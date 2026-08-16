'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const {
  PEAKOS_COLLABORATION_PREFIX,
  createPeakosCollaborationGateway,
} = require('./peakos-collaboration-routes');
const {
  createPeakosEventVisibilityGuard,
  eventHiddenPredicate,
  registerPeakosEventVisibilityRoutes,
} = require('./peakos-event-visibility');

const PEAK_WORKSPACE_ID = 'ws_peak';
const DAeGU_WORKSPACE_ID = 'ws_daegu';

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function createContractDatabase() {
  const events = new Map([
    ['repeat-parent', {
      id: 'repeat-parent', workspace_id: PEAK_WORKSPACE_ID, owner_id: 'owner', repeat_parent_id: null, deleted: false,
    }],
    ['repeat-child-hidden', {
      id: 'repeat-child-hidden', workspace_id: PEAK_WORKSPACE_ID, owner_id: 'owner', repeat_parent_id: 'repeat-parent', deleted: false,
    }],
    ['repeat-child-visible', {
      id: 'repeat-child-visible', workspace_id: PEAK_WORKSPACE_ID, owner_id: 'owner', repeat_parent_id: 'repeat-parent', deleted: false,
    }],
    ['admin-target', {
      id: 'admin-target', workspace_id: PEAK_WORKSPACE_ID, owner_id: 'employee', repeat_parent_id: null, deleted: false,
    }],
    ['non-owner-target', {
      id: 'non-owner-target', workspace_id: PEAK_WORKSPACE_ID, owner_id: 'employee', repeat_parent_id: null, deleted: false,
    }],
    ['branch-event', {
      id: 'branch-event', workspace_id: DAeGU_WORKSPACE_ID, owner_id: 'branch-owner', repeat_parent_id: null, deleted: false,
    }],
  ]);
  const hides = new Map();
  const sqlCalls = [];

  const query = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    sqlCalls.push({ text, params: [...params] });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] };
    if (text.startsWith('SELECT id, owner_id FROM events')) {
      const [eventId, workspaceId, peakId] = params;
      const row = events.get(String(eventId));
      const inWorkspace = row && (row.workspace_id === workspaceId
        || (row.workspace_id == null && workspaceId === peakId));
      return { rows: row && row.deleted === false && inWorkspace ? [row] : [] };
    }
    if (text.startsWith('INSERT INTO peakos_workspace_event_hides')) {
      const [workspaceId, eventId, actorUid] = params.map(String);
      const key = `${workspaceId}:${eventId}`;
      const row = hides.get(key) || {
        workspace_id: workspaceId,
        event_id: eventId,
        hidden_by_uid: actorUid,
        hidden_at: '2026-08-16T12:34:56.000Z',
      };
      hides.set(key, row);
      return { rows: [row] };
    }
    if (text.startsWith('DELETE FROM peakos_workspace_event_hides')) {
      hides.delete(`${params[0]}:${params[1]}`);
      return { rows: [] };
    }
    if (text.startsWith('SELECT 1 FROM peakos_workspace_event_hides')) {
      return { rows: hides.has(`${params[0]}:${params[1]}`) ? [{ one: 1 }] : [] };
    }
    throw new Error(`unexpected SQL: ${text}`);
  };

  return {
    events,
    hides,
    sqlCalls,
    pool: {
      query,
      async connect() {
        return { query, release() {} };
      },
    },
  };
}

function workspaceIdForRequest(req) {
  return req.workspace?.id || PEAK_WORKSPACE_ID;
}

