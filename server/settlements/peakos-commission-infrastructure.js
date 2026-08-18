'use strict';

const path = require('node:path');

const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '20260818_peakos_commission_rules.sql');

const REQUIRED_COLUMNS = Object.freeze([
  ['peakos_commission_rule_versions', 'workspace_id', 'text', true],
  ['peakos_commission_rule_versions', 'id', 'uuid', true],
  ['peakos_commission_rule_versions', 'rule_series_id', 'uuid', true],
  ['peakos_commission_rule_versions', 'version', 'integer', true],
  ['peakos_commission_rule_versions', 'supersedes_id', 'uuid', false],
  ['peakos_commission_rule_versions', 'status', 'text', true],
  ['peakos_commission_rule_versions', 'scope_owner_uid', 'text', false],
  ['peakos_commission_rule_versions', 'scope_platform', 'text', false],
  ['peakos_commission_rule_versions', 'scope_product_a', 'text', false],
  ['peakos_commission_rule_versions', 'scope_product_b', 'text', false],
  ['peakos_commission_rule_versions', 'scope_product_c', 'text', false],
  ['peakos_commission_rule_versions', 'rate_basis_points', 'integer', true],
  ['peakos_commission_rule_versions', 'effective_from', 'date', true],
  ['peakos_commission_rule_versions', 'effective_to', 'date', false],
  ['peakos_commission_rule_versions', 'reason', 'text', true],
  ['peakos_commission_rule_versions', 'actor_uid', 'text', true],
  ['peakos_commission_rule_versions', 'actor_name', 'text', true],
  ['peakos_commission_rule_versions', 'created_at', 'timestamp with time zone', true],
  ['peakos_commission_calculation_ledger', 'workspace_id', 'text', true],
  ['peakos_commission_calculation_ledger', 'id', 'uuid', true],
  ['peakos_commission_calculation_ledger', 'input_fingerprint', 'text', true],
  ['peakos_commission_calculation_ledger', 'source_intake_id', 'text', true],
  ['peakos_commission_calculation_ledger', 'source_owner_uid', 'text', true],
  ['peakos_commission_calculation_ledger', 'source_owner_name', 'text', true],
  ['peakos_commission_calculation_ledger', 'source_business_date', 'date', true],
  ['peakos_commission_calculation_ledger', 'source_row_version', 'bigint', true],
  ['peakos_commission_calculation_ledger', 'source_snapshot_sha256', 'text', true],
  ['peakos_commission_calculation_ledger', 'source_kind', 'text', true],
  ['peakos_commission_calculation_ledger', 'source_platform', 'text', false],
  ['peakos_commission_calculation_ledger', 'source_product_a', 'text', true],
  ['peakos_commission_calculation_ledger', 'source_product_b', 'text', true],
  ['peakos_commission_calculation_ledger', 'source_product_c', 'text', true],
  ['peakos_commission_calculation_ledger', 'source_qty', 'numeric', false],
  ['peakos_commission_calculation_ledger', 'source_sell_per_unit', 'numeric', false],
  ['peakos_commission_calculation_ledger', 'source_salesperson_unit', 'numeric', false],
  ['peakos_commission_calculation_ledger', 'sales_amount', 'numeric(20,0)', false],
  ['peakos_commission_calculation_ledger', 'salesperson_supply_amount', 'numeric(20,0)', false],
  ['peakos_commission_calculation_ledger', 'commission_base_amount', 'numeric(20,0)', false],
  ['peakos_commission_calculation_ledger', 'rule_version_id', 'uuid', false],
  ['peakos_commission_calculation_ledger', 'rule_series_id', 'uuid', false],
  ['peakos_commission_calculation_ledger', 'rule_version', 'integer', false],
  ['peakos_commission_calculation_ledger', 'rate_basis_points', 'integer', false],
  ['peakos_commission_calculation_ledger', 'calculation_status', 'text', true],
  ['peakos_commission_calculation_ledger', 'estimated_commission_amount', 'numeric(20,0)', false],
  ['peakos_commission_calculation_ledger', 'payout_eligible', 'boolean', true],
  ['peakos_commission_calculation_ledger', 'payout_blockers', 'jsonb', true],
  ['peakos_commission_calculation_ledger', 'vendor_batch_id', 'uuid', false],
  ['peakos_commission_calculation_ledger', 'vendor_source_settled_row_version', 'bigint', false],
  ['peakos_commission_calculation_ledger', 'source_snapshot', 'jsonb', true],
  ['peakos_commission_calculation_ledger', 'rule_snapshot', 'jsonb', false],
  ['peakos_commission_calculation_ledger', 'calculated_by_uid', 'text', true],
  ['peakos_commission_calculation_ledger', 'calculated_by_name', 'text', true],
  ['peakos_commission_calculation_ledger', 'calculated_at', 'timestamp with time zone', true],
]);

