'use strict';

const path = require('node:path');
const {
  PeakosEventChecklistDirectiveError,
  assertChecklistMutationAllowed,
  internalCalendarRuleEventSql,
  normalizeChecklistCreateBody,
  normalizeChecklistUpdateBody,
  normalizeIdentifier,
  normalizeInstructionDateRange,
  normalizeInstructorUid,
} = require('./peakos-event-checklist-policy');

const DIRECTIVE_TABLE = 'peakos_event_checklist_directives';
const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  'migrations',
  '20260817_peakos_event_checklist_directives.sql',
);

const DIRECTIVE_REQUIRED_COLUMN_DEFINITIONS = Object.freeze({
  workspace_id: Object.freeze(['text', true, null]),
  event_id: Object.freeze(['text', true, null]),
  checklist_item_id: Object.freeze(['text', true, null]),
  instructor_uid: Object.freeze(['text', true, null]),
  instructor_name_snapshot: Object.freeze(['text', true, null]),
  recorded_by_uid: Object.freeze(['text', true, null]),
  recorded_by_name_snapshot: Object.freeze(['text', true, null]),
  version: Object.freeze(['integer', true, '1']),
  created_at: Object.freeze(['timestamp with time zone', true, 'now()']),
  updated_at: Object.freeze(['timestamp with time zone', true, 'now()']),
});

const DIRECTIVE_REQUIRED_CONSTRAINTS = Object.freeze([
  Object.freeze(['peakos_event_checklist_directives_pkey', 'p',
    'PRIMARY KEY (workspace_id, checklist_item_id)']),
  Object.freeze(['peakos_event_checklist_directives_workspace_fk', 'f',
    'FOREIGN KEY (workspace_id) REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT']),
  Object.freeze(['peakos_event_checklist_directives_event_fk', 'f',
    'FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE RESTRICT ON DELETE CASCADE']),
  Object.freeze(['peakos_event_checklist_directives_item_fk', 'f',
    'FOREIGN KEY (checklist_item_id) REFERENCES event_checklist(id) ON UPDATE RESTRICT ON DELETE CASCADE']),
  Object.freeze(['peakos_event_checklist_directives_instructor_membership_fk', 'f',
    'FOREIGN KEY (workspace_id, instructor_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT']),
  Object.freeze(['peakos_event_checklist_directives_recorder_membership_fk', 'f',
    'FOREIGN KEY (workspace_id, recorded_by_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT']),
  Object.freeze(['peakos_event_checklist_directives_event_id_check', 'c',
    'CHECK (((char_length(btrim(event_id)) >= 1) AND (char_length(btrim(event_id)) <= 200)))']),
  Object.freeze(['peakos_event_checklist_directives_item_id_check', 'c',
    'CHECK (((char_length(btrim(checklist_item_id)) >= 1) AND (char_length(btrim(checklist_item_id)) <= 200)))']),
  Object.freeze(['peakos_event_checklist_directives_instructor_uid_check', 'c',
    'CHECK (((char_length(btrim(instructor_uid)) >= 1) AND (char_length(btrim(instructor_uid)) <= 200)))']),
  Object.freeze(['peakos_event_checklist_directives_instructor_name_check', 'c',
    'CHECK (((char_length(btrim(instructor_name_snapshot)) >= 1) AND (char_length(btrim(instructor_name_snapshot)) <= 240)))']),
  Object.freeze(['peakos_event_checklist_directives_recorder_uid_check', 'c',
    'CHECK (((char_length(btrim(recorded_by_uid)) >= 1) AND (char_length(btrim(recorded_by_uid)) <= 200)))']),
  Object.freeze(['peakos_event_checklist_directives_recorder_name_check', 'c',
    'CHECK (((char_length(btrim(recorded_by_name_snapshot)) >= 1) AND (char_length(btrim(recorded_by_name_snapshot)) <= 240)))']),
  Object.freeze(['peakos_event_checklist_directives_version_check', 'c',
    'CHECK ((version >= 1))']),
]);

const DIRECTIVE_TRIGGER_FUNCTION_SOURCES = Object.freeze({
  peakos_event_checklist_directive_assert_parent: `
DECLARE
  actual_event_id TEXT;
  actual_workspace_id TEXT;
  actual_event_is_project BOOLEAN;
BEGIN
  SELECT checklist_row.event_id,
         COALESCE(event_row.workspace_id, 'ws_peak'),
         event_row.project_id IS NOT NULL
    INTO actual_event_id, actual_workspace_id, actual_event_is_project
    FROM public.events event_row
    JOIN public.event_checklist checklist_row ON checklist_row.event_id = event_row.id
   WHERE checklist_row.id = NEW.checklist_item_id
   FOR UPDATE OF event_row, checklist_row;

  IF actual_event_id IS NULL
     OR actual_event_id IS DISTINCT FROM NEW.event_id
     OR actual_workspace_id IS DISTINCT FROM NEW.workspace_id
     OR actual_event_is_project THEN
    RAISE EXCEPTION
      'checklist item % is not attached to event % in workspace %',
      NEW.checklist_item_id, NEW.event_id, NEW.workspace_id
      USING ERRCODE = '23503',
            CONSTRAINT = 'peakos_event_checklist_directives_parent_workspace_fk';
  END IF;
  RETURN NEW;
END
`.trim(),
  peakos_event_preserve_checklist_directives: `
BEGIN
  IF EXISTS (
    SELECT 1
     FROM public.peakos_event_checklist_directives directive
     WHERE directive.event_id = NEW.id
       AND (
         directive.workspace_id IS DISTINCT FROM COALESCE(NEW.workspace_id, 'ws_peak')
         OR NEW.project_id IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION 'event % workspace conflicts with a checklist directive', NEW.id
      USING ERRCODE = '23503',
            CONSTRAINT = 'peakos_event_checklist_directives_parent_workspace_fk';
  END IF;
  RETURN NEW;
END
`.trim(),
  peakos_checklist_item_preserve_directive_parent: `
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.peakos_event_checklist_directives directive
     WHERE directive.checklist_item_id = NEW.id
       AND directive.event_id IS DISTINCT FROM NEW.event_id
  ) THEN
    RAISE EXCEPTION 'checklist item % event conflicts with a checklist directive', NEW.id
      USING ERRCODE = '23503',
            CONSTRAINT = 'peakos_event_checklist_directives_parent_workspace_fk';
  END IF;
  RETURN NEW;
END
`.trim(),
  peakos_event_checklist_directive_touch_updated_at: `
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END
`.trim(),
});

