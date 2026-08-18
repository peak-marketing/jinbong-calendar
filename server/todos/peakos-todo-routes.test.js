'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');

const {
  registerPeakosTodoRoutes,
} = require('./peakos-todo-routes');

const TODO_ID = '11111111-1111-4111-8111-111111111111';

function actor(overrides = {}) {
  return {
    uid: 'owner-uid',
    userName: '김대호',
    userDoc: {
      name: '김대호', approved: true, is_active: true,
      chat_only: false, external_calendar_only: false,
    },
    workspaceSelectedByHeader: true,
    workspace: {
      id: 'ws_peak', role: 'member', headquartersOversight: false,
      permissions: { calendar: 'write' },
    },
    ...overrides,
  };
}

function todoRow(overrides = {}) {
  return {
    workspace_id: 'ws_peak',
    id: TODO_ID,
    owner_uid: 'owner-uid',
    owner_name_snapshot: '김대호',
    title: '오늘 할 일',
    todo_date: '2026-08-18',
    start_time: '09:00:00',
    end_time: '10:00:00',
    category: '일반',
    memo: '확인',
    done: false,
    sort_order: 3,
    archived: false,
    archived_at: null,
    version: 1,
    created_at: '2026-08-18T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

function poolWith({ query, connect } = {}) {
  return {
    query: query || (async () => ({ rows: [] })),
    connect: connect || (async () => ({
      query: async () => ({ rows: [] }),
      release() {},
    })),
  };
}

function appWith(pool, requestActor, options = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, requestActor);
    next();
  });
  registerPeakosTodoRoutes({
    app,
    pool,
    ensureInfrastructure: options.ensureInfrastructure || (async () => true),
    randomUUID: () => TODO_ID,
  });
  return app;
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function call(server, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

test('GET is exact self/workspace/date scoped, private, and uses canonical items DTO', async t => {
  const statements = [];
  const pool = poolWith({
    async query(sql, values) {
      statements.push({ sql, values });
      return { rows: [todoRow()] };
    },
  });
  const server = await listen(appWith(pool, actor()));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await call(server, '/api/peakos/todos?date=2026-08-18');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(statements[0].values, ['ws_peak', 'owner-uid', '2026-08-18']);
  assert.match(statements[0].sql, /workspace_id = \$1[\s\S]*owner_uid = \$2[\s\S]*todo_date = \$3/);
  assert.deepEqual(Object.keys(result.body).sort(), [
    'capabilities', 'date', 'items', 'readOnly', 'timeZone',
  ]);
  assert.equal(result.body.items[0].startTime, '09:00');
  assert.equal(result.body.items[0].ownerUid, 'owner-uid');
  assert.equal(result.body.items[0].version, 1);
});

test('GET accurately exposes read-only capability for calendar-read direct members', async t => {
  const readOnlyActor = actor({
    workspace: {
      id: 'ws_peak', role: 'member', headquartersOversight: false,
      permissions: { calendar: 'read' },
    },
  });
  const server = await listen(appWith(poolWith(), readOnlyActor));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await call(server, '/api/peakos/todos?date=2026-08-18');
  assert.equal(result.status, 200);
  assert.equal(result.body.readOnly, true);
  assert.deepEqual(result.body.capabilities, {
    create: false, edit: false, reorder: false, archive: false,
  });
});

test('preview denial happens before readiness or any database query', async t => {
  let readinessCalls = 0;
  let databaseCalls = 0;
  const previewActor = actor({ headers: { 'x-peakos-preview': '1' } });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, previewActor);
    req.get = name => previewActor.headers[String(name).toLowerCase()];
    next();
  });
  registerPeakosTodoRoutes({
    app,
    pool: poolWith({
      query: async () => { databaseCalls += 1; return { rows: [] }; },
      connect: async () => { databaseCalls += 1; throw new Error('must not connect'); },
    }),
    ensureInfrastructure: async () => { readinessCalls += 1; },
  });
  const server = await listen(app);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await call(server, '/api/peakos/todos?date=2026-08-18');
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'TODO_PREVIEW_FORBIDDEN');
  assert.equal(readinessCalls, 0);
  assert.equal(databaseCalls, 0);
});

test('POST rejects owner override and creates only the authenticated owner snapshot', async t => {
  const statements = [];
  const pool = poolWith({
    async query(sql, values) {
      statements.push({ sql, values });
      return { rows: [todoRow({ title: values[4] })] };
    },
  });
  const server = await listen(appWith(pool, actor()));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const forbidden = await call(server, '/api/peakos/todos', {
    method: 'POST',
    body: { title: '속임 시도', date: '2026-08-18', ownerUid: 'other-uid' },
  });
  assert.equal(forbidden.status, 400);
  assert.equal(statements.length, 0);

  const created = await call(server, '/api/peakos/todos', {
    method: 'POST',
    body: { title: '독립 할 일', date: '2026-08-18', memo: '첫째\n둘째' },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.body), ['item']);
  assert.equal(statements[0].values[0], 'ws_peak');
  assert.equal(statements[0].values[2], 'owner-uid');
  assert.equal(statements[0].values[3], '김대호');
});

