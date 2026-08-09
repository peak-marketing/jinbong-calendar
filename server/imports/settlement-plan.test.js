'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BASELINE_EXPECTATIONS, SOURCE_DOCUMENTS } = require('./settlement-source-manifest');
const {
  baselineCheck,
  paymentStateStats,
  planSha256,
} = require('./settlement-plan');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baselineInput() {
  return {
    individual: clone(BASELINE_EXPECTATIONS.individual),
    special: clone(BASELINE_EXPECTATIONS.special),
    reasonCounts: clone(BASELINE_EXPECTATIONS.reasonCounts),
    individualMoney: clone(BASELINE_EXPECTATIONS.individualMoney),
    monthlyMoney: clone(BASELINE_EXPECTATIONS.monthlyMoney),
    specialMoney: clone(BASELINE_EXPECTATIONS.specialMoney),
    approvedDateCorrections: clone(BASELINE_EXPECTATIONS.approvedDateCorrections),
    excludedChecks: {
      kimJuhyeonCheckOnlyObserved: true,
      kimJuhyeonAugustMainIsZero: true,
    },
    uiInvariantFailures: 0,
    sourceFiles: SOURCE_DOCUMENTS.map((document, index) => ({
      key: document.key,
      sha256: index.toString(16).padStart(64, '0'),
      byteLength: index + 1,
    })),
    paymentState: clone(BASELINE_EXPECTATIONS.paymentState),
  };
}

test('apply baseline은 건수뿐 아니라 owner×month K/L/N·입금상태·보정 4행을 모두 고정한다', () => {
  const valid = baselineCheck(baselineInput());
  assert.deepEqual(valid, { ok: true, mismatches: [] });

  const badMoney = baselineInput();
  badMoney.individualMoney['김대호']['2026-06'].n -= 1;
  assert.equal(baselineCheck(badMoney).ok, false);

  const badPayment = baselineInput();
  badPayment.paymentState.legacyUnpaidUse.count = 5;
  assert.equal(baselineCheck(badPayment).ok, false);

  const unexpectedCorrection = baselineInput();
  unexpectedCorrection.approvedDateCorrections['kim-daeho'] = 1;
  assert.equal(baselineCheck(unexpectedCorrection).ok, false);
});

test('payment 집계는 refund target magnitude에 semantic sign을 한 번만 적용한다', () => {
  const stats = paymentStateStats([
    { kind: 'normal', paid: 'none', expectedDepositAmount: 100, paidAmount: 0, refOf: '' },
    { kind: 'refund', paid: 'paid', expectedDepositAmount: 40, paidAmount: 40, refOf: '' },
    { kind: 'normal', paid: 'wrong', expectedDepositAmount: -10, paidAmount: 0, refOf: '' },
  ]);
  assert.equal(stats.expected, 50);
  assert.equal(stats.paid, -40);
  assert.deepEqual(stats.positiveDue, { rows: 1, amount: 100 });
  assert.deepEqual(stats.credit, { rows: 1, amount: -10 });
});

test('planSha는 property 순서에는 안정적이고 target 또는 quarantine lineage가 바뀌면 달라진다', () => {
  const base = {
    intakeRecords: [{ id: 'a', qty: 1, source: { rowNumber: 2, documentId: 'secret-doc' } }],
    monthlyRecords: [{ id: 'b', amount: 10 }],
    quarantine: [{
      sourceDocumentId: 'secret-doc', sheetName: '2026-06 정산', rowNumber: 3,
      reasonCodes: ['B', 'A'], privateSourceRow: { client: 'private' },
    }],
  };
  const reordered = {
    intakeRecords: [{ source: { documentId: 'secret-doc', rowNumber: 2 }, qty: 1, id: 'a' }],
    monthlyRecords: [{ amount: 10, id: 'b' }],
    quarantine: [{ ...base.quarantine[0], reasonCodes: ['A', 'B'] }],
  };
  assert.equal(planSha256(base), planSha256(reordered));
  assert.notEqual(planSha256(base), planSha256({
    ...base, intakeRecords: [{ ...base.intakeRecords[0], qty: 2 }],
  }));
  assert.notEqual(planSha256(base), planSha256({
    ...base, quarantine: [{ ...base.quarantine[0], rowNumber: 4 }],
  }));
});
