'use strict';

const path = require('node:path');

const TODO_MIGRATION_FILE = '20260818_peakos_todos.sql';
const TODO_MIGRATION_PATH = path.join(__dirname, '..', 'migrations', TODO_MIGRATION_FILE);

const TODO_TABLES = Object.freeze(['peakos_todo_audit', 'peakos_todos']);

const TODO_REQUIRED_COLUMNS = Object.freeze([
  ['peakos_todo_audit', 'id', 'bigint', true, "nextval('peakos_todo_audit_id_seq'::regclass)"],
  ['peakos_todo_audit', 'workspace_id', 'text', true, null],
  ['peakos_todo_audit', 'todo_id', 'uuid', true, null],
  ['peakos_todo_audit', 'action', 'text', true, null],
  ['peakos_todo_audit', 'entity_version', 'integer', true, null],
  ['peakos_todo_audit', 'actor_uid', 'text', true, null],
  ['peakos_todo_audit', 'actor_name_snapshot', 'text', true, null],
  ['peakos_todo_audit', 'before_state', 'jsonb', false, null],
  ['peakos_todo_audit', 'after_state', 'jsonb', true, null],
  ['peakos_todo_audit', 'created_at', 'timestamp with time zone', true, 'now()'],
  ['peakos_todos', 'workspace_id', 'text', true, null],
  ['peakos_todos', 'id', 'uuid', true, null],
  ['peakos_todos', 'owner_uid', 'text', true, null],
  ['peakos_todos', 'owner_name_snapshot', 'text', true, null],
  ['peakos_todos', 'title', 'text', true, null],
  ['peakos_todos', 'todo_date', 'date', true, null],
  ['peakos_todos', 'start_time', 'time without time zone', false, null],
  ['peakos_todos', 'end_time', 'time without time zone', false, null],
  ['peakos_todos', 'category', 'text', true, "'일반'::text"],
  ['peakos_todos', 'memo', 'text', true, "''::text"],
  ['peakos_todos', 'done', 'boolean', true, 'false'],
  ['peakos_todos', 'sort_order', 'integer', true, '0'],
  ['peakos_todos', 'archived', 'boolean', true, 'false'],
  ['peakos_todos', 'archived_at', 'timestamp with time zone', false, null],
  ['peakos_todos', 'version', 'integer', true, '1'],
  ['peakos_todos', 'last_action', 'text', true, "'CREATE'::text"],
  ['peakos_todos', 'last_changed_by_uid', 'text', true, null],
  ['peakos_todos', 'last_changed_by_name_snapshot', 'text', true, null],
  ['peakos_todos', 'created_at', 'timestamp with time zone', true, 'now()'],
  ['peakos_todos', 'updated_at', 'timestamp with time zone', true, 'now()'],
]);

const TODO_REQUIRED_CONSTRAINTS = Object.freeze([
  ['peakos_todo_audit_action_check', 'peakos_todo_audit', 'c', '77e8446e20cb8a5e9978835f2073574b'],
  ['peakos_todo_audit_actor_check', 'peakos_todo_audit', 'c', '2a053b886930bb5c137a21bd4d6a98da'],
  ['peakos_todo_audit_actor_membership_fk', 'peakos_todo_audit', 'f', 'a6df8809886efbcf7b496c62c2da118f'],
  ['peakos_todo_audit_pkey', 'peakos_todo_audit', 'p', '4c6419b3704337bbfe50f018842a9ad3'],
  ['peakos_todo_audit_shape_check', 'peakos_todo_audit', 'c', 'a8bbf02ac8823410821f4d397f1795e1'],
  ['peakos_todo_audit_todo_fk', 'peakos_todo_audit', 'f', '57dee0e0292bee4eaa8ae81f6956620a'],
  ['peakos_todo_audit_version_check', 'peakos_todo_audit', 'c', 'caf57479106ae07bc1510c53c5584db4'],
  ['peakos_todo_audit_workspace_fk', 'peakos_todo_audit', 'f', '13a728e367ce44d9178a893af7138a12'],
  ['peakos_todos_action_check', 'peakos_todos', 'c', '091ab2473adaccba5ed84136a9d7647e'],
  ['peakos_todos_archive_check', 'peakos_todos', 'c', 'c00917f37b636fdcf97584b0b5e5890a'],
  ['peakos_todos_category_check', 'peakos_todos', 'c', '7429b35f79e5e4301976c0db35527416'],
  ['peakos_todos_changer_membership_fk', 'peakos_todos', 'f', '7a7e9e09e142e5d7750ee23566d0a9b6'],
  ['peakos_todos_date_check', 'peakos_todos', 'c', 'd15d3949f7b96202558dc6c05404abd9'],
  ['peakos_todos_memo_check', 'peakos_todos', 'c', 'a9586f472baba09f1b61e012c091d446'],
  ['peakos_todos_owner_check', 'peakos_todos', 'c', '76cfe49a20057e44d8a5826cb602e268'],
  ['peakos_todos_owner_membership_fk', 'peakos_todos', 'f', '86465fee0020f3a0692572f7859c3ba6'],
  ['peakos_todos_pkey', 'peakos_todos', 'p', 'a990ae57adc95623c1e40b72d9ba2d52'],
  ['peakos_todos_sort_order_check', 'peakos_todos', 'c', '9d91a4d9add25d4d5d96f1d590c00787'],
  ['peakos_todos_time_check', 'peakos_todos', 'c', '4f45c3ebb4e50a2b3791f6aa5335cf90'],
  ['peakos_todos_timestamp_check', 'peakos_todos', 'c', 'd0fcb99b2cb5a405bff7aa20d5dc9716'],
  ['peakos_todos_title_check', 'peakos_todos', 'c', '3480279a52ec3dbfd7d7f4e53d8ac559'],
  ['peakos_todos_version_check', 'peakos_todos', 'c', '4b4ca8f661c30614d9612df3a53931e0'],
  ['peakos_todos_workspace_fk', 'peakos_todos', 'f', '13a728e367ce44d9178a893af7138a12'],
]);

