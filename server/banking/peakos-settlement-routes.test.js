'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SettlementRouteError,
  intakeOut,
  monthlyOut,
  normalizeMonthlyCreate,
  normalizeMonthlyPatch,
  registerPeakosSettlementRoutes,
  resolvePreviewOwnerUid,
  validateRelationship,
} = require('./peakos-settlement-routes');

const actor = { uid: 'employee-uid-1', name: '테스트 직원' };

test('intake canonical response는 행 버전과 지급액을 주되 일반 계정 원가는 가린다', () => {
  const row = {
    id: 'intake-1', owner_uid: actor.uid, owner_name: actor.name, row_version: '7',
    date: '2026-08-09', client: '거래처', a: '대', b: '중', c: '소',
    unit: '10000', qty: '2', sell: '100000', cost: '30000', kind: 'normal',
    expected_deposit_amount: '220000', paid: 'partial', paid_amount: '110000',
    vendor_paid: true, vendor_paid_amount: '60000', source_document_id: 'source-document-id',
  };
  const ordinary = intakeOut(row);
  assert.equal(ordinary.rowVersion, 7);
  assert.equal(ordinary.cost, null);
  assert.equal(ordinary.vendorPaidAmount, null);
  assert.equal(ordinary.vendorPaid, true);
  assert.equal(ordinary.vendorBank, '');
  assert.equal(ordinary.importedFromSettlementSheet, true);
  const privileged = intakeOut(row, { showCost: true, showVendor: true });
  assert.equal(privileged.cost, 30000);
  assert.equal(privileged.vendorPaidAmount, 60000);
  assert.equal(privileged.vendorPaid, true);
  assert.equal(Object.hasOwn(ordinary, 'sourceDocumentId'), false);
});

test('PostgreSQL DATE는 UTC 변환으로 전날이 되지 않고 한국 달력 날짜를 보존한다', () => {
  const databaseDate = new Date('2026-06-03T15:00:00.000Z');
  const intake = intakeOut({
    id: 'intake-date', row_version: 1, date: databaseDate, kind: 'normal',
  });
  const monthly = monthlyOut({
    id: 'monthly-date', row_version: 1, date: databaseDate, kind: 'sale',
  });
  assert.equal(intake.date, '2026-06-04');
  assert.equal(monthly.date, '2026-06-04');
});

test('monthly 신규 요청은 서버 소유자·view를 강제하고 원본·버전 필드를 거부한다', () => {
  const [row] = normalizeMonthlyCreate({ rows: [{
    id: 'monthly-sale-1', kind: 'sale', parentId: '', date: '2026-08-09',
    client: '업체', a: '월보장', b: '판매', c: '상품', amount: 500000,
    qty: 1, period: '', memo: '테스트',
  }] }, actor, 'monthly-guarantee');
  assert.equal(row.owner_uid, actor.uid);
  assert.equal(row.view, 'monthly-guarantee');
  assert.equal(row.parent_id, '');
  assert.throws(() => normalizeMonthlyCreate({ rows: [{
    id: 'monthly-sale-2', kind: 'sale', date: '2026-08-09', client: '업체',
    a: '', b: '', c: '', amount: 1, qty: 1, period: '', memo: '', rowVersion: 9,
  }] }, actor, 'monthly-guarantee'), error => (
    error instanceof SettlementRouteError && error.code === 'MONTHLY_FIELDS_NOT_ALLOWED'
  ));
});

test('monthly PATCH는 kind·parentId·source lineage를 수정하지 못하고 버전을 요구한다', () => {
  const [row] = normalizeMonthlyPatch({ rows: [{
    id: 'monthly-run-1', expectedRowVersion: 3, changes: { memo: '고친 메모', amount: 30000 },
  }] });
  assert.equal(row.expectedRowVersion, 3);
  assert.deepEqual(row.changes, { memo: '고친 메모', amount: 30000 });
  for (const changes of [{ parentId: 'sale-2' }, { kind: 'sale' }, { sourceDocumentId: 'secret' }]) {
    assert.throws(() => normalizeMonthlyPatch({ rows: [{
      id: 'monthly-run-1', expectedRowVersion: 3, changes,
    }] }), error => error.code === 'MONTHLY_FIELDS_NOT_ALLOWED');
  }
  assert.throws(() => normalizeMonthlyPatch({ rows: [{
    id: 'monthly-run-1', expectedRowVersion: 0, changes: { memo: 'x' },
  }] }), error => error.code === 'ROW_VERSION_REQUIRED');
});

test('monthly canonical response는 고아 실행 건 parentId와 행 버전을 그대로 보존한다', () => {
  const output = monthlyOut({
    id: 'orphan-run', row_version: 4, kind: 'run', parent_id: 'old-missing-sale',
    date: '2026-07-13', client: '과거업체', amount: 44000, qty: 1,
    source_document_id: 'source-document-id',
  });
  assert.equal(output.parentId, 'old-missing-sale');
  assert.equal(output.rowVersion, 4);
  assert.equal(output.importedFromSettlementSheet, true);
});

