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
  canEditSettings = canManage,
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
    description: '프로젝트 설명',
    status: 'active',
    version: 1,
    lead: { uid: 'lead-uid', name: '업무지시자 김팀장', rank: '팀장' },
    createdBy: { uid: 'uid-kim-daeho', name: '김대호' },
    members: [
      { uid: 'lead-uid', name: '업무지시자 김팀장', rank: '팀장' },
      { uid: 'worker-uid', name: '업무담당자 이사원', rank: '사원' },
      { uid: 'viewer-uid', name: '공동구성원 박대리', rank: '대리' },
    ],
    taskCount: 1,
    doneTaskCount: taskStatus === 'done' ? 1 : 0,
    reviewTaskCount: taskStatus === 'review' ? 1 : 0,
    nearestDueDate: '2026-08-20',
    canManage,
    canEditSettings,
    mediumCategories: [{
      id: `${id}-medium-1`,
      name: '콘텐츠 제작',
      version: 1,
      manager: { uid: 'worker-uid', name: '업무담당자 이사원' },
      smallCategories: [{
        id: `${id}-small-1`,
        name: '광고 시안',
        version: 1,
        tasks: [task],
      }],
    }],
  };
}

function makeBoardProject({
  id = 'board-project',
  canManage = true,
  canEditSettings = canManage,
} = {}) {
  const project = makeProject({ id, name: '캠페인 보드 테스트', canManage, canEditSettings });
  const makeTask = ({
    key,
    title,
    status,
    dueDate,
    assignee = { uid: 'worker-uid', name: '업무담당자 이사원' },
    description = '',
    revisionReason = '',
  }: {
    key: string;
    title: string;
    status: string;
    dueDate: string;
    assignee?: { uid: string; name: string };
    description?: string;
    revisionReason?: string;
  }) => ({
    id: `${id}-${key}`,
    title,
    description,
    status,
    dueDate,
    workflowVersion: 3,
    assignedBy: { uid: 'lead-uid', name: '업무지시자 김팀장' },
    assignee,
    reviewer: { uid: 'lead-uid', name: '업무지시자 김팀장' },
    revisionReason,
    history: status === 'revision' ? [{
      action: 'revision',
      actor: { uid: 'lead-uid', name: '업무지시자 김팀장' },
      note: revisionReason,
      createdAt: '2026-08-11T10:00:00+09:00',
    }] : [],
    capabilities: taskCapabilities(status),
  });
  project.mediumCategories = [
    {
      id: `${id}-medium-content`,
      name: '콘텐츠 제작',
      version: 1,
      manager: { uid: 'worker-uid', name: '업무담당자 이사원' },
      smallCategories: [{
        id: `${id}-small-design`,
        name: '광고 시안',
        version: 1,
        tasks: [
          makeTask({
            key: 'todo', title: '첫 시안 방향 정리', status: 'todo', dueDate: '2026-08-13',
            description: '브랜드 톤을 정리합니다.',
          }),
          makeTask({
            key: 'doing', title: 'PC 광고 시안 제작', status: 'doing', dueDate: '2026-08-14',
            assignee: { uid: 'viewer-uid', name: '공동구성원 박대리' },
          }),
          makeTask({
            key: 'revision', title: '모바일 광고 시안 보완', status: 'revision', dueDate: '2026-08-12',
            revisionReason: 'CTA 버튼 간격을 다시 맞춰 주세요.',
          }),
        ],
      }],
    },
    {
      id: `${id}-medium-operation`,
      name: '캠페인 운영',
      version: 1,
      manager: { uid: 'lead-uid', name: '업무지시자 김팀장' },
      smallCategories: [{
        id: `${id}-small-channel`,
        name: '채널 점검',
        version: 1,
        tasks: [
          makeTask({
            key: 'review', title: '게시 전 링크 검수', status: 'review', dueDate: '2026-08-15',
            description: '최종 링크와 문구를 검토합니다.',
          }),
          makeTask({
            key: 'done', title: '매체 계정 권한 확인', status: 'done', dueDate: '2026-08-10',
            assignee: { uid: 'viewer-uid', name: '공동구성원 박대리' },
          }),
        ],
      }],
    },
  ];
  project.taskCount = 5;
  project.doneTaskCount = 1;
  project.reviewTaskCount = 1;
  project.nearestDueDate = '2026-08-12';
  return project;
}

function projectSummary(project: any) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    lead: project.lead,
    createdBy: project.createdBy,
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

