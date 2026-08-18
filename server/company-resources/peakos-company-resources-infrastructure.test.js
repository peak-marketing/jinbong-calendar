'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
  MIGRATION_PATH,
  REQUIRED_COLUMNS,
  REQUIRED_CONSTRAINTS,
  REQUIRED_DEFAULTS,
  REQUIRED_FUNCTIONS,
  REQUIRED_INDEXES,
  REQUIRED_TRIGGERS,
  TABLES,
  ensurePeakosCompanyResourceInfrastructure,
} = require('./peakos-company-resources-infrastructure');

function validPool(overrides = {}) {
  let call = 0;
  return {
    async query() {
      call += 1;
      if (call === 1) return { rows: overrides.relations || TABLES.map(table_name => ({
        table_name, relkind: 'r', relrowsecurity: false, relforcerowsecurity: false,
        runtime_owns_table: false,
      })) };
      if (call === 2) return { rows: overrides.columns || REQUIRED_COLUMNS.map(([table_name, column_name, data_type, is_not_null]) => ({
        table_name, column_name, data_type, is_not_null,
        column_default: REQUIRED_DEFAULTS[`${table_name}.${column_name}`] || null,
      })) };
      if (call === 3) return { rows: overrides.constraints || Object.entries(REQUIRED_CONSTRAINTS).map(([conname, [table_name, contype, definition_hash]]) => ({
        conname, table_name, contype, convalidated: true, definition_hash,
      })) };
      if (call === 4) return { rows: overrides.indexes || Object.entries(REQUIRED_INDEXES).map(([index_name, [table_name, definition_hash]]) => ({
        index_name, table_name, indisvalid: true, indisready: true, indislive: true,
        indisprimary: false, indisexclusion: false, definition_hash,
      })) };
      if (call === 5) return { rows: overrides.triggers || Object.entries(REQUIRED_TRIGGERS).map(([tgname, [table_name, function_name, definition_hash]]) => ({
        tgname, table_name, tgenabled: 'O', tgisinternal: false, tgdeferrable: false,
        tginitdeferred: false, function_name, definition_hash,
      })) };
      if (call === 6) return { rows: overrides.functions || Object.entries(REQUIRED_FUNCTIONS).map(([proname, [prosecdef, source_hash]]) => ({
        proname, pronargs: 0, prosecdef, provolatile: 'v', lanname: 'plpgsql',
        source_hash, runtime_can_execute: false, runtime_owns_function: false,
      })) };
      if (call === 7) return { rows: overrides.acl || [] };
      throw new Error(`unexpected readiness query ${call}`);
    },
  };
}

test('operator migration은 4개 자료 영역, revision, 자동 audit, 보호 ACL만 선언한다', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.peakos_equipment_usage_entries/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.peakos_development_cost_entries/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.peakos_protected_company_documents/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.peakos_company_resource_audit/);
  assert.match(sql, /DEVELOPMENT_COST_EVIDENCE/);
  assert.match(sql, /peakos_protected_company_documents_one_active_idx/);
  assert.match(sql, /active development cost evidence cannot be archived/);
  assert.match(sql, /runtime role % can forge company resource audit/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.peakos_equipment_usage_entries/);
  assert.doesNotMatch(sql, /GRANT[^;]*(?:DELETE|TRUNCATE|REFERENCES|TRIGGER)[^;]*peakos_(?:equipment|development|protected|company_resource)/i);
  assert.doesNotMatch(sql, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?public\.peakos_bank_/i);
});

