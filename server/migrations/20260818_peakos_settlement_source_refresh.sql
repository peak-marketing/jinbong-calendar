-- Auditable incremental refresh support for the settlement-sheet snapshot.
--
-- This migration is intentionally schema-only.  It never copies or changes a
-- settlement row.  The refresh CLI records every INSERT/UPDATE here after a
-- pinned dry-run and a separately-created backup have both been verified.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-settlement-source-refresh-migration-v1'));

CREATE TABLE IF NOT EXISTS peakos_settlement_refresh_runs (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES peakos_workspaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL,
  source_manifest_sha256 TEXT NOT NULL,
  source_plan_sha256 TEXT NOT NULL,
  database_state_sha256 TEXT NOT NULL,
  operation_sha256 TEXT NOT NULL,
  backup_sha256 TEXT NOT NULL,
  backup_bytes BIGINT NOT NULL,
  totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  quarantine_count INTEGER NOT NULL DEFAULT 0,
  actor_uid TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT peakos_settlement_refresh_runs_status_check
    CHECK (status IN ('RUNNING', 'COMPLETED')),
  CONSTRAINT peakos_settlement_refresh_runs_source_manifest_hash_check
    CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_settlement_refresh_runs_source_plan_hash_check
    CHECK (source_plan_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_settlement_refresh_runs_database_hash_check
    CHECK (database_state_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_settlement_refresh_runs_operation_hash_check
    CHECK (operation_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_settlement_refresh_runs_backup_hash_check
    CHECK (backup_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_settlement_refresh_runs_backup_size_check
    CHECK (backup_bytes >= 1024),
  CONSTRAINT peakos_settlement_refresh_runs_counts_check CHECK (
    inserted_count >= 0 AND updated_count >= 0 AND skipped_count >= 0
      AND conflict_count >= 0 AND quarantine_count >= 0
  ),
  CONSTRAINT peakos_settlement_refresh_runs_lifecycle_check CHECK (
    (status = 'RUNNING' AND completed_at IS NULL
      AND inserted_count = 0 AND updated_count = 0 AND skipped_count = 0
      AND conflict_count = 0 AND quarantine_count = 0)
    OR
    (status = 'COMPLETED' AND completed_at IS NOT NULL AND conflict_count = 0)
  )
);

CREATE INDEX IF NOT EXISTS peakos_settlement_refresh_runs_workspace_idx
  ON peakos_settlement_refresh_runs(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS peakos_settlement_refresh_items (
  run_id UUID NOT NULL REFERENCES peakos_settlement_refresh_runs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  target_table TEXT NOT NULL,
  target_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  before_fingerprint TEXT,
  after_fingerprint TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, target_table, target_id),
  CONSTRAINT peakos_settlement_refresh_items_table_check
    CHECK (target_table IN ('peakos_intake', 'peakos_monthly')),
  CONSTRAINT peakos_settlement_refresh_items_operation_check
    CHECK (operation IN ('INSERT', 'UPDATE')),
  CONSTRAINT peakos_settlement_refresh_items_before_hash_check
    CHECK (before_fingerprint IS NULL OR before_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_settlement_refresh_items_after_hash_check
    CHECK (after_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_settlement_refresh_items_before_state_check CHECK (
    (operation = 'INSERT' AND before_fingerprint IS NULL AND before_state IS NULL)
      OR
    (operation = 'UPDATE' AND before_fingerprint IS NOT NULL AND before_state IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS peakos_settlement_refresh_items_target_idx
  ON peakos_settlement_refresh_items(target_table, target_id, created_at DESC);

CREATE OR REPLACE FUNCTION peakos_settlement_refresh_run_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $refresh_run_guard$
DECLARE
  actual_inserted INTEGER;
  actual_updated INTEGER;
  actual_quarantined INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'RUNNING' THEN
      RAISE EXCEPTION 'settlement refresh run must start RUNNING'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'peakos_settlement_refresh_runs is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'RUNNING' OR NEW.status <> 'COMPLETED'
     OR NEW.completed_at IS NULL OR NEW.conflict_count <> 0
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.source_manifest_sha256 IS DISTINCT FROM OLD.source_manifest_sha256
     OR NEW.source_plan_sha256 IS DISTINCT FROM OLD.source_plan_sha256
     OR NEW.database_state_sha256 IS DISTINCT FROM OLD.database_state_sha256
     OR NEW.operation_sha256 IS DISTINCT FROM OLD.operation_sha256
     OR NEW.backup_sha256 IS DISTINCT FROM OLD.backup_sha256
     OR NEW.backup_bytes IS DISTINCT FROM OLD.backup_bytes
     OR NEW.totals IS DISTINCT FROM OLD.totals
     OR NEW.actor_uid IS DISTINCT FROM OLD.actor_uid
     OR NEW.actor_name IS DISTINCT FROM OLD.actor_name
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'invalid settlement refresh run transition'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.inserted_count IS DISTINCT FROM COALESCE((OLD.totals->>'insert')::integer, -1)
     OR NEW.updated_count IS DISTINCT FROM COALESCE((OLD.totals->>'update')::integer, -1)
     OR NEW.skipped_count IS DISTINCT FROM COALESCE((OLD.totals->>'skip')::integer, -1)
     OR NEW.quarantine_count IS DISTINCT FROM COALESCE((OLD.totals->>'quarantine')::integer, -1) THEN
    RAISE EXCEPTION 'settlement refresh completion counts do not match pinned totals'
      USING ERRCODE = '55000';
  END IF;
  SELECT COUNT(*) FILTER (WHERE operation = 'INSERT')::integer,
         COUNT(*) FILTER (WHERE operation = 'UPDATE')::integer
    INTO actual_inserted, actual_updated
    FROM public.peakos_settlement_refresh_items
   WHERE run_id = NEW.id;
  SELECT COUNT(*)::integer
    INTO actual_quarantined
    FROM public.peakos_settlement_import_quarantine
   WHERE run_id = NEW.id;
  IF NEW.inserted_count IS DISTINCT FROM actual_inserted
     OR NEW.updated_count IS DISTINCT FROM actual_updated
     OR NEW.quarantine_count IS DISTINCT FROM actual_quarantined THEN
    RAISE EXCEPTION 'settlement refresh completion counts do not match append-only items'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$refresh_run_guard$;

CREATE OR REPLACE FUNCTION peakos_settlement_refresh_item_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $refresh_item_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1
      FROM public.peakos_settlement_refresh_runs
     WHERE id = NEW.run_id AND status = 'RUNNING'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'settlement refresh items require a RUNNING parent run'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'peakos_settlement_refresh_items is append-only'
    USING ERRCODE = '55000';
END
$refresh_item_guard$;

CREATE OR REPLACE FUNCTION peakos_settlement_refresh_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $refresh_append_only$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$refresh_append_only$;

DROP TRIGGER IF EXISTS peakos_settlement_refresh_runs_guard
  ON peakos_settlement_refresh_runs;
CREATE TRIGGER peakos_settlement_refresh_runs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON peakos_settlement_refresh_runs
  FOR EACH ROW EXECUTE FUNCTION peakos_settlement_refresh_run_guard();

DROP TRIGGER IF EXISTS peakos_settlement_refresh_runs_no_truncate
  ON peakos_settlement_refresh_runs;
CREATE TRIGGER peakos_settlement_refresh_runs_no_truncate
  BEFORE TRUNCATE ON peakos_settlement_refresh_runs
  FOR EACH STATEMENT EXECUTE FUNCTION peakos_settlement_refresh_reject_mutation();

DROP TRIGGER IF EXISTS peakos_settlement_refresh_items_no_mutation
  ON peakos_settlement_refresh_items;
CREATE TRIGGER peakos_settlement_refresh_items_no_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON peakos_settlement_refresh_items
  FOR EACH ROW EXECUTE FUNCTION peakos_settlement_refresh_item_guard();

DROP TRIGGER IF EXISTS peakos_settlement_refresh_items_no_truncate
  ON peakos_settlement_refresh_items;
CREATE TRIGGER peakos_settlement_refresh_items_no_truncate
  BEFORE TRUNCATE ON peakos_settlement_refresh_items
  FOR EACH STATEMENT EXECUTE FUNCTION peakos_settlement_refresh_reject_mutation();

DO $refresh_runtime_grants$
DECLARE
  configured_role TEXT := NULLIF(current_setting('peakos.app_role', TRUE), '');
  application_role TEXT;
BEGIN
  application_role := configured_role;
  IF application_role IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
      application_role := 'calendar_user';
    ELSE
      RAISE EXCEPTION
        'set peakos.app_role to the non-owner runtime role before applying settlement refresh migration'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role) THEN
    RAISE EXCEPTION 'PEAK OS application role % does not exist', application_role;
  END IF;
  IF application_role = current_user THEN
    RAISE EXCEPTION 'settlement refresh migration must run as an operator role, not runtime role %', application_role
      USING ERRCODE = '55000';
  END IF;

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE peakos_settlement_refresh_runs FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE peakos_settlement_refresh_items FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE peakos_settlement_refresh_runs TO %I',
    application_role
  );
  EXECUTE format(
    'GRANT UPDATE (status, inserted_count, updated_count, skipped_count, conflict_count, '
      || 'quarantine_count, completed_at) ON TABLE peakos_settlement_refresh_runs TO %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE peakos_settlement_refresh_items TO %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON FUNCTION peakos_settlement_refresh_run_guard() FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON FUNCTION peakos_settlement_refresh_item_guard() FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON FUNCTION peakos_settlement_refresh_reject_mutation() FROM PUBLIC, %I',
    application_role
  );

  IF NOT has_table_privilege(application_role, 'public.peakos_settlement_refresh_runs', 'SELECT')
     OR NOT has_table_privilege(application_role, 'public.peakos_settlement_refresh_runs', 'INSERT')
     OR NOT has_table_privilege(application_role, 'public.peakos_settlement_refresh_items', 'SELECT')
     OR NOT has_table_privilege(application_role, 'public.peakos_settlement_refresh_items', 'INSERT')
     OR has_table_privilege(application_role, 'public.peakos_settlement_refresh_runs', 'DELETE')
     OR has_table_privilege(application_role, 'public.peakos_settlement_refresh_runs', 'TRUNCATE')
     OR has_table_privilege(application_role, 'public.peakos_settlement_refresh_runs', 'REFERENCES')
     OR has_table_privilege(application_role, 'public.peakos_settlement_refresh_runs', 'TRIGGER')
     OR has_table_privilege(application_role, 'public.peakos_settlement_refresh_items', 'UPDATE')
     OR has_table_privilege(application_role, 'public.peakos_settlement_refresh_items', 'DELETE')
     OR has_table_privilege(application_role, 'public.peakos_settlement_refresh_items', 'TRUNCATE')
     OR has_table_privilege(application_role, 'public.peakos_settlement_refresh_items', 'REFERENCES')
     OR has_table_privilege(application_role, 'public.peakos_settlement_refresh_items', 'TRIGGER') THEN
    RAISE EXCEPTION 'runtime settlement refresh privileges are unsafe or incomplete'
      USING ERRCODE = '55000';
  END IF;
  IF NOT has_column_privilege(application_role, 'public.peakos_settlement_refresh_runs', 'status', 'UPDATE')
     OR NOT has_column_privilege(application_role, 'public.peakos_settlement_refresh_runs', 'completed_at', 'UPDATE')
     OR NOT has_column_privilege(application_role, 'public.peakos_settlement_refresh_runs', 'inserted_count', 'UPDATE')
     OR NOT has_column_privilege(application_role, 'public.peakos_settlement_refresh_runs', 'updated_count', 'UPDATE')
     OR NOT has_column_privilege(application_role, 'public.peakos_settlement_refresh_runs', 'skipped_count', 'UPDATE')
     OR NOT has_column_privilege(application_role, 'public.peakos_settlement_refresh_runs', 'conflict_count', 'UPDATE')
     OR NOT has_column_privilege(application_role, 'public.peakos_settlement_refresh_runs', 'quarantine_count', 'UPDATE')
     OR EXISTS (
       SELECT 1
         FROM pg_attribute attribute
        WHERE attribute.attrelid = 'public.peakos_settlement_refresh_runs'::regclass
          AND attribute.attnum > 0 AND NOT attribute.attisdropped
          AND attribute.attname NOT IN (
            'status', 'inserted_count', 'updated_count', 'skipped_count',
            'conflict_count', 'quarantine_count', 'completed_at'
          )
          AND has_column_privilege(
            application_role, attribute.attrelid, attribute.attnum, 'UPDATE'
          )
     )
     OR has_function_privilege(application_role, 'public.peakos_settlement_refresh_run_guard()', 'EXECUTE')
     OR has_function_privilege(application_role, 'public.peakos_settlement_refresh_item_guard()', 'EXECUTE')
     OR has_function_privilege(application_role, 'public.peakos_settlement_refresh_reject_mutation()', 'EXECUTE') THEN
    RAISE EXCEPTION 'runtime settlement refresh column/function privileges are unsafe or incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$refresh_runtime_grants$;

COMMIT;
