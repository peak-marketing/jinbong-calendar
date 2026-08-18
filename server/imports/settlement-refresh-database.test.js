'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { canonicalFingerprint } = require('./settlement-normalizer');
const { intakeState } = require('./settlement-database');
const { SOURCE_DOCUMENTS, sourceManifestSnapshot } = require('./settlement-source-manifest');
const {
  REFRESH_MIGRATION_PATH,
  SettlementRefreshError,
  assertSettlementRefreshInfrastructure,
  assertSafeRefresh,
  classifySettlementRefresh,
  digest,
  intakeRefreshValues,
  loadSettlementRefreshState,
} = require('./settlement-refresh-database');

const DOC = 'externaldocumentidentifier001';
const RUN = '00000000-0000-0000-0000-000000000001';
const SOURCE_IDS = SOURCE_DOCUMENTS.map((document, index) => (
  index === 0 ? DOC : `externaldocumentidentifier${String(index + 1).padStart(3, '0')}`
));
const SOURCE_SNAPSHOT = sourceManifestSnapshot(SOURCE_DOCUMENTS.map((document, index) => ({
  ...document,
  documentId: SOURCE_IDS[index],
})), []);

function refreshPlan({ intake = [], monthly = [], quarantine = [], sourceSnapshot = SOURCE_SNAPSHOT } = {}) {
  return { sourceSnapshot, records: { intake, monthly }, quarantine };
}

function record({ row = 2, fingerprint = 'a'.repeat(64), date = '2026-08-01' } = {}) {
  return {
    id: `gsi_${String(row).padStart(40, '0')}`,
    ownerUid: 'owner-uid', ownerName: 'owner', date, client: 'client',
    expectedPayer: 'payer', expectedDepositAmount: 110,
    a: 'a', b: 'b', c: 'c', unit: 70, qty: 1, sell: 100, cost: null,
    memo: '', kind: 'normal', refOf: '', supplier: '', manager: 'owner',
    finalOnly: false, paid: 'none', paidAmount: 0, payer: '', paidDate: '',
    paidMemo: '', paidAuto: false, bankMatchEligible: false, vendorPaid: false,
    vendorPaidDate: '', vendorBank: '', vendorBy: '', vendorMemo: '',
    source: {
      documentId: DOC, sheetName: '2026-08 정산', rowNumber: row,
      recordType: 'individual', fingerprint, grossAmount: 110,
      expectedDepositAmount: 110, salesAmount: 100,
      salespersonSupplyAmount: 70, profitAmount: 30, paymentStatus: '', metadata: {},
    },
  };
}

function databaseRow(sourceRecord, overrides = {}) {
  return {
    id: sourceRecord.id, row_version: 1, owner_uid: sourceRecord.ownerUid,
    owner_name: sourceRecord.ownerName, date: sourceRecord.date,
    client: sourceRecord.client, expected_payer: sourceRecord.expectedPayer,
    expected_deposit_amount: sourceRecord.expectedDepositAmount,
    a: sourceRecord.a, b: sourceRecord.b, c: sourceRecord.c,
    unit: sourceRecord.unit, qty: sourceRecord.qty, sell: sourceRecord.sell,
    cost: sourceRecord.cost, memo: sourceRecord.memo, kind: sourceRecord.kind,
    ref_of: sourceRecord.refOf, supplier: sourceRecord.supplier,
    manager: sourceRecord.manager, final_only: sourceRecord.finalOnly,
    paid: sourceRecord.paid, paid_amount: sourceRecord.paidAmount,
    payer: sourceRecord.payer, paid_date: sourceRecord.paidDate,
    paid_memo: sourceRecord.paidMemo, paid_auto: false, bank_match_eligible: false,
    vendor_paid: false, vendor_paid_amount: null, vendor_paid_date: '',
    vendor_bank: '', vendor_by: '', vendor_memo: '',
    source_document_id: sourceRecord.source.documentId,
    source_sheet_name: sourceRecord.source.sheetName,
    source_row_number: sourceRecord.source.rowNumber,
    source_record_type: sourceRecord.source.recordType,
    source_record_fingerprint: sourceRecord.source.fingerprint,
    source_import_run_id: RUN,
    source_gross_amount: sourceRecord.source.grossAmount,
    source_expected_deposit_amount: sourceRecord.source.expectedDepositAmount,
    source_sales_amount: sourceRecord.source.salesAmount,
    source_salesperson_supply_amount: sourceRecord.source.salespersonSupplyAmount,
    source_profit_amount: sourceRecord.source.profitAmount,
    source_payment_status: sourceRecord.source.paymentStatus,
    source_metadata: sourceRecord.source.metadata,
    ...overrides,
  };
}

function state({
  intakeRows = [], monthlyRows = [], baselineRows = [], quarantineRows = [],
  baselineSourceSnapshot = SOURCE_SNAPSHOT,
} = {}) {
  return {
    completedImportRuns: 1,
    baselineSourceSnapshot,
    intakeRows,
    monthlyRows,
    baselineRows,
    quarantineRows,
  };
}

