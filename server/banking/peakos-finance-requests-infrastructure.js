'use strict';

const FINANCE_REQUEST_MIGRATION_FILE = '20260818_peakos_refund_deposit_gate.sql';

const REFUND_DEPOSIT_GUARD_SOURCE = `
DECLARE
  linked_transaction public.peakos_bank_transactions%ROWTYPE;
BEGIN
  IF NEW.kind NOT IN ('REFUND_CLIENT', 'REFUND_MISTAKEN')
     OR NEW.status <> 'COMPLETED' THEN
    RETURN NEW;
  END IF;

  IF NEW.bank_transaction_id IS NULL
     OR NEW.refund_deposit_confirmed_at IS NULL
     OR NEW.refund_deposit_confirmed_by_uid IS NULL
     OR NEW.refund_deposit_confirmed_by_name IS NULL THEN
    RAISE EXCEPTION 'refund completion requires a confirmed deposit'
      USING ERRCODE = '23514';
  END IF;

  SELECT transaction.*
    INTO linked_transaction
    FROM public.peakos_bank_transactions transaction
   WHERE transaction.workspace_id = NEW.workspace_id
     AND transaction.id = NEW.bank_transaction_id
   FOR UPDATE;

  IF NOT FOUND
     OR linked_transaction.direction <> 'DEPOSIT'
     OR linked_transaction.source NOT IN ('BANK_SYNC', 'COLLECTOR')
     OR linked_transaction.reconciliation_status IN ('IGNORED', 'REVERSED')
     OR linked_transaction.amount < NEW.amount_vat
     OR (NEW.source_account_id IS NOT NULL
         AND linked_transaction.account_id <> NEW.source_account_id) THEN
    RAISE EXCEPTION 'linked bank transaction is not a verified refund deposit'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
`.trim();

const BANK_REFUND_LINK_GUARD_SOURCE = `
DECLARE
  invalid_linked_refund_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT request.id
      INTO invalid_linked_refund_id
      FROM public.peakos_finance_requests request
     WHERE request.workspace_id = OLD.workspace_id
       AND request.bank_transaction_id = OLD.id
       AND request.kind IN ('REFUND_CLIENT', 'REFUND_MISTAKEN')
       AND request.status = 'COMPLETED'
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'bank transaction linked to a completed refund cannot be deleted'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_bank_transactions_refund_link_guard';
    END IF;
    RETURN OLD;
  END IF;

  SELECT request.id
    INTO invalid_linked_refund_id
    FROM public.peakos_finance_requests request
   WHERE request.workspace_id = OLD.workspace_id
     AND request.bank_transaction_id = OLD.id
     AND request.kind IN ('REFUND_CLIENT', 'REFUND_MISTAKEN')
     AND request.status = 'COMPLETED'
     AND (
       NEW.workspace_id IS DISTINCT FROM request.workspace_id
       OR NEW.id IS DISTINCT FROM request.bank_transaction_id
       OR NEW.direction IS DISTINCT FROM 'DEPOSIT'
       OR NEW.source IS NULL
       OR NEW.source NOT IN ('BANK_SYNC', 'COLLECTOR')
       OR NEW.reconciliation_status IS NULL
       OR NEW.reconciliation_status IN ('IGNORED', 'REVERSED')
       OR NEW.amount IS NULL
       OR NEW.amount < request.amount_vat
       OR (request.source_account_id IS NOT NULL
           AND NEW.account_id IS DISTINCT FROM request.source_account_id)
     )
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'bank transaction linked to a completed refund must remain a verified deposit'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_bank_transactions_refund_link_guard';
  END IF;
  RETURN NEW;
END
`.trim();

