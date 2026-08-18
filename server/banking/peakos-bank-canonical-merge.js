'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { loadIbkAccountConfig } = require('./ibk-account-config');

const SOURCE_DATABASE = 'calendar_business_os';
const TARGET_DATABASE = 'calendar_db';
const PEAK_WORKSPACE_ID = 'ws_peak';
const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  'migrations',
  '20260817_peakos_bank_workspace_merge.sql',
);
const ACCOUNT_IDS = Object.freeze([
  'ibk-hq-sales',
  'ibk-hq-supplier',
  'ibk-hq-fixed',
  'ibk-review-space',
  'ibk-reward-space',
]);
const MAX_SOURCE_ROWS = Object.freeze({
  transactions: 100_000,
  runs: 200_000,
  allocations: 100_000,
  audits: 500_000,
});
const EXPECTED_CUTOVER_SOURCE_COUNTS = Object.freeze({
  accounts: 5,
  transactions: 367,
  runs: 1260,
  allocations: 0,
  audits: 1302,
});

class BankCanonicalMergeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BankCanonicalMergeError';
    this.code = code;
  }
}

function fail(code) {
  throw new BankCanonicalMergeError(code);
}

function maskedComparable(value) {
  return String(value || '').replace(/[xX•●]/g, '*').replace(/\s+/g, '');
}

function transactionKey(row) {
  return `${row.account_id}\u0000${row.provider_transaction_key}`;
}

function sameTimestamp(left, right) {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return Number.isFinite(leftTime) && leftTime === rightTime;
}

function countsOf(snapshot) {
  return Object.freeze({
    accounts: snapshot.accounts.length,
    transactions: snapshot.transactions.length,
    runs: snapshot.runs.length,
    allocations: snapshot.allocations.length,
    audits: snapshot.audits.length,
  });
}

function assertExactCounts(actual, expected, errorCode = 'BANK_MERGE_SOURCE_COUNT_MISMATCH') {
  if (!expected) return;
  for (const key of ['accounts', 'transactions', 'runs', 'allocations', 'audits']) {
    if (!Number.isInteger(expected[key]) || Number(actual[key]) !== expected[key]) fail(errorCode);
  }
}

function validateSourceSnapshot(snapshot, configuredAccounts) {
  const expectedIds = [...ACCOUNT_IDS].sort();
  const actualIds = snapshot.accounts.map(row => String(row.id || '')).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) fail('BANK_MERGE_SOURCE_ACCOUNTS_INVALID');
  if (snapshot.accounts.some(row => row.is_active !== true)) fail('BANK_MERGE_SOURCE_ACCOUNT_INACTIVE');

  const configured = new Map((configuredAccounts || []).map(row => [String(row.id || ''), row]));
  if (configured.size !== ACCOUNT_IDS.length) fail('BANK_MERGE_CREDENTIAL_MAPPING_INVALID');
  for (const account of snapshot.accounts) {
    const credential = configured.get(account.id);
    if (!credential || maskedComparable(credential.accountNumberMasked)
        !== maskedComparable(account.account_number_masked)) {
      fail('BANK_MERGE_CREDENTIAL_MAPPING_INVALID');
    }
  }

  for (const [key, limit] of Object.entries(MAX_SOURCE_ROWS)) {
    if (!Array.isArray(snapshot[key]) || snapshot[key].length > limit) fail('BANK_MERGE_SOURCE_LIMIT');
  }
  const accountSet = new Set(ACCOUNT_IDS);
  const transactionKeys = new Set();
  for (const row of snapshot.transactions) {
    const key = transactionKey(row);
    if (!accountSet.has(String(row.account_id || ''))
        || !String(row.provider_transaction_key || '')
        || transactionKeys.has(key)) fail('BANK_MERGE_SOURCE_TRANSACTION_INVALID');
    transactionKeys.add(key);
  }
  const requestIds = new Set();
  for (const row of snapshot.runs) {
    const requestId = String(row.request_id || '');
    if (!accountSet.has(String(row.account_id || '')) || !requestId || requestIds.has(requestId)) {
      fail('BANK_MERGE_SOURCE_RUN_INVALID');
    }
    requestIds.add(requestId);
  }
  for (const row of snapshot.allocations) {
    if (!transactionKeys.has(`${row.source_account_id}\u0000${row.source_provider_transaction_key}`)) {
      fail('BANK_MERGE_SOURCE_ALLOCATION_INVALID');
    }
  }
  return countsOf(snapshot);
}