test('관계 없는 normal/reserve에는 refOf를 허용하지 않고 legacy ref-less는 비금액 edit만 허용한다', async () => {
  const noQuery = { query: async () => { throw new Error('DB를 조회하면 안 됩니다.'); } };
  await assert.rejects(
    validateRelationship(noQuery, { kind: 'normal', ref_of: 'foreign-row' }),
    error => error.code === 'INTAKE_RELATION_NOT_ALLOWED',
  );
  const legacy = { id: 'legacy-use', kind: 'use', ref_of: '' };
  const memoOnly = { ...legacy, memo: '일반 메모 수정' };
  assert.equal(await validateRelationship(noQuery, memoOnly, {
    current: legacy, changedFields: ['memo'],
  }), memoOnly);
  await assert.rejects(
    validateRelationship(noQuery, { ...legacy, qty: 2 }, { current: legacy, changedFields: ['qty'] }),
    error => error.code === 'INTAKE_RELATION_REQUIRED',
  );
});

test('refund는 현재 catalog가 아니라 잠근 parent snapshot과 수량 비례 expected를 파생한다', async () => {
  const parent = {
    id: 'normal-parent', owner_uid: actor.uid, final_only: false, kind: 'normal', qty: 4,
    client: '원업체', a: '원대', b: '원중', c: '원소', unit: 30000, sell: 100000,
    cost: 17000, supplier: '원공급처', expected_deposit_amount: 440000,
  };
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT * FROM peakos_intake WHERE id = $1')) return { rows: [parent] };
      if (normalized.startsWith('SELECT id, kind, qty')) return { rows: [{ id: 'old-refund', qty: 1 }] };
      throw new Error(`unexpected query: ${normalized}`);
    },
  };
  const currentRefund = {
    id: 'new-refund', owner_uid: actor.uid, final_only: false, kind: 'refund', ref_of: parent.id,
    qty: 2, client: '과거값', a: '과거값', b: '과거값', c: '과거값', unit: 1,
    sell: 1, cost: 1, supplier: '과거값', expected_deposit_amount: 1,
  };
  const refund = await validateRelationship(client, {
    id: 'new-refund', owner_uid: actor.uid, final_only: false, kind: 'refund', ref_of: parent.id,
    qty: 2, client: '브라우저변조', a: '변조', b: '변조', c: '변조', unit: 1,
    sell: 1, cost: 1, supplier: '변조', expected_deposit_amount: 1,
  }, { current: currentRefund, changedFields: ['a'] });
  assert.deepEqual({
    client: refund.client, a: refund.a, b: refund.b, c: refund.c,
    unit: refund.unit, sell: refund.sell, cost: refund.cost, supplier: refund.supplier,
    expected: refund.expected_deposit_amount,
  }, {
    client: '원업체', a: '원대', b: '원중', c: '원소', unit: 30000,
    sell: 100000, cost: 17000, supplier: '원공급처', expected: 220000,
  });
});

test('reserve 사용 잔여는 use의 refund child를 수량·VAT 금액에서 되돌려 계산한다', async () => {
  const parent = {
    id: 'reserve-parent', owner_uid: actor.uid, final_only: false, kind: 'reserve', qty: 10,
    client: '예약업체', memo: '8월 예약', a: '예약대', b: '예약중', c: '예약소',
    unit: 30000, sell: 100000, cost: null, supplier: '',
    expected_deposit_amount: 1100000,
    paid: 'paid', paid_amount: 1100000,
  };
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT * FROM peakos_intake WHERE id = $1')) return { rows: [parent] };
      if (normalized.startsWith('SELECT id, kind, qty')) {
        return { rows: [{ id: 'use-old', kind: 'use', qty: 8, expected_deposit_amount: 880000 }] };
      }
      if (normalized.startsWith("SELECT id, qty, expected_deposit_amount")) {
        return { rows: [{ id: 'refund-old', qty: 3, expected_deposit_amount: 330000 }] };
      }
      throw new Error(`unexpected query: ${normalized}`);
    },
  };
  const candidate = {
    id: 'use-new', owner_uid: actor.uid, final_only: false, kind: 'use', ref_of: parent.id,
    client: '브라우저변조', memo: '브라우저변조', a: '변조대', b: '변조중', c: '변주소',
    unit: 1, sell: 1, cost: 17000, supplier: '실행기본공급처', qty: 5,
    expected_deposit_amount: 1,
  };
  const canonical = await validateRelationship(client, candidate);
  assert.deepEqual({
    client: canonical.client, memo: canonical.memo, a: canonical.a, b: canonical.b,
    c: canonical.c, unit: canonical.unit, sell: canonical.sell, cost: canonical.cost,
    supplier: canonical.supplier, expected: canonical.expected_deposit_amount,
  }, {
    client: parent.client, memo: parent.memo, a: parent.a, b: parent.b,
    c: parent.c, unit: parent.unit, sell: parent.sell, cost: 17000,
    supplier: '실행기본공급처', expected: 550000,
  });
  await assert.rejects(
    validateRelationship(client, { ...candidate, qty: 6 }),
    error => error.code === 'INTAKE_RESERVE_LIMIT_EXCEEDED',
  );
});

