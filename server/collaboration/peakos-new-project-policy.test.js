'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  ACTIVE_LEAD_FUNCTION_SOURCE,
  ACTIVE_MEDIUM_MANAGER_FUNCTION_SOURCE,
  HISTORY_APPEND_ONLY_FUNCTION_SOURCE,
  NEW_PROJECT_INTERNAL_TASK_ACTIONS,
  NEW_PROJECT_PROJECT_STATUSES,
  NEW_PROJECT_REQUIRED_COLUMN_DEFINITIONS,
  NEW_PROJECT_REQUIRED_COLUMNS,
  NEW_PROJECT_REQUIRED_CONSTRAINT_DEFINITIONS,
  NEW_PROJECT_REQUIRED_CONSTRAINTS,
  NEW_PROJECT_REQUIRED_FUNCTIONS,
  NEW_PROJECT_REQUIRED_INDEXES,
  NEW_PROJECT_REQUIRED_TABLES,
  newProjectMediumScopeDecision,
  NEW_PROJECT_TASK_STATUSES,
  MEETING_STATUSES,
  NEW_PROJECT_REQUIRED_TRIGGERS,
  NEW_PROJECT_SCHEMA_READINESS_SQL,
  NEW_PROJECT_TABLE_PRIVILEGES,
  NEW_PROJECT_TASK_ACTIONS,
  newProjectCreateDecision,
  newProjectExternalActionToInternal,
  newProjectMutationDecision,
  newProjectReadDecision,
  newProjectSchemaReadiness,
  newProjectVisibleMediums,
  newProjectTaskTransitionDecision,
  normalizeNewProjectDate,
  normalizeNewProjectExpectedVersion,
  normalizeNewProjectId,
  normalizeNewProjectSortOrder,
  normalizeNewProjectTaskActionBody,
  normalizeNewProjectUid,
  resolveNewProjectReviewer,
} = require('./peakos-new-project-policy');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '20260811_peakos_structured_projects.sql'),
  'utf8',
);

const task = Object.freeze({
  status: 'todo',
  version: 3,
  assignee_uid: 'worker-uid',
  reviewer_uid: 'manager-uid',
  reviewer_source: 'assigned_by',
});

function stripSqlStringLiterals(sql) {
  return String(sql).replace(/'(?:''|[^'])*'/g, "''");
}

