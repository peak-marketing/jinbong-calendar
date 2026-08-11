import { expect, test, type Page, type Route } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createPeakosStore, handlePeakos, installFirebaseStub } from './helpers';

const ROOT = path.resolve(__dirname, '../..');

type ApiCall = {
  method: string;
  path: string;
  body: any;
  workspace: string;
  preview: string;
};

type NewProjectFixture = {
  user?: any;
  calls: ApiCall[];
  projectsByWorkspace: Record<string, any[]>;
  capabilities: { viewPortfolio: boolean; createProject: boolean };
  readOnly?: boolean;
};

function taskCapabilities(status: string) {
  if (status === 'doing' || status === 'todo' || status === 'revision') {
    return { submit: true, approve: false, requestRevision: false, edit: false, reassign: false };
  }
  if (status === 'review') {
    return { submit: false, approve: true, requestRevision: true, edit: false, reassign: false };
  }
  return { submit: false, approve: false, requestRevision: false, edit: false, reassign: false };
}

function makeProject({
  id = 'new-project-1',
  name = '브랜드 리뉴얼 프로젝트',
  canManage = true,
  taskStatus = 'doing',
} = {}) {
  const task = {
    id: `${id}-task-1`,
    title: '메인 캠페인 시안 제작',
    description: 'PC와 모바일 시안을 함께 준비합니다.',
    status: taskStatus,
    dueDate: '2026-08-20',
    workflowVersion: 7,
    assignedBy: { uid: 'lead-uid', name: '업무지시자 김팀장' },
    assignee: { uid: 'worker-uid', name: '업무담당자 이사원' },
    reviewer: { uid: 'lead-uid', name: '업무지시자 김팀장' },
    revisionReason: taskStatus === 'revision' ? '모바일 시안을 보강해 주세요.' : '',
    history: [],
    capabilities: taskCapabilities(taskStatus),
  };
  return {
    id,
    name,
    description: '대분류 설명',
    status: 'active',
    version: 1,
    lead: { uid: 'lead-uid', name: '업무지시자 김팀장' },
    members: [
      { uid: 'lead-uid', name: '업무지시자 김팀장' },
      { uid: 'worker-uid', name: '업무담당자 이사원' },
      { uid: 'viewer-uid', name: '공동구성원 박대리' },
    ],
    taskCount: 1,
    doneTaskCount: taskStatus === 'done' ? 1 : 0,
    reviewTaskCount: taskStatus === 'review' ? 1 : 0,
    nearestDueDate: '2026-08-20',
    canManage,
    mediumCategories: [{
      id: `${id}-medium-1`,
      name: '콘텐츠 제작',
      version: 1,
      smallCategories: [{
        id: `${id}-small-1`,
        name: '광고 시안',
        version: 1,
        tasks: [task],
      }],
    }],
  };
}

function projectSummary(project: any) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    lead: project.lead,
    members: project.members,
    taskCount: project.taskCount,
    doneTaskCount: project.doneTaskCount,
    reviewTaskCount: project.reviewTaskCount,
    nearestDueDate: project.nearestDueDate,
  };
}

async function serveOsShell(page: Page) {
  const html = fs.readFileSync(path.join(ROOT, 'business-os-preview.html'));
  const js = fs.readFileSync(path.join(ROOT, 'business-os-preview.js'));
  const css = fs.readFileSync(path.join(ROOT, 'business-os-live.css'));
  await page.route('**/os/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/os/' || pathname === '/os/login' || pathname === '/os/login/'
      || /^\/os\/w\/[a-z0-9-]+\/?$/.test(pathname)) {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    if (pathname === '/os/business-os-preview.js') {
      return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: js });
    }
    if (pathname === '/os/business-os-live.css') {
      return route.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body: css });
    }
    return route.continue();
  });
}

function parseBody(route: Route) {
  try { return route.request().postDataJSON(); } catch { return null; }
}

function findTask(project: any, taskId: string) {
  for (const medium of project.mediumCategories || []) {
    for (const small of medium.smallCategories || []) {
      const task = (small.tasks || []).find((item: any) => String(item.id) === String(taskId));
      if (task) return task;
    }
  }
  return null;
}

