-- PEAK OS-only, workspace-wide calendar visibility.
--
-- Hiding an event in PEAK OS must never mutate the legacy events.deleted
-- flag. This additive table records only the OS presentation decision. The
-- canonical Paragon calendar continues to read the event row unchanged.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-workspace-event-hides-v1'));

DO $event_hide_prerequisites$
BEGIN
  IF to_regclass('public.peakos_workspaces') IS NULL
     OR to_regclass('public.peakos_workspace_memberships') IS NULL
     OR to_regclass('public.events') IS NULL THEN
    RAISE EXCEPTION
      'peakos workspace and events migrations must be applied before event hides'
      USING ERRCODE = '55000';
  END IF;
END
$event_hide_prerequisites$;

CREATE TABLE IF NOT EXISTS peakos_workspace_event_hides (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  hidden_by_uid TEXT NOT NULL,
  hidden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, event_id),
  CONSTRAINT peakos_workspace_event_hides_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_workspace_event_hides_event_fk
    FOREIGN KEY (event_id)
    REFERENCES events(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT peakos_workspace_event_hides_actor_membership_fk
    FOREIGN KEY (workspace_id, hidden_by_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_workspace_event_hides_event_id_check
    CHECK (char_length(btrim(event_id)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_workspace_event_hides_actor_uid_check
    CHECK (char_length(btrim(hidden_by_uid)) BETWEEN 1 AND 200)
);

-- The primary key supports every workspace-scoped read. PostgreSQL needs the
-- reverse event index as well so deleting an event does not scan all hides
-- while enforcing the event FK.
CREATE INDEX IF NOT EXISTS peakos_workspace_event_hides_event_idx
  ON peakos_workspace_event_hides(event_id);

-- event_id is globally unique in the legacy table, while workspace_id was
-- added later and still permits the legacy Peak NULL fallback. A normal
-- composite FK therefore cannot express COALESCE(events.workspace_id,
-- 'ws_peak'). These two lock-aware triggers enforce the equivalent invariant
-- in both directions without rewriting any event row.
CREATE OR REPLACE FUNCTION peakos_workspace_event_hide_assert_workspace()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $event_hide_workspace_guard$
DECLARE
  actual_workspace_id TEXT;
BEGIN
  SELECT COALESCE(event_row.workspace_id, 'ws_peak')
    INTO actual_workspace_id
    FROM events event_row
   WHERE event_row.id = NEW.event_id
   FOR UPDATE;

  IF actual_workspace_id IS NULL OR actual_workspace_id IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'event % does not belong to workspace %', NEW.event_id, NEW.workspace_id
      USING ERRCODE = '23503',
            CONSTRAINT = 'peakos_workspace_event_hides_event_workspace_fk';
  END IF;
  RETURN NEW;
END
$event_hide_workspace_guard$;

DROP TRIGGER IF EXISTS peakos_workspace_event_hides_workspace_guard
  ON peakos_workspace_event_hides;
CREATE TRIGGER peakos_workspace_event_hides_workspace_guard
BEFORE INSERT OR UPDATE ON peakos_workspace_event_hides
FOR EACH ROW EXECUTE FUNCTION peakos_workspace_event_hide_assert_workspace();

CREATE OR REPLACE FUNCTION peakos_event_workspace_preserve_hides()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $event_workspace_hide_guard$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM peakos_workspace_event_hides event_hide
     WHERE event_hide.event_id = NEW.id
       AND event_hide.workspace_id IS DISTINCT FROM COALESCE(NEW.workspace_id, 'ws_peak')
  ) THEN
    RAISE EXCEPTION 'event % workspace conflicts with an OS hide row', NEW.id
      USING ERRCODE = '23503',
            CONSTRAINT = 'peakos_workspace_event_hides_event_workspace_fk';
  END IF;
  RETURN NEW;
END
$event_workspace_hide_guard$;

DROP TRIGGER IF EXISTS peakos_events_workspace_hide_guard ON events;
CREATE TRIGGER peakos_events_workspace_hide_guard
BEFORE UPDATE OF workspace_id ON events
FOR EACH ROW
WHEN (OLD.workspace_id IS DISTINCT FROM NEW.workspace_id)
EXECUTE FUNCTION peakos_event_workspace_preserve_hides();

-- This file is applied by an owner/DBA while the API normally connects as
-- calendar_user. Override in the same operator session with:
--   SET peakos.app_role = 'another_runtime_role';
DO $event_hide_runtime_grants$
DECLARE
  configured_role TEXT := NULLIF(current_setting('peakos.app_role', TRUE), '');
  application_role TEXT;
BEGIN
  application_role := configured_role;
  IF application_role IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
      application_role := 'calendar_user';
    ELSE
      application_role := current_user;
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role) THEN
    RAISE EXCEPTION 'PEAK OS application role % does not exist', application_role;
  END IF;

  EXECUTE format(
    'GRANT SELECT, INSERT, DELETE ON TABLE peakos_workspace_event_hides TO %I',
    application_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION peakos_workspace_event_hide_assert_workspace() TO %I',
    application_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION peakos_event_workspace_preserve_hides() TO %I',
    application_role
  );
END
$event_hide_runtime_grants$;

COMMIT;
