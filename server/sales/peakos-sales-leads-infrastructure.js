'use strict';

const { validateSecret } = require('./peakos-sales-leads-crypto');

const SALES_MIGRATION_FILE = '20260817_peakos_sales_leads.sql';

function frozenColumnMap(definitions) {
  return Object.freeze(Object.fromEntries(Object.entries(definitions).map(([table, columns]) => [
    table,
    Object.freeze(Object.fromEntries(Object.entries(columns).map(([column, definition]) => [
      column,
      Object.freeze(definition),
    ]))),
  ])));
}

const SALES_REQUIRED_COLUMN_DEFINITIONS = frozenColumnMap({
  peakos_sales_leads: {
    workspace_id: ['text', true], id: ['uuid', true], owner_uid: ['text', true],
    owner_name_snapshot: ['text', true], company_name: ['text', true],
    contact_ciphertext: ['bytea', true], contact_nonce: ['bytea', true],
    contact_auth_tag: ['bytea', true], contact_encryption_version: ['smallint', true],
    phone_fingerprint: ['text', true], phone_last4: ['text', true], channel: ['text', true],
    source: ['text', true], status: ['text', true],
    next_followup_at: ['timestamp with time zone', false],
    last_contact_at: ['timestamp with time zone', false], version: ['integer', true],
    created_by_uid: ['text', true], created_by_name_snapshot: ['text', true],
    archived_at: ['timestamp with time zone', false], archived_by_uid: ['text', false],
    archived_by_name_snapshot: ['text', false], created_at: ['timestamp with time zone', true],
    updated_at: ['timestamp with time zone', true],
  },
  peakos_sales_call_logs: {
    workspace_id: ['text', true], id: ['uuid', true], lead_id: ['uuid', true],
    actor_uid: ['text', true], actor_name_snapshot: ['text', true], disposition: ['text', true],
    occurred_at: ['timestamp with time zone', true], duration_seconds: ['integer', false],
    note_ciphertext: ['bytea', true], note_nonce: ['bytea', true], note_auth_tag: ['bytea', true],
    note_encryption_version: ['smallint', true], next_followup_at: ['timestamp with time zone', false],
    created_at: ['timestamp with time zone', true],
  },
  peakos_sales_lead_history: {
    workspace_id: ['text', true], id: ['bigint', true], lead_id: ['uuid', true],
    action: ['text', true], actor_uid: ['text', true], actor_name_snapshot: ['text', true],
    entity_version: ['integer', true], before_state: ['jsonb', true], after_state: ['jsonb', true],
    created_at: ['timestamp with time zone', true],
  },
});

const SALES_REQUIRED_COLUMNS = Object.freeze(Object.fromEntries(
  Object.entries(SALES_REQUIRED_COLUMN_DEFINITIONS).map(([table, columns]) => [
    table,
    Object.freeze(Object.keys(columns)),
  ]),
));

