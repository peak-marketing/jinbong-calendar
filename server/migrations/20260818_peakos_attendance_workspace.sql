-- PEAK OS workspace-scoped attendance v1.
--
-- The legacy table stored a KST date/time as unrelated TEXT columns and had
-- no tenant key. This migration preserves those projections for the legacy
-- calendar client, adds canonical instants and a workspace boundary, and
-- makes check-in/check-out mutations auditable. Apply once as an operator
-- with `SET peakos.app_role = 'calendar_user'` in the same session.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-attendance-workspace-v1'));

DO $prerequisites$
BEGIN
  IF to_regclass('public.attendance') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.peakos_workspaces') IS NULL
     OR to_regclass('public.peakos_workspace_memberships') IS NULL THEN
    RAISE EXCEPTION
      'attendance, users and peakos workspace migrations are required'
      USING ERRCODE = '55000';
  END IF;
END
$prerequisites$;

LOCK TABLE public.attendance IN ACCESS EXCLUSIVE MODE;

DO $validate_legacy_values$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.attendance
     WHERE attendance_date !~ '^\d{4}-\d{2}-\d{2}$'
        OR to_char(to_date(attendance_date, 'YYYY-MM-DD'), 'YYYY-MM-DD') <> attendance_date
        OR check_in IS NULL
        OR check_in !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        OR (check_out IS NOT NULL
            AND check_out !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  ) THEN
    RAISE EXCEPTION 'legacy attendance contains an invalid date or time'
      USING ERRCODE = '23514';
  END IF;

END
$validate_legacy_values$;

ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS check_in_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS check_out_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;

-- Freeze an evidence-backed plan before writing anything. Active users require
-- exactly one active, direct default membership. A historical user without a
-- membership may follow their non-null group only when active peers in that
-- exact group resolve to one and only one direct default workspace. Zero or
-- multiple candidates abort the whole transaction; ws_peak is never guessed.
CREATE TEMPORARY TABLE peakos_attendance_backfill_plan (
  attendance_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mapping_source TEXT NOT NULL CHECK (mapping_source IN ('direct_membership', 'group_lineage'))
) ON COMMIT DROP;

INSERT INTO peakos_attendance_backfill_plan
  (attendance_id, workspace_id, mapping_source)
SELECT attendance_row.id,
       COALESCE(direct_lineage.workspace_id, group_lineage.workspace_id),
       CASE WHEN direct_lineage.workspace_id IS NOT NULL
            THEN 'direct_membership' ELSE 'group_lineage' END
  FROM public.attendance attendance_row
  JOIN public.users owner_user ON owner_user.uid = attendance_row.user_id
  LEFT JOIN LATERAL (
    SELECT MIN(membership.workspace_id) AS workspace_id,
           COUNT(DISTINCT membership.workspace_id) AS candidate_count
      FROM public.peakos_workspace_memberships membership
     WHERE membership.user_uid = attendance_row.user_id
       AND membership.active = TRUE
       AND membership.role <> 'oversight'
       AND membership.is_default = TRUE
  ) direct_lineage ON TRUE
  LEFT JOIN LATERAL (
    SELECT MIN(peer_membership.workspace_id) AS workspace_id,
           COUNT(DISTINCT peer_membership.workspace_id) AS candidate_count
      FROM public.users peer_user
      JOIN public.peakos_workspace_memberships peer_membership
        ON peer_membership.user_uid = peer_user.uid
       AND peer_membership.active = TRUE
       AND peer_membership.role <> 'oversight'
       AND peer_membership.is_default = TRUE
     WHERE owner_user.group_id IS NOT NULL
       AND peer_user.group_id = owner_user.group_id
  ) group_lineage ON direct_lineage.candidate_count = 0
 WHERE attendance_row.workspace_id IS NULL
   AND (
     direct_lineage.candidate_count = 1
     OR (direct_lineage.candidate_count = 0 AND group_lineage.candidate_count = 1)
   );

DO $validate_backfill_plan$
DECLARE
  source_rows BIGINT;
  planned_rows BIGINT;
BEGIN
  SELECT COUNT(*) INTO source_rows
    FROM public.attendance WHERE workspace_id IS NULL;
  SELECT COUNT(*) INTO planned_rows
    FROM peakos_attendance_backfill_plan;
  IF planned_rows <> source_rows THEN
    RAISE EXCEPTION
      'attendance workspace lineage is missing or ambiguous (planned %, source %) ',
      planned_rows, source_rows
      USING ERRCODE = '23514';
  END IF;
END
$validate_backfill_plan$;

UPDATE public.attendance attendance_row
   SET workspace_id = plan.workspace_id
  FROM peakos_attendance_backfill_plan plan
 WHERE plan.attendance_id = attendance_row.id
   AND attendance_row.workspace_id IS NULL;

INSERT INTO public.peakos_workspace_bootstrap_state (key, metadata)
SELECT 'attendance-workspace-backfill-v1',
       jsonb_build_object(
         'directMembershipRows', COUNT(*) FILTER (WHERE mapping_source = 'direct_membership'),
         'groupLineageRows', COUNT(*) FILTER (WHERE mapping_source = 'group_lineage'),
         'unmappedOrAmbiguousRows', 0,
         'totalRows', COUNT(*)
       )
  FROM peakos_attendance_backfill_plan
ON CONFLICT (key) DO NOTHING;

UPDATE public.attendance
   SET check_in_at = ((attendance_date || ' ' || check_in)::timestamp AT TIME ZONE 'Asia/Seoul')
 WHERE check_in_at IS NULL;