const DIRECTIVE_REQUIRED_TRIGGERS = Object.freeze([
  Object.freeze([
    'peakos_event_checklist_directives',
    'peakos_event_checklist_directives_parent_guard',
    'peakos_event_checklist_directive_assert_parent',
    23,
    Object.freeze(['workspace_id', 'event_id', 'checklist_item_id']),
    false,
    'CREATE TRIGGER peakos_event_checklist_directives_parent_guard BEFORE INSERT OR UPDATE OF workspace_id, event_id, checklist_item_id ON public.peakos_event_checklist_directives FOR EACH ROW EXECUTE FUNCTION peakos_event_checklist_directive_assert_parent()',
  ]),
  Object.freeze([
    'peakos_event_checklist_directives',
    'peakos_event_checklist_directives_touch_updated_at',
    'peakos_event_checklist_directive_touch_updated_at',
    19,
    Object.freeze([]),
    false,
    'CREATE TRIGGER peakos_event_checklist_directives_touch_updated_at BEFORE UPDATE ON public.peakos_event_checklist_directives FOR EACH ROW EXECUTE FUNCTION peakos_event_checklist_directive_touch_updated_at()',
  ]),
  Object.freeze([
    'events',
    'peakos_events_checklist_directive_workspace_guard',
    'peakos_event_preserve_checklist_directives',
    19,
    Object.freeze(['workspace_id', 'project_id']),
    true,
    'CREATE TRIGGER peakos_events_checklist_directive_workspace_guard BEFORE UPDATE OF workspace_id, project_id ON public.events FOR EACH ROW WHEN (((old.workspace_id IS DISTINCT FROM new.workspace_id) OR (old.project_id IS DISTINCT FROM new.project_id))) EXECUTE FUNCTION peakos_event_preserve_checklist_directives()',
  ]),
  Object.freeze([
    'event_checklist',
    'peakos_event_checklist_directive_event_guard',
    'peakos_checklist_item_preserve_directive_parent',
    19,
    Object.freeze(['event_id']),
    true,
    'CREATE TRIGGER peakos_event_checklist_directive_event_guard BEFORE UPDATE OF event_id ON public.event_checklist FOR EACH ROW WHEN ((old.event_id IS DISTINCT FROM new.event_id)) EXECUTE FUNCTION peakos_checklist_item_preserve_directive_parent()',
  ]),
]);

const DIRECTIVE_REQUIRED_INDEXES = Object.freeze([
  Object.freeze([
    'peakos_event_checklist_directives_inbox_idx',
    Object.freeze(['workspace_id', 'instructor_uid', 'event_id', 'checklist_item_id']),
    'CREATE INDEX peakos_event_checklist_directives_inbox_idx ON public.peakos_event_checklist_directives USING btree (workspace_id, instructor_uid, event_id, checklist_item_id)',
  ]),
  Object.freeze([
    'peakos_event_checklist_directives_event_idx',
    Object.freeze(['event_id']),
    'CREATE INDEX peakos_event_checklist_directives_event_idx ON public.peakos_event_checklist_directives USING btree (event_id)',
  ]),
]);

const DIRECTIVE_TABLE_PRIVILEGES = Object.freeze({
  SELECT: true,
  INSERT: true,
  UPDATE: true,
  DELETE: true,
  TRUNCATE: false,
  REFERENCES: false,
  TRIGGER: false,
});

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const directiveColumnRows = Object.entries(DIRECTIVE_REQUIRED_COLUMN_DEFINITIONS)
  .map(([column, [type, notNull, defaultExpression]]) => (
    `(${sqlString(column)},${sqlString(type)},${notNull ? 'TRUE' : 'FALSE'},${
      defaultExpression === null ? 'FALSE' : 'TRUE'
    },${sqlString(defaultExpression || '')})`
  ));
const directiveConstraintRows = DIRECTIVE_REQUIRED_CONSTRAINTS
  .map(([name, type, definition]) => (
    `(${sqlString(name)},${sqlString(type)},${sqlString(definition)})`
  ));
const directiveFunctionRows = Object.entries(DIRECTIVE_TRIGGER_FUNCTION_SOURCES)
  .map(([name, source]) => `(${sqlString(name)},${sqlString(source)})`);
const directiveTriggerRows = DIRECTIVE_REQUIRED_TRIGGERS
  .map(([table, name, functionName, type, columns, hasQual, definition]) => (
    `(${sqlString(table)},${sqlString(name)},${sqlString(functionName)},${type},ARRAY[${
      columns.map(sqlString).join(',')
    }]::text[],${hasQual ? 'TRUE' : 'FALSE'},${sqlString(definition)})`
  ));
const directiveIndexRows = DIRECTIVE_REQUIRED_INDEXES
  .map(([name, columns, definition]) => (
    `(${sqlString(name)},ARRAY[${columns.map(sqlString).join(',')}]::text[],${sqlString(definition)})`
  ));
const directivePrivilegeRows = Object.entries(DIRECTIVE_TABLE_PRIVILEGES)
  .map(([privilege, expected]) => (
    `(${sqlString(privilege)},${expected ? 'TRUE' : 'FALSE'})`
  ));

