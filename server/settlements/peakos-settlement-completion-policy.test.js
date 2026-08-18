'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SettlementCompletionPolicyError,
  canManageCompletion,
  canReadCompletion,
  canReopenCompletion,
  deriveRuleFromMonthlySource,
  evaluateEligibility,
  normalizeEvidence,
} = require('./peakos-settlement-completion-policy');

const AS_OF = new Date('2026-08-17T12:00:00.000Z');

function reasonCodes(result) {
  return result.reasons.map(item => item.code);
}

test('direct execution is fail-closed until both eight completed issues and the eighth completion timestamp exist', () => {
  const missing = evaluateEligibility('DIRECT_EXECUTION_8TH', {}, { asOf: AS_OF });
  assert.equal(missing.eligible, false);
  assert.deepEqual(reasonCodes(missing), [
    'MISSING_COMPLETED_ISSUE_COUNT',
    'MISSING_EIGHTH_ISSUANCE_COMPLETED_AT',
  ]);

  const countOnly = evaluateEligibility('DIRECT_EXECUTION_8TH', {
    completedIssueCount: 8,
  }, { asOf: AS_OF });
  assert.equal(countOnly.eligible, false);
  assert.deepEqual(reasonCodes(countOnly), ['MISSING_EIGHTH_ISSUANCE_COMPLETED_AT']);

  const eligible = evaluateEligibility('DIRECT_EXECUTION_8TH', {
    completedIssueCount: 8,
    eighthIssueCompletedAt: '2026-08-17T09:00:00+09:00',
  }, { asOf: AS_OF });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.eligibleAt, '2026-08-17T00:00:00.000Z');
  assert.match(eligible.eligibleAtKst, /^2026-08-17 09:00:00 KST$/);
  assert.equal(eligible.timeZone, 'Asia/Seoul');
});

test('direct execution rejects a future eighth completion and does not treat count as a timestamp', () => {
  const result = evaluateEligibility('DIRECT_EXECUTION_8TH', {
    completedIssueCount: 9,
    eighthIssueCompletedAt: '2026-08-18T09:00:00+09:00',
  }, { asOf: AS_OF });
  assert.equal(result.eligible, false);
  assert.deepEqual(reasonCodes(result), ['FUTURE_EIGHTH_ISSUANCE_COMPLETED_AT']);
});

test('monthly guarantee requires explicit completed 25 full days', () => {
  const short = evaluateEligibility('MONTHLY_GUARANTEE_25D', {
    exposureStartedAt: '2026-07-23T09:00:00+09:00',
    exposureCompletedAt: '2026-08-17T08:59:59+09:00',
  }, { asOf: AS_OF });
  assert.equal(short.eligible, false);
  assert.deepEqual(reasonCodes(short), ['REQUIRED_DURATION_NOT_MET']);
  assert.equal(short.requiredDurationHours, 600);

  const exact = evaluateEligibility('MONTHLY_GUARANTEE_25D', {
    exposureStartedAt: '2026-07-23T09:00:00+09:00',
    exposureCompletedAt: '2026-08-17T09:00:00+09:00',
  }, { asOf: AS_OF });
  assert.equal(exact.eligible, true);
  assert.equal(exact.observedDurationHours, 600);
});

test('per-item requires a full 24 hours and explicit completion evidence', () => {
  const missing = evaluateEligibility('PER_ITEM_24H', {
    exposureStartedAt: '2026-08-16T09:00:00+09:00',
  }, { asOf: AS_OF });
  assert.equal(missing.eligible, false);
  assert.deepEqual(reasonCodes(missing), ['MISSING_EXPOSURE_COMPLETED_AT']);

  const exact = evaluateEligibility('PER_ITEM_24H', {
    exposureStartedAt: '2026-08-16T09:00:00+09:00',
    exposureCompletedAt: '2026-08-17T09:00:00+09:00',
  }, { asOf: AS_OF });
  assert.equal(exact.eligible, true);
  assert.equal(exact.requiredDurationHours, 24);
});

test('monthly management requires explicit completed 30 full days', () => {
  const exact = evaluateEligibility('MONTHLY_MANAGEMENT_30D', {
    serviceStartedAt: '2026-07-18T09:00:00+09:00',
    serviceCompletedAt: '2026-08-17T09:00:00+09:00',
  }, { asOf: AS_OF });
  assert.equal(exact.eligible, true);
  assert.equal(exact.requiredDurationHours, 720);
});

