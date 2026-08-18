'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createContext } = require('./peakos-new-project-routes');

const routesSource = fs.readFileSync(path.resolve(__dirname, 'peakos-new-project-routes.js'), 'utf8');
const policySource = fs.readFileSync(path.resolve(__dirname, 'peakos-new-project-policy.js'), 'utf8');
const migrationSource = fs.readFileSync(
  path.resolve(__dirname, '../migrations/20260811_peakos_structured_projects.sql'),
  'utf8',
);
const mediumManagerMigrationSource = fs.readFileSync(
  path.resolve(__dirname, '../migrations/20260811_peakos_structured_projects_medium_managers.sql'),
  'utf8',
);
const indexSource = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test('본사 oversight 멤버는 지사 포트폴리오만 전체 열람하고 쓰지 못한다', () => {
  const context = createContext({
    uid: 'uid-son-myungah',
    userDoc: { name: '손명아', approved: true, is_active: true },
    workspace: {
      id: 'ws_daegu', role: 'oversight', headquartersOversight: true,
    },
    headers: {},
  }, {
    peakWorkspaceId: 'ws_peak',
    isPortfolioViewer: () => false,
    isPortfolioCreator: () => false,
  });
  assert.equal(context.viewPortfolio, true);
  assert.equal(context.readOnly, true);
  assert.equal(context.canCreateProject, false);
  assert.equal(context.isNonPeakManager, false);
});

test('six-table migration is isolated from every legacy project table and preserves append-only history', () => {
  const creates = migrationSource.match(/CREATE TABLE IF NOT EXISTS peakos_structured_[a-z_]+/g) || [];
  assert.equal(creates.length, 6);
  for (const table of [
    'peakos_structured_projects',
    'peakos_structured_project_members',
    'peakos_structured_project_medium_categories',
    'peakos_structured_project_small_categories',
    'peakos_structured_project_tasks',
    'peakos_structured_project_history',
  ]) assert.match(migrationSource, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));

  assert.doesNotMatch(
    migrationSource,
    /(?:ALTER\s+TABLE|INSERT\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+TABLE)\s+(?:public\.)?(?:projects|project_tasks|project_members)\b/i,
  );
  assert.match(migrationSource, /PRIMARY KEY \(workspace_id, id\)/);
  assert.match(migrationSource, /peakos_structured_project_tasks_small_hierarchy_fk/);
  assert.match(migrationSource, /FOREIGN KEY \(workspace_id, project_id, medium_category_id, small_category_id\)/);
  assert.match(migrationSource, /peakos_structured_project_tasks_assignee_fk/);
  assert.match(migrationSource, /reviewer_uid <> assignee_uid/);
  assert.match(migrationSource, /peakos_structured_project_history_no_mutation/);
  assert.match(migrationSource, /BEFORE UPDATE OR DELETE ON peakos_structured_project_history/);
  assert.match(migrationSource, /peakos_structured_projects_lead_project_member_fk/);
  assert.match(migrationSource, /peakos_structured_projects_active_lead_guard/);
  assert.match(migrationSource, /peakos_structured_project_members_active_lead_guard/);
});

test('중분류 담당자 마이그레이션은 기존 행을 NULL로 보존하고 활성 프로젝트 팀원만 참조한다', () => {
  assert.match(mediumManagerMigrationSource, /ADD COLUMN IF NOT EXISTS manager_uid TEXT/);
  assert.match(mediumManagerMigrationSource, /ADD COLUMN IF NOT EXISTS manager_name_snapshot TEXT/);
  assert.match(mediumManagerMigrationSource, /FOREIGN KEY \(workspace_id, project_id, manager_uid\)/);
  assert.match(mediumManagerMigrationSource, /REFERENCES peakos_structured_project_members\(workspace_id, project_id, user_uid\)/);
  assert.match(mediumManagerMigrationSource, /medium\.active = TRUE/);
  assert.match(mediumManagerMigrationSource, /member\.active = TRUE/);
  assert.match(mediumManagerMigrationSource, /peakos_structured_project_medium_manager_guard/);
  assert.match(mediumManagerMigrationSource, /peakos_structured_project_members_medium_manager_guard/);
  assert.doesNotMatch(
    mediumManagerMigrationSource,
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+peakos_structured_project_medium_categories\b/i,
  );
  assert.doesNotMatch(
    mediumManagerMigrationSource,
    /\b(?:projects|project_tasks|project_members)\b/i,
  );
});