const REFUND_DEPOSIT_CONFIRMATION_CONSTRAINT = "CHECK ((((kind = ANY (ARRAY['REFUND_CLIENT'::text, 'REFUND_MISTAKEN'::text])) AND (status = 'COMPLETED'::text) AND (bank_transaction_id IS NOT NULL) AND (refund_deposit_confirmed_at IS NOT NULL) AND (refund_deposit_confirmed_by_uid IS NOT NULL) AND ((char_length(btrim(refund_deposit_confirmed_by_uid)) >= 1) AND (char_length(btrim(refund_deposit_confirmed_by_uid)) <= 256)) AND (refund_deposit_confirmed_by_name IS NOT NULL) AND ((char_length(btrim(refund_deposit_confirmed_by_name)) >= 1) AND (char_length(btrim(refund_deposit_confirmed_by_name)) <= 120))) OR ((NOT ((kind = ANY (ARRAY['REFUND_CLIENT'::text, 'REFUND_MISTAKEN'::text])) AND (status = 'COMPLETED'::text))) AND (refund_deposit_confirmed_at IS NULL) AND (refund_deposit_confirmed_by_uid IS NULL) AND (refund_deposit_confirmed_by_name IS NULL))))";

const REQUIRED_COLUMNS = Object.freeze([
  Object.freeze(['peakos_finance_requests', 'workspace_id', 'text', true]),
  Object.freeze(['peakos_finance_requests', 'version', 'integer', true]),
  Object.freeze(['peakos_finance_requests', 'bank_transaction_id', 'bigint', false]),
  Object.freeze(['peakos_finance_requests', 'refund_deposit_confirmed_at', 'timestamp with time zone', false]),
  Object.freeze(['peakos_finance_requests', 'refund_deposit_confirmed_by_uid', 'text', false]),
  Object.freeze(['peakos_finance_requests', 'refund_deposit_confirmed_by_name', 'text', false]),
  Object.freeze(['peakos_finance_request_events', 'workspace_id', 'text', true]),
  Object.freeze(['peakos_bank_transactions', 'workspace_id', 'text', true]),
  Object.freeze(['peakos_bank_transactions', 'direction', 'text', true]),
  Object.freeze(['peakos_bank_transactions', 'amount', 'bigint', true]),
  Object.freeze(['peakos_bank_transactions', 'reconciliation_status', 'text', true]),
  Object.freeze(['peakos_bank_transactions', 'source', 'text', true]),
]);

const REQUIRED_CONSTRAINTS = Object.freeze([
  Object.freeze(['peakos_finance_requests', 'peakos_finance_requests_workspace_fk']),
  Object.freeze(['peakos_finance_requests', 'peakos_finance_requests_workspace_source_account_fk']),
  Object.freeze(['peakos_finance_requests', 'peakos_finance_requests_workspace_bank_transaction_fk']),
  Object.freeze(['peakos_finance_requests', 'peakos_finance_requests_version_check']),
  Object.freeze(['peakos_finance_requests', 'peakos_finance_requests_refund_deposit_confirmation_check']),
  Object.freeze(['peakos_finance_request_events', 'peakos_finance_request_events_workspace_request_fk']),
]);
const REQUIRED_CONSTRAINT_NAMES = Object.freeze(REQUIRED_CONSTRAINTS.map(([, name]) => name));

