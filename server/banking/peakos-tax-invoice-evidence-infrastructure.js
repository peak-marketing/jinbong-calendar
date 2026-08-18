'use strict';

const path = require('node:path');

const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  'migrations',
  '20260818_peakos_tax_invoice_evidence.sql',
);

const REQUIRED_COLUMNS = Object.freeze([
  ['peakos_finance_requests', 'current_invoice_evidence_id', 'uuid', false],
  ['peakos_tax_invoice_evidence', 'id', 'uuid', true],
  ['peakos_tax_invoice_evidence', 'workspace_id', 'text', true],
  ['peakos_tax_invoice_evidence', 'finance_request_id', 'text', true],
  ['peakos_tax_invoice_evidence', 'revision', 'integer', true],
  ['peakos_tax_invoice_evidence', 'action_kind', 'text', true],
  ['peakos_tax_invoice_evidence', 'target_invoice_status', 'text', true],
  ['peakos_tax_invoice_evidence', 'invoice_number', 'text', true],
  ['peakos_tax_invoice_evidence', 'issued_at', 'timestamp with time zone', true],
  ['peakos_tax_invoice_evidence', 'supplier_registration_number', 'text', true],
  ['peakos_tax_invoice_evidence', 'document_identifier', 'text', true],
  ['peakos_tax_invoice_evidence', 'correction_reason', 'text', true],
  ['peakos_tax_invoice_evidence', 'stored_key', 'text', true],
  ['peakos_tax_invoice_evidence', 'original_filename', 'text', true],
  ['peakos_tax_invoice_evidence', 'mime_type', 'text', true],
  ['peakos_tax_invoice_evidence', 'size_bytes', 'integer', true],
  ['peakos_tax_invoice_evidence', 'sha256', 'text', true],
  ['peakos_tax_invoice_evidence', 'supersedes_evidence_id', 'uuid', false],
  ['peakos_tax_invoice_evidence', 'registered_by_uid', 'text', true],
  ['peakos_tax_invoice_evidence', 'registered_by_name', 'text', true],
  ['peakos_tax_invoice_evidence', 'created_at', 'timestamp with time zone', true],
  ['peakos_tax_invoice_evidence_audit', 'id', 'bigint', true],
  ['peakos_tax_invoice_evidence_audit', 'workspace_id', 'text', true],
  ['peakos_tax_invoice_evidence_audit', 'finance_request_id', 'text', true],
  ['peakos_tax_invoice_evidence_audit', 'evidence_id', 'uuid', true],
  ['peakos_tax_invoice_evidence_audit', 'action', 'text', true],
  ['peakos_tax_invoice_evidence_audit', 'actor_uid', 'text', true],
  ['peakos_tax_invoice_evidence_audit', 'actor_name', 'text', true],
  ['peakos_tax_invoice_evidence_audit', 'state', 'jsonb', true],
  ['peakos_tax_invoice_evidence_audit', 'created_at', 'timestamp with time zone', true],
]);

const REQUIRED_CONSTRAINTS = Object.freeze([
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_pkey', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_workspace_request_id_unique', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_workspace_request_revision_unique', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_request_fk', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_supersedes_fk', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_revision_check', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_action_check', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_target_status_check', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_action_shape_check', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_invoice_number_check', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_supplier_number_check', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_document_identifier_check', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_correction_reason_check', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_stored_key_check', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_filename_check', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_mime_check', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_size_check', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_sha256_check', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_actor_check', true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_time_check', true],
  ['peakos_tax_invoice_evidence_audit', 'peakos_tax_invoice_evidence_audit_pkey', true],
  ['peakos_tax_invoice_evidence_audit', 'peakos_tax_invoice_evidence_audit_evidence_fk', true],
  ['peakos_tax_invoice_evidence_audit', 'peakos_tax_invoice_evidence_audit_action_check', true],
  ['peakos_tax_invoice_evidence_audit', 'peakos_tax_invoice_evidence_audit_actor_check', true],
  ['peakos_finance_requests', 'peakos_finance_requests_current_invoice_evidence_fk', true],
  // This one intentionally remains NOT VALID until URL-only legacy terminal
  // rows are remediated. PostgreSQL still enforces it on all new writes.
  ['peakos_finance_requests', 'peakos_finance_requests_terminal_invoice_evidence_check', null],
]);

