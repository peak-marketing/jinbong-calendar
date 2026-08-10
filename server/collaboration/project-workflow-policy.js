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

function taskIsAssignedTo(task, actorUid, assignmentUids = []) {
  const uid = String(actorUid || '');
  if (!uid) return false;
  if (String(task?.assignment_mode || '') === 'all') {
    return assignmentUids.some(value => String(value || '') === uid);
  }
  return String(task?.assignee_uid || '') === uid;
}

function projectTaskPatchDecision({ task, body = {}, actorUid, canManage, assignmentUids = [] }) {
  if (!task) return { allowed: false, code: 'PROJECT_TASK_NOT_FOUND', error: '업무를 찾을 수 없습니다.' };
  const keys = Object.keys(body || {}).filter(key => body[key] !== undefined);
  if (canManage) {
    if (body.status === undefined || String(body.status || '') === String(task.status || '')) {
      return { allowed: true, actorRole: 'manager' };
    }

    const currentStatus = String(task.status || 'todo');
    const requestedStatus = String(body.status || '');
    if (
      requestedStatus === 'review'
      && ['todo', 'doing'].includes(currentStatus)
      && taskIsAssignedTo(task, actorUid, assignmentUids)
    ) {
      if (String(task.assignment_mode || 'single') === 'all') {
        return {
          allowed: false,
          code: 'PROJECT_TASK_COMPLETION_REQUIRED',
          error: '모두 담당 업무는 개인별 체크리스트를 완료해 검토를 요청하세요.',
        };
      }
      return { allowed: true, actorRole: 'assignee' };
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

function projectTaskReviewDecision({ task, action, actorUid, canManage, assignmentUids = [] }) {
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

  if (!canManage) {
    return { allowed: false, code: 'PROJECT_TASK_MANAGER_REQUIRED', error: '프로젝트 책임자만 검토를 승인하거나 반려할 수 있습니다.' };
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
  projectTaskPatchDecision,
  projectTaskReviewDecision,
  taskIsAssignedTo,
};