async function installApi(page: Page, fixture: NewProjectFixture) {
  const user = fixture.user || {
    uid: 'uid-kim-daeho', name: '김대호', email: 'daeho@test.local', role: 'admin',
    approved: true, is_active: true, group_id: 'hq-sales', group_name: '본사 영업팀',
    group_type: 'sales', peakos_can_preview_accounts: true,
  };
  const peakos = createPeakosStore(user.name, user.role || 'member');

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const originalPath = url.pathname.replace(/^\/api/, '');
    const protectedRequest = originalPath.startsWith('/peakos/collaboration/');
    const resourcePath = protectedRequest
      ? originalPath.slice('/peakos/collaboration'.length)
      : originalPath;
    const method = request.method().toUpperCase();
    const body = parseBody(route);
    const workspace = request.headers()['x-peakos-workspace'] || 'peak';
    fixture.calls.push({
      method,
      path: originalPath,
      body,
      workspace,
      preview: request.headers()['x-peakos-preview'] || '',
    });
    const send = (payload: unknown, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });

    if (originalPath === '/users/me') return send(user);
    if (originalPath === '/os-auth/session') {
      return send({ required: true, verified: true, expiresInSeconds: 3600 });
    }
    if (originalPath === '/os/workspaces') {
      return send({
        default_slug: workspace === 'daegu' ? 'daegu' : 'peak',
        workspaces: [
          { id: 'ws_peak', slug: 'peak', name: '피크마케팅 본사', kind: 'headquarters', role: 'admin' },
          { id: 'ws_daegu', slug: 'daegu', name: '피크마케팅 대구지사', kind: 'branch', role: 'member' },
        ],
      });
    }
    const contextMatch = originalPath.match(/^\/os\/workspaces\/([^/]+)\/context$/);
    if (contextMatch) {
      const slug = decodeURIComponent(contextMatch[1]);
      return send({
        workspace: {
          id: slug === 'daegu' ? 'ws_daegu' : 'ws_peak',
          slug,
          name: slug === 'daegu' ? '피크마케팅 대구지사' : '피크마케팅 본사',
          kind: slug === 'daegu' ? 'branch' : 'headquarters',
        },
        membership: { role: 'member' },
        permissions: {
          calendar: 'write', chat: 'write', projects: fixture.readOnly ? 'read' : 'write',
          settlements: 'write', documents: 'read', headquartersOversight: fixture.readOnly === true,
        },
      });
    }

    if (protectedRequest && method !== 'GET' && request.headers()['x-peakos-preview'] === '1') {
      return send({ code: 'PEAKOS_PREVIEW_WRITE_FORBIDDEN', error: '계정 미리보기에서는 변경할 수 없습니다.' }, 403);
    }

    if (resourcePath === '/users/all-approved' && method === 'GET') {
      return send([
        { uid: user.uid, name: user.name, email: user.email, group_name: user.group_name },
        { uid: 'lead-uid', name: '업무지시자 김팀장', email: 'lead@test.local', group_name: '본사 영업팀' },
        { uid: 'worker-uid', name: '업무담당자 이사원', email: 'worker@test.local', group_name: '본사 영업팀' },
        { uid: 'viewer-uid', name: '공동구성원 박대리', email: 'viewer@test.local', group_name: '본사 영업팀' },
      ]);
    }

    const projects = fixture.projectsByWorkspace[workspace] || [];
    if (resourcePath === '/new-projects' && method === 'GET') {
      return send({
        readOnly: fixture.readOnly === true,
        capabilities: fixture.readOnly ? {} : fixture.capabilities,
        projects: projects.map(projectSummary),
      });
    }
    if (resourcePath === '/new-projects' && method === 'POST') {
      const created = makeProject({ id: `new-project-${projects.length + 1}`, name: body?.name || '새 프로젝트' });
      created.description = body?.description || '';
      created.lead = { uid: body?.leadUid, name: body?.leadUid };
      created.members = (body?.memberUids || []).map((uid: string) => ({ uid, name: uid }));
      projects.push(created);
      return send({ project: created }, 201);
    }
    const detailMatch = resourcePath.match(/^\/new-projects\/([^/]+)$/);
    if (detailMatch && method === 'GET') {
      const project = projects.find(item => String(item.id) === decodeURIComponent(detailMatch[1]));
      if (!project) return send({ code: 'NEW_PROJECT_NOT_FOUND', error: '찾을 수 없습니다.' }, 404);
      return send({
        readOnly: fixture.readOnly === true,
        capabilities: fixture.readOnly || !project.canManage ? {} : { manageProject: true },
        project,
      });
    }
    if (detailMatch && method === 'PUT') {
      const project = projects.find(item => String(item.id) === decodeURIComponent(detailMatch[1]));
      if (!project) return send({ code: 'NEW_PROJECT_NOT_FOUND', error: '찾을 수 없습니다.' }, 404);
      if (Number(body?.expectedVersion) !== Number(project.version)) {
        return send({ code: 'NEW_PROJECT_VERSION_CONFLICT', error: '다른 사용자가 먼저 변경했습니다.' }, 409);
      }
      Object.assign(project, {
        ...(body?.name === undefined ? {} : { name: body.name }),
        ...(body?.description === undefined ? {} : { description: body.description }),
        ...(body?.status === undefined ? {} : { status: body.status }),
      });
      project.version += 1;
      return send({ project });
    }

    const taskUpdateMatch = resourcePath.match(/^\/new-projects\/([^/]+)\/tasks\/([^/]+)$/);
    if (taskUpdateMatch && method === 'PUT') {
      const project = projects.find(item => String(item.id) === decodeURIComponent(taskUpdateMatch[1]));
      const task = project && findTask(project, decodeURIComponent(taskUpdateMatch[2]));
      if (!project || !task) return send({ code: 'NEW_PROJECT_TASK_NOT_FOUND', error: '업무를 찾을 수 없습니다.' }, 404);
      if (Number(body?.expectedVersion) !== Number(task.workflowVersion)) {
        return send({ code: 'NEW_PROJECT_TASK_VERSION_CONFLICT', error: '다른 사용자가 먼저 처리했습니다.' }, 409);
      }
      const reassigned = body?.assigneeUid !== undefined
        && String(body.assigneeUid) !== String(task.assignee?.uid || '');
      if (reassigned) {
        const assignee = (project.members || []).find((member: any) => String(member.uid) === String(body.assigneeUid));
        if (!assignee) return send({ code: 'NEW_PROJECT_ASSIGNEE_NOT_MEMBER', error: '프로젝트 구성원만 배정할 수 있습니다.' }, 400);
        task.assignee = { uid: assignee.uid, name: assignee.name };
        task.assignedBy = { uid: user.uid, name: user.name };
        task.reviewer = String(assignee.uid) === String(user.uid)
          ? { ...project.lead }
          : { uid: user.uid, name: user.name };
        task.status = 'todo';
      }
      if (body?.title !== undefined) task.title = String(body.title);
      if (body?.description !== undefined) task.description = String(body.description);
      if (body?.dueDate !== undefined) task.dueDate = body.dueDate || null;
      task.workflowVersion += 1;
      task.version = task.workflowVersion;
      return send({ task });
    }

    const reviewMatch = resourcePath.match(/^\/new-projects\/([^/]+)\/tasks\/([^/]+)\/review$/);
    if (reviewMatch && method === 'POST') {
      const project = projects.find(item => String(item.id) === decodeURIComponent(reviewMatch[1]));
      const task = project && findTask(project, decodeURIComponent(reviewMatch[2]));
      if (!project || !task) return send({ code: 'NEW_PROJECT_TASK_NOT_FOUND', error: '업무를 찾을 수 없습니다.' }, 404);
      if (Number(body?.expectedVersion) !== Number(task.workflowVersion)) {
        return send({ code: 'NEW_PROJECT_TASK_VERSION_CONFLICT', error: '다른 사용자가 먼저 처리했습니다.' }, 409);
      }
      const action = String(body?.action || '');
      if (action === 'revision' && !String(body?.note || '').trim()) {
        return send({ code: 'NEW_PROJECT_TASK_REVISION_NOTE_REQUIRED', error: '수정 사유가 필요합니다.' }, 400);
      }
      const wasRevision = task.status === 'revision';
      if (action === 'request') task.status = 'review';
      else if (action === 'approve') task.status = 'done';
      else if (action === 'revision') {
        task.status = 'revision';
        task.revisionReason = String(body.note).trim();
      }
      task.workflowVersion += 1;
      task.capabilities = taskCapabilities(task.status);
      task.history.push({
        action: action === 'request' ? (wasRevision ? 'resubmit' : 'submit') : action,
        actor: { uid: user.uid, name: user.name },
        note: body?.note || '',
        createdAt: '2026-08-11T10:00:00+09:00',
      });
      project.doneTaskCount = task.status === 'done' ? 1 : 0;
      project.reviewTaskCount = task.status === 'review' ? 1 : 0;
      return send({ task });
    }

    // The legacy project surface remains a separate dataset and API contract.
    if (resourcePath === '/projects' && method === 'GET') {
      return send({
        canManageAll: false,
        projects: [{
          id: 'legacy-project-1', name: '기존 프로젝트 유지 확인', description: '기존 Paragon 프로젝트',
          status: 'active', owner_name: user.name, member_count: 1, task_count: 0, done_task_count: 0,
        }],
      });
    }
    if (resourcePath === '/projects/my-tasks' && method === 'GET') return send({ readOnly: false, tasks: [] });
    if (resourcePath === '/events' && method === 'GET') return send([]);
    if (resourcePath === '/events/checklist-summary' && method === 'GET') return send({});
    if (resourcePath === '/chat-rooms' && method === 'GET') return send([]);
    if (resourcePath === '/chat-rooms/unread' && method === 'GET') return send({});

    if (!protectedRequest && handlePeakos(peakos, route)) return;
    if (originalPath === '/service-requests') return send({ canManage: false, requests: [] });
    if (originalPath === '/ideas') return send([]);
    return send([]);
  });
}