const REQUIRED_INDEXES = Object.freeze([
  ['peakos_tax_invoice_evidence_document_identity_unique', true,
    "(action_kind <> 'REPLACEMENT'::text)"],
  ['peakos_tax_invoice_evidence_request_created_idx', false, ''],
  ['peakos_tax_invoice_evidence_audit_request_idx', false, ''],
]);

const REQUIRED_TRIGGERS = Object.freeze([
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_validate_insert', 7,
    'peakos_tax_invoice_evidence_validate_insert', '6e234fce54e34d0c266c2b87c29925af', false, false, false],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_audit_insert', 5,
    'peakos_tax_invoice_evidence_audit_insert', '293295c7014e43ec2cd1af16d749079d', false, false, false],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_validate_commit', 5,
    'peakos_tax_invoice_evidence_validate_commit', '183b62fbe6d84029c457d449b7372a78', true, true, true],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_no_mutation', 27,
    'peakos_tax_invoice_evidence_reject_mutation', '45452988f7fcc96dc1983fe88d5df4f0', false, false, false],
  ['peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_no_truncate', 34,
    'peakos_tax_invoice_evidence_reject_mutation', '45452988f7fcc96dc1983fe88d5df4f0', false, false, false],
  ['peakos_tax_invoice_evidence_audit', 'peakos_tax_invoice_evidence_audit_no_mutation', 27,
    'peakos_tax_invoice_evidence_reject_mutation', '45452988f7fcc96dc1983fe88d5df4f0', false, false, false],
  ['peakos_tax_invoice_evidence_audit', 'peakos_tax_invoice_evidence_audit_no_truncate', 34,
    'peakos_tax_invoice_evidence_reject_mutation', '45452988f7fcc96dc1983fe88d5df4f0', false, false, false],
  ['peakos_finance_requests', 'peakos_finance_requests_invoice_evidence_guard', 23,
    'peakos_finance_request_invoice_evidence_guard', 'fe4dd43ecf010c119d93d434e608e93f', false, false, false],
]);

const TABLE_PRIVILEGES = Object.freeze({
  peakos_tax_invoice_evidence: Object.freeze({
    SELECT: true, INSERT: true, UPDATE: false, DELETE: false,
    TRUNCATE: false, REFERENCES: false, TRIGGER: false,
  }),
  peakos_tax_invoice_evidence_audit: Object.freeze({
    SELECT: true, INSERT: false, UPDATE: false, DELETE: false,
    TRUNCATE: false, REFERENCES: false, TRIGGER: false,
  }),
});

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const columnRows = REQUIRED_COLUMNS.map(([table, column, type, notNull]) => (
  `(${sqlString(table)},${sqlString(column)},${sqlString(type)},${notNull ? 'TRUE' : 'FALSE'})`
));
const constraintRows = REQUIRED_CONSTRAINTS.map(([table, constraint, validated]) => (
  `(${sqlString(table)},${sqlString(constraint)},${validated === null ? 'NULL::boolean' : (validated ? 'TRUE' : 'FALSE')})`
));
const indexRows = REQUIRED_INDEXES.map(([index, unique, predicate]) => (
  `(${sqlString(index)},${unique ? 'TRUE' : 'FALSE'},${sqlString(predicate)})`
));
const triggerRows = REQUIRED_TRIGGERS.map(([
  table, trigger, type, functionName, sourceMd5, deferrable, initiallyDeferred, constraint,
]) => (
  `(${sqlString(table)},${sqlString(trigger)},${type},${sqlString(functionName)},${sqlString(sourceMd5)},${deferrable ? 'TRUE' : 'FALSE'},${initiallyDeferred ? 'TRUE' : 'FALSE'},${constraint ? 'TRUE' : 'FALSE'})`
));
const privilegeRows = Object.entries(TABLE_PRIVILEGES).flatMap(([table, privileges]) => (
  Object.entries(privileges).map(([privilege, expected]) => (
    `(${sqlString(table)},${sqlString(privilege)},${expected ? 'TRUE' : 'FALSE'})`
  ))
));

