-- Add an optional owner to each structured-project medium category. Existing
-- category rows intentionally remain unassigned (NULL); the API/UI can assign
-- them later without rewriting or guessing historical ownership.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-structured-project-medium-managers-v1'));

DO $prerequisites$
BEGIN
  IF to_regclass('public.peakos_structured_project_medium_categories') IS NULL
     OR to_regclass('public.peakos_structured_project_members') IS NULL THEN
    RAISE EXCEPTION
      '20260811_peakos_structured_projects.sql must be applied before medium managers'
      USING ERRCODE = '55000';
  END IF;
END
$prerequisites$;

ALTER TABLE peakos_structured_project_medium_categories
  ADD COLUMN IF NOT EXISTS manager_uid TEXT,
  ADD COLUMN IF NOT EXISTS manager_name_snapshot TEXT;

DO $medium_manager_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'peakos_structured_project_medium_categories'::regclass
       AND conname = 'peakos_structured_project_medium_manager_fields_check'
  ) THEN
    ALTER TABLE peakos_structured_project_medium_categories
      ADD CONSTRAINT peakos_structured_project_medium_manager_fields_check
      CHECK (
        (manager_uid IS NULL AND manager_name_snapshot IS NULL)
        OR (
          manager_uid IS NOT NULL
          AND char_length(btrim(manager_uid)) BETWEEN 1 AND 200
          AND manager_name_snapshot IS NOT NULL
          AND char_length(btrim(manager_name_snapshot)) BETWEEN 1 AND 160
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'peakos_structured_project_medium_categories'::regclass
       AND conname = 'peakos_structured_project_medium_manager_fk'
  ) THEN
    ALTER TABLE peakos_structured_project_medium_categories
      ADD CONSTRAINT peakos_structured_project_medium_manager_fk
      FOREIGN KEY (workspace_id, project_id, manager_uid)
      REFERENCES peakos_structured_project_members(workspace_id, project_id, user_uid)
      ON UPDATE RESTRICT ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$medium_manager_constraints$;

CREATE INDEX IF NOT EXISTS peakos_structured_project_medium_manager_idx
  ON peakos_structured_project_medium_categories(workspace_id, project_id, manager_uid)
  WHERE active = TRUE AND manager_uid IS NOT NULL;

-- The composite FK establishes tenant/project lineage. This deferred guard adds
-- the business invariant that a manager of an active medium must also be an
-- active member. It runs for both assignment changes and member deactivation,
-- so the invariant cannot be bypassed outside the API.
CREATE OR REPLACE FUNCTION peakos_structured_project_assert_active_medium_manager()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $active_medium_manager$
DECLARE
  target_workspace_id TEXT;
  target_project_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_workspace_id := OLD.workspace_id;
    target_project_id := OLD.project_id;
  ELSE
    target_workspace_id := NEW.workspace_id;
    target_project_id := NEW.project_id;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM peakos_structured_project_medium_categories medium
      LEFT JOIN peakos_structured_project_members member
        ON member.workspace_id = medium.workspace_id
       AND member.project_id = medium.project_id
       AND member.user_uid = medium.manager_uid
       AND member.active = TRUE
     WHERE medium.workspace_id = target_workspace_id
       AND medium.project_id = target_project_id
       AND medium.active = TRUE
       AND medium.manager_uid IS NOT NULL
       AND member.user_uid IS NULL
  ) THEN
    RAISE EXCEPTION
      'active structured-project medium managers must be active project members for %/%',
      target_workspace_id, target_project_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$active_medium_manager$;

DROP TRIGGER IF EXISTS peakos_structured_project_medium_manager_guard
  ON peakos_structured_project_medium_categories;
CREATE CONSTRAINT TRIGGER peakos_structured_project_medium_manager_guard
AFTER INSERT OR UPDATE ON peakos_structured_project_medium_categories
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION peakos_structured_project_assert_active_medium_manager();

DROP TRIGGER IF EXISTS peakos_structured_project_members_medium_manager_guard
  ON peakos_structured_project_members;
CREATE CONSTRAINT TRIGGER peakos_structured_project_members_medium_manager_guard
AFTER INSERT OR UPDATE OR DELETE ON peakos_structured_project_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION peakos_structured_project_assert_active_medium_manager();

COMMIT;
