-- Server-authoritative settlement completion evidence and lifecycle.
--
-- This migration is additive. Existing peakos_monthly rows are not backfilled,
-- inferred, completed, or frozen. A row has no eligibility state until an
-- authorized manager records explicit evidence through the API.

BEGIN;

SET LOCAL search_path = public, pg_temp;

SELECT pg_advisory_xact_lock(hashtext('peakos-settlement-completion-v1'));

DO $settlement_completion_prerequisites$
BEGIN
  IF to_regclass('public.peakos_workspaces') IS NULL
     OR to_regclass('public.peakos_monthly') IS NULL
     OR to_regclass('public.peakos_workspace_memberships') IS NULL THEN
    RAISE EXCEPTION
      'workspace and settlement migrations must be applied before settlement completion'
      USING ERRCODE = '55000';
  END IF;
END
$settlement_completion_prerequisites$;

-- The previous workspace migration kept a NULL -> ws_peak read fallback for
-- legacy rows. Completion evidence needs a real composite FK, so materialize
-- that already-established meaning before making the source key exact.
UPDATE peakos_monthly SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL;
ALTER TABLE peakos_monthly ALTER COLUMN workspace_id SET NOT NULL;

DO $settlement_completion_monthly_composite_key$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.peakos_monthly'::regclass
       AND conname = 'peakos_monthly_workspace_source_unique'
  ) THEN
    ALTER TABLE peakos_monthly
      ADD CONSTRAINT peakos_monthly_workspace_source_unique
      UNIQUE (workspace_id, id);
  END IF;
END
$settlement_completion_monthly_composite_key$;

