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

test('task supervisor authority requires a local project manager membership and excludes oversight', () => {
  const source = between(
    'async function canDirectProjectTasks(req, projectId)',
    'function canReviewProjectTask(req, task)',
  );
  assert.match(source, /req\.workspace\.headquartersOversight/);
  assert.match(source, /req\.userDoc\.role === 'manager'/);
  assert.match(source, /project_members pm/);
  assert.match(source, /pm\.user_id = \$2/);
  assert.match(source, /pwm\.active = TRUE/);
  assert.match(source, /pwm\.role <> 'oversight'/);
});

test('task review authority is persisted reviewer, project owner, or admin only', () => {
  const source = between(
    'function canReviewProjectTask(req, task)',
    'async function resolveProjectTaskAssignees',
  );
  assert.match(source, /req\.userDoc\.role === 'admin'/);
  assert.match(source, /task\.owner_id \|\| task\.project_owner_uid/);
  assert.match(source, /task\.reviewer_uid/);
  assert.doesNotMatch(source, /role === 'manager'/);
});

test('task creation separates self-service members from supervisors and records server-derived lineage atomically', () => {
  const source = between(
    "app.post('/api/projects/:id/tasks', authMiddleware",
    "app.put('/api/projects/:id/tasks/:taskId', authMiddleware",
  );
  assert.match(source, /canAccessProject\(req, req\.params\.id\)/);
  assert.match(source, /canDirectProjectTasks\(req, req\.params\.id\)/);
  assert.match(source, /projectTaskCreationDecision/);
  assert.match(source, /projectTaskCreationReviewer/);
  assert.match(source, /ownerUid: project\.owner_id/);
  assert.match(source, /PROJECT_TASK_SELF_ASSIGN_ONLY|creationDecision\.code/);
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
  assert.match(source, /canDirectProjectTasks/);
  assert.match(source, /canReviewProjectTask/);
  assert.match(source, /PROJECT_TASK_VERSION_CONFLICT/);
  assert.match(source, /statusWillChange = requestedStatus !== before\.status/);
  assert.match(source, /if \(statusWillChange\) \{[\s\S]*addSet\('status', requestedStatus\)/);
  assert.equal((source.match(/addSet\('reviewer_uid', req\.uid\)/g) || []).length, 2);
  assert.equal((source.match(/addSet\('reviewer_name', req\.userName \|\| req\.userEmail \|\| '사용자'\)/g) || []).length, 2);
  assert.match(source, /&& taskAssignmentPatchChanges\(before, req\.body\)/);
  assert.match(source, /if \(canDirectTasks && assignmentUpdate\) \{[\s\S]*addSet\('assigned_by_uid', req\.uid\)/);
  assert.doesNotMatch(source, /canDirectTasks && \(assignmentUpdate \|\| req\.body\.dueDate/);
  assert.match(source, /projectTaskCreationReviewer\(\{/);
  assert.match(source, /assignmentMode: assignmentUpdate\.assignmentMode/);
  assert.match(source, /assigneeUid: assignmentUpdate\.assigneeUid/);
  assert.match(source, /addSet\('reviewer_uid', reviewer\.reviewerUid\)/);
  assert.match(source, /title: '업무 재배정'/);
  assert.match(source, /targetUids: assignmentUpdate[\s\S]*assignmentUpdate\.assignees\.map/);
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
  assert.match(source, /canReviewProjectTask/);
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

test('my-task summary is a static, workspace-scoped assignee read with detail-equivalent permissions', () => {
  const source = between(
    "app.get('/api/projects/my-tasks', authMiddleware",
    "app.get('/api/projects/:id', authMiddleware",
  );
  assert.match(source, /req\.userDoc\?\.approved/);
  assert.match(source, /req\.workspace\.headquartersOversight === true/);
  assert.match(source, /readOnly: true, tasks: \[\]/);
  assert.equal((source.match(/pool\.query\(/g) || []).length, 1);

  assert.match(source, /p\.workspace_id = \$2 OR \(p\.workspace_id IS NULL AND \$2 = \$3\)/);
  assert.match(source, /COALESCE\(pd\.deleted, false\) = false/);
  assert.match(source, /p\.status IS DISTINCT FROM 'archived'/);
  assert.match(source, /current_project_member\.user_id = \$1/);
  assert.match(source, /current_workspace_member\.workspace_id = COALESCE\(p\.workspace_id, \$3\)/);
  assert.match(source, /current_workspace_member\.active = TRUE/);
  assert.match(source, /current_workspace_member\.role <> 'oversight'/);
  assert.match(source, /pt\.assignee_uid = \$1[\s\S]*mine\.user_uid = \$1/);

  assert.equal((source.match(/JSONB_AGG/g) || []).length, 1);
  assert.match(source, /assignee_workspace_member\.workspace_id = COALESCE\(p\.workspace_id, \$3\)/);
  assert.match(source, /assignee_workspace_member\.active = TRUE/);
  assert.match(source, /assignee_workspace_member\.role <> 'oversight'/);
  assert.match(source, /TRUE AS is_assignee/);
  assert.match(source, /AS creator_name/);
  assert.match(source, /reviewer_uid: task\.reviewer_uid \|\| projectOwnerUid/);
  assert.match(source, /reviewer_name: task\.reviewer_name \|\| reviewerDirectoryName/);
  assert.match(source, /can_direct_tasks/);
  assert.match(source, /can_review_task/);
  assert.match(source, /canRequestReview/);
  assert.match(source, /canComplete/);
  assert.match(source, /project: \{[\s\S]*owner_name: projectOwnerName/);
  assert.match(source, /task: \{[\s\S]*permissions:/);
  assert.doesNotMatch(source, /req\.query\.(?:uid|user|workspace)|req\.body/);
});

test('my-task static route is registered before the generic project detail route', () => {
  const staticIndex = indexSource.indexOf("app.get('/api/projects/my-tasks', authMiddleware");
  const dynamicIndex = indexSource.indexOf("app.get('/api/projects/:id', authMiddleware");
  assert.notEqual(staticIndex, -1);
  assert.notEqual(dynamicIndex, -1);
  assert.ok(staticIndex < dynamicIndex);
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
