-- Standalone PEAK OS personal todos.
--
-- This operator migration is schema-only. It deliberately does not read from
-- or copy any legacy collaboration record. Apply it with peakos.app_role set
-- to the non-owner runtime role (calendar_user is the safe default).

BEGIN;
SET LOCAL search_path = public, pg_catalog;

SELECT pg_advisory_xact_lock(hashtext('peakos-todos-v1'));

DO $todo_prerequisites$
BEGIN
  IF to_regclass('public.peakos_workspaces') IS NULL
     OR to_regclass('public.peakos_workspace_memberships') IS NULL THEN
    RAISE EXCEPTION 'workspace migration must be applied before PEAK OS todos'
      USING ERRCODE = '55000';
  END IF;
END
$todo_prerequisites$;

CREATE TABLE IF NOT EXISTS public.peakos_todos (
  workspace_id TEXT NOT NULL,
  id UUID NOT NULL,
  owner_uid TEXT NOT NULL,
  owner_name_snapshot TEXT NOT NULL,
  title TEXT NOT NULL,
  todo_date DATE NOT NULL,
  start_time TIME WITHOUT TIME ZONE,
  end_time TIME WITHOUT TIME ZONE,
  category TEXT NOT NULL DEFAULT '일반',
  memo TEXT NOT NULL DEFAULT '',
  done BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  last_action TEXT NOT NULL DEFAULT 'CREATE',
  last_changed_by_uid TEXT NOT NULL,
  last_changed_by_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT peakos_todos_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_todos_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.peakos_workspaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_todos_owner_membership_fk
    FOREIGN KEY (workspace_id, owner_uid)
    REFERENCES public.peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_todos_changer_membership_fk
    FOREIGN KEY (workspace_id, last_changed_by_uid)
    REFERENCES public.peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_todos_title_check
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 240),
  CONSTRAINT peakos_todos_owner_check
    CHECK (
      char_length(btrim(owner_uid)) BETWEEN 1 AND 200
      AND char_length(btrim(owner_name_snapshot)) BETWEEN 1 AND 160
      AND char_length(btrim(last_changed_by_uid)) BETWEEN 1 AND 200
      AND char_length(btrim(last_changed_by_name_snapshot)) BETWEEN 1 AND 160
    ),
  CONSTRAINT peakos_todos_category_check
    CHECK (char_length(btrim(category)) BETWEEN 1 AND 80),
  CONSTRAINT peakos_todos_memo_check CHECK (char_length(memo) <= 5000),
  CONSTRAINT peakos_todos_date_check
    CHECK (todo_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  CONSTRAINT peakos_todos_time_check
    CHECK (end_time IS NULL OR (start_time IS NOT NULL AND start_time < end_time)),
  CONSTRAINT peakos_todos_sort_order_check CHECK (sort_order BETWEEN 0 AND 1000000),
  CONSTRAINT peakos_todos_version_check CHECK (version BETWEEN 1 AND 2147483647),
  CONSTRAINT peakos_todos_action_check
    CHECK (last_action IN ('CREATE', 'UPDATE', 'REORDER', 'ARCHIVE')),
  CONSTRAINT peakos_todos_archive_check
    CHECK ((archived = FALSE AND archived_at IS NULL)
       OR (archived = TRUE AND archived_at IS NOT NULL)),
  CONSTRAINT peakos_todos_timestamp_check CHECK (created_at <= updated_at)
);

CREATE INDEX IF NOT EXISTS peakos_todos_owner_date_idx
  ON public.peakos_todos
    (workspace_id, owner_uid, todo_date, archived, sort_order, created_at, id);

