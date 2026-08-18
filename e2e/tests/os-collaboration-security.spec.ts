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
  todos: any[];
  checklists: Record<string, any[]>;
  instructors: any[];
  checklistInstructions: any[];
  rooms: any[];
  roomMembers: Record<string, any[]>;
  messages: Record<string, any[]>;
  projects: any[];
  newProjects: any[];
  osHiddenEventIds: Record<string, string[]>;
  workspaceRole?: 'admin' | 'manager' | 'member' | 'oversight';
  calendarPermission?: 'none' | 'read' | 'write';
  workspaceData?: Record<string, { events: any[]; projects: any[]; newProjects?: any[]; todos?: any[] }>;
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

function addDaysKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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
    todos: [],
    checklists: {},
    instructors: [
      { uid: 'e2e-test-user', name: '김대호' },
      { uid: 'other-user', name: '박우진' },
    ],
    checklistInstructions: [],
    rooms: [],
    roomMembers: {},
    messages: {},
    projects: [],
    newProjects: [],
    osHiddenEventIds: {},
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

function canonicalEventPatch(body: any) {
  const patch = { ...(body || {}) };
  if (Object.prototype.hasOwnProperty.call(patch, 'endTime')) {
    patch.end_time = patch.endTime;
    delete patch.endTime;
  }
  return patch;
}

function canonicalEventResponse(event: any) {
  const row = canonicalEventPatch(event);
  if (!Object.prototype.hasOwnProperty.call(row, 'end_time')) row.end_time = null;
  return row;
}