const REQUIRED_CONSTRAINTS = Object.freeze({
  peakos_commission_rule_versions_pkey: ['peakos_commission_rule_versions', 'p'],
  peakos_commission_rule_versions_series_version_unique: ['peakos_commission_rule_versions', 'u'],
  peakos_commission_rule_versions_workspace_fk: ['peakos_commission_rule_versions', 'f'],
  peakos_commission_rule_versions_owner_membership_fk: ['peakos_commission_rule_versions', 'f'],
  peakos_commission_rule_versions_supersedes_fk: ['peakos_commission_rule_versions', 'f'],
  peakos_commission_rule_versions_status_check: ['peakos_commission_rule_versions', 'c'],
  peakos_commission_rule_versions_version_check: ['peakos_commission_rule_versions', 'c'],
  peakos_commission_rule_versions_transition_shape_check: ['peakos_commission_rule_versions', 'c'],
  peakos_commission_rule_versions_rate_check: ['peakos_commission_rule_versions', 'c'],
  peakos_commission_rule_versions_effective_check: ['peakos_commission_rule_versions', 'c'],
  peakos_commission_rule_versions_scope_check: ['peakos_commission_rule_versions', 'c'],
  peakos_commission_rule_versions_text_check: ['peakos_commission_rule_versions', 'c'],
  peakos_commission_calculation_ledger_pkey: ['peakos_commission_calculation_ledger', 'p'],
  peakos_commission_calculation_ledger_input_unique: ['peakos_commission_calculation_ledger', 'u'],
  peakos_commission_calculation_ledger_workspace_fk: ['peakos_commission_calculation_ledger', 'f'],
  peakos_commission_calculation_ledger_owner_membership_fk: ['peakos_commission_calculation_ledger', 'f'],
  peakos_commission_calculation_ledger_rule_fk: ['peakos_commission_calculation_ledger', 'f'],
  peakos_commission_calculation_ledger_vendor_batch_fk: ['peakos_commission_calculation_ledger', 'f'],
  peakos_commission_calculation_ledger_hash_check: ['peakos_commission_calculation_ledger', 'c'],
  peakos_commission_calculation_ledger_source_check: ['peakos_commission_calculation_ledger', 'c'],
  peakos_commission_calculation_ledger_status_check: ['peakos_commission_calculation_ledger', 'c'],
  peakos_commission_calculation_ledger_blockers_check: ['peakos_commission_calculation_ledger', 'c'],
  peakos_commission_calculation_ledger_math_check: ['peakos_commission_calculation_ledger', 'c'],
  peakos_commission_calculation_ledger_payout_check: ['peakos_commission_calculation_ledger', 'c'],
  peakos_commission_calculation_ledger_vendor_shape_check: ['peakos_commission_calculation_ledger', 'c'],
  peakos_commission_calculation_ledger_actor_check: ['peakos_commission_calculation_ledger', 'c'],
});