const TODO_REQUIRED_INDEXES = Object.freeze([
  ['peakos_todo_audit_todo_idx', 'peakos_todo_audit', '28352e0c93d03a591920710c2dd26f8b'],
  ['peakos_todos_owner_date_idx', 'peakos_todos', '225aee0f06c2c3e8453a0eca5f552051'],
]);

const TODO_REQUIRED_TRIGGERS = Object.freeze([
  ['peakos_todo_audit_no_mutation', 'peakos_todo_audit', 'peakos_todo_reject_mutation', '4c8571fd154dfdfaeaab9bff8e43af34'],
  ['peakos_todo_audit_no_truncate', 'peakos_todo_audit', 'peakos_todo_reject_mutation', '2868e69e7702debc652f3c671f4c1ce0'],
  ['peakos_todos_guard_update', 'peakos_todos', 'peakos_todo_guard_update', '3f590200625eff53367fc39ede844547'],
  ['peakos_todos_no_delete', 'peakos_todos', 'peakos_todo_reject_mutation', '4d63a3b2266ebf31cee0504891e3db9c'],
  ['peakos_todos_no_truncate', 'peakos_todos', 'peakos_todo_reject_mutation', '8249a1bb9bc204fb4c26bcbc6661f7f7'],
  ['peakos_todos_write_audit', 'peakos_todos', 'peakos_todo_write_audit', '2fd593a994942c112cf0308a957c1c45'],
]);

const TODO_REQUIRED_FUNCTIONS = Object.freeze([
  ['peakos_todo_guard_update', false, '3ff3d2d441eed494ef7cd5cdf3a49a12'],
  ['peakos_todo_reject_mutation', false, '010d6bc545ebe0e111224d516c3e5eb4'],
  ['peakos_todo_write_audit', true, '82049adbdd6427adbf558c0236eaed0b'],
]);

