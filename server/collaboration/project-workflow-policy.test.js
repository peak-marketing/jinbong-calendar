'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  projectTaskCreationDecision,
  projectTaskCreationReviewer,
  projectTaskPatchDecision,
  projectTaskReviewDecision,
  taskAssignmentPatchChanges,
  taskIsAssignedTo,
} = require('./project-workflow-policy');

const single = { status: 'doing', assignment_mode: 'single', assignee_uid: 'worker' };
const all = { status: 'doing', assignment_mode: 'all', assignee_uid: null };

test('task creation keeps ordinary members self-only while supervisors can direct project members', () => {
  assert.equal(projectTaskCreationDecision({
    actorUid: 'member', canCreateTasks: true, canDirectTasks: false,
    assignmentMode: 'single', assigneeUid: 'member', status: 'todo',
  }).selfAssigned, true);
  assert.equal(projectTaskCreationDecision({
    actorUid: 'member', canCreateTasks: true, canDirectTasks: false,
    assignmentMode: 'single', assigneeUid: 'other', status: 'todo',
  }).code, 'PROJECT_TASK_SELF_ASSIGN_ONLY');
  assert.equal(projectTaskCreationDecision({
    actorUid: 'member', canCreateTasks: true, canDirectTasks: false,
    assignmentMode: 'all', assigneeUid: '', status: 'todo',
  }).code, 'PROJECT_TASK_SELF_ASSIGN_ONLY');
  assert.equal(projectTaskCreationDecision({
    actorUid: 'member', canCreateTasks: true, canDirectTasks: false,
    assignmentMode: 'single', assigneeUid: 'member', status: 'doing',
  }).code, 'PROJECT_TASK_SELF_STATUS_FORBIDDEN');
  assert.equal(projectTaskCreationDecision({
    actorUid: 'manager', canCreateTasks: true, canDirectTasks: true,
    assignmentMode: 'single', assigneeUid: 'other', status: 'doing',
  }).allowed, true);
  assert.equal(projectTaskCreationDecision({
    actorUid: 'oversight', canCreateTasks: false, canDirectTasks: false,
    assignmentMode: 'single', assigneeUid: 'oversight', status: 'todo',
  }).code, 'PROJECT_TASK_CREATE_FORBIDDEN');
});

test('task creation reviewer is the directing supervisor except for a single self-assignment', () => {
  const common = {
    canDirectTasks: true,
    actorUid: 'manager',
    actorName: '팀장',
    ownerUid: 'owner',
    ownerName: '프로젝트 책임자',
  };
  assert.deepEqual(projectTaskCreationReviewer({
    ...common, assignmentMode: 'single', assigneeUid: 'worker',
  }), { reviewerUid: 'manager', reviewerName: '팀장', instructionReviewerIsActor: true });
  assert.deepEqual(projectTaskCreationReviewer({
    ...common, assignmentMode: 'all', assigneeUid: '',
  }), { reviewerUid: 'manager', reviewerName: '팀장', instructionReviewerIsActor: true });
  assert.deepEqual(projectTaskCreationReviewer({
    ...common, assignmentMode: 'single', assigneeUid: 'manager',
  }), { reviewerUid: 'owner', reviewerName: '프로젝트 책임자', instructionReviewerIsActor: false });
  assert.deepEqual(projectTaskCreationReviewer({
    ...common, canDirectTasks: false, assignmentMode: 'single', assigneeUid: 'member', actorUid: 'member',
  }), { reviewerUid: 'owner', reviewerName: '프로젝트 책임자', instructionReviewerIsActor: false });
});

test('single assignee can request review but cannot self-approve or change the task basis', () => {
  assert.equal(taskIsAssignedTo(single, 'worker'), true);
  assert.equal(projectTaskPatchDecision({ task: single, body: { status: 'review' }, actorUid: 'worker', canManage: false }).allowed, true);
  assert.equal(projectTaskPatchDecision({ task: single, body: { status: 'done' }, actorUid: 'worker', canManage: false }).code, 'PROJECT_TASK_TRANSITION_FORBIDDEN');
  assert.equal(projectTaskPatchDecision({ task: single, body: { dueDate: '2026-08-20' }, actorUid: 'worker', canManage: false }).code, 'PROJECT_TASK_MANAGER_REQUIRED');
  assert.equal(projectTaskPatchDecision({ task: single, body: { status: 'review' }, actorUid: 'other', canManage: false }).code, 'PROJECT_TASK_ASSIGNEE_REQUIRED');
});

