'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const multer = require('multer');

const {
  PEAKOS_COLLABORATION_PREFIX,
  createPeakosCollaborationGateway,
  getPeakosCollaborationContext,
  isPeakosCollaborationAuthenticated,
  resolvePeakosCollaborationTarget,
} = require('./peakos-collaboration-routes');

function request(method, url, headers = {}) {
  return {
    method,
    url,
    headers,
    get(name) {
      return this.headers[String(name).toLowerCase()];
    },
  };
}

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test('resolves the reviewed collaboration surface to the identical legacy API URL', () => {
  const cases = [
    ['GET', '/events?from=2026-08-01&to=2026-08-31'],
    ['POST', '/events'],
    ['POST', '/events/reorder'],
    ['PUT', '/events/event-1/checklist/item-1'],
    ['DELETE', '/events/event-1/comments/comment-1'],
    ['GET', '/users/all-approved'],
    ['POST', '/chat-rooms/room-1/messages'],
    ['POST', '/chat-rooms/room-1/upload-file'],
    ['GET', '/chat-rooms/room-1/unread-counts'],
    ['POST', '/projects'],
    ['GET', '/projects/my-tasks'],
    ['POST', '/projects/upload'],
    ['PUT', '/projects/project-1/tasks/task-1/completion'],
    ['POST', '/projects/project-1/tasks/task-1/review'],
    ['DELETE', '/projects/project-1/comments/comment-1'],
  ];

  for (const [method, suffix] of cases) {
    const target = resolvePeakosCollaborationTarget(method, `${PEAKOS_COLLABORATION_PREFIX}${suffix}`);
    assert.equal(target.status, 'allowed', `${method} ${suffix}`);
    assert.equal(target.canonicalUrl, `/api${suffix}`);
  }
});

test('allowlist covers every collaboration handler exposed to PEAK OS', () => {
  const cases = [
    ['GET', '/users/all-approved'],
    ['GET', '/events'], ['POST', '/events'], ['POST', '/events/reorder'],
    ['GET', '/events/checklist-summary'], ['PUT', '/events/e-1'],
    ['POST', '/events/e-1/delete-repeat-future'], ['POST', '/events/e-1/delete-repeat-all'],
    ['GET', '/events/e-1/shares'], ['GET', '/events/e-1/checklist'],
    ['POST', '/events/e-1/checklist'], ['PUT', '/events/e-1/checklist/c-1'],
    ['DELETE', '/events/e-1/checklist/c-1'], ['GET', '/events/e-1/comments'],
    ['POST', '/events/e-1/comments'], ['DELETE', '/events/e-1/comments/c-1'],
    ['GET', '/event-types'], ['POST', '/event-types'], ['DELETE', '/event-types/t-1'],
    ['GET', '/todo-cats'], ['POST', '/todo-cats'], ['DELETE', '/todo-cats/t-1'],
    ['GET', '/chat-room-groups'], ['POST', '/chat-room-groups'],
    ['PUT', '/chat-room-groups/g-1'], ['DELETE', '/chat-room-groups/g-1'],
    ['GET', '/chat-rooms'], ['POST', '/chat-rooms'], ['GET', '/chat-rooms/unread'],
    ['GET', '/chat-rooms/delete-requests'], ['PUT', '/chat-rooms/bulk/group'],
    ['POST', '/chat-rooms/bulk/request-delete'], ['POST', '/chat-rooms/bulk/delete'],
    ['PUT', '/chat-rooms/r-1'], ['DELETE', '/chat-rooms/r-1'],
    ['PUT', '/chat-rooms/r-1/group'], ['GET', '/chat-rooms/r-1/members'],
    ['POST', '/chat-rooms/r-1/members'], ['DELETE', '/chat-rooms/r-1/members/u-1'],
    ['POST', '/chat-rooms/r-1/action-items/convert'], ['POST', '/chat-rooms/r-1/leave'],
    ['POST', '/chat-rooms/r-1/request-delete'], ['POST', '/chat-rooms/r-1/reject-delete'],
    ['GET', '/chat-rooms/r-1/typing'], ['POST', '/chat-rooms/r-1/typing'],
    ['GET', '/chat-rooms/r-1/messages'], ['POST', '/chat-rooms/r-1/messages'],
    ['POST', '/chat-rooms/r-1/upload'], ['POST', '/chat-rooms/r-1/upload-file'],
    ['POST', '/chat-rooms/r-1/read'], ['GET', '/chat-rooms/r-1/unread-counts'],
    ['GET', '/projects'], ['POST', '/projects'], ['GET', '/projects/my-tasks'], ['POST', '/projects/upload'],
    ['GET', '/projects/p-1'], ['PUT', '/projects/p-1'], ['DELETE', '/projects/p-1'],
    ['POST', '/projects/p-1/events'], ['POST', '/projects/p-1/meetings'],
    ['POST', '/projects/p-1/tasks'], ['PUT', '/projects/p-1/tasks/t-1'],
    ['DELETE', '/projects/p-1/tasks/t-1'], ['PUT', '/projects/p-1/tasks/t-1/completion'],
    ['POST', '/projects/p-1/tasks/t-1/review'],
    ['POST', '/projects/p-1/tasks/t-1/comments'],
    ['DELETE', '/projects/p-1/tasks/t-1/comments/c-1'],
    ['POST', '/projects/p-1/updates'], ['PUT', '/projects/p-1/updates/u-1'],
    ['DELETE', '/projects/p-1/updates/u-1'], ['POST', '/projects/p-1/comments'],
    ['PUT', '/projects/p-1/comments/c-1'], ['DELETE', '/projects/p-1/comments/c-1'],
  ];

  for (const [method, suffix] of cases) {
    assert.equal(
      resolvePeakosCollaborationTarget(method, `${PEAKOS_COLLABORATION_PREFIX}${suffix}`).status,
      'allowed',
      `${method} ${suffix}`,
    );
  }
});