async function readSourceSnapshot(client) {
  const accounts = (await client.query(
    `SELECT id, provider, bank_name, display_name, branch_id, account_number_masked,
            account_fingerprint, currency, purpose, is_active, latest_balance,
            latest_balance_at, last_sync_started_at, last_sync_succeeded_at,
            last_sync_error, created_at, updated_at
       FROM peakos_bank_accounts
      ORDER BY id`,
  )).rows;
  const transactions = (await client.query(
    `SELECT account_id, provider_transaction_key, provider_key_stable,
            transaction_at, direction, amount, balance, summary, counterparty_name,
            counterparty_account_masked, branch_text, reconciliation_status, source,
            first_seen_at, last_seen_at, created_at, updated_at
       FROM peakos_bank_transactions
      ORDER BY id`,
  )).rows;
  const runs = (await client.query(
    `SELECT account_id, status, trigger_type, requested_by_uid, requested_by_name,
            started_at, finished_at, range_from, range_to, fetched_count,
            inserted_count, updated_count, error_code, error_message, request_id
       FROM peakos_bank_sync_runs
      ORDER BY id`,
  )).rows;
  const allocations = (await client.query(
    `SELECT allocation.id AS source_id, transaction_row.account_id AS source_account_id,
            transaction_row.provider_transaction_key AS source_provider_transaction_key,
            allocation.intake_id, allocation.allocated_amount, allocation.status,
            allocation.match_method, allocation.confidence, allocation.reason,
            allocation.created_by_uid, allocation.created_by_name, allocation.created_at,
            allocation.reversed_by_uid, allocation.reversed_by_name,
            allocation.reversed_at, allocation.reversal_reason
       FROM peakos_bank_allocations allocation
       JOIN peakos_bank_transactions transaction_row ON transaction_row.id = allocation.transaction_id
      ORDER BY allocation.id`,
  )).rows;
  const audits = (await client.query(
    `SELECT id AS source_id, action, entity_type, entity_id, actor_uid, actor_name,
            request_id, ip_address, reason, metadata, created_at
       FROM peakos_bank_audit_log
      ORDER BY id`,
  )).rows;
  return { accounts, transactions, runs, allocations, audits };
}

async function assertTargetSchema(client, workspaceId) {
  const workspace = await client.query(
    'SELECT 1 FROM peakos_workspaces WHERE id = $1 AND active = TRUE',
    [workspaceId],
  );
  if (!workspace.rows[0]) fail('BANK_MERGE_WORKSPACE_NOT_READY');
  const required = [
    ['peakos_bank_accounts', 'workspace_id'],
    ['peakos_bank_transactions', 'workspace_id'],
    ['peakos_bank_sync_runs', 'workspace_id'],
    ['peakos_bank_allocations', 'workspace_id'],
    ['peakos_bank_allocations', 'legacy_source_key'],
    ['peakos_bank_audit_log', 'workspace_id'],
    ['peakos_bank_audit_log', 'legacy_source_key'],
  ];
  const columns = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    [[...new Set(required.map(([table]) => table))]],
  );
  const available = new Set(columns.rows.map(row => `${row.table_name}.${row.column_name}`));
  if (required.some(([table, column]) => !available.has(`${table}.${column}`))) {
    fail('BANK_MERGE_TARGET_MIGRATION_REQUIRED');
  }
}

