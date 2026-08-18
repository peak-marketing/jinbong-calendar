'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeRequest,
  registerPeakosVendorReconciliationRoutes,
  requestDigest,
} = require('./peakos-vendor-reconciliation-routes');

const IDEMPOTENCY_KEY = '123e4567-e89b-42d3-a456-426614174000';
const BATCH_ID = '223e4567-e89b-42d3-a456-426614174000';

function requestBody(overrides = {}) {
  return {
    idempotencyKey: IDEMPOTENCY_KEY,
    supplier: '피크마케팅',
    deliveredQty: 3,
    paidDate: '2026-08-17',
    bank: '공급처통장',
    memo: '공급사 전달 수량 대사 완료',
    rows: [{ id: 'intake-1', expectedRowVersion: 7 }],
    ...overrides,
  };
}

function source(overrides = {}) {
  return {
    id: 'intake-1', workspace_id: 'ws_peak', row_version: 7,
    kind: 'normal', qty: '3', cost: '2000', supplier: '피크마케팅',
    a: '매출', b: '스페이스', c: '[일반] 1장 일반',
    vendor_paid: false, vendor_paid_amount: null, vendor_paid_date: '',
    vendor_bank: '', vendor_by: '', vendor_memo: '',
    ...overrides,
  };
}

function batch(overrides = {}) {
  return {
    id: BATCH_ID, workspace_id: 'ws_peak', supplier: '피크마케팅',
    status: 'COMPLETED', row_version: 1, item_count: 1,
    delivered_qty: '3', settled_qty: '3', total_due: '6000',
    bank_label: '공급처통장', paid_date: '2026-08-17',
    memo: '공급사 전달 수량 대사 완료', completed_by_name: '재무담당',
    completed_at: new Date('2026-08-17T01:00:00.000Z'),
    ...overrides,
  };
}

function item(overrides = {}) {
  return {
    source_intake_id: 'intake-1', source_expected_row_version: 7,
    source_settled_row_version: 8, semantic_qty: '3', cost_per_unit: '2000',
    due_amount: '6000', ...overrides,
  };
}

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers.at(-1)); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers.at(-1)); },
  };
}

function makeResponse() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    vary() { return this; },
  };
}

function makeRequest(overrides = {}) {
  return {
    uid: 'finance-uid',
    userDoc: { approved: true, is_active: true, name: '재무담당' },
    workspace: {
      id: 'ws_peak', role: 'manager', headquartersOversight: false,
      permissions: { settlements: 'write' },
    },
    headers: {}, query: {}, params: {}, body: requestBody(),
    get(name) { return this.headers[String(name).toLowerCase()]; },
    ...overrides,
  };
}

function createClient(queryHandler) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      return queryHandler(normalized, params, calls);
    },
    release() {},
  };
}

function register(client, overrides = {}) {
  const app = makeApp();
  const pool = {
    connect: async () => client,
    query: (...args) => client.query(...args),
  };
  registerPeakosVendorReconciliationRoutes({
    app, pool, authMiddleware() {},
    approvedActive: req => req.userDoc?.approved === true && req.userDoc?.is_active !== false,
    getName: req => req.userDoc?.name,
    canReviewFinance: () => true,
    getWorkspaceId: req => req.workspace?.id,
    clock: () => new Date('2026-08-17T01:00:00.000Z'),
    randomUUID: () => BATCH_ID,
    logger: { error() {} },
    ...overrides,
  });
  return app;
}

