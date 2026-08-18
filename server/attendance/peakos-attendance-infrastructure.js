'use strict';

const ATTENDANCE_MIGRATION_FILE = '20260818_peakos_attendance_workspace.sql';

const ATTENDANCE_GUARD_SOURCE = `
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.user_name IS DISTINCT FROM OLD.user_name
     OR NEW.attendance_date IS DISTINCT FROM OLD.attendance_date
     OR NEW.check_in IS DISTINCT FROM OLD.check_in
     OR NEW.check_in_at IS DISTINCT FROM OLD.check_in_at
     OR NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.memo IS DISTINCT FROM OLD.memo
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.check_out_at IS NOT NULL
     OR NEW.check_out_at IS NULL
     OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'attendance identity/check-in is immutable and check-out is write-once'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
`.trim();

const ATTENDANCE_EVENT_APPEND_ONLY_SOURCE = `
BEGIN
  RAISE EXCEPTION 'peakos_attendance_events is append-only'
    USING ERRCODE = '55000';
END
`.trim();

const REQUIRED_COLUMNS = Object.freeze([
  ['attendance', 'workspace_id', 'text', true],
  ['attendance', 'check_in_at', 'timestamp with time zone', true],
  ['attendance', 'check_out_at', 'timestamp with time zone', false],
  ['attendance', 'row_version', 'integer', true],
  ['peakos_attendance_events', 'workspace_id', 'text', true],
  ['peakos_attendance_events', 'id', 'bigint', true],
  ['peakos_attendance_events', 'attendance_id', 'text', true],
  ['peakos_attendance_events', 'event_type', 'text', true],
  ['peakos_attendance_events', 'actor_uid', 'text', true],
  ['peakos_attendance_events', 'actor_name_snapshot', 'text', true],
  ['peakos_attendance_events', 'occurred_at', 'timestamp with time zone', true],
  ['peakos_attendance_events', 'record_version', 'integer', true],
  ['peakos_attendance_events', 'created_at', 'timestamp with time zone', true],
]);

const REQUIRED_CONSTRAINTS = Object.freeze([
  ['attendance', 'peakos_attendance_workspace_fk'],
  ['attendance', 'peakos_attendance_date_check'],
  ['attendance', 'peakos_attendance_time_projection_check'],
  ['attendance', 'peakos_attendance_checkout_order_check'],
  ['attendance', 'peakos_attendance_row_version_check'],
  ['peakos_attendance_events', 'peakos_attendance_events_pkey'],
  ['peakos_attendance_events', 'peakos_attendance_events_attendance_fk'],
  ['peakos_attendance_events', 'peakos_attendance_events_actor_membership_fk'],
  ['peakos_attendance_events', 'peakos_attendance_events_type_check'],
  ['peakos_attendance_events', 'peakos_attendance_events_actor_uid_check'],
  ['peakos_attendance_events', 'peakos_attendance_events_actor_name_check'],
  ['peakos_attendance_events', 'peakos_attendance_events_version_check'],
]);

const REQUIRED_INDEXES = Object.freeze([
  ['attendance', 'peakos_attendance_workspace_user_date_unique', true,
    'CREATE UNIQUE INDEX peakos_attendance_workspace_user_date_unique ON public.attendance USING btree (workspace_id, user_id, attendance_date)'],
  ['attendance', 'peakos_attendance_workspace_id_unique', true,
    'CREATE UNIQUE INDEX peakos_attendance_workspace_id_unique ON public.attendance USING btree (workspace_id, id)'],
  ['attendance', 'peakos_attendance_workspace_month_idx', false,
    'CREATE INDEX peakos_attendance_workspace_month_idx ON public.attendance USING btree (workspace_id, attendance_date, user_id)'],
  ['peakos_attendance_events', 'peakos_attendance_events_record_idx', false,
    'CREATE INDEX peakos_attendance_events_record_idx ON public.peakos_attendance_events USING btree (workspace_id, attendance_id, created_at, id)'],
  ['peakos_attendance_events', 'peakos_attendance_events_actor_idx', false,
    'CREATE INDEX peakos_attendance_events_actor_idx ON public.peakos_attendance_events USING btree (workspace_id, actor_uid, occurred_at DESC, id DESC)'],
]);

const REQUIRED_TRIGGERS = Object.freeze([
  ['attendance', 'peakos_attendance_guard_update', 19, 'peakos_attendance_guard_update', ATTENDANCE_GUARD_SOURCE,
    'CREATE TRIGGER peakos_attendance_guard_update BEFORE UPDATE ON public.attendance FOR EACH ROW EXECUTE FUNCTION peakos_attendance_guard_update()'],
  ['peakos_attendance_events', 'peakos_attendance_events_no_mutation', 27,
    'peakos_attendance_event_append_only', ATTENDANCE_EVENT_APPEND_ONLY_SOURCE,
    'CREATE TRIGGER peakos_attendance_events_no_mutation BEFORE DELETE OR UPDATE ON public.peakos_attendance_events FOR EACH ROW EXECUTE FUNCTION peakos_attendance_event_append_only()'],
]);