function captureRoutes(client, overrides = {}) {
  const routes = new Map();
  const app = {};
  const directPeakWorkspace = {
    id: 'ws_peak',
    role: 'member',
    headquartersOversight: false,
    permissions: { settlements: 'write' },
  };
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
    app[method] = (path, ...handlers) => {
      const handler = handlers.at(-1);
      routes.set(`${method.toUpperCase()} ${path}`, (req, res) => handler({
        query: {},
        ...req,
        workspace: req.workspace || directPeakWorkspace,
      }, res));
    };
  }
  registerPeakosSettlementRoutes({
    app, authMiddleware: (_req, _res, next) => next(),
    pool: { connect: async () => client, query: (...args) => client.query(...args) },
    monthlyOwners: { 'monthly-guarantee': '김지홍' },
    approvedActive: overrides.approvedActive || (() => true), getName: () => actor.name,
    canSeeAll: overrides.canSeeAll || (() => false),
    canReadOwnerUid: overrides.canReadOwnerUid || (() => false),
    canManageMonthly: overrides.canManageMonthly || (() => true),
    canSeeMonthly: overrides.canSeeMonthly || (() => true),
    canSeeFinalExecution: overrides.canSeeFinalExecution || (() => false),
    canReviewFinance: overrides.canReviewFinance || (() => false),
    canManageBankEligibility: overrides.canManageBankEligibility || (() => false),
    autoReconciliationEnabled: overrides.autoReconciliationEnabled || false,
    getWorkspaceId: req => req.workspace?.id,
    logger: { error() {} },
  });
  return routes;
}

function responseCapture() {
  return {
    statusCode: 200, payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    set() { return this; },
  };
}

test('intake POST는 create-only 트랜잭션·catalog 파생·감사 후 canonical v1을 반환한다', async () => {
  const statements = [];
  const inserted = {
    id: 'intake-create-1', owner_uid: actor.uid, owner_name: actor.name,
    row_version: 1, date: '2026-08-09', client: '업체', expected_payer: '업체',
    a: '대', b: '중', c: '소', unit: 20000, qty: 1, sell: 100000,
    cost: 7000, kind: 'normal', paid: 'none', paid_amount: 0,
    vendor_paid: false, vendor_paid_amount: null,
  };
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push(normalized);
      if (normalized.startsWith('SELECT id FROM peakos_intake ')) return { rows: [] };
      if (normalized.startsWith('SELECT target_id FROM peakos_intake_tombstones')) return { rows: [] };
      if (normalized.startsWith('SELECT key, a, b, c, cost, unit')) {
        return { rows: [{ key: '대|중|소', a: '대', b: '중', c: '소', cost: '7000', unit: '20000' }] };
      }
      if (normalized.startsWith('INSERT INTO peakos_intake (')) return { rows: [inserted] };
      return { rows: [] };
    },
    release() {},
  };
  const handler = captureRoutes(client).get('POST /api/peakos/intake');
  const req = {
    uid: actor.uid, headers: {}, body: { rows: [{
      id: inserted.id, date: inserted.date, client: '업체', expectedPayer: '업체',
      a: '대', b: '중', c: '소', unit: 99999, qty: 1, sell: 100000,
      expectedDepositAmount: 110000, memo: '', kind: 'normal', refOf: '', supplier: '',
    }] },
  };
  const res = responseCapture();
  await handler(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.rows[0].rowVersion, 1);
  assert.equal(res.payload.rows[0].unit, 20000);
  assert.equal(res.payload.rows[0].cost, null);
  assert.ok(statements.includes('BEGIN'));
  assert.ok(statements.some(sql => sql.startsWith('INSERT INTO peakos_intake_audit_log')));
  assert.equal(statements.at(-1), 'COMMIT');
});

