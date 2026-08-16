'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const test = require('node:test');
const express = require('express');

const {
  PEAKOS_COLLABORATION_PREFIX,
  createPeakosCollaborationGateway,
} = require('./peakos-collaboration-routes');
const {
  MIGRATION_PATH,
  createPeakosEventVisibilityGuard,
  ensurePeakosEventVisibilityInfrastructure,
  eventHiddenPredicate,
  normalizedContextEventId,
  registerPeakosEventVisibilityRoutes,
} = require('./peakos-event-visibility');

const PEAK_WORKSPACE_ID = 'ws_peak';

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

async function request(server, pathname, {
  method = 'GET',
  user = 'owner',
  role = 'member',
  workspace = 'ws_peak',
} = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method,
    headers: {
      authorization: 'Bearer valid',
      'x-test-user': user,
      'x-test-role': role,
      'x-peakos-workspace': workspace === 'ws_peak' ? 'peak' : 'daegu',
      'x-os-session': 'verified',
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function createDatabase() {
  const events = new Map([
    ['event-1', { id: 'event-1', workspace_id: 'ws_peak', owner_id: 'owner', deleted: false }],
    ['event-2', { id: 'event-2', workspace_id: 'ws_daegu', owner_id: 'branch-owner', deleted: false }],
  ]);
  const hides = new Map();
  const query = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] };
    if (text.startsWith('SELECT id, owner_id FROM events')) {
      const [eventId, workspaceId, peakId] = params;
      const row = events.get(eventId);
      const inWorkspace = row && (row.workspace_id === workspaceId
        || (row.workspace_id == null && workspaceId === peakId));
      return { rows: row && !row.deleted && inWorkspace ? [row] : [] };
    }
    if (text.startsWith('INSERT INTO peakos_workspace_event_hides')) {
      const [workspaceId, eventId, actorUid] = params;
      const key = `${workspaceId}:${eventId}`;
      const existing = hides.get(key);
      if (existing) return { rows: [] };
      const row = {
        workspace_id: workspaceId,
        event_id: eventId,
        hidden_by_uid: actorUid,
        hidden_at: '2026-08-16T12:00:00.000Z',
      };
      hides.set(key, row);
      return { rows: [row] };
    }
    if (text.startsWith('DELETE FROM peakos_workspace_event_hides')) {
      hides.delete(`${params[0]}:${params[1]}`);
      return { rows: [] };
    }
    if (text.startsWith('SELECT 1 FROM peakos_workspace_event_hides')) {
      return { rows: hides.has(`${params[0]}:${params[1]}`) ? [{ '?column?': 1 }] : [] };
    }
    if (text.startsWith('SELECT workspace_id, event_id, hidden_at FROM peakos_workspace_event_hides')) {
      const row = hides.get(`${params[0]}:${params[1]}`);
      return { rows: row ? [row] : [] };
    }
    throw new Error(`unexpected SQL: ${text}`);
  };
  const client = { query, release() {} };
  return {
    events,
    hides,
    pool: { query, async connect() { return client; } },
  };
}

async function fixture() {
  const database = createDatabase();
  const app = express();
  app.use(express.json());
  const authMiddleware = (req, res, next) => {
    if (req.headers.authorization !== 'Bearer valid') return res.status(401).json({ error: 'No token' });
    req.uid = String(req.headers['x-test-user'] || 'owner');
    req.userDoc = {
      approved: true,
      is_active: true,
      role: String(req.headers['x-test-role'] || 'member'),
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
    getRequireWorkspace: ({ req }) => (_req, _res, next) => {
      const workspaceId = req.headers['x-peakos-workspace'] === 'daegu' ? 'ws_daegu' : 'ws_peak';
      req.workspace = {
        id: workspaceId,
        role: req.userDoc.role,
        headquartersOversight: false,
        permissions: { calendar: 'write' },
      };
      next();
    },
  }));
  const workspaceIdForRequest = req => req.workspace?.id || PEAK_WORKSPACE_ID;
  app.use(createPeakosEventVisibilityGuard({ pool: database.pool, workspaceIdForRequest }));
  registerPeakosEventVisibilityRoutes({
    app,
    authMiddleware,
    pool: database.pool,
    workspaceIdForRequest,
    peakWorkspaceId: PEAK_WORKSPACE_ID,
  });
  app.get('/api/events/:id', authMiddleware, (req, res) => {
    const event = database.events.get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Not found' });
    return res.json(event);
  });
  app.get('/api/events/:id/shares', authMiddleware, (req, res) => {
    const event = database.events.get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Not found' });
    return res.json({ eventId: event.id, shares: [] });
  });
  return { database, server: await listen(app) };
}

