'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalFingerprint } = require('./settlement-normalizer');
const { verifyUidMap } = require('./settlement-uid-map');

const PEAK_WORKSPACE_ID = 'ws_peak';

const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  'migrations',
  '20260809_peakos_settlement_import.sql',
);

function intakeState(row) {
  return {
    id: row.id,
    row_version: Number(row.row_version),
    owner_uid: row.owner_uid,
    owner_name: row.owner_name,
    date: String(row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date).slice(0, 10),
    client: row.client,
    expected_payer: row.expected_payer,
    expected_deposit_amount: row.expected_deposit_amount === null ? null : Number(row.expected_deposit_amount),
    a: row.a,
    b: row.b,
    c: row.c,
    unit: Number(row.unit),
    qty: Number(row.qty),
    sell: Number(row.sell),
    cost: row.cost === null ? null : Number(row.cost),
    memo: row.memo,
    kind: row.kind,
    ref_of: row.ref_of,
    supplier: row.supplier,
    manager: row.manager,
    final_only: row.final_only,
    paid: row.paid,
    paid_amount: Number(row.paid_amount),
    payer: row.payer,
    paid_date: row.paid_date,
    paid_memo: row.paid_memo,
    paid_auto: row.paid_auto,
    bank_match_eligible: row.bank_match_eligible,
    vendor_paid: row.vendor_paid,
    vendor_paid_amount: row.vendor_paid_amount === null || row.vendor_paid_amount === undefined
      ? null : Number(row.vendor_paid_amount),
    vendor_paid_date: row.vendor_paid_date,
    vendor_bank: row.vendor_bank,
    vendor_by: row.vendor_by,
    vendor_memo: row.vendor_memo,
    source_document_id: row.source_document_id,
    source_sheet_name: row.source_sheet_name,
    source_row_number: Number(row.source_row_number),
    source_record_type: row.source_record_type,
    source_record_fingerprint: row.source_record_fingerprint,
    source_import_run_id: String(row.source_import_run_id),
    source_gross_amount: row.source_gross_amount === null ? null : Number(row.source_gross_amount),
    source_expected_deposit_amount: row.source_expected_deposit_amount === null
      ? null : Number(row.source_expected_deposit_amount),
    source_sales_amount: row.source_sales_amount === null ? null : Number(row.source_sales_amount),
    source_salesperson_supply_amount: row.source_salesperson_supply_amount === null
      ? null : Number(row.source_salesperson_supply_amount),
    source_profit_amount: row.source_profit_amount === null ? null : Number(row.source_profit_amount),
    source_payment_status: row.source_payment_status,
    source_metadata: row.source_metadata || {},
  };
}

function monthlyState(row) {
  return {
    id: row.id,
    row_version: Number(row.row_version),
    view: row.view,
    owner_uid: row.owner_uid,
    owner_name: row.owner_name,
    kind: row.kind,
    parent_id: row.parent_id,
    date: String(row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date).slice(0, 10),
    client: row.client,
    a: row.a,
    b: row.b,
    c: row.c,
    amount: Number(row.amount),
    qty: Number(row.qty),
    period: row.period,
    memo: row.memo,
    source_document_id: row.source_document_id,
    source_sheet_name: row.source_sheet_name,
    source_row_number: Number(row.source_row_number),
    source_record_type: row.source_record_type,
    source_record_fingerprint: row.source_record_fingerprint,
    source_import_run_id: String(row.source_import_run_id),
    source_gross_amount: row.source_gross_amount === null ? null : Number(row.source_gross_amount),
    source_expected_deposit_amount: row.source_expected_deposit_amount === null
      ? null : Number(row.source_expected_deposit_amount),
    source_sales_amount: row.source_sales_amount === null ? null : Number(row.source_sales_amount),
    source_salesperson_supply_amount: row.source_salesperson_supply_amount === null
      ? null : Number(row.source_salesperson_supply_amount),
    source_profit_amount: row.source_profit_amount === null ? null : Number(row.source_profit_amount),
    source_metadata: row.source_metadata || {},
  };
}