test('신규 use는 cost/supplier 없는 imported reserve에서도 현재 catalog 원가와 실행 기본 공급처를 보존한다', async () => {
  const parent = {
    id: 'imported-reserve', owner_uid: actor.uid, owner_name: actor.name, row_version: 1,
    date: '2026-07-01', client: '예약업체', expected_payer: '예약업체',
    a: '예약대', b: '예약중', c: '예약소', unit: 30000, qty: 10, sell: 100000,
    cost: null, memo: '7월 예약', kind: 'reserve', ref_of: '', supplier: '',
    final_only: false, expected_deposit_amount: 1100000, paid: 'paid', paid_amount: 1100000,
  };
  let insertedValues;
  const client = {
    async query(sql, values) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT id FROM peakos_intake ')) return { rows: [] };
      if (normalized.startsWith('SELECT target_id FROM peakos_intake_tombstones')) return { rows: [] };
      if (normalized.startsWith('SELECT * FROM peakos_intake WHERE id = $1 AND')) return { rows: [parent] };
      if (normalized.startsWith('SELECT id, kind, qty')) return { rows: [] };
      if (normalized.startsWith('SELECT key, a, b, c, cost, unit')) {
        return { rows: [{
          key: '예약대|예약중|예약소', a: '예약대', b: '예약중', c: '예약소',
          cost: '17000', unit: '45000', is_base: true, is_custom: false,
        }] };
      }
      if (normalized.startsWith('INSERT INTO peakos_intake (')) {
        insertedValues = values;
        return { rows: [{
          id: values[0], owner_uid: values[1], owner_name: values[2], row_version: 1,
          date: values[3], client: values[4], expected_payer: values[5],
          expected_deposit_amount: values[6], a: values[7], b: values[8], c: values[9],
          unit: values[10], qty: values[11], sell: values[12], cost: values[13], memo: values[14],
          kind: values[15], ref_of: values[16], supplier: values[17], final_only: values[19],
          paid: values[20], paid_amount: values[21], vendor_paid: values[26],
        }] };
      }
      return { rows: [] };
    }, release() {},
  };
  const res = responseCapture();
  await captureRoutes(client).get('POST /api/peakos/intake')({
    uid: actor.uid, headers: {}, body: { rows: [{
      id: 'new-use', date: '2026-08-09', client: '브라우저변조', expectedPayer: '',
      a: '변조대', b: '변조중', c: '변주소', unit: 1, qty: 2, sell: 1,
      expectedDepositAmount: 1, memo: '브라우저변조', kind: 'use', refOf: parent.id,
      supplier: '실행기본공급처',
    }] },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(insertedValues[4], parent.client);
  assert.deepEqual(insertedValues.slice(7, 10), [parent.a, parent.b, parent.c]);
  assert.equal(insertedValues[10], parent.unit, '판매/예약 unit snapshot은 부모 기준이어야 한다');
  assert.equal(insertedValues[12], parent.sell);
  assert.equal(insertedValues[13], 17000, '실행 원가는 현재 catalog에서 파생해야 한다');
  assert.equal(insertedValues[17], '실행기본공급처', '빈 예약 공급처가 실행 공급처를 지우면 안 된다');
  assert.equal(insertedValues[6], 220000);
});

test('intake PATCH stale version은 UPDATE 없이 전체 트랜잭션을 rollback한다', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push(normalized);
      if (normalized.startsWith('SELECT * FROM peakos_intake WHERE id = ANY')) {
        return { rows: [{ id: 'intake-1', owner_uid: actor.uid, row_version: 2 }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const handler = captureRoutes(client).get('PATCH /api/peakos/intake');
  const req = {
    uid: actor.uid, headers: {}, body: {
      action: 'business',
      rows: [{ id: 'intake-1', expectedRowVersion: 1, changes: { memo: '오래된 수정' } }],
    },
  };
  const res = responseCapture();
  await handler(req, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'INTAKE_VERSION_CONFLICT');
  assert.equal(statements.some(sql => sql.startsWith('UPDATE peakos_intake')), false);
  assert.equal(statements.at(-1), 'ROLLBACK');
});

test('intake POST는 기존 행 또는 tombstone ID가 하나라도 있으면 묶음 전체를 거부한다', async () => {
  for (const conflictQuery of ['intake', 'tombstone']) {
    const statements = [];
    const client = {
      async query(sql) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        statements.push(normalized);
        if (normalized.startsWith('SELECT id FROM peakos_intake ')) {
          return { rows: conflictQuery === 'intake' ? [{ id: 'intake-existing' }] : [] };
        }
        if (normalized.startsWith('SELECT target_id FROM peakos_intake_tombstones')) {
          return { rows: conflictQuery === 'tombstone' ? [{ target_id: 'intake-existing' }] : [] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const handler = captureRoutes(client).get('POST /api/peakos/intake');
    const res = responseCapture();
    await handler({ uid: actor.uid, headers: {}, body: { rows: [{
      id: 'intake-existing', date: '2026-08-09', client: '업체', a: '대', b: '중', c: '소',
      unit: 10000, qty: 1, sell: 100000, expectedDepositAmount: 110000,
      memo: '', kind: 'normal', refOf: '', supplier: '',
    }] } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.code, 'INTAKE_CREATE_ID_CONFLICT');
    assert.equal(statements.some(sql => sql.startsWith('INSERT INTO peakos_intake (')), false);
    assert.equal(statements.at(-1), 'ROLLBACK');
  }
});

test('일반 owner는 payment/vendor/manager 액션을 실행할 수 없다', async () => {
  for (const action of ['payment', 'vendor', 'manager']) {
    const statements = [];
    const current = {
      id: 'intake-1', owner_uid: actor.uid, row_version: 1, kind: 'normal',
      expected_deposit_amount: 110000, paid_amount: 0,
    };
    const client = {
      async query(sql) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        statements.push(normalized);
        if (normalized.startsWith('SELECT * FROM peakos_intake WHERE id = ANY')) return { rows: [current] };
        return { rows: [] };
      }, release() {},
    };
    const changes = action === 'payment'
      ? { paidAmount: 110000, payer: '입금자', paidDate: '2026-08-09', paidMemo: '매출통장 입금 확인 완료' }
      : action === 'vendor'
        ? { vendorPaid: true, vendorPaidDate: '2026-08-09', vendorBank: '공급처통장', vendorMemo: '공급처 통장 지급 완료' }
        : { manager: '김대호' };
    const res = responseCapture();
    await captureRoutes(client).get('PATCH /api/peakos/intake')({
      uid: actor.uid, headers: {}, body: { action, rows: [{ id: current.id, expectedRowVersion: 1, changes }] },
    }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'INTAKE_ACTION_FORBIDDEN');
    assert.equal(statements.some(sql => sql.startsWith('UPDATE peakos_intake')), false);
    assert.equal(statements.at(-1), 'ROLLBACK');
  }
});

test('intake business PATCH 성공은 row_version을 증가시키고 감사 후 commit한다', async () => {
  const statements = [];
  const current = {
    id: 'intake-1', owner_uid: actor.uid, owner_name: actor.name, row_version: 1,
    date: '2026-08-09', client: '업체', a: '대', b: '중', c: '소', unit: 10000,
    qty: 1, sell: 100000, cost: 3000, memo: '', kind: 'normal', ref_of: '',
    expected_deposit_amount: 110000, paid: 'none', paid_amount: 0,
    bank_match_eligible: false, paid_auto: false, vendor_paid: false,
  };
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push(normalized);
      if (normalized.startsWith('SELECT * FROM peakos_intake WHERE id = ANY')) return { rows: [current] };
      if (normalized.startsWith('SELECT intake_id FROM peakos_bank_allocations')) return { rows: [] };
      if (normalized.startsWith('UPDATE peakos_intake')) return { rows: [{ ...current, memo: '서버 수정 메모', row_version: 2 }] };
      return { rows: [] };
    }, release() {},
  };
  const res = responseCapture();
  await captureRoutes(client).get('PATCH /api/peakos/intake')({
    uid: actor.uid, headers: {}, body: { action: 'business', rows: [{
      id: current.id, expectedRowVersion: 1, changes: { memo: '서버 수정 메모' },
    }] },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.rows[0].rowVersion, 2);
  assert.ok(statements.some(sql => /row_version = row_version \+ 1/.test(sql)));
  assert.ok(statements.some(sql => sql.startsWith('INSERT INTO peakos_intake_audit_log')));
  assert.equal(statements.at(-1), 'COMMIT');
});

test('수동 입금이 확인된 행은 상품·금액·공급처 기준을 잠그고 memo 같은 비금액 메타만 허용한다', async () => {
  const current = {
    id: 'paid-intake-1', owner_uid: actor.uid, owner_name: actor.name, row_version: 4,
    date: '2026-08-09', client: '업체', expected_payer: '입금자',
    a: '대', b: '중', c: '소', unit: 10000, qty: 1, sell: 100000, cost: 3000,
    memo: '', kind: 'normal', ref_of: '', supplier: '공급처',
    expected_deposit_amount: 110000, paid: 'partial', paid_amount: 50000,
    bank_match_eligible: false, paid_auto: false, vendor_paid: false,
  };
  const blockedStatements = [];
  const blockedClient = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      blockedStatements.push(normalized);
      if (normalized.startsWith('SELECT * FROM peakos_intake WHERE id = ANY')) return { rows: [current] };
      if (normalized.startsWith('SELECT intake_id FROM peakos_bank_allocations')) return { rows: [] };
      if (normalized.startsWith('SELECT id FROM peakos_intake WHERE ref_of')) return { rows: [] };
      return { rows: [] };
    }, release() {},
  };
  let res = responseCapture();
  await captureRoutes(blockedClient).get('PATCH /api/peakos/intake')({
    uid: actor.uid, headers: {}, body: { action: 'business', rows: [{
      id: current.id, expectedRowVersion: 4, changes: { a: '다른 대분류', supplier: '다른 공급처' },
    }] },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'INTAKE_PAYMENT_BASIS_LOCKED');
  assert.equal(blockedStatements.some(sql => sql.startsWith('UPDATE peakos_intake')), false);
  assert.equal(blockedStatements.at(-1), 'ROLLBACK');

  const memoStatements = [];
  const memoClient = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      memoStatements.push(normalized);
      if (normalized.startsWith('SELECT * FROM peakos_intake WHERE id = ANY')) return { rows: [current] };
      if (normalized.startsWith('SELECT intake_id FROM peakos_bank_allocations')) return { rows: [] };
      if (normalized.startsWith('UPDATE peakos_intake')) {
        return { rows: [{ ...current, memo: '입금 후 일반 메모 수정', row_version: 5 }] };
      }
      return { rows: [] };
    }, release() {},
  };
  res = responseCapture();
  await captureRoutes(memoClient).get('PATCH /api/peakos/intake')({
    uid: actor.uid, headers: {}, body: { action: 'business', rows: [{
      id: current.id, expectedRowVersion: 4, changes: { memo: '입금 후 일반 메모 수정' },
    }] },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.rows[0].rowVersion, 5);
  assert.ok(memoStatements.some(sql => sql.startsWith('UPDATE peakos_intake')));
  assert.equal(memoStatements.at(-1), 'COMMIT');
});

test('intake DELETE는 버전을 확인해 tombstone과 감사기록을 먼저 남긴다', async () => {
  const statements = [];
  const current = {
    id: 'intake-delete-1', owner_uid: actor.uid, owner_name: actor.name,
    row_version: 3, bank_match_eligible: false, paid_auto: false,
  };
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push(normalized);
      if (normalized.startsWith('SELECT * FROM peakos_intake WHERE id = $1 AND')) return { rows: [current] };
      return { rows: [] };
    }, release() {},
  };
  const res = responseCapture();
  await captureRoutes(client).get('DELETE /api/peakos/intake/:id')({
    uid: actor.uid, headers: {}, params: { id: current.id }, body: { expectedRowVersion: 3 },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.rowVersion, 3);
  const tombstoneIndex = statements.findIndex(sql => sql.startsWith('INSERT INTO peakos_intake_tombstones'));
  const deleteIndex = statements.findIndex(sql => sql.startsWith('DELETE FROM peakos_intake'));
  assert.ok(tombstoneIndex > 0 && deleteIndex > tombstoneIndex);
  assert.ok(statements.some(sql => sql.startsWith('INSERT INTO peakos_intake_audit_log')));
  assert.equal(statements.at(-1), 'COMMIT');
});

test('monthly stale PATCH와 eligibility stale PUT은 UPDATE 없이 rollback한다', async () => {
  const monthlyStatements = [];
  const monthlyClient = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      monthlyStatements.push(normalized);
      if (normalized.startsWith('SELECT * FROM peakos_monthly WHERE id = ANY')) {
        return { rows: [{ id: 'monthly-1', view: 'monthly-guarantee', row_version: 2 }] };
      }
      return { rows: [] };
    }, release() {},
  };
  let res = responseCapture();
  await captureRoutes(monthlyClient).get('PATCH /api/peakos/monthly/:view')({
    uid: actor.uid, headers: {}, params: { view: 'monthly-guarantee' },
    body: { rows: [{ id: 'monthly-1', expectedRowVersion: 1, changes: { memo: '오래된 수정' } }] },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(monthlyStatements.some(sql => sql.startsWith('UPDATE peakos_monthly')), false);
  assert.equal(monthlyStatements.at(-1), 'ROLLBACK');

  const eligibilityStatements = [];
  const eligibilityClient = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      eligibilityStatements.push(normalized);
      if (normalized.startsWith('SELECT * FROM peakos_intake WHERE id = $1 AND')) {
        return { rows: [{ id: 'intake-1', row_version: 2 }] };
      }
      return { rows: [] };
    }, release() {},
  };
  res = responseCapture();
  await captureRoutes(eligibilityClient, {
    canManageBankEligibility: () => true, autoReconciliationEnabled: true,
  }).get('PUT /api/peakos/intake/:id/bank-match-eligibility')({
    uid: actor.uid, headers: {}, params: { id: 'intake-1' },
    body: { expectedRowVersion: 1, eligible: true, reason: '자동 입금 대상 확정' },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'INTAKE_VERSION_CONFLICT');
  assert.equal(eligibilityStatements.some(sql => sql.startsWith('UPDATE peakos_intake')), false);
  assert.equal(eligibilityStatements.at(-1), 'ROLLBACK');
});

test('owner 미리보기는 원장에 저장된 단일 immutable UID를 우선해 중복 빈 계정과 섞지 않는다', async () => {
  const statements = [];
  const client = {
    async query(sql, values) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ sql: normalized, values });
      if (normalized.startsWith('WITH ledger_owners AS')) return { rows: [{ uid: 'resolved-owner-uid' }] };
      if (normalized.startsWith('SELECT * FROM peakos_intake WHERE owner_uid')) return { rows: [] };
      throw new Error(`unexpected query: ${normalized}`);
    }, release() {},
  };
  const res = responseCapture();
  await captureRoutes(client, { canReadOwnerUid: (_req, uid) => uid === 'resolved-owner-uid' })
    .get('GET /api/peakos/intake')({
      uid: actor.uid, headers: {}, query: { owner: '표시이름' },
    }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, []);
  assert.deepEqual(statements[1].values, ['resolved-owner-uid', 'ws_peak']);
  assert.equal(statements.some(entry => /^SELECT \* FROM peakos_intake WHERE owner_name/.test(entry.sql)), false);
});