async function readTargetComparable(client, workspaceId) {
  const accounts = (await client.query(
    `SELECT id, workspace_id, account_number_masked
       FROM peakos_bank_accounts
      WHERE id = ANY($1::text[])`,
    [ACCOUNT_IDS],
  )).rows;
  const transactions = (await client.query(
    `SELECT account_id, provider_transaction_key, transaction_at, direction, amount, workspace_id
       FROM peakos_bank_transactions
      WHERE account_id = ANY($1::text[])`,
    [ACCOUNT_IDS],
  )).rows;
  const runs = (await client.query(
    `SELECT account_id, request_id, workspace_id
       FROM peakos_bank_sync_runs
      WHERE request_id IS NOT NULL AND account_id = ANY($1::text[])`,
    [ACCOUNT_IDS],
  )).rows;
  const allocationKeys = (await client.query(
    `SELECT legacy_source_key
       FROM peakos_bank_allocations
      WHERE workspace_id = $1 AND legacy_source_key IS NOT NULL`,
    [workspaceId],
  )).rows;
  const auditKeys = (await client.query(
    `SELECT legacy_source_key
       FROM peakos_bank_audit_log
      WHERE workspace_id = $1 AND legacy_source_key IS NOT NULL`,
    [workspaceId],
  )).rows;
  return { accounts, transactions, runs, allocationKeys, auditKeys };
}

function buildPlan(snapshot, target, workspaceId) {
  const targetAccounts = new Map(target.accounts.map(row => [String(row.id), row]));
  for (const account of snapshot.accounts) {
    const existing = targetAccounts.get(account.id);
    if (existing && (existing.workspace_id !== workspaceId
        || maskedComparable(existing.account_number_masked)
          !== maskedComparable(account.account_number_masked))) {
      fail('BANK_MERGE_TARGET_ACCOUNT_CONFLICT');
    }
  }
  const targetTransactions = new Map(target.transactions.map(row => [transactionKey(row), row]));
  for (const row of snapshot.transactions) {
    const existing = targetTransactions.get(transactionKey(row));
    if (existing && (existing.workspace_id !== workspaceId
        || !sameTimestamp(existing.transaction_at, row.transaction_at)
        || existing.direction !== row.direction
        || String(existing.amount) !== String(row.amount))) {
      fail('BANK_MERGE_TARGET_TRANSACTION_CONFLICT');
    }
  }
  const targetRuns = new Map(target.runs.map(row => [String(row.request_id), row]));
  for (const row of snapshot.runs) {
    const existing = targetRuns.get(String(row.request_id));
    if (existing && (existing.workspace_id !== workspaceId || existing.account_id !== row.account_id)) {
      fail('BANK_MERGE_TARGET_RUN_CONFLICT');
    }
  }
  const allocationKeys = new Set(target.allocationKeys.map(row => String(row.legacy_source_key)));
  const auditKeys = new Set(target.auditKeys.map(row => String(row.legacy_source_key)));
  return Object.freeze({
    source: countsOf(snapshot),
    insert: Object.freeze({
      accounts: snapshot.accounts.filter(row => !targetAccounts.has(row.id)).length,
      transactions: snapshot.transactions.filter(row => !targetTransactions.has(transactionKey(row))).length,
      runs: snapshot.runs.filter(row => !targetRuns.has(String(row.request_id))).length,
      allocations: snapshot.allocations.filter(row => !allocationKeys.has(
        `${SOURCE_DATABASE}:peakos_bank_allocations:${row.source_id}`,
      )).length,
      audits: snapshot.audits.filter(row => !auditKeys.has(
        `${SOURCE_DATABASE}:peakos_bank_audit_log:${row.source_id}`,
      )).length,
    }),
  });
}

async function createPlanWithClients({ sourceClient, targetClient, configuredAccounts, workspaceId }) {
  await assertTargetSchema(targetClient, workspaceId);
  const snapshot = await readSourceSnapshot(sourceClient);
  validateSourceSnapshot(snapshot, configuredAccounts);
  const target = await readTargetComparable(targetClient, workspaceId);
  return { snapshot, plan: buildPlan(snapshot, target, workspaceId) };
}

