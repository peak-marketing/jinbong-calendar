'use strict';

const path = require('node:path');

const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  'migrations',
  '20260818_peakos_vendor_reconciliation.sql',
);

const REQUIRED_COLUMNS = Object.freeze([
  ['peakos_intake', 'workspace_id', 'text', true],
  ['peakos_intake', 'row_version', 'bigint', true],
  ['peakos_vendor_settlement_batches', 'id', 'uuid', true],
  ['peakos_vendor_settlement_batches', 'workspace_id', 'text', true],
  ['peakos_vendor_settlement_batches', 'idempotency_key', 'uuid', true],
  ['peakos_vendor_settlement_batches', 'request_digest', 'text', true],
  ['peakos_vendor_settlement_batches', 'supplier', 'text', true],
  ['peakos_vendor_settlement_batches', 'status', 'text', true],
  ['peakos_vendor_settlement_batches', 'row_version', 'bigint', true],
  ['peakos_vendor_settlement_batches', 'item_count', 'integer', true],
  ['peakos_vendor_settlement_batches', 'delivered_qty', 'numeric(20,0)', true],
  ['peakos_vendor_settlement_batches', 'settled_qty', 'numeric(20,0)', true],
  ['peakos_vendor_settlement_batches', 'total_due', 'numeric(20,0)', true],
  ['peakos_vendor_settlement_batches', 'bank_label', 'text', true],
  ['peakos_vendor_settlement_batches', 'paid_date', 'date', true],
  ['peakos_vendor_settlement_batches', 'memo', 'text', true],
  ['peakos_vendor_settlement_batches', 'completed_by_uid', 'text', true],
  ['peakos_vendor_settlement_batches', 'completed_by_name', 'text', true],
  ['peakos_vendor_settlement_batches', 'completed_at', 'timestamp with time zone', true],
  ['peakos_vendor_settlement_batches', 'created_at', 'timestamp with time zone', true],
  ['peakos_vendor_settlement_items', 'workspace_id', 'text', true],
  ['peakos_vendor_settlement_items', 'batch_id', 'uuid', true],
  ['peakos_vendor_settlement_items', 'source_intake_id', 'text', true],
  ['peakos_vendor_settlement_items', 'item_ordinal', 'integer', true],
  ['peakos_vendor_settlement_items', 'source_expected_row_version', 'bigint', true],
  ['peakos_vendor_settlement_items', 'source_settled_row_version', 'bigint', true],
  ['peakos_vendor_settlement_items', 'source_kind', 'text', true],
  ['peakos_vendor_settlement_items', 'resolved_supplier', 'text', true],
  ['peakos_vendor_settlement_items', 'semantic_qty', 'numeric(20,0)', true],
  ['peakos_vendor_settlement_items', 'cost_per_unit', 'numeric(20,0)', true],
  ['peakos_vendor_settlement_items', 'due_amount', 'numeric(20,0)', true],
  ['peakos_vendor_settlement_items', 'created_at', 'timestamp with time zone', true],
  ['peakos_vendor_settlement_audit', 'id', 'bigint', true],
  ['peakos_vendor_settlement_audit', 'workspace_id', 'text', true],
  ['peakos_vendor_settlement_audit', 'batch_id', 'uuid', true],
  ['peakos_vendor_settlement_audit', 'source_intake_id', 'text', false],
  ['peakos_vendor_settlement_audit', 'action', 'text', true],
  ['peakos_vendor_settlement_audit', 'actor_uid', 'text', true],
  ['peakos_vendor_settlement_audit', 'actor_name', 'text', true],
  ['peakos_vendor_settlement_audit', 'state', 'jsonb', true],
  ['peakos_vendor_settlement_audit', 'created_at', 'timestamp with time zone', true],
]);

