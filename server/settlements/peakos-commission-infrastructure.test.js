'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
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
  ensurePeakosCommissionInfrastructure,
} = require('./peakos-commission-infrastructure');

function validPool(overrides = {}) {
  let call = 0;
  return {
    async query() {
      call += 1;
      if (call === 1) return { rows: overrides.columns || [] };
      if (call === 2) return { rows: overrides.constraints || Object.entries(REQUIRED_CONSTRAINTS).map(([conname, [table_name, contype]]) => ({
        conname, table_name, contype, convalidated: true,
        definition_hash: REQUIRED_CONSTRAINT_HASHES[conname],
      })) };
      if (call === 3) return { rows: overrides.indexes || Object.entries(REQUIRED_INDEXES).map(([index_name, table_name]) => ({
        index_name, table_name, indisvalid: true, indisready: true, indislive: true,
        indisprimary: false, indisexclusion: false,
        definition_hash: REQUIRED_INDEX_HASHES[index_name],
      })) };
      if (call === 4) return { rows: overrides.triggers || Object.entries(REQUIRED_TRIGGERS).map(([tgname, table_name]) => ({
        tgname, table_name, tgenabled: 'O', tgisinternal: false, tgdeferrable: false,
        tginitdeferred: false, tgconstraint: 0, tgnargs: 0,
        definition_hash: REQUIRED_TRIGGER_HASHES[tgname],
      })) };
      if (call === 5) return { rows: overrides.functions || Object.entries(REQUIRED_FUNCTIONS).map(([proname, expected]) => ({
        proname, pronargs: expected.args, prosecdef: expected.securityDefiner,
        provolatile: expected.volatility, lanname: expected.language, source_hash: expected.sourceHash,
        runtime_can_execute: false, runtime_can_grant_execute: false, public_can_execute: false,
        runtime_owns_function: false,
      })) };
      if (call === 6) return { rows: overrides.acl || [] };
      throw new Error(`unexpected readiness query ${call}`);
    },
  };
}

test('migration은 default rate/backfill 없이 versioned rule과 immutable ledger를 만든다', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.peakos_commission_rule_versions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.peakos_commission_calculation_ledger/);
  assert.match(sql, /rate_basis_points BETWEEN 0 AND 10000/);
  assert.match(sql, /peakos_commission_rule_overlap_check/);
  assert.match(sql, /peakos_commission_append_only/);
  assert.match(sql, /peakos_commission_calculation_source_snapshot_check/);
  assert.match(sql, /peakos_commission_calculation_payout_evidence_check/);
  assert.match(sql, /payout_eligible = FALSE/);
  assert.match(sql, /SETTLEMENT_COMPLETION_UNCONFIRMED/);
  assert.match(sql, /GRANT SELECT, INSERT ON TABLE public\.peakos_commission_rule_versions/);
  assert.doesNotMatch(sql, /DEFAULT\s+[^,\n]*rate_basis_points/i);
  assert.doesNotMatch(sql, /INSERT INTO public\.peakos_commission_calculation_ledger\s+SELECT/i);
  assert.doesNotMatch(sql, /GRANT[^;]*(?:UPDATE|DELETE|TRUNCATE)[^;]*peakos_commission/i);
  assert.equal(Object.keys(REQUIRED_CONSTRAINT_HASHES).length, Object.keys(REQUIRED_CONSTRAINTS).length);
});

test('exact readiness는 schema/constraint/index/trigger/function/ACL 전체를 검증한다', async () => {
  const ready = await ensurePeakosCommissionInfrastructure(validPool());
  assert.deepEqual(ready, {
    checkedColumns: REQUIRED_COLUMNS.length,
    checkedConstraints: Object.keys(REQUIRED_CONSTRAINTS).length,
    checkedIndexes: Object.keys(REQUIRED_INDEXES).length,
    checkedTriggers: Object.keys(REQUIRED_TRIGGERS).length,
    checkedFunctions: Object.keys(REQUIRED_FUNCTIONS).length,
  });
});

test('동일 이름 constraint/trigger/function 변조와 과도한 runtime ACL을 거부한다', async () => {
  const constraints = Object.entries(REQUIRED_CONSTRAINTS).map(([conname, [table_name, contype]]) => ({
    conname, table_name, contype, convalidated: true,
    definition_hash: REQUIRED_CONSTRAINT_HASHES[conname],
  }));
  constraints[0] = { ...constraints[0], definition_hash: '0'.repeat(32) };
  await assert.rejects(ensurePeakosCommissionInfrastructure(validPool({ constraints })), /constraints/);

  const triggers = Object.entries(REQUIRED_TRIGGERS).map(([tgname, table_name]) => ({
    tgname, table_name, tgenabled: 'O', tgisinternal: false, tgdeferrable: false,
    tginitdeferred: false, tgconstraint: 0, tgnargs: 0,
    definition_hash: REQUIRED_TRIGGER_HASHES[tgname],
  }));
  triggers[0] = { ...triggers[0], tgenabled: 'D' };
  await assert.rejects(ensurePeakosCommissionInfrastructure(validPool({ triggers })), /triggers/);

  const functions = Object.entries(REQUIRED_FUNCTIONS).map(([proname, expected]) => ({
    proname, pronargs: expected.args, prosecdef: expected.securityDefiner,
    provolatile: expected.volatility, lanname: expected.language, source_hash: expected.sourceHash,
    runtime_can_execute: false, runtime_can_grant_execute: false, public_can_execute: false,
    runtime_owns_function: false,
  }));
  functions[0] = { ...functions[0], runtime_can_execute: true };
  await assert.rejects(ensurePeakosCommissionInfrastructure(validPool({ functions })), /functions/);
  await assert.rejects(
    ensurePeakosCommissionInfrastructure(validPool({ acl: [{ table_name: 'peakos_commission_rule_versions' }] })),
    /runtime ACL/,
  );
});

test('server composition은 workspace gate 뒤 route를 등록하고 vendor readiness 뒤 수당 readiness를 확인한다', () => {
  const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
  assert.match(source, /require\('\.\/settlements\/peakos-commission-infrastructure'\)/);
  assert.match(source, /require\('\.\/settlements\/peakos-commission-routes'\)/);
  assert.match(source, /\^\\\/commission-\(\?:rules\|estimates\|calculations\)/);
  const globalGate = source.indexOf("app.use(\n  '/api/peakos',");
  const vendorRoutes = source.indexOf('registerPeakosVendorReconciliationRoutes({');
  const commissionRoutes = source.indexOf('registerPeakosCommissionRoutes({');
  assert.ok(globalGate >= 0 && vendorRoutes > globalGate && commissionRoutes > vendorRoutes);
  assert.match(
    source.slice(commissionRoutes, commissionRoutes + 400),
    /getName: peakosName[\s\S]*getWorkspaceId: req => requestWorkspaceId\(req\)/,
  );
  const vendorReadiness = source.indexOf('await ensurePeakosVendorReconciliationInfrastructure(pool);');
  const commissionReadiness = source.indexOf('await ensurePeakosCommissionInfrastructure(pool);');
  assert.ok(vendorReadiness >= 0 && commissionReadiness > vendorReadiness);
});
