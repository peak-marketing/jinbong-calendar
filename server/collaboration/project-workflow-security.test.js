'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const indexSource = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
const migrationSource = fs.readFileSync(
  path.resolve(__dirname, '../migrations/20260810_peakos_project_workflow.sql'),
  'utf8',
);

function between(start, end) {
  const from = indexSource.indexOf(start);
  const to = indexSource.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return indexSource.slice(from, to);
}

test('task creation is manager-only and records server-derived instruction lineage atomically', () => {
  const source = between(
    "app.post('/api/projects/:id/tasks', authMiddleware",
    "app.put('/api/projects/:id/tasks/:taskId', authMiddleware",
  );
  assert.match(source, /canManageProject\(req, req\.params\.id\)/);
  assert.doesNotMatch(source, /req\.body\.(?:assignedBy|assigned_by|reviewer)/);
  assert.match(source, /assigned_by_uid[\s\S]*reviewer_uid/);
  assert.match(source, /recordProjectTaskWorkflowEvent\(client/);
  assert.match(source, /BEGIN[\s\S]*COMMIT/);
  assert.match(source, /PROJECT_TASK_DUE_DATE_REQUIRED/);
  assert.match(source, /PROJECT_TASK_ASSIGNEE_REQUIRED/);
});

test('generic task edits lock the row, enforce actor transitions, and reject stale versions', () => {
  const source = between(
    "app.put('/api/projects/:id/tasks/:taskId', authMiddleware",
    "app.post('/api/projects/:id/tasks/:taskId/review', authMiddleware",
  );
  assert.match(source, /FOR UPDATE OF pt/);
  assert.match(source, /projectTaskPatchDecision/);
  assert.match(source, /PROJECT_TASK_VERSION_CONFLICT/);
  assert.match(source, /statusWillChange = requestedStatus !== before\.status/);
  assert.match(source, /if \(statusWillChange\) \{[\s\S]*addSet\('status', requestedStatus\)/);
  assert.equal((source.match(/addSet\('reviewer_uid', req\.uid\)/g) || []).length, 2);
  assert.equal((source.match(/addSet\('reviewer_name', req\.userName \|\| req\.userEmail \|\| '사용자'\)/g) || []).length, 2);
  assert.doesNotMatch(source, /req\.body\.(?:reviewerUid|reviewer_uid|reviewerName|reviewer_name)/);
  assert.match(source, /workflow_version = workflow_version \+ 1/);
  assert.match(source, /recordProjectTaskWorkflowEvent\(client/);
});

test('review request, approval, and rejection are one locked transaction with mandatory rejection reason', () => {
  const source = between(
    "app.post('/api/projects/:id/tasks/:taskId/review', authMiddleware",
    "app.put('/api/projects/:id/tasks/:taskId/completion', authMiddleware",
  );
  assert.match(source, /PROJECT_TASK_REVIEW_NOTE_REQUIRED/);
  assert.match(source, /FOR UPDATE OF pt/);
  assert.match(source, /projectTaskReviewDecision/);
  assert.match(source, /PROJECT_TASK_VERSION_CONFLICT/);
  assert.match(source, /project_task_comments/);
  assert.match(source, /project_task_workflow_events|recordProjectTaskWorkflowEvent/);
  assert.match(source, /BEGIN[\s\S]*COMMIT/);
});

test('multi-assignee completion serializes the final check and cannot reopen manager review', () => {
  const source = between(
    "app.put('/api/projects/:id/tasks/:taskId/completion', authMiddleware",
    "app.delete('/api/projects/:id/tasks/:taskId', authMiddleware",
  );
  assert.match(source, /FOR UPDATE OF pt/);
  assert.match(source, /PROJECT_TASK_REVIEW_LOCKED/);
  assert.match(source, /PROJECT_TASK_COMPLETION_LOCKED/);
  assert.doesNotMatch(source, /req\.body\.expectedVersion/);
  assert.match(source, /nextStatus = 'review'/);
  assert.match(source, /recordProjectTaskWorkflowEvent\(client/);
});

test('detail payload exposes instruction, reviewer, and append-only workflow history', () => {
  const source = between(
    "app.get('/api/projects/:id', authMiddleware",
    "app.put('/api/projects/:id', authMiddleware",
  );
  assert.match(source, /creator_name/);
  assert.match(source, /COALESCE\(pt\.reviewer_uid, task_project\.owner_id\)/);
  assert.doesNotMatch(source, /AS reviewer_uid/);
  assert.match(source, /reviewer_uid: task\.reviewer_uid \|\| projectOwnerUid/);
  assert.match(source, /reviewer_name: task\.reviewer_name \|\| reviewerDirectoryName/);
  assert.match(source, /project_task_workflow_events/);
  assert.match(source, /taskWorkflowEvents/);
});

test('versioned migration preserves existing task statuses while adding workflow metadata and audit', () => {
  for (const field of [
    'role_label',
    'assigned_by_uid',
    'reviewer_uid',
    'review_requested_at',
    'reviewed_at',
    'review_note',
    'workflow_version',
  ]) assert.match(migrationSource, new RegExp(field));
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS project_task_workflow_events/);
  assert.doesNotMatch(migrationSource, /DELETE\s+FROM\s+project_tasks/i);
  assert.doesNotMatch(migrationSource, /SET\s+status\s*=\s*['"]/i);
});