const REQUIRED_CONSTRAINT_HASHES = Object.freeze({
  peakos_commission_rule_versions_pkey: 'be9bbd4b120e79f06678520e7e95fca3',
  peakos_commission_rule_versions_series_version_unique: '67189083690066fa7fc4877b6ca8d893',
  peakos_commission_rule_versions_workspace_fk: 'b48703b9c5c79becf68dbf598be7f595',
  peakos_commission_rule_versions_owner_membership_fk: '6ab5a8fee707ef509ec4cf6d9e534ea5',
  peakos_commission_rule_versions_supersedes_fk: 'c2df3900857533ebe6e638de7bdea6c7',
  peakos_commission_rule_versions_status_check: '102076a2594728ae4013500b160e6c23',
  peakos_commission_rule_versions_version_check: '148261f5e80224bbf8ecee084cdeea9a',
  peakos_commission_rule_versions_transition_shape_check: 'de7957c50fa97963d9cb52b17f128df3',
  peakos_commission_rule_versions_rate_check: '72ec35e62f413194b990e7aa9d3822ad',
  peakos_commission_rule_versions_effective_check: '7b9d845803beb21593636b0ff4c265ba',
  peakos_commission_rule_versions_scope_check: '944bc64e83a33cfe8b0c35bbf9e44a0c',
  peakos_commission_rule_versions_text_check: '92d82eaabb07f21587aa1294b9beccc7',
  peakos_commission_calculation_ledger_pkey: 'be9bbd4b120e79f06678520e7e95fca3',
  peakos_commission_calculation_ledger_input_unique: '789d37d93cc6efcba67f34e906d35c8c',
  peakos_commission_calculation_ledger_workspace_fk: 'b48703b9c5c79becf68dbf598be7f595',
  peakos_commission_calculation_ledger_owner_membership_fk: '0220eb8eb777974e221c2c221513b6e4',
  peakos_commission_calculation_ledger_rule_fk: '7c6ad8f37065d1b247681e6cfdfc113f',
  peakos_commission_calculation_ledger_vendor_batch_fk: '67ac15c24fd9271ebcb22be27229eae8',
  peakos_commission_calculation_ledger_hash_check: 'eecdee3585f7a9b7178a0c8e2fa3d5bc',
  peakos_commission_calculation_ledger_source_check: '69f82bdea71b2c7b16e35be1977d3afc',
  peakos_commission_calculation_ledger_status_check: 'dc6cedebbe159db55721798aa3df78df',
  peakos_commission_calculation_ledger_blockers_check: '8cf41ee22b799d75d3c13f1aabe0b968',
  peakos_commission_calculation_ledger_math_check: '0585648b652643c614c787181e24ed08',
  peakos_commission_calculation_ledger_payout_check: '8e4085c74caed58c04e2657465b6d4ae',
  peakos_commission_calculation_ledger_vendor_shape_check: 'b5f17bdbb10f5d2a8059c8903a3e4df4',
  peakos_commission_calculation_ledger_actor_check: '8acc4dc94aa5aa54e1661a182d49d705',
});

const REQUIRED_INDEXES = Object.freeze({
  peakos_commission_rule_versions_current_idx: 'peakos_commission_rule_versions',
  peakos_commission_rule_versions_effective_idx: 'peakos_commission_rule_versions',
  peakos_commission_calculation_owner_date_idx: 'peakos_commission_calculation_ledger',
  peakos_commission_calculation_source_idx: 'peakos_commission_calculation_ledger',
});

const REQUIRED_INDEX_HASHES = Object.freeze({
  peakos_commission_rule_versions_current_idx: '7c4e0bb2049de2be8be756610b899189',
  peakos_commission_rule_versions_effective_idx: 'ccffab396d3e71d8090314e68ba43e50',
  peakos_commission_calculation_owner_date_idx: 'e602aa40ac30c18c7236260b854c15da',
  peakos_commission_calculation_source_idx: '4230494a362439790ab9b5523b1f4678',
});

