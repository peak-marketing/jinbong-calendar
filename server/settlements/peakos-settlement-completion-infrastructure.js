'use strict';

const path = require('node:path');

const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  'migrations',
  '20260818_peakos_settlement_completion.sql',
);

const REQUIRED_COLUMNS = Object.freeze([
  ['peakos_monthly', 'workspace_id', 'text', true],
  ['peakos_settlement_completion_cases', 'workspace_id', 'text', true],
  ['peakos_settlement_completion_cases', 'source_monthly_id', 'text', true],
  ['peakos_settlement_completion_cases', 'rule_code', 'text', true],
  ['peakos_settlement_completion_cases', 'status', 'text', true],
  ['peakos_settlement_completion_cases', 'row_version', 'bigint', true],
  ['peakos_settlement_completion_cases', 'exposure_started_at', 'timestamp with time zone', false],
  ['peakos_settlement_completion_cases', 'exposure_completed_at', 'timestamp with time zone', false],
  ['peakos_settlement_completion_cases', 'service_started_at', 'timestamp with time zone', false],
  ['peakos_settlement_completion_cases', 'service_completed_at', 'timestamp with time zone', false],
  ['peakos_settlement_completion_cases', 'completed_issue_count', 'integer', false],
  ['peakos_settlement_completion_cases', 'eighth_issue_completed_at', 'timestamp with time zone', false],
  ['peakos_settlement_completion_cases', 'evidence_updated_at', 'timestamp with time zone', true],
  ['peakos_settlement_completion_cases', 'evidence_updated_by_uid', 'text', true],
  ['peakos_settlement_completion_cases', 'evidence_updated_by_name', 'text', true],
  ['peakos_settlement_completion_cases', 'settlement_completed_at', 'timestamp with time zone', false],
  ['peakos_settlement_completion_cases', 'settlement_completed_by_uid', 'text', false],
  ['peakos_settlement_completion_cases', 'settlement_completed_by_name', 'text', false],
  ['peakos_settlement_completion_cases', 'settlement_completion_reason', 'text', false],
  ['peakos_settlement_completion_cases', 'frozen_at', 'timestamp with time zone', false],
  ['peakos_settlement_completion_cases', 'frozen_by_uid', 'text', false],
  ['peakos_settlement_completion_cases', 'frozen_by_name', 'text', false],
  ['peakos_settlement_completion_cases', 'freeze_reason', 'text', false],
  ['peakos_settlement_completion_cases', 'reopened_at', 'timestamp with time zone', false],
  ['peakos_settlement_completion_cases', 'reopened_by_uid', 'text', false],
  ['peakos_settlement_completion_cases', 'reopened_by_name', 'text', false],
  ['peakos_settlement_completion_cases', 'reopen_reason', 'text', false],
  ['peakos_settlement_completion_cases', 'last_action', 'text', true],
  ['peakos_settlement_completion_cases', 'last_action_reason', 'text', true],
  ['peakos_settlement_completion_cases', 'last_actor_uid', 'text', true],
  ['peakos_settlement_completion_cases', 'last_actor_name', 'text', true],
  ['peakos_settlement_completion_cases', 'last_action_at', 'timestamp with time zone', true],
  ['peakos_settlement_completion_cases', 'created_at', 'timestamp with time zone', true],
  ['peakos_settlement_completion_cases', 'updated_at', 'timestamp with time zone', true],
  ['peakos_settlement_completion_audit', 'id', 'bigint', true],
  ['peakos_settlement_completion_audit', 'workspace_id', 'text', true],
  ['peakos_settlement_completion_audit', 'source_monthly_id', 'text', true],
  ['peakos_settlement_completion_audit', 'action', 'text', true],
  ['peakos_settlement_completion_audit', 'row_version', 'bigint', true],
  ['peakos_settlement_completion_audit', 'actor_uid', 'text', true],
  ['peakos_settlement_completion_audit', 'actor_name', 'text', true],
  ['peakos_settlement_completion_audit', 'reason', 'text', true],
  ['peakos_settlement_completion_audit', 'before_state', 'jsonb', false],
  ['peakos_settlement_completion_audit', 'after_state', 'jsonb', true],
  ['peakos_settlement_completion_audit', 'created_at', 'timestamp with time zone', true],
]);

