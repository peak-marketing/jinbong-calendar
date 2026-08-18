'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  MIGRATION_PATH,
  REQUIRED_COLUMNS,
  REQUIRED_CONSTRAINTS,
  REQUIRED_CONSTRAINT_HASHES,
  REQUIRED_FUNCTIONS,
  REQUIRED_INDEXES,
  REQUIRED_INDEX_HASHES,
  REQUIRED_TRIGGERS,
  REQUIRED_TRIGGER_HASHES,
  ensureSettlementCompletionInfrastructure,
} = require('./peakos-settlement-completion-infrastructure');

const MIGRATION = fs.readFileSync(MIGRATION_PATH, 'utf8');

test('migration is additive and leaves every existing settlement without inferred evidence or lifecycle', () => {
  assert.match(MIGRATION, /UPDATE peakos_monthly SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL/);
  assert.doesNotMatch(MIGRATION, /INSERT\s+INTO\s+peakos_settlement_completion_cases\s+SELECT/i);
  assert.doesNotMatch(MIGRATION, /UPDATE\s+peakos_settlement_completion_cases\s+SET\s+status/i);
  assert.doesNotMatch(MIGRATION, /ALTER\s+TABLE\s+peakos_monthly\s+ADD\s+COLUMN/i);
});

test('cross-workspace source tampering is blocked by a real composite FK and a trigger assertion', () => {
  assert.match(MIGRATION, /UNIQUE\s*\(workspace_id,\s*id\)/i);
  assert.match(
    MIGRATION,
    /FOREIGN KEY \(workspace_id, source_monthly_id\)[\s\S]*REFERENCES peakos_monthly\(workspace_id, id\)/,
  );
  assert.match(MIGRATION, /source_workspace IS DISTINCT FROM NEW\.workspace_id/);
  assert.deepEqual(REQUIRED_CONSTRAINTS.peakos_monthly_workspace_source_unique, ['peakos_monthly', 'u']);
  assert.deepEqual(REQUIRED_CONSTRAINTS.peakos_settlement_completion_cases_source_fk, [
    'peakos_settlement_completion_cases', 'f',
  ]);
});

test('database lifecycle guard independently enforces all four approved completion rules in KST', () => {
  assert.match(MIGRATION, /WHEN 'DIRECT_EXECUTION_8TH'[\s\S]*completed_issues >= 8/);
  assert.match(MIGRATION, /WHEN 'MONTHLY_GUARANTEE_25D'[\s\S]*INTERVAL '25 days'/);
  assert.match(MIGRATION, /WHEN 'PER_ITEM_24H'[\s\S]*INTERVAL '24 hours'/);
  assert.match(MIGRATION, /WHEN 'MONTHLY_MANAGEMENT_30D'[\s\S]*INTERVAL '30 days'/);
  assert.match(MIGRATION, /AT TIME ZONE 'Asia\/Seoul'/);
  assert.match(MIGRATION, /peakos_settlement_completion_cases_not_eligible/);
});

test('completed/frozen source rows and audit history are protected by database triggers', () => {
  assert.match(MIGRATION, /linked_case\.status IN \('COMPLETED', 'FROZEN'\)/);
  assert.match(MIGRATION, /peakos_monthly_settlement_completion_lock/);
  assert.match(MIGRATION, /peakos_settlement_completion_audit_no_mutation/);
  assert.match(MIGRATION, /peakos_settlement_completion_audit_no_truncate/);
  assert.match(MIGRATION, /SECURITY DEFINER[\s\S]*peakos_settlement_completion_audit/);
});

test('runtime ACL allows lifecycle writes only on cases and makes audit append-only through its trigger', () => {
  assert.match(MIGRATION, /GRANT SELECT, INSERT, UPDATE ON TABLE peakos_settlement_completion_cases/);
  assert.match(MIGRATION, /GRANT SELECT ON TABLE peakos_settlement_completion_audit/);
  assert.doesNotMatch(MIGRATION, /GRANT[^;]*(?:DELETE|TRUNCATE|TRIGGER|REFERENCES)/i);
  assert.match(MIGRATION, /REVOKE ALL PRIVILEGES ON SEQUENCE peakos_settlement_completion_audit_id_seq/);
  assert.match(MIGRATION, /REVOKE ALL PRIVILEGES ON FUNCTION/);
});