function intakeParams(record, runId) {
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

const INTAKE_INSERT_SQL = `INSERT INTO peakos_intake (
  id, owner_uid, owner_name, date, client, expected_payer, expected_deposit_amount,
  a, b, c, unit, qty, sell, cost, memo, kind, ref_of, supplier, manager,
  final_only, paid, paid_amount, payer, paid_date, paid_memo, paid_auto,
  bank_match_eligible, vendor_paid, vendor_paid_date, vendor_bank, vendor_by,
  vendor_memo, source_document_id, source_sheet_name, source_row_number,
  source_record_type, source_record_fingerprint, source_import_run_id,
  source_gross_amount, source_expected_deposit_amount, source_sales_amount,
  source_salesperson_supply_amount, source_profit_amount, source_payment_status,
  source_metadata, workspace_id, source_imported_at
) VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
  $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,
  $37,$38,$39,$40,$41,$42,$43,$44,$45::jsonb,$46,NOW()
) RETURNING *`;

function monthlyParams(record, runId) {
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

const MONTHLY_INSERT_SQL = `INSERT INTO peakos_monthly (
  id, view, owner_uid, owner_name, kind, parent_id, date, client, a, b, c,
  amount, qty, period, memo, source_document_id, source_sheet_name,
  source_row_number, source_record_type, source_record_fingerprint,
  source_import_run_id, source_gross_amount, source_expected_deposit_amount,
  source_sales_amount, source_salesperson_supply_amount, source_profit_amount,
  source_metadata, workspace_id, source_imported_at
) VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
  $20,$21,$22,$23,$24,$25,$26,$27::jsonb,$28,NOW()
) RETURNING *`;

async function ensureSettlementImportInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  await pool.query(fs.readFileSync(MIGRATION_PATH, 'utf8'));
}

async function existingSource(client, table, record) {
  const result = await client.query(
    `SELECT id, source_record_fingerprint
       FROM ${table}
      WHERE (id = $1
         OR (source_document_id = $2 AND source_sheet_name = $3
             AND source_row_number = $4 AND source_record_type = $5))
        AND (workspace_id = $6 OR (workspace_id IS NULL AND $6 = 'ws_peak'))
      FOR UPDATE`,
    [record.id, record.source.documentId, record.source.sheetName,
      record.source.rowNumber, record.source.recordType, PEAK_WORKSPACE_ID],
  );
  if (result.rows.length > 1) throw new Error('이관 대상 ID/lineage가 서로 다른 행과 충돌합니다.');
  return result.rows[0] || null;
}

async function recordImportedItem(client, runId, table, row, state) {
  const afterFingerprint = canonicalFingerprint(state);
  await client.query(
    `INSERT INTO peakos_settlement_import_items
      (run_id, target_table, target_id, operation, after_fingerprint, after_state)
     VALUES ($1,$2,$3,'INSERT',$4,$5::jsonb)`,
    [runId, table, row.id, afterFingerprint, JSON.stringify(state)],
  );
  return { table, id: row.id, afterFingerprint };
}

async function insertIntake(client, runId, record) {
  const existing = await existingSource(client, 'peakos_intake', record);
  if (existing) {
    if (existing.id === record.id && existing.source_record_fingerprint === record.source.fingerprint) {
      return { skipped: true };
    }
    throw new Error('기존 개인정산 행이 원본 ID/lineage와 충돌합니다.');
  }
  const inserted = await client.query(INTAKE_INSERT_SQL, intakeParams(record, runId));
  const row = inserted.rows[0];
  if (!row || row.bank_match_eligible !== false || row.paid_auto !== false) {
    throw new Error('과거 정산 행의 자동 입금매칭 차단을 확인하지 못했습니다.');
  }
  return { skipped: false, item: await recordImportedItem(client, runId, 'peakos_intake', row, intakeState(row)) };
}

async function insertMonthly(client, runId, record) {
  const existing = await existingSource(client, 'peakos_monthly', record);
  if (existing) {
    if (existing.id === record.id && existing.source_record_fingerprint === record.source.fingerprint) {
      return { skipped: true };
    }
    throw new Error('기존 특수정산 행이 원본 ID/lineage와 충돌합니다.');
  }
  const inserted = await client.query(MONTHLY_INSERT_SQL, monthlyParams(record, runId));
  const row = inserted.rows[0];
  return { skipped: false, item: await recordImportedItem(client, runId, 'peakos_monthly', row, monthlyState(row)) };
}

function numeric(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) throw new Error('이관 후 DB 집계값이 숫자가 아닙니다.');
  return parsed;
}