async function openMainCluster(page: Page) {
  const main = page.locator('[data-nav-cluster="main"]');
  if ((await main.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    const toggle = main.locator(':scope > .nav-cluster-toggle');
    const visible = await toggle.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    });
    if (!visible) await page.locator('.mobile-menu').click();
    await toggle.click();
  }
}

async function setup(page: Page, fixture: NewProjectFixture, url = '/os/') {
  await installFirebaseStub(page);
  await serveOsShell(page);
  await installApi(page, fixture);
  await page.goto(url);
  await expect(page.locator('#authGate')).toBeHidden();
  await openMainCluster(page);
}

async function openNewProjects(page: Page) {
  const button = page.locator('.nav-item[data-view="new-projects"]');
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('#newProjectsView')).toBeVisible();
}

test.describe('신규 프로젝트 계층·검토 workflow', () => {
  test('기존 프로젝트와 별도 탭에서 대분류 > 중분류 > 소분류 > 체크리스트와 지시 계보를 표시한다', async ({ page }) => {
    const project = makeProject();
    const fixture: NewProjectFixture = {
      calls: [],
      projectsByWorkspace: { peak: [project] },
      capabilities: { viewPortfolio: true, createProject: true },
    };
    await setup(page, fixture);

    await openNewProjects(page);
    await expect(page.locator('[data-structured-project-list]')).toContainText('전체 포트폴리오');
    await expect(page.locator('[data-structured-project-id="new-project-1"]')).toContainText('브랜드 리뉴얼 프로젝트');
    await page.locator('[data-structured-project-open="new-project-1"]').click();

    const detail = page.locator('[data-structured-project-detail]');
    await expect(detail).toContainText('프로젝트 대분류');
    await expect(page.locator('[data-work-category-id="new-project-1-medium-1"]')).toContainText('콘텐츠 제작');
    await expect(page.locator('[data-work-subcategory-id="new-project-1-small-1"]')).toContainText('광고 시안');
    const task = page.locator('[data-work-item-id="new-project-1-task-1"]');
    await expect(task).toContainText('메인 캠페인 시안 제작');
    await expect(task).toContainText('업무지시자 김팀장');
    await expect(task).toContainText('업무담당자 이사원');

    await openMainCluster(page);
    await page.locator('.nav-item[data-view="review"]').click();
    await expect(page.locator('#reviewView [data-project-id="legacy-project-1"]')).toContainText('기존 프로젝트 유지 확인');
    expect(fixture.calls.some(call => call.path === '/peakos/collaboration/projects')).toBe(true);
    expect(fixture.calls.some(call => call.path === '/peakos/collaboration/new-projects')).toBe(true);
    expect(fixture.calls.filter(call => call.method !== 'GET' && call.path.includes('/projects'))).toEqual([]);
  });

  test('exact3 포트폴리오 계정과 일반 구성원의 범위·생성·관리 버튼을 capability로 분리한다', async ({ page }) => {
    const portfolio = makeProject({ id: 'portfolio-project', name: '다른 팀 프로젝트', canManage: false });
    const fixture: NewProjectFixture = {
      calls: [],
      projectsByWorkspace: { peak: [portfolio] },
      capabilities: { viewPortfolio: true, createProject: true },
    };
    await setup(page, fixture);
    await openNewProjects(page);
    await expect(page.getByText('전체 포트폴리오', { exact: false }).first()).toBeVisible();
    await expect(page.locator('[data-structured-project-create]')).toBeVisible();
    await page.locator('[data-structured-project-open="portfolio-project"]').click();
    await expect(page.locator('[data-structured-medium-create]')).toHaveCount(0);
    await expect(page.locator('[data-structured-task-create]')).toHaveCount(0);

    const newProjectReads = fixture.calls.filter(call => call.method === 'GET' && call.path.includes('/new-projects'));
    expect(newProjectReads.every(call => !call.path.includes('?') && call.body == null)).toBe(true);
  });

  test('프로젝트 생성·설정 폼에 담당자와 공동 구성원을 두고 versioned 설정 저장을 보낸다', async ({ page }) => {
    const project = makeProject({ id: 'managed-project', name: '관리 프로젝트', canManage: true });
    const fixture: NewProjectFixture = {
      calls: [],
      projectsByWorkspace: { peak: [project] },
      capabilities: { viewPortfolio: true, createProject: true },
    };
    await setup(page, fixture);
    await openNewProjects(page);

    await page.locator('[data-structured-project-create]').click();
    const createForm = page.locator('#structuredProjectForm');
    await expect(createForm.getByText('프로젝트 담당자', { exact: true })).toBeVisible();
    await expect(createForm.getByText('같이 볼 구성원', { exact: true })).toBeVisible();
    await expect(createForm.locator('select[name="leadUid"]')).toBeVisible();
    await expect(createForm.locator('input[name="memberUids"]')).toHaveCount(4);
    await createForm.locator('[data-collab-cancel]').click();

    await page.locator('[data-structured-project-open="managed-project"]').click();
    await page.locator('[data-structured-project-edit]').click();
    const editForm = page.locator('#structuredProjectForm');
    await editForm.locator('textarea[name="description"]').fill('버전 충돌을 막는 설정 변경');
    await editForm.getByRole('button', { name: '변경 저장' }).click();
    await expect(page.locator('[data-structured-project-detail]')).toContainText('버전 충돌을 막는 설정 변경');
    const update = fixture.calls.find(call => call.method === 'PUT' && call.path.endsWith('/new-projects/managed-project'));
    expect(update?.body).toMatchObject({ expectedVersion: 1, description: '버전 충돌을 막는 설정 변경' });
  });

  test('업무 편집은 담당자 유지 시 원 지시·검토 계보를 보존하고 재배정 시 현재 지시자로 갱신한다', async ({ page }) => {
    const project = makeProject({ id: 'assignment-project', name: '업무 계보 프로젝트', canManage: true });
    project.members.push({ uid: 'e2e-test-user', name: '김대호' });
    const task = findTask(project, 'assignment-project-task-1');
    task.capabilities = {
      submit: false, approve: false, requestRevision: false, edit: true, reassign: true,
    };
    const fixture: NewProjectFixture = {
      user: {
        uid: 'e2e-test-user', name: '김대호', email: 'daeho@test.local', role: 'admin',
        approved: true, is_active: true, group_id: 'hq-sales', group_name: '본사 영업팀',
        group_type: 'sales', peakos_can_preview_accounts: true,
      },
      calls: [],
      projectsByWorkspace: { peak: [project] },
      capabilities: { viewPortfolio: true, createProject: true },
    };
    await setup(page, fixture);
    await openNewProjects(page);
    await page.locator('[data-structured-project-open="assignment-project"]').click();

    const taskRow = page.locator('[data-work-item-id="assignment-project-task-1"]');
    await taskRow.locator('[data-work-item-edit]').click();
    let form = page.locator('#structuredTaskForm');
    await expect(form.locator('[data-structured-assigner-preview]')).toHaveText('업무지시자 김팀장');
    await expect(form.locator('[data-structured-reviewer-preview]')).toHaveText('업무지시자 김팀장');
    await form.locator('textarea[name="description"]').fill('기존 담당자를 유지한 설명 수정');
    await form.getByRole('button', { name: '업무 저장' }).click();
    await expect(taskRow).toContainText('기존 담당자를 유지한 설명 수정');
    await expect(taskRow.locator('.structured-assignment-flow')).toContainText('업무지시자 김팀장');

    await taskRow.locator('[data-work-item-edit]').click();
    form = page.locator('#structuredTaskForm');
    await form.locator('select[name="assigneeUid"]').selectOption('viewer-uid');
    await expect(form.locator('[data-structured-assignee-preview]')).toHaveText('공동구성원 박대리');
    await expect(form.locator('[data-structured-assigner-preview]')).toHaveText('김대호');
    await expect(form.locator('[data-structured-reviewer-preview]')).toHaveText('김대호');
    await form.getByRole('button', { name: '업무 저장' }).click();
    const lineage = taskRow.locator('.structured-assignment-flow');
    await expect(lineage).toContainText('김대호');
    await expect(lineage).toContainText('공동구성원 박대리');

    await taskRow.locator('[data-work-item-edit]').click();
    form = page.locator('#structuredTaskForm');
    await form.locator('select[name="assigneeUid"]').selectOption('e2e-test-user');
    await expect(form.locator('[data-structured-assignee-preview]')).toHaveText('김대호');
    await expect(form.locator('[data-structured-assigner-preview]')).toHaveText('김대호');
    await expect(form.locator('[data-structured-reviewer-preview]')).toHaveText('업무지시자 김팀장');
    await form.getByRole('button', { name: '업무 저장' }).click();
    await expect(taskRow.locator('.structured-assignment-flow')).toContainText('업무지시자 김팀장');

    const updates = fixture.calls.filter(call => call.method === 'PUT'
      && call.path.endsWith('/new-projects/assignment-project/tasks/assignment-project-task-1'));
    expect(updates.map(call => call.body)).toEqual([
      {
        title: '메인 캠페인 시안 제작', description: '기존 담당자를 유지한 설명 수정',
        dueDate: '2026-08-20', assigneeUid: 'worker-uid', expectedVersion: 7,
      },
      {
        title: '메인 캠페인 시안 제작', description: '기존 담당자를 유지한 설명 수정',
        dueDate: '2026-08-20', assigneeUid: 'viewer-uid', expectedVersion: 8,
      },
      {
        title: '메인 캠페인 시안 제작', description: '기존 담당자를 유지한 설명 수정',
        dueDate: '2026-08-20', assigneeUid: 'e2e-test-user', expectedVersion: 9,
      },
    ]);
    expect(updates.every(call => call.body.assignedByUid === undefined && call.body.reviewerUid === undefined)).toBe(true);
  });

  test('일반 구성원은 참여 프로젝트만 보고 생성·구조 변경 없이 본인 체크리스트를 제출한다', async ({ page }) => {
    const project = makeProject({ id: 'member-project', name: '내 참여 프로젝트', canManage: false });
    const fixture: NewProjectFixture = {
      user: {
        uid: 'worker-uid', name: '업무담당자 이사원', email: 'worker@test.local', role: 'member',
        approved: true, is_active: true, group_id: 'hq-sales', group_name: '본사 영업팀', group_type: 'sales',
      },
      calls: [],
      projectsByWorkspace: { peak: [project] },
      capabilities: { viewPortfolio: false, createProject: false },
    };
    await setup(page, fixture);
    await openNewProjects(page);
    await expect(page.getByText('내 참여 프로젝트', { exact: false }).first()).toBeVisible();
    await expect(page.locator('[data-structured-project-create]')).toHaveCount(0);
    await page.locator('[data-structured-project-open="member-project"]').click();
    await expect(page.locator('[data-structured-medium-create]')).toHaveCount(0);
    await page.locator('[data-work-item-id="member-project-task-1"] [data-work-item-submit]').first().click();
    await expect(page.locator('[data-work-item-id="member-project-task-1"]')).toContainText('검토 요청');
    const request = fixture.calls.find(call => call.path.endsWith('/tasks/member-project-task-1/review'));
    expect(request?.body).toMatchObject({ action: 'request', expectedVersion: 7 });
  });

  test('완료 제출 → 수정 사유 필수 → 재제출 → 승인 상태기계를 version과 함께 전송한다', async ({ page }) => {
    const project = makeProject({ id: 'workflow-project' });
    const fixture: NewProjectFixture = {
      calls: [],
      projectsByWorkspace: { peak: [project] },
      capabilities: { viewPortfolio: true, createProject: true },
    };
    await setup(page, fixture);
    await openNewProjects(page);
    await page.locator('[data-structured-project-open="workflow-project"]').click();

    const task = page.locator('[data-work-item-id="workflow-project-task-1"]');
    await task.locator('[data-work-item-submit]').first().click();
    await expect(task).toContainText('검토 요청');
    await task.locator('[data-work-item-revision]').click();
    const revisionForm = page.locator('#structuredRevisionForm');
    await expect(revisionForm).toBeVisible();
    await revisionForm.getByRole('button', { name: '수정 요청 보내기' }).click();
    expect(fixture.calls.filter(call => call.body?.action === 'revision')).toHaveLength(0);
    await revisionForm.locator('[name="note"]').fill('모바일 시안의 버튼 간격을 다시 맞춰 주세요.');
    await revisionForm.getByRole('button', { name: '수정 요청 보내기' }).click();
    await expect(task).toContainText('수정 요청');
    await expect(task).toContainText('모바일 시안의 버튼 간격을 다시 맞춰 주세요.');

    await task.locator('[data-work-item-submit]').first().click();
    await expect(task).toContainText('검토 요청');
    await task.locator('[data-work-item-approve]').click();
    await expect(task).toContainText('승인 완료');

    const actions = fixture.calls
      .filter(call => call.path.endsWith('/tasks/workflow-project-task-1/review'))
      .map(call => ({ action: call.body.action, note: call.body.note, version: call.body.expectedVersion }));
    expect(actions).toEqual([
      { action: 'request', note: '', version: 7 },
      { action: 'revision', note: '모바일 시안의 버튼 간격을 다시 맞춰 주세요.', version: 8 },
      { action: 'request', note: '', version: 9 },
      { action: 'approve', note: '', version: 10 },
    ]);
    await expect(task).toContainText('업무지시자 김팀장');
    await expect(task).toContainText('업무담당자 이사원');
  });

  test('계정 미리보기 전환 프레임부터 프로젝트 행과 쓰기 요청을 모두 비운다', async ({ page }) => {
    const fixture: NewProjectFixture = {
      calls: [],
      projectsByWorkspace: { peak: [makeProject({ id: 'private-project', name: '실계정 비공개 프로젝트' })] },
      capabilities: { viewPortfolio: true, createProject: true },
    };
    await setup(page, fixture);
    await openNewProjects(page);
    await expect(page.locator('[data-structured-project-id="private-project"]')).toBeVisible();
    const readsBefore = fixture.calls.filter(call => call.method === 'GET' && call.path.includes('/new-projects')).length;

    await page.locator('#personaSelect').selectOption('박우진');
    await expect(page.locator('[data-structured-private-state]')).toContainText('계정 미리보기에서는 신규 프로젝트가 비공개입니다');
    await expect(page.locator('[data-structured-project-id]')).toHaveCount(0);
    await expect(page.locator('[data-work-item-id]')).toHaveCount(0);
    await expect(page.locator('[data-structured-project-create]')).toHaveCount(0);
    expect(fixture.calls.filter(call => call.method === 'GET' && call.path.includes('/new-projects')).length).toBe(readsBefore);
    expect(fixture.calls.filter(call => call.method !== 'GET' && call.path.includes('/new-projects'))).toEqual([]);
  });

  test('지사 HQ oversight는 전체 프로젝트를 열람하되 생성·설정·제출·검토를 전부 막는다', async ({ page }) => {
    const fixture: NewProjectFixture = {
      user: {
        uid: 'uid-son-myeonga', name: '손명아', email: 'son@test.local', role: 'member',
        approved: true, is_active: true, group_id: 'hq', group_name: '본사', group_type: 'hq',
      },
      calls: [],
      projectsByWorkspace: {
        peak: [makeProject({ id: 'hq-private', name: '본사 프로젝트' })],
        daegu: [makeProject({
          id: 'branch-portfolio-project', name: '대구지사 전체 프로젝트', canManage: true, taskStatus: 'review',
        })],
      },
      capabilities: { viewPortfolio: true, createProject: true },
      readOnly: true,
    };
    await setup(page, fixture, '/os/w/daegu');
    await openNewProjects(page);

    await expect(page.locator('[data-structured-project-list]')).toContainText('열람 전용');
    await expect(page.locator('[data-structured-project-id="branch-portfolio-project"]')).toBeVisible();
    await expect(page.getByText('본사 프로젝트', { exact: false })).toHaveCount(0);
    await expect(page.locator('[data-structured-project-create]')).toHaveCount(0);

    await page.locator('[data-structured-project-open="branch-portfolio-project"]').click();
    await expect(page.locator('[data-structured-project-detail]')).toContainText('열람 전용');
    await expect(page.locator('[data-structured-project-edit]')).toHaveCount(0);
    await expect(page.locator('[data-structured-medium-create]')).toHaveCount(0);
    await expect(page.locator('[data-structured-task-create]')).toHaveCount(0);
    await expect(page.locator('[data-work-item-submit]')).toHaveCount(0);
    await expect(page.locator('[data-work-item-approve]')).toHaveCount(0);
    await expect(page.locator('[data-work-item-revision]')).toHaveCount(0);

    const structuredCalls = fixture.calls.filter(call => call.path.includes('/new-projects'));
    expect(structuredCalls.length).toBeGreaterThan(0);
    expect(structuredCalls.every(call => call.method === 'GET' && call.workspace === 'daegu')).toBe(true);
  });

  test('지사 workspace header로만 조회하고 모바일에서 계층·체크 버튼이 화면을 넘지 않는다', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture: NewProjectFixture = {
      user: {
        uid: 'daegu-worker', name: '대구 구성원', email: 'daegu@test.local', role: 'member',
        approved: true, is_active: true, group_id: 'daegu', group_name: '대구지사', group_type: 'sales',
      },
      calls: [],
      projectsByWorkspace: {
        peak: [makeProject({ id: 'hq-secret', name: '본사 비공개 프로젝트' })],
        daegu: [makeProject({ id: 'daegu-project', name: '대구지사 프로젝트', canManage: false })],
      },
      capabilities: { viewPortfolio: false, createProject: false },
    };
    await setup(page, fixture, '/os/w/daegu');
    await openNewProjects(page);
    await expect(page.locator('[data-structured-project-id="daegu-project"]')).toBeVisible();
    await expect(page.getByText('본사 비공개 프로젝트', { exact: false })).toHaveCount(0);
    await page.locator('[data-structured-project-open="daegu-project"]').click();
    await expect(page.locator('[data-work-category-id]')).toBeVisible();
    await expect(page.locator('[data-work-subcategory-id]')).toBeVisible();
    await expect(page.locator('[data-work-item-id]')).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewport);
    const checkbox = page.locator('.structured-task-check').first();
    const box = await checkbox.boundingBox();
    expect(box?.width || 0).toBeGreaterThanOrEqual(40);
    expect(box?.height || 0).toBeGreaterThanOrEqual(40);
    const newProjectCalls = fixture.calls.filter(call => call.path.includes('/new-projects'));
    expect(newProjectCalls.length).toBeGreaterThan(0);
    expect(newProjectCalls.every(call => call.workspace === 'daegu')).toBe(true);
  });
});
