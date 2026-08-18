-- Append-only operator quarantine ledger for immutable platform aggregate runs.
--
-- A quarantine never mutates or deletes the imported run.  Self reads exclude
-- quarantined runs and may therefore fall back to the preceding completed run.
-- Apply this migration as the same DBA/operator role that owns the canonical
-- platform settlement tables, never as the application runtime role.

BEGIN;

SET LOCAL search_path = public, pg_temp;

SELECT pg_advisory_xact_lock(hashtext('peakos-platform-aggregate-quarantine-v1'));

DO $platform_quarantine_prerequisites$
BEGIN
  IF to_regclass('public.peakos_platform_aggregate_runs') IS NULL
     OR to_regprocedure('public.peakos_platform_reject_mutation()') IS NULL THEN
    RAISE EXCEPTION
      'platform monthly settlement migration must be applied before aggregate quarantine'
      USING ERRCODE = '55000';
  END IF;
END
$platform_quarantine_prerequisites$;

CREATE TABLE IF NOT EXISTS peakos_platform_aggregate_quarantines (
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  id UUID NOT NULL,
  aggregate_run_id UUID NOT NULL,
  operation_key TEXT NOT NULL,
  expected_latest_run_id UUID NOT NULL,
  reason TEXT NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, provider, id),
  CONSTRAINT peakos_platform_aggregate_quarantines_run_unique
    UNIQUE (workspace_id, provider, aggregate_run_id),
  CONSTRAINT peakos_platform_aggregate_quarantines_operation_unique
    UNIQUE (workspace_id, provider, operation_key),
  CONSTRAINT peakos_platform_aggregate_quarantines_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_platform_aggregate_quarantines_run_fk
    FOREIGN KEY (workspace_id, provider, aggregate_run_id)
    REFERENCES peakos_platform_aggregate_runs(workspace_id, provider, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_platform_aggregate_quarantines_provider_check
    CHECK (provider IN ('rewardspace', 'reviewspace', 'keywordmaster', 'brandautospace', 'reviewflow')),
  CONSTRAINT peakos_platform_aggregate_quarantines_operation_check
    CHECK (operation_key ~ '^[A-Za-z0-9:._/-]{1,240}$'),
  CONSTRAINT peakos_platform_aggregate_quarantines_expected_latest_check
    CHECK (expected_latest_run_id = aggregate_run_id),
  CONSTRAINT peakos_platform_aggregate_quarantines_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 8 AND 500),
  CONSTRAINT peakos_platform_aggregate_quarantines_actor_check
    CHECK (char_length(btrim(actor_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_platform_aggregate_quarantines_actor_name_check
    CHECK (char_length(btrim(actor_name_snapshot)) BETWEEN 1 AND 160)
);

DROP TRIGGER IF EXISTS peakos_platform_aggregate_quarantines_no_mutation
  ON peakos_platform_aggregate_quarantines;
CREATE TRIGGER peakos_platform_aggregate_quarantines_no_mutation
  BEFORE UPDATE OR DELETE ON peakos_platform_aggregate_quarantines
  FOR EACH ROW EXECUTE FUNCTION peakos_platform_reject_mutation();

DROP TRIGGER IF EXISTS peakos_platform_aggregate_quarantines_no_truncate
  ON peakos_platform_aggregate_quarantines;
CREATE TRIGGER peakos_platform_aggregate_quarantines_no_truncate
  BEFORE TRUNCATE ON peakos_platform_aggregate_quarantines
  FOR EACH STATEMENT EXECUTE FUNCTION peakos_platform_reject_mutation();

DO $platform_quarantine_runtime_grants$
DECLARE
  configured_role TEXT := NULLIF(current_setting('peakos.app_role', TRUE), '');
  application_role TEXT;
  privilege_name TEXT;
BEGIN
  application_role := configured_role;
  IF application_role IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
      application_role := 'calendar_user';
    ELSE
      RAISE EXCEPTION
        'set peakos.app_role to the non-owner runtime role before applying aggregate quarantine migration'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role) THEN
    RAISE EXCEPTION 'PEAK OS application role % does not exist', application_role;
  END IF;
  IF application_role = current_user THEN
    RAISE EXCEPTION 'aggregate quarantine migration must run as operator, not runtime role %', application_role
      USING ERRCODE = '55000';
  END IF;

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE peakos_platform_aggregate_quarantines FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE peakos_platform_aggregate_quarantines TO %I',
    application_role
  );

  IF NOT has_table_privilege(application_role, 'public.peakos_platform_aggregate_quarantines', 'SELECT')
     OR NOT has_table_privilege(application_role, 'public.peakos_platform_aggregate_quarantines', 'INSERT') THEN
    RAISE EXCEPTION 'runtime role % lacks aggregate quarantine read/append privilege', application_role
      USING ERRCODE = '55000';
  END IF;
  FOREACH privilege_name IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
  LOOP
    IF has_table_privilege(
      application_role,
      'public.peakos_platform_aggregate_quarantines',
      privilege_name
    ) THEN
      RAISE EXCEPTION 'runtime role % has unsafe % privilege on aggregate quarantine ledger',
        application_role, privilege_name USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$platform_quarantine_runtime_grants$;

COMMIT;
