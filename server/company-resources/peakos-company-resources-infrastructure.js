'use strict';

const path = require('node:path');

const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '20260818_peakos_company_resources.sql');
const TABLES = Object.freeze([
  'peakos_equipment_usage_entries',
  'peakos_development_cost_entries',
  'peakos_protected_company_documents',
  'peakos_company_resource_audit',
]);

const REQUIRED_COLUMNS = Object.freeze([
  ['peakos_equipment_usage_entries', 'workspace_id', 'text', true],
  ['peakos_equipment_usage_entries', 'id', 'uuid', true],
  ['peakos_equipment_usage_entries', 'used_on', 'date', true],
  ['peakos_equipment_usage_entries', 'item_name', 'text', true],
  ['peakos_equipment_usage_entries', 'purpose', 'text', true],
  ['peakos_equipment_usage_entries', 'quantity', 'integer', true],
  ['peakos_equipment_usage_entries', 'used_by_uid', 'text', true],
  ['peakos_equipment_usage_entries', 'used_by_name', 'text', true],
  ['peakos_equipment_usage_entries', 'memo', 'text', true],
  ['peakos_equipment_usage_entries', 'status', 'text', true],
  ['peakos_equipment_usage_entries', 'void_reason', 'text', true],
  ['peakos_equipment_usage_entries', 'row_version', 'bigint', true],
  ['peakos_equipment_usage_entries', 'recorded_by_uid', 'text', true],
  ['peakos_equipment_usage_entries', 'recorded_by_name', 'text', true],
  ['peakos_equipment_usage_entries', 'last_changed_by_uid', 'text', true],
  ['peakos_equipment_usage_entries', 'last_changed_by_name', 'text', true],
  ['peakos_equipment_usage_entries', 'created_at', 'timestamp with time zone', true],
  ['peakos_equipment_usage_entries', 'updated_at', 'timestamp with time zone', true],

  ['peakos_development_cost_entries', 'workspace_id', 'text', true],
  ['peakos_development_cost_entries', 'id', 'uuid', true],
  ['peakos_development_cost_entries', 'spent_on', 'date', true],
  ['peakos_development_cost_entries', 'title', 'text', true],
  ['peakos_development_cost_entries', 'vendor', 'text', true],
  ['peakos_development_cost_entries', 'amount_krw', 'numeric(20,0)', true],
  ['peakos_development_cost_entries', 'memo', 'text', true],
  ['peakos_development_cost_entries', 'evidence_document_id', 'uuid', true],
  ['peakos_development_cost_entries', 'status', 'text', true],
  ['peakos_development_cost_entries', 'void_reason', 'text', true],
  ['peakos_development_cost_entries', 'row_version', 'bigint', true],
  ['peakos_development_cost_entries', 'recorded_by_uid', 'text', true],
  ['peakos_development_cost_entries', 'recorded_by_name', 'text', true],
  ['peakos_development_cost_entries', 'last_changed_by_uid', 'text', true],
  ['peakos_development_cost_entries', 'last_changed_by_name', 'text', true],
  ['peakos_development_cost_entries', 'created_at', 'timestamp with time zone', true],
  ['peakos_development_cost_entries', 'updated_at', 'timestamp with time zone', true],

  ['peakos_protected_company_documents', 'workspace_id', 'text', true],
  ['peakos_protected_company_documents', 'id', 'uuid', true],
  ['peakos_protected_company_documents', 'logical_document_id', 'uuid', true],
  ['peakos_protected_company_documents', 'revision', 'integer', true],
  ['peakos_protected_company_documents', 'supersedes_document_id', 'uuid', false],
  ['peakos_protected_company_documents', 'category', 'text', true],
  ['peakos_protected_company_documents', 'title', 'text', true],
  ['peakos_protected_company_documents', 'original_filename', 'text', true],
  ['peakos_protected_company_documents', 'stored_key', 'text', true],
  ['peakos_protected_company_documents', 'mime_type', 'text', true],
  ['peakos_protected_company_documents', 'size_bytes', 'bigint', true],
  ['peakos_protected_company_documents', 'sha256', 'text', true],
  ['peakos_protected_company_documents', 'status', 'text', true],
  ['peakos_protected_company_documents', 'archive_reason', 'text', true],
  ['peakos_protected_company_documents', 'row_version', 'bigint', true],
  ['peakos_protected_company_documents', 'uploaded_by_uid', 'text', true],
  ['peakos_protected_company_documents', 'uploaded_by_name', 'text', true],
  ['peakos_protected_company_documents', 'last_changed_by_uid', 'text', true],
  ['peakos_protected_company_documents', 'last_changed_by_name', 'text', true],
  ['peakos_protected_company_documents', 'created_at', 'timestamp with time zone', true],
  ['peakos_protected_company_documents', 'updated_at', 'timestamp with time zone', true],

  ['peakos_company_resource_audit', 'id', 'bigint', true],
  ['peakos_company_resource_audit', 'workspace_id', 'text', true],
  ['peakos_company_resource_audit', 'entity_type', 'text', true],
  ['peakos_company_resource_audit', 'entity_id', 'uuid', true],
  ['peakos_company_resource_audit', 'action', 'text', true],
  ['peakos_company_resource_audit', 'row_version', 'bigint', true],
  ['peakos_company_resource_audit', 'actor_uid', 'text', true],
  ['peakos_company_resource_audit', 'actor_name', 'text', true],
  ['peakos_company_resource_audit', 'before_state', 'jsonb', false],
  ['peakos_company_resource_audit', 'after_state', 'jsonb', true],
  ['peakos_company_resource_audit', 'created_at', 'timestamp with time zone', true],
]);