function successClient(sourceRow = source()) {
  return createClient((sql, params) => {
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK'
        || sql.startsWith('SELECT pg_advisory_xact_lock') || sql.startsWith('SET CONSTRAINTS')) return { rows: [] };
    if (sql.startsWith('SELECT id, request_digest FROM peakos_vendor_settlement_batches')) return { rows: [] };
    if (sql.includes('FROM peakos_intake') && sql.includes('id = ANY')) return { rows: [sourceRow] };
    if (sql.includes('FROM peakos_intake') && sql.includes("kind IN ('normal','use')")) return { rows: [sourceRow] };
    if (sql.startsWith('INSERT INTO peakos_vendor_settlement_batches')) return { rows: [batch()] };
    if (sql.startsWith('INSERT INTO peakos_vendor_settlement_items')) return { rows: [item()] };
    if (sql.startsWith('UPDATE peakos_intake')) return { rows: [{
      ...sourceRow, row_version: 8, vendor_paid: true, vendor_paid_amount: '6000',
      vendor_paid_date: '2026-08-17', vendor_bank: '공급처통장',
      vendor_by: '재무담당', vendor_memo: '공급사 전달 수량 대사 완료',
    }] };
    if (sql.startsWith('INSERT INTO peakos_intake_audit_log')) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

test('요청 정규화는 정렬된 행 버전과 exact 필드만 허용한다', () => {
  const normalized = normalizeRequest(requestBody({
    rows: [
      { id: 'z-row', expectedRowVersion: 2 },
      { id: 'a-row', expectedRowVersion: 1 },
    ],
  }));
  assert.deepEqual(normalized.rows.map(row => row.id), ['a-row', 'z-row']);
  assert.equal(requestDigest(normalized).length, 64);
  assert.throws(() => normalizeRequest({ ...requestBody(), amount: 1 }), /허용되지 않은/);
  assert.throws(() => normalizeRequest(requestBody({
    rows: [{ id: 'same', expectedRowVersion: 1 }, { id: 'same', expectedRowVersion: 1 }],
  })), /중복/);
  assert.throws(() => normalizeRequest(requestBody({ deliveredQty: 1.5 })), /정수/);
});

test('성공 시 서버가 수량·원가를 재계산하고 배치/항목/원장 audit을 한 트랜잭션에 저장한다', async () => {
  const client = successClient();
  const app = register(client);
  const res = makeResponse();
  await app.routes.get('POST /api/peakos/vendor-reconciliations')(makeRequest(), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.totalDue, 6000);
  assert.equal(res.body.settledQty, 3);
  assert.equal(res.body.rows[0].rowVersion, 8);
  assert.ok(client.calls.some(call => call.sql.startsWith('BEGIN ISOLATION LEVEL SERIALIZABLE')));
  assert.ok(client.calls.some(call => call.sql.startsWith('INSERT INTO peakos_vendor_settlement_batches')));
  assert.ok(client.calls.some(call => call.sql.startsWith('INSERT INTO peakos_vendor_settlement_items')));
  assert.ok(client.calls.some(call => call.sql.startsWith('INSERT INTO peakos_intake_audit_log')));
  assert.ok(client.calls.some(call => call.sql.startsWith('SET CONSTRAINTS')));
  assert.equal(client.calls.some(call => /transfer|withdraw|payment_api/i.test(call.sql)), false);
});

test('공급사 전달 수량 불일치는 insert 전에 rollback한다', async () => {
  const client = successClient();
  const app = register(client);
  const res = makeResponse();
  await app.routes.get('POST /api/peakos/vendor-reconciliations')(
    makeRequest({ body: requestBody({ deliveredQty: 2 }) }), res,
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'VENDOR_RECONCILIATION_QTY_MISMATCH');
  assert.equal(client.calls.some(call => call.sql.startsWith('INSERT INTO peakos_vendor_settlement_batches')), false);
  assert.ok(client.calls.some(call => call.sql === 'ROLLBACK'));
});

test('원가 누락과 행 버전 충돌은 모두 fail closed다', async () => {
  for (const [sourceRow, expectedCode] of [
    [source({ cost: null }), 'VENDOR_RECONCILIATION_COST_REQUIRED'],
    [source({ row_version: 8 }), 'VENDOR_RECONCILIATION_VERSION_CONFLICT'],
  ]) {
    const client = successClient(sourceRow);
    const app = register(client);
    const res = makeResponse();
    await app.routes.get('POST /api/peakos/vendor-reconciliations')(makeRequest(), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, expectedCode);
    assert.equal(client.calls.some(call => call.sql.startsWith('INSERT INTO peakos_vendor_settlement_batches')), false);
  }
});

test('브라우저가 공급사 미지급 행을 일부 누락하면 stale conflict다', async () => {
  const selected = source();
  const omitted = source({ id: 'intake-2', row_version: 3, qty: '1', cost: '1000' });
  const client = createClient((sql) => {
    if (sql.startsWith('BEGIN') || sql === 'ROLLBACK' || sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith('SELECT id, request_digest')) return { rows: [] };
    if (sql.includes('id = ANY')) return { rows: [selected] };
    if (sql.includes("kind IN ('normal','use')")) return { rows: [selected, omitted] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const app = register(client);
  const res = makeResponse();
  await app.routes.get('POST /api/peakos/vendor-reconciliations')(makeRequest(), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'VENDOR_RECONCILIATION_SELECTION_STALE');
});

test('다른 workspace의 source id는 generic 404이고 어떤 row도 갱신하지 않는다', async () => {
  const client = createClient((sql) => {
    if (sql.startsWith('BEGIN') || sql === 'ROLLBACK' || sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith('SELECT id, request_digest')) return { rows: [] };
    if (sql.includes('id = ANY')) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const app = register(client);
  const res = makeResponse();
  await app.routes.get('POST /api/peakos/vendor-reconciliations')(makeRequest(), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'VENDOR_RECONCILIATION_SOURCE_NOT_FOUND');
  assert.equal(client.calls.some(call => call.sql.startsWith('UPDATE peakos_intake')), false);
});

test('preview와 oversight/read-only는 쓰기를 거부한다', async () => {
  const client = successClient();
  const app = register(client);
  for (const req of [
    makeRequest({ headers: { 'x-peakos-preview': 'true' } }),
    makeRequest({ workspace: {
      id: 'ws_daegu', role: 'oversight', headquartersOversight: true,
      permissions: { settlements: 'read' },
    } }),
  ]) {
    const res = makeResponse();
    await app.routes.get('POST /api/peakos/vendor-reconciliations')(req, res);
    assert.equal(res.statusCode, 403);
  }
  assert.equal(client.calls.length, 0);
});

test('동일 idempotency payload는 기존 배치를 재사용하고 다른 payload는 충돌한다', async () => {
  const normalized = normalizeRequest(requestBody());
  for (const [storedDigest, expectedStatus, expectedCode] of [
    [requestDigest(normalized), 200, undefined],
    ['0'.repeat(64), 409, 'VENDOR_RECONCILIATION_IDEMPOTENCY_CONFLICT'],
  ]) {
    const client = createClient((sql) => {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK'
          || sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
      if (sql.startsWith('SELECT id, request_digest')) return { rows: [{ id: BATCH_ID, request_digest: storedDigest }] };
      if (sql.startsWith('SELECT * FROM peakos_vendor_settlement_batches')) return { rows: [batch()] };
      if (sql.startsWith('SELECT * FROM peakos_vendor_settlement_items')) return { rows: [item()] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const app = register(client);
    const res = makeResponse();
    await app.routes.get('POST /api/peakos/vendor-reconciliations')(makeRequest(), res);
    assert.equal(res.statusCode, expectedStatus);
    if (expectedCode) assert.equal(res.body.code, expectedCode);
    else assert.equal(res.body.replayed, true);
    assert.equal(client.calls.some(call => call.sql.startsWith('UPDATE peakos_intake')), false);
  }
});

test('batch 상세 조회는 workspace 조건을 강제하고 다른 tenant에는 404다', async () => {
  const client = createClient((sql) => {
    if (sql.startsWith('SELECT * FROM peakos_vendor_settlement_batches')) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const app = register(client);
  const req = makeRequest({ params: { batchId: BATCH_ID } });
  const res = makeResponse();
  await app.routes.get('GET /api/peakos/vendor-reconciliations/:batchId')(req, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(client.calls[0].params, ['ws_peak', BATCH_ID]);
});