test('duration evaluator reports reversed and future evidence explicitly', () => {
  const result = evaluateEligibility('PER_ITEM_24H', {
    exposureStartedAt: '2026-08-18T10:00:00+09:00',
    exposureCompletedAt: '2026-08-18T09:00:00+09:00',
  }, { asOf: AS_OF });
  assert.equal(result.eligible, false);
  assert.deepEqual(reasonCodes(result), [
    'FUTURE_EXPOSURE_STARTED_AT',
    'FUTURE_EXPOSURE_COMPLETED_AT',
    'COMPLETION_BEFORE_START',
  ]);
});

test('evidence timestamps must carry an explicit timezone and fields must match the rule', () => {
  assert.throws(
    () => normalizeEvidence({ exposureStartedAt: '2026-08-17T09:00:00' }, 'PER_ITEM_24H'),
    error => error instanceof SettlementCompletionPolicyError
      && error.code === 'SETTLEMENT_EVIDENCE_TIMESTAMP_INVALID',
  );
  assert.throws(
    () => normalizeEvidence({ serviceStartedAt: '2026-08-17T09:00:00+09:00' }, 'PER_ITEM_24H'),
    error => error.code === 'SETTLEMENT_EVIDENCE_RULE_MISMATCH',
  );
  assert.throws(
    () => normalizeEvidence({
      completedIssueCount: 7,
      eighthIssueCompletedAt: '2026-08-17T09:00:00+09:00',
    }, 'DIRECT_EXECUTION_8TH'),
    error => error.code === 'SETTLEMENT_EVIDENCE_DIRECT_INCONSISTENT',
  );
});

test('monthly source rows map to rules without guessing unsupported categories or run rows', () => {
  assert.equal(deriveRuleFromMonthlySource({ kind: 'sale', view: 'direct-execution' }), 'DIRECT_EXECUTION_8TH');
  assert.equal(deriveRuleFromMonthlySource({ kind: 'sale', view: 'monthly-guarantee', c: '월보장' }), 'MONTHLY_GUARANTEE_25D');
  assert.equal(deriveRuleFromMonthlySource({ kind: 'sale', view: 'monthly-guarantee', c: '건바이' }), 'PER_ITEM_24H');
  assert.equal(deriveRuleFromMonthlySource({ kind: 'sale', view: 'monthly-manage' }), 'MONTHLY_MANAGEMENT_30D');
  assert.throws(
    () => deriveRuleFromMonthlySource({ kind: 'run', view: 'monthly-manage' }),
    error => error.code === 'SETTLEMENT_SOURCE_NOT_SALE',
  );
  assert.throws(
    () => deriveRuleFromMonthlySource({ kind: 'sale', view: 'monthly-guarantee', c: '트래픽' }),
    error => error.code === 'SETTLEMENT_SOURCE_RULE_UNMAPPED',
  );
});

test('role policy is workspace-scoped: managers/admins mutate, only admins reopen, oversight stays read-only', () => {
  const req = (role, permission, uid = 'actor') => ({
    uid,
    workspace: {
      id: 'ws_peak', role, headquartersOversight: role === 'oversight',
      permissions: { settlements: permission },
    },
  });
  assert.equal(canManageCompletion(req('manager', 'write')), true);
  assert.equal(canManageCompletion(req('admin', 'write')), true);
  assert.equal(canManageCompletion(req('member', 'write')), false);
  assert.equal(canManageCompletion(req('oversight', 'read')), false);
  assert.equal(canReopenCompletion(req('manager', 'write')), false);
  assert.equal(canReopenCompletion(req('admin', 'write')), true);
  assert.equal(canReadCompletion(req('member', 'read', 'owner'), 'owner'), true);
  assert.equal(canReadCompletion(req('member', 'write', 'other'), 'owner'), false);
  assert.equal(canReadCompletion(req('manager', 'read'), 'owner'), true);
  assert.equal(canReadCompletion(req('oversight', 'read'), 'owner'), true);
  assert.equal(canReadCompletion(req('admin', 'none'), 'owner'), false);
});
