'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  NEW_PROJECT_INTERNAL_TASK_ACTIONS,
  NEW_PROJECT_PROJECT_STATUSES,
  NEW_PROJECT_REQUIRED_COLUMNS,
  NEW_PROJECT_REQUIRED_CONSTRAINTS,
  NEW_PROJECT_REQUIRED_TABLES,
  NEW_PROJECT_REQUIRED_TRIGGERS,
  NEW_PROJECT_SCHEMA_READINESS_SQL,
  NEW_PROJECT_TASK_ACTIONS,
  newProjectCreateDecision,
  newProjectExternalActionToInternal,
  newProjectMutationDecision,
  newProjectReadDecision,
  newProjectSchemaReadiness,
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

test('readiness contract names six isolated tables and checks columns, composite constraints, and guards with SELECT only', () => {
  assert.equal(NEW_PROJECT_REQUIRED_TABLES.length, 6);
  assert.equal(new Set(NEW_PROJECT_REQUIRED_TABLES).size, 6);
  assert.ok(NEW_PROJECT_REQUIRED_TABLES.every(name => name.startsWith('peakos_structured_')));
  assert.ok(Object.values(NEW_PROJECT_REQUIRED_COLUMNS).every(columns => columns.includes('workspace_id')));
  assert.ok(Object.values(NEW_PROJECT_REQUIRED_CONSTRAINTS).flat().includes('peakos_structured_projects_lead_project_member_fk'));
  assert.deepEqual(NEW_PROJECT_REQUIRED_TRIGGERS.map(([, trigger]) => trigger), [
    'peakos_structured_projects_active_lead_guard',
    'peakos_structured_project_members_active_lead_guard',
    'peakos_structured_project_history_no_mutation',
  ]);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /^WITH required_columns/i);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /pg_constraint/);
  assert.match(NEW_PROJECT_SCHEMA_READINESS_SQL, /pg_trigger/);
  assert.doesNotMatch(NEW_PROJECT_SCHEMA_READINESS_SQL, /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT)\b/i);

  assert.deepEqual(newProjectSchemaReadiness({ ready: true, missing_requirements: [] }), { ready: true, missing: [] });
  const missing = newProjectSchemaReadiness({
    ready: false,
    missing_requirements: ['constraint:peakos_structured_projects.needed_fk'],
  });
  assert.equal(missing.ready, false);
  assert.equal(missing.code, 'NEW_PROJECT_SCHEMA_NOT_READY');
  assert.match(missing.error, /20260811_peakos_structured_projects\.sql/);
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
  assert.deepEqual(newProjectReadDecision({ isAssignee: true }), { allowed: true, scope: 'project' });
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
  assert.deepEqual(NEW_PROJECT_TASK_ACTIONS, ['request', 'approve', 'revision']);
  assert.deepEqual(NEW_PROJECT_INTERNAL_TASK_ACTIONS, ['submit', 'resubmit', 'approve', 'request_revision']);
  assert.deepEqual(newProjectExternalActionToInternal('request', 'todo'), { ok: true, action: 'submit' });
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
  const tableMatches = [...migration.matchAll(/CREATE TABLE IF NOT EXISTS\s+(peakos_structured_[a-z_]+)/gi)];
  assert.deepEqual(tableMatches.map(match => match[1]), NEW_PROJECT_REQUIRED_TABLES);
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

test('operator migration grants the configurable runtime role only required DML and sequence privileges', () => {
  assert.match(migration, /current_setting\('peakos\.app_role', TRUE\)/i);
  assert.match(migration, /rolname = 'calendar_user'/i);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE %I TO %I/i);
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE peakos_structured_project_history TO %I/i);
  assert.match(migration, /GRANT USAGE, SELECT ON SEQUENCE peakos_structured_project_history_id_seq/i);
  assert.doesNotMatch(migration, /GRANT[^;]*\bDELETE\b/i);
  assert.doesNotMatch(migration, /ALTER\s+(?:TABLE|SEQUENCE)[\s\S]{0,100}\sOWNER\s+TO/i);
});