function sqlString(value) {
  return value === null ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`;
}

const columnValues = TODO_REQUIRED_COLUMNS.map(([table, column, type, notNull, defaultValue]) => (
  `(${sqlString(table)},${sqlString(column)},${sqlString(type)},${notNull ? 'TRUE' : 'FALSE'},${sqlString(defaultValue)})`
));
const constraintValues = TODO_REQUIRED_CONSTRAINTS.map(([name, table, type, hash]) => (
  `(${sqlString(name)},${sqlString(table)},${sqlString(type)},${sqlString(hash)})`
));
const indexValues = TODO_REQUIRED_INDEXES.map(([name, table, hash]) => (
  `(${sqlString(name)},${sqlString(table)},${sqlString(hash)})`
));
const triggerValues = TODO_REQUIRED_TRIGGERS.map(([name, table, functionName, hash]) => (
  `(${sqlString(name)},${sqlString(table)},${sqlString(functionName)},${sqlString(hash)})`
));
const functionValues = TODO_REQUIRED_FUNCTIONS.map(([name, securityDefiner, hash]) => (
  `(${sqlString(name)},${securityDefiner ? 'TRUE' : 'FALSE'},${sqlString(hash)})`
));

// Deliberately SELECT-only. Runtime startup must never repair operator-owned
// schema, grants, triggers, functions, or data.
const TODO_SCHEMA_READINESS_SQL = `
WITH required_tables(table_name) AS (
  VALUES ${TODO_TABLES.map(sqlString).map(value => `(${value})`).join(', ')}
), required_columns(table_name, column_name, data_type, is_not_null, column_default) AS (
  VALUES ${columnValues.join(',\n    ')}
), required_constraints(constraint_name, table_name, constraint_type, definition_hash) AS (
  VALUES ${constraintValues.join(',\n    ')}
), required_indexes(index_name, table_name, definition_hash) AS (
  VALUES ${indexValues.join(',\n    ')}
), required_triggers(trigger_name, table_name, function_name, definition_hash) AS (
  VALUES ${triggerValues.join(',\n    ')}
), required_functions(function_name, security_definer, source_hash) AS (
  VALUES ${functionValues.join(',\n    ')}
), table_privileges(table_name, privilege_name, expected) AS (
  VALUES
    ('peakos_todos','SELECT',TRUE),('peakos_todos','INSERT',TRUE),
    ('peakos_todos','UPDATE',TRUE),('peakos_todos','DELETE',FALSE),
    ('peakos_todos','TRUNCATE',FALSE),('peakos_todos','REFERENCES',FALSE),
    ('peakos_todos','TRIGGER',FALSE),
    ('peakos_todo_audit','SELECT',TRUE),('peakos_todo_audit','INSERT',FALSE),
    ('peakos_todo_audit','UPDATE',FALSE),('peakos_todo_audit','DELETE',FALSE),
    ('peakos_todo_audit','TRUNCATE',FALSE),('peakos_todo_audit','REFERENCES',FALSE),
    ('peakos_todo_audit','TRIGGER',FALSE)
), missing AS (
  SELECT 'relation:' || expected.table_name AS requirement
    FROM required_tables expected
    LEFT JOIN pg_class relation
      ON relation.relnamespace = 'public'::regnamespace
     AND relation.relname = expected.table_name
   WHERE relation.oid IS NULL OR relation.relkind <> 'r'
      OR relation.relrowsecurity OR relation.relforcerowsecurity
      OR pg_get_userbyid(relation.relowner) = current_user
  UNION ALL
  SELECT 'column-definition:' || expected.table_name || '.' || expected.column_name
    FROM required_columns expected
    LEFT JOIN pg_class relation
      ON relation.relnamespace = 'public'::regnamespace
     AND relation.relname = expected.table_name
    LEFT JOIN pg_attribute attribute
      ON attribute.attrelid = relation.oid
     AND attribute.attname = expected.column_name
     AND attribute.attnum > 0 AND NOT attribute.attisdropped
    LEFT JOIN pg_attrdef default_row
      ON default_row.adrelid = attribute.attrelid AND default_row.adnum = attribute.attnum
   WHERE attribute.attnum IS NULL
      OR format_type(attribute.atttypid, attribute.atttypmod) <> expected.data_type
      OR attribute.attnotnull <> expected.is_not_null
      OR pg_get_expr(default_row.adbin, default_row.adrelid) IS DISTINCT FROM expected.column_default
      OR attribute.attacl IS NOT NULL
  UNION ALL
  SELECT 'unexpected-column:' || relation.relname || '.' || attribute.attname
    FROM pg_class relation
    JOIN pg_attribute attribute
      ON attribute.attrelid = relation.oid
     AND attribute.attnum > 0 AND NOT attribute.attisdropped
   WHERE relation.relnamespace = 'public'::regnamespace
     AND relation.relname IN ('peakos_todos','peakos_todo_audit')
     AND NOT EXISTS (
       SELECT 1 FROM required_columns expected
        WHERE expected.table_name = relation.relname
          AND expected.column_name = attribute.attname
     )
  UNION ALL
  SELECT 'constraint-definition:' || expected.table_name || '.' || expected.constraint_name
    FROM required_constraints expected
    LEFT JOIN pg_class relation
      ON relation.relnamespace = 'public'::regnamespace
     AND relation.relname = expected.table_name
    LEFT JOIN pg_constraint actual
      ON actual.conrelid = relation.oid AND actual.conname = expected.constraint_name
   WHERE actual.oid IS NULL OR actual.contype <> expected.constraint_type
      OR actual.convalidated IS NOT TRUE
      OR md5(pg_get_constraintdef(actual.oid, TRUE)) <> expected.definition_hash
  UNION ALL
  SELECT 'unexpected-constraint:' || relation.relname || '.' || actual.conname
    FROM pg_constraint actual
    JOIN pg_class relation ON relation.oid = actual.conrelid
   WHERE relation.relnamespace = 'public'::regnamespace
     AND relation.relname IN ('peakos_todos','peakos_todo_audit')
     AND NOT EXISTS (
       SELECT 1 FROM required_constraints expected
        WHERE expected.table_name = relation.relname
          AND expected.constraint_name = actual.conname
     )
  UNION ALL
  SELECT 'index-definition:' || expected.table_name || '.' || expected.index_name
    FROM required_indexes expected
    LEFT JOIN pg_class index_relation
      ON index_relation.relnamespace = 'public'::regnamespace
     AND index_relation.relname = expected.index_name
    LEFT JOIN pg_index actual ON actual.indexrelid = index_relation.oid
    LEFT JOIN pg_class table_relation ON table_relation.oid = actual.indrelid
   WHERE actual.indexrelid IS NULL OR table_relation.relname <> expected.table_name
      OR actual.indisvalid IS NOT TRUE OR actual.indisready IS NOT TRUE
      OR actual.indislive IS NOT TRUE OR actual.indisunique IS NOT FALSE
      OR actual.indisprimary IS NOT FALSE OR actual.indisexclusion IS NOT FALSE
      OR md5(pg_get_indexdef(actual.indexrelid)) <> expected.definition_hash
  UNION ALL
  SELECT 'unexpected-index:' || table_relation.relname || '.' || index_relation.relname
    FROM pg_index actual
    JOIN pg_class index_relation ON index_relation.oid = actual.indexrelid
    JOIN pg_class table_relation ON table_relation.oid = actual.indrelid
   WHERE table_relation.relnamespace = 'public'::regnamespace
     AND table_relation.relname IN ('peakos_todos','peakos_todo_audit')
     AND actual.indisprimary IS NOT TRUE
     AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = actual.indexrelid)
     AND NOT EXISTS (
       SELECT 1 FROM required_indexes expected
        WHERE expected.table_name = table_relation.relname
          AND expected.index_name = index_relation.relname
     )
  UNION ALL
  SELECT 'trigger-definition:' || expected.table_name || '.' || expected.trigger_name
    FROM required_triggers expected
    LEFT JOIN pg_class relation
      ON relation.relnamespace = 'public'::regnamespace
     AND relation.relname = expected.table_name
    LEFT JOIN pg_trigger actual
      ON actual.tgrelid = relation.oid AND actual.tgname = expected.trigger_name
     AND NOT actual.tgisinternal
    LEFT JOIN pg_proc function_row ON function_row.oid = actual.tgfoid
   WHERE actual.oid IS NULL OR actual.tgenabled <> 'O'
      OR actual.tgqual IS NOT NULL OR actual.tgnargs <> 0
      OR function_row.proname <> expected.function_name
      OR md5(pg_get_triggerdef(actual.oid, TRUE)) <> expected.definition_hash
  UNION ALL
  SELECT 'unexpected-trigger:' || relation.relname || '.' || actual.tgname
    FROM pg_trigger actual
    JOIN pg_class relation ON relation.oid = actual.tgrelid
   WHERE relation.relnamespace = 'public'::regnamespace
     AND relation.relname IN ('peakos_todos','peakos_todo_audit')
     AND NOT actual.tgisinternal
     AND NOT EXISTS (
       SELECT 1 FROM required_triggers expected
        WHERE expected.table_name = relation.relname
          AND expected.trigger_name = actual.tgname
     )
  UNION ALL
  SELECT 'function-definition:' || expected.function_name
    FROM required_functions expected
    LEFT JOIN pg_proc actual
      ON actual.pronamespace = 'public'::regnamespace
     AND actual.proname = expected.function_name AND actual.pronargs = 0
    LEFT JOIN pg_language language ON language.oid = actual.prolang
   WHERE actual.oid IS NULL OR actual.prosecdef <> expected.security_definer
      OR actual.provolatile <> 'v' OR language.lanname <> 'plpgsql'
      OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
      OR md5(actual.prosrc) <> expected.source_hash
      OR pg_get_userbyid(actual.proowner) = current_user
  UNION ALL
  SELECT 'unexpected-function:' || actual.proname
    FROM pg_proc actual
   WHERE actual.pronamespace = 'public'::regnamespace
     AND actual.proname LIKE 'peakos_todo_%'
     AND NOT EXISTS (
       SELECT 1 FROM required_functions expected
        WHERE expected.function_name = actual.proname
     )
  UNION ALL
  SELECT 'table-privilege:' || expected.table_name || '.' || expected.privilege_name
    FROM table_privileges expected
   WHERE has_table_privilege(
           current_user, format('public.%I', expected.table_name), expected.privilege_name
         ) IS DISTINCT FROM expected.expected
  UNION ALL
  SELECT 'public-table-privilege:' || expected.table_name || '.' || expected.privilege_name
    FROM table_privileges expected
   WHERE has_table_privilege(
           'public', format('public.%I', expected.table_name), expected.privilege_name
         ) IS NOT FALSE
  UNION ALL
  SELECT 'function-privilege:' || expected.function_name || '.execute'
    FROM required_functions expected
   WHERE has_function_privilege(
           current_user, format('public.%I()', expected.function_name), 'EXECUTE'
         ) IS NOT FALSE
  UNION ALL
  SELECT 'public-function-privilege:' || expected.function_name || '.execute'
    FROM required_functions expected
   WHERE has_function_privilege(
           'public', format('public.%I()', expected.function_name), 'EXECUTE'
         ) IS NOT FALSE
  UNION ALL
  SELECT 'sequence-owner-or-privilege:peakos_todo_audit_id_seq'
   WHERE EXISTS (
     SELECT 1 FROM pg_class sequence_row
      WHERE sequence_row.oid = to_regclass('public.peakos_todo_audit_id_seq')
        AND pg_get_userbyid(sequence_row.relowner) = current_user
   )
      OR has_sequence_privilege(current_user, 'public.peakos_todo_audit_id_seq', 'USAGE') IS NOT FALSE
      OR has_sequence_privilege(current_user, 'public.peakos_todo_audit_id_seq', 'SELECT') IS NOT FALSE
      OR has_sequence_privilege(current_user, 'public.peakos_todo_audit_id_seq', 'UPDATE') IS NOT FALSE
      OR has_sequence_privilege('public', 'public.peakos_todo_audit_id_seq', 'USAGE') IS NOT FALSE
      OR has_sequence_privilege('public', 'public.peakos_todo_audit_id_seq', 'SELECT') IS NOT FALSE
      OR has_sequence_privilege('public', 'public.peakos_todo_audit_id_seq', 'UPDATE') IS NOT FALSE
)
SELECT NOT EXISTS (SELECT 1 FROM missing) AS ready,
       COALESCE(array_agg(requirement ORDER BY requirement)
         FILTER (WHERE requirement IS NOT NULL), ARRAY[]::text[]) AS missing_requirements
  FROM missing
