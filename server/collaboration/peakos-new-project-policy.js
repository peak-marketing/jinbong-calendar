'use strict';

const NEW_PROJECT_TABLES = Object.freeze({
  projects: 'peakos_structured_projects',
  members: 'peakos_structured_project_members',
  mediumCategories: 'peakos_structured_project_medium_categories',
  smallCategories: 'peakos_structured_project_small_categories',
  tasks: 'peakos_structured_project_tasks',
  history: 'peakos_structured_project_history',
  meetings: 'peakos_structured_project_meetings',
  meetingAttendees: 'peakos_structured_project_meeting_attendees',
});

function freezeDefinitionMap(definitions) {
  return Object.freeze(Object.fromEntries(Object.entries(definitions).map(([table, entries]) => [
    table,
    Object.freeze(Object.fromEntries(Object.entries(entries).map(([name, definition]) => [
      name,
      Object.freeze(definition),
    ]))),
  ])));
}

// [PostgreSQL type, NOT NULL, canonical default expression or null]. Readiness
// checks these definitions through pg_catalog so a same-named but weakened
// column cannot make the API start.
const NEW_PROJECT_REQUIRED_COLUMN_DEFINITIONS = freezeDefinitionMap({
  [NEW_PROJECT_TABLES.projects]: {
    workspace_id: ['text', true, null], id: ['uuid', true, 'gen_random_uuid()'],
    name: ['text', true, null], description: ['text', true, "''::text"],
    lead_uid: ['text', true, null], lead_name_snapshot: ['text', true, null],
    status: ['text', true, "'active'::text"], sort_order: ['integer', true, '0'],
    version: ['integer', true, '1'], created_by_uid: ['text', true, null],
    created_by_name_snapshot: ['text', true, null],
    created_at: ['timestamp with time zone', true, 'now()'],
    updated_at: ['timestamp with time zone', true, 'now()'],
  },
  [NEW_PROJECT_TABLES.members]: {
    workspace_id: ['text', true, null], project_id: ['uuid', true, null],
    user_uid: ['text', true, null], user_name_snapshot: ['text', true, null],
    role: ['text', true, "'member'::text"], active: ['boolean', true, 'true'],
    sort_order: ['integer', true, '0'], version: ['integer', true, '1'],
    added_by_uid: ['text', true, null], added_by_name_snapshot: ['text', true, null],
    created_at: ['timestamp with time zone', true, 'now()'],
    updated_at: ['timestamp with time zone', true, 'now()'],
  },
  [NEW_PROJECT_TABLES.mediumCategories]: {
    workspace_id: ['text', true, null], project_id: ['uuid', true, null],
    id: ['uuid', true, 'gen_random_uuid()'], name: ['text', true, null],
    description: ['text', true, "''::text"], manager_uid: ['text', false, null],
    manager_name_snapshot: ['text', false, null], active: ['boolean', true, 'true'],
    sort_order: ['integer', true, '0'], version: ['integer', true, '1'],
    created_by_uid: ['text', true, null], created_by_name_snapshot: ['text', true, null],
    created_at: ['timestamp with time zone', true, 'now()'],
    updated_at: ['timestamp with time zone', true, 'now()'],
  },
  [NEW_PROJECT_TABLES.smallCategories]: {
    workspace_id: ['text', true, null], project_id: ['uuid', true, null],
    medium_category_id: ['uuid', true, null], id: ['uuid', true, 'gen_random_uuid()'],
    name: ['text', true, null], description: ['text', true, "''::text"],
    active: ['boolean', true, 'true'], sort_order: ['integer', true, '0'],
    version: ['integer', true, '1'], created_by_uid: ['text', true, null],
    created_by_name_snapshot: ['text', true, null],
    created_at: ['timestamp with time zone', true, 'now()'],
    updated_at: ['timestamp with time zone', true, 'now()'],
  },
  [NEW_PROJECT_TABLES.meetings]: {
    workspace_id: ['text', true, null], project_id: ['uuid', true, null],
    id: ['uuid', true, 'gen_random_uuid()'], medium_category_id: ['uuid', true, null],
    small_category_id: ['uuid', false, null], title: ['text', true, null],
    description: ['text', true, "''::text"], location: ['text', true, "''::text"],
    start_date: ['date', true, null], end_date: ['date', true, null],
    start_time: ['text', true, "''::text"], end_time: ['text', true, "''::text"],
    organizer_uid: ['text', true, null], organizer_name_snapshot: ['text', true, null],
    status: ['text', true, "'scheduled'::text"], event_id: ['text', false, null],
    version: ['integer', true, '1'], created_by_uid: ['text', true, null],
    created_by_name_snapshot: ['text', true, null],
    created_at: ['timestamp with time zone', true, 'now()'],
    updated_at: ['timestamp with time zone', true, 'now()'],
  },
  [NEW_PROJECT_TABLES.meetingAttendees]: {
    workspace_id: ['text', true, null], project_id: ['uuid', true, null],
    meeting_id: ['uuid', true, null], user_uid: ['text', true, null],
    user_name_snapshot: ['text', true, null], active: ['boolean', true, 'true'],
    created_at: ['timestamp with time zone', true, 'now()'],
  },
  [NEW_PROJECT_TABLES.tasks]: {
    workspace_id: ['text', true, null], project_id: ['uuid', true, null],
    medium_category_id: ['uuid', true, null], small_category_id: ['uuid', true, null],
    id: ['uuid', true, 'gen_random_uuid()'], title: ['text', true, null],
    description: ['text', true, "''::text"], status: ['text', true, "'todo'::text"],
    assignee_uid: ['text', true, null], assignee_name_snapshot: ['text', true, null],
    assigned_by_uid: ['text', true, null], assigned_by_name_snapshot: ['text', true, null],
    reviewer_uid: ['text', true, null], reviewer_name_snapshot: ['text', true, null],
    reviewer_source: ['text', true, null], due_date: ['date', false, null],
    sort_order: ['integer', true, '0'], version: ['integer', true, '1'],
    last_note: ['text', true, "''::text"],
    review_requested_at: ['timestamp with time zone', false, null],
    reviewed_at: ['timestamp with time zone', false, null],
    status_changed_at: ['timestamp with time zone', true, 'now()'],
    created_by_uid: ['text', true, null], created_by_name_snapshot: ['text', true, null],
    created_at: ['timestamp with time zone', true, 'now()'],
    updated_at: ['timestamp with time zone', true, 'now()'],
  },
  [NEW_PROJECT_TABLES.history]: {
    id: ['bigint', true, "nextval('peakos_structured_project_history_id_seq'::regclass)"],
    workspace_id: ['text', true, null], project_id: ['uuid', true, null],
    entity_type: ['text', true, null], entity_id: ['text', true, null],
    task_id: ['uuid', false, null], action: ['text', true, null],
    actor_uid: ['text', true, null], actor_name_snapshot: ['text', true, null],
    from_status: ['text', true, "''::text"], to_status: ['text', true, "''::text"],
    note: ['text', true, "''::text"], entity_version: ['integer', true, null],
    metadata: ['jsonb', true, "'{}'::jsonb"],
    created_at: ['timestamp with time zone', true, 'now()'],
  },
});

const NEW_PROJECT_REQUIRED_COLUMNS = Object.freeze(Object.fromEntries(
  Object.entries(NEW_PROJECT_REQUIRED_COLUMN_DEFINITIONS).map(([table, columns]) => [
    table,
    Object.freeze(Object.keys(columns)),
  ]),
));