async function preflightCanonicalBankMerge({
  sourcePool,
  targetPool,
  configuredAccounts,
  workspaceId = PEAK_WORKSPACE_ID,
} = {}) {
  if (!sourcePool?.connect || !targetPool?.connect) throw new TypeError('sourcePool과 targetPool이 필요합니다.');
  const sourceClient = await sourcePool.connect();
  const targetClient = await targetPool.connect();
  try {
    await sourceClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await targetClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { plan } = await createPlanWithClients({
      sourceClient, targetClient, configuredAccounts, workspaceId,
    });
    await targetClient.query('ROLLBACK');
    await sourceClient.query('ROLLBACK');
    return Object.freeze({ ok: true, applyRequired: Object.values(plan.insert).some(Boolean), ...plan });
  } catch (error) {
    await targetClient.query('ROLLBACK').catch(() => {});
    await sourceClient.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    targetClient.release();
    sourceClient.release();
  }
}

async function upsertAccounts(client, accounts, workspaceId) {
  for (const row of accounts) {
    const result = await client.query(
      `INSERT INTO peakos_bank_accounts
        (id, provider, bank_name, display_name, branch_id, account_number_masked,
         account_fingerprint, currency, purpose, is_active, latest_balance,
         latest_balance_at, last_sync_started_at, last_sync_succeeded_at,
         last_sync_error, created_at, updated_at, workspace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (id) DO UPDATE SET
         provider = EXCLUDED.provider,
         bank_name = EXCLUDED.bank_name,
         display_name = EXCLUDED.display_name,
         branch_id = EXCLUDED.branch_id,
         account_number_masked = EXCLUDED.account_number_masked,
         account_fingerprint = EXCLUDED.account_fingerprint,
         currency = EXCLUDED.currency,
         purpose = EXCLUDED.purpose,
         is_active = EXCLUDED.is_active,
         latest_balance = EXCLUDED.latest_balance,
         latest_balance_at = EXCLUDED.latest_balance_at,
         last_sync_started_at = EXCLUDED.last_sync_started_at,
         last_sync_succeeded_at = EXCLUDED.last_sync_succeeded_at,
         last_sync_error = EXCLUDED.last_sync_error,
         updated_at = GREATEST(peakos_bank_accounts.updated_at, EXCLUDED.updated_at),
         workspace_id = EXCLUDED.workspace_id
       WHERE peakos_bank_accounts.workspace_id = EXCLUDED.workspace_id
         AND peakos_bank_accounts.account_number_masked = EXCLUDED.account_number_masked
       RETURNING id`,
      [row.id, row.provider, row.bank_name, row.display_name, row.branch_id,
        row.account_number_masked, row.account_fingerprint, row.currency, row.purpose,
        row.is_active, row.latest_balance, row.latest_balance_at, row.last_sync_started_at,
        row.last_sync_succeeded_at, row.last_sync_error, row.created_at, row.updated_at,
        workspaceId],
    );
    if (!result.rows[0]) fail('BANK_MERGE_TARGET_ACCOUNT_CONFLICT');
  }
}

