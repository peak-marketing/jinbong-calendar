'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_SUPPLIER_BY_PRODUCT,
  VendorReconciliationPolicyError,
  canWriteVendorReconciliation,
  settlementMath,
  supplierForIntake,
} = require('./peakos-vendor-reconciliation-policy');

test('빈 공급처는 서버의 고정 상품 기준으로만 해석한다', () => {
  assert.equal(Object.keys(DEFAULT_SUPPLIER_BY_PRODUCT).length, 82);
  assert.equal(supplierForIntake({ supplier: '', b: '통합검색', c: '건바이' }), '키지애드 (50)');
  assert.equal(supplierForIntake({ supplier: '  직접 공급처  ', b: '통합검색', c: '건바이' }), '직접 공급처');
  assert.equal(supplierForIntake({ supplier: '', b: '없는 상품', c: '없음' }), '');
});

test('서버가 양수 실행 수량과 확정 원가로 지급액을 계산한다', () => {
  assert.deepEqual(settlementMath({ kind: 'normal', qty: '3', cost: '2500' }), {
    semanticQty: 3,
    cost: 2500,
    due: 7500,
  });
  assert.equal(settlementMath({ kind: 'use', qty: 2, cost: 1000 }).due, 2000);
});

test('누락·변동·0원 원가와 음수/환불 수량은 fail closed다', () => {
  for (const row of [
    { kind: 'normal', qty: 1, cost: null },
    { kind: 'normal', qty: 1, cost: 0 },
    { kind: 'normal', qty: -1, cost: 1000 },
    { kind: 'refund', qty: 1, cost: 1000 },
    { kind: 'reserve', qty: 1, cost: 1000 },
  ]) {
    assert.throws(() => settlementMath(row), VendorReconciliationPolicyError);
  }
});

test('쓰기 권한은 승인 활성 direct write + 재무 capability를 모두 요구한다', () => {
  const base = {
    userDoc: { approved: true, is_active: true },
    workspace: {
      id: 'ws_peak', role: 'manager', headquartersOversight: false,
      permissions: { settlements: 'write' },
    },
  };
  assert.equal(canWriteVendorReconciliation(base, { canReviewFinance: () => true }), true);
  assert.equal(canWriteVendorReconciliation({ ...base, workspace: { ...base.workspace, role: 'oversight' } }, { canReviewFinance: () => true }), false);
  assert.equal(canWriteVendorReconciliation({ ...base, workspace: { ...base.workspace, headquartersOversight: true } }, { canReviewFinance: () => true }), false);
  assert.equal(canWriteVendorReconciliation({ ...base, workspace: { ...base.workspace, permissions: { settlements: 'read' } } }, { canReviewFinance: () => true }), false);
  assert.equal(canWriteVendorReconciliation(base, { canReviewFinance: () => false }), false);
});
