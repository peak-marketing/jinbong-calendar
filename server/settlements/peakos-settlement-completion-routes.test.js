'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  registerPeakosSettlementCompletionRoutes,
} = require('./peakos-settlement-completion-routes');

const NOW = new Date('2026-08-17T12:00:00.000Z');

function source(overrides = {}) {
  return {
    id: 'monthly-source-1', owner_uid: 'owner-uid', view: 'monthly-guarantee',
    kind: 'sale', c: '월보장', workspace_id: 'ws_peak', ...overrides,
  };
}

function completionCase(overrides = {}) {
  return {
    workspace_id: 'ws_peak', source_monthly_id: 'monthly-source-1',
    rule_code: 'MONTHLY_GUARANTEE_25D', status: 'OPEN', row_version: 1,
    exposure_started_at: new Date('2026-07-20T00:00:00.000Z'),
    exposure_completed_at: new Date('2026-08-15T00:00:00.000Z'),
    service_started_at: null, service_completed_at: null,
    completed_issue_count: null, eighth_issue_completed_at: null,
    evidence_updated_at: NOW, evidence_updated_by_name: '관리자',
    settlement_completed_at: null, settlement_completed_by_name: null,
    settlement_completion_reason: null, frozen_at: null, frozen_by_name: null,
    freeze_reason: null, reopened_at: null, reopened_by_name: null, reopen_reason: null,
    ...overrides,
  };
}

function fakeApp() {
  const routes = new Map();
  const add = method => (pathname, ...handlers) => routes.set(`${method} ${pathname}`, handlers.at(-1));
  return { routes, get: add('GET'), put: add('PUT'), post: add('POST') };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function request({ role = 'manager', permission = 'write', uid = 'manager-uid', body = {}, params = {}, headers = {}, query = {} } = {}) {
  return {
    uid, body, params, headers, query,
    workspace: {
      id: 'ws_peak', role, headquartersOversight: role === 'oversight',
      permissions: { settlements: permission },
    },
    get(name) { return headers[String(name).toLowerCase()]; },
  };
}

function register(pool, options = {}) {
  const app = fakeApp();
  registerPeakosSettlementCompletionRoutes({
    app,
    authMiddleware: (_req, _res, next) => next(),
    pool,
    approvedActive: () => true,
    getName: () => '관리자',
    getWorkspaceId: req => req.workspace.id,
    clock: () => NOW,
    logger: { error() {} },
    ...options,
  });
  return app.routes;
}

function readPool(sourceRow, caseRow = null) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('FROM peakos_monthly')) return { rows: sourceRow ? [sourceRow] : [] };
      if (sql.includes('FROM peakos_settlement_completion_cases')) return { rows: caseRow ? [caseRow] : [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async connect() { throw new Error('read route must not connect'); },
  };
}