test('readiness contract fail-closes on exact columns, constraints, indexes, functions, triggers and runtime ACLs using SELECT only', () => {
  assert.equal(NEW_PROJECT_REQUIRED_TABLES.length, 9);
  assert.equal(new Set(NEW_PROJECT_REQUIRED_TABLES).size, 9);
  assert.ok(NEW_PROJECT_REQUIRED_TABLES.every(name => name.startsWith('peakos_structured_')));
  assert.ok(Object.values(NEW_PROJECT_REQUIRED_COLUMNS).every(columns => columns.includes('workspace_id')));
  assert.ok(NEW_PROJECT_REQUIRED_COLUMNS.peakos_structured_project_medium_categories.includes('manager_uid'));
  assert.ok(NEW_PROJECT_REQUIRED_COLUMNS.peakos_structured_project_medium_categories.includes('manager_name_snapshot'));
  assert.deepEqual(
    NEW_PROJECT_REQUIRED_COLUMN_DEFINITIONS.peakos_structured_project_tasks.assigned_by_uid,
    ['text', true, null],
  );
  assert.deepEqual(
    NEW_PROJECT_REQUIRED_COLUMN_DEFINITIONS.peakos_structured_project_tasks.reviewer_uid,
    ['text', true, null],
  );
  assert.deepEqual(
    NEW_PROJECT_REQUIRED_COLUMN_DEFINITIONS.peakos_structured_project_tasks.status,
    ['text', true, "'todo'::text"],
  );
  assert.ok(Object.values(NEW_PROJECT_REQUIRED_CONSTRAINTS).flat().includes('peakos_structured_projects_lead_project_member_fk'));
  assert.ok(Object.values(NEW_PROJECT_REQUIRED_CONSTRAINTS).flat().includes('peakos_structured_project_medium_manager_fk'));
  assert.ok(NEW_PROJECT_REQUIRED_CONSTRAINT_DEFINITIONS.peakos_structured_project_tasks.some(
    ([name, type, definition]) => name === 'peakos_structured_project_tasks_assigner_membership_fk'
      && type === 'f'
      && /workspace_id, assigned_by_uid/.test(definition),
  ));
  assert.ok(NEW_PROJECT_REQUIRED_CONSTRAINT_DEFINITIONS.peakos_structured_project_tasks.some(
    ([name, type, definition]) => name === 'peakos_structured_project_tasks_reviewer_membership_fk'
      && type === 'f'
      && /workspace_id, reviewer_uid/.test(definition),
  ));
  assert.deepEqual(NEW_PROJECT_REQUIRED_TRIGGERS.map(([, trigger]) => trigger), [
    'peakos_structured_projects_active_lead_guard',
    'peakos_structured_project_members_active_lead_guard',
    'peakos_structured_project_medium_manager_guard',
    'peakos_structured_project_members_medium_manager_guard',
    'peakos_structured_project_history_no_mutation',
  ]);
  assert.equal(NEW_PROJECT_REQUIRED_INDEXES.length, 14);
  assert.ok(NEW_PROJECT_REQUIRED_INDEXES.some(([, name, , columns, , predicate]) => (
    name === 'peakos_structured_project_tasks_reviewer_idx'
      && columns === 'workspace_id,reviewer_uid,status,review_requested_at'
      && predicate === "(status = 'review'::text)"
  )));
  assert.deepEqual(NEW_PROJECT_REQUIRED_FUNCTIONS.map(([name]) => name), [
    'peakos_structured_project_assert_active_lead',
    'peakos_structured_project_assert_active_medium_manager',
    'peakos_structured_project_history_append_only',
  ]);
  assert.match(ACTIVE_LEAD_FUNCTION_SOURCE, /role = 'lead'[\s\S]*active = TRUE/);
  assert.match(ACTIVE_MEDIUM_MANAGER_FUNCTION_SOURCE, /medium\.manager_uid[\s\S]*member\.active = TRUE/);
  assert.match(HISTORY_APPEND_ONLY_FUNCTION_SOURCE, /append-only/);
  assert.deepEqual(NEW_PROJECT_TABLE_PRIVILEGES.peakos_structured_project_tasks, {
    SELECT: true, INSERT: true, UPDATE: true, DELETE: false,
    TRUNCATE: false, REFERENCES: false, TRIGGER: false,
  });
  assert.deepEqual(NEW_PROJECT_TABLE_PRIVILEGES.peakos_structured_project_history, {
    SELECT: true, INSERT: true, UPDATE: false, DELETE: false,
    TRUNCATE: false, REFERENCES: false, TRIGGER: false,
  });
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /^WITH required_columns/i);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /format_type\(actual\.atttypid, actual\.atttypmod\)/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /pg_get_expr\(default_row\.adbin, default_row\.adrelid\)/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /actual\.convalidated IS NOT TRUE/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /pg_get_constraintdef\(actual\.oid\)/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /actual\.tgenabled::text <> expected\.enabled_state/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /actual\.tgdeferrable <> expected\.is_deferrable/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /actual\.tginitdeferred <> expected\.is_initially_deferred/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /actual\.tgqual IS NOT NULL/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /actual\.tgattr::text <> ''/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /actual\.tgnargs <> 0/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /octet_length\(actual\.tgargs\) <> 0/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /pg_get_triggerdef\(actual\.oid\)/);
  assert.ok(NEW_PROJECT_REQUIRED_TRIGGERS.every(([, , , , , , , definition]) => (
    /^CREATE (?:CONSTRAINT )?TRIGGER /.test(definition)
  )));
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /actual\.prorettype <> 'trigger'::regtype/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /actual\.prosecdef IS NOT FALSE/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /actual\.prosrc/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /actual\.indisvalid IS NOT TRUE/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /actual\.indisready IS NOT TRUE/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /actual\.indislive IS NOT TRUE/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /actual\.indoption/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /has_table_privilege/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /has_sequence_privilege/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /has_function_privilege/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /aclexplode/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /SELECT current_user AS role_name/);
  assert.doesNotMatch(NEW_PROJECT_SCHEMA_READINESS_SQL, /current_setting\('peakos\.app_role'/);
  assert.doesNotMatch(
    stripSqlStringLiterals(NEW_PROJECT_SCHEMA_READINESS_SQL),
    /\b(?:CREATE\s+(?:TABLE|INDEX|TRIGGER|FUNCTION)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|TRIGGER|FUNCTION)|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|GRANT\s+)/i,
  );

  assert.deepEqual(newProjectSchemaReadiness({ ready: true, missing_requirements: [] }), { ready: true, missing: [] });
  const missing = newProjectSchemaReadiness({
    ready: false,
    missing_requirements: ['constraint:peakos_structured_projects.needed_fk'],
  });
  assert.equal(missing.ready, false);
  assert.equal(missing.code, 'NEW_PROJECT_SCHEMA_NOT_READY');
  assert.match(missing.error, /20260811_peakos_structured_projects_medium_managers\.sql/);
});