const DIRECTIVE_SCHEMA_READINESS_SQL = `
WITH required_columns(column_name, data_type, is_not_null, has_default, default_expression) AS (
  VALUES ${directiveColumnRows.join(',\n    ')}
), required_constraints(constraint_name, constraint_type, definition) AS (
  VALUES ${directiveConstraintRows.join(',\n    ')}
), required_functions(function_name, source) AS (
  VALUES ${directiveFunctionRows.join(',\n    ')}
), required_triggers(
  table_name, trigger_name, function_name, trigger_type,
  trigger_columns, has_qualifier, definition
) AS (
  VALUES ${directiveTriggerRows.join(',\n    ')}
), required_indexes(index_name, indexed_columns, definition) AS (
  VALUES ${directiveIndexRows.join(',\n    ')}
), required_table_privileges(privilege_name, expected) AS (
  VALUES ${directivePrivilegeRows.join(',\n    ')}
), runtime_role AS (
  SELECT current_user AS role_name, role_row.oid AS role_oid
    FROM pg_roles role_row
   WHERE role_row.rolname = current_user
), directive_relation AS (
  SELECT relation.oid, relation.relowner, relation.relacl
    FROM pg_namespace namespace
    JOIN pg_class relation
      ON relation.relnamespace = namespace.oid
     AND relation.relname = 'peakos_event_checklist_directives'
     AND relation.relkind IN ('r', 'p')
   WHERE namespace.nspname = 'public'
), missing AS (
  SELECT 'column-definition:peakos_event_checklist_directives.' || expected.column_name AS requirement
    FROM required_columns expected
    LEFT JOIN directive_relation relation ON TRUE
    LEFT JOIN pg_attribute actual
      ON actual.attrelid = relation.oid
     AND actual.attname = expected.column_name
     AND actual.attnum > 0
     AND NOT actual.attisdropped
    LEFT JOIN pg_attrdef column_default
      ON column_default.adrelid = actual.attrelid
     AND column_default.adnum = actual.attnum
   WHERE actual.attnum IS NULL
      OR format_type(actual.atttypid, actual.atttypmod) <> expected.data_type
      OR actual.attnotnull <> expected.is_not_null
      OR actual.atthasdef <> expected.has_default
      OR COALESCE(pg_get_expr(column_default.adbin, column_default.adrelid), '')
         <> expected.default_expression
      OR actual.attidentity <> ''
      OR actual.attgenerated <> ''
  UNION ALL
  SELECT 'constraint-definition:peakos_event_checklist_directives.' || expected.constraint_name
    FROM required_constraints expected
    LEFT JOIN directive_relation relation ON TRUE
    LEFT JOIN pg_constraint actual
      ON actual.conrelid = relation.oid
     AND actual.conname = expected.constraint_name
   WHERE actual.oid IS NULL
      OR actual.contype::text <> expected.constraint_type
      OR actual.convalidated IS NOT TRUE
      OR actual.condeferrable IS NOT FALSE
      OR actual.condeferred IS NOT FALSE
      OR regexp_replace(
           replace(pg_get_constraintdef(actual.oid), 'REFERENCES public.', 'REFERENCES '),
           '\\s+', ' ', 'g'
         ) <> regexp_replace(expected.definition, '\\s+', ' ', 'g')
  UNION ALL
  SELECT 'function-definition:' || expected.function_name
    FROM required_functions expected
    LEFT JOIN pg_namespace function_namespace ON function_namespace.nspname = 'public'
    LEFT JOIN pg_proc actual
      ON actual.pronamespace = function_namespace.oid
     AND actual.proname = expected.function_name
     AND actual.pronargs = 0
    LEFT JOIN pg_language function_language ON function_language.oid = actual.prolang
   WHERE actual.oid IS NULL
      OR actual.prorettype <> 'trigger'::regtype
      OR actual.prokind <> 'f'
      OR actual.provolatile <> 'v'
      OR actual.prosecdef IS NOT FALSE
      OR function_language.lanname <> 'plpgsql'
      OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
      OR btrim(regexp_replace(actual.prosrc, '\\s+', ' ', 'g'))
         <> btrim(regexp_replace(expected.source, '\\s+', ' ', 'g'))
  UNION ALL
  SELECT 'trigger-definition:' || expected.table_name || '.' || expected.trigger_name
    FROM required_triggers expected
    LEFT JOIN pg_namespace table_namespace ON table_namespace.nspname = 'public'
    LEFT JOIN pg_class relation
      ON relation.relnamespace = table_namespace.oid
     AND relation.relname = expected.table_name
     AND relation.relkind IN ('r', 'p')
    LEFT JOIN pg_trigger actual
      ON actual.tgrelid = relation.oid
     AND actual.tgname = expected.trigger_name
     AND NOT actual.tgisinternal
    LEFT JOIN pg_proc trigger_function ON trigger_function.oid = actual.tgfoid
    LEFT JOIN pg_namespace function_namespace ON function_namespace.oid = trigger_function.pronamespace
   WHERE actual.oid IS NULL
      OR actual.tgenabled <> 'O'
      OR actual.tgtype::integer <> expected.trigger_type
      OR actual.tgdeferrable IS NOT FALSE
      OR actual.tginitdeferred IS NOT FALSE
      OR actual.tgnargs <> 0
      OR actual.tgconstraint <> 0
      OR function_namespace.nspname <> 'public'
      OR trigger_function.proname <> expected.function_name
      OR expected.trigger_columns <> COALESCE((
           SELECT array_agg(attribute.attname::text ORDER BY key_position.ordinality)
             FROM unnest(actual.tgattr) WITH ORDINALITY key_position(attribute_number, ordinality)
             JOIN pg_attribute attribute
               ON attribute.attrelid = actual.tgrelid
              AND attribute.attnum = key_position.attribute_number
         ), ARRAY[]::text[])
      OR (actual.tgqual IS NOT NULL) <> expected.has_qualifier
      OR regexp_replace(
           replace(pg_get_triggerdef(actual.oid), 'EXECUTE FUNCTION public.', 'EXECUTE FUNCTION '),
           '\\s+', ' ', 'g'
         ) <> regexp_replace(expected.definition, '\\s+', ' ', 'g')
  UNION ALL
  SELECT 'index-definition:peakos_event_checklist_directives.' || expected.index_name
    FROM required_indexes expected
    LEFT JOIN directive_relation table_relation ON TRUE
    LEFT JOIN pg_namespace index_namespace ON index_namespace.nspname = 'public'
    LEFT JOIN pg_class index_relation
      ON index_relation.relnamespace = index_namespace.oid
     AND index_relation.relname = expected.index_name
     AND index_relation.relkind = 'i'
    LEFT JOIN pg_am index_method ON index_method.oid = index_relation.relam
    LEFT JOIN pg_index actual
      ON actual.indexrelid = index_relation.oid
     AND actual.indrelid = table_relation.oid
   WHERE actual.indexrelid IS NULL
      OR index_method.amname <> 'btree'
      OR actual.indisunique IS NOT FALSE
      OR actual.indisprimary IS NOT FALSE
      OR actual.indisexclusion IS NOT FALSE
      OR actual.indimmediate IS NOT TRUE
      OR actual.indisvalid IS NOT TRUE
      OR actual.indisready IS NOT TRUE
      OR actual.indislive IS NOT TRUE
      OR actual.indnkeyatts <> cardinality(expected.indexed_columns)
      OR actual.indnatts <> cardinality(expected.indexed_columns)
      OR expected.indexed_columns <> (
           SELECT array_agg(attribute.attname::text ORDER BY key_position.ordinality)
             FROM unnest(actual.indkey) WITH ORDINALITY key_position(attribute_number, ordinality)
             JOIN pg_attribute attribute
               ON attribute.attrelid = actual.indrelid
              AND attribute.attnum = key_position.attribute_number
            WHERE key_position.ordinality <= actual.indnkeyatts
         )
      OR actual.indpred IS NOT NULL
      OR actual.indexprs IS NOT NULL
      OR EXISTS (SELECT 1 FROM unnest(actual.indoption) option_value WHERE option_value <> 0)
      OR regexp_replace(pg_get_indexdef(actual.indexrelid), '\\s+', ' ', 'g')
         <> regexp_replace(expected.definition, '\\s+', ' ', 'g')
  UNION ALL
  SELECT 'runtime-role:missing-or-invalid'
    FROM runtime_role runtime
   WHERE runtime.role_name IS NULL OR runtime.role_oid IS NULL
  UNION ALL
  SELECT 'table-privilege:peakos_event_checklist_directives.' || expected.privilege_name
    FROM required_table_privileges expected
    CROSS JOIN runtime_role runtime
   WHERE COALESCE(
     has_table_privilege(
       runtime.role_oid,
       to_regclass('public.peakos_event_checklist_directives'),
       expected.privilege_name
     ),
     FALSE
   ) <> expected.expected
  UNION ALL
  SELECT 'public-table-privilege:peakos_event_checklist_directives.' || acl.privilege_type
    FROM directive_relation relation
    CROSS JOIN LATERAL aclexplode(
      COALESCE(relation.relacl, acldefault('r', relation.relowner))
    ) acl
   WHERE acl.grantee = 0
  UNION ALL
  SELECT 'function-privilege:' || expected.function_name || '.execute'
    FROM required_functions expected
    CROSS JOIN runtime_role runtime
    LEFT JOIN pg_namespace function_namespace ON function_namespace.nspname = 'public'
    LEFT JOIN pg_proc actual
      ON actual.pronamespace = function_namespace.oid
     AND actual.proname = expected.function_name
     AND actual.pronargs = 0
   WHERE actual.oid IS NULL
      OR COALESCE(has_function_privilege(runtime.role_oid, actual.oid, 'EXECUTE'), FALSE)
  UNION ALL
  SELECT 'public-function-privilege:' || expected.function_name || '.execute'
    FROM required_functions expected
    LEFT JOIN pg_namespace function_namespace ON function_namespace.nspname = 'public'
    LEFT JOIN pg_proc actual
      ON actual.pronamespace = function_namespace.oid
     AND actual.proname = expected.function_name
     AND actual.pronargs = 0
   WHERE actual.oid IS NULL OR EXISTS (
     SELECT 1
       FROM aclexplode(COALESCE(actual.proacl, acldefault('f', actual.proowner))) acl
      WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
   )
)
SELECT NOT EXISTS (SELECT 1 FROM missing) AS ready,
       COALESCE(array_agg(requirement ORDER BY requirement)
         FILTER (WHERE requirement IS NOT NULL), ARRAY[]::text[]) AS missing_requirements
  FROM missing
`.trim();