function findMedium(project: any, mediumId: string) {
  return (project?.mediumCategories || [])
    .find((medium: any) => String(medium.id) === String(mediumId)) || null;
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
        { uid: user.uid, name: user.name, email: user.email, group_name: user.group_name, rank: user.rank || '부장' },
        { uid: 'lead-uid', name: '업무지시자 김팀장', email: 'lead@test.local', group_name: '본사 영업팀', rank: '팀장' },
        { uid: 'worker-uid', name: '업무담당자 이사원', email: 'worker@test.local', group_name: '본사 영업팀', rank: '사원' },
        { uid: 'viewer-uid', name: '공동구성원 박대리', email: 'viewer@test.local', group_name: '본사 영업팀', rank: '대리' },
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
        capabilities: fixture.readOnly ? {} : {
          manageProject: project.canManage === true,
          editProjectSettings: project.canEditSettings === true,
        },
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

    const mediumCreateMatch = resourcePath.match(/^\/new-projects\/([^/]+)\/mediums$/);
    if (mediumCreateMatch && method === 'POST') {
      const project = projects.find(item => String(item.id) === decodeURIComponent(mediumCreateMatch[1]));
      if (!project) return send({ code: 'NEW_PROJECT_NOT_FOUND', error: '찾을 수 없습니다.' }, 404);
      let manager = null;
      if (body?.managerUid !== undefined) {
        const managerUid = typeof body.managerUid === 'string' ? body.managerUid.trim() : '';
        if (!managerUid) return send({ code: 'NEW_PROJECT_UID_INVALID', error: '중분류 담당자를 확인해 주세요.' }, 400);
        manager = (project.members || []).find((member: any) => String(member.uid) === managerUid) || null;
        if (!manager) return send({ code: 'NEW_PROJECT_MEDIUM_MANAGER_NOT_MEMBER', error: '프로젝트 팀원만 중분류 담당자가 될 수 있습니다.' }, 400);
      }
      const medium = {
        id: `${project.id}-medium-${(project.mediumCategories || []).length + 1}`,
        name: String(body?.name || ''),
        version: 1,
        manager: manager ? { uid: manager.uid, name: manager.name } : null,
        smallCategories: [],
      };
      project.mediumCategories ||= [];
      project.mediumCategories.push(medium);
      return send({ medium }, 201);
    }

    const mediumUpdateMatch = resourcePath.match(/^\/new-projects\/([^/]+)\/mediums\/([^/]+)$/);
    if (mediumUpdateMatch && method === 'PUT') {
      const project = projects.find(item => String(item.id) === decodeURIComponent(mediumUpdateMatch[1]));
      const medium = findMedium(project, decodeURIComponent(mediumUpdateMatch[2]));
      if (!project || !medium) return send({ code: 'NEW_PROJECT_MEDIUM_NOT_FOUND', error: '중분류를 찾을 수 없습니다.' }, 404);
      if (Number(body?.expectedVersion) !== Number(medium.version)) {
        return send({ code: 'NEW_PROJECT_CATEGORY_VERSION_CONFLICT', error: '다른 사용자가 먼저 변경했습니다.' }, 409);
      }
      let manager = medium.manager || null;
      if (body?.managerUid !== undefined) {
        const managerUid = typeof body.managerUid === 'string' ? body.managerUid.trim() : '';
        if (!managerUid) return send({ code: 'NEW_PROJECT_UID_INVALID', error: '중분류 담당자를 확인해 주세요.' }, 400);
        manager = (project.members || []).find((member: any) => String(member.uid) === managerUid) || null;
        if (!manager) return send({ code: 'NEW_PROJECT_MEDIUM_MANAGER_NOT_MEMBER', error: '프로젝트 팀원만 중분류 담당자가 될 수 있습니다.' }, 400);
      }
      if (body?.name !== undefined) medium.name = String(body.name || '');
      medium.manager = manager ? { uid: manager.uid, name: manager.name } : null;
      medium.version += 1;
      return send({ medium });
    }

    const smallCreateMatch = resourcePath.match(/^\/new-projects\/([^/]+)\/mediums\/([^/]+)\/smalls$/);
    if (smallCreateMatch && method === 'POST') {
      const project = projects.find(item => String(item.id) === decodeURIComponent(smallCreateMatch[1]));
      const medium = (project?.mediumCategories || [])
        .find((item: any) => String(item.id) === decodeURIComponent(smallCreateMatch[2]));
      if (!project || !medium) return send({ code: 'NEW_PROJECT_MEDIUM_NOT_FOUND', error: '중분류를 찾을 수 없습니다.' }, 404);
      const small = {
        id: `${project.id}-small-${(medium.smallCategories || []).length + 1}`,
        name: String(body?.name || ''),
        version: 1,
        tasks: [],
      };
      medium.smallCategories ||= [];
      medium.smallCategories.push(small);
      return send({ category: small }, 201);
    }

    const taskCreateMatch = resourcePath.match(/^\/new-projects\/([^/]+)\/mediums\/([^/]+)\/smalls\/([^/]+)\/tasks$/);
    if (taskCreateMatch && method === 'POST') {
      const project = projects.find(item => String(item.id) === decodeURIComponent(taskCreateMatch[1]));
      const medium = (project?.mediumCategories || [])
        .find((item: any) => String(item.id) === decodeURIComponent(taskCreateMatch[2]));
      const small = (medium?.smallCategories || [])
        .find((item: any) => String(item.id) === decodeURIComponent(taskCreateMatch[3]));
      if (!project || !medium || !small) {
        return send({ code: 'NEW_PROJECT_SMALL_NOT_FOUND', error: '소분류를 찾을 수 없습니다.' }, 404);
      }
      const assignee = (project.members || [])
        .find((member: any) => String(member.uid) === String(body?.assigneeUid));
      if (!assignee) return send({ code: 'NEW_PROJECT_ASSIGNEE_NOT_MEMBER', error: '프로젝트 팀원만 배정할 수 있습니다.' }, 400);
      const assignedBy = { uid: user.uid, name: user.name };
      const task = {
        id: `${project.id}-task-${(small.tasks || []).length + 1}`,
        title: String(body?.title || ''),
        description: String(body?.description || ''),
        dueDate: body?.dueDate || null,
        status: 'todo',
        workflowVersion: 1,
        assignedBy,
        assignee,
        reviewer: String(assignee.uid) === String(user.uid) ? { ...project.lead } : assignedBy,
        revisionReason: '',
        history: [],
        capabilities: taskCapabilities('todo'),
      };
      small.tasks ||= [];
      small.tasks.push(task);
      project.taskCount = Number(project.taskCount || 0) + 1;
      return send({ task }, 201);
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
  test('기존 프로젝트와 별도 탭에서 프로젝트의 중분류 > 소분류 > 체크리스트와 지시 계보를 표시한다', async ({ page }) => {
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
    await expect(detail).not.toContainText('프로젝트 대분류');
    await expect(detail.locator('.structured-hierarchy-guide')).toHaveCount(0);
    await expect(detail).toContainText('프로젝트 팀원 3명');
    await expect(detail).not.toContainText('같이 보는 구성원');
    await expect(page.locator('.structured-project-team-member')).toHaveCount(3);
    await expect(page.locator('.structured-project-lead-card')).toContainText('업무지시자 김팀장');
    await expect(page.locator('.structured-project-lead-card')).toContainText('팀장');
    await expect(page.locator('.structured-project-member-rank')).toHaveText(['팀장', '사원', '대리']);
    const [heroBox, titleBox, peopleBox, progressBox, progressTrackBox] = await Promise.all([
      detail.locator('.structured-detail-hero').boundingBox(),
      detail.locator('.structured-detail-title').boundingBox(),
      detail.locator('.structured-detail-people').boundingBox(),
      detail.locator('.structured-detail-progress').boundingBox(),
      detail.locator('.structured-detail-progress > i').boundingBox(),
    ]);
    if (!heroBox || !titleBox || !peopleBox || !progressBox || !progressTrackBox) throw new Error('프로젝트 상단 배치 치수를 확인할 수 없습니다.');
    expect(peopleBox.x).toBeGreaterThan(titleBox.x);
    expect(peopleBox.x - (titleBox.x + titleBox.width)).toBeLessThanOrEqual(24);
    expect(Math.abs(progressBox.x - titleBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(progressBox.width - titleBox.width)).toBeLessThanOrEqual(1);
    expect(progressBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
    expect(progressBox.width).toBeGreaterThan(heroBox.width * 0.38);
    expect(Math.abs(peopleBox.y - titleBox.y)).toBeLessThanOrEqual(1);
    expect(peopleBox.y + peopleBox.height).toBeGreaterThanOrEqual(progressBox.y + progressBox.height - 1);
    expect(heroBox.height).toBeLessThan(270);
    expect(progressTrackBox.width).toBeGreaterThanOrEqual(500);

    await page.setViewportSize({ width: 1600, height: 900 });
    const wideProgressTrack = await detail.locator('.structured-detail-progress > i').boundingBox();
    expect(wideProgressTrack?.width || 0).toBeGreaterThanOrEqual(500);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1600);

    for (const width of [900, 800]) {
      await page.setViewportSize({ width, height: 900 });
      const [nextHero, nextTitle, nextPeople, nextProgress, nextTrack] = await Promise.all([
        detail.locator('.structured-detail-hero').boundingBox(),
        detail.locator('.structured-detail-title').boundingBox(),
        detail.locator('.structured-detail-people').boundingBox(),
        detail.locator('.structured-detail-progress').boundingBox(),
        detail.locator('.structured-detail-progress > i').boundingBox(),
      ]);
      if (!nextHero || !nextTitle || !nextPeople || !nextProgress || !nextTrack) throw new Error(`프로젝트 상단 ${width}px 배치 치수를 확인할 수 없습니다.`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect([nextHero, nextTitle, nextPeople, nextProgress, nextTrack].every(box => (
        box.x >= 0 && box.x + box.width <= width
      ))).toBe(true);
      expect(nextPeople.y).toBeGreaterThanOrEqual(nextTitle.y + nextTitle.height);
      expect(nextProgress.y).toBeGreaterThanOrEqual(nextPeople.y + nextPeople.height);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    const medium = page.locator('[data-work-category-id="new-project-1-medium-1"]');
    await expect(medium).toContainText('콘텐츠 제작');
    await expect(medium.locator('[data-structured-medium-manager]')).toContainText('중분류 담당자');
    await expect(medium.locator('[data-structured-medium-manager]')).toContainText('업무담당자 이사원');
    await expect(medium.locator('[data-structured-medium-manager]')).toContainText('사원');
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

  test('기존 계층 보기를 보존한 채 4열 보드에서 상태·분류·담당자·검색과 업무 상세를 비교한다', async ({ page }) => {
    test.setTimeout(45_000);
    const project = makeBoardProject();
    const fixture: NewProjectFixture = {
      calls: [],
      projectsByWorkspace: { peak: [project] },
      capabilities: { viewPortfolio: true, createProject: true },
    };
    await setup(page, fixture);
    await openNewProjects(page);
    await page.locator('[data-structured-project-open="board-project"]').click();

    const hierarchyToggle = page.locator('[data-structured-task-view="hierarchy"]');
    const boardToggle = page.locator('[data-structured-task-view="board"]');
    await expect(hierarchyToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-work-category-id]')).toHaveCount(2);
    await expect(page.locator('[data-structured-task-board]')).toHaveCount(0);
    const readsBeforeToggle = fixture.calls.filter(call => call.method === 'GET' && call.path.includes('/new-projects')).length;

    await boardToggle.click();
    await expect(boardToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-work-category-id]')).toHaveCount(0);
    const board = page.locator('[data-structured-task-board]');
    await expect(board).toBeVisible();
    await expect(page.locator('[data-structured-board-column]')).toHaveCount(4);
    await expect(page.locator('[data-structured-board-column="todo"]')).toContainText('첫 시안 방향 정리');
    const doingLane = page.locator('[data-structured-board-column="doing"]');
    await expect(doingLane).toContainText('PC 광고 시안 제작');
    await expect(doingLane).toContainText('모바일 광고 시안 보완');
    await expect(doingLane).toContainText('수정 요청 1건 우선 확인');
    await expect(page.locator('[data-structured-board-column="review"]')).toContainText('게시 전 링크 검수');
    await expect(page.locator('[data-structured-board-column="done"]')).toContainText('매체 계정 권한 확인');
    await expect(page.locator('[data-structured-board-column="todo"] [data-task-status="revision"]')).toHaveCount(0);
    await expect(doingLane.locator('[data-task-status="revision"]')).toHaveCount(1);
    await expect(page.locator('[data-structured-task-board] [data-work-item-id]')).toHaveCount(5);

    const revisionCard = page.locator('[data-work-item-id="board-project-revision"]');
    await expect(revisionCard).toContainText('콘텐츠 제작');
    await expect(revisionCard).toContainText('광고 시안');
    await expect(revisionCard).toContainText('업무지시자 김팀장');
    await expect(revisionCard).toContainText('업무담당자 이사원');
    await expect(revisionCard.locator('.project-deadline-badge')).toHaveCount(1);
    await revisionCard.locator('[data-structured-board-task-open]').click();
    const drawer = page.locator('[data-structured-task-drawer]');
    await expect(drawer).toBeFocused();
    await expect(drawer).toContainText('콘텐츠 제작');
    await expect(drawer).toContainText('광고 시안');
    await expect(drawer).toContainText('2026-08-12');
    await expect(drawer).toContainText('업무지시자 김팀장');
    await expect(drawer).toContainText('업무담당자 이사원');
    await expect(drawer).toContainText('CTA 버튼 간격을 다시 맞춰 주세요.');
    await expect(drawer.locator('[data-work-item-submit="board-project-revision"]')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 480 });
    const drawerBody = drawer.locator('.structured-task-drawer-body');
    await drawerBody.hover();
    await page.mouse.wheel(0, 220);
    const drawerScrollBeforePoll = await expect.poll(() => drawerBody.evaluate(element => element.scrollTop))
      .toBeGreaterThan(0)
      .then(() => drawerBody.evaluate(element => element.scrollTop));
    const detailReadsBeforePoll = fixture.calls.filter(call => call.method === 'GET'
      && call.path.endsWith('/new-projects/board-project')).length;
    await page.waitForTimeout(6_200);
    expect(fixture.calls.filter(call => call.method === 'GET'
      && call.path.endsWith('/new-projects/board-project')).length).toBe(detailReadsBeforePoll);
    await expect(drawer).toBeVisible();
    await expect(drawer).toBeFocused();
    await expect(drawer).toContainText('모바일 광고 시안 보완');
    await expect(drawer).toContainText('CTA 버튼 간격을 다시 맞춰 주세요.');
    expect(await drawerBody.evaluate(element => element.scrollTop)).toBe(drawerScrollBeforePoll);
    await drawer.press('Escape');
    await expect(page.locator('[data-structured-task-drawer]')).toHaveCount(0);
    await expect(revisionCard.locator('[data-structured-board-task-open]')).toBeFocused();
    await page.locator('#personaSelect').focus();
    const detailReadsAfterClose = fixture.calls.filter(call => call.method === 'GET'
      && call.path.endsWith('/new-projects/board-project')).length;
    await expect.poll(() => fixture.calls.filter(call => call.method === 'GET'
      && call.path.endsWith('/new-projects/board-project')).length, { timeout: 9_000 })
      .toBeGreaterThan(detailReadsAfterClose);

    await page.locator('[data-structured-board-small-filter]').selectOption('board-project-small-design');
    await expect(page.locator('[data-structured-task-board] [data-work-item-id]')).toHaveCount(3);
    await expect(page.locator('[data-work-item-id="board-project-review"]')).toHaveCount(0);
    await page.locator('[data-structured-board-medium-filter]').selectOption('board-project-medium-operation');
    await expect(page.locator('[data-structured-board-small-filter]')).toHaveValue('all');
    await expect(page.locator('[data-structured-board-small-filter] option')).toHaveText(['전체 소분류', '채널 점검']);
    await expect(page.locator('[data-structured-task-board] [data-work-item-id]')).toHaveCount(2);
    await expect(page.locator('[data-work-item-id="board-project-review"]')).toBeVisible();
    await expect(page.locator('[data-work-item-id="board-project-done"]')).toBeVisible();
    await page.locator('[data-structured-board-assignee-filter]').selectOption('viewer-uid');
    await expect(page.locator('[data-structured-task-board] [data-work-item-id]')).toHaveCount(1);
    await expect(page.locator('[data-work-item-id="board-project-done"]')).toBeVisible();
    await page.locator('[data-structured-board-medium-filter]').selectOption('all');
    await expect(page.locator('[data-structured-task-board] [data-work-item-id]')).toHaveCount(2);
    await page.locator('[data-structured-board-assignee-filter]').selectOption('all');
    await page.locator('[data-structured-board-search]').fill('CTA 버튼 간격');
    await expect(page.locator('[data-structured-task-board] [data-work-item-id]')).toHaveCount(1);
    await expect(page.locator('[data-work-item-id="board-project-revision"]')).toBeVisible();
    await page.locator('[data-structured-board-search]').fill('검색 결과 없음');
    await expect(page.locator('[data-structured-board-empty]')).toBeVisible();
    await expect(page.locator('[data-structured-board-column]')).toHaveCount(4);
    await page.locator('[data-structured-board-search]').fill('');

    for (const viewport of [{ width: 1280, height: 800 }, { width: 1600, height: 900 }]) {
      await page.setViewportSize(viewport);
      const dimensions = await page.evaluate(() => ({
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
      }));
      expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewport);
      const boardBox = await board.boundingBox();
      expect(boardBox?.x || 0).toBeGreaterThanOrEqual(0);
      expect((boardBox?.x || 0) + (boardBox?.width || 0)).toBeLessThanOrEqual(viewport.width);
    }
    for (const width of [900, 800, 761]) {
      await page.setViewportSize({ width, height: 900 });
      const controlLayout = await page.locator('.structured-board-controls').evaluate((container) => {
        const parent = container.getBoundingClientRect();
        const items = [...container.querySelectorAll(':scope > label')].map(element => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
        });
        return {
          viewport: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          parent: { left: parent.left, right: parent.right, width: parent.width },
          items,
        };
      });
      expect(controlLayout.documentWidth).toBeLessThanOrEqual(controlLayout.viewport);
      expect(controlLayout.items).toHaveLength(4);
      expect(controlLayout.parent.left).toBeGreaterThanOrEqual(0);
      expect(controlLayout.parent.right).toBeLessThanOrEqual(width);
      expect(controlLayout.items.every(item => (
        item.left >= controlLayout.parent.left - 1
        && item.right <= controlLayout.parent.right + 1
        && item.width > 0
      ))).toBe(true);
      const [searchControl, mediumControl, smallControl, assigneeControl] = controlLayout.items;
      expect(searchControl.top).toBeLessThan(mediumControl.top);
      expect(Math.abs(mediumControl.top - smallControl.top)).toBeLessThanOrEqual(1);
      expect(mediumControl.right).toBeLessThanOrEqual(smallControl.left);
      expect(assigneeControl.top).toBeGreaterThanOrEqual(mediumControl.bottom);
      expect(Math.abs(searchControl.width - assigneeControl.width)).toBeLessThanOrEqual(1);
      expect(searchControl.width).toBeGreaterThan(mediumControl.width * 1.8);
    }
    expect(fixture.calls.filter(call => call.method === 'GET' && call.path.includes('/new-projects')).length).toBeGreaterThan(readsBeforeToggle);
    expect(fixture.calls.filter(call => call.method !== 'GET' && call.path.includes('/new-projects'))).toEqual([]);

    await hierarchyToggle.click();
    await expect(hierarchyToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-work-category-id]')).toHaveCount(2);
    await expect(page.locator('[data-structured-task-board]')).toHaveCount(0);
  });

  test('보드 필터의 중·소분류를 기본값으로 사용해 필수값을 확인하고 담당자에게 체크리스트를 배정한다', async ({ page }) => {
    const project = makeBoardProject({ id: 'board-quick-assign-project' });
    project.lead = { uid: 'e2e-test-user', name: '업무지시자 김팀장', rank: '팀장' };
    project.members[0] = { ...project.lead };
    const fixture: NewProjectFixture = {
      user: {
        uid: 'e2e-test-user', name: '업무지시자 김팀장', email: 'lead@test.local', rank: '팀장', role: 'manager',
        approved: true, is_active: true, group_id: 'hq-sales', group_name: '본사 영업팀', group_type: 'sales',
      },
      calls: [],
      projectsByWorkspace: { peak: [project] },
      capabilities: { viewPortfolio: false, createProject: false },
    };
    await setup(page, fixture);
    await openNewProjects(page);
    await page.locator('[data-structured-project-open="board-quick-assign-project"]').click();
    await page.locator('[data-structured-task-view="board"]').click();

    const assignButton = page.locator('[data-structured-board-assign]');
    await expect(assignButton).toBeVisible();
    await page.locator('[data-structured-board-medium-filter]').selectOption('board-quick-assign-project-medium-content');
    await page.locator('[data-structured-board-small-filter]').selectOption('board-quick-assign-project-small-design');
    await assignButton.click();

    const locationForm = page.locator('#structuredBoardAssignLocationForm');
    await expect(locationForm).toBeVisible();
    await expect(locationForm.locator('select[name="mediumId"]')).toHaveValue('board-quick-assign-project-medium-content');
    await expect(locationForm.locator('select[name="smallId"]')).toHaveValue('board-quick-assign-project-small-design');
    await locationForm.locator('[data-structured-board-assign-next]').click();
    const form = page.locator('#structuredTaskForm[data-structured-board-assign-form]');
    await expect(form).toBeVisible();
    await expect(form.locator('input[name="title"]')).toHaveAttribute('required', '');
    await expect(form.locator('select[name="assigneeUid"]')).toHaveAttribute('required', '');
    await expect(form.locator('input[name="dueDate"]')).toHaveAttribute('required', '');

    const submit = form.getByRole('button', { name: '담당자에게 배정', exact: true });
    const selfOption = form.locator('select[name="assigneeUid"] option[value="e2e-test-user"]');
    if (await selfOption.isDisabled()) {
      await expect(selfOption).toBeDisabled();
    } else {
      await form.locator('input[name="title"]').fill('검토자가 자기 자신인 잘못된 배정');
      await form.locator('select[name="assigneeUid"]').selectOption('e2e-test-user');
      await form.locator('input[name="dueDate"]').fill('2026-08-27');
      await submit.click();
      expect(fixture.calls.filter(call => call.method === 'POST' && call.path.endsWith('/tasks'))).toHaveLength(0);
      await expect(form).toBeVisible();
      await form.locator('input[name="title"]').fill('');
      await form.locator('select[name="assigneeUid"]').selectOption('');
      await form.locator('input[name="dueDate"]').fill('');
    }
    await submit.click();
    expect(fixture.calls.filter(call => call.method === 'POST' && call.path.endsWith('/tasks'))).toHaveLength(0);
    await form.locator('input[name="title"]').fill('보드에서 신규 체크리스트 배정');
    await form.locator('select[name="assigneeUid"]').selectOption('worker-uid');
    await submit.click();
    expect(fixture.calls.filter(call => call.method === 'POST' && call.path.endsWith('/tasks'))).toHaveLength(0);

    await form.locator('input[name="dueDate"]').fill('2026-08-28');
    await form.locator('textarea[name="description"]').fill('필터로 선택한 분류에 바로 배정합니다.');
    await submit.click();

    const createdCard = page.locator('[data-structured-board-column="todo"]')
      .locator('[data-work-item-id="board-quick-assign-project-task-4"]');
    await expect(createdCard).toBeVisible();
    await expect(createdCard).toContainText('보드에서 신규 체크리스트 배정');
    await expect(createdCard).toContainText('업무담당자 이사원');
    await expect(page.locator('[data-structured-board-search]')).toHaveValue('');
    await expect(page.locator('[data-structured-board-medium-filter]')).toHaveValue('board-quick-assign-project-medium-content');
    await expect(page.locator('[data-structured-board-small-filter]')).toHaveValue('board-quick-assign-project-small-design');
    await expect(page.locator('[data-structured-board-assignee-filter]')).toHaveValue('worker-uid');
    const taskCreate = fixture.calls.find(call => call.method === 'POST'
      && call.path.endsWith('/new-projects/board-quick-assign-project/mediums/board-quick-assign-project-medium-content/smalls/board-quick-assign-project-small-design/tasks'));
    expect(taskCreate).toMatchObject({ workspace: 'peak', preview: '0' });
    expect(taskCreate?.body).toEqual({
      title: '보드에서 신규 체크리스트 배정',
      description: '필터로 선택한 분류에 바로 배정합니다.',
      dueDate: '2026-08-28',
      assigneeUid: 'worker-uid',
    });
  });

  test('소분류가 없는 중분류에서 새 소분류를 만든 뒤 같은 흐름으로 업무를 배정한다', async ({ page }) => {
    const project = makeProject({ id: 'board-empty-small-project', name: '소분류 신규 배정' });
    project.lead = { uid: 'e2e-test-user', name: '업무지시자 김팀장', rank: '팀장' };
    project.members[0] = { ...project.lead };
    project.mediumCategories = [{
      id: 'board-empty-small-project-medium-1', name: '신규 캠페인', version: 1,
      manager: { uid: 'e2e-test-user', name: '업무지시자 김팀장' }, smallCategories: [],
    }];
    project.taskCount = 0;
    project.doneTaskCount = 0;
    project.reviewTaskCount = 0;
    const fixture: NewProjectFixture = {
      user: {
        uid: 'e2e-test-user', name: '업무지시자 김팀장', email: 'lead@test.local', rank: '팀장', role: 'manager',
        approved: true, is_active: true, group_id: 'hq-sales', group_name: '본사 영업팀', group_type: 'sales',
      },
      calls: [],
      projectsByWorkspace: { peak: [project] },
      capabilities: { viewPortfolio: false, createProject: false },
    };
    await setup(page, fixture);
    await openNewProjects(page);
    await page.locator('[data-structured-project-open="board-empty-small-project"]').click();
    await page.locator('[data-structured-task-view="board"]').click();
    await page.locator('[data-structured-board-medium-filter]').selectOption('board-empty-small-project-medium-1');
    await page.locator('[data-structured-board-assign]').click();

    const locationForm = page.locator('#structuredBoardAssignLocationForm');
    await expect(locationForm.locator('select[name="mediumId"]')).toHaveValue('board-empty-small-project-medium-1');
    await expect(locationForm.locator('select[name="smallId"]')).toHaveValue('');
    await locationForm.locator('[data-structured-board-small-start]').click();
    const categoryForm = page.locator('#structuredCategoryForm');
    await expect(categoryForm).toBeVisible();
    await categoryForm.locator('input[name="name"]').fill('랜딩 페이지');
    await categoryForm.getByRole('button', { name: '추가', exact: true }).click();

    const form = page.locator('#structuredTaskForm[data-structured-board-assign-form]');
    await expect(form).toBeVisible();
    await form.locator('input[name="title"]').fill('랜딩 페이지 문구 검수');
    await form.locator('select[name="assigneeUid"]').selectOption('viewer-uid');
    await form.locator('input[name="dueDate"]').fill('2026-08-29');
    await form.getByRole('button', { name: '담당자에게 배정', exact: true }).click();

    const writes = fixture.calls.filter(call => call.method === 'POST'
      && call.path.includes('/new-projects/board-empty-small-project'));
    expect(writes.map(call => call.path)).toEqual([
      '/peakos/collaboration/new-projects/board-empty-small-project/mediums/board-empty-small-project-medium-1/smalls',
      '/peakos/collaboration/new-projects/board-empty-small-project/mediums/board-empty-small-project-medium-1/smalls/board-empty-small-project-small-1/tasks',
    ]);
    expect(writes[0]).toMatchObject({ workspace: 'peak', body: { name: '랜딩 페이지' } });
    expect(writes[1]).toMatchObject({
      workspace: 'peak',
      body: {
        title: '랜딩 페이지 문구 검수', description: '', dueDate: '2026-08-29', assigneeUid: 'viewer-uid',
      },
    });
    const card = page.locator('[data-structured-board-column="todo"]')
      .locator('[data-work-item-id="board-empty-small-project-task-1"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('신규 캠페인');
    await expect(card).toContainText('랜딩 페이지');
    await expect(card).toContainText('공동구성원 박대리');
    await expect(page.locator('[data-structured-board-medium-filter]')).toHaveValue('board-empty-small-project-medium-1');
    await expect(page.locator('[data-structured-board-small-filter]')).toHaveValue('board-empty-small-project-small-1');
    await expect(page.locator('[data-structured-board-assignee-filter]')).toHaveValue('viewer-uid');
    expect(findTask(project, 'board-empty-small-project-task-1')?.reviewer).toMatchObject({
      uid: 'e2e-test-user', name: '업무지시자 김팀장',
    });
  });

  test('보드 상세 패널에서 수정 요청·재검토·승인을 기존 version API로 처리한다', async ({ page }) => {
    const project = makeBoardProject();
    const fixture: NewProjectFixture = {
      calls: [],
      projectsByWorkspace: { peak: [project] },
      capabilities: { viewPortfolio: true, createProject: true },
    };
    await setup(page, fixture);
    await openNewProjects(page);
    await page.locator('[data-structured-project-open="board-project"]').click();
    await page.locator('[data-structured-task-view="board"]').click();

    await page.locator('[data-work-item-id="board-project-review"] [data-structured-board-task-open]').click();
    let drawer = page.locator('[data-structured-task-drawer]');
    await expect(drawer.locator('[data-work-item-approve="board-project-review"]')).toBeVisible();
    await expect(drawer.locator('[data-work-item-revision="board-project-review"]')).toBeVisible();
    await drawer.locator('[data-work-item-revision="board-project-review"]').click();
    const revisionForm = page.locator('#structuredRevisionForm');
    await revisionForm.locator('[name="note"]').fill('링크 권한과 UTM을 다시 확인해 주세요.');
    await revisionForm.getByRole('button', { name: '수정 요청 보내기' }).click();

    const doingLane = page.locator('[data-structured-board-column="doing"]');
    await expect(doingLane.locator('[data-work-item-id="board-project-review"]')).toBeVisible();
    await expect(page.locator('[data-structured-board-column="review"] [data-work-item-id="board-project-review"]')).toHaveCount(0);
    drawer = page.locator('[data-structured-task-drawer]');
    await expect(drawer).toContainText('링크 권한과 UTM을 다시 확인해 주세요.');
    await drawer.locator('[data-work-item-submit="board-project-review"]').click();

    await expect(page.locator('[data-structured-board-column="review"] [data-work-item-id="board-project-review"]')).toBeVisible();
    drawer = page.locator('[data-structured-task-drawer]');
    await drawer.locator('[data-work-item-approve="board-project-review"]').click();
    await expect(page.locator('[data-structured-board-column="done"] [data-work-item-id="board-project-review"]')).toBeVisible();
    await expect(page.locator('[data-structured-task-drawer]')).toContainText('승인 완료');

    const actions = fixture.calls
      .filter(call => call.path.endsWith('/tasks/board-project-review/review'))
      .map(call => ({ action: call.body.action, note: call.body.note, version: call.body.expectedVersion }));
    expect(actions).toEqual([
      { action: 'revision', note: '링크 권한과 UTM을 다시 확인해 주세요.', version: 3 },
      { action: 'request', note: '', version: 4 },
      { action: 'approve', note: '', version: 5 },
    ]);
  });

  test('운영 DTO에 직급이 없어도 조직도 이름으로 전현우 팀장·김대호 부장을 표시하고 앱 role은 직급으로 쓰지 않는다', async ({ page }) => {
    const project = makeProject({
      id: 'rank-fallback-project', name: '운영 직급 표시 프로젝트', canManage: false, canEditSettings: false,
    });
    project.lead = { uid: 'jeon-hyeonwoo', name: '전현우', role: 'member' };
    project.members = [
      { uid: 'jeon-hyeonwoo', name: '전현우', role: 'member' },
      { uid: 'kim-daeho', name: '김대호', role: 'admin' },
    ];
    const fixture: NewProjectFixture = {
      calls: [],
      projectsByWorkspace: { peak: [project] },
      capabilities: { viewPortfolio: true, createProject: true },
    };
    await setup(page, fixture);
    await openNewProjects(page);
    await page.locator('[data-structured-project-open="rank-fallback-project"]').click();

    const leadCard = page.locator('.structured-project-lead-card');
    await expect(leadCard).toContainText('전현우');
    await expect(leadCard).toContainText('팀장');
    const team = page.locator('.structured-project-team');
    await expect(page.locator('[data-structured-project-detail]')).toContainText('프로젝트 팀원 2명');
    await expect(page.locator('.structured-project-member-rank')).toHaveText(['팀장', '부장']);
    await expect(team).not.toContainText('member');
    await expect(team).not.toContainText('admin');
  });

  test('기존 중분류에 담당자가 없어도 상세를 안전하게 표시한다', async ({ page }) => {
    const project = makeProject({
      id: 'legacy-null-manager-project', name: '기존 중분류 호환', canManage: false, canEditSettings: false,
    });
    project.mediumCategories[0].manager = null;
    const fixture: NewProjectFixture = {
      calls: [],
      projectsByWorkspace: { peak: [project] },
      capabilities: { viewPortfolio: false, createProject: false },
    };
    await setup(page, fixture);
    await openNewProjects(page);
    await page.locator('[data-structured-project-open="legacy-null-manager-project"]').click();

    const manager = page.locator('[data-work-category-id="legacy-null-manager-project-medium-1"] [data-structured-medium-manager]');
    await expect(manager).toHaveText('중분류 담당자 미지정');
    await expect(page.locator('[data-structured-medium-edit]')).toHaveCount(0);
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
    await expect(page.locator('[data-structured-project-edit]')).toHaveCount(0);
    await expect(page.locator('[data-structured-project-lead-edit]')).toHaveCount(0);
    await expect(page.locator('[data-structured-medium-create]')).toHaveCount(0);
    await expect(page.locator('[data-structured-task-create]')).toHaveCount(0);

    const newProjectReads = fixture.calls.filter(call => call.method === 'GET' && call.path.includes('/new-projects'));
    expect(newProjectReads.every(call => !call.path.includes('?') && call.body == null)).toBe(true);
  });

  test('Peak exact3 생성자는 현재 팀원일 때 담당자·팀원 수정만 하고 업무 구조는 변경하지 못한다', async ({ page }) => {
    const project = makeProject({
      id: 'managed-project', name: '관리 프로젝트', canManage: false, canEditSettings: true,
    });
    const fixture: NewProjectFixture = {
      calls: [],
      projectsByWorkspace: { peak: [project] },
      capabilities: { viewPortfolio: true, createProject: true },
    };
    await setup(page, fixture);
    await openNewProjects(page);

    await page.locator('[data-structured-project-create]').click();
    const createForm = page.locator('#structuredProjectForm');
    await expect(createForm.getByText('프로젝트명', { exact: true })).toBeVisible();
    await expect(createForm).not.toContainText('대분류');
    await expect(createForm.getByText('프로젝트 담당자', { exact: true })).toBeVisible();
    await expect(createForm.getByText('프로젝트 팀원', { exact: true })).toBeVisible();
    await expect(createForm.getByText('같이 볼 구성원', { exact: true })).toHaveCount(0);
    await expect(createForm.locator('select[name="leadUid"]')).toBeVisible();
    await expect(createForm.locator('input[name="memberUids"]')).toHaveCount(4);
    await createForm.locator('[data-collab-cancel]').click();

    await page.locator('[data-structured-project-open="managed-project"]').click();
    await expect(page.locator('[data-structured-project-edit]')).toBeVisible();
    await expect(page.locator('[data-structured-project-lead-edit]')).toBeVisible();
    await expect(page.locator('[data-structured-medium-create]')).toHaveCount(0);
    await expect(page.locator('[data-structured-small-create]')).toHaveCount(0);
    await expect(page.locator('[data-structured-task-create]')).toHaveCount(0);
    await expect(page.locator('[data-structured-medium-edit]')).toHaveCount(0);
    await page.locator('[data-structured-task-view="board"]').click();
    await expect(page.locator('[data-structured-board-assign]')).toHaveCount(0);
    await page.locator('[data-structured-task-view="hierarchy"]').click();
    await page.locator('[data-structured-project-lead-edit]').click();
    const editForm = page.locator('#structuredProjectForm');
    await expect(editForm.getByText('프로젝트 팀원', { exact: true })).toBeVisible();
    await editForm.locator('textarea[name="description"]').fill('버전 충돌을 막는 설정 변경');
    await editForm.getByRole('button', { name: '변경 저장' }).click();
    await expect(page.locator('[data-structured-project-detail]')).toContainText('버전 충돌을 막는 설정 변경');
    const update = fixture.calls.find(call => call.method === 'PUT' && call.path.endsWith('/new-projects/managed-project'));
    expect(update?.body).toMatchObject({ expectedVersion: 1, description: '버전 충돌을 막는 설정 변경' });
  });

  test('실제 프로젝트 담당자는 중분류와 소분류를 만든 뒤 팀원에게 체크리스트 업무를 배정한다', async ({ page }) => {
    const project = makeProject({
      id: 'lead-project', name: '담당자 업무 배정 프로젝트', canManage: true, canEditSettings: true,
    });
    project.mediumCategories = [];
    project.taskCount = 0;
    project.doneTaskCount = 0;
    project.reviewTaskCount = 0;
    const fixture: NewProjectFixture = {
      user: {
        uid: 'lead-uid', name: '업무지시자 김팀장', email: 'lead@test.local', rank: '팀장', role: 'manager',
        approved: true, is_active: true, group_id: 'hq-sales', group_name: '본사 영업팀', group_type: 'sales',
      },
      calls: [],
      projectsByWorkspace: { peak: [project] },
      capabilities: { viewPortfolio: false, createProject: false },
    };
    await setup(page, fixture);
    await openNewProjects(page);
    await page.locator('[data-structured-project-open="lead-project"]').click();

    await expect(page.locator('[data-structured-project-lead-edit]')).toBeVisible();
    await expect(page.locator('[data-structured-medium-create]')).toHaveCount(2);
    await page.locator('[data-structured-medium-create]').last().click();
    let categoryForm = page.locator('#structuredCategoryForm');
    await expect(categoryForm.locator('select[name="managerUid"]')).toHaveValue('lead-uid');
    const managerOptions = await categoryForm.locator('select[name="managerUid"] option').evaluateAll(options =>
      options.map(option => (option as HTMLOptionElement).value).filter(Boolean).sort());
    expect(managerOptions).toEqual(['lead-uid', 'viewer-uid', 'worker-uid']);
    await categoryForm.locator('input[name="name"]').fill('콘텐츠 제작');
    await categoryForm.locator('select[name="managerUid"]').selectOption('worker-uid');
    await categoryForm.getByRole('button', { name: '추가', exact: true }).click();

    const medium = page.locator('[data-work-category-id="lead-project-medium-1"]');
    await expect(medium).toContainText('콘텐츠 제작');
    await expect(medium.locator('[data-structured-medium-manager]')).toContainText('업무담당자 이사원');
    await expect(medium.locator('[data-structured-medium-manager]')).toContainText('사원');
    await medium.locator('[data-structured-medium-edit]').click();
    categoryForm = page.locator('#structuredCategoryForm');
    await expect(categoryForm.locator('select[name="managerUid"]')).toHaveValue('worker-uid');
    await categoryForm.locator('select[name="managerUid"]').selectOption('viewer-uid');
    await categoryForm.getByRole('button', { name: '변경 저장', exact: true }).click();
    await expect(medium.locator('[data-structured-medium-manager]')).toContainText('공동구성원 박대리');
    await expect(medium.locator('[data-structured-medium-manager]')).toContainText('대리');
    await medium.locator('[data-structured-small-create]').last().click();
    categoryForm = page.locator('#structuredCategoryForm');
    await categoryForm.locator('input[name="name"]').fill('광고 시안');
    await categoryForm.getByRole('button', { name: '추가', exact: true }).click();

    const small = page.locator('[data-work-subcategory-id="lead-project-small-1"]');
    await expect(small).toContainText('광고 시안');
    await small.locator('[data-structured-task-create]').click();
    const taskForm = page.locator('#structuredTaskForm');
    await expect(taskForm).toContainText('업무 지시자');
    await taskForm.locator('input[name="title"]').fill('모바일 광고 시안 제작');
    await taskForm.locator('select[name="assigneeUid"]').selectOption('worker-uid');
    await taskForm.locator('input[name="dueDate"]').fill('2026-08-31');
    await taskForm.locator('textarea[name="description"]').fill('소분류 기준으로 업무를 배정합니다.');
    await taskForm.getByRole('button', { name: '업무 토스', exact: true }).click();

    const task = page.locator('[data-work-item-id="lead-project-task-1"]');
    await expect(task).toContainText('모바일 광고 시안 제작');
    await expect(task.locator('.structured-assignment-flow')).toContainText('업무지시자 김팀장');
    await expect(task.locator('.structured-assignment-flow')).toContainText('업무담당자 이사원');
    const categoryCreate = fixture.calls.find(call => call.method === 'POST' && call.path.endsWith('/new-projects/lead-project/mediums'));
    expect(categoryCreate?.body).toMatchObject({ name: '콘텐츠 제작', managerUid: 'worker-uid' });
    const categoryUpdate = fixture.calls.find(call => call.method === 'PUT' && call.path.endsWith('/new-projects/lead-project/mediums/lead-project-medium-1'));
    expect(categoryUpdate?.body).toMatchObject({ name: '콘텐츠 제작', managerUid: 'viewer-uid', expectedVersion: 1 });
    const writes = fixture.calls.filter(call => call.method === 'POST' && call.path.includes('/new-projects/lead-project'));
    expect(writes.map(call => call.path)).toEqual([
      '/peakos/collaboration/new-projects/lead-project/mediums',
      '/peakos/collaboration/new-projects/lead-project/mediums/lead-project-medium-1/smalls',
      '/peakos/collaboration/new-projects/lead-project/mediums/lead-project-medium-1/smalls/lead-project-small-1/tasks',
    ]);
    expect(writes[2]?.body).toEqual({
      title: '모바일 광고 시안 제작', description: '소분류 기준으로 업무를 배정합니다.',
      dueDate: '2026-08-31', assigneeUid: 'worker-uid',
    });
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
    await expect(page.locator('[data-structured-project-edit]')).toHaveCount(0);
    await expect(page.locator('[data-structured-project-lead-edit]')).toHaveCount(0);
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
    await page.locator('[data-structured-project-open="private-project"]').click();
    await page.locator('[data-structured-task-view="board"]').click();
    await expect(page.locator('[data-structured-board-assign]')).toBeVisible();
    await page.locator('[data-work-item-id="private-project-task-1"] [data-structured-board-task-open]').click();
    await expect(page.locator('[data-structured-task-drawer]')).toContainText('메인 캠페인 시안 제작');
    const readsBefore = fixture.calls.filter(call => call.method === 'GET' && call.path.includes('/new-projects')).length;

    await page.locator('#personaSelect').selectOption('박우진');
    await expect(page.locator('[data-structured-private-state]')).toContainText('계정 미리보기에서는 신규 프로젝트가 비공개입니다');
    await expect(page.locator('[data-structured-task-board]')).toHaveCount(0);
    await expect(page.locator('[data-structured-task-drawer]')).toHaveCount(0);
    await expect(page.locator('[data-structured-project-id]')).toHaveCount(0);
    await expect(page.locator('[data-work-item-id]')).toHaveCount(0);
    await expect(page.locator('[data-structured-project-create]')).toHaveCount(0);
    await expect(page.locator('[data-structured-board-assign]')).toHaveCount(0);
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

    await page.locator('[data-structured-task-view="board"]').click();
    await expect(page.locator('[data-structured-task-board] [data-work-item-id="branch-portfolio-project-task-1"]')).toBeVisible();
    await expect(page.locator('[data-structured-board-assign]')).toHaveCount(0);
    await page.locator('[data-work-item-id="branch-portfolio-project-task-1"] [data-structured-board-task-open]').click();
    const readonlyDrawer = page.locator('[data-structured-task-drawer]');
    await expect(readonlyDrawer).toContainText('현재 계정에서 처리할 수 있는 작업이 없습니다.');
    await expect(readonlyDrawer.locator('[data-work-item-submit]')).toHaveCount(0);
    await expect(readonlyDrawer.locator('[data-work-item-approve]')).toHaveCount(0);
    await expect(readonlyDrawer.locator('[data-work-item-revision]')).toHaveCount(0);
    await expect(readonlyDrawer.locator('[data-work-item-edit]')).toHaveCount(0);

    const structuredCalls = fixture.calls.filter(call => call.path.includes('/new-projects'));
    expect(structuredCalls.length).toBeGreaterThan(0);
    expect(structuredCalls.every(call => call.method === 'GET' && call.workspace === 'daegu')).toBe(true);
  });

  test('390px 보드에서 빠른 배정 단계와 폼이 넘치지 않고 44px 터치 영역을 유지한다', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const project = makeBoardProject({ id: 'mobile-board-assign-project' });
    project.lead = { uid: 'e2e-test-user', name: '업무지시자 김팀장', rank: '팀장' };
    project.members[0] = { ...project.lead };
    const fixture: NewProjectFixture = {
      user: {
        uid: 'e2e-test-user', name: '업무지시자 김팀장', email: 'lead@test.local', rank: '팀장', role: 'manager',
        approved: true, is_active: true, group_id: 'hq-sales', group_name: '본사 영업팀', group_type: 'sales',
      },
      calls: [],
      projectsByWorkspace: { peak: [project] },
      capabilities: { viewPortfolio: false, createProject: false },
    };
    await setup(page, fixture);
    await openNewProjects(page);
    await page.locator('[data-structured-project-open="mobile-board-assign-project"]').click();
    await page.locator('[data-structured-task-view="board"]').click();

    const assignButton = page.locator('[data-structured-board-assign]');
    const assignButtonBox = await assignButton.boundingBox();
    expect(assignButtonBox?.height || 0).toBeGreaterThanOrEqual(44);
    await assignButton.click();

    const locationForm = page.locator('#structuredBoardAssignLocationForm');
    await expect(locationForm).toBeVisible();
    const locationControlsFit = await locationForm.locator('select, button').evaluateAll(elements => elements.every(element => {
      const rect = element.getBoundingClientRect();
      return rect.height >= 44 && rect.left >= 0 && rect.right <= window.innerWidth;
    }));
    expect(locationControlsFit).toBe(true);
    await locationForm.locator('[data-structured-board-assign-next]').click();

    const taskForm = page.locator('#structuredTaskForm[data-structured-board-assign-form]');
    await expect(taskForm).toBeVisible();
    const taskControlsFit = await taskForm.locator('input, select, textarea, button').evaluateAll(elements => elements.every(element => {
      const rect = element.getBoundingClientRect();
      return rect.height >= 44 && rect.left >= 0 && rect.right <= window.innerWidth;
    }));
    expect(taskControlsFit).toBe(true);
    const mobileDimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      modalRight: document.querySelector('.readonly-modal-card')?.getBoundingClientRect().right || 0,
    }));
    expect(mobileDimensions.documentWidth).toBeLessThanOrEqual(mobileDimensions.viewport);
    expect(mobileDimensions.modalRight).toBeLessThanOrEqual(mobileDimensions.viewport);

    await taskForm.locator('[data-collab-cancel]').click();
    await page.locator('[data-structured-task-view="hierarchy"]').click();
    await expect(page.locator('[data-work-category-id]')).toHaveCount(2);
    await expect(page.locator('[data-structured-task-board]')).toHaveCount(0);
    await page.locator('[data-structured-task-view="board"]').click();
    await expect(page.locator('[data-structured-board-assign]')).toBeVisible();
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
    await expect(page.locator('[data-structured-medium-manager]')).toContainText('업무담당자 이사원');
    await expect(page.locator('[data-structured-medium-manager]')).toContainText('사원');
    await expect(page.locator('[data-work-category-id]')).toBeVisible();
    await expect(page.locator('[data-work-subcategory-id]')).toBeVisible();
    await expect(page.locator('[data-work-item-id]')).toBeVisible();
    await expect(page.locator('[data-structured-project-detail]')).toContainText('프로젝트 팀원 3명');
    await expect(page.locator('.structured-project-team-member')).toHaveCount(3);

    const detail = page.locator('[data-structured-project-detail]');
    const mobileElementsFit = await detail.locator([
      '.structured-detail-hero',
      '.structured-detail-title',
      '.structured-detail-people',
      '.structured-detail-progress',
    ].join(', ')).evaluateAll(elements => elements.every(element => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    }));
    expect(mobileElementsFit).toBe(true);
    const [mobileTitle, mobilePeople, mobileProgress] = await Promise.all([
      detail.locator('.structured-detail-title').boundingBox(),
      detail.locator('.structured-detail-people').boundingBox(),
      detail.locator('.structured-detail-progress').boundingBox(),
    ]);
    if (!mobileTitle || !mobilePeople || !mobileProgress) throw new Error('모바일 프로젝트 상단 배치를 확인할 수 없습니다.');
    expect(mobilePeople.y).toBeGreaterThanOrEqual(mobileTitle.y + mobileTitle.height);
    expect(mobileProgress.y).toBeGreaterThanOrEqual(mobilePeople.y + mobilePeople.height);
    const progressTrack = await detail.locator('.structured-detail-progress > i').boundingBox();
    expect(progressTrack?.width || 0).toBeGreaterThan(280);
    const mobileActionButtons = detail.locator('.structured-detail-nav button, .structured-task-actions button');
    expect(await mobileActionButtons.count()).toBeGreaterThan(0);
    const mobileButtonsMeetTouchTarget = await mobileActionButtons.evaluateAll(elements => elements.every(element => {
      const rect = element.getBoundingClientRect();
      return rect.height >= 44 && rect.left >= 0 && rect.right <= window.innerWidth;
    }));
    expect(mobileButtonsMeetTouchTarget).toBe(true);

    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewport);
    const teamCardsFit = await page.locator('.structured-project-team-member').evaluateAll(elements => elements.every(element => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    }));
    expect(teamCardsFit).toBe(true);
    const checkbox = page.locator('.structured-task-check').first();
    const box = await checkbox.boundingBox();
    expect(box?.width || 0).toBeGreaterThanOrEqual(40);
    expect(box?.height || 0).toBeGreaterThanOrEqual(40);

    await page.locator('[data-structured-task-view="board"]').click();
    const board = page.locator('[data-structured-task-board]');
    await expect(board).toBeVisible();
    await expect(page.locator('[data-structured-board-column]')).toHaveCount(4);
    const boardFits = await board.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    });
    expect(boardFits).toBe(true);
    const boardScroller = page.locator('.structured-board-grid');
    const boardScroll = await boardScroller.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));
    expect(boardScroll.scrollWidth).toBeGreaterThan(boardScroll.clientWidth);
    expect(['auto', 'scroll']).toContain(boardScroll.overflowX);
    const boardToggleBox = await page.locator('[data-structured-task-view="board"]').boundingBox();
    expect(boardToggleBox?.height || 0).toBeGreaterThanOrEqual(44);
    const boardCardButton = page.locator('[data-structured-board-task-open]').first();
    const boardCardBox = await boardCardButton.boundingBox();
    expect(boardCardBox?.height || 0).toBeGreaterThanOrEqual(44);
    await boardCardButton.click();
    const mobileDrawer = page.locator('[data-structured-task-drawer]');
    await expect(mobileDrawer).toBeVisible();
    await expect.poll(() => mobileDrawer.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    })).toBe(true);
    const closeDrawer = mobileDrawer.locator('[data-structured-task-drawer-close]');
    const closeDrawerBox = await closeDrawer.boundingBox();
    expect(closeDrawerBox?.width || 0).toBeGreaterThanOrEqual(44);
    expect(closeDrawerBox?.height || 0).toBeGreaterThanOrEqual(44);
    const mobileDrawerActions = mobileDrawer.locator('.structured-task-drawer-actions button');
    if (await mobileDrawerActions.count()) {
      const actionsMeetTouchTarget = await mobileDrawerActions.evaluateAll(elements => elements.every(element => {
        const rect = element.getBoundingClientRect();
        return rect.height >= 44 && rect.left >= 0 && rect.right <= window.innerWidth;
      }));
      expect(actionsMeetTouchTarget).toBe(true);
    }
    await closeDrawer.click();
    await expect(page.locator('[data-structured-task-drawer]')).toHaveCount(0);
    const boardDimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(boardDimensions.documentWidth).toBeLessThanOrEqual(boardDimensions.viewport);
    const newProjectCalls = fixture.calls.filter(call => call.path.includes('/new-projects'));
    expect(newProjectCalls.length).toBeGreaterThan(0);
    expect(newProjectCalls.every(call => call.workspace === 'daegu')).toBe(true);
  });
});