const TAX_INVOICE_EVIDENCE_READINESS_SQL = `
WITH required_columns(table_name, column_name, data_type, is_not_null) AS (
  VALUES ${columnRows.join(',\n    ')}
), required_constraints(table_name, constraint_name, expected_validated) AS (
  VALUES ${constraintRows.join(',\n    ')}
), required_indexes(index_name, is_unique, predicate) AS (
  VALUES ${indexRows.join(',\n    ')}
), required_triggers(table_name, trigger_name, trigger_type, function_name, source_md5,
    expected_deferrable, expected_initially_deferred, expected_constraint) AS (
  VALUES ${triggerRows.join(',\n    ')}
), required_privileges(table_name, privilege_name, expected) AS (
  VALUES ${privilegeRows.join(',\n    ')}
), runtime_role AS (
  SELECT current_user AS role_name, role_row.oid AS role_oid
    FROM pg_roles role_row WHERE role_row.rolname = current_user
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
     AND actual.attnum > 0 AND NOT actual.attisdropped
   WHERE actual.attnum IS NULL
      OR format_type(actual.atttypid, actual.atttypmod) <> expected.data_type
      OR actual.attnotnull <> expected.is_not_null
  UNION ALL
  SELECT 'constraint-definition:' || expected.table_name || '.' || expected.constraint_name
    FROM required_constraints expected
    LEFT JOIN pg_constraint actual
      ON actual.conrelid = to_regclass('public.' || expected.table_name)
     AND actual.conname = expected.constraint_name
     AND actual.connamespace = 'public'::regnamespace
   WHERE actual.oid IS NULL
      OR (expected.expected_validated IS NOT NULL
        AND actual.convalidated <> expected.expected_validated)
      OR actual.condeferrable IS NOT FALSE
      OR actual.condeferred IS NOT FALSE
  UNION ALL
  SELECT 'index-definition:' || expected.index_name
    FROM required_indexes expected
    LEFT JOIN pg_class index_relation
      ON index_relation.relnamespace = 'public'::regnamespace
     AND index_relation.relname = expected.index_name
     AND index_relation.relkind = 'i'
    LEFT JOIN pg_index actual ON actual.indexrelid = index_relation.oid
   WHERE actual.indexrelid IS NULL OR actual.indisvalid IS NOT TRUE
      OR actual.indisready IS NOT TRUE OR actual.indislive IS NOT TRUE
      OR actual.indisunique <> expected.is_unique
      OR regexp_replace(COALESCE(pg_get_expr(actual.indpred, actual.indrelid), ''), '\\s+', ' ', 'g')
         <> regexp_replace(expected.predicate, '\\s+', ' ', 'g')
  UNION ALL
  SELECT 'trigger-definition:' || expected.table_name || '.' || expected.trigger_name
    FROM required_triggers expected
    LEFT JOIN pg_class relation
      ON relation.relnamespace = 'public'::regnamespace
     AND relation.relname = expected.table_name
    LEFT JOIN pg_trigger actual
      ON actual.tgrelid = relation.oid
     AND actual.tgname = expected.trigger_name
     AND NOT actual.tgisinternal
    LEFT JOIN pg_proc function_row ON function_row.oid = actual.tgfoid
    LEFT JOIN pg_namespace function_namespace ON function_namespace.oid = function_row.pronamespace
    LEFT JOIN pg_language function_language ON function_language.oid = function_row.prolang
   WHERE actual.oid IS NULL OR actual.tgenabled <> 'O'
      OR actual.tgtype <> expected.trigger_type
      OR actual.tgdeferrable <> expected.expected_deferrable
      OR actual.tginitdeferred <> expected.expected_initially_deferred
      OR ((actual.tgconstraint <> 0) <> expected.expected_constraint)
      OR actual.tgqual IS NOT NULL
      OR function_namespace.nspname <> 'public'
      OR function_row.proname <> expected.function_name
      OR function_row.pronargs <> 0 OR function_row.prorettype <> 'trigger'::regtype
      OR function_row.prokind <> 'f' OR function_row.provolatile <> 'v'
      OR function_language.lanname <> 'plpgsql'
      OR md5(function_row.prosrc) <> expected.source_md5
  UNION ALL
  SELECT 'runtime-owner:' || relation.relname
    FROM pg_class relation CROSS JOIN runtime_role runtime
   WHERE relation.relnamespace = 'public'::regnamespace
     AND relation.relname IN ('peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_audit')
     AND relation.relowner = runtime.role_oid
  UNION ALL
  SELECT 'table-privilege:' || expected.table_name || '.' || expected.privilege_name
    FROM required_privileges expected CROSS JOIN runtime_role runtime
   WHERE COALESCE(
     has_table_privilege(runtime.role_oid, to_regclass('public.' || expected.table_name), expected.privilege_name),
     FALSE
   ) <> expected.expected
  UNION ALL
  SELECT 'sequence-privilege:peakos_tax_invoice_evidence_audit_id_seq.' || privilege.privilege_name
    FROM (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) AS privilege(privilege_name)
    CROSS JOIN runtime_role runtime
   WHERE COALESCE(
     has_sequence_privilege(runtime.role_oid, to_regclass('public.peakos_tax_invoice_evidence_audit_id_seq'), privilege.privilege_name),
     FALSE
   ) IS NOT FALSE
  UNION ALL
  SELECT 'function-privilege:' || function_name || '.execute'
    FROM (VALUES
      ('peakos_tax_invoice_evidence_reject_mutation'),
      ('peakos_tax_invoice_evidence_validate_insert'),
      ('peakos_tax_invoice_evidence_audit_insert'),
      ('peakos_tax_invoice_evidence_validate_commit'),
      ('peakos_finance_request_invoice_evidence_guard')
    ) AS functions(function_name)
    CROSS JOIN runtime_role runtime
   WHERE COALESCE(
     has_function_privilege(
       runtime.role_oid,
       to_regprocedure('public.' || function_name || '()'),
       'EXECUTE'
     ), FALSE
   ) IS NOT FALSE
  UNION ALL
  SELECT 'public-table-privilege:' || grant_row.table_name || '.' || grant_row.privilege_type
    FROM information_schema.role_table_grants grant_row
   WHERE grant_row.table_schema = 'public'
     AND grant_row.table_name IN ('peakos_tax_invoice_evidence', 'peakos_tax_invoice_evidence_audit')
     AND grant_row.grantee = 'PUBLIC'
)
SELECT NOT EXISTS (SELECT 1 FROM missing) AS ready,
       COALESCE(array_agg(requirement ORDER BY requirement)
         FILTER (WHERE requirement IS NOT NULL), ARRAY[]::text[]) AS missing_requirements
  FROM missing
`.trim();

