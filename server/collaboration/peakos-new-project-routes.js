'use strict';

const crypto = require('node:crypto');
const {
  NEW_PROJECT_PROJECT_STATUSES,
  NEW_PROJECT_SCHEMA_READINESS_SQL,
  newProjectCreateDecision,
  newProjectReadDecision,
  newProjectSchemaReadiness,
  newProjectVisibleMediums,
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
  MEETING_ATTENDEE_LIMIT,
  MEETING_STATUSES,
  newProjectMeetingManageDecision,
  normalizeMeetingSchedule,
  normalizeMeetingTime,
} = require('./peakos-new-project-policy');

const NEW_PROJECT_BASE_PATH = '/api/new-projects';

class NewProjectHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'NewProjectHttpError';
    this.status = status;
    this.code = code;
  }
}

function requestIsPreview(req) {
  const raw = typeof req?.get === 'function'
    ? req.get('x-peakos-preview')
    : req?.headers?.['x-peakos-preview'];
  return /^(?:1|true|yes|on)$/i.test(String(raw || '').trim());
}

function actorName(req) {
  return String(req?.userDoc?.name || req?.userName || req?.userEmail || '사용자').trim().slice(0, 160) || '사용자';
}

function sendError(res, error) {
  const status = Number(error?.status || error?.statusCode) || 500;
  const code = String(error?.code || 'NEW_PROJECT_INTERNAL_ERROR');
  const message = status >= 500 ? '신규 프로젝트를 처리하지 못했습니다.' : error.message;
  return res.status(status).json({ code, error: message });
}

function validationValue(result) {
  if (result?.ok) {
    return Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
  }
  throw new NewProjectHttpError(result?.status || 400, result?.code || 'NEW_PROJECT_BODY_INVALID', result?.error || '요청 형식이 올바르지 않습니다.');
}

function assertAllowed(decision) {
  if (decision?.allowed) return decision;
  throw new NewProjectHttpError(decision?.status || 403, decision?.code || 'NEW_PROJECT_FORBIDDEN', decision?.error || '권한이 없습니다.');
}

function normalizeUidList(value, field = '구성원') {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 250) {
    throw new NewProjectHttpError(400, 'NEW_PROJECT_MEMBER_LIST_INVALID', `${field} 목록이 올바르지 않습니다.`);
  }
  const result = [];
  const seen = new Set();
  for (const raw of value) {
    const uid = validationValue(normalizeNewProjectUid(raw, field));
    if (seen.has(uid)) continue;
    seen.add(uid);
    result.push(uid);
  }
  return result;
}

function normalizeCategoryBody(body, { update = false, level = 'small' } = {}) {
  const keys = update
    ? ['name', 'description', 'sortOrder', 'expectedVersion']
    : ['name', 'description', 'sortOrder'];
  if (level === 'medium') keys.push('managerUid');
  validationValue(normalizeStrictObject(body, keys, '업무 분류'));
  const result = {};
  if (!update || body.name !== undefined) {
    result.name = validationValue(normalizeNewProjectDisplayName(body.name, '업무 분류명'));
  }
  if (!update || body.description !== undefined) {
    result.description = validationValue(normalizeNewProjectText(body.description, {
      field: '업무 분류 설명', required: false, max: 10000,
    }));
  }
  if (!update || body.sortOrder !== undefined) {
    result.sortOrder = validationValue(normalizeNewProjectSortOrder(body.sortOrder));
  }
  // managerUid stays optional at the API boundary while an older static client
  // may still be cached during rollout. The current UI requires it for new
  // mediums; omission preserves an existing NULL/assignment without guessing.
  if (level === 'medium' && body.managerUid !== undefined) {
    result.managerUid = validationValue(normalizeNewProjectUid(body.managerUid, '업무 중분류 담당자'));
  }
  if (update) result.expectedVersion = validationValue(normalizeNewProjectExpectedVersion(body.expectedVersion));
  if (update && Object.keys(result).length === 1) {
    throw new NewProjectHttpError(400, 'NEW_PROJECT_BODY_EMPTY', '변경할 업무 분류 내용을 입력해 주세요.');
  }
  return result;
}

const TASK_ATTACHMENT_LIMIT = 20;
const TASK_ATTACHMENT_URL = /^\/uploads\/[A-Za-z0-9._-]{1,180}$/;

// 첨부는 클라이언트가 보내는 메타데이터라 서버에서 반드시 좁힌다.
// 업로드 라우트가 만든 /uploads 경로만 허용해 외부 URL이 섞이지 않게 한다.
function normalizeTaskAttachments(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new NewProjectHttpError(400, 'NEW_PROJECT_TASK_ATTACHMENTS_INVALID', '첨부파일 목록 형식이 올바르지 않습니다.');
  }
  if (value.length > TASK_ATTACHMENT_LIMIT) {
    throw new NewProjectHttpError(400, 'NEW_PROJECT_TASK_ATTACHMENTS_TOO_MANY', `첨부파일은 최대 ${TASK_ATTACHMENT_LIMIT}개까지 올릴 수 있습니다.`);
  }
  return value.map(item => {
    const url = String(item?.url || '').trim();
    if (!TASK_ATTACHMENT_URL.test(url)) {
      throw new NewProjectHttpError(400, 'NEW_PROJECT_TASK_ATTACHMENT_URL_INVALID', '업로드한 파일만 첨부할 수 있습니다.');
    }
    const size = Number(item?.size);
    return {
      url,
      name: String(item?.name || '').trim().slice(0, 200) || url.split('/').pop(),
      size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : null,
      mimeType: String(item?.mimeType || '').trim().slice(0, 120) || null,
    };
  });
}

function normalizeTaskCreateBody(body) {
  validationValue(normalizeStrictObject(
    body,
    ['title', 'description', 'dueDate', 'assigneeUid', 'assignedByUid', 'reviewerUid', 'sortOrder', 'attachments'],
    '체크리스트 업무',
  ));
  return {
    title: validationValue(normalizeNewProjectText(body.title, { field: '업무명', max: 240 })),
    description: validationValue(normalizeNewProjectText(body.description, {
      field: '업무 설명', required: false, max: 20000,
    })),
    dueDate: validationValue(normalizeNewProjectDate(body.dueDate)),
    attachments: normalizeTaskAttachments(body.attachments) ?? [],
    reviewerUid: body.reviewerUid === undefined || body.reviewerUid === ''
      ? ''
      : validationValue(normalizeNewProjectUid(body.reviewerUid, '업무 검토자')),
    assigneeUid: validationValue(normalizeNewProjectUid(body.assigneeUid, '업무 담당자')),
    // assignedByUid is optional only for a cached pre-rollout client. The
    // current UI always sends an explicit instructor; omission falls back to
    // the authenticated actor below without ever trusting a client name.
    assignedByUid: body.assignedByUid === undefined
      ? undefined
      : validationValue(normalizeNewProjectUid(body.assignedByUid, '업무 지시자')),
    sortOrder: validationValue(normalizeNewProjectSortOrder(body.sortOrder)),
  };
}

function normalizeTaskUpdateBody(body) {
  validationValue(normalizeStrictObject(
    body,
    ['title', 'description', 'dueDate', 'assigneeUid', 'assignedByUid', 'reviewerUid', 'sortOrder', 'expectedVersion', 'attachments'],
    '체크리스트 업무 수정',
  ));
  const result = {
    expectedVersion: validationValue(normalizeNewProjectExpectedVersion(body.expectedVersion)),
  };
  if (body.title !== undefined) {
    result.title = validationValue(normalizeNewProjectText(body.title, { field: '업무명', max: 240 }));
  }
  if (body.description !== undefined) {
    result.description = validationValue(normalizeNewProjectText(body.description, {
      field: '업무 설명', required: false, max: 20000,
    }));
  }
  if (body.attachments !== undefined) {
    result.attachments = normalizeTaskAttachments(body.attachments);
  }
  if (body.reviewerUid !== undefined) {
    result.reviewerUid = body.reviewerUid === ''
      ? ''
      : validationValue(normalizeNewProjectUid(body.reviewerUid, '업무 검토자'));
  }
  if (body.dueDate !== undefined) result.dueDate = validationValue(normalizeNewProjectDate(body.dueDate));
  if (body.assigneeUid !== undefined) {
    result.assigneeUid = validationValue(normalizeNewProjectUid(body.assigneeUid, '업무 담당자'));
  }
  if (body.assignedByUid !== undefined) {
    result.assignedByUid = validationValue(normalizeNewProjectUid(body.assignedByUid, '업무 지시자'));
  }
  if (body.sortOrder !== undefined) result.sortOrder = validationValue(normalizeNewProjectSortOrder(body.sortOrder));
  if (Object.keys(result).length === 1) {
    throw new NewProjectHttpError(400, 'NEW_PROJECT_BODY_EMPTY', '변경할 업무 내용을 입력해 주세요.');
  }
  return result;
}

function mapMember(row) {
  return {
    uid: row.user_uid,
    name: row.user_name_snapshot,
    role: row.role,
    active: row.active === true,
    sortOrder: Number(row.sort_order || 0),
    version: Number(row.version || 1),
  };
}

function mapMediumManager(row) {
  if (!row?.manager_uid) return null;
  return {
    uid: String(row.manager_uid),
    name: String(row.manager_name_snapshot || ''),
  };
}

function taskCapabilities(task, context) {
  const mutable = !context.readOnly && context.canManage && !['review', 'done'].includes(task.status);
  const assignmentMutable = !context.readOnly && context.canManage && task.status !== 'done';
  const isAssignee = String(task.assignee_uid) === String(context.uid);
  const isReviewer = String(task.reviewer_uid) === String(context.uid);
  const canReview = !context.readOnly && task.status === 'review' && isReviewer;
  return {
    edit: mutable,
    // A manager must be able to recover a review that can no longer reach its
    // stored reviewer after membership or project access was revoked.
    reassign: assignmentMutable,
    submit: !context.readOnly && isAssignee && ['todo', 'acknowledged', 'doing', 'revision'].includes(task.status),
    approve: canReview,
    requestRevision: canReview,
  };
}

function mapTask(row, context, history = []) {
  return {
    id: String(row.id),
    title: row.title,
    description: row.description || '',
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    status: row.status,
    dueDate: row.due_date || null,
    sortOrder: Number(row.sort_order || 0),
    workflowVersion: Number(row.version || 1),
    version: Number(row.version || 1),
    assignedBy: { uid: row.assigned_by_uid, name: row.assigned_by_name_snapshot },
    assignee: { uid: row.assignee_uid, name: row.assignee_name_snapshot },
    reviewer: {
      uid: row.reviewer_uid,
      name: row.reviewer_name_snapshot,
      source: row.reviewer_source,
    },
    revisionReason: row.status === 'revision' ? (row.last_note || '') : '',
    lastNote: row.last_note || '',
    reviewRequestedAt: row.review_requested_at || null,
    reviewedAt: row.reviewed_at || null,
    statusChangedAt: row.status_changed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    history,
    capabilities: taskCapabilities(row, context),
  };
}

function mapHistory(row) {
  return {
    id: String(row.id),
    action: row.action,
    actor: { uid: row.actor_uid, name: row.actor_name_snapshot },
    fromStatus: row.from_status || '',
    toStatus: row.to_status || '',
    note: row.note || '',
    workflowVersion: Number(row.entity_version || 1),
    createdAt: row.created_at,
  };
}

function mapProjectSummary(row) {
  return {
    id: String(row.id),
    name: row.name,
    description: row.description || '',
    status: row.status,
    version: Number(row.version || 1),
    lead: { uid: row.lead_uid, name: row.lead_name_snapshot },
    createdBy: { uid: row.created_by_uid, name: row.created_by_name_snapshot },
    members: Array.isArray(row.members) ? row.members : [],
    mediumCount: Number(row.medium_count || 0),
    taskCount: Number(row.task_count || 0),
    doneTaskCount: Number(row.done_task_count || 0),
    reviewTaskCount: Number(row.review_task_count || 0),
    nearestDueDate: row.nearest_due_date || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function ensurePeakosNewProjectInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  const result = await pool.query(NEW_PROJECT_SCHEMA_READINESS_SQL);
  const readiness = newProjectSchemaReadiness(result.rows[0]);
  if (!readiness.ready) {
    const error = new Error(readiness.error);
    error.code = readiness.code;
    error.missing = readiness.missing;
    throw error;
  }
  return readiness;
}

function createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator }) {
  const workspace = req.workspace || {};
  let portfolioAccess = false;
  let portfolioCreateAccess = false;
  try {
    portfolioAccess = isPortfolioViewer(req) === true;
    portfolioCreateAccess = isPortfolioCreator(req) === true;
  } catch (error) {
    throw new NewProjectHttpError(503, 'NEW_PROJECT_PORTFOLIO_POLICY_UNAVAILABLE', '신규 프로젝트 열람 정책을 확인할 수 없습니다.');
  }
  const hasPortfolioAccess = portfolioAccess;
  const isOversight = workspace.headquartersOversight === true || workspace.role === 'oversight';
  const isDirectWorkspaceMember = !!workspace.id && !isOversight;
  const isNonPeakManager = isDirectWorkspaceMember
    && workspace.id !== peakWorkspaceId
    && ['admin', 'manager'].includes(workspace.role);
  const createDecision = newProjectCreateDecision({
    preview: requestIsPreview(req),
    isOversight,
    isPortfolioCreator: workspace.id === peakWorkspaceId && portfolioCreateAccess,
    isDirectWorkspaceMember,
    workspaceRole: workspace.role,
    canManageWorkspaceProjects: workspace.id !== peakWorkspaceId,
  });
  return {
    uid: String(req.uid || ''),
    name: actorName(req),
    workspace,
    workspaceId: String(workspace.id || ''),
    isPeakWorkspace: workspace.id === peakWorkspaceId,
    isPreview: requestIsPreview(req),
    isPortfolioViewer: hasPortfolioAccess,
    isOversight,
    isDirectWorkspaceMember,
    isNonPeakManager,
    // Existing workspace policy grants all four HQ oversight memberships a
    // read-only branch portfolio. Peak HQ itself remains the exact-three UID
    // portfolio; oversight never gains create or mutation capability.
    viewPortfolio: hasPortfolioAccess || isNonPeakManager || isOversight,
    canCreateProject: createDecision.allowed === true,
    readOnly: isOversight,
  };
}