test('all-assignee tasks use the per-person completion path instead of direct status patches', () => {
  assert.equal(taskIsAssignedTo(all, 'worker', ['worker', 'other']), true);
  assert.equal(projectTaskPatchDecision({ task: all, body: { status: 'review' }, actorUid: 'worker', canManage: false, assignmentUids: ['worker'] }).code, 'PROJECT_TASK_COMPLETION_REQUIRED');
  assert.equal(projectTaskReviewDecision({ task: all, action: 'request', actorUid: 'worker', canManage: false, assignmentUids: ['worker'] }).code, 'PROJECT_TASK_COMPLETION_REQUIRED');
});

test('manager can edit the basis but only approves a review-requested task', () => {
  assert.equal(projectTaskPatchDecision({ task: single, body: { title: '새 지시', dueDate: '2026-08-20' }, actorUid: 'manager', canManage: true }).allowed, true);
  assert.equal(projectTaskPatchDecision({ task: single, body: { status: 'done' }, actorUid: 'manager', canManage: true }).code, 'PROJECT_TASK_REVIEW_REQUIRED');
  assert.deepEqual(
    projectTaskReviewDecision({ task: { ...single, status: 'review' }, action: 'approve', actorUid: 'manager', canManage: true }),
    { allowed: true, nextStatus: 'done', actorRole: 'manager' },
  );
  assert.deepEqual(
    projectTaskReviewDecision({ task: { ...single, status: 'review' }, action: 'reject', actorUid: 'manager', canManage: true }),
    { allowed: true, nextStatus: 'doing', actorRole: 'manager' },
  );
});

test('manager generic patches follow the explicit transition table and unchanged statuses are edits', () => {
  for (const [from, to] of [
    ['todo', 'doing'],
    ['todo', 'hold'],
    ['doing', 'todo'],
    ['doing', 'hold'],
    ['hold', 'todo'],
    ['hold', 'doing'],
    ['review', 'done'],
    ['review', 'doing'],
  ]) {
    assert.equal(
      projectTaskPatchDecision({ task: { ...single, status: from }, body: { status: to }, actorUid: 'manager', canManage: true }).allowed,
      true,
      `${from} -> ${to}`,
    );
  }

  for (const status of ['todo', 'doing', 'review', 'done', 'hold']) {
    assert.equal(
      projectTaskPatchDecision({ task: { ...single, status }, body: { status, title: '내용 수정' }, actorUid: 'manager', canManage: true }).allowed,
      true,
      `${status} unchanged`,
    );
  }

  assert.equal(projectTaskPatchDecision({ task: { ...single, status: 'done' }, body: { status: 'doing' }, actorUid: 'manager', canManage: true }).code, 'PROJECT_TASK_TRANSITION_FORBIDDEN');
  assert.equal(projectTaskPatchDecision({ task: { ...single, status: 'hold' }, body: { status: 'review' }, actorUid: 'manager', canManage: true }).code, 'PROJECT_TASK_TRANSITION_FORBIDDEN');
  assert.equal(projectTaskPatchDecision({ task: { ...single, status: 'review' }, body: { status: 'hold' }, actorUid: 'manager', canManage: true }).code, 'PROJECT_TASK_TRANSITION_FORBIDDEN');
});

test('a manager can request review through generic compatibility only when also the single assignee', () => {
  assert.equal(
    projectTaskPatchDecision({ task: single, body: { status: 'review' }, actorUid: 'worker', canManage: true }).actorRole,
    'assignee',
  );
  assert.equal(
    projectTaskPatchDecision({ task: single, body: { status: 'review' }, actorUid: 'manager', canManage: true }).code,
    'PROJECT_TASK_TRANSITION_FORBIDDEN',
  );
  assert.equal(
    projectTaskPatchDecision({ task: all, body: { status: 'review' }, actorUid: 'worker', canManage: true, assignmentUids: ['worker'] }).code,
    'PROJECT_TASK_COMPLETION_REQUIRED',
  );
});