async function upsertTransactions(client, rows, workspaceId) {
  for (const row of rows) {
    const result = await client.query(
      `INSERT INTO peakos_bank_transactions AS existing
        (account_id, provider_transaction_key, provider_key_stable, transaction_at,
         direction, amount, balance, summary, counterparty_name,
         counterparty_account_masked, branch_text, reconciliation_status, source,
         first_seen_at, last_seen_at, created_at, updated_at, workspace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (account_id, provider_transaction_key) DO UPDATE SET
         provider_key_stable = existing.provider_key_stable AND EXCLUDED.provider_key_stable,
         balance = EXCLUDED.balance,
         summary = EXCLUDED.summary,
         counterparty_name = EXCLUDED.counterparty_name,
         counterparty_account_masked = EXCLUDED.counterparty_account_masked,
         branch_text = EXCLUDED.branch_text,
         reconciliation_status = EXCLUDED.reconciliation_status,
         first_seen_at = LEAST(existing.first_seen_at, EXCLUDED.first_seen_at),
         last_seen_at = GREATEST(existing.last_seen_at, EXCLUDED.last_seen_at),
         updated_at = GREATEST(existing.updated_at, EXCLUDED.updated_at),
         workspace_id = EXCLUDED.workspace_id
       WHERE existing.workspace_id = EXCLUDED.workspace_id
         AND existing.transaction_at = EXCLUDED.transaction_at
         AND existing.direction = EXCLUDED.direction
         AND existing.amount = EXCLUDED.amount
       RETURNING id`,
      [row.account_id, row.provider_transaction_key, row.provider_key_stable,
        row.transaction_at, row.direction, row.amount, row.balance, row.summary,
        row.counterparty_name, row.counterparty_account_masked, row.branch_text,
        row.reconciliation_status, row.source, row.first_seen_at, row.last_seen_at,
        row.created_at, row.updated_at, workspaceId],
    );
    if (!result.rows[0]) fail('BANK_MERGE_TARGET_TRANSACTION_CONFLICT');
  }
}

async function upsertRuns(client, rows, workspaceId) {
  for (const row of rows) {
    const result = await client.query(
      `INSERT INTO peakos_bank_sync_runs AS existing
        (account_id, status, trigger_type, requested_by_uid, requested_by_name,
         started_at, finished_at, range_from, range_to, fetched_count,
         inserted_count, updated_count, error_code, error_message, request_id, workspace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO UPDATE SET
         status = EXCLUDED.status,
         finished_at = EXCLUDED.finished_at,
         range_from = EXCLUDED.range_from,
         range_to = EXCLUDED.range_to,
         fetched_count = EXCLUDED.fetched_count,
         inserted_count = EXCLUDED.inserted_count,
         updated_count = EXCLUDED.updated_count,
         error_code = EXCLUDED.error_code,
         error_message = EXCLUDED.error_message,
         workspace_id = EXCLUDED.workspace_id
       WHERE existing.account_id = EXCLUDED.account_id
         AND existing.workspace_id = EXCLUDED.workspace_id
       RETURNING id`,
      [row.account_id, row.status, row.trigger_type, row.requested_by_uid,
        row.requested_by_name, row.started_at, row.finished_at, row.range_from,
        row.range_to, row.fetched_count, row.inserted_count, row.updated_count,
        row.error_code, row.error_message, row.request_id, workspaceId],
    );
    if (!result.rows[0]) fail('BANK_MERGE_TARGET_RUN_CONFLICT');
  }
}

async function upsertAllocations(client, rows, workspaceId) {
  for (const row of rows) {
    const transaction = await client.query(
      `SELECT id FROM peakos_bank_transactions
        WHERE workspace_id = $1 AND account_id = $2 AND provider_transaction_key = $3`,
      [workspaceId, row.source_account_id, row.source_provider_transaction_key],
    );
    if (!transaction.rows[0]) fail('BANK_MERGE_TARGET_TRANSACTION_MISSING');
    const legacyKey = `${SOURCE_DATABASE}:peakos_bank_allocations:${row.source_id}`;
    const result = await client.query(
      `INSERT INTO peakos_bank_allocations AS existing
        (transaction_id, intake_id, allocated_amount, status, match_method,
         confidence, reason, created_by_uid, created_by_name, created_at,
         reversed_by_uid, reversed_by_name, reversed_at, reversal_reason,
         workspace_id, legacy_source_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (workspace_id, legacy_source_key) WHERE legacy_source_key IS NOT NULL
       DO UPDATE SET
         status = EXCLUDED.status,
         reversed_by_uid = EXCLUDED.reversed_by_uid,
         reversed_by_name = EXCLUDED.reversed_by_name,
         reversed_at = EXCLUDED.reversed_at,
         reversal_reason = EXCLUDED.reversal_reason
       WHERE existing.transaction_id = EXCLUDED.transaction_id
         AND existing.intake_id = EXCLUDED.intake_id
         AND existing.allocated_amount = EXCLUDED.allocated_amount
       RETURNING id`,
      [transaction.rows[0].id, row.intake_id, row.allocated_amount, row.status,
        row.match_method, row.confidence, row.reason, row.created_by_uid,
        row.created_by_name, row.created_at, row.reversed_by_uid,
        row.reversed_by_name, row.reversed_at, row.reversal_reason, workspaceId,
        legacyKey],
    );
    if (!result.rows[0]) fail('BANK_MERGE_TARGET_ALLOCATION_CONFLICT');
  }
}