const TABLE_PRIVILEGES = Object.freeze({
  attendance: Object.freeze({
    SELECT: true, INSERT: true, UPDATE: true, DELETE: false,
    TRUNCATE: false, REFERENCES: false, TRIGGER: false,
  }),
  peakos_attendance_events: Object.freeze({
    SELECT: true, INSERT: true, UPDATE: false, DELETE: false,
    TRUNCATE: false, REFERENCES: false, TRIGGER: false,
  }),
});

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const columnRows = REQUIRED_COLUMNS.map(([table, column, type, notNull]) => (
  `(${sqlString(table)},${sqlString(column)},${sqlString(type)},${notNull ? 'TRUE' : 'FALSE'})`
));
const constraintRows = REQUIRED_CONSTRAINTS.map(([table, constraint]) => (
  `(${sqlString(table)},${sqlString(constraint)})`
));
const indexRows = REQUIRED_INDEXES.map(([table, index, unique, definition]) => (
  `(${sqlString(table)},${sqlString(index)},${unique ? 'TRUE' : 'FALSE'},${sqlString(definition)})`
));
const triggerRows = REQUIRED_TRIGGERS.map(([
  table, trigger, type, functionName, functionSource, definition,
]) => (
  `(${sqlString(table)},${sqlString(trigger)},${type},${sqlString(functionName)},${sqlString(functionSource)},${sqlString(definition)})`
));
const privilegeRows = Object.entries(TABLE_PRIVILEGES).flatMap(([table, privileges]) => (
  Object.entries(privileges).map(([privilege, expected]) => (
    `(${sqlString(table)},${sqlString(privilege)},${expected ? 'TRUE' : 'FALSE'})`
  ))
));