test('최종정산 전체 원장은 지정 capability가 없으면 DB 조회 전에 거부한다', async () => {
  let queries = 0;
  const blockedClient = {
    async query() { queries += 1; throw new Error('권한 거부 전에 DB를 조회하면 안 됩니다.'); },
    release() {},
  };
  let res = responseCapture();
  await captureRoutes(blockedClient)
    .get('GET /api/peakos/intake')({
      uid: actor.uid, headers: {}, query: { scope: 'all' },
    }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(queries, 0);

  const allowedClient = {
    async query(sql) {
      queries += 1;
      assert.match(String(sql), /SELECT \* FROM peakos_intake[\s\S]*workspace_id[\s\S]*ORDER BY/);
      return { rows: [] };
    },
    release() {},
  };
  res = responseCapture();
  await captureRoutes(allowedClient, { canSeeAll: () => true })
    .get('GET /api/peakos/intake')({
      uid: actor.uid, headers: {}, query: { scope: 'all' },
    }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, []);
});

test('월별 전용 정산서는 권한 있는 계정 미리보기에서 immutable owner UID로만 읽는다', async () => {
  const statements = [];
  const previewUid = 'kim-jihong-owner-uid';
  const client = {
    async query(sql, values) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ sql: normalized, values });
      if (normalized.startsWith('WITH ledger_owners AS')) return { rows: [{ uid: previewUid }] };
      if (normalized.startsWith('SELECT * FROM peakos_monthly WHERE view = $1 AND owner_uid = $2')) {
        return { rows: [{
          id: 'monthly-preview-1', view: 'monthly-guarantee', owner_uid: previewUid,
          owner_name: '김지홍', row_version: 1, kind: 'sale', date: '2026-08-01',
        }] };
      }
      throw new Error(`unexpected query: ${normalized}`);
    },
    release() {},
  };
  const res = responseCapture();
  await captureRoutes(client, { canReadOwnerUid: (_req, uid) => uid === previewUid })
    .get('GET /api/peakos/monthly/:view')({
      uid: actor.uid, headers: {}, params: { view: 'monthly-guarantee' },
      query: { owner: '김지홍' },
    }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.length, 1);
  assert.deepEqual(statements.at(-1).values, ['monthly-guarantee', previewUid, 'ws_peak']);
});