// [constraint name, pg_constraint.contype, canonical pg_get_constraintdef].
// Every tenant boundary and the assignedBy/reviewer chain is definition-checked,
// not merely checked by a reusable name.
const NEW_PROJECT_REQUIRED_CONSTRAINT_DEFINITIONS = Object.freeze({
  [NEW_PROJECT_TABLES.projects]: Object.freeze([
    ['peakos_structured_projects_pkey', 'p', 'PRIMARY KEY (workspace_id, id)'],
    ['peakos_structured_projects_workspace_fk', 'f', 'FOREIGN KEY (workspace_id) REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_projects_lead_membership_fk', 'f', 'FOREIGN KEY (workspace_id, lead_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_projects_creator_membership_fk', 'f', 'FOREIGN KEY (workspace_id, created_by_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_projects_lead_project_member_fk', 'f', 'FOREIGN KEY (workspace_id, id, lead_uid) REFERENCES peakos_structured_project_members(workspace_id, project_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED'],
    ['peakos_structured_projects_status_check', 'c', "CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'archived'::text])))"],
    ['peakos_structured_projects_version_check', 'c', 'CHECK (((version >= 1) AND (version <= 2147483647)))'],
  ]),
  [NEW_PROJECT_TABLES.members]: Object.freeze([
    ['peakos_structured_project_members_pkey', 'p', 'PRIMARY KEY (workspace_id, project_id, user_uid)'],
    ['peakos_structured_project_members_project_fk', 'f', 'FOREIGN KEY (workspace_id, project_id) REFERENCES peakos_structured_projects(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_members_user_membership_fk', 'f', 'FOREIGN KEY (workspace_id, user_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_members_adder_membership_fk', 'f', 'FOREIGN KEY (workspace_id, added_by_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_members_role_check', 'c', "CHECK ((role = ANY (ARRAY['lead'::text, 'member'::text])))"],
    ['peakos_structured_project_members_version_check', 'c', 'CHECK (((version >= 1) AND (version <= 2147483647)))'],
  ]),
  [NEW_PROJECT_TABLES.mediumCategories]: Object.freeze([
    ['peakos_structured_project_medium_categories_pkey', 'p', 'PRIMARY KEY (workspace_id, project_id, id)'],
    ['peakos_structured_project_medium_project_fk', 'f', 'FOREIGN KEY (workspace_id, project_id) REFERENCES peakos_structured_projects(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_medium_creator_membership_fk', 'f', 'FOREIGN KEY (workspace_id, created_by_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_medium_manager_fields_check', 'c', 'CHECK ((((manager_uid IS NULL) AND (manager_name_snapshot IS NULL)) OR ((manager_uid IS NOT NULL) AND ((char_length(btrim(manager_uid)) >= 1) AND (char_length(btrim(manager_uid)) <= 200)) AND (manager_name_snapshot IS NOT NULL) AND ((char_length(btrim(manager_name_snapshot)) >= 1) AND (char_length(btrim(manager_name_snapshot)) <= 160)))))'],
    ['peakos_structured_project_medium_manager_fk', 'f', 'FOREIGN KEY (workspace_id, project_id, manager_uid) REFERENCES peakos_structured_project_members(workspace_id, project_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED'],
    ['peakos_structured_project_medium_version_check', 'c', 'CHECK (((version >= 1) AND (version <= 2147483647)))'],
  ]),
  [NEW_PROJECT_TABLES.smallCategories]: Object.freeze([
    ['peakos_structured_project_small_categories_pkey', 'p', 'PRIMARY KEY (workspace_id, project_id, id)'],
    ['peakos_structured_project_sma_workspace_id_project_id_mediu_key', 'u', 'UNIQUE (workspace_id, project_id, medium_category_id, id)'],
    ['peakos_structured_project_small_project_fk', 'f', 'FOREIGN KEY (workspace_id, project_id) REFERENCES peakos_structured_projects(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_small_medium_fk', 'f', 'FOREIGN KEY (workspace_id, project_id, medium_category_id) REFERENCES peakos_structured_project_medium_categories(workspace_id, project_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_small_creator_membership_fk', 'f', 'FOREIGN KEY (workspace_id, created_by_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_small_version_check', 'c', 'CHECK (((version >= 1) AND (version <= 2147483647)))'],
  ]),
  [NEW_PROJECT_TABLES.tasks]: Object.freeze([
    ['peakos_structured_project_tasks_pkey', 'p', 'PRIMARY KEY (workspace_id, project_id, id)'],
    ['peakos_structured_project_tasks_project_fk', 'f', 'FOREIGN KEY (workspace_id, project_id) REFERENCES peakos_structured_projects(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_tasks_medium_fk', 'f', 'FOREIGN KEY (workspace_id, project_id, medium_category_id) REFERENCES peakos_structured_project_medium_categories(workspace_id, project_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_tasks_small_hierarchy_fk', 'f', 'FOREIGN KEY (workspace_id, project_id, medium_category_id, small_category_id) REFERENCES peakos_structured_project_small_categories(workspace_id, project_id, medium_category_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_tasks_assignee_fk', 'f', 'FOREIGN KEY (workspace_id, project_id, assignee_uid) REFERENCES peakos_structured_project_members(workspace_id, project_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_tasks_assigner_membership_fk', 'f', 'FOREIGN KEY (workspace_id, assigned_by_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_tasks_reviewer_membership_fk', 'f', 'FOREIGN KEY (workspace_id, reviewer_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_tasks_creator_membership_fk', 'f', 'FOREIGN KEY (workspace_id, created_by_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_tasks_status_check', 'c', "CHECK ((status = ANY (ARRAY['todo'::text, 'acknowledged'::text, 'doing'::text, 'review'::text, 'revision'::text, 'done'::text])))"],
    ['peakos_structured_project_tasks_reviewer_source_check', 'c', "CHECK ((reviewer_source = ANY (ARRAY['assigned_by'::text, 'lead_fallback'::text, 'explicit'::text])))"],
    ['peakos_structured_project_tasks_reviewer_separation_check', 'c', 'CHECK ((reviewer_uid <> assignee_uid))'],
    ['peakos_structured_project_tasks_version_check', 'c', 'CHECK (((version >= 1) AND (version <= 2147483647)))'],
  ]),
  [NEW_PROJECT_TABLES.meetings]: Object.freeze([
    ['peakos_structured_project_meetings_pkey', 'p', 'PRIMARY KEY (workspace_id, project_id, id)'],
    ['peakos_structured_project_meetings_project_fk', 'f', 'FOREIGN KEY (workspace_id, project_id) REFERENCES peakos_structured_projects(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_meetings_medium_fk', 'f', 'FOREIGN KEY (workspace_id, project_id, medium_category_id) REFERENCES peakos_structured_project_medium_categories(workspace_id, project_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_meetings_small_hierarchy_fk', 'f', 'FOREIGN KEY (workspace_id, project_id, medium_category_id, small_category_id) REFERENCES peakos_structured_project_small_categories(workspace_id, project_id, medium_category_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_meetings_organizer_fk', 'f', 'FOREIGN KEY (workspace_id, project_id, organizer_uid) REFERENCES peakos_structured_project_members(workspace_id, project_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_meetings_creator_membership_fk', 'f', 'FOREIGN KEY (workspace_id, created_by_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_meetings_status_check', 'c', "CHECK ((status = ANY (ARRAY['scheduled'::text, 'done'::text, 'cancelled'::text])))"],
    ['peakos_structured_project_meetings_title_check', 'c', "CHECK (((btrim(title) <> ''::text) AND (length(title) <= 180)))"],
    ['peakos_structured_project_meetings_span_check', 'c', 'CHECK ((end_date >= start_date))'],
    ['peakos_structured_project_meetings_start_time_check', 'c', "CHECK (((start_time = ''::text) OR (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text)))"],
    ['peakos_structured_project_meetings_end_time_check', 'c', "CHECK (((end_time = ''::text) OR ((start_time <> ''::text) AND (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text))))"],
    ['peakos_structured_project_meetings_time_order_check', 'c', "CHECK (((end_time = ''::text) OR (end_date > start_date) OR (end_time > start_time)))"],
    ['peakos_structured_project_meetings_version_check', 'c', 'CHECK (((version >= 1) AND (version <= 2147483647)))'],
  ]),
  [NEW_PROJECT_TABLES.meetingAttendees]: Object.freeze([
    ['peakos_structured_project_meeting_attendees_pkey', 'p', 'PRIMARY KEY (workspace_id, project_id, meeting_id, user_uid)'],
    ['peakos_structured_project_meeting_attendees_meeting_fk', 'f', 'FOREIGN KEY (workspace_id, project_id, meeting_id) REFERENCES peakos_structured_project_meetings(workspace_id, project_id, id) ON UPDATE RESTRICT ON DELETE CASCADE'],
    ['peakos_structured_project_meeting_attendees_member_fk', 'f', 'FOREIGN KEY (workspace_id, project_id, user_uid) REFERENCES peakos_structured_project_members(workspace_id, project_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
  ]),
  [NEW_PROJECT_TABLES.history]: Object.freeze([
    ['peakos_structured_project_history_pkey', 'p', 'PRIMARY KEY (id)'],
    ['peakos_structured_project_history_project_fk', 'f', 'FOREIGN KEY (workspace_id, project_id) REFERENCES peakos_structured_projects(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_history_actor_membership_fk', 'f', 'FOREIGN KEY (workspace_id, actor_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_history_task_fk', 'f', 'FOREIGN KEY (workspace_id, project_id, task_id) REFERENCES peakos_structured_project_tasks(workspace_id, project_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    ['peakos_structured_project_history_task_entity_check', 'c', "CHECK ((((entity_type = 'task'::text) AND (task_id IS NOT NULL)) OR ((entity_type <> 'task'::text) AND (task_id IS NULL))))"],
    ['peakos_structured_project_history_action_check', 'c', "CHECK ((action ~ '^[a-z][a-z0-9_]{0,63}$'::text))"],
    ['peakos_structured_project_history_version_check', 'c', 'CHECK (((entity_version >= 1) AND (entity_version <= 2147483647)))'],
    ['peakos_structured_project_history_metadata_check', 'c', "CHECK ((jsonb_typeof(metadata) = 'object'::text))"],
  ]),
});

const NEW_PROJECT_REQUIRED_CONSTRAINTS = Object.freeze(Object.fromEntries(
  Object.entries(NEW_PROJECT_REQUIRED_CONSTRAINT_DEFINITIONS).map(([table, constraints]) => [
    table,
    Object.freeze(constraints.map(([name]) => name)),
  ]),
));

const ACTIVE_LEAD_FUNCTION_SOURCE = `
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
`.trim();

const ACTIVE_MEDIUM_MANAGER_FUNCTION_SOURCE = `
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
`.trim();

const HISTORY_APPEND_ONLY_FUNCTION_SOURCE = `
BEGIN
  RAISE EXCEPTION 'peakos_structured_project_history is append-only'
    USING ERRCODE = '55000';
END
`.trim();

const NEW_PROJECT_REQUIRED_FUNCTIONS = Object.freeze([
  Object.freeze(['peakos_structured_project_assert_active_lead', ACTIVE_LEAD_FUNCTION_SOURCE]),
  Object.freeze(['peakos_structured_project_assert_active_medium_manager', ACTIVE_MEDIUM_MANAGER_FUNCTION_SOURCE]),
  Object.freeze(['peakos_structured_project_history_append_only', HISTORY_APPEND_ONLY_FUNCTION_SOURCE]),
]);

// [table, trigger, tgtype, enabled, deferrable, initially deferred, function,
// canonical pg_get_triggerdef]. tgtype alone does not detect UPDATE OF or WHEN
// narrowing, so readiness also checks tgattr, tgqual, arguments and definition.
const NEW_PROJECT_REQUIRED_TRIGGERS = Object.freeze([
  Object.freeze([
    NEW_PROJECT_TABLES.projects,
    'peakos_structured_projects_active_lead_guard', 21, 'O', true, true,
    'peakos_structured_project_assert_active_lead',
    'CREATE CONSTRAINT TRIGGER peakos_structured_projects_active_lead_guard AFTER INSERT OR UPDATE ON public.peakos_structured_projects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION peakos_structured_project_assert_active_lead()',
  ]),
  Object.freeze([
    NEW_PROJECT_TABLES.members,
    'peakos_structured_project_members_active_lead_guard', 29, 'O', true, true,
    'peakos_structured_project_assert_active_lead',
    'CREATE CONSTRAINT TRIGGER peakos_structured_project_members_active_lead_guard AFTER INSERT OR DELETE OR UPDATE ON public.peakos_structured_project_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION peakos_structured_project_assert_active_lead()',
  ]),
  Object.freeze([
    NEW_PROJECT_TABLES.mediumCategories,
    'peakos_structured_project_medium_manager_guard', 21, 'O', true, true,
    'peakos_structured_project_assert_active_medium_manager',
    'CREATE CONSTRAINT TRIGGER peakos_structured_project_medium_manager_guard AFTER INSERT OR UPDATE ON public.peakos_structured_project_medium_categories DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION peakos_structured_project_assert_active_medium_manager()',
  ]),
  Object.freeze([
    NEW_PROJECT_TABLES.members,
    'peakos_structured_project_members_medium_manager_guard', 29, 'O', true, true,
    'peakos_structured_project_assert_active_medium_manager',
    'CREATE CONSTRAINT TRIGGER peakos_structured_project_members_medium_manager_guard AFTER INSERT OR DELETE OR UPDATE ON public.peakos_structured_project_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION peakos_structured_project_assert_active_medium_manager()',
  ]),
  Object.freeze([
    NEW_PROJECT_TABLES.history,
    'peakos_structured_project_history_no_mutation', 27, 'O', false, false,
    'peakos_structured_project_history_append_only',
    'CREATE TRIGGER peakos_structured_project_history_no_mutation BEFORE DELETE OR UPDATE ON public.peakos_structured_project_history FOR EACH ROW EXECUTE FUNCTION peakos_structured_project_history_append_only()',
  ]),
]);

// [table, index, unique, key columns, indoption values, canonical predicate].
const NEW_PROJECT_REQUIRED_INDEXES = Object.freeze([
  Object.freeze([NEW_PROJECT_TABLES.projects, 'peakos_structured_projects_listing_idx', false, 'workspace_id,status,sort_order,created_at,id', '0,0,0,3,0', '']),
  Object.freeze([NEW_PROJECT_TABLES.projects, 'peakos_structured_projects_lead_idx', false, 'workspace_id,lead_uid,status,updated_at', '0,0,0,3', '']),
  Object.freeze([NEW_PROJECT_TABLES.members, 'peakos_structured_project_members_user_idx', false, 'workspace_id,user_uid,active,project_id', '0,0,0,0', '']),
  Object.freeze([NEW_PROJECT_TABLES.members, 'peakos_structured_project_members_listing_idx', false, 'workspace_id,project_id,active,sort_order,user_uid', '0,0,0,0,0', '']),
  Object.freeze([NEW_PROJECT_TABLES.members, 'peakos_structured_project_members_one_active_lead_idx', true, 'workspace_id,project_id', '0,0', "((active = true) AND (role = 'lead'::text))"]),
  Object.freeze([NEW_PROJECT_TABLES.mediumCategories, 'peakos_structured_project_medium_listing_idx', false, 'workspace_id,project_id,active,sort_order,id', '0,0,0,0,0', '']),
  Object.freeze([NEW_PROJECT_TABLES.mediumCategories, 'peakos_structured_project_medium_manager_idx', false, 'workspace_id,project_id,manager_uid', '0,0,0', '((active = true) AND (manager_uid IS NOT NULL))']),
  Object.freeze([NEW_PROJECT_TABLES.smallCategories, 'peakos_structured_project_small_listing_idx', false, 'workspace_id,project_id,medium_category_id,active,sort_order,id', '0,0,0,0,0,0', '']),
  Object.freeze([NEW_PROJECT_TABLES.tasks, 'peakos_structured_project_tasks_hierarchy_idx', false, 'workspace_id,project_id,medium_category_id,small_category_id,sort_order,id', '0,0,0,0,0,0', '']),
  Object.freeze([NEW_PROJECT_TABLES.tasks, 'peakos_structured_project_tasks_assignee_idx', false, 'workspace_id,assignee_uid,status,due_date,updated_at', '0,0,0,0,3', '']),
  Object.freeze([NEW_PROJECT_TABLES.tasks, 'peakos_structured_project_tasks_reviewer_idx', false, 'workspace_id,reviewer_uid,status,review_requested_at', '0,0,0,0', "(status = 'review'::text)"]),
  Object.freeze([NEW_PROJECT_TABLES.tasks, 'peakos_structured_project_tasks_due_idx', false, 'workspace_id,status,due_date,project_id', '0,0,0,0', "(status <> 'done'::text)"]),
  Object.freeze([NEW_PROJECT_TABLES.history, 'peakos_structured_project_history_project_idx', false, 'workspace_id,project_id,created_at,id', '0,0,3,3', '']),
  Object.freeze([NEW_PROJECT_TABLES.history, 'peakos_structured_project_history_task_idx', false, 'workspace_id,project_id,task_id,created_at,id', '0,0,0,3,3', '(task_id IS NOT NULL)']),
]);

const NEW_PROJECT_TABLE_PRIVILEGES = Object.freeze(Object.fromEntries(
  Object.values(NEW_PROJECT_TABLES).map(table => [
    table,
    Object.freeze({
      SELECT: true,
      INSERT: true,
      UPDATE: table !== NEW_PROJECT_TABLES.history,
      DELETE: false,
      TRUNCATE: false,
      REFERENCES: false,
      TRIGGER: false,
    }),
  ]),
));

const NEW_PROJECT_REQUIRED_TABLES = Object.freeze(Object.values(NEW_PROJECT_TABLES));
const NEW_PROJECT_MIGRATION_FILE = '20260811_peakos_structured_projects.sql 및 20260811_peakos_structured_projects_medium_managers.sql';

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const columnRows = Object.entries(NEW_PROJECT_REQUIRED_COLUMN_DEFINITIONS).flatMap(([table, columns]) => (
  Object.entries(columns).map(([column, [type, notNull, defaultExpression]]) => (
    `(${sqlString(table)},${sqlString(column)},${sqlString(type)},${notNull ? 'TRUE' : 'FALSE'},${defaultExpression === null ? 'NULL' : sqlString(defaultExpression)})`
  ))
));
const constraintRows = Object.entries(NEW_PROJECT_REQUIRED_CONSTRAINT_DEFINITIONS)
  .flatMap(([table, constraints]) => constraints.map(([name, type, definition]) => (
    `(${sqlString(table)},${sqlString(name)},${sqlString(type)},${sqlString(definition)})`
  )));
const triggerRows = NEW_PROJECT_REQUIRED_TRIGGERS.map(([
  table, name, triggerType, enabled, deferrable, initiallyDeferred, functionName, definition,
]) => (
  `(${sqlString(table)},${sqlString(name)},${triggerType},${sqlString(enabled)},${deferrable ? 'TRUE' : 'FALSE'},${initiallyDeferred ? 'TRUE' : 'FALSE'},${sqlString(functionName)},${sqlString(definition)})`
));
const functionRows = NEW_PROJECT_REQUIRED_FUNCTIONS.map(([name, source]) => (
  `(${sqlString(name)},${sqlString(source)})`
));
const indexRows = NEW_PROJECT_REQUIRED_INDEXES.map(([
  table, name, unique, columns, options, predicate,
]) => (
  `(${sqlString(table)},${sqlString(name)},${unique ? 'TRUE' : 'FALSE'},${sqlString(columns)},${sqlString(options)},${sqlString(predicate)})`
));
const privilegeRows = Object.entries(NEW_PROJECT_TABLE_PRIVILEGES)
  .flatMap(([table, privileges]) => Object.entries(privileges).map(([privilege, expected]) => (
    `(${sqlString(table)},${sqlString(privilege)},${expected ? 'TRUE' : 'FALSE'})`
  )));

// Startup code must remain SELECT-only. It validates the effective application
// role (current_user), never the operator-session peakos.app_role hint.
const NEW_PROJECT_SCHEMA_READINESS_SQL = `
WITH required_columns(table_name, column_name, data_type, is_not_null, default_expression) AS (
  VALUES ${columnRows.join(',\n    ')}
), required_constraints(table_name, constraint_name, constraint_type, definition) AS (
  VALUES ${constraintRows.join(',\n    ')}
), required_triggers(table_name, trigger_name, trigger_type, enabled_state, is_deferrable, is_initially_deferred, function_name, definition) AS (
  VALUES ${triggerRows.join(',\n    ')}
), required_functions(function_name, function_source) AS (
  VALUES ${functionRows.join(',\n    ')}
), required_indexes(table_name, index_name, is_unique, key_columns, key_options, predicate) AS (
  VALUES ${indexRows.join(',\n    ')}
), required_table_privileges(table_name, privilege_name, expected) AS (
  VALUES ${privilegeRows.join(',\n    ')}
), runtime_role AS (
  SELECT current_user AS role_name, role_row.oid AS role_oid
    FROM pg_roles role_row
   WHERE role_row.rolname = current_user
), missing AS (
  SELECT 'column-definition:' || expected.table_name || '.' || expected.column_name AS requirement
    FROM required_columns expected
    LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
    LEFT JOIN pg_class relation
      ON relation.relnamespace = namespace.oid
     AND relation.relname = expected.table_name
     AND relation.relkind IN ('r', 'p')
    LEFT JOIN pg_attribute actual
      ON actual.attrelid = relation.oid
     AND actual.attname = expected.column_name
     AND actual.attnum > 0
     AND NOT actual.attisdropped
    LEFT JOIN pg_attrdef default_row
      ON default_row.adrelid = actual.attrelid
     AND default_row.adnum = actual.attnum
   WHERE actual.attnum IS NULL
      OR format_type(actual.atttypid, actual.atttypmod) <> expected.data_type
      OR actual.attnotnull <> expected.is_not_null
      OR actual.attidentity <> ''
      OR actual.attgenerated <> ''
      OR COALESCE(pg_get_expr(default_row.adbin, default_row.adrelid), '')
         <> COALESCE(expected.default_expression, '')
  UNION ALL
  SELECT 'constraint-definition:' || expected.table_name || '.' || expected.constraint_name
    FROM required_constraints expected
    LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
    LEFT JOIN pg_class relation
      ON relation.relnamespace = namespace.oid
     AND relation.relname = expected.table_name
     AND relation.relkind IN ('r', 'p')
    LEFT JOIN pg_constraint actual
      ON actual.conrelid = relation.oid
     AND actual.conname = expected.constraint_name
   WHERE actual.oid IS NULL
      OR actual.contype::text <> expected.constraint_type
      OR actual.convalidated IS NOT TRUE
      OR regexp_replace(btrim(pg_get_constraintdef(actual.oid)), '\\s+', ' ', 'g')
         <> regexp_replace(btrim(expected.definition), '\\s+', ' ', 'g')
  UNION ALL
  SELECT 'trigger-definition:' || expected.table_name || '.' || expected.trigger_name
    FROM required_triggers expected
    LEFT JOIN pg_namespace table_namespace ON table_namespace.nspname = 'public'
    LEFT JOIN pg_class relation
      ON relation.relnamespace = table_namespace.oid
     AND relation.relname = expected.table_name
     AND relation.relkind IN ('r', 'p')
    LEFT JOIN pg_trigger actual
      ON actual.tgrelid = relation.oid
     AND actual.tgname = expected.trigger_name
     AND NOT actual.tgisinternal
    LEFT JOIN pg_proc trigger_function ON trigger_function.oid = actual.tgfoid
    LEFT JOIN pg_namespace function_namespace ON function_namespace.oid = trigger_function.pronamespace
   WHERE actual.oid IS NULL
      OR actual.tgtype::integer <> expected.trigger_type
      OR actual.tgenabled::text <> expected.enabled_state
      OR actual.tgdeferrable <> expected.is_deferrable
      OR actual.tginitdeferred <> expected.is_initially_deferred
      OR actual.tgqual IS NOT NULL
      OR actual.tgattr::text <> ''
      OR actual.tgnargs <> 0
      OR octet_length(actual.tgargs) <> 0
      OR function_namespace.nspname <> 'public'
      OR trigger_function.proname <> expected.function_name
      OR regexp_replace(btrim(pg_get_triggerdef(actual.oid)), '\\s+', ' ', 'g')
         <> regexp_replace(btrim(expected.definition), '\\s+', ' ', 'g')
  UNION ALL
  SELECT 'function-definition:' || expected.function_name
    FROM required_functions expected
    LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
    LEFT JOIN pg_proc actual
      ON actual.pronamespace = namespace.oid
     AND actual.proname = expected.function_name
     AND actual.pronargs = 0
    LEFT JOIN pg_language language ON language.oid = actual.prolang
   WHERE actual.oid IS NULL
      OR actual.prorettype <> 'trigger'::regtype
      OR actual.prokind <> 'f'
      OR actual.provolatile <> 'v'
      OR actual.prosecdef IS NOT FALSE
      OR actual.proleakproof IS NOT FALSE
      OR actual.proparallel <> 'u'
      OR language.lanname <> 'plpgsql'
      OR actual.proconfig IS NOT NULL
      OR btrim(regexp_replace(actual.prosrc, '\\s+', ' ', 'g'))
         <> btrim(regexp_replace(expected.function_source, '\\s+', ' ', 'g'))
  UNION ALL
  SELECT 'index-definition:' || expected.table_name || '.' || expected.index_name
    FROM required_indexes expected
    LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
    LEFT JOIN pg_class table_relation
      ON table_relation.relnamespace = namespace.oid
     AND table_relation.relname = expected.table_name
     AND table_relation.relkind IN ('r', 'p')
    LEFT JOIN pg_class index_relation
      ON index_relation.relnamespace = namespace.oid
     AND index_relation.relname = expected.index_name
     AND index_relation.relkind = 'i'
    LEFT JOIN pg_index actual
      ON actual.indexrelid = index_relation.oid
     AND actual.indrelid = table_relation.oid
   WHERE actual.indexrelid IS NULL
      OR actual.indisunique <> expected.is_unique
      OR actual.indisvalid IS NOT TRUE
      OR actual.indisready IS NOT TRUE
      OR actual.indislive IS NOT TRUE
      OR actual.indnkeyatts <> cardinality(string_to_array(expected.key_columns, ','))
      OR (
        SELECT string_agg(attribute.attname, ',' ORDER BY key.ordinality)
          FROM unnest(actual.indkey) WITH ORDINALITY AS key(attnum, ordinality)
          JOIN pg_attribute attribute
            ON attribute.attrelid = actual.indrelid
           AND attribute.attnum = key.attnum
         WHERE key.ordinality <= actual.indnkeyatts
      ) <> expected.key_columns
      OR (
        SELECT string_agg(option.value::text, ',' ORDER BY option.ordinality)
          FROM unnest(actual.indoption) WITH ORDINALITY AS option(value, ordinality)
         WHERE option.ordinality <= actual.indnkeyatts
      ) <> expected.key_options
      OR regexp_replace(COALESCE(pg_get_expr(actual.indpred, actual.indrelid), ''), '\\s+', ' ', 'g')
         <> regexp_replace(expected.predicate, '\\s+', ' ', 'g')
  UNION ALL
  SELECT 'runtime-role:missing-or-invalid'
    FROM runtime_role runtime
   WHERE runtime.role_name IS NULL OR runtime.role_oid IS NULL
  UNION ALL
  SELECT 'table-privilege:' || expected.table_name || '.' || expected.privilege_name
    FROM required_table_privileges expected
    CROSS JOIN runtime_role runtime
   WHERE COALESCE(
     has_table_privilege(runtime.role_oid, to_regclass('public.' || expected.table_name), expected.privilege_name),
     FALSE
   ) <> expected.expected
  UNION ALL
  SELECT 'public-table-privilege:' || relation.relname || '.' || acl.privilege_type
    FROM pg_namespace namespace
    JOIN pg_class relation
      ON relation.relnamespace = namespace.oid
     AND relation.relname = ANY (ARRAY[${NEW_PROJECT_REQUIRED_TABLES.map(sqlString).join(',')}])
     AND relation.relkind IN ('r', 'p')
    CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) acl
   WHERE namespace.nspname = 'public'
     AND acl.grantee = 0
  UNION ALL
  SELECT 'sequence-privilege:peakos_structured_project_history_id_seq.' || privilege.privilege_name
    FROM (VALUES ('USAGE', TRUE), ('SELECT', FALSE), ('UPDATE', FALSE)) AS privilege(privilege_name, expected)
    CROSS JOIN runtime_role runtime
   WHERE COALESCE(
     has_sequence_privilege(runtime.role_oid, to_regclass('public.peakos_structured_project_history_id_seq'), privilege.privilege_name),
     FALSE
   ) <> privilege.expected
  UNION ALL
  SELECT 'public-sequence-privilege:peakos_structured_project_history_id_seq.' || acl.privilege_type
    FROM pg_namespace namespace
    JOIN pg_class relation
      ON relation.relnamespace = namespace.oid
     AND relation.relname = 'peakos_structured_project_history_id_seq'
     AND relation.relkind = 'S'
    CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl, acldefault('S', relation.relowner))) acl
   WHERE namespace.nspname = 'public'
     AND acl.grantee = 0
  UNION ALL
  SELECT 'function-privilege:' || expected.function_name || '.execute'
    FROM required_functions expected
    CROSS JOIN runtime_role runtime
   WHERE COALESCE(
     has_function_privilege(
       runtime.role_oid,
       to_regprocedure('public.' || expected.function_name || '()'),
       'EXECUTE'
     ),
     FALSE
   ) IS NOT FALSE
  UNION ALL
  SELECT 'public-function-privilege:' || function_row.proname || '.execute'
    FROM required_functions expected
    JOIN pg_namespace namespace ON namespace.nspname = 'public'
    JOIN pg_proc function_row
      ON function_row.pronamespace = namespace.oid
     AND function_row.proname = expected.function_name
     AND function_row.pronargs = 0
    CROSS JOIN LATERAL aclexplode(COALESCE(function_row.proacl, acldefault('f', function_row.proowner))) acl
   WHERE acl.grantee = 0
     AND acl.privilege_type = 'EXECUTE'
)
SELECT NOT EXISTS (SELECT 1 FROM missing) AS ready,
       COALESCE(array_agg(requirement ORDER BY requirement)
         FILTER (WHERE requirement IS NOT NULL), ARRAY[]::text[]) AS missing_requirements
  FROM missing
`.trim();

const NEW_PROJECT_PROJECT_STATUSES = Object.freeze(['active', 'completed', 'archived']);
const NEW_PROJECT_TASK_STATUSES = Object.freeze(['todo', 'acknowledged', 'doing', 'review', 'revision', 'done']);
// These are the only actions accepted from the UI/API. `request` is mapped to
// submit or resubmit from the locked row's current status. Internal action names
// are history labels only and must never be trusted from a client body.
const NEW_PROJECT_TASK_ACTIONS = Object.freeze(['acknowledge', 'start', 'request', 'approve', 'revision']);
const NEW_PROJECT_INTERNAL_TASK_ACTIONS = Object.freeze(['acknowledge', 'start', 'submit', 'resubmit', 'approve', 'request_revision']);
const NEW_PROJECT_MEMBER_ROLES = Object.freeze(['lead', 'member']);
const NOTE_REQUIRED_ACTIONS = new Set(['revision']);
const SORT_ORDER_BOUND = 1_000_000;
const VERSION_BOUND = 2_147_483_647;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const ISO_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const ACTION_TRANSITIONS = Object.freeze({
  // 담당자가 스스로 고르는 단계: 확인완료 → 진행중 → 진행완료(검토 요청)
  acknowledge: Object.freeze({ from: Object.freeze(['todo', 'doing']), to: 'acknowledged', actor: 'assignee' }),
  start: Object.freeze({ from: Object.freeze(['todo', 'acknowledged']), to: 'doing', actor: 'assignee' }),
  submit: Object.freeze({ from: Object.freeze(['todo', 'acknowledged', 'doing']), to: 'review', actor: 'assignee' }),
  resubmit: Object.freeze({ from: Object.freeze(['revision']), to: 'review', actor: 'assignee' }),
  approve: Object.freeze({ from: Object.freeze(['review']), to: 'done', actor: 'reviewer' }),
  request_revision: Object.freeze({ from: Object.freeze(['review']), to: 'revision', actor: 'reviewer' }),
});

function denied(status, code, error) {
  return { allowed: false, status, code, error };
}

function invalid(code, error) {
  return { ok: false, status: 400, code, error };
}

function normalizeStrictObject(value, allowedKeys, label = '요청') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('NEW_PROJECT_BODY_INVALID', `${label} 형식이 올바르지 않습니다.`);
  }
  const unknownKeys = Object.keys(value).filter(key => !allowedKeys.includes(key));
  if (unknownKeys.length) {
    return invalid('NEW_PROJECT_BODY_FIELD_INVALID', `${label}에 허용되지 않은 항목이 있습니다.`);
  }
  return { ok: true, value };
}

