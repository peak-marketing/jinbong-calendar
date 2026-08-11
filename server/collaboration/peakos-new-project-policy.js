'use strict';

const NEW_PROJECT_TABLES = Object.freeze({
  projects: 'peakos_structured_projects',
  members: 'peakos_structured_project_members',
  mediumCategories: 'peakos_structured_project_medium_categories',
  smallCategories: 'peakos_structured_project_small_categories',
  tasks: 'peakos_structured_project_tasks',
  history: 'peakos_structured_project_history',
});

const NEW_PROJECT_REQUIRED_COLUMNS = Object.freeze({
  [NEW_PROJECT_TABLES.projects]: Object.freeze([
    'workspace_id', 'id', 'name', 'description', 'lead_uid', 'lead_name_snapshot',
    'status', 'sort_order', 'version', 'created_by_uid', 'created_by_name_snapshot',
    'created_at', 'updated_at',
  ]),
  [NEW_PROJECT_TABLES.members]: Object.freeze([
    'workspace_id', 'project_id', 'user_uid', 'user_name_snapshot', 'role',
    'active', 'sort_order', 'version', 'added_by_uid', 'added_by_name_snapshot',
    'created_at', 'updated_at',
  ]),
  [NEW_PROJECT_TABLES.mediumCategories]: Object.freeze([
    'workspace_id', 'project_id', 'id', 'name', 'description', 'active',
    'sort_order', 'version', 'created_by_uid', 'created_by_name_snapshot',
    'created_at', 'updated_at',
  ]),
  [NEW_PROJECT_TABLES.smallCategories]: Object.freeze([
    'workspace_id', 'project_id', 'medium_category_id', 'id', 'name',
    'description', 'active', 'sort_order', 'version', 'created_by_uid',
    'created_by_name_snapshot', 'created_at', 'updated_at',
  ]),
  [NEW_PROJECT_TABLES.tasks]: Object.freeze([
    'workspace_id', 'project_id', 'medium_category_id', 'small_category_id',
    'id', 'title', 'description', 'status', 'assignee_uid',
    'assignee_name_snapshot', 'assigned_by_uid', 'assigned_by_name_snapshot',
    'reviewer_uid', 'reviewer_name_snapshot', 'reviewer_source', 'due_date', 'sort_order',
    'version', 'last_note', 'review_requested_at', 'reviewed_at',
    'status_changed_at', 'created_by_uid', 'created_by_name_snapshot',
    'created_at', 'updated_at',
  ]),
  [NEW_PROJECT_TABLES.history]: Object.freeze([
    'id', 'workspace_id', 'project_id', 'entity_type', 'entity_id', 'task_id',
    'action', 'actor_uid', 'actor_name_snapshot', 'from_status', 'to_status',
    'note', 'entity_version', 'metadata', 'created_at',
  ]),
});

const NEW_PROJECT_REQUIRED_CONSTRAINTS = Object.freeze({
  [NEW_PROJECT_TABLES.projects]: Object.freeze([
    'peakos_structured_projects_pkey',
    'peakos_structured_projects_workspace_fk',
    'peakos_structured_projects_lead_membership_fk',
    'peakos_structured_projects_lead_project_member_fk',
  ]),
  [NEW_PROJECT_TABLES.members]: Object.freeze([
    'peakos_structured_project_members_pkey',
    'peakos_structured_project_members_project_fk',
    'peakos_structured_project_members_user_membership_fk',
  ]),
  [NEW_PROJECT_TABLES.mediumCategories]: Object.freeze([
    'peakos_structured_project_medium_categories_pkey',
    'peakos_structured_project_medium_project_fk',
  ]),
  [NEW_PROJECT_TABLES.smallCategories]: Object.freeze([
    'peakos_structured_project_small_categories_pkey',
    'peakos_structured_project_small_medium_fk',
  ]),
  [NEW_PROJECT_TABLES.tasks]: Object.freeze([
    'peakos_structured_project_tasks_pkey',
    'peakos_structured_project_tasks_small_hierarchy_fk',
    'peakos_structured_project_tasks_assignee_fk',
  ]),
  [NEW_PROJECT_TABLES.history]: Object.freeze([
    'peakos_structured_project_history_pkey',
    'peakos_structured_project_history_project_fk',
    'peakos_structured_project_history_task_fk',
  ]),
});

const NEW_PROJECT_REQUIRED_TRIGGERS = Object.freeze([
  Object.freeze([NEW_PROJECT_TABLES.projects, 'peakos_structured_projects_active_lead_guard']),
  Object.freeze([NEW_PROJECT_TABLES.members, 'peakos_structured_project_members_active_lead_guard']),
  Object.freeze([NEW_PROJECT_TABLES.history, 'peakos_structured_project_history_no_mutation']),
]);

const NEW_PROJECT_REQUIRED_TABLES = Object.freeze(Object.values(NEW_PROJECT_TABLES));
const NEW_PROJECT_MIGRATION_FILE = '20260811_peakos_structured_projects.sql';