function readyPool({ omitConstraint = null, unsafeAcl = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (sql.includes('WITH required(table_name,column_name,data_type,is_not_null)')) return { rows: [] };
      if (sql.includes('FROM pg_constraint')) {
        return { rows: Object.entries(REQUIRED_CONSTRAINTS)
          .filter(([name]) => name !== omitConstraint)
          .map(([conname, [table_name, contype]]) => ({
            conname, table_name, contype, convalidated: true,
            definition_hash: REQUIRED_CONSTRAINT_HASHES[conname],
          })) };
      }
      if (sql.includes('FROM pg_index')) {
        return { rows: Object.entries(REQUIRED_INDEXES).map(([index_name, table_name]) => ({
          index_name, table_name, indisvalid: true, indisready: true, indislive: true,
          indisprimary: false, indisexclusion: false, definition_hash: REQUIRED_INDEX_HASHES[index_name],
        })) };
      }
      if (sql.includes('FROM pg_trigger')) {
        return { rows: Object.entries(REQUIRED_TRIGGERS).map(([tgname, table_name]) => ({
          tgname, table_name, tgenabled: 'O', tgisinternal: false, tgdeferrable: false,
          tginitdeferred: false, tgconstraint: 0, tgnargs: 0,
          definition_hash: REQUIRED_TRIGGER_HASHES[tgname],
        })) };
      }
      if (sql.includes('FROM pg_proc')) {
        return { rows: Object.entries(REQUIRED_FUNCTIONS).map(([proname, expected]) => ({
          proname, pronargs: expected.args, prosecdef: expected.securityDefiner,
          provolatile: expected.volatility, prokind: 'f',
          returns_trigger: proname !== 'peakos_settlement_completion_case_is_eligible',
          lanname: expected.language, runtime_owned: false, runtime_execute: false, public_execute: false,
          source_hash: expected.sourceHash,
        })) };
      }
      if (sql.includes('CROSS JOIN unnest')) {
        return { rows: [
          {
            table_name: 'peakos_settlement_completion_audit', rolsuper: false, rolbypassrls: false,
            can_select: true, can_insert: false, can_update: false, can_delete: false,
            can_truncate: false, can_reference: false, can_trigger: false, public_privilege: false,
          },
          {
            table_name: 'peakos_settlement_completion_cases', rolsuper: false, rolbypassrls: false,
            can_select: true, can_insert: true, can_update: !unsafeAcl, can_delete: false,
            can_truncate: false, can_reference: false, can_trigger: false, public_privilege: false,
          },
        ] };
      }
      if (sql.includes('has_sequence_privilege')) {
        return { rows: [{ can_usage: false, can_select: false, can_update: false, public_privilege: false }] };
      }
      throw new Error(`unexpected readiness SQL: ${sql}`);
    },
  };
}

test('readiness is SELECT-only and validates all exact schema/trigger/function/ACL groups', async () => {
  const pool = readyPool();
  const result = await ensureSettlementCompletionInfrastructure(pool);
  assert.equal(result.ready, true);
  assert.equal(pool.calls.length, 7);
  for (const sql of pool.calls) assert.match(sql.trim(), /^(?:SELECT|WITH)\b/);
  assert.equal(REQUIRED_COLUMNS.some(([table, column, , required]) => (
    table === 'peakos_monthly' && column === 'workspace_id' && required === true
  )), true);
});

test('readiness fails closed on a missing composite source constraint', async () => {
  await assert.rejects(
    ensureSettlementCompletionInfrastructure(readyPool({ omitConstraint: 'peakos_monthly_workspace_source_unique' })),
    error => error.code === 'PEAKOS_SETTLEMENT_COMPLETION_MIGRATION_REQUIRED'
      && /peakos_monthly_workspace_source_unique/.test(error.message),
  );
});

test('readiness fails closed when runtime case UPDATE is unavailable or ACL drifts', async () => {
  await assert.rejects(
    ensureSettlementCompletionInfrastructure(readyPool({ unsafeAcl: true })),
    error => error.code === 'PEAKOS_SETTLEMENT_COMPLETION_ACL_INVALID',
  );
});

test('server composition registers the scoped routes and checks completion readiness after source readiness', () => {
  const indexPath = require.resolve('../index.js');
  const source = fs.readFileSync(indexPath, 'utf8');
  assert.match(source, /require\('\.\/settlements\/peakos-settlement-completion-infrastructure'\)/);
  assert.match(source, /require\('\.\/settlements\/peakos-settlement-completion-routes'\)/);
  assert.match(source, /\^\\\/settlement-completion\(\?:\\\/\|\$\)/);
  const baseRoutes = source.indexOf('registerPeakosSettlementRoutes({');
  const completionRoutes = source.indexOf('registerPeakosSettlementCompletionRoutes({');
  assert.ok(baseRoutes >= 0 && completionRoutes > baseRoutes);
  assert.match(
    source.slice(completionRoutes, completionRoutes + 650),
    /canSeeAll: peakosCanSeeWorkspaceFinalExecution[\s\S]*getWorkspaceId: req => requestWorkspaceId\(req\)/,
  );
  const sourceReadiness = source.indexOf('await ensureSettlementImportInfrastructure(pool);');
  const completionReadiness = source.indexOf('await ensureSettlementCompletionInfrastructure(pool);');
  assert.ok(sourceReadiness >= 0 && completionReadiness > sourceReadiness);
});