function normalizeNewProjectId(value, field = 'ID') {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(id)) {
    return invalid('NEW_PROJECT_ID_INVALID', `${field}가 올바르지 않습니다.`);
  }
  return { ok: true, value: id };
}

function normalizeNewProjectUid(value, field = '사용자') {
  const uid = typeof value === 'string' ? value.trim() : '';
  if (!UID_PATTERN.test(uid)) {
    return invalid('NEW_PROJECT_UID_INVALID', `${field} 식별자가 올바르지 않습니다.`);
  }
  return { ok: true, value: uid };
}

function normalizeNewProjectText(value, {
  field = '내용',
  required = true,
  min = required ? 1 : 0,
  max = 4000,
} = {}) {
  if (value === undefined || value === null) {
    if (!required) return { ok: true, value: '' };
    return invalid('NEW_PROJECT_TEXT_REQUIRED', `${field}을(를) 입력해 주세요.`);
  }
  if (typeof value !== 'string') {
    return invalid('NEW_PROJECT_TEXT_INVALID', `${field} 형식이 올바르지 않습니다.`);
  }
  const text = value.trim();
  if (text.length < min) return invalid('NEW_PROJECT_TEXT_REQUIRED', `${field}을(를) 입력해 주세요.`);
  if (text.length > max) return invalid('NEW_PROJECT_TEXT_TOO_LONG', `${field}은(는) ${max}자 이하여야 합니다.`);
  return { ok: true, value: text };
}