test('portfolio capability is derived from immutable UID set and never display name or generic Peak admin role', () => {
  const source = between(routesSource, 'function createContext(req,', 'async function resolveWorkspaceUsers');
  assert.match(source, /isPortfolioViewer\(req\) === true/);
  assert.match(source, /isPortfolioCreator\(req\) === true/);
  assert.doesNotMatch(source, /userDoc\?\.(?:name|role)|userName|displayName/);
  assert.match(source, /workspace\.id === peakWorkspaceId && portfolioCreateAccess/);
  assert.match(source, /workspace\.id !== peakWorkspaceId\s+&& \['admin', 'manager'\]\.includes\(workspace\.role\)/);
  assert.match(source, /viewPortfolio: hasPortfolioAccess \|\| isNonPeakManager \|\| isOversight/);
  assert.doesNotMatch(policySource, /패션TV봉이|박종원|김대호/);
});

test('list and detail reads bind every relation to the authenticated workspace and ordinary UID', () => {
  const list = between(
    routesSource,
    'app.get(NEW_PROJECT_BASE_PATH,',
    'app.post(NEW_PROJECT_BASE_PATH,',
  );
  assert.match(list, /p\.workspace_id = \$1/);
  assert.match(list, /p\.lead_uid = \$2/);
  assert.match(list, /mine\.workspace_id = p\.workspace_id/);
  assert.match(list, /mine\.project_id = p\.id/);
  assert.match(list, /mine\.user_uid = \$2/);
  assert.doesNotMatch(list, /mine_task/);
  assert.doesNotMatch(list, /req\.(?:query|body).*(?:uid|workspace)/);

  const access = between(routesSource, 'async function loadProjectAccess', 'function assertCanManage');
  assert.match(access, /p\.workspace_id = \$1 AND p\.id = \$2/);
  assert.match(access, /member\.workspace_id = p\.workspace_id/);
  assert.doesNotMatch(access, /AS is_assignee|task\.assignee_uid/);
  assert.match(access, /\[context\.workspaceId, projectId, context\.uid\]/);
});