const ATTENDANCE_SCHEMA_READINESS_SQL = `
WITH required_columns(table_name, column_name, data_type, is_not_null) AS (
  VALUES ${columnRows.join(',\n    ')}
), required_constraints(table_name, constraint_name) AS (
  VALUES ${constraintRows.join(',\n    ')}
), required_indexes(table_name, index_name, is_unique, definition) AS (
  VALUES ${indexRows.join(',\n    ')}
), required_triggers(table_name, trigger_name, trigger_type, function_name, function_source, definition) AS (
  VALUES ${triggerRows.join(',\n    ')}
), required_privileges(table_name, privilege_name, expected) AS (
  VALUES ${privilegeRows.join(',\n    ')}
), missing AS (
  SELECT 'column-definition:' || expected.table_name || '.' || expected.column_name AS requirement
    FROM required_columns expected
    LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
    LEFT JOIN pg_class relation
      ON relation.relnamespace = namespace.oid
     AND relation.relname = expected.table_name
     AND relation.relkind IN ('r', 'p')
    LEFT JOIN pg_attribute actual
      ON actual.attrelid = relation.oid
     AND actual.attname = expected.column_name
     AND actual.attnum > 0
     AND NOT actual.attisdropped
   WHERE actual.attnum IS NULL
      OR format_type(actual.atttypid, actual.atttypmod) <> expected.data_type
      OR actual.attnotnull <> expected.is_not_null
  UNION ALL
  SELECT 'constraint:' || expected.table_name || '.' || expected.constraint_name
    FROM required_constraints expected
    LEFT JOIN pg_constraint actual
      ON actual.connamespace = 'public'::regnamespace
     AND actual.conrelid = to_regclass('public.' || expected.table_name)
     AND actual.conname = expected.constraint_name
   WHERE actual.oid IS NULL OR actual.convalidated IS NOT TRUE
  UNION ALL
  SELECT 'index-definition:' || expected.table_name || '.' || expected.index_name
    FROM required_indexes expected
    LEFT JOIN pg_indexes actual
      ON actual.schemaname = 'public'
     AND actual.tablename = expected.table_name
     AND actual.indexname = expected.index_name
    LEFT JOIN pg_class index_relation
      ON index_relation.relnamespace = 'public'::regnamespace
     AND index_relation.relname = expected.index_name
    LEFT JOIN pg_index index_catalog ON index_catalog.indexrelid = index_relation.oid
   WHERE actual.indexname IS NULL
      OR index_catalog.indisvalid IS NOT TRUE
      OR index_catalog.indisready IS NOT TRUE
      OR index_catalog.indisunique <> expected.is_unique
      OR regexp_replace(btrim(actual.indexdef), '\\s+', ' ', 'g')
         <> regexp_replace(btrim(expected.definition), '\\s+', ' ', 'g')
  UNION ALL
  SELECT 'trigger-definition:' || expected.table_name || '.' || expected.trigger_name
    FROM required_triggers expected
    LEFT JOIN pg_trigger actual
      ON actual.tgrelid = to_regclass('public.' || expected.table_name)
     AND actual.tgname = expected.trigger_name
     AND NOT actual.tgisinternal
    LEFT JOIN pg_proc trigger_function ON trigger_function.oid = actual.tgfoid
    LEFT JOIN pg_namespace function_namespace ON function_namespace.oid = trigger_function.pronamespace
   WHERE actual.oid IS NULL
      OR actual.tgenabled <> 'O'
      OR actual.tgtype <> expected.trigger_type
      OR actual.tgqual IS NOT NULL
      OR actual.tgattr::text <> ''
      OR function_namespace.nspname <> 'public'
      OR trigger_function.proname <> expected.function_name
      OR trigger_function.prosecdef IS NOT FALSE
      OR btrim(regexp_replace(btrim(trigger_function.prosrc), '\\s+', ' ', 'g'))
         <> btrim(regexp_replace(btrim(expected.function_source), '\\s+', ' ', 'g'))
      OR regexp_replace(btrim(pg_get_triggerdef(actual.oid)), '\\s+', ' ', 'g')
         <> regexp_replace(btrim(expected.definition), '\\s+', ' ', 'g')
  UNION ALL
  SELECT 'legacy-global-unique:attendance.attendance_user_id_attendance_date_key'
   WHERE EXISTS (
     SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.attendance'::regclass
        AND conname = 'attendance_user_id_attendance_date_key'
   )
  UNION ALL
  SELECT 'backfill-state:attendance-workspace-backfill-v1'
   WHERE NOT EXISTS (
     SELECT 1 FROM public.peakos_workspace_bootstrap_state
      WHERE key = 'attendance-workspace-backfill-v1'
        AND (metadata->>'totalRows')::bigint
            = (metadata->>'directMembershipRows')::bigint
              + (metadata->>'groupLineageRows')::bigint
        AND (metadata->>'unmappedOrAmbiguousRows')::bigint = 0
   )
  UNION ALL
  SELECT 'tenant-null-or-orphan:attendance'
   WHERE EXISTS (
     SELECT 1
       FROM public.attendance attendance_row
       LEFT JOIN public.peakos_workspaces workspace
         ON workspace.id = attendance_row.workspace_id
      WHERE attendance_row.workspace_id IS NULL OR workspace.id IS NULL
   )
  UNION ALL
  SELECT 'time-projection:attendance'
   WHERE EXISTS (
     SELECT 1 FROM public.attendance
      WHERE check_in_at IS NULL
         OR check_in <> to_char(check_in_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI')
         OR attendance_date <> to_char(check_in_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')
         OR (check_out IS NULL) <> (check_out_at IS NULL)
   )
  UNION ALL
  SELECT 'table-privilege:' || expected.table_name || '.' || expected.privilege_name
    FROM required_privileges expected
   WHERE has_table_privilege(
           current_user,
           format('public.%I', expected.table_name),
           expected.privilege_name
         ) <> expected.expected
  UNION ALL
  SELECT 'sequence-privilege:peakos_attendance_events_id_seq.USAGE'
   WHERE has_sequence_privilege(
           current_user, 'public.peakos_attendance_events_id_seq', 'USAGE'
         ) IS NOT TRUE
  UNION ALL
  SELECT 'sequence-privilege:peakos_attendance_events_id_seq.SELECT'
   WHERE has_sequence_privilege(
           current_user, 'public.peakos_attendance_events_id_seq', 'SELECT'
         ) IS NOT FALSE
  UNION ALL
  SELECT 'sequence-privilege:peakos_attendance_events_id_seq.UPDATE'
   WHERE has_sequence_privilege(
           current_user, 'public.peakos_attendance_events_id_seq', 'UPDATE'
         ) IS NOT FALSE
)
SELECT COALESCE(array_agg(requirement ORDER BY requirement), ARRAY[]::text[]) AS missing
  FROM missing
`;

class AttendanceInfrastructureError extends Error {
  constructor(missing) {
    super(`근태 저장소 준비가 필요합니다 (${ATTENDANCE_MIGRATION_FILE}).`);
    this.name = 'AttendanceInfrastructureError';
    this.code = 'ATTENDANCE_SCHEMA_NOT_READY';
    this.statusCode = 503;
    this.missing = Object.freeze([...(missing || [])]);
  }
}

async function ensurePeakosAttendanceInfrastructure(pool) {
  let result;
  try {
    result = await pool.query(ATTENDANCE_SCHEMA_READINESS_SQL);
  } catch (error) {
    const safe = new AttendanceInfrastructureError(['readiness-query']);
    safe.cause = error;
    throw safe;
  }
  const missing = result?.rows?.[0]?.missing || [];
  if (missing.length) throw new AttendanceInfrastructureError(missing);
  return true;
}

module.exports = {
  ATTENDANCE_GUARD_SOURCE,
  ATTENDANCE_MIGRATION_FILE,
  ATTENDANCE_SCHEMA_READINESS_SQL,
  AttendanceInfrastructureError,
  ensurePeakosAttendanceInfrastructure,
};
