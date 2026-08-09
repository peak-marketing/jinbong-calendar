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
};

function uuidFromSequence(sequence: number) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function todayKey() {
  const today = new Date();
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');
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
      || pathname === '/os/w/peak' || pathname === '/os/w/peak/') {
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
    state.calls.push({
      method,
      path: originalPath,
      body,
      preview: request.headers()['x-peakos-preview'] || '',
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
      workspaces: [{ id: 'workspace-peak', slug: 'peak', name: '피크마케팅', kind: 'headquarters', role: 'admin' }],
    });
    if (originalPath === '/os/workspaces/peak/context') return send({
      workspace: { id: 'workspace-peak', slug: 'peak', name: '피크마케팅', kind: 'headquarters' },
      membership: { role: 'admin' },
      permissions: {
        calendar: 'write', chat: 'write', projects: 'write', settlements: 'write', documents: 'write',
        headquartersOversight: false,
      },
    });

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
    if (resourcePath === '/events' && method === 'GET') return send(state.events.filter(event => !event.deleted));
    if (resourcePath === '/events' && method === 'POST') {
      const created = {
        id: `event-${++state.sequence}`,
        ...body,
        owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false,
        sort_order: state.events.length,
      };
      state.events.push(created);
      state.checklists[created.id] = (body?.checklist || []).map((title: string, index: number) => ({
        id: `${created.id}-check-${index + 1}`, event_id: created.id, title, done: false, sort_order: index,
      }));
      return send(created);
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

    if (resourcePath === '/projects' && method === 'GET') return send({ canManageAll: true, projects: state.projects });
    if (resourcePath === '/projects' && method === 'POST') {
      const projectId = `project-${++state.sequence}`;
      const project = {
        id: projectId,
        name: body?.name || '새 프로젝트',
        description: body?.description || '',
        status: body?.status || 'active',
        deadline: body?.deadline || '',
        owner_id: 'e2e-test-user', owner_name: '김대호', canManage: true,
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
      });
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

async function setup(page: Page, state: CollaborationState) {
  await installFirebaseStub(page);
  await serveOsShell(page);
  await installSharedApi(page, state);
  await page.goto('/os/');
  await expect(page.locator('#authGate')).toBeHidden();
  const main = page.locator('[data-nav-cluster="main"]');
  if ((await main.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await main.locator(':scope > .nav-cluster-toggle').click();
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

    const beforePreview = collaborationMutations.length;
    await page.locator('#personaSelect').selectOption('박우진');
    await page.locator('[data-nav-cluster="main"] > .nav-cluster-toggle').click();
    await page.locator('.nav-item[data-view="todo"]').click();
    await expect(page.locator('#todoView [data-collab-readonly]')).toBeVisible();
    await expect(page.locator('#todoView [data-collab-add-todo]')).toHaveCount(0);
    await expect(page.locator('#todoView [data-collab-event="owned-todo"] .todo-task-check')).toBeDisabled();
    await page.waitForTimeout(250);
    expect(state.calls.filter(call => call.method !== 'GET' && call.path.startsWith('/peakos/collaboration/'))).toHaveLength(beforePreview);
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
    expect(state.events.find(event => event.title === '실패 후에도 남는 팀 일정')).toMatchObject({
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
    await taskForm.locator('[name="assigneeUid"]').selectOption('e2e-test-user');
    await taskForm.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.locator('.project-detail-task')).toContainText('초기 업무명');

    await page.locator('[data-collab-task-edit]').click();
    const editTaskForm = page.locator('#collaborationProjectTaskForm');
    await editTaskForm.locator('[name="title"]').fill('수정된 업무명');
    await editTaskForm.getByRole('button', { name: '저장', exact: true }).click();
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

    const paths = state.calls.filter(call => call.method !== 'GET').map(call => `${call.method} ${call.path}`);
    expect(paths).toEqual(expect.arrayContaining([
      'POST /peakos/collaboration/projects',
      'POST /peakos/collaboration/projects/project-1/tasks',
      'PUT /peakos/collaboration/projects/project-1/tasks/task-2',
      'POST /peakos/collaboration/projects/project-1/comments',
      'POST /peakos/collaboration/projects/project-1/tasks/task-2/comments',
    ]));
    expect(paths.some(pathname => /^\w+ \/(?:projects|events|chat-rooms)(?:\/|$)/.test(pathname))).toBe(false);
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