const REQUIRED_DEFAULTS = Object.freeze({
  'peakos_company_resource_audit.id': "nextval('peakos_company_resource_audit_id_seq'::regclass)",
  'peakos_development_cost_entries.memo': "''::text",
  'peakos_development_cost_entries.row_version': '1',
  'peakos_development_cost_entries.status': "'ACTIVE'::text",
  'peakos_development_cost_entries.void_reason': "''::text",
  'peakos_equipment_usage_entries.memo': "''::text",
  'peakos_equipment_usage_entries.row_version': '1',
  'peakos_equipment_usage_entries.status': "'ACTIVE'::text",
  'peakos_equipment_usage_entries.void_reason': "''::text",
  'peakos_protected_company_documents.archive_reason': "''::text",
  'peakos_protected_company_documents.revision': '1',
  'peakos_protected_company_documents.row_version': '1',
  'peakos_protected_company_documents.status': "'ACTIVE'::text",
});

const REQUIRED_CONSTRAINTS = Object.freeze({
  peakos_company_resource_audit_action_check: ['peakos_company_resource_audit', 'c', '8d311b3c62f794ad3ea81935b9b4b701'],
  peakos_company_resource_audit_actor_check: ['peakos_company_resource_audit', 'c', 'd1e05c554aab8ef81f88671b42680378'],
  peakos_company_resource_audit_entity_check: ['peakos_company_resource_audit', 'c', 'bcf5c729678fe1556c506335e9239b2d'],
  peakos_company_resource_audit_pkey: ['peakos_company_resource_audit', 'p', 'fc8063647bc030cd9b08337bbdb3d950'],
  peakos_company_resource_audit_shape_check: ['peakos_company_resource_audit', 'c', 'e6feb5e7d8ad73c25b07495bd8230b1c'],
  peakos_company_resource_audit_workspace_fk: ['peakos_company_resource_audit', 'f', 'b48703b9c5c79becf68dbf598be7f595'],
  peakos_development_cost_entries_amount_check: ['peakos_development_cost_entries', 'c', '01ade9ac0ae6277210798a7f45371c63'],
  peakos_development_cost_entries_changer_fk: ['peakos_development_cost_entries', 'f', '89191a887fa28366653d1f4d46ae5775'],
  peakos_development_cost_entries_evidence_fk: ['peakos_development_cost_entries', 'f', '1081f25b64bb3c242903e93afdabc96b'],
  peakos_development_cost_entries_pkey: ['peakos_development_cost_entries', 'p', 'be9bbd4b120e79f06678520e7e95fca3'],
  peakos_development_cost_entries_recorder_fk: ['peakos_development_cost_entries', 'f', '68db7fb389b0c6dd6eee65f7af6e35ab'],
  peakos_development_cost_entries_status_check: ['peakos_development_cost_entries', 'c', '1842d2d4015d93a65731e5d3588de39b'],
  peakos_development_cost_entries_text_check: ['peakos_development_cost_entries', 'c', '52d511b6c3bd78ee6b778f9a24229929'],
  peakos_development_cost_entries_time_check: ['peakos_development_cost_entries', 'c', 'd6c5e562ae0bde8eaf5d05b6a4f11b18'],
  peakos_development_cost_entries_version_check: ['peakos_development_cost_entries', 'c', 'c7bc351335dd72a3f13da8c8371e281f'],
  peakos_development_cost_entries_void_check: ['peakos_development_cost_entries', 'c', '70bf5bab771f638a7914331e8571cad1'],
  peakos_development_cost_entries_workspace_fk: ['peakos_development_cost_entries', 'f', 'b48703b9c5c79becf68dbf598be7f595'],
  peakos_equipment_usage_entries_changer_fk: ['peakos_equipment_usage_entries', 'f', '89191a887fa28366653d1f4d46ae5775'],
  peakos_equipment_usage_entries_pkey: ['peakos_equipment_usage_entries', 'p', 'be9bbd4b120e79f06678520e7e95fca3'],
  peakos_equipment_usage_entries_quantity_check: ['peakos_equipment_usage_entries', 'c', '1dc42be250fc4c87620f11b43501b1b6'],
  peakos_equipment_usage_entries_recorder_fk: ['peakos_equipment_usage_entries', 'f', '68db7fb389b0c6dd6eee65f7af6e35ab'],
  peakos_equipment_usage_entries_status_check: ['peakos_equipment_usage_entries', 'c', '1842d2d4015d93a65731e5d3588de39b'],
  peakos_equipment_usage_entries_text_check: ['peakos_equipment_usage_entries', 'c', 'fe11afd2c5cf79c7270646013861392a'],
  peakos_equipment_usage_entries_time_check: ['peakos_equipment_usage_entries', 'c', 'd6c5e562ae0bde8eaf5d05b6a4f11b18'],
  peakos_equipment_usage_entries_user_fk: ['peakos_equipment_usage_entries', 'f', '8f93639bd1084915fea14a8968bb9e80'],
  peakos_equipment_usage_entries_version_check: ['peakos_equipment_usage_entries', 'c', 'c7bc351335dd72a3f13da8c8371e281f'],
  peakos_equipment_usage_entries_void_check: ['peakos_equipment_usage_entries', 'c', '70bf5bab771f638a7914331e8571cad1'],
  peakos_equipment_usage_entries_workspace_fk: ['peakos_equipment_usage_entries', 'f', 'b48703b9c5c79becf68dbf598be7f595'],
  peakos_protected_company_documents_archive_check: ['peakos_protected_company_documents', 'c', '4f2538c2331865c17a8072dc9bc5faf3'],
  peakos_protected_company_documents_category_check: ['peakos_protected_company_documents', 'c', 'acdbf723baf2442a0923c8f76bad7947'],
  peakos_protected_company_documents_changer_fk: ['peakos_protected_company_documents', 'f', '89191a887fa28366653d1f4d46ae5775'],
  peakos_protected_company_documents_pkey: ['peakos_protected_company_documents', 'p', 'be9bbd4b120e79f06678520e7e95fca3'],
  peakos_protected_company_documents_revision_check: ['peakos_protected_company_documents', 'c', '5eecf588f512624d9104203bad6b7c44'],
  peakos_protected_company_documents_revision_unique: ['peakos_protected_company_documents', 'u', 'd2b1121d26f5de966a284c4065eb777c'],
  peakos_protected_company_documents_status_check: ['peakos_protected_company_documents', 'c', '357cacb4db186eb86de0605fd20b6644'],
  peakos_protected_company_documents_storage_check: ['peakos_protected_company_documents', 'c', '7ed796a109f67d443d09664ffb599003'],
  peakos_protected_company_documents_storage_unique: ['peakos_protected_company_documents', 'u', '6878725e1a312178658711ec594ae996'],
  peakos_protected_company_documents_supersedes_fk: ['peakos_protected_company_documents', 'f', 'e33e693a977a92391151750c46edf97f'],
  peakos_protected_company_documents_text_check: ['peakos_protected_company_documents', 'c', '672bc61668d78f0d87312e250a01cda8'],
  peakos_protected_company_documents_time_check: ['peakos_protected_company_documents', 'c', 'd6c5e562ae0bde8eaf5d05b6a4f11b18'],
  peakos_protected_company_documents_uploader_fk: ['peakos_protected_company_documents', 'f', '63687381947ce7cd321f1da1de354cb7'],
  peakos_protected_company_documents_version_check: ['peakos_protected_company_documents', 'c', 'c7bc351335dd72a3f13da8c8371e281f'],
  peakos_protected_company_documents_workspace_fk: ['peakos_protected_company_documents', 'f', 'b48703b9c5c79becf68dbf598be7f595'],
});

