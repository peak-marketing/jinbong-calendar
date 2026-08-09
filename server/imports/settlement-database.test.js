'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { Pool } = require('pg');
const { canonicalFingerprint } = require('./settlement-normalizer');
const {
  INTAKE_INSERT_SQL,
  MIGRATION_PATH,
  MONTHLY_INSERT_SQL,
  assertNoExternalRollbackDependents,
  assertPostInsertAggregates,
  comparePostInsert,
  expectedPostInsert,
  importSettlementPlan,
  intakeState,
  lockRollbackMutationBoundary,
  rollbackSettlementImport,
} = require('./settlement-database');

test('migration은 expected gross·lineage·version·tombstone/audit·plan hash를 만든다', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(sql, /expected_deposit_amount NUMERIC/);
  assert.match(sql, /vendor_paid_amount NUMERIC/);
  assert.match(sql, /row_version BIGINT NOT NULL DEFAULT 1/);
  assert.match(sql, /source_record_fingerprint/);
  assert.match(sql, /plan_sha256 TEXT NOT NULL/);
  assert.match(sql, /peakos_intake_bank_match_expected_candidate_idx/);
  assert.match(sql, /ALTER TABLE peakos_monthly[\s\S]*row_version BIGINT NOT NULL DEFAULT 1/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS peakos_intake_tombstones/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS peakos_intake_audit_log/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS peakos_monthly_tombstones/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS peakos_monthly_audit_log/);
  assert.doesNotMatch(sql, /DROP INDEX IF EXISTS peakos_intake_bank_match_candidate_idx/);
});

test('import 함수는 API mutation과 경쟁하지 않도록 transaction table lock을 선언한다', () => {
  assert.match(
    importSettlementPlan.toString(),
    /LOCK TABLE peakos_intake, peakos_monthly IN SHARE ROW EXCLUSIVE MODE/,
  );
  assert.match(INTAKE_INSERT_SQL, /source_metadata, workspace_id, source_imported_at/);
  assert.match(MONTHLY_INSERT_SQL, /source_metadata, workspace_id, source_imported_at/);
  assert.match(importSettlementPlan.toString(), /PEAK_WORKSPACE_ID/);
});

test('post-insert 기대 집계는 intake K/L/N과 특수 sale/run/parent를 분리한다', () => {
  const intake = [{
    source: { salesAmount: 100, profitAmount: 30, grossAmount: 110 },
  }];
  const monthly = [
    {
      kind: 'sale', parentResolvedInImport: true,
      source: { salesAmount: 200, grossAmount: 220, salespersonSupplyAmount: null },
    },
    {
      kind: 'run', parentResolvedInImport: false,
      source: { salesAmount: 0, grossAmount: null, salespersonSupplyAmount: 40 },
    },
  ];
  assert.deepEqual(expectedPostInsert(intake, monthly, 1), {
    intake: { rows: 1, k: 100, l: 30, n: 110, unsafeBankRows: 0 },
    monthly: {
      rows: 2, saleRows: 1, runRows: 1, saleK: 200, saleN: 220,
      runCost: 40, parentResolved: 0, parentOrphan: 1,
    },
    quarantine: 1,
  });
  assert.doesNotThrow(() => comparePostInsert({ value: '10' }, { value: 10 }));
  assert.throws(() => comparePostInsert({ value: 9 }, { value: 10 }), /검증이 실패/);
});

test('post-insert DB 조회가 VAT gross와 자동매칭 차단을 검증한다', async () => {
  const sql = [];
  const client = {
    async query(statement) {
      const normalized = String(statement).replace(/\s+/g, ' ');
      sql.push(normalized);
      if (normalized.includes('FROM peakos_intake')) {
        return { rows: [{ rows: 1, k: '100', l: '30', n: '110', unsafe_bank_rows: 0 }] };
      }
      if (normalized.includes('FROM peakos_monthly')) {
        return { rows: [{
          rows: 1, sale_rows: 1, run_rows: 0, sale_k: '200', sale_n: '220',
          run_cost: '0', parent_resolved: 0, parent_orphan: 0,
        }] };
      }
      return { rows: [{ rows: 1 }] };
    },
  };
  await assertPostInsertAggregates(client, '00000000-0000-0000-0000-000000000000', {
    intake: { rows: 1, k: 100, l: 30, n: 110, unsafeBankRows: 0 },
    monthly: {
      rows: 1, saleRows: 1, runRows: 0, saleK: 200, saleN: 220,
      runCost: 0, parentResolved: 0, parentOrphan: 0,
    },
    quarantine: 1,
  });
  assert.ok(sql.some(statement => statement.includes('SUM(source_gross_amount)')));
  assert.ok(sql.some(statement => statement.includes('bank_match_eligible OR paid_auto')));
  assert.equal(sql.filter(statement => /FROM peakos_(?:intake|monthly)/.test(statement))
    .every(statement => statement.includes('workspace_id')), true);
});