async function insertAudits(client, rows, workspaceId) {
  for (const row of rows) {
    const legacyKey = `${SOURCE_DATABASE}:peakos_bank_audit_log:${row.source_id}`;
    await client.query(
      `INSERT INTO peakos_bank_audit_log
        (action, entity_type, entity_id, actor_uid, actor_name, request_id,
         ip_address, reason, metadata, created_at, workspace_id, legacy_source_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (workspace_id, legacy_source_key) WHERE legacy_source_key IS NOT NULL
       DO NOTHING`,
      [row.action, row.entity_type, row.entity_id, row.actor_uid, row.actor_name,
        row.request_id, row.ip_address, row.reason, row.metadata || {}, row.created_at,
        workspaceId, legacyKey],
    );
  }
}

async function targetCounts(client, workspaceId) {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM peakos_bank_accounts WHERE workspace_id = $1) AS accounts,
       (SELECT COUNT(*)::integer FROM peakos_bank_transactions WHERE workspace_id = $1) AS transactions,
       (SELECT COUNT(*)::integer FROM peakos_bank_sync_runs WHERE workspace_id = $1) AS runs,
       (SELECT COUNT(*)::integer FROM peakos_bank_allocations WHERE workspace_id = $1) AS allocations,
       (SELECT COUNT(*)::integer FROM peakos_bank_audit_log WHERE workspace_id = $1) AS audits,
       (SELECT COUNT(*)::integer FROM peakos_bank_allocations
         WHERE workspace_id = $1 AND legacy_source_key LIKE $2) AS imported_allocations,
       (SELECT COUNT(*)::integer FROM peakos_bank_audit_log
         WHERE workspace_id = $1 AND legacy_source_key LIKE $3) AS imported_audits`,
    [workspaceId,
      `${SOURCE_DATABASE}:peakos_bank_allocations:%`,
      `${SOURCE_DATABASE}:peakos_bank_audit_log:%`],
  );
  const row = result.rows[0] || {};
  return Object.freeze({
    accounts: Number(row.accounts || 0),
    transactions: Number(row.transactions || 0),
    runs: Number(row.runs || 0),
    allocations: Number(row.allocations || 0),
    audits: Number(row.audits || 0),
    importedAllocations: Number(row.imported_allocations || 0),
    importedAudits: Number(row.imported_audits || 0),
  });
}

async function applyCanonicalBankMerge({
  sourcePool,
  targetPool,
  configuredAccounts,
  workspaceId = PEAK_WORKSPACE_ID,
  applyMigration = false,
  migrationSql,
  expectedSourceCounts,
} = {}) {
  if (!sourcePool?.connect || !targetPool?.connect) throw new TypeError('sourcePool과 targetPool이 필요합니다.');
  const sourceClient = await sourcePool.connect();
  const targetClient = await targetPool.connect();
  try {
    await sourceClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await targetClient.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await targetClient.query("SELECT pg_advisory_xact_lock(hashtext('peakos-bank-canonical-merge-v1'))");
    if (applyMigration) {
      await targetClient.query(migrationSql || fs.readFileSync(MIGRATION_PATH, 'utf8'));
    }
    const { snapshot, plan } = await createPlanWithClients({
      sourceClient, targetClient, configuredAccounts, workspaceId,
    });
    assertExactCounts(plan.source, expectedSourceCounts);
    await upsertAccounts(targetClient, snapshot.accounts, workspaceId);
    await upsertTransactions(targetClient, snapshot.transactions, workspaceId);
    await upsertRuns(targetClient, snapshot.runs, workspaceId);
    await upsertAllocations(targetClient, snapshot.allocations, workspaceId);
    await insertAudits(targetClient, snapshot.audits, workspaceId);
    const finalCounts = await targetCounts(targetClient, workspaceId);
    if (expectedSourceCounts) {
      // The canonical ledger can legitimately advance after cutover. Require
      // complete source coverage, while keeping imported legacy identities
      // exact, instead of rejecting later bank sync rows as a mismatch.
      if (finalCounts.accounts < expectedSourceCounts.accounts
          || finalCounts.transactions < expectedSourceCounts.transactions
          || finalCounts.runs < expectedSourceCounts.runs
          || finalCounts.importedAllocations !== expectedSourceCounts.allocations
          || finalCounts.importedAudits !== expectedSourceCounts.audits) {
        fail('BANK_MERGE_VERIFY_FAILED');
      }
    } else if (finalCounts.accounts < plan.source.accounts
        || finalCounts.transactions < plan.source.transactions
        || finalCounts.runs < plan.source.runs
        || finalCounts.allocations < plan.source.allocations
        || finalCounts.importedAllocations < plan.source.allocations
        || finalCounts.importedAudits < plan.source.audits) fail('BANK_MERGE_VERIFY_FAILED');
    await sourceClient.query('COMMIT');
    await targetClient.query('COMMIT');
    return Object.freeze({ ok: true, applied: true, source: plan.source, plannedInsert: plan.insert, target: finalCounts });
  } catch (error) {
    await targetClient.query('ROLLBACK').catch(() => {});
    await sourceClient.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    targetClient.release();
    sourceClient.release();
  }
}

function databaseConfig(database) {
  return {
    user: process.env.PGUSER || 'calendar_user',
    password: process.env.PGPASSWORD,
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    database,
    application_name: 'peakos-bank-canonical-merge',
    max: 1,
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.some(argument => argument !== '--apply')) {
    process.stdout.write('{"ok":false,"errorCode":"BANK_MERGE_ARGUMENT_INVALID"}\n');
    process.exitCode = 1;
    return;
  }
  const apply = argv.includes('--apply');
  const sourcePool = new Pool(databaseConfig(SOURCE_DATABASE));
  const targetPool = new Pool(databaseConfig(TARGET_DATABASE));
  try {
    const registry = loadIbkAccountConfig();
    const options = {
      sourcePool,
      targetPool,
      configuredAccounts: registry.publicAccounts,
    };
    const result = apply
      ? await applyCanonicalBankMerge({
        ...options,
        applyMigration: true,
        expectedSourceCounts: EXPECTED_CUTOVER_SOURCE_COUNTS,
      })
      : await preflightCanonicalBankMerge(options);
    process.stdout.write(`${JSON.stringify({ ...result, mode: apply ? 'apply' : 'preflight' })}\n`);
  } catch (error) {
    const errorCode = error instanceof BankCanonicalMergeError
      ? error.code
      : 'BANK_MERGE_FAILED';
    process.stdout.write(`${JSON.stringify({ ok: false, errorCode, mode: apply ? 'apply' : 'preflight' })}\n`);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([sourcePool.end(), targetPool.end()]);
  }
}

if (require.main === module) void main();

module.exports = {
  ACCOUNT_IDS,
  BankCanonicalMergeError,
  EXPECTED_CUTOVER_SOURCE_COUNTS,
  PEAK_WORKSPACE_ID,
  SOURCE_DATABASE,
  TARGET_DATABASE,
  applyCanonicalBankMerge,
  buildPlan,
  preflightCanonicalBankMerge,
  validateSourceSnapshot,
};