`;

class TodoInfrastructureError extends Error {
  constructor(missing = []) {
    super(`PEAK OS 할 일 저장소 마이그레이션이 필요합니다 (${TODO_MIGRATION_FILE}).`);
    this.name = 'TodoInfrastructureError';
    this.code = 'TODO_SCHEMA_NOT_READY';
    this.statusCode = 503;
    this.missing = Object.freeze([...(missing || [])]);
  }
}

async function ensurePeakosTodoInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  let result;
  try {
    result = await pool.query(TODO_SCHEMA_READINESS_SQL);
  } catch (error) {
    const safe = new TodoInfrastructureError(['readiness-query']);
    safe.cause = error;
    throw safe;
  }
  const row = result?.rows?.[0] || {};
  if (row.ready !== true || !Array.isArray(row.missing_requirements)
      || row.missing_requirements.length) {
    throw new TodoInfrastructureError(row.missing_requirements || ['readiness-result']);
  }
  return Object.freeze({
    checkedTables: TODO_TABLES.length,
    checkedColumns: TODO_REQUIRED_COLUMNS.length,
    checkedConstraints: TODO_REQUIRED_CONSTRAINTS.length,
    checkedIndexes: TODO_REQUIRED_INDEXES.length,
    checkedTriggers: TODO_REQUIRED_TRIGGERS.length,
    checkedFunctions: TODO_REQUIRED_FUNCTIONS.length,
  });
}

module.exports = {
  TODO_MIGRATION_FILE,
  TODO_MIGRATION_PATH,
  TODO_REQUIRED_COLUMNS,
  TODO_REQUIRED_CONSTRAINTS,
  TODO_REQUIRED_FUNCTIONS,
  TODO_REQUIRED_INDEXES,
  TODO_REQUIRED_TRIGGERS,
  TODO_SCHEMA_READINESS_SQL,
  TODO_TABLES,
  TodoInfrastructureError,
  ensurePeakosTodoInfrastructure,
};