const SALES_REQUIRED_CONSTRAINTS = Object.freeze({
  peakos_sales_leads: Object.freeze([
    ['peakos_sales_leads_pkey', 'p', 'PRIMARY KEY (workspace_id, id)'],
    ['peakos_sales_leads_workspace_fk', 'f', 'FOREIGN KEY (workspace_id) REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_sales_leads_owner_membership_fk', 'f', 'FOREIGN KEY (workspace_id, owner_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_sales_leads_creator_membership_fk', 'f', 'FOREIGN KEY (workspace_id, created_by_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_sales_leads_archiver_membership_fk', 'f', 'FOREIGN KEY (workspace_id, archived_by_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_sales_leads_owner_uid_check', 'c', 'CHECK (((char_length(btrim(owner_uid)) >= 1) AND (char_length(btrim(owner_uid)) <= 200)))'],
    ['peakos_sales_leads_owner_name_check', 'c', 'CHECK (((char_length(btrim(owner_name_snapshot)) >= 1) AND (char_length(btrim(owner_name_snapshot)) <= 160)))'],
    ['peakos_sales_leads_company_name_check', 'c', 'CHECK (((char_length(btrim(company_name)) >= 1) AND (char_length(btrim(company_name)) <= 240)))'],
    ['peakos_sales_leads_contact_ciphertext_check', 'c', 'CHECK (((octet_length(contact_ciphertext) >= 1) AND (octet_length(contact_ciphertext) <= 131072)))'],
    ['peakos_sales_leads_contact_nonce_check', 'c', 'CHECK ((octet_length(contact_nonce) = 12))'],
    ['peakos_sales_leads_contact_auth_tag_check', 'c', 'CHECK ((octet_length(contact_auth_tag) = 16))'],
    ['peakos_sales_leads_contact_encryption_version_check', 'c', 'CHECK ((contact_encryption_version = 1))'],
    ['peakos_sales_leads_phone_fingerprint_check', 'c', "CHECK ((phone_fingerprint ~ '^[0-9a-f]{64}$'::text))"],
    ['peakos_sales_leads_phone_last4_check', 'c', "CHECK ((phone_last4 ~ '^[0-9]{4}$'::text))"],
    ['peakos_sales_leads_channel_check', 'c', "CHECK ((channel = ANY (ARRAY['phone'::text, 'field'::text, 'online'::text])))"],
    ['peakos_sales_leads_source_check', 'c', "CHECK ((source = ANY (ARRAY['manual'::text, 'referral'::text, 'inbound'::text, 'other'::text])))"],
    ['peakos_sales_leads_status_check', 'c', "CHECK ((status = ANY (ARRAY['new'::text, 'contacted'::text, 'follow_up'::text, 'won'::text, 'lost'::text, 'do_not_call'::text])))"],
    ['peakos_sales_leads_version_check', 'c', 'CHECK (((version >= 1) AND (version <= 2147483647)))'],
    ['peakos_sales_leads_creator_uid_check', 'c', 'CHECK (((char_length(btrim(created_by_uid)) >= 1) AND (char_length(btrim(created_by_uid)) <= 200)))'],
    ['peakos_sales_leads_creator_name_check', 'c', 'CHECK (((char_length(btrim(created_by_name_snapshot)) >= 1) AND (char_length(btrim(created_by_name_snapshot)) <= 160)))'],
    ['peakos_sales_leads_archive_pair_check', 'c', 'CHECK ((((archived_at IS NULL) AND (archived_by_uid IS NULL) AND (archived_by_name_snapshot IS NULL)) OR ((archived_at IS NOT NULL) AND (archived_by_uid IS NOT NULL) AND (archived_by_name_snapshot IS NOT NULL) AND ((char_length(btrim(archived_by_name_snapshot)) >= 1) AND (char_length(btrim(archived_by_name_snapshot)) <= 160)))))'],
    ['peakos_sales_leads_updated_check', 'c', 'CHECK ((updated_at >= created_at))'],
  ]),
  peakos_sales_call_logs: Object.freeze([
    ['peakos_sales_call_logs_pkey', 'p', 'PRIMARY KEY (workspace_id, id)'],
    ['peakos_sales_call_logs_lead_fk', 'f', 'FOREIGN KEY (workspace_id, lead_id) REFERENCES peakos_sales_leads(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_sales_call_logs_actor_membership_fk', 'f', 'FOREIGN KEY (workspace_id, actor_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_sales_call_logs_actor_uid_check', 'c', 'CHECK (((char_length(btrim(actor_uid)) >= 1) AND (char_length(btrim(actor_uid)) <= 200)))'],
    ['peakos_sales_call_logs_actor_name_check', 'c', 'CHECK (((char_length(btrim(actor_name_snapshot)) >= 1) AND (char_length(btrim(actor_name_snapshot)) <= 160)))'],
    ['peakos_sales_call_logs_disposition_check', 'c', "CHECK ((disposition = ANY (ARRAY['connected'::text, 'no_answer'::text, 'busy'::text, 'callback'::text, 'interested'::text, 'won'::text, 'lost'::text, 'do_not_call'::text])))"],
    ['peakos_sales_call_logs_duration_check', 'c', 'CHECK (((duration_seconds IS NULL) OR ((duration_seconds >= 0) AND (duration_seconds <= 86400))))'],
    ['peakos_sales_call_logs_note_ciphertext_check', 'c', 'CHECK (((octet_length(note_ciphertext) >= 1) AND (octet_length(note_ciphertext) <= 65536)))'],
    ['peakos_sales_call_logs_note_nonce_check', 'c', 'CHECK ((octet_length(note_nonce) = 12))'],
    ['peakos_sales_call_logs_note_auth_tag_check', 'c', 'CHECK ((octet_length(note_auth_tag) = 16))'],
    ['peakos_sales_call_logs_note_encryption_version_check', 'c', 'CHECK ((note_encryption_version = 1))'],
  ]),
  peakos_sales_lead_history: Object.freeze([
    ['peakos_sales_lead_history_pkey', 'p', 'PRIMARY KEY (workspace_id, id)'],
    ['peakos_sales_lead_history_lead_fk', 'f', 'FOREIGN KEY (workspace_id, lead_id) REFERENCES peakos_sales_leads(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_sales_lead_history_actor_membership_fk', 'f', 'FOREIGN KEY (workspace_id, actor_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_sales_lead_history_action_check', 'c', "CHECK ((action = ANY (ARRAY['created'::text, 'updated'::text, 'call_logged'::text, 'archived'::text])))"],
    ['peakos_sales_lead_history_actor_uid_check', 'c', 'CHECK (((char_length(btrim(actor_uid)) >= 1) AND (char_length(btrim(actor_uid)) <= 200)))'],
    ['peakos_sales_lead_history_actor_name_check', 'c', 'CHECK (((char_length(btrim(actor_name_snapshot)) >= 1) AND (char_length(btrim(actor_name_snapshot)) <= 160)))'],
    ['peakos_sales_lead_history_version_check', 'c', 'CHECK (((entity_version >= 1) AND (entity_version <= 2147483647)))'],
    ['peakos_sales_lead_history_state_check', 'c', "CHECK (((jsonb_typeof(before_state) = 'object'::text) AND (jsonb_typeof(after_state) = 'object'::text)))"],
  ]),
});