test('공용 서버와 영업 운영 UI가 readiness·전용 route·4개 회사자료 탭을 연결한다', () => {
  const root = require('node:path').resolve(__dirname, '../..');
  const index = fs.readFileSync(require('node:path').join(root, 'server/index.js'), 'utf8');
  const html = fs.readFileSync(require('node:path').join(root, 'business-os-preview.html'), 'utf8');
  const browser = fs.readFileSync(require('node:path').join(root, 'business-os-preview.js'), 'utf8');
  assert.match(index, /registerPeakosCompanyResourceRoutes\(\{[\s\S]*?canSeeFinanceOperations:\s*peakosCanSeeFinanceOperations,[\s\S]*?canReviewFinance:\s*peakosCanReviewFinance,/);
  assert.match(index, /await ensurePeakosWorkspaceInfrastructure\(pool\);\s*await ensurePeakosCompanyResourceInfrastructure\(pool\);/);
  assert.match(index, /\^\\\/company-resources\(\?:\\\/\|\$\)\//);
  for (const view of ['company-equipment-usage', 'company-development-costs', 'company-bank-copies', 'company-materials']) {
    assert.match(html, new RegExp(`data-view="${view}"`));
    assert.match(browser, new RegExp(`id: '${view}'`));
  }
  assert.match(browser, /payload\?\.capabilities\?\.canWrite === true/);
  assert.match(browser, /previewPersona && COMPANY_RESOURCE_FOLDERS\.some/);
});

test('exact readiness는 전체 column/constraint/index/trigger/function/least-privilege ACL을 확인한다', async () => {
  const result = await ensurePeakosCompanyResourceInfrastructure(validPool());
  assert.deepEqual(result, {
    checkedColumns: REQUIRED_COLUMNS.length,
    checkedConstraints: Object.keys(REQUIRED_CONSTRAINTS).length,
    checkedIndexes: Object.keys(REQUIRED_INDEXES).length,
    checkedTriggers: Object.keys(REQUIRED_TRIGGERS).length,
    checkedFunctions: Object.keys(REQUIRED_FUNCTIONS).length,
  });
});

test('추가 column/trigger, constraint/function hash 변조, RLS/owner/ACL 오염을 fail closed한다', async () => {
  const columns = REQUIRED_COLUMNS.map(([table_name, column_name, data_type, is_not_null]) => ({
    table_name, column_name, data_type, is_not_null,
    column_default: REQUIRED_DEFAULTS[`${table_name}.${column_name}`] || null,
  }));
  columns.push({ table_name: TABLES[0], column_name: 'shadow', data_type: 'text', is_not_null: false });
  await assert.rejects(
    ensurePeakosCompanyResourceInfrastructure(validPool({ columns })),
    error => error.code === 'PEAKOS_COMPANY_RESOURCES_MIGRATION_REQUIRED',
  );

  const constraints = Object.entries(REQUIRED_CONSTRAINTS).map(([conname, [table_name, contype, definition_hash]]) => ({
    conname, table_name, contype, convalidated: true, definition_hash,
  }));
  constraints[0] = { ...constraints[0], definition_hash: '0'.repeat(32) };
  await assert.rejects(ensurePeakosCompanyResourceInfrastructure(validPool({ constraints })), /constraints/);

  const triggers = Object.entries(REQUIRED_TRIGGERS).map(([tgname, [table_name, function_name, definition_hash]]) => ({
    tgname, table_name, tgenabled: 'O', tgisinternal: false, tgdeferrable: false,
    tginitdeferred: false, function_name, definition_hash,
  }));
  triggers.push({ ...triggers[0], tgname: 'shadow_trigger' });
  await assert.rejects(ensurePeakosCompanyResourceInfrastructure(validPool({ triggers })), /triggers/);

  const functions = Object.entries(REQUIRED_FUNCTIONS).map(([proname, [prosecdef, source_hash]]) => ({
    proname, pronargs: 0, prosecdef, provolatile: 'v', lanname: 'plpgsql',
    source_hash, runtime_can_execute: false, runtime_owns_function: false,
  }));
  functions[0] = { ...functions[0], runtime_can_execute: true };
  await assert.rejects(ensurePeakosCompanyResourceInfrastructure(validPool({ functions })), /functions/);

  const relations = TABLES.map(table_name => ({
    table_name, relkind: 'r', relrowsecurity: false, relforcerowsecurity: false,
    runtime_owns_table: false,
  }));
  relations[0] = { ...relations[0], runtime_owns_table: true };
  await assert.rejects(ensurePeakosCompanyResourceInfrastructure(validPool({ relations })), /relations/);
  await assert.rejects(
    ensurePeakosCompanyResourceInfrastructure(validPool({ acl: [{ table_name: 'peakos_company_resource_audit' }] })),
    /runtime ACL/,
  );
});