CREATE TABLE IF NOT EXISTS peakos_settlement_completion_cases (
  workspace_id TEXT NOT NULL,
  source_monthly_id TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  row_version BIGINT NOT NULL DEFAULT 1,

  exposure_started_at TIMESTAMPTZ,
  exposure_completed_at TIMESTAMPTZ,
  service_started_at TIMESTAMPTZ,
  service_completed_at TIMESTAMPTZ,
  completed_issue_count INTEGER,
  eighth_issue_completed_at TIMESTAMPTZ,

  evidence_updated_at TIMESTAMPTZ NOT NULL,
  evidence_updated_by_uid TEXT NOT NULL,
  evidence_updated_by_name TEXT NOT NULL DEFAULT '',

  settlement_completed_at TIMESTAMPTZ,
  settlement_completed_by_uid TEXT,
  settlement_completed_by_name TEXT,
  settlement_completion_reason TEXT,

  frozen_at TIMESTAMPTZ,
  frozen_by_uid TEXT,
  frozen_by_name TEXT,
  freeze_reason TEXT,

  reopened_at TIMESTAMPTZ,
  reopened_by_uid TEXT,
  reopened_by_name TEXT,
  reopen_reason TEXT,

  last_action TEXT NOT NULL DEFAULT 'EVIDENCE_RECORDED',
  last_action_reason TEXT NOT NULL,
  last_actor_uid TEXT NOT NULL,
  last_actor_name TEXT NOT NULL DEFAULT '',
  last_action_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (workspace_id, source_monthly_id),
  CONSTRAINT peakos_settlement_completion_cases_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_settlement_completion_cases_source_fk
    FOREIGN KEY (workspace_id, source_monthly_id)
    REFERENCES peakos_monthly(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_settlement_completion_cases_rule_check
    CHECK (rule_code IN (
      'DIRECT_EXECUTION_8TH',
      'MONTHLY_GUARANTEE_25D',
      'PER_ITEM_24H',
      'MONTHLY_MANAGEMENT_30D'
    )),
  CONSTRAINT peakos_settlement_completion_cases_status_check
    CHECK (status IN ('OPEN', 'COMPLETED', 'FROZEN')),
  CONSTRAINT peakos_settlement_completion_cases_version_check
    CHECK (row_version >= 1),
  CONSTRAINT peakos_settlement_completion_cases_issue_count_check
    CHECK (completed_issue_count IS NULL OR completed_issue_count BETWEEN 0 AND 1000000),
  CONSTRAINT peakos_settlement_completion_cases_eighth_issue_check
    CHECK (
      eighth_issue_completed_at IS NULL
      OR (completed_issue_count IS NOT NULL AND completed_issue_count >= 8)
    ),
  CONSTRAINT peakos_settlement_completion_cases_evidence_shape_check
    CHECK (
      (rule_code = 'DIRECT_EXECUTION_8TH'
       AND exposure_started_at IS NULL AND exposure_completed_at IS NULL
       AND service_started_at IS NULL AND service_completed_at IS NULL)
      OR
      (rule_code IN ('MONTHLY_GUARANTEE_25D', 'PER_ITEM_24H')
       AND service_started_at IS NULL AND service_completed_at IS NULL
       AND completed_issue_count IS NULL AND eighth_issue_completed_at IS NULL)
      OR
      (rule_code = 'MONTHLY_MANAGEMENT_30D'
       AND exposure_started_at IS NULL AND exposure_completed_at IS NULL
       AND completed_issue_count IS NULL AND eighth_issue_completed_at IS NULL)
    ),
  CONSTRAINT peakos_settlement_completion_cases_lifecycle_check
    CHECK (
      (status = 'OPEN'
       AND settlement_completed_at IS NULL
       AND settlement_completed_by_uid IS NULL
       AND settlement_completed_by_name IS NULL
       AND settlement_completion_reason IS NULL
       AND frozen_at IS NULL AND frozen_by_uid IS NULL
       AND frozen_by_name IS NULL AND freeze_reason IS NULL)
      OR
      (status = 'COMPLETED'
       AND settlement_completed_at IS NOT NULL
       AND settlement_completed_by_uid IS NOT NULL
       AND settlement_completed_by_name IS NOT NULL
       AND settlement_completion_reason IS NOT NULL
       AND frozen_at IS NULL AND frozen_by_uid IS NULL
       AND frozen_by_name IS NULL AND freeze_reason IS NULL)
      OR
      (status = 'FROZEN'
       AND settlement_completed_at IS NOT NULL
       AND settlement_completed_by_uid IS NOT NULL
       AND settlement_completed_by_name IS NOT NULL
       AND settlement_completion_reason IS NOT NULL
       AND frozen_at IS NOT NULL AND frozen_by_uid IS NOT NULL
       AND frozen_by_name IS NOT NULL AND freeze_reason IS NOT NULL)
    ),
  CONSTRAINT peakos_settlement_completion_cases_actor_check
    CHECK (
      char_length(btrim(evidence_updated_by_uid)) BETWEEN 1 AND 200
      AND char_length(evidence_updated_by_name) <= 160
      AND char_length(btrim(last_actor_uid)) BETWEEN 1 AND 200
      AND char_length(last_actor_name) <= 160
    ),
  CONSTRAINT peakos_settlement_completion_cases_reason_check
    CHECK (
      char_length(btrim(last_action_reason)) BETWEEN 8 AND 500
      AND (settlement_completion_reason IS NULL
        OR char_length(btrim(settlement_completion_reason)) BETWEEN 8 AND 500)
      AND (freeze_reason IS NULL OR char_length(btrim(freeze_reason)) BETWEEN 8 AND 500)
      AND (reopen_reason IS NULL OR char_length(btrim(reopen_reason)) BETWEEN 8 AND 500)
    ),
  CONSTRAINT peakos_settlement_completion_cases_action_check
    CHECK (last_action IN ('EVIDENCE_RECORDED', 'COMPLETED', 'FROZEN', 'REOPENED')),
  CONSTRAINT peakos_settlement_completion_cases_time_check
    CHECK (
      updated_at >= created_at
      AND last_action_at = updated_at
      AND evidence_updated_at >= created_at
      AND (settlement_completed_at IS NULL OR settlement_completed_at >= created_at)
      AND (frozen_at IS NULL OR frozen_at >= settlement_completed_at)
      AND (reopened_at IS NULL OR reopened_at >= created_at)
    )
);

CREATE TABLE IF NOT EXISTS peakos_settlement_completion_audit (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_monthly_id TEXT NOT NULL,
  action TEXT NOT NULL,
  row_version BIGINT NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT peakos_settlement_completion_audit_case_fk
    FOREIGN KEY (workspace_id, source_monthly_id)
    REFERENCES peakos_settlement_completion_cases(workspace_id, source_monthly_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_settlement_completion_audit_action_check
    CHECK (action IN ('EVIDENCE_RECORDED', 'COMPLETED', 'FROZEN', 'REOPENED')),
  CONSTRAINT peakos_settlement_completion_audit_version_check CHECK (row_version >= 1),
  CONSTRAINT peakos_settlement_completion_audit_actor_check
    CHECK (char_length(btrim(actor_uid)) BETWEEN 1 AND 200 AND char_length(actor_name) <= 160),
  CONSTRAINT peakos_settlement_completion_audit_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 8 AND 500)
);

CREATE INDEX IF NOT EXISTS peakos_settlement_completion_cases_status_idx
  ON peakos_settlement_completion_cases(workspace_id, status, updated_at DESC, source_monthly_id);

CREATE INDEX IF NOT EXISTS peakos_settlement_completion_audit_source_idx
  ON peakos_settlement_completion_audit(workspace_id, source_monthly_id, id DESC);

CREATE OR REPLACE FUNCTION public.peakos_settlement_completion_case_is_eligible(
  selected_rule TEXT,
  exposure_start TIMESTAMPTZ,
  exposure_completion TIMESTAMPTZ,
  service_start TIMESTAMPTZ,
  service_completion TIMESTAMPTZ,
  completed_issues INTEGER,
  eighth_completion TIMESTAMPTZ,
  evaluated_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
CALLED ON NULL INPUT
SET search_path = pg_catalog, public
AS $settlement_completion_case_eligible$
  SELECT CASE selected_rule
    WHEN 'DIRECT_EXECUTION_8TH' THEN
      completed_issues IS NOT NULL AND completed_issues >= 8
      AND eighth_completion IS NOT NULL AND eighth_completion <= evaluated_at
    WHEN 'MONTHLY_GUARANTEE_25D' THEN
      exposure_start IS NOT NULL AND exposure_completion IS NOT NULL
      AND exposure_completion <= evaluated_at
      AND (exposure_completion AT TIME ZONE 'Asia/Seoul')
          >= (exposure_start AT TIME ZONE 'Asia/Seoul') + INTERVAL '25 days'
    WHEN 'PER_ITEM_24H' THEN
      exposure_start IS NOT NULL AND exposure_completion IS NOT NULL
      AND exposure_completion <= evaluated_at
      AND (exposure_completion AT TIME ZONE 'Asia/Seoul')
          >= (exposure_start AT TIME ZONE 'Asia/Seoul') + INTERVAL '24 hours'
    WHEN 'MONTHLY_MANAGEMENT_30D' THEN
      service_start IS NOT NULL AND service_completion IS NOT NULL
      AND service_completion <= evaluated_at
      AND (service_completion AT TIME ZONE 'Asia/Seoul')
          >= (service_start AT TIME ZONE 'Asia/Seoul') + INTERVAL '30 days'
    ELSE FALSE
  END
$settlement_completion_case_eligible$;

CREATE OR REPLACE FUNCTION public.peakos_settlement_completion_assert_source()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $settlement_completion_source_guard$
DECLARE
  source_workspace TEXT;
  source_kind TEXT;
  source_view TEXT;
  source_category TEXT;
  derived_rule TEXT;
BEGIN
  SELECT COALESCE(monthly.workspace_id, 'ws_peak'), monthly.kind, monthly.view, btrim(monthly.c)
    INTO source_workspace, source_kind, source_view, source_category
    FROM public.peakos_monthly monthly
   WHERE monthly.id = NEW.source_monthly_id
   FOR KEY SHARE;

  IF source_workspace IS NULL OR source_kind IS DISTINCT FROM 'sale' THEN
    RAISE EXCEPTION 'settlement completion source must be a monthly sale row'
      USING ERRCODE = '23503',
            CONSTRAINT = 'peakos_settlement_completion_cases_source_rule_fk';
  END IF;

  derived_rule := CASE
    WHEN source_view = 'direct-execution' THEN 'DIRECT_EXECUTION_8TH'
    WHEN source_view = 'monthly-manage' THEN 'MONTHLY_MANAGEMENT_30D'
    WHEN source_view = 'monthly-guarantee' AND source_category = '월보장'
      THEN 'MONTHLY_GUARANTEE_25D'
    WHEN source_view = 'monthly-guarantee' AND source_category = '건바이'
      THEN 'PER_ITEM_24H'
    ELSE NULL
  END;

  IF source_workspace IS DISTINCT FROM NEW.workspace_id
     OR derived_rule IS NULL
     OR derived_rule IS DISTINCT FROM NEW.rule_code THEN
    RAISE EXCEPTION 'settlement completion source workspace or rule does not match'
      USING ERRCODE = '23503',
            CONSTRAINT = 'peakos_settlement_completion_cases_source_rule_fk';
  END IF;
  RETURN NEW;
END
$settlement_completion_source_guard$;

CREATE OR REPLACE FUNCTION public.peakos_settlement_completion_case_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $settlement_completion_case_guard$
BEGIN
  IF NEW.last_action_at > statement_timestamp() + INTERVAL '1 minute'
     OR NEW.evidence_updated_at > statement_timestamp() + INTERVAL '1 minute'
     OR NEW.updated_at > statement_timestamp() + INTERVAL '1 minute' THEN
    RAISE EXCEPTION 'settlement completion action timestamp is in the future'
      USING ERRCODE = '22007',
            CONSTRAINT = 'peakos_settlement_completion_cases_action_time_guard';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'OPEN'
       OR NEW.row_version IS DISTINCT FROM 1
       OR NEW.last_action IS DISTINCT FROM 'EVIDENCE_RECORDED'
       OR NEW.created_at IS DISTINCT FROM NEW.updated_at
       OR NEW.last_action_at IS DISTINCT FROM NEW.updated_at
       OR NEW.evidence_updated_at IS DISTINCT FROM NEW.updated_at
       OR NEW.reopened_at IS NOT NULL OR NEW.reopened_by_uid IS NOT NULL
       OR NEW.reopened_by_name IS NOT NULL OR NEW.reopen_reason IS NOT NULL THEN
      RAISE EXCEPTION 'new settlement completion case must start as version 1 OPEN evidence'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_settlement_completion_cases_transition_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.source_monthly_id IS DISTINCT FROM OLD.source_monthly_id
     OR NEW.rule_code IS DISTINCT FROM OLD.rule_code
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.row_version IS DISTINCT FROM OLD.row_version + 1
     OR NEW.updated_at IS DISTINCT FROM NEW.last_action_at
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'settlement completion immutable identity or version changed'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_settlement_completion_cases_transition_guard';
  END IF;

  IF NEW.last_action = 'EVIDENCE_RECORDED' THEN
    IF OLD.status IS DISTINCT FROM 'OPEN' OR NEW.status IS DISTINCT FROM 'OPEN'
       OR ROW(NEW.settlement_completed_at, NEW.settlement_completed_by_uid,
              NEW.settlement_completed_by_name, NEW.settlement_completion_reason,
              NEW.frozen_at, NEW.frozen_by_uid, NEW.frozen_by_name, NEW.freeze_reason,
              NEW.reopened_at, NEW.reopened_by_uid, NEW.reopened_by_name, NEW.reopen_reason)
          IS DISTINCT FROM
          ROW(OLD.settlement_completed_at, OLD.settlement_completed_by_uid,
              OLD.settlement_completed_by_name, OLD.settlement_completion_reason,
              OLD.frozen_at, OLD.frozen_by_uid, OLD.frozen_by_name, OLD.freeze_reason,
              OLD.reopened_at, OLD.reopened_by_uid, OLD.reopened_by_name, OLD.reopen_reason)
       OR ROW(NEW.exposure_started_at, NEW.exposure_completed_at,
              NEW.service_started_at, NEW.service_completed_at,
              NEW.completed_issue_count, NEW.eighth_issue_completed_at)
          IS NOT DISTINCT FROM
          ROW(OLD.exposure_started_at, OLD.exposure_completed_at,
              OLD.service_started_at, OLD.service_completed_at,
              OLD.completed_issue_count, OLD.eighth_issue_completed_at)
       OR NEW.evidence_updated_at IS DISTINCT FROM NEW.updated_at
       OR NEW.evidence_updated_by_uid IS DISTINCT FROM NEW.last_actor_uid
       OR NEW.evidence_updated_by_name IS DISTINCT FROM NEW.last_actor_name THEN
      RAISE EXCEPTION 'invalid settlement evidence transition'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_settlement_completion_cases_transition_guard';
    END IF;
  ELSIF NEW.last_action = 'COMPLETED' THEN
    IF OLD.status IS DISTINCT FROM 'OPEN' OR NEW.status IS DISTINCT FROM 'COMPLETED'
       OR ROW(NEW.exposure_started_at, NEW.exposure_completed_at,
              NEW.service_started_at, NEW.service_completed_at,
              NEW.completed_issue_count, NEW.eighth_issue_completed_at,
              NEW.evidence_updated_at, NEW.evidence_updated_by_uid, NEW.evidence_updated_by_name,
              NEW.frozen_at, NEW.frozen_by_uid, NEW.frozen_by_name, NEW.freeze_reason,
              NEW.reopened_at, NEW.reopened_by_uid, NEW.reopened_by_name, NEW.reopen_reason)
          IS DISTINCT FROM
          ROW(OLD.exposure_started_at, OLD.exposure_completed_at,
              OLD.service_started_at, OLD.service_completed_at,
              OLD.completed_issue_count, OLD.eighth_issue_completed_at,
              OLD.evidence_updated_at, OLD.evidence_updated_by_uid, OLD.evidence_updated_by_name,
              OLD.frozen_at, OLD.frozen_by_uid, OLD.frozen_by_name, OLD.freeze_reason,
              OLD.reopened_at, OLD.reopened_by_uid, OLD.reopened_by_name, OLD.reopen_reason)
       OR NEW.settlement_completed_at IS DISTINCT FROM NEW.updated_at
       OR NEW.settlement_completed_by_uid IS DISTINCT FROM NEW.last_actor_uid
       OR NEW.settlement_completed_by_name IS DISTINCT FROM NEW.last_actor_name
       OR NEW.settlement_completion_reason IS DISTINCT FROM NEW.last_action_reason
       OR NOT public.peakos_settlement_completion_case_is_eligible(
         NEW.rule_code, NEW.exposure_started_at, NEW.exposure_completed_at,
         NEW.service_started_at, NEW.service_completed_at,
         NEW.completed_issue_count, NEW.eighth_issue_completed_at, NEW.updated_at
       ) THEN
      RAISE EXCEPTION 'settlement completion evidence is not eligible'
        USING ERRCODE = 'P0001',
              CONSTRAINT = 'peakos_settlement_completion_cases_not_eligible';
    END IF;
  ELSIF NEW.last_action = 'FROZEN' THEN
    IF OLD.status IS DISTINCT FROM 'COMPLETED' OR NEW.status IS DISTINCT FROM 'FROZEN'
       OR ROW(NEW.exposure_started_at, NEW.exposure_completed_at,
              NEW.service_started_at, NEW.service_completed_at,
              NEW.completed_issue_count, NEW.eighth_issue_completed_at,
              NEW.evidence_updated_at, NEW.evidence_updated_by_uid, NEW.evidence_updated_by_name,
              NEW.settlement_completed_at, NEW.settlement_completed_by_uid,
              NEW.settlement_completed_by_name, NEW.settlement_completion_reason,
              NEW.reopened_at, NEW.reopened_by_uid, NEW.reopened_by_name, NEW.reopen_reason)
          IS DISTINCT FROM
          ROW(OLD.exposure_started_at, OLD.exposure_completed_at,
              OLD.service_started_at, OLD.service_completed_at,
              OLD.completed_issue_count, OLD.eighth_issue_completed_at,
              OLD.evidence_updated_at, OLD.evidence_updated_by_uid, OLD.evidence_updated_by_name,
              OLD.settlement_completed_at, OLD.settlement_completed_by_uid,
              OLD.settlement_completed_by_name, OLD.settlement_completion_reason,
              OLD.reopened_at, OLD.reopened_by_uid, OLD.reopened_by_name, OLD.reopen_reason)
       OR NEW.frozen_at IS DISTINCT FROM NEW.updated_at
       OR NEW.frozen_by_uid IS DISTINCT FROM NEW.last_actor_uid
       OR NEW.frozen_by_name IS DISTINCT FROM NEW.last_actor_name
       OR NEW.freeze_reason IS DISTINCT FROM NEW.last_action_reason THEN
      RAISE EXCEPTION 'invalid settlement freeze transition'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_settlement_completion_cases_transition_guard';
    END IF;
  ELSIF NEW.last_action = 'REOPENED' THEN
    IF OLD.status NOT IN ('COMPLETED', 'FROZEN') OR NEW.status IS DISTINCT FROM 'OPEN'
       OR ROW(NEW.exposure_started_at, NEW.exposure_completed_at,
              NEW.service_started_at, NEW.service_completed_at,
              NEW.completed_issue_count, NEW.eighth_issue_completed_at,
              NEW.evidence_updated_at, NEW.evidence_updated_by_uid, NEW.evidence_updated_by_name)
          IS DISTINCT FROM
          ROW(OLD.exposure_started_at, OLD.exposure_completed_at,
              OLD.service_started_at, OLD.service_completed_at,
              OLD.completed_issue_count, OLD.eighth_issue_completed_at,
              OLD.evidence_updated_at, OLD.evidence_updated_by_uid, OLD.evidence_updated_by_name)
       OR NEW.settlement_completed_at IS NOT NULL
       OR NEW.settlement_completed_by_uid IS NOT NULL
       OR NEW.settlement_completed_by_name IS NOT NULL
       OR NEW.settlement_completion_reason IS NOT NULL
       OR NEW.frozen_at IS NOT NULL OR NEW.frozen_by_uid IS NOT NULL
       OR NEW.frozen_by_name IS NOT NULL OR NEW.freeze_reason IS NOT NULL
       OR NEW.reopened_at IS DISTINCT FROM NEW.updated_at
       OR NEW.reopened_by_uid IS DISTINCT FROM NEW.last_actor_uid
       OR NEW.reopened_by_name IS DISTINCT FROM NEW.last_actor_name
       OR NEW.reopen_reason IS DISTINCT FROM NEW.last_action_reason THEN
      RAISE EXCEPTION 'invalid settlement reopen transition'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_settlement_completion_cases_transition_guard';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported settlement completion transition'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_settlement_completion_cases_transition_guard';
  END IF;
  RETURN NEW;
END
$settlement_completion_case_guard$;

CREATE OR REPLACE FUNCTION public.peakos_settlement_completion_audit_case()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $settlement_completion_audit_case$
BEGIN
  INSERT INTO public.peakos_settlement_completion_audit
    (workspace_id, source_monthly_id, action, row_version, actor_uid, actor_name,
     reason, before_state, after_state, created_at)
  VALUES
    (NEW.workspace_id, NEW.source_monthly_id, NEW.last_action, NEW.row_version,
     NEW.last_actor_uid, NEW.last_actor_name, NEW.last_action_reason,
     CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
     to_jsonb(NEW), NEW.last_action_at);
  RETURN NEW;
END
$settlement_completion_audit_case$;

CREATE OR REPLACE FUNCTION public.peakos_settlement_completion_reject_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $settlement_completion_append_only$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$settlement_completion_append_only$;

CREATE OR REPLACE FUNCTION public.peakos_settlement_completion_guard_source()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $settlement_completion_guard_source$
DECLARE
  linked_case public.peakos_settlement_completion_cases%ROWTYPE;
  new_rule TEXT;
BEGIN
  SELECT completion.* INTO linked_case
    FROM public.peakos_settlement_completion_cases completion
   WHERE completion.workspace_id = COALESCE(OLD.workspace_id, 'ws_peak')
     AND completion.source_monthly_id = OLD.id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'monthly settlement row has completion evidence'
      USING ERRCODE = '23503',
            CONSTRAINT = 'peakos_monthly_settlement_completion_attached';
  END IF;

  IF linked_case.status IN ('COMPLETED', 'FROZEN') THEN
    RAISE EXCEPTION 'monthly settlement row is completed or frozen'
      USING ERRCODE = 'P0001',
            CONSTRAINT = 'peakos_monthly_settlement_completion_lock';
  END IF;

  new_rule := CASE
    WHEN NEW.kind = 'sale' AND NEW.view = 'direct-execution' THEN 'DIRECT_EXECUTION_8TH'
    WHEN NEW.kind = 'sale' AND NEW.view = 'monthly-manage' THEN 'MONTHLY_MANAGEMENT_30D'
    WHEN NEW.kind = 'sale' AND NEW.view = 'monthly-guarantee' AND btrim(NEW.c) = '월보장'
      THEN 'MONTHLY_GUARANTEE_25D'
    WHEN NEW.kind = 'sale' AND NEW.view = 'monthly-guarantee' AND btrim(NEW.c) = '건바이'
      THEN 'PER_ITEM_24H'
    ELSE NULL
  END;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR COALESCE(NEW.workspace_id, 'ws_peak') IS DISTINCT FROM linked_case.workspace_id
     OR new_rule IS DISTINCT FROM linked_case.rule_code THEN
    RAISE EXCEPTION 'monthly settlement source identity or rule is attached to completion evidence'
      USING ERRCODE = '23503',
            CONSTRAINT = 'peakos_monthly_settlement_completion_attached';
  END IF;
  RETURN NEW;
END
$settlement_completion_guard_source$;

DROP TRIGGER IF EXISTS peakos_settlement_completion_cases_source_guard
  ON peakos_settlement_completion_cases;
CREATE TRIGGER peakos_settlement_completion_cases_source_guard
BEFORE INSERT OR UPDATE OF workspace_id, source_monthly_id, rule_code
ON peakos_settlement_completion_cases
FOR EACH ROW EXECUTE FUNCTION public.peakos_settlement_completion_assert_source();

DROP TRIGGER IF EXISTS peakos_settlement_completion_cases_transition_guard
  ON peakos_settlement_completion_cases;
CREATE TRIGGER peakos_settlement_completion_cases_transition_guard
BEFORE INSERT OR UPDATE ON peakos_settlement_completion_cases
FOR EACH ROW EXECUTE FUNCTION public.peakos_settlement_completion_case_guard();

DROP TRIGGER IF EXISTS peakos_settlement_completion_cases_audit
  ON peakos_settlement_completion_cases;
CREATE TRIGGER peakos_settlement_completion_cases_audit
AFTER INSERT OR UPDATE ON peakos_settlement_completion_cases
FOR EACH ROW EXECUTE FUNCTION public.peakos_settlement_completion_audit_case();

DROP TRIGGER IF EXISTS peakos_settlement_completion_cases_no_delete
  ON peakos_settlement_completion_cases;
CREATE TRIGGER peakos_settlement_completion_cases_no_delete
BEFORE DELETE ON peakos_settlement_completion_cases
FOR EACH ROW EXECUTE FUNCTION public.peakos_settlement_completion_reject_mutation();

DROP TRIGGER IF EXISTS peakos_settlement_completion_cases_no_truncate
  ON peakos_settlement_completion_cases;
CREATE TRIGGER peakos_settlement_completion_cases_no_truncate
BEFORE TRUNCATE ON peakos_settlement_completion_cases
FOR EACH STATEMENT EXECUTE FUNCTION public.peakos_settlement_completion_reject_mutation();

DROP TRIGGER IF EXISTS peakos_settlement_completion_audit_no_mutation
  ON peakos_settlement_completion_audit;
CREATE TRIGGER peakos_settlement_completion_audit_no_mutation
BEFORE UPDATE OR DELETE ON peakos_settlement_completion_audit
FOR EACH ROW EXECUTE FUNCTION public.peakos_settlement_completion_reject_mutation();

DROP TRIGGER IF EXISTS peakos_settlement_completion_audit_no_truncate
  ON peakos_settlement_completion_audit;
CREATE TRIGGER peakos_settlement_completion_audit_no_truncate
BEFORE TRUNCATE ON peakos_settlement_completion_audit
FOR EACH STATEMENT EXECUTE FUNCTION public.peakos_settlement_completion_reject_mutation();

DROP TRIGGER IF EXISTS peakos_monthly_settlement_completion_guard ON peakos_monthly;
CREATE TRIGGER peakos_monthly_settlement_completion_guard
BEFORE UPDATE OR DELETE ON peakos_monthly
FOR EACH ROW EXECUTE FUNCTION public.peakos_settlement_completion_guard_source();

DO $settlement_completion_runtime_grants$
DECLARE
  configured_role TEXT := NULLIF(current_setting('peakos.app_role', TRUE), '');
  application_role TEXT;
  function_signature TEXT;
  privilege_name TEXT;
BEGIN
  application_role := configured_role;
  IF application_role IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
      application_role := 'calendar_user';
    ELSE
      RAISE EXCEPTION
        'set peakos.app_role to the non-owner runtime role before applying settlement completion migration'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role) THEN
    RAISE EXCEPTION 'PEAK OS application role % does not exist', application_role;
  END IF;
  IF application_role = current_user THEN
    RAISE EXCEPTION 'settlement completion migration must run as an operator role, not runtime role %', application_role
      USING ERRCODE = '55000';
  END IF;

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE peakos_settlement_completion_cases FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE ON TABLE peakos_settlement_completion_cases TO %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE peakos_settlement_completion_audit FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT ON TABLE peakos_settlement_completion_audit TO %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON SEQUENCE peakos_settlement_completion_audit_id_seq FROM PUBLIC, %I',
    application_role
  );

  FOREACH function_signature IN ARRAY ARRAY[
    'peakos_settlement_completion_case_is_eligible(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,integer,timestamp with time zone,timestamp with time zone)',
    'peakos_settlement_completion_assert_source()',
    'peakos_settlement_completion_case_guard()',
    'peakos_settlement_completion_audit_case()',
    'peakos_settlement_completion_reject_mutation()',
    'peakos_settlement_completion_guard_source()'
  ]
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, %I', function_signature, application_role);
  END LOOP;

  FOREACH privilege_name IN ARRAY ARRAY['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
  LOOP
    IF has_table_privilege(application_role, 'public.peakos_settlement_completion_cases', privilege_name)
       OR has_table_privilege(application_role, 'public.peakos_settlement_completion_audit', privilege_name) THEN
      RAISE EXCEPTION 'runtime role % has unsafe settlement completion % privilege',
        application_role, privilege_name USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF has_table_privilege(application_role, 'public.peakos_settlement_completion_audit', 'INSERT')
     OR has_table_privilege(application_role, 'public.peakos_settlement_completion_audit', 'UPDATE') THEN
    RAISE EXCEPTION 'runtime role % can mutate settlement completion audit directly', application_role
      USING ERRCODE = '55000';
  END IF;
END
$settlement_completion_runtime_grants$;

COMMIT;