test('fails closed for unrelated, unsafe, or wrong-method routes', () => {
  assert.equal(
    resolvePeakosCollaborationTarget('POST', `${PEAKOS_COLLABORATION_PREFIX}/users/all-approved`).status,
    'method_not_allowed',
  );
  assert.equal(
    resolvePeakosCollaborationTarget('PUT', `${PEAKOS_COLLABORATION_PREFIX}/events/reorder`).status,
    'method_not_allowed',
  );
  assert.equal(
    resolvePeakosCollaborationTarget('DELETE', `${PEAKOS_COLLABORATION_PREFIX}/chat-rooms/unread`).status,
    'method_not_allowed',
  );
  assert.equal(
    resolvePeakosCollaborationTarget('PUT', `${PEAKOS_COLLABORATION_PREFIX}/projects/upload`).status,
    'method_not_allowed',
  );
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal(
      resolvePeakosCollaborationTarget(method, `${PEAKOS_COLLABORATION_PREFIX}/projects/my-tasks`).status,
      'method_not_allowed',
      `${method} /projects/my-tasks`,
    );
  }
  assert.equal(
    resolvePeakosCollaborationTarget('GET', `${PEAKOS_COLLABORATION_PREFIX}/peakos/bank/accounts`).status,
    'not_found',
  );
  assert.equal(
    resolvePeakosCollaborationTarget('GET', `${PEAKOS_COLLABORATION_PREFIX}/projects/%2e%2e/events`).status,
    'not_found',
  );
  assert.equal(
    resolvePeakosCollaborationTarget('GET', `${PEAKOS_COLLABORATION_PREFIX}/projects/bad\u0000id`).status,
    'not_found',
  );
  assert.equal(resolvePeakosCollaborationTarget('GET', '/api/events'), null);
});

test('gateway authenticates, checks OS session, rewrites, and marks the request', () => {
  const calls = [];
  const gateway = createPeakosCollaborationGateway({
    authMiddleware(req, _res, next) {
      calls.push(['firebase', req.url]);
      req.uid = 'user-1';
      req.userDoc = { uid: 'user-1', approved: true };
      next();
    },
    getRequireOsSession: () => (req, _res, next) => {
      calls.push(['os-session', req.url, req.uid]);
      next();
    },
  });
  const req = request('POST', `${PEAKOS_COLLABORATION_PREFIX}/chat-rooms/room-1/messages?source=os`);
  const res = response();
  let nextCalls = 0;

  gateway(req, res, error => {
    assert.equal(error, undefined);
    nextCalls += 1;
  });

  assert.deepEqual(calls, [
    ['firebase', '/api/chat-rooms/room-1/messages?source=os'],
    ['os-session', '/api/chat-rooms/room-1/messages?source=os', 'user-1'],
  ]);
  assert.equal(req.url, '/api/chat-rooms/room-1/messages?source=os');
  assert.equal(nextCalls, 1);
  assert.equal(isPeakosCollaborationAuthenticated(req), true);
  assert.deepEqual(getPeakosCollaborationContext(req), {
    prefix: PEAKOS_COLLABORATION_PREFIX,
    suffix: '/chat-rooms/room-1/messages',
    canonicalPath: '/api/chat-rooms/room-1/messages',
  });
});