test('portfolio visibility is server-injected and does not expand an ordinary Peak manager', () => {
  assert.deepEqual(newProjectReadDecision({ isPortfolioViewer: true }), { allowed: true, scope: 'portfolio' });
  assert.equal(newProjectReadDecision({
    isDirectWorkspaceMember: true,
    workspaceRole: 'manager',
  }).code, 'NEW_PROJECT_READ_FORBIDDEN');
  assert.deepEqual(newProjectReadDecision({
    isDirectWorkspaceMember: true,
    workspaceRole: 'manager',
    canReadWorkspacePortfolio: true,
  }), { allowed: true, scope: 'portfolio' });
  assert.deepEqual(newProjectReadDecision({ isProjectMember: true }), { allowed: true, scope: 'project' });
  assert.equal(newProjectReadDecision({ isAssignee: true }).code, 'NEW_PROJECT_READ_FORBIDDEN');
  assert.equal(newProjectReadDecision({ preview: true, isPortfolioViewer: true }).code, 'NEW_PROJECT_PREVIEW_DATA_HIDDEN');
});

test('exact-three portfolio identity can create but cannot mutate another existing project', () => {
  assert.equal(newProjectCreateDecision({ isPortfolioCreator: true }).allowed, true);
  assert.equal(newProjectMutationDecision({ isPortfolioManager: true }).code, 'NEW_PROJECT_MUTATION_FORBIDDEN');
  assert.equal(newProjectMutationDecision({
    isDirectWorkspaceMember: true,
    workspaceRole: 'manager',
  }).code, 'NEW_PROJECT_MUTATION_FORBIDDEN');
  assert.equal(newProjectMutationDecision({
    isDirectWorkspaceMember: true,
    workspaceRole: 'manager',
    canManageWorkspaceProjects: true,
  }).code, 'NEW_PROJECT_MUTATION_FORBIDDEN');
  assert.equal(newProjectMutationDecision({
    isDirectWorkspaceMember: true,
    workspaceRole: 'manager',
    canManageWorkspaceProjects: true,
    isProjectMember: true,
  }).allowed, true);
  assert.equal(newProjectMutationDecision({ isProjectLead: true }).allowed, true);
  assert.equal(newProjectMutationDecision({ preview: true, isProjectLead: true }).code, 'NEW_PROJECT_PREVIEW_READ_ONLY');
  assert.equal(newProjectMutationDecision({ isOversight: true, isProjectLead: true }).code, 'NEW_PROJECT_OVERSIGHT_READ_ONLY');
  assert.equal(newProjectCreateDecision({ isOversight: true, isPortfolioCreator: true }).code, 'NEW_PROJECT_OVERSIGHT_READ_ONLY');
});