function baseline(row) {
  return {
    target_table: 'peakos_intake', target_id: row.id,
    after_fingerprint: canonicalFingerprint(intakeState(row)),
  };
}

test('refresh migration은 append-only run/item audit만 만들고 원장 데이터는 건드리지 않는다', () => {
  const sql = fs.readFileSync(REFRESH_MIGRATION_PATH, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS peakos_settlement_refresh_runs/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS peakos_settlement_refresh_items/);
  assert.match(sql, /operation IN \('INSERT', 'UPDATE'\)/);
  assert.match(sql, /backup_sha256/);
  assert.match(sql, /workspace_id TEXT NOT NULL REFERENCES peakos_workspaces\(id\)/);
  assert.match(sql, /peakos_settlement_refresh_runs_lifecycle_check/);
  assert.match(sql, /peakos_settlement_refresh_runs_guard/);
  assert.match(sql, /peakos_settlement_refresh_items_no_mutation/);
  assert.match(sql, /items require a RUNNING parent run/);
  assert.match(sql, /WHERE id = NEW\.run_id AND status = 'RUNNING'\s+FOR UPDATE/);
  assert.doesNotMatch(sql, /WHERE id = NEW\.run_id AND status = 'RUNNING'\s+FOR KEY SHARE/);
  assert.match(sql, /completion counts do not match append-only items/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET search_path = pg_catalog, public/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE peakos_settlement_refresh_runs FROM PUBLIC/);
  assert.match(sql, /GRANT UPDATE \(status, inserted_count/);
  assert.match(sql, /migration must run as an operator role, not runtime role/);
  assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+peakos_(?:intake|monthly)\b/i);
});

test('runtime readiness는 operator ownership·FK·guards·exact ACL을 모두 요구한다', async () => {
  const ready = {
    runs: true, items: true, workspace_fk: true, item_run_fk: true,
    lifecycle_check: true,
    run_guard: true, item_guard: true, run_truncate_guard: true,
    item_truncate_guard: true, function_owners: true, guard_security: true,
    operator_ownership: true, non_owner: true, base_grants: true,
    run_update_grants: true, no_unsafe_grants: true, public_revoked: true,
    public_columns_revoked: true, functions_revoked: true,
  };
  const calls = [];
  assert.equal(await assertSettlementRefreshInfrastructure({
    async query(sql) { calls.push(String(sql)); return { rows: [ready] }; },
  }), true);
  assert.match(calls[0], /has_column_privilege/);
  assert.match(calls[0], /information_schema\.table_privileges/);
  await assert.rejects(
    assertSettlementRefreshInfrastructure({
      async query() { return { rows: [{ ...ready, item_guard: false }] }; },
    }),
    error => error instanceof SettlementRefreshError
      && error.code === 'SETTLEMENT_REFRESH_INFRASTRUCTURE_NOT_READY',
  );
});

test('동일 source는 skip, 신규 lineage는 insert, 안전한 source 수정은 update로 분류한다', () => {
  const exactSource = record({ row: 2, fingerprint: 'a'.repeat(64) });
  const changedOldSource = record({ row: 3, fingerprint: 'b'.repeat(64) });
  const changedCurrentSource = record({ row: 3, fingerprint: 'c'.repeat(64) });
  const newSource = record({ row: 4, fingerprint: 'd'.repeat(64) });
  const exactRow = databaseRow(exactSource);
  const changedRow = databaseRow(changedOldSource);
  const plan = refreshPlan({ intake: [exactSource, changedCurrentSource, newSource] });
  const result = classifySettlementRefresh({
    plan,
    databaseState: state({
      intakeRows: [exactRow, changedRow],
      baselineRows: [baseline(exactRow), baseline(changedRow)],
    }),
  });
  assert.deepEqual(result.counts, {
    source: 3, current: 2, insert: 1, update: 1, skip: 1,
    conflict: 0, missing: 0, quarantine: 0, newQuarantine: 0,
    intakeInsert: 1, intakeUpdate: 1, monthlyInsert: 0, monthlyUpdate: 0,
  });
  assert.equal(result.safe, true);
  assert.match(result.databaseStateSha256, /^[0-9a-f]{64}$/);
  assert.match(result.operationSha256, /^[0-9a-f]{64}$/);
});