const REQUIRED_INDEX_DEFINITIONS = Object.freeze({
  peakos_finance_requests_workspace_id_unique: Object.freeze([
    true,
    'CREATE UNIQUE INDEX peakos_finance_requests_workspace_id_unique ON public.peakos_finance_requests USING btree (workspace_id, id)',
    '',
  ]),
  peakos_finance_requests_workspace_date_idx: Object.freeze([
    false,
    'CREATE INDEX peakos_finance_requests_workspace_date_idx ON public.peakos_finance_requests USING btree (workspace_id, request_date DESC, created_at DESC, id DESC)',
    '',
  ]),
  peakos_finance_requests_workspace_requester_idempotency_idx: Object.freeze([
    true,
    'CREATE UNIQUE INDEX peakos_finance_requests_workspace_requester_idempotency_idx ON public.peakos_finance_requests USING btree (workspace_id, requester_uid, idempotency_key) WHERE (idempotency_key IS NOT NULL)',
    '(idempotency_key IS NOT NULL)',
  ]),
  peakos_finance_requests_workspace_external_document_idx: Object.freeze([
    true,
    'CREATE UNIQUE INDEX peakos_finance_requests_workspace_external_document_idx ON public.peakos_finance_requests USING btree (workspace_id, platform_key, external_document_id) WHERE ((platform_key IS NOT NULL) AND (external_document_id IS NOT NULL))',
    '((platform_key IS NOT NULL) AND (external_document_id IS NOT NULL))',
  ]),
  peakos_finance_requests_refund_deposit_unique: Object.freeze([
    true,
    "CREATE UNIQUE INDEX peakos_finance_requests_refund_deposit_unique ON public.peakos_finance_requests USING btree (workspace_id, bank_transaction_id) WHERE ((kind = ANY (ARRAY['REFUND_CLIENT'::text, 'REFUND_MISTAKEN'::text])) AND (status = 'COMPLETED'::text) AND (bank_transaction_id IS NOT NULL))",
    "((kind = ANY (ARRAY['REFUND_CLIENT'::text, 'REFUND_MISTAKEN'::text])) AND (status = 'COMPLETED'::text) AND (bank_transaction_id IS NOT NULL))",
  ]),
  peakos_finance_request_events_workspace_request_idx: Object.freeze([
    false,
    'CREATE INDEX peakos_finance_request_events_workspace_request_idx ON public.peakos_finance_request_events USING btree (workspace_id, request_id, created_at, id)',
    '',
  ]),
  peakos_bank_transactions_workspace_id_unique: Object.freeze([
    true,
    'CREATE UNIQUE INDEX peakos_bank_transactions_workspace_id_unique ON public.peakos_bank_transactions USING btree (workspace_id, id)',
    '',
  ]),
});
const REQUIRED_INDEX_NAMES = Object.freeze(Object.keys(REQUIRED_INDEX_DEFINITIONS));
const FORBIDDEN_INDEX_NAMES = Object.freeze([
  'peakos_finance_requests_requester_idempotency_idx',
  'peakos_finance_requests_external_document_idx',
]);