const REQUIRED_TRIGGERS = Object.freeze({
  peakos_commission_rule_versions_guard: 'peakos_commission_rule_versions',
  peakos_commission_rule_versions_no_mutation: 'peakos_commission_rule_versions',
  peakos_commission_rule_versions_no_truncate: 'peakos_commission_rule_versions',
  peakos_commission_calculation_ledger_guard: 'peakos_commission_calculation_ledger',
  peakos_commission_calculation_ledger_no_mutation: 'peakos_commission_calculation_ledger',
  peakos_commission_calculation_ledger_no_truncate: 'peakos_commission_calculation_ledger',
});

const REQUIRED_TRIGGER_HASHES = Object.freeze({
  peakos_commission_rule_versions_guard: 'b846ec562ee92184a7cf9d10bb80676b',
  peakos_commission_rule_versions_no_mutation: 'baa93a700bf7101c76e941b638378b17',
  peakos_commission_rule_versions_no_truncate: '2513365a9bd8e29ea31085d20e9db58b',
  peakos_commission_calculation_ledger_guard: 'fed30177e47f12a462f0b88a43f13ee6',
  peakos_commission_calculation_ledger_no_mutation: '277ae4791c861e2605824d63a03e9d2b',
  peakos_commission_calculation_ledger_no_truncate: '8177fee5f4e4cac02bfa884e055f0ed2',
});

const REQUIRED_FUNCTIONS = Object.freeze({
  peakos_commission_reject_mutation: { args: 0, language: 'plpgsql', securityDefiner: false, volatility: 'v', sourceHash: '931b6f23059e70fb20ffda2b1678502f' },
  peakos_commission_guard_rule_version: { args: 0, language: 'plpgsql', securityDefiner: true, volatility: 'v', sourceHash: '532fdc1660f02c093a591c0f97b49462' },
  peakos_commission_guard_calculation: { args: 0, language: 'plpgsql', securityDefiner: true, volatility: 'v', sourceHash: 'd71bbc6dccc93e846801200156574bd8' },
});

function migrationRequired(detail) {
  const error = new Error(`수당 규칙 운영 migration이 필요합니다: ${detail}`);
  error.code = 'PEAKOS_COMMISSION_MIGRATION_REQUIRED';
  return error;
}

