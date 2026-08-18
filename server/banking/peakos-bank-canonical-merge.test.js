'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  ACCOUNT_IDS,
  BankCanonicalMergeError,
  PEAK_WORKSPACE_ID,
  buildPlan,
  validateSourceSnapshot,
} = require('./peakos-bank-canonical-merge');

const masks = new Map([
  ['ibk-hq-sales', '56-********-4017'],
  ['ibk-hq-supplier', '56-********-1042'],
  ['ibk-hq-fixed', '56-********-1035'],
  ['ibk-review-space', '07-********-4015'],
  ['ibk-reward-space', '07-********-4022'],
]);

function snapshot() {
  return {
    accounts: ACCOUNT_IDS.map(id => ({
      id,
      is_active: true,
      account_number_masked: masks.get(id),
    })),
    transactions: [{
      account_id: 'ibk-hq-sales',
      provider_transaction_key: 'safe-key-1',
      transaction_at: '2026-08-17T00:00:00.000Z',
      direction: 'DEPOSIT',
      amount: 1000,
    }],
    runs: [{ account_id: 'ibk-hq-sales', request_id: 'safe-request-1' }],
    allocations: [{
      source_id: 7,
      source_account_id: 'ibk-hq-sales',
      source_provider_transaction_key: 'safe-key-1',
    }],
    audits: [{ source_id: 11 }],
  };
}

const configuredAccounts = ACCOUNT_IDS.map(id => ({
  id,
  accountNumberMasked: masks.get(id),
}));

test('source validation requires exactly five active accounts bound to masked credentials', () => {
  const source = snapshot();
  assert.deepEqual(validateSourceSnapshot(source, configuredAccounts), {
    accounts: 5,
    transactions: 1,
    runs: 1,
    allocations: 1,
    audits: 1,
  });

  assert.throws(
    () => validateSourceSnapshot({ ...source, accounts: source.accounts.slice(1) }, configuredAccounts),
    error => error instanceof BankCanonicalMergeError
      && error.code === 'BANK_MERGE_SOURCE_ACCOUNTS_INVALID',
  );
  assert.throws(
    () => validateSourceSnapshot({
      ...source,
      accounts: source.accounts.map((row, index) => index ? row : { ...row, is_active: false }),
    }, configuredAccounts),
    error => error?.code === 'BANK_MERGE_SOURCE_ACCOUNT_INACTIVE',
  );
  assert.throws(
    () => validateSourceSnapshot(source, configuredAccounts.map((row, index) => (
      index ? row : { ...row, accountNumberMasked: '00-********-0000' }
    ))),
    error => error?.code === 'BANK_MERGE_CREDENTIAL_MAPPING_INVALID',
  );
});

test('merge plan is idempotent across account, transaction, run and legacy audit identities', () => {
  const source = snapshot();
  validateSourceSnapshot(source, configuredAccounts);
  const emptyPlan = buildPlan(source, {
    accounts: [], transactions: [], runs: [], allocationKeys: [], auditKeys: [],
  }, PEAK_WORKSPACE_ID);
  assert.deepEqual(emptyPlan.insert, {
    accounts: 5,
    transactions: 1,
    runs: 1,
    allocations: 1,
    audits: 1,
  });

  const completePlan = buildPlan(source, {
    accounts: source.accounts.map(row => ({
      id: row.id,
      workspace_id: PEAK_WORKSPACE_ID,
      account_number_masked: row.account_number_masked,
    })),
    transactions: source.transactions.map(row => ({ ...row, workspace_id: PEAK_WORKSPACE_ID })),
    runs: source.runs.map(row => ({ ...row, workspace_id: PEAK_WORKSPACE_ID })),
    allocationKeys: [{
      legacy_source_key: 'calendar_business_os:peakos_bank_allocations:7',
    }],
    auditKeys: [{
      legacy_source_key: 'calendar_business_os:peakos_bank_audit_log:11',
    }],
  }, PEAK_WORKSPACE_ID);
  assert.deepEqual(completePlan.insert, {
    accounts: 0,
    transactions: 0,
    runs: 0,
    allocations: 0,
    audits: 0,
  });
});

test('merge plan rejects cross-workspace and immutable transaction collisions', () => {
  const source = snapshot();
  assert.throws(
    () => buildPlan(source, {
      accounts: [{
        id: 'ibk-hq-sales',
        workspace_id: 'ws_daegu',
        account_number_masked: masks.get('ibk-hq-sales'),
      }],
      transactions: [], runs: [], allocationKeys: [], auditKeys: [],
    }, PEAK_WORKSPACE_ID),
    error => error?.code === 'BANK_MERGE_TARGET_ACCOUNT_CONFLICT',
  );
  assert.throws(
    () => buildPlan(source, {
      accounts: [],
      transactions: [{
        ...source.transactions[0],
        amount: 9999,
        workspace_id: PEAK_WORKSPACE_ID,
      }],
      runs: [], allocationKeys: [], auditKeys: [],
    }, PEAK_WORKSPACE_ID),
    error => error?.code === 'BANK_MERGE_TARGET_TRANSACTION_CONFLICT',
  );
});

test('workspace migration covers every bank root, idempotency key and composite FK', () => {
  const sql = fs.readFileSync(path.join(
    __dirname,
    '..',
    'migrations',
    '20260817_peakos_bank_workspace_merge.sql',
  ), 'utf8');
  for (const table of [
    'peakos_bank_accounts',
    'peakos_bank_transactions',
    'peakos_bank_sync_runs',
    'peakos_bank_allocations',
    'peakos_bank_audit_log',
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table}`));
  }
  assert.match(sql, /ALTER COLUMN workspace_id SET NOT NULL/);
  assert.match(sql, /peakos_bank_sync_runs_workspace_account_fk/);
  assert.match(sql, /peakos_bank_allocations_workspace_transaction_fk/);
  assert.match(sql, /peakos_bank_audit_legacy_source_unique/);
});