test('OS에서 row_version이 바뀐 행과 source 수정이 겹치면 무조건 conflict로 중단한다', () => {
  const oldSource = record({ row: 2, fingerprint: 'a'.repeat(64) });
  const currentSource = record({ row: 2, fingerprint: 'b'.repeat(64) });
  const originalRow = databaseRow(oldSource);
  const editedRow = { ...originalRow, row_version: 2, memo: 'manual edit' };
  const result = classifySettlementRefresh({
    plan: refreshPlan({ intake: [currentSource] }),
    databaseState: state({ intakeRows: [editedRow], baselineRows: [baseline(originalRow)] }),
  });
  assert.equal(result.safe, false);
  assert.equal(result.counts.conflict, 1);
  assert.equal(result.conflicts[0].reason, 'TARGET_CHANGED_AFTER_LAST_SNAPSHOT');
  assert.throws(() => assertSafeRefresh(result), error => (
    error instanceof SettlementRefreshError && error.code === 'SETTLEMENT_REFRESH_CONFLICT'
  ));
});

test('원본에서 사라진 기존 lineage와 새 격리 행은 delete/skip하지 않고 fail-closed한다', () => {
  const existingSource = record({ row: 2 });
  const existingRow = databaseRow(existingSource);
  const result = classifySettlementRefresh({
    plan: refreshPlan({
      quarantine: [{
        sourceDocumentId: DOC, sheetName: '2026-08 정산', rowNumber: 9,
        reasonCodes: ['AMOUNT_MISSING_OR_INVALID'],
      }],
    }),
    databaseState: state({ intakeRows: [existingRow], baselineRows: [baseline(existingRow)] }),
  });
  assert.equal(result.counts.missing, 1);
  assert.equal(result.counts.newQuarantine, 1);
  assert.equal(result.safe, false);
});

test('최초 완료 이관 run이 없는 DB는 빈 DB여도 refresh 대상으로 인정하지 않는다', () => {
  assert.throws(
    () => classifySettlementRefresh({
      plan: { records: { intake: [], monthly: [] }, quarantine: [] },
      databaseState: { completedImportRuns: 0 },
    }),
    error => error instanceof SettlementRefreshError
      && error.code === 'SETTLEMENT_REFRESH_BASELINE_REQUIRED',
  );
});

test('현재 source map의 문서 ID가 최초 이관 스냅샷과 다르면 insert 분류 전 fail-closed한다', () => {
  const changedSnapshot = structuredClone(SOURCE_SNAPSHOT);
  changedSnapshot.documents[0].documentRefSha256 = 'f'.repeat(64);
  assert.throws(
    () => classifySettlementRefresh({
      plan: refreshPlan({ intake: [record()] , sourceSnapshot: changedSnapshot }),
      databaseState: state(),
    }),
    error => error instanceof SettlementRefreshError
      && error.code === 'SETTLEMENT_REFRESH_SOURCE_IDENTITY_MISMATCH',
  );
});

test('최신 plan 행의 문서 ID가 snapshot의 pin 범위 밖이면 fail-closed한다', () => {
  const outside = record();
  outside.source.documentId = 'differentexternaldocumentidentifier999';
  assert.throws(
    () => classifySettlementRefresh({
      plan: refreshPlan({ intake: [outside] }),
      databaseState: state(),
    }),
    error => error instanceof SettlementRefreshError
      && error.code === 'SETTLEMENT_REFRESH_SOURCE_IDENTITY_MISMATCH',
  );
});

test('원장 조회는 current source-map ID 필터 없이 이관 lineage 전체를 읽는다', async () => {
  const sql = [];
  const client = {
    async query(statement) {
      const text = String(statement);
      sql.push(text);
      if (text.includes("to_regclass('public.peakos_settlement_import_runs')")) {
        return { rows: [{ runs: true, items: true, quarantine: true }] };
      }
      if (text.includes('COUNT(*) OVER')) {
        return { rows: [{ count: 1, source_snapshot: SOURCE_SNAPSHOT }] };
      }
      if (text.includes('FROM peakos_intake')) return { rows: [] };
      if (text.includes('FROM peakos_monthly')) return { rows: [] };
      if (text.includes('FROM peakos_settlement_import_quarantine')) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const loaded = await loadSettlementRefreshState(client, refreshPlan({ intake: [record()] }));
  assert.equal(loaded.completedImportRuns, 1);
  const targetQueries = sql.filter(text => /FROM peakos_(?:intake|monthly)\b/.test(text));
  assert.equal(targetQueries.length, 2);
  assert.ok(targetQueries.every(text => text.includes('source_import_run_id IS NOT NULL')));
  assert.ok(targetQueries.every(text => !text.includes('source_document_id = ANY')));
});

test('source update whitelist는 lineage/import run과 created timestamp를 덮어쓰지 않는다', () => {
  const values = intakeRefreshValues(record());
  assert.equal(values.source_record_fingerprint, 'a'.repeat(64));
  assert.equal(values.bank_match_eligible, false);
  assert.equal(values.paid_auto, false);
  assert.equal(Object.hasOwn(values, 'source_import_run_id'), false);
  assert.equal(Object.hasOwn(values, 'source_imported_at'), false);
  assert.equal(Object.hasOwn(values, 'created_at'), false);
});

test('digest는 key 순서와 무관하고 값 변경은 감지한다', () => {
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
});