test('reviewer is the delegator with a non-self project lead fallback', () => {
  assert.deepEqual(resolveNewProjectReviewer({
    assigneeUid: 'worker-uid',
    assignedByUid: 'manager-uid',
    assignedByName: '업무 지시자',
    leadUid: 'lead-uid',
    leadName: '프로젝트 담당자',
  }), {
    ok: true,
    reviewerUid: 'manager-uid',
    reviewerName: '업무 지시자',
    source: 'assigned_by',
  });
  assert.equal(resolveNewProjectReviewer({
    assigneeUid: 'worker-uid',
    assignedByUid: 'worker-uid',
    assignedByName: '본인',
    leadUid: 'lead-uid',
    leadName: '프로젝트 담당자',
  }).source, 'lead_fallback');
  assert.equal(resolveNewProjectReviewer({
    assigneeUid: 'lead-uid',
    assignedByUid: 'lead-uid',
    assignedByName: '본인',
    leadUid: 'lead-uid',
    leadName: '본인',
  }).code, 'NEW_PROJECT_REVIEWER_REQUIRED');
});

test('external checklist actions map to explicit internal history actions', () => {
  assert.deepEqual(NEW_PROJECT_TASK_ACTIONS, ['acknowledge', 'start', 'request', 'approve', 'revision']);
  assert.deepEqual(NEW_PROJECT_INTERNAL_TASK_ACTIONS, ['acknowledge', 'start', 'submit', 'resubmit', 'approve', 'request_revision']);
  assert.deepEqual(newProjectExternalActionToInternal('request', 'todo'), { ok: true, action: 'submit' });
  // 담당자가 직접 고르는 단계
  assert.deepEqual(newProjectExternalActionToInternal('acknowledge', 'todo'), { ok: true, action: 'acknowledge' });
  assert.deepEqual(newProjectExternalActionToInternal('start', 'acknowledged'), { ok: true, action: 'start' });
  assert.deepEqual(newProjectExternalActionToInternal('request', 'acknowledged'), { ok: true, action: 'submit' });
  assert.deepEqual(newProjectExternalActionToInternal('request', 'doing'), { ok: true, action: 'submit' });
  assert.deepEqual(newProjectExternalActionToInternal('request', 'revision'), { ok: true, action: 'resubmit' });
  assert.deepEqual(newProjectExternalActionToInternal('revision', 'review'), { ok: true, action: 'request_revision' });
  assert.equal(newProjectExternalActionToInternal('request', 'done').code, 'NEW_PROJECT_TASK_TRANSITION_FORBIDDEN');
});

test('assignee submits and resubmits while the stored reviewer approves or requests revision', () => {
  const submitted = newProjectTaskTransitionDecision({
    task,
    action: 'request',
    actorUid: 'worker-uid',
    expectedVersion: 3,
    isAssignee: true,
  });
  assert.equal(submitted.allowed, true);
  assert.equal(submitted.action, 'submit');
  assert.equal(submitted.nextStatus, 'review');
  assert.equal(submitted.note, '');

  const resubmitted = newProjectTaskTransitionDecision({
    task: { ...task, status: 'revision' },
    action: 'request',
    actorUid: 'worker-uid',
    expectedVersion: 3,
    isAssignee: true,
  });
  assert.equal(resubmitted.action, 'resubmit');

  const approved = newProjectTaskTransitionDecision({
    task: { ...task, status: 'review' },
    action: 'approve',
    actorUid: 'manager-uid',
    expectedVersion: 3,
    isReviewer: true,
  });
  assert.equal(approved.allowed, true);
  assert.equal(approved.nextStatus, 'done');
  assert.equal(approved.note, '');

  assert.equal(newProjectTaskTransitionDecision({
    task: { ...task, status: 'review' },
    action: 'revision',
    actorUid: 'manager-uid',
    expectedVersion: 3,
    isReviewer: true,
  }).code, 'NEW_PROJECT_TEXT_REQUIRED');

  const revision = newProjectTaskTransitionDecision({
    task: { ...task, status: 'review' },
    action: 'revision',
    actorUid: 'manager-uid',
    expectedVersion: 3,
    note: '완료 화면을 첨부해 다시 올려 주세요.',
    isReviewer: true,
  });
  assert.equal(revision.action, 'request_revision');
  assert.equal(revision.nextStatus, 'revision');
});