function httpError(statusCode, code, message) {
  return new PeakosEventChecklistDirectiveError(statusCode, code, message);
}

function infrastructureError(missing = []) {
  const error = new Error(
    `OS 체크리스트 지시자 migration이 필요합니다: ${path.basename(MIGRATION_PATH)}`,
  );
  error.code = 'PEAKOS_CHECKLIST_DIRECTIVE_SCHEMA_NOT_READY';
  error.statusCode = 503;
  error.missing = missing;
  return error;
}

async function ensurePeakosEventChecklistDirectiveInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  const result = await pool.query(DIRECTIVE_SCHEMA_READINESS_SQL);
  const row = result.rows[0] || {};
  if (row.ready !== true) throw infrastructureError(row.missing_requirements || []);
  return true;
}

function sendDirectiveError(res, error) {
  const missingMigration = ['42P01', '42703', '42704'].includes(String(error?.code || ''));
  const status = missingMigration ? 503 : Number(error?.statusCode || error?.status) || 500;
  const code = missingMigration
    ? 'PEAKOS_CHECKLIST_DIRECTIVE_SCHEMA_NOT_READY'
    : String(error?.code || 'PEAKOS_CHECKLIST_DIRECTIVE_ERROR');
  const message = status >= 500
    ? (missingMigration
      ? `OS 체크리스트 지시자 migration이 필요합니다: ${path.basename(MIGRATION_PATH)}`
      : 'OS 체크리스트를 처리하지 못했습니다.')
    : error.message;
  return res.status(status).json({ code, error: message });
}

function workspaceId(req, workspaceIdForRequest) {
  return normalizeIdentifier(workspaceIdForRequest(req), '워크스페이스');
}

function actorName(req) {
  return String(req?.userDoc?.name || req?.userName || '사용자').trim().slice(0, 240) || '사용자';
}

function checklistCapabilities(req, ownerUid) {
  const mutable = String(req?.uid || '') === String(ownerUid || '')
    || req?.userDoc?.role === 'admin'
    || req?.workspace?.role === 'admin';
  return { toggle: mutable, edit: mutable, delete: mutable };
}

function mapChecklistItem(row, { req, ownerUid } = {}) {
  if (!row) return null;
  const mapped = {
    id: String(row.id),
    event_id: String(row.event_id),
    title: row.title,
    sort_order: Number(row.sort_order || 0),
    done: row.done === true,
    created_at: row.created_at || null,
    instructor: row.instructor_uid ? {
      uid: String(row.instructor_uid),
      name: String(row.instructor_name_snapshot || ''),
    } : null,
    directiveVersion: row.directive_version == null ? null : Number(row.directive_version),
    capabilities: checklistCapabilities(req, ownerUid || row.owner_id),
  };
  return mapped;
}

const enrichChecklistItemResponse = mapChecklistItem;

function mapInstruction(row) {
  return {
    id: String(row.checklist_item_id),
    title: row.checklist_title,
    done: row.checklist_done === true,
    sortOrder: Number(row.checklist_sort_order || 0),
    directiveVersion: Number(row.directive_version || 1),
    updatedAt: row.directive_updated_at || null,
    event: {
      id: String(row.event_id),
      title: row.event_title,
      date: row.event_date,
      time: row.event_time || '',
      endTime: row.event_end_time || '',
      owner: {
        uid: String(row.event_owner_uid),
        name: String(row.event_owner_name || ''),
      },
    },
    assignedBy: {
      uid: String(row.recorded_by_uid),
      name: String(row.recorded_by_name_snapshot || ''),
    },
    capabilities: { toggle: false, edit: false, delete: false },
  };
}

async function findEligibleWorkspaceUser(db, selectedWorkspaceId, uid) {
  const normalizedUid = normalizeInstructorUid(uid);
  const result = await db.query(
    `SELECT user_row.uid,
            user_row.name,
            COALESCE(user_row.external_calendar_only, FALSE) AS external_calendar_only,
            COALESCE(user_row.chat_only, FALSE) AS chat_only,
            user_row.role AS user_role,
            workspace.slug AS workspace_slug
       FROM peakos_workspace_memberships membership
       JOIN users user_row ON user_row.uid = membership.user_uid
       JOIN peakos_workspaces workspace ON workspace.id = membership.workspace_id
      WHERE membership.workspace_id = $1
        AND membership.user_uid = $2
        AND membership.active = TRUE
        AND membership.role <> 'oversight'
        AND COALESCE(membership.permissions ->> 'calendar', 'none') IN ('read', 'write')
        AND user_row.approved = TRUE
        AND COALESCE(user_row.is_active, TRUE) = TRUE
        AND NOT (
          COALESCE(user_row.chat_only, FALSE) = TRUE
          AND COALESCE(user_row.external_calendar_only, FALSE) = FALSE
        )
        AND workspace.active = TRUE
        AND char_length(btrim(COALESCE(user_row.name, ''))) BETWEEN 1 AND 240
      LIMIT 1`,
    [selectedWorkspaceId, normalizedUid],
  );
  const row = result.rows[0];
  return row ? {
    uid: String(row.uid),
    name: String(row.name).trim(),
    workspaceSlug: String(row.workspace_slug || ''),
    externalCalendarOnly: row.external_calendar_only === true,
    chatOnly: row.chat_only === true,
    role: String(row.user_role || ''),
  } : null;
}

async function resolveCanonicalInstructor(db, selectedWorkspaceId, uid) {
  const instructor = await findEligibleWorkspaceUser(db, selectedWorkspaceId, uid);
  if (!instructor) {
    throw httpError(
      400,
      'PEAKOS_CHECKLIST_INSTRUCTOR_INVALID',
      '현재 워크스페이스의 승인된 활성 구성원만 지시자로 선택할 수 있습니다.',
    );
  }
  return instructor;
}