function expectedPostInsert(intakeRecords, monthlyRecords, quarantineCount) {
  const intake = {
    rows: intakeRecords.length,
    k: intakeRecords.reduce((sum, row) => sum + numeric(row.source.salesAmount), 0),
    l: intakeRecords.reduce((sum, row) => sum + numeric(row.source.profitAmount), 0),
    n: intakeRecords.reduce((sum, row) => sum + numeric(row.source.grossAmount), 0),
    unsafeBankRows: 0,
  };
  const sales = monthlyRecords.filter(row => row.kind === 'sale');
  const runs = monthlyRecords.filter(row => row.kind === 'run');
  const monthly = {
    rows: monthlyRecords.length,
    saleRows: sales.length,
    runRows: runs.length,
    saleK: sales.reduce((sum, row) => sum + numeric(row.source.salesAmount), 0),
    saleN: sales.reduce((sum, row) => sum + numeric(row.source.grossAmount), 0),
    runCost: runs.reduce((sum, row) => sum + numeric(row.source.salespersonSupplyAmount), 0),
    parentResolved: runs.filter(row => row.parentResolvedInImport).length,
    parentOrphan: runs.filter(row => !row.parentResolvedInImport).length,
  };
  return { intake, monthly, quarantine: quarantineCount };
}

function comparePostInsert(actual, expected, prefix = 'postInsert') {
  const mismatches = [];
  const visit = (left, right, path) => {
    Object.entries(right).forEach(([key, expectedValue]) => {
      const actualValue = left?.[key];
      if (expectedValue && typeof expectedValue === 'object') {
        visit(actualValue || {}, expectedValue, `${path}.${key}`);
      } else if (numeric(actualValue) !== numeric(expectedValue)) {
        mismatches.push(`${path}.${key}`);
      }
    });
  };
  visit(actual, expected, prefix);
  if (mismatches.length) throw new Error(`이관 후 DB 집계 검증이 실패했습니다(${mismatches.join(',')}).`);
}

async function assertPostInsertAggregates(client, runId, expected) {
  const [intakeResult, monthlyResult, quarantineResult] = await Promise.all([
    client.query(
      `SELECT COUNT(*)::integer AS rows,
              COALESCE(SUM(source_sales_amount), 0)::text AS k,
              COALESCE(SUM(source_profit_amount), 0)::text AS l,
              COALESCE(SUM(source_gross_amount), 0)::text AS n,
              COUNT(*) FILTER (WHERE bank_match_eligible OR paid_auto)::integer AS unsafe_bank_rows
         FROM peakos_intake
        WHERE source_import_run_id = $1
          AND workspace_id = $2`,
      [runId, PEAK_WORKSPACE_ID],
    ),
    client.query(
      `SELECT COUNT(*)::integer AS rows,
              COUNT(*) FILTER (WHERE imported.kind = 'sale')::integer AS sale_rows,
              COUNT(*) FILTER (WHERE imported.kind = 'run')::integer AS run_rows,
              COALESCE(SUM(imported.source_sales_amount)
                FILTER (WHERE imported.kind = 'sale'), 0)::text AS sale_k,
              COALESCE(SUM(imported.source_gross_amount)
                FILTER (WHERE imported.kind = 'sale'), 0)::text AS sale_n,
              COALESCE(SUM(imported.source_salesperson_supply_amount)
                FILTER (WHERE imported.kind = 'run'), 0)::text AS run_cost,
              COUNT(*) FILTER (WHERE imported.kind = 'run' AND parent.id IS NOT NULL)::integer
                AS parent_resolved,
              COUNT(*) FILTER (WHERE imported.kind = 'run' AND parent.id IS NULL)::integer
                AS parent_orphan
         FROM peakos_monthly imported
         LEFT JOIN peakos_monthly parent
           ON parent.id = imported.parent_id
          AND parent.workspace_id = imported.workspace_id
        WHERE imported.source_import_run_id = $1
          AND imported.workspace_id = $2`,
      [runId, PEAK_WORKSPACE_ID],
    ),
    client.query(
      'SELECT COUNT(*)::integer AS rows FROM peakos_settlement_import_quarantine WHERE run_id = $1',
      [runId],
    ),
  ]);
  const intakeRow = intakeResult.rows[0] || {};
  const monthlyRow = monthlyResult.rows[0] || {};
  comparePostInsert({
    intake: {
      rows: intakeRow.rows,
      k: intakeRow.k,
      l: intakeRow.l,
      n: intakeRow.n,
      unsafeBankRows: intakeRow.unsafe_bank_rows,
    },
    monthly: {
      rows: monthlyRow.rows,
      saleRows: monthlyRow.sale_rows,
      runRows: monthlyRow.run_rows,
      saleK: monthlyRow.sale_k,
      saleN: monthlyRow.sale_n,
      runCost: monthlyRow.run_cost,
      parentResolved: monthlyRow.parent_resolved,
      parentOrphan: monthlyRow.parent_orphan,
    },
    quarantine: quarantineResult.rows[0]?.rows || 0,
  }, expected);
}