function normalizeNewProjectDisplayName(value, field = '이름') {
  const result = normalizeNewProjectText(value, { field, required: true, max: 160 });
  if (!result.ok) return { ...result, code: 'NEW_PROJECT_NAME_INVALID' };
  return result;
}

function normalizeNewProjectSortOrder(value, { defaultValue = 0 } = {}) {
  const sortOrder = value === undefined ? defaultValue : value;
  if (!Number.isSafeInteger(sortOrder) || Math.abs(sortOrder) > SORT_ORDER_BOUND) {
    return invalid('NEW_PROJECT_SORT_ORDER_INVALID', '정렬 순서가 올바르지 않습니다.');
  }
  return { ok: true, value: sortOrder };
}

function normalizeNewProjectExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > VERSION_BOUND) {
    return invalid('NEW_PROJECT_VERSION_INVALID', '업무 버전이 올바르지 않습니다.');
  }
  return { ok: true, value };
}

function normalizeNewProjectDate(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return { ok: true, value: null };
    return invalid('NEW_PROJECT_DATE_REQUIRED', '마감일을 입력해 주세요.');
  }
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    return invalid('NEW_PROJECT_DATE_INVALID', '마감일은 YYYY-MM-DD 형식이어야 합니다.');
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    return invalid('NEW_PROJECT_DATE_INVALID', '실제로 존재하는 마감일을 입력해 주세요.');
  }
  return { ok: true, value };
}