async function createFixture() {
  const database = createContractDatabase();
  const handlerHits = [];
  const app = express();
  app.use(express.json());

  const authMiddleware = (req, res, next) => {
    if (req.headers.authorization !== 'Bearer valid') {
      return res.status(401).json({ code: 'AUTH_REQUIRED' });
    }
    req.uid = String(req.headers['x-test-user'] || 'owner');
    req.userDoc = {
      approved: true,
      is_active: true,
      role: String(req.headers['x-test-legacy-role'] || 'member'),
    };
    const workspaceId = req.headers['x-peakos-workspace'] === 'daegu'
      ? DAeGU_WORKSPACE_ID
      : PEAK_WORKSPACE_ID;
    req.workspace = {
      id: workspaceId,
      role: String(req.headers['x-test-workspace-role'] || 'member'),
      permissions: { calendar: String(req.headers['x-test-calendar-permission'] || 'write') },
      headquartersOversight: req.headers['x-test-workspace-role'] === 'oversight',
    };
    return next();
  };

  app.use(createPeakosCollaborationGateway({
    authMiddleware,
    getRequireOsSession: () => (req, res, next) => (
      req.headers['x-os-session'] === 'verified'
        ? next()
        : res.status(401).json({ code: 'OS_AUTH_SESSION_REQUIRED' })
    ),
    getRequireWorkspace: ({ req }) => (_req, res, next) => {
      const permission = String(req.headers['x-test-calendar-permission'] || 'write');
      const role = String(req.headers['x-test-workspace-role'] || 'member');
      const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method).toUpperCase());
      if (isWrite && (permission !== 'write' || role === 'oversight')) {
        return res.status(403).json({ code: 'PEAKOS_WORKSPACE_PERMISSION_FORBIDDEN' });
      }
      return next();
    },
  }));

  app.use(createPeakosEventVisibilityGuard({
    pool: database.pool,
    workspaceIdForRequest,
  }));
  registerPeakosEventVisibilityRoutes({
    app,
    authMiddleware,
    pool: database.pool,
    workspaceIdForRequest,
    peakWorkspaceId: PEAK_WORKSPACE_ID,
  });

  const visibleEvents = req => {
    const workspaceId = workspaceIdForRequest(req);
    const osPredicate = eventHiddenPredicate(req, { eventAlias: 'e', workspaceParameter: 1 });
    return [...database.events.values()].filter(event => (
      event.deleted === false
      && event.workspace_id === workspaceId
      && (!osPredicate || !database.hides.has(`${workspaceId}:${event.id}`))
    ));
  };

  app.get('/api/events', authMiddleware, (req, res) => res.json(visibleEvents(req)));
  app.get('/api/projects/:id', authMiddleware, (req, res) => res.json({
    id: req.params.id,
    events: visibleEvents(req),
  }));
  app.get('/api/events/checklist-summary', authMiddleware, (req, res) => {
    const summary = Object.fromEntries(visibleEvents(req).map(event => [event.id, { total: 1, completed: 0 }]));
    res.json(summary);
  });
  app.post('/api/events/reorder', authMiddleware, (req, res) => {
    const visibleIds = new Set(visibleEvents(req).map(event => event.id));
    const ids = (req.body?.items || []).map(item => String(item.id));
    if (ids.some(id => !visibleIds.has(id))) {
      return res.status(403).json({ code: 'EVENT_REORDER_FORBIDDEN' });
    }
    handlerHits.push(['reorder', ids]);
    return res.json({ ok: true, updated: ids.length });
  });

  const directHandler = label => (req, res) => {
    handlerHits.push([label, req.params.id || req.params.eventId]);
    res.json({ ok: true });
  };
  app.get('/api/events/:id/shares', authMiddleware, directHandler('shares'));
  app.get('/api/events/:id/checklist', authMiddleware, directHandler('checklist-get'));
  app.post('/api/events/:id/checklist', authMiddleware, directHandler('checklist-post'));
  app.put('/api/events/:eventId/checklist/:itemId', authMiddleware, directHandler('checklist-put'));
  app.get('/api/events/:id/comments', authMiddleware, directHandler('comments-get'));
  app.post('/api/events/:id/comments', authMiddleware, directHandler('comments-post'));
  app.delete('/api/events/:eventId/comments/:commentId', authMiddleware, directHandler('comments-delete'));
  app.post('/api/events/:id/delete-repeat-future', authMiddleware, directHandler('repeat-future'));
  app.post('/api/events/:id/delete-repeat-all', authMiddleware, directHandler('repeat-all'));
  app.put('/api/events/:id', authMiddleware, (req, res) => {
    const event = database.events.get(String(req.params.id));
    if (!event) return res.status(404).json({ error: 'Not found' });
    if (typeof req.body?.deleted === 'boolean') event.deleted = req.body.deleted;
    handlerHits.push(['event-put', event.id, req.body]);
    return res.json(event);
  });
  app.get('/api/events/:id', authMiddleware, (req, res) => {
    const event = database.events.get(String(req.params.id));
    return event ? res.json(event) : res.status(404).json({ error: 'Not found' });
  });

  return { database, handlerHits, server: await listen(app) };
}