test('rollback fingerprint에는 monotonic row_version과 vendor 지급액이 포함된다', () => {
  const row = {
    id: 'row', row_version: 1, owner_uid: 'uid', owner_name: 'name', date: '2026-06-01',
    client: 'client', expected_payer: 'payer', expected_deposit_amount: '110',
    a: '', b: '', c: '', unit: '1', qty: '1', sell: '100', cost: null, memo: '',
    kind: 'normal', ref_of: '', supplier: '', manager: '', final_only: false,
    paid: 'none', paid_amount: '0', payer: '', paid_date: '', paid_memo: '', paid_auto: false,
    bank_match_eligible: false, vendor_paid: false, vendor_paid_amount: null,
    vendor_paid_date: '', vendor_bank: '', vendor_by: '', vendor_memo: '',
    source_document_id: 'externaldocumentidentifier001', source_sheet_name: '2026-06 정산',
    source_row_number: 2, source_record_type: 'individual',
    source_record_fingerprint: 'a'.repeat(64),
    source_import_run_id: '00000000-0000-0000-0000-000000000000',
    source_gross_amount: '110', source_expected_deposit_amount: '110',
    source_sales_amount: '100', source_salesperson_supply_amount: '70',
    source_profit_amount: '30', source_payment_status: '미입금', source_metadata: {},
  };
  const first = intakeState(row);
  const edited = intakeState({ ...row, row_version: 2, vendor_paid_amount: '70' });
  assert.notEqual(canonicalFingerprint(first), canonicalFingerprint(edited));
});

test('rollback mutation boundary는 API advisory 두 개를 고정 순서로 잡은 뒤 table lock을 잡는다', async () => {
  const calls = [];
  await lockRollbackMutationBoundary({
    query: async sql => { calls.push(String(sql)); return { rows: [] }; },
  });
  assert.deepEqual(calls, [
    "SELECT pg_advisory_xact_lock(hashtext('peakos-intake-api-mutation-v1:ws_peak'))",
    "SELECT pg_advisory_xact_lock(hashtext('peakos-monthly-api-mutation-v1:ws_peak'))",
    'LOCK TABLE peakos_intake, peakos_monthly IN SHARE ROW EXCLUSIVE MODE',
  ]);
});

test('rollback dependent 검사는 manifest 내부 child는 제외하고 intake ref/monthly parent 외부 child를 잠근다', async () => {
  const calls = [];
  await assertNoExternalRollbackDependents({
    async query(sql, values) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), values });
      return { rows: [] };
    },
  }, [
    { target_table: 'peakos_intake', target_id: 'intake-parent' },
    { target_table: 'peakos_intake', target_id: 'intake-internal-child' },
    { target_table: 'peakos_monthly', target_id: 'monthly-parent' },
    { target_table: 'peakos_monthly', target_id: 'monthly-internal-child' },
  ]);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /child\.ref_of = ANY\(\$1::text\[\]\)/);
  assert.match(calls[0].sql, /NOT \(child\.id = ANY\(\$1::text\[\]\)\)/);
  assert.match(calls[0].sql, /LIMIT 1 FOR UPDATE/);
  assert.match(calls[0].sql, /child\.workspace_id = \$2/);
  assert.deepEqual(calls[0].values, [['intake-parent', 'intake-internal-child'], 'ws_peak']);
  assert.match(calls[1].sql, /child\.parent_id = ANY\(\$1::text\[\]\)/);
  assert.match(calls[1].sql, /child\.workspace_id = \$2/);
  assert.deepEqual(calls[1].values, [['monthly-parent', 'monthly-internal-child'], 'ws_peak']);

  await assert.rejects(
    assertNoExternalRollbackDependents({
      async query(sql) {
        return { rows: String(sql).includes('peakos_intake child') ? [{ id: 'api-created-child' }] : [] };
      },
    }, [{ target_table: 'peakos_intake', target_id: 'intake-parent' }]),
    /연결 접수/,
  );
  await assert.rejects(
    assertNoExternalRollbackDependents({
      async query(sql) {
        return { rows: String(sql).includes('peakos_monthly child') ? [{ id: 'api-created-run' }] : [] };
      },
    }, [{ target_table: 'peakos_monthly', target_id: 'monthly-parent' }]),
    /연결 실행 건/,
  );
});