const REQUIRED_CONSTRAINTS = Object.freeze({
  peakos_intake_workspace_source_unique: ['peakos_intake', 'u', '1edf6b2f182ce3abe4e8d8a2a0fc599d'],
  peakos_vendor_settlement_audit_action_check: ['peakos_vendor_settlement_audit', 'c', 'd6df3ac5969504b1c7ef5e8cf40540c0'],
  peakos_vendor_settlement_audit_actor_check: ['peakos_vendor_settlement_audit', 'c', '7631d5916d48acb735d32a97617c26a1'],
  peakos_vendor_settlement_audit_batch_fk: ['peakos_vendor_settlement_audit', 'f', '9108e67eff388a017b02f7df26a5fde4'],
  peakos_vendor_settlement_audit_pkey: ['peakos_vendor_settlement_audit', 'p', 'fc8063647bc030cd9b08337bbdb3d950'],
  peakos_vendor_settlement_audit_source_shape_check: ['peakos_vendor_settlement_audit', 'c', '916a4815cfc975e34e98ce6454b0160f'],
  peakos_vendor_settlement_batches_count_check: ['peakos_vendor_settlement_batches', 'c', '45a3cee69e60c4d908b30dbeb9a25ecb'],
  peakos_vendor_settlement_batches_digest_check: ['peakos_vendor_settlement_batches', 'c', '57856eedd682c8cd3e20d12dbdbd1f35'],
  peakos_vendor_settlement_batches_due_check: ['peakos_vendor_settlement_batches', 'c', '625933243d3c1e7f47f375d2912a4c2a'],
  peakos_vendor_settlement_batches_idempotency_unique: ['peakos_vendor_settlement_batches', 'u', 'bebb679e5e1cce195500118d475807f5'],
  peakos_vendor_settlement_batches_pkey: ['peakos_vendor_settlement_batches', 'p', 'fc8063647bc030cd9b08337bbdb3d950'],
  peakos_vendor_settlement_batches_quantity_check: ['peakos_vendor_settlement_batches', 'c', '4e9147b07f9a44f0fffdf6c233062c7e'],
  peakos_vendor_settlement_batches_status_check: ['peakos_vendor_settlement_batches', 'c', '4be6c78db16c8860198b56843af8c798'],
  peakos_vendor_settlement_batches_text_check: ['peakos_vendor_settlement_batches', 'c', '3ee0c786f4d748b1fc349cc57a74c1dc'],
  peakos_vendor_settlement_batches_time_check: ['peakos_vendor_settlement_batches', 'c', '0ef4e86ea59fa4ffe9016ea21be3a598'],
  peakos_vendor_settlement_batches_version_check: ['peakos_vendor_settlement_batches', 'c', '0aa0947ef8af32f220c7806cc4f86571'],
  peakos_vendor_settlement_batches_workspace_fk: ['peakos_vendor_settlement_batches', 'f', 'b48703b9c5c79becf68dbf598be7f595'],
  peakos_vendor_settlement_batches_workspace_id_unique: ['peakos_vendor_settlement_batches', 'u', '1edf6b2f182ce3abe4e8d8a2a0fc599d'],
  peakos_vendor_settlement_items_batch_fk: ['peakos_vendor_settlement_items', 'f', '9108e67eff388a017b02f7df26a5fde4'],
  peakos_vendor_settlement_items_math_check: ['peakos_vendor_settlement_items', 'c', 'a39e192419b5332ca1604128565e2278'],
  peakos_vendor_settlement_items_ordinal_check: ['peakos_vendor_settlement_items', 'c', 'e1416b94ac45c1d3379c0fa5adaab7ca'],
  peakos_vendor_settlement_items_ordinal_unique: ['peakos_vendor_settlement_items', 'u', '941cf9e669e41f0d4f1a5d6edcdc1d79'],
  peakos_vendor_settlement_items_pkey: ['peakos_vendor_settlement_items', 'p', '4e0abf26586680cb22c5e5711024636d'],
  peakos_vendor_settlement_items_source_fk: ['peakos_vendor_settlement_items', 'f', '16dd5ac1b09befb680091647b92f79cf'],
  peakos_vendor_settlement_items_source_kind_check: ['peakos_vendor_settlement_items', 'c', '383621e65eff2793ab7212bccec87e6b'],
  peakos_vendor_settlement_items_source_unique: ['peakos_vendor_settlement_items', 'u', '3dc4cfca1d2026f16b3c60a04f6ef950'],
  peakos_vendor_settlement_items_supplier_check: ['peakos_vendor_settlement_items', 'c', '514ccdd3af8575709d5f1659ec6146e7'],
  peakos_vendor_settlement_items_version_check: ['peakos_vendor_settlement_items', 'c', 'b746372712b0cdedff37c1d240f3d44d'],
});

