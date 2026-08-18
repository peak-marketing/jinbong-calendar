'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const {
  createPeakosCollaborationGateway,
  isPeakosCollaborationAuthenticated,
} = require('./peakos-collaboration-routes');

const INDEX_SOURCE = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');

function sourceBetween(start, end) {
  const startIndex = INDEX_SOURCE.indexOf(start);
  const endIndex = INDEX_SOURCE.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing route source: ${start}`);
  assert.notEqual(endIndex, -1, `missing route boundary: ${end}`);
  return INDEX_SOURCE.slice(startIndex, endIndex);
}

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
  body,
  headers = {},
} = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
    method,
    headers: {
      authorization: 'Bearer valid-firebase-token',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

async function sharedHandlerFixture() {
  const app = express();
  const rows = [];
  let canonicalMutationCount = 0;
  let osSessionChecks = 0;

  app.use(express.json());
  const authMiddleware = (req, res, next) => {
    if (req.headers.authorization !== 'Bearer valid-firebase-token') {
      return res.status(401).json({ code: 'INVALID_FIREBASE_TOKEN' });
    }
    req.uid = 'signed-in-user';
    req.userName = '서명 사용자';
    req.userDoc = { approved: true, is_active: true, role: 'member', group_id: 'hq' };
    return next();
  };
  const requireOsSession = (req, res, next) => {
    osSessionChecks += 1;
    if (req.headers['x-test-os-session'] !== 'verified') {
      return res.status(401).json({ code: 'OS_AUTH_SESSION_REQUIRED' });
    }
    req.osSecondAuth = { required: true, verified: true, uid: req.uid };
    return next();
  };

  app.use(createPeakosCollaborationGateway({
    authMiddleware,
    getRequireOsSession: () => requireOsSession,
  }));

  // These callbacks stand in for the one canonical Paragon handler reached
  // both directly and after the protected OS gateway rewrites req.url.
  app.get('/api/events', authMiddleware, (req, res) => {
    res.json({ rows, protected: isPeakosCollaborationAuthenticated(req) });
  });
  app.post('/api/events', authMiddleware, (req, res) => {
    canonicalMutationCount += 1;
    const row = {
      id: `event-${rows.length + 1}`,
      title: String(req.body?.title || ''),
      owner_id: req.uid,
    };
    rows.push(row);
    res.json(row);
  });
  app.put('/api/events/:id', authMiddleware, (req, res) => {
    canonicalMutationCount += 1;
    res.json({ ok: true });
  });
  app.delete('/api/projects/:id', authMiddleware, (req, res) => {
    canonicalMutationCount += 1;
    res.json({ ok: true });
  });

  const server = await listen(app);
  return {
    server,
    rows,
    get canonicalMutationCount() { return canonicalMutationCount; },
    get osSessionChecks() { return osSessionChecks; },
  };
}

test('forged OS writes and every preview mutation stop before the canonical handler', async () => {
  const fixture = await sharedHandlerFixture();
  try {
    const forged = await request(fixture.server, '/api/peakos/collaboration/events', {
      method: 'POST',
      headers: {
        'x-peakos-preview': '0',
        cookie: 'peakos_os_session=attacker-controlled',
      },
      body: { title: 'forged', owner_id: 'victim-user' },
    });
    assert.equal(forged.status, 401);
    assert.equal(forged.body.code, 'OS_AUTH_SESSION_REQUIRED');
    assert.equal(fixture.canonicalMutationCount, 0);
    assert.equal(fixture.rows.length, 0);

    for (const [method, pathname] of [
      ['POST', '/api/peakos/collaboration/events'],
      ['PUT', '/api/peakos/collaboration/events/event-1'],
      ['DELETE', '/api/peakos/collaboration/projects/project-1'],
    ]) {
      const preview = await request(fixture.server, pathname, {
        method,
        headers: {
          'x-test-os-session': 'verified',
          'x-peakos-preview': 'true',
        },
        body: { title: 'must not persist' },
      });
      assert.equal(preview.status, 403, `${method} ${pathname}`);
      assert.equal(preview.body.code, 'PEAKOS_PREVIEW_WRITE_FORBIDDEN');
    }
    assert.equal(fixture.canonicalMutationCount, 0);
    assert.equal(fixture.rows.length, 0);
    assert.equal(fixture.osSessionChecks, 4);
  } finally {
    await close(fixture.server);
  }
});

test('OS and legacy requests round-trip through the same canonical handler state', async () => {
  const fixture = await sharedHandlerFixture();
  try {
    const osCreated = await request(fixture.server, '/api/peakos/collaboration/events', {
      method: 'POST',
      headers: { 'x-test-os-session': 'verified', 'x-peakos-preview': '0' },
      body: { title: 'OS 작성', owner_id: 'forged-owner' },
    });
    assert.equal(osCreated.status, 200);
    assert.equal(osCreated.body.owner_id, 'signed-in-user');

    const legacyRead = await request(fixture.server, '/api/events');
    assert.equal(legacyRead.status, 200);
    assert.equal(legacyRead.body.protected, false);
    assert.deepEqual(legacyRead.body.rows.map(row => row.title), ['OS 작성']);

    const legacyCreated = await request(fixture.server, '/api/events', {
      method: 'POST',
      body: { title: 'Paragon 작성' },
    });
    assert.equal(legacyCreated.status, 200);

    const osRead = await request(fixture.server, '/api/peakos/collaboration/events', {
      headers: { 'x-test-os-session': 'verified' },
    });
    assert.equal(osRead.status, 200);
    assert.equal(osRead.body.protected, true);
    assert.deepEqual(osRead.body.rows.map(row => row.title), ['OS 작성', 'Paragon 작성']);
    assert.equal(fixture.canonicalMutationCount, 2);
  } finally {
    await close(fixture.server);
  }
});

test('canonical event policy keeps owner identity and branch/team visibility server-side', () => {
  const restrictedPaths = sourceBetween(
    'function isChatOnlyAllowedPath(pathname)',
    'function isExternalCalendarAllowedPath(pathname)',
  );
  assert.match(restrictedPaths, /\/api\\\/os-auth/);

  const list = sourceBetween(
    "app.get('/api/events', authMiddleware",
    "async function getNextTodoSortOrder",
  );
  assert.match(list, /e\.owner_id = \$1 OR es\.user_id = \$1/);
  assert.match(list, /e\.scope = 'team' AND event_owner\.group_id/);
  assert.match(list, /params\.push\(req\.userDoc\.group_id \|\| null\)/);

  const create = sourceBetween(
    "app.post('/api/events', authMiddleware",
    "app.get('/api/events/checklist-summary'",
  );
  assert.match(create, /\[type, title,[\s\S]*req\.uid, req\.userName/);
  assert.doesNotMatch(create, /req\.body\.(?:owner|ownerId|owner_id)/);

  const update = sourceBetween(
    "app.put('/api/events/:id', authMiddleware",
    '// ── Ideas',
  );
  assert.match(update, /req\.userDoc\.role !== 'admin' && ev\.rows\[0\]\.owner_id !== req\.uid/);
});

test('chat and project canonical handlers enforce membership and event ownership', () => {
  const chatList = sourceBetween(
    "app.get('/api/chat-rooms', authMiddleware",
    "app.get('/api/chat-room-groups'",
  );
  assert.match(chatList, /JOIN chat_room_members crm ON cr\.id = crm\.room_id/);
  assert.match(chatList, /WHERE crm\.user_id = \$1/);

  for (const [start, end] of [
    ["app.get('/api/chat-rooms/:roomId/messages'", "app.post('/api/chat-rooms/:roomId/messages'"],
    ["app.post('/api/chat-rooms/:roomId/messages'", '// 이미지 업로드 메시지'],
    ["app.post('/api/chat-rooms/:roomId/read'", '// 메시지별 안 읽은 수 조회'],
    ["app.get('/api/chat-rooms/:roomId/unread-counts'", "app.post('/api/chat-rooms/:roomId/upload-file'"],
  ]) {
    const handler = sourceBetween(start, end);
    assert.match(handler, /(?:isChatRoomMember|chat_room_members)/, start);
  }
  const read = sourceBetween(
    "app.post('/api/chat-rooms/:roomId/read'",
    '// 메시지별 안 읽은 수 조회',
  );
  assert.match(read, /SELECT id FROM chat WHERE id = \$1 AND room_id = \$2/);

  const addMember = sourceBetween(
    "app.post('/api/chat-rooms/:roomId/members'",
    "app.delete('/api/chat-rooms/:roomId/members/:userId'",
  );
  assert.match(addMember, /req\.userDoc\.chat_only \|\| req\.userDoc\.external_calendar_only/);
  assert.match(addMember, /assertUsersInWorkspace\(\[userId\]/);
  assert.match(addMember, /if \(restrictedDirectory\)/);
  assert.match(addMember, /role = \$2.*'admin'/s);

  const projectList = sourceBetween(
    "app.get('/api/projects', authMiddleware",
    "app.post('/api/projects', authMiddleware",
  );
  assert.match(projectList, /p\.owner_id = \$\$\{params\.length\}/);
  assert.match(projectList, /project_members pmx/);

  const projectLink = sourceBetween(
    "app.post('/api/projects/:id/events'",
    "app.post('/api/projects/:id/meetings'",
  );
  assert.match(projectLink, /canAccessProject\(req, req\.params\.id\)/);
  assert.match(projectLink, /canAccessEvent\(req, eventId, \{ requireOwner: true \}\)/);
  assert.match(projectLink, /client\.query\('BEGIN'\)/);
  assert.match(projectLink, /SELECT id FROM events WHERE id = \$1 AND deleted = FALSE FOR UPDATE/);
  assert.match(projectLink, /SELECT 1 FROM peakos_event_checklist_directives WHERE event_id = \$1 LIMIT 1/);
  assert.match(projectLink, /UPDATE events SET project_id = \$1 WHERE id = \$2 AND deleted = FALSE RETURNING id/);
  assert.match(projectLink, /PROJECT_EVENT_DIRECTIVE_CONFLICT/);
  assert.match(projectLink, /client\.query\('COMMIT'\)/);
  assert.match(projectLink, /client\.query\('ROLLBACK'\)/);
});

test('event reorder is locked and authorized as one transaction before any update', () => {
  const reorder = sourceBetween(
    "app.post('/api/events/reorder'",
    '// ══ 휴무일 관리',
  );
  const begin = reorder.indexOf("client.query('BEGIN')");
  const lock = reorder.indexOf('FOR UPDATE');
  const authorize = reorder.indexOf('authorizeEventReorder');
  const update = reorder.indexOf('UPDATE events SET sort_order');
  const commit = reorder.indexOf("client.query('COMMIT')");
  assert.ok(begin >= 0 && begin < lock);
  assert.ok(lock < authorize);
  assert.ok(authorize < update);
  assert.ok(update < commit);
  assert.match(reorder, /await client\.query\('ROLLBACK'\)/);
});
