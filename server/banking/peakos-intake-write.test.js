'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  IntakeWriteError,
  actionAllowed,
  databaseChanges,
  derivedStoredPaidState,
  normalizeCreateRows,
  normalizePatchRequest,
  vendorAmount,
} = require('./peakos-intake-write');

const actor = { uid: 'firebase-user-123', name: '테스트 직원' };

function validCreate(overrides = {}) {
  return {
    id: 'intake-test-1',
    date: '2026-08-09',
    client: '거래처',
    expectedPayer: '입금자',
    a: '블로그',
    b: '원고',
    c: '프리미엄',
    unit: 10000,
    qty: 1,
    sell: 100000,
    expectedDepositAmount: 110000,
    memo: '신규 접수',
    kind: 'normal',
    refOf: '',
    supplier: '공급처',
    ...overrides,
  };
}

test('신규 등록은 서버 소유권과 안전한 재무 기본값을 강제한다', () => {
  const [row] = normalizeCreateRows({ rows: [validCreate()] }, actor);
  assert.equal(row.owner_uid, actor.uid);
  assert.equal(row.owner_name, actor.name);
  assert.equal(row.expected_deposit_amount, 110000);
  assert.equal(row.paid, 'none');
  assert.equal(row.paid_amount, 0);
  assert.equal(row.paid_auto, false);
  assert.equal(row.vendor_paid, false);
  assert.equal(row.vendor_paid_amount, null);
  assert.equal(row.cost, null);
});

test('신규 등록 body의 재무·원본·버전 필드는 허용하지 않는다', () => {
  for (const forbidden of ['paid', 'paidAuto', 'vendorPaid', 'rowVersion', 'sourceDocumentId', 'owner']) {
    assert.throws(
      () => normalizeCreateRows({ rows: [validCreate({ [forbidden]: true })] }, actor),
      error => error instanceof IntakeWriteError && error.code === 'INTAKE_FIELDS_NOT_ALLOWED',
    );
  }
  assert.throws(
    () => normalizeCreateRows({ rows: [validCreate({ finalOnly: true })] }, actor),
    error => error.status === 403 && error.code === 'INTAKE_FINAL_ONLY_FORBIDDEN',
  );
  assert.throws(
    () => normalizeCreateRows({ rows: [validCreate({ cost: 5000 })] }, actor),
    error => error.status === 403 && error.code === 'INTAKE_COST_FORBIDDEN',
  );
});

test('PATCH는 action별 필드와 양의 rowVersion을 fail-closed로 검증한다', () => {
  const parsed = normalizePatchRequest({
    action: 'business',
    rows: [{ id: 'intake-test-1', expectedRowVersion: 3, changes: { memo: '수정 메모' } }],
  });
  assert.equal(parsed.action, 'business');
  assert.equal(parsed.rows[0].expectedRowVersion, 3);
  assert.deepEqual(parsed.rows[0].changes, { memo: '수정 메모' });
  assert.throws(() => normalizePatchRequest({
    action: 'business',
    rows: [{ id: 'intake-test-1', expectedRowVersion: 3, changes: { paidAmount: 1 } }],
  }), /허용되지 않은 필드/);
  assert.throws(() => normalizePatchRequest({
    action: 'business',
    rows: [{ id: 'intake-test-1', expectedRowVersion: 0, changes: { memo: 'x' } }],
  }), /최신 접수 버전/);
});

test('권한은 owner business와 지정 capability action을 분리한다', () => {
  assert.equal(actionAllowed('business', { sameOwner: true }), true);
  assert.equal(actionAllowed('business', { sameOwner: false, canFinance: true }), false);
  assert.equal(actionAllowed('payment', { sameOwner: true }), false);
  assert.equal(actionAllowed('payment', { canFinance: true }), true);
  assert.equal(actionAllowed('vendor', { canFinance: true }), true);
  assert.equal(actionAllowed('manager', { canManage: true }), true);
  assert.equal(actionAllowed('cost', { canCost: true }), true);
});

test('입금 상태는 서버가 VAT 포함 입금예정액과 입금액으로 계산한다', () => {
  const row = {
    expected_deposit_amount: 110000,
    sell: 100000,
    qty: 1,
    paid_amount: 0,
    paid: 'none',
  };
  assert.deepEqual(databaseChanges('payment', {
    paidAmount: 110000,
    payer: '입금자',
    paidDate: '2026-08-09',
    paidMemo: '매출통장 입금 확인',
  }, row), {
    paid_amount: 110000,
    payer: '입금자',
    paid_date: '2026-08-09',
    paid_memo: '매출통장 입금 확인',
    paid: 'paid',
    paid_auto: false,
  });
  assert.equal(derivedStoredPaidState(132000, 110000, 'paid'), 'partial');
  assert.equal(databaseChanges('business', { expectedDepositAmount: 132000 }, {
    ...row,
    paid_amount: 110000,
    paid: 'paid',
  }).paid, 'partial');
  assert.throws(() => normalizePatchRequest({
    action: 'payment',
    rows: [{
      id: 'intake-test-1', expectedRowVersion: 1,
      changes: { paidAmount: 110000, payer: '', paidDate: '2026-08-09', paidMemo: '매출통장 입금 확인' },
    }],
  }), /실제 입금자명/);
  assert.throws(() => normalizePatchRequest({
    action: 'payment',
    rows: [{
      id: 'intake-test-1', expectedRowVersion: 1,
      changes: { paidAmount: 1.5, payer: '입금자', paidDate: '2026-08-09', paidMemo: '매출통장 입금 확인' },
    }],
  }), /정수/);
});

test('공급처 정산액은 서버의 확정 원가와 수량에서만 계산한다', () => {
  assert.equal(vendorAmount({ kind: 'normal', cost: 3000, qty: 4 }), 12000);
  assert.throws(() => vendorAmount({ kind: 'refund', cost: 3000, qty: 4 }), /양수 실행 건/);
  assert.throws(() => vendorAmount({ kind: 'normal', cost: null, qty: 4 }), /확정 원가/);
});

test('공급처 지급자는 브라우저가 지정할 수 없다', () => {
  assert.throws(() => normalizePatchRequest({
    action: 'vendor',
    rows: [{
      id: 'intake-test-1', expectedRowVersion: 1,
      changes: {
        vendorPaid: true,
        vendorPaidDate: '2026-08-09',
        vendorBank: '공급처통장',
        vendorBy: '다른 직원',
        vendorMemo: '공급처 지급 확인 완료',
      },
    }],
  }), /허용되지 않은 필드/);
});