const REQUIRED_INDEXES = Object.freeze({
  peakos_vendor_settlement_audit_batch_idx: ['peakos_vendor_settlement_audit', '4ab2ab9bf8c313105d90779b01658ba0'],
  peakos_vendor_settlement_batches_supplier_idx: ['peakos_vendor_settlement_batches', '5c8669b54d10bf1e3b7f822eaa0c6bfb'],
  peakos_vendor_settlement_batches_workspace_date_idx: ['peakos_vendor_settlement_batches', 'c7a1fb0b43b9074ed745cc01dcc087ac'],
  peakos_vendor_settlement_items_batch_idx: ['peakos_vendor_settlement_items', 'efa6442e70d5a0d20a055b14d5d8daa0'],
});

const REQUIRED_TRIGGERS = Object.freeze({
  peakos_intake_vendor_reconciliation_guard: ['peakos_intake', false, false, 'peakos_vendor_reconciliation_guard_intake', '428c6d44ab157287f360e0a0dbba1592'],
  peakos_vendor_settlement_audit_no_mutation: ['peakos_vendor_settlement_audit', false, false, 'peakos_vendor_reconciliation_reject_mutation', '4e615a50a9aa55dce2d4a16df07569a8'],
  peakos_vendor_settlement_audit_no_truncate: ['peakos_vendor_settlement_audit', false, false, 'peakos_vendor_reconciliation_reject_mutation', '45cf60609f0c9385133953bd8ab5bd53'],
  peakos_vendor_settlement_batches_audit: ['peakos_vendor_settlement_batches', false, false, 'peakos_vendor_reconciliation_audit_insert', '80d55a9f3f6554f0a8945708577825de'],
  peakos_vendor_settlement_batches_no_mutation: ['peakos_vendor_settlement_batches', false, false, 'peakos_vendor_reconciliation_reject_mutation', '04e19f3ba95f2afea5b0de0583dd4a86'],
  peakos_vendor_settlement_batches_no_truncate: ['peakos_vendor_settlement_batches', false, false, 'peakos_vendor_reconciliation_reject_mutation', '164b025c7d3d2e5164fb7344ef74d0b3'],
  peakos_vendor_settlement_batches_validate: ['peakos_vendor_settlement_batches', true, true, 'peakos_vendor_reconciliation_validate_batch', '8d8669e94279a4e1b2a1272edb366b30'],
  peakos_vendor_settlement_items_audit: ['peakos_vendor_settlement_items', false, false, 'peakos_vendor_reconciliation_audit_insert', 'b8080f14ebf940045915a577dafb1e86'],
  peakos_vendor_settlement_items_no_mutation: ['peakos_vendor_settlement_items', false, false, 'peakos_vendor_reconciliation_reject_mutation', 'e3578c93e76189c8b71d0e18d36c372b'],
  peakos_vendor_settlement_items_no_truncate: ['peakos_vendor_settlement_items', false, false, 'peakos_vendor_reconciliation_reject_mutation', '263aa48f531860d018f26b91112f84ed'],
  peakos_vendor_settlement_items_validate: ['peakos_vendor_settlement_items', true, true, 'peakos_vendor_reconciliation_validate_batch', '8ebf51fb39e1386f0b01fc45bdb5b15f'],
});