test('rollback은 API 생성 intake child가 있으면 어떤 imported 행도 삭제하지 않고 전체 rollback한다', async () => {
  const runId = '00000000-0000-0000-0000-000000000001';
  const manifestSha256 = 'a'.repeat(64);
  const planSha256 = 'b'.repeat(64);
  const afterFingerprint = 'c'.repeat(64);
  const statements = [];
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push(normalized);
      if (normalized.startsWith('SELECT id, status, source_manifest_sha256')) {
        return { rows: [{ id: runId, status: 'COMPLETED', source_manifest_sha256: manifestSha256, plan_sha256: planSha256 }] };
      }
      if (normalized.startsWith('SELECT target_table, target_id')) {
        return { rows: [{
          target_table: 'peakos_intake', target_id: 'imported-parent',
          after_fingerprint: afterFingerprint, after_state: {},
        }] };
      }
      if (normalized.includes('FROM peakos_intake child')) return { rows: [{ id: 'api-created-child' }] };
      return { rows: [] };
    },
    release() {},
  };
  await assert.rejects(
    rollbackSettlementImport({
      pool: { connect: async () => client }, runId, actorUid: 'rollback-actor',
      manifestSha256, planSha256,
      manifestItems: [{ table: 'peakos_intake', id: 'imported-parent', afterFingerprint }],
    }),
    /연결 접수/,
  );
  const importLock = statements.indexOf("SELECT pg_advisory_xact_lock(hashtext('peakos-settlement-import-v1'))");
  const intakeApiLock = statements.indexOf("SELECT pg_advisory_xact_lock(hashtext('peakos-intake-api-mutation-v1:ws_peak'))");
  const monthlyApiLock = statements.indexOf("SELECT pg_advisory_xact_lock(hashtext('peakos-monthly-api-mutation-v1:ws_peak'))");
  const tableLock = statements.indexOf('LOCK TABLE peakos_intake, peakos_monthly IN SHARE ROW EXCLUSIVE MODE');
  assert.ok(importLock >= 0 && importLock < intakeApiLock && intakeApiLock < monthlyApiLock && monthlyApiLock < tableLock);
  assert.equal(statements.some(sql => sql.startsWith('DELETE FROM peakos_')), false);
  assert.equal(statements.at(-1), 'ROLLBACK');
});

const testDatabaseUrl = process.env.PEAKOS_TEST_DATABASE_URL || '';
test('실제 PostgreSQL에서 migration column/index/constraint를 생성한다', {
  skip: !testDatabaseUrl,
}, async t => {
  const parsed = new URL(testDatabaseUrl);
  if (!/test/i.test(parsed.pathname)) {
    throw new Error('PEAKOS_TEST_DATABASE_URL은 이름에 test가 포함된 전용 DB여야 합니다.');
  }
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  t.after(() => pool.end());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const schema = `settlement_import_test_${Date.now()}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public`);
    await client.query(`CREATE TABLE peakos_intake (
      id TEXT PRIMARY KEY, owner_uid TEXT, date DATE, kind TEXT, sell NUMERIC, qty NUMERIC,
      paid_amount NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(),
      bank_match_eligible BOOLEAN DEFAULT FALSE, paid_auto BOOLEAN DEFAULT FALSE
    )`);
    await client.query('CREATE TABLE peakos_monthly (id TEXT PRIMARY KEY)');
    await client.query(fs.readFileSync(MIGRATION_PATH, 'utf8'));
    const columns = await client.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name IN ('peakos_intake','peakos_monthly','peakos_settlement_import_runs')`,
      [schema],
    );
    const names = new Set(columns.rows.map(row => `${row.table_name}.${row.column_name}`));
    assert.ok(names.has('peakos_intake.expected_deposit_amount'));
    assert.ok(names.has('peakos_intake.row_version'));
    assert.ok(names.has('peakos_intake.vendor_paid_amount'));
    assert.ok(names.has('peakos_settlement_import_runs.plan_sha256'));
    assert.ok(names.has('peakos_monthly.row_version'));
    const indexes = await client.query('SELECT indexname FROM pg_indexes WHERE schemaname = $1', [schema]);
    assert.ok(indexes.rows.some(row => row.indexname === 'peakos_intake_bank_match_expected_candidate_idx'));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});
