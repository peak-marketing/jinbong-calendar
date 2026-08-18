'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CALCULATION_INSERT_SQL,
  calculationOut,
  databaseCalculationValues,
  estimateDateRange,
  registerPeakosCommissionRoutes,
  requestIsPreview,
} = require('./peakos-commission-routes');
const { calculateCommission } = require('./peakos-commission-policy');

function harness(pool) {
  const routes = new Map();
  const app = {
    get(path, _auth, handler) { routes.set(`GET ${path}`, handler); },
    post(path, _auth, handler) { routes.set(`POST ${path}`, handler); },
  };
  registerPeakosCommissionRoutes({
    app,
    authMiddleware: (_req, _res, next) => next(),
    pool,
    getName: req => req.userDoc.name,
    clock: () => new Date('2026-08-17T12:00:00.000Z'),
    logger: { error() {} },
  });
  return routes;
}

function req(overrides = {}) {
  return {
    uid: 'sales_a', headers: {}, query: {}, body: {}, params: {},
    userDoc: { approved: true, is_active: true, name: 'Sales A' },
    workspace: {
      id: 'ws_peak', role: 'sales', headquartersOversight: false,
      permissions: { settlements: 'read' },
    },
    get(name) { return this.headers[String(name).toLowerCase()]; },
    ...overrides,
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(value) { this.statusCode = value; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

function ledgerRow(overrides = {}) {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', source_owner_uid: 'sales_a',
    source_owner_name: 'Sales A', source_business_date: '2026-08-17',
    source_platform: 'reviewspace', source_product_a: '매출', source_product_b: '플랫폼',
    source_product_c: '리뷰', calculation_status: 'CALCULATED',
    estimated_commission_amount: '7500', payout_eligible: false,
    payout_blockers: ['SETTLEMENT_COMPLETION_UNCONFIRMED', 'SUPPLIER_RECONCILIATION_INCOMPLETE'], rate_basis_points: 1250,
    calculated_at: '2026-08-17T12:00:00.000Z', source_intake_id: 'intake_1',
    source_row_version: 4, sales_amount: '200000', salesperson_supply_amount: '140000',
    commission_base_amount: '60000', rule_version_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    rule_series_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', rule_version: 2,
    source_snapshot_sha256: 'a'.repeat(64), calculated_by_name: 'Manager',
    ...overrides,
  };
}

test('preview persona/header는 읽기 API도 사용할 수 없다', async () => {
  const pool = { connect() {}, async query() { throw new Error('database must not run'); } };
  const routes = harness(pool);
  for (const headers of [
    { 'x-peakos-preview': '1' },
    { 'x-peakos-preview-persona': 'Sales A' },
    { 'x-peakos-preview-owner': 'sales_a' },
  ]) {
    assert.equal(requestIsPreview(req({ headers })), true);
    const res = response();
    await routes.get('GET /api/peakos/commission-calculations')(req({ headers }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'COMMISSION_PREVIEW_FORBIDDEN');
  }
});

test('예상 수당 조회 기간은 KST 이번 달이 기본이며 최대 1년이다', () => {
  assert.deepEqual(estimateDateRange({}, new Date('2026-08-31T15:30:00.000Z')), {
    from: '2026-09-01', to: '2026-09-01',
  });
  assert.deepEqual(estimateDateRange({ from: '2026-01-01', to: '2026-12-31' }, new Date()), {
    from: '2026-01-01', to: '2026-12-31',
  });
  assert.deepEqual(estimateDateRange({ from: '2024-01-01', to: '2024-12-31' }, new Date()), {
    from: '2024-01-01', to: '2024-12-31',
  });
  assert.throws(
    () => estimateDateRange({ from: '2025-01-01', to: '2026-01-02' }, new Date()),
    error => error.code === 'COMMISSION_DATE_RANGE_TOO_WIDE',
  );
});

test('일반 영업자 estimate는 자기 행만 조회하고 rule 0개를 금액 null로 반환한다', async () => {
  const calls = [];
  const pool = {
    connect() {},
    async query(statement, params) {
      calls.push({ statement, params });
      if (/FROM peakos_intake source/.test(statement)) return { rows: [{
        id: 'intake_1', owner_uid: 'sales_a', owner_name: 'Sales A', date: '2026-08-17',
        created_at: '2026-08-17T00:00:00Z', row_version: 1, kind: 'normal',
        a: '매출', b: '플랫폼', c: '리뷰', qty: 1, sell: 100000, unit: 70000,
        source_metadata: { provider: 'reviewspace' }, vendor_paid: false,
        batch_id: null, source_settled_row_version: null,
      }] };
      return { rows: [] };
    },
  };
  const routes = harness(pool);
  const request = req({ query: { ownerUid: 'sales_b', from: '2026-08-01', to: '2026-08-31' } });
  const res = response();
  await routes.get('GET /api/peakos/commission-estimates')(request, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0].params, ['ws_peak', '2026-08-01', '2026-08-31', 'sales_a']);
  assert.match(calls[0].statement, /source\.owner_uid = \$4/);
  assert.equal(res.body.estimates[0].status, 'UNCONFIGURED');
  assert.equal(res.body.estimates[0].label, '규칙 미설정');
  assert.equal(res.body.estimates[0].estimatedCommissionAmount, null);
  assert.equal(res.body.estimates[0].sourceId, 'intake_1');
});

test('일반 영업자 목록은 서버 SQL에서 자기 UID로 강제 제한된다', async () => {
  let values;
  let sql;
  const pool = {
    connect() {},
    async query(statement, params) { sql = statement; values = params; return { rows: [ledgerRow()] }; },
  };
  const routes = harness(pool);
  const request = req({ query: { ownerUid: 'sales_b' } });
  const res = response();
  await routes.get('GET /api/peakos/commission-calculations')(request, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(values, ['ws_peak', 'sales_a']);
  assert.match(sql, /workspace_id = \$1[\s\S]*source_owner_uid = \$2/);
  assert.equal(res.body.calculations[0].sourceId, 'intake_1');
  assert.equal('ruleVersionId' in res.body.calculations[0], false);
});

test('oversight 목록은 선택 workspace에 고정되고 민감 원가·원본 ID가 마스킹된다', async () => {
  let values;
  const pool = {
    connect() {},
    async query(_statement, params) { values = params; return { rows: [ledgerRow()] }; },
  };
  const routes = harness(pool);
  const request = req({
    uid: 'oversight', query: {},
    workspace: { id: 'ws_branch', role: 'oversight', headquartersOversight: true, permissions: { settlements: 'read' } },
  });
  const res = response();
  await routes.get('GET /api/peakos/commission-calculations')(request, res);
  assert.deepEqual(values, ['ws_branch']);
  const item = res.body.calculations[0];
  assert.equal(item.estimatedCommissionAmount, 7500);
  assert.equal('sourceId' in item, false);
  assert.equal('salespersonSupplyAmount' in item, false);
  assert.equal('ruleVersionId' in item, false);
});

test('calculation DTO는 규칙 미설정 금액을 null로 유지한다', () => {
  const output = calculationOut(ledgerRow({
    calculation_status: 'UNCONFIGURED', estimated_commission_amount: null,
    rate_basis_points: null, sales_amount: null, salesperson_supply_amount: null,
    commission_base_amount: null, rule_version_id: null, rule_series_id: null, rule_version: null,
    payout_blockers: ['COMMISSION_RULE_UNCONFIGURED'],
  }));
  assert.equal(output.label, '규칙 미설정');
  assert.equal(output.estimatedCommissionAmount, null);
  assert.equal(output.payoutEligible, false);
});

test('DB insert payload는 서버 재계산 snapshot 35개 값만 사용한다', () => {
  const source = {
    id: 'intake_1', owner_uid: 'sales_a', owner_name: 'Sales A', date: '2026-08-17',
    row_version: 4, kind: 'normal', a: '매출', b: '플랫폼', c: '리뷰', qty: 2,
    sell: 100000, unit: 70000, vendor_paid: true, source_metadata: { provider: 'reviewspace' },
  };
  const rule = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    rule_series_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', version: 2,
    status: 'APPROVED', scope_owner_uid: null, scope_platform: null,
    scope_product_a: null, scope_product_b: null, scope_product_c: null,
    rate_basis_points: 1250, effective_from: '2026-08-01', effective_to: null,
  };
  const vendor = { batch_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', source_settled_row_version: 4 };
  const result = calculateCommission(source, [rule], vendor);
  const values = databaseCalculationValues({
    workspace: 'ws_peak', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    inputFingerprint: 'f'.repeat(64), result, vendorEvidence: vendor,
    who: { uid: 'manager', name: 'Manager' }, now: new Date('2026-08-17T12:00:00Z'),
  });
  assert.equal(values.length, 35);
  assert.equal((CALCULATION_INSERT_SQL.match(/\$\d+/g) || []).length, 35);
  assert.equal(values[17], 200000);
  assert.equal(values[18], 140000);
  assert.equal(values[19], 60000);
  assert.equal(values[25], 7500);
});