function normalizeNewProjectEnum(value, allowed, field, { defaultValue } = {}) {
  const candidate = value === undefined ? defaultValue : value;
  if (typeof candidate !== 'string' || !allowed.includes(candidate)) {
    return invalid('NEW_PROJECT_ENUM_INVALID', `${field} 값이 올바르지 않습니다.`);
  }
  return { ok: true, value: candidate };
}

// 중분류 열람 범위. 프로젝트 담당자·관리 권한자는 전체를 보고,
// 그 밖의 팀원은 자기가 담당자인 중분류이거나 자기 업무가 들어 있는
// 중분류만 본다. 서버에서 걸러야 실제로 가려지므로 여기서 판정한다.
function newProjectVisibleMediums({ mediums = [], uid = '', seesEveryMedium = false } = {}) {
  const list = Array.isArray(mediums) ? mediums : [];
  if (seesEveryMedium) return list;
  const actor = String(uid || '');
  if (!actor) return [];
  const involves = task => [task?.assignee?.uid, task?.assignedBy?.uid, task?.reviewer?.uid]
    .some(value => String(value || '') === actor);
  return list.filter(medium => {
    if (String(medium?.managerUid || '') === actor) return true;
    return (Array.isArray(medium?.smallCategories) ? medium.smallCategories : [])
      .some(small => (Array.isArray(small?.tasks) ? small.tasks : []).some(involves));
  });
}