const REQUIRED_CONSTRAINTS = Object.freeze({
  peakos_monthly_workspace_source_unique: ['peakos_monthly', 'u'],
  peakos_settlement_completion_cases_pkey: ['peakos_settlement_completion_cases', 'p'],
  peakos_settlement_completion_cases_workspace_fk: ['peakos_settlement_completion_cases', 'f'],
  peakos_settlement_completion_cases_source_fk: ['peakos_settlement_completion_cases', 'f'],
  peakos_settlement_completion_cases_rule_check: ['peakos_settlement_completion_cases', 'c'],
  peakos_settlement_completion_cases_status_check: ['peakos_settlement_completion_cases', 'c'],
  peakos_settlement_completion_cases_version_check: ['peakos_settlement_completion_cases', 'c'],
  peakos_settlement_completion_cases_issue_count_check: ['peakos_settlement_completion_cases', 'c'],
  peakos_settlement_completion_cases_eighth_issue_check: ['peakos_settlement_completion_cases', 'c'],
  peakos_settlement_completion_cases_evidence_shape_check: ['peakos_settlement_completion_cases', 'c'],
  peakos_settlement_completion_cases_lifecycle_check: ['peakos_settlement_completion_cases', 'c'],
  peakos_settlement_completion_cases_actor_check: ['peakos_settlement_completion_cases', 'c'],
  peakos_settlement_completion_cases_reason_check: ['peakos_settlement_completion_cases', 'c'],
  peakos_settlement_completion_cases_action_check: ['peakos_settlement_completion_cases', 'c'],
  peakos_settlement_completion_cases_time_check: ['peakos_settlement_completion_cases', 'c'],
  peakos_settlement_completion_audit_pkey: ['peakos_settlement_completion_audit', 'p'],
  peakos_settlement_completion_audit_case_fk: ['peakos_settlement_completion_audit', 'f'],
  peakos_settlement_completion_audit_action_check: ['peakos_settlement_completion_audit', 'c'],
  peakos_settlement_completion_audit_version_check: ['peakos_settlement_completion_audit', 'c'],
  peakos_settlement_completion_audit_actor_check: ['peakos_settlement_completion_audit', 'c'],
  peakos_settlement_completion_audit_reason_check: ['peakos_settlement_completion_audit', 'c'],
});

const REQUIRED_CONSTRAINT_HASHES = Object.freeze({
  peakos_monthly_workspace_source_unique: '1edf6b2f182ce3abe4e8d8a2a0fc599d',
  peakos_settlement_completion_cases_pkey: '850fbbee6baeb601a3f9a51d933100b6',
  peakos_settlement_completion_cases_workspace_fk: 'b48703b9c5c79becf68dbf598be7f595',
  peakos_settlement_completion_cases_source_fk: '6936599e95aac94ce89a5be7439abaa9',
  peakos_settlement_completion_cases_rule_check: '832d7d12fc34e8814fd27f3bc09ca257',
  peakos_settlement_completion_cases_status_check: '4de9fe44367b61769a897a5605e6e892',
  peakos_settlement_completion_cases_version_check: 'c7bc351335dd72a3f13da8c8371e281f',
  peakos_settlement_completion_cases_issue_count_check: 'bd65ad9e9db64f0c1bd2d7608ebfc8d3',
  peakos_settlement_completion_cases_eighth_issue_check: '04f7a081688733c4a401160d9471d3b6',
  peakos_settlement_completion_cases_evidence_shape_check: '31bc4f518efb242b6a57f3bb41fbd23f',
  peakos_settlement_completion_cases_lifecycle_check: '442653b89a51189c5808129f64c4f884',
  peakos_settlement_completion_cases_actor_check: '867815e0e3576ef3cbf8c15d417e2915',
  peakos_settlement_completion_cases_reason_check: '25921a12417a0ac2b91f34765dd3e7f6',
  peakos_settlement_completion_cases_action_check: '2d6d2c4e976e0ea0643e27f4eb5c8ba8',
  peakos_settlement_completion_cases_time_check: 'ea4657eb10c33696b6cc16c48b2bf227',
  peakos_settlement_completion_audit_pkey: 'fc8063647bc030cd9b08337bbdb3d950',
  peakos_settlement_completion_audit_case_fk: 'ea65031a29f69df66b4cfe7e2df3bac1',
  peakos_settlement_completion_audit_action_check: '971125db50ba30e28157b13f5a70974c',
  peakos_settlement_completion_audit_version_check: 'c7bc351335dd72a3f13da8c8371e281f',
  peakos_settlement_completion_audit_actor_check: '22e8432e958d37a6617e63291e1e9212',
  peakos_settlement_completion_audit_reason_check: '66d822455270b121f57b8c48c439fa1d',
});