const APPEND_ONLY_FUNCTION_SOURCE = `
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
`.trim();

// [table, trigger, tgtype, enabled, canonical pg_get_triggerdef]. A trigger's
// name, event bitmask and function are not a sufficient append-only contract:
// UPDATE OF can narrow the protected columns without changing tgtype and a
// WHEN clause can make the trigger inert. Keep the catalog fields and the
// canonical definition in readiness so a same-named weakened trigger fails
// closed until the migration recreates it.
const SALES_REQUIRED_TRIGGERS = Object.freeze([
  Object.freeze([
    'peakos_sales_call_logs',
    'peakos_sales_call_logs_no_mutation',
    27,
    'O',
    'CREATE TRIGGER peakos_sales_call_logs_no_mutation BEFORE DELETE OR UPDATE ON public.peakos_sales_call_logs FOR EACH ROW EXECUTE FUNCTION peakos_sales_append_only()',
  ]),
  Object.freeze([
    'peakos_sales_lead_history',
    'peakos_sales_lead_history_no_mutation',
    27,
    'O',
    'CREATE TRIGGER peakos_sales_lead_history_no_mutation BEFORE DELETE OR UPDATE ON public.peakos_sales_lead_history FOR EACH ROW EXECUTE FUNCTION peakos_sales_append_only()',
  ]),
]);
const SALES_REQUIRED_INDEXES = Object.freeze([
  Object.freeze(['peakos_sales_leads', 'peakos_sales_leads_active_phone_unique',
    Object.freeze(['workspace_id', 'phone_fingerprint']), '(archived_at IS NULL)']),
]);
const TABLE_PRIVILEGES = Object.freeze({
  peakos_sales_leads: Object.freeze({ SELECT: true, INSERT: true, UPDATE: true, DELETE: false, TRUNCATE: false, REFERENCES: false, TRIGGER: false }),
  peakos_sales_call_logs: Object.freeze({ SELECT: true, INSERT: true, UPDATE: false, DELETE: false, TRUNCATE: false, REFERENCES: false, TRIGGER: false }),
  peakos_sales_lead_history: Object.freeze({ SELECT: true, INSERT: true, UPDATE: false, DELETE: false, TRUNCATE: false, REFERENCES: false, TRIGGER: false }),
});

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const columnRows = Object.entries(SALES_REQUIRED_COLUMN_DEFINITIONS).flatMap(([table, columns]) => (
  Object.entries(columns).map(([column, [type, notNull]]) => (
    `(${sqlString(table)},${sqlString(column)},${sqlString(type)},${notNull ? 'TRUE' : 'FALSE'})`
  ))
));
const constraintRows = Object.entries(SALES_REQUIRED_CONSTRAINTS).flatMap(([table, constraints]) => (
  constraints.map(([name, type, definition]) => (
    `(${sqlString(table)},${sqlString(name)},${sqlString(type)},${sqlString(definition)})`
  ))
));
const triggerRows = SALES_REQUIRED_TRIGGERS.map(([
  table, name, triggerType, enabled, definition,
]) => (
  `(${sqlString(table)},${sqlString(name)},${triggerType},${sqlString(enabled)},${sqlString(definition)})`
));
const privilegeRows = Object.entries(TABLE_PRIVILEGES).flatMap(([table, privileges]) => (
  Object.entries(privileges).map(([privilege, allowed]) => (
    `(${sqlString(table)},${sqlString(privilege)},${allowed ? 'TRUE' : 'FALSE'})`
  ))
));