test('월별 전용 정산서 미리보기는 화면 소유자와 다른 owner 이름을 거부한다', async () => {
  const client = {
    async query() { throw new Error('소유자 불일치 요청은 DB를 조회하면 안 됩니다.'); },
    release() {},
  };
  const res = responseCapture();
  await captureRoutes(client, { canReadOwnerUid: () => true })
    .get('GET /api/peakos/monthly/:view')({
      uid: actor.uid, headers: {}, params: { view: 'monthly-guarantee' },
      query: { owner: '박우진' },
    }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error, '이 계정의 전용 정산서가 아닙니다.');
});

test('원장 UID가 없을 때만 active 표시이름 1개로 fallback하고 중복이면 차단한다', async () => {
  let activeRows = [{ uid: 'unique-owner-uid' }];
  const pool = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('WITH ledger_owners AS')) return { rows: [] };
      if (normalized.startsWith('SELECT uid FROM users')) return { rows: activeRows };
      throw new Error(`unexpected query: ${normalized}`);
    },
  };
  assert.equal(await resolvePreviewOwnerUid(pool, '표시이름'), 'unique-owner-uid');
  activeRows = [{ uid: 'duplicate-1' }, { uid: 'duplicate-2' }];
  await assert.rejects(
    resolvePreviewOwnerUid(pool, '표시이름'),
    error => error instanceof SettlementRouteError && error.code === 'INTAKE_PREVIEW_OWNER_AMBIGUOUS',
  );
});

