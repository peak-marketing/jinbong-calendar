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
  assert.match(list, /mine_task\.workspace_id = p\.workspace_id/);
  assert.match(list, /mine_task\.assignee_uid = \$2/);
  assert.doesNotMatch(list, /req\.(?:query|body).*(?:uid|workspace)/);

  const access = between(routesSource, 'async function loadProjectAccess', 'function assertCanManage');
  assert.match(access, /p\.workspace_id = \$1 AND p\.id = \$2/);
  assert.match(access, /member\.workspace_id = p\.workspace_id/);
  assert.match(access, /task\.workspace_id = p\.workspace_id/);
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

test('project hierarchy, assignee membership and task mutations all reject cross-parent IDs', () => {
  const createTask = between(
    routesSource,
    'app.post(`${NEW_PROJECT_BASE_PATH}/:id/mediums/:mediumId/smalls/:smallId/tasks`',
    'app.put(`${NEW_PROJECT_BASE_PATH}/:id/tasks/:taskId`',
  );
  assert.match(createTask, /small\.workspace_id = \$1 AND small\.project_id = \$2/);
  assert.match(createTask, /small\.medium_category_id = \$3 AND small\.id = \$4/);
  assert.match(createTask, /WHERE workspace_id = \$1 AND project_id = \$2 AND user_uid = \$3 AND active = TRUE/);
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

test('assigned-by lineage is server-authored and the persisted reviewer receives review decisions', () => {
  const createTask = between(
    routesSource,
    'app.post(`${NEW_PROJECT_BASE_PATH}/:id/mediums/:mediumId/smalls/:smallId/tasks`',
    'app.put(`${NEW_PROJECT_BASE_PATH}/:id/tasks/:taskId`',
  );
  assert.match(createTask, /assignedByUid: context\.uid/);
  assert.match(createTask, /assignedByName: context\.name/);
  assert.match(createTask, /reviewer\.reviewerUid/);
  assert.doesNotMatch(createTask, /req\.body\.(?:assignedBy|assigned_by|reviewer)/);

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