test('exact-three creator-member may edit settings without broadening category or assignment management', () => {
  const access = between(routesSource, 'async function loadProjectAccess', 'function assertCanManage');
  assert.match(access, /const isLead = String\(project\.lead_uid\) === context\.uid/);
  assert.match(access, /project\.is_project_member === true/);
  assert.match(access, /const canManage = !context\.isPreview && !context\.isOversight && \(isLead \|\| isManagerMember\)/);
  assert.match(access, /context\.isPeakWorkspace/);
  assert.match(access, /context\.isPortfolioViewer/);
  assert.match(access, /String\(project\.created_by_uid\) === context\.uid/);
  assert.match(access, /canEditProjectSettings: canManage/);

  const createContextSource = between(routesSource, 'function createContext(req,', 'async function resolveWorkspaceUsers');
  assert.match(createContextSource, /canCreateProject/);
  const create = between(routesSource, 'app.post(NEW_PROJECT_BASE_PATH,', 'app.get(`${NEW_PROJECT_BASE_PATH}/:id`');
  assert.match(create, /if \(!context\.canCreateProject\)/);
  assert.match(create, /resolveWorkspaceUsers\(client, context\.workspaceId/);

  const projectUpdate = between(
    routesSource,
    'app.put(`${NEW_PROJECT_BASE_PATH}/:id`',
    'app.delete(`${NEW_PROJECT_BASE_PATH}/:id`',
  );
  assert.match(projectUpdate, /assertCanEditProjectSettings\(access\)/);
  const categoryCreate = between(
    routesSource,
    'async function createCategory',
    'app.post(`${NEW_PROJECT_BASE_PATH}/:id/mediums`',
  );
  assert.match(categoryCreate, /assertCanManage\(access\)/);
});

test('중분류 managerUid는 실제 담당자의 manageProject 경계와 프로젝트 팀원 검증 안에서만 저장된다', () => {
  const createCategory = between(
    routesSource,
    'async function createCategory',
    'app.post(`${NEW_PROJECT_BASE_PATH}/:id/mediums`',
  );
  assert.match(createCategory, /assertCanManage\(access\)/);
  assert.match(createCategory, /resolveMediumManager\(client, context, projectId, body\.managerUid\)/);
  assert.match(createCategory, /manager_uid, manager_name_snapshot/);
  assert.match(createCategory, /manager: manager \|\| null/);

  const updateCategory = between(
    routesSource,
    'async function updateCategory',
    'app.put(`${NEW_PROJECT_BASE_PATH}/:id/mediums/:mediumId`',
  );
  assert.match(updateCategory, /assertCanManage\(access\)/);
  assert.match(updateCategory, /body\.managerUid !== undefined/);
  assert.match(updateCategory, /resolveMediumManager\(client, context, projectId, body\.managerUid\)/);
  assert.match(updateCategory, /manager_uid = \$7, manager_name_snapshot = \$8/);
  assert.match(updateCategory, /version = \$9/);

  const managerResolution = between(routesSource, 'async function resolveMediumManager', 'async function loadProjectAccess');
  assert.match(managerResolution, /resolveWorkspaceUsers\(db, context\.workspaceId, \[managerUid\]\)/);
  assert.match(managerResolution, /workspace_id = \$1 AND project_id = \$2 AND user_uid = \$3 AND active = TRUE/);
  assert.match(managerResolution, /NEW_PROJECT_MEDIUM_MANAGER_NOT_MEMBER/);

  const projectUpdate = between(
    routesSource,
    'app.put(`${NEW_PROJECT_BASE_PATH}/:id`',
    'app.delete(`${NEW_PROJECT_BASE_PATH}/:id`',
  );
  assert.match(projectUpdate, /manager_uid = ANY\(\$3::text\[\]\)/);
  assert.match(projectUpdate, /NEW_PROJECT_MEMBER_MANAGES_MEDIUM/);
});

test('새 프로젝트 역할 지정은 workspace membership 잠금으로 소속 비활성화와 직렬화된다', () => {
  const resolver = between(
    routesSource,
    'async function resolveWorkspaceUsers',
    'async function resolveMediumManager',
  );
  assert.match(resolver, /membership\.active = TRUE/);
  assert.match(resolver, /membership\.role <> 'oversight'/);
  assert.match(resolver, /membership\.permissions ->> 'projects'/);
  assert.match(resolver, /JOIN peakos_workspaces workspace/);
  assert.match(resolver, /workspace\.active = TRUE/);
  assert.match(resolver, /u\.approved = TRUE/);
  assert.match(resolver, /COALESCE\(u\.is_active, TRUE\) = TRUE/);
  assert.match(resolver, /COALESCE\(u\.chat_only, FALSE\) = FALSE/);
  assert.match(resolver, /COALESCE\(u\.external_calendar_only, FALSE\) = FALSE/);
  assert.match(resolver, /FOR KEY SHARE OF u, membership/);

  const recipient = between(
    routesSource,
    'async function findActiveProjectNotificationRecipient',
    'async function safeNotifyProjectMember',
  );
  assert.match(recipient, /lockWorkspaceMembership = false/);
  assert.match(recipient, /FOR KEY SHARE OF workspace_member, project_member/);

  const review = between(
    routesSource,
    'app.post(`${NEW_PROJECT_BASE_PATH}/:id/tasks/:taskId/review`',
    '\n}\n\nmodule.exports',
  );
  assert.equal((review.match(/\{ lockWorkspaceMembership: true \}/g) || []).length, 2);
});

test('project hierarchy, assignee membership and task mutations all reject cross-parent IDs', () => {
  const createTask = between(
    routesSource,
    'app.post(`${NEW_PROJECT_BASE_PATH}/:id/mediums/:mediumId/smalls/:smallId/tasks`',
    'app.put(`${NEW_PROJECT_BASE_PATH}/:id/tasks/:taskId`',
  );
  assert.match(createTask, /small\.workspace_id = \$1 AND small\.project_id = \$2/);
  assert.match(createTask, /small\.medium_category_id = \$3 AND small\.id = \$4/);
  assert.match(createTask, /WHERE workspace_id = \$1 AND project_id = \$2[\s\S]*user_uid = ANY\(\$3::text\[\]\) AND active = TRUE/);
  assert.match(createTask, /NEW_PROJECT_HIERARCHY_NOT_FOUND/);
  assert.match(createTask, /NEW_PROJECT_ASSIGNEE_NOT_MEMBER/);

  const updateTask = between(
    routesSource,
    'app.put(`${NEW_PROJECT_BASE_PATH}/:id/tasks/:taskId`',
    'app.delete(`${NEW_PROJECT_BASE_PATH}/:id/tasks/:taskId`',
  );
  assert.match(updateTask, /workspace_id = \$1 AND project_id = \$2 AND id = \$3 FOR UPDATE/);
  assert.match(updateTask, /WHERE workspace_id = \$1 AND project_id = \$2 AND id = \$3 AND version = \$16/);
  assert.match(updateTask, /NEW_PROJECT_TASK_EDIT_LOCKED/);
});

test('selected instructor UID is server-validated, canonically named, and persisted as the reviewer', () => {
  const normalizers = between(
    routesSource,
    'function normalizeTaskCreateBody',
    'function mapMember',
  );
  assert.match(normalizers, /assignedByUid/);
  assert.match(normalizers, /normalizeNewProjectUid\(body\.assignedByUid, '업무 지시자'\)/);

  const createTask = between(
    routesSource,
    'app.post(`${NEW_PROJECT_BASE_PATH}/:id/mediums/:mediumId/smalls/:smallId/tasks`',
    'app.put(`${NEW_PROJECT_BASE_PATH}/:id/tasks/:taskId`',
  );
  assert.match(createTask, /body\.assignedByUid/);
  assert.match(createTask, /NEW_PROJECT_ASSIGNER_NOT_MEMBER/);
  assert.match(createTask, /assignedByUid: assigner\.uid/);
  assert.match(createTask, /assignedByName: assigner\.name/);
  assert.match(createTask, /reviewer\.reviewerUid/);
  assert.doesNotMatch(createTask, /assignedByUid: context\.uid/);
  assert.doesNotMatch(createTask, /req\.body\.(?:assignedByName|assigned_by|reviewer)/);

  const updateTask = between(
    routesSource,
    'app.put(`${NEW_PROJECT_BASE_PATH}/:id/tasks/:taskId`',
    'app.delete(`${NEW_PROJECT_BASE_PATH}/:id/tasks/:taskId`',
  );
  assert.match(updateTask, /let assignedByUid = task\.assigned_by_uid/);
  assert.match(updateTask, /body\.assignedByUid !== undefined/);
  assert.match(updateTask, /NEW_PROJECT_ASSIGNER_NOT_MEMBER/);
  assert.match(updateTask, /assignedByUid = assigner\.uid/);
  assert.match(updateTask, /reviewerUid = reviewer\.reviewerUid/);

  const review = between(
    routesSource,
    'app.post(`${NEW_PROJECT_BASE_PATH}/:id/tasks/:taskId/review`',
    '\n}\n\nmodule.exports',
  );
  assert.match(review, /task\.reviewer_uid/);
  assert.match(review, /task\.assignee_uid/);
  assert.match(review, /FOR UPDATE/);
  assert.match(review, /decision\.expectedVersion/);
  assert.match(review, /AND version = \$7/);
  assert.match(review, /recordHistory\(client/);
  assert.match(review, /BEGIN[\s\S]*COMMIT/);
});

test('preview returns zero portfolio rows, rejects detail, and task history cannot be deleted', () => {
  const list = between(routesSource, 'app.get(NEW_PROJECT_BASE_PATH,', 'app.post(NEW_PROJECT_BASE_PATH,');
  assert.match(list, /if \(context\.isPreview\)/);
  assert.match(list, /projects: \[\]/);
  assert.match(list, /createProject: false/);

  const detail = between(
    routesSource,
    'app.get(`${NEW_PROJECT_BASE_PATH}/:id`',
    'app.put(`${NEW_PROJECT_BASE_PATH}/:id`',
  );
  assert.match(detail, /NEW_PROJECT_PREVIEW_DATA_HIDDEN/);
  const deletion = between(
    routesSource,
    'app.delete(`${NEW_PROJECT_BASE_PATH}/:id/tasks/:taskId`',
    'app.post(`${NEW_PROJECT_BASE_PATH}/:id/tasks/:taskId/review`',
  );
  assert.match(deletion, /NEW_PROJECT_TASK_HISTORY_PROTECTED/);
  assert.doesNotMatch(deletion, /DELETE FROM/);
});

test('new routes are registered as an additive module while legacy project handlers remain intact', () => {
  assert.match(indexSource, /registerPeakosNewProjectRoutes/);
  assert.match(indexSource, /app\.get\('\/api\/projects', authMiddleware/);
  assert.match(indexSource, /app\.get\('\/api\/projects\/:id', authMiddleware/);
  assert.match(indexSource, /app\.post\('\/api\/projects\/:id\/tasks', authMiddleware/);
  assert.match(indexSource, /app\.post\('\/api\/projects\/:id\/tasks\/:taskId\/review', authMiddleware/);
  assert.doesNotMatch(routesSource, /FROM projects\b|FROM project_tasks\b|UPDATE projects\b|UPDATE project_tasks\b/i);
});

test('canonical and protected aliases both require OS second factor and explicit project workspace permission', () => {
  const registration = between(
    indexSource,
    'registerPeakosNewProjectRoutes({',
    "app.use(\n  '/api/peakos/company-documents'",
  );
  assert.match(registration, /authMiddleware/);
  assert.match(registration, /peakosOsEmailAuth\.requireOsSession/);
  assert.match(registration, /requireWorkspace\(\{ area: 'projects', action: 'read', requireHeader: true \}\)/);
  assert.match(registration, /requireWorkspace\(\{ area: 'projects', action: 'write', requireHeader: true \}\)/);
  assert.match(indexSource, /\^\\\/api\\\/(?:\(\?:)?projects\|new-projects/);
  assert.match(indexSource, /suffix\.startsWith\('\/new-projects'\)/);
});