async function importSettlementPlan({ pool, plan, uidMap, actor }) {
  if (!plan?.report?.baseline?.ok) throw new Error('기준 건수와 다른 dry-run 결과는 이관할 수 없습니다.');
  if (!/^[0-9a-f]{64}$/.test(String(plan.planSha256 || ''))) {
    throw new Error('검증된 정규화 plan 해시가 필요합니다.');
  }
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect가 필요합니다.');
  const actorUid = String(actor?.uid || '').trim();
  const actorName = String(actor?.name || '').trim().slice(0, 120);
  if (!actorUid) throw new Error('이관 실행자 UID가 필요합니다.');
  const runId = crypto.randomUUID();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('peakos-settlement-import-v1'))");
    // Prevent API INSERT/PATCH/DELETE from racing the 1,760-row snapshot while
    // allowing ordinary SELECT traffic to continue.
    await client.query('LOCK TABLE peakos_intake, peakos_monthly IN SHARE ROW EXCLUSIVE MODE');
    await verifyUidMap(client, uidMap);
    await client.query(
      `INSERT INTO peakos_settlement_import_runs
        (id, workspace_id, status, source_manifest_sha256, plan_sha256, source_snapshot, totals,
         actor_uid, actor_name)
       VALUES ($1,$2,'RUNNING',$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [runId, PEAK_WORKSPACE_ID, plan.manifestSha256, plan.planSha256, JSON.stringify(plan.sourceSnapshot),
        JSON.stringify(plan.report.totals), actorUid, actorName],
    );

    let imported = 0;
    let skipped = 0;
    const rollbackItems = [];
    const insertedIntake = [];
    const insertedMonthly = [];
    // Sales precede runs in deterministic source order where possible; orphan
    // parent ids are allowed and preserved for a future older-month import.
    const monthly = [...plan.records.monthly].sort((left, right) => (
      (left.kind === right.kind ? 0 : left.kind === 'sale' ? -1 : 1)
      || left.date.localeCompare(right.date)
      || left.id.localeCompare(right.id)
    ));
    for (const record of plan.records.intake) {
      const result = await insertIntake(client, runId, record);
      if (result.skipped) skipped += 1;
      else { imported += 1; rollbackItems.push(result.item); insertedIntake.push(record); }
    }
    for (const record of monthly) {
      const result = await insertMonthly(client, runId, record);
      if (result.skipped) skipped += 1;
      else { imported += 1; rollbackItems.push(result.item); insertedMonthly.push(record); }
    }
    for (const item of plan.quarantine) {
      await client.query(
        `INSERT INTO peakos_settlement_import_quarantine
          (run_id, source_document_id, source_sheet_name, source_row_number,
           reason_codes, source_payload)
         VALUES ($1,$2,$3,$4,$5::text[],$6::jsonb)`,
        [runId, item.sourceDocumentId, item.sheetName, item.rowNumber,
          item.reasonCodes, JSON.stringify(item.privateSourceRow || {})],
      );
    }
    if (imported + skipped !== plan.records.intake.length + plan.records.monthly.length) {
      throw new Error('이관 처리 건수 검증이 실패했습니다.');
    }
    await assertPostInsertAggregates(
      client,
      runId,
      expectedPostInsert(insertedIntake, insertedMonthly, plan.quarantine.length),
    );
    await client.query(
      `UPDATE peakos_settlement_import_runs
          SET status = 'COMPLETED', imported_count = $2, skipped_count = $3,
              quarantine_count = $4, completed_at = NOW()
        WHERE id = $1 AND workspace_id = $5 AND status = 'RUNNING'`,
      [runId, imported, skipped, plan.quarantine.length, PEAK_WORKSPACE_ID],
    );
    await client.query('COMMIT');
    committed = true;
    return {
      runId,
      imported,
      skipped,
      quarantined: plan.quarantine.length,
      rollbackManifest: {
        version: 2,
        runId,
        manifestSha256: plan.manifestSha256,
        planSha256: plan.planSha256,
        items: rollbackItems,
      },
    };
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const ROLLBACK_SELECT = Object.freeze({
  peakos_intake: `SELECT * FROM peakos_intake
    WHERE id = $1 AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = 'ws_peak'))
    FOR UPDATE`,
  peakos_monthly: `SELECT * FROM peakos_monthly
    WHERE id = $1 AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = 'ws_peak'))
    FOR UPDATE`,
});

async function lockRollbackMutationBoundary(client) {
  // API mutation routes take their advisory lock before their table lock.
  // Rollback takes both API locks in a single fixed order, then both tables,
  // so no newly-created child can appear between dependency validation and
  // deletion and no cross-route lock inversion can deadlock the process.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('peakos-intake-api-mutation-v1:ws_peak'))");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('peakos-monthly-api-mutation-v1:ws_peak'))");
  await client.query('LOCK TABLE peakos_intake, peakos_monthly IN SHARE ROW EXCLUSIVE MODE');
}

async function assertNoExternalRollbackDependents(client, items) {
  const idsByTable = {
    peakos_intake: items.filter(item => item.target_table === 'peakos_intake').map(item => item.target_id),
    peakos_monthly: items.filter(item => item.target_table === 'peakos_monthly').map(item => item.target_id),
  };
  if (idsByTable.peakos_intake.length) {
    const intakeDependents = await client.query(
      `SELECT child.id
         FROM peakos_intake child
        WHERE child.ref_of = ANY($1::text[])
          AND NOT (child.id = ANY($1::text[]))
          AND (child.workspace_id = $2 OR (child.workspace_id IS NULL AND $2 = 'ws_peak'))
        ORDER BY child.id
        LIMIT 1 FOR UPDATE`,
      [idsByTable.peakos_intake, PEAK_WORKSPACE_ID],
    );
    if (intakeDependents.rows.length) {
      throw new Error('이관 후 생성된 연결 접수가 있어 롤백을 중단했습니다.');
    }
  }
  if (idsByTable.peakos_monthly.length) {
    const monthlyDependents = await client.query(
      `SELECT child.id
         FROM peakos_monthly child
        WHERE child.parent_id = ANY($1::text[])
          AND NOT (child.id = ANY($1::text[]))
          AND (child.workspace_id = $2 OR (child.workspace_id IS NULL AND $2 = 'ws_peak'))
        ORDER BY child.id
        LIMIT 1 FOR UPDATE`,
      [idsByTable.peakos_monthly, PEAK_WORKSPACE_ID],
    );
    if (monthlyDependents.rows.length) {
      throw new Error('이관 후 생성된 연결 실행 건이 있어 롤백을 중단했습니다.');
    }
  }
}

async function rollbackSettlementImport({
  pool, runId, actorUid, manifestSha256, planSha256, manifestItems,
}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(runId || ''))) throw new Error('롤백 run id가 올바르지 않습니다.');
  if (!String(actorUid || '').trim()) throw new Error('롤백 실행자 UID가 필요합니다.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('peakos-settlement-import-v1'))");
    await lockRollbackMutationBoundary(client);
    const run = await client.query(
      `SELECT id, status, source_manifest_sha256, plan_sha256
         FROM peakos_settlement_import_runs
        WHERE id = $1 AND workspace_id = $2
        FOR UPDATE`,
      [runId, PEAK_WORKSPACE_ID],
    );
    if (!run.rows[0] || run.rows[0].status !== 'COMPLETED') {
      throw new Error('롤백할 완료 이관 run을 찾지 못했습니다.');
    }
    if (run.rows[0].source_manifest_sha256 !== manifestSha256
        || run.rows[0].plan_sha256 !== planSha256) {
      throw new Error('롤백 manifest와 DB 이관 run이 일치하지 않습니다.');
    }
    const items = await client.query(
      `SELECT target_table, target_id, after_fingerprint, after_state
         FROM peakos_settlement_import_items
        WHERE run_id = $1 AND rolled_back_at IS NULL
        ORDER BY CASE target_table WHEN 'peakos_monthly' THEN 0 ELSE 1 END, target_id
        FOR UPDATE`,
      [runId],
    );
    const expectedItems = new Map((manifestItems || []).map(item => [
      `${item.table}\u0000${item.id}`, item.afterFingerprint,
    ]));
    const manifestMatches = expectedItems.size === (manifestItems || []).length
      && items.rows.length === expectedItems.size
      && items.rows.every(item => expectedItems.get(
        `${item.target_table}\u0000${item.target_id}`,
      ) === item.after_fingerprint);
    if (!manifestMatches) throw new Error('롤백 manifest 항목과 DB 이관 항목이 일치하지 않습니다.');

    await assertNoExternalRollbackDependents(client, items.rows);

    for (const item of items.rows) {
      const selectSql = ROLLBACK_SELECT[item.target_table];
      if (!selectSql) throw new Error('롤백 manifest의 대상 테이블이 올바르지 않습니다.');
      const current = await client.query(selectSql, [item.target_id, PEAK_WORKSPACE_ID]);
      if (!current.rows[0]) throw new Error('롤백 대상 행이 사라졌습니다.');
      const state = item.target_table === 'peakos_intake'
        ? intakeState(current.rows[0]) : monthlyState(current.rows[0]);
      if (String(state.source_import_run_id) !== String(runId)
          || canonicalFingerprint(state) !== item.after_fingerprint) {
        throw new Error('OS에서 수정된 이관 행이 있어 롤백을 중단했습니다.');
      }
      await client.query(
        `DELETE FROM ${item.target_table}
          WHERE id = $1 AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = 'ws_peak'))`,
        [item.target_id, PEAK_WORKSPACE_ID],
      );
    }
    await client.query(
      `UPDATE peakos_settlement_import_items SET rolled_back_at = NOW()
        WHERE run_id = $1 AND rolled_back_at IS NULL`,
      [runId],
    );
    await client.query(
      `UPDATE peakos_settlement_import_runs
          SET status = 'ROLLED_BACK', rolled_back_at = NOW(), rolled_back_by_uid = $2
        WHERE id = $1 AND workspace_id = $3 AND status = 'COMPLETED'`,
      [runId, String(actorUid).trim(), PEAK_WORKSPACE_ID],
    );
    await client.query('COMMIT');
    return { runId, deleted: items.rows.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  INTAKE_INSERT_SQL,
  MIGRATION_PATH,
  MONTHLY_INSERT_SQL,
  ensureSettlementImportInfrastructure,
  assertPostInsertAggregates,
  assertNoExternalRollbackDependents,
  comparePostInsert,
  expectedPostInsert,
  importSettlementPlan,
  intakeState,
  monthlyState,
  lockRollbackMutationBoundary,
  rollbackSettlementImport,
};