function mutationPool({ sourceRow = source(), caseRow = null, resultRow = null } = {}) {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      if (sql.includes('FROM peakos_monthly')) return { rows: sourceRow ? [sourceRow] : [] };
      if (sql.includes('FROM peakos_settlement_completion_cases')) return { rows: caseRow ? [caseRow] : [] };
      if (sql.includes('INSERT INTO peakos_settlement_completion_cases')
          || sql.includes('UPDATE peakos_settlement_completion_cases')) {
        return { rows: [resultRow || caseRow] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  return { calls, async connect() { return client; } };
}

test('GET returns an untracked, fail-closed pending state without creating evidence', async () => {
  const pool = readPool(source());
  const routes = register(pool);
  const req = request({ role: 'member', permission: 'read', uid: 'owner-uid', params: { sourceId: 'monthly-source-1' } });
  const res = response();
  await routes.get('GET /api/peakos/settlement-completion/:sourceId')(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.tracked, false);
  assert.equal(res.payload.rowVersion, 0);
  assert.equal(res.payload.eligibility.eligible, false);
  assert.deepEqual(res.payload.eligibility.reasons.map(item => item.code), [
    'MISSING_EXPOSURE_STARTED_AT', 'MISSING_EXPOSURE_COMPLETED_AT',
  ]);
  assert.equal(pool.calls.some(call => /INSERT|UPDATE|DELETE/.test(call.sql)), false);
});

test('GET denies another ordinary member and keeps the source query workspace-scoped', async () => {
  const pool = readPool(source());
  const routes = register(pool);
  const req = request({ role: 'member', permission: 'read', uid: 'other-uid', params: { sourceId: 'monthly-source-1' } });
  const res = response();
  await routes.get('GET /api/peakos/settlement-completion/:sourceId')(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.code, 'SETTLEMENT_COMPLETION_READ_FORBIDDEN');
  assert.match(pool.calls[0].sql, /workspace_id = \$2/);
  assert.deepEqual(pool.calls[0].values, ['monthly-source-1', 'ws_peak']);
});

test('member and preview manager evidence writes fail before acquiring a database client', async () => {
  let connects = 0;
  const pool = { async connect() { connects += 1; throw new Error('must not connect'); } };
  const routes = register(pool);
  for (const req of [
    request({ role: 'member', params: { sourceId: 'monthly-source-1' } }),
    request({ role: 'oversight', permission: 'write', params: { sourceId: 'monthly-source-1' } }),
    request({ role: 'manager', headers: { 'x-peakos-preview': 'true' }, params: { sourceId: 'monthly-source-1' } }),
  ]) {
    req.body = { expectedVersion: 0, reason: '권한 차단 회귀 테스트 사유', evidence: {} };
    const res = response();
    await routes.get('PUT /api/peakos/settlement-completion/:sourceId/evidence')(req, res);
    assert.equal(res.statusCode, 403);
  }
  assert.equal(connects, 0);
});

test('manager records explicit evidence with version 0, derived rule and a serialized transaction', async () => {
  const row = completionCase();
  const pool = mutationPool({ caseRow: null, resultRow: row });
  const routes = register(pool);
  const req = request({
    params: { sourceId: 'monthly-source-1' },
    body: {
      expectedVersion: 0,
      reason: '월보장 노출 완료 근거 최초 입력',
      evidence: {
        exposureStartedAt: '2026-07-20T09:00:00+09:00',
        exposureCompletedAt: '2026-08-15T09:00:00+09:00',
      },
    },
  });
  const res = response();
  await routes.get('PUT /api/peakos/settlement-completion/:sourceId/evidence')(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ruleCode, 'MONTHLY_GUARANTEE_25D');
  const inserted = pool.calls.find(call => call.sql.includes('INSERT INTO peakos_settlement_completion_cases'));
  assert.ok(inserted);
  assert.equal(inserted.values[2], 'MONTHLY_GUARANTEE_25D');
  assert.deepEqual(pool.calls.filter(call => ['BEGIN', 'COMMIT'].includes(call.sql)).map(call => call.sql), ['BEGIN', 'COMMIT']);
  assert.match(pool.calls[1].sql, /pg_advisory_xact_lock/);
});

test('complete returns explicit eligibility reasons and rolls back before UPDATE when evidence is incomplete', async () => {
  const directSource = source({ view: 'direct-execution', c: '담당자' });
  const pending = completionCase({
    rule_code: 'DIRECT_EXECUTION_8TH', completed_issue_count: 7,
    eighth_issue_completed_at: null, exposure_started_at: null, exposure_completed_at: null,
  });
  const pool = mutationPool({ sourceRow: directSource, caseRow: pending });
  const routes = register(pool);
  const req = request({
    params: { sourceId: 'monthly-source-1', action: 'complete' },
    body: { expectedVersion: 1, reason: '완료조건 검증 회귀 테스트 수행' },
  });
  const res = response();
  await routes.get('POST /api/peakos/settlement-completion/:sourceId/:action')(req, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'SETTLEMENT_COMPLETION_NOT_ELIGIBLE');
  assert.deepEqual(res.payload.details.reasons.map(item => item.code), [
    'EIGHTH_ISSUANCE_NOT_COMPLETED', 'MISSING_EIGHTH_ISSUANCE_COMPLETED_AT',
  ]);
  assert.equal(pool.calls.some(call => call.sql.includes('UPDATE peakos_settlement_completion_cases')), false);
  assert.equal(pool.calls.some(call => call.sql === 'ROLLBACK'), true);
});

test('every lifecycle mutation requires the exact current row version', async () => {
  const pool = mutationPool({ caseRow: completionCase({ row_version: 4 }) });
  const routes = register(pool);
  const req = request({
    params: { sourceId: 'monthly-source-1', action: 'complete' },
    body: { expectedVersion: 3, reason: '동시성 버전 충돌 회귀 테스트' },
  });
  const res = response();
  await routes.get('POST /api/peakos/settlement-completion/:sourceId/:action')(req, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'SETTLEMENT_COMPLETION_VERSION_CONFLICT');
});

test('reopen is admin-only even when a manager has settlement write permission', async () => {
  const frozen = completionCase({ status: 'FROZEN', row_version: 3 });
  const pool = mutationPool({ caseRow: frozen });
  const routes = register(pool);
  const req = request({
    role: 'manager', params: { sourceId: 'monthly-source-1', action: 'reopen' },
    body: { expectedVersion: 3, reason: '관리자 전용 재개 권한 회귀 테스트' },
  });
  const res = response();
  await routes.get('POST /api/peakos/settlement-completion/:sourceId/:action')(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.code, 'SETTLEMENT_COMPLETION_REOPEN_FORBIDDEN');
  assert.equal(pool.calls.length, 0);
});

test('eligible completion, freeze and admin reopen use distinct audited lifecycle transitions', async () => {
  const eligible = completionCase();
  const completed = completionCase({
    status: 'COMPLETED', row_version: 2,
    settlement_completed_at: NOW,
    settlement_completed_by_uid: 'manager-uid',
    settlement_completed_by_name: '관리자',
    settlement_completion_reason: '월보장 노출 완료 확인 후 정산 완료',
  });
  const frozen = completionCase({
    ...completed,
    status: 'FROZEN', row_version: 3,
    frozen_at: NOW, frozen_by_uid: 'manager-uid', frozen_by_name: '관리자',
    freeze_reason: '최종 지급 자료 확정 후 정산 동결',
  });
  const reopened = completionCase({
    status: 'OPEN', row_version: 4,
    reopened_at: NOW, reopened_by_uid: 'admin-uid', reopened_by_name: '관리자',
    reopen_reason: '원본 정정 요청 확인을 위한 정산 재개',
  });
  const scenarios = [
    {
      action: 'complete', role: 'manager', uid: 'manager-uid', current: eligible,
      result: completed, expectedVersion: 1,
      reason: '월보장 노출 완료 확인 후 정산 완료', status: 'COMPLETED', sql: /status='COMPLETED'/,
    },
    {
      action: 'freeze', role: 'manager', uid: 'manager-uid', current: completed,
      result: frozen, expectedVersion: 2,
      reason: '최종 지급 자료 확정 후 정산 동결', status: 'FROZEN', sql: /status='FROZEN'/,
    },
    {
      action: 'reopen', role: 'admin', uid: 'admin-uid', current: frozen,
      result: reopened, expectedVersion: 3,
      reason: '원본 정정 요청 확인을 위한 정산 재개', status: 'OPEN', sql: /status='OPEN'/,
    },
  ];

  for (const scenario of scenarios) {
    const pool = mutationPool({ caseRow: scenario.current, resultRow: scenario.result });
    const routes = register(pool);
    const req = request({
      role: scenario.role,
      uid: scenario.uid,
      params: { sourceId: 'monthly-source-1', action: scenario.action },
      body: { expectedVersion: scenario.expectedVersion, reason: scenario.reason },
    });
    const res = response();
    await routes.get('POST /api/peakos/settlement-completion/:sourceId/:action')(req, res);
    assert.equal(res.statusCode, 200, scenario.action);
    assert.equal(res.payload.status, scenario.status, scenario.action);
    assert.equal(res.payload.rowVersion, scenario.expectedVersion + 1, scenario.action);
    assert.match(
      pool.calls.find(call => call.sql.includes('UPDATE peakos_settlement_completion_cases')).sql,
      scenario.sql,
    );
    assert.deepEqual(
      pool.calls.filter(call => ['BEGIN', 'COMMIT'].includes(call.sql)).map(call => call.sql),
      ['BEGIN', 'COMMIT'],
    );
  }
});

test('audit history is workspace-scoped, bounded and read-only', async () => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('FROM peakos_monthly')) return { rows: [source()] };
      if (sql.includes('FROM peakos_settlement_completion_audit')) {
        return { rows: [{
          action: 'COMPLETED', row_version: 2, actor_name: '관리자',
          reason: '월보장 노출 완료 확인 후 정산 완료', created_at: NOW,
        }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async connect() { throw new Error('audit read must not connect'); },
  };
  const routes = register(pool);
  const req = request({
    role: 'admin', params: { sourceId: 'monthly-source-1' }, query: { limit: '25' },
  });
  const res = response();
  await routes.get('GET /api/peakos/settlement-completion/:sourceId/audit')(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.rows, [{
    action: 'COMPLETED', rowVersion: 2, actorName: '관리자',
    reason: '월보장 노출 완료 확인 후 정산 완료', createdAt: NOW.toISOString(),
  }]);
  const auditQuery = calls.find(call => call.sql.includes('peakos_settlement_completion_audit'));
  assert.match(auditQuery.sql, /workspace_id = \$1 AND source_monthly_id = \$2/);
  assert.deepEqual(auditQuery.values, ['ws_peak', 'monthly-source-1', 25]);
  assert.equal(calls.some(call => /INSERT|UPDATE|DELETE/.test(call.sql)), false);
});