test('지점 direct member 접수 생성은 row·catalog·audit를 모두 선택 workspace에 고정한다', async () => {
  const statements = [];
  const workspace = {
    id: 'ws_daegu', role: 'member', headquartersOversight: false,
    permissions: { settlements: 'write' },
  };
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ sql: normalized, values });
      if (normalized.startsWith('SELECT id FROM peakos_intake ')) {
        assert.equal(values[1], workspace.id);
        assert.match(normalized, /workspace_id = \$2/);
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT target_id FROM peakos_intake_tombstones')) {
        assert.deepEqual(values.slice(-1), [workspace.id]);
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT key, a, b, c, cost, unit')) {
        assert.equal(values[0], workspace.id);
        return { rows: [{ a: '대', b: '중', c: '소', cost: 7000, unit: 20000 }] };
      }
      if (normalized.startsWith('INSERT INTO peakos_intake (')) {
        assert.match(normalized, /workspace_id/);
        assert.equal(values.at(-1), workspace.id);
        return { rows: [{
          id: values[0], owner_uid: values[1], owner_name: values[2],
          row_version: 1, date: values[3], client: values[4], a: values[7],
          b: values[8], c: values[9], unit: values[10], qty: values[11],
          sell: values[12], cost: values[13], kind: values[15],
          paid: 'none', paid_amount: 0, vendor_paid: false,
          workspace_id: values.at(-1),
        }] };
      }
      if (normalized.startsWith('INSERT INTO peakos_intake_audit_log')) {
        assert.equal(values[0], workspace.id);
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const res = responseCapture();
  await captureRoutes(client).get('POST /api/peakos/intake')({
    uid: actor.uid, headers: {}, workspace, body: { rows: [{
      id: 'daegu-intake-1', date: '2026-08-09', client: '대구업체',
      expectedPayer: '대구업체', a: '대', b: '중', c: '소', unit: 99999,
      qty: 1, sell: 100000, expectedDepositAmount: 110000,
      memo: '', kind: 'normal', refOf: '', supplier: '',
    }] },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.rows[0].id, 'daegu-intake-1');
  assert.ok(statements.some(entry => entry.sql.startsWith('INSERT INTO peakos_intake_audit_log')));
});