test('lead fallback reviewer works only when persisted as the fallback reviewer', () => {
  const leadFallbackTask = {
    ...task,
    status: 'review',
    reviewer_uid: 'lead-uid',
    reviewer_source: 'lead_fallback',
  };
  assert.equal(newProjectTaskTransitionDecision({
    task: leadFallbackTask,
    action: 'approve',
    actorUid: 'lead-uid',
    expectedVersion: 3,
    isProjectLead: true,
  }).allowed, true);
  assert.equal(newProjectTaskTransitionDecision({
    task: { ...leadFallbackTask, reviewer_source: 'assigned_by' },
    action: 'approve',
    actorUid: 'lead-uid',
    expectedVersion: 3,
    isProjectLead: true,
  }).code, 'NEW_PROJECT_TASK_REVIEWER_REQUIRED');
});

test('workflow fails closed for role confusion, preview, oversight, stale versions and invalid states', () => {
  assert.equal(newProjectTaskTransitionDecision({
    task,
    action: 'request',
    actorUid: 'other-uid',
    expectedVersion: 3,
    isAssignee: true,
  }).code, 'NEW_PROJECT_TASK_ASSIGNEE_REQUIRED');
  assert.equal(newProjectTaskTransitionDecision({
    task: { ...task, status: 'review' },
    action: 'approve',
    actorUid: 'worker-uid',
    expectedVersion: 3,
    isAssignee: true,
  }).code, 'NEW_PROJECT_TASK_REVIEWER_REQUIRED');
  assert.equal(newProjectTaskTransitionDecision({
    task,
    action: 'request',
    actorUid: 'worker-uid',
    expectedVersion: 2,
    isAssignee: true,
  }).code, 'NEW_PROJECT_TASK_VERSION_CONFLICT');
  assert.equal(newProjectTaskTransitionDecision({
    task,
    action: 'request',
    actorUid: 'worker-uid',
    expectedVersion: 3,
    isAssignee: true,
    preview: true,
  }).code, 'NEW_PROJECT_PREVIEW_READ_ONLY');
  assert.equal(newProjectTaskTransitionDecision({
    task,
    action: 'request',
    actorUid: 'worker-uid',
    expectedVersion: 3,
    isAssignee: true,
    isOversight: true,
  }).code, 'NEW_PROJECT_OVERSIGHT_READ_ONLY');
});

test('strict validators reject internal actions, unknown fields, numeric strings, unsafe IDs, and impossible dates', () => {
  assert.deepEqual(normalizeNewProjectTaskActionBody({ action: 'request', expectedVersion: 3 }), {
    ok: true,
    value: { action: 'request', expectedVersion: 3, note: '' },
  });
  assert.equal(normalizeNewProjectTaskActionBody({ action: 'revision', expectedVersion: 3 }).code, 'NEW_PROJECT_TEXT_REQUIRED');
  assert.equal(normalizeNewProjectTaskActionBody({ action: 'submit', expectedVersion: 3 }).code, 'NEW_PROJECT_ENUM_INVALID');
  assert.equal(normalizeNewProjectTaskActionBody({ action: 'request', expectedVersion: 3, admin: true }).code, 'NEW_PROJECT_BODY_FIELD_INVALID');
  assert.equal(normalizeNewProjectExpectedVersion('3').code, 'NEW_PROJECT_VERSION_INVALID');
  assert.equal(normalizeNewProjectSortOrder(1000001).code, 'NEW_PROJECT_SORT_ORDER_INVALID');
  assert.equal(normalizeNewProjectId('project-1').code, 'NEW_PROJECT_ID_INVALID');
  assert.equal(normalizeNewProjectId('550e8400-e29b-41d4-a716-446655440000').ok, true);
  assert.equal(normalizeNewProjectUid('../outside').code, 'NEW_PROJECT_UID_INVALID');
  assert.equal(normalizeNewProjectDate('2026-02-29').code, 'NEW_PROJECT_DATE_INVALID');
  assert.equal(normalizeNewProjectDate('2028-02-29').value, '2028-02-29');
});