function transactionPool(queryHandler) {
  const statements = [];
  return {
    statements,
    pool: poolWith({
      async connect() {
        return {
          async query(sql, values) {
            statements.push({ sql, values });
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
            return queryHandler(sql, values, statements);
          },
          release() {},
        };
      },
    }),
  };
}

test('PATCH is optimistic, increments once, and returns canonical item DTO', async t => {
  const tx = transactionPool(async sql => {
    if (/SELECT[\s\S]*FOR UPDATE/.test(sql)) return { rows: [todoRow()] };
    if (/UPDATE peakos_todos/.test(sql)) {
      return { rows: [todoRow({ title: '변경됨', version: 2 })] };
    }
    return { rows: [] };
  });
  const server = await listen(appWith(tx.pool, actor()));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await call(server, `/api/peakos/todos/${TODO_ID}`, {
    method: 'PATCH', body: { title: '변경됨', expectedVersion: 1 },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.item.version, 2);
  assert.equal(result.body.item.title, '변경됨');
  assert.equal(tx.statements.at(-1).sql, 'COMMIT');
});

test('cross-owner and cross-workspace direct PATCH probes return the same 404 without mutation', async t => {
  const observed = [];
  const makePool = () => transactionPool(async (_sql, values) => {
    observed.push(values);
    return { rows: [] };
  }).pool;
  for (const requestActor of [
    actor({ uid: 'other-owner' }),
    actor({ workspace: {
      id: 'ws_branch', role: 'member', headquartersOversight: false,
      permissions: { calendar: 'write' },
    } }),
  ]) {
    const server = await listen(appWith(makePool(), requestActor));
    const result = await call(server, `/api/peakos/todos/${TODO_ID}`, {
      method: 'PATCH', body: { done: true, expectedVersion: 1 },
    });
    await new Promise(resolve => server.close(resolve));
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'TODO_NOT_FOUND');
  }
  assert.deepEqual(observed[0], ['ws_peak', TODO_ID, 'other-owner']);
  assert.deepEqual(observed[1], ['ws_branch', TODO_ID, 'owner-uid']);
});

test('reorder locks the complete self-owned set and rolls back atomically on a missing row', async t => {
  const tx = transactionPool(async sql => {
    if (/SELECT[\s\S]*ANY\(\$3::uuid\[\]\)/.test(sql)) return { rows: [todoRow()] };
    throw new Error('mutation must not run for an incomplete lock set');
  });
  const second = '22222222-2222-4222-8222-222222222222';
  const server = await listen(appWith(tx.pool, actor()));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await call(server, '/api/peakos/todos/reorder', {
    method: 'POST',
    body: { items: [
      { id: TODO_ID, sortOrder: 0, expectedVersion: 1 },
      { id: second, sortOrder: 1, expectedVersion: 1 },
    ] },
  });
  assert.equal(result.status, 404);
  assert.equal(tx.statements.at(-1).sql, 'ROLLBACK');
  assert.equal(tx.statements.some(entry => /UPDATE peakos_todos/.test(entry.sql)), false);
});

test('successful reorder returns canonical items and increments each version exactly once', async t => {
  const second = '22222222-2222-4222-8222-222222222222';
  const tx = transactionPool(async (sql, values) => {
    if (/SELECT[\s\S]*ANY\(\$3::uuid\[\]\)/.test(sql)) {
      return { rows: [todoRow(), todoRow({ id: second, sort_order: 4 })] };
    }
    if (/UPDATE peakos_todos/.test(sql)) {
      return { rows: [todoRow({ id: values[1], sort_order: values[3], version: 2 })] };
    }
    return { rows: [] };
  });
  const server = await listen(appWith(tx.pool, actor()));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await call(server, '/api/peakos/todos/reorder', {
    method: 'POST',
    body: { items: [
      { id: TODO_ID, sortOrder: 1, expectedVersion: 1 },
      { id: second, sortOrder: 2, expectedVersion: 1 },
    ] },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body), ['items']);
  assert.deepEqual(result.body.items.map(item => [item.id, item.sortOrder, item.version]), [
    [TODO_ID, 1, 2], [second, 2, 2],
  ]);
  assert.equal(tx.statements.filter(entry => /UPDATE peakos_todos/.test(entry.sql)).length, 2);
  assert.equal(tx.statements.at(-1).sql, 'COMMIT');
});

test('DELETE performs a versioned soft archive and never issues SQL DELETE', async t => {
  const tx = transactionPool(async sql => {
    if (/SELECT version[\s\S]*FOR UPDATE/.test(sql)) return { rows: [{ version: 4 }] };
    if (/UPDATE peakos_todos/.test(sql)) return { rows: [{ id: TODO_ID, version: 5 }] };
    return { rows: [] };
  });
  const server = await listen(appWith(tx.pool, actor()));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await call(server, `/api/peakos/todos/${TODO_ID}`, {
    method: 'DELETE', body: { expectedVersion: 4 },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { deleted: TODO_ID, version: 5 });
  assert.equal(tx.statements.some(entry => /^DELETE\s/i.test(entry.sql)), false);
  const update = tx.statements.find(entry => /UPDATE peakos_todos/.test(entry.sql));
  assert.match(update.sql, /archived = TRUE[\s\S]*last_action = 'ARCHIVE'/);
});
