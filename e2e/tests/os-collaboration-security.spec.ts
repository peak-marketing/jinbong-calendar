import { expect, test, type Page, type Route } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createPeakosStore, handlePeakos, installFirebaseStub } from './helpers';

const ROOT = path.resolve(__dirname, '../..');

type ApiCall = {
  method: string;
  path: string;
  body: any;
  preview: string;
  workspace: string;
  search: string;
};

type CollaborationState = {
  otpVerified: boolean;
  failNextMutation: boolean;
  failReadAckCount: number;
  failDirectoryCount: number;
  sequence: number;
  user: any;
  calls: ApiCall[];
  events: any[];
  checklists: Record<string, any[]>;
  rooms: any[];
  roomMembers: Record<string, any[]>;
  messages: Record<string, any[]>;
  projects: any[];
  workspaceData?: Record<string, { events: any[]; projects: any[] }>;
};

function uuidFromSequence(sequence: number) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function todayKey() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).reduce<Record<string, string>>((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function createState(overrides: Partial<CollaborationState> = {}): CollaborationState {
  return {
    otpVerified: true,
    failNextMutation: false,
    failReadAckCount: 0,
    failDirectoryCount: 0,
    sequence: 0,
    user: {
      uid: 'e2e-test-user', name: '김대호', email: 'e2e@test.local', role: 'admin',
      approved: true, is_active: true, group_id: 'hq-sales', group_name: '본사 영업팀',
      group_type: 'sales', peakos_can_read_bank: true,
      peakos_can_view_bank_balances: true, peakos_can_review_finance: true,
      peakos_can_view_tax_purchase: true,
      peakos_can_preview_accounts: true,
      peakos_special_settlement_views: ['direct-execution'],
    },
    calls: [],
    events: [],
    checklists: {},
    rooms: [],
    roomMembers: {},
    messages: {},
    projects: [],
    ...overrides,
  };
}

async function serveOsShell(page: Page) {
  const html = fs.readFileSync(path.join(ROOT, 'business-os-preview.html'));
  const js = fs.readFileSync(path.join(ROOT, 'business-os-preview.js'));
  const css = fs.readFileSync(path.join(ROOT, 'business-os-live.css'));
  await page.route('**/os/**', async route => {
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

async function installSharedApi(page: Page, state: CollaborationState) {
  const peakos = createPeakosStore('김대호', 'admin');
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const originalPath = url.pathname.replace(/^\/api/, '');
    const protectedRequest = originalPath === '/peakos/collaboration'
      || originalPath.startsWith('/peakos/collaboration/');
    const resourcePath = protectedRequest
      ? originalPath.slice('/peakos/collaboration'.length) || '/'
      : originalPath;
    const method = request.method().toUpperCase();
    const body = parseBody(route);
    const workspaceSlug = request.headers()['x-peakos-workspace'] || 'peak';
    const workspaceFixture = state.workspaceData?.[workspaceSlug];
    const requestEvents = workspaceFixture?.events || state.events;
    const requestProjects = workspaceFixture?.projects || state.projects;
    state.calls.push({
      method,
      path: originalPath,
      body,
      preview: request.headers()['x-peakos-preview'] || '',
      workspace: request.headers()['x-peakos-workspace'] || '',
      search: url.search,
    });

    const send = (payload: unknown, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });

    if (originalPath === '/users/me') {
      return send(state.user);
    }
    if (originalPath === '/os-auth/session') {
      if (!state.otpVerified) {
        return send({
          error: 'PEAK OS 추가 인증이 필요합니다.', code: 'OS_AUTH_SESSION_REQUIRED',
          required: true, verified: false,
        }, 401);
      }
      return send({ required: true, verified: true, expiresInSeconds: 3600 });
    }
    if (originalPath === '/os/workspaces') return send({
      default_slug: 'peak',
      workspaces: [
        { id: 'workspace-peak', slug: 'peak', name: '피크마케팅', kind: 'headquarters', role: 'admin' },
        ...Object.keys(state.workspaceData || {}).filter(slug => slug !== 'peak').map(slug => ({
          id: `workspace-${slug}`, slug, name: slug === 'daegu' ? '피크마케팅 대구지사' : slug,
          kind: 'branch', role: 'admin',
        })),
      ],
    });
    const workspaceContextMatch = originalPath.match(/^\/os\/workspaces\/([^/]+)\/context$/);
    if (workspaceContextMatch) {
      const slug = decodeURIComponent(workspaceContextMatch[1]);
      if (slug !== 'peak' && !state.workspaceData?.[slug]) return send({ error: 'Not found' }, 404);
      return send({
        workspace: {
          id: `workspace-${slug}`, slug,
          name: slug === 'peak' ? '피크마케팅' : slug === 'daegu' ? '피크마케팅 대구지사' : slug,
          kind: slug === 'peak' ? 'headquarters' : 'branch',
        },
        membership: { role: 'admin' },
        permissions: {
          calendar: 'write', chat: 'write', projects: 'write', settlements: 'write', documents: 'write',
          headquartersOversight: false,
        },
      });
    }

    if (protectedRequest && !state.otpVerified) {
      return send({
        error: 'PEAK OS 추가 인증이 필요합니다.', code: 'OS_AUTH_SESSION_REQUIRED',
        required: true, verified: false,
      }, 401);
    }
    if (protectedRequest && method !== 'GET' && request.headers()['x-peakos-preview'] === '1') {
      return send({ error: '계정 미리보기에서는 변경할 수 없습니다.', code: 'PEAKOS_PREVIEW_WRITE_FORBIDDEN' }, 403);
    }
    if (protectedRequest && method !== 'GET' && state.failNextMutation) {
      state.failNextMutation = false;
      return send({ error: '동시 수정 충돌 테스트' }, 409);
    }
    if (protectedRequest && method === 'GET') {
      const chatOnlyAllowed = resourcePath.startsWith('/chat-rooms') || resourcePath === '/users/all-approved';
      const externalCalendarAllowed = chatOnlyAllowed || resourcePath.startsWith('/events');
      if (state.user.chat_only && !chatOnlyAllowed) return send({ error: 'This account is restricted to chat' }, 403);
      if (state.user.external_calendar_only && !externalCalendarAllowed) {
        return send({ error: 'This account is restricted to calendar and chat' }, 403);
      }
    }

    if (resourcePath === '/users/all-approved' && method === 'GET') {
      if (state.failDirectoryCount > 0) {
        state.failDirectoryCount -= 1;
        return send({ error: '직원 목록 일시 오류' }, 500);
      }
      return send([
        { uid: 'e2e-test-user', name: '김대호', email: 'e2e@test.local', group_id: 'hq-sales', group_name: '본사 영업팀' },
        { uid: 'other-user', name: '박우진', email: 'other@test.local', group_id: 'hq-sales', group_name: '본사 영업팀' },
      ]);
    }

    if (resourcePath === '/events/checklist-summary' && method === 'GET') {
      const summary = Object.fromEntries(Object.entries(state.checklists).map(([eventId, items]) => [
        eventId,
        { total: items.length, completed: items.filter(item => item.done).length },
      ]));
      return send(summary);
    }
    if (resourcePath === '/events' && method === 'GET') return send(requestEvents.filter(event => !event.deleted));
    if (resourcePath === '/events' && method === 'POST') {
      const category = String(body?.todoCat || '');
      const categoryRows = state.events.filter(event =>
        event.type === 'todo'
        && event.date === body?.date
        && event.scope === (body?.scope || 'personal')
        && String(event.todo_cat || event.todoCat || '') === category
        && ((body?.scope || 'personal') !== 'personal' || event.owner_id === 'e2e-test-user')
      );
      const created = {
        id: `event-${++state.sequence}`,
        ...body,
        owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false,
        sort_order: Math.max(-1, ...categoryRows.map(event => Number(event.sort_order || 0))) + 1,
      };
      state.events.push(created);
      state.checklists[created.id] = (body?.checklist || []).map((title: string, index: number) => ({
        id: `${created.id}-check-${index + 1}`, event_id: created.id, title, done: false, sort_order: index,
      }));
      return send(created);
    }
    if (resourcePath === '/events/reorder' && method === 'POST') {
      for (const item of body?.items || []) {
        const event = state.events.find(entry => String(entry.id) === String(item.id));
        if (event) event.sort_order = item.sortOrder;
      }
      return send({ ok: true, updated: body?.items?.length || 0 });
    }
    const eventMatch = resourcePath.match(/^\/events\/([^/]+)$/);
    if (eventMatch && method === 'PUT') {
      const event = state.events.find(item => String(item.id) === decodeURIComponent(eventMatch[1]));
      if (!event) return send({ error: 'Not found' }, 404);
      Object.assign(event, body || {});
      return send(event);
    }
    const checklistListMatch = resourcePath.match(/^\/events\/([^/]+)\/checklist$/);
    if (checklistListMatch && method === 'GET') {
      return send(state.checklists[decodeURIComponent(checklistListMatch[1])] || []);
    }
    if (checklistListMatch && method === 'POST') {
      const eventId = decodeURIComponent(checklistListMatch[1]);
      const list = state.checklists[eventId] || (state.checklists[eventId] = []);
      const item = { id: `${eventId}-check-${++state.sequence}`, event_id: eventId, title: body?.title, done: false, sort_order: list.length };
      list.push(item);
      return send({ item, event: state.events.find(event => String(event.id) === eventId) || null });
    }
    const checklistItemMatch = resourcePath.match(/^\/events\/([^/]+)\/checklist\/([^/]+)$/);
    if (checklistItemMatch) {
      const eventId = decodeURIComponent(checklistItemMatch[1]);
      const itemId = decodeURIComponent(checklistItemMatch[2]);
      const list = state.checklists[eventId] || [];
      const item = list.find(entry => String(entry.id) === itemId);
      if (!item) return send({ error: 'Not found' }, 404);
      if (method === 'PUT') Object.assign(item, body || {});
      if (method === 'DELETE') state.checklists[eventId] = list.filter(entry => String(entry.id) !== itemId);
      return send(method === 'DELETE' ? { ok: true } : { item, event: state.events.find(event => String(event.id) === eventId) || null });
    }

    if (resourcePath === '/chat-rooms' && method === 'GET') return send(state.rooms);
    if (resourcePath === '/chat-rooms' && method === 'POST') {
      const roomId = `room-${++state.sequence}`;
      const room = {
        id: roomId,
        name: body?.name || '새 채팅방',
        creator_id: 'e2e-test-user',
        member_count: 1 + (body?.memberIds?.length || 0),
        created_at: new Date().toISOString(),
      };
      state.rooms.push(room);
      state.messages[roomId] = [];
      state.roomMembers[roomId] = [
        { uid: 'e2e-test-user', name: '김대호', email: 'e2e@test.local', is_creator: true },
        ...(body?.memberIds || []).filter((uid: string) => uid === 'other-user').map(() => ({
          uid: 'other-user', name: '박우진', email: 'other@test.local', is_creator: false,
        })),
      ];
      return send(room);
    }
    if (resourcePath === '/chat-rooms/unread' && method === 'GET') return send({});
    const roomRootMatch = resourcePath.match(/^\/chat-rooms\/([^/]+)$/);
    if (roomRootMatch && method === 'PUT') {
      const roomId = decodeURIComponent(roomRootMatch[1]);
      const room = state.rooms.find(item => String(item.id) === roomId);
      if (!room) return send({ error: 'Not found' }, 404);
      Object.assign(room, body || {});
      return send(room);
    }
    const roomMembersMatch = resourcePath.match(/^\/chat-rooms\/([^/]+)\/members$/);
    if (roomMembersMatch && method === 'GET') {
      return send(state.roomMembers[decodeURIComponent(roomMembersMatch[1])] || []);
    }
    if (roomMembersMatch && method === 'POST') {
      const roomId = decodeURIComponent(roomMembersMatch[1]);
      const list = state.roomMembers[roomId] || (state.roomMembers[roomId] = []);
      if (body?.userId === 'other-user' && !list.some(member => member.uid === 'other-user')) {
        list.push({ uid: 'other-user', name: '박우진', email: 'other@test.local', is_creator: false });
        const room = state.rooms.find(item => String(item.id) === roomId);
        if (room) room.member_count = list.length;
      }
      return send({ ok: true });
    }
    const messageMatch = resourcePath.match(/^\/chat-rooms\/([^/]+)\/messages$/);
    if (messageMatch && method === 'GET') return send(state.messages[decodeURIComponent(messageMatch[1])] || []);
    if (messageMatch && method === 'POST') {
      const roomId = decodeURIComponent(messageMatch[1]);
      const message = {
        id: uuidFromSequence(++state.sequence), room_id: roomId, uid: 'e2e-test-user', name: '김대호',
        text: body?.text || '', created_at: new Date().toISOString(),
      };
      (state.messages[roomId] || (state.messages[roomId] = [])).push(message);
      return send(message);
    }
    const chatUploadMatch = resourcePath.match(/^\/chat-rooms\/([^/]+)\/(upload|upload-file)$/);
    if (chatUploadMatch && method === 'POST') {
      const roomId = decodeURIComponent(chatUploadMatch[1]);
      const image = chatUploadMatch[2] === 'upload';
      const message = {
        id: uuidFromSequence(++state.sequence), room_id: roomId, uid: 'e2e-test-user', name: '김대호',
        text: '', created_at: new Date().toISOString(),
        ...(image ? { image_url: '/uploads/e2e.png' } : { file_url: '/uploads/e2e.txt', file_name: 'e2e.txt' }),
      };
      (state.messages[roomId] || (state.messages[roomId] = [])).push(message);
      return send(message);
    }
    if (/^\/chat-rooms\/[^/]+\/read$/.test(resourcePath) && method === 'POST') {
      if (state.failReadAckCount > 0) {
        state.failReadAckCount -= 1;
        return send({ error: '읽음 처리 일시 오류' }, 500);
      }
      return send({ ok: true });
    }

    if (resourcePath === '/projects' && method === 'GET') return send({ canManageAll: true, projects: requestProjects });
    if (resourcePath === '/projects/my-tasks' && method === 'GET') {
      const tasks = requestProjects.flatMap(project => (project.tasks || [])
        .filter((task: any) => {
          const assignees = Array.isArray(task.assignees) ? task.assignees : [];
          return String(task.assignee_uid || task.assigneeUid || '') === String(state.user.uid)
            || assignees.some((assignee: any) => String(assignee.uid || '') === String(state.user.uid));
        })
        .map((task: any) => ({
          project: {
            id: project.id, name: project.name, status: project.status,
            owner_name: project.owner_name || project.ownerName || '',
          },
          task,
        })));
      return send({ readOnly: false, tasks });
    }
    if (resourcePath === '/projects' && method === 'POST') {
      const projectId = `project-${++state.sequence}`;
      const project = {
        id: projectId,
        name: body?.name || '새 프로젝트',
        description: body?.description || '',
        status: body?.status || 'active',
        deadline: body?.deadline || '',
        owner_id: 'e2e-test-user', owner_name: '김대호', canManage: true,
        canCreateTasks: true, canDirectTasks: true,
        member_count: 1, member_names: '김대호', task_count: 0, done_task_count: 0,
        members: [{ uid: 'e2e-test-user', name: '김대호', email: 'e2e@test.local', role: 'manager' }],
        tasks: [], updates: [], comments: [], taskComments: [], events: [],
      };
      state.projects.push(project);
      return send(project);
    }
    const projectMatch = resourcePath.match(/^\/projects\/([^/]+)$/);
    if (projectMatch && method === 'GET') {
      const project = state.projects.find(item => String(item.id) === decodeURIComponent(projectMatch[1]));
      return project ? send(project) : send({ error: 'Not found' }, 404);
    }
    if (projectMatch && method === 'PUT') {
      const project = state.projects.find(item => String(item.id) === decodeURIComponent(projectMatch[1]));
      if (!project) return send({ error: 'Not found' }, 404);
      Object.assign(project, body || {});
      return send(project);
    }
    const projectTaskMatch = resourcePath.match(/^\/projects\/([^/]+)\/tasks(?:\/([^/]+))?$/);
    if (projectTaskMatch && method === 'POST' && !projectTaskMatch[2]) {
      const project = state.projects.find(item => String(item.id) === decodeURIComponent(projectTaskMatch[1]));
      if (!project) return send({ error: 'Not found' }, 404);
      const assignee = body?.assigneeUid === 'other-user'
        ? { uid: 'other-user', name: '박우진', completed: false }
        : { uid: 'e2e-test-user', name: '김대호', completed: false };
      const task = {
        id: `task-${++state.sequence}`, project_id: project.id,
        title: body?.title || '', description: body?.description || '', status: body?.status || 'todo',
        due_date: body?.dueDate || '', assignment_mode: body?.assigneeMode || 'single',
        assignee_uid: assignee.uid, assignee_name: assignee.name, assignees: [assignee],
        role_label: body?.roleLabel || '', reviewer_uid: body?.reviewerUid || 'e2e-test-user', reviewer_name: '김대호',
        assigned_by_uid: 'e2e-test-user', assigned_by_name: '김대호', workflow_version: 1,
        permissions: { canEdit: true, canSetDeadline: true, canRequestReview: true, canReview: true, canDelete: true },
      };
      project.tasks.push(task);
      project.task_count = project.tasks.length;
      return send(task);
    }
    if (projectTaskMatch && method === 'PUT' && projectTaskMatch[2]) {
      const project = state.projects.find(item => String(item.id) === decodeURIComponent(projectTaskMatch[1]));
      const task = project?.tasks.find((item: any) => String(item.id) === decodeURIComponent(projectTaskMatch[2]));
      if (!task) return send({ error: 'Not found' }, 404);
      Object.assign(task, {
        ...(body?.title === undefined ? {} : { title: body.title }),
        ...(body?.description === undefined ? {} : { description: body.description }),
        ...(body?.status === undefined ? {} : { status: body.status }),
        ...(body?.dueDate === undefined ? {} : { due_date: body.dueDate }),
        ...(body?.roleLabel === undefined ? {} : { role_label: body.roleLabel }),
        ...(body?.reviewerUid === undefined ? {} : { reviewer_uid: body.reviewerUid, reviewer_name: '김대호' }),
      });
      task.workflow_version = Number(task.workflow_version || 0) + 1;
      project.done_task_count = project.tasks.filter((item: any) => item.status === 'done').length;
      return send(task);
    }
    const projectTaskReviewMatch = resourcePath.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/review$/);
    if (projectTaskReviewMatch && method === 'POST') {
      const project = state.projects.find(item => String(item.id) === decodeURIComponent(projectTaskReviewMatch[1]));
      const task = project?.tasks.find((item: any) => String(item.id) === decodeURIComponent(projectTaskReviewMatch[2]));
      if (!project || !task) return send({ error: 'Not found' }, 404);
      if (body?.action === 'request') {
        task.status = 'review';
        task.review_requested_at = new Date().toISOString();
      } else if (body?.action === 'approve') {
        task.status = 'done';
        task.reviewed_at = new Date().toISOString();
      } else {
        task.status = 'doing';
        task.review_note = body?.note || '';
        if (body?.dueDate) task.due_date = body.dueDate;
      }
      task.workflow_version = Number(task.workflow_version || 0) + 1;
      project.done_task_count = project.tasks.filter((item: any) => item.status === 'done').length;
      return send(task);
    }
    const projectCommentMatch = resourcePath.match(/^\/projects\/([^/]+)\/comments$/);
    if (projectCommentMatch && method === 'POST') {
      const project = state.projects.find(item => String(item.id) === decodeURIComponent(projectCommentMatch[1]));
      if (!project) return send({ error: 'Not found' }, 404);
      const comment = {
        id: `comment-${++state.sequence}`, project_id: project.id, content: body?.content || '',
        attachments: body?.attachments || [], author_uid: 'e2e-test-user', author_name: '김대호',
        created_at: new Date().toISOString(), deleted: false,
      };
      project.comments.push(comment);
      return send(comment);
    }
    const taskCommentMatch = resourcePath.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/comments$/);
    if (taskCommentMatch && method === 'POST') {
      const project = state.projects.find(item => String(item.id) === decodeURIComponent(taskCommentMatch[1]));
      if (!project) return send({ error: 'Not found' }, 404);
      const comment = {
        id: `task-comment-${++state.sequence}`, project_id: project.id,
        task_id: decodeURIComponent(taskCommentMatch[2]), content: body?.content || '',
        author_uid: 'e2e-test-user', author_name: '김대호', created_at: new Date().toISOString(), deleted: false,
      };
      project.taskComments.push(comment);
      return send(comment);
    }

    // Existing PEAK OS finance/settlement calls are unrelated to collaboration.
    if (!protectedRequest && handlePeakos(peakos, route)) return;
    if (originalPath === '/service-requests') return send({ canManage: false, requests: [] });
    if (originalPath === '/ideas') return send([]);
    return send([]);
  });
}