function newProjectSchemaReadiness(row) {
  const missing = Array.isArray(row?.missing_requirements)
    ? row.missing_requirements.filter(value => typeof value === 'string' && value)
    : [];
  const ready = row?.ready === true && missing.length === 0;
  return ready
    ? { ready: true, missing: [] }
    : {
      ready: false,
      missing,
      code: 'NEW_PROJECT_SCHEMA_NOT_READY',
      error: `신규 프로젝트 스키마가 준비되지 않았습니다. 운영자가 ${NEW_PROJECT_MIGRATION_FILE}을 적용해야 합니다.`,
    };
}

function newProjectReadDecision({
  preview = false,
  isPortfolioViewer = false,
  isDirectWorkspaceMember = false,
  workspaceRole = '',
  canReadWorkspacePortfolio = false,
  isProjectLead = false,
  isProjectMember = false,
} = {}) {
  if (preview) {
    return denied(403, 'NEW_PROJECT_PREVIEW_DATA_HIDDEN', '계정 미리보기에서는 신규 프로젝트 데이터를 볼 수 없습니다.');
  }
  // `isPortfolioViewer` is the exact-three HQ allowlist decision and
  // `canReadWorkspacePortfolio` is true only for a direct non-Peak workspace
  // admin/manager. Both values must be resolved by the server, never the body.
  const directPortfolioManager = canReadWorkspacePortfolio
    && isDirectWorkspaceMember
    && ['admin', 'manager'].includes(workspaceRole);
  if (isPortfolioViewer || directPortfolioManager) {
    return { allowed: true, scope: 'portfolio' };
  }
  if (isProjectLead || isProjectMember) {
    return { allowed: true, scope: 'project' };
  }
  return denied(403, 'NEW_PROJECT_READ_FORBIDDEN', '이 신규 프로젝트를 볼 권한이 없습니다.');
}

