-- PEAK OS checklist instruction delivery.
--
-- This is deliberately an additive companion to event_checklist. Selecting an
-- instructor grants no event share and changes no Paragon event visibility.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-event-checklist-directives-v1'));

DO $directive_prerequisites$
BEGIN
  IF to_regclass('public.peakos_workspaces') IS NULL
     OR to_regclass('public.peakos_workspace_memberships') IS NULL
     OR to_regclass('public.events') IS NULL
     OR to_regclass('public.event_checklist') IS NULL THEN
    RAISE EXCEPTION
      'workspace, events, and event_checklist migrations must be applied before checklist directives'
      USING ERRCODE = '55000';
  END IF;
END
$directive_prerequisites$;

CREATE TABLE IF NOT EXISTS peakos_event_checklist_directives (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  checklist_item_id TEXT NOT NULL,
  instructor_uid TEXT NOT NULL,
  instructor_name_snapshot TEXT NOT NULL,
  recorded_by_uid TEXT NOT NULL,
  recorded_by_name_snapshot TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, checklist_item_id),
  CONSTRAINT peakos_event_checklist_directives_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_event_checklist_directives_event_fk
    FOREIGN KEY (event_id)
    REFERENCES events(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT peakos_event_checklist_directives_item_fk
    FOREIGN KEY (checklist_item_id)
    REFERENCES event_checklist(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT peakos_event_checklist_directives_instructor_membership_fk
    FOREIGN KEY (workspace_id, instructor_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_event_checklist_directives_recorder_membership_fk
    FOREIGN KEY (workspace_id, recorded_by_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_event_checklist_directives_event_id_check
    CHECK (char_length(btrim(event_id)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_event_checklist_directives_item_id_check
    CHECK (char_length(btrim(checklist_item_id)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_event_checklist_directives_instructor_uid_check
    CHECK (char_length(btrim(instructor_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_event_checklist_directives_instructor_name_check
    CHECK (char_length(btrim(instructor_name_snapshot)) BETWEEN 1 AND 240),
  CONSTRAINT peakos_event_checklist_directives_recorder_uid_check
    CHECK (char_length(btrim(recorded_by_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_event_checklist_directives_recorder_name_check
    CHECK (char_length(btrim(recorded_by_name_snapshot)) BETWEEN 1 AND 240),
  CONSTRAINT peakos_event_checklist_directives_version_check
    CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS peakos_event_checklist_directives_inbox_idx
  ON peakos_event_checklist_directives
    (workspace_id, instructor_uid, event_id, checklist_item_id);

CREATE INDEX IF NOT EXISTS peakos_event_checklist_directives_event_idx
  ON peakos_event_checklist_directives(event_id);

-- event_checklist has only event_id and legacy events still permit a NULL
-- workspace_id. The trigger enforces the otherwise-unrepresentable composite
-- invariant, including the established NULL -> ws_peak fallback.
CREATE OR REPLACE FUNCTION public.peakos_event_checklist_directive_assert_parent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $directive_parent_guard$
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
$directive_parent_guard$;

DROP TRIGGER IF EXISTS peakos_event_checklist_directives_parent_guard
  ON peakos_event_checklist_directives;
CREATE TRIGGER peakos_event_checklist_directives_parent_guard
BEFORE INSERT OR UPDATE OF workspace_id, event_id, checklist_item_id
ON peakos_event_checklist_directives
FOR EACH ROW EXECUTE FUNCTION public.peakos_event_checklist_directive_assert_parent();

CREATE OR REPLACE FUNCTION public.peakos_event_preserve_checklist_directives()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $event_directive_workspace_guard$
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
$event_directive_workspace_guard$;

DROP TRIGGER IF EXISTS peakos_events_checklist_directive_workspace_guard ON events;
CREATE TRIGGER peakos_events_checklist_directive_workspace_guard
BEFORE UPDATE OF workspace_id, project_id ON events
FOR EACH ROW
WHEN (OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
   OR OLD.project_id IS DISTINCT FROM NEW.project_id)
EXECUTE FUNCTION public.peakos_event_preserve_checklist_directives();

CREATE OR REPLACE FUNCTION public.peakos_checklist_item_preserve_directive_parent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $checklist_directive_event_guard$
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
$checklist_directive_event_guard$;

DROP TRIGGER IF EXISTS peakos_event_checklist_directive_event_guard ON event_checklist;
CREATE TRIGGER peakos_event_checklist_directive_event_guard
BEFORE UPDATE OF event_id ON event_checklist
FOR EACH ROW
WHEN (OLD.event_id IS DISTINCT FROM NEW.event_id)
EXECUTE FUNCTION public.peakos_checklist_item_preserve_directive_parent();

CREATE OR REPLACE FUNCTION public.peakos_event_checklist_directive_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $directive_touch$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END
$directive_touch$;

DROP TRIGGER IF EXISTS peakos_event_checklist_directives_touch_updated_at
  ON peakos_event_checklist_directives;
CREATE TRIGGER peakos_event_checklist_directives_touch_updated_at
BEFORE UPDATE ON peakos_event_checklist_directives
FOR EACH ROW EXECUTE FUNCTION public.peakos_event_checklist_directive_touch_updated_at();

-- Runtime privileges are reset rather than trusting inherited/default ACLs.
-- Applied by an owner/DBA. Override in the same operator session with:
--   SET peakos.app_role = 'another_runtime_role';
-- When calendar_user does not exist the migration fails closed; it never grants
-- application privileges to the DBA/current_user by accident. Trigger functions
-- remain callable by their owning trigger only, not directly by the app role.
DO $directive_runtime_grants$
DECLARE
  configured_role TEXT := NULLIF(current_setting('peakos.app_role', TRUE), '');
  application_role TEXT;
  privilege_name TEXT;
  function_signature TEXT;
BEGIN
  application_role := configured_role;
  IF application_role IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
      application_role := 'calendar_user';
    ELSE
      RAISE EXCEPTION
        'set peakos.app_role to the non-owner runtime role before applying PEAK OS checklist directives migration'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role) THEN
    RAISE EXCEPTION 'PEAK OS application role % does not exist', application_role;
  END IF;

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE public.peakos_event_checklist_directives FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.peakos_event_checklist_directives TO %I',
    application_role
  );

  FOREACH function_signature IN ARRAY ARRAY[
    'public.peakos_event_checklist_directive_assert_parent()',
    'public.peakos_event_preserve_checklist_directives()',
    'public.peakos_checklist_item_preserve_directive_parent()',
    'public.peakos_event_checklist_directive_touch_updated_at()'
  ]
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, %I',
      function_signature,
      application_role
    );
  END LOOP;

  FOREACH privilege_name IN ARRAY ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE',
    'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ]
  LOOP
    IF has_table_privilege(
      application_role,
      'public.peakos_event_checklist_directives',
      privilege_name
    ) IS DISTINCT FROM (privilege_name IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')) THEN
      RAISE EXCEPTION
        'runtime role % has an unexpected effective % privilege on peakos_event_checklist_directives',
        application_role, privilege_name
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  FOREACH function_signature IN ARRAY ARRAY[
    'public.peakos_event_checklist_directive_assert_parent()',
    'public.peakos_event_preserve_checklist_directives()',
    'public.peakos_checklist_item_preserve_directive_parent()',
    'public.peakos_event_checklist_directive_touch_updated_at()'
  ]
  LOOP
    IF has_function_privilege(application_role, function_signature, 'EXECUTE') THEN
      RAISE EXCEPTION
        'runtime role % must not execute checklist directive trigger function % directly',
        application_role, function_signature
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$directive_runtime_grants$;

COMMIT;