const TABLE_PRIVILEGES = Object.freeze({
  peakos_finance_requests: Object.freeze({
    SELECT: true, INSERT: true, UPDATE: true, DELETE: false,
    TRUNCATE: false, REFERENCES: false, TRIGGER: false,
  }),
  peakos_finance_request_events: Object.freeze({
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
const constraintRows = REQUIRED_CONSTRAINTS.map(([table, name]) => (
  `(${sqlString(table)},${sqlString(name)})`
));
const indexRows = Object.entries(REQUIRED_INDEX_DEFINITIONS).map(([
  name, [unique, definition, predicate],
]) => `(${sqlString(name)},${unique ? 'TRUE' : 'FALSE'},${sqlString(definition)},${sqlString(predicate)})`);
const privilegeRows = Object.entries(TABLE_PRIVILEGES).flatMap(([table, privileges]) => (
  Object.entries(privileges).map(([privilege, allowed]) => (
    `(${sqlString(table)},${sqlString(privilege)},${allowed ? 'TRUE' : 'FALSE'})`
  ))
));

const FINANCE_REQUEST_SCHEMA_READINESS_SQL = `
WITH required_columns(table_name, column_name, data_type, is_not_null) AS (
  VALUES ${columnRows.join(',\n    ')}
), required_constraints(table_name, constraint_name) AS (
  VALUES ${constraintRows.join(',\n    ')}
), required_indexes(index_name, is_unique, definition, predicate) AS (
  VALUES ${indexRows.join(',\n    ')}
), forbidden_indexes(index_name) AS (
  VALUES ${FORBIDDEN_INDEX_NAMES.map(name => `(${sqlString(name)})`).join(',\n    ')}
), required_table_privileges(table_name, privilege_name, expected) AS (
  VALUES ${privilegeRows.join(',\n    ')}
), runtime_role AS (
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
    LEFT JOIN pg_constraint actual
      ON actual.conname = expected.constraint_name
     AND actual.connamespace = 'public'::regnamespace
     AND actual.conrelid = to_regclass('public.' || expected.table_name)
   WHERE actual.oid IS NULL OR actual.convalidated IS NOT TRUE
      OR CASE expected.constraint_name
        WHEN 'peakos_finance_requests_workspace_fk' THEN
          pg_get_constraintdef(actual.oid) <> 'FOREIGN KEY (workspace_id) REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT'
        WHEN 'peakos_finance_requests_workspace_source_account_fk' THEN
          pg_get_constraintdef(actual.oid) <> 'FOREIGN KEY (workspace_id, source_account_id) REFERENCES peakos_bank_accounts(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'
        WHEN 'peakos_finance_requests_workspace_bank_transaction_fk' THEN
          pg_get_constraintdef(actual.oid) <> 'FOREIGN KEY (workspace_id, bank_transaction_id) REFERENCES peakos_bank_transactions(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'
        WHEN 'peakos_finance_requests_version_check' THEN
          pg_get_constraintdef(actual.oid) <> 'CHECK (((version >= 1) AND (version <= 2147483647)))'
        WHEN 'peakos_finance_requests_refund_deposit_confirmation_check' THEN
          pg_get_constraintdef(actual.oid) <> ${sqlString(REFUND_DEPOSIT_CONFIRMATION_CONSTRAINT)}
        WHEN 'peakos_finance_request_events_workspace_request_fk' THEN
          pg_get_constraintdef(actual.oid) <> 'FOREIGN KEY (workspace_id, request_id) REFERENCES peakos_finance_requests(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'
        ELSE TRUE
      END
  UNION ALL
  SELECT 'trigger-definition:peakos_finance_requests.peakos_finance_requests_refund_deposit_guard'
    FROM pg_namespace namespace
    LEFT JOIN pg_class relation
      ON relation.relnamespace = namespace.oid
     AND relation.relname = 'peakos_finance_requests'
    LEFT JOIN pg_trigger actual
      ON actual.tgrelid = relation.oid
     AND actual.tgname = 'peakos_finance_requests_refund_deposit_guard'
     AND NOT actual.tgisinternal
    LEFT JOIN pg_proc trigger_function ON trigger_function.oid = actual.tgfoid
    LEFT JOIN pg_namespace function_namespace ON function_namespace.oid = trigger_function.pronamespace
    LEFT JOIN pg_language trigger_language ON trigger_language.oid = trigger_function.prolang
   WHERE namespace.nspname = 'public'
     AND (
       actual.oid IS NULL OR actual.tgenabled <> 'O' OR actual.tgtype <> 23
       OR actual.tgdeferrable IS NOT FALSE OR actual.tginitdeferred IS NOT FALSE
       OR actual.tgconstraint <> 0 OR actual.tgqual IS NOT NULL
       OR actual.tgattr::text <> '' OR actual.tgnargs <> 0 OR octet_length(actual.tgargs) <> 0
       OR function_namespace.nspname <> 'public'
       OR trigger_function.proname <> 'peakos_finance_refund_deposit_guard'
       OR trigger_function.pronargs <> 0 OR trigger_function.prorettype <> 'trigger'::regtype
       OR trigger_function.prokind <> 'f' OR trigger_function.provolatile <> 'v'
       OR trigger_function.prosecdef IS NOT FALSE OR trigger_language.lanname <> 'plpgsql'
       OR btrim(regexp_replace(trigger_function.prosrc, '\\s+', ' ', 'g'))
          <> btrim(regexp_replace(${sqlString(REFUND_DEPOSIT_GUARD_SOURCE)}, '\\s+', ' ', 'g'))
       OR regexp_replace(btrim(pg_get_triggerdef(actual.oid)), '\\s+', ' ', 'g')
          <> 'CREATE TRIGGER peakos_finance_requests_refund_deposit_guard BEFORE INSERT OR UPDATE ON public.peakos_finance_requests FOR EACH ROW EXECUTE FUNCTION peakos_finance_refund_deposit_guard()'
     )
  UNION ALL
  SELECT 'trigger-definition:peakos_bank_transactions.peakos_bank_transactions_refund_link_guard'
    FROM pg_namespace namespace
    LEFT JOIN pg_class relation
      ON relation.relnamespace = namespace.oid
     AND relation.relname = 'peakos_bank_transactions'
    LEFT JOIN pg_trigger actual
      ON actual.tgrelid = relation.oid
     AND actual.tgname = 'peakos_bank_transactions_refund_link_guard'
     AND NOT actual.tgisinternal
    LEFT JOIN pg_proc trigger_function ON trigger_function.oid = actual.tgfoid
    LEFT JOIN pg_namespace function_namespace ON function_namespace.oid = trigger_function.pronamespace
    LEFT JOIN pg_language trigger_language ON trigger_language.oid = trigger_function.prolang
   WHERE namespace.nspname = 'public'
     AND (
       actual.oid IS NULL OR actual.tgenabled <> 'O' OR actual.tgtype <> 27
       OR actual.tgdeferrable IS NOT FALSE OR actual.tginitdeferred IS NOT FALSE
       OR actual.tgconstraint <> 0 OR actual.tgqual IS NOT NULL
       OR actual.tgattr::text <> '' OR actual.tgnargs <> 0 OR octet_length(actual.tgargs) <> 0
       OR function_namespace.nspname <> 'public'
       OR trigger_function.proname <> 'peakos_bank_refund_link_guard'
       OR trigger_function.pronargs <> 0 OR trigger_function.prorettype <> 'trigger'::regtype
       OR trigger_function.prokind <> 'f' OR trigger_function.provolatile <> 'v'
       OR trigger_function.prosecdef IS NOT FALSE OR trigger_language.lanname <> 'plpgsql'
       OR btrim(regexp_replace(trigger_function.prosrc, '\\s+', ' ', 'g'))
          <> btrim(regexp_replace(${sqlString(BANK_REFUND_LINK_GUARD_SOURCE)}, '\\s+', ' ', 'g'))
       OR regexp_replace(btrim(pg_get_triggerdef(actual.oid)), '\\s+', ' ', 'g')
          <> 'CREATE TRIGGER peakos_bank_transactions_refund_link_guard BEFORE DELETE OR UPDATE ON public.peakos_bank_transactions FOR EACH ROW EXECUTE FUNCTION peakos_bank_refund_link_guard()'
     )
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
      OR regexp_replace(COALESCE(pg_get_indexdef(actual.indexrelid), ''), '\\s+', ' ', 'g')
         <> regexp_replace(expected.definition, '\\s+', ' ', 'g')
      OR regexp_replace(COALESCE(pg_get_expr(actual.indpred, actual.indrelid), ''), '\\s+', ' ', 'g')
         <> regexp_replace(expected.predicate, '\\s+', ' ', 'g')
  UNION ALL
  SELECT 'forbidden-index:' || forbidden.index_name
    FROM forbidden_indexes forbidden
    JOIN pg_class index_relation
      ON index_relation.relnamespace = 'public'::regnamespace
     AND index_relation.relname = forbidden.index_name
     AND index_relation.relkind = 'i'
  UNION ALL
  SELECT 'runtime-owner:' || relation.relname
    FROM pg_class relation
    CROSS JOIN runtime_role runtime
   WHERE relation.relnamespace = 'public'::regnamespace
     AND relation.relname IN ('peakos_finance_requests', 'peakos_finance_request_events')
     AND relation.relowner = runtime.role_oid
  UNION ALL
  SELECT 'table-privilege:' || expected.table_name || '.' || expected.privilege_name
    FROM required_table_privileges expected
    CROSS JOIN runtime_role runtime
   WHERE COALESCE(
     has_table_privilege(runtime.role_oid, to_regclass('public.' || expected.table_name), expected.privilege_name),
     FALSE
   ) <> expected.expected
  UNION ALL
  SELECT 'sequence-privilege:peakos_finance_request_events_id_seq.' || privilege.privilege_name
    FROM (VALUES ('USAGE', TRUE), ('SELECT', FALSE), ('UPDATE', FALSE)) AS privilege(privilege_name, expected)
    CROSS JOIN runtime_role runtime
   WHERE COALESCE(
     has_sequence_privilege(runtime.role_oid, to_regclass('public.peakos_finance_request_events_id_seq'), privilege.privilege_name),
     FALSE
   ) <> privilege.expected
  UNION ALL
  SELECT 'function-privilege:peakos_finance_refund_deposit_guard.execute'
    FROM runtime_role runtime
   WHERE COALESCE(
     has_function_privilege(runtime.role_oid, to_regprocedure('public.peakos_finance_refund_deposit_guard()'), 'EXECUTE'),
     FALSE
   ) IS NOT FALSE
  UNION ALL
  SELECT 'function-privilege:peakos_bank_refund_link_guard.execute'
    FROM runtime_role runtime
   WHERE COALESCE(
     has_function_privilege(runtime.role_oid, to_regprocedure('public.peakos_bank_refund_link_guard()'), 'EXECUTE'),
     FALSE
   ) IS NOT FALSE
  UNION ALL
  SELECT 'dependency-select-privilege:' || dependency.table_name
    FROM (VALUES
      ('peakos_bank_transactions'),
      ('peakos_bank_accounts'),
      ('peakos_workspaces')
    ) AS dependency(table_name)
    CROSS JOIN runtime_role runtime
   WHERE COALESCE(
     has_table_privilege(runtime.role_oid, to_regclass('public.' || dependency.table_name), 'SELECT'),
     FALSE
   ) IS NOT TRUE
  UNION ALL
  SELECT 'public-table-privilege:' || grant_row.table_name || '.' || grant_row.privilege_type
    FROM information_schema.role_table_grants grant_row
   WHERE grant_row.table_schema = 'public'
     AND grant_row.table_name IN ('peakos_finance_requests', 'peakos_finance_request_events')
     AND grant_row.grantee = 'PUBLIC'
)
SELECT NOT EXISTS (SELECT 1 FROM missing) AS ready,
       COALESCE(array_agg(requirement ORDER BY requirement)
         FILTER (WHERE requirement IS NOT NULL), ARRAY[]::text[]) AS missing_requirements
  FROM missing
`.trim();

function financeRequestSchemaReadiness(row) {
  const missing = Array.isArray(row?.missing_requirements)
    ? row.missing_requirements.map(String)
    : [];
  if (row?.ready === true && missing.length === 0) return { ready: true, missing: [] };
  return {
    ready: false,
    code: 'FINANCE_REQUEST_SCHEMA_NOT_READY',
    missing,
    error: `금융 요청 스키마가 준비되지 않았습니다. ${FINANCE_REQUEST_MIGRATION_FILE}을 운영자 권한으로 적용해 주세요.`,
  };
}

async function ensurePeakosFinanceRequestInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  const result = await pool.query(FINANCE_REQUEST_SCHEMA_READINESS_SQL);
  const readiness = financeRequestSchemaReadiness(result.rows[0]);
  if (!readiness.ready) {
    const error = new Error(readiness.error);
    error.code = readiness.code;
    error.missing = readiness.missing;
    throw error;
  }
  return readiness;
}

module.exports = {
  BANK_REFUND_LINK_GUARD_SOURCE,
  FINANCE_REQUEST_MIGRATION_FILE,
  FINANCE_REQUEST_SCHEMA_READINESS_SQL,
  FORBIDDEN_INDEX_NAMES,
  REFUND_DEPOSIT_CONFIRMATION_CONSTRAINT,
  REFUND_DEPOSIT_GUARD_SOURCE,
  REQUIRED_COLUMNS,
  REQUIRED_CONSTRAINTS,
  REQUIRED_CONSTRAINT_NAMES,
  REQUIRED_INDEX_DEFINITIONS,
  REQUIRED_INDEX_NAMES,
  TABLE_PRIVILEGES,
  ensurePeakosFinanceRequestInfrastructure,
  financeRequestSchemaReadiness,
};