const REQUIRED_INDEXES = Object.freeze({
  peakos_company_resource_audit_entity_idx: ['peakos_company_resource_audit', '00aec46a34ff8a59a76b344efb4098c3'],
  peakos_development_cost_entries_date_idx: ['peakos_development_cost_entries', '9ac87ff8c5b867fff81910e06457aed1'],
  peakos_development_cost_entries_evidence_idx: ['peakos_development_cost_entries', '272b4889f2d1e7d26bf66bccb94351f4'],
  peakos_equipment_usage_entries_date_idx: ['peakos_equipment_usage_entries', 'a54ec12c851850511231796fcc2db320'],
  peakos_equipment_usage_entries_user_idx: ['peakos_equipment_usage_entries', '74aa0d2c2abca681821a00e8a4b567bd'],
  peakos_protected_company_documents_category_idx: ['peakos_protected_company_documents', '09a0ea7b8935fa34455ceaaa2ddb1475'],
  peakos_protected_company_documents_one_active_idx: ['peakos_protected_company_documents', '335cc517fd568b779853625fbc8c72d2'],
});

const REQUIRED_TRIGGERS = Object.freeze({
  peakos_company_resource_audit_no_mutation: ['peakos_company_resource_audit', 'peakos_company_resource_reject_mutation', 'a4f2d5a126c657a78a7def22c7d8e9da'],
  peakos_company_resource_audit_no_truncate: ['peakos_company_resource_audit', 'peakos_company_resource_reject_mutation', '950f802eaf7d5bd64d4b960054de2377'],
  peakos_development_cost_entries_no_delete: ['peakos_development_cost_entries', 'peakos_company_resource_reject_mutation', '2ee30c6bef5420455f4f7717d80b337b'],
  peakos_development_cost_entries_no_truncate: ['peakos_development_cost_entries', 'peakos_company_resource_reject_mutation', '53795a7da649aa3fbdf7d00e9a6aaf30'],
  peakos_development_cost_guard_update: ['peakos_development_cost_entries', 'peakos_company_resource_guard_update', 'f67d327fd33919277328b3172010d42a'],
  peakos_development_cost_validate_insert: ['peakos_development_cost_entries', 'peakos_company_resource_validate_insert', '83ebb935fc0c058d9cbb9baef58dc2e2'],
  peakos_development_cost_write_audit: ['peakos_development_cost_entries', 'peakos_company_resource_write_audit', '672010281f27a254b4487a1c97f43f14'],
  peakos_equipment_usage_entries_no_delete: ['peakos_equipment_usage_entries', 'peakos_company_resource_reject_mutation', 'a18deb06fc682e6ec8c3aed974b2714d'],
  peakos_equipment_usage_entries_no_truncate: ['peakos_equipment_usage_entries', 'peakos_company_resource_reject_mutation', '57410a76b595e241e01c8036caab7cfd'],
  peakos_equipment_usage_guard_update: ['peakos_equipment_usage_entries', 'peakos_company_resource_guard_update', '7b5de59dbc079cb0dd5e2288ab7de6ab'],
  peakos_equipment_usage_write_audit: ['peakos_equipment_usage_entries', 'peakos_company_resource_write_audit', '3cb46906c68358ec1c4a0e38d24eca13'],
  peakos_protected_company_document_guard_update: ['peakos_protected_company_documents', 'peakos_company_resource_guard_update', 'f06d7e9ff580211910c5acc568e9bdc1'],
  peakos_protected_company_document_validate_insert: ['peakos_protected_company_documents', 'peakos_company_resource_validate_insert', '73779b34a38e7ce900c8f09421a2b0bb'],
  peakos_protected_company_document_write_audit: ['peakos_protected_company_documents', 'peakos_company_resource_write_audit', 'aa3890530ba75f38d2c049db7e5b2c16'],
  peakos_protected_company_documents_no_delete: ['peakos_protected_company_documents', 'peakos_company_resource_reject_mutation', '0465b0f137d9005e399fa9f721a60819'],
  peakos_protected_company_documents_no_truncate: ['peakos_protected_company_documents', 'peakos_company_resource_reject_mutation', 'd419507c61e26393f29ca6a383c81faa'],
});