test('operator migration creates six new tables without legacy copies and enforces tenant hierarchy, lead integrity and append-only history', () => {
  // 회의 표 두 개는 나중에 따로 올린 마이그레이션이 만든다. 기본 마이그레이션은
  // 여전히 핵심 여섯 개만 만들어야 한다.
  const CORE_TABLES = NEW_PROJECT_REQUIRED_TABLES.filter(name => !name.includes('_meeting'));
  assert.equal(CORE_TABLES.length, 6);
  const tableMatches = [...migration.matchAll(/CREATE TABLE IF NOT EXISTS\s+(peakos_structured_[a-z_]+)/gi)];
  assert.deepEqual(tableMatches.map(match => match[1]), CORE_TABLES);
  assert.match(migration, /BEGIN;[\s\S]*pg_advisory_xact_lock[\s\S]*COMMIT;/i);
  assert.doesNotMatch(migration, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?(?:projects|project_tasks|project_members)\b/i);

  assert.match(migration, /FOREIGN KEY \(workspace_id, project_id, medium_category_id, small_category_id\)[\s\S]*REFERENCES peakos_structured_project_small_categories/i);
  assert.match(migration, /FOREIGN KEY \(workspace_id, project_id, assignee_uid\)[\s\S]*REFERENCES peakos_structured_project_members/i);
  assert.match(migration, /peakos_structured_projects_lead_project_member_fk[\s\S]*DEFERRABLE INITIALLY DEFERRED/i);
  assert.match(migration, /one_active_lead_idx[\s\S]*WHERE active = TRUE AND role = 'lead'/i);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER peakos_structured_projects_active_lead_guard[\s\S]*DEFERRABLE INITIALLY DEFERRED/i);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER peakos_structured_project_members_active_lead_guard[\s\S]*DEFERRABLE INITIALLY DEFERRED/i);
  assert.match(migration, /CREATE TRIGGER peakos_structured_project_history_no_mutation[\s\S]*BEFORE UPDATE OR DELETE/i);
  assert.match(migration, /reviewer_source IN \('assigned_by', 'lead_fallback'\)/i);
  assert.match(migration, /status IN \('todo', 'doing', 'review', 'revision', 'done'\)/i);
  assert.deepEqual(NEW_PROJECT_PROJECT_STATUSES, ['active', 'completed', 'archived']);
});

test('operator migration resets PUBLIC/runtime ACLs to exact least privilege without owner fallback', () => {
  assert.match(migration, /current_setting\('peakos\.app_role', TRUE\)/i);
  assert.match(migration, /rolname = 'calendar_user'/i);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON TABLE public\.%I FROM PUBLIC, %I/i);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.%I TO %I/i);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON TABLE public\.peakos_structured_project_history FROM PUBLIC, %I/i);
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE public\.peakos_structured_project_history TO %I/i);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON SEQUENCE public\.peakos_structured_project_history_id_seq FROM PUBLIC, %I/i);
  assert.match(migration, /GRANT USAGE ON SEQUENCE public\.peakos_structured_project_history_id_seq TO %I/i);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, %I/i);
  assert.match(migration, /has_table_privilege\([\s\S]*'TRUNCATE'/i);
  assert.match(migration, /has_sequence_privilege\([\s\S]*'UPDATE'/i);
  assert.match(migration, /has_function_privilege\(application_role, function_signature, 'EXECUTE'\)/i);
  assert.doesNotMatch(migration, /application_role\s*:=\s*current_user/i);
  assert.doesNotMatch(migration, /GRANT\s+EXECUTE/i);
  assert.doesNotMatch(migration, /GRANT\s+USAGE,\s*SELECT\s+ON\s+SEQUENCE/i);
  assert.doesNotMatch(migration, /GRANT[^;]*\bDELETE\b/i);
  assert.doesNotMatch(migration, /ALTER\s+(?:TABLE|SEQUENCE)[\s\S]{0,100}\sOWNER\s+TO/i);
});