async function resolveWorkspaceUsers(db, workspaceId, uids) {
  const unique = [...new Set(uids.map(uid => String(uid || '')).filter(Boolean))];
  if (!unique.length) return new Map();
  const result = await db.query(
    `SELECT u.uid, u.name
       FROM users u
       JOIN peakos_workspace_memberships membership
         ON membership.user_uid = u.uid
        AND membership.workspace_id = $1
        AND membership.active = TRUE
        AND membership.role <> 'oversight'
        AND COALESCE(membership.permissions ->> 'projects', 'none') IN ('read', 'write')
       JOIN peakos_workspaces workspace
         ON workspace.id = membership.workspace_id
        AND workspace.active = TRUE
      WHERE u.uid = ANY($2::text[])
        AND u.approved = TRUE
        AND COALESCE(u.is_active, TRUE) = TRUE
        AND COALESCE(u.chat_only, FALSE) = FALSE
        AND COALESCE(u.external_calendar_only, FALSE) = FALSE
      FOR KEY SHARE OF u, membership`,
    [workspaceId, unique],
  );
  const byUid = new Map(result.rows.map(row => [String(row.uid), { uid: String(row.uid), name: String(row.name || '사용자') }]));
  if (byUid.size !== unique.length || unique.some(uid => !byUid.has(uid))) {
    throw new NewProjectHttpError(400, 'NEW_PROJECT_WORKSPACE_USER_INVALID', '선택한 담당자·구성원 중 현재 조직에 속하지 않는 계정이 있습니다.');
  }
  return byUid;
}

async function resolveMediumManager(db, context, projectId, managerUid) {
  if (managerUid === undefined) return undefined;
  const users = await resolveWorkspaceUsers(db, context.workspaceId, [managerUid]);
  const member = await db.query(
    `SELECT 1 FROM peakos_structured_project_members
      WHERE workspace_id = $1 AND project_id = $2 AND user_uid = $3 AND active = TRUE`,
    [context.workspaceId, projectId, managerUid],
  );
  if (!member.rows[0]) {
    throw new NewProjectHttpError(
      400,
      'NEW_PROJECT_MEDIUM_MANAGER_NOT_MEMBER',
      '업무 중분류 담당자는 프로젝트 팀원이어야 합니다.',
    );
  }
  return users.get(managerUid);
}

async function loadProjectAccess(db, context, projectId, { lock = false } = {}) {
  const result = await db.query(
    `SELECT p.*,
            EXISTS (
              SELECT 1 FROM peakos_structured_project_members member
               WHERE member.workspace_id = p.workspace_id
                 AND member.project_id = p.id
                 AND member.user_uid = $3
                 AND member.active = TRUE
            ) AS is_project_member
       FROM peakos_structured_projects p
      WHERE p.workspace_id = $1 AND p.id = $2
      ${lock ? 'FOR UPDATE' : ''}`,
    [context.workspaceId, projectId, context.uid],
  );
  const project = result.rows[0];
  if (!project) throw new NewProjectHttpError(404, 'NEW_PROJECT_NOT_FOUND', '신규 프로젝트를 찾을 수 없습니다.');
  const isLead = String(project.lead_uid) === context.uid;
  assertAllowed(newProjectReadDecision({
    preview: context.isPreview,
    isPortfolioViewer: context.viewPortfolio,
    isDirectWorkspaceMember: context.isDirectWorkspaceMember,
    workspaceRole: context.workspace.role,
    canReadWorkspacePortfolio: context.isNonPeakManager,
    isProjectLead: isLead,
    isProjectMember: project.is_project_member === true,
  }));
  const isManagerMember = context.isNonPeakManager
    && project.is_project_member === true;
  const canManage = !context.isPreview && !context.isOversight && (isLead || isManagerMember);
  // Peak's exact-three portfolio capability is deliberately narrower than
  // project management. A creator who remains an active member may correct
  // the project's lead/member settings, but does not gain category or task
  // assignment rights unless they are the current lead. This is UID-backed;
  // display names and generic users.role values are never consulted.
  const isPeakCreatorMember = context.isPeakWorkspace
    && context.isPortfolioViewer
    && String(project.created_by_uid) === context.uid
    && project.is_project_member === true;
  return {
    project,
    isLead,
    isManagerMember,
    canManage,
    canEditProjectSettings: canManage
      || (!context.isPreview && !context.isOversight && isPeakCreatorMember),
  };
}

function assertCanManage(access) {
  if (access.canManage) return;
  throw new NewProjectHttpError(403, 'NEW_PROJECT_MUTATION_FORBIDDEN', '프로젝트 담당자 또는 프로젝트에 참여 중인 조직 관리자만 변경할 수 있습니다.');
}

function assertCanEditProjectSettings(access) {
  if (access.canEditProjectSettings) return;
  throw new NewProjectHttpError(403, 'NEW_PROJECT_MUTATION_FORBIDDEN', '프로젝트 설정을 변경할 권한이 없습니다.');
}

function assertProjectMutable(project) {
  if (project.status === 'active') return;
  throw new NewProjectHttpError(409, 'NEW_PROJECT_NOT_ACTIVE', '진행 중인 프로젝트에서만 업무를 변경할 수 있습니다.');
}

