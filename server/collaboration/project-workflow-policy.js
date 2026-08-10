'use strict';

const PROJECT_TASK_BASIS_FIELDS = Object.freeze([
  'title',
  'description',
  'roleLabel',
  'role_label',
  'dueDate',
  'due_date',
  'assigneeMode',
  'assignment_mode',
  'assigneeUid',
  'assignee_uid',
]);

const PROJECT_TASK_MANAGER_TRANSITIONS = Object.freeze({
  todo: Object.freeze(['doing', 'hold']),
  doing: Object.freeze(['todo', 'hold']),
  review: Object.freeze(['done', 'doing']),
  done: Object.freeze([]),
  hold: Object.freeze(['todo', 'doing']),
});

function projectTaskCreationDecision({
  actorUid,
  canCreateTasks,
  canDirectTasks,
  assignmentMode = 'single',
  assigneeUid = '',
  status = 'todo',
}) {
  const normalizedStatus = String(status || 'todo').trim();
  if (!canCreateTasks) {
    return {
      allowed: false,
      code: 'PROJECT_TASK_CREATE_FORBIDDEN',
      error: '이 프로젝트에 업무를 등록할 권한이 없습니다.',
    };
  }
  if (!['todo', 'doing', 'hold'].includes(normalizedStatus)) {
    return {
      allowed: false,
      code: 'PROJECT_TASK_REVIEW_REQUIRED',
      error: '새 업무는 담당자의 검토 요청 전 상태로만 등록할 수 있습니다.',
    };
  }
  if (canDirectTasks) {
    return { allowed: true, actorRole: 'supervisor', selfAssigned: false };
  }
  if (
    String(assignmentMode || 'single') !== 'single'
    || !actorUid
    || String(assigneeUid || '') !== String(actorUid)
  ) {
    return {
      allowed: false,
      code: 'PROJECT_TASK_SELF_ASSIGN_ONLY',
      error: '일반 프로젝트 멤버는 본인 업무만 등록할 수 있습니다.',
    };
  }
  if (normalizedStatus !== 'todo') {
    return {
      allowed: false,
      code: 'PROJECT_TASK_SELF_STATUS_FORBIDDEN',
      error: '본인 업무는 대기 상태로만 등록할 수 있습니다.',
    };
  }
  return { allowed: true, actorRole: 'member', selfAssigned: true };
}

function projectTaskCreationReviewer({
  canDirectTasks,
  assignmentMode = 'single',
  assigneeUid = '',
  actorUid = '',
  actorName = '',
  ownerUid = '',
  ownerName = '',
}) {
  const isSingleSelfAssignment = String(assignmentMode || 'single') === 'single'
    && String(assigneeUid || '') === String(actorUid || '');
  const instructionReviewerIsActor = canDirectTasks && !isSingleSelfAssignment;
  return instructionReviewerIsActor
    ? { reviewerUid: actorUid, reviewerName: actorName, instructionReviewerIsActor: true }
    : { reviewerUid: ownerUid, reviewerName: ownerName, instructionReviewerIsActor: false };
}

function taskIsAssignedTo(task, actorUid, assignmentUids = []) {
  const uid = String(actorUid || '');
  if (!uid) return false;
  if (String(task?.assignment_mode || '') === 'all') {
    return assignmentUids.some(value => String(value || '') === uid);
  }
  return String(task?.assignee_uid || '') === uid;
}

function taskAssignmentPatchChanges(task, body = {}) {
  const hasMode = body.assigneeMode !== undefined || body.assignment_mode !== undefined;
  const hasUid = body.assigneeUid !== undefined || body.assignee_uid !== undefined;
  if (!hasMode && !hasUid) return false;
  const currentMode = String(task?.assignment_mode || 'single') === 'all' ? 'all' : 'single';
  const requestedMode = hasMode
    ? (String(body.assigneeMode ?? body.assignment_mode ?? '') === 'all' ? 'all' : 'single')
    : currentMode;
  if (requestedMode !== currentMode) return true;
  if (requestedMode === 'all') return false;
  const requestedUid = hasUid
    ? String(body.assigneeUid ?? body.assignee_uid ?? '')
    : String(task?.assignee_uid || '');
  return requestedUid !== String(task?.assignee_uid || '');
}

