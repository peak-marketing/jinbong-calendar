'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CommissionPolicyError,
  calculateCommission,
  calculationInputFingerprint,
  canManageRules,
  canReadCalculation,
  canReadRules,
  normalizeRuleDraft,
  ruleMatchesSource,
} = require('./peakos-commission-policy');

function source(overrides = {}) {
  return {
    id: 'intake_1', owner_uid: 'sales_a', owner_name: '영업자 A', date: '2026-08-17',
    row_version: 4, kind: 'normal', a: '매출', b: '플랫폼', c: '리뷰',
    qty: 2, sell: 100000, unit: 70000, vendor_paid: true,
    source_metadata: { provider: 'reviewspace' },
    ...overrides,
  };
}

function rule(overrides = {}) {
  return {
    id: '4bc3bc41-b2cc-43a1-9d0a-e2383799a1ce',
    rule_series_id: 'a3ab4027-2779-4cb7-a166-265b69152243',
    version: 2,
    status: 'APPROVED',
    scope_owner_uid: null,
    scope_platform: null,
    scope_product_a: null,
    scope_product_b: null,
    scope_product_c: null,
    rate_basis_points: 1250,
    effective_from: '2026-08-01',
    effective_to: null,
    ...overrides,
  };
}

function req({ uid = 'manager', role = 'manager', permission = 'write', oversight = false } = {}) {
  return {
    uid,
    userDoc: { approved: true, is_active: true },
    workspace: {
      id: 'ws_peak', role, headquartersOversight: oversight,
      permissions: { settlements: permission },
    },
  };
}

test('규칙 입력은 basis points를 명시하고 계층·기간을 엄격히 검증한다', () => {
  assert.deepEqual(normalizeRuleDraft({
    scopeOwnerUid: 'sales_a', scopePlatform: 'reviewspace', scopeProductA: '매출',
    scopeProductB: '플랫폼', scopeProductC: '리뷰', rateBasisPoints: 1250,
    effectiveFrom: '2026-08-01', effectiveTo: '2026-09-01', reason: '8월 계약 수당률 승인',
  }), {
    scopeOwnerUid: 'sales_a', scopePlatform: 'reviewspace', scopeProductA: '매출',
    scopeProductB: '플랫폼', scopeProductC: '리뷰', rateBasisPoints: 1250,
    effectiveFrom: '2026-08-01', effectiveTo: '2026-09-01', reason: '8월 계약 수당률 승인',
  });
  assert.throws(() => normalizeRuleDraft({
    scopeProductB: '플랫폼', rateBasisPoints: 1000,
    effectiveFrom: '2026-08-01', reason: '계층이 없는 잘못된 규칙',
  }), error => error instanceof CommissionPolicyError && error.code === 'COMMISSION_SCOPE_HIERARCHY_INVALID');
  assert.throws(() => normalizeRuleDraft({
    rateBasisPoints: 10001, effectiveFrom: '2026-08-01', reason: '범위를 넘긴 수당률 규칙',
  }), error => error.code === 'COMMISSION_RATE_INVALID');
});

test('관리자 write만 규칙을 변경하고 oversight는 읽기 전용이다', () => {
  assert.equal(canManageRules(req()), true);
  assert.equal(canReadRules(req()), true);
  assert.equal(canManageRules(req({ role: 'admin' })), true);
  assert.equal(canManageRules(req({ role: 'sales' })), false);
  assert.equal(canReadRules(req({ role: 'sales' })), false);
  assert.equal(canManageRules(req({ role: 'oversight', oversight: true, permission: 'read' })), false);
  assert.equal(canReadRules(req({ role: 'oversight', oversight: true, permission: 'read' })), true);
  assert.equal(canManageRules(req({ permission: 'read' })), false);
});

test('영업자는 자기 산출 결과만 읽고 관리자는 범위 내 결과를 읽는다', () => {
  assert.equal(canReadCalculation(req({ uid: 'sales_a', role: 'sales', permission: 'read' }), 'sales_a'), true);
  assert.equal(canReadCalculation(req({ uid: 'sales_a', role: 'sales', permission: 'read' }), 'sales_b'), false);
  assert.equal(canReadCalculation(req(), 'sales_b'), true);
  assert.equal(canReadCalculation(req({ role: 'oversight', oversight: true, permission: 'read' }), 'sales_b'), true);
});