const REQUIRED_INDEXES = Object.freeze({
  peakos_settlement_completion_cases_status_idx: 'peakos_settlement_completion_cases',
  peakos_settlement_completion_audit_source_idx: 'peakos_settlement_completion_audit',
});

const REQUIRED_INDEX_HASHES = Object.freeze({
  peakos_settlement_completion_cases_status_idx: '2874239058eb1724e8b274da201ad4fc',
  peakos_settlement_completion_audit_source_idx: '2680ce743e1ff5fe560c15defeecbaca',
});

const REQUIRED_TRIGGERS = Object.freeze({
  peakos_settlement_completion_cases_source_guard: 'peakos_settlement_completion_cases',
  peakos_settlement_completion_cases_transition_guard: 'peakos_settlement_completion_cases',
  peakos_settlement_completion_cases_audit: 'peakos_settlement_completion_cases',
  peakos_settlement_completion_cases_no_delete: 'peakos_settlement_completion_cases',
  peakos_settlement_completion_cases_no_truncate: 'peakos_settlement_completion_cases',
  peakos_settlement_completion_audit_no_mutation: 'peakos_settlement_completion_audit',
  peakos_settlement_completion_audit_no_truncate: 'peakos_settlement_completion_audit',
  peakos_monthly_settlement_completion_guard: 'peakos_monthly',
});

const REQUIRED_TRIGGER_HASHES = Object.freeze({
  peakos_settlement_completion_cases_source_guard: 'd31e9d5f49c30667e411b8074d198a75',
  peakos_settlement_completion_cases_transition_guard: 'b66ccf4a95cc2486b1af785f1a202364',
  peakos_settlement_completion_cases_audit: 'c174f0852d985429b0efe268b633a812',
  peakos_settlement_completion_cases_no_delete: '1979471626a614c7e66f0857a62a9a10',
  peakos_settlement_completion_cases_no_truncate: '6bffce5e91f812b37ece55e4bbcdfcba',
  peakos_settlement_completion_audit_no_mutation: '69af453c165d33318c9f02f4e03bcc92',
  peakos_settlement_completion_audit_no_truncate: '08abcf4bce313b3f756f38e55b72f68b',
  peakos_monthly_settlement_completion_guard: '23e4deb6825f9c0767c2b6267fc28ea6',
});

const REQUIRED_FUNCTIONS = Object.freeze({
  peakos_settlement_completion_case_is_eligible: { args: 8, language: 'sql', securityDefiner: false, volatility: 'i', sourceHash: '3680c77d55be71d35592855a461ed9b2' },
  peakos_settlement_completion_assert_source: { args: 0, language: 'plpgsql', securityDefiner: false, volatility: 'v', sourceHash: '9b3b889d56ff725ed09a7376868d0c7d' },
  peakos_settlement_completion_case_guard: { args: 0, language: 'plpgsql', securityDefiner: true, volatility: 'v', sourceHash: 'acca67d1cf6e711bcaa9e8e96928f5b3' },
  peakos_settlement_completion_audit_case: { args: 0, language: 'plpgsql', securityDefiner: true, volatility: 'v', sourceHash: 'e079926bbb34e2f145c0a22f841bc18c' },
  peakos_settlement_completion_reject_mutation: { args: 0, language: 'plpgsql', securityDefiner: false, volatility: 'v', sourceHash: '92ded720b045854f9747b5231a2a315e' },
  peakos_settlement_completion_guard_source: { args: 0, language: 'plpgsql', securityDefiner: false, volatility: 'v', sourceHash: '84099a1895627ac8b2c46df4b786134e' },
});

function migrationRequired(detail) {
  const error = new Error(`정산 완료 운영 migration이 필요합니다: ${detail}`);
  error.code = 'PEAKOS_SETTLEMENT_COMPLETION_MIGRATION_REQUIRED';
  return error;
}