function projectTaskPatchDecision({
  task,
  body = {},
  actorUid,
  canManage,
  canDirectTasks = canManage,
  canReview = canManage,
  assignmentUids = [],
}) {
  if (!task) return { allowed: false, code: 'PROJECT_TASK_NOT_FOUND', error: '업무를 찾을 수 없습니다.' };
  const keys = Object.keys(body || {}).filter(key => body[key] !== undefined);
  if (canDirectTasks) {
    const currentStatus = String(task.status || 'todo');
    const requestedStatus = body.status === undefined ? currentStatus : String(body.status || '');
    const assignmentFields = new Set(['assigneeMode', 'assignment_mode', 'assigneeUid', 'assignee_uid']);
    if (
      ['review', 'done'].includes(currentStatus)
      && keys.some(key => assignmentFields.has(key))
      && taskAssignmentPatchChanges(task, body)
    ) {
      return {
        allowed: false,
        code: currentStatus === 'review' ? 'PROJECT_TASK_REVIEW_LOCKED' : 'PROJECT_TASK_COMPLETION_LOCKED',
        error: currentStatus === 'review'
          ? '검토 요청 중에는 담당자를 변경할 수 없습니다. 반려 후 다시 배정하세요.'
          : '완료 승인된 업무의 담당자 이력은 변경할 수 없습니다.',
      };
    }
    if (body.status === undefined || requestedStatus === currentStatus) {
      return { allowed: true, actorRole: 'manager' };
    }

    if (
      requestedStatus === 'review'
      && ['todo', 'doing'].includes(currentStatus)
      && taskIsAssignedTo(task, actorUid, assignmentUids)
    ) {
      const reviewRequestFields = new Set(['status', 'expectedVersion', 'reviewNote']);
      if (keys.some(key => !reviewRequestFields.has(key))) {
        return {
          allowed: false,
          code: 'PROJECT_TASK_REVIEW_REQUEST_MIXED_FORBIDDEN',
          error: '검토 요청과 업무 내용·담당자·마감일 변경은 한번에 처리할 수 없습니다.',
        };
      }
      if (String(task.assignment_mode || 'single') === 'all') {
        return {
          allowed: false,
          code: 'PROJECT_TASK_COMPLETION_REQUIRED',
          error: '모두 담당 업무는 개인별 체크리스트를 완료해 검토를 요청하세요.',
        };
      }
      return { allowed: true, actorRole: 'assignee' };
    }
    if (
      currentStatus === 'review'
      && ['done', 'doing'].includes(requestedStatus)
      && !canReview
    ) {
      return {
        allowed: false,
        code: 'PROJECT_TASK_REVIEWER_REQUIRED',
        error: '지정 검토자·프로젝트 책임자·관리자만 검토를 처리할 수 있습니다.',
      };
    }
    if ((PROJECT_TASK_MANAGER_TRANSITIONS[currentStatus] || []).includes(requestedStatus)) {
      return { allowed: true, actorRole: 'manager' };
    }
    if (requestedStatus === 'done' && currentStatus !== 'review') {
      return {
        allowed: false,
        code: 'PROJECT_TASK_REVIEW_REQUIRED',
        error: '담당자의 검토 요청 후에만 완료 승인할 수 있습니다.',
      };
    }
    return {
      allowed: false,
      code: 'PROJECT_TASK_TRANSITION_FORBIDDEN',
      error: '현재 상태에서는 요청한 업무 상태로 변경할 수 없습니다.',
    };
  }

  if (!taskIsAssignedTo(task, actorUid, assignmentUids)) {
    return { allowed: false, code: 'PROJECT_TASK_ASSIGNEE_REQUIRED', error: '이 업무의 담당자만 검토를 요청할 수 있습니다.' };
  }
  if (String(task.assignment_mode || 'single') === 'all') {
    return {
      allowed: false,
      code: 'PROJECT_TASK_COMPLETION_REQUIRED',
      error: '모두 담당 업무는 개인별 체크리스트를 완료해 검토를 요청하세요.',
    };
  }
  const assigneePatchFields = new Set(['status', 'expectedVersion', 'reviewNote']);
  if (keys.some(key => PROJECT_TASK_BASIS_FIELDS.includes(key)) || keys.some(key => !assigneePatchFields.has(key))) {
    return {
      allowed: false,
      code: 'PROJECT_TASK_MANAGER_REQUIRED',
      error: '업무 내용·담당자·역할·마감일은 프로젝트 책임자만 변경할 수 있습니다.',
    };
  }
  if (body.status !== 'review' || !['todo', 'doing'].includes(String(task.status || ''))) {
    return {
      allowed: false,
      code: 'PROJECT_TASK_TRANSITION_FORBIDDEN',
      error: '담당자는 진행 중인 업무의 검토 요청만 할 수 있습니다.',
    };
  }
  return { allowed: true, actorRole: 'assignee' };
}

function projectTaskReviewDecision({ task, action, actorUid, canManage, canReview = canManage, assignmentUids = [] }) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (!['request', 'approve', 'reject'].includes(normalizedAction)) {
    return { allowed: false, code: 'PROJECT_TASK_REVIEW_ACTION_INVALID', error: '검토 처리 방식이 올바르지 않습니다.' };
  }
  if (!task) return { allowed: false, code: 'PROJECT_TASK_NOT_FOUND', error: '업무를 찾을 수 없습니다.' };

  if (normalizedAction === 'request') {
    if (String(task.assignment_mode || 'single') === 'all') {
      return {
        allowed: false,
        code: 'PROJECT_TASK_COMPLETION_REQUIRED',
        error: '모두 담당 업무는 개인별 체크리스트를 완료해 검토를 요청하세요.',
      };
    }
    if (!taskIsAssignedTo(task, actorUid, assignmentUids)) {
      return { allowed: false, code: 'PROJECT_TASK_ASSIGNEE_REQUIRED', error: '이 업무의 담당자만 검토를 요청할 수 있습니다.' };
    }
    if (!['todo', 'doing'].includes(String(task.status || ''))) {
      return { allowed: false, code: 'PROJECT_TASK_TRANSITION_FORBIDDEN', error: '진행 중인 업무만 검토를 요청할 수 있습니다.' };
    }
    return { allowed: true, nextStatus: 'review', actorRole: 'assignee' };
  }

  if (!canReview) {
    return { allowed: false, code: 'PROJECT_TASK_REVIEWER_REQUIRED', error: '지정 검토자·프로젝트 책임자·관리자만 검토를 승인하거나 반려할 수 있습니다.' };
  }
  if (task.status !== 'review') {
    return { allowed: false, code: 'PROJECT_TASK_REVIEW_REQUIRED', error: '검토 요청 상태의 업무만 처리할 수 있습니다.' };
  }
  return {
    allowed: true,
    nextStatus: normalizedAction === 'approve' ? 'done' : 'doing',
    actorRole: 'manager',
  };
}

module.exports = {
  PROJECT_TASK_BASIS_FIELDS,
  PROJECT_TASK_MANAGER_TRANSITIONS,
  projectTaskCreationDecision,
  projectTaskCreationReviewer,
  projectTaskPatchDecision,
  projectTaskReviewDecision,
  taskAssignmentPatchChanges,
  taskIsAssignedTo,
};