test('지점 manager는 지점 전체 접수·최종실행만 보고 담당자 미지정 월별 원장은 열지 못한다', async () => {
  const workspace = {
    id: 'ws_daegu', role: 'manager', headquartersOversight: false,
    permissions: { settlements: 'write' },
  };
  const statements = [];
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ sql: normalized, values });
      if (normalized.startsWith('SELECT * FROM peakos_intake')) {
        assert.deepEqual(values, [workspace.id]);
        return { rows: [{ id: 'daegu-all', row_version: 1, kind: 'normal', cost: 7000 }] };
      }
      if (normalized.startsWith('SELECT * FROM peakos_monthly')) {
        assert.deepEqual(values, [['monthly-guarantee'], workspace.id]);
        return { rows: [{ id: 'daegu-final', view: 'monthly-guarantee', row_version: 1, kind: 'sale' }] };
      }
      throw new Error(`unexpected query: ${normalized}`);
    },
    release() {},
  };
  const routes = captureRoutes(client, {
    canSeeAll: () => true,
    canSeeFinalExecution: () => true,
  });

  let res = responseCapture();
  await routes.get('GET /api/peakos/intake')({
    uid: actor.uid, headers: {}, workspace, query: { scope: 'all' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload[0].cost, 7000);

  res = responseCapture();
  await routes.get('GET /api/peakos/final-execution')({
    uid: actor.uid, headers: {}, workspace, query: {},
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.rows.map(row => row.id), ['daegu-final']);

  const queriesBeforeMonthly = statements.length;
  res = responseCapture();
  await routes.get('GET /api/peakos/monthly/:view')({
    uid: actor.uid, headers: {}, workspace,
    params: { view: 'monthly-guarantee' }, query: { scope: 'all' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.code, 'PEAKOS_BRANCH_MONTHLY_OWNER_REQUIRED');

  res = responseCapture();
  await routes.get('POST /api/peakos/monthly/:view')({
    uid: actor.uid, headers: {}, workspace,
    params: { view: 'monthly-guarantee' }, body: { rows: [] },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.code, 'PEAKOS_BRANCH_MONTHLY_OWNER_REQUIRED');
  assert.equal(statements.length, queriesBeforeMonthly, '월별 원장 거부는 DB 접근 전이어야 한다');
});

test('HQ oversight는 지점 정산 GET만 실제 scoped 조회하고 mutation은 DB 전에 거부한다', async () => {
  const workspace = {
    id: 'ws_jeonju', role: 'oversight', headquartersOversight: true,
    permissions: { settlements: 'read' },
  };
  const statements = [];
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ sql: normalized, values });
      if (normalized.startsWith('SELECT * FROM peakos_intake')) {
        assert.deepEqual(values, [workspace.id]);
        assert.match(normalized, /workspace_id = \$1/);
        assert.match(normalized, /workspace_id IS NULL AND \$1 = 'ws_peak'/);
        return { rows: [{ id: 'jeonju-only', row_version: 1, kind: 'normal' }] };
      }
      if (normalized.startsWith('SELECT * FROM peakos_monthly')) {
        assert.equal(values.at(-1), workspace.id);
        assert.match(normalized, /workspace_id = \$2/);
        return { rows: [{ id: 'jeonju-final', view: 'monthly-guarantee', row_version: 1, kind: 'sale' }] };
      }
      throw new Error(`unexpected query: ${normalized}`);
    },
    release() {},
  };
  const routes = captureRoutes(client, { canSeeAll: () => false, canSeeFinalExecution: () => false });

  let res = responseCapture();
  await routes.get('GET /api/peakos/intake')({
    uid: 'hq-oversight', headers: {}, workspace, query: { scope: 'all' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.map(row => row.id), ['jeonju-only']);

  res = responseCapture();
  await routes.get('GET /api/peakos/final-execution')({
    uid: 'hq-oversight', headers: {}, workspace, query: {},
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.rows.map(row => row.id), ['jeonju-final']);

  const queriesBeforeMutation = statements.length;
  res = responseCapture();
  await routes.get('POST /api/peakos/intake')({
    uid: 'hq-oversight', headers: {}, workspace, body: { rows: [] },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.code, 'PEAKOS_WORKSPACE_READ_ONLY');
  assert.equal(statements.length, queriesBeforeMutation);
});

test('다른 workspace intake ID를 직접 수정해도 scoped lock에서 not-found로 끝난다', async () => {
  const workspace = {
    id: 'ws_build_solution', role: 'member', headquartersOversight: false,
    permissions: { settlements: 'write' },
  };
  const statements = [];
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ sql: normalized, values });
      if (normalized.startsWith('SELECT * FROM peakos_intake WHERE id = ANY')) {
        assert.deepEqual(values, [['known-peak-id'], workspace.id]);
        assert.match(normalized, /workspace_id = \$2/);
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const res = responseCapture();
  await captureRoutes(client).get('PATCH /api/peakos/intake')({
    uid: actor.uid, headers: {}, workspace, body: {
      action: 'business',
      rows: [{ id: 'known-peak-id', expectedRowVersion: 1, changes: { memo: '침범 시도' } }],
    },
  }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.code, 'INTAKE_NOT_FOUND');
  assert.equal(statements.some(entry => entry.sql.startsWith('UPDATE peakos_intake')), false);
});

test('intake parent/ref 검증은 선택 workspace 밖의 알려진 ID를 관계로 인정하지 않는다', async () => {
  const client = {
    async query(sql, values) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      assert.match(normalized, /workspace_id = \$2/);
      assert.deepEqual(values, ['peak-parent-id', 'ws_daegu']);
      return { rows: [] };
    },
  };
  await assert.rejects(
    validateRelationship(client, {
      id: 'daegu-use', owner_uid: actor.uid, final_only: false,
      kind: 'use', ref_of: 'peak-parent-id', qty: 1,
    }, { workspaceId: 'ws_daegu' }),
    error => error.code === 'INTAKE_RELATION_CONTEXT_INVALID',
  );
});
