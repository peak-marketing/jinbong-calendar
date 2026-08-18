'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
  MIGRATION_PATH,
  REQUIRED_COLUMNS,
  REQUIRED_CONSTRAINTS,
  REQUIRED_FUNCTIONS,
  REQUIRED_INDEXES,
  REQUIRED_TRIGGERS,
  ensurePeakosVendorReconciliationInfrastructure,
} = require('./peakos-vendor-reconciliation-infrastructure');

function validPool(overrides = {}) {
  let call = 0;
  return {
    async query() {
      call += 1;
      if (call === 1) return { rows: overrides.columns || [] };
      if (call === 2) return { rows: overrides.constraints || Object.entries(REQUIRED_CONSTRAINTS).map(([conname, [table_name, contype, definition_hash]]) => ({
        conname, table_name, contype, convalidated: true, definition_hash,
      })) };
      if (call === 3) return { rows: overrides.indexes || Object.entries(REQUIRED_INDEXES).map(([index_name, [table_name, definition_hash]]) => ({
        index_name, table_name, indisvalid: true, indisready: true, indislive: true,
        indisprimary: false, indisexclusion: false, definition_hash,
      })) };
      if (call === 4) return { rows: overrides.triggers || Object.entries(REQUIRED_TRIGGERS).map(([tgname, [table_name, tgdeferrable, tginitdeferred, function_name, definition_hash]]) => ({
        tgname, table_name, tgenabled: 'O', tgisinternal: false, tgdeferrable,
        tginitdeferred, function_name, definition_hash,
      })) };
      if (call === 5) return { rows: overrides.functions || Object.entries(REQUIRED_FUNCTIONS).map(([proname, [prosecdef, source_hash]]) => ({
        proname, pronargs: 0, prosecdef, provolatile: 'v', lanname: 'plpgsql',
        source_hash, runtime_can_execute: false, runtime_owns_function: false,
      })) };
      if (call === 6) return { rows: overrides.acl || [] };
      throw new Error(`unexpected readiness query ${call}`);
    },
  };
}

test('operator migration은 증거 ledger, deferred 합계 검증, 원장 lock, 최소 ACL을 선언한다', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.peakos_vendor_settlement_batches/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.peakos_vendor_settlement_items/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.peakos_vendor_settlement_audit/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /peakos_intake_vendor_batch_required/);
  assert.match(sql, /peakos_intake_vendor_reconciliation_lock/);
  assert.match(sql, /GRANT SELECT, INSERT ON TABLE public\.peakos_vendor_settlement_batches/);
  assert.doesNotMatch(sql, /GRANT[^;]*UPDATE[^;]*peakos_vendor_settlement_(?:batches|items|audit)/i);
  assert.match(sql, /runtime role % can forge vendor reconciliation audit/);
  assert.doesNotMatch(sql, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?public\.peakos_bank_/i);
});

test('exact readiness는 전체 schema/constraint/index/trigger/function/ACL을 통과시킨다', async () => {
  const result = await ensurePeakosVendorReconciliationInfrastructure(validPool());
  assert.deepEqual(result, {
    checkedColumns: REQUIRED_COLUMNS.length,
    checkedConstraints: Object.keys(REQUIRED_CONSTRAINTS).length,
    checkedIndexes: Object.keys(REQUIRED_INDEXES).length,
    checkedTriggers: Object.keys(REQUIRED_TRIGGERS).length,
    checkedFunctions: Object.keys(REQUIRED_FUNCTIONS).length,
  });
});

test('constraint definition, trigger 상태, 함수 hash 또는 runtime ACL 변조를 거부한다', async () => {
  const constraints = Object.entries(REQUIRED_CONSTRAINTS).map(([conname, [table_name, contype, definition_hash]]) => ({
    conname, table_name, contype, convalidated: true, definition_hash,
  }));
  constraints[0] = { ...constraints[0], definition_hash: '0'.repeat(32) };
  await assert.rejects(
    ensurePeakosVendorReconciliationInfrastructure(validPool({ constraints })),
    error => error.code === 'PEAKOS_VENDOR_RECONCILIATION_MIGRATION_REQUIRED',
  );

  const triggers = Object.entries(REQUIRED_TRIGGERS).map(([tgname, [table_name, tgdeferrable, tginitdeferred, function_name, definition_hash]]) => ({
    tgname, table_name, tgenabled: 'O', tgisinternal: false, tgdeferrable,
    tginitdeferred, function_name, definition_hash,
  }));
  triggers[0] = { ...triggers[0], tgenabled: 'D' };
  await assert.rejects(ensurePeakosVendorReconciliationInfrastructure(validPool({ triggers })), /triggers/);

  const functions = Object.entries(REQUIRED_FUNCTIONS).map(([proname, [prosecdef, source_hash]]) => ({
    proname, pronargs: 0, prosecdef, provolatile: 'v', lanname: 'plpgsql',
    source_hash, runtime_can_execute: false, runtime_owns_function: false,
  }));
  functions[0] = { ...functions[0], runtime_can_execute: true };
  await assert.rejects(ensurePeakosVendorReconciliationInfrastructure(validPool({ functions })), /functions/);

  await assert.rejects(
    ensurePeakosVendorReconciliationInfrastructure(validPool({ acl: [{ table_name: 'peakos_vendor_settlement_audit' }] })),
    /runtime ACL/,
  );
});

test('server composition은 전역 workspace gate 뒤에 대사 route를 등록하고 source readiness 뒤 exact readiness를 확인한다', () => {
  const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
  assert.match(source, /require\('\.\/settlements\/peakos-vendor-reconciliation-infrastructure'\)/);
  assert.match(source, /require\('\.\/settlements\/peakos-vendor-reconciliation-routes'\)/);
  assert.match(source, /\^\\\/vendor-reconciliations\(\?:\\\/\|\$\)/);
  const globalGate = source.indexOf("app.use(\n  '/api/peakos',");
  const baseRoutes = source.indexOf('registerPeakosSettlementRoutes({');
  const vendorRoutes = source.indexOf('registerPeakosVendorReconciliationRoutes({');
  assert.ok(globalGate >= 0 && baseRoutes > globalGate && vendorRoutes > baseRoutes);
  assert.match(
    source.slice(vendorRoutes, vendorRoutes + 500),
    /approvedActive: peakosApprovedActive[\s\S]*canReviewFinance: peakosCanReviewFinance[\s\S]*getWorkspaceId: req => requestWorkspaceId\(req\)/,
  );
  const sourceReadiness = source.indexOf('await ensureSettlementImportInfrastructure(pool);');
  const vendorReadiness = source.indexOf('await ensurePeakosVendorReconciliationInfrastructure(pool);');
  assert.ok(sourceReadiness >= 0 && vendorReadiness > sourceReadiness);
});