// Startup code must only check readiness. Applying the operator-run migration
// from an API process could leave different replicas on different schemas.
const NEW_PROJECT_SCHEMA_READINESS_SQL = `
WITH required_columns(table_name, column_name) AS (
  VALUES
    ${Object.entries(NEW_PROJECT_REQUIRED_COLUMNS)
      .flatMap(([table, columns]) => columns.map(column => `('${table}', '${column}')`))
      .join(',\n    ')}
), required_constraints(table_name, constraint_name) AS (
  VALUES
    ${Object.entries(NEW_PROJECT_REQUIRED_CONSTRAINTS)
      .flatMap(([table, constraints]) => constraints.map(constraint => `('${table}', '${constraint}')`))
      .join(',\n    ')}
), required_triggers(table_name, trigger_name) AS (
  VALUES
    ${NEW_PROJECT_REQUIRED_TRIGGERS
      .map(([table, trigger]) => `('${table}', '${trigger}')`)
      .join(',\n    ')}
), missing AS (
  SELECT 'column:' || required_columns.table_name || '.' || required_columns.column_name AS requirement
  FROM required_columns
  LEFT JOIN information_schema.columns actual
    ON actual.table_schema = 'public'
   AND actual.table_name = required_columns.table_name
   AND actual.column_name = required_columns.column_name
  WHERE actual.column_name IS NULL
  UNION ALL
  SELECT 'constraint:' || required_constraints.table_name || '.' || required_constraints.constraint_name
  FROM required_constraints
  LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
  LEFT JOIN pg_class relation
    ON relation.relnamespace = namespace.oid
   AND relation.relname = required_constraints.table_name
  LEFT JOIN pg_constraint actual
    ON actual.conrelid = relation.oid
   AND actual.conname = required_constraints.constraint_name
  WHERE actual.oid IS NULL
  UNION ALL
  SELECT 'trigger:' || required_triggers.table_name || '.' || required_triggers.trigger_name
  FROM required_triggers
  LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
  LEFT JOIN pg_class relation
    ON relation.relnamespace = namespace.oid
   AND relation.relname = required_triggers.table_name
  LEFT JOIN pg_trigger actual
    ON actual.tgrelid = relation.oid
   AND actual.tgname = required_triggers.trigger_name
   AND NOT actual.tgisinternal
  WHERE actual.oid IS NULL
)
SELECT
  NOT EXISTS (SELECT 1 FROM missing) AS ready,
  COALESCE(array_agg(requirement ORDER BY requirement)
    FILTER (WHERE requirement IS NOT NULL), ARRAY[]::text[]) AS missing_requirements
FROM missing
`.trim();

const NEW_PROJECT_PROJECT_STATUSES = Object.freeze(['active', 'completed', 'archived']);
const NEW_PROJECT_TASK_STATUSES = Object.freeze(['todo', 'doing', 'review', 'revision', 'done']);
// These are the only actions accepted from the UI/API. `request` is mapped to
// submit or resubmit from the locked row's current status. Internal action names
// are history labels only and must never be trusted from a client body.
const NEW_PROJECT_TASK_ACTIONS = Object.freeze(['request', 'approve', 'revision']);
const NEW_PROJECT_INTERNAL_TASK_ACTIONS = Object.freeze(['submit', 'resubmit', 'approve', 'request_revision']);
const NEW_PROJECT_MEMBER_ROLES = Object.freeze(['lead', 'member']);
const NOTE_REQUIRED_ACTIONS = new Set(['revision']);
const SORT_ORDER_BOUND = 1_000_000;
const VERSION_BOUND = 2_147_483_647;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const ISO_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const ACTION_TRANSITIONS = Object.freeze({
  submit: Object.freeze({ from: Object.freeze(['todo', 'doing']), to: 'review', actor: 'assignee' }),
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
  isAssignee = false,
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
  if (isProjectLead || isProjectMember || isAssignee) {
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
  leadUid = '',
  leadName = '',
} = {}) {
  const assignee = normalizeNewProjectUid(assigneeUid, '업무 담당자');
  if (!assignee.ok) return assignee;

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
    if (status === 'todo' || status === 'doing') return { ok: true, action: 'submit' };
    return invalid('NEW_PROJECT_TASK_TRANSITION_FORBIDDEN', '현재 상태에서는 검토를 요청할 수 없습니다.');
  }
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

module.exports = {
  ACTION_TRANSITIONS,
  NEW_PROJECT_INTERNAL_TASK_ACTIONS,
  NEW_PROJECT_MEMBER_ROLES,
  NEW_PROJECT_MIGRATION_FILE,
  NEW_PROJECT_PROJECT_STATUSES,
  NEW_PROJECT_REQUIRED_COLUMNS,
  NEW_PROJECT_REQUIRED_CONSTRAINTS,
  NEW_PROJECT_REQUIRED_TABLES,
  NEW_PROJECT_REQUIRED_TRIGGERS,
  NEW_PROJECT_SCHEMA_READINESS_SQL,
  NEW_PROJECT_TABLES,
  NEW_PROJECT_TASK_ACTIONS,
  NEW_PROJECT_TASK_STATUSES,
  NOTE_REQUIRED_ACTIONS,
  SORT_ORDER_BOUND,
  VERSION_BOUND,
  newProjectCreateDecision,
  newProjectMutationDecision,
  newProjectExternalActionToInternal,
  newProjectReadDecision,
  newProjectSchemaReadiness,
  newProjectTaskTransitionDecision,
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