test('규칙 scope는 영업자·플랫폼·상품·적용일을 모두 만족해야 한다', () => {
  const scoped = rule({
    scope_owner_uid: 'sales_a', scope_platform: 'reviewspace', scope_product_a: '매출',
    scope_product_b: '플랫폼', scope_product_c: '리뷰', effective_to: '2026-09-01',
  });
  const result = calculateCommission(source(), [scoped], null);
  assert.equal(result.status, 'CALCULATED');
  assert.equal(ruleMatchesSource(scoped, result.source), true);
  assert.equal(ruleMatchesSource({ ...scoped, scope_platform: 'rewardspace' }, result.source), false);
  assert.equal(ruleMatchesSource({ ...scoped, effective_to: '2026-08-17' }, result.source), false);
});

test('종료된 규칙도 종료일 전 판매에는 유지되고 종료일 이후에는 적용되지 않는다', () => {
  const ended = rule({ status: 'ENDED', version: 3, effective_to: '2026-09-01' });
  assert.equal(calculateCommission(source({ date: '2026-08-31' }), [ended], null).status, 'CALCULATED');
  assert.equal(calculateCommission(source({ date: '2026-09-01' }), [ended], null).status, 'UNCONFIGURED');
});

test('서버가 수당을 반올림하되 intake 완료 근거 연결 전에는 지급 확정하지 않는다', () => {
  const result = calculateCommission(source(), [rule()], {
    batch_id: '92df1f8e-6491-4e40-8d07-dc213c6d9bc8', source_settled_row_version: 4,
  });
  assert.equal(result.status, 'CALCULATED');
  assert.equal(result.salesAmount, 200000);
  assert.equal(result.salespersonSupplyAmount, 140000);
  assert.equal(result.commissionBaseAmount, 60000);
  assert.equal(result.rateBasisPoints, 1250);
  assert.equal(result.estimatedCommissionAmount, 7500);
  assert.equal(result.payoutEligible, false);
  assert.deepEqual(result.payoutBlockers, ['SETTLEMENT_COMPLETION_UNCONFIRMED']);
});

test('대사 미완료는 예상 수당만 만들고 지급 가능으로 표시하지 않는다', () => {
  const result = calculateCommission(source({ vendor_paid: false }), [rule()], null);
  assert.equal(result.status, 'CALCULATED');
  assert.equal(result.estimatedCommissionAmount, 7500);
  assert.equal(result.payoutEligible, false);
  assert.deepEqual(result.payoutBlockers, [
    'SETTLEMENT_COMPLETION_UNCONFIRMED', 'SUPPLIER_RECONCILIATION_INCOMPLETE',
  ]);
});

test('규칙 0개와 2개는 모두 금액 null로 fail-closed 한다', () => {
  const missing = calculateCommission(source(), [], null);
  assert.equal(missing.status, 'UNCONFIGURED');
  assert.equal(missing.estimatedCommissionAmount, null);
  const overlap = calculateCommission(source(), [rule(), rule({
    id: '1cc1f06d-06e6-41cd-83ae-0550b6fb4872',
    rule_series_id: '6f0516cd-3310-483f-b6a3-1836fe9931dc',
  })], null);
  assert.equal(overlap.status, 'RULE_OVERLAP');
  assert.equal(overlap.estimatedCommissionAmount, null);
});

test('환불·음수·마진 0은 지급액을 계산하지 않는다', () => {
  for (const row of [
    source({ kind: 'refund' }),
    source({ qty: -1 }),
    source({ sell: 70000, unit: 70000 }),
  ]) {
    const result = calculateCommission(row, [rule()], null);
    assert.equal(result.status, 'SOURCE_INELIGIBLE');
    assert.equal(result.estimatedCommissionAmount, null);
    assert.equal(result.payoutEligible, false);
  }
});

test('source/rule/vendor snapshot 변화는 입력 fingerprint를 바꾼다', () => {
  const evidence = { batch_id: '92df1f8e-6491-4e40-8d07-dc213c6d9bc8', source_settled_row_version: 4 };
  const first = calculateCommission(source(), [rule()], evidence);
  const second = calculateCommission(source({ row_version: 5 }), [rule()], evidence);
  assert.match(calculationInputFingerprint(first, evidence), /^[0-9a-f]{64}$/);
  assert.notEqual(calculationInputFingerprint(first, evidence), calculationInputFingerprint(second, evidence));
});