test('review actions enforce assigned requester and manager-only decisions', () => {
  assert.equal(projectTaskReviewDecision({ task: single, action: 'request', actorUid: 'worker', canManage: false }).nextStatus, 'review');
  assert.equal(projectTaskReviewDecision({ task: single, action: 'approve', actorUid: 'worker', canManage: false }).code, 'PROJECT_TASK_REVIEWER_REQUIRED');
  assert.equal(projectTaskReviewDecision({ task: single, action: 'wat', actorUid: 'worker', canManage: false }).code, 'PROJECT_TASK_REVIEW_ACTION_INVALID');
});

test('a supervisor may edit task instructions but cannot decide another reviewers request', () => {
  const reviewTask = { ...single, status: 'review' };
  assert.equal(projectTaskPatchDecision({
    task: reviewTask,
    body: { title: '완료 기준 보강' },
    actorUid: 'other-manager',
    canDirectTasks: true,
    canReview: false,
  }).allowed, true);
  assert.equal(projectTaskPatchDecision({
    task: reviewTask,
    body: { status: 'done' },
    actorUid: 'other-manager',
    canDirectTasks: true,
    canReview: false,
  }).code, 'PROJECT_TASK_REVIEWER_REQUIRED');
  assert.equal(projectTaskReviewDecision({
    task: reviewTask,
    action: 'approve',
    actorUid: 'other-manager',
    canReview: false,
  }).code, 'PROJECT_TASK_REVIEWER_REQUIRED');
  assert.equal(projectTaskReviewDecision({
    task: reviewTask,
    action: 'approve',
    actorUid: 'assigned-reviewer',
    canReview: true,
  }).allowed, true);
});

test('a supervisor cannot take over a review by reassigning it or mixing assignment into the review request', () => {
  const reviewTask = { ...single, status: 'review', reviewer_uid: 'assigned-reviewer' };
  assert.equal(projectTaskPatchDecision({
    task: reviewTask,
    body: { status: 'review', assigneeUid: 'other-worker' },
    actorUid: 'other-manager',
    canDirectTasks: true,
    canReview: false,
  }).code, 'PROJECT_TASK_REVIEW_LOCKED');
  assert.equal(projectTaskPatchDecision({
    task: single,
    body: { status: 'review', assigneeUid: 'worker', dueDate: '2026-08-20' },
    actorUid: 'worker',
    canDirectTasks: true,
    canReview: false,
  }).code, 'PROJECT_TASK_REVIEW_REQUEST_MIXED_FORBIDDEN');
  assert.equal(projectTaskPatchDecision({
    task: reviewTask,
    body: { status: 'review', assigneeUid: 'other-worker' },
    actorUid: 'assigned-reviewer',
    canDirectTasks: true,
    canReview: true,
  }).code, 'PROJECT_TASK_REVIEW_LOCKED');
  assert.equal(projectTaskPatchDecision({
    task: { ...reviewTask, status: 'done' },
    body: { assigneeUid: 'other-worker' },
    actorUid: 'assigned-reviewer',
    canDirectTasks: true,
    canReview: true,
  }).code, 'PROJECT_TASK_COMPLETION_LOCKED');
});

test('unchanged assignment payloads are no-ops while actual single/all changes are detected', () => {
  assert.equal(taskAssignmentPatchChanges(single, { assigneeMode: 'single', assigneeUid: 'worker' }), false);
  assert.equal(taskAssignmentPatchChanges(single, { assigneeMode: 'single', assigneeUid: 'other' }), true);
  assert.equal(taskAssignmentPatchChanges(single, { assigneeMode: 'all', assigneeUid: '' }), true);
  assert.equal(taskAssignmentPatchChanges(all, { assigneeMode: 'all', assigneeUid: '' }), false);
  assert.equal(projectTaskPatchDecision({
    task: { ...single, status: 'review' },
    body: { title: '제목 수정', assigneeMode: 'single', assigneeUid: 'worker' },
    actorUid: 'other-manager',
    canDirectTasks: true,
    canReview: false,
  }).allowed, true);
});