UPDATE public.attendance
   SET check_out_at = ((attendance_date || ' ' || check_out)::timestamp AT TIME ZONE 'Asia/Seoul')
 WHERE check_out IS NOT NULL
   AND check_out_at IS NULL;

DO $validate_backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.attendance
     WHERE workspace_id IS NULL
        OR check_in_at IS NULL
        OR (check_out IS NULL) <> (check_out_at IS NULL)
        OR check_out_at < check_in_at
  ) THEN
    RAISE EXCEPTION 'attendance workspace/time backfill is incomplete'
      USING ERRCODE = '23514';
  END IF;
END
$validate_backfill$;

ALTER TABLE public.attendance
  ALTER COLUMN workspace_id SET NOT NULL,
  ALTER COLUMN check_in_at SET NOT NULL;

ALTER TABLE public.attendance
  DROP CONSTRAINT IF EXISTS attendance_user_id_attendance_date_key,
  DROP CONSTRAINT IF EXISTS peakos_attendance_workspace_fk,
  DROP CONSTRAINT IF EXISTS peakos_attendance_date_check,
  DROP CONSTRAINT IF EXISTS peakos_attendance_time_projection_check,
  DROP CONSTRAINT IF EXISTS peakos_attendance_checkout_order_check,
  DROP CONSTRAINT IF EXISTS peakos_attendance_row_version_check;

ALTER TABLE public.attendance
  ADD CONSTRAINT peakos_attendance_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES public.peakos_workspaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT peakos_attendance_date_check
    CHECK (
      attendance_date ~ '^\d{4}-\d{2}-\d{2}$'
      AND to_char(to_date(attendance_date, 'YYYY-MM-DD'), 'YYYY-MM-DD') = attendance_date
      AND to_char(check_in_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') = attendance_date
      AND (check_out_at IS NULL
           OR to_char(check_out_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') = attendance_date)
    ),
  ADD CONSTRAINT peakos_attendance_time_projection_check
    CHECK (
      check_in ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND check_in = to_char(check_in_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI')
      AND (
        (check_out IS NULL AND check_out_at IS NULL)
        OR
        (check_out ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         AND check_out = to_char(check_out_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI'))
      )
    ),
  ADD CONSTRAINT peakos_attendance_checkout_order_check
    CHECK (check_out_at IS NULL OR check_out_at >= check_in_at),
  ADD CONSTRAINT peakos_attendance_row_version_check
    CHECK (row_version BETWEEN 1 AND 2147483647);

CREATE UNIQUE INDEX IF NOT EXISTS peakos_attendance_workspace_user_date_unique
  ON public.attendance(workspace_id, user_id, attendance_date);
CREATE UNIQUE INDEX IF NOT EXISTS peakos_attendance_workspace_id_unique
  ON public.attendance(workspace_id, id);
CREATE INDEX IF NOT EXISTS peakos_attendance_workspace_month_idx
  ON public.attendance(workspace_id, attendance_date, user_id);

CREATE OR REPLACE FUNCTION public.peakos_attendance_guard_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
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
$function$;

DROP TRIGGER IF EXISTS peakos_attendance_guard_update ON public.attendance;
CREATE TRIGGER peakos_attendance_guard_update
BEFORE UPDATE ON public.attendance
FOR EACH ROW EXECUTE FUNCTION public.peakos_attendance_guard_update();

CREATE TABLE IF NOT EXISTS public.peakos_attendance_events (
  workspace_id TEXT NOT NULL,
  id BIGSERIAL NOT NULL,
  attendance_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name_snapshot TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  record_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_attendance_events_attendance_fk
    FOREIGN KEY (workspace_id, attendance_id)
    REFERENCES public.attendance(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_attendance_events_actor_membership_fk
    FOREIGN KEY (workspace_id, actor_uid)
    REFERENCES public.peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_attendance_events_type_check
    CHECK (event_type IN ('CHECK_IN', 'CHECK_OUT')),
  CONSTRAINT peakos_attendance_events_actor_uid_check
    CHECK (char_length(btrim(actor_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_attendance_events_actor_name_check
    CHECK (char_length(btrim(actor_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_attendance_events_version_check
    CHECK (record_version BETWEEN 1 AND 2147483647)
);

CREATE INDEX IF NOT EXISTS peakos_attendance_events_record_idx
  ON public.peakos_attendance_events(workspace_id, attendance_id, created_at, id);
CREATE INDEX IF NOT EXISTS peakos_attendance_events_actor_idx
  ON public.peakos_attendance_events(workspace_id, actor_uid, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.peakos_attendance_event_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'peakos_attendance_events is append-only'
    USING ERRCODE = '55000';
END
$function$;

DROP TRIGGER IF EXISTS peakos_attendance_events_no_mutation
  ON public.peakos_attendance_events;
CREATE TRIGGER peakos_attendance_events_no_mutation
BEFORE UPDATE OR DELETE ON public.peakos_attendance_events
FOR EACH ROW EXECUTE FUNCTION public.peakos_attendance_event_append_only();

DO $runtime_acl$
DECLARE
  app_role TEXT := NULLIF(current_setting('peakos.app_role', TRUE), '');
BEGIN
  IF app_role IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    RAISE EXCEPTION 'set peakos.app_role to the runtime database role before migrating'
      USING ERRCODE = '22023';
  END IF;

  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.attendance FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.attendance TO %I', app_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.peakos_attendance_events FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT ON TABLE public.peakos_attendance_events TO %I', app_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.peakos_attendance_events_id_seq FROM %I', app_role);
  EXECUTE format('GRANT USAGE ON SEQUENCE public.peakos_attendance_events_id_seq TO %I', app_role);
END
$runtime_acl$;

COMMIT;