async function ensureSettlementCompletionInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');

  const values = [];
  const params = [];
  for (const [table, column, dataType, notNull] of REQUIRED_COLUMNS) {
    params.push(table, column, dataType, notNull);
    values.push(`($${params.length - 3}::text,$${params.length - 2}::text,$${params.length - 1}::text,$${params.length}::boolean)`);
  }
  const columns = await pool.query(
    `WITH required(table_name,column_name,data_type,is_not_null) AS (VALUES ${values.join(',')})
     SELECT required.table_name, required.column_name
       FROM required
       LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
       LEFT JOIN pg_class relation
         ON relation.relnamespace = namespace.oid
        AND relation.relname = required.table_name
        AND relation.relkind IN ('r','p')
       LEFT JOIN pg_attribute attribute
         ON attribute.attrelid = relation.oid
        AND attribute.attname = required.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      WHERE attribute.attnum IS NULL
         OR format_type(attribute.atttypid, attribute.atttypmod) <> required.data_type
         OR attribute.attnotnull <> required.is_not_null
      ORDER BY 1,2`,
    params,
  );
  if (columns.rows.length) {
    throw migrationRequired(columns.rows.slice(0, 8)
      .map(row => `${row.table_name}.${row.column_name}`).join(', '));
  }

  const constraintNames = Object.keys(REQUIRED_CONSTRAINTS);
  const constraints = await pool.query(
    `SELECT constraint_row.conname, constraint_row.contype, constraint_row.convalidated,
            relation.relname AS table_name,
            md5(regexp_replace(lower(pg_get_constraintdef(constraint_row.oid)), '[[:space:]]+', '', 'g'))
              AS definition_hash
       FROM pg_constraint constraint_row
       JOIN pg_class relation ON relation.oid = constraint_row.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND constraint_row.conname = ANY($1::text[])`,
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
            md5(regexp_replace(lower(pg_get_indexdef(index_row.indexrelid)), '[[:space:]]+', '', 'g'))
              AS definition_hash
       FROM pg_index index_row
       JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
       JOIN pg_class table_relation ON table_relation.oid = index_row.indrelid
       JOIN pg_namespace namespace ON namespace.oid = table_relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND index_relation.relname = ANY($1::text[])`,
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
            function_row.proname AS function_name,
            md5(regexp_replace(lower(pg_get_triggerdef(trigger_row.oid)), '[[:space:]]+', '', 'g'))
              AS definition_hash
       FROM pg_trigger trigger_row
       JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
      WHERE namespace.nspname = 'public'
        AND trigger_row.tgname = ANY($1::text[])`,
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
            function_row.provolatile, function_row.prokind,
            function_row.prorettype = 'trigger'::regtype AS returns_trigger,
            language.lanname, owner.rolname AS owner_name,
            owner.oid = runtime.oid AS runtime_owned,
            has_function_privilege(runtime.oid, function_row.oid, 'EXECUTE') AS runtime_execute,
            EXISTS (
              SELECT 1
                FROM aclexplode(COALESCE(function_row.proacl, acldefault('f', function_row.proowner))) acl
               WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
            ) AS public_execute,
            md5(regexp_replace(lower(function_row.prosrc), '[[:space:]]+', '', 'g')) AS source_hash
       FROM pg_proc function_row
       JOIN pg_namespace namespace ON namespace.oid = function_row.pronamespace
       JOIN pg_language language ON language.oid = function_row.prolang
       JOIN pg_roles owner ON owner.oid = function_row.proowner
       JOIN pg_roles runtime ON runtime.rolname = current_user
      WHERE namespace.nspname = 'public'
        AND function_row.proname = ANY($1::text[])`,
    [Object.keys(REQUIRED_FUNCTIONS)],
  );
  const functionMap = new Map(functions.rows.map(row => [row.proname, row]));
  const invalidFunctions = Object.entries(REQUIRED_FUNCTIONS).filter(([name, expected]) => {
    const row = functionMap.get(name);
    const isTrigger = name !== 'peakos_settlement_completion_case_is_eligible';
    return !row || Number(row.pronargs) !== expected.args || row.lanname !== expected.language
      || row.prosecdef !== expected.securityDefiner || row.provolatile !== expected.volatility
      || row.prokind !== 'f' || row.returns_trigger !== isTrigger
      || row.runtime_owned !== false || row.runtime_execute !== false || row.public_execute !== false
      || row.source_hash !== expected.sourceHash;
  }).map(([name]) => name);
  if (invalidFunctions.length) throw migrationRequired(`functions ${invalidFunctions.join(', ')}`);

  const acl = await pool.query(
    `SELECT runtime.rolsuper, runtime.rolbypassrls,
            required.table_name,
            has_table_privilege(runtime.oid, to_regclass('public.' || required.table_name), 'SELECT') AS can_select,
            has_table_privilege(runtime.oid, to_regclass('public.' || required.table_name), 'INSERT') AS can_insert,
            has_table_privilege(runtime.oid, to_regclass('public.' || required.table_name), 'UPDATE') AS can_update,
            has_table_privilege(runtime.oid, to_regclass('public.' || required.table_name), 'DELETE') AS can_delete,
            has_table_privilege(runtime.oid, to_regclass('public.' || required.table_name), 'TRUNCATE') AS can_truncate,
            has_table_privilege(runtime.oid, to_regclass('public.' || required.table_name), 'REFERENCES') AS can_reference,
            has_table_privilege(runtime.oid, to_regclass('public.' || required.table_name), 'TRIGGER') AS can_trigger,
            EXISTS (
              SELECT 1
                FROM pg_class public_relation
                CROSS JOIN LATERAL aclexplode(
                  COALESCE(public_relation.relacl, acldefault('r', public_relation.relowner))
                ) public_acl
               WHERE public_relation.oid = to_regclass('public.' || required.table_name)
                 AND public_acl.grantee = 0
            ) AS public_privilege
       FROM pg_roles runtime
       CROSS JOIN unnest($1::text[]) required(table_name)
      WHERE runtime.rolname = current_user
      ORDER BY required.table_name`,
    [['peakos_settlement_completion_cases', 'peakos_settlement_completion_audit']],
  );
  const aclInvalid = acl.rows.length !== 2 || acl.rows.some(row => {
    const caseTable = row.table_name === 'peakos_settlement_completion_cases';
    return row.rolsuper === true || row.rolbypassrls === true || row.can_select !== true
      || row.can_insert !== caseTable || row.can_update !== caseTable
      || row.can_delete !== false || row.can_truncate !== false
      || row.can_reference !== false || row.can_trigger !== false || row.public_privilege !== false;
  });
  if (aclInvalid) {
    const error = new Error('정산 완료 runtime ACL이 최소 권한 계약과 다릅니다.');
    error.code = 'PEAKOS_SETTLEMENT_COMPLETION_ACL_INVALID';
    throw error;
  }

  const sequenceAcl = await pool.query(
    `SELECT has_sequence_privilege(runtime.oid,
              to_regclass('public.peakos_settlement_completion_audit_id_seq'), 'USAGE') AS can_usage,
            has_sequence_privilege(runtime.oid,
              to_regclass('public.peakos_settlement_completion_audit_id_seq'), 'SELECT') AS can_select,
            has_sequence_privilege(runtime.oid,
              to_regclass('public.peakos_settlement_completion_audit_id_seq'), 'UPDATE') AS can_update,
            EXISTS (
              SELECT 1
                FROM pg_class public_sequence
                CROSS JOIN LATERAL aclexplode(
                  COALESCE(public_sequence.relacl, acldefault('S', public_sequence.relowner))
                ) public_acl
               WHERE public_sequence.oid = to_regclass('public.peakos_settlement_completion_audit_id_seq')
                 AND public_acl.grantee = 0
            ) AS public_privilege
       FROM pg_roles runtime WHERE runtime.rolname = current_user`,
  );
  const sequence = sequenceAcl.rows[0];
  if (!sequence || sequence.can_usage !== false || sequence.can_select !== false
      || sequence.can_update !== false || sequence.public_privilege !== false) {
    const error = new Error('정산 완료 audit sequence ACL이 최소 권한 계약과 다릅니다.');
    error.code = 'PEAKOS_SETTLEMENT_COMPLETION_ACL_INVALID';
    throw error;
  }
  return Object.freeze({ ready: true, migrationPath: MIGRATION_PATH });
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
  ensureSettlementCompletionInfrastructure,
};