async function resolveCanonicalActor(db, selectedWorkspaceId, req) {
  const actor = await findEligibleWorkspaceUser(db, selectedWorkspaceId, req.uid);
  if (!actor) {
    throw httpError(403, 'PEAKOS_CHECKLIST_ACTOR_FORBIDDEN', '현재 워크스페이스의 활성 구성원만 접근할 수 있습니다.');
  }
  return actor;
}

async function listEligibleInstructors(db, selectedWorkspaceId, {
  callerUid = '',
  restrictedDirectory = false,
} = {}) {
  const result = await db.query(
    `SELECT user_row.uid, user_row.name
       FROM peakos_workspace_memberships membership
       JOIN users user_row ON user_row.uid = membership.user_uid
       JOIN peakos_workspaces workspace ON workspace.id = membership.workspace_id
      WHERE membership.workspace_id = $1
        AND membership.active = TRUE
        AND membership.role <> 'oversight'
        AND COALESCE(membership.permissions ->> 'calendar', 'none') IN ('read', 'write')
        AND user_row.approved = TRUE
        AND COALESCE(user_row.is_active, TRUE) = TRUE
        AND NOT (
          COALESCE(user_row.chat_only, FALSE) = TRUE
          AND COALESCE(user_row.external_calendar_only, FALSE) = FALSE
        )
        AND workspace.active = TRUE
        AND char_length(btrim(COALESCE(user_row.name, ''))) BETWEEN 1 AND 240
        AND ($2::boolean = FALSE OR user_row.uid = $3 OR user_row.role = 'admin')
      ORDER BY user_row.name, user_row.uid`,
    [selectedWorkspaceId, restrictedDirectory === true, String(callerUid || '')],
  );
  return result.rows.map(row => ({ uid: String(row.uid), name: String(row.name).trim() }));
}

async function listInstructionInbox(db, {
  req,
  selectedWorkspaceId,
  from,
  to,
  peakWorkspaceId = 'ws_peak',
  eventHiddenPredicate,
}) {
  const hidden = eventHiddenPredicate(req, { eventAlias: 'event_row', workspaceParameter: 1 });
  const internalVisibility = req.userDoc?.external_calendar_only
    ? ` AND NOT ${internalCalendarRuleEventSql('event_row')}`
    : '';
  const result = await db.query(
    `SELECT directive.checklist_item_id,
            checklist.title AS checklist_title,
            checklist.done AS checklist_done,
            checklist.sort_order AS checklist_sort_order,
            directive.version AS directive_version,
            directive.updated_at AS directive_updated_at,
            directive.recorded_by_uid,
            directive.recorded_by_name_snapshot,
            event_row.id AS event_id,
            event_row.title AS event_title,
            event_row.date AS event_date,
            event_row.time AS event_time,
            event_row.end_time AS event_end_time,
            event_row.owner_id AS event_owner_uid,
            event_row.owner_name AS event_owner_name
       FROM ${DIRECTIVE_TABLE} directive
       JOIN event_checklist checklist
         ON checklist.id = directive.checklist_item_id
        AND checklist.event_id = directive.event_id
       JOIN events event_row ON event_row.id = directive.event_id
       JOIN peakos_workspace_memberships current_membership
         ON current_membership.workspace_id = directive.workspace_id
        AND current_membership.user_uid = directive.instructor_uid
       JOIN users current_user ON current_user.uid = current_membership.user_uid
       JOIN peakos_workspaces current_workspace
         ON current_workspace.id = current_membership.workspace_id
      WHERE directive.workspace_id = $1
        AND directive.instructor_uid = $2
        AND current_membership.active = TRUE
        AND current_membership.role <> 'oversight'
        AND COALESCE(current_membership.permissions ->> 'calendar', 'none') IN ('read', 'write')
        AND current_user.approved = TRUE
        AND COALESCE(current_user.is_active, TRUE) = TRUE
        AND NOT (
          COALESCE(current_user.chat_only, FALSE) = TRUE
          AND COALESCE(current_user.external_calendar_only, FALSE) = FALSE
        )
        AND current_workspace.active = TRUE
        AND event_row.deleted = FALSE
        AND event_row.project_id IS NULL
        AND (event_row.workspace_id = $1 OR (event_row.workspace_id IS NULL AND $1 = $5))
        AND event_row.date BETWEEN $3 AND $4
        ${hidden}
        ${internalVisibility}
      ORDER BY event_row.date, NULLIF(event_row.time, ''), checklist.done, checklist.sort_order, checklist.id`,
    [selectedWorkspaceId, req.uid, from, to, peakWorkspaceId],
  );
  return result.rows.map(mapInstruction);
}

async function loadEventForMutation(client, {
  req,
  eventId,
  selectedWorkspaceId,
  peakWorkspaceId,
  eventHiddenPredicate,
}) {
  const hidden = eventHiddenPredicate(req, { eventAlias: 'event_row', workspaceParameter: 2 });
  const result = await client.query(
    `SELECT event_row.*,
            ${internalCalendarRuleEventSql('event_row')} AS is_internal_rule
       FROM events event_row
      WHERE event_row.id = $1
        AND event_row.deleted = FALSE
        AND (event_row.workspace_id = $2 OR (event_row.workspace_id IS NULL AND $2 = $3))
        ${hidden}
      FOR UPDATE`,
    [eventId, selectedWorkspaceId, peakWorkspaceId],
  );
  const loadedEvent = result.rows[0] || null;
  const event = req.userDoc?.external_calendar_only && loadedEvent?.is_internal_rule
    ? null
    : loadedEvent;
  assertChecklistMutationAllowed(req, event);
  return event;
}

function assertInstructorCanReceiveEvent(event, instructor) {
  if (instructor?.chatOnly && !instructor?.externalCalendarOnly) {
    throw httpError(
      400,
      'PEAKOS_CHECKLIST_INSTRUCTOR_EVENT_FORBIDDEN',
      '이 일정을 열람할 수 있는 구성원만 지시자로 선택할 수 있습니다.',
    );
  }
  if (event?.is_internal_rule && instructor?.externalCalendarOnly) {
    throw httpError(
      400,
      'PEAKOS_CHECKLIST_INSTRUCTOR_EVENT_FORBIDDEN',
      '이 일정을 열람할 수 있는 구성원만 지시자로 선택할 수 있습니다.',
    );
  }
  return instructor;
}

async function findNotificationRecipient(db, selectedWorkspaceId, event, uid) {
  if (!uid) return null;
  const recipient = await findEligibleWorkspaceUser(db, selectedWorkspaceId, uid);
  if (!recipient || (event?.is_internal_rule && recipient.externalCalendarOnly)) return null;
  return recipient;
}

function assertDirectiveTargetIsPersonal(event, instructorUid) {
  if (instructorUid && event?.project_id) {
    throw httpError(
      400,
      'PEAKOS_CHECKLIST_PROJECT_DIRECTIVE_FORBIDDEN',
      '프로젝트 업무는 프로젝트의 지시자·담당자·검토자 흐름에서 배정해 주세요.',
    );
  }
}

