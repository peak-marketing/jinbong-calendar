'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  projectTaskPatchDecision,
  projectTaskReviewDecision,
  taskIsAssignedTo,
} = require('./project-workflow-policy');

const single = { status: 'doing', assignment_mode: 'single', assignee_uid: 'worker' };
const all = { status: 'doing', assignment_mode: 'all', assignee_uid: null };

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
  assert.equal(projectTaskReviewDecision({ task: single, action: 'approve', actorUid: 'worker', canManage: false }).code, 'PROJECT_TASK_MANAGER_REQUIRED');
  assert.equal(projectTaskReviewDecision({ task: single, action: 'wat', actorUid: 'worker', canManage: false }).code, 'PROJECT_TASK_REVIEW_ACTION_INVALID');
});