CREATE TABLE IF NOT EXISTS public.peakos_todo_audit (
  id BIGSERIAL NOT NULL,
  workspace_id TEXT NOT NULL,
  todo_id UUID NOT NULL,
  action TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name_snapshot TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT peakos_todo_audit_pkey PRIMARY KEY (id),
  CONSTRAINT peakos_todo_audit_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.peakos_workspaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_todo_audit_todo_fk
    FOREIGN KEY (workspace_id, todo_id)
    REFERENCES public.peakos_todos(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_todo_audit_actor_membership_fk
    FOREIGN KEY (workspace_id, actor_uid)
    REFERENCES public.peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_todo_audit_action_check
    CHECK (action IN ('CREATE', 'UPDATE', 'REORDER', 'ARCHIVE')),
  CONSTRAINT peakos_todo_audit_version_check
    CHECK (entity_version BETWEEN 1 AND 2147483647),
  CONSTRAINT peakos_todo_audit_actor_check
    CHECK (
      char_length(btrim(actor_uid)) BETWEEN 1 AND 200
      AND char_length(btrim(actor_name_snapshot)) BETWEEN 1 AND 160
    ),
  CONSTRAINT peakos_todo_audit_shape_check
    CHECK ((action = 'CREATE' AND before_state IS NULL)
       OR (action <> 'CREATE' AND before_state IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS peakos_todo_audit_todo_idx
  ON public.peakos_todo_audit
    (workspace_id, todo_id, entity_version, id);

CREATE OR REPLACE FUNCTION public.peakos_todo_guard_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $todo_guard$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.owner_uid IS DISTINCT FROM OLD.owner_uid
     OR NEW.owner_name_snapshot IS DISTINCT FROM OLD.owner_name_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.archived = TRUE
     OR NEW.version <> OLD.version + 1
     OR NEW.last_action NOT IN ('UPDATE', 'REORDER', 'ARCHIVE') THEN
    RAISE EXCEPTION 'PEAK OS todo identity, archive state, or version is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.last_action = 'ARCHIVE' THEN
    IF OLD.archived = TRUE OR NEW.archived <> TRUE OR NEW.archived_at IS NULL
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.todo_date IS DISTINCT FROM OLD.todo_date
       OR NEW.start_time IS DISTINCT FROM OLD.start_time
       OR NEW.end_time IS DISTINCT FROM OLD.end_time
       OR NEW.category IS DISTINCT FROM OLD.category
       OR NEW.memo IS DISTINCT FROM OLD.memo
       OR NEW.done IS DISTINCT FROM OLD.done
       OR NEW.sort_order IS DISTINCT FROM OLD.sort_order THEN
      RAISE EXCEPTION 'PEAK OS todo archive transition is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.archived IS DISTINCT FROM FALSE OR NEW.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'PEAK OS todo content update cannot alter archive state'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.last_action = 'REORDER'
     AND (NEW.title IS DISTINCT FROM OLD.title
       OR NEW.todo_date IS DISTINCT FROM OLD.todo_date
       OR NEW.start_time IS DISTINCT FROM OLD.start_time
       OR NEW.end_time IS DISTINCT FROM OLD.end_time
       OR NEW.category IS DISTINCT FROM OLD.category
       OR NEW.memo IS DISTINCT FROM OLD.memo
       OR NEW.done IS DISTINCT FROM OLD.done) THEN
    RAISE EXCEPTION 'PEAK OS todo reorder can only change sort order'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$todo_guard$;

CREATE OR REPLACE FUNCTION public.peakos_todo_reject_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $todo_reject$
BEGIN
  RAISE EXCEPTION 'PEAK OS todo audit is append-only and todos are soft-archived'
    USING ERRCODE = '55000';
END
$todo_reject$;

CREATE OR REPLACE FUNCTION public.peakos_todo_write_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $todo_audit$
BEGIN
  INSERT INTO public.peakos_todo_audit
    (workspace_id, todo_id, action, entity_version, actor_uid,
     actor_name_snapshot, before_state, after_state, created_at)
  VALUES
    (NEW.workspace_id, NEW.id, NEW.last_action, NEW.version,
     NEW.last_changed_by_uid, NEW.last_changed_by_name_snapshot,
     CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
     to_jsonb(NEW), NOW());
  RETURN NEW;
END
$todo_audit$;

DROP TRIGGER IF EXISTS peakos_todos_guard_update ON public.peakos_todos;
CREATE TRIGGER peakos_todos_guard_update
BEFORE UPDATE ON public.peakos_todos
FOR EACH ROW EXECUTE FUNCTION public.peakos_todo_guard_update();

DROP TRIGGER IF EXISTS peakos_todos_no_delete ON public.peakos_todos;
CREATE TRIGGER peakos_todos_no_delete
BEFORE DELETE ON public.peakos_todos
FOR EACH ROW EXECUTE FUNCTION public.peakos_todo_reject_mutation();

DROP TRIGGER IF EXISTS peakos_todos_no_truncate ON public.peakos_todos;
CREATE TRIGGER peakos_todos_no_truncate
BEFORE TRUNCATE ON public.peakos_todos
FOR EACH STATEMENT EXECUTE FUNCTION public.peakos_todo_reject_mutation();

DROP TRIGGER IF EXISTS peakos_todos_write_audit ON public.peakos_todos;
CREATE TRIGGER peakos_todos_write_audit
AFTER INSERT OR UPDATE ON public.peakos_todos
FOR EACH ROW EXECUTE FUNCTION public.peakos_todo_write_audit();

DROP TRIGGER IF EXISTS peakos_todo_audit_no_mutation ON public.peakos_todo_audit;
CREATE TRIGGER peakos_todo_audit_no_mutation
BEFORE UPDATE OR DELETE ON public.peakos_todo_audit
FOR EACH ROW EXECUTE FUNCTION public.peakos_todo_reject_mutation();

DROP TRIGGER IF EXISTS peakos_todo_audit_no_truncate ON public.peakos_todo_audit;
CREATE TRIGGER peakos_todo_audit_no_truncate
BEFORE TRUNCATE ON public.peakos_todo_audit
FOR EACH STATEMENT EXECUTE FUNCTION public.peakos_todo_reject_mutation();

DO $todo_runtime_grants$
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
        'set peakos.app_role to the non-owner runtime role before applying PEAK OS todo migration'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role) THEN
    RAISE EXCEPTION 'PEAK OS application role % does not exist', application_role;
  END IF;

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE public.peakos_todos FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE ON TABLE public.peakos_todos TO %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE public.peakos_todo_audit FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT ON TABLE public.peakos_todo_audit TO %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON SEQUENCE public.peakos_todo_audit_id_seq FROM PUBLIC, %I',
    application_role
  );

  FOREACH function_signature IN ARRAY ARRAY[
    'public.peakos_todo_guard_update()',
    'public.peakos_todo_reject_mutation()',
    'public.peakos_todo_write_audit()'
  ]
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, %I',
      function_signature, application_role
    );
  END LOOP;

  FOREACH privilege_name IN ARRAY ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ]
  LOOP
    IF has_table_privilege(application_role, 'public.peakos_todos', privilege_name)
       IS DISTINCT FROM (privilege_name IN ('SELECT', 'INSERT', 'UPDATE')) THEN
      RAISE EXCEPTION 'runtime role % has unexpected % privilege on peakos_todos',
        application_role, privilege_name USING ERRCODE = '55000';
    END IF;
    IF has_table_privilege(application_role, 'public.peakos_todo_audit', privilege_name)
       IS DISTINCT FROM (privilege_name = 'SELECT') THEN
      RAISE EXCEPTION 'runtime role % has unexpected % privilege on peakos_todo_audit',
        application_role, privilege_name USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF has_sequence_privilege(application_role, 'public.peakos_todo_audit_id_seq', 'USAGE')
     OR has_sequence_privilege(application_role, 'public.peakos_todo_audit_id_seq', 'SELECT')
     OR has_sequence_privilege(application_role, 'public.peakos_todo_audit_id_seq', 'UPDATE') THEN
    RAISE EXCEPTION 'runtime role % must not access the todo audit sequence', application_role
      USING ERRCODE = '55000';
  END IF;

  FOREACH function_signature IN ARRAY ARRAY[
    'public.peakos_todo_guard_update()',
    'public.peakos_todo_reject_mutation()',
    'public.peakos_todo_write_audit()'
  ]
  LOOP
    IF has_function_privilege(application_role, function_signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'runtime role % must not execute todo trigger function % directly',
        application_role, function_signature USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$todo_runtime_grants$;

COMMIT;