async function normalizeChecklistSortOrders(client, eventId) {
  await client.query(
    `WITH ranked AS (
       SELECT id,
              ROW_NUMBER() OVER (
                ORDER BY done DESC, sort_order ASC, created_at ASC, id ASC
              ) - 1 AS next_sort_order
         FROM event_checklist
        WHERE event_id = $1
     )
     UPDATE event_checklist checklist
        SET sort_order = ranked.next_sort_order
       FROM ranked
      WHERE checklist.id = ranked.id
        AND checklist.sort_order IS DISTINCT FROM ranked.next_sort_order`,
    [eventId],
  );
}

async function syncChecklistDrivenEventState(client, eventId) {
  const summary = await client.query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE done = TRUE) AS completed
       FROM event_checklist
      WHERE event_id = $1`,
    [eventId],
  );
  const total = Number(summary.rows[0]?.total || 0);
  const completed = Number(summary.rows[0]?.completed || 0);
  const done = total > 0 && total === completed;
  const kanbanStatus = done ? 'done' : (completed > 0 ? 'in_progress' : 'todo');
  const eventResult = await client.query(
    `UPDATE events
        SET done = $2, kanban_status = $3
      WHERE id = $1
      RETURNING *`,
    [eventId, done, kanbanStatus],
  );
  const event = eventResult.rows[0] || null;
  if (event?.project_id) {
    const projectSummary = await client.query(
      `SELECT COUNT(*) FILTER (WHERE deleted = FALSE) AS total,
              COUNT(*) FILTER (WHERE deleted = FALSE AND done = TRUE) AS completed
         FROM events
        WHERE project_id = $1`,
      [event.project_id],
    );
    const projectTotal = Number(projectSummary.rows[0]?.total || 0);
    const projectCompleted = Number(projectSummary.rows[0]?.completed || 0);
    const status = projectTotal > 0 && projectTotal === projectCompleted ? 'done' : 'active';
    await client.query(
      'UPDATE projects SET status = $2 WHERE id = $1 AND status IS DISTINCT FROM $2',
      [event.project_id, status],
    );
  }
  return event;
}

async function fetchChecklistItem(client, selectedWorkspaceId, eventId, itemId) {
  const result = await client.query(
    `SELECT checklist.*,
            directive.instructor_uid,
            directive.instructor_name_snapshot,
            directive.version AS directive_version
       FROM event_checklist checklist
       LEFT JOIN ${DIRECTIVE_TABLE} directive
         ON directive.workspace_id = $1
        AND directive.event_id = checklist.event_id
        AND directive.checklist_item_id = checklist.id
      WHERE checklist.event_id = $2 AND checklist.id = $3`,
    [selectedWorkspaceId, eventId, itemId],
  );
  return result.rows[0] || null;
}

async function runTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

function directiveNotification({
  targetUid,
  event,
  item,
  workspaceSlug,
  action,
  actor,
}) {
  if (!targetUid) return null;
  const actionLabel = action === 'completed' ? '완료 상태가 변경되었습니다'
    : action === 'removed' ? '지시자 지정이 해제되었습니다'
      : action === 'deleted' ? '지시사항이 삭제되었습니다'
        : action === 'updated' ? '지시사항이 변경되었습니다'
          : '지시사항이 등록되었습니다';
  const titleLabel = action === 'completed' ? '완료 상태'
    : action === 'removed' ? '지시자 해제'
      : action === 'deleted' ? '삭제'
        : action === 'updated' ? '변경'
          : '등록';
  const ownerName = String(event.owner_name || event.ownerName || '업무 담당자').trim() || '업무 담당자';
  const link = `/os/w/${encodeURIComponent(workspaceSlug || 'peak')}/?view=todo&date=${encodeURIComponent(event.date || '')}&instruction=${encodeURIComponent(item.id)}`;
  return {
    uid: String(targetUid),
    title: `📌 지시사항 ${titleLabel} 알림`,
    body: `담당 ${ownerName}: ${item.title} · ${actionLabel} (${actor.name})`,
    data: {
      kind: 'todo-directive',
      action,
      eventId: event.id,
      itemId: item.id,
      date: event.date || '',
      workspaceSlug: workspaceSlug || '',
      link,
      tag: `todo-directive-${item.id}`,
    },
  };
}

async function deliverNotifications(notifyUser, notifications) {
  if (typeof notifyUser !== 'function') return;
  for (const notification of notifications.filter(Boolean)) {
    try {
      await notifyUser(
        notification.uid,
        notification.title,
        notification.body,
        notification.data,
      );
    } catch (error) {
      console.error('OS checklist directive notification failed:', error?.message || error);
    }
  }
}

function createPeakosEventChecklistDirectiveHandlers({
  pool,
  workspaceIdForRequest,
  peakWorkspaceId = 'ws_peak',
  eventHiddenPredicate,
  canAccessEvent,
  notifyUser,
  now = () => new Date(),
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('pool.query와 pool.connect가 필요합니다.');
  }
  if (typeof workspaceIdForRequest !== 'function') throw new TypeError('workspaceIdForRequest가 필요합니다.');
  if (typeof eventHiddenPredicate !== 'function') throw new TypeError('eventHiddenPredicate가 필요합니다.');
  if (typeof canAccessEvent !== 'function') throw new TypeError('canAccessEvent가 필요합니다.');
  if (typeof notifyUser !== 'function') throw new TypeError('notifyUser가 필요합니다.');

  async function getInstructors(req, res) {
    try {
      const selectedWorkspaceId = workspaceId(req, workspaceIdForRequest);
      await resolveCanonicalActor(pool, selectedWorkspaceId, req);
      const instructors = await listEligibleInstructors(pool, selectedWorkspaceId, {
        callerUid: req.uid,
        restrictedDirectory: !!(req.userDoc?.chat_only || req.userDoc?.external_calendar_only),
      });
      return res.json({ instructors });
    } catch (error) {
      return sendDirectiveError(res, error);
    }
  }

  async function getInstructions(req, res) {
    try {
      const selectedWorkspaceId = workspaceId(req, workspaceIdForRequest);
      await resolveCanonicalActor(pool, selectedWorkspaceId, req);
      const range = normalizeInstructionDateRange(req.query, now());
      const instructions = await listInstructionInbox(pool, {
        req,
        selectedWorkspaceId,
        peakWorkspaceId,
        ...range,
        eventHiddenPredicate,
      });
      return res.json({ ...range, instructions });
    } catch (error) {
      return sendDirectiveError(res, error);
    }
  }

  async function getChecklist(req, res) {
    try {
      const eventId = normalizeIdentifier(req.params.id, '일정');
      const selectedWorkspaceId = workspaceId(req, workspaceIdForRequest);
      if (!(await canAccessEvent(req, eventId))) {
        throw httpError(404, 'PEAKOS_CHECKLIST_EVENT_NOT_FOUND', '일정을 찾을 수 없습니다.');
      }
      const hidden = eventHiddenPredicate(req, { eventAlias: 'event_row', workspaceParameter: 2 });
      const result = await pool.query(
        `SELECT checklist.*,
                event_row.owner_id,
                directive.instructor_uid,
                directive.instructor_name_snapshot,
                directive.version AS directive_version
           FROM events event_row
           JOIN event_checklist checklist ON checklist.event_id = event_row.id
           LEFT JOIN ${DIRECTIVE_TABLE} directive
             ON directive.workspace_id = $2
            AND directive.event_id = checklist.event_id
            AND directive.checklist_item_id = checklist.id
          WHERE event_row.id = $1
            AND event_row.deleted = FALSE
            AND (event_row.workspace_id = $2 OR (event_row.workspace_id IS NULL AND $2 = $3))
            ${hidden}
          ORDER BY checklist.done DESC, checklist.sort_order, checklist.created_at, checklist.id`,
        [eventId, selectedWorkspaceId, peakWorkspaceId],
      );
      return res.json(result.rows.map(row => mapChecklistItem(row, { req })));
    } catch (error) {
      return sendDirectiveError(res, error);
    }
  }

  async function createChecklist(req, res) {
    let notifications = [];
    try {
      const body = normalizeChecklistCreateBody(req.body);
      const eventId = normalizeIdentifier(req.params.id, '일정');
      const selectedWorkspaceId = workspaceId(req, workspaceIdForRequest);
      const result = await runTransaction(pool, async client => {
        const event = await loadEventForMutation(client, {
          req, eventId, selectedWorkspaceId, peakWorkspaceId, eventHiddenPredicate,
        });
        assertDirectiveTargetIsPersonal(event, body.instructorUid);
        const actor = await resolveCanonicalActor(client, selectedWorkspaceId, req);
        const instructor = body.instructorUid
          ? (body.instructorUid === actor.uid
            ? actor
            : await resolveCanonicalInstructor(client, selectedWorkspaceId, body.instructorUid))
          : null;
        if (instructor) assertInstructorCanReceiveEvent(event, instructor);
        const order = await client.query(
          'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM event_checklist WHERE event_id = $1',
          [eventId],
        );
        const inserted = await client.query(
          `INSERT INTO event_checklist (event_id, title, sort_order)
           VALUES ($1, $2, $3)
           RETURNING *`,
          [eventId, body.title, Number(order.rows[0]?.next || 0)],
        );
        const created = inserted.rows[0];
        if (instructor) {
          await client.query(
            `INSERT INTO ${DIRECTIVE_TABLE}
              (workspace_id, event_id, checklist_item_id,
               instructor_uid, instructor_name_snapshot,
               recorded_by_uid, recorded_by_name_snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [selectedWorkspaceId, eventId, created.id,
              instructor.uid, instructor.name, actor.uid, actor.name],
          );
        }
        await normalizeChecklistSortOrders(client, eventId);
        const updatedEvent = await syncChecklistDrivenEventState(client, eventId);
        const itemRow = await fetchChecklistItem(client, selectedWorkspaceId, eventId, created.id);
        const item = mapChecklistItem(itemRow, { req, ownerUid: event.owner_id });
        const operationNotifications = instructor ? [directiveNotification({
          targetUid: instructor.uid,
          event: updatedEvent || event,
          item,
          workspaceSlug: instructor.workspaceSlug || actor.workspaceSlug,
          action: 'assigned',
          actor,
        })] : [];
        return { item, event: updatedEvent || event, notifications: operationNotifications };
      });
      notifications = result.notifications;
      await deliverNotifications(notifyUser, notifications);
      return res.json({ item: result.item, event: result.event });
    } catch (error) {
      return sendDirectiveError(res, error);
    }
  }

  async function updateChecklist(req, res) {
    try {
      const body = normalizeChecklistUpdateBody(req.body);
      const eventId = normalizeIdentifier(req.params.eventId, '일정');
      const itemId = normalizeIdentifier(req.params.itemId, '체크리스트');
      const selectedWorkspaceId = workspaceId(req, workspaceIdForRequest);
      const result = await runTransaction(pool, async client => {
        const event = await loadEventForMutation(client, {
          req, eventId, selectedWorkspaceId, peakWorkspaceId, eventHiddenPredicate,
        });
        if (Object.prototype.hasOwnProperty.call(body, 'instructorUid')) {
          assertDirectiveTargetIsPersonal(event, body.instructorUid);
        }
        const actor = await resolveCanonicalActor(client, selectedWorkspaceId, req);
        const existingResult = await client.query(
          `SELECT checklist.*,
                  directive.instructor_uid,
                  directive.instructor_name_snapshot,
                  directive.version AS directive_version
             FROM event_checklist checklist
             LEFT JOIN ${DIRECTIVE_TABLE} directive
               ON directive.workspace_id = $1
              AND directive.event_id = checklist.event_id
              AND directive.checklist_item_id = checklist.id
            WHERE checklist.event_id = $2 AND checklist.id = $3
            FOR UPDATE OF checklist`,
          [selectedWorkspaceId, eventId, itemId],
        );
        const existing = existingResult.rows[0];
        if (!existing) {
          throw httpError(404, 'PEAKOS_CHECKLIST_ITEM_NOT_FOUND', '체크리스트 항목을 찾을 수 없습니다.');
        }
        let nextInstructor;
        if (Object.prototype.hasOwnProperty.call(body, 'instructorUid')) {
          nextInstructor = body.instructorUid === null
            ? null
            : (body.instructorUid === actor.uid
              ? actor
              : await resolveCanonicalInstructor(client, selectedWorkspaceId, body.instructorUid));
          if (nextInstructor) assertInstructorCanReceiveEvent(event, nextInstructor);
        }
        await client.query(
          `UPDATE event_checklist
              SET title = CASE WHEN $3 THEN $4 ELSE title END,
                  done = CASE WHEN $5 THEN $6 ELSE done END
            WHERE event_id = $1 AND id = $2`,
          [eventId, itemId,
            Object.prototype.hasOwnProperty.call(body, 'title'), body.title || '',
            Object.prototype.hasOwnProperty.call(body, 'done'), body.done === true],
        );
        if (Object.prototype.hasOwnProperty.call(body, 'instructorUid')) {
          if (nextInstructor) {
            await client.query(
              `INSERT INTO ${DIRECTIVE_TABLE}
                (workspace_id, event_id, checklist_item_id,
                 instructor_uid, instructor_name_snapshot,
                 recorded_by_uid, recorded_by_name_snapshot)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (workspace_id, checklist_item_id) DO UPDATE
                 SET event_id = EXCLUDED.event_id,
                     instructor_uid = EXCLUDED.instructor_uid,
                     instructor_name_snapshot = EXCLUDED.instructor_name_snapshot,
                     recorded_by_uid = EXCLUDED.recorded_by_uid,
                     recorded_by_name_snapshot = EXCLUDED.recorded_by_name_snapshot,
                     version = ${DIRECTIVE_TABLE}.version + 1,
                     updated_at = NOW()`,
              [selectedWorkspaceId, eventId, itemId,
                nextInstructor.uid, nextInstructor.name, actor.uid, actor.name],
            );
          } else {
            await client.query(
              `DELETE FROM ${DIRECTIVE_TABLE}
                WHERE workspace_id = $1 AND event_id = $2 AND checklist_item_id = $3`,
              [selectedWorkspaceId, eventId, itemId],
            );
          }
        }
        await normalizeChecklistSortOrders(client, eventId);
        const updatedEvent = await syncChecklistDrivenEventState(client, eventId);
        const itemRow = await fetchChecklistItem(client, selectedWorkspaceId, eventId, itemId);
        const item = mapChecklistItem(itemRow, { req, ownerUid: event.owner_id });
        const previousUid = existing.instructor_uid ? String(existing.instructor_uid) : null;
        const currentUid = item.instructor?.uid || null;
        const previousRecipient = await findNotificationRecipient(
          client, selectedWorkspaceId, event, previousUid,
        );
        const currentRecipient = currentUid === nextInstructor?.uid
          ? nextInstructor
          : await findNotificationRecipient(client, selectedWorkspaceId, event, currentUid);
        const operationNotifications = [];
        if (previousRecipient && previousUid !== currentUid) {
          operationNotifications.push(directiveNotification({
            targetUid: previousRecipient.uid,
            event: updatedEvent || event,
            item,
            workspaceSlug: actor.workspaceSlug,
            action: 'removed',
            actor,
          }));
        }
        if (currentRecipient) {
          operationNotifications.push(directiveNotification({
            targetUid: currentRecipient.uid,
            event: updatedEvent || event,
            item,
            workspaceSlug: nextInstructor?.workspaceSlug || actor.workspaceSlug,
            action: previousUid !== currentUid
              ? 'assigned'
              : (Object.prototype.hasOwnProperty.call(body, 'done') ? 'completed' : 'updated'),
            actor,
          }));
        }
        return { item, event: updatedEvent || event, notifications: operationNotifications };
      });
      await deliverNotifications(notifyUser, result.notifications);
      return res.json({ item: result.item, event: result.event });
    } catch (error) {
      return sendDirectiveError(res, error);
    }
  }

  async function deleteChecklist(req, res) {
    try {
      const eventId = normalizeIdentifier(req.params.eventId, '일정');
      const itemId = normalizeIdentifier(req.params.itemId, '체크리스트');
      const selectedWorkspaceId = workspaceId(req, workspaceIdForRequest);
      const result = await runTransaction(pool, async client => {
        const event = await loadEventForMutation(client, {
          req, eventId, selectedWorkspaceId, peakWorkspaceId, eventHiddenPredicate,
        });
        const actor = await resolveCanonicalActor(client, selectedWorkspaceId, req);
        const existingResult = await client.query(
          `SELECT checklist.*,
                  directive.instructor_uid,
                  directive.instructor_name_snapshot
             FROM event_checklist checklist
             LEFT JOIN ${DIRECTIVE_TABLE} directive
               ON directive.workspace_id = $1
              AND directive.event_id = checklist.event_id
              AND directive.checklist_item_id = checklist.id
            WHERE checklist.event_id = $2 AND checklist.id = $3
            FOR UPDATE OF checklist`,
          [selectedWorkspaceId, eventId, itemId],
        );
        const existing = existingResult.rows[0];
        if (!existing) {
          throw httpError(404, 'PEAKOS_CHECKLIST_ITEM_NOT_FOUND', '체크리스트 항목을 찾을 수 없습니다.');
        }
        await client.query(
          'DELETE FROM event_checklist WHERE event_id = $1 AND id = $2',
          [eventId, itemId],
        );
        await normalizeChecklistSortOrders(client, eventId);
        const updatedEvent = await syncChecklistDrivenEventState(client, eventId);
        const notificationRecipient = await findNotificationRecipient(
          client, selectedWorkspaceId, event, existing.instructor_uid,
        );
        const operationNotifications = notificationRecipient ? [directiveNotification({
          targetUid: notificationRecipient.uid,
          event: updatedEvent || event,
          item: { id: itemId, title: existing.title },
          workspaceSlug: actor.workspaceSlug,
          action: 'deleted',
          actor,
        })] : [];
        return { event: updatedEvent || event, notifications: operationNotifications };
      });
      await deliverNotifications(notifyUser, result.notifications);
      return res.json({ ok: true, id: itemId, event: result.event });
    } catch (error) {
      return sendDirectiveError(res, error);
    }
  }

  return {
    createChecklist,
    deleteChecklist,
    getChecklist,
    getInstructions,
    getInstructors,
    updateChecklist,
  };
}

