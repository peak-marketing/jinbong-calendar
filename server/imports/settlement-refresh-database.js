'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const { canonicalFingerprint } = require('./settlement-normalizer');
const { stableJson } = require('./settlement-plan');
const { SOURCE_DOCUMENTS } = require('./settlement-source-manifest');
const { verifyUidMap } = require('./settlement-uid-map');
const {
  INTAKE_INSERT_SQL,
  MONTHLY_INSERT_SQL,
  intakeState,
  lockRollbackMutationBoundary,
  monthlyState,
} = require('./settlement-database');

const PEAK_WORKSPACE_ID = 'ws_peak';
const REFRESH_MIGRATION_PATH = path.join(
  __dirname,
  '..',
  'migrations',
  '20260818_peakos_settlement_source_refresh.sql',
);

class SettlementRefreshError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SettlementRefreshError';
    this.code = code;
  }
}

function refreshFail(code, message) {
  throw new SettlementRefreshError(code, message);
}

function digest(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function sourceKey(value) {
  const source = value?.source || value || {};
  return [
    source.documentId ?? source.source_document_id,
    source.sheetName ?? source.source_sheet_name,
    source.rowNumber ?? source.source_row_number,
    source.recordType ?? source.source_record_type,
  ].join('\u0000');
}

function targetKey(table, id) {
  return `${table}\u0000${id}`;
}

function targetTable(record) {
  return record?.source?.recordType === 'individual' ? 'peakos_intake' : 'peakos_monthly';
}

function targetState(table, row) {
  return table === 'peakos_intake' ? intakeState(row) : monthlyState(row);
}

function sourceDocumentIdentity(snapshot, label = '정산 원본') {
  const documents = snapshot?.documents;
  const expectedKeys = SOURCE_DOCUMENTS.map(document => document.key).sort();
  if (!Array.isArray(documents) || documents.length !== expectedKeys.length) {
    refreshFail(
      'SETTLEMENT_REFRESH_SOURCE_IDENTITY_INVALID',
      `${label} 문서 식별자 스냅샷이 완전하지 않습니다.`,
    );
  }
  const identity = documents.map(document => ({
    key: String(document?.key || '').trim(),
    documentRefSha256: String(document?.documentRefSha256 || '').trim(),
  })).sort((left, right) => left.key.localeCompare(right.key));
  const actualKeys = identity.map(document => document.key);
  const actualReferences = identity.map(document => document.documentRefSha256);
  if (new Set(actualKeys).size !== actualKeys.length
      || new Set(actualReferences).size !== actualReferences.length
      || stableJson(actualKeys) !== stableJson(expectedKeys)
      || identity.some(document => !/^[0-9a-f]{64}$/.test(document.documentRefSha256))) {
    refreshFail(
      'SETTLEMENT_REFRESH_SOURCE_IDENTITY_INVALID',
      `${label} 문서 식별자 스냅샷이 올바르지 않습니다.`,
    );
  }
  return identity;
}

function assertSourceDocumentIdentity(planSnapshot, baselineSnapshot) {
  const current = sourceDocumentIdentity(planSnapshot, '현재');
  const baseline = sourceDocumentIdentity(baselineSnapshot, '최초 이관');
  if (stableJson(current) !== stableJson(baseline)) {
    refreshFail(
      'SETTLEMENT_REFRESH_SOURCE_IDENTITY_MISMATCH',
      '현재 source map의 문서가 최초 이관 원본과 달라 최신 정산 반영을 중단했습니다.',
    );
  }
  return digest(current);
}

function assertPlanRowsUsePinnedDocuments(plan, identity) {
  const allowed = new Set(identity.map(document => document.documentRefSha256));
  const rawDocumentIds = [
    ...plan.records.intake.map(record => record?.source?.documentId),
    ...plan.records.monthly.map(record => record?.source?.documentId),
    ...(plan.quarantine || []).map(record => record?.sourceDocumentId),
  ];
  if (rawDocumentIds.some(documentId => {
    const value = String(documentId || '').trim();
    if (!value) return true;
    return !allowed.has(crypto.createHash('sha256').update(value).digest('hex'));
  })) {
    refreshFail(
      'SETTLEMENT_REFRESH_SOURCE_IDENTITY_MISMATCH',
      '정규화 plan의 행이 pin된 7개 원본 문서 범위 밖에 있어 반영을 중단했습니다.',
    );
  }
}

function normalizeDatabaseState(state = {}) {
  return {
    completedImportRuns: Number(state.completedImportRuns || 0),
    baselineSourceSnapshot: state.baselineSourceSnapshot || null,
    intakeRows: Array.isArray(state.intakeRows) ? state.intakeRows : [],
    monthlyRows: Array.isArray(state.monthlyRows) ? state.monthlyRows : [],
    baselineRows: Array.isArray(state.baselineRows) ? state.baselineRows : [],
    quarantineRows: Array.isArray(state.quarantineRows) ? state.quarantineRows : [],
  };
}

function classifySettlementRefresh({ plan, databaseState }) {
  if (!plan?.records || !Array.isArray(plan.records.intake)
      || !Array.isArray(plan.records.monthly)) {
    refreshFail('SETTLEMENT_REFRESH_PLAN_INVALID', '검증된 정산 원본 계획이 필요합니다.');
  }
  const state = normalizeDatabaseState(databaseState);
  if (state.completedImportRuns < 1) {
    refreshFail('SETTLEMENT_REFRESH_BASELINE_REQUIRED', '최초 정산 이관이 완료된 원장에만 최신분을 반영할 수 있습니다.');
  }
  const currentSourceIdentity = sourceDocumentIdentity(plan.sourceSnapshot, '현재');
  const sourceIdentitySha256 = assertSourceDocumentIdentity(
    plan.sourceSnapshot, state.baselineSourceSnapshot,
  );
  assertPlanRowsUsePinnedDocuments(plan, currentSourceIdentity);

  const currentRows = [
    ...state.intakeRows.map(row => ({ table: 'peakos_intake', row })),
    ...state.monthlyRows.map(row => ({ table: 'peakos_monthly', row })),
  ];
  const currentBySource = new Map();
  for (const item of currentRows) {
    const key = sourceKey(item.row);
    if (!key || key.startsWith('\u0000') || currentBySource.has(key)) {
      refreshFail('SETTLEMENT_REFRESH_TARGET_LINEAGE_DUPLICATE', '기존 정산 원장의 원본 연결이 중복되어 반영을 중단했습니다.');
    }
    currentBySource.set(key, item);
  }
  const baselineByTarget = new Map(state.baselineRows.map(row => [
    targetKey(row.target_table, row.target_id), row,
  ]));
  const sourceRecords = [...plan.records.intake, ...plan.records.monthly];
  const sourceKeys = new Set();
  const inserts = [];
  const updates = [];
  const skipped = [];
  const conflicts = [];

  for (const record of sourceRecords) {
    const lineage = sourceKey(record);
    if (sourceKeys.has(lineage)) {
      refreshFail('SETTLEMENT_REFRESH_SOURCE_LINEAGE_DUPLICATE', '최신 원본 안에 중복된 정산 행이 있습니다.');
    }
    sourceKeys.add(lineage);
    const table = targetTable(record);
    const existing = currentBySource.get(lineage);
    if (!existing) {
      inserts.push({ table, record });
      continue;
    }
    if (existing.table !== table || String(existing.row.id) !== String(record.id)) {
      conflicts.push({ table, record, current: existing.row, reason: 'TARGET_ID_OR_TABLE_MISMATCH' });
      continue;
    }
    if (existing.row.source_record_fingerprint === record.source.fingerprint) {
      skipped.push({ table, record, current: existing.row });
      continue;
    }
    const beforeState = targetState(table, existing.row);
    const beforeFingerprint = canonicalFingerprint(beforeState);
    const baseline = baselineByTarget.get(targetKey(table, record.id));
    if (!baseline || baseline.after_fingerprint !== beforeFingerprint) {
      conflicts.push({
        table, record, current: existing.row, beforeState, beforeFingerprint,
        reason: baseline ? 'TARGET_CHANGED_AFTER_LAST_SNAPSHOT' : 'TARGET_BASELINE_SNAPSHOT_MISSING',
      });
      continue;
    }
    updates.push({ table, record, current: existing.row, beforeState, beforeFingerprint });
  }

  const missing = currentRows.filter(item => !sourceKeys.has(sourceKey(item.row)));
  const previousQuarantine = new Set(state.quarantineRows.map(sourceKey));
  const newQuarantine = (plan.quarantine || []).filter(item => !previousQuarantine.has(sourceKey({
    source_document_id: item.sourceDocumentId,
    source_sheet_name: item.sheetName,
    source_row_number: item.rowNumber,
    source_record_type: item.reasonCodes?.includes('NON_POSITIVE_QUANTITY') ? 'run' : 'individual',
  })));

  const databaseStateSha256 = digest({
    sourceIdentitySha256,
    rows: currentRows.map(item => ({
      table: item.table,
      id: item.row.id,
      sourceFingerprint: item.row.source_record_fingerprint,
      stateFingerprint: canonicalFingerprint(targetState(item.table, item.row)),
      baselineFingerprint: baselineByTarget.get(targetKey(item.table, item.row.id))?.after_fingerprint || null,
    }))
      .sort((left, right) => targetKey(left.table, left.id).localeCompare(targetKey(right.table, right.id))),
  });
  const operationSha256 = digest([
    ...inserts.map(item => ({
      operation: 'INSERT', table: item.table, id: item.record.id,
      before: null, after: item.record.source.fingerprint,
    })),
    ...updates.map(item => ({
      operation: 'UPDATE', table: item.table, id: item.record.id,
      before: item.beforeFingerprint, after: item.record.source.fingerprint,
    })),
  ].sort((left, right) => targetKey(left.table, left.id).localeCompare(targetKey(right.table, right.id))));

  const counts = {
    source: sourceRecords.length,
    current: currentRows.length,
    insert: inserts.length,
    update: updates.length,
    skip: skipped.length,
    conflict: conflicts.length,
    missing: missing.length,
    quarantine: (plan.quarantine || []).length,
    newQuarantine: newQuarantine.length,
    intakeInsert: inserts.filter(item => item.table === 'peakos_intake').length,
    intakeUpdate: updates.filter(item => item.table === 'peakos_intake').length,
    monthlyInsert: inserts.filter(item => item.table === 'peakos_monthly').length,
    monthlyUpdate: updates.filter(item => item.table === 'peakos_monthly').length,
  };
  return {
    counts,
    sourceIdentitySha256,
    databaseStateSha256,
    operationSha256,
    inserts,
    updates,
    skipped,
    conflicts,
    missing,
    newQuarantine,
    safe: counts.conflict === 0 && counts.missing === 0 && counts.newQuarantine === 0,
  };
}

function assertSafeRefresh(classification) {
  if (!classification?.safe) {
    refreshFail(
      'SETTLEMENT_REFRESH_CONFLICT',
      '원본 삭제·신규 격리 또는 OS에서 수정된 행이 있어 최신 정산 반영을 중단했습니다.',
    );
  }
}

async function refreshTablesExist(client) {
  const result = await client.query(
    "SELECT to_regclass('public.peakos_settlement_refresh_items') IS NOT NULL AS ready",
  );
  return result.rows[0]?.ready === true;
}

async function loadSettlementRefreshState(client, plan, { forUpdate = false } = {}) {
  const sourceRecords = [...plan.records.intake, ...plan.records.monthly];
  if (!sourceRecords.length) refreshFail('SETTLEMENT_REFRESH_SOURCE_EMPTY', '최신 정산 원본이 비어 있습니다.');
  const infrastructure = await client.query(
    `SELECT to_regclass('public.peakos_settlement_import_runs') IS NOT NULL AS runs,
            to_regclass('public.peakos_settlement_import_items') IS NOT NULL AS items,
            to_regclass('public.peakos_settlement_import_quarantine') IS NOT NULL AS quarantine`,
  );
  const ready = infrastructure.rows[0] || {};
  if (!ready.runs || !ready.items || !ready.quarantine) {
    refreshFail('SETTLEMENT_REFRESH_BASELINE_SCHEMA_REQUIRED', '최초 정산 이관 스키마가 없는 DB에는 최신분을 반영할 수 없습니다.');
  }
  // Pin the current private source map to the *first* successful import.  A
  // changed Google document id otherwise changes every deterministic target
  // id and can make a duplicate ledger look like a batch of new inserts.
  const runResult = await client.query(
    `SELECT COUNT(*) OVER ()::integer AS count, source_snapshot
       FROM peakos_settlement_import_runs
      WHERE workspace_id = $1 AND status = 'COMPLETED' AND rolled_back_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [PEAK_WORKSPACE_ID],
  );
  const baselineRun = runResult.rows[0];
  if (!baselineRun) {
    refreshFail('SETTLEMENT_REFRESH_BASELINE_REQUIRED', '최초 정산 이관이 완료된 원장에만 최신분을 반영할 수 있습니다.');
  }
  assertSourceDocumentIdentity(plan.sourceSnapshot, baselineRun.source_snapshot);

  const rowLock = forUpdate ? ' FOR UPDATE' : '';
  // A pg Client executes one statement at a time. Keep this explicitly
  // sequential (rather than Promise.all on one client) so pg@9 does not reject
  // the read-only preflight as an overlapping-query programming error.
  const intakeResult = await client.query(
      `SELECT * FROM peakos_intake
        WHERE source_import_run_id IS NOT NULL
          AND (workspace_id = $1 OR (workspace_id IS NULL AND $1 = 'ws_peak'))
        ORDER BY id${rowLock}`,
      [PEAK_WORKSPACE_ID],
    );
  const monthlyResult = await client.query(
      `SELECT * FROM peakos_monthly
        WHERE source_import_run_id IS NOT NULL
          AND (workspace_id = $1 OR (workspace_id IS NULL AND $1 = 'ws_peak'))
        ORDER BY id${rowLock}`,
      [PEAK_WORKSPACE_ID],
    );
  const quarantineResult = await client.query(
      `SELECT quarantine.source_document_id, quarantine.source_sheet_name,
              quarantine.source_row_number,
              CASE WHEN 'NON_POSITIVE_QUANTITY' = ANY(quarantine.reason_codes)
                   THEN 'run' ELSE 'individual' END AS source_record_type
         FROM peakos_settlement_import_quarantine quarantine
         JOIN peakos_settlement_import_runs run ON run.id = quarantine.run_id
        WHERE run.workspace_id = $1 AND run.status = 'COMPLETED'
          AND run.rolled_back_at IS NULL
        ORDER BY quarantine.id`,
      [PEAK_WORKSPACE_ID],
    );
  const targetIds = [
    ...intakeResult.rows.map(row => row.id),
    ...monthlyResult.rows.map(row => row.id),
  ];
  let baselineRows = [];
  if (targetIds.length) {
    const refreshReady = await refreshTablesExist(client);
    const refreshUnion = refreshReady ? `
      UNION ALL
      SELECT item.target_table, item.target_id, item.after_fingerprint, item.created_at, 1 AS priority
        FROM peakos_settlement_refresh_items item
        JOIN peakos_settlement_refresh_runs run ON run.id = item.run_id
       WHERE run.workspace_id = $1 AND run.status = 'COMPLETED'
         AND item.target_id = ANY($2::text[])` : '';
    const baselineResult = await client.query(
      `WITH snapshots AS (
        SELECT item.target_table, item.target_id, item.after_fingerprint, item.created_at, 0 AS priority
          FROM peakos_settlement_import_items item
          JOIN peakos_settlement_import_runs run ON run.id = item.run_id
         WHERE run.workspace_id = $1 AND run.status = 'COMPLETED'
           AND item.rolled_back_at IS NULL
           AND item.target_id = ANY($2::text[])
        ${refreshUnion}
      )
      SELECT DISTINCT ON (target_table, target_id)
             target_table, target_id, after_fingerprint
        FROM snapshots
       ORDER BY target_table, target_id, created_at DESC, priority DESC`,
      [PEAK_WORKSPACE_ID, targetIds],
    );
    baselineRows = baselineResult.rows;
  }
  return {
    completedImportRuns: Number(baselineRun.count || 0),
    baselineSourceSnapshot: baselineRun.source_snapshot,
    intakeRows: intakeResult.rows,
    monthlyRows: monthlyResult.rows,
    baselineRows,
    quarantineRows: quarantineResult.rows,
  };
}

function intakeInsertParams(record, runId) {
  return [
    record.id, record.ownerUid, record.ownerName, record.date, record.client,
    record.expectedPayer, record.expectedDepositAmount,
    record.a, record.b, record.c, record.unit, record.qty, record.sell, record.cost,
    record.memo, record.kind, record.refOf, record.supplier, record.manager,
    record.finalOnly, record.paid, record.paidAmount, record.payer, record.paidDate,
    record.paidMemo, false, false, record.vendorPaid, record.vendorPaidDate,
    record.vendorBank, record.vendorBy, record.vendorMemo,
    record.source.documentId, record.source.sheetName, record.source.rowNumber,
    record.source.recordType, record.source.fingerprint, runId,
    record.source.grossAmount, record.source.expectedDepositAmount,
    record.source.salesAmount, record.source.salespersonSupplyAmount,
    record.source.profitAmount, record.source.paymentStatus,
    JSON.stringify(record.source.metadata || {}), PEAK_WORKSPACE_ID,
  ];
}

function monthlyInsertParams(record, runId) {
  return [
    record.id, record.view, record.ownerUid, record.ownerName, record.kind,
    record.parentId, record.date, record.client, record.a, record.b, record.c,
    record.amount, record.qty, record.period, record.memo,
    record.source.documentId, record.source.sheetName, record.source.rowNumber,
    record.source.recordType, record.source.fingerprint, runId,
    record.source.grossAmount, record.source.expectedDepositAmount,
    record.source.salesAmount, record.source.salespersonSupplyAmount,
    record.source.profitAmount, JSON.stringify(record.source.metadata || {}),
    PEAK_WORKSPACE_ID,
  ];
}

function intakeRefreshValues(record) {
  return {
    owner_uid: record.ownerUid,
    owner_name: record.ownerName,
    date: record.date,
    client: record.client,
    expected_payer: record.expectedPayer,
    expected_deposit_amount: record.expectedDepositAmount,
    a: record.a, b: record.b, c: record.c,
    unit: record.unit, qty: record.qty, sell: record.sell, cost: record.cost,
    memo: record.memo, kind: record.kind, ref_of: record.refOf,
    supplier: record.supplier, manager: record.manager, final_only: record.finalOnly,
    paid: record.paid, paid_amount: record.paidAmount, payer: record.payer,
    paid_date: record.paidDate, paid_memo: record.paidMemo, paid_auto: false,
    bank_match_eligible: false, vendor_paid: record.vendorPaid,
    vendor_paid_amount: null, vendor_paid_date: record.vendorPaidDate,
    vendor_bank: record.vendorBank, vendor_by: record.vendorBy, vendor_memo: record.vendorMemo,
    source_record_fingerprint: record.source.fingerprint,
    source_gross_amount: record.source.grossAmount,
    source_expected_deposit_amount: record.source.expectedDepositAmount,
    source_sales_amount: record.source.salesAmount,
    source_salesperson_supply_amount: record.source.salespersonSupplyAmount,
    source_profit_amount: record.source.profitAmount,
    source_payment_status: record.source.paymentStatus,
    source_metadata: JSON.stringify(record.source.metadata || {}),
  };
}

function monthlyRefreshValues(record) {
  return {
    view: record.view, owner_uid: record.ownerUid, owner_name: record.ownerName,
    kind: record.kind, parent_id: record.parentId, date: record.date,
    client: record.client, a: record.a, b: record.b, c: record.c,
    amount: record.amount, qty: record.qty, period: record.period, memo: record.memo,
    source_record_fingerprint: record.source.fingerprint,
    source_gross_amount: record.source.grossAmount,
    source_expected_deposit_amount: record.source.expectedDepositAmount,
    source_sales_amount: record.source.salesAmount,
    source_salesperson_supply_amount: record.source.salespersonSupplyAmount,
    source_profit_amount: record.source.profitAmount,
    source_metadata: JSON.stringify(record.source.metadata || {}),
  };
}

async function insertAudit(client, table, row, action, actor, runId, before = null) {
  const auditTable = table === 'peakos_intake'
    ? 'peakos_intake_audit_log' : 'peakos_monthly_audit_log';
  await client.query(
    `INSERT INTO ${auditTable}
      (workspace_id,target_id,action,row_version,actor_uid,actor_name,request_id,
       before_state,after_state,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)`,
    [PEAK_WORKSPACE_ID, row.id, action, Number(row.row_version), actor.uid, actor.name,
      runId, before ? JSON.stringify(before) : null, JSON.stringify(row),
      JSON.stringify({ sourceRefresh: true, refreshRunId: runId })],
  );
}

async function recordRefreshItem(client, runId, table, operation, beforeState, afterRow) {
  const afterState = targetState(table, afterRow);
  const beforeFingerprint = beforeState ? canonicalFingerprint(beforeState) : null;
  const afterFingerprint = canonicalFingerprint(afterState);
  await client.query(
    `INSERT INTO peakos_settlement_refresh_items
      (run_id,target_table,target_id,operation,before_fingerprint,after_fingerprint,
       before_state,after_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
    [runId, table, afterRow.id, operation, beforeFingerprint, afterFingerprint,
      beforeState ? JSON.stringify(beforeState) : null, JSON.stringify(afterState)],
  );
  return { afterState, afterFingerprint };
}

async function insertRefreshRecord(client, runId, item, actor) {
  const result = item.table === 'peakos_intake'
    ? await client.query(INTAKE_INSERT_SQL, intakeInsertParams(item.record, runId))
    : await client.query(MONTHLY_INSERT_SQL, monthlyInsertParams(item.record, runId));
  const row = result.rows[0];
  if (!row) refreshFail('SETTLEMENT_REFRESH_INSERT_FAILED', '최신 정산 신규 행을 저장하지 못했습니다.');
  const snapshot = await recordRefreshItem(client, runId, item.table, 'INSERT', null, row);
  await client.query(
    `INSERT INTO peakos_settlement_import_items
      (run_id,target_table,target_id,operation,after_fingerprint,after_state)
     VALUES ($1,$2,$3,'INSERT',$4,$5::jsonb)`,
    [runId, item.table, row.id, snapshot.afterFingerprint, JSON.stringify(snapshot.afterState)],
  );
  await insertAudit(client, item.table, row, 'SOURCE_REFRESH_CREATE', actor, runId);
}

async function updateRefreshRecord(client, runId, item, actor) {
  const values = item.table === 'peakos_intake'
    ? intakeRefreshValues(item.record) : monthlyRefreshValues(item.record);
  const columns = Object.keys(values);
  const parameters = columns.map(column => values[column]);
  const assignments = columns.map((column, index) => (
    column === 'source_metadata'
      ? `${column} = $${index + 1}::jsonb`
      : `${column} = $${index + 1}`
  ));
  const idIndex = parameters.length + 1;
  const versionIndex = parameters.length + 2;
  const fingerprintIndex = parameters.length + 3;
  const workspaceIndex = parameters.length + 4;
  const result = await client.query(
    `UPDATE ${item.table}
        SET ${assignments.join(', ')}, row_version = row_version + 1,
            workspace_id = COALESCE(workspace_id, $${workspaceIndex}), updated_at = NOW()
      WHERE id = $${idIndex}
        AND row_version = $${versionIndex}
        AND source_record_fingerprint = $${fingerprintIndex}
        AND (workspace_id = $${workspaceIndex}
          OR (workspace_id IS NULL AND $${workspaceIndex} = 'ws_peak'))
      RETURNING *`,
    [...parameters, item.record.id, Number(item.current.row_version),
      item.current.source_record_fingerprint, PEAK_WORKSPACE_ID],
  );
  const row = result.rows[0];
  if (!row) refreshFail('SETTLEMENT_REFRESH_CONCURRENT_EDIT', '정산 반영 중 다른 수정이 감지되어 전체 작업을 취소했습니다.');
  await recordRefreshItem(client, runId, item.table, 'UPDATE', item.beforeState, row);
  await insertAudit(client, item.table, row, 'SOURCE_REFRESH_UPDATE', actor, runId, item.beforeState);
}

function assertPin(label, value, expected) {
  if (!/^[0-9a-f]{64}$/.test(String(expected || '')) || value !== expected) {
    refreshFail('SETTLEMENT_REFRESH_PIN_MISMATCH', `${label}이 dry-run 이후 변경되어 반영을 중단했습니다.`);
  }
}

async function assertRefreshBaselineInfrastructure(pool) {
  const result = await pool.query(
    `SELECT to_regclass('public.peakos_settlement_import_runs') IS NOT NULL AS runs,
            to_regclass('public.peakos_settlement_import_items') IS NOT NULL AS items`,
  );
  if (!result.rows[0]?.runs || !result.rows[0]?.items) {
    refreshFail('SETTLEMENT_REFRESH_BASELINE_SCHEMA_REQUIRED', '최초 정산 이관이 없는 DB에는 최신분을 반영할 수 없습니다.');
  }
}

async function assertSettlementRefreshInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  const result = await pool.query(
    `SELECT
       to_regclass('public.peakos_settlement_refresh_runs') IS NOT NULL AS runs,
       to_regclass('public.peakos_settlement_refresh_items') IS NOT NULL AS items,
       EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.peakos_settlement_refresh_runs')
            AND conname = 'peakos_settlement_refresh_runs_workspace_id_fkey'
            AND contype = 'f' AND convalidated
       ) AS workspace_fk,
       EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.peakos_settlement_refresh_items')
            AND confrelid = to_regclass('public.peakos_settlement_refresh_runs')
            AND conname = 'peakos_settlement_refresh_items_run_id_fkey'
            AND contype = 'f' AND convalidated
            AND confupdtype = 'r' AND confdeltype = 'r'
       ) AS item_run_fk,
       EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.peakos_settlement_refresh_runs')
            AND conname = 'peakos_settlement_refresh_runs_lifecycle_check'
            AND contype = 'c' AND convalidated
       ) AS lifecycle_check,
       EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass('public.peakos_settlement_refresh_runs')
            AND tgname = 'peakos_settlement_refresh_runs_guard'
            AND tgenabled <> 'D' AND NOT tgisinternal AND tgtype = 31
            AND tgfoid = to_regprocedure('public.peakos_settlement_refresh_run_guard()')
       ) AS run_guard,
       EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass('public.peakos_settlement_refresh_items')
            AND tgname = 'peakos_settlement_refresh_items_no_mutation'
            AND tgenabled <> 'D' AND NOT tgisinternal AND tgtype = 31
            AND tgfoid = to_regprocedure('public.peakos_settlement_refresh_item_guard()')
       ) AS item_guard,
       EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass('public.peakos_settlement_refresh_runs')
            AND tgname = 'peakos_settlement_refresh_runs_no_truncate'
            AND tgenabled <> 'D' AND NOT tgisinternal AND tgtype = 34
            AND tgfoid = to_regprocedure('public.peakos_settlement_refresh_reject_mutation()')
       ) AS run_truncate_guard,
       EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass('public.peakos_settlement_refresh_items')
            AND tgname = 'peakos_settlement_refresh_items_no_truncate'
            AND tgenabled <> 'D' AND NOT tgisinternal AND tgtype = 34
            AND tgfoid = to_regprocedure('public.peakos_settlement_refresh_reject_mutation()')
       ) AS item_truncate_guard,
       (
         SELECT COUNT(*) = 3 AND BOOL_AND(procedure.proowner = refresh_table.relowner)
           FROM pg_proc procedure
          WHERE procedure.oid IN (
            to_regprocedure('public.peakos_settlement_refresh_run_guard()'),
            to_regprocedure('public.peakos_settlement_refresh_item_guard()'),
            to_regprocedure('public.peakos_settlement_refresh_reject_mutation()')
          )
       ) AS function_owners,
       (
         SELECT COUNT(*) = 2 AND BOOL_AND(procedure.prosecdef)
           AND BOOL_AND('search_path=pg_catalog, public' = ANY(procedure.proconfig))
           FROM pg_proc procedure
          WHERE procedure.oid IN (
            to_regprocedure('public.peakos_settlement_refresh_run_guard()'),
            to_regprocedure('public.peakos_settlement_refresh_item_guard()')
          )
       ) AS guard_security,
       refresh_table.relowner = item_table.relowner AS operator_ownership,
       NOT pg_has_role(current_user, table_owner.oid, 'MEMBER')
         AND NOT pg_has_role(current_user, item_owner.oid, 'MEMBER') AS non_owner,
       has_table_privilege(current_user, 'public.peakos_settlement_refresh_runs', 'SELECT')
         AND has_table_privilege(current_user, 'public.peakos_settlement_refresh_runs', 'INSERT')
         AND has_table_privilege(current_user, 'public.peakos_settlement_refresh_items', 'SELECT')
         AND has_table_privilege(current_user, 'public.peakos_settlement_refresh_items', 'INSERT') AS base_grants,
       has_column_privilege(current_user, 'public.peakos_settlement_refresh_runs', 'status', 'UPDATE')
         AND has_column_privilege(current_user, 'public.peakos_settlement_refresh_runs', 'completed_at', 'UPDATE')
         AND has_column_privilege(current_user, 'public.peakos_settlement_refresh_runs', 'inserted_count', 'UPDATE')
         AND has_column_privilege(current_user, 'public.peakos_settlement_refresh_runs', 'updated_count', 'UPDATE')
         AND has_column_privilege(current_user, 'public.peakos_settlement_refresh_runs', 'skipped_count', 'UPDATE')
         AND has_column_privilege(current_user, 'public.peakos_settlement_refresh_runs', 'conflict_count', 'UPDATE')
         AND has_column_privilege(current_user, 'public.peakos_settlement_refresh_runs', 'quarantine_count', 'UPDATE')
         AND NOT EXISTS (
           SELECT 1
             FROM pg_attribute attribute
            WHERE attribute.attrelid = to_regclass('public.peakos_settlement_refresh_runs')
              AND attribute.attnum > 0 AND NOT attribute.attisdropped
              AND attribute.attname NOT IN (
                'status', 'inserted_count', 'updated_count', 'skipped_count',
                'conflict_count', 'quarantine_count', 'completed_at'
              )
              AND has_column_privilege(
                current_user, attribute.attrelid, attribute.attnum, 'UPDATE'
              )
         ) AS run_update_grants,
       NOT has_table_privilege(current_user, 'public.peakos_settlement_refresh_runs', 'DELETE')
         AND NOT has_table_privilege(current_user, 'public.peakos_settlement_refresh_runs', 'TRUNCATE')
         AND NOT has_table_privilege(current_user, 'public.peakos_settlement_refresh_runs', 'REFERENCES')
         AND NOT has_table_privilege(current_user, 'public.peakos_settlement_refresh_runs', 'TRIGGER')
         AND NOT has_table_privilege(current_user, 'public.peakos_settlement_refresh_items', 'UPDATE')
         AND NOT has_table_privilege(current_user, 'public.peakos_settlement_refresh_items', 'DELETE')
         AND NOT has_table_privilege(current_user, 'public.peakos_settlement_refresh_items', 'TRUNCATE')
         AND NOT has_table_privilege(current_user, 'public.peakos_settlement_refresh_items', 'REFERENCES')
         AND NOT has_table_privilege(current_user, 'public.peakos_settlement_refresh_items', 'TRIGGER')
         AND NOT EXISTS (
           SELECT 1
             FROM pg_attribute attribute
            WHERE attribute.attrelid = to_regclass('public.peakos_settlement_refresh_items')
              AND attribute.attnum > 0 AND NOT attribute.attisdropped
              AND has_column_privilege(
                current_user, attribute.attrelid, attribute.attnum, 'UPDATE'
              )
         ) AS no_unsafe_grants,
       NOT EXISTS (
         SELECT 1 FROM information_schema.table_privileges privilege
          WHERE privilege.table_schema = 'public'
            AND privilege.table_name IN (
              'peakos_settlement_refresh_runs', 'peakos_settlement_refresh_items'
            )
            AND privilege.grantee = 'PUBLIC'
            AND privilege.privilege_type IN (
              'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
            )
       ) AS public_revoked
       ,NOT EXISTS (
         SELECT 1 FROM information_schema.column_privileges privilege
          WHERE privilege.table_schema = 'public'
            AND privilege.table_name IN (
              'peakos_settlement_refresh_runs', 'peakos_settlement_refresh_items'
            )
            AND privilege.grantee = 'PUBLIC'
            AND privilege.privilege_type = 'UPDATE'
       ) AS public_columns_revoked
       ,NOT has_function_privilege(
           current_user, 'public.peakos_settlement_refresh_run_guard()', 'EXECUTE'
         )
         AND NOT has_function_privilege(
           current_user, 'public.peakos_settlement_refresh_item_guard()', 'EXECUTE'
         )
         AND NOT has_function_privilege(
           current_user, 'public.peakos_settlement_refresh_reject_mutation()', 'EXECUTE'
         ) AS functions_revoked
      FROM pg_class refresh_table
      JOIN pg_roles table_owner ON table_owner.oid = refresh_table.relowner
      JOIN pg_class item_table
        ON item_table.oid = to_regclass('public.peakos_settlement_refresh_items')
      JOIN pg_roles item_owner ON item_owner.oid = item_table.relowner
     WHERE refresh_table.oid = to_regclass('public.peakos_settlement_refresh_runs')`,
  );
  const readiness = result.rows[0] || {};
  if (!readiness.runs || !readiness.items || !readiness.workspace_fk || !readiness.item_run_fk
      || !readiness.lifecycle_check || !readiness.run_guard || !readiness.item_guard
      || !readiness.run_truncate_guard || !readiness.item_truncate_guard
      || !readiness.function_owners || !readiness.guard_security
      || !readiness.operator_ownership || !readiness.non_owner
      || !readiness.base_grants || !readiness.run_update_grants
      || !readiness.no_unsafe_grants || !readiness.public_revoked
      || !readiness.public_columns_revoked || !readiness.functions_revoked) {
    refreshFail(
      'SETTLEMENT_REFRESH_INFRASTRUCTURE_NOT_READY',
      '운영자 소유 정산 refresh 스키마·트리거·최소 권한이 준비되지 않았습니다.',
    );
  }
  return true;
}

async function applySettlementRefresh({
  pool, plan, uidMap, actor, backupPin, expectedPins,
}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect가 필요합니다.');
  const actorUid = String(actor?.uid || '').trim();
  const actorName = String(actor?.name || '').trim().slice(0, 120);
  if (!actorUid) refreshFail('SETTLEMENT_REFRESH_ACTOR_REQUIRED', '정산 반영 실행자 UID가 필요합니다.');
  if (!/^[0-9a-f]{64}$/.test(String(backupPin?.sha256 || ''))
      || !Number.isSafeInteger(backupPin?.byteLength) || backupPin.byteLength < 1024) {
    refreshFail('SETTLEMENT_REFRESH_BACKUP_REQUIRED', '검증된 운영 DB 백업 pin이 필요합니다.');
  }
  assertPin('원본 manifest', plan.manifestSha256, expectedPins?.manifestSha256);
  assertPin('원본 정규화 plan', plan.planSha256, expectedPins?.planSha256);
  assertPin('백업 파일', backupPin.sha256, expectedPins?.backupSha256);

  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('peakos-settlement-import-v1'))");
    await lockRollbackMutationBoundary(client);
    await verifyUidMap(client, uidMap);
    const databaseState = await loadSettlementRefreshState(client, plan, { forUpdate: true });
    const classification = classifySettlementRefresh({ plan, databaseState });
    assertPin('운영 원장 상태', classification.databaseStateSha256, expectedPins?.databaseStateSha256);
    assertPin('반영 작업 목록', classification.operationSha256, expectedPins?.operationSha256);
    assertSafeRefresh(classification);
    if (!classification.inserts.length && !classification.updates.length) {
      await client.query('ROLLBACK');
      return { noOp: true, inserted: 0, updated: 0, skipped: classification.counts.skip };
    }

    const runId = crypto.randomUUID();
    const totals = {
      ...classification.counts,
      sourceDateFrom: [...plan.records.intake, ...plan.records.monthly]
        .map(row => row.date).sort()[0] || null,
      sourceDateTo: [...plan.records.intake, ...plan.records.monthly]
        .map(row => row.date).sort().at(-1) || null,
    };
    await client.query(
      `INSERT INTO peakos_settlement_import_runs
        (id,workspace_id,status,source_manifest_sha256,plan_sha256,source_snapshot,totals,
         actor_uid,actor_name)
       VALUES ($1,$2,'RUNNING',$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [runId, PEAK_WORKSPACE_ID, plan.manifestSha256, plan.planSha256,
        JSON.stringify(plan.sourceSnapshot), JSON.stringify(totals), actorUid, actorName],
    );
    await client.query(
      `INSERT INTO peakos_settlement_refresh_runs
        (id,workspace_id,status,source_manifest_sha256,source_plan_sha256,
         database_state_sha256,operation_sha256,backup_sha256,backup_bytes,totals,
         actor_uid,actor_name)
       VALUES ($1,$2,'RUNNING',$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
      [runId, PEAK_WORKSPACE_ID, plan.manifestSha256, plan.planSha256,
        classification.databaseStateSha256, classification.operationSha256,
        backupPin.sha256, backupPin.byteLength, JSON.stringify(totals), actorUid, actorName],
    );

    const inserts = [...classification.inserts].sort((left, right) => (
      (left.table === right.table ? 0 : left.table === 'peakos_intake' ? -1 : 1)
      || (left.record.kind === right.record.kind ? 0 : left.record.kind === 'sale' ? -1 : 1)
      || left.record.id.localeCompare(right.record.id)
    ));
    for (const item of inserts) await insertRefreshRecord(client, runId, item, { uid: actorUid, name: actorName });
    for (const item of classification.updates) {
      await updateRefreshRecord(client, runId, item, { uid: actorUid, name: actorName });
    }
    for (const item of plan.quarantine || []) {
      await client.query(
        `INSERT INTO peakos_settlement_import_quarantine
          (run_id,source_document_id,source_sheet_name,source_row_number,reason_codes,source_payload)
         VALUES ($1,$2,$3,$4,$5::text[],$6::jsonb)`,
        [runId, item.sourceDocumentId, item.sheetName, item.rowNumber,
          item.reasonCodes, JSON.stringify(item.privateSourceRow || {})],
      );
    }

    const afterState = await loadSettlementRefreshState(client, plan, { forUpdate: true });
    const after = classifySettlementRefresh({ plan, databaseState: afterState });
    if (!after.safe || after.counts.insert !== 0 || after.counts.update !== 0
        || after.counts.skip !== after.counts.source) {
      refreshFail('SETTLEMENT_REFRESH_POSTCHECK_FAILED', '최신 정산 반영 후 전체 대조가 일치하지 않아 취소했습니다.');
    }
    await client.query(
      `UPDATE peakos_settlement_import_runs
          SET status='COMPLETED', imported_count=$2, skipped_count=$3,
              quarantine_count=$4, completed_at=NOW()
        WHERE id=$1 AND workspace_id=$5 AND status='RUNNING'`,
      [runId, classification.counts.insert,
        classification.counts.skip + classification.counts.update,
        classification.counts.quarantine, PEAK_WORKSPACE_ID],
    );
    await client.query(
      `UPDATE peakos_settlement_refresh_runs
          SET status='COMPLETED', inserted_count=$2, updated_count=$3,
              skipped_count=$4, conflict_count=0, quarantine_count=$5,
              completed_at=NOW()
        WHERE id=$1 AND workspace_id=$6 AND status='RUNNING'`,
      [runId, classification.counts.insert, classification.counts.update,
        classification.counts.skip, classification.counts.quarantine, PEAK_WORKSPACE_ID],
    );
    await client.query('COMMIT');
    committed = true;
    return {
      noOp: false,
      runId,
      inserted: classification.counts.insert,
      updated: classification.counts.update,
      skipped: classification.counts.skip,
      quarantined: classification.counts.quarantine,
    };
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  PEAK_WORKSPACE_ID,
  REFRESH_MIGRATION_PATH,
  SettlementRefreshError,
  applySettlementRefresh,
  assertPlanRowsUsePinnedDocuments,
  assertSourceDocumentIdentity,
  assertRefreshBaselineInfrastructure,
  assertSafeRefresh,
  assertSettlementRefreshInfrastructure,
  classifySettlementRefresh,
  digest,
  intakeRefreshValues,
  loadSettlementRefreshState,
  monthlyRefreshValues,
  sourceDocumentIdentity,
  sourceKey,
  targetKey,
  targetState,
};
