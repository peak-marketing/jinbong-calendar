'use strict';

const crypto = require('node:crypto');
const {
  NEW_PROJECT_PROJECT_STATUSES,
  NEW_PROJECT_SCHEMA_READINESS_SQL,
  newProjectCreateDecision,
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
    ['title', 'description', 'dueDate', 'assigneeUid', 'assignedByUid', 'sortOrder', 'attachments'],
    '체크리스트 업무',
  ));
  return {
    title: validationValue(normalizeNewProjectText(body.title, { field: '업무명', max: 240 })),
    description: validationValue(normalizeNewProjectText(body.description, {
      field: '업무 설명', required: false, max: 20000,
    })),
    dueDate: validationValue(normalizeNewProjectDate(body.dueDate)),
    attachments: normalizeTaskAttachments(body.attachments) ?? [],
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
    ['title', 'description', 'dueDate', 'assigneeUid', 'assignedByUid', 'sortOrder', 'expectedVersion', 'attachments'],
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
      const [membersResult, mediumsResult, smallsResult, tasksResult, historyResult] = await Promise.all([
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
      ]);
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
        });
        smallsByMedium.set(key, rows);
      }
      const mediumCategories = mediumsResult.rows.map(row => ({
        id: String(row.id), name: row.name, description: row.description || '',
        manager: mapMediumManager(row),
        sortOrder: Number(row.sort_order || 0), version: Number(row.version || 1),
        smallCategories: smallsByMedium.get(String(row.id)) || [],
      }));
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
        [body.assigneeUid, selectedAssignerUid],
      );
      const members = await client.query(
        `SELECT user_uid FROM peakos_structured_project_members
          WHERE workspace_id = $1 AND project_id = $2
            AND user_uid = ANY($3::text[]) AND active = TRUE`,
        [context.workspaceId, projectId, [body.assigneeUid, selectedAssignerUid]],
      );
      const activeMemberUids = new Set(members.rows.map(row => String(row.user_uid)));
      if (!activeMemberUids.has(body.assigneeUid) || !users.has(body.assigneeUid)) {
        throw new NewProjectHttpError(400, 'NEW_PROJECT_ASSIGNEE_NOT_MEMBER', '업무 담당자는 프로젝트 구성원이어야 합니다.');
      }
      if (!activeMemberUids.has(selectedAssignerUid) || !users.has(selectedAssignerUid)) {
        throw new NewProjectHttpError(400, 'NEW_PROJECT_ASSIGNER_NOT_MEMBER', '업무 지시자는 프로젝트 구성원이어야 합니다.');
      }
      const assignee = users.get(body.assigneeUid);
      const assigner = users.get(selectedAssignerUid);
      const reviewer = validationValue(resolveNewProjectReviewer({
        assigneeUid: assignee.uid,
        assignedByUid: assigner.uid,
        assignedByName: assigner.name,
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
          [nextAssigneeUid, nextAssignerUid],
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
        const reviewer = validationValue(resolveNewProjectReviewer({
          assigneeUid: assignee.uid,
          assignedByUid: assigner.uid,
          assignedByName: assigner.name,
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
