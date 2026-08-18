-- Canonical, workspace-scoped platform settlement ledger.
--
-- This migration deliberately does not contain a vendor API client or an API
-- key.  `credential_secret_ref` is an opaque reference to operator-managed
-- secret storage; plaintext vendor credentials must never be written here.

-- DBA/operator owned migration. The server only performs SELECT-based
-- readiness checks and never creates or weakens this financial schema.

BEGIN;

SET LOCAL search_path = public, pg_temp;

SELECT pg_advisory_xact_lock(hashtext('peakos-platform-monthly-settlement-v1'));

DO $platform_prerequisites$
BEGIN
  IF to_regclass('public.peakos_workspaces') IS NULL
     OR to_regclass('public.peakos_workspace_memberships') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.peakos_intake') IS NULL THEN
    RAISE EXCEPTION
      'workspace and settlement migrations must be applied before platform monthly settlement'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('peakos_workspaces', 'id'),
        ('peakos_workspaces', 'active'),
        ('peakos_workspace_memberships', 'workspace_id'),
        ('peakos_workspace_memberships', 'user_uid'),
        ('peakos_workspace_memberships', 'role'),
        ('peakos_workspace_memberships', 'active'),
        ('users', 'uid'),
        ('users', 'name'),
        ('users', 'approved'),
        ('users', 'is_active'),
        ('users', 'chat_only'),
        ('users', 'external_calendar_only'),
        ('peakos_intake', 'workspace_id'),
        ('peakos_intake', 'owner_uid'),
        ('peakos_intake', 'date'),
        ('peakos_intake', 'final_only'),
        ('peakos_intake', 'kind'),
        ('peakos_intake', 'sell'),
        ('peakos_intake', 'unit'),
        ('peakos_intake', 'qty')
      ) AS required(table_name, column_name)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_namespace namespace
         JOIN pg_class relation ON relation.relnamespace = namespace.oid
         JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
        WHERE namespace.nspname = 'public'
          AND relation.relname = required.table_name
          AND relation.relkind IN ('r','p')
          AND attribute.attname = required.column_name
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
     )
  ) THEN
    RAISE EXCEPTION
      'platform monthly settlement prerequisite columns are missing'
      USING ERRCODE = '55000';
  END IF;
END
$platform_prerequisites$;