function standaloneTodo(overrides: Record<string, any>) {
  return {
    id: String(overrides.id), title: String(overrides.title || ''), date: String(overrides.date || todayKey()),
    startTime: String(overrides.startTime || ''), endTime: String(overrides.endTime || ''),
    category: String(overrides.category || '일반'), memo: String(overrides.memo || ''),
    done: overrides.done === true, sortOrder: Number(overrides.sortOrder || 0), version: Number(overrides.version || 1),
    ownerUid: String(overrides.ownerUid || 'e2e-test-user'), ownerName: String(overrides.ownerName || '김대호'),
    createdAt: String(overrides.createdAt || '2026-08-01T00:00:00.000Z'),
    updatedAt: String(overrides.updatedAt || '2026-08-01T00:00:00.000Z'),
  };
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
    const standaloneTodos = () => workspaceFixture?.todos || (workspaceFixture ? [] : state.todos);
    const requestProjects = workspaceFixture?.projects || state.projects;
    const requestNewProjects = workspaceFixture?.newProjects || state.newProjects;
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

    if (originalPath === '/peakos/todos' || originalPath.startsWith('/peakos/todos/')) {
      if (!state.otpVerified) return send({ error: 'PEAK OS 추가 인증이 필요합니다.', code: 'OS_AUTH_SESSION_REQUIRED' }, 401);
      if (request.headers()['x-peakos-preview'] === '1') {
        return send({ error: '계정 미리보기에서는 할 일을 조회할 수 없습니다.', code: 'PEAKOS_PREVIEW_FORBIDDEN' }, 403);
      }
      if (method !== 'GET' && state.failNextMutation) {
        state.failNextMutation = false;
        return send({ error: '동시 수정 충돌 테스트', code: 'TODO_VERSION_CONFLICT' }, 409);
      }
      const records = standaloneTodos();
      const date = String(url.searchParams.get('date') || todayKey());
      if (originalPath === '/peakos/todos' && method === 'GET') {
        return send({
          date, timeZone: 'Asia/Seoul', readOnly: state.calendarPermission === 'read',
          capabilities: state.calendarPermission === 'read'
            ? { create: false, edit: false, reorder: false, archive: false }
            : { create: true, edit: true, reorder: true, archive: true },
          items: records.filter(todo => todo.date === date),
        });
      }
      if (originalPath === '/peakos/todos' && method === 'POST') {
        const item = {
          id: uuidFromSequence(++state.sequence), title: String(body?.title || ''), date: String(body?.date || date),
          startTime: String(body?.startTime || ''), endTime: String(body?.endTime || ''),
          category: String(body?.category || '일반') || '일반', memo: String(body?.memo || ''),
          done: body?.done === true, sortOrder: Number(body?.sortOrder || 0), version: 1,
          ownerUid: state.user.uid, ownerName: state.user.name,
          createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z',
        };
        records.push(item);
        return send({ item }, 201);
      }
      if (originalPath === '/peakos/todos/reorder' && method === 'POST') {
        const changed: any[] = [];
        for (const next of Array.isArray(body?.items) ? body.items : []) {
          const item = records.find(todo => todo.id === next.id);
          if (!item || Number(next.expectedVersion) !== Number(item.version)) {
            return send({ error: '버전 충돌', code: 'TODO_VERSION_CONFLICT' }, 409);
          }
          item.sortOrder = Number(next.sortOrder);
          item.version += 1;
          changed.push({ ...item });
        }
        return send({ items: changed });
      }
      const id = decodeURIComponent(originalPath.slice('/peakos/todos/'.length));
      const item = records.find(todo => String(todo.id) === id);
      if (!item) return send({ error: 'Not found' }, 404);
      if (Number(body?.expectedVersion) !== Number(item.version)) {
        return send({ error: '버전 충돌', code: 'TODO_VERSION_CONFLICT' }, 409);
      }
      if (method === 'PATCH') {
        Object.entries(body || {}).forEach(([key, value]) => {
          if (key !== 'expectedVersion') item[key] = value;
        });
        item.version += 1;
        return send({ item: { ...item } });
      }
      if (method === 'DELETE') {
        records.splice(records.indexOf(item), 1);
        return send({ deleted: id, version: item.version + 1 });
      }
    }

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
        { id: 'workspace-peak', slug: 'peak', name: '피크마케팅', kind: 'headquarters', role: state.workspaceRole || 'admin' },
        ...Object.keys(state.workspaceData || {}).filter(slug => slug !== 'peak').map(slug => ({
          id: `workspace-${slug}`, slug, name: slug === 'daegu' ? '피크마케팅 대구지사' : slug,
          kind: 'branch', role: state.workspaceRole || 'admin',
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
        membership: { role: state.workspaceRole || 'admin' },
        permissions: {
          calendar: state.calendarPermission || (state.workspaceRole === 'oversight' ? 'read' : 'write'),
          chat: 'write', projects: 'write', settlements: 'write', documents: 'write',
          headquartersOversight: state.workspaceRole === 'oversight',
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
    if (resourcePath === '/events/instructors' && method === 'GET') {
      return send({ instructors: state.instructors });
    }
    if (resourcePath === '/events/checklist-instructions' && method === 'GET') {
      const from = String(url.searchParams.get('from') || '');
      const to = String(url.searchParams.get('to') || '');
      const instructions = state.checklistInstructions.filter(item => {
        const date = String(item?.event?.date || '').slice(0, 10);
        return (!from || date >= from) && (!to || date <= to);
      });
      return send({ from, to, instructions });
    }
    if (resourcePath === '/events' && method === 'GET') {
      const hidden = new Set(state.osHiddenEventIds[workspaceSlug] || []);
      const from = String(url.searchParams.get('from') || '');
      const to = String(url.searchParams.get('to') || '');
      return send(requestEvents
        .filter(event => !event.deleted && (!protectedRequest || !hidden.has(String(event.id))))
        .filter(event => (!from || String(event.date || '').slice(0, 10) >= from)
          && (!to || String(event.date || '').slice(0, 10) <= to))
        .map(canonicalEventResponse));
    }
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
        ...canonicalEventPatch(body),
        owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false,
        sort_order: Math.max(-1, ...categoryRows.map(event => Number(event.sort_order || 0))) + 1,
      };
      state.events.push(created);
      state.checklists[created.id] = (body?.checklist || []).map((title: string, index: number) => ({
        id: `${created.id}-check-${index + 1}`, event_id: created.id, title, done: false, sort_order: index,
      }));
      return send(canonicalEventResponse(created));
    }
    if (resourcePath === '/events/reorder' && method === 'POST') {
      for (const item of body?.items || []) {
        const event = state.events.find(entry => String(entry.id) === String(item.id));
        if (event) event.sort_order = item.sortOrder;
      }
      return send({ ok: true, updated: body?.items?.length || 0 });
    }
    const eventHideMatch = resourcePath.match(/^\/events\/([^/]+)\/os-hide$/);
    if (eventHideMatch && protectedRequest && method === 'POST') {
      const eventId = decodeURIComponent(eventHideMatch[1]);
      const event = requestEvents.find(item => String(item.id) === eventId && !item.deleted);
      if (!event) return send({ error: 'Not found' }, 404);
      const hidden = state.osHiddenEventIds[workspaceSlug] || (state.osHiddenEventIds[workspaceSlug] = []);
      if (!hidden.includes(eventId)) hidden.push(eventId);
      return send({
        ok: true,
        eventId,
        workspaceId: `workspace-${workspaceSlug}`,
        hiddenAt: new Date().toISOString(),
      });
    }
    if (eventHideMatch && protectedRequest && method === 'DELETE') {
      const eventId = decodeURIComponent(eventHideMatch[1]);
      state.osHiddenEventIds[workspaceSlug] = (state.osHiddenEventIds[workspaceSlug] || [])
        .filter(id => id !== eventId);
      return send({ ok: true, eventId, workspaceId: `workspace-${workspaceSlug}` });
    }
    const eventMatch = resourcePath.match(/^\/events\/([^/]+)$/);
    if (eventMatch && method === 'PUT') {
      const event = state.events.find(item => String(item.id) === decodeURIComponent(eventMatch[1]));
      if (!event) return send({ error: 'Not found' }, 404);
      Object.assign(event, canonicalEventPatch(body));
      return send(canonicalEventResponse(event));
    }
    const checklistListMatch = resourcePath.match(/^\/events\/([^/]+)\/checklist$/);
    if (checklistListMatch && method === 'GET') {
      return send((state.checklists[decodeURIComponent(checklistListMatch[1])] || []).map(item => ({
        ...item,
        capabilities: item.capabilities || { toggle: true, edit: true, delete: true },
      })));
    }
    if (checklistListMatch && method === 'POST') {
      const eventId = decodeURIComponent(checklistListMatch[1]);
      const list = state.checklists[eventId] || (state.checklists[eventId] = []);
      const instructor = state.instructors.find(entry => String(entry.uid) === String(body?.instructorUid || '')) || null;
      const item = {
        id: `${eventId}-check-${++state.sequence}`, event_id: eventId, title: body?.title,
        done: false, sort_order: list.length, instructor,
        capabilities: { toggle: true, edit: true, delete: true },
      };
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
      if (method === 'PUT') {
        Object.assign(item, body || {});
        if (Object.prototype.hasOwnProperty.call(body || {}, 'instructorUid')) {
          item.instructor = body?.instructorUid
            ? (state.instructors.find(entry => String(entry.uid) === String(body.instructorUid)) || null)
            : null;
          delete item.instructorUid;
        }
      }
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
    if (resourcePath === '/new-projects' && method === 'GET') {
      return send({
        readOnly: false,
        capabilities: { viewPortfolio: true, createProject: true },
        projects: requestNewProjects,
      });
    }
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
    const projectTaskCompletionMatch = resourcePath.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/completion$/);
    if (projectTaskCompletionMatch && method === 'PUT') {
      const project = state.projects.find(item => String(item.id) === decodeURIComponent(projectTaskCompletionMatch[1]));
      const task = project?.tasks.find((item: any) => String(item.id) === decodeURIComponent(projectTaskCompletionMatch[2]));
      const assignee = task?.assignees?.find((item: any) => String(item.uid || '') === String(state.user.uid));
      if (!project || !task || !assignee) return send({ error: 'Not found' }, 404);
      assignee.completed = body?.completed === true;
      assignee.completed_at = assignee.completed ? new Date().toISOString() : null;
      task.completed_assignee_count = task.assignees.filter((item: any) => item.completed === true).length;
      return send({ task, assignee });
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
  const form = page.locator('#todoView [data-todo-capture]');
  await form.locator('[name="title"]').fill(title);
  await form.getByRole('button', { name: '＋ 적기', exact: true }).click();
  await expect(page.locator('#todoView')).toContainText(title);
}

async function openCalendarEventEditor(page: Page, eventId: string) {
  await page.locator(`#homeCalendarAgenda [data-event-detail="${eventId}"]`).first().click();
  await expect(page.locator('#readonlyModalBody')).toBeVisible();
  await page.locator('#readonlyModalBody [data-collab-event-edit]').click();
  await expect(page.locator('#collaborationEventForm')).toBeVisible();
  return page.locator('#collaborationEventForm');
}

test.describe('PEAK OS collaboration security and isolated-data contract', () => {
  test('standalone todo never renders or mutates legacy Paragon events', async ({ page }) => {
    const date = todayKey();
    const state = createState({
      events: [{
        id: 'legacy-paragon-todo', type: 'todo', title: '기존 파라곤 할 일은 캘린더 전용', date,
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false,
      }],
      todos: [{
        id: 'peakos-standalone-todo', title: 'PEAK OS 독립 할 일', date,
        startTime: '', endTime: '', category: '영업', memo: '독립 원장 메모', done: false,
        sortOrder: 10, version: 1, ownerUid: 'e2e-test-user', ownerName: '김대호',
        createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z',
      }],
    });
    await setup(page, state);

    await page.locator('.nav-item[data-view="todo"]').click();
    const todo = page.locator('[data-todo-dashboard][data-todo-source="peakos"]');
    await expect(todo.locator('[data-personal-todo-id="peakos-standalone-todo"]')).toBeVisible();
    await expect(todo).toContainText('PEAK OS 독립 할 일');
    await expect(todo).not.toContainText('기존 파라곤 할 일은 캘린더 전용');
    await expect(todo.locator('[data-checklist-instruction-panel]')).toHaveCount(0);
    await expect(page.locator('.nav-item[data-view="todo"] .nav-badge')).toHaveText('1');

    await page.locator('.nav-item[data-view="dashboard"]').click();
    await expect(page.locator('.executive-list')).toContainText('PEAK OS 독립 할 일');
    await expect(page.locator('.executive-list')).not.toContainText('기존 파라곤 할 일은 캘린더 전용');
    await page.locator('.nav-item[data-view="todo"]').click();

    const eventMutationCount = state.calls.filter(call => call.method !== 'GET'
      && call.path.startsWith('/peakos/collaboration/events')).length;
    await addTodo(page, '전용 API로 추가');
    const created = state.todos?.find(item => item.title === '전용 API로 추가');
    expect(created).toBeTruthy();
    await page.locator('[data-personal-todo-id="peakos-standalone-todo"] .todo-task-check').click();
    await expect(page.locator('[data-personal-todo-id="peakos-standalone-todo"]')).toHaveClass(/done/);
    const readsBeforeConflict = state.calls.filter(call => call.method === 'GET' && call.path === '/peakos/todos').length;
    state.failNextMutation = true;
    await page.locator('[data-personal-todo-id="peakos-standalone-todo"] .todo-task-check').click();
    await expect(page.locator('.toast')).toContainText('다른 화면에서 먼저 변경');
    await expect(page.locator('[data-personal-todo-id="peakos-standalone-todo"]')).toHaveClass(/done/);
    expect(state.calls.filter(call => call.method === 'GET' && call.path === '/peakos/todos').length)
      .toBeGreaterThan(readsBeforeConflict);

    await page.locator(`[data-personal-todo-id="${created.id}"] [data-peakos-todo-open]`).click();
    const editor = page.locator('[data-peakos-todo-editor]');
    await editor.locator('[name="title"]').fill('전용 API 수정');
    await editor.locator('[name="startTime"]').fill('13:00');
    await editor.locator('[name="endTime"]').fill('14:30');
    await editor.locator('[name="category"]').fill('고객관리');
    await editor.locator('[name="memo"]').fill('상세 모달 저장');
    await editor.getByRole('button', { name: '변경 저장' }).click();
    await expect(page.locator('#readonlyDetailModal')).toBeHidden();
    await expect(todo).toContainText('전용 API 수정');

    page.once('dialog', dialog => dialog.accept());
    await page.locator(`[data-personal-todo-id="${created.id}"] [data-peakos-todo-open]`).click();
    await page.locator('[data-peakos-todo-editor] [data-peakos-todo-archive]').click();
    await expect(page.locator(`[data-personal-todo-id="${created.id}"]`)).toHaveCount(0);

    expect(state.calls.filter(call => call.method !== 'GET'
      && call.path.startsWith('/peakos/collaboration/events'))).toHaveLength(eventMutationCount);
    expect(state.calls.some(call => call.method === 'POST' && call.path === '/peakos/todos')).toBe(true);
    expect(state.calls.some(call => call.method === 'PATCH'
      && call.path === '/peakos/todos/peakos-standalone-todo'
      && call.body?.expectedVersion === 1)).toBe(true);
    expect(state.calls.some(call => call.method === 'PATCH'
      && call.path === `/peakos/todos/${created.id}`
      && Number.isInteger(call.body?.expectedVersion))).toBe(true);
    expect(state.calls.some(call => call.method === 'DELETE'
      && call.path === `/peakos/todos/${created.id}`
      && Number.isInteger(call.body?.expectedVersion))).toBe(true);
  });

  test('account preview clears standalone todo and sends zero todo API requests', async ({ page }) => {
    const date = todayKey();
    const state = createState({
      todos: [{
        id: 'private-standalone', title: '실계정 비공개 할 일', date,
        startTime: '', endTime: '', category: '일반', memo: '', done: false,
        sortOrder: 10, version: 1, ownerUid: 'e2e-test-user', ownerName: '김대호',
      }],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();
    await expect(page.locator('[data-personal-todo-id="private-standalone"]')).toBeVisible();
    const beforePreview = state.calls.filter(call => call.path.startsWith('/peakos/todos')).length;

    await page.locator('#personaSelect').selectOption('박우진');
    await expect(page.locator('#todoView [data-personal-todo-id]')).toHaveCount(0);
    await expect(page.getByText('계정 미리보기에서는 개인 할 일을 표시하지 않습니다')).toHaveCount(2);
    await page.waitForTimeout(150);
    expect(state.calls.filter(call => call.path.startsWith('/peakos/todos'))).toHaveLength(beforePreview);
  });

  test('todo writes use only the standalone protected API and account preview issues zero requests', async ({ page }) => {
    const date = todayKey();
    const state = createState({
      events: [{
        id: 'owned-todo', type: 'todo', title: '미리보기 차단 확인', date,
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false,
      }],
      todos: [standaloneTodo({ id: 'owned-todo', title: '미리보기 차단 확인', date, sortOrder: 10 })],
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
    const todoMutations = state.calls.filter(call => call.method !== 'GET' && call.path.startsWith('/peakos/todos'));
    expect(todoMutations).toHaveLength(1);
    expect(todoMutations[0]).toMatchObject({ method: 'POST', path: '/peakos/todos' });
    const directLegacyWrites = state.calls.filter(call =>
      call.method !== 'GET' && /^\/(events|chat-rooms|projects)(?:\/|$)/.test(call.path)
    );
    expect(directLegacyWrites).toEqual([]);

    await expect(page.locator('[data-personal-todo-id="owned-todo"]')).toBeVisible();
    await expect(page.locator('#todoView')).not.toContainText('미리보기 비공개 프로젝트');
    await expect(page.locator('#todoView')).not.toContainText('미리보기 비공개 프로젝트 업무');
    await expect(page.locator('#todoView [data-project-todo-id]')).toHaveCount(0);
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

    const todoRequestsBeforePreview = state.calls.filter(call => call.path.startsWith('/peakos/todos')).length;
    await page.locator('#personaSelect').selectOption('박우진');
    await expect.poll(() => previewLoadStarted).toBeGreaterThan(0);
    // loadPeakosData가 아직 멈춰 있는 같은 전환 단계에서도 로그인 사용자의
    // 업무 DOM은 즉시 제거되어야 한다.
    await expect(page.locator('#todoView [data-collab-add-todo]')).toHaveCount(0);
    await expect(page.locator('#todoView [data-todo-capture]')).toHaveCount(0);
    await expect(page.locator('#todoView [data-personal-todo-id]')).toHaveCount(0);
    await expect(page.locator('#todoView [data-project-todo-id]')).toHaveCount(0);
    await expect(page.locator('#todoView [data-todo-time-range]')).toHaveCount(0);
    await expect(page.getByText('계정 미리보기에서는 개인 할 일을 표시하지 않습니다')).toHaveCount(2);
    expect(state.calls.filter(call => call.path.startsWith('/peakos/todos'))).toHaveLength(todoRequestsBeforePreview);
    releasePreviewLoad();
    await expect.poll(() => previewLoadSettled).toBeGreaterThan(0);
    await page.unroute(/\/api\/peakos\/intake\?owner=/);
    await expect(page.locator('#todoView [data-checklist-instruction-panel]')).toHaveCount(0);
    const previewTodoReads = state.calls.filter(call => call.path.startsWith('/peakos/todos'));
    await page.waitForTimeout(100);
    expect(state.calls.filter(call => call.path.startsWith('/peakos/todos')))
      .toHaveLength(previewTodoReads.length);
  });

  test('selected-day todo keeps capture, priority, and timeline on one protected standalone record', async ({ page }) => {
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
      todos: [
        standaloneTodo({ id: 'first', title: '먼저 생각한 일', date, category: '기획', sortOrder: 10 }),
        standaloneTodo({ id: 'second', title: '시간 있는 일', date, startTime: '11:00', category: '영업', sortOrder: 20 }),
        standaloneTodo({ id: 'tomorrow', title: '내일 할 일', date: tomorrowKey, sortOrder: 30 }),
      ],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();
    await expect(page.locator('[data-todo-panel="capture"]')).toBeVisible();
    await expect(page.locator('[data-todo-panel="list"]')).toBeVisible();
    await expect(page.locator('[data-todo-selected-date]')).toHaveAttribute('datetime', date);
    await expect(page.locator('[data-todo-progress]')).toHaveAttribute('aria-valuenow', '0');
    await expect(page.locator('#todoView')).not.toContainText('내일 할 일');

    // 시작 시각 하나만 저장된 전용 할 일도 그대로 편집할 수 있다.
    const existingSingleRow = page.locator('[data-daily-timeline-id="second"]');
    await expect(existingSingleRow.locator('[data-todo-time]')).toHaveValue('11:00');
    await expect(existingSingleRow.locator('[data-todo-end-time]')).toHaveValue('');

    await page.locator('[data-todo-priority-move="first"][data-direction="down"]').click();
    const priorityRows = page.locator('[data-daily-priority-id]');
    await expect(priorityRows.nth(0)).toHaveAttribute('data-daily-priority-id', 'second');
    await expect(priorityRows.nth(1)).toHaveAttribute('data-daily-priority-id', 'first');
    const reorderCall = state.calls.find(call => call.method === 'POST' && call.path === '/peakos/todos/reorder');
    expect(reorderCall).toMatchObject({
      workspace: 'peak',
      body: { items: [{ id: 'second', sortOrder: 10, expectedVersion: 1 }, { id: 'first', sortOrder: 20, expectedVersion: 1 }] },
    });

    const capture = page.locator('[data-todo-capture]');
    await capture.locator('[name="title"]').fill('방금 생각난 일');
    await capture.getByRole('button', { name: '＋ 적기' }).click();
    await expect(page.locator('#todoView')).toContainText('방금 생각난 일');
    const captured = state.todos?.find(todo => todo.title === '방금 생각난 일');
    expect(captured).toMatchObject({ date, startTime: '', category: '일반', version: 1 });
    expect(state.calls.filter(call => call.method === 'POST' && call.path === '/peakos/todos').at(-1)?.body)
      .toMatchObject({ title: '방금 생각난 일', date, startTime: '', endTime: '' });
    await expect(page.locator('[data-daily-priority-id]').last()).toHaveAttribute('data-daily-priority-id', captured.id);

    const todoFirstPatches = () => state.calls.filter(call =>
      call.method === 'PATCH' && call.path === '/peakos/todos/first');
    const todoReads = () => state.calls.filter(call =>
      call.method === 'GET' && call.path === '/peakos/todos');
    const patchesBeforeRange = todoFirstPatches().length;
    const readsBeforeRange = todoReads().length;
    const timeInput = page.locator('[data-daily-timeline-id="first"] [data-todo-time="first"]');
    const endTimeInput = page.locator('[data-daily-timeline-id="first"] [data-todo-end-time="first"]');

    // 두 입력은 draft이며, 적용을 눌렀을 때만 한 요청으로 원자 저장한다.
    await timeInput.fill('17:30');
    await endTimeInput.fill('19:00');
    expect(todoFirstPatches()).toHaveLength(patchesBeforeRange);
    await page.locator('[data-daily-timeline-id="first"] [data-todo-time-save="first"]').click();
    await expect(page.locator('[data-daily-timeline-id="first"] [data-todo-time="first"]')).toHaveValue('17:30');
    await expect(page.locator('[data-daily-timeline-id="first"] [data-todo-end-time="first"]')).toHaveValue('19:00');
    expect(todoFirstPatches()).toHaveLength(patchesBeforeRange + 1);
    expect(todoFirstPatches().at(-1)).toMatchObject({ workspace: 'peak', body: { startTime: '17:30', endTime: '19:00', expectedVersion: 2 } });
    expect(state.todos?.find(todo => todo.id === 'first')).toMatchObject({ startTime: '17:30', endTime: '19:00' });
    expect(todoReads().length).toBeGreaterThan(readsBeforeRange);

    // 상세/편집 화면도 canonical 재조회된 시간 범위를 그대로 보여준다.
    await page.locator('[data-daily-timeline-id="first"] [data-peakos-todo-open="first"]').click();
    const todoForm = page.locator('[data-peakos-todo-editor]');
    await expect(todoForm.locator('[name="startTime"]')).toHaveValue('17:30');
    await expect(todoForm.locator('[name="endTime"]')).toHaveValue('19:00');
    await todoForm.locator('[name="endTime"]').fill('19:30');
    await todoForm.getByRole('button', { name: '변경 저장', exact: true }).click();
    await expect(todoForm).toBeHidden();
    expect(todoFirstPatches().at(-1)).toMatchObject({ body: { startTime: '17:30', endTime: '19:30', expectedVersion: 3 } });
    expect(state.todos?.find(todo => todo.id === 'first')).toMatchObject({ startTime: '17:30', endTime: '19:30' });

    // 종료가 시작보다 앞서면 draft는 고칠 수 있게 남기되 서버 쓰기는 전혀 보내지 않는다.
    const patchesBeforeInvalidRange = todoFirstPatches().length;
    await page.locator('[data-daily-timeline-id="first"] [data-todo-end-time="first"]').fill('17:00');
    await page.locator('[data-daily-timeline-id="first"] [data-todo-time-save="first"]').click();
    await expect(page.locator('[data-daily-timeline-id="first"] [data-todo-end-time="first"]')).toBeFocused();
    expect(todoFirstPatches()).toHaveLength(patchesBeforeInvalidRange);

    // 시작을 비우면 범위 자체가 성립하지 않으므로 종료도 함께 비운다.
    await page.locator('[data-daily-timeline-id="first"] [data-todo-time="first"]').fill('');
    await page.locator('[data-daily-timeline-id="first"] [data-todo-time-save="first"]').click();
    expect(todoFirstPatches().at(-1)).toMatchObject({ body: { startTime: '', endTime: '' } });
    await expect(page.locator('[data-daily-timeline-id="first"] [data-todo-end-time="first"]')).toHaveValue('');

    expect(state.calls.some(call => call.path.startsWith('/timetable'))).toBe(false);
    expect(state.calls.some(call => call.method !== 'GET' && /^\/events(?:\/|$)/.test(call.path))).toBe(false);
  });

  test('KST date navigation drives filtered progress and capture without changing the today badge', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-12-31T03:00:00.000Z') });
    const state = createState({
      events: [
        { id: 'previous-open', type: 'todo', title: '어제 미완료', date: '2026-12-30', time: '', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 10, done: false, deleted: false },
        { id: 'previous-done', type: 'todo', title: '어제 완료', date: '2026-12-30', time: '09:00', end_time: '10:00', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 20, done: true, deleted: false },
        { id: 'today-open', type: 'todo', title: '오늘 미완료', date: '2026-12-31', time: '', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 10, done: false, deleted: false },
        { id: 'next-done-one', type: 'todo', title: '내일 완료 하나', date: '2027-01-01', time: '11:00', end_time: '12:00', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 10, done: true, deleted: false },
        { id: 'next-done-two', type: 'todo', title: '내일 완료 둘', date: '2027-01-01', time: '', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 20, done: true, deleted: false },
        { id: 'next-team', type: 'todo', title: '내일 팀 업무', date: '2027-01-01', time: '', scope: 'team', owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false },
        { id: 'next-other-owner', type: 'todo', title: '다른 사람 내일 업무', date: '2027-01-01', time: '', scope: 'personal', owner_id: 'other-user', owner_name: '박우진', done: false, deleted: false },
      ],
      todos: [
        standaloneTodo({ id: 'previous-open', title: '어제 미완료', date: '2026-12-30', sortOrder: 10 }),
        standaloneTodo({ id: 'previous-done', title: '어제 완료', date: '2026-12-30', startTime: '09:00', endTime: '10:00', sortOrder: 20, done: true }),
        standaloneTodo({ id: 'today-open', title: '오늘 미완료', date: '2026-12-31', sortOrder: 10 }),
        standaloneTodo({ id: 'next-done-one', title: '내일 완료 하나', date: '2027-01-01', startTime: '11:00', endTime: '12:00', sortOrder: 10, done: true }),
        standaloneTodo({ id: 'next-done-two', title: '내일 완료 둘', date: '2027-01-01', sortOrder: 20, done: true }),
      ],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();

    const selected = page.locator('[data-todo-selected-date]');
    const progress = page.locator('[data-todo-progress]');
    const badge = page.locator('.nav-item[data-view="todo"] .nav-badge');
    await expect(selected).toHaveAttribute('datetime', '2026-12-31');
    await expect(progress).toHaveAttribute('aria-valuenow', '0');
    await expect(badge).toHaveText('1');

    await page.locator('[data-todo-date-next]').click();
    await expect(selected).toHaveAttribute('datetime', '2027-01-01');
    await expect(progress).toHaveAttribute('aria-valuenow', '100');
    await expect(page.locator('[data-todo-stat="all"] strong')).toHaveText('2');
    await expect(page.locator('[data-todo-stat="complete"] strong')).toHaveText('2');
    await expect(page.locator('#todoView')).not.toContainText('내일 팀 업무');
    await expect(page.locator('#todoView')).not.toContainText('다른 사람 내일 업무');
    await expect(badge).toHaveText('1');
    expect(state.calls.some(call => call.method === 'GET'
      && call.path === '/peakos/todos'
      && call.search === '?date=2027-01-01')).toBe(true);

    const capture = page.locator('[data-todo-capture]');
    await capture.locator('[name="title"]').fill('선택한 내일에 추가');
    await capture.getByRole('button', { name: '＋ 적기' }).click();
    expect(state.todos?.find(todo => todo.title === '선택한 내일에 추가')).toMatchObject({
      date: '2027-01-01', startTime: '', version: 1,
    });
    await expect(progress).toHaveAttribute('aria-valuenow', '67');
    await expect(page.locator('[data-todo-stat="all"] strong')).toHaveText('3');
    await expect(badge).toHaveText('1');

    await page.locator('[data-todo-date-next]').click();
    await expect(selected).toHaveAttribute('datetime', '2027-01-02');
    await expect(progress).toHaveAttribute('aria-valuenow', '0');
    await expect(page.locator('[data-todo-stat="all"] strong')).toHaveText('0');

    await page.locator('[data-todo-date-today]').click();
    await expect(selected).toHaveAttribute('datetime', '2026-12-31');
    await page.locator('[data-todo-date-prev]').click();
    await expect(selected).toHaveAttribute('datetime', '2026-12-30');
    await expect(progress).toHaveAttribute('aria-valuenow', '50');
    await expect(badge).toHaveText('1');
  });

  test('calendar year navigation cannot erase the KST-today todo badge or selected-day data', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-12-31T03:00:00.000Z') });
    const state = createState({
      events: [
        { id: 'badge-today', type: 'todo', title: '오늘 배지 유지 업무', date: '2026-12-31', time: '', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false },
        { id: 'next-year-calendar', type: 'event', title: '다음 해 일정', date: '2027-01-05', time: '', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false },
      ],
      todos: [standaloneTodo({ id: 'badge-today', title: '오늘 배지 유지 업무', date: '2026-12-31' })],
    });
    await setup(page, state);

    const badge = page.locator('.nav-item[data-view="todo"] .nav-badge');
    await expect(badge).toHaveText('1');
    await page.locator('#calendarNext').click();
    await expect(page.locator('#calendarMonthLabel')).toHaveText('2027년 1월');
    expect(state.calls.some(call => call.method === 'GET'
      && call.path === '/peakos/collaboration/events'
      && call.search === '?from=2027-01-01&to=2027-12-31')).toBe(true);
    await expect(badge).toHaveText('1');

    await page.locator('.nav-item[data-view="todo"]').click();
    await expect(page.locator('[data-todo-selected-date]')).toHaveAttribute('datetime', '2026-12-31');
    await expect(page.locator('[data-personal-todo-id="badge-today"]')).toContainText('오늘 배지 유지 업무');
    await expect(badge).toHaveText('1');
    expect(state.calls.some(call => call.method === 'GET'
      && call.path === '/peakos/todos'
      && call.search === '?date=2026-12-31')).toBe(true);
  });

  test('a late legacy annual snapshot cannot overwrite a newer standalone todo save', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-08-16T03:00:00.000Z') });
    const date = '2026-08-16';
    const state = createState({
      events: [{
        id: 'annual-race-todo', type: 'todo', title: '연간 조회 경합 업무', date, time: '', end_time: '',
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 10,
        done: false, deleted: false,
      }],
      todos: [standaloneTodo({ id: 'annual-race-todo', title: '연간 조회 경합 업무', date, sortOrder: 10 })],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="calendar"]').click();

    const staleAnnualPayload = state.events.map(event => canonicalEventResponse({ ...event }));
    let annualStarted = 0;
    let annualDelivered = 0;
    let releaseAnnual!: () => void;
    const annualGate = new Promise<void>(resolve => { releaseAnnual = resolve; });
    await page.route(/\/api\/peakos\/collaboration\/events\?/, async route => {
      const request = route.request();
      const url = new URL(request.url());
      const annual = request.method() === 'GET'
        && url.searchParams.get('from') === '2026-01-01'
        && url.searchParams.get('to') === '2026-12-31';
      if (!annual || annualStarted > 0) return route.fallback();
      annualStarted += 1;
      await annualGate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(staleAnnualPayload) });
      annualDelivered += 1;
    });

    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await expect.poll(() => annualStarted).toBe(1);
    await page.locator('.nav-item[data-view="todo"]').click();
    const row = page.locator('[data-personal-todo-id="annual-race-todo"]');
    await expect(row).toBeVisible();
    await row.locator('[data-todo-time]').fill('17:30');
    await row.locator('[data-todo-end-time]').fill('19:00');
    await row.locator('[data-todo-time-save]').click();
    await expect.poll(() => state.todos?.find(todo => todo.id === 'annual-race-todo')?.endTime).toBe('19:00');
    await expect(row.locator('[data-todo-time]')).toHaveValue('17:30');
    await expect(row.locator('[data-todo-end-time]')).toHaveValue('19:00');

    await row.locator('[data-peakos-todo-toggle]').click();
    await expect.poll(() => state.todos?.find(todo => todo.id === 'annual-race-todo')?.done).toBe(true);
    await expect(row).toHaveClass(/done/);
    await expect(page.locator('.nav-item[data-view="todo"] .nav-badge')).toHaveText('0');

    releaseAnnual();
    await expect.poll(() => annualDelivered).toBe(1);
    await expect(row).toHaveClass(/done/);
    await expect(row.locator('input').nth(0)).toHaveValue('17:30');
    await expect(row.locator('input').nth(1)).toHaveValue('19:00');
    await expect(page.locator('[data-todo-progress]')).toHaveAttribute('aria-valuenow', '100');
    await expect(page.locator('.nav-item[data-view="todo"] .nav-badge')).toHaveText('0');

    // legacy 캘린더 원장은 독립적이므로 그 snapshot은 그대로 남지만,
    // 완료된 standalone 할 일 상태에는 어떤 영향도 주지 않는다.
    await page.locator('.nav-item[data-view="calendar"]').click();
    await expect(page.locator('#homeCalendarAgenda')).toContainText('연간 조회 경합 업무');
  });

  test('a failed selected-date load restores the date, dashboard, and capture draft', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-08-16T03:00:00.000Z') });
    const state = createState({
      events: [{
        id: 'rollback-current', type: 'todo', title: '실패 전 선택일 업무', date: '2026-08-16', time: '',
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 10,
        done: false, deleted: false,
      }, {
        id: 'rollback-next', type: 'todo', title: '재시도할 다음 날 업무', date: '2026-08-17', time: '',
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 10,
        done: false, deleted: false,
      }],
      todos: [
        standaloneTodo({ id: 'rollback-current', title: '실패 전 선택일 업무', date: '2026-08-16', sortOrder: 10 }),
        standaloneTodo({ id: 'rollback-next', title: '재시도할 다음 날 업무', date: '2026-08-17', sortOrder: 10 }),
      ],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();
    const selected = page.locator('[data-todo-selected-date]');
    const captureDraft = page.locator('[data-todo-capture] [name="title"]');
    await expect(selected).toHaveAttribute('datetime', '2026-08-16');
    await expect(page.locator('[data-personal-todo-id="rollback-current"]')).toBeVisible();
    await captureDraft.fill('조회 실패 뒤에도 남을 초안');

    let selectedDateReads = 0;
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
    let releaseSuccess!: () => void;
    const successGate = new Promise<void>(resolve => { releaseSuccess = resolve; });
    await page.route(/\/api\/peakos\/todos\?/, async route => {
      const request = route.request();
      const url = new URL(request.url());
      const selectedDateRead = request.method() === 'GET'
        && url.searchParams.get('date') === '2026-08-17';
      if (!selectedDateRead) return route.fallback();
      selectedDateReads += 1;
      if (selectedDateReads === 1) {
        await failureGate;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: '선택 날짜 일시 오류' }),
        });
      }
      if (selectedDateReads === 2) {
        await successGate;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            date: '2026-08-17', timeZone: 'Asia/Seoul', readOnly: false,
            capabilities: { create: true, edit: true, reorder: true, archive: true },
            items: state.todos.filter(todo => todo.date === '2026-08-17'),
          }),
        });
      }
      return route.fallback();
    });

    const mutationCount = () => state.calls.filter(call => call.method !== 'GET').length;
    const mutationsBeforeNavigation = mutationCount();
    await page.locator('[data-todo-date-next]').click();
    await expect.poll(() => selectedDateReads).toBe(1);
    await expect(page.locator('#todoView')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[data-todo-date-next]')).toBeDisabled();
    await expect(page.locator('[data-todo-dashboard] button:not([disabled]), [data-todo-dashboard] input:not([disabled]), [data-todo-dashboard] textarea:not([disabled]), [data-todo-dashboard] select:not([disabled])')).toHaveCount(0);
    await page.locator('[data-peakos-todo-toggle="rollback-current"]').evaluate(element => (element as HTMLButtonElement).click());
    expect(mutationCount()).toBe(mutationsBeforeNavigation);
    releaseFailure();

    await expect(selected).toHaveAttribute('datetime', '2026-08-16');
    await expect(captureDraft).toHaveValue('조회 실패 뒤에도 남을 초안');
    await expect(page.locator('[data-personal-todo-id="rollback-current"]')).toBeVisible();
    await expect(page.locator('[data-personal-todo-id="rollback-next"]')).toHaveCount(0);
    await expect(page.locator('#todoView')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[data-todo-date-next]')).toBeEnabled();
    await expect(captureDraft).toBeEnabled();
    await expect(page.locator('[data-peakos-todo-toggle="rollback-current"]')).toBeEnabled();
    await expect(page.locator('.toast')).toContainText('할 일 조회 실패: 선택 날짜 일시 오류');

    await page.locator('[data-todo-date-next]').click();
    await expect.poll(() => selectedDateReads).toBe(2);
    await expect(page.locator('#todoView')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[data-todo-dashboard] button:not([disabled]), [data-todo-dashboard] input:not([disabled]), [data-todo-dashboard] textarea:not([disabled]), [data-todo-dashboard] select:not([disabled])')).toHaveCount(0);
    await page.locator('[data-peakos-todo-toggle="rollback-current"]').evaluate(element => (element as HTMLButtonElement).click());
    expect(mutationCount()).toBe(mutationsBeforeNavigation);
    releaseSuccess();
    await expect(selected).toHaveAttribute('datetime', '2026-08-17');
    await expect(page.locator('[data-personal-todo-id="rollback-next"]')).toBeVisible();
    await expect(captureDraft).toHaveValue('');
    await expect(captureDraft).toBeEnabled();
    await expect(page.locator('[data-peakos-todo-toggle="rollback-next"]')).toBeEnabled();
  });

  for (const width of [900, 768]) {
    test(`${width}px timeline range keeps every row control inside its panel`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const date = todayKey();
      const state = createState({
        events: [{
          id: `responsive-range-${width}`, type: 'todo', title: '시간 범위 배치 확인', date,
          time: '17:30', end_time: '19:00', scope: 'personal', owner_id: 'e2e-test-user',
          owner_name: '김대호', sort_order: 10, done: false, deleted: false,
        }],
        todos: [standaloneTodo({
          id: `responsive-range-${width}`, title: '시간 범위 배치 확인', date,
          startTime: '17:30', endTime: '19:00', sortOrder: 10,
        })],
      });
      await setup(page, state);
      await page.locator('.nav-item[data-view="todo"]').click();

      const geometry = await page.locator(`[data-daily-timeline-id="responsive-range-${width}"]`).evaluate(row => {
        const rect = row.getBoundingClientRect();
        const childRects = [...row.children].map(child => {
          const childRect = child.getBoundingClientRect();
          return { left: childRect.left, right: childRect.right, width: childRect.width };
        });
        return {
          row: { left: rect.left, right: rect.right, width: rect.width },
          childRects,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      expect(geometry.row.width).toBeGreaterThan(0);
      for (const child of geometry.childRects) {
        expect(child.width).toBeGreaterThan(0);
        expect(child.left).toBeGreaterThanOrEqual(geometry.row.left - 1);
        expect(child.right).toBeLessThanOrEqual(geometry.row.right + 1);
      }
      expect(geometry.overflow).toBeLessThanOrEqual(1);
    });
  }

  test('personal todo is a two-panel dashboard and never renders or refreshes project tasks', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const date = todayKey();
    const state = createState({
      events: [{
        id: 'personal-inbox-task', type: 'todo', title: '생각나는 개인 업무', date, time: '',
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 10,
        done: false, deleted: false,
      }, {
        id: 'personal-timed-task', type: 'todo', title: '시간을 정한 개인 업무', date, time: '10:00', end_time: '11:00',
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 20,
        done: false, deleted: false,
      }, {
        id: 'personal-done-task', type: 'todo', title: '완료한 개인 업무', date, time: '09:00', end_time: '09:30',
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 30,
        done: true, deleted: false,
      }, {
        id: 'project-linked-event', type: 'todo', title: '이벤트 API의 프로젝트 연결 업무', date, time: '',
        project_id: 'split-project', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호',
        sort_order: 40, done: false, deleted: false,
      }],
      todos: [
        standaloneTodo({ id: 'personal-inbox-task', title: '생각나는 개인 업무', date, sortOrder: 10 }),
        standaloneTodo({ id: 'personal-timed-task', title: '시간을 정한 개인 업무', date, startTime: '10:00', endTime: '11:00', sortOrder: 20 }),
        standaloneTodo({ id: 'personal-done-task', title: '완료한 개인 업무', date, startTime: '09:00', endTime: '09:30', sortOrder: 30, done: true }),
      ],
      projects: [{
        id: 'split-project', name: '신규 캠페인 프로젝트', status: 'active', owner_name: '김대호',
        tasks: [{
          id: 'project-split-task', project_id: 'split-project', title: '프로젝트 원고 작성',
          status: 'doing', assignment_mode: 'single',
          assignee_uid: 'e2e-test-user', assignee_name: '김대호',
          assignees: [{ uid: 'e2e-test-user', name: '김대호', completed: false }],
          permissions: { canRequestReview: true },
        }],
      }],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();

    const dashboard = page.locator('[data-todo-dashboard]');
    const capture = dashboard.locator('[data-todo-panel="capture"]');
    const list = dashboard.locator('[data-todo-panel="list"]');
    await expect(dashboard).toBeVisible();
    await expect(dashboard.locator('[data-todo-panel]')).toHaveCount(2);
    await expect(capture.getByText('생각나는 일 적기', { exact: true })).toBeVisible();
    await expect(list.getByText('투두리스트', { exact: true })).toBeVisible();
    await expect(page.locator('#todoView .todo-page-toolbar')).toHaveCount(0);
    await expect(page.locator('#todoView')).not.toContainText('현재 워크스페이스 운영 데이터');

    await expect(dashboard.locator('[data-todo-stat]')).toHaveCount(4);
    await expect(dashboard.locator('[data-todo-stat="all"] strong')).toHaveText('3');
    await expect(dashboard.locator('[data-todo-stat="remaining"] strong')).toHaveText('2');
    await expect(dashboard.locator('[data-todo-stat="scheduled"] strong')).toHaveText('2');
    await expect(dashboard.locator('[data-todo-stat="complete"] strong')).toHaveText('1');
    await expect(dashboard.locator('[data-todo-progress]')).toHaveAttribute('aria-valuenow', '33');
    await expect(capture.locator('[data-todo-capture-item]')).toHaveCount(1);
    await expect(capture).toContainText('생각나는 개인 업무');
    await expect(capture).not.toContainText('시간을 정한 개인 업무');
    await expect(list.locator('[data-personal-todo-id]')).toHaveCount(3);

    await expect(dashboard).not.toContainText('신규 캠페인 프로젝트');
    await expect(dashboard).not.toContainText('프로젝트 원고 작성');
    await expect(dashboard).not.toContainText('이벤트 API의 프로젝트 연결 업무');
    await expect(dashboard.locator('[data-project-todo-id], [data-todo-panel="project"]')).toHaveCount(0);
    expect(state.calls.some(call => call.path === '/peakos/collaboration/projects/my-tasks')).toBe(false);
    await expect(page.locator('.nav-item[data-view="todo"] .nav-badge')).toHaveText('2');

    const [captureBox, listBox] = await Promise.all([capture.boundingBox(), list.boundingBox()]);
    expect(captureBox).not.toBeNull();
    expect(listBox).not.toBeNull();
    expect(listBox?.x || 0).toBeGreaterThan((captureBox?.x || 0) + (captureBox?.width || 0) - 2);
    expect(Math.abs((captureBox?.y || 0) - (listBox?.y || 0))).toBeLessThan(4);

    await list.locator('[data-personal-todo-id="personal-inbox-task"] [data-peakos-todo-toggle]').click();
    await expect(list.locator('[data-personal-todo-id="personal-inbox-task"]')).toHaveClass(/done/);
    expect(state.calls.find(call => call.method === 'PATCH'
      && call.path === '/peakos/todos/personal-inbox-task')).toMatchObject({
      workspace: 'peak', body: { done: true, expectedVersion: 1 },
    });
    await expect(dashboard.locator('[data-todo-progress]')).toHaveAttribute('aria-valuenow', '67');
    await expect(page.locator('.nav-item[data-view="todo"] .nav-badge')).toHaveText('1');

    const projectReadsBeforePoll = state.calls.filter(call => call.method === 'GET'
      && call.path === '/peakos/collaboration/projects/my-tasks').length;
    const todoDayReadsBeforePoll = state.calls.filter(call => call.method === 'GET'
      && call.path === '/peakos/todos'
      && call.search === `?date=${date}`).length;
    await page.locator('#personaSelect').focus();
    await page.waitForTimeout(5_400);
    expect(state.calls.filter(call => call.method === 'GET'
      && call.path === '/peakos/todos'
      && call.search === `?date=${date}`).length).toBeGreaterThan(todoDayReadsBeforePoll);
    expect(state.calls.filter(call => call.method === 'GET'
      && call.path === '/peakos/collaboration/projects/my-tasks')).toHaveLength(projectReadsBeforePoll);
  });

  test('calendar checklist instructor stays canonical while todo renders no instruction inbox', async ({ page }) => {
    const date = todayKey();
    const state = createState({
      events: [{
        id: 'directive-owner-event', type: 'todo', title: '오늘 영업 후속', date, time: '17:30', end_time: '19:00',
        memo: '지시함에 보이면 안 되는 일정 메모', scope: 'personal', owner_id: 'e2e-test-user',
        owner_name: '김대호', sort_order: 10, done: false, deleted: false,
      }, {
        id: 'instruction-parent-event', type: 'event', title: '고객 상담 일정', date, time: '13:00', end_time: '13:30',
        memo: '지시함 최소 응답에 포함되면 안 되는 비공개 메모', scope: 'personal', owner_id: 'other-user',
        owner_name: '박우진', sort_order: 20, done: false, deleted: false,
      }],
      checklists: {
        'directive-owner-event': [{
          id: 'editable-directive', event_id: 'directive-owner-event', title: '재통화 대상 확인', done: false, sort_order: 0,
          instructor: { uid: 'other-user', name: '박우진' },
          capabilities: { toggle: true, edit: true, delete: true },
        }, {
          id: 'server-readonly-directive', event_id: 'directive-owner-event', title: '서버 읽기 전용 항목', done: false, sort_order: 1,
          instructor: { uid: 'e2e-test-user', name: '김대호' },
          capabilities: { toggle: false, edit: false, delete: false },
        }],
      },
      checklistInstructions: [{
        id: 'received-instruction', title: '지정 고객 후속 통화', done: false, sortOrder: 0,
        directiveVersion: 2, updatedAt: '2026-08-17T00:00:00.000Z',
        event: {
          id: 'instruction-parent-event', title: '고객 상담 일정', date, time: '13:00', endTime: '13:30',
          owner: { uid: 'other-user', name: '박우진' },
        },
        assignedBy: { uid: 'other-user', name: '박우진' },
        capabilities: { toggle: false, edit: false, delete: false },
      }],
      projects: [{
        id: 'instruction-secret-project', name: '지시함 노출 금지 프로젝트', status: 'active', owner_name: '김대호',
        tasks: [{
          id: 'instruction-secret-project-task', project_id: 'instruction-secret-project',
          title: '지시함에 나오면 안 되는 프로젝트 업무', status: 'todo',
          assignee_uid: 'e2e-test-user', assignee_name: '김대호',
          assignees: [{ uid: 'e2e-test-user', name: '김대호', completed: false }],
        }],
      }],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();
    await expect(page.locator('[data-checklist-instruction-panel]')).toHaveCount(0);
    await expect(page.locator('#todoView')).not.toContainText('지정 고객 후속 통화');
    expect(state.calls.some(call => call.path === '/peakos/collaboration/events/checklist-instructions')).toBe(false);
    expect(state.calls.some(call => call.path === '/peakos/collaboration/projects/my-tasks')).toBe(false);

    await page.locator('.nav-item[data-view="calendar"]').click();
    await page.locator('#homeCalendarAgenda [data-event-detail="directive-owner-event"]').first().click();
    const modal = page.locator('#readonlyModalBody');
    await expect(modal.locator('[data-checklist-id="editable-directive"]')).toContainText('지시자 · 박우진');
    const serverReadonly = modal.locator('[data-checklist-id="server-readonly-directive"]');
    await expect(serverReadonly.locator('.collaboration-check')).toBeDisabled();
    await expect(serverReadonly.locator('[data-collab-checklist-edit], [data-collab-checklist-delete]')).toHaveCount(0);
    await expect.poll(() => state.calls.filter(call => call.method === 'GET'
      && call.path === '/peakos/collaboration/events/instructors').length).toBeGreaterThan(0);

    const createForm = modal.locator('[data-checklist-create-form]');
    await createForm.locator('[name="title"]').fill('새 후속 항목');
    await createForm.locator('[name="instructorUid"]').selectOption('other-user');
    await createForm.getByRole('button', { name: '추가', exact: true }).click();
    await expect(modal.locator('[data-checklist-id]').last()).toContainText('지시자 · 박우진');
    expect(state.calls.filter(call => call.method === 'POST'
      && call.path === '/peakos/collaboration/events/directive-owner-event/checklist').at(-1)).toMatchObject({
      body: { title: '새 후속 항목', instructorUid: 'other-user' },
    });

    const editable = modal.locator('[data-checklist-id="editable-directive"]');
    await editable.locator('[data-collab-checklist-edit]').click();
    const editForm = editable.locator('[data-checklist-edit-form]');
    await expect(editForm).toBeVisible();
    await editForm.locator('[name="title"]').fill('재통화 대상 확인 수정');
    await editForm.locator('[name="instructorUid"]').selectOption('e2e-test-user');
    await editForm.getByRole('button', { name: '저장', exact: true }).click();
    expect(state.calls.filter(call => call.method === 'PUT'
      && call.path === '/peakos/collaboration/events/directive-owner-event/checklist/editable-directive').at(-1)).toMatchObject({
      body: { title: '재통화 대상 확인 수정', instructorUid: 'e2e-test-user' },
    });
    await expect(modal.locator('[data-checklist-id="editable-directive"]')).toContainText('지시자 · 김대호');
  });

  test('legacy checklist notification deep link leaves todo isolated and opens its calendar date', async ({ page }) => {
    const date = todayKey();
    const state = createState({
      checklistInstructions: [{
        id: 'deep-linked-instruction', title: '링크로 연 후속 통화', done: false, sortOrder: 0,
        directiveVersion: 1, updatedAt: '2026-08-17T00:00:00.000Z',
        event: {
          id: 'deep-link-parent', title: '딜링크 영업 일정', date, time: '17:30', endTime: '19:00',
          owner: { uid: 'other-user', name: '박우진' },
        },
        assignedBy: { uid: 'other-user', name: '박우진' },
        capabilities: { toggle: false, edit: false, delete: false },
      }],
    });
    const url = `/os/w/peak/?keep=1&view=todo&date=${date}&instruction=deep-linked-instruction#directive`;
    await setup(page, state, url);

    await expect(page.locator('#calendarView')).toBeVisible();
    await expect(page.locator('#todoView')).toBeHidden();
    await expect(page.locator('[data-checklist-instruction-panel]')).toHaveCount(0);
    const currentUrl = new URL(page.url());
    expect(currentUrl.searchParams.get('view')).toBeNull();
    expect(currentUrl.searchParams.get('date')).toBeNull();
    expect(currentUrl.searchParams.get('instruction')).toBeNull();
    expect(currentUrl.searchParams.get('keep')).toBe('1');
    expect(currentUrl.hash).toBe('#directive');
    expect(state.calls.some(call => call.path === '/peakos/collaboration/events/checklist-instructions')).toBe(false);
  });

  test('a late checklist detail response cannot replace the project modal opened after closing it', async ({ page }) => {
    const date = todayKey();
    const eventId = 'slow-checklist-event';
    const state = createState({
      events: [{
        id: eventId, type: 'todo', title: '느린 체크리스트 일정', date,
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호',
        sort_order: 10, done: false, deleted: false,
      }],
      projects: [{
        id: 'modal-race-project', name: '모달 경합 확인 프로젝트', description: '', status: 'active',
        owner_id: 'e2e-test-user', owner_name: '김대호', canManage: true,
        member_count: 1, member_names: '김대호', task_count: 0, done_task_count: 0,
      }],
    });
    await setup(page, state);

    let releaseChecklist!: () => void;
    const checklistGate = new Promise<void>(resolve => { releaseChecklist = resolve; });
    let checklistDelivered = false;
    await page.route(`**/api/peakos/collaboration/events/${eventId}/checklist`, async route => {
      await checklistGate;
      checklistDelivered = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.locator('.nav-item[data-view="calendar"]').click();
    await page.locator(`#homeCalendarAgenda [data-event-detail="${eventId}"]`).first().click();
    await expect(page.locator('#readonlyModalBody')).toContainText('체크리스트를 불러오는 중입니다');
    await page.locator('#readonlyModalClose').click();

    await page.locator('.nav-item[data-view="review"]').click();
    await page.locator('[data-collab-project-create]').click();
    const projectForm = page.locator('#collaborationProjectForm');
    await expect(projectForm).toBeVisible();
    await projectForm.locator('[name="name"]').fill('늦은 일정 응답이 덮으면 안 되는 프로젝트');

    releaseChecklist();
    await expect.poll(() => checklistDelivered).toBeTruthy();
    await expect(projectForm).toBeVisible();
    await expect(projectForm.locator('[name="name"]')).toHaveValue('늦은 일정 응답이 덮으면 안 되는 프로젝트');
    await expect(page.locator('#readonlyModalBody')).not.toContainText('느린 체크리스트 일정');
  });

  test('automatic report review reminders stay on the calendar but never enter personal todo surfaces', async ({ page }) => {
    const date = todayKey();
    const state = createState({
      events: [
        {
          id: 'auto-daily-report-review', type: 'todo', title: '📄 전현우 보고서 확인', date, time: '',
          todo_cat: '보고서', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호',
          sort_order: 1, done: false, deleted: false,
        },
        {
          id: 'auto-work-report-review', type: 'todo', title: '📋 손명아 업무보고 확인', date,
          time: '09:00', end_time: '09:30', todo_cat: '보고서', scope: 'personal',
          owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 2, done: false, deleted: false,
        },
        {
          id: 'manual-same-category-title', type: 'todo', title: '전현우 보고서 확인', date, time: '',
          todo_cat: '보고서', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호',
          sort_order: 10, done: false, deleted: false,
        },
        {
          id: 'manual-report-prep', type: 'todo', title: '보고서 자료 정리', date,
          time: '13:00', end_time: '14:00', todo_cat: '보고서', scope: 'personal',
          owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 20, done: false, deleted: false,
        },
        {
          id: 'report-writing-reminder', type: 'todo', title: '📝 일일 보고서 작성', date, time: '',
          todo_cat: '보고서', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호',
          sort_order: 30, done: false, deleted: false,
        },
        {
          id: 'completed-personal-task', type: 'todo', title: '완료한 직접 투두', date, time: '',
          todo_cat: '기획', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호',
          sort_order: 40, done: true, deleted: false,
        },
      ],
      todos: [
        standaloneTodo({ id: 'manual-same-category-title', title: '전현우 보고서 확인', date, category: '보고서', sortOrder: 10 }),
        standaloneTodo({ id: 'manual-report-prep', title: '보고서 자료 정리', date, startTime: '13:00', endTime: '14:00', category: '보고서', sortOrder: 20 }),
        standaloneTodo({ id: 'report-writing-reminder', title: '📝 일일 보고서 작성', date, category: '보고서', sortOrder: 30 }),
        standaloneTodo({ id: 'completed-personal-task', title: '완료한 직접 투두', date, category: '기획', sortOrder: 40, done: true }),
      ],
      projects: [{
        id: 'report-filter-project', name: '보고서 필터 영향 확인 프로젝트', status: 'active', owner_name: '김대호',
        tasks: [{
          id: 'report-filter-project-task', project_id: 'report-filter-project', title: '프로젝트 정상 업무',
          status: 'todo', assignment_mode: 'single', assignee_uid: 'e2e-test-user', assignee_name: '김대호',
          assignees: [{ uid: 'e2e-test-user', name: '김대호', completed: false }],
          permissions: { canRequestReview: true },
        }],
      }],
    });
    await setup(page, state);

    // The source records remain in the shared calendar and report workflow.
    await page.locator('.nav-item[data-view="calendar"]').click();
    const todayCell = page.locator(`#homeCalendarGrid [data-date="${date}"]`);
    await expect(todayCell).toContainText('📄 전현우 보고서 확인');
    await expect(todayCell).toContainText('📋 손명아 업무보고 확인');
    await expect(page.locator('#homeCalendarAgenda [data-event-detail="auto-daily-report-review"]').first()).toBeVisible();
    await expect(page.locator('#homeCalendarAgenda [data-event-detail="auto-work-report-review"]').first()).toBeVisible();

    // Dashboard와 배지는 legacy 이벤트가 아닌 명시적 standalone 컬렉션만 읽는다.
    await page.locator('.nav-item[data-view="dashboard"]').click();
    const dashboardTasks = page.locator('.executive-metric-card.tasks');
    await expect(dashboardTasks.locator(':scope > strong')).toHaveText('4건');
    await expect(dashboardTasks).toContainText('1건 완료 · 3건 남음');
    await expect(page.locator('.executive-list')).not.toContainText('📄 전현우 보고서 확인');
    await expect(page.locator('.executive-list')).not.toContainText('📋 손명아 업무보고 확인');
    await expect(page.locator('.nav-item[data-view="todo"] .nav-badge')).toHaveText('3');

    await page.locator('.nav-item[data-view="todo"]').click();
    const dashboard = page.locator('[data-todo-dashboard]');
    const capture = dashboard.locator('[data-todo-panel="capture"]');
    const list = dashboard.locator('[data-todo-panel="list"]');
    await expect(list.locator('[data-personal-todo-id]')).toHaveCount(4);
    await expect(list.locator('[data-personal-todo-id="auto-daily-report-review"]')).toHaveCount(0);
    await expect(list.locator('[data-personal-todo-id="auto-work-report-review"]')).toHaveCount(0);
    await expect(list.locator('[data-personal-todo-id="manual-same-category-title"]')).toContainText('전현우 보고서 확인');
    await expect(list.locator('[data-personal-todo-id="manual-report-prep"]')).toContainText('보고서 자료 정리');
    await expect(list.locator('[data-personal-todo-id="report-writing-reminder"]')).toContainText('📝 일일 보고서 작성');
    await expect(capture.locator('[data-todo-capture-item]')).toHaveCount(2);
    await expect(capture).not.toContainText('📄 전현우 보고서 확인');
    await expect(capture).not.toContainText('📋 손명아 업무보고 확인');
    await expect(dashboard.locator('[data-todo-progress]')).toHaveAttribute('aria-valuenow', '25');
    await expect(dashboard.locator('[data-todo-stat="all"] strong')).toHaveText('4');
    await expect(dashboard.locator('[data-todo-stat="remaining"] strong')).toHaveText('3');
    await expect(dashboard.locator('[data-todo-stat="scheduled"] strong')).toHaveText('1');
    await expect(dashboard.locator('[data-todo-stat="complete"] strong')).toHaveText('1');

    await expect(dashboard).not.toContainText('보고서 필터 영향 확인 프로젝트');
    await expect(dashboard).not.toContainText('프로젝트 정상 업무');
    await expect(dashboard.locator('[data-project-todo-id], [data-todo-panel="project"]')).toHaveCount(0);
    expect(state.calls.some(call => call.path === '/peakos/collaboration/projects/my-tasks')).toBe(false);
  });

  const todoVisualViewports = [
    { label: '1440', width: 1440, height: 900 },
    { label: '768', width: 768, height: 900 },
    { label: '390', width: 390, height: 844 },
    ...(process.env.PEAKOS_TODO_MID_GEOMETRY === '1' ? [
      { label: '1200', width: 1200, height: 900 },
      { label: '1100', width: 1100, height: 900 },
    ] : []),
  ];
  for (const viewport of todoVisualViewports) {
    for (const theme of ['light', 'dark'] as const) {
      test(`two-panel todo dashboard fits ${viewport.label}px in ${theme} theme`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const date = todayKey();
        const deadline = addDaysKey(date, 2);
        const state = createState({
          events: [{
            id: `responsive-personal-${viewport.label}-${theme}`, type: 'todo', title: '반응형 개인 업무', date,
            time: '17:30', end_time: '19:00', scope: 'personal', owner_id: 'e2e-test-user',
            owner_name: '김대호', sort_order: 10, done: false, deleted: false,
          }, {
            id: `responsive-completed-${viewport.label}-${theme}`, type: 'todo', title: '완료한 반응형 개인 업무', date,
            time: '09:00', end_time: '10:00', todo_cat: '완료 검증', scope: 'personal', owner_id: 'e2e-test-user',
            owner_name: '김대호', sort_order: 20, done: true, deleted: false,
          }],
          todos: [
            standaloneTodo({
              id: `responsive-personal-${viewport.label}-${theme}`, title: '반응형 개인 업무', date,
              startTime: '17:30', endTime: '19:00', sortOrder: 10,
            }),
            standaloneTodo({
              id: `responsive-completed-${viewport.label}-${theme}`, title: '완료한 반응형 개인 업무', date,
              startTime: '09:00', endTime: '10:00', category: '완료 검증', sortOrder: 20, done: true,
            }),
          ],
          projects: [{
            id: `responsive-project-${viewport.label}-${theme}`, name: '반응형 프로젝트', status: 'active', owner_name: '김대호',
            tasks: [{
              id: `responsive-project-task-${viewport.label}-${theme}`,
              project_id: `responsive-project-${viewport.label}-${theme}`,
              title: '긴 화면에서도 실제 메타데이터가 잘리는지 확인하는 프로젝트 업무',
              status: 'todo', due_date: deadline, assignment_mode: 'single',
              assignee_uid: 'e2e-test-user', assignee_name: '김대호',
              assignees: [{ uid: 'e2e-test-user', name: '김대호', completed: false }],
              role_label: '화면 검수', permissions: { canRequestReview: true },
            }],
          }],
        });
        await setup(page, state);
        await page.locator('.nav-item[data-view="todo"]').click();
        if (theme === 'dark') await page.locator('#themeToggle').click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

        const surface = page.locator('[data-todo-dashboard]');
        const capture = surface.locator('[data-todo-panel="capture"]');
        const list = surface.locator('[data-todo-panel="list"]');
        await expect(surface).toBeVisible();
        await expect(surface.locator('[data-todo-panel]')).toHaveCount(2);
        await expect(capture).toBeVisible();
        await expect(list).toBeVisible();
        await expect(surface.locator('[data-project-todo-id], [data-todo-panel="project"]')).toHaveCount(0);
        await expect(surface).not.toContainText('긴 화면에서도 실제 메타데이터가 잘리는지 확인하는 프로젝트 업무');

        const screenshot = await page.screenshot({ fullPage: true });
        await testInfo.attach(`two-panel-todo-${viewport.label}-${theme}`, {
          body: screenshot, contentType: 'image/png',
        });
        const visualDir = process.env.PEAKOS_COMPACT_TODO_VISUAL_DIR;
        if (visualDir) {
          fs.mkdirSync(visualDir, { recursive: true });
          fs.writeFileSync(path.join(visualDir, `two-panel-todo-${viewport.label}-${theme}.png`), screenshot);
        }

        const geometry = await surface.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const visibleRows = [...element.querySelectorAll<HTMLElement>('.todo-dashboard-task-row')]
            .filter(row => row.offsetParent !== null)
            .map(row => {
              const rowRect = row.getBoundingClientRect();
              return { left: rowRect.left, right: rowRect.right, width: rowRect.width };
            });
          return {
            surface: { left: rect.left, right: rect.right, width: rect.width },
            visibleRows,
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            background: getComputedStyle(element).backgroundColor,
          };
        });
        expect(geometry.surface.width).toBeGreaterThan(0);
        expect(geometry.visibleRows).toHaveLength(2);
        for (const row of geometry.visibleRows) {
          expect(row.width).toBeGreaterThan(0);
          expect(row.left).toBeGreaterThanOrEqual(geometry.surface.left - 1);
          expect(row.right).toBeLessThanOrEqual(geometry.surface.right + 1);
        }
        expect(geometry.overflow).toBeLessThanOrEqual(1);
        if (theme === 'dark') expect(geometry.background).not.toBe('rgb(255, 255, 255)');

        if (theme === 'dark') {
          const contrastSamples = await page.locator('#todoView').evaluate(root => {
            type Colour = { r: number; g: number; b: number; a: number };
            const parseColour = (value: string): Colour => {
              const values = value.match(/[\d.]+/g)?.map(Number) || [];
              return { r: values[0] || 0, g: values[1] || 0, b: values[2] || 0, a: values.length > 3 ? values[3] : 1 };
            };
            const blend = (top: Colour, bottom: Colour): Colour => {
              const alpha = top.a + bottom.a * (1 - top.a);
              if (!alpha) return { r: 0, g: 0, b: 0, a: 0 };
              return {
                r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / alpha,
                g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / alpha,
                b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / alpha,
                a: alpha,
              };
            };
            const backgroundFor = (element: Element) => {
              const layers: Colour[] = [];
              for (let current: Element | null = element; current; current = current.parentElement) {
                layers.push(parseColour(getComputedStyle(current).backgroundColor));
              }
              return layers.reverse().reduce((background, layer) => blend(layer, background), { r: 255, g: 255, b: 255, a: 1 });
            };
            const channel = (value: number) => {
              const normalized = value / 255;
              return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
            };
            const luminance = (colour: Colour) => 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b);
            const contrastFor = (element: Element, foregroundValue = getComputedStyle(element).color) => {
              const background = backgroundFor(element);
              const foreground = blend(parseColour(foregroundValue), background);
              const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
              return {
                ratio: (values[0] + 0.05) / (values[1] + 0.05),
                foreground: foregroundValue,
                background: `rgb(${Math.round(background.r)}, ${Math.round(background.g)}, ${Math.round(background.b)})`,
              };
            };
            const targets = [
              ['toolbar title', '.todo-dashboard-toolbar > strong'],
              ['selected date', '[data-todo-selected-date]'],
              ['progress label', '.todo-dashboard-progress > div > span'],
              ['progress value', '.todo-dashboard-progress > div > strong'],
              ['stat label', '[data-todo-stat] > span'],
              ['stat value', '[data-todo-stat] > strong'],
              ['stat detail', '[data-todo-stat] > small'],
              ['panel kicker', '.todo-dashboard-panel > header > div > span'],
              ['panel title', '.todo-dashboard-panel > header > div > strong'],
              ['panel count', '.todo-dashboard-panel > header > em'],
              ['completed row title', '.todo-dashboard-task-row.done .daily-plan-task-open strong'],
              ['completed row metadata', '.todo-dashboard-task-row.done .daily-plan-task-open small'],
              ['row status', '.todo-dashboard-task-state'],
            ] as const;
            const samples = targets.flatMap(([label, selector]) => {
              const elements = [...root.querySelectorAll(selector)];
              if (!elements.length) return [{ label, text: 'MISSING', ratio: 0, foreground: '', background: '' }];
              return elements.map((element, index) => ({
                label: `${label} ${index + 1}`,
                text: String(element.textContent || '').trim(),
                ...contrastFor(element),
              }));
            });
            const captureInput = root.querySelector('[data-todo-capture] textarea');
            if (!captureInput) {
              samples.push({ label: 'capture placeholder', text: 'MISSING', ratio: 0, foreground: '', background: '' });
            } else {
              const placeholder = getComputedStyle(captureInput, '::placeholder').color;
              samples.push({
                label: 'capture placeholder',
                text: captureInput.getAttribute('placeholder') || '',
                ...contrastFor(captureInput, placeholder),
              });
            }
            return samples;
          });
          for (const sample of contrastSamples) {
            expect(sample.ratio, `${sample.label} (${sample.text}) ${sample.foreground} on ${sample.background}`).toBeGreaterThanOrEqual(4.5);
          }
          if (process.env.PEAKOS_COMPACT_TODO_VISUAL_DIR) {
            console.log(`[compact-todo-contrast:${viewport.label}] ${JSON.stringify(contrastSamples.map(sample => ({
              label: sample.label, text: sample.text, ratio: Number(sample.ratio.toFixed(2)),
              foreground: sample.foreground, background: sample.background,
            })))}`);
          }
        }

        const [surfaceBox, captureBox, listBox] = await Promise.all([
          surface.boundingBox(), capture.boundingBox(), list.boundingBox(),
        ]);
        expect(surfaceBox).not.toBeNull();
        expect(captureBox).not.toBeNull();
        expect(listBox).not.toBeNull();
        for (const panelBox of [captureBox!, listBox!]) {
          expect(panelBox.x).toBeGreaterThanOrEqual(surfaceBox!.x - 1);
          expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(surfaceBox!.x + surfaceBox!.width + 1);
        }
        if (viewport.width > 1240) {
          expect(listBox?.x || 0).toBeGreaterThan((captureBox?.x || 0) + (captureBox?.width || 0) - 2);
          expect(Math.abs((captureBox?.y || 0) - (listBox?.y || 0))).toBeLessThan(4);
        } else {
          expect(listBox?.y || 0).toBeGreaterThan((captureBox?.y || 0) + (captureBox?.height || 0) - 2);
        }
        await expect(surface.locator('[data-todo-progress]')).toHaveAttribute('aria-valuenow', '50');
        const completedRow = list.locator(`[data-personal-todo-id="responsive-completed-${viewport.label}-${theme}"]`);
        await expect(completedRow).toHaveClass(/done/);
        await expect(completedRow).toHaveCSS('opacity', '1');
        await expect(completedRow.locator('.todo-dashboard-task-state')).toHaveText('완료');
        await expect(completedRow.locator('input').nth(0)).toHaveValue('09:00');
        await expect(completedRow.locator('input').nth(0)).toBeDisabled();
        await expect(completedRow.locator('input').nth(1)).toHaveValue('10:00');
        await expect(completedRow.locator('input').nth(1)).toBeDisabled();

        if (viewport.width === 390) {
          for (const control of [
            page.locator('[data-todo-date-prev]'),
            page.locator('[data-todo-date-next]'),
            page.locator(`[data-personal-todo-id="responsive-personal-${viewport.label}-${theme}"] .todo-task-check`),
            page.locator(`[data-personal-todo-id="responsive-completed-${viewport.label}-${theme}"] .todo-task-check`),
            page.locator('[data-todo-capture] button[type="submit"]'),
            page.locator(`[data-daily-timeline-id="responsive-personal-${viewport.label}-${theme}"] [data-todo-time]`),
            page.locator(`[data-daily-timeline-id="responsive-personal-${viewport.label}-${theme}"] [data-todo-end-time]`),
            page.locator(`[data-daily-timeline-id="responsive-personal-${viewport.label}-${theme}"] [data-todo-time-save]`),
          ]) {
            const box = await control.boundingBox();
            expect(box).not.toBeNull();
            expect(box!.height).toBeGreaterThanOrEqual(44);
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
        }
      });
    }
  }

  test('a branch todo dashboard reads only that workspace personal records', async ({ page }) => {
    const date = todayKey();
    const state = createState({
      events: [{
        id: 'peak-private-task', type: 'todo', title: '본사 전용 개인 업무', date,
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false,
      }],
      todos: [standaloneTodo({ id: 'peak-private-task', title: '본사 전용 개인 업무', date })],
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
          todos: [standaloneTodo({ id: 'daegu-personal-task', title: '대구지사 개인 업무', date })],
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

    await expect(page.locator('[data-todo-dashboard] [data-todo-panel]')).toHaveCount(2);
    await expect(page.locator('[data-personal-todo-id="daegu-personal-task"]')).toBeVisible();
    await expect(page.locator('[data-personal-todo-id="daegu-personal-task"]')).toContainText('대구지사 개인 업무');
    await expect(page.locator('#todoView')).not.toContainText('대구지사 프로젝트');
    await expect(page.locator('#todoView')).not.toContainText('대구지사 프로젝트 업무');
    await expect(page.locator('#todoView')).not.toContainText('본사 전용 개인 업무');
    await expect(page.locator('#todoView')).not.toContainText('본사 전용 프로젝트 업무');
    await expect(page.locator('.nav-item[data-view="todo"] .nav-badge')).toHaveText('1');
    const todoReads = state.calls.filter(call => call.method === 'GET' && call.path === '/peakos/todos');
    expect(todoReads.length).toBeGreaterThanOrEqual(1);
    expect(todoReads.every(call => call.workspace === 'daegu')).toBe(true);
    expect(state.calls.some(call => call.path === '/peakos/collaboration/projects/my-tasks')).toBe(false);
  });

  test('Korea New Year loads and renders the new Korean calendar year', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-12-31T15:05:00.000Z') });
    const state = createState({
      events: [{
        id: 'new-year', type: 'todo', title: '새해 첫 할 일', date: '2027-01-01', time: '',
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', sort_order: 10,
        done: false, deleted: false,
      }],
      todos: [standaloneTodo({ id: 'new-year', title: '새해 첫 할 일', date: '2027-01-01', sortOrder: 10 })],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();

    await expect(page.locator('[data-todo-selected-date]')).toHaveAttribute('datetime', '2027-01-01');
    await expect(page.locator('#todoView')).toContainText('새해 첫 할 일');
    expect(state.calls.some(call =>
      call.method === 'GET'
      && call.path === '/peakos/todos'
      && call.search === '?date=2027-01-01'
    )).toBe(true);
  });

  test('a draft opened before Korean midnight stays on its explicitly selected day', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-12-31T14:59:30.000Z') });
    const state = createState();
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();
    await expect(page.locator('[data-todo-selected-date]')).toHaveAttribute('datetime', '2026-12-31');
    const capture = page.locator('[data-todo-capture]');
    await capture.locator('[name="title"]').fill('선택 날짜에 남을 할 일');

    await page.clock.setFixedTime(new Date('2026-12-31T15:00:30.000Z'));
    await capture.getByRole('button', { name: '＋ 적기' }).click();

    await expect(page.locator('[data-todo-selected-date]')).toHaveAttribute('datetime', '2026-12-31');
    expect(state.todos?.find(todo => todo.title === '선택 날짜에 남을 할 일')).toMatchObject({
      date: '2026-12-31', startTime: '', version: 1,
    });
  });

  test('the five-second sync preserves a todo draft and focused button until focus leaves the view', async ({ page }) => {
    const state = createState();
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();
    const draft = page.locator('[data-todo-capture] [name="title"]');
    await draft.fill('자동 동기화에도 남아야 하는 생각');
    const readsBefore = state.calls.filter(call =>
      call.method === 'GET' && call.path === '/peakos/todos'
    ).length;
    const projectReadsBefore = state.calls.filter(call =>
      call.method === 'GET' && call.path === '/peakos/collaboration/projects/my-tasks'
    ).length;

    await page.waitForTimeout(5_400);
    await expect(draft).toHaveValue('자동 동기화에도 남아야 하는 생각');
    expect(state.calls.filter(call =>
      call.method === 'GET' && call.path === '/peakos/todos'
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
      call.method === 'GET' && call.path === '/peakos/todos'
    )).toHaveLength(readsBefore);
    expect(state.calls.filter(call =>
      call.method === 'GET' && call.path === '/peakos/collaboration/projects/my-tasks'
    )).toHaveLength(projectReadsBefore);

    await page.locator('#personaSelect').focus();
    await expect(page.locator('#personaSelect')).toBeFocused();
    await page.waitForTimeout(5_400);
    await expect(draft).toHaveValue('자동 동기화에도 남아야 하는 생각');
    expect(state.calls.filter(call =>
      call.method === 'GET' && call.path === '/peakos/todos'
    ).length).toBeGreaterThan(readsBefore);
    expect(state.calls.filter(call =>
      call.method === 'GET' && call.path === '/peakos/collaboration/projects/my-tasks'
    )).toHaveLength(projectReadsBefore);
  });

  test('standalone OS todo and legacy Paragon events never round-trip through one shared state', async ({ page }) => {
    const state = createState();
    await setup(page, state);
    await addTodo(page, 'OS에서 등록한 할 일');

    const legacyRows = await page.evaluate(async () => {
      const response = await fetch('/api/events', { headers: { Authorization: 'Bearer e2e-token' } });
      return response.json();
    });
    expect(legacyRows.map((row: any) => row.title)).not.toContain('OS에서 등록한 할 일');
    expect(state.todos?.map(row => row.title)).toContain('OS에서 등록한 할 일');

    await page.evaluate(async date => {
      await fetch('/api/events', {
        method: 'POST',
        headers: { Authorization: 'Bearer e2e-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'todo', title: '기존 파라곤에서 등록', date, scope: 'personal' }),
      });
    }, todayKey());

    // 할 일 폴링은 전용 저장소만 다시 읽으므로 legacy 변경이 유입되지 않는다.
    await page.waitForTimeout(5_400);
    await expect(page.locator('#todoView')).not.toContainText('기존 파라곤에서 등록');
    expect(state.calls.some(call => call.method !== 'GET'
      && call.path.startsWith('/peakos/collaboration/events'))).toBe(false);
  });

  for (const viewport of [
    { label: 'desktop', width: 1280, height: 800 },
    { label: 'mobile', width: 390, height: 844 },
  ]) {
    test(`${viewport.label} workspace writer hides one event only from OS without deleting the legacy row`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const date = todayKey();
      const event = {
        id: `os-hide-${viewport.label}`, type: 'event', title: `${viewport.label} OS 숨김 계약`, date,
        time: '10:30', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호',
        done: false, deleted: false,
      };
      const state = createState({ events: [event] });
      await setup(page, state);
      if (viewport.label === 'mobile') {
        await page.locator('.nav-item[data-view="calendar"]').click();
      }

      await expect(page.locator('#calendarView')).toContainText(event.title);
      await expect(page.locator('#calendarView > .permission-stats[aria-label="월간 일정 요약"]')).toHaveCount(0);
      await expect(page.locator('#calendarView > section').first()).toHaveAttribute('id', 'companyCalendar');
      await expect(page.locator('#permissionsView .permission-stats[aria-label="권한 구성 요약"]')).toHaveCount(1);

      const form = await openCalendarEventEditor(page, event.id);
      await expect(form.locator('[data-collab-event-hide]')).toHaveText('OS에서 숨기기');
      await expect(form.locator('[data-collab-event-delete]')).toHaveCount(0);
      if (viewport.label === 'mobile') {
        const hideBox = await form.locator('[data-collab-event-hide]').boundingBox();
        expect(hideBox?.height || 0).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }

      let confirmation = '';
      page.once('dialog', async dialog => {
        confirmation = dialog.message();
        await dialog.accept();
      });
      await form.locator('[data-collab-event-hide]').click();

      expect(confirmation).toBe('이 일정을 OS의 모든 구성원에게서 숨길까요? 기존 파라곤 일정은 삭제되지 않습니다.');
      await expect(page.locator('.toast')).toHaveText('OS에서 숨겼습니다. 기존 파라곤 일정은 유지됩니다.');
      await expect(page.locator('#calendarView')).not.toContainText(event.title);

      const hideCall = state.calls.find(call => call.method === 'POST'
        && call.path === `/peakos/collaboration/events/${event.id}/os-hide`);
      expect(hideCall).toMatchObject({ workspace: 'peak', preview: '0', body: null });
      expect(state.osHiddenEventIds.peak).toEqual([event.id]);
      expect(event.deleted).toBe(false);
      expect(state.calls.some(call => call.method === 'PUT'
        && call.path.endsWith(`/events/${event.id}`)
        && call.body?.deleted === true)).toBe(false);

      const legacyRows = await page.evaluate(async () => {
        const response = await fetch('/api/events', { headers: { Authorization: 'Bearer e2e-token' } });
        return response.json();
      });
      expect(legacyRows).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: event.id, deleted: false }),
      ]));
    });
  }

  test('calendar polling removes an event hidden by another OS user without a reload', async ({ page }) => {
    const date = todayKey();
    const event = {
      id: 'poll-hidden-event', type: 'event', title: '다른 구성원이 숨긴 일정', date,
      scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false,
    };
    const state = createState({ events: [event] });
    await setup(page, state);
    await expect(page.locator('#calendarView')).toContainText(event.title);
    const readsBefore = state.calls.filter(call => call.method === 'GET'
      && call.path === '/peakos/collaboration/events').length;

    state.osHiddenEventIds.peak = [event.id];

    await expect(page.locator('#calendarView')).not.toContainText(event.title, { timeout: 7_500 });
    expect(state.calls.filter(call => call.method === 'GET'
      && call.path === '/peakos/collaboration/events').length).toBeGreaterThan(readsBefore);
    expect(event.deleted).toBe(false);
  });

  test('legacy event deletion keeps its original PUT deleted semantics and never creates an OS hide', async ({ page }) => {
    const date = todayKey();
    const event = {
      id: 'legacy-delete-event', type: 'event', title: '기존 파라곤 삭제 계약', date,
      scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false,
    };
    const state = createState({ events: [event] });
    await setup(page, state, '/business-os-preview.html');
    await expect(page.locator('#calendarView')).toContainText(event.title);

    const form = await openCalendarEventEditor(page, event.id);
    await expect(form.locator('[data-collab-event-delete]')).toHaveText('삭제');
    await expect(form.locator('[data-collab-event-hide]')).toHaveCount(0);
    page.once('dialog', dialog => dialog.accept());
    await form.locator('[data-collab-event-delete]').click();

    await expect(page.locator('#calendarView')).not.toContainText(event.title);
    expect(event.deleted).toBe(true);
    expect(state.osHiddenEventIds).toEqual({});
    expect(state.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'PUT', path: `/peakos/collaboration/events/${event.id}`, body: { deleted: true }, workspace: '',
      }),
    ]));
    expect(state.calls.some(call => call.path.endsWith(`/events/${event.id}/os-hide`))).toBe(false);
  });

  for (const workspaceRole of ['member', 'oversight'] as const) {
    test(`${workspaceRole} read-only workspace never exposes or issues OS hide mutations`, async ({ page }) => {
      const date = todayKey();
      const event = {
        id: `readonly-${workspaceRole}`, type: 'event', title: `${workspaceRole} 열람 일정`, date,
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false,
      };
      const state = createState({
        events: [event],
        workspaceRole,
        calendarPermission: 'read',
        user: {
          ...createState().user,
          role: workspaceRole === 'oversight' ? 'admin' : 'member',
        },
      });
      await setup(page, state, workspaceRole === 'oversight' ? '/os/w/peak' : '/os/');
      await expect(page.locator('[data-collab-event-hide]')).toHaveCount(0);
      expect(state.calls.some(call => call.method === 'POST' && call.path.endsWith('/os-hide'))).toBe(false);
    });
  }

  for (const accessCase of [
    { label: 'non-owner', ownerId: 'other-user', permission: 'write' as const },
    { label: 'read-only workspace', ownerId: 'e2e-test-user', permission: 'read' as const },
  ]) {
    test(`${accessCase.label} can read a time range but cannot edit or save it`, async ({ page }) => {
      const date = todayKey();
      const event = {
        id: `range-${accessCase.label}`, type: 'event', title: `${accessCase.label} 시간 범위`, date,
        time: '17:30:00', end_time: '19:00', scope: 'personal',
        owner_id: accessCase.ownerId, owner_name: accessCase.ownerId === 'other-user' ? '박우진' : '김대호',
        done: false, deleted: false,
      };
      const state = createState({
        events: [event], workspaceRole: 'member', calendarPermission: accessCase.permission,
        user: { ...createState().user, role: 'member' },
      });
      await setup(page, state, '/os/w/peak');
      await page.locator(`#homeCalendarAgenda [data-event-detail="${event.id}"]`).first().click();
      await expect(page.locator('#readonlyModalBody')).toContainText('오후 5:30 ~ 오후 7:00');
      await expect(page.locator('#readonlyModalBody [data-collab-event-edit]')).toHaveCount(0);
      expect(state.calls.some(call => call.method !== 'GET' && call.path.endsWith(`/events/${event.id}`))).toBe(false);
    });
  }

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
    await page.locator('#homeCalendarAgenda [data-collab-add-todo]').click();
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

  test('read-only range exposes disabled start, end, and apply with no writes', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const date = todayKey();
    const state = createState({
      events: [{ id: 'audit-readonly-range', type: 'todo', title: '읽기 전용 시간 범위', date, time: '17:30', end_time: '19:00', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false }],
      todos: [standaloneTodo({ id: 'audit-readonly-range', title: '읽기 전용 시간 범위', date, startTime: '17:30', endTime: '19:00' })],
      workspaceRole: 'member',
      calendarPermission: 'read',
      user: { ...createState().user, role: 'member' },
    });
    await setup(page, state, '/os/w/peak');
    await page.locator('.nav-item[data-view="todo"]').click();
    const row = page.locator('[data-daily-timeline-id="audit-readonly-range"]');
    const start = row.getByRole('textbox', { name: '읽기 전용 시간 범위 시작 시간' });
    const end = row.getByRole('textbox', { name: '읽기 전용 시간 범위 종료 시간' });
    const apply = row.getByRole('button', { name: '적용', exact: true });
    await expect(start).toHaveValue('17:30');
    await expect(end).toHaveValue('19:00');
    await expect(start).toBeDisabled();
    await expect(end).toBeDisabled();
    await expect(apply).toBeDisabled();
    const sizes = await row.locator('input, .daily-timeline-save').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    expect(sizes).toEqual([44, 44, 44]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    expect(state.calls.some(call => call.method !== 'GET' && call.path === '/peakos/todos/audit-readonly-range')).toBe(false);
  });

  test('focused range draft survives polling and stale pre-save response cannot overwrite applied range', async ({ page }) => {
    const date = todayKey();
    const state = createState({
      events: [{ id: 'audit-poll-range', type: 'todo', title: '폴링 시간 범위', date, time: '17:30', end_time: '', scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false, deleted: false }],
      todos: [standaloneTodo({ id: 'audit-poll-range', title: '폴링 시간 범위', date, startTime: '17:30' })],
    });
    await setup(page, state);
    await page.locator('.nav-item[data-view="todo"]').click();
    const row = page.locator('[data-daily-timeline-id="audit-poll-range"]');
    const start = row.locator('[data-todo-time]');
    const end = row.locator('[data-todo-end-time]');
    await start.fill('17:30');
    await end.fill('19:00');
    const patchesBeforeDraft = state.calls.filter(call => call.method === 'PATCH' && call.path === '/peakos/todos/audit-poll-range').length;
    await page.waitForTimeout(5_400);
    await expect(start).toHaveValue('17:30');
    await expect(end).toHaveValue('19:00');
    expect(state.calls.filter(call => call.method === 'PATCH' && call.path === '/peakos/todos/audit-poll-range')).toHaveLength(patchesBeforeDraft);

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForTimeout(1_200);
    const staleItems = state.todos.map(todo => ({ ...todo }));
    let staleStarted = 0;
    let staleDelivered = 0;
    let releaseStale!: () => void;
    const staleGate = new Promise<void>(resolve => { releaseStale = resolve; });
    await page.route(/\/api\/peakos\/todos\?/, async route => {
      if (route.request().method() !== 'GET' || staleStarted > 0) return route.fallback();
      staleStarted += 1;
      await staleGate;
      const dateParam = new URL(route.request().url()).searchParams.get('date');
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          date: dateParam, timeZone: 'Asia/Seoul', readOnly: false,
          capabilities: { create: true, edit: true, reorder: true, archive: true }, items: staleItems,
        }),
      });
      staleDelivered += 1;
    });
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await expect.poll(() => staleStarted).toBe(1);
    const todoReadCount = () => state.calls.filter(call => call.method === 'GET'
      && call.path === '/peakos/todos' && call.search.startsWith('?date=')).length;
    const readsBeforeSave = todoReadCount();
    await row.locator('[data-todo-time-save]').click();
    await expect.poll(() => state.calls.filter(call => call.method === 'PATCH'
      && call.path === '/peakos/todos/audit-poll-range').length).toBe(1);
    // Wait for the post-save canonical GET/render first. Only then release the
    // older polling response so this test exercises the harmful completion order.
    await expect.poll(todoReadCount).toBeGreaterThan(readsBeforeSave);
    await expect(page.locator('[data-daily-timeline-id="audit-poll-range"] [data-todo-end-time]')).toHaveValue('19:00');
    releaseStale();
    await expect.poll(() => staleDelivered).toBe(1);
    await page.waitForTimeout(1_200);
    await expect(page.locator('[data-daily-timeline-id="audit-poll-range"] [data-todo-end-time]')).toHaveValue('19:00');
  });

});