async function request(server, pathname, {
  method = 'GET',
  body,
  user = 'owner',
  legacyRole = 'member',
  workspace = 'peak',
  workspaceRole = 'member',
  calendarPermission = 'write',
  preview = false,
} = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method,
    headers: {
      authorization: 'Bearer valid',
      'content-type': 'application/json',
      'x-os-session': 'verified',
      'x-peakos-workspace': workspace,
      'x-test-user': user,
      'x-test-legacy-role': legacyRole,
      'x-test-workspace-role': workspaceRole,
      'x-test-calendar-permission': calendarPermission,
      ...(preview ? { 'x-peakos-preview': '1' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function protectedPath(suffix) {
  return `${PEAKOS_COLLABORATION_PREFIX}${suffix}`;
}

test('workspace hide removes one repeat instance for every OS member but leaves legacy and other workspace rows unchanged', async t => {
  const fixture = await createFixture();
  t.after(() => close(fixture.server));

  for (const user of ['owner', 'coworker']) {
    const before = await request(fixture.server, protectedPath('/events'), { user });
    assert.equal(before.status, 200);
    assert.ok(before.body.some(event => event.id === 'repeat-child-hidden'));
  }

  const hidden = await request(fixture.server, protectedPath('/events/repeat-child-hidden/os-hide'), {
    method: 'POST',
    user: 'owner',
  });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.eventId, 'repeat-child-hidden');
  assert.equal(fixture.database.events.get('repeat-child-hidden').deleted, false);
  assert.equal(fixture.database.hides.size, 1);

  for (const user of ['owner', 'coworker', 'workspace-admin']) {
    const after = await request(fixture.server, protectedPath('/events'), { user });
    assert.equal(after.status, 200);
    assert.ok(!after.body.some(event => event.id === 'repeat-child-hidden'), user);
    assert.ok(after.body.some(event => event.id === 'repeat-parent'), user);
    assert.ok(after.body.some(event => event.id === 'repeat-child-visible'), user);
  }

  const legacy = await request(fixture.server, '/api/events', { user: 'coworker' });
  assert.ok(legacy.body.some(event => event.id === 'repeat-child-hidden' && event.deleted === false));

  const otherWorkspace = await request(fixture.server, protectedPath('/events'), {
    workspace: 'daegu',
    user: 'branch-owner',
  });
  assert.deepEqual(otherWorkspace.body.map(event => event.id), ['branch-event']);
});

test('only an owner or legacy admin with direct workspace write can hide; preview, read-only, oversight, non-owner and cross-workspace requests fail closed', async t => {
  const fixture = await createFixture();
  t.after(() => close(fixture.server));

  const owner = await request(fixture.server, protectedPath('/events/repeat-parent/os-hide'), {
    method: 'POST', user: 'owner',
  });
  assert.equal(owner.status, 200);

  const admin = await request(fixture.server, protectedPath('/events/admin-target/os-hide'), {
    method: 'POST', user: 'global-admin', legacyRole: 'admin', workspaceRole: 'admin',
  });
  assert.equal(admin.status, 200);

  const deniedCases = [
    {
      label: 'non-owner writer',
      eventId: 'non-owner-target',
      options: { user: 'manager', legacyRole: 'manager', workspaceRole: 'manager' },
      code: 'PEAKOS_EVENT_HIDE_FORBIDDEN',
    },
    {
      label: 'read-only owner',
      eventId: 'repeat-child-visible',
      options: { user: 'owner', calendarPermission: 'read' },
      code: 'PEAKOS_WORKSPACE_PERMISSION_FORBIDDEN',
    },
    {
      label: 'oversight admin',
      eventId: 'repeat-child-visible',
      options: {
        user: 'global-admin', legacyRole: 'admin', workspaceRole: 'oversight', calendarPermission: 'read',
      },
      code: 'PEAKOS_WORKSPACE_PERMISSION_FORBIDDEN',
    },
    {
      label: 'preview owner',
      eventId: 'repeat-child-visible',
      options: { user: 'owner', preview: true },
      code: 'PEAKOS_PREVIEW_WRITE_FORBIDDEN',
    },
    {
      label: 'cross-workspace IDOR',
      eventId: 'branch-event',
      options: { user: 'branch-owner', workspace: 'peak' },
      code: 'PEAKOS_EVENT_NOT_FOUND',
    },
  ];

  for (const denied of deniedCases) {
    const hidesBefore = fixture.database.hides.size;
    const result = await request(
      fixture.server,
      protectedPath(`/events/${denied.eventId}/os-hide`),
      { method: 'POST', ...denied.options },
    );
    assert.equal(result.status >= 400, true, denied.label);
    assert.equal(result.body.code, denied.code, denied.label);
    assert.equal(fixture.database.hides.size, hidesBefore, denied.label);
  }
});

test('a hidden event cannot leak through direct detail, shares, checklist, comments, repeat mutation, summary, project detail or reorder surfaces', async t => {
  const fixture = await createFixture();
  t.after(() => close(fixture.server));

  assert.equal((await request(
    fixture.server,
    protectedPath('/events/repeat-child-hidden/os-hide'),
    { method: 'POST', user: 'owner' },
  )).status, 200);

  const directCases = [
    ['GET', '/events/repeat-child-hidden/shares', undefined],
    ['GET', '/events/repeat-child-hidden/checklist', undefined],
    ['POST', '/events/repeat-child-hidden/checklist', { title: 'blocked' }],
    ['PUT', '/events/repeat-child-hidden/checklist/item-1', { done: true }],
    ['GET', '/events/repeat-child-hidden/comments', undefined],
    ['POST', '/events/repeat-child-hidden/comments', { text: 'blocked' }],
    ['DELETE', '/events/repeat-child-hidden/comments/comment-1', undefined],
    ['PUT', '/events/repeat-child-hidden', { title: 'blocked' }],
    ['POST', '/events/repeat-child-hidden/delete-repeat-future', { fromDate: '2026-08-16' }],
    ['POST', '/events/repeat-child-hidden/delete-repeat-all', {}],
  ];
  for (const [method, suffix, body] of directCases) {
    const result = await request(fixture.server, protectedPath(suffix), { method, body });
    assert.equal(result.status, 404, `${method} ${suffix}`);
    assert.equal(result.body.code, 'PEAKOS_EVENT_HIDDEN', `${method} ${suffix}`);
  }
  assert.deepEqual(fixture.handlerHits, []);

  const unsupportedDetail = await request(
    fixture.server,
    protectedPath('/events/repeat-child-hidden'),
  );
  assert.equal(unsupportedDetail.status, 405);
  assert.equal(unsupportedDetail.body.code, 'PEAKOS_COLLABORATION_METHOD_NOT_ALLOWED');

  const summary = await request(fixture.server, protectedPath('/events/checklist-summary'));
  assert.equal(summary.status, 200);
  assert.equal(summary.body['repeat-child-hidden'], undefined);

  const project = await request(fixture.server, protectedPath('/projects/project-1'));
  assert.equal(project.status, 200);
  assert.ok(!project.body.events.some(event => event.id === 'repeat-child-hidden'));

  const reorder = await request(fixture.server, protectedPath('/events/reorder'), {
    method: 'POST',
    body: { items: [{ id: 'repeat-child-hidden', sortOrder: 1 }] },
  });
  assert.equal(reorder.status, 403);
  assert.equal(reorder.body.code, 'EVENT_REORDER_FORBIDDEN');
  assert.deepEqual(fixture.handlerHits, []);
});

test('legacy delete still sets events.deleted and never creates an OS visibility row', async t => {
  const fixture = await createFixture();
  t.after(() => close(fixture.server));

  const beforeHides = fixture.database.hides.size;
  const deleted = await request(fixture.server, '/api/events/repeat-child-visible', {
    method: 'PUT',
    user: 'owner',
    body: { deleted: true },
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);
  assert.equal(fixture.database.events.get('repeat-child-visible').deleted, true);
  assert.equal(fixture.database.hides.size, beforeHides);
  assert.deepEqual(fixture.handlerHits, [
    ['event-put', 'repeat-child-visible', { deleted: true }],
  ]);
});

function sourceBlock(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `source start missing: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `source end missing: ${end}`);
  return source.slice(from, to);
}

test('the production server wires visibility filtering before every OS event surface while preserving the canonical legacy update handler', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  const gatewayAt = source.indexOf('app.use(createPeakosCollaborationGateway({');
  const guardAt = source.indexOf('app.use(createPeakosEventVisibilityGuard({');
  const hideRoutesAt = source.indexOf('registerPeakosEventVisibilityRoutes({');
  const eventListAt = source.indexOf("app.get('/api/events'");
  assert.ok(gatewayAt >= 0 && gatewayAt < guardAt);
  assert.ok(guardAt < hideRoutesAt && hideRoutesAt < eventListAt);

  const access = sourceBlock(source, 'async function canAccessEvent(', '// PEAK OS collaboration requests');
  assert.match(access, /eventHiddenPredicate\(req, \{ eventAlias: 'e', workspaceParameter: 3 \}\)/);

  const eventList = sourceBlock(source, "app.get('/api/events'", "app.post('/api/events'");
  assert.match(eventList, /eventHiddenPredicate\(req, \{ eventAlias: 'e', workspaceParameter: 2 \}\)/);

  const projectDetail = sourceBlock(source, "app.get('/api/projects/:id'", "app.put('/api/projects/:id'");
  assert.match(projectDetail, /eventHiddenPredicate\(req, \{ eventAlias: 'events', workspaceParameter: 2 \}\)/);

  const reorder = sourceBlock(source, "app.post('/api/events/reorder'", '// ══ 휴무일 관리');
  assert.match(reorder, /eventHiddenPredicate\(req, \{ eventAlias: 'e', workspaceParameter: 2 \}\)/);

  const checklistSummary = sourceBlock(
    source,
    "app.get('/api/events/checklist-summary'",
    '// ══ 통계 대시보드',
  );
  assert.equal((checklistSummary.match(/eventHiddenPredicate\(/g) || []).length, 2);

  const legacyUpdate = sourceBlock(
    source,
    "app.put('/api/events/:id'",
    '// ── Ideas',
  );
  assert.match(legacyUpdate, /deleted/);
  assert.doesNotMatch(legacyUpdate, /peakos_workspace_event_hides|os-hide/);

  const startup = sourceBlock(source, 'async function startServer()', 'startServer();');
  assert.match(startup, /ensurePeakosEventVisibilityInfrastructure\(pool\)/);
});
