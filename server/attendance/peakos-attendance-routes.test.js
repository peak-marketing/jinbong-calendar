'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');

const {
  createLegacyAttendanceHandlers,
  createPeakosAttendanceService,
  registerPeakosAttendanceRoutes,
} = require('./peakos-attendance-routes');

const FIXED_NOW = new Date('2026-08-17T00:31:30.000Z'); // 09:31 KST

function actor({
  uid = 'member-1', role = 'member', permission = 'write', oversight = false,
  workspaceId = 'ws_daegu', preview = false,
} = {}) {
  return {
    uid,
    userName: uid,
    userDoc: {
      name: uid,
      approved: true,
      is_active: true,
      group_id: 'sales-daegu',
      chat_only: false,
      external_calendar_only: false,
    },
    workspace: {
      id: workspaceId,
      role,
      permissions: { settlements: permission },
      headquartersOversight: oversight,
    },
    headers: preview ? { 'x-peakos-preview': '1' } : {},
  };
}

function attendanceRow(overrides = {}) {
  return {
    id: 'attendance-1',
    workspace_id: 'ws_daegu',
    user_id: 'member-1',
    user_name: 'member-1',
    attendance_date: '2026-08-17',
    check_in: '09:31',
    check_out: null,
    check_in_at: FIXED_NOW,
    check_out_at: null,
    group_id: 'sales-daegu',
    row_version: 1,
    worked_minutes: null,
    is_holiday: false,
    ...overrides,
  };
}

function fakePool({ query, clientQuery } = {}) {
  const client = {
    statements: [],
    async query(sql, values) {
      this.statements.push({ sql: String(sql), values });
      if (clientQuery) return clientQuery(String(sql), values, this.statements);
      return { rows: [] };
    },
    release() {},
  };
  return {
    statements: [],
    client,
    async query(sql, values) {
      this.statements.push({ sql: String(sql), values });
      if (query) return query(String(sql), values, this.statements);
      return { rows: [] };
    },
    async connect() { return client; },
  };
}

function buildApp(pool, requestActor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, requestActor);
    req.headers = { ...req.headers, ...requestActor.headers };
    next();
  });
  registerPeakosAttendanceRoutes({
    app,
    pool,
    now: () => FIXED_NOW,
    ensureInfrastructure: async () => true,
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

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function call(server, pathname, { method = 'GET' } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { method });
  const body = await response.json();
  return { status: response.status, body, headers: response.headers };
}

test('member month read is bound to the authenticated UID and selected workspace', async () => {
  const pool = fakePool({
    query: async () => ({ rows: [attendanceRow()] }),
  });
  const server = await listen(buildApp(pool, actor()));
  try {
    const response = await call(server, '/api/peakos/attendance/month?month=2026-08');
    assert.equal(response.status, 200);
    assert.equal(response.body.scope, 'self');
    assert.equal(response.body.records[0].userUid, 'member-1');
    assert.equal(response.body.timeZone, 'Asia/Seoul');
    assert.match(pool.statements[0].sql, /attendance_row\.workspace_id = \$1/);
    assert.match(pool.statements[0].sql, /attendance_row\.user_id = \$4/);
    assert.deepEqual(pool.statements[0].values, [
      'ws_daegu', '2026-08-01', '2026-09-01', 'member-1',
    ]);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  } finally {
    await close(server);
  }
});

test('forged target/team and preview reads stop before attendance SQL', async () => {
  for (const [requestActor, query] of [
    [actor(), '?month=2026-08&scope=team'],
    [actor(), '?month=2026-08&targetUid=another-user'],
    [actor({ preview: true }), '?month=2026-08'],
  ]) {
    const pool = fakePool();
    const server = await listen(buildApp(pool, requestActor));
    try {
      const response = await call(server, `/api/peakos/attendance/month${query}`);
      assert.equal(response.status, 403);
      assert.equal(pool.statements.length, 0);
    } finally {
      await close(server);
    }
  }
});

test('same-workspace manager and oversight receive team summaries without cross-tenant SQL', async () => {
  for (const requestActor of [
    actor({ uid: 'manager-1', role: 'manager' }),
    actor({ uid: 'oversight-1', role: 'oversight', permission: 'read', oversight: true }),
  ]) {
    const pool = fakePool({
      query: async sql => {
        if (/FROM attendance attendance_row/.test(sql)) {
          return { rows: [attendanceRow({ user_id: 'member-2', user_name: 'member-2' })] };
        }
        if (/FROM peakos_workspace_memberships membership/.test(sql)) {
          return { rows: [{
            uid: 'member-2', name: 'member-2', email: '', group_id: 'sales-daegu',
            membership_role: 'member',
          }] };
        }
        return { rows: [] };
      },
    });
    const server = await listen(buildApp(pool, requestActor));
    try {
      const response = await call(
        server,
        '/api/peakos/attendance/month?month=2026-08&scope=team',
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.scope, 'team');
      assert.equal(response.body.readOnly, requestActor.workspace.headquartersOversight);
      assert.equal(response.body.summary[0].presentDays, 1);
      assert.equal(pool.statements.length, 2);
      assert.equal(pool.statements[0].values[0], 'ws_daegu');
      assert.equal(pool.statements[1].values[0], 'ws_daegu');
      assert.match(pool.statements[1].sql, /membership\.workspace_id = \$1/);
      if (requestActor.workspace.role === 'manager') {
        assert.match(pool.statements[0].sql, /scoped_user\.group_id = \$4/);
        assert.deepEqual(pool.statements[0].values.slice(0, 4), [
          'ws_daegu', '2026-08-01', '2026-09-01', 'sales-daegu',
        ]);
        assert.match(pool.statements[1].sql, /users\.group_id = \$2/);
        assert.deepEqual(pool.statements[1].values, ['ws_daegu', 'sales-daegu']);
      } else {
        assert.doesNotMatch(pool.statements[0].sql, /scoped_user\.group_id/);
        assert.deepEqual(pool.statements[0].values, ['ws_daegu', '2026-08-01', '2026-09-01']);
        assert.doesNotMatch(pool.statements[1].sql, /AND users\.group_id/);
        assert.deepEqual(pool.statements[1].values, ['ws_daegu']);
      }
    } finally {
      await close(server);
    }
  }
});

test('manager target filtering retains the current-group predicate', async () => {
  const pool = fakePool({
    query: async () => ({ rows: [] }),
  });
  const server = await listen(buildApp(pool, actor({
    uid: 'manager-1', role: 'manager',
  })));
  try {
    const response = await call(
      server,
      '/api/peakos/attendance/month?month=2026-08&scope=team&targetUid=other-group-user',
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.records.length, 0);
    assert.equal(response.body.members.length, 0);
    assert.match(pool.statements[0].sql, /scoped_user\.group_id = \$4/);
    assert.match(pool.statements[0].sql, /attendance_row\.user_id = \$5/);
    assert.deepEqual(pool.statements[0].values, [
      'ws_daegu', '2026-08-01', '2026-09-01', 'sales-daegu', 'other-group-user',
    ]);
    assert.match(pool.statements[1].sql, /users\.group_id = \$2/);
    assert.match(pool.statements[1].sql, /users\.uid = \$3/);
    assert.deepEqual(pool.statements[1].values, [
      'ws_daegu', 'sales-daegu', 'other-group-user',
    ]);
  } finally {
    await close(server);
  }
});

test('oversight mutation is rejected before a transaction is opened', async () => {
  const pool = fakePool();
  const server = await listen(buildApp(pool, actor({
    uid: 'oversight-1', role: 'oversight', permission: 'read', oversight: true,
  })));
  try {
    const response = await call(server, '/api/peakos/attendance/check-in', { method: 'POST' });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'PEAKOS_WORKSPACE_READ_ONLY');
    assert.equal(pool.client.statements.length, 0);
  } finally {
    await close(server);
  }
});