async function setup(page: Page, state: CollaborationState, url = '/os/') {
  await installFirebaseStub(page);
  await serveOsShell(page);
  await installSharedApi(page, state);
  await page.goto(url);
  await expect(page.locator('#authGate')).toBeHidden();
  const main = page.locator('[data-nav-cluster="main"]');
  if ((await main.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    const toggle = main.locator(':scope > .nav-cluster-toggle');
    const inViewport = await toggle.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    });
    if (!inViewport) await page.locator('.mobile-menu').click();
    await toggle.click();
  }
}

async function addTodo(page: Page, title: string) {
  await page.locator('.nav-item[data-view="todo"]').click();
  await page.locator('#todoView [data-collab-add-todo]').click();
  const form = page.locator('#collaborationEventForm');
  await expect(form).toBeVisible();
  await form.locator('[name="title"]').fill(title);
  await form.getByRole('button', { name: '등록', exact: true }).click();
  await expect(page.locator('#todoView')).toContainText(title);
}

test.describe('PEAK OS collaboration security and shared-data contract', () => {
  test('writes use only the protected alias and account preview issues zero mutations', async ({ page }) => {
    const date = todayKey();
    const state = createState({
      events: [{
        id: 'owned-todo', type: 'todo', title: '미리보기 차단 확인', date,
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false,
      }],
      projects: [{
        id: 'preview-project', name: '미리보기 비공개 프로젝트', status: 'active', owner_name: '김대호',
        tasks: [{
          id: 'preview-project-task', project_id: 'preview-project', title: '미리보기 비공개 프로젝트 업무',
          status: 'todo', assignment_mode: 'single', assignee_uid: 'e2e-test-user', assignee_name: '김대호',
          assignees: [{ uid: 'e2e-test-user', name: '김대호', completed: false }],
          permissions: { canRequestReview: true },
        }],
      }],
    });
    await setup(page, state);

    await addTodo(page, '보호 경로 등록');
    const collaborationMutations = state.calls.filter(call =>
      call.method !== 'GET' && call.path.startsWith('/peakos/collaboration/')
    );
    expect(collaborationMutations).toHaveLength(1);
    expect(collaborationMutations[0]).toMatchObject({
      method: 'POST', path: '/peakos/collaboration/events', preview: '0',
    });
    const directLegacyWrites = state.calls.filter(call =>
      call.method !== 'GET' && /^\/(events|chat-rooms|projects)(?:\/|$)/.test(call.path)
    );
    expect(directLegacyWrites).toEqual([]);

    await expect(page.locator('[data-personal-todo-id="owned-todo"]')).toBeVisible();
    await expect(page.locator('[data-project-todo-id="preview-project-task"]')).toBeVisible();
    let releasePreviewLoad!: () => void;
    let previewLoadStarted = 0;
    let previewLoadSettled = 0;
    const previewLoadGate = new Promise<void>(resolve => { releasePreviewLoad = resolve; });
    await page.route(/\/api\/peakos\/intake\?owner=/, async route => {
      previewLoadStarted += 1;
      await previewLoadGate;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: '미리보기 지연 조회 테스트' }),
      });
      previewLoadSettled += 1;
    });

    const beforePreview = collaborationMutations.length;
    await page.locator('#personaSelect').selectOption('박우진');
    await expect.poll(() => previewLoadStarted).toBeGreaterThan(0);
    // loadPeakosData가 아직 멈춰 있는 같은 전환 단계에서도 로그인 사용자의
    // 업무 DOM은 즉시 제거되어야 한다.
    await expect(page.locator('#todoView [data-collab-readonly]')).toBeVisible();
    await expect(page.locator('#todoView [data-collab-add-todo]')).toHaveCount(0);
    await expect(page.locator('#todoView [data-personal-todo-id]')).toHaveCount(0);
    await expect(page.locator('#todoView [data-project-todo-id]')).toHaveCount(0);
    await expect(page.getByText('계정 미리보기에서는 업무 데이터가 비공개입니다')).toHaveCount(2);
    expect(state.calls.filter(call => call.method !== 'GET' && call.path.startsWith('/peakos/collaboration/'))).toHaveLength(beforePreview);
    releasePreviewLoad();
    await expect.poll(() => previewLoadSettled).toBeGreaterThan(0);
    await page.unroute(/\/api\/peakos\/intake\?owner=/);
  });

  test('today todo follows priority, capture, and timeline steps through one protected event record', async ({ page }) => {
    const date = todayKey();
    const tomorrow = new Date(`${date}T12:00:00+09:00`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tomorrowKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(tomorrow);
    const state = createState({
      events: [
        { id: 'first', type: 'todo', title: '먼저 생각한 일', date, time: '', todo_cat: '기획', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 10, done: false, deleted: false },
        { id: 'second', type: 'todo', title: '시간 있는 일', date, time: '11:00', todo_cat: '영업', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 20, done: false, deleted: false },
        { id: 'tomorrow', type: 'todo', title: '내일 할 일', date: tomorrowKey, time: '', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 30, done: false, deleted: false },
      ],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();

    const steps = page.locator('#todoView [data-daily-plan-step]');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toHaveAttribute('data-daily-plan-step', 'priority');
    await expect(steps.nth(1)).toHaveAttribute('data-daily-plan-step', 'capture');
    await expect(steps.nth(2)).toHaveAttribute('data-daily-plan-step', 'timeline');
    await expect(page.locator('#todoView')).toContainText('우선순위 정하기');
    await expect(page.locator('#todoView')).toContainText('생각한 일 전부 쓰기');
    await expect(page.locator('#todoView')).toContainText('타임라인 잡기');
    await expect(page.locator('#todoView')).not.toContainText('내일 할 일');
    const plannerToggle = page.locator('[data-personal-plan-toggle]');
    await expect(plannerToggle).toHaveAttribute('aria-expanded', 'false');
    await plannerToggle.click();
    await expect(plannerToggle).toHaveAttribute('aria-expanded', 'true');

    await page.locator('[data-todo-priority-move="first"][data-direction="down"]').click();
    const priorityRows = page.locator('[data-daily-priority-id]');
    await expect(priorityRows.nth(0)).toHaveAttribute('data-daily-priority-id', 'second');
    await expect(priorityRows.nth(1)).toHaveAttribute('data-daily-priority-id', 'first');
    const reorderCall = state.calls.find(call => call.method === 'POST' && call.path === '/peakos/collaboration/events/reorder');
    expect(reorderCall).toMatchObject({
      workspace: 'peak',
      body: { items: [{ id: 'second', sortOrder: 10 }, { id: 'first', sortOrder: 20 }] },
    });

    const capture = page.locator('[data-todo-capture]');
    await capture.locator('[name="title"]').fill('방금 생각난 일');
    await capture.getByRole('button', { name: '＋ 적기' }).click();
    await expect(page.locator('#todoView')).toContainText('방금 생각난 일');
    const captured = state.events.find(event => event.title === '방금 생각난 일');
    expect(captured).toMatchObject({ type: 'todo', date, time: '', scope: 'personal' });
    const captureOrderCall = state.calls.filter(call =>
      call.method === 'POST' && call.path === '/peakos/collaboration/events/reorder'
    ).at(-1);
    expect(captureOrderCall?.body?.items.at(-1)).toMatchObject({ id: captured.id });
    await expect(page.locator('[data-daily-priority-id]').last()).toHaveAttribute('data-daily-priority-id', captured.id);

    const timeInput = page.locator('[data-daily-timeline-id="first"] [data-todo-time="first"]');
    await timeInput.fill('09:30');
    await timeInput.press('Tab');
    await expect(page.locator('[data-daily-timeline-id="first"] [data-todo-time="first"]')).toHaveValue('09:30');
    const timeCall = state.calls.find(call => call.method === 'PUT' && call.path === '/peakos/collaboration/events/first' && call.body?.time === '09:30');
    expect(timeCall).toMatchObject({ workspace: 'peak', body: { time: '09:30' } });
    expect(state.calls.some(call => call.path.startsWith('/timetable'))).toBe(false);
    expect(state.calls.some(call => call.method !== 'GET' && /^\/events(?:\/|$)/.test(call.path))).toBe(false);
  });

  test('one desktop view separates personal and project checklists with distinct completion workflows', async ({ page }) => {
    const date = todayKey();
    const state = createState({
      events: [{
        id: 'personal-split-task', type: 'todo', title: '개인 체크리스트 업무', date, time: '10:00',
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 10,
        done: false, deleted: false,
      }],
      projects: [{
        id: 'split-project', name: '신규 캠페인 프로젝트', status: 'active', owner_name: '김대호',
        tasks: [{
          id: 'project-split-task', project_id: 'split-project', title: '프로젝트 원고 작성',
          status: 'doing', due_date: date, assignment_mode: 'single',
          assignee_uid: 'e2e-test-user', assignee_name: '김대호',
          assignees: [{ uid: 'e2e-test-user', name: '김대호', completed: false }],
          role_label: '콘텐츠 작성', reviewer_uid: 'manager-user', reviewer_name: '팀장',
          permissions: { canRequestReview: true, canReview: false, canComplete: false },
        }],
      }],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();

    const split = page.locator('[data-todo-split-view]');
    const personal = split.locator('[data-todo-panel="personal"]');
    const project = split.locator('[data-todo-panel="project"]');
    await expect(split).toBeVisible();
    await expect(personal.getByText('나의 할 일', { exact: true })).toBeVisible();
    await expect(project.getByText('프로젝트 할 일', { exact: true })).toBeVisible();
    await expect(personal.locator('[data-personal-todo-id="personal-split-task"]')).toContainText('개인 체크리스트 업무');
    await expect(project.locator('[data-project-todo-id="project-split-task"]')).toContainText('프로젝트 원고 작성');
    await expect(project.locator('[data-project-todo-id="project-split-task"]')).toContainText('신규 캠페인 프로젝트');

    const [personalBox, projectBox] = await Promise.all([personal.boundingBox(), project.boundingBox()]);
    expect(personalBox).not.toBeNull();
    expect(projectBox).not.toBeNull();
    expect(Math.abs((personalBox?.y || 0) - (projectBox?.y || 0))).toBeLessThan(4);
    expect(projectBox?.x || 0).toBeGreaterThan((personalBox?.x || 0) + (personalBox?.width || 0) - 2);

    await personal.locator('[data-personal-todo-id="personal-split-task"] [data-collab-event-toggle]').click();
    await expect(personal.locator('[data-personal-todo-id="personal-split-task"]')).toHaveClass(/done/);
    expect(state.calls.find(call => call.method === 'PUT'
      && call.path === '/peakos/collaboration/events/personal-split-task')).toMatchObject({
      workspace: 'peak', body: { done: true },
    });

    await project.locator('[data-project-todo-id="project-split-task"] [data-collab-task-review-request]').click();
    await expect(project.locator('[data-project-todo-id="project-split-task"]')).toHaveClass(/review/);
    const reviewCall = state.calls.find(call => call.method === 'POST'
      && call.path === '/peakos/collaboration/projects/split-project/tasks/project-split-task/review');
    expect(reviewCall).toMatchObject({ workspace: 'peak', body: { action: 'request' } });
    expect(state.calls.filter(call => call.method === 'PUT'
      && call.path === '/peakos/collaboration/events/personal-split-task')).toHaveLength(1);
  });

  test('the two todo panels stack on mobile without horizontal overflow and keep the planner folded', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const date = todayKey();
    const state = createState({
      events: [{
        id: 'mobile-personal-task', type: 'todo', title: '모바일 개인 업무', date,
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false,
      }],
      projects: [{
        id: 'mobile-project', name: '모바일 프로젝트', status: 'active', owner_name: '김대호',
        tasks: [{
          id: 'mobile-project-task', project_id: 'mobile-project', title: '모바일 프로젝트 업무', status: 'todo',
          assignment_mode: 'single', assignee_uid: 'e2e-test-user', assignee_name: '김대호',
          assignees: [{ uid: 'e2e-test-user', name: '김대호', completed: false }],
          permissions: { canRequestReview: true },
        }],
      }],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();

    const personal = page.locator('[data-todo-panel="personal"]');
    const project = page.locator('[data-todo-panel="project"]');
    const [personalBox, projectBox] = await Promise.all([personal.boundingBox(), project.boundingBox()]);
    expect(projectBox?.y || 0).toBeGreaterThan((personalBox?.y || 0) + (personalBox?.height || 0) - 2);
    expect(Math.abs((personalBox?.x || 0) - (projectBox?.x || 0))).toBeLessThan(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const plannerToggle = page.locator('[data-personal-plan-toggle]');
    await expect(plannerToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#personalTodoPlanner')).toBeHidden();
    await plannerToggle.click();
    await expect(plannerToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#personalTodoPlanner')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('a branch todo split reads only that workspace personal and project records', async ({ page }) => {
    const date = todayKey();
    const state = createState({
      events: [{
        id: 'peak-private-task', type: 'todo', title: '본사 전용 개인 업무', date,
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false,
      }],
      projects: [{
        id: 'peak-private-project', name: '본사 전용 프로젝트', status: 'active',
        tasks: [{
          id: 'peak-private-project-task', project_id: 'peak-private-project', title: '본사 전용 프로젝트 업무',
          status: 'todo', assignee_uid: 'e2e-test-user', assignees: [{ uid: 'e2e-test-user', name: '김대호' }],
        }],
      }],
      workspaceData: {
        daegu: {
          events: [{
            id: 'daegu-personal-task', type: 'todo', title: '대구지사 개인 업무', date,
            scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false,
          }],
          projects: [{
            id: 'daegu-project', name: '대구지사 프로젝트', status: 'active', owner_name: '대구 책임자',
            tasks: [{
              id: 'daegu-project-task', project_id: 'daegu-project', title: '대구지사 프로젝트 업무',
              status: 'todo', assignment_mode: 'single', assignee_uid: 'e2e-test-user', assignee_name: '김대호',
              assignees: [{ uid: 'e2e-test-user', name: '김대호', completed: false }],
              permissions: { canRequestReview: true },
            }],
          }],
        },
      },
    });
    await setup(page, state, '/os/w/daegu');
    await page.locator('.nav-item[data-view="todo"]').click();

    await expect(page.locator('[data-personal-todo-id="daegu-personal-task"]')).toContainText('대구지사 개인 업무');
    await expect(page.locator('[data-project-todo-id="daegu-project-task"]')).toContainText('대구지사 프로젝트 업무');
    await expect(page.locator('#todoView')).not.toContainText('본사 전용 개인 업무');
    await expect(page.locator('#todoView')).not.toContainText('본사 전용 프로젝트 업무');
    const splitReads = state.calls.filter(call => call.method === 'GET'
      && (call.path === '/peakos/collaboration/events'
        || call.path === '/peakos/collaboration/projects/my-tasks'));
    expect(splitReads.length).toBeGreaterThanOrEqual(2);
    expect(splitReads.every(call => call.workspace === 'daegu')).toBe(true);
  });

  test('Korea New Year loads and renders the new Korean calendar year', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-12-31T15:05:00.000Z') });
    const state = createState({
      events: [{
        id: 'new-year', type: 'todo', title: '새해 첫 할 일', date: '2027-01-01', time: '',
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 10,
        done: false, deleted: false,
      }],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();

    await expect(page.locator('[data-daily-plan-date]')).toHaveAttribute('data-daily-plan-date', '2027-01-01');
    await expect(page.locator('#todoView')).toContainText('새해 첫 할 일');
    expect(state.calls.some(call =>
      call.method === 'GET'
      && call.path === '/peakos/collaboration/events'
      && call.search.includes('from=2027-01-01')
      && call.search.includes('to=2027-12-31')
    )).toBe(true);
  });

  test('a draft opened before Korean midnight is saved to the new Korean day', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-12-31T14:59:30.000Z') });
    const state = createState();
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();
    const capture = page.locator('[data-todo-capture]');
    await capture.locator('[name="title"]').fill('자정 이후 오늘 할 일');

    await page.clock.setFixedTime(new Date('2026-12-31T15:00:30.000Z'));
    await capture.getByRole('button', { name: '＋ 적기' }).click();

    await expect(page.locator('[data-daily-plan-date]')).toHaveAttribute('data-daily-plan-date', '2027-01-01');
    expect(state.events.find(event => event.title === '자정 이후 오늘 할 일')).toMatchObject({
      date: '2027-01-01', scope: 'personal', type: 'todo',
    });
  });

  test('the five-second sync preserves a todo draft and focused button until focus leaves the view', async ({ page }) => {
    const state = createState();
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();
    const draft = page.locator('[data-todo-capture] [name="title"]');
    await draft.fill('자동 동기화에도 남아야 하는 생각');
    const readsBefore = state.calls.filter(call =>
      call.method === 'GET' && call.path === '/peakos/collaboration/events'
    ).length;
    const projectReadsBefore = state.calls.filter(call =>
      call.method === 'GET' && call.path === '/peakos/collaboration/projects/my-tasks'
    ).length;

    await page.waitForTimeout(5_400);
    await expect(draft).toHaveValue('자동 동기화에도 남아야 하는 생각');
    expect(state.calls.filter(call =>
      call.method === 'GET' && call.path === '/peakos/collaboration/events'
    )).toHaveLength(readsBefore);
    expect(state.calls.filter(call =>
      call.method === 'GET' && call.path === '/peakos/collaboration/projects/my-tasks'
    )).toHaveLength(projectReadsBefore);

    await draft.press('Tab');
    const captureButton = page.locator('[data-todo-capture] button[type="submit"]');
    await expect(captureButton).toBeFocused();
    await page.waitForTimeout(5_400);
    await expect(draft).toHaveValue('자동 동기화에도 남아야 하는 생각');
    await expect(captureButton).toBeFocused();
    expect(state.calls.filter(call =>
      call.method === 'GET' && call.path === '/peakos/collaboration/events'
    )).toHaveLength(readsBefore);
    expect(state.calls.filter(call =>
      call.method === 'GET' && call.path === '/peakos/collaboration/projects/my-tasks'
    )).toHaveLength(projectReadsBefore);

    await page.locator('#personaSelect').focus();
    await expect(page.locator('#personaSelect')).toBeFocused();
    await page.waitForTimeout(5_400);
    await expect(draft).toHaveValue('자동 동기화에도 남아야 하는 생각');
    expect(state.calls.filter(call =>
      call.method === 'GET' && call.path === '/peakos/collaboration/events'
    ).length).toBeGreaterThan(readsBefore);
    expect(state.calls.filter(call =>
      call.method === 'GET' && call.path === '/peakos/collaboration/projects/my-tasks'
    ).length).toBeGreaterThan(projectReadsBefore);
  });

  test('protected OS writes and legacy writes round-trip through one shared state', async ({ page }) => {
    const state = createState();
    await setup(page, state);
    await addTodo(page, 'OS에서 등록한 할 일');

    const legacyRows = await page.evaluate(async () => {
      const response = await fetch('/api/events', { headers: { Authorization: 'Bearer e2e-token' } });
      return response.json();
    });
    expect(legacyRows.map((row: any) => row.title)).toContain('OS에서 등록한 할 일');

    await page.evaluate(async date => {
      await fetch('/api/events', {
        method: 'POST',
        headers: { Authorization: 'Bearer e2e-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'todo', title: '기존 파라곤에서 등록', date, scope: 'personal' }),
      });
    }, todayKey());

    // The OS five-second collaboration poll must pull legacy changes without a reload.
    await expect(page.locator('#todoView')).toContainText('기존 파라곤에서 등록', { timeout: 7_500 });
  });

  test('team event shares selected employees through the protected event payload', async ({ page }) => {
    const state = createState();
    await setup(page, state);

    await page.locator('#homeCalendarAgenda [data-collab-add-event]').click();
    const form = page.locator('#collaborationEventForm');
    await expect(form).toBeVisible();
    await form.locator('[name="scope"]').selectOption('team');
    const shareField = form.locator('[data-collab-event-shares]');
    await expect(shareField).toBeVisible();
    await shareField.locator('[name="shareWith"][value="other-user"]').check();
    await form.locator('[name="title"]').fill('팀 공유 일정 검증');
    await form.getByRole('button', { name: '등록', exact: true }).click();

    await expect(page.locator('#calendarView')).toContainText('팀 공유 일정 검증');
    const createCall = state.calls.find(call =>
      call.method === 'POST' && call.path === '/peakos/collaboration/events'
    );
    expect(createCall?.body).toMatchObject({
      title: '팀 공유 일정 검증',
      scope: 'team',
      shareWith: ['other-user'],
    });
    expect(state.calls.some(call => call.method === 'POST' && call.path === '/events')).toBe(false);
  });

  test('a directory outage keeps personal event editing usable and preserves a team draft for retry', async ({ page }) => {
    const state = createState();
    await setup(page, state);

    await page.locator('#homeCalendarAgenda [data-collab-add-event]').click();
    let form = page.locator('#collaborationEventForm');
    await expect(form).toBeVisible();
    expect(state.calls.filter(call => call.path === '/peakos/collaboration/users/all-approved')).toHaveLength(0);
    await form.locator('[name="title"]').fill('직원 목록 없이 저장하는 개인 일정');
    await form.getByRole('button', { name: '등록', exact: true }).click();
    expect(state.events.some(event => event.title === '직원 목록 없이 저장하는 개인 일정')).toBe(true);
    expect(state.calls.filter(call => call.path === '/peakos/collaboration/users/all-approved')).toHaveLength(0);

    state.failDirectoryCount = 2;
    await page.locator('#homeCalendarAgenda [data-collab-add-event]').click();
    form = page.locator('#collaborationEventForm');
    await form.locator('[name="title"]').fill('실패 후에도 남는 팀 일정');
    await form.locator('[name="scope"]').selectOption('team');
    await expect(form.locator('[data-collab-event-shares] .collaboration-error')).toContainText('직원 목록 일시 오류');
    await form.getByRole('button', { name: '등록', exact: true }).click();
    await expect(form).toBeVisible();
    await expect(form.locator('[name="title"]')).toHaveValue('실패 후에도 남는 팀 일정');
    expect(state.events.some(event => event.title === '실패 후에도 남는 팀 일정')).toBe(false);

    await form.locator('[name="scope"]').selectOption('personal');
    await form.locator('[name="scope"]').selectOption('team');
    const colleague = form.locator('[name="shareWith"][value="other-user"]');
    await expect(colleague).toBeVisible();
    await colleague.check();
    await form.getByRole('button', { name: '등록', exact: true }).click();
    await expect.poll(() => state.events.find(event => event.title === '실패 후에도 남는 팀 일정')).toMatchObject({
      scope: 'team', shareWith: ['other-user'],
    });
  });

  test('a server conflict keeps the draft open and an expired second factor locks the OS', async ({ page }) => {
    const state = createState();
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();
    await page.locator('#todoView [data-collab-add-todo]').click();
    const form = page.locator('#collaborationEventForm');
    await form.locator('[name="title"]').fill('실패해도 남는 입력');
    state.failNextMutation = true;
    await form.getByRole('button', { name: '등록', exact: true }).click();
    await expect(form).toBeVisible();
    await expect(form.locator('[name="title"]')).toHaveValue('실패해도 남는 입력');
    await expect(page.locator('.toast')).toContainText('동시 수정 충돌 테스트');
    expect(state.events.some(event => event.title === '실패해도 남는 입력')).toBe(false);

    state.otpVerified = false;
    await form.getByRole('button', { name: '등록', exact: true }).click();
    await expect(page).toHaveURL(/\/os\/login/);
    await expect(page.locator('#authGate')).toBeVisible();
    expect(state.events.some(event => event.title === '실패해도 남는 입력')).toBe(false);

    const readsAtLock = state.calls.filter(call =>
      call.method === 'GET' && call.path.startsWith('/peakos/collaboration/')
    ).length;
    await page.waitForTimeout(5_400);
    expect(state.calls.filter(call =>
      call.method === 'GET' && call.path.startsWith('/peakos/collaboration/')
    )).toHaveLength(readsAtLock);
  });

  test('leaving an open chat room stops its three-second message poll', async ({ page }) => {
    const state = createState({
      rooms: [{ id: 'room-1', name: '폴링 검증방', creator_id: 'e2e-test-user', member_count: 2 }],
      messages: { 'room-1': [{ id: uuidFromSequence(1), room_id: 'room-1', uid: 'other-user', name: '박우진', text: '첫 메시지', created_at: new Date().toISOString() }] },
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="chat"]').click();
    await page.locator('[data-room-id="room-1"]').click();
    await expect(page.locator('#chatThreadMessages')).toContainText('첫 메시지');
    await page.waitForTimeout(3_400);
    const beforeLeave = state.calls.filter(call => call.method === 'GET' && call.path === '/peakos/collaboration/chat-rooms/room-1/messages').length;
    expect(beforeLeave).toBeGreaterThanOrEqual(2);
    const readAcksBeforeLeave = state.calls.filter(call =>
      call.method === 'POST' && call.path === '/peakos/collaboration/chat-rooms/room-1/read'
    ).length;
    expect(readAcksBeforeLeave).toBe(1);

    await page.locator('.nav-item[data-view="todo"]').click();
    await page.waitForTimeout(3_400);
    const afterLeave = state.calls.filter(call => call.method === 'GET' && call.path === '/peakos/collaboration/chat-rooms/room-1/messages').length;
    expect(afterLeave).toBe(beforeLeave);
    expect(state.calls.filter(call =>
      call.method === 'POST' && call.path === '/peakos/collaboration/chat-rooms/room-1/read'
    )).toHaveLength(readAcksBeforeLeave);
  });

  test('unknown bracket chat text stays verbatim while known protocol text uses its system label', async ({ page }) => {
    const state = createState({
      rooms: [{ id: 'room-bracket', name: '메시지 렌더링방', creator_id: 'e2e-test-user', member_count: 2 }],
      messages: {
        'room-bracket': [
          { id: uuidFromSequence(10), room_id: 'room-bracket', uid: 'other-user', name: '박우진', text: '[EVENT_SHARE]{"id":"event-1"}', created_at: new Date().toISOString() },
          { id: uuidFromSequence(11), room_id: 'room-bracket', uid: 'other-user', name: '박우진', text: '[공지] 회의실 변경', created_at: new Date().toISOString() },
        ],
      },
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="chat"]').click();
    await page.locator('[data-room-id="room-bracket"]').click();

    await expect(page.locator('.chat-message-system')).toContainText('일정을 공유했습니다.');
    await expect(page.locator('.chat-message-bubble')).toContainText('[공지] 회의실 변경');
    await expect(page.locator('#chatThreadMessages')).not.toContainText('공유 메시지');
  });

  test('a failed read acknowledgement keeps messages visible and retries once before deduping', async ({ page }) => {
    const state = createState({
      failReadAckCount: 1,
      rooms: [{ id: 'room-ack', name: '읽음 처리 검증방', creator_id: 'e2e-test-user', member_count: 2 }],
      messages: {
        'room-ack': [{ id: uuidFromSequence(20), room_id: 'room-ack', uid: 'other-user', name: '박우진', text: 'ACK 실패에도 남을 메시지', created_at: new Date().toISOString() }],
      },
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="chat"]').click();
    await page.locator('[data-room-id="room-ack"]').click();

    await expect(page.locator('.chat-message-bubble')).toContainText('ACK 실패에도 남을 메시지');
    await expect(page.locator('#chatThreadMessages')).not.toContainText('메시지 조회 실패');
    const ackCalls = () => state.calls.filter(call =>
      call.method === 'POST' && call.path === '/peakos/collaboration/chat-rooms/room-ack/read'
    ).length;
    await expect.poll(ackCalls).toBe(1);
    await expect.poll(ackCalls, { timeout: 4_500 }).toBe(2);
    await page.waitForTimeout(3_400);
    expect(ackCalls()).toBe(2);
    await expect(page.locator('.chat-message-bubble')).toContainText('ACK 실패에도 남을 메시지');
  });

  test('an ordinary project member registers only their own task through the protected OS route', async ({ page }) => {
    const date = todayKey();
    const state = createState({
      user: {
        uid: 'e2e-test-user', name: '일반 멤버', email: 'member@test.local', role: 'member',
        approved: true, is_active: true, group_id: 'hq-sales', group_name: '본사 영업팀', group_type: 'sales',
      },
      projects: [{
        id: 'member-self-project', name: '일반 멤버 업무 프로젝트', description: '본인 업무만 등록합니다.',
        status: 'active', deadline: date, owner_id: 'owner-user', owner_name: '프로젝트 책임자',
        canManage: false, canCreateTasks: true, canDirectTasks: false,
        member_count: 3, member_names: '프로젝트 책임자, 일반 멤버, 박우진', task_count: 0, done_task_count: 0,
        members: [
          { uid: 'owner-user', name: '프로젝트 책임자', role: 'manager' },
          { uid: 'e2e-test-user', name: '일반 멤버', role: 'member' },
          { uid: 'other-user', name: '박우진', role: 'member' },
        ],
        tasks: [], updates: [], comments: [], taskComments: [], events: [],
      }],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="review"]').click();
    await page.locator('[data-project-id="member-self-project"]').click();

    const createButton = page.locator('[data-collab-task-create]');
    await expect(createButton).toHaveText('＋ 내 업무');
    await createButton.click();
    const form = page.locator('#collaborationProjectTaskForm');
    const assignee = form.locator('[name="assigneeUid"]');
    await expect(assignee.locator('option')).toHaveCount(1);
    await expect(assignee).toHaveValue('e2e-test-user');
    await expect(assignee.locator('option[value="__all__"]')).toHaveCount(0);
    await expect(assignee.locator('option[value="other-user"]')).toHaveCount(0);
    await expect(form.getByLabel('검토자')).toHaveValue('프로젝트 책임자');

    await form.locator('[name="title"]').fill('내 업무 OS 등록');
    await form.locator('[name="roleLabel"]').fill('자료 작성');
    await form.locator('[name="dueDate"]').fill(date);
    await form.getByRole('button', { name: '내 업무 등록', exact: true }).click();
    await expect(page.locator('.project-detail-task')).toContainText('내 업무 OS 등록');

    const call = state.calls.find(entry => entry.method === 'POST'
      && entry.path === '/peakos/collaboration/projects/member-self-project/tasks');
    expect(call?.body).toMatchObject({
      assigneeMode: 'single',
      assigneeUid: 'e2e-test-user',
      status: 'todo',
    });
  });

  test('an oversight project view exposes no OS task creation action', async ({ page }) => {
    const state = createState({
      projects: [{
        id: 'oversight-project', name: '본사 열람 프로젝트', description: '읽기 전용 프로젝트입니다.',
        status: 'active', deadline: todayKey(), owner_id: 'branch-owner', owner_name: '지사 책임자',
        canManage: false, canCreateTasks: false, canDirectTasks: false, readOnly: true,
        member_count: 1, member_names: '지사 책임자', task_count: 0, done_task_count: 0,
        members: [{ uid: 'branch-owner', name: '지사 책임자', role: 'manager' }],
        tasks: [], updates: [], comments: [], taskComments: [], events: [],
      }],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="review"]').click();
    await page.locator('[data-project-id="oversight-project"]').click();

    await expect(page.locator('[data-collab-task-create]')).toHaveCount(0);
    expect(state.calls.filter(call => call.method !== 'GET'
      && call.path.includes('/projects/oversight-project/tasks'))).toEqual([]);
  });

  test('a project manager sees the reviewer handoff before changing an active task assignee', async ({ page }) => {
    const date = todayKey();
    const state = createState({
      user: {
        uid: 'e2e-test-user', name: '팀 관리자', email: 'manager@test.local', role: 'manager',
        approved: true, is_active: true, group_id: 'hq-sales', group_name: '본사 영업팀', group_type: 'sales',
      },
      projects: [{
        id: 'reviewer-handoff-project', name: '검토자 인계 프로젝트', description: '담당자 변경 시 검토자를 확인합니다.',
        status: 'active', deadline: date, owner_id: 'owner-user', owner_name: '프로젝트 책임자',
        canManage: false, canCreateTasks: true, canDirectTasks: true,
        member_count: 4, member_names: '프로젝트 책임자, 팀 관리자, 기존 담당자, 새 담당자', task_count: 2, done_task_count: 0,
        members: [
          { uid: 'owner-user', name: '프로젝트 책임자', role: 'manager' },
          { uid: 'e2e-test-user', name: '팀 관리자', role: 'manager' },
          { uid: 'other-user', name: '기존 담당자', role: 'member' },
          { uid: 'other-two', name: '새 담당자', role: 'member' },
        ],
        tasks: [
          {
            id: 'editable-handoff-task', project_id: 'reviewer-handoff-project', title: '담당자 변경 가능 업무',
            status: 'doing', due_date: date, assignment_mode: 'single', assignee_uid: 'other-user', assignee_name: '기존 담당자',
            assignees: [{ uid: 'other-user', name: '기존 담당자', completed: false }], role_label: '자료 작성',
            reviewer_uid: 'persisted-reviewer', reviewer_name: '기존 검토자', workflow_version: 2,
            permissions: { canEdit: true, canSetDeadline: true, canRequestReview: false, canReview: false, canDelete: true },
          },
          {
            id: 'locked-review-task', project_id: 'reviewer-handoff-project', title: '검토 중 담당자 잠금 업무',
            status: 'review', due_date: date, assignment_mode: 'single', assignee_uid: 'other-user', assignee_name: '기존 담당자',
            assignees: [{ uid: 'other-user', name: '기존 담당자', completed: false }], role_label: '검수',
            reviewer_uid: 'owner-user', reviewer_name: '프로젝트 책임자', workflow_version: 3,
            permissions: { canEdit: true, canSetDeadline: true, canRequestReview: false, canReview: false, canDelete: true },
          },
        ],
        updates: [], comments: [], taskComments: [], events: [],
      }],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="review"]').click();
    await page.locator('[data-project-id="reviewer-handoff-project"]').click();
    await page.locator('[data-project-detail-tab="tasks"]').click();

    await page.locator('[data-collab-task-edit="editable-handoff-task"]').click();
    let form = page.locator('#collaborationProjectTaskForm');
    const reviewer = form.getByLabel('검토자');
    const assignee = form.locator('[name="assigneeUid"]');
    await expect(reviewer).toHaveValue('기존 검토자');
    await assignee.selectOption('e2e-test-user');
    await expect(reviewer).toHaveValue('프로젝트 책임자');
    await assignee.selectOption('other-two');
    await expect(reviewer).toHaveValue('팀 관리자');
    await assignee.selectOption('__all__');
    await expect(reviewer).toHaveValue('팀 관리자');
    await form.getByRole('button', { name: '취소', exact: true }).click();

    await page.locator('[data-collab-task-edit="locked-review-task"]').click();
    form = page.locator('#collaborationProjectTaskForm');
    await expect(form.locator('[name="assigneeUid"]')).toBeDisabled();
    await expect(form).toContainText('검토 요청·완료 상태에서는 담당자 이력을 변경할 수 없습니다.');
  });

  test('project create, task edit, project comment, and task comment use protected contracts', async ({ page }) => {
    const state = createState();
    await setup(page, state);
    await page.locator('.nav-item[data-view="review"]').click();
    await page.locator('[data-collab-project-create]').click();

    const projectForm = page.locator('#collaborationProjectForm');
    await expect(projectForm).toBeVisible();
    await projectForm.locator('[name="name"]').fill('OS 계약 검증 프로젝트');
    await projectForm.locator('[name="description"]').fill('기존 파라곤과 공유하는 프로젝트');
    await projectForm.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.locator('.project-detail-hero')).toContainText('OS 계약 검증 프로젝트');

    await page.locator('[data-collab-task-create]').click();
    const taskForm = page.locator('#collaborationProjectTaskForm');
    await taskForm.locator('[name="title"]').fill('초기 업무명');
    await taskForm.locator('[name="description"]').fill('업무 설명');
    await taskForm.locator('[name="roleLabel"]').fill('콘텐츠 검수');
    await taskForm.locator('[name="assigneeUid"]').selectOption('e2e-test-user');
    await taskForm.locator('[data-project-due-days="3"]').click();
    await taskForm.getByRole('button', { name: '업무 지시', exact: true }).click();
    await expect(page.locator('.project-detail-task')).toContainText('초기 업무명');
    await expect(page.locator('.project-detail-task')).toContainText('콘텐츠 검수');
    await expect(page.locator('.project-detail-task')).toContainText('지시김대호');

    await page.locator('[data-collab-task-edit]').click();
    const editTaskForm = page.locator('#collaborationProjectTaskForm');
    await editTaskForm.locator('[name="title"]').fill('수정된 업무명');
    await editTaskForm.getByRole('button', { name: '수정 저장', exact: true }).click();
    await expect(page.locator('.project-detail-task')).toContainText('수정된 업무명');

    const projectCommentForm = page.locator('#collaborationProjectCommentForm');
    await projectCommentForm.locator('[name="content"]').fill('프로젝트 전체 확인사항');
    await projectCommentForm.getByRole('button', { name: '등록', exact: true }).click();
    await expect(page.locator('.project-comment-list')).toContainText('프로젝트 전체 확인사항');

    await page.locator('[data-collab-task-comments]').click();
    const taskCommentForm = page.locator('#collaborationTaskCommentForm');
    await taskCommentForm.locator('[name="content"]').fill('업무별 확인사항');
    await taskCommentForm.getByRole('button', { name: '등록', exact: true }).click();
    await expect(page.locator('#readonlyModalBody')).toContainText('업무별 확인사항');
    await page.locator('#readonlyModalClose').click();

    await page.locator('[data-project-detail-tab="tasks"]').click();
    await expect(page.locator('.project-workflow-board')).toContainText('담당자 · 역할별 체크리스트');
    await page.locator('[data-collab-task-review-request="task-2"]').click();
    await expect(page.locator('[data-project-task-group="review"]')).toContainText('수정된 업무명');
    await page.locator('[data-collab-task-review-decision="task-2"][data-decision="approve"]').click();
    await expect(page.locator('[data-project-task-group="done"]')).toContainText('수정된 업무명');

    const canonicalProject = await page.evaluate(async () => {
      const response = await fetch('/api/projects/project-1');
      if (!response.ok) throw new Error(`Legacy project read failed: ${response.status}`);
      return response.json();
    });
    expect(canonicalProject.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '수정된 업무명', role_label: '콘텐츠 검수', status: 'done' }),
    ]));

    const paths = state.calls.filter(call => call.method !== 'GET').map(call => `${call.method} ${call.path}`);
    expect(paths).toEqual(expect.arrayContaining([
      'POST /peakos/collaboration/projects',
      'POST /peakos/collaboration/projects/project-1/tasks',
      'PUT /peakos/collaboration/projects/project-1/tasks/task-2',
      'POST /peakos/collaboration/projects/project-1/tasks/task-2/review',
      'POST /peakos/collaboration/projects/project-1/comments',
      'POST /peakos/collaboration/projects/project-1/tasks/task-2/comments',
    ]));
    expect(paths.some(pathname => /^\w+ \/(?:projects|events|chat-rooms)(?:\/|$)/.test(pathname))).toBe(false);
    expect(state.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', path: '/projects/project-1' }),
    ]));
  });

  test('project reviewer rejects with a required reason and resets the deadline through the atomic workflow route', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const date = todayKey();
    const state = createState({
      projects: [{
        id: 'review-project', name: '검토 흐름 프로젝트', description: 'OS 전용 업무 지시 화면',
        status: 'active', deadline: date, owner_id: 'e2e-test-user', owner_name: '김대호', canManage: true,
        canCreateTasks: true, canDirectTasks: true,
        member_count: 2, member_names: '김대호, 박우진', task_count: 1, done_task_count: 0,
        review_task_count: 1, overdue_task_count: 0,
        members: [
          { uid: 'e2e-test-user', name: '김대호', role: 'manager' },
          { uid: 'other-user', name: '박우진', role: 'member' },
        ],
        tasks: [{
          id: 'review-task', project_id: 'review-project', title: '캠페인 원고 검수', description: '완료 기준 확인',
          status: 'review', due_date: date, assignment_mode: 'single', assignee_uid: 'other-user', assignee_name: '박우진',
          assignees: [{ uid: 'other-user', name: '박우진', completed: false }], role_label: '콘텐츠 작성',
          assigned_by_uid: 'e2e-test-user', assigned_by_name: '김대호', reviewer_uid: 'e2e-test-user', reviewer_name: '김대호',
          review_requested_at: new Date().toISOString(), workflow_version: 4,
          permissions: { canEdit: true, canSetDeadline: true, canRequestReview: false, canReview: true, canDelete: true },
        }],
        updates: [], comments: [], taskComments: [], events: [],
      }],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="review"]').click();
    await page.locator('[data-project-id="review-project"]').click();
    await page.locator('[data-project-detail-tab="tasks"]').click();

    await expect(page.locator('[data-project-task-group="review"]')).toContainText('지시김대호');
    await expect(page.locator('[data-project-task-group="review"]')).toContainText('담당박우진');
    await expect(page.locator('[data-project-task-group="review"]')).toContainText('콘텐츠 작성');
    const rejectButton = page.locator('[data-collab-task-review-decision="review-task"][data-decision="reject"]');
    expect((await rejectButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await rejectButton.click();

    const form = page.locator('#collaborationProjectReviewRejectForm');
    await form.locator('[name="note"]').fill('근거 이미지를 추가하고 문구를 다시 확인해 주세요.');
    await form.locator('[data-project-due-days="3"]').click();
    await form.getByRole('button', { name: '반려하고 다시 진행', exact: true }).click();

    await expect(page.locator('[data-project-task-group="active"]')).toContainText('캠페인 원고 검수');
    await expect(page.locator('.project-review-note')).toContainText('근거 이미지를 추가하고 문구를 다시 확인해 주세요.');
    const call = state.calls.find(entry => entry.method === 'POST'
      && entry.path === '/peakos/collaboration/projects/review-project/tasks/review-task/review');
    expect(call?.body).toMatchObject({
      action: 'reject',
      note: '근거 이미지를 추가하고 문구를 다시 확인해 주세요.',
      expectedVersion: 4,
    });
    expect(call?.body?.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('chat room, message, attachment, member, and settings use protected contracts', async ({ page }) => {
    const state = createState();
    await setup(page, state);
    await page.locator('.nav-item[data-view="chat"]').click();
    await page.locator('[data-collab-chat-create]').click();

    const roomForm = page.locator('#collaborationChatRoomForm');
    await roomForm.locator('[name="name"]').fill('OS 계약 검증방');
    await roomForm.getByRole('button', { name: '만들기', exact: true }).click();
    await expect(page.locator('#chatThreadTitle')).toHaveText('OS 계약 검증방');

    await page.locator('#chatMessageInput').fill('OS에서 보낸 메시지');
    await page.locator('#chatComposer .chat-send-button').click();
    await expect(page.locator('#chatThreadMessages')).toContainText('OS에서 보낸 메시지');

    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('#chatAttachButton').click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: 'e2e.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not-a-real-png'),
    });
    await expect.poll(() => state.calls.filter(call =>
      call.method === 'POST' && call.path === '/peakos/collaboration/chat-rooms/room-1/upload'
    ).length).toBe(1);

    await page.locator('[data-collab-chat-members]').click();
    const memberForm = page.locator('#collaborationChatMemberForm');
    await memberForm.locator('[name="userId"]').selectOption('other-user');
    await memberForm.getByRole('button', { name: '추가', exact: true }).click();
    await expect(page.locator('#readonlyModalBody')).toContainText('박우진');
    await page.locator('#readonlyModalClose').click();

    await page.locator('[data-collab-chat-settings]').click();
    const settingsForm = page.locator('#collaborationChatSettingsForm');
    await settingsForm.locator('[name="name"]').fill('이름 변경된 검증방');
    await settingsForm.getByRole('button', { name: '이름 저장', exact: true }).click();
    await expect(page.locator('#chatThreadTitle')).toHaveText('이름 변경된 검증방');

    const paths = state.calls.filter(call => call.method !== 'GET').map(call => `${call.method} ${call.path}`);
    expect(paths).toEqual(expect.arrayContaining([
      'POST /peakos/collaboration/chat-rooms',
      'POST /peakos/collaboration/chat-rooms/room-1/messages',
      'POST /peakos/collaboration/chat-rooms/room-1/upload',
      'POST /peakos/collaboration/chat-rooms/room-1/members',
      'PUT /peakos/collaboration/chat-rooms/room-1',
    ]));
    expect(paths.some(pathname => /^\w+ \/(?:projects|events|chat-rooms)(?:\/|$)/.test(pathname))).toBe(false);
  });

  for (const account of [
    {
      label: 'chat_only',
      flags: { chat_only: true, external_calendar_only: false },
      forbidden: ['/events', '/events/checklist-summary', '/projects'],
      required: ['/chat-rooms', '/chat-rooms/unread'],
    },
    {
      label: 'external_calendar_only',
      flags: { chat_only: false, external_calendar_only: true },
      forbidden: ['/projects'],
      required: ['/events', '/events/checklist-summary', '/chat-rooms', '/chat-rooms/unread'],
    },
  ]) {
    test(`${account.label} boots without forbidden collaboration reads`, async ({ page }) => {
      const state = createState({
        user: {
          uid: 'e2e-test-user', name: account.label, email: `${account.label}@test.local`, role: 'member',
          approved: true, is_active: true, group_id: 'external', group_name: '외부 계정',
          group_type: 'external', ...account.flags,
        },
      });
      await setup(page, state);
      await expect(page.locator('#authGate')).toBeHidden();

      const protectedReads = state.calls
        .filter(call => call.method === 'GET' && call.path.startsWith('/peakos/collaboration/'))
        .map(call => call.path.slice('/peakos/collaboration'.length).split('?')[0]);
      for (const path of account.forbidden) expect(protectedReads).not.toContain(path);
      for (const path of account.required) expect(protectedReads).toContain(path);
    });
  }
});