test('migration is additive, workspace-scoped, indexed, and never mutates events.deleted', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS peakos_workspace_event_hides/);
  assert.match(sql, /PRIMARY KEY \(workspace_id, event_id\)/);
  assert.match(sql, /REFERENCES peakos_workspaces\(id\)/);
  assert.match(sql, /REFERENCES events\(id\).*ON DELETE CASCADE/s);
  assert.match(sql, /REFERENCES peakos_workspace_memberships\(workspace_id, user_uid\)/);
  assert.match(sql, /peakos_workspace_event_hides_event_idx/);
  assert.match(sql, /peakos_workspace_event_hide_assert_workspace/);
  assert.match(sql, /peakos_events_workspace_hide_guard/);
  assert.match(sql, /GRANT SELECT, INSERT, DELETE/);
  assert.doesNotMatch(sql, /UPDATE\s+events|ALTER TABLE\s+events/i);
  assert.doesNotMatch(sql, /SET\s+deleted/i);
});

test('readiness fails closed until every event-hide column exists', async () => {
  const ready = await ensurePeakosEventVisibilityInfrastructure({
    async query(sql) {
      const text = String(sql);
      if (text.includes('information_schema.columns')) {
        return { rows: ['event_id', 'hidden_at', 'hidden_by_uid', 'workspace_id'].map(column_name => ({ column_name })) };
      }
      if (text.includes('pg_constraint')) {
        return { rows: [
          { conname: 'peakos_workspace_event_hides_pkey', definition: 'PRIMARY KEY (workspace_id, event_id)' },
          { conname: 'peakos_workspace_event_hides_workspace_fk', definition: 'FOREIGN KEY (workspace_id) REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT' },
          { conname: 'peakos_workspace_event_hides_event_fk', definition: 'FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE RESTRICT ON DELETE CASCADE' },
          { conname: 'peakos_workspace_event_hides_actor_membership_fk', definition: 'FOREIGN KEY (workspace_id, hidden_by_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT' },
        ] };
      }
      if (text.includes('pg_indexes')) {
        return { rows: [{ indexname: 'peakos_workspace_event_hides_event_idx', indexdef: 'CREATE INDEX peakos_workspace_event_hides_event_idx ON peakos_workspace_event_hides USING btree (event_id)' }] };
      }
      return { rows: [
        { tgname: 'peakos_workspace_event_hides_workspace_guard', table_name: 'peakos_workspace_event_hides' },
        { tgname: 'peakos_events_workspace_hide_guard', table_name: 'events' },
      ] };
    },
  });
  assert.deepEqual(ready, {
    ready: true,
    table: 'peakos_workspace_event_hides',
    columns: 4,
    constraints: 4,
    indexes: 1,
    triggers: 2,
  });

  await assert.rejects(
    ensurePeakosEventVisibilityInfrastructure({ async query() { return { rows: [] }; } }),
    error => error.code === 'PEAKOS_EVENT_VISIBILITY_MIGRATION_REQUIRED'
      && error.missing.includes('workspace_id'),
  );
});

