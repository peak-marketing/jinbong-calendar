-- Structured projects are a new, isolated model. This migration intentionally
-- does not copy or alter any row in the legacy projects/project_tasks tables.
-- Apply this file once through the operator migration workflow; API startup
-- performs a SELECT-only readiness check exported by peakos-new-project-policy.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-structured-projects-v1'));

DO $prerequisites$
BEGIN
  IF to_regclass('public.peakos_workspaces') IS NULL
     OR to_regclass('public.peakos_workspace_memberships') IS NULL THEN
    RAISE EXCEPTION
      'peakos workspace migrations must be applied before structured projects'
      USING ERRCODE = '55000';
  END IF;
END
$prerequisites$;

CREATE TABLE IF NOT EXISTS peakos_structured_projects (
  workspace_id TEXT NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  lead_uid TEXT NOT NULL,
  lead_name_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_uid TEXT NOT NULL,
  created_by_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_structured_projects_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_projects_lead_membership_fk
    FOREIGN KEY (workspace_id, lead_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_projects_creator_membership_fk
    FOREIGN KEY (workspace_id, created_by_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_projects_name_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_structured_projects_description_check
    CHECK (char_length(description) <= 10000),
  CONSTRAINT peakos_structured_projects_lead_uid_check
    CHECK (char_length(btrim(lead_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_structured_projects_lead_name_check
    CHECK (char_length(btrim(lead_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_structured_projects_status_check
    CHECK (status IN ('active', 'completed', 'archived')),
  CONSTRAINT peakos_structured_projects_sort_order_check
    CHECK (sort_order BETWEEN -1000000 AND 1000000),
  CONSTRAINT peakos_structured_projects_version_check
    CHECK (version BETWEEN 1 AND 2147483647),
  CONSTRAINT peakos_structured_projects_creator_uid_check
    CHECK (char_length(btrim(created_by_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_structured_projects_creator_name_check
    CHECK (char_length(btrim(created_by_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_structured_projects_updated_check
    CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS peakos_structured_project_members (
  workspace_id TEXT NOT NULL,
  project_id UUID NOT NULL,
  user_uid TEXT NOT NULL,
  user_name_snapshot TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  added_by_uid TEXT NOT NULL,
  added_by_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, project_id, user_uid),
  CONSTRAINT peakos_structured_project_members_project_fk
    FOREIGN KEY (workspace_id, project_id)
    REFERENCES peakos_structured_projects(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_members_user_membership_fk
    FOREIGN KEY (workspace_id, user_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_members_adder_membership_fk
    FOREIGN KEY (workspace_id, added_by_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_members_user_uid_check
    CHECK (char_length(btrim(user_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_structured_project_members_user_name_check
    CHECK (char_length(btrim(user_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_structured_project_members_role_check
    CHECK (role IN ('lead', 'member')),
  CONSTRAINT peakos_structured_project_members_sort_order_check
    CHECK (sort_order BETWEEN -1000000 AND 1000000),
  CONSTRAINT peakos_structured_project_members_version_check
    CHECK (version BETWEEN 1 AND 2147483647),
  CONSTRAINT peakos_structured_project_members_adder_uid_check
    CHECK (char_length(btrim(added_by_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_structured_project_members_adder_name_check
    CHECK (char_length(btrim(added_by_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_structured_project_members_updated_check
    CHECK (updated_at >= created_at)
);

-- The project and its lead member are created/changed in one transaction. This
-- deferred circular FK permits that ordering while preventing a committed
-- project from pointing at a non-member UID.
DO $lead_project_member_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'peakos_structured_projects'::regclass
      AND conname = 'peakos_structured_projects_lead_project_member_fk'
  ) THEN
    ALTER TABLE peakos_structured_projects
      ADD CONSTRAINT peakos_structured_projects_lead_project_member_fk
      FOREIGN KEY (workspace_id, id, lead_uid)
      REFERENCES peakos_structured_project_members(workspace_id, project_id, user_uid)
      ON UPDATE RESTRICT ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$lead_project_member_fk$;

CREATE TABLE IF NOT EXISTS peakos_structured_project_medium_categories (
  workspace_id TEXT NOT NULL,
  project_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  manager_uid TEXT,
  manager_name_snapshot TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_uid TEXT NOT NULL,
  created_by_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, project_id, id),
  CONSTRAINT peakos_structured_project_medium_project_fk
    FOREIGN KEY (workspace_id, project_id)
    REFERENCES peakos_structured_projects(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_medium_creator_membership_fk
    FOREIGN KEY (workspace_id, created_by_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_medium_manager_fields_check
    CHECK (
      (manager_uid IS NULL AND manager_name_snapshot IS NULL)
      OR (
        manager_uid IS NOT NULL
        AND char_length(btrim(manager_uid)) BETWEEN 1 AND 200
        AND manager_name_snapshot IS NOT NULL
        AND char_length(btrim(manager_name_snapshot)) BETWEEN 1 AND 160
      )
    ),
  CONSTRAINT peakos_structured_project_medium_manager_fk
    FOREIGN KEY (workspace_id, project_id, manager_uid)
    REFERENCES peakos_structured_project_members(workspace_id, project_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT peakos_structured_project_medium_name_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_structured_project_medium_description_check
    CHECK (char_length(description) <= 10000),
  CONSTRAINT peakos_structured_project_medium_sort_order_check
    CHECK (sort_order BETWEEN -1000000 AND 1000000),
  CONSTRAINT peakos_structured_project_medium_version_check
    CHECK (version BETWEEN 1 AND 2147483647),
  CONSTRAINT peakos_structured_project_medium_creator_uid_check
    CHECK (char_length(btrim(created_by_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_structured_project_medium_creator_name_check
    CHECK (char_length(btrim(created_by_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_structured_project_medium_updated_check
    CHECK (updated_at >= created_at)
);

-- Older installations applied the first structured-project migration before
-- medium managers shipped. Keep this operator migration safely re-runnable so
-- the current schema can be reached without relying on CREATE TABLE IF NOT
-- EXISTS to retrofit columns or constraints.
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

CREATE TABLE IF NOT EXISTS peakos_structured_project_small_categories (
  workspace_id TEXT NOT NULL,
  project_id UUID NOT NULL,
  medium_category_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_uid TEXT NOT NULL,
  created_by_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, project_id, id),
  UNIQUE (workspace_id, project_id, medium_category_id, id),
  CONSTRAINT peakos_structured_project_small_project_fk
    FOREIGN KEY (workspace_id, project_id)
    REFERENCES peakos_structured_projects(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_small_medium_fk
    FOREIGN KEY (workspace_id, project_id, medium_category_id)
    REFERENCES peakos_structured_project_medium_categories(workspace_id, project_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_small_creator_membership_fk
    FOREIGN KEY (workspace_id, created_by_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_small_name_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_structured_project_small_description_check
    CHECK (char_length(description) <= 10000),
  CONSTRAINT peakos_structured_project_small_sort_order_check
    CHECK (sort_order BETWEEN -1000000 AND 1000000),
  CONSTRAINT peakos_structured_project_small_version_check
    CHECK (version BETWEEN 1 AND 2147483647),
  CONSTRAINT peakos_structured_project_small_creator_uid_check
    CHECK (char_length(btrim(created_by_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_structured_project_small_creator_name_check
    CHECK (char_length(btrim(created_by_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_structured_project_small_updated_check
    CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS peakos_structured_project_tasks (
  workspace_id TEXT NOT NULL,
  project_id UUID NOT NULL,
  medium_category_id UUID NOT NULL,
  small_category_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  assignee_uid TEXT NOT NULL,
  assignee_name_snapshot TEXT NOT NULL,
  assigned_by_uid TEXT NOT NULL,
  assigned_by_name_snapshot TEXT NOT NULL,
  reviewer_uid TEXT NOT NULL,
  reviewer_name_snapshot TEXT NOT NULL,
  reviewer_source TEXT NOT NULL,
  due_date DATE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  last_note TEXT NOT NULL DEFAULT '',
  review_requested_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_uid TEXT NOT NULL,
  created_by_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, project_id, id),
  CONSTRAINT peakos_structured_project_tasks_project_fk
    FOREIGN KEY (workspace_id, project_id)
    REFERENCES peakos_structured_projects(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_tasks_medium_fk
    FOREIGN KEY (workspace_id, project_id, medium_category_id)
    REFERENCES peakos_structured_project_medium_categories(workspace_id, project_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_tasks_small_hierarchy_fk
    FOREIGN KEY (workspace_id, project_id, medium_category_id, small_category_id)
    REFERENCES peakos_structured_project_small_categories(workspace_id, project_id, medium_category_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_tasks_assignee_fk
    FOREIGN KEY (workspace_id, project_id, assignee_uid)
    REFERENCES peakos_structured_project_members(workspace_id, project_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_tasks_assigner_membership_fk
    FOREIGN KEY (workspace_id, assigned_by_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_tasks_reviewer_membership_fk
    FOREIGN KEY (workspace_id, reviewer_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_tasks_creator_membership_fk
    FOREIGN KEY (workspace_id, created_by_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_tasks_title_check
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 240),
  CONSTRAINT peakos_structured_project_tasks_description_check
    CHECK (char_length(description) <= 20000),
  CONSTRAINT peakos_structured_project_tasks_status_check
    CHECK (status IN ('todo', 'doing', 'review', 'revision', 'done')),
  CONSTRAINT peakos_structured_project_tasks_assignee_uid_check
    CHECK (char_length(btrim(assignee_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_structured_project_tasks_assignee_name_check
    CHECK (char_length(btrim(assignee_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_structured_project_tasks_assigner_uid_check
    CHECK (char_length(btrim(assigned_by_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_structured_project_tasks_assigner_name_check
    CHECK (char_length(btrim(assigned_by_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_structured_project_tasks_reviewer_uid_check
    CHECK (char_length(btrim(reviewer_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_structured_project_tasks_reviewer_name_check
    CHECK (char_length(btrim(reviewer_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_structured_project_tasks_reviewer_source_check
    CHECK (reviewer_source IN ('assigned_by', 'lead_fallback')),
  CONSTRAINT peakos_structured_project_tasks_reviewer_separation_check
    CHECK (reviewer_uid <> assignee_uid),
  CONSTRAINT peakos_structured_project_tasks_sort_order_check
    CHECK (sort_order BETWEEN -1000000 AND 1000000),
  CONSTRAINT peakos_structured_project_tasks_version_check
    CHECK (version BETWEEN 1 AND 2147483647),
  CONSTRAINT peakos_structured_project_tasks_last_note_check
    CHECK (char_length(last_note) <= 4000),
  CONSTRAINT peakos_structured_project_tasks_creator_uid_check
    CHECK (char_length(btrim(created_by_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_structured_project_tasks_creator_name_check
    CHECK (char_length(btrim(created_by_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_structured_project_tasks_updated_check
    CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS peakos_structured_project_history (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  task_id UUID,
  action TEXT NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name_snapshot TEXT NOT NULL,
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  entity_version INTEGER NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_structured_project_history_project_fk
    FOREIGN KEY (workspace_id, project_id)
    REFERENCES peakos_structured_projects(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_history_actor_membership_fk
    FOREIGN KEY (workspace_id, actor_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_history_task_fk
    FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES peakos_structured_project_tasks(workspace_id, project_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_history_entity_type_check
    CHECK (entity_type IN ('project', 'member', 'medium_category', 'small_category', 'task')),
  CONSTRAINT peakos_structured_project_history_entity_id_check
    CHECK (char_length(btrim(entity_id)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_structured_project_history_task_entity_check
    CHECK ((entity_type = 'task' AND task_id IS NOT NULL) OR (entity_type <> 'task' AND task_id IS NULL)),
  CONSTRAINT peakos_structured_project_history_action_check
    CHECK (action ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT peakos_structured_project_history_actor_uid_check
    CHECK (char_length(btrim(actor_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_structured_project_history_actor_name_check
    CHECK (char_length(btrim(actor_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_structured_project_history_from_status_check
    CHECK (from_status = '' OR from_status IN ('active', 'completed', 'archived', 'todo', 'doing', 'review', 'revision', 'done')),
  CONSTRAINT peakos_structured_project_history_to_status_check
    CHECK (to_status = '' OR to_status IN ('active', 'completed', 'archived', 'todo', 'doing', 'review', 'revision', 'done')),
  CONSTRAINT peakos_structured_project_history_note_check
    CHECK (char_length(note) <= 4000),
  CONSTRAINT peakos_structured_project_history_version_check
    CHECK (entity_version BETWEEN 1 AND 2147483647),
  CONSTRAINT peakos_structured_project_history_metadata_check
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS peakos_structured_projects_listing_idx
  ON peakos_structured_projects(workspace_id, status, sort_order, created_at DESC, id);
CREATE INDEX IF NOT EXISTS peakos_structured_projects_lead_idx
  ON peakos_structured_projects(workspace_id, lead_uid, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS peakos_structured_project_members_user_idx
  ON peakos_structured_project_members(workspace_id, user_uid, active, project_id);
CREATE INDEX IF NOT EXISTS peakos_structured_project_members_listing_idx
  ON peakos_structured_project_members(workspace_id, project_id, active, sort_order, user_uid);
CREATE UNIQUE INDEX IF NOT EXISTS peakos_structured_project_members_one_active_lead_idx
  ON peakos_structured_project_members(workspace_id, project_id)
  WHERE active = TRUE AND role = 'lead';
CREATE INDEX IF NOT EXISTS peakos_structured_project_medium_listing_idx
  ON peakos_structured_project_medium_categories(workspace_id, project_id, active, sort_order, id);
CREATE INDEX IF NOT EXISTS peakos_structured_project_medium_manager_idx
  ON peakos_structured_project_medium_categories(workspace_id, project_id, manager_uid)
  WHERE active = TRUE AND manager_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS peakos_structured_project_small_listing_idx
  ON peakos_structured_project_small_categories(workspace_id, project_id, medium_category_id, active, sort_order, id);
CREATE INDEX IF NOT EXISTS peakos_structured_project_tasks_hierarchy_idx
  ON peakos_structured_project_tasks(workspace_id, project_id, medium_category_id, small_category_id, sort_order, id);
CREATE INDEX IF NOT EXISTS peakos_structured_project_tasks_assignee_idx
  ON peakos_structured_project_tasks(workspace_id, assignee_uid, status, due_date, updated_at DESC);
CREATE INDEX IF NOT EXISTS peakos_structured_project_tasks_reviewer_idx
  ON peakos_structured_project_tasks(workspace_id, reviewer_uid, status, review_requested_at)
  WHERE status = 'review';
CREATE INDEX IF NOT EXISTS peakos_structured_project_tasks_due_idx
  ON peakos_structured_project_tasks(workspace_id, status, due_date, project_id)
  WHERE status <> 'done';
CREATE INDEX IF NOT EXISTS peakos_structured_project_history_project_idx
  ON peakos_structured_project_history(workspace_id, project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS peakos_structured_project_history_task_idx
  ON peakos_structured_project_history(workspace_id, project_id, task_id, created_at DESC, id DESC)
  WHERE task_id IS NOT NULL;

CREATE OR REPLACE FUNCTION peakos_structured_project_assert_active_lead()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $active_lead$
DECLARE
  target_workspace_id TEXT;
  target_project_id UUID;
  target_lead_uid TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_workspace_id := OLD.workspace_id;
    IF TG_TABLE_NAME = 'peakos_structured_projects' THEN
      target_project_id := OLD.id;
    ELSE
      target_project_id := OLD.project_id;
    END IF;
  ELSE
    target_workspace_id := NEW.workspace_id;
    IF TG_TABLE_NAME = 'peakos_structured_projects' THEN
      target_project_id := NEW.id;
    ELSE
      target_project_id := NEW.project_id;
    END IF;
  END IF;

  SELECT lead_uid
    INTO target_lead_uid
    FROM peakos_structured_projects
   WHERE workspace_id = target_workspace_id
     AND id = target_project_id;

  -- A project deletion is not part of the runtime contract. If a DBA removes
  -- one after first removing its children, there is no surviving lead to test.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM peakos_structured_project_members
     WHERE workspace_id = target_workspace_id
       AND project_id = target_project_id
       AND user_uid = target_lead_uid
       AND role = 'lead'
       AND active = TRUE
  ) THEN
    RAISE EXCEPTION
      'structured project %/% must have its lead_uid as the one active lead member',
      target_workspace_id, target_project_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$active_lead$;

DROP TRIGGER IF EXISTS peakos_structured_projects_active_lead_guard
  ON peakos_structured_projects;
CREATE CONSTRAINT TRIGGER peakos_structured_projects_active_lead_guard
AFTER INSERT OR UPDATE ON peakos_structured_projects
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION peakos_structured_project_assert_active_lead();

DROP TRIGGER IF EXISTS peakos_structured_project_members_active_lead_guard
  ON peakos_structured_project_members;
CREATE CONSTRAINT TRIGGER peakos_structured_project_members_active_lead_guard
AFTER INSERT OR UPDATE OR DELETE ON peakos_structured_project_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION peakos_structured_project_assert_active_lead();

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

CREATE OR REPLACE FUNCTION peakos_structured_project_history_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $append_only$
BEGIN
  RAISE EXCEPTION 'peakos_structured_project_history is append-only'
    USING ERRCODE = '55000';
END
$append_only$;

DROP TRIGGER IF EXISTS peakos_structured_project_history_no_mutation
  ON peakos_structured_project_history;
CREATE TRIGGER peakos_structured_project_history_no_mutation
BEFORE UPDATE OR DELETE ON peakos_structured_project_history
FOR EACH ROW EXECUTE FUNCTION peakos_structured_project_history_append_only();

-- Runtime privileges are reset instead of trusting inherited/default ACLs.
-- This file is applied by an owner/DBA while the API normally connects as
-- calendar_user. Override in the same operator session with:
--   SET peakos.app_role = 'another_runtime_role';
-- The configured role must be a dedicated non-owner runtime role. If
-- calendar_user is absent, fail closed instead of granting to current_user.
DO $structured_project_runtime_grants$
DECLARE
  configured_role TEXT := NULLIF(current_setting('peakos.app_role', TRUE), '');
  application_role TEXT;
  mutable_table TEXT;
  privilege_name TEXT;
  function_signature TEXT;
BEGIN
  application_role := configured_role;
  IF application_role IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
      application_role := 'calendar_user';
    ELSE
      RAISE EXCEPTION
        'set peakos.app_role to the non-owner runtime role before applying PEAK OS structured projects migration'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role) THEN
    RAISE EXCEPTION 'PEAK OS application role % does not exist', application_role;
  END IF;

  FOREACH mutable_table IN ARRAY ARRAY[
    'peakos_structured_projects',
    'peakos_structured_project_members',
    'peakos_structured_project_medium_categories',
    'peakos_structured_project_small_categories',
    'peakos_structured_project_tasks'
  ] LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, %I',
      mutable_table,
      application_role
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO %I',
      mutable_table,
      application_role
    );
  END LOOP;
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE public.peakos_structured_project_history FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE public.peakos_structured_project_history TO %I',
    application_role
  );
  IF to_regclass('public.peakos_structured_project_history_id_seq') IS NOT NULL THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE public.peakos_structured_project_history_id_seq FROM PUBLIC, %I',
      application_role
    );
    EXECUTE format(
      'GRANT USAGE ON SEQUENCE public.peakos_structured_project_history_id_seq TO %I',
      application_role
    );
  END IF;

  FOREACH function_signature IN ARRAY ARRAY[
    'public.peakos_structured_project_assert_active_lead()',
    'public.peakos_structured_project_assert_active_medium_manager()',
    'public.peakos_structured_project_history_append_only()'
  ] LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, %I',
      function_signature,
      application_role
    );
  END LOOP;

  FOREACH mutable_table IN ARRAY ARRAY[
    'peakos_structured_projects',
    'peakos_structured_project_members',
    'peakos_structured_project_medium_categories',
    'peakos_structured_project_small_categories',
    'peakos_structured_project_tasks'
  ] LOOP
    FOREACH privilege_name IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE',
      'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] LOOP
      IF has_table_privilege(
        application_role,
        'public.' || mutable_table,
        privilege_name
      ) IS DISTINCT FROM (privilege_name IN ('SELECT', 'INSERT', 'UPDATE')) THEN
        RAISE EXCEPTION
          'runtime role % has an unexpected effective % privilege on %',
          application_role, privilege_name, mutable_table
          USING ERRCODE = '55000';
      END IF;
    END LOOP;
  END LOOP;

  FOREACH privilege_name IN ARRAY ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE',
    'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ] LOOP
    IF has_table_privilege(
      application_role,
      'public.peakos_structured_project_history',
      privilege_name
    ) IS DISTINCT FROM (privilege_name IN ('SELECT', 'INSERT')) THEN
      RAISE EXCEPTION
        'runtime role % has an unexpected effective % privilege on structured-project history',
        application_role, privilege_name
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF NOT has_sequence_privilege(
    application_role,
    'public.peakos_structured_project_history_id_seq',
    'USAGE'
  )
     OR has_sequence_privilege(
       application_role,
       'public.peakos_structured_project_history_id_seq',
       'SELECT'
     )
     OR has_sequence_privilege(
       application_role,
       'public.peakos_structured_project_history_id_seq',
       'UPDATE'
     ) THEN
    RAISE EXCEPTION
      'runtime role % has unsafe structured-project history sequence privileges',
      application_role
      USING ERRCODE = '55000';
  END IF;

  FOREACH function_signature IN ARRAY ARRAY[
    'public.peakos_structured_project_assert_active_lead()',
    'public.peakos_structured_project_assert_active_medium_manager()',
    'public.peakos_structured_project_history_append_only()'
  ] LOOP
    IF has_function_privilege(application_role, function_signature, 'EXECUTE') THEN
      RAISE EXCEPTION
        'runtime role % must not execute structured-project trigger function % directly',
        application_role, function_signature
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$structured_project_runtime_grants$;

COMMIT;