const REQUIRED_FUNCTIONS = Object.freeze({
  peakos_company_resource_guard_update: [true, '425e32e4a45b227e69b186db457661b8'],
  peakos_company_resource_reject_mutation: [false, '547afaa7d728c2097aaac0689f3c1d7f'],
  peakos_company_resource_validate_insert: [true, 'dcbc54908b72ec03e2428421f58c0e34'],
  peakos_company_resource_write_audit: [true, 'cd3f9cf383c25647b60b8b1ed15bcac3'],
});

function migrationRequired(detail) {
  const error = new Error(`회사 자료 운영 migration이 필요합니다: ${detail}`);
  error.code = 'PEAKOS_COMPANY_RESOURCES_MIGRATION_REQUIRED';
  return error;
}

function exactKeys(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function ensurePeakosCompanyResourceInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');

  const relations = await pool.query(
    `SELECT relation.relname AS table_name, relation.relkind, relation.relrowsecurity,
            relation.relforcerowsecurity,
            pg_get_userbyid(relation.relowner) = current_user AS runtime_owns_table
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
      ORDER BY relation.relname`,
    [TABLES],
  );
  const relationMap = new Map(relations.rows.map(row => [row.table_name, row]));
  const invalidRelations = TABLES.filter(table => {
    const row = relationMap.get(table);
    return !row || row.relkind !== 'r' || row.relrowsecurity !== false
      || row.relforcerowsecurity !== false || row.runtime_owns_table !== false;
  });
  if (invalidRelations.length) throw migrationRequired(`relations ${invalidRelations.join(', ')}`);

  const columns = await pool.query(
    `SELECT relation.relname AS table_name, attribute.attname AS column_name,
            format_type(attribute.atttypid,attribute.atttypmod) AS data_type,
            attribute.attnotnull AS is_not_null,
            pg_get_expr(default_row.adbin,default_row.adrelid) AS column_default
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
       LEFT JOIN pg_attrdef default_row
         ON default_row.adrelid = attribute.attrelid AND default_row.adnum = attribute.attnum
      WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
      ORDER BY relation.relname, attribute.attnum`,
    [TABLES],
  );
  const actualColumns = new Map(columns.rows.map(row => [`${row.table_name}.${row.column_name}`, row]));
  const invalidColumns = REQUIRED_COLUMNS.filter(([table, column, type, notNull]) => {
    const key = `${table}.${column}`;
    const row = actualColumns.get(key);
    const expectedDefault = REQUIRED_DEFAULTS[key] || null;
    return !row || row.data_type !== type || row.is_not_null !== notNull
      || (row.column_default || null) !== expectedDefault;
  }).map(([table, column]) => `${table}.${column}`);
  if (invalidColumns.length || columns.rows.length !== REQUIRED_COLUMNS.length) {
    throw migrationRequired(`columns ${invalidColumns.slice(0, 8).join(', ') || 'unexpected column set'}`);
  }

  const constraints = await pool.query(
    `SELECT constraint_row.conname, relation.relname AS table_name,
            constraint_row.contype, constraint_row.convalidated,
            md5(regexp_replace(lower(pg_get_constraintdef(constraint_row.oid)), '[[:space:]]+', '', 'g')) AS definition_hash
       FROM pg_constraint constraint_row
       JOIN pg_class relation ON relation.oid = constraint_row.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
      ORDER BY constraint_row.conname`,
    [TABLES],
  );
  const expectedConstraintNames = Object.keys(REQUIRED_CONSTRAINTS).sort();
  const actualConstraintNames = constraints.rows.map(row => row.conname).sort();
  const constraintMap = new Map(constraints.rows.map(row => [row.conname, row]));
  const invalidConstraints = expectedConstraintNames.filter(name => {
    const row = constraintMap.get(name);
    const [table, type, hash] = REQUIRED_CONSTRAINTS[name];
    return !row || row.table_name !== table || row.contype !== type
      || row.convalidated !== true || row.definition_hash !== hash;
  });
  if (!exactKeys(actualConstraintNames, expectedConstraintNames) || invalidConstraints.length) {
    throw migrationRequired(`constraints ${invalidConstraints.slice(0, 8).join(', ') || 'unexpected constraint set'}`);
  }

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
    return !row || row.table_name !== table || row.indisvalid !== true || row.indisready !== true
      || row.indislive !== true || row.indisprimary !== false || row.indisexclusion !== false
      || row.definition_hash !== hash;
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
      WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
        AND NOT trigger_row.tgisinternal
      ORDER BY trigger_row.tgname`,
    [TABLES],
  );
  const expectedTriggerNames = Object.keys(REQUIRED_TRIGGERS).sort();
  const actualTriggerNames = triggers.rows.map(row => row.tgname).sort();
  const triggerMap = new Map(triggers.rows.map(row => [row.tgname, row]));
  const invalidTriggers = expectedTriggerNames.filter(name => {
    const row = triggerMap.get(name);
    const [table, functionName, hash] = REQUIRED_TRIGGERS[name];
    return !row || row.table_name !== table || row.tgenabled !== 'O'
      || row.tgisinternal !== false || row.tgdeferrable !== false
      || row.tginitdeferred !== false || row.function_name !== functionName
      || row.definition_hash !== hash;
  });
  if (!exactKeys(actualTriggerNames, expectedTriggerNames) || invalidTriggers.length) {
    throw migrationRequired(`triggers ${invalidTriggers.slice(0, 8).join(', ') || 'unexpected trigger set'}`);
  }

  const functions = await pool.query(
    `SELECT function_row.proname,function_row.pronargs,function_row.prosecdef,
            function_row.provolatile,language.lanname,
            md5(regexp_replace(lower(function_row.prosrc), '[[:space:]]+', '', 'g')) AS source_hash,
            has_function_privilege(current_user,function_row.oid,'EXECUTE') AS runtime_can_execute,
            pg_get_userbyid(function_row.proowner) = current_user AS runtime_owns_function
       FROM pg_proc function_row
       JOIN pg_namespace namespace ON namespace.oid = function_row.pronamespace
       JOIN pg_language language ON language.oid = function_row.prolang
      WHERE namespace.nspname = 'public' AND function_row.proname LIKE 'peakos_company_resource_%'
      ORDER BY function_row.proname`,
  );
  const expectedFunctionNames = Object.keys(REQUIRED_FUNCTIONS).sort();
  const actualFunctionNames = functions.rows.map(row => row.proname).sort();
  const functionMap = new Map(functions.rows.map(row => [row.proname, row]));
  const invalidFunctions = expectedFunctionNames.filter(name => {
    const row = functionMap.get(name);
    const [securityDefiner, hash] = REQUIRED_FUNCTIONS[name];
    return !row || Number(row.pronargs) !== 0 || row.lanname !== 'plpgsql'
      || row.prosecdef !== securityDefiner || row.provolatile !== 'v'
      || row.source_hash !== hash || row.runtime_can_execute !== false
      || row.runtime_owns_function !== false;
  });
  if (!exactKeys(actualFunctionNames, expectedFunctionNames) || invalidFunctions.length) {
    throw migrationRequired(`functions ${invalidFunctions.join(', ') || 'unexpected function set'}`);
  }

  const acl = await pool.query(
    `WITH required(table_name,can_select,can_insert,can_update) AS (VALUES
       ('peakos_equipment_usage_entries'::text,TRUE,TRUE,TRUE),
       ('peakos_development_cost_entries'::text,TRUE,TRUE,TRUE),
       ('peakos_protected_company_documents'::text,TRUE,TRUE,TRUE),
       ('peakos_company_resource_audit'::text,TRUE,FALSE,FALSE)
     )
     SELECT required.table_name
       FROM required
       JOIN pg_class relation ON relation.relname = required.table_name
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace AND namespace.nspname = 'public'
      WHERE pg_get_userbyid(relation.relowner) = current_user
         OR has_table_privilege(current_user,relation.oid,'SELECT') <> required.can_select
         OR has_table_privilege(current_user,relation.oid,'INSERT') <> required.can_insert
         OR has_table_privilege(current_user,relation.oid,'UPDATE') <> required.can_update
         OR has_table_privilege(current_user,relation.oid,'DELETE')
         OR has_table_privilege(current_user,relation.oid,'TRUNCATE')
         OR has_table_privilege(current_user,relation.oid,'REFERENCES')
         OR has_table_privilege(current_user,relation.oid,'TRIGGER')
     UNION ALL
     SELECT 'peakos_company_resource_audit_id_seq'
      WHERE has_sequence_privilege(current_user,'public.peakos_company_resource_audit_id_seq','USAGE')
         OR has_sequence_privilege(current_user,'public.peakos_company_resource_audit_id_seq','SELECT')
         OR has_sequence_privilege(current_user,'public.peakos_company_resource_audit_id_seq','UPDATE')`,
  );
  if (acl.rows.length) throw migrationRequired(`runtime ACL ${acl.rows.map(row => row.table_name).join(', ')}`);

  return Object.freeze({
    checkedColumns: REQUIRED_COLUMNS.length,
    checkedConstraints: expectedConstraintNames.length,
    checkedIndexes: Object.keys(REQUIRED_INDEXES).length,
    checkedTriggers: expectedTriggerNames.length,
    checkedFunctions: expectedFunctionNames.length,
  });
}

module.exports = {
  MIGRATION_PATH,
  REQUIRED_COLUMNS,
  REQUIRED_CONSTRAINTS,
  REQUIRED_DEFAULTS,
  REQUIRED_FUNCTIONS,
  REQUIRED_INDEXES,
  REQUIRED_TRIGGERS,
  TABLES,
  ensurePeakosCompanyResourceInfrastructure,
};