test('hidden SQL predicate and direct-ID extraction activate only for marked OS requests', () => {
  const legacy = { method: 'GET', url: '/api/events/event-1' };
  assert.equal(eventHiddenPredicate(legacy, { eventAlias: 'e', workspaceParameter: 2 }), '');
  assert.equal(normalizedContextEventId(legacy), null);

  const gateway = createPeakosCollaborationGateway({
    authMiddleware(req, _res, next) { req.uid = 'owner'; next(); },
    getRequireOsSession: () => (_req, _res, next) => next(),
  });
  const req = {
    method: 'GET',
    url: `${PEAKOS_COLLABORATION_PREFIX}/events/event-1/checklist`,
    headers: {},
    get(name) { return this.headers[String(name).toLowerCase()]; },
  };
  gateway(req, { status() { return this; }, json() { return this; } }, error => assert.equal(error, undefined));
  assert.equal(normalizedContextEventId(req), 'event-1');
  assert.match(eventHiddenPredicate(req, { eventAlias: 'e', workspaceParameter: 2 }), /workspace_id = \$2/);
});

test('OS hide is workspace-wide and idempotent while the legacy event remains alive and visible', async () => {
  const testFixture = await fixture();
  try {
    const hidden = await request(testFixture.server, `${PEAKOS_COLLABORATION_PREFIX}/events/event-1/os-hide`, {
      method: 'POST',
    });
    assert.deepEqual(hidden, {
      status: 200,
      body: {
        ok: true,
        eventId: 'event-1',
        workspaceId: 'ws_peak',
        hiddenAt: '2026-08-16T12:00:00.000Z',
      },
    });
    assert.equal(testFixture.database.events.get('event-1').deleted, false);

    const again = await request(testFixture.server, `${PEAKOS_COLLABORATION_PREFIX}/events/event-1/os-hide`, {
      method: 'POST',
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.hiddenAt, hidden.body.hiddenAt);

    const otherOsMember = await request(
      testFixture.server,
      `${PEAKOS_COLLABORATION_PREFIX}/events/event-1/shares`,
      { user: 'coworker' },
    );
    assert.equal(otherOsMember.status, 404);
    assert.equal(otherOsMember.body.code, 'PEAKOS_EVENT_HIDDEN');

    const legacy = await request(testFixture.server, '/api/events/event-1', { user: 'coworker' });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.deleted, false);
  } finally {
    await close(testFixture.server);
  }
});

test('hide rejects a non-owner and a cross-workspace event; unhide restores OS direct access', async () => {
  const testFixture = await fixture();
  try {
    const nonOwner = await request(testFixture.server, `${PEAKOS_COLLABORATION_PREFIX}/events/event-1/os-hide`, {
      method: 'POST', user: 'manager', role: 'manager',
    });
    assert.equal(nonOwner.status, 403);
    assert.equal(nonOwner.body.code, 'PEAKOS_EVENT_HIDE_FORBIDDEN');

    const crossWorkspace = await request(testFixture.server, `${PEAKOS_COLLABORATION_PREFIX}/events/event-2/os-hide`, {
      method: 'POST', user: 'branch-owner', workspace: 'ws_peak',
    });
    assert.equal(crossWorkspace.status, 404);
    assert.equal(crossWorkspace.body.code, 'PEAKOS_EVENT_NOT_FOUND');

    assert.equal((await request(
      testFixture.server,
      `${PEAKOS_COLLABORATION_PREFIX}/events/event-1/os-hide`,
      { method: 'POST' },
    )).status, 200);
    assert.equal((await request(
      testFixture.server,
      `${PEAKOS_COLLABORATION_PREFIX}/events/event-1/os-hide`,
      { method: 'DELETE' },
    )).status, 200);
    assert.equal((await request(
      testFixture.server,
      `${PEAKOS_COLLABORATION_PREFIX}/events/event-1/shares`,
      { user: 'coworker' },
    )).status, 200);
  } finally {
    await close(testFixture.server);
  }
});

test('direct canonical os-hide path is unavailable without the authenticated OS marker', async () => {
  const testFixture = await fixture();
  try {
    const direct = await request(testFixture.server, '/api/events/event-1/os-hide', { method: 'POST' });
    assert.equal(direct.status, 404);
    assert.equal(direct.body.code, 'PEAKOS_EVENT_HIDE_ROUTE_NOT_FOUND');
    assert.equal(testFixture.database.hides.size, 0);
  } finally {
    await close(testFixture.server);
  }
});