test('check-in writes a KST record and one append-only event, then retries idempotently', async () => {
  let insertAttempts = 0;
  const pool = fakePool({
    clientQuery: async sql => {
      if (/INSERT INTO attendance/.test(sql)) {
        insertAttempts += 1;
        return { rows: insertAttempts === 1 ? [attendanceRow()] : [] };
      }
      if (/SELECT[\s\S]+FROM attendance attendance_row/.test(sql)) {
        return { rows: [attendanceRow()] };
      }
      return { rows: [] };
    },
  });
  const service = createPeakosAttendanceService({
    pool,
    now: () => FIXED_NOW,
    ensureInfrastructure: async () => true,
  });

  const first = await service.checkIn(actor());
  const second = await service.checkIn(actor());
  assert.equal(first.alreadyRecorded, false);
  assert.equal(second.alreadyRecorded, true);
  assert.equal(first.record.date, '2026-08-17');
  assert.equal(first.record.checkIn, '09:31');
  const inserts = pool.client.statements.filter(statement => /INSERT INTO peakos_attendance_events/.test(statement.sql));
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0].values.slice(0, 4), [
    'ws_daegu', 'attendance-1', 'member-1', 'member-1',
  ]);
});

test('check-out requires today check-in and is write-once/idempotent', async () => {
  const missingPool = fakePool({
    clientQuery: async sql => (/FOR UPDATE/.test(sql) ? { rows: [] } : { rows: [] }),
  });
  const missingService = createPeakosAttendanceService({
    pool: missingPool, now: () => FIXED_NOW, ensureInfrastructure: async () => true,
  });
  await assert.rejects(
    missingService.checkOut(actor()),
    error => error.code === 'ATTENDANCE_CHECK_IN_REQUIRED' && error.statusCode === 409,
  );

  const checkedOutAt = new Date('2026-08-17T09:31:30.000Z');
  const existingPool = fakePool({
    clientQuery: async sql => {
      if (/FOR UPDATE/.test(sql)) {
        return { rows: [attendanceRow({
          check_out: '18:31', check_out_at: checkedOutAt, row_version: 2,
        })] };
      }
      return { rows: [] };
    },
  });
  const existingService = createPeakosAttendanceService({
    pool: existingPool, now: () => FIXED_NOW, ensureInfrastructure: async () => true,
  });
  const response = await existingService.checkOut(actor());
  assert.equal(response.alreadyRecorded, true);
  assert.equal(response.record.checkOut, '18:31');
  assert.equal(
    existingPool.client.statements.filter(statement => /^UPDATE attendance/.test(statement.sql.trim())).length,
    0,
  );
});

test('legacy details handler rejects a forged userId for an ordinary member', async () => {
  const pool = fakePool();
  const service = createPeakosAttendanceService({
    pool, now: () => FIXED_NOW, ensureInfrastructure: async () => true,
  });
  const handlers = createLegacyAttendanceHandlers({ service });
  const req = { ...actor(), query: { month: '2026-08', userId: 'another-user' } };
  let status = 200;
  let payload = null;
  const res = {
    status(value) { status = value; return this; },
    json(value) { payload = value; return this; },
  };
  await handlers.details(req, res);
  assert.equal(status, 403);
  assert.equal(payload.code, 'ATTENDANCE_TARGET_FORBIDDEN');
  assert.equal(pool.statements.length, 0);
});