function newProjectMutationDecision({
  preview = false,
  isOversight = false,
  isDirectWorkspaceMember = false,
  workspaceRole = '',
  canManageWorkspaceProjects = false,
  isProjectMember = false,
  isProjectLead = false,
} = {}) {
  if (preview) {
    return denied(403, 'NEW_PROJECT_PREVIEW_READ_ONLY', '계정 미리보기에서는 신규 프로젝트를 변경할 수 없습니다.');
  }
  if (isOversight || workspaceRole === 'oversight') {
    return denied(403, 'NEW_PROJECT_OVERSIGHT_READ_ONLY', '본사 열람 권한으로는 지사 신규 프로젝트를 변경할 수 없습니다.');
  }
  // `canManageWorkspaceProjects` is true only for a direct non-Peak workspace
  // admin/manager, and existing-project changes additionally require active
  // project membership. A generic Peak role and HQ portfolio visibility are
  // both insufficient to mutate an existing project.
  const directWorkspaceManager = canManageWorkspaceProjects
    && isDirectWorkspaceMember
    && ['admin', 'manager'].includes(workspaceRole)
    && isProjectMember;
  if (isProjectLead || directWorkspaceManager) {
    return {
      allowed: true,
      actorRole: isProjectLead ? 'lead' : workspaceRole,
    };
  }
  return denied(403, 'NEW_PROJECT_MUTATION_FORBIDDEN', '프로젝트 담당자 또는 해당 조직의 관리자만 변경할 수 있습니다.');
}

function newProjectCreateDecision({
  preview = false,
  isOversight = false,
  isPortfolioCreator = false,
  isDirectWorkspaceMember = false,
  workspaceRole = '',
  canManageWorkspaceProjects = false,
} = {}) {
  if (preview) {
    return denied(403, 'NEW_PROJECT_PREVIEW_READ_ONLY', '계정 미리보기에서는 신규 프로젝트를 만들 수 없습니다.');
  }
  if (isOversight || workspaceRole === 'oversight') {
    return denied(403, 'NEW_PROJECT_OVERSIGHT_READ_ONLY', '본사 열람 권한으로는 지사 신규 프로젝트를 만들 수 없습니다.');
  }
  const directWorkspaceManager = canManageWorkspaceProjects
    && isDirectWorkspaceMember
    && ['admin', 'manager'].includes(workspaceRole);
  if (isPortfolioCreator || directWorkspaceManager) {
    return { allowed: true, actorRole: isPortfolioCreator ? 'portfolio_creator' : workspaceRole };
  }
  return denied(403, 'NEW_PROJECT_CREATE_FORBIDDEN', '신규 프로젝트를 만들 권한이 없습니다.');
}

function resolveNewProjectReviewer({
  assigneeUid = '',
  assignedByUid = '',
  assignedByName = '',
  reviewerUid = '',
  reviewerName = '',
  leadUid = '',
  leadName = '',
} = {}) {
  const assignee = normalizeNewProjectUid(assigneeUid, '업무 담당자');
  if (!assignee.ok) return assignee;

  // 지시자가 직접 검토자를 고른 경우를 먼저 존중한다.
  // 담당자가 자기 일을 스스로 승인하는 것은 DB 제약으로도 막혀 있다.
  const chosenUid = normalizeNewProjectUid(reviewerUid, '업무 검토자');
  const chosenName = normalizeNewProjectDisplayName(reviewerName, '업무 검토자 이름');
  if (reviewerUid && chosenUid.ok && chosenName.ok) {
    if (chosenUid.value === assignee.value) {
      return invalid('NEW_PROJECT_REVIEWER_SAME_AS_ASSIGNEE', '검토자는 업무 담당자와 달라야 합니다.');
    }
    return { ok: true, reviewerUid: chosenUid.value, reviewerName: chosenName.value, source: 'explicit' };
  }

  const assignerUid = normalizeNewProjectUid(assignedByUid, '업무 지시자');
  const assignerName = normalizeNewProjectDisplayName(assignedByName, '업무 지시자 이름');
  if (assignerUid.ok && assignerName.ok && assignerUid.value !== assignee.value) {
    return {
      ok: true,
      reviewerUid: assignerUid.value,
      reviewerName: assignerName.value,
      source: 'assigned_by',
    };
  }

  const fallbackUid = normalizeNewProjectUid(leadUid, '프로젝트 담당자');
  const fallbackName = normalizeNewProjectDisplayName(leadName, '프로젝트 담당자 이름');
  if (fallbackUid.ok && fallbackName.ok && fallbackUid.value !== assignee.value) {
    return {
      ok: true,
      reviewerUid: fallbackUid.value,
      reviewerName: fallbackName.value,
      source: 'lead_fallback',
    };
  }

  return invalid(
    'NEW_PROJECT_REVIEWER_REQUIRED',
    '업무 담당자와 다른 검토자를 지정해야 합니다. 업무 지시자가 없으면 프로젝트 담당자가 검토합니다.',
  );
}

function newProjectExternalActionToInternal(action, status) {
  if (action === 'request') {
    if (status === 'revision') return { ok: true, action: 'resubmit' };
    if (['todo', 'acknowledged', 'doing'].includes(status)) return { ok: true, action: 'submit' };
    return invalid('NEW_PROJECT_TASK_TRANSITION_FORBIDDEN', '현재 상태에서는 검토를 요청할 수 없습니다.');
  }
  if (action === 'acknowledge') return { ok: true, action: 'acknowledge' };
  if (action === 'start') return { ok: true, action: 'start' };
  if (action === 'approve') return { ok: true, action: 'approve' };
  if (action === 'revision') return { ok: true, action: 'request_revision' };
  return invalid('NEW_PROJECT_ENUM_INVALID', '업무 처리 방식 값이 올바르지 않습니다.');
}