function registerPeakosEventChecklistDirectiveRoutes({
  app,
  isOsRequest,
  readMiddlewares = [],
  writeMiddlewares = readMiddlewares,
  ...dependencies
} = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('Express app이 필요합니다.');
  if (typeof isOsRequest !== 'function') throw new TypeError('isOsRequest가 필요합니다.');
  const handlers = createPeakosEventChecklistDirectiveHandlers(dependencies);
  const reads = Array.isArray(readMiddlewares) ? readMiddlewares : [readMiddlewares];
  const writes = Array.isArray(writeMiddlewares) ? writeMiddlewares : [writeMiddlewares];
  const osOnly = handler => (req, res, next) => (
    isOsRequest(req) ? handler(req, res, next) : next()
  );

  app.get('/api/events/instructors', ...reads, osOnly(handlers.getInstructors));
  app.get('/api/events/checklist-instructions', ...reads, osOnly(handlers.getInstructions));
  app.get('/api/events/:id/checklist', ...reads, osOnly(handlers.getChecklist));
  app.post('/api/events/:id/checklist', ...writes, osOnly(handlers.createChecklist));
  app.put('/api/events/:eventId/checklist/:itemId', ...writes, osOnly(handlers.updateChecklist));
  app.delete('/api/events/:eventId/checklist/:itemId', ...writes, osOnly(handlers.deleteChecklist));
  return handlers;
}

module.exports = {
  DIRECTIVE_REQUIRED_COLUMN_DEFINITIONS,
  DIRECTIVE_REQUIRED_CONSTRAINTS,
  DIRECTIVE_REQUIRED_INDEXES,
  DIRECTIVE_REQUIRED_TRIGGERS,
  DIRECTIVE_SCHEMA_READINESS_SQL,
  DIRECTIVE_TABLE_PRIVILEGES,
  DIRECTIVE_TABLE,
  DIRECTIVE_TRIGGER_FUNCTION_SOURCES,
  MIGRATION_PATH,
  assertChecklistMutationAllowed,
  assertDirectiveTargetIsPersonal,
  assertInstructorCanReceiveEvent,
  checklistCapabilities,
  createPeakosEventChecklistDirectiveHandlers,
  enrichChecklistItemResponse,
  ensurePeakosEventChecklistDirectiveInfrastructure,
  findEligibleWorkspaceUser,
  findNotificationRecipient,
  listEligibleInstructors,
  listInstructionInbox,
  loadEventForMutation,
  mapChecklistItem,
  mapInstruction,
  registerPeakosEventChecklistDirectiveRoutes,
  resolveCanonicalInstructor,
  syncChecklistDrivenEventState,
};