test('중분류 열람 범위는 담당자와 본인 업무 기준으로 좁혀진다', () => {
  const mediums = [
    { id: 'm1', managerUid: 'owner-uid', smallCategories: [{ tasks: [] }] },
    { id: 'm2', managerUid: 'other-uid', smallCategories: [
      { tasks: [{ assignee: { uid: 'worker-uid' }, assignedBy: { uid: 'lead-uid' }, reviewer: { uid: 'lead-uid' } }] },
    ] },
    { id: 'm3', managerUid: 'other-uid', smallCategories: [
      { tasks: [{ assignee: { uid: 'someone' }, assignedBy: { uid: 'lead-uid' }, reviewer: { uid: 'lead-uid' } }] },
    ] },
  ];
  // 관리 권한자는 전부 본다.
  assert.deepEqual(
    newProjectVisibleMediums({ mediums, uid: 'anyone', seesEveryMedium: true }).map(m => m.id),
    ['m1', 'm2', 'm3'],
  );
  // 중분류 담당자는 자기 중분류를 본다.
  assert.deepEqual(
    newProjectVisibleMediums({ mediums, uid: 'owner-uid' }).map(m => m.id),
    ['m1'],
  );
  // 담당자가 아니어도 자기 업무가 있으면 그 중분류는 보인다.
  assert.deepEqual(
    newProjectVisibleMediums({ mediums, uid: 'worker-uid' }).map(m => m.id),
    ['m2'],
  );
  // 아무 접점이 없으면 하나도 보이지 않는다.
  assert.deepEqual(newProjectVisibleMediums({ mediums, uid: 'stranger' }), []);
  assert.deepEqual(newProjectVisibleMediums({ mediums, uid: '' }), []);
});

test('검토자를 직접 고르면 그 사람이 검토자가 된다', () => {
  const base = {
    assigneeUid: 'worker-uid',
    assignedByUid: 'lead-uid',
    assignedByName: '김대호',
    leadUid: 'owner-uid',
    leadName: '전현우',
  };
  // 직접 고른 검토자가 최우선.
  assert.deepEqual(
    resolveNewProjectReviewer({ ...base, reviewerUid: 'checker-uid', reviewerName: '손명아' }),
    { ok: true, reviewerUid: 'checker-uid', reviewerName: '손명아', source: 'explicit' },
  );
  // 비워 두면 예전처럼 지시자가 검토한다.
  assert.deepEqual(
    resolveNewProjectReviewer(base),
    { ok: true, reviewerUid: 'lead-uid', reviewerName: '김대호', source: 'assigned_by' },
  );
  // 담당자를 검토자로 지정할 수는 없다.
  assert.equal(
    resolveNewProjectReviewer({ ...base, reviewerUid: 'worker-uid', reviewerName: '이사원' }).code,
    'NEW_PROJECT_REVIEWER_SAME_AS_ASSIGNEE',
  );
});