function taxInvoiceEvidenceReadiness(row) {
  const missing = Array.isArray(row?.missing_requirements)
    ? row.missing_requirements.map(String)
    : [];
  if (row?.ready === true && missing.length === 0) return Object.freeze({ ready: true, missing: [] });
  return Object.freeze({
    ready: false,
    code: 'TAX_INVOICE_EVIDENCE_SCHEMA_NOT_READY',
    missing,
    error: `세금계산서 증빙 스키마가 준비되지 않았습니다. ${path.basename(MIGRATION_PATH)}을 운영자 권한으로 적용해 주세요.`,
  });
}

async function ensurePeakosTaxInvoiceEvidenceInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  const result = await pool.query(TAX_INVOICE_EVIDENCE_READINESS_SQL);
  const readiness = taxInvoiceEvidenceReadiness(result.rows[0]);
  if (!readiness.ready) {
    const error = new Error(readiness.error);
    error.code = readiness.code;
    error.missing = readiness.missing;
    throw error;
  }
  return readiness;
}

module.exports = {
  MIGRATION_PATH,
  REQUIRED_COLUMNS,
  REQUIRED_CONSTRAINTS,
  REQUIRED_INDEXES,
  REQUIRED_TRIGGERS,
  TABLE_PRIVILEGES,
  TAX_INVOICE_EVIDENCE_READINESS_SQL,
  ensurePeakosTaxInvoiceEvidenceInfrastructure,
  taxInvoiceEvidenceReadiness,
};