CREATE TABLE IF NOT EXISTS peakos_platform_connections (
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  version INTEGER NOT NULL,
  connection_state TEXT NOT NULL DEFAULT 'pending',
  credential_secret_ref TEXT,
  last_successful_import_at TIMESTAMPTZ,
  last_error_code TEXT,
  actor_uid TEXT NOT NULL,
  actor_name_snapshot TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, provider, version),
  CONSTRAINT peakos_platform_connections_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_platform_connections_provider_check
    CHECK (provider IN ('rewardspace', 'reviewspace', 'keywordmaster', 'brandautospace', 'reviewflow')),
  CONSTRAINT peakos_platform_connections_version_check CHECK (version > 0),
  CONSTRAINT peakos_platform_connections_state_check
    CHECK (connection_state IN ('pending', 'ready', 'error', 'disabled')),
  CONSTRAINT peakos_platform_connections_secret_ref_check
    CHECK (
      credential_secret_ref IS NULL
      OR (
        char_length(credential_secret_ref) BETWEEN 1 AND 512
        AND credential_secret_ref ~ '^[A-Za-z0-9][A-Za-z0-9:/._-]*$'
      )
    ),
  CONSTRAINT peakos_platform_connections_ready_secret_check
    CHECK (connection_state <> 'ready' OR credential_secret_ref IS NOT NULL),
  CONSTRAINT peakos_platform_connections_error_check
    CHECK (
      (connection_state = 'error' AND last_error_code IS NOT NULL
        AND last_error_code ~ '^[A-Z0-9_]{1,80}$')
      OR (connection_state <> 'error' AND last_error_code IS NULL)
    ),
  CONSTRAINT peakos_platform_connections_actor_check
    CHECK (char_length(btrim(actor_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_platform_connections_actor_name_check
    CHECK (char_length(actor_name_snapshot) <= 160)
);

CREATE TABLE IF NOT EXISTS peakos_platform_salesperson_mappings (
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  id UUID NOT NULL,
  version INTEGER NOT NULL,
  supersedes_id UUID,
  operation_key TEXT NOT NULL,
  external_name_normalized TEXT NOT NULL,
  external_name_snapshot TEXT NOT NULL,
  owner_uid TEXT,
  owner_name_snapshot TEXT,
  mapping_state TEXT NOT NULL DEFAULT 'active',
  match_method TEXT NOT NULL DEFAULT 'exact_name',
  correction_reason TEXT,
  actor_uid TEXT NOT NULL,
  actor_name_snapshot TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, provider, id),
  CONSTRAINT peakos_platform_salesperson_mappings_version_unique
    UNIQUE (workspace_id, provider, external_name_normalized, version),
  CONSTRAINT peakos_platform_salesperson_mappings_operation_unique
    UNIQUE (workspace_id, provider, operation_key),
  CONSTRAINT peakos_platform_salesperson_mappings_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_platform_salesperson_mappings_owner_membership_fk
    FOREIGN KEY (workspace_id, owner_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_platform_salesperson_mappings_supersedes_fk
    FOREIGN KEY (workspace_id, provider, supersedes_id)
    REFERENCES peakos_platform_salesperson_mappings(workspace_id, provider, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_platform_salesperson_mappings_provider_check
    CHECK (provider IN ('rewardspace', 'reviewspace', 'keywordmaster', 'brandautospace', 'reviewflow')),
  CONSTRAINT peakos_platform_salesperson_mappings_external_name_check
    CHECK (char_length(external_name_normalized) BETWEEN 1 AND 160),
  CONSTRAINT peakos_platform_salesperson_mappings_external_snapshot_check
    CHECK (char_length(btrim(external_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_platform_salesperson_mappings_operation_check
    CHECK (operation_key ~ '^[A-Za-z0-9:._/-]{1,240}$'),
  CONSTRAINT peakos_platform_salesperson_mappings_version_check CHECK (version > 0),
  CONSTRAINT peakos_platform_salesperson_mappings_supersedes_check
    CHECK ((version = 1 AND supersedes_id IS NULL) OR (version > 1 AND supersedes_id IS NOT NULL)),
  CONSTRAINT peakos_platform_salesperson_mappings_state_check
    CHECK (mapping_state IN ('active', 'revoked')),
  CONSTRAINT peakos_platform_salesperson_mappings_owner_check
    CHECK (
      (mapping_state = 'active' AND owner_uid IS NOT NULL
        AND owner_name_snapshot IS NOT NULL
        AND char_length(btrim(owner_name_snapshot)) BETWEEN 1 AND 160)
      OR (mapping_state = 'revoked' AND owner_uid IS NULL AND owner_name_snapshot IS NULL)
    ),
  CONSTRAINT peakos_platform_salesperson_mappings_match_method_check
    CHECK (match_method IN ('exact_name', 'manual_correction', 'manual_revoke')),
  CONSTRAINT peakos_platform_salesperson_mappings_correction_check
    CHECK (
      (match_method = 'exact_name' AND version = 1 AND correction_reason IS NULL)
      OR (match_method = 'manual_correction'
        AND correction_reason IS NOT NULL
        AND char_length(btrim(correction_reason)) BETWEEN 8 AND 500)
      OR (match_method = 'manual_revoke' AND version > 1
        AND correction_reason IS NOT NULL
        AND char_length(btrim(correction_reason)) BETWEEN 8 AND 500)
    ),
  CONSTRAINT peakos_platform_salesperson_mappings_actor_check
    CHECK (char_length(btrim(actor_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_platform_salesperson_mappings_actor_name_check
    CHECK (char_length(actor_name_snapshot) <= 160)
);

CREATE TABLE IF NOT EXISTS peakos_platform_import_runs (
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  status TEXT NOT NULL,
  covered_from DATE NOT NULL,
  covered_to DATE NOT NULL,
  source_total_count INTEGER NOT NULL,
  snapshot_complete BOOLEAN NOT NULL,
  requested_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  mapped_count INTEGER NOT NULL DEFAULT 0,
  unmapped_count INTEGER NOT NULL DEFAULT 0,
  ambiguous_count INTEGER NOT NULL DEFAULT 0,
  actor_uid TEXT NOT NULL,
  actor_name_snapshot TEXT NOT NULL DEFAULT '',
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, provider, id),
  CONSTRAINT peakos_platform_import_runs_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_platform_import_runs_provider_check
    CHECK (provider IN ('rewardspace', 'reviewspace', 'keywordmaster', 'brandautospace', 'reviewflow')),
  CONSTRAINT peakos_platform_import_runs_idempotency_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9:._/-]{1,240}$'),
  CONSTRAINT peakos_platform_import_runs_digest_check
    CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_platform_import_runs_adapter_check
    CHECK (adapter_version ~ '^[A-Za-z0-9:._/-]{1,120}$'),
  CONSTRAINT peakos_platform_import_runs_status_check
    CHECK (status IN ('completed', 'failed')),
  CONSTRAINT peakos_platform_import_runs_coverage_check CHECK (covered_to >= covered_from),
  CONSTRAINT peakos_platform_import_runs_source_total_check
    CHECK (source_total_count >= 0 AND source_total_count = requested_count),
  CONSTRAINT peakos_platform_import_runs_snapshot_complete_check CHECK (snapshot_complete),
  CONSTRAINT peakos_platform_import_runs_counts_check
    CHECK (
      requested_count >= 0 AND inserted_count >= 0 AND mapped_count >= 0
      AND unmapped_count >= 0 AND ambiguous_count >= 0
      AND inserted_count <= requested_count
      AND mapped_count + unmapped_count + ambiguous_count = requested_count
    ),
  CONSTRAINT peakos_platform_import_runs_actor_check
    CHECK (char_length(btrim(actor_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_platform_import_runs_actor_name_check
    CHECK (char_length(actor_name_snapshot) <= 160),
  CONSTRAINT peakos_platform_import_runs_error_check
    CHECK (
      (status = 'failed' AND error_code IS NOT NULL
        AND error_code ~ '^[A-Z0-9_]{1,80}$')
      OR (status = 'completed' AND error_code IS NULL)
    ),
  CONSTRAINT peakos_platform_import_runs_time_check CHECK (completed_at >= started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS peakos_platform_import_runs_idempotency_uidx
  ON peakos_platform_import_runs(workspace_id, provider, idempotency_key);

CREATE TABLE IF NOT EXISTS peakos_platform_transaction_events (
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  id UUID NOT NULL,
  import_run_id UUID NOT NULL,
  external_transaction_id TEXT NOT NULL,
  event_fingerprint TEXT NOT NULL,
  source_updated_at TIMESTAMPTZ NOT NULL,
  business_date DATE NOT NULL,
  external_salesperson_name TEXT NOT NULL,
  external_name_normalized TEXT NOT NULL,
  attribution_status TEXT NOT NULL,
  owner_uid TEXT,
  owner_name_snapshot TEXT,
  record_state TEXT NOT NULL DEFAULT 'active',
  sales_amount NUMERIC(20, 0),
  profit_amount NUMERIC(20, 0),
  currency TEXT NOT NULL DEFAULT 'KRW',
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, provider, id),
  CONSTRAINT peakos_platform_transaction_events_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_platform_transaction_events_import_fk
    FOREIGN KEY (workspace_id, provider, import_run_id)
    REFERENCES peakos_platform_import_runs(workspace_id, provider, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_platform_transaction_events_owner_membership_fk
    FOREIGN KEY (workspace_id, owner_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_platform_transaction_events_provider_check
    CHECK (provider IN ('rewardspace', 'reviewspace', 'keywordmaster', 'brandautospace', 'reviewflow')),
  CONSTRAINT peakos_platform_transaction_events_external_id_check
    CHECK (char_length(btrim(external_transaction_id)) BETWEEN 1 AND 240),
  CONSTRAINT peakos_platform_transaction_events_fingerprint_check
    CHECK (event_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_platform_transaction_events_external_name_check
    CHECK (char_length(btrim(external_salesperson_name)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_platform_transaction_events_normalized_name_check
    CHECK (char_length(external_name_normalized) BETWEEN 1 AND 160),
  CONSTRAINT peakos_platform_transaction_events_attribution_check
    CHECK (
      (attribution_status = 'mapped' AND owner_uid IS NOT NULL
        AND owner_name_snapshot IS NOT NULL
        AND char_length(btrim(owner_name_snapshot)) BETWEEN 1 AND 160)
      OR (attribution_status IN ('unmapped', 'ambiguous')
        AND owner_uid IS NULL AND owner_name_snapshot IS NULL)
    ),
  CONSTRAINT peakos_platform_transaction_events_state_check
    CHECK (record_state IN ('active', 'voided')),
  CONSTRAINT peakos_platform_transaction_events_voided_amount_check
    CHECK (record_state <> 'voided' OR (sales_amount IS NULL AND profit_amount IS NULL)),
  CONSTRAINT peakos_platform_transaction_events_currency_check CHECK (currency = 'KRW')
);

CREATE UNIQUE INDEX IF NOT EXISTS peakos_platform_transaction_events_fingerprint_uidx
  ON peakos_platform_transaction_events(workspace_id, provider, event_fingerprint);

CREATE INDEX IF NOT EXISTS peakos_platform_transaction_events_self_month_idx
  ON peakos_platform_transaction_events(workspace_id, owner_uid, business_date, provider)
  WHERE attribution_status = 'mapped';

CREATE INDEX IF NOT EXISTS peakos_platform_transaction_events_current_idx
  ON peakos_platform_transaction_events(
    workspace_id, provider, external_transaction_id, source_updated_at DESC, imported_at DESC, id DESC
  );

CREATE INDEX IF NOT EXISTS peakos_platform_import_runs_latest_idx
  ON peakos_platform_import_runs(workspace_id, provider, completed_at DESC, id DESC)
  WHERE status = 'completed';

-- Some vendor contracts expose only a salesperson-level monthly aggregate.
-- Those responses cannot be represented honestly as transaction revisions, so
-- each complete response is kept as one immutable run with immutable rows.
CREATE TABLE IF NOT EXISTS peakos_platform_aggregate_runs (
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  id UUID NOT NULL,
  settlement_month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  covered_from DATE NOT NULL,
  covered_to DATE NOT NULL,
  idempotency_key TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  source_total_count INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  mapped_count INTEGER NOT NULL,
  ambiguous_count INTEGER NOT NULL,
  global_unmatched_count INTEGER NOT NULL,
  source_excluded_count INTEGER NOT NULL,
  source_state TEXT NOT NULL DEFAULT 'unknown',
  source_drift NUMERIC(20, 0),
  observed_at TIMESTAMPTZ NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name_snapshot TEXT NOT NULL DEFAULT '',
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, provider, id),
  CONSTRAINT peakos_platform_aggregate_runs_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_platform_aggregate_runs_provider_check
    CHECK (provider IN ('rewardspace', 'reviewspace', 'keywordmaster', 'brandautospace', 'reviewflow')),
  CONSTRAINT peakos_platform_aggregate_runs_month_check
    CHECK (settlement_month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  CONSTRAINT peakos_platform_aggregate_runs_status_check CHECK (status = 'completed'),
  CONSTRAINT peakos_platform_aggregate_runs_coverage_check
    CHECK (
      covered_to >= covered_from
      AND to_char(covered_from, 'YYYY-MM') = settlement_month
      AND to_char(covered_to, 'YYYY-MM') = settlement_month
    ),
  CONSTRAINT peakos_platform_aggregate_runs_idempotency_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9:._/-]{1,240}$'),
  CONSTRAINT peakos_platform_aggregate_runs_digest_check
    CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_platform_aggregate_runs_adapter_check
    CHECK (adapter_version ~ '^[A-Za-z0-9:._/-]{1,120}$'),
  CONSTRAINT peakos_platform_aggregate_runs_counts_check
    CHECK (
      source_total_count >= 0 AND row_count >= 0 AND mapped_count >= 0
      AND ambiguous_count >= 0 AND global_unmatched_count >= 0 AND source_excluded_count >= 0
      AND mapped_count + ambiguous_count = row_count
      AND row_count + global_unmatched_count + source_excluded_count = source_total_count
    ),
  CONSTRAINT peakos_platform_aggregate_runs_source_state_check
    CHECK (source_state IN ('live', 'draft', 'paid', 'unknown')),
  CONSTRAINT peakos_platform_aggregate_runs_source_drift_check
    CHECK (
      source_drift IS NULL
      OR source_drift BETWEEN -9007199254740991 AND 9007199254740991
    ),
  CONSTRAINT peakos_platform_aggregate_runs_actor_check
    CHECK (char_length(btrim(actor_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_platform_aggregate_runs_actor_name_check
    CHECK (char_length(actor_name_snapshot) <= 160),
  CONSTRAINT peakos_platform_aggregate_runs_time_check CHECK (completed_at >= observed_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS peakos_platform_aggregate_runs_idempotency_uidx
  ON peakos_platform_aggregate_runs(workspace_id, provider, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS peakos_platform_aggregate_runs_identity_uidx
  ON peakos_platform_aggregate_runs(
    workspace_id, provider, settlement_month, source_digest, adapter_version
  );

CREATE INDEX IF NOT EXISTS peakos_platform_aggregate_runs_latest_idx
  ON peakos_platform_aggregate_runs(
    workspace_id, provider, settlement_month, completed_at DESC, id DESC
  )
  WHERE status = 'completed';

CREATE TABLE IF NOT EXISTS peakos_platform_aggregate_rows (
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  id UUID NOT NULL,
  snapshot_run_id UUID NOT NULL,
  external_row_key TEXT NOT NULL,
  external_salesperson_name TEXT NOT NULL,
  external_name_normalized TEXT NOT NULL,
  attribution_status TEXT NOT NULL,
  owner_uid TEXT,
  owner_name_snapshot TEXT,
  sales_amount NUMERIC(20, 0),
  profit_amount NUMERIC(20, 0),
  profit_basis TEXT NOT NULL,
  source_record_count INTEGER,
  attribution_issue_code TEXT,
  attribution_issue_detail TEXT,
  currency TEXT NOT NULL DEFAULT 'KRW',
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, provider, id),
  CONSTRAINT peakos_platform_aggregate_rows_run_unique
    UNIQUE (workspace_id, provider, snapshot_run_id, external_row_key),
  CONSTRAINT peakos_platform_aggregate_rows_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_platform_aggregate_rows_run_fk
    FOREIGN KEY (workspace_id, provider, snapshot_run_id)
    REFERENCES peakos_platform_aggregate_runs(workspace_id, provider, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_platform_aggregate_rows_owner_membership_fk
    FOREIGN KEY (workspace_id, owner_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_platform_aggregate_rows_provider_check
    CHECK (provider IN ('rewardspace', 'reviewspace', 'keywordmaster', 'brandautospace', 'reviewflow')),
  CONSTRAINT peakos_platform_aggregate_rows_external_key_check
    CHECK (external_row_key ~ '^[A-Za-z0-9:._/-]{1,240}$'),
  CONSTRAINT peakos_platform_aggregate_rows_external_name_check
    CHECK (char_length(btrim(external_salesperson_name)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_platform_aggregate_rows_normalized_name_check
    CHECK (char_length(external_name_normalized) BETWEEN 1 AND 160),
  CONSTRAINT peakos_platform_aggregate_rows_attribution_check
    CHECK (
      (attribution_status = 'mapped'
        AND owner_uid IS NOT NULL
        AND owner_name_snapshot IS NOT NULL
        AND char_length(btrim(owner_name_snapshot)) BETWEEN 1 AND 160
        AND attribution_issue_code IS NULL
        AND attribution_issue_detail IS NULL)
      OR (attribution_status = 'unmapped'
        AND owner_uid IS NULL AND owner_name_snapshot IS NULL
        AND attribution_issue_code IS NULL AND attribution_issue_detail IS NULL)
      OR (attribution_status = 'ambiguous'
        AND owner_uid IS NULL AND owner_name_snapshot IS NULL
        AND sales_amount IS NULL AND profit_amount IS NULL
        AND attribution_issue_code IS NOT NULL
        AND attribution_issue_code ~ '^[A-Z0-9_]{1,80}$'
        AND attribution_issue_detail IS NOT NULL
        AND char_length(btrim(attribution_issue_detail)) BETWEEN 1 AND 500)
    ),
  CONSTRAINT peakos_platform_aggregate_rows_amount_range_check
    CHECK (
      (sales_amount IS NULL OR sales_amount BETWEEN -9007199254740991 AND 9007199254740991)
      AND (profit_amount IS NULL OR profit_amount BETWEEN -9007199254740991 AND 9007199254740991)
    ),
  CONSTRAINT peakos_platform_aggregate_rows_profit_basis_check
    CHECK (profit_basis IN ('reward_distributor_margin', 'review_spread_profit', 'unavailable')),
  CONSTRAINT peakos_platform_aggregate_rows_profit_availability_check
    CHECK (profit_basis <> 'unavailable' OR profit_amount IS NULL),
  CONSTRAINT peakos_platform_aggregate_rows_keyword_profit_check
    CHECK (
      provider <> 'keywordmaster'
      OR (profit_amount IS NULL AND profit_basis = 'unavailable')
    ),
  CONSTRAINT peakos_platform_aggregate_rows_source_count_check
    CHECK (source_record_count IS NULL OR source_record_count >= 0),
  CONSTRAINT peakos_platform_aggregate_rows_currency_check CHECK (currency = 'KRW')
);

CREATE INDEX IF NOT EXISTS peakos_platform_aggregate_rows_self_idx
  ON peakos_platform_aggregate_rows(
    workspace_id, provider, snapshot_run_id, external_name_normalized
  );

-- Imported facts, exact-name UID pins and connection versions are immutable.
-- Corrections are represented by a later version/event, preserving the source
-- and actor chain used for payroll review.
CREATE OR REPLACE FUNCTION peakos_platform_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $platform_append_only$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$platform_append_only$;

DO $platform_append_only_triggers$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'peakos_platform_connections',
    'peakos_platform_salesperson_mappings',
    'peakos_platform_import_runs',
    'peakos_platform_transaction_events',
    'peakos_platform_aggregate_runs',
    'peakos_platform_aggregate_rows'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_no_mutation ON %I', table_name, table_name);
    EXECUTE format(
      'CREATE TRIGGER %I_no_mutation BEFORE UPDATE OR DELETE ON %I '
      || 'FOR EACH ROW EXECUTE FUNCTION peakos_platform_reject_mutation()',
      table_name,
      table_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I_no_truncate ON %I', table_name, table_name);
    EXECUTE format(
      'CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON %I '
      || 'FOR EACH STATEMENT EXECUTE FUNCTION peakos_platform_reject_mutation()',
      table_name,
      table_name
    );
  END LOOP;
END
$platform_append_only_triggers$;

DO $platform_runtime_grants$
DECLARE
  configured_role TEXT := NULLIF(current_setting('peakos.app_role', TRUE), '');
  application_role TEXT;
  table_name TEXT;
  privilege_name TEXT;
BEGIN
  application_role := configured_role;
  IF application_role IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
      application_role := 'calendar_user';
    ELSE
      RAISE EXCEPTION
        'set peakos.app_role to the non-owner runtime role before applying platform settlement migration'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role) THEN
    RAISE EXCEPTION 'PEAK OS application role % does not exist', application_role;
  END IF;
  IF application_role = current_user THEN
    RAISE EXCEPTION 'platform settlement migration must run as an operator role, not runtime role %', application_role
      USING ERRCODE = '55000';
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'peakos_platform_connections',
    'peakos_platform_salesperson_mappings',
    'peakos_platform_import_runs',
    'peakos_platform_transaction_events',
    'peakos_platform_aggregate_runs',
    'peakos_platform_aggregate_rows'
  ]
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I FROM PUBLIC, %I', table_name, application_role);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE %I TO %I', table_name, application_role);
    IF NOT has_table_privilege(application_role, 'public.' || table_name, 'SELECT')
       OR NOT has_table_privilege(application_role, 'public.' || table_name, 'INSERT') THEN
      RAISE EXCEPTION 'runtime role % lacks platform settlement read/append privilege on %',
        application_role, table_name USING ERRCODE = '55000';
    END IF;
    FOREACH privilege_name IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
    LOOP
      IF has_table_privilege(application_role, 'public.' || table_name, privilege_name) THEN
        RAISE EXCEPTION 'runtime role % has unsafe % privilege on %',
          application_role, privilege_name, table_name USING ERRCODE = '55000';
      END IF;
    END LOOP;
  END LOOP;

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON FUNCTION peakos_platform_reject_mutation() FROM PUBLIC, %I',
    application_role
  );
  IF has_function_privilege(application_role, 'public.peakos_platform_reject_mutation()', 'EXECUTE') THEN
    RAISE EXCEPTION 'runtime role % must not execute platform append-only function directly', application_role
      USING ERRCODE = '55000';
  END IF;
END
$platform_runtime_grants$;

COMMIT;