test('gateway rejects preview mutations after both authentication checks', () => {
  const calls = [];
  const gateway = createPeakosCollaborationGateway({
    authMiddleware(_req, _res, next) {
      calls.push('firebase');
      next();
    },
    getRequireOsSession: () => (_req, _res, next) => {
      calls.push('os-session');
      next();
    },
  });
  const req = request(
    'PUT',
    `${PEAKOS_COLLABORATION_PREFIX}/events/event-1`,
    { 'x-peakos-preview': 'true' },
  );
  const res = response();
  let nextCalls = 0;

  gateway(req, res, () => { nextCalls += 1; });

  assert.deepEqual(calls, ['firebase', 'os-session']);
  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.code, 'PEAKOS_PREVIEW_WRITE_FORBIDDEN');
  assert.equal(isPeakosCollaborationAuthenticated(req), false);
});

test('preview reads are allowed and a failed OS session never reaches a legacy handler', () => {
  const previewReadGateway = createPeakosCollaborationGateway({
    authMiddleware(_req, _res, next) { next(); },
    getRequireOsSession: () => (_req, _res, next) => next(),
  });
  const previewRead = request(
    'GET',
    `${PEAKOS_COLLABORATION_PREFIX}/projects`,
    { 'x-peakos-preview': '1' },
  );
  let previewNext = 0;
  previewReadGateway(previewRead, response(), () => { previewNext += 1; });
  assert.equal(previewNext, 1);

  const deniedGateway = createPeakosCollaborationGateway({
    authMiddleware(_req, _res, next) { next(); },
    getRequireOsSession: () => (_req, res) => res.status(401).json({ code: 'OS_AUTH_SESSION_REQUIRED' }),
  });
  const denied = request('POST', `${PEAKOS_COLLABORATION_PREFIX}/events`);
  const deniedResponse = response();
  let deniedNext = 0;
  deniedGateway(denied, deniedResponse, () => { deniedNext += 1; });
  assert.equal(deniedNext, 0);
  assert.equal(deniedResponse.statusCode, 401);
  assert.equal(isPeakosCollaborationAuthenticated(denied), false);
});

test('gateway does not intercept legacy paths and returns stable errors for denied aliases', () => {
  let authCalls = 0;
  const gateway = createPeakosCollaborationGateway({
    authMiddleware(_req, _res, next) { authCalls += 1; next(); },
    getRequireOsSession: () => (_req, _res, next) => next(),
  });
  const legacy = request('GET', '/api/events');
  let legacyNext = 0;
  gateway(legacy, response(), () => { legacyNext += 1; });
  assert.equal(legacyNext, 1);
  assert.equal(authCalls, 0);

  const deniedResponse = response();
  gateway(
    request('POST', `${PEAKOS_COLLABORATION_PREFIX}/users/all-approved`),
    deniedResponse,
    () => assert.fail('denied route must not continue'),
  );
  assert.equal(deniedResponse.statusCode, 405);
  assert.equal(deniedResponse.payload.code, 'PEAKOS_COLLABORATION_METHOD_NOT_ALLOWED');
  assert.equal(authCalls, 0);
});

test('Express rewrite reaches the legacy handler and preserves multipart uploads', async t => {
  const app = express();
  app.use(createPeakosCollaborationGateway({
    authMiddleware(req, _res, next) {
      req.uid = 'user-1';
      req.userDoc = { uid: 'user-1', approved: true };
      next();
    },
    getRequireOsSession: () => (req, _res, next) => {
      req.osSecondAuth = { required: true, verified: true, uid: req.uid };
      next();
    },
  }));
  app.post('/api/chat-rooms/:roomId/upload-file', multer().single('file'), (req, res) => {
    res.json({
      roomId: req.params.roomId,
      filename: req.file?.originalname,
      content: req.file?.buffer?.toString('utf8'),
      authenticated: isPeakosCollaborationAuthenticated(req),
      canonicalPath: getPeakosCollaborationContext(req)?.canonicalPath,
    });
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const form = new FormData();
  form.append('file', new Blob(['same multipart stream']), 'evidence.txt');
  const result = await fetch(
    `http://127.0.0.1:${address.port}${PEAKOS_COLLABORATION_PREFIX}/chat-rooms/room-7/upload-file`,
    { method: 'POST', body: form },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    roomId: 'room-7',
    filename: 'evidence.txt',
    content: 'same multipart stream',
    authenticated: true,
    canonicalPath: '/api/chat-rooms/room-7/upload-file',
  });
});