async function ensurePeakosCommissionInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  if (Object.keys(REQUIRED_CONSTRAINT_HASHES).length !== Object.keys(REQUIRED_CONSTRAINTS).length
      || Object.keys(REQUIRED_INDEX_HASHES).length !== Object.keys(REQUIRED_INDEXES).length
      || Object.keys(REQUIRED_TRIGGER_HASHES).length !== Object.keys(REQUIRED_TRIGGERS).length
      || Object.values(REQUIRED_FUNCTIONS).some(value => !value.sourceHash)) {
    throw migrationRequired('readiness fingerprints are incomplete');
  }

  const params = [];
  const values = REQUIRED_COLUMNS.map(([table, column, type, notNull]) => {
    params.push(table, column, type, notNull);
    return `($${params.length - 3}::text,$${params.length - 2}::text,$${params.length - 1}::text,$${params.length}::boolean)`;
  });
  const columns = await pool.query(
    `WITH required(table_name,column_name,data_type,is_not_null) AS (VALUES ${values.join(',')})
     SELECT required.table_name, required.column_name
       FROM required
       LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
       LEFT JOIN pg_class relation
         ON relation.relnamespace = namespace.oid AND relation.relname = required.table_name
        AND relation.relkind IN ('r','p')
       LEFT JOIN pg_attribute attribute
         ON attribute.attrelid = relation.oid AND attribute.attname = required.column_name
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
      WHERE attribute.attnum IS NULL
         OR format_type(attribute.atttypid, attribute.atttypmod) <> required.data_type
         OR attribute.attnotnull <> required.is_not_null
      ORDER BY 1,2`,
    params,
  );
  if (columns.rows.length) throw migrationRequired(`columns ${columns.rows.slice(0, 8).map(row => `${row.table_name}.${row.column_name}`).join(', ')}`);

  const constraintNames = Object.keys(REQUIRED_CONSTRAINTS);
  const constraints = await pool.query(
    `SELECT constraint_row.conname, constraint_row.contype, constraint_row.convalidated,
            relation.relname AS table_name,
            md5(regexp_replace(lower(pg_get_constraintdef(constraint_row.oid)), '[[:space:]]+', '', 'g')) AS definition_hash
       FROM pg_constraint constraint_row
       JOIN pg_class relation ON relation.oid = constraint_row.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND constraint_row.conname = ANY($1::text[])`,
    [constraintNames],
  );
  const constraintMap = new Map(constraints.rows.map(row => [row.conname, row]));
  const invalidConstraints = constraintNames.filter(name => {
    const row = constraintMap.get(name);
    const [table, type] = REQUIRED_CONSTRAINTS[name];
    return !row || row.table_name !== table || row.contype !== type || row.convalidated !== true
      || row.definition_hash !== REQUIRED_CONSTRAINT_HASHES[name];
  });
  if (invalidConstraints.length) throw migrationRequired(`constraints ${invalidConstraints.slice(0, 8).join(', ')}`);

  const indexes = await pool.query(
    `SELECT index_relation.relname AS index_name, table_relation.relname AS table_name,
            index_row.indisvalid, index_row.indisready, index_row.indislive,
            index_row.indisprimary, index_row.indisexclusion,
            md5(regexp_replace(lower(pg_get_indexdef(index_row.indexrelid)), '[[:space:]]+', '', 'g')) AS definition_hash
       FROM pg_index index_row
       JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
       JOIN pg_class table_relation ON table_relation.oid = index_row.indrelid
       JOIN pg_namespace namespace ON namespace.oid = table_relation.relnamespace
      WHERE namespace.nspname = 'public' AND index_relation.relname = ANY($1::text[])`,
    [Object.keys(REQUIRED_INDEXES)],
  );
  const indexMap = new Map(indexes.rows.map(row => [row.index_name, row]));
  const invalidIndexes = Object.entries(REQUIRED_INDEXES).filter(([name, table]) => {
    const row = indexMap.get(name);
    return !row || row.table_name !== table || row.indisvalid !== true || row.indisready !== true
      || row.indislive !== true || row.indisprimary !== false || row.indisexclusion !== false
      || row.definition_hash !== REQUIRED_INDEX_HASHES[name];
  }).map(([name]) => name);
  if (invalidIndexes.length) throw migrationRequired(`indexes ${invalidIndexes.join(', ')}`);

  const triggers = await pool.query(
    `SELECT trigger_row.tgname, relation.relname AS table_name, trigger_row.tgenabled,
            trigger_row.tgisinternal, trigger_row.tgdeferrable, trigger_row.tginitdeferred,
            trigger_row.tgconstraint, trigger_row.tgnargs,
            md5(regexp_replace(lower(pg_get_triggerdef(trigger_row.oid)), '[[:space:]]+', '', 'g')) AS definition_hash
       FROM pg_trigger trigger_row
       JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND trigger_row.tgname = ANY($1::text[])`,
    [Object.keys(REQUIRED_TRIGGERS)],
  );
  const triggerMap = new Map(triggers.rows.map(row => [row.tgname, row]));
  const invalidTriggers = Object.entries(REQUIRED_TRIGGERS).filter(([name, table]) => {
    const row = triggerMap.get(name);
    return !row || row.table_name !== table || row.tgenabled !== 'O' || row.tgisinternal !== false
      || row.tgdeferrable !== false || row.tginitdeferred !== false
      || Number(row.tgconstraint) !== 0 || Number(row.tgnargs) !== 0
      || row.definition_hash !== REQUIRED_TRIGGER_HASHES[name];
  }).map(([name]) => name);
  if (invalidTriggers.length) throw migrationRequired(`triggers ${invalidTriggers.join(', ')}`);

  const functions = await pool.query(
    `SELECT function_row.proname, function_row.pronargs, function_row.prosecdef,
            function_row.provolatile, language.lanname,
            md5(regexp_replace(lower(function_row.prosrc), '[[:space:]]+', '', 'g')) AS source_hash,
            has_function_privilege(current_user,function_row.oid,'EXECUTE') AS runtime_can_execute,
            has_function_privilege(current_user,function_row.oid,'EXECUTE WITH GRANT OPTION') AS runtime_can_grant_execute,
            EXISTS (
              SELECT 1 FROM aclexplode(COALESCE(function_row.proacl,acldefault('f',function_row.proowner))) privilege
               WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
            ) AS public_can_execute,
            pg_get_userbyid(function_row.proowner) = current_user AS runtime_owns_function
       FROM pg_proc function_row
       JOIN pg_namespace namespace ON namespace.oid = function_row.pronamespace
       JOIN pg_language language ON language.oid = function_row.prolang
      WHERE namespace.nspname = 'public' AND function_row.proname = ANY($1::text[])`,
    [Object.keys(REQUIRED_FUNCTIONS)],
  );
  const functionMap = new Map(functions.rows.map(row => [row.proname, row]));
  const invalidFunctions = Object.entries(REQUIRED_FUNCTIONS).filter(([name, expected]) => {
    const row = functionMap.get(name);
    return !row || Number(row.pronargs) !== expected.args || row.lanname !== expected.language
      || row.prosecdef !== expected.securityDefiner || row.provolatile !== expected.volatility
      || row.source_hash !== expected.sourceHash || row.runtime_can_execute !== false
      || row.runtime_can_grant_execute !== false || row.public_can_execute !== false
      || row.runtime_owns_function !== false;
  }).map(([name]) => name);
  if (invalidFunctions.length) throw migrationRequired(`functions ${invalidFunctions.join(', ')}`);

  const acl = await pool.query(
    `WITH required(table_name) AS (VALUES
       ('peakos_commission_rule_versions'::text),
       ('peakos_commission_calculation_ledger'::text)
     )
     SELECT required.table_name
       FROM required
       JOIN pg_class relation ON relation.relname = required.table_name
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace AND namespace.nspname = 'public'
      WHERE pg_get_userbyid(relation.relowner) = current_user
         OR NOT has_table_privilege(current_user,relation.oid,'SELECT')
         OR NOT has_table_privilege(current_user,relation.oid,'INSERT')
         OR has_table_privilege(current_user,relation.oid,'SELECT WITH GRANT OPTION')
         OR has_table_privilege(current_user,relation.oid,'INSERT WITH GRANT OPTION')
         OR has_table_privilege(current_user,relation.oid,'UPDATE')
         OR has_table_privilege(current_user,relation.oid,'DELETE')
         OR has_table_privilege(current_user,relation.oid,'TRUNCATE')
         OR has_table_privilege(current_user,relation.oid,'REFERENCES')
         OR has_table_privilege(current_user,relation.oid,'TRIGGER')
         OR EXISTS (
           SELECT 1 FROM aclexplode(COALESCE(relation.relacl,acldefault('r',relation.relowner))) privilege
            WHERE privilege.grantee = 0
         )`,
  );
  if (acl.rows.length) throw migrationRequired(`runtime ACL ${acl.rows.map(row => row.table_name).join(', ')}`);

  return Object.freeze({
    checkedColumns: REQUIRED_COLUMNS.length,
    checkedConstraints: constraintNames.length,
    checkedIndexes: Object.keys(REQUIRED_INDEXES).length,
    checkedTriggers: Object.keys(REQUIRED_TRIGGERS).length,
    checkedFunctions: Object.keys(REQUIRED_FUNCTIONS).length,
  });
}

module.exports = {
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
};