const SALES_SCHEMA_READINESS_SQL = `
WITH required_columns(table_name, column_name, data_type, is_not_null) AS (
  VALUES ${columnRows.join(',\n    ')}
), required_constraints(table_name, constraint_name, constraint_type, definition) AS (
  VALUES ${constraintRows.join(',\n    ')}
), required_triggers(table_name, trigger_name, trigger_type, enabled_state, definition) AS (
  VALUES ${triggerRows.join(',\n    ')}
), required_table_privileges(table_name, privilege_name, expected) AS (
  VALUES ${privilegeRows.join(',\n    ')}
), runtime_role AS (
  -- Readiness runs on the application pool itself. Validate that connection's
  -- effective role rather than trusting an operator-session migration hint.
  SELECT current_user AS role_name, role_row.oid AS role_oid
    FROM pg_roles role_row
   WHERE role_row.rolname = current_user
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
  SELECT 'constraint-definition:' || expected.table_name || '.' || expected.constraint_name
    FROM required_constraints expected
    LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
    LEFT JOIN pg_class relation
      ON relation.relnamespace = namespace.oid AND relation.relname = expected.table_name
    LEFT JOIN pg_constraint actual
      ON actual.conrelid = relation.oid AND actual.conname = expected.constraint_name
   WHERE actual.oid IS NULL
      OR actual.contype::text <> expected.constraint_type
      OR actual.convalidated IS NOT TRUE
      OR regexp_replace(btrim(pg_get_constraintdef(actual.oid)), '\\s+', ' ', 'g')
         <> regexp_replace(btrim(expected.definition), '\\s+', ' ', 'g')
  UNION ALL
  SELECT 'trigger-definition:' || expected.table_name || '.' || expected.trigger_name
    FROM required_triggers expected
    LEFT JOIN pg_namespace table_namespace ON table_namespace.nspname = 'public'
    LEFT JOIN pg_class relation
      ON relation.relnamespace = table_namespace.oid AND relation.relname = expected.table_name
    LEFT JOIN pg_trigger actual
      ON actual.tgrelid = relation.oid
     AND actual.tgname = expected.trigger_name
     AND NOT actual.tgisinternal
    LEFT JOIN pg_proc trigger_function ON trigger_function.oid = actual.tgfoid
    LEFT JOIN pg_namespace function_namespace ON function_namespace.oid = trigger_function.pronamespace
    LEFT JOIN pg_language trigger_language ON trigger_language.oid = trigger_function.prolang
   WHERE actual.oid IS NULL
      OR actual.tgenabled::text <> expected.enabled_state
      OR actual.tgtype::integer <> expected.trigger_type
      OR actual.tgdeferrable IS NOT FALSE
      OR actual.tginitdeferred IS NOT FALSE
      OR actual.tgconstraint <> 0
      OR actual.tgqual IS NOT NULL
      OR actual.tgattr::text <> ''
      OR actual.tgnargs <> 0
      OR octet_length(actual.tgargs) <> 0
      OR function_namespace.nspname <> 'public'
      OR trigger_function.proname <> 'peakos_sales_append_only'
      OR trigger_function.pronargs <> 0
      OR trigger_function.prorettype <> 'trigger'::regtype
      OR trigger_function.prokind <> 'f'
      OR trigger_function.provolatile <> 'v'
      OR trigger_function.prosecdef IS NOT FALSE
      OR trigger_language.lanname <> 'plpgsql'
      OR btrim(regexp_replace(trigger_function.prosrc, '\\s+', ' ', 'g'))
         <> btrim(regexp_replace(${sqlString(APPEND_ONLY_FUNCTION_SOURCE)}, '\\s+', ' ', 'g'))
      OR regexp_replace(btrim(pg_get_triggerdef(actual.oid)), '\\s+', ' ', 'g')
         <> regexp_replace(btrim(expected.definition), '\\s+', ' ', 'g')
  UNION ALL
  SELECT 'index-definition:peakos_sales_leads.peakos_sales_leads_active_phone_unique'
    FROM pg_namespace namespace
    LEFT JOIN pg_class table_relation
      ON table_relation.relnamespace = namespace.oid
     AND table_relation.relname = 'peakos_sales_leads'
    LEFT JOIN pg_class index_relation
      ON index_relation.relnamespace = namespace.oid
     AND index_relation.relname = 'peakos_sales_leads_active_phone_unique'
     AND index_relation.relkind = 'i'
    LEFT JOIN pg_index actual
      ON actual.indexrelid = index_relation.oid
     AND actual.indrelid = table_relation.oid
   WHERE namespace.nspname = 'public'
     AND (
       actual.indexrelid IS NULL
       OR actual.indisunique IS NOT TRUE
       OR actual.indisvalid IS NOT TRUE
       OR actual.indisready IS NOT TRUE
       OR actual.indnkeyatts <> 2
       OR (
         SELECT array_agg(attribute.attname ORDER BY key.ordinality)
           FROM unnest(actual.indkey) WITH ORDINALITY AS key(attnum, ordinality)
           JOIN pg_attribute attribute
             ON attribute.attrelid = actual.indrelid
            AND attribute.attnum = key.attnum
          WHERE key.ordinality <= actual.indnkeyatts
       ) <> ARRAY['workspace_id', 'phone_fingerprint']::name[]
       OR regexp_replace(COALESCE(pg_get_expr(actual.indpred, actual.indrelid), ''), '\\s+', ' ', 'g')
          <> '(archived_at IS NULL)'
     )
  UNION ALL
  SELECT 'runtime-role:missing-or-invalid'
    FROM runtime_role runtime
   WHERE runtime.role_name IS NULL OR runtime.role_oid IS NULL
  UNION ALL
  SELECT 'table-privilege:' || expected.table_name || '.' || expected.privilege_name
    FROM required_table_privileges expected
    CROSS JOIN runtime_role runtime
   WHERE runtime.role_name IS NOT NULL
     AND COALESCE(
       has_table_privilege(runtime.role_oid, to_regclass('public.' || expected.table_name), expected.privilege_name),
       FALSE
     ) <> expected.expected
  UNION ALL
  SELECT 'sequence-privilege:peakos_sales_lead_history_id_seq.' || privilege.privilege_name
    FROM (VALUES ('USAGE', TRUE), ('SELECT', FALSE), ('UPDATE', FALSE)) AS privilege(privilege_name, expected)
    CROSS JOIN runtime_role runtime
   WHERE runtime.role_name IS NOT NULL
     AND COALESCE(
       has_sequence_privilege(runtime.role_oid, to_regclass('public.peakos_sales_lead_history_id_seq'), privilege.privilege_name),
       FALSE
     ) <> privilege.expected
  UNION ALL
  SELECT 'function-privilege:peakos_sales_append_only.execute'
    FROM runtime_role runtime
   WHERE runtime.role_name IS NOT NULL
     AND COALESCE(
       has_function_privilege(runtime.role_oid, to_regprocedure('public.peakos_sales_append_only()'), 'EXECUTE'),
       FALSE
     ) IS NOT FALSE
  UNION ALL
  SELECT 'permission:peakos_workspace_memberships.sales'
   WHERE EXISTS (
     SELECT 1 FROM peakos_workspace_memberships
      WHERE NOT permissions ? 'sales'
         OR permissions->>'sales' NOT IN ('none', 'read', 'write')
   )
)
SELECT NOT EXISTS (SELECT 1 FROM missing) AS ready,
       COALESCE(array_agg(requirement ORDER BY requirement)
         FILTER (WHERE requirement IS NOT NULL), ARRAY[]::text[]) AS missing_requirements
  FROM missing
`.trim();