// 회의를 붙이면서 히스토리 표의 entity_type CHECK와 from/to_status CHECK를
// 두 번 연속 빠뜨렸다. 둘 다 트랜잭션을 통째로 되돌려서, 화면에서는 그냥
// "저장이 안 된다"로만 보였다. 코드가 쓰는 값이 마이그레이션이 허용하는
// 값 안에 있는지 소스로 확인한다.
test('히스토리에 쓰는 entity_type과 상태값은 마이그레이션이 허용하는 값이어야 한다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'migrations');
  const sql = fs.readdirSync(dir)
    .filter(name => name.endsWith('.sql'))
    .sort()
    .map(name => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');
  const routes = fs.readFileSync(path.join(__dirname, 'peakos-new-project-routes.js'), 'utf8');

  // 마이그레이션 파일들에서 마지막으로 선언된 허용 목록을 읽는다.
  const lastList = (pattern) => {
    const matches = [...sql.matchAll(pattern)];
    assert.ok(matches.length, `허용 목록을 찾지 못했습니다: ${pattern}`);
    return new Set([...matches.at(-1)[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
  };
  const entityTypes = lastList(/entity_type = ANY \(ARRAY\[([^\]]+)\]/g);
  // to_status 를 가진 표가 둘(히스토리·개발수정요청 댓글)이라 이름으로 좁힌다.
  // 좁히지 않으면 엉뚱한 표의 허용 목록을 보고 통과해 버린다.
  const toStatuses = lastList(/peakos_structured_project_history_to_status_check[\s\S]*?to_status = ANY \(ARRAY\[([^\]]+)\]/g);

  // entityType은 리터럴로도, 삼항식으로도 쓰인다. 같은 줄의 따옴표 값을 모두 본다.
  const usedEntityTypes = new Set(routes.split('\n')
    .filter(line => line.includes('entityType:'))
    .map(line => line.slice(line.indexOf('entityType:')))
    // 삼항식 조건("level === 'small' ? ...")의 비교값은 기록되는 값이 아니다.
    .map(line => line.replace(/[=!]==?\s*'[a-z_]+'/g, ''))
    .flatMap(line => [...line.matchAll(/'([a-z_]+)'/g)].map(m => m[1])));
  assert.ok(usedEntityTypes.size >= 3, `entityType을 못 찾았습니다: ${[...usedEntityTypes]}`);
  assert.ok(usedEntityTypes.has('meeting'));
  for (const used of usedEntityTypes) {
    assert.ok(entityTypes.has(used), `history entity_type '${used}'가 CHECK에 없습니다`);
  }
  for (const status of MEETING_STATUSES) {
    assert.ok(toStatuses.has(status), `회의 상태 '${status}'가 history status CHECK에 없습니다`);
  }
  for (const status of NEW_PROJECT_TASK_STATUSES) {
    assert.ok(toStatuses.has(status), `업무 상태 '${status}'가 history status CHECK에 없습니다`);
  }
});

// 중분류만 맡은 사람이 자기 분류를 정리하지 못하면, 소분류 하나 지우려고
// 매번 프로젝트 담당자를 불러야 한다. 리더도 관리자도 아닌 경우를 못 박아 둔다.
test('중분류 담당자는 프로젝트 관리자가 아니어도 자기 중분류를 정리할 수 있다', () => {
  const base = { readOnly: false, canManage: false, isLead: false, uid: 'manager-uid' };

  assert.equal(newProjectMediumScopeDecision({ ...base, mediumManagerUid: 'manager-uid' }).allowed, true);

  // 남의 중분류는 손대지 못한다.
  const other = newProjectMediumScopeDecision({ ...base, mediumManagerUid: 'someone-else' });
  assert.equal(other.allowed, false);
  assert.equal(other.status, 403);
  assert.equal(other.code, 'NEW_PROJECT_MEDIUM_SCOPE_FORBIDDEN');

  // 담당자가 비어 있으면 아무나 통과해서는 안 된다.
  assert.equal(newProjectMediumScopeDecision({ ...base, mediumManagerUid: null }).allowed, false);
  assert.equal(newProjectMediumScopeDecision({ ...base, uid: '', mediumManagerUid: '' }).allowed, false);

  // 프로젝트 담당자와 관리자는 어느 중분류든 가능하다.
  assert.equal(newProjectMediumScopeDecision({ ...base, isLead: true, mediumManagerUid: 'x' }).allowed, true);
  assert.equal(newProjectMediumScopeDecision({ ...base, canManage: true, mediumManagerUid: 'x' }).allowed, true);

  // 열람 전용은 자기 중분류라도 안 된다.
  assert.equal(newProjectMediumScopeDecision({
    ...base, readOnly: true, mediumManagerUid: 'manager-uid',
  }).allowed, false);
});