function newProjectTaskTransitionDecision({
  task,
  action,
  actorUid,
  expectedVersion,
  note,
  preview = false,
  isOversight = false,
  isAssignee = false,
  isReviewer = false,
  isProjectLead = false,
} = {}) {
  if (preview) {
    return denied(403, 'NEW_PROJECT_PREVIEW_READ_ONLY', '계정 미리보기에서는 업무 상태를 변경할 수 없습니다.');
  }
  if (isOversight) {
    return denied(403, 'NEW_PROJECT_OVERSIGHT_READ_ONLY', '본사 열람 권한으로는 지사 업무 상태를 변경할 수 없습니다.');
  }
  if (!task || typeof task !== 'object') {
    return denied(404, 'NEW_PROJECT_TASK_NOT_FOUND', '업무를 찾을 수 없습니다.');
  }

  const normalizedAction = normalizeNewProjectEnum(action, NEW_PROJECT_TASK_ACTIONS, '업무 처리 방식');
  if (!normalizedAction.ok) return { allowed: false, ...normalizedAction };
  const status = String(task.status || '');
  if (!NEW_PROJECT_TASK_STATUSES.includes(status)) {
    return denied(409, 'NEW_PROJECT_TASK_STATUS_INVALID', '저장된 업무 상태가 올바르지 않습니다.');
  }

  const internalAction = newProjectExternalActionToInternal(normalizedAction.value, status);
  if (!internalAction.ok) return { allowed: false, ...internalAction };
  const transition = ACTION_TRANSITIONS[internalAction.action];

  const uid = normalizeNewProjectUid(actorUid, '처리자');
  if (!uid.ok) return { allowed: false, ...uid };
  const actorIsAssignee = isAssignee && uid.value === String(task.assignee_uid || '');
  const actorIsReviewer = (isReviewer && uid.value === String(task.reviewer_uid || ''))
    || (
      isProjectLead
      && task.reviewer_source === 'lead_fallback'
      && uid.value === String(task.reviewer_uid || '')
    );
  if (transition.actor === 'assignee' && !actorIsAssignee) {
    return denied(403, 'NEW_PROJECT_TASK_ASSIGNEE_REQUIRED', '업무를 받은 담당자만 이 처리를 할 수 있습니다.');
  }
  if (transition.actor === 'reviewer' && !actorIsReviewer) {
    return denied(403, 'NEW_PROJECT_TASK_REVIEWER_REQUIRED', '업무를 지시한 검토자만 승인하거나 수정을 요청할 수 있습니다.');
  }

  const version = normalizeNewProjectExpectedVersion(expectedVersion);
  if (!version.ok) return { allowed: false, ...version };
  const currentVersion = Number(task.version);
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1 || currentVersion > VERSION_BOUND) {
    return denied(409, 'NEW_PROJECT_TASK_VERSION_INVALID', '저장된 업무 버전이 올바르지 않습니다.');
  }
  if (version.value !== currentVersion) {
    return denied(409, 'NEW_PROJECT_TASK_VERSION_CONFLICT', '다른 사용자가 먼저 업무를 변경했습니다. 새로고침 후 다시 시도해 주세요.');
  }

  if (!transition.from.includes(status)) {
    return denied(409, 'NEW_PROJECT_TASK_TRANSITION_FORBIDDEN', '현재 상태에서는 요청한 업무 처리를 할 수 없습니다.');
  }

  const normalizedNote = normalizeNewProjectText(note, {
    field: '처리 메모',
    required: NOTE_REQUIRED_ACTIONS.has(normalizedAction.value),
    max: 4000,
  });
  if (!normalizedNote.ok) return { allowed: false, ...normalizedNote };

  return {
    allowed: true,
    action: internalAction.action,
    externalAction: normalizedAction.value,
    actorRole: transition.actor,
    fromStatus: status,
    nextStatus: transition.to,
    expectedVersion: version.value,
    nextVersion: version.value + 1,
    note: normalizedNote.value,
  };
}

function normalizeNewProjectTaskActionBody(body) {
  const object = normalizeStrictObject(body, ['action', 'expectedVersion', 'note'], '업무 처리 요청');
  if (!object.ok) return object;
  const action = normalizeNewProjectEnum(body.action, NEW_PROJECT_TASK_ACTIONS, '업무 처리 방식');
  if (!action.ok) return action;
  const expectedVersion = normalizeNewProjectExpectedVersion(body.expectedVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const note = normalizeNewProjectText(body.note, {
    field: '처리 메모',
    required: NOTE_REQUIRED_ACTIONS.has(action.value),
    max: 4000,
  });
  if (!note.ok) return note;
  return { ok: true, value: { action: action.value, expectedVersion: expectedVersion.value, note: note.value } };
}

const MEETING_STATUSES = Object.freeze(['scheduled', 'done', 'cancelled']);
const MEETING_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const MEETING_ATTENDEE_LIMIT = 100;

// 시간은 "" 이거나 HH:MM. 빈 값은 "시간 미정"이라는 뜻이다.
function normalizeMeetingTime(value, field) {
  if (value === undefined || value === null || value === '') return { ok: true, value: '' };
  const text = String(value).trim();
  if (!MEETING_TIME.test(text)) {
    return { ok: false, code: 'NEW_PROJECT_MEETING_TIME_INVALID', error: `${field}은(는) 09:30 형식으로 입력해 주세요.` };
  }
  return { ok: true, value: text };
}

// 회의 한 건이 성립하는지 본다. DB CHECK와 같은 규칙을 여기서 먼저 걸러
// 사용자에게 제약 위반 대신 읽을 수 있는 메시지를 준다.
function normalizeMeetingSchedule({ startDate, endDate, startTime, endTime }) {
  if (endDate < startDate) {
    return { ok: false, code: 'NEW_PROJECT_MEETING_SPAN_INVALID', error: '종료일이 시작일보다 빠릅니다.' };
  }
  if (endTime && !startTime) {
    return { ok: false, code: 'NEW_PROJECT_MEETING_TIME_INVALID', error: '종료 시간을 넣으려면 시작 시간을 먼저 정해 주세요.' };
  }
  if (endTime && endDate === startDate && endTime <= startTime) {
    return { ok: false, code: 'NEW_PROJECT_MEETING_TIME_ORDER', error: '종료 시간이 시작 시간보다 빠르거나 같습니다.' };
  }
  return { ok: true, value: { startDate, endDate, startTime, endTime } };
}

// 회의를 잡을 수 있는 사람: 프로젝트를 관리하는 사람, 프로젝트 담당자,
// 그리고 그 중분류를 맡은 사람. 남의 분류에 회의를 꽂지 못하게 한다.
function newProjectMeetingManageDecision({ readOnly, canManage, isLead, uid, mediumManagerUid }) {
  if (readOnly) {
    return { allowed: false, status: 403, code: 'NEW_PROJECT_READ_ONLY', error: '열람 전용 계정은 회의를 잡을 수 없습니다.' };
  }
  if (canManage === true || isLead === true) return { allowed: true };
  if (uid && mediumManagerUid && String(uid) === String(mediumManagerUid)) return { allowed: true };
  return {
    allowed: false, status: 403, code: 'NEW_PROJECT_MEETING_FORBIDDEN',
    error: '이 중분류에 회의를 잡을 권한이 없습니다.',
  };
}

module.exports = {
  ACTION_TRANSITIONS,
  ACTIVE_LEAD_FUNCTION_SOURCE,
  ACTIVE_MEDIUM_MANAGER_FUNCTION_SOURCE,
  HISTORY_APPEND_ONLY_FUNCTION_SOURCE,
  NEW_PROJECT_INTERNAL_TASK_ACTIONS,
  NEW_PROJECT_MEMBER_ROLES,
  NEW_PROJECT_MIGRATION_FILE,
  NEW_PROJECT_PROJECT_STATUSES,
  NEW_PROJECT_REQUIRED_COLUMN_DEFINITIONS,
  NEW_PROJECT_REQUIRED_COLUMNS,
  NEW_PROJECT_REQUIRED_CONSTRAINT_DEFINITIONS,
  NEW_PROJECT_REQUIRED_CONSTRAINTS,
  NEW_PROJECT_REQUIRED_FUNCTIONS,
  NEW_PROJECT_REQUIRED_INDEXES,
  NEW_PROJECT_REQUIRED_TABLES,
  NEW_PROJECT_REQUIRED_TRIGGERS,
  NEW_PROJECT_SCHEMA_READINESS_SQL,
  NEW_PROJECT_TABLE_PRIVILEGES,
  NEW_PROJECT_TABLES,
  NEW_PROJECT_TASK_ACTIONS,
  NEW_PROJECT_TASK_STATUSES,
  MEETING_ATTENDEE_LIMIT,
  MEETING_STATUSES,
  NOTE_REQUIRED_ACTIONS,
  SORT_ORDER_BOUND,
  VERSION_BOUND,
  newProjectCreateDecision,
  newProjectMeetingManageDecision,
  newProjectMutationDecision,
  newProjectExternalActionToInternal,
  newProjectReadDecision,
  newProjectSchemaReadiness,
  newProjectVisibleMediums,
  newProjectTaskTransitionDecision,
  normalizeMeetingSchedule,
  normalizeMeetingTime,
  normalizeNewProjectDate,
  normalizeNewProjectDisplayName,
  normalizeNewProjectEnum,
  normalizeNewProjectExpectedVersion,
  normalizeNewProjectId,
  normalizeNewProjectSortOrder,
  normalizeNewProjectTaskActionBody,
  normalizeNewProjectText,
  normalizeNewProjectUid,
  normalizeStrictObject,
  resolveNewProjectReviewer,
};