function salesSchemaReadiness(row) {
  const missing = Array.isArray(row?.missing_requirements) ? row.missing_requirements.map(String) : [];
  if (row?.ready === true && missing.length === 0) return { ready: true, missing: [] };
  return {
    ready: false,
    code: 'SALES_SCHEMA_NOT_READY',
    missing,
    error: `영업 DB 스키마가 준비되지 않았습니다. ${SALES_MIGRATION_FILE}을 운영자 권한으로 적용해 주세요.`,
  };
}

async function ensurePeakosSalesLeadInfrastructure(pool, { encryptionSecret } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  validateSecret(encryptionSecret);
  const result = await pool.query(SALES_SCHEMA_READINESS_SQL);
  const readiness = salesSchemaReadiness(result.rows[0]);
  if (!readiness.ready) {
    const error = new Error(readiness.error);
    error.code = readiness.code;
    error.missing = readiness.missing;
    throw error;
  }
  return readiness;
}

module.exports = {
  APPEND_ONLY_FUNCTION_SOURCE,
  SALES_MIGRATION_FILE,
  SALES_REQUIRED_COLUMN_DEFINITIONS,
  SALES_REQUIRED_COLUMNS,
  SALES_REQUIRED_CONSTRAINTS,
  SALES_REQUIRED_INDEXES,
  SALES_REQUIRED_TRIGGERS,
  SALES_SCHEMA_READINESS_SQL,
  TABLE_PRIVILEGES,
  ensurePeakosSalesLeadInfrastructure,
  salesSchemaReadiness,
};