async function recordHistory(db, {
  context,
  projectId,
  entityType,
  entityId,
  taskId = null,
  action,
  fromStatus = '',
  toStatus = '',
  note = '',
  version,
  metadata = {},
}) {
  await db.query(
    `INSERT INTO peakos_structured_project_history
       (workspace_id, project_id, entity_type, entity_id, task_id, action,
        actor_uid, actor_name_snapshot, from_status, to_status, note, entity_version, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
    [
      context.workspaceId, projectId, entityType, String(entityId), taskId, action,
      context.uid, context.name, fromStatus, toStatus, String(note || '').slice(0, 4000),
      version, JSON.stringify(metadata || {}),
    ],
  );
}


// 회의 주최자·참석자는 모두 이 프로젝트의 살아 있는 팀원이어야 한다.
// 한 명이라도 아니면 회의 자체를 만들지 않는다.
async function resolveProjectMembers(db, context, projectId, uids) {
  const unique = [...new Set(uids.map(uid => String(uid || '')).filter(Boolean))];
  const found = new Map();
  for (const uid of unique) {
    const person = await findActiveProjectNotificationRecipient(
      db, context.workspaceId, projectId, uid, { lockWorkspaceMembership: true },
    );
    if (!person) {
      throw new NewProjectHttpError(400, 'NEW_PROJECT_MEETING_MEMBER_INVALID',
        '회의 주최자·참석자는 이 프로젝트의 팀원이어야 합니다.');
    }
    found.set(uid, person);
  }
  return found;
}

async function safeNotify(notifyUser, uid, title, body, data) {
  if (!uid || typeof notifyUser !== 'function') return;
  try {
    await notifyUser(uid, title, body, data);
  } catch (_) {
    // A push delivery failure must not roll back a committed workflow action.
  }
}

function structuredProjectNotificationLink(context, projectId, taskId = '') {
  const explicitSlug = String(context?.workspace?.slug || '').trim().toLowerCase();
  const derivedSlug = String(context?.workspaceId || '')
    .replace(/^ws_/, '')
    .replaceAll('_', '-');
  const workspaceSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(explicitSlug)
    ? explicitSlug
    : (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(derivedSlug) ? derivedSlug : 'peak');
  const query = new URLSearchParams({ view: 'new-projects', projectId: String(projectId) });
  if (taskId) query.set('taskId', String(taskId));
  return `/os/w/${encodeURIComponent(workspaceSlug)}/?${query.toString()}`;
}

async function findActiveProjectNotificationRecipient(
  db,
  workspaceId,
  projectId,
  uid,
  { lockWorkspaceMembership = false } = {},
) {
  if (!uid) return null;
  const result = await db.query(
    `SELECT user_row.uid, user_row.name
       FROM users user_row
       JOIN peakos_workspace_memberships workspace_member
         ON workspace_member.user_uid = user_row.uid
        AND workspace_member.workspace_id = $1
        AND workspace_member.active = TRUE
        AND workspace_member.role <> 'oversight'
        AND COALESCE(workspace_member.permissions ->> 'projects', 'none') IN ('read', 'write')
       JOIN peakos_workspaces workspace
         ON workspace.id = workspace_member.workspace_id
        AND workspace.active = TRUE
       JOIN peakos_structured_project_members project_member
         ON project_member.workspace_id = workspace_member.workspace_id
        AND project_member.project_id = $2
        AND project_member.user_uid = workspace_member.user_uid
        AND project_member.active = TRUE
      WHERE user_row.uid = $3
        AND user_row.approved = TRUE
        AND COALESCE(user_row.is_active, TRUE) = TRUE
        AND COALESCE(user_row.chat_only, FALSE) = FALSE
        AND COALESCE(user_row.external_calendar_only, FALSE) = FALSE
      LIMIT 1
      ${lockWorkspaceMembership ? 'FOR KEY SHARE OF workspace_member, project_member' : ''}`,
    [workspaceId, projectId, uid],
  );
  const row = result.rows[0];
  return row ? { uid: String(row.uid), name: String(row.name || '') } : null;
}

async function safeNotifyProjectMember(
  db,
  notifyUser,
  { workspaceId, projectId, uid, title, body, data },
) {
  try {
    const recipient = await findActiveProjectNotificationRecipient(
      db, workspaceId, projectId, uid,
    );
    if (!recipient) return false;
    await safeNotify(notifyUser, recipient.uid, title, body, data);
    return true;
  } catch (_) {
    // The workflow mutation has already committed. Recipient lookup and push
    // delivery are best-effort and must never turn a committed change into a
    // 500 response that the client could mistakenly retry.
    return false;
  }
}


function normalizeMeetingBody(body, { update = false } = {}) {
  const keys = ['title', 'description', 'location', 'startDate', 'endDate',
    'startTime', 'endTime', 'organizerUid', 'attendeeUids', 'smallId'];
  if (update) keys.push('expectedVersion', 'status');
  validationValue(normalizeStrictObject(body, keys, '회의'));
  const result = {};
  if (!update || body.title !== undefined) {
    result.title = validationValue(normalizeNewProjectDisplayName(body.title, '회의명'));
  }
  if (!update || body.description !== undefined) {
    result.description = validationValue(normalizeNewProjectText(body.description, {
      field: '회의 설명', required: false, max: 10000,
    }));
  }
  if (!update || body.location !== undefined) {
    result.location = validationValue(normalizeNewProjectText(body.location, {
      field: '회의 장소', required: false, max: 300,
    }));
  }
  if (!update || body.startDate !== undefined) {
    result.startDate = validationValue(normalizeNewProjectDate(body.startDate, { required: true }));
  }
  // 종료일을 비우면 하루짜리 회의로 본다.
  if (!update || body.endDate !== undefined) {
    result.endDate = validationValue(normalizeNewProjectDate(body.endDate)) || result.startDate || null;
  }
  if (!update || body.startTime !== undefined) {
    result.startTime = validationValue(normalizeMeetingTime(body.startTime, '시작 시간'));
  }
  if (!update || body.endTime !== undefined) {
    result.endTime = validationValue(normalizeMeetingTime(body.endTime, '종료 시간'));
  }
  if (!update || body.organizerUid !== undefined) {
    result.organizerUid = validationValue(normalizeNewProjectUid(body.organizerUid, '회의 주최자'));
  }
  if (!update || body.attendeeUids !== undefined) {
    const attendees = normalizeUidList(body.attendeeUids, '회의 참석자') || [];
    if (attendees.length > MEETING_ATTENDEE_LIMIT) {
      throw new NewProjectHttpError(400, 'NEW_PROJECT_MEETING_ATTENDEES_INVALID',
        `회의 참석자는 ${MEETING_ATTENDEE_LIMIT}명까지 고를 수 있습니다.`);
    }
    result.attendeeUids = attendees;
  }
  if (!update && body.smallId !== undefined && body.smallId !== null && body.smallId !== '') {
    result.smallId = validationValue(normalizeNewProjectId(body.smallId, '소분류 ID'));
  }
  if (update && body.status !== undefined) {
    result.status = validationValue(normalizeNewProjectEnum(body.status, MEETING_STATUSES, '회의 상태'));
  }
  if (update) result.expectedVersion = validationValue(normalizeNewProjectExpectedVersion(body.expectedVersion));
  return result;
}

function mapMeeting(row, attendees = [], actionItems = []) {
  return {
    id: String(row.id),
    mediumId: String(row.medium_category_id),
    smallId: row.small_category_id ? String(row.small_category_id) : null,
    title: row.title,
    description: row.description || '',
    location: row.location || '',
    startDate: serializeMeetingDate(row.start_date),
    endDate: serializeMeetingDate(row.end_date),
    startTime: row.start_time || '',
    endTime: row.end_time || '',
    organizer: { uid: String(row.organizer_uid), name: row.organizer_name_snapshot || '' },
    status: row.status,
    version: Number(row.version || 1),
    eventId: row.event_id ? String(row.event_id) : null,
    notes: row.notes || '',
    notesWrittenAt: row.notes_written_at ? new Date(row.notes_written_at).toISOString() : null,
    notesWrittenBy: row.notes_written_by_uid
      ? { uid: String(row.notes_written_by_uid), name: row.notes_written_by_name_snapshot || '' }
      : null,
    attendees: attendees.map(entry => ({ uid: String(entry.user_uid), name: entry.user_name_snapshot || '' })),
    actionItems: actionItems.map(mapMeetingActionItem),
  };
}

// DATE 컬럼은 드라이버가 Date 객체로 준다. toISOString은 UTC로 되돌려
// 한국 기준 하루 전으로 밀리므로 현지 필드를 그대로 쓴다.
function serializeMeetingDate(value) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value || '').slice(0, 10);
}


const MEETING_ACTION_ITEM_LIMIT = 50;

function normalizeMeetingNotesBody(body) {
  validationValue(normalizeStrictObject(body, ['notes', 'actionItems', 'expectedVersion'], '회의록'));
  const notes = validationValue(normalizeNewProjectText(body.notes, {
    field: '회의 결정사항', required: false, max: 20000,
  }));
  if (body.actionItems !== undefined && !Array.isArray(body.actionItems)) {
    throw new NewProjectHttpError(400, 'NEW_PROJECT_MEETING_ACTION_ITEMS_INVALID', '회의에서 나온 할 일 목록이 올바르지 않습니다.');
  }
  const raw = Array.isArray(body.actionItems) ? body.actionItems : [];
  if (raw.length > MEETING_ACTION_ITEM_LIMIT) {
    throw new NewProjectHttpError(400, 'NEW_PROJECT_MEETING_ACTION_ITEMS_INVALID',
      `회의에서 나온 할 일은 ${MEETING_ACTION_ITEM_LIMIT}개까지 적을 수 있습니다.`);
  }
  const actionItems = raw.map((entry, index) => {
    validationValue(normalizeStrictObject(entry, ['id', 'title', 'assigneeUid', 'dueDate'], '회의 할 일'));
    return {
      id: entry.id ? validationValue(normalizeNewProjectId(entry.id, '회의 할 일 ID')) : null,
      title: validationValue(normalizeNewProjectDisplayName(entry.title, '회의 할 일')),
      assigneeUid: entry.assigneeUid ? validationValue(normalizeNewProjectUid(entry.assigneeUid, '회의 할 일 담당자')) : '',
      dueDate: validationValue(normalizeNewProjectDate(entry.dueDate)),
      sortOrder: index,
    };
  });
  return { notes, actionItems, expectedVersion: validationValue(normalizeNewProjectExpectedVersion(body.expectedVersion)) };
}

function mapMeetingActionItem(row) {
  return {
    id: String(row.id),
    title: row.title,
    assignee: row.assignee_uid ? { uid: String(row.assignee_uid), name: row.assignee_name_snapshot || '' } : null,
    dueDate: row.due_date ? serializeMeetingDate(row.due_date) : null,
    taskId: row.task_id ? String(row.task_id) : null,
  };
}

function registerPeakosNewProjectRoutes({
  app,
  pool,
  readMiddlewares = [],
  writeMiddlewares = [],
  peakWorkspaceId,
  isPortfolioViewer,
  isPortfolioCreator,
  notifyUser,
} = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('app이 필요합니다.');
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('pool.query/pool.connect가 필요합니다.');
  }
  if (!peakWorkspaceId || typeof isPortfolioViewer !== 'function' || typeof isPortfolioCreator !== 'function') {
    throw new TypeError('워크스페이스·포트폴리오 정책이 필요합니다.');
  }

  app.get(NEW_PROJECT_BASE_PATH, ...readMiddlewares, async (req, res) => {
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      if (context.isPreview) {
        return res.json({
          readOnly: true,
          preview: true,
          capabilities: { viewPortfolio: false, createProject: false },
          projects: [],
        });
      }
      const result = await pool.query(
        `SELECT p.*,
                COALESCE((
                  SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
                    'uid', member.user_uid,
                    'name', member.user_name_snapshot,
                    'role', member.role
                  ) ORDER BY member.sort_order, member.user_name_snapshot)
                    FROM peakos_structured_project_members member
                   WHERE member.workspace_id = p.workspace_id
                     AND member.project_id = p.id
                     AND member.active = TRUE
                ), '[]'::jsonb) AS members,
                (SELECT COUNT(*)::int
                   FROM peakos_structured_project_medium_categories medium
                  WHERE medium.workspace_id = p.workspace_id
                    AND medium.project_id = p.id AND medium.active = TRUE) AS medium_count,
                (SELECT COUNT(*)::int
                   FROM peakos_structured_project_tasks task
                  WHERE task.workspace_id = p.workspace_id AND task.project_id = p.id) AS task_count,
                (SELECT COUNT(*)::int
                   FROM peakos_structured_project_tasks task
                  WHERE task.workspace_id = p.workspace_id AND task.project_id = p.id
                    AND task.status = 'done') AS done_task_count,
                (SELECT COUNT(*)::int
                   FROM peakos_structured_project_tasks task
                  WHERE task.workspace_id = p.workspace_id AND task.project_id = p.id
                    AND task.status = 'review') AS review_task_count,
                (SELECT MIN(task.due_date)
                   FROM peakos_structured_project_tasks task
                  WHERE task.workspace_id = p.workspace_id AND task.project_id = p.id
                    AND task.status <> 'done' AND task.due_date IS NOT NULL) AS nearest_due_date
           FROM peakos_structured_projects p
          WHERE p.workspace_id = $1
            AND (
              $3::boolean
              OR p.lead_uid = $2
              OR EXISTS (
                SELECT 1 FROM peakos_structured_project_members mine
                 WHERE mine.workspace_id = p.workspace_id AND mine.project_id = p.id
                   AND mine.user_uid = $2 AND mine.active = TRUE
              )
            )
            -- 삭제(보관)한 대분류는 목록에서 감춘다. 행은 남아 있어 되돌릴 수 있다.
            AND p.status IS DISTINCT FROM 'archived'
          ORDER BY CASE p.status WHEN 'active' THEN 0 ELSE 1 END,
                   p.sort_order, p.updated_at DESC, p.id`,
        [context.workspaceId, context.uid, context.viewPortfolio],
      );
      return res.json({
        readOnly: context.readOnly,
        capabilities: {
          viewPortfolio: context.viewPortfolio,
          createProject: context.canCreateProject,
        },
        projects: result.rows.map(mapProjectSummary),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post(NEW_PROJECT_BASE_PATH, ...writeMiddlewares, async (req, res) => {
    let client;
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      if (!context.canCreateProject) {
        throw new NewProjectHttpError(403, 'NEW_PROJECT_CREATE_FORBIDDEN', '이 조직에서 신규 프로젝트를 만들 권한이 없습니다.');
      }
      validationValue(normalizeStrictObject(
        req.body,
        ['name', 'description', 'leadUid', 'memberUids'],
        '신규 프로젝트',
      ));
      const name = validationValue(normalizeNewProjectDisplayName(req.body.name, '프로젝트명'));
      const description = validationValue(normalizeNewProjectText(req.body.description, {
        field: '프로젝트 설명', required: false, max: 10000,
      }));
      const leadUid = validationValue(normalizeNewProjectUid(req.body.leadUid, '프로젝트 담당자'));
      const memberUids = normalizeUidList(req.body.memberUids || [], '프로젝트 구성원');
      const allUids = [...new Set([leadUid, context.uid, ...memberUids])];
      const id = crypto.randomUUID();
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      const users = await resolveWorkspaceUsers(client, context.workspaceId, allUids);
      const lead = users.get(leadUid);
      await client.query(
        `INSERT INTO peakos_structured_projects
           (workspace_id, id, name, description, lead_uid, lead_name_snapshot,
            created_by_uid, created_by_name_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [context.workspaceId, id, name, description, lead.uid, lead.name, context.uid, context.name],
      );
      for (const [index, uid] of allUids.entries()) {
        const user = users.get(uid);
        await client.query(
          `INSERT INTO peakos_structured_project_members
             (workspace_id, project_id, user_uid, user_name_snapshot, role, sort_order,
              added_by_uid, added_by_name_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [context.workspaceId, id, uid, user.name, uid === leadUid ? 'lead' : 'member', index, context.uid, context.name],
        );
      }
      await recordHistory(client, {
        context, projectId: id, entityType: 'project', entityId: id,
        action: 'created', toStatus: 'active', version: 1,
        metadata: { leadUid, memberUids: allUids },
      });
      await client.query('COMMIT');
      await safeNotifyProjectMember(pool, notifyUser, {
        workspaceId: context.workspaceId,
        projectId: id,
        uid: leadUid,
        title: '신규 프로젝트 담당',
        body: `${context.name}님이 "${name}" 프로젝트 담당자로 지정했습니다.`,
        data: {
          kind: 'new-project', newProjectId: id,
          link: structuredProjectNotificationLink(context, id),
        },
      });
      return res.status(201).json({
        project: {
          id, name, description, status: 'active', version: 1,
          lead, createdBy: { uid: context.uid, name: context.name },
          members: allUids.map(uid => ({ ...users.get(uid), role: uid === leadUid ? 'lead' : 'member' })),
        },
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  });

  // 내 업무 — 신규 프로젝트에서 나에게 배정된 업무만 모은다.
  // 기존 파라곤 프로젝트와 섞지 않으려고 별도 경로로 둔다.
  // ':id' 라우트보다 먼저 등록해야 'my-tasks'가 프로젝트 ID로 잡히지 않는다.
  app.get(`${NEW_PROJECT_BASE_PATH}/my-tasks`, ...readMiddlewares, async (req, res) => {
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      if (context.isPreview) {
        return res.json({ readOnly: true, tasks: [] });
      }
      const result = await pool.query(
        `SELECT t.id, t.title, t.description, t.status, t.sort_order,
                TO_CHAR(t.due_date, 'YYYY-MM-DD') AS due_date,
                t.assigned_by_uid, t.assigned_by_name_snapshot,
                t.reviewer_uid, t.reviewer_name_snapshot, t.version,
                t.review_requested_at, t.status_changed_at, t.created_at,
                t.project_id, t.medium_category_id, t.small_category_id,
                t.attachments,
                sp.name AS project_name, sp.status AS project_status,
                m.name AS medium_name, sc.name AS small_name
           FROM peakos_structured_project_tasks t
           JOIN peakos_structured_projects sp
             ON sp.workspace_id = t.workspace_id AND sp.id = t.project_id
           LEFT JOIN peakos_structured_project_medium_categories m
             ON m.workspace_id = t.workspace_id AND m.id = t.medium_category_id
           LEFT JOIN peakos_structured_project_small_categories sc
             ON sc.workspace_id = t.workspace_id AND sc.id = t.small_category_id
          WHERE t.workspace_id = $1
            AND t.assignee_uid = $2
            AND sp.status IS DISTINCT FROM 'archived'
          ORDER BY
            CASE t.status
              WHEN 'revision' THEN 1 WHEN 'review' THEN 2 WHEN 'doing' THEN 3
              WHEN 'todo' THEN 4 WHEN 'done' THEN 5 ELSE 6
            END,
            COALESCE(t.due_date, DATE '9999-12-31'),
            sp.name, t.sort_order, t.created_at`,
        [context.workspaceId, context.uid],
      );
      return res.json({
        readOnly: false,
        tasks: result.rows.map(row => ({
          id: String(row.id),
          title: row.title,
          description: row.description || '',
          status: row.status,
          dueDate: row.due_date || null,
          version: Number(row.version || 1),
          attachments: Array.isArray(row.attachments) ? row.attachments : [],
          assignedBy: { uid: row.assigned_by_uid, name: row.assigned_by_name_snapshot || '' },
          reviewer: { uid: row.reviewer_uid, name: row.reviewer_name_snapshot || '' },
          project: { id: String(row.project_id), name: row.project_name, status: row.project_status },
          medium: { id: row.medium_category_id, name: row.medium_name || '' },
          small: { id: row.small_category_id, name: row.small_name || '' },
          reviewRequestedAt: row.review_requested_at || null,
          statusChangedAt: row.status_changed_at || null,
          createdAt: row.created_at,
        })),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get(`${NEW_PROJECT_BASE_PATH}/:id`, ...readMiddlewares, async (req, res) => {
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      if (context.isPreview) {
        throw new NewProjectHttpError(403, 'NEW_PROJECT_PREVIEW_DATA_HIDDEN', '계정 미리보기에서는 신규 프로젝트 데이터를 볼 수 없습니다.');
      }
      const id = validationValue(normalizeNewProjectId(req.params.id, '프로젝트 ID'));
      const access = await loadProjectAccess(pool, context, id);
      const [membersResult, mediumsResult, smallsResult, tasksResult, historyResult,
        meetingsResult, attendeesResult, actionItemsResult] = await Promise.all([
        pool.query(
          `SELECT * FROM peakos_structured_project_members
            WHERE workspace_id = $1 AND project_id = $2 AND active = TRUE
            ORDER BY CASE role WHEN 'lead' THEN 0 ELSE 1 END, sort_order, user_name_snapshot`,
          [context.workspaceId, id],
        ),
        pool.query(
          `SELECT * FROM peakos_structured_project_medium_categories
            WHERE workspace_id = $1 AND project_id = $2 AND active = TRUE
            ORDER BY sort_order, created_at, id`,
          [context.workspaceId, id],
        ),
        pool.query(
          `SELECT * FROM peakos_structured_project_small_categories
            WHERE workspace_id = $1 AND project_id = $2 AND active = TRUE
            ORDER BY sort_order, created_at, id`,
          [context.workspaceId, id],
        ),
        pool.query(
          `SELECT * FROM peakos_structured_project_tasks
            WHERE workspace_id = $1 AND project_id = $2
            ORDER BY sort_order, created_at, id`,
          [context.workspaceId, id],
        ),
        pool.query(
          `SELECT * FROM peakos_structured_project_history
            WHERE workspace_id = $1 AND project_id = $2 AND entity_type = 'task'
            ORDER BY created_at, id`,
          [context.workspaceId, id],
        ),
        pool.query(
          `SELECT * FROM peakos_structured_project_meetings
            WHERE workspace_id = $1 AND project_id = $2 AND status <> 'cancelled'
            ORDER BY start_date, start_time, created_at`,
          [context.workspaceId, id],
        ),
        pool.query(
          `SELECT * FROM peakos_structured_project_meeting_attendees
            WHERE workspace_id = $1 AND project_id = $2 AND active = TRUE
            ORDER BY user_name_snapshot`,
          [context.workspaceId, id],
        ),
        pool.query(
          `SELECT * FROM peakos_structured_project_meeting_action_items
            WHERE workspace_id = $1 AND project_id = $2 AND active = TRUE
            ORDER BY sort_order, created_at`,
          [context.workspaceId, id],
        ),
      ]);
      const actionItemsByMeeting = new Map();
      for (const row of actionItemsResult.rows) {
        const key = String(row.meeting_id);
        const rows = actionItemsByMeeting.get(key) || [];
        rows.push(row);
        actionItemsByMeeting.set(key, rows);
      }
      const attendeesByMeeting = new Map();
      for (const row of attendeesResult.rows) {
        const key = String(row.meeting_id);
        const rows = attendeesByMeeting.get(key) || [];
        rows.push(row);
        attendeesByMeeting.set(key, rows);
      }
      // 소분류에 붙은 회의는 그 소분류에, 나머지는 중분류에 매단다.
      const meetingsByMedium = new Map();
      const meetingsBySmall = new Map();
      for (const row of meetingsResult.rows) {
        const meeting = mapMeeting(row, attendeesByMeeting.get(String(row.id)) || [],
          actionItemsByMeeting.get(String(row.id)) || []);
        const bucket = meeting.smallId ? meetingsBySmall : meetingsByMedium;
        const key = meeting.smallId || meeting.mediumId;
        const rows = bucket.get(key) || [];
        rows.push(meeting);
        bucket.set(key, rows);
      }
      const historyByTask = new Map();
      for (const row of historyResult.rows) {
        const key = String(row.task_id);
        const rows = historyByTask.get(key) || [];
        rows.push(mapHistory(row));
        historyByTask.set(key, rows);
      }
      const taskContext = {
        uid: context.uid,
        readOnly: context.readOnly,
        canManage: access.canManage,
        isLead: access.isLead,
      };
      const tasksBySmall = new Map();
      for (const row of tasksResult.rows) {
        const key = String(row.small_category_id);
        const rows = tasksBySmall.get(key) || [];
        rows.push(mapTask(row, taskContext, historyByTask.get(String(row.id)) || []));
        tasksBySmall.set(key, rows);
      }
      const smallsByMedium = new Map();
      for (const row of smallsResult.rows) {
        const key = String(row.medium_category_id);
        const rows = smallsByMedium.get(key) || [];
        rows.push({
          id: String(row.id), name: row.name, description: row.description || '',
          sortOrder: Number(row.sort_order || 0), version: Number(row.version || 1),
          tasks: tasksBySmall.get(String(row.id)) || [],
          meetings: meetingsBySmall.get(String(row.id)) || [],
        });
        smallsByMedium.set(key, rows);
      }
      const allMediumCategories = mediumsResult.rows.map(row => ({
        id: String(row.id), name: row.name, description: row.description || '',
        manager: mapMediumManager(row),
        sortOrder: Number(row.sort_order || 0), version: Number(row.version || 1),
        smallCategories: smallsByMedium.get(String(row.id)) || [],
        meetings: meetingsByMedium.get(String(row.id)) || [],
        managerUid: String(row.manager_uid || ''),
      }));
      // 프로젝트 담당자·관리 권한자는 전체를 보고, 그 밖의 팀원은 자기가
      // 중분류 담당자이거나 그 안에 자기 업무가 있는 중분류만 본다.
      // 화면이 아니라 서버에서 걸러야 실제로 가려진다.
      const seesEveryMedium = access.canManage
        || context.viewPortfolio === true
        || String(access.project.lead_uid || '') === String(context.uid);
      const mediumCategories = newProjectVisibleMediums({
        mediums: allMediumCategories,
        uid: context.uid,
        seesEveryMedium,
      }).map(({ managerUid, ...medium }) => medium);
      const project = access.project;
      return res.json({
        readOnly: context.readOnly,
        capabilities: {
          viewPortfolio: context.viewPortfolio,
          manageProject: access.canManage,
          editProjectSettings: access.canEditProjectSettings,
        },
        project: {
          id: String(project.id),
          name: project.name,
          description: project.description || '',
          status: project.status,
          version: Number(project.version || 1),
          lead: { uid: project.lead_uid, name: project.lead_name_snapshot },
          createdBy: { uid: project.created_by_uid, name: project.created_by_name_snapshot },
          members: membersResult.rows.map(mapMember),
          mediumCategories,
          createdAt: project.created_at,
          updatedAt: project.updated_at,
        },
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.put(`${NEW_PROJECT_BASE_PATH}/:id`, ...writeMiddlewares, async (req, res) => {
    let client;
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      const id = validationValue(normalizeNewProjectId(req.params.id, '프로젝트 ID'));
      validationValue(normalizeStrictObject(
        req.body,
        ['name', 'description', 'status', 'leadUid', 'memberUids', 'expectedVersion'],
        '프로젝트 수정',
      ));
      if (!Object.keys(req.body).length) throw new NewProjectHttpError(400, 'NEW_PROJECT_BODY_EMPTY', '변경할 프로젝트 내용을 입력해 주세요.');
      const expectedVersion = validationValue(normalizeNewProjectExpectedVersion(req.body.expectedVersion));
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      const access = await loadProjectAccess(client, context, id, { lock: true });
      assertCanEditProjectSettings(access);
      const current = access.project;
      if (Number(current.version) !== expectedVersion) {
        throw new NewProjectHttpError(409, 'NEW_PROJECT_VERSION_CONFLICT', '다른 사용자가 먼저 프로젝트를 변경했습니다.');
      }
      const name = req.body.name === undefined
        ? current.name
        : validationValue(normalizeNewProjectDisplayName(req.body.name, '프로젝트명'));
      const description = req.body.description === undefined
        ? current.description
        : validationValue(normalizeNewProjectText(req.body.description, {
          field: '프로젝트 설명', required: false, max: 10000,
        }));
      const status = req.body.status === undefined
        ? current.status
        : validationValue(normalizeNewProjectEnum(req.body.status, NEW_PROJECT_PROJECT_STATUSES, '프로젝트 상태'));
      const leadUid = req.body.leadUid === undefined
        ? current.lead_uid
        : validationValue(normalizeNewProjectUid(req.body.leadUid, '프로젝트 담당자'));

      const currentMembersResult = await client.query(
        `SELECT user_uid FROM peakos_structured_project_members
          WHERE workspace_id = $1 AND project_id = $2 AND active = TRUE`,
        [context.workspaceId, id],
      );
      const currentMemberUids = currentMembersResult.rows.map(row => String(row.user_uid));
      const requestedMembers = req.body.memberUids === undefined
        ? currentMemberUids
        : normalizeUidList(req.body.memberUids, '프로젝트 구성원');
      const nextMemberUids = [...new Set([leadUid, ...requestedMembers])];
      const users = await resolveWorkspaceUsers(client, context.workspaceId, nextMemberUids);
      if (status === 'completed' && current.status !== 'completed') {
        const incomplete = await client.query(
          `SELECT 1 FROM peakos_structured_project_tasks
            WHERE workspace_id = $1 AND project_id = $2 AND status <> 'done' LIMIT 1`,
          [context.workspaceId, id],
        );
        if (incomplete.rows[0]) {
          throw new NewProjectHttpError(409, 'NEW_PROJECT_TASKS_INCOMPLETE', '모든 업무가 승인 완료된 뒤에 프로젝트를 완료할 수 있습니다.');
        }
      }
      const removed = currentMemberUids.filter(uid => !nextMemberUids.includes(uid));
      if (removed.length) {
        const managedMedium = await client.query(
          `SELECT manager_uid FROM peakos_structured_project_medium_categories
            WHERE workspace_id = $1 AND project_id = $2
              AND active = TRUE
              AND manager_uid = ANY($3::text[])
            LIMIT 1`,
          [context.workspaceId, id, removed],
        );
        if (managedMedium.rows[0]) {
          throw new NewProjectHttpError(
            409,
            'NEW_PROJECT_MEMBER_MANAGES_MEDIUM',
            '진행 중인 업무 중분류를 담당한 팀원은 프로젝트에서 제외할 수 없습니다.',
          );
        }
        const openTasks = await client.query(
          `SELECT assignee_uid FROM peakos_structured_project_tasks
            WHERE workspace_id = $1 AND project_id = $2
              AND status <> 'done'
              AND (
                assignee_uid = ANY($3::text[])
                OR reviewer_uid = ANY($3::text[])
                OR assigned_by_uid = ANY($3::text[])
              )
            LIMIT 1`,
          [context.workspaceId, id, removed],
        );
        if (openTasks.rows[0]) {
          throw new NewProjectHttpError(409, 'NEW_PROJECT_MEMBER_HAS_OPEN_TASK', '미완료 업무를 받은 구성원은 프로젝트에서 제외할 수 없습니다.');
        }
      }
      await client.query(
        `UPDATE peakos_structured_project_members
            SET active = FALSE, role = 'member', version = version + 1, updated_at = NOW()
          WHERE workspace_id = $1 AND project_id = $2
            AND NOT (user_uid = ANY($3::text[]))`,
        [context.workspaceId, id, nextMemberUids],
      );
      // The schema permits exactly one active lead member. Demote the old lead
      // before upserting the new one; the project->lead integrity checks are
      // deferred until commit, so no invalid state can escape the transaction.
      await client.query(
        `UPDATE peakos_structured_project_members
            SET role = 'member', version = version + 1, updated_at = NOW()
          WHERE workspace_id = $1 AND project_id = $2
            AND active = TRUE AND role = 'lead' AND user_uid <> $3`,
        [context.workspaceId, id, leadUid],
      );
      for (const [index, uid] of nextMemberUids.entries()) {
        const user = users.get(uid);
        await client.query(
          `INSERT INTO peakos_structured_project_members
             (workspace_id, project_id, user_uid, user_name_snapshot, role, active,
              sort_order, added_by_uid, added_by_name_snapshot)
           VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7,$8)
           ON CONFLICT (workspace_id, project_id, user_uid) DO UPDATE
             SET user_name_snapshot = EXCLUDED.user_name_snapshot,
                 role = EXCLUDED.role,
                 active = TRUE,
                 sort_order = EXCLUDED.sort_order,
                 version = peakos_structured_project_members.version + 1,
                 updated_at = NOW()`,
          [context.workspaceId, id, uid, user.name, uid === leadUid ? 'lead' : 'member', index, context.uid, context.name],
        );
      }
      const nextVersion = Number(current.version) + 1;
      const updated = await client.query(
        `UPDATE peakos_structured_projects
            SET name = $3, description = $4, status = $5,
                lead_uid = $6, lead_name_snapshot = $7,
                version = version + 1, updated_at = NOW()
          WHERE workspace_id = $1 AND id = $2 AND version = $8
          RETURNING *`,
        [context.workspaceId, id, name, description, status, leadUid, users.get(leadUid).name, expectedVersion],
      );
      if (!updated.rows[0]) {
        throw new NewProjectHttpError(409, 'NEW_PROJECT_VERSION_CONFLICT', '다른 사용자가 먼저 프로젝트를 변경했습니다.');
      }
      await recordHistory(client, {
        context, projectId: id, entityType: 'project', entityId: id,
        action: 'updated', fromStatus: current.status, toStatus: status,
        version: nextVersion,
        metadata: { leadUid, memberUids: nextMemberUids },
      });
      await client.query('COMMIT');
      return res.json({
        project: {
          ...mapProjectSummary({ ...updated.rows[0], members: nextMemberUids.map(uid => ({
            uid, name: users.get(uid).name, role: uid === leadUid ? 'lead' : 'member',
          })) }),
        },
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  });

  app.delete(`${NEW_PROJECT_BASE_PATH}/:id`, ...writeMiddlewares, async (req, res) => {
    let client;
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      const id = validationValue(normalizeNewProjectId(req.params.id, '프로젝트 ID'));
      const expectedVersion = validationValue(normalizeNewProjectExpectedVersion(
        req.body?.expectedVersion ?? Number(req.query?.expectedVersion),
      ));
      client = await pool.connect();
      await client.query('BEGIN');
      const access = await loadProjectAccess(client, context, id, { lock: true });
      assertCanManage(access);
      if (Number(access.project.version) !== expectedVersion) {
        throw new NewProjectHttpError(409, 'NEW_PROJECT_VERSION_CONFLICT', '다른 사용자가 먼저 프로젝트를 변경했습니다.');
      }
      const updated = await client.query(
        `UPDATE peakos_structured_projects
            SET status = 'archived', version = version + 1, updated_at = NOW()
          WHERE workspace_id = $1 AND id = $2 AND version = $3
          RETURNING version`,
        [context.workspaceId, id, expectedVersion],
      );
      if (!updated.rows[0]) {
        throw new NewProjectHttpError(409, 'NEW_PROJECT_VERSION_CONFLICT', '다른 사용자가 먼저 프로젝트를 변경했습니다.');
      }
      await recordHistory(client, {
        context, projectId: id, entityType: 'project', entityId: id,
        action: 'archived', fromStatus: access.project.status, toStatus: 'archived',
        version: Number(updated.rows[0].version),
      });
      await client.query('COMMIT');
      return res.json({ ok: true });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  });


  // ── 분류별 회의 ────────────────────────────────────
  // 회의는 캘린더에도 보여야 하므로 events 행을 함께 만든다. events.project_id는
  // 레거시 projects를 가리키는 외래키라 구조화 프로젝트 ID를 넣을 수 없어,
  // 회의 쪽이 event_id를 들고 있는다.
  async function syncMeetingCalendarEvent(client, context, meeting, attendeeUids) {
    const memo = [meeting.description, meeting.location ? `장소: ${meeting.location}` : '']
      .filter(Boolean).join('\n\n').slice(0, 5000);
    let eventId = meeting.eventId || null;
    if (eventId) {
      const updated = await client.query(
        `UPDATE events
            SET title = $1, date = $2, end_date = $3, time = $4, end_time = $5,
                memo = $6, deleted = ($7 = 'cancelled')
          WHERE id = $8 AND deleted = FALSE OR id = $8
          RETURNING id`,
        [meeting.title, meeting.startDate, meeting.endDate, meeting.startTime,
          meeting.endTime || null, memo, meeting.status, eventId],
      );
      if (!updated.rows[0]) eventId = null;
    }
    if (!eventId) {
      const inserted = await client.query(
        `INSERT INTO events
           (workspace_id, type, title, date, time, end_time, url, memo, scope,
            owner_id, owner_name, end_date, sort_order)
         VALUES ($1,'meeting',$2,$3,$4,$5,'',$6,'team',$7,$8,$9,0)
         RETURNING id`,
        [context.workspaceId, meeting.title, meeting.startDate, meeting.startTime,
          meeting.endTime || null, memo, meeting.organizer.uid, meeting.organizer.name,
          meeting.endDate],
      );
      eventId = String(inserted.rows[0].id);
    }
    // 참석자에게만 공유한다. 주최자는 소유자라 공유가 필요 없다.
    await client.query('DELETE FROM event_shares WHERE event_id = $1', [eventId]);
    const shared = [...new Set(attendeeUids.map(String))].filter(uid => uid && uid !== meeting.organizer.uid);
    for (const uid of shared) {
      await client.query(
        'INSERT INTO event_shares (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [eventId, uid],
      );
    }
    return eventId;
  }

  async function loadMeetingAccess(client, context, projectId, mediumId) {
    const access = await loadProjectAccess(client, context, projectId, { lock: true });
    assertProjectMutable(access.project);
    const medium = await client.query(
      `SELECT id, manager_uid FROM peakos_structured_project_medium_categories
        WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND active = TRUE`,
      [context.workspaceId, projectId, mediumId],
    );
    if (!medium.rows[0]) throw new NewProjectHttpError(404, 'NEW_PROJECT_MEDIUM_NOT_FOUND', '업무 중분류를 찾을 수 없습니다.');
    assertAllowed(newProjectMeetingManageDecision({
      readOnly: context.readOnly,
      canManage: access.canManage,
      isLead: String(access.project.lead_uid || '') === String(context.uid),
      uid: context.uid,
      mediumManagerUid: medium.rows[0].manager_uid,
    }));
    return access;
  }

  app.post(`${NEW_PROJECT_BASE_PATH}/:id/mediums/:mediumId/meetings`, ...writeMiddlewares, async (req, res) => {
    let client;
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      const projectId = validationValue(normalizeNewProjectId(req.params.id, '프로젝트 ID'));
      const mediumId = validationValue(normalizeNewProjectId(req.params.mediumId, '중분류 ID'));
      const body = normalizeMeetingBody(req.body);
      validationValue(normalizeMeetingSchedule(body));
      const id = crypto.randomUUID();
      client = await pool.connect();
      await client.query('BEGIN');
      await loadMeetingAccess(client, context, projectId, mediumId);
      if (body.smallId) {
        const small = await client.query(
          `SELECT 1 FROM peakos_structured_project_small_categories
            WHERE workspace_id = $1 AND project_id = $2 AND medium_category_id = $3 AND id = $4 AND active = TRUE`,
          [context.workspaceId, projectId, mediumId, body.smallId],
        );
        if (!small.rows[0]) throw new NewProjectHttpError(404, 'NEW_PROJECT_SMALL_NOT_FOUND', '업무 소분류를 찾을 수 없습니다.');
      }
      // 주최자와 참석자는 모두 이 프로젝트의 팀원이어야 한다.
      const people = await resolveProjectMembers(client, context, projectId,
        [body.organizerUid, ...body.attendeeUids]);
      const organizer = people.get(body.organizerUid);
      const inserted = await client.query(
        `INSERT INTO peakos_structured_project_meetings
           (workspace_id, project_id, id, medium_category_id, small_category_id,
            title, description, location, start_date, end_date, start_time, end_time,
            organizer_uid, organizer_name_snapshot, created_by_uid, created_by_name_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [context.workspaceId, projectId, id, mediumId, body.smallId || null,
          body.title, body.description, body.location, body.startDate, body.endDate,
          body.startTime, body.endTime, organizer.uid, organizer.name, context.uid, context.name],
      );
      for (const uid of body.attendeeUids) {
        const person = people.get(uid);
        await client.query(
          `INSERT INTO peakos_structured_project_meeting_attendees
             (workspace_id, project_id, meeting_id, user_uid, user_name_snapshot, active)
           VALUES ($1,$2,$3,$4,$5,TRUE) ON CONFLICT DO NOTHING`,
          [context.workspaceId, projectId, id, person.uid, person.name],
        );
      }
      const meeting = mapMeeting(inserted.rows[0],
        body.attendeeUids.map(uid => ({ user_uid: uid, user_name_snapshot: people.get(uid).name })));
      const eventId = await syncMeetingCalendarEvent(client, context, meeting, body.attendeeUids);
      await client.query(
        `UPDATE peakos_structured_project_meetings SET event_id = $1
          WHERE workspace_id = $2 AND project_id = $3 AND id = $4`,
        [eventId, context.workspaceId, projectId, id],
      );
      await recordHistory(client, {
        context, projectId, entityType: 'meeting', entityId: id,
        action: 'created', version: 1,
        metadata: { mediumCategoryId: mediumId, smallCategoryId: body.smallId || null },
      });
      await client.query('COMMIT');
      const saved = { ...meeting, eventId };
      const when = `${saved.startDate}${saved.startTime ? ` ${saved.startTime}` : ''}`;
      for (const uid of new Set([saved.organizer.uid, ...body.attendeeUids])) {
        if (uid === context.uid) continue;
        await safeNotify(notifyUser, uid, '회의 일정이 잡혔습니다',
          `${saved.title} · ${when}`,
          { link: structuredProjectNotificationLink(context, projectId) });
      }
      return res.status(201).json({ meeting: saved });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  });

  app.patch(`${NEW_PROJECT_BASE_PATH}/:id/meetings/:meetingId`, ...writeMiddlewares, async (req, res) => {
    let client;
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      const projectId = validationValue(normalizeNewProjectId(req.params.id, '프로젝트 ID'));
      const meetingId = validationValue(normalizeNewProjectId(req.params.meetingId, '회의 ID'));
      const body = normalizeMeetingBody(req.body, { update: true });
      client = await pool.connect();
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT * FROM peakos_structured_project_meetings
          WHERE workspace_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE`,
        [context.workspaceId, projectId, meetingId],
      );
      if (!current.rows[0]) throw new NewProjectHttpError(404, 'NEW_PROJECT_MEETING_NOT_FOUND', '회의를 찾을 수 없습니다.');
      const row = current.rows[0];
      await loadMeetingAccess(client, context, projectId, String(row.medium_category_id));
      const merged = {
        title: body.title ?? row.title,
        description: body.description ?? row.description,
        location: body.location ?? row.location,
        startDate: body.startDate ?? serializeMeetingDate(row.start_date),
        endDate: body.endDate ?? serializeMeetingDate(row.end_date),
        startTime: body.startTime ?? row.start_time,
        endTime: body.endTime ?? row.end_time,
        status: body.status ?? row.status,
        organizerUid: body.organizerUid ?? String(row.organizer_uid),
      };
      validationValue(normalizeMeetingSchedule(merged));
      const existingAttendees = await client.query(
        `SELECT user_uid, user_name_snapshot FROM peakos_structured_project_meeting_attendees
          WHERE workspace_id = $1 AND project_id = $2 AND meeting_id = $3 ORDER BY user_name_snapshot`,
        [context.workspaceId, projectId, meetingId],
      );
      const attendeeUids = body.attendeeUids ?? existingAttendees.rows.map(entry => String(entry.user_uid));
      const people = await resolveProjectMembers(client, context, projectId,
        [merged.organizerUid, ...attendeeUids]);
      const organizer = people.get(merged.organizerUid);
      const updated = await client.query(
        `UPDATE peakos_structured_project_meetings
            SET title = $1, description = $2, location = $3, start_date = $4, end_date = $5,
                start_time = $6, end_time = $7, status = $8, organizer_uid = $9,
                organizer_name_snapshot = $10, version = version + 1, updated_at = NOW()
          WHERE workspace_id = $11 AND project_id = $12 AND id = $13 AND version = $14
          RETURNING *`,
        [merged.title, merged.description, merged.location, merged.startDate, merged.endDate,
          merged.startTime, merged.endTime, merged.status, organizer.uid, organizer.name,
          context.workspaceId, projectId, meetingId, body.expectedVersion],
      );
      if (!updated.rows[0]) {
        throw new NewProjectHttpError(409, 'NEW_PROJECT_VERSION_CONFLICT', '다른 사용자가 먼저 회의를 변경했습니다.');
      }
      if (body.attendeeUids) {
        // 빠진 사람은 지우지 않고 내린다. 이 저장소는 어디서도 하드 삭제하지 않는다.
        await client.query(
          `UPDATE peakos_structured_project_meeting_attendees SET active = FALSE
            WHERE workspace_id = $1 AND project_id = $2 AND meeting_id = $3
              AND NOT (user_uid = ANY($4::text[]))`,
          [context.workspaceId, projectId, meetingId, attendeeUids],
        );
        for (const uid of attendeeUids) {
          await client.query(
            `INSERT INTO peakos_structured_project_meeting_attendees
               (workspace_id, project_id, meeting_id, user_uid, user_name_snapshot, active)
             VALUES ($1,$2,$3,$4,$5,TRUE)
             ON CONFLICT (workspace_id, project_id, meeting_id, user_uid)
             DO UPDATE SET active = TRUE, user_name_snapshot = EXCLUDED.user_name_snapshot`,
            [context.workspaceId, projectId, meetingId, uid, people.get(uid).name],
          );
        }
      }
      const meeting = mapMeeting(updated.rows[0],
        attendeeUids.map(uid => ({ user_uid: uid, user_name_snapshot: people.get(uid).name })));
      const eventId = await syncMeetingCalendarEvent(client, context, meeting, attendeeUids);
      if (eventId !== meeting.eventId) {
        await client.query(
          `UPDATE peakos_structured_project_meetings SET event_id = $1
            WHERE workspace_id = $2 AND project_id = $3 AND id = $4`,
          [eventId, context.workspaceId, projectId, meetingId],
        );
      }
      await recordHistory(client, {
        context, projectId, entityType: 'meeting', entityId: meetingId,
        action: merged.status === 'cancelled' ? 'cancelled' : 'updated',
        version: Number(updated.rows[0].version),
      });
      await client.query('COMMIT');
      return res.json({ meeting: { ...meeting, eventId } });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  });

  app.delete(`${NEW_PROJECT_BASE_PATH}/:id/meetings/:meetingId`, ...writeMiddlewares, async (req, res) => {
    let client;
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      const projectId = validationValue(normalizeNewProjectId(req.params.id, '프로젝트 ID'));
      const meetingId = validationValue(normalizeNewProjectId(req.params.meetingId, '회의 ID'));
      client = await pool.connect();
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT * FROM peakos_structured_project_meetings
          WHERE workspace_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE`,
        [context.workspaceId, projectId, meetingId],
      );
      if (!current.rows[0]) throw new NewProjectHttpError(404, 'NEW_PROJECT_MEETING_NOT_FOUND', '회의를 찾을 수 없습니다.');
      await loadMeetingAccess(client, context, projectId, String(current.rows[0].medium_category_id));
      // 회의는 지우지 않고 취소로 내린다. 캘린더에서만 사라진다.
      const cancelled = await client.query(
        `UPDATE peakos_structured_project_meetings
            SET status = 'cancelled', version = version + 1, updated_at = NOW()
          WHERE workspace_id = $1 AND project_id = $2 AND id = $3
          RETURNING version`,
        [context.workspaceId, projectId, meetingId],
      );
      if (current.rows[0].event_id) {
        await client.query('UPDATE events SET deleted = TRUE WHERE id = $1', [current.rows[0].event_id]);
      }
      await recordHistory(client, {
        context, projectId, entityType: 'meeting', entityId: meetingId,
        action: 'cancelled', fromStatus: current.rows[0].status, toStatus: 'cancelled',
        version: Number(cancelled.rows[0].version),
      });
      await client.query('COMMIT');
      return res.json({ ok: true });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  });


  // 회의록 저장. 결정사항 본문과 "회의에서 나온 할 일"을 한 번에 갈아 끼운다.
  app.put(`${NEW_PROJECT_BASE_PATH}/:id/meetings/:meetingId/notes`, ...writeMiddlewares, async (req, res) => {
    let client;
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      const projectId = validationValue(normalizeNewProjectId(req.params.id, '프로젝트 ID'));
      const meetingId = validationValue(normalizeNewProjectId(req.params.meetingId, '회의 ID'));
      const body = normalizeMeetingNotesBody(req.body);
      client = await pool.connect();
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT * FROM peakos_structured_project_meetings
          WHERE workspace_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE`,
        [context.workspaceId, projectId, meetingId],
      );
      if (!current.rows[0]) throw new NewProjectHttpError(404, 'NEW_PROJECT_MEETING_NOT_FOUND', '회의를 찾을 수 없습니다.');
      await loadMeetingAccess(client, context, projectId, String(current.rows[0].medium_category_id));
      const assigneeUids = [...new Set(body.actionItems.map(item => item.assigneeUid).filter(Boolean))];
      const people = await resolveProjectMembers(client, context, projectId, assigneeUids);
      const updated = await client.query(
        `UPDATE peakos_structured_project_meetings
            SET notes = $1, notes_written_at = NOW(), notes_written_by_uid = $2,
                notes_written_by_name_snapshot = $3, version = version + 1, updated_at = NOW()
          WHERE workspace_id = $4 AND project_id = $5 AND id = $6 AND version = $7
          RETURNING *`,
        [body.notes, context.uid, context.name, context.workspaceId, projectId, meetingId, body.expectedVersion],
      );
      if (!updated.rows[0]) {
        throw new NewProjectHttpError(409, 'NEW_PROJECT_VERSION_CONFLICT', '다른 사용자가 먼저 회의록을 저장했습니다.');
      }
      // 목록에서 빠진 줄은 내린다. 이미 업무로 만든 줄은 링크가 끊기지 않게 남긴다.
      const keptIds = body.actionItems.map(item => item.id).filter(Boolean);
      await client.query(
        `UPDATE peakos_structured_project_meeting_action_items
            SET active = FALSE, updated_at = NOW()
          WHERE workspace_id = $1 AND project_id = $2 AND meeting_id = $3
            AND task_id IS NULL AND NOT (id = ANY($4::uuid[]))`,
        [context.workspaceId, projectId, meetingId, keptIds],
      );
      const saved = [];
      for (const item of body.actionItems) {
        const person = item.assigneeUid ? people.get(item.assigneeUid) : null;
        if (item.id) {
          const row = await client.query(
            `UPDATE peakos_structured_project_meeting_action_items
                SET title = $1, assignee_uid = $2, assignee_name_snapshot = $3,
                    due_date = $4, sort_order = $5, active = TRUE, updated_at = NOW()
              WHERE workspace_id = $6 AND project_id = $7 AND meeting_id = $8 AND id = $9
              RETURNING *`,
            [item.title, person?.uid || null, person?.name || null, item.dueDate, item.sortOrder,
              context.workspaceId, projectId, meetingId, item.id],
          );
          if (row.rows[0]) { saved.push(row.rows[0]); continue; }
        }
        const row = await client.query(
          `INSERT INTO peakos_structured_project_meeting_action_items
             (workspace_id, project_id, meeting_id, title, assignee_uid, assignee_name_snapshot,
              due_date, sort_order, created_by_uid, created_by_name_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [context.workspaceId, projectId, meetingId, item.title, person?.uid || null,
            person?.name || null, item.dueDate, item.sortOrder, context.uid, context.name],
        );
        saved.push(row.rows[0]);
      }
      const attendees = await client.query(
        `SELECT user_uid, user_name_snapshot FROM peakos_structured_project_meeting_attendees
          WHERE workspace_id = $1 AND project_id = $2 AND meeting_id = $3 AND active = TRUE
          ORDER BY user_name_snapshot`,
        [context.workspaceId, projectId, meetingId],
      );
      await recordHistory(client, {
        context, projectId, entityType: 'meeting', entityId: meetingId,
        action: 'noted', version: Number(updated.rows[0].version),
        metadata: { actionItemCount: saved.length },
      });
      await client.query('COMMIT');
      return res.json({ meeting: mapMeeting(updated.rows[0], attendees.rows, saved) });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  });

  // 회의에서 나온 할 일 한 줄을 실제 업무로 만든다. 지시자는 회의 주최자다.
  app.post(`${NEW_PROJECT_BASE_PATH}/:id/meetings/:meetingId/action-items/:itemId/task`, ...writeMiddlewares, async (req, res) => {
    let client;
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      const projectId = validationValue(normalizeNewProjectId(req.params.id, '프로젝트 ID'));
      const meetingId = validationValue(normalizeNewProjectId(req.params.meetingId, '회의 ID'));
      const itemId = validationValue(normalizeNewProjectId(req.params.itemId, '회의 할 일 ID'));
      validationValue(normalizeStrictObject(req.body || {}, ['smallId'], '업무 전환'));
      const requestedSmallId = req.body?.smallId
        ? validationValue(normalizeNewProjectId(req.body.smallId, '소분류 ID'))
        : '';
      const taskId = crypto.randomUUID();
      client = await pool.connect();
      await client.query('BEGIN');
      const meetingRow = await client.query(
        `SELECT * FROM peakos_structured_project_meetings
          WHERE workspace_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE`,
        [context.workspaceId, projectId, meetingId],
      );
      if (!meetingRow.rows[0]) throw new NewProjectHttpError(404, 'NEW_PROJECT_MEETING_NOT_FOUND', '회의를 찾을 수 없습니다.');
      const meeting = meetingRow.rows[0];
      const access = await loadMeetingAccess(client, context, projectId, String(meeting.medium_category_id));
      const itemRow = await client.query(
        `SELECT * FROM peakos_structured_project_meeting_action_items
          WHERE workspace_id = $1 AND project_id = $2 AND meeting_id = $3 AND id = $4 AND active = TRUE
          FOR UPDATE`,
        [context.workspaceId, projectId, meetingId, itemId],
      );
      if (!itemRow.rows[0]) throw new NewProjectHttpError(404, 'NEW_PROJECT_MEETING_ACTION_ITEM_NOT_FOUND', '회의에서 나온 할 일을 찾을 수 없습니다.');
      const item = itemRow.rows[0];
      if (item.task_id) {
        throw new NewProjectHttpError(409, 'NEW_PROJECT_MEETING_ACTION_ITEM_CONVERTED', '이미 업무로 만든 할 일입니다.');
      }
      if (!item.assignee_uid) {
        throw new NewProjectHttpError(400, 'NEW_PROJECT_MEETING_ACTION_ITEM_UNASSIGNED', '담당자를 정해야 업무로 만들 수 있습니다.');
      }
      // 업무는 소분류 아래에만 존재한다. 소분류 회의면 그 소분류를, 중분류 회의면 고른 소분류를 쓴다.
      const smallId = meeting.small_category_id ? String(meeting.small_category_id) : requestedSmallId;
      if (!smallId) {
        throw new NewProjectHttpError(400, 'NEW_PROJECT_MEETING_SMALL_REQUIRED', '업무를 만들 소분류를 골라 주세요.');
      }
      const small = await client.query(
        `SELECT 1 FROM peakos_structured_project_small_categories
          WHERE workspace_id = $1 AND project_id = $2 AND medium_category_id = $3 AND id = $4 AND active = TRUE`,
        [context.workspaceId, projectId, String(meeting.medium_category_id), smallId],
      );
      if (!small.rows[0]) throw new NewProjectHttpError(404, 'NEW_PROJECT_SMALL_NOT_FOUND', '업무 소분류를 찾을 수 없습니다.');
      const people = await resolveProjectMembers(client, context, projectId,
        [String(item.assignee_uid), String(meeting.organizer_uid)]);
      const assignee = people.get(String(item.assignee_uid));
      const assigner = people.get(String(meeting.organizer_uid));
      const reviewer = validationValue(resolveNewProjectReviewer({
        assigneeUid: assignee.uid,
        assignedByUid: assigner.uid,
        assignedByName: assigner.name,
        leadUid: access.project.lead_uid,
        leadName: access.project.lead_name_snapshot,
      }));
      const description = `${meeting.title} 회의에서 나온 할 일입니다.`;
      const inserted = await client.query(
        `INSERT INTO peakos_structured_project_tasks
           (workspace_id, project_id, medium_category_id, small_category_id, id,
            title, description, assignee_uid, assignee_name_snapshot,
            assigned_by_uid, assigned_by_name_snapshot,
            reviewer_uid, reviewer_name_snapshot, reviewer_source,
            due_date, sort_order, created_by_uid, created_by_name_snapshot, attachments)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,$16,$17,'[]'::jsonb)
         RETURNING *`,
        [context.workspaceId, projectId, String(meeting.medium_category_id), smallId, taskId,
          item.title, description, assignee.uid, assignee.name, assigner.uid, assigner.name,
          reviewer.reviewerUid, reviewer.reviewerName, reviewer.source,
          item.due_date || null, context.uid, context.name],
      );
      await client.query(
        `UPDATE peakos_structured_project_meeting_action_items
            SET task_id = $1, updated_at = NOW()
          WHERE workspace_id = $2 AND project_id = $3 AND id = $4`,
        [taskId, context.workspaceId, projectId, itemId],
      );
      await recordHistory(client, {
        context, projectId, entityType: 'task', entityId: taskId, taskId,
        action: 'assigned', toStatus: 'todo', version: 1,
        metadata: { assigneeUid: assignee.uid, assignedByUid: assigner.uid, meetingId },
      });
      await client.query('COMMIT');
      await safeNotify(notifyUser, assignee.uid, '회의에서 나온 업무가 배정되었습니다',
        `${item.title} · ${meeting.title}`,
        { link: structuredProjectNotificationLink(context, projectId, taskId) });
      return res.status(201).json({
        task: mapTask(inserted.rows[0], { uid: context.uid, readOnly: context.readOnly, canManage: access.canManage }, []),
        actionItem: mapMeetingActionItem({ ...item, task_id: taskId }),
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  });

  async function createCategory(req, res, level) {
    let client;
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      const projectId = validationValue(normalizeNewProjectId(req.params.id, '프로젝트 ID'));
      const mediumId = level === 'small'
        ? validationValue(normalizeNewProjectId(req.params.mediumId, '중분류 ID'))
        : null;
      const body = normalizeCategoryBody(req.body, { level });
      const id = crypto.randomUUID();
      client = await pool.connect();
      await client.query('BEGIN');
      const access = await loadProjectAccess(client, context, projectId, { lock: true });
      assertCanManage(access);
      assertProjectMutable(access.project);
      const manager = level === 'medium'
        ? await resolveMediumManager(client, context, projectId, body.managerUid)
        : undefined;
      if (level === 'small') {
        const medium = await client.query(
          `SELECT 1 FROM peakos_structured_project_medium_categories
            WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND active = TRUE`,
          [context.workspaceId, projectId, mediumId],
        );
        if (!medium.rows[0]) throw new NewProjectHttpError(404, 'NEW_PROJECT_MEDIUM_NOT_FOUND', '업무 중분류를 찾을 수 없습니다.');
        await client.query(
          `INSERT INTO peakos_structured_project_small_categories
             (workspace_id, project_id, medium_category_id, id, name, description,
              sort_order, created_by_uid, created_by_name_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [context.workspaceId, projectId, mediumId, id, body.name, body.description, body.sortOrder, context.uid, context.name],
        );
      } else {
        await client.query(
          `INSERT INTO peakos_structured_project_medium_categories
             (workspace_id, project_id, id, name, description,
              manager_uid, manager_name_snapshot, sort_order,
              created_by_uid, created_by_name_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            context.workspaceId, projectId, id, body.name, body.description,
            manager?.uid || null, manager?.name || null, body.sortOrder,
            context.uid, context.name,
          ],
        );
      }
      await recordHistory(client, {
        context, projectId, entityType: level === 'small' ? 'small_category' : 'medium_category',
        entityId: id, action: 'created', version: 1,
        metadata: level === 'small'
          ? { mediumCategoryId: mediumId }
          : { managerUid: manager?.uid || null },
      });
      await client.query('COMMIT');
      return res.status(201).json({
        category: {
          id, name: body.name, description: body.description,
          sortOrder: body.sortOrder, version: 1,
          ...(level === 'medium' ? { manager: manager || null } : {}),
          ...(mediumId ? { mediumCategoryId: mediumId } : {}),
        },
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  }

  app.post(`${NEW_PROJECT_BASE_PATH}/:id/mediums`, ...writeMiddlewares, (req, res) => createCategory(req, res, 'medium'));
  app.post(`${NEW_PROJECT_BASE_PATH}/:id/mediums/:mediumId/smalls`, ...writeMiddlewares, (req, res) => createCategory(req, res, 'small'));

  async function updateCategory(req, res, level) {
    let client;
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      const projectId = validationValue(normalizeNewProjectId(req.params.id, '프로젝트 ID'));
      const mediumId = validationValue(normalizeNewProjectId(req.params.mediumId, '중분류 ID'));
      const categoryId = level === 'small'
        ? validationValue(normalizeNewProjectId(req.params.smallId, '소분류 ID'))
        : mediumId;
      const body = normalizeCategoryBody(req.body, { update: true, level });
      const table = level === 'small'
        ? 'peakos_structured_project_small_categories'
        : 'peakos_structured_project_medium_categories';
      client = await pool.connect();
      await client.query('BEGIN');
      const access = await loadProjectAccess(client, context, projectId, { lock: true });
      assertCanManage(access);
      assertProjectMutable(access.project);
      const currentResult = await client.query(
        `SELECT * FROM ${table}
          WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND active = TRUE
          ${level === 'small' ? 'AND medium_category_id = $4' : ''}
          FOR UPDATE`,
        level === 'small'
          ? [context.workspaceId, projectId, categoryId, mediumId]
          : [context.workspaceId, projectId, categoryId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new NewProjectHttpError(404, 'NEW_PROJECT_CATEGORY_NOT_FOUND', '업무 분류를 찾을 수 없습니다.');
      if (Number(current.version) !== body.expectedVersion) {
        throw new NewProjectHttpError(409, 'NEW_PROJECT_VERSION_CONFLICT', '다른 사용자가 먼저 분류를 변경했습니다.');
      }
      const manager = level === 'medium' && body.managerUid !== undefined
        ? await resolveMediumManager(client, context, projectId, body.managerUid)
        : (level === 'medium' ? mapMediumManager(current) : undefined);
      const updated = level === 'medium'
        ? await client.query(
          `UPDATE ${table}
              SET name = $4, description = $5, sort_order = $6,
                  manager_uid = $7, manager_name_snapshot = $8,
                  version = version + 1, updated_at = NOW()
            WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND version = $9
            RETURNING *`,
          [
            context.workspaceId, projectId, categoryId,
            body.name ?? current.name,
            body.description ?? current.description,
            body.sortOrder ?? current.sort_order,
            manager?.uid || null,
            manager?.name || null,
            body.expectedVersion,
          ],
        )
        : await client.query(
          `UPDATE ${table}
              SET name = $4, description = $5, sort_order = $6,
                  version = version + 1, updated_at = NOW()
            WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND version = $7
            RETURNING *`,
          [
            context.workspaceId, projectId, categoryId,
            body.name ?? current.name,
            body.description ?? current.description,
            body.sortOrder ?? current.sort_order,
            body.expectedVersion,
          ],
        );
      if (!updated.rows[0]) throw new NewProjectHttpError(409, 'NEW_PROJECT_VERSION_CONFLICT', '다른 사용자가 먼저 분류를 변경했습니다.');
      await recordHistory(client, {
        context, projectId, entityType: level === 'small' ? 'small_category' : 'medium_category',
        entityId: categoryId, action: 'updated', version: Number(updated.rows[0].version),
        metadata: level === 'medium' ? { managerUid: manager?.uid || null } : {},
      });
      await client.query('COMMIT');
      return res.json({
        category: {
          id: String(updated.rows[0].id), name: updated.rows[0].name,
          description: updated.rows[0].description || '',
          sortOrder: Number(updated.rows[0].sort_order || 0),
          version: Number(updated.rows[0].version),
          ...(level === 'medium' ? { manager: mapMediumManager(updated.rows[0]) } : {}),
        },
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  }

  app.put(`${NEW_PROJECT_BASE_PATH}/:id/mediums/:mediumId`, ...writeMiddlewares, (req, res) => updateCategory(req, res, 'medium'));
  app.put(`${NEW_PROJECT_BASE_PATH}/:id/mediums/:mediumId/smalls/:smallId`, ...writeMiddlewares, (req, res) => updateCategory(req, res, 'small'));

  async function archiveCategory(req, res, level) {
    let client;
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      const projectId = validationValue(normalizeNewProjectId(req.params.id, '프로젝트 ID'));
      const mediumId = validationValue(normalizeNewProjectId(req.params.mediumId, '중분류 ID'));
      const categoryId = level === 'small'
        ? validationValue(normalizeNewProjectId(req.params.smallId, '소분류 ID'))
        : mediumId;
      client = await pool.connect();
      await client.query('BEGIN');
      const access = await loadProjectAccess(client, context, projectId, { lock: true });
      assertCanManage(access);
      assertProjectMutable(access.project);
      const dependent = level === 'medium'
        ? await client.query(
          `SELECT 1 FROM peakos_structured_project_small_categories
            WHERE workspace_id = $1 AND project_id = $2 AND medium_category_id = $3 AND active = TRUE LIMIT 1`,
          [context.workspaceId, projectId, categoryId],
        )
        : await client.query(
          `SELECT 1 FROM peakos_structured_project_tasks
            WHERE workspace_id = $1 AND project_id = $2
              AND small_category_id = $3 AND medium_category_id = $4 LIMIT 1`,
          [context.workspaceId, projectId, categoryId, mediumId],
        );
      if (dependent.rows[0]) {
        throw new NewProjectHttpError(409, 'NEW_PROJECT_CATEGORY_NOT_EMPTY', '하위 분류 또는 업무가 있는 분류는 삭제할 수 없습니다.');
      }
      const table = level === 'small'
        ? 'peakos_structured_project_small_categories'
        : 'peakos_structured_project_medium_categories';
      const updated = await client.query(
        `UPDATE ${table}
            SET active = FALSE, version = version + 1, updated_at = NOW()
          WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND active = TRUE
            ${level === 'small' ? 'AND medium_category_id = $4' : ''}
          RETURNING version`,
        level === 'small'
          ? [context.workspaceId, projectId, categoryId, mediumId]
          : [context.workspaceId, projectId, categoryId],
      );
      if (!updated.rows[0]) throw new NewProjectHttpError(404, 'NEW_PROJECT_CATEGORY_NOT_FOUND', '업무 분류를 찾을 수 없습니다.');
      await recordHistory(client, {
        context, projectId, entityType: level === 'small' ? 'small_category' : 'medium_category',
        entityId: categoryId, action: 'archived', version: Number(updated.rows[0].version),
      });
      await client.query('COMMIT');
      return res.json({ ok: true });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  }

  app.delete(`${NEW_PROJECT_BASE_PATH}/:id/mediums/:mediumId`, ...writeMiddlewares, (req, res) => archiveCategory(req, res, 'medium'));
  app.delete(`${NEW_PROJECT_BASE_PATH}/:id/mediums/:mediumId/smalls/:smallId`, ...writeMiddlewares, (req, res) => archiveCategory(req, res, 'small'));

  app.post(`${NEW_PROJECT_BASE_PATH}/:id/mediums/:mediumId/smalls/:smallId/tasks`, ...writeMiddlewares, async (req, res) => {
    let client;
    let notification;
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      const projectId = validationValue(normalizeNewProjectId(req.params.id, '프로젝트 ID'));
      const mediumId = validationValue(normalizeNewProjectId(req.params.mediumId, '중분류 ID'));
      const smallId = validationValue(normalizeNewProjectId(req.params.smallId, '소분류 ID'));
      const body = normalizeTaskCreateBody(req.body);
      const id = crypto.randomUUID();
      client = await pool.connect();
      await client.query('BEGIN');
      const access = await loadProjectAccess(client, context, projectId, { lock: true });
      assertCanManage(access);
      assertProjectMutable(access.project);
      const hierarchy = await client.query(
        `SELECT 1
           FROM peakos_structured_project_small_categories small
           JOIN peakos_structured_project_medium_categories medium
             ON medium.workspace_id = small.workspace_id
            AND medium.project_id = small.project_id
            AND medium.id = small.medium_category_id
            AND medium.active = TRUE
          WHERE small.workspace_id = $1 AND small.project_id = $2
            AND small.medium_category_id = $3 AND small.id = $4 AND small.active = TRUE`,
        [context.workspaceId, projectId, mediumId, smallId],
      );
      if (!hierarchy.rows[0]) throw new NewProjectHttpError(404, 'NEW_PROJECT_HIERARCHY_NOT_FOUND', '업무 중·소분류를 찾을 수 없습니다.');
      const selectedAssignerUid = body.assignedByUid || context.uid;
      if (selectedAssignerUid === body.assigneeUid) {
        throw new NewProjectHttpError(
          400,
          'NEW_PROJECT_ASSIGNER_ASSIGNEE_CONFLICT',
          '업무 지시자와 담당자는 서로 달라야 합니다.',
        );
      }
      const users = await resolveWorkspaceUsers(
        client,
        context.workspaceId,
        [body.assigneeUid, selectedAssignerUid, body.reviewerUid].filter(Boolean),
      );
      const members = await client.query(
        `SELECT user_uid FROM peakos_structured_project_members
          WHERE workspace_id = $1 AND project_id = $2
            AND user_uid = ANY($3::text[]) AND active = TRUE`,
        [context.workspaceId, projectId, [body.assigneeUid, selectedAssignerUid, body.reviewerUid].filter(Boolean)],
      );
      const activeMemberUids = new Set(members.rows.map(row => String(row.user_uid)));
      if (!activeMemberUids.has(body.assigneeUid) || !users.has(body.assigneeUid)) {
        throw new NewProjectHttpError(400, 'NEW_PROJECT_ASSIGNEE_NOT_MEMBER', '업무 담당자는 프로젝트 구성원이어야 합니다.');
      }
      if (!activeMemberUids.has(selectedAssignerUid) || !users.has(selectedAssignerUid)) {
        throw new NewProjectHttpError(400, 'NEW_PROJECT_ASSIGNER_NOT_MEMBER', '업무 지시자는 프로젝트 구성원이어야 합니다.');
      }
      if (body.reviewerUid && (!activeMemberUids.has(body.reviewerUid) || !users.has(body.reviewerUid))) {
        throw new NewProjectHttpError(400, 'NEW_PROJECT_REVIEWER_NOT_MEMBER', '업무 검토자는 프로젝트 구성원이어야 합니다.');
      }
      const assignee = users.get(body.assigneeUid);
      const assigner = users.get(selectedAssignerUid);
      const chosenReviewer = body.reviewerUid ? users.get(body.reviewerUid) : null;
      const reviewer = validationValue(resolveNewProjectReviewer({
        assigneeUid: assignee.uid,
        assignedByUid: assigner.uid,
        assignedByName: assigner.name,
        reviewerUid: chosenReviewer?.uid || '',
        reviewerName: chosenReviewer?.name || '',
        leadUid: access.project.lead_uid,
        leadName: access.project.lead_name_snapshot,
      }));
      const inserted = await client.query(
        `INSERT INTO peakos_structured_project_tasks
           (workspace_id, project_id, medium_category_id, small_category_id, id,
            title, description, assignee_uid, assignee_name_snapshot,
            assigned_by_uid, assigned_by_name_snapshot,
            reviewer_uid, reviewer_name_snapshot, reviewer_source,
            due_date, sort_order, created_by_uid, created_by_name_snapshot, attachments)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)
         RETURNING *`,
        [
          context.workspaceId, projectId, mediumId, smallId, id,
          body.title, body.description, assignee.uid, assignee.name,
          assigner.uid, assigner.name,
          reviewer.reviewerUid, reviewer.reviewerName, reviewer.source,
          body.dueDate, body.sortOrder, context.uid, context.name,
          JSON.stringify(body.attachments || []),
        ],
      );
      await recordHistory(client, {
        context, projectId, entityType: 'task', entityId: id, taskId: id,
        action: 'assigned', toStatus: 'todo', version: 1,
        metadata: {
          assigneeUid: assignee.uid,
          assignedByUid: assigner.uid,
          reviewerUid: reviewer.reviewerUid,
          registeredByUid: context.uid,
        },
      });
      await client.query('COMMIT');
      notification = {
        uid: assignee.uid,
        title: '신규 업무 배정',
        body: `${assigner.name}님 지시 · ${context.name}님이 "${body.title}" 업무를 등록했습니다.`,
      };
      const task = inserted.rows[0];
      await safeNotifyProjectMember(pool, notifyUser, {
        workspaceId: context.workspaceId,
        projectId,
        uid: notification.uid,
        title: notification.title,
        body: notification.body,
        data: {
        kind: 'new-project-task', newProjectId: projectId, taskId: id,
          link: structuredProjectNotificationLink(context, projectId, id),
        },
      });
      return res.status(201).json({
        task: mapTask(task, { uid: context.uid, readOnly: false, canManage: true, isLead: access.isLead }, []),
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  });

  app.put(`${NEW_PROJECT_BASE_PATH}/:id/tasks/:taskId`, ...writeMiddlewares, async (req, res) => {
    let client;
    let notifyTarget = null;
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      const projectId = validationValue(normalizeNewProjectId(req.params.id, '프로젝트 ID'));
      const taskId = validationValue(normalizeNewProjectId(req.params.taskId, '업무 ID'));
      const body = normalizeTaskUpdateBody(req.body);
      client = await pool.connect();
      await client.query('BEGIN');
      const access = await loadProjectAccess(client, context, projectId, { lock: true });
      assertCanManage(access);
      assertProjectMutable(access.project);
      const taskResult = await client.query(
        `SELECT * FROM peakos_structured_project_tasks
          WHERE workspace_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE`,
        [context.workspaceId, projectId, taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new NewProjectHttpError(404, 'NEW_PROJECT_TASK_NOT_FOUND', '업무를 찾을 수 없습니다.');
      if (Number(task.version) !== body.expectedVersion) {
        throw new NewProjectHttpError(409, 'NEW_PROJECT_TASK_VERSION_CONFLICT', '다른 사용자가 먼저 업무를 변경했습니다.');
      }
      const assignmentTouched = body.assigneeUid !== undefined || body.assignedByUid !== undefined;
      const nonAssignmentTouched = body.title !== undefined
        || body.description !== undefined
        || body.dueDate !== undefined
        || body.sortOrder !== undefined;
      if (task.status === 'done' || (task.status === 'review' && (!assignmentTouched || nonAssignmentTouched))) {
        throw new NewProjectHttpError(409, 'NEW_PROJECT_TASK_EDIT_LOCKED', '검토 중이거나 완료된 업무는 수정할 수 없습니다.');
      }
      let assigneeUid = task.assignee_uid;
      let assigneeName = task.assignee_name_snapshot;
      let assignedByUid = task.assigned_by_uid;
      let assignedByName = task.assigned_by_name_snapshot;
      let reviewerUid = task.reviewer_uid;
      let reviewerName = task.reviewer_name_snapshot;
      let reviewerSource = task.reviewer_source;
      const reassigned = body.assigneeUid !== undefined && body.assigneeUid !== task.assignee_uid;
      const assignerChanged = body.assignedByUid !== undefined
        && body.assignedByUid !== task.assigned_by_uid;
      if (assignmentTouched) {
        const nextAssigneeUid = body.assigneeUid ?? task.assignee_uid;
        const nextAssignerUid = body.assignedByUid ?? task.assigned_by_uid;
        if (nextAssigneeUid === nextAssignerUid) {
          throw new NewProjectHttpError(
            400,
            'NEW_PROJECT_ASSIGNER_ASSIGNEE_CONFLICT',
            '업무 지시자와 담당자는 서로 달라야 합니다.',
          );
        }
        const users = await resolveWorkspaceUsers(
          client,
          context.workspaceId,
          [nextAssigneeUid, nextAssignerUid, body.reviewerUid].filter(Boolean),
        );
        const members = await client.query(
          `SELECT user_uid FROM peakos_structured_project_members
            WHERE workspace_id = $1 AND project_id = $2
              AND user_uid = ANY($3::text[]) AND active = TRUE`,
          [context.workspaceId, projectId, [nextAssigneeUid, nextAssignerUid]],
        );
        const activeMemberUids = new Set(members.rows.map(row => String(row.user_uid)));
        if (!activeMemberUids.has(nextAssigneeUid) || !users.has(nextAssigneeUid)) {
          throw new NewProjectHttpError(400, 'NEW_PROJECT_ASSIGNEE_NOT_MEMBER', '업무 담당자는 프로젝트 구성원이어야 합니다.');
        }
        if (!activeMemberUids.has(nextAssignerUid) || !users.has(nextAssignerUid)) {
          throw new NewProjectHttpError(400, 'NEW_PROJECT_ASSIGNER_NOT_MEMBER', '업무 지시자는 프로젝트 구성원이어야 합니다.');
        }
        const assignee = users.get(nextAssigneeUid);
        const assigner = users.get(nextAssignerUid);
        // 검토자를 비워 보내면 예전처럼 지시자가 검토를 맡는다.
        const nextReviewerUid = body.reviewerUid !== undefined
          ? body.reviewerUid
          : (task.reviewer_source === 'explicit' ? String(task.reviewer_uid || '') : '');
        if (nextReviewerUid && !users.has(nextReviewerUid)) {
          throw new NewProjectHttpError(400, 'NEW_PROJECT_REVIEWER_NOT_MEMBER', '업무 검토자는 프로젝트 구성원이어야 합니다.');
        }
        const chosenReviewer = nextReviewerUid ? users.get(nextReviewerUid) : null;
        const reviewer = validationValue(resolveNewProjectReviewer({
          assigneeUid: assignee.uid,
          assignedByUid: assigner.uid,
          assignedByName: assigner.name,
          reviewerUid: chosenReviewer?.uid || '',
          reviewerName: chosenReviewer?.name || '',
          leadUid: access.project.lead_uid,
          leadName: access.project.lead_name_snapshot,
        }));
        assigneeUid = assignee.uid;
        assigneeName = assignee.name;
        assignedByUid = assigner.uid;
        assignedByName = assigner.name;
        reviewerUid = reviewer.reviewerUid;
        reviewerName = reviewer.reviewerName;
        reviewerSource = reviewer.source;
        if (reassigned) notifyTarget = assignee;
      }
      const assignmentChanged = reassigned || assignerChanged;
      if (task.status === 'review' && !assignmentChanged) {
        throw new NewProjectHttpError(
          409,
          'NEW_PROJECT_TASK_REVIEW_RECOVERY_REQUIRED',
          '검토 중인 업무는 지시자 또는 담당자를 변경해야 다시 진행할 수 있습니다.',
        );
      }
      if (task.status === 'review' && assignmentChanged && !notifyTarget) {
        notifyTarget = { uid: assigneeUid, name: assigneeName };
      }
      const nextStatus = assignmentChanged ? 'todo' : task.status;
      const updated = await client.query(
        `UPDATE peakos_structured_project_tasks
            SET title = $4, description = $5, due_date = $6, sort_order = $7,
                assignee_uid = $8, assignee_name_snapshot = $9,
                assigned_by_uid = $10, assigned_by_name_snapshot = $11,
                reviewer_uid = $12, reviewer_name_snapshot = $13, reviewer_source = $14,
                status = $15, status_changed_at = CASE WHEN status <> $15 THEN NOW() ELSE status_changed_at END,
                attachments = $17::jsonb,
                version = version + 1, updated_at = NOW()
          WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND version = $16
          RETURNING *`,
        [
          context.workspaceId, projectId, taskId,
          body.title ?? task.title,
          body.description ?? task.description,
          body.dueDate !== undefined ? body.dueDate : task.due_date,
          body.sortOrder ?? task.sort_order,
          assigneeUid, assigneeName, assignedByUid, assignedByName,
          reviewerUid, reviewerName, reviewerSource, nextStatus, body.expectedVersion,
          JSON.stringify(body.attachments !== undefined
            ? body.attachments
            : (Array.isArray(task.attachments) ? task.attachments : [])),
        ],
      );
      if (!updated.rows[0]) throw new NewProjectHttpError(409, 'NEW_PROJECT_TASK_VERSION_CONFLICT', '다른 사용자가 먼저 업무를 변경했습니다.');
      await recordHistory(client, {
        context, projectId, entityType: 'task', entityId: taskId, taskId,
        action: reassigned || assignerChanged ? 'reassigned' : 'updated',
        fromStatus: task.status, toStatus: nextStatus,
        version: Number(updated.rows[0].version),
        metadata: reassigned || assignerChanged ? {
          fromAssigneeUid: task.assignee_uid,
          assigneeUid,
          fromAssignedByUid: task.assigned_by_uid,
          assignedByUid,
          registeredByUid: context.uid,
        } : {},
      });
      await client.query('COMMIT');
      if (notifyTarget) {
        await safeNotifyProjectMember(pool, notifyUser, {
          workspaceId: context.workspaceId,
          projectId,
          uid: notifyTarget.uid,
          title: '업무 재배정',
          body: `${assignedByName}님 지시 · ${context.name}님이 "${updated.rows[0].title}" 업무를 배정했습니다.`,
          data: {
            kind: 'new-project-task', newProjectId: projectId, taskId,
            link: structuredProjectNotificationLink(context, projectId, taskId),
          },
        });
      }
      return res.json({
        task: mapTask(updated.rows[0], {
          uid: context.uid, readOnly: false, canManage: true, isLead: access.isLead,
        }, []),
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  });

  app.delete(`${NEW_PROJECT_BASE_PATH}/:id/tasks/:taskId`, ...writeMiddlewares, async (_req, res) => (
    res.status(409).json({
      code: 'NEW_PROJECT_TASK_HISTORY_PROTECTED',
      error: '지시·검토 이력을 보존하기 위해 등록된 업무는 삭제할 수 없습니다.',
    })
  ));

  app.post(`${NEW_PROJECT_BASE_PATH}/:id/tasks/:taskId/review`, ...writeMiddlewares, async (req, res) => {
    let client;
    let notification;
    try {
      const context = createContext(req, { peakWorkspaceId, isPortfolioViewer, isPortfolioCreator });
      const projectId = validationValue(normalizeNewProjectId(req.params.id, '프로젝트 ID'));
      const taskId = validationValue(normalizeNewProjectId(req.params.taskId, '업무 ID'));
      const body = validationValue(normalizeNewProjectTaskActionBody(req.body));
      client = await pool.connect();
      await client.query('BEGIN');
      const access = await loadProjectAccess(client, context, projectId, { lock: true });
      assertProjectMutable(access.project);
      const taskResult = await client.query(
        `SELECT * FROM peakos_structured_project_tasks
          WHERE workspace_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE`,
        [context.workspaceId, projectId, taskId],
      );
      const task = taskResult.rows[0];
      const isAssignee = String(task?.assignee_uid || '') === context.uid;
      const isReviewer = String(task?.reviewer_uid || '') === context.uid;
      const decision = assertAllowed(newProjectTaskTransitionDecision({
        task,
        action: body.action,
        actorUid: context.uid,
        expectedVersion: body.expectedVersion,
        note: body.note,
        preview: context.isPreview,
        isOversight: context.isOversight,
        isAssignee,
        isReviewer,
        isProjectLead: access.isLead,
      }));
      if (decision.action === 'submit' || decision.action === 'resubmit') {
        const activeReviewer = await findActiveProjectNotificationRecipient(
          client, context.workspaceId, projectId, task.reviewer_uid,
          { lockWorkspaceMembership: true },
        );
        if (!activeReviewer) {
          throw new NewProjectHttpError(
            409,
            'NEW_PROJECT_REVIEWER_UNAVAILABLE',
            '검토자가 현재 프로젝트를 열람할 수 없습니다. 프로젝트 관리자에게 지시자 재지정을 요청해 주세요.',
          );
        }
      }
      if (decision.action === 'request_revision') {
        const activeAssignee = await findActiveProjectNotificationRecipient(
          client, context.workspaceId, projectId, task.assignee_uid,
          { lockWorkspaceMembership: true },
        );
        if (!activeAssignee) {
          throw new NewProjectHttpError(
            409,
            'NEW_PROJECT_ASSIGNEE_UNAVAILABLE',
            '담당자가 현재 프로젝트를 열람할 수 없어 수정 요청을 보낼 수 없습니다.',
          );
        }
      }
      const updated = await client.query(
        `UPDATE peakos_structured_project_tasks
            SET status = $4,
                last_note = $5,
                review_requested_at = CASE WHEN $6 IN ('submit','resubmit') THEN NOW() ELSE review_requested_at END,
                reviewed_at = CASE WHEN $6 IN ('approve','request_revision') THEN NOW() ELSE reviewed_at END,
                status_changed_at = NOW(), version = version + 1, updated_at = NOW()
          WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND version = $7
          RETURNING *`,
        [
          context.workspaceId, projectId, taskId, decision.nextStatus, decision.note,
          decision.action, decision.expectedVersion,
        ],
      );
      if (!updated.rows[0]) throw new NewProjectHttpError(409, 'NEW_PROJECT_TASK_VERSION_CONFLICT', '다른 사용자가 먼저 업무를 변경했습니다.');
      await recordHistory(client, {
        context, projectId, entityType: 'task', entityId: taskId, taskId,
        action: decision.action, fromStatus: decision.fromStatus, toStatus: decision.nextStatus,
        note: decision.note, version: decision.nextVersion,
      });
      await client.query('COMMIT');
      if (decision.action === 'acknowledge' || decision.action === 'start') {
        // 담당자가 스스로 올린 단계는 지시자에게 알린다.
        // 이 분기가 없으면 확인완료를 눌러도 "수정 요청" 알림이 나갔다.
        notification = {
          uid: task.assigned_by_uid,
          title: decision.action === 'acknowledge' ? '업무 확인완료' : '업무 진행 시작',
          body: decision.action === 'acknowledge'
            ? `${context.name}님이 "${task.title}" 업무를 확인했습니다.`
            : `${context.name}님이 "${task.title}" 업무를 시작했습니다.`,
        };
      } else if (decision.action === 'submit' || decision.action === 'resubmit') {
        notification = {
          uid: task.reviewer_uid,
          title: '업무 진행완료',
          body: `${context.name}님이 "${task.title}" 업무를 진행완료했습니다. 검토해 주세요.`,
        };
      } else {
        notification = {
          uid: task.assignee_uid,
          title: decision.action === 'approve' ? '업무 완료 승인' : '업무 수정 요청',
          body: decision.action === 'approve'
            ? `"${task.title}" 업무가 승인되었습니다.`
            : `"${task.title}" 업무에 수정 요청이 도착했습니다.`,
        };
      }
      await safeNotifyProjectMember(pool, notifyUser, {
        workspaceId: context.workspaceId,
        projectId,
        uid: notification.uid,
        title: notification.title,
        body: notification.body,
        data: {
          kind: 'new-project-task-review', newProjectId: projectId, taskId,
          link: structuredProjectNotificationLink(context, projectId, taskId),
        },
      });
      return res.json({
        task: mapTask(updated.rows[0], {
          uid: context.uid,
          readOnly: false,
          canManage: access.canManage,
          isLead: access.isLead,
        }, []),
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  });
}

module.exports = {
  NEW_PROJECT_BASE_PATH,
  NewProjectHttpError,
  createContext,
  ensurePeakosNewProjectInfrastructure,
  mapProjectSummary,
  mapTask,
  registerPeakosNewProjectRoutes,
  requestIsPreview,
};