const REQUIRED_FUNCTIONS = Object.freeze({
  peakos_vendor_reconciliation_audit_insert: [true, '199455056d410fcd82746e78eabbb6a5'],
  peakos_vendor_reconciliation_guard_intake: [true, 'f3336b0af0adc42d68aae543052051ff'],
  peakos_vendor_reconciliation_reject_mutation: [false, '8df09c124b594b9e58b1615b5f8efef0'],
  peakos_vendor_reconciliation_validate_batch: [true, '3f8910ff4b1d6831ce061a2050d4fb78'],
});

function migrationRequired(detail) {
  const error = new Error(`공급사 대사 운영 migration이 필요합니다: ${detail}`);
  error.code = 'PEAKOS_VENDOR_RECONCILIATION_MIGRATION_REQUIRED';
  return error;
}

async function ensurePeakosVendorReconciliationInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');

  const columnParams = [];
  const columnValues = REQUIRED_COLUMNS.map(([table, column, type, notNull]) => {
    columnParams.push(table, column, type, notNull);
    return `($${columnParams.length - 3}::text,$${columnParams.length - 2}::text,$${columnParams.length - 1}::text,$${columnParams.length}::boolean)`;
  });
  const columns = await pool.query(
    `WITH required(table_name,column_name,data_type,is_not_null) AS (VALUES ${columnValues.join(',')})
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
         OR format_type(attribute.atttypid,attribute.atttypmod) <> required.data_type
         OR attribute.attnotnull <> required.is_not_null
      ORDER BY 1,2`,
    columnParams,
  );
  if (columns.rows.length) throw migrationRequired(`columns ${columns.rows.slice(0, 8).map(row => `${row.table_name}.${row.column_name}`).join(', ')}`);

  const constraintNames = Object.keys(REQUIRED_CONSTRAINTS);
  const constraints = await pool.query(
    `SELECT constraint_row.conname, relation.relname AS table_name,
            constraint_row.contype, constraint_row.convalidated,
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
    const [table, type, hash] = REQUIRED_CONSTRAINTS[name];
    return !row || row.table_name !== table || row.contype !== type
      || row.convalidated !== true || row.definition_hash !== hash;
  });
  if (invalidConstraints.length) throw migrationRequired(`constraints ${invalidConstraints.slice(0, 8).join(', ')}`);

  const indexes = await pool.query(
    `SELECT index_relation.relname AS index_name, table_relation.relname AS table_name,
            index_row.indisvalid,index_row.indisready,index_row.indislive,
            index_row.indisprimary,index_row.indisexclusion,
            md5(regexp_replace(lower(pg_get_indexdef(index_row.indexrelid)), '[[:space:]]+', '', 'g')) AS definition_hash
       FROM pg_index index_row
       JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
       JOIN pg_class table_relation ON table_relation.oid = index_row.indrelid
       JOIN pg_namespace namespace ON namespace.oid = table_relation.relnamespace
      WHERE namespace.nspname = 'public' AND index_relation.relname = ANY($1::text[])`,
    [Object.keys(REQUIRED_INDEXES)],
  );
  const indexMap = new Map(indexes.rows.map(row => [row.index_name, row]));
  const invalidIndexes = Object.entries(REQUIRED_INDEXES).filter(([name, [table, hash]]) => {
    const row = indexMap.get(name);
    return !row || row.table_name !== table || row.indisvalid !== true
      || row.indisready !== true || row.indislive !== true || row.indisprimary !== false
      || row.indisexclusion !== false || row.definition_hash !== hash;
  }).map(([name]) => name);
  if (invalidIndexes.length) throw migrationRequired(`indexes ${invalidIndexes.join(', ')}`);

  const triggers = await pool.query(
    `SELECT trigger_row.tgname, relation.relname AS table_name, trigger_row.tgenabled,
            trigger_row.tgisinternal,trigger_row.tgdeferrable,trigger_row.tginitdeferred,
            function_row.proname AS function_name,
            md5(regexp_replace(lower(pg_get_triggerdef(trigger_row.oid)), '[[:space:]]+', '', 'g')) AS definition_hash
       FROM pg_trigger trigger_row
       JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
      WHERE namespace.nspname = 'public' AND trigger_row.tgname = ANY($1::text[])`,
    [Object.keys(REQUIRED_TRIGGERS)],
  );
  const triggerMap = new Map(triggers.rows.map(row => [row.tgname, row]));
  const invalidTriggers = Object.entries(REQUIRED_TRIGGERS).filter(([name, expected]) => {
    const row = triggerMap.get(name);
    const [table, deferrable, initiallyDeferred, functionName, hash] = expected;
    return !row || row.table_name !== table || row.tgenabled !== 'O'
      || row.tgisinternal !== false || row.tgdeferrable !== deferrable
      || row.tginitdeferred !== initiallyDeferred || row.function_name !== functionName
      || row.definition_hash !== hash;
  }).map(([name]) => name);
  if (invalidTriggers.length) throw migrationRequired(`triggers ${invalidTriggers.slice(0, 8).join(', ')}`);

  const functions = await pool.query(
    `SELECT function_row.proname,function_row.pronargs,function_row.prosecdef,
            function_row.provolatile,language.lanname,
            md5(regexp_replace(lower(function_row.prosrc), '[[:space:]]+', '', 'g')) AS source_hash,
            has_function_privilege(current_user,function_row.oid,'EXECUTE') AS runtime_can_execute,
            pg_get_userbyid(function_row.proowner) = current_user AS runtime_owns_function
       FROM pg_proc function_row
       JOIN pg_namespace namespace ON namespace.oid = function_row.pronamespace
       JOIN pg_language language ON language.oid = function_row.prolang
      WHERE namespace.nspname = 'public' AND function_row.proname = ANY($1::text[])`,
    [Object.keys(REQUIRED_FUNCTIONS)],
  );
  const functionMap = new Map(functions.rows.map(row => [row.proname, row]));
  const invalidFunctions = Object.entries(REQUIRED_FUNCTIONS).filter(([name, [securityDefiner, hash]]) => {
    const row = functionMap.get(name);
    return !row || Number(row.pronargs) !== 0 || row.lanname !== 'plpgsql'
      || row.prosecdef !== securityDefiner || row.provolatile !== 'v'
      || row.source_hash !== hash || row.runtime_can_execute !== false
      || row.runtime_owns_function !== false;
  }).map(([name]) => name);
  if (invalidFunctions.length) throw migrationRequired(`functions ${invalidFunctions.join(', ')}`);

  const acl = await pool.query(
    `WITH required(table_name,can_select,can_insert) AS (VALUES
       ('peakos_vendor_settlement_batches'::text,TRUE,TRUE),
       ('peakos_vendor_settlement_items'::text,TRUE,TRUE),
       ('peakos_vendor_settlement_audit'::text,TRUE,FALSE)
     )
     SELECT required.table_name
       FROM required
       JOIN pg_class relation ON relation.relname = required.table_name
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace AND namespace.nspname = 'public'
      WHERE pg_get_userbyid(relation.relowner) = current_user
         OR has_table_privilege(current_user,relation.oid,'SELECT') <> required.can_select
         OR has_table_privilege(current_user,relation.oid,'INSERT') <> required.can_insert
         OR has_table_privilege(current_user,relation.oid,'UPDATE')
         OR has_table_privilege(current_user,relation.oid,'DELETE')
         OR has_table_privilege(current_user,relation.oid,'TRUNCATE')
         OR has_table_privilege(current_user,relation.oid,'REFERENCES')
         OR has_table_privilege(current_user,relation.oid,'TRIGGER')
     UNION ALL
     SELECT 'peakos_vendor_settlement_audit_id_seq'
      WHERE has_sequence_privilege(current_user,'public.peakos_vendor_settlement_audit_id_seq','USAGE')
         OR has_sequence_privilege(current_user,'public.peakos_vendor_settlement_audit_id_seq','SELECT')
         OR has_sequence_privilege(current_user,'public.peakos_vendor_settlement_audit_id_seq','UPDATE')`,
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
  REQUIRED_FUNCTIONS,
  REQUIRED_INDEXES,
  REQUIRED_TRIGGERS,
  ensurePeakosVendorReconciliationInfrastructure,
};
