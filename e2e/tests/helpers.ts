import { Page } from '@playwright/test';
import { BASE_PRICES } from './base-prices';

// A minimal Firebase surface the page expects. Installed as an init-script
// so `window.firebase` already exists when the inline <script> in
// index.html runs its firebase.initializeApp / firebase.auth() calls.
export async function installFirebaseStub(page: Page) {
  // Block the real Firebase SDK so our stub wins. The page does not rely
  // on any post-load firebase features beyond what we stub below.
  await page.route('https://www.gstatic.com/firebasejs/**', route => {
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: '/* stubbed by e2e */',
    });
  });

  await page.addInitScript(() => {
    const listeners: Array<(u: any) => void> = [];
    const authTrace = {
      popupCalls: 0,
      redirectCalls: 0,
      signOutCalls: 0,
      providerParameters: [] as Array<Record<string, string>>,
    };
    (window as any).__e2eAuthTrace = authTrace;
    const fakeUser = {
      uid: 'e2e-test-user',
      email: 'e2e@test.local',
      displayName: 'E2E Test',
      getIdToken: async () => 'e2e-token',
    };
    const authStub: any = {
      currentUser: fakeUser,
      onAuthStateChanged(cb: (u: any) => void) {
        listeners.push(cb);
        Promise.resolve().then(() => cb(fakeUser));
        return () => {};
      },
      signInWithPopup: async (provider: any) => {
        authTrace.popupCalls += 1;
        authTrace.providerParameters.push({ ...(provider?.customParameters || {}) });
        authStub.currentUser = fakeUser;
        listeners.forEach(listener => listener(fakeUser));
        return { user: fakeUser };
      },
      signInWithRedirect: async (provider: any) => {
        authTrace.redirectCalls += 1;
        authTrace.providerParameters.push({ ...(provider?.customParameters || {}) });
      },
      getRedirectResult: async () => ({ user: null }),
      signOut: async () => {
        authTrace.signOutCalls += 1;
        authStub.currentUser = null;
        listeners.forEach(listener => listener(null));
      },
    };
    const messagingStub: any = {
      onMessage: () => () => {},
      getToken: async () => '',
      deleteToken: async () => true,
      onTokenRefresh: () => () => {},
    };
    function GoogleAuthProvider(this: any) {
      this.customParameters = {};
      this.setCustomParameters = (parameters: Record<string, string>) => {
        this.customParameters = { ...this.customParameters, ...parameters };
        return this;
      };
    }
    (authStub as any).setPersistence = async () => {};
    const AuthNS = {
      Persistence: { LOCAL: 'LOCAL', SESSION: 'SESSION', NONE: 'NONE' },
    };
    (window as any).firebase = {
      initializeApp: () => ({}),
      auth: Object.assign(() => authStub, { GoogleAuthProvider, Auth: AuthNS }),
      messaging: Object.assign(() => messagingStub, { isSupported: async () => false }),
    };
  });
}

export type ApiStubState = {
  events: any[];
  ideas: any[];
  users: any[];
  chatRooms: any[];
  chatMessages: Record<string, any[]>;
  chatMembers: Record<string, any[]>;
  chatUnreadCounts: Record<string, number>;
  chatTyping?: Record<string, any[]>;
  chatRoomGroups?: any[];
  eventChecklist?: Record<string, any[]>;
  eventShares?: Record<string, string[]>;
  attendance?: any[];
  projects?: any[];
  groups?: any[];
};

export function defaultApiState(): ApiStubState {
  return {
    events: [],
    ideas: [],
    users: [{
      uid: 'e2e-test-user',
      name: 'E2E',
      email: 'e2e@test.local',
      role: 'admin',
      approved: true,
      is_active: true,
    }],
    chatRooms: [],
    chatMessages: {},
    chatMembers: {},
    chatUnreadCounts: {},
    chatTyping: {},
    chatRoomGroups: [],
    eventChecklist: {},
    eventShares: {},
    attendance: [],
    projects: [],
    groups: [],
  };
}

function canonicalStubEventPatch(body: any) {
  const patch = { ...(body || {}) };
  if (Object.prototype.hasOwnProperty.call(patch, 'endTime')) {
    patch.end_time = patch.endTime;
    delete patch.endTime;
  }
  return patch;
}

function canonicalStubEventResponse(event: any) {
  const row = canonicalStubEventPatch(event);
  if (!Object.prototype.hasOwnProperty.call(row, 'end_time')) row.end_time = null;
  return row;
}

// Route-based API stub. Uses a shared in-page state object so POSTs can
// see their writes on subsequent GETs.
export async function installApiStub(page: Page, initial: ApiStubState = defaultApiState()) {
  await page.addInitScript((state) => {
    (window as any).__e2e_api_state = state;
  }, initial);

  await page.route('**/api/**', async (route, request) => {
    const url = new URL(request.url());
    const pathname = url.pathname.replace(/^\/api/, '');
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()!) : null;

    const respond = (payload: any, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });

    try {
      if (pathname === '/chat-rooms' && method === 'GET') {
        const rooms = await page.evaluate(() => {
          const state = (window as any).__e2e_api_state || {};
          const getPreviewText = (message: any) => {
            if (!message) return null;
            if (message.image_url) return '사진을 보냈습니다';
            if (message.file_url) return message.file_name || '파일을 보냈습니다';
            const text = String(message.text || '');
            if (!text) return null;
            if (text.startsWith('[EVENT_SHARE]')) return '일정을 공유했습니다';
            if (text.startsWith('[NOTICE_SHARE]')) return '공지를 공유했습니다';
            if (text.startsWith('[IDEA_SHARE]')) return '아이디어를 공유했습니다';
            if (text.startsWith('[MEETING_BRIEF]')) return '회의 카드가 업데이트됐습니다';
            if (text.startsWith('[MEETING_ACTION]')) return '액션 아이템이 등록됐습니다';
            if (text.startsWith('[MEETING_ACTION_LINK]')) return '액션 아이템이 등록 처리됐습니다';
            return text.slice(0, 120);
          };
          const toTime = (value: any) => {
            const time = Date.parse(String(value || ''));
            return Number.isNaN(time) ? 0 : time;
          };
          return [...(state.chatRooms || [])]
            .map((room: any) => {
              const roomId = String(room.id);
              const group = (state.chatRoomGroups || []).find((g: any) => String(g.id) === String(room.group_id || ''));
              const messages = [...(state.chatMessages?.[roomId] || [])]
                .sort((left: any, right: any) => {
                  const timeDiff = toTime(left.created_at) - toTime(right.created_at);
                  if (timeDiff !== 0) return timeDiff;
                  return String(left.id || '').localeCompare(String(right.id || ''));
                });
              const lastMessage = messages[messages.length - 1] || null;
              return {
                ...room,
                member_count: Array.isArray(state.chatMembers?.[roomId]) ? state.chatMembers[roomId].length : 0,
                group_name: group?.name || room.group_name || null,
                group_color: group?.color || room.group_color || null,
                last_message_at: lastMessage?.created_at || null,
                last_message_sender: lastMessage?.name || null,
                last_message_text: getPreviewText(lastMessage),
              };
            })
            .sort((left: any, right: any) => {
              const timeDiff = toTime(right.last_message_at || right.created_at) - toTime(left.last_message_at || left.created_at);
              if (timeDiff !== 0) return timeDiff;
              return String(left.name || '').localeCompare(String(right.name || ''));
            });
        });
        return respond(rooms);
      }
      if (pathname === '/chat-rooms/unread' && method === 'GET') {
        const counts = await page.evaluate(() => ({ ...((window as any).__e2e_api_state?.chatUnreadCounts || {}) }));
        return respond(counts);
      }
      if (pathname === '/chat-room-groups' && method === 'GET') {
        const groups = await page.evaluate(() => {
          const state = (window as any).__e2e_api_state || {};
          const rooms = state.chatRooms || [];
          return [...(state.chatRoomGroups || [])].map((group: any) => ({
            ...group,
            room_count: rooms.filter((room: any) => String(room.group_id || '') === String(group.id)).length,
          }));
        });
        return respond({ canManage: true, groups });
      }
      if (pathname === '/chat-rooms/bulk/group' && method === 'PUT') {
        await page.evaluate((body) => {
          const state = (window as any).__e2e_api_state || {};
          const roomIds = new Set((body?.roomIds || []).map((id: any) => String(id)));
          const group = (state.chatRoomGroups || []).find((g: any) => String(g.id) === String(body?.groupId || ''));
          state.chatRooms = (state.chatRooms || []).map((room: any) => {
            if (!roomIds.has(String(room.id))) return room;
            if (!body?.groupId) return { ...room, group_id: null, group_name: null, group_color: null };
            return {
              ...room,
              group_id: String(body.groupId),
              group_name: group?.name || null,
              group_color: group?.color || null,
            };
          });
        }, body);
        return respond({ ok: true, updated: body?.roomIds?.length || 0, group_id: body?.groupId || null });
      }
      if (pathname === '/chat-rooms/bulk/request-delete' && method === 'POST') {
        await page.evaluate((body) => {
          const state = (window as any).__e2e_api_state || {};
          const roomIds = new Set((body?.roomIds || []).map((id: any) => String(id)));
          state.chatRooms = (state.chatRooms || []).map((room: any) => (
            roomIds.has(String(room.id))
              ? { ...room, delete_requested: true, delete_requested_by: 'e2e-test-user' }
              : room
          ));
        }, body);
        return respond({ ok: true, updated: body?.roomIds?.length || 0 });
      }
      if (pathname === '/chat-rooms/bulk/delete' && method === 'POST') {
        await page.evaluate((body) => {
          const state = (window as any).__e2e_api_state || {};
          const roomIds = new Set((body?.roomIds || []).map((id: any) => String(id)));
          state.chatRooms = (state.chatRooms || []).filter((room: any) => !roomIds.has(String(room.id)));
          for (const roomId of roomIds) {
            delete state.chatMessages?.[roomId as any];
            delete state.chatMembers?.[roomId as any];
            delete state.chatUnreadCounts?.[roomId as any];
          }
        }, body);
        return respond({ ok: true, deleted: body?.roomIds?.length || 0 });
      }
      if (/^\/chat-rooms\/[^/]+\/typing$/.test(pathname) && method === 'GET') {
        const roomId = pathname.split('/')[2];
        const users = await page.evaluate((roomId) => {
          const state = (window as any).__e2e_api_state || {};
          return [...(state.chatTyping?.[roomId] || [])].filter((user: any) => user.uid !== 'e2e-test-user');
        }, roomId);
        return respond({ users });
      }
      if (/^\/chat-rooms\/[^/]+\/typing$/.test(pathname) && method === 'POST') {
        const roomId = pathname.split('/')[2];
        await page.evaluate(({ roomId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          state.chatTyping = state.chatTyping || {};
          const others = (state.chatTyping[roomId] || []).filter((user: any) => user.uid !== 'e2e-test-user');
          state.chatTyping[roomId] = body?.typing
            ? [...others, { uid: 'e2e-test-user', name: 'E2E Test' }]
            : others;
        }, { roomId, body });
        return respond({ ok: true });
      }
      if (/^\/chat-rooms\/[^/]+\/messages$/.test(pathname) && method === 'GET') {
        const roomId = pathname.split('/')[2];
        const messages = await page.evaluate((roomId) => {
          const state = (window as any).__e2e_api_state || {};
          return [...(state.chatMessages?.[roomId] || [])].sort((left: any, right: any) => {
            const leftTime = Date.parse(String(left.created_at || '')) || 0;
            const rightTime = Date.parse(String(right.created_at || '')) || 0;
            if (leftTime !== rightTime) return leftTime - rightTime;
            return String(left.id || '').localeCompare(String(right.id || ''));
          });
        }, roomId);
        return respond(messages);
      }
      if (/^\/chat-rooms\/[^/]+\/messages$/.test(pathname) && method === 'POST') {
        const roomId = pathname.split('/')[2];
        const message = await page.evaluate(({ roomId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          const record = {
            id: `chat-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            text: String(body?.text || ''),
            uid: 'e2e-test-user',
            name: 'E2E Test',
            photo_url: '',
            image_url: '',
            file_url: '',
            file_name: '',
            room_id: roomId,
            created_at: new Date().toISOString(),
            mention_user_ids: Array.isArray(body?.mentionUserIds) ? [...body.mentionUserIds] : [],
          };
          state.chatMessages = state.chatMessages || {};
          state.chatMessages[roomId] = state.chatMessages[roomId] || [];
          state.chatMessages[roomId].push(record);
          state.chatUnreadCounts = state.chatUnreadCounts || {};
          state.chatUnreadCounts[roomId] = 0;
          return record;
        }, { roomId, body });
        return respond(message);
      }
      if (/^\/chat-rooms\/[^/]+\/members$/.test(pathname) && method === 'GET') {
        const roomId = pathname.split('/')[2];
        const members = await page.evaluate((roomId) => {
          const state = (window as any).__e2e_api_state || {};
          return [...(state.chatMembers?.[roomId] || [])];
        }, roomId);
        return respond(members);
      }
      if (/^\/chat-rooms\/[^/]+\/read$/.test(pathname) && method === 'POST') {
        const roomId = pathname.split('/')[2];
        await page.evaluate((roomId) => {
          const state = (window as any).__e2e_api_state || {};
          state.chatUnreadCounts = state.chatUnreadCounts || {};
          state.chatUnreadCounts[roomId] = 0;
        }, roomId);
        return respond({ ok: true });
      }
      if (/^\/chat-rooms\/[^/]+\/unread-counts$/.test(pathname) && method === 'GET') {
        return respond({});
      }
      if (/^\/chat-rooms\/[^/]+$/.test(pathname) && method === 'PUT') {
        const roomId = pathname.split('/')[2];
        const updated = await page.evaluate(({ roomId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          const rooms = state.chatRooms || [];
          const index = rooms.findIndex((room: any) => String(room.id) === String(roomId));
          if (index === -1) return null;
          rooms[index] = { ...rooms[index], name: String(body?.name || rooms[index].name || '') };
          return rooms[index];
        }, { roomId, body });
        return respond(updated || {}, updated ? 200 : 404);
      }
      if (pathname === '/users/register' && method === 'POST') {
        const user = await page.evaluate(() => (window as any).__e2e_api_state.users[0]);
        return respond(user);
      }
      if (pathname === '/users/all-approved' && method === 'GET') {
        // Mirror the server-side chat_only filter so tests exercise
        // the same contract the real backend enforces.
        const filtered = await page.evaluate(() => {
          const state = (window as any).__e2e_api_state;
          const caller = (state.users || []).find((u: any) => u.uid === 'e2e-test-user');
          if (caller && (caller.chat_only || caller.external_calendar_only)) {
            return state.users.filter((u: any) => u.uid === caller.uid || u.role === 'admin');
          }
          return state.users;
        });
        return respond(filtered);
      }
      if (pathname === '/groups' && method === 'GET') {
        const groups = await page.evaluate(() => [...((window as any).__e2e_api_state.groups || [])]);
        return respond(groups);
      }
      if (pathname === '/users/approved' && method === 'GET') {
        const users = await page.evaluate(() => (
          ((window as any).__e2e_api_state.users || []).filter((user: any) => user.approved || user.is_active === false)
        ));
        return respond(users);
      }
      if (pathname === '/users/pending' && method === 'GET') {
        const users = await page.evaluate(() => (
          ((window as any).__e2e_api_state.users || []).filter((user: any) => !user.approved && user.is_active !== false)
        ));
        return respond(users);
      }
      if (/^\/users\/[^/]+\/cancel-approval$/.test(pathname) && method === 'POST') {
        const uid = pathname.split('/')[2];
        const updated = await page.evaluate((uid) => {
          const users = (window as any).__e2e_api_state.users || [];
          const user = users.find((entry: any) => String(entry.uid) === String(uid) && !entry.approved);
          if (!user) return false;
          user.approved = false;
          user.is_active = false;
          return true;
        }, uid);
        return respond(updated ? { ok: true } : { error: 'Pending user not found' }, updated ? 200 : 404);
      }
      if (/^\/users\/[^/]+\/deactivate$/.test(pathname) && method === 'PUT') {
        const uid = pathname.split('/')[2];
        await page.evaluate((uid) => {
          const user = ((window as any).__e2e_api_state.users || []).find((entry: any) => String(entry.uid) === String(uid));
          if (user) {
            user.approved = false;
            user.is_active = false;
          }
        }, uid);
        return respond({ ok: true });
      }
      if (/^\/users\/[^/]+\/activate$/.test(pathname) && method === 'PUT') {
        const uid = pathname.split('/')[2];
        await page.evaluate((uid) => {
          const user = ((window as any).__e2e_api_state.users || []).find((entry: any) => String(entry.uid) === String(uid));
          if (user) {
            user.approved = true;
            user.is_active = true;
          }
        }, uid);
        return respond({ ok: true });
      }
      if (pathname === '/projects' && method === 'GET') {
        const projects = await page.evaluate(() => {
          const state = (window as any).__e2e_api_state || {};
          return [...(state.projects || [])].filter((p: any) => !p.deleted).map((project: any) => ({
            ...project,
            member_count: (project.members || []).length,
            task_count: (project.tasks || []).length,
            done_task_count: (project.tasks || []).filter((task: any) => task.status === 'done').length,
            comment_count: (project.comments || []).length,
            member_names: (project.members || []).map((m: any) => m.name).join(', '),
          }));
        });
        return respond({ canManageAll: true, projects });
      }
      if (pathname === '/projects' && method === 'POST') {
        const project = await page.evaluate((body) => {
          const state = (window as any).__e2e_api_state || {};
          const users = state.users || [];
          const memberIds = Array.from(new Set(['e2e-test-user', ...(body?.memberIds || [])]));
          const members = memberIds
            .map((uid: any) => users.find((u: any) => String(u.uid) === String(uid)))
            .filter(Boolean)
            .map((u: any, index: number) => ({ uid: u.uid, name: u.name, email: u.email, photo_url: u.photo_url || '', role: index === 0 ? 'manager' : 'member' }));
          const record = {
            id: 'project-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
            name: String(body?.name || ''),
            description: String(body?.description || ''),
            status: String(body?.status || 'active'),
            deadline: String(body?.deadline || ''),
            owner_id: 'e2e-test-user',
            owner_name: 'E2E',
            members,
            tasks: [],
            updates: [],
            comments: [],
            taskComments: [],
            events: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deleted: false,
            canManage: true,
          };
          state.projects = state.projects || [];
          state.projects.unshift(record);
          if (body?.meeting?.date) {
            const event = {
              id: 'event-' + Date.now(),
              project_id: record.id,
              type: 'meeting',
              title: String(body.meeting.title || `${record.name} 회의`),
              date: String(body.meeting.date || ''),
              time: String(body.meeting.time || ''),
              memo: String(body.meeting.memo || ''),
              scope: 'team',
              owner_id: 'e2e-test-user',
              owner_name: 'E2E',
              deleted: false,
            };
            record.events.push(event);
            state.events = state.events || [];
            state.events.unshift(event);
            return { ...record, meetingEvent: event };
          }
          return record;
        }, body);
        return respond(project);
      }
      if (/^\/projects\/[^/]+$/.test(pathname) && method === 'GET') {
        const projectId = pathname.split('/')[2];
        const project = await page.evaluate((projectId) => {
          const state = (window as any).__e2e_api_state || {};
          const project = (state.projects || []).find((p: any) => String(p.id) === String(projectId) && !p.deleted);
          // Preserve the permission fields supplied by each fixture. Forcing
          // canManage here made member/read-only scenarios silently exercise
          // the project-owner UI instead of their real permission boundary.
          return project ? { ...project } : null;
        }, projectId);
        return respond(project || { error: 'Not found' }, project ? 200 : 404);
      }
      if (/^\/projects\/[^/]+$/.test(pathname) && method === 'PUT') {
        const projectId = pathname.split('/')[2];
        const project = await page.evaluate(({ projectId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          const projects = state.projects || [];
          const index = projects.findIndex((p: any) => String(p.id) === String(projectId));
          if (index < 0) return null;
          projects[index] = { ...projects[index], ...body, updated_at: new Date().toISOString() };
          return projects[index];
        }, { projectId, body });
        return respond(project || { error: 'Not found' }, project ? 200 : 404);
      }
      if (/^\/projects\/[^/]+\/tasks$/.test(pathname) && method === 'POST') {
        const projectId = pathname.split('/')[2];
        const denied = await page.evaluate(({ projectId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          const project = (state.projects || []).find((p: any) => String(p.id) === String(projectId));
          if (!project) return { status: 404, payload: { error: 'Not found' } };
          const canCreateTasks = project.canCreateTasks ?? project.canManage === true;
          if (!canCreateTasks) {
            return {
              status: 403,
              payload: { code: 'PROJECT_TASK_CREATE_FORBIDDEN', error: '이 프로젝트에 업무를 등록할 권한이 없습니다.' },
            };
          }
          const canDirectTasks = project.canDirectTasks ?? project.canManage === true;
          if (!canDirectTasks && (
            body?.assigneeMode === 'all'
            || String(body?.assigneeUid || '') !== 'e2e-test-user'
          )) {
            return {
              status: 403,
              payload: { code: 'PROJECT_TASK_SELF_ASSIGN_ONLY', error: '일반 프로젝트 멤버는 본인 업무만 등록할 수 있습니다.' },
            };
          }
          if (!canDirectTasks && String(body?.status || 'todo') !== 'todo') {
            return {
              status: 403,
              payload: { code: 'PROJECT_TASK_SELF_STATUS_FORBIDDEN', error: '본인 업무는 대기 상태로만 등록할 수 있습니다.' },
            };
          }
          return null;
        }, { projectId, body });
        if (denied) return respond(denied.payload, denied.status);
        const task = await page.evaluate(({ projectId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          const project = (state.projects || []).find((p: any) => String(p.id) === String(projectId));
          if (!project) return null;
          const assignee = (project.members || []).find((m: any) => String(m.uid) === String(body?.assigneeUid || ''));
          const allAssignees = body?.assigneeMode === 'all';
          const assignees = (allAssignees
            ? (project.members || [])
            : assignee ? [assignee] : []
          ).map((member: any) => ({
            uid: member.uid,
            name: member.name,
            completed: false,
            completedAt: null,
          }));
          const record = {
            id: 'task-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
            project_id: projectId,
            title: String(body?.title || ''),
            description: String(body?.description || ''),
            assignee_uid: allAssignees ? '' : assignee?.uid || '',
            assignee_name: allAssignees ? '모두' : assignee?.name || '',
            assignment_mode: allAssignees ? 'all' : 'single',
            assignees,
            assignee_count: assignees.length,
            completed_assignee_count: 0,
            status: String(body?.status || 'todo'),
            due_date: String(body?.dueDate || ''),
            created_at: new Date().toISOString(),
          };
          project.tasks = project.tasks || [];
          project.tasks.push(record);
          return record;
        }, { projectId, body });
        return respond(task || { error: 'Not found' }, task ? 200 : 404);
      }
      if (/^\/projects\/[^/]+\/tasks\/[^/]+$/.test(pathname) && method === 'PUT') {
        const [, , projectId, , taskId] = pathname.split('/');
        const task = await page.evaluate(({ projectId, taskId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          const project = (state.projects || []).find((p: any) => String(p.id) === String(projectId));
          const tasks = project?.tasks || [];
          const index = tasks.findIndex((t: any) => String(t.id) === String(taskId));
          if (index < 0) return null;
          tasks[index] = { ...tasks[index], ...body, due_date: body?.dueDate ?? body?.due_date ?? tasks[index].due_date };
          return tasks[index];
        }, { projectId, taskId, body });
        return respond(task || { error: 'Not found' }, task ? 200 : 404);
      }
      if (/^\/projects\/[^/]+\/tasks\/[^/]+\/completion$/.test(pathname) && method === 'PUT') {
        const [, , projectId, , taskId] = pathname.split('/');
        const result = await page.evaluate(({ projectId, taskId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          const project = (state.projects || []).find((p: any) => String(p.id) === String(projectId));
          const task = (project?.tasks || []).find((item: any) => String(item.id) === String(taskId));
          if (!task) return null;
          const assignee = (task.assignees || []).find((item: any) => item.uid === 'e2e-test-user');
          if (!assignee) return null;
          assignee.completed = body?.completed !== false;
          assignee.completedAt = assignee.completed ? new Date().toISOString() : null;
          task.assignee_count = task.assignees.length;
          task.completed_assignee_count = task.assignees.filter((item: any) => item.completed).length;
          if (task.completed_assignee_count === task.assignee_count) task.status = 'review';
          else if (task.completed_assignee_count > 0 || ['review', 'done'].includes(task.status)) task.status = 'doing';
          return {
            taskId,
            completed: assignee.completed,
            completedCount: task.completed_assignee_count,
            total: task.assignee_count,
            percent: Math.round((task.completed_assignee_count / task.assignee_count) * 100),
            status: task.status,
          };
        }, { projectId, taskId, body });
        return respond(result || { error: 'Not found' }, result ? 200 : 404);
      }
      if (/^\/projects\/[^/]+\/tasks\/[^/]+\/comments$/.test(pathname) && method === 'POST') {
        const [, , projectId, , taskId] = pathname.split('/');
        const comment = await page.evaluate(({ projectId, taskId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          const project = (state.projects || []).find((p: any) => String(p.id) === String(projectId));
          if (!project) return null;
          const record = {
            id: 'task-comment-' + Date.now(),
            project_id: projectId,
            task_id: taskId,
            content: String(body?.content || ''),
            author_uid: 'e2e-test-user',
            author_name: 'E2E',
            created_at: new Date().toISOString(),
          };
          project.taskComments = project.taskComments || [];
          project.taskComments.push(record);
          return record;
        }, { projectId, taskId, body });
        return respond(comment || { error: 'Not found' }, comment ? 200 : 404);
      }
      if (/^\/projects\/[^/]+\/updates$/.test(pathname) && method === 'POST') {
        const projectId = pathname.split('/')[2];
        const update = await page.evaluate(({ projectId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          const project = (state.projects || []).find((p: any) => String(p.id) === String(projectId));
          if (!project) return null;
          const record = {
            id: 'update-' + Date.now(),
            project_id: projectId,
            content: String(body?.content || ''),
            status_snapshot: String(body?.statusSnapshot || ''),
            author_uid: 'e2e-test-user',
            author_name: 'E2E',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          project.updates = project.updates || [];
          project.updates.unshift(record);
          return record;
        }, { projectId, body });
        return respond(update || { error: 'Not found' }, update ? 200 : 404);
      }
      if (/^\/projects\/[^/]+\/updates\/[^/]+$/.test(pathname) && method === 'PUT') {
        const [, , projectId, , updateId] = pathname.split('/');
        const update = await page.evaluate(({ projectId, updateId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          const project = (state.projects || []).find((p: any) => String(p.id) === String(projectId));
          const item = (project?.updates || []).find((entry: any) => String(entry.id) === String(updateId));
          if (!item) return null;
          item.content = String(body?.content || '');
          item.status_snapshot = String(body?.statusSnapshot || '');
          item.updated_at = new Date(Date.now() + 2000).toISOString();
          return item;
        }, { projectId, updateId, body });
        return respond(update || { error: 'Not found' }, update ? 200 : 404);
      }
      if (/^\/projects\/[^/]+\/meetings$/.test(pathname) && method === 'POST') {
        const projectId = pathname.split('/')[2];
        const event = await page.evaluate(({ projectId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          const project = (state.projects || []).find((p: any) => String(p.id) === String(projectId));
          if (!project) return null;
          const record = {
            id: 'event-' + Date.now(),
            project_id: projectId,
            type: 'meeting',
            title: String(body?.title || ''),
            date: String(body?.date || ''),
            time: String(body?.time || ''),
            memo: String(body?.memo || ''),
            scope: 'team',
            owner_id: 'e2e-test-user',
            owner_name: 'E2E',
            deleted: false,
          };
          project.events = project.events || [];
          project.events.push(record);
          state.events = state.events || [];
          state.events.unshift(record);
          return record;
        }, { projectId, body });
        return respond(event || { error: 'Not found' }, event ? 200 : 404);
      }
      if (/^\/projects\/[^/]+\/comments$/.test(pathname) && method === 'POST') {
        const projectId = pathname.split('/')[2];
        const comment = await page.evaluate(({ projectId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          const project = (state.projects || []).find((p: any) => String(p.id) === String(projectId));
          if (!project) return null;
          const record = {
            id: 'comment-' + Date.now(),
            project_id: projectId,
            content: String(body?.content || ''),
            attachments: body?.attachments || [],
            author_uid: 'e2e-test-user',
            author_name: 'E2E',
            created_at: new Date().toISOString(),
          };
          project.comments = project.comments || [];
          project.comments.push(record);
          return record;
        }, { projectId, body });
        return respond(comment || { error: 'Not found' }, comment ? 200 : 404);
      }
      if (pathname === '/events' && method === 'GET') {
        // Honour the same from/to date-range scoping as the real
        // server so perf measurements reflect production (~5k rows
        // for a manager) rather than the uncapped seeded set (~25k).
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const events = await page.evaluate(({ from, to }) => {
          const state = (window as any).__e2e_api_state || {};
          const projects = state.projects || [];
          const all = state.events || [];
          return all.filter((e: any) => {
            if (e.project_id || e.projectId) {
              const projectId = String(e.project_id || e.projectId);
              const project = projects.find((p: any) => String(p.id) === projectId);
              if (project && (project.deleted || project.status === 'archived')) return false;
            }
            return (
            (!from || String(e.date) >= from) && (!to || String(e.date) <= to)
            );
          });
        }, { from, to });
        return respond(events.map(canonicalStubEventResponse));
      }
      if (pathname === '/events' && method === 'POST') {
        const rec = {
          id: 'ev-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
          owner_id: 'e2e-test-user',
          owner_name: 'E2E',
          deleted: false,
          ...canonicalStubEventPatch(body),
        };
        await page.evaluate(({ rec, checklist, shareWith }) => {
          const state = (window as any).__e2e_api_state;
          state.events.unshift(rec);
          state.eventChecklist = state.eventChecklist || {};
          state.eventChecklist[rec.id] = (Array.isArray(checklist) ? checklist : []).map((title: string, index: number) => ({
            id: `cl-${rec.id}-${index}`,
            event_id: rec.id,
            title,
            done: false,
            sort_order: index,
            created_at: new Date().toISOString(),
          }));
          state.eventShares = state.eventShares || {};
          state.eventShares[rec.id] = Array.isArray(shareWith) ? [...shareWith] : [];
        }, { rec, checklist: body?.checklist, shareWith: body?.shareWith });
        return respond(canonicalStubEventResponse(rec));
      }
      if (/^\/events\/[^/]+\/shares$/.test(pathname) && method === 'GET') {
        const eventId = pathname.split('/')[2];
        const sharedUsers = await page.evaluate((eventId) => {
          const state = (window as any).__e2e_api_state || {};
          const ids = state.eventShares?.[eventId] || [];
          return (state.users || []).filter((user: any) => ids.includes(user.uid));
        }, eventId);
        return respond(sharedUsers);
      }
      if (/^\/events\/[^/]+$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/')[2];
        const eventPatch = canonicalStubEventPatch(body);
        await page.evaluate(({ id, patch }) => {
          const state = (window as any).__e2e_api_state;
          const arr = state.events;
          const i = arr.findIndex((e: any) => e.id === id);
          if (i >= 0) arr[i] = { ...arr[i], ...patch };
          if (Array.isArray(patch?.shareWith)) {
            state.eventShares = state.eventShares || {};
            state.eventShares[id] = [...patch.shareWith];
          }
        }, { id, patch: eventPatch });
        const updated = await page.evaluate((id) => {
          const state = (window as any).__e2e_api_state || {};
          return (state.events || []).find((event: any) => event.id === id) || null;
        }, id);
        return respond(canonicalStubEventResponse(updated || { id, ...eventPatch }));
      }
      if (/^\/events\/[^/]+\/checklist$/.test(pathname) && method === 'GET') {
        const eventId = pathname.split('/')[2];
        const items = await page.evaluate((eventId) => {
          const state = (window as any).__e2e_api_state || {};
          return [...(state.eventChecklist?.[eventId] || [])];
        }, eventId);
        return respond(items);
      }
      if (/^\/events\/[^/]+\/checklist$/.test(pathname) && method === 'POST') {
        const eventId = pathname.split('/')[2];
        const item = await page.evaluate(({ eventId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          state.eventChecklist = state.eventChecklist || {};
          const items = state.eventChecklist[eventId] || [];
          const record = {
            id: 'cl-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
            event_id: eventId,
            title: String(body?.title || ''),
            done: false,
            sort_order: items.length,
            created_at: new Date().toISOString(),
          };
          state.eventChecklist[eventId] = [...items, record];
          return record;
        }, { eventId, body });
        return respond({ item, event: null });
      }
      if (/^\/events\/[^/]+\/checklist\/[^/]+$/.test(pathname) && method === 'PUT') {
        const [, , eventId, , itemId] = pathname.split('/');
        const item = await page.evaluate(({ eventId, itemId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          const items = state.eventChecklist?.[eventId] || [];
          const index = items.findIndex((entry: any) => String(entry.id) === String(itemId));
          if (index < 0) return null;
          items[index] = { ...items[index], ...body };
          return items[index];
        }, { eventId, itemId, body });
        return respond({ item, event: null }, item ? 200 : 404);
      }
      if (/^\/events\/[^/]+\/checklist\/[^/]+$/.test(pathname) && method === 'DELETE') {
        const [, , eventId, , itemId] = pathname.split('/');
        await page.evaluate(({ eventId, itemId }) => {
          const state = (window as any).__e2e_api_state || {};
          state.eventChecklist = state.eventChecklist || {};
          state.eventChecklist[eventId] = (state.eventChecklist[eventId] || []).filter((entry: any) => String(entry.id) !== String(itemId));
        }, { eventId, itemId });
        return respond({ ok: true, id: itemId, event: null });
      }
      if (pathname === '/events/checklist-summary' && method === 'GET') return respond({});
      if (pathname === '/ideas' && method === 'GET') {
        const ideas = await page.evaluate(() => (window as any).__e2e_api_state.ideas || []);
        return respond(ideas);
      }
      if (pathname === '/ideas' && method === 'POST') {
        const rec = {
          id: 'idea-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
          owner_id: 'e2e-test-user',
          owner_name: 'E2E',
          created_at: new Date().toISOString(),
          ...body,
        };
        await page.evaluate((rec) => {
          (window as any).__e2e_api_state.ideas.unshift(rec);
        }, rec);
        return respond(rec);
      }
      if (/^\/ideas\/[^/]+$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/')[2];
        const updated = await page.evaluate(({ id, patch }) => {
          const arr = (window as any).__e2e_api_state.ideas || [];
          const i = arr.findIndex((idea: any) => idea.id === id);
          if (i < 0) return null;
          arr[i] = { ...arr[i], ...patch };
          return arr[i];
        }, { id, patch: body });
        if (!updated) return respond({ error: 'Not found' }, 404);
        return respond(updated);
      }
      if (/^\/ideas\/[^/]+$/.test(pathname) && method === 'DELETE') {
        const id = pathname.split('/')[2];
        await page.evaluate((id) => {
          const state = (window as any).__e2e_api_state;
          state.ideas = (state.ideas || []).filter((idea: any) => idea.id !== id);
        }, id);
        return respond({ ok: true });
      }
      if (pathname === '/event-types' && method === 'GET') return respond([]);
      if (pathname === '/todo-cats' && method === 'GET') return respond([
        { id: 1, name: '세무 관련', color: '#AF52DE' },
      ]);
      if (pathname === '/idea-cats' && method === 'GET') return respond([]);
      if (pathname === '/rooms' && method === 'GET') return respond([]);
      if (pathname === '/attendance' && method === 'GET') {
        const month = url.searchParams.get('month') || '';
        const userId = url.searchParams.get('userId') || '';
        const records = await page.evaluate(({ month, userId }) => {
          const state = (window as any).__e2e_api_state || {};
          return (state.attendance || []).filter((record: any) =>
            (!month || String(record.attendance_date || '').startsWith(month)) &&
            (!userId || String(record.user_id || '') === String(userId))
          );
        }, { month, userId });
        return respond(records);
      }
      if (pathname === '/attendance/details' && method === 'GET') {
        const month = url.searchParams.get('month') || '';
        const userId = url.searchParams.get('userId') || '';
        const records = await page.evaluate(({ month, userId }) => {
          const state = (window as any).__e2e_api_state || {};
          return (state.attendance || [])
            .filter((record: any) =>
              (!month || String(record.attendance_date || '').startsWith(month)) &&
              (!userId || String(record.user_id || '') === String(userId))
            )
            .map((record: any) => ({ ...record, is_late: !!record.check_in && String(record.check_in) > '10:10' }));
        }, { month, userId });
        return respond(records);
      }
      if (pathname === '/attendance/monthly-summary' && method === 'GET') return respond([]);
      if (pathname === '/attendance/check-in' && method === 'POST') {
        const record = await page.evaluate(() => {
          const state = (window as any).__e2e_api_state || {};
          const today = (window as any).todayStr ? (window as any).todayStr() : new Date().toISOString().slice(0, 10);
          state.attendance = state.attendance || [];
          const existing = state.attendance.find((entry: any) => entry.user_id === 'e2e-test-user' && entry.attendance_date === today);
          if (existing) {
            existing.check_in = existing.check_in || '09:30';
            return existing;
          }
          const record = { user_id: 'e2e-test-user', user_name: 'E2E', attendance_date: today, check_in: '09:30', check_out: null };
          state.attendance.push(record);
          return record;
        });
        return respond(record);
      }
      if (pathname === '/attendance/today' && method === 'GET') return respond(null);
      if (pathname === '/notices' && method === 'GET') return respond([]);
      if (pathname === '/notices/unread-count' && method === 'GET') return respond({ count: 0 });
      if (pathname === '/rooms/unread-counts' && method === 'GET') return respond({});
      if (pathname === '/default-shares' && method === 'GET') return respond([]);
      if (pathname === '/default-shares' && method === 'POST') return respond({ ok: true });
      if (pathname === '/fcm/status' && method === 'GET') return respond({ tokenCount: 0, lastRegisteredAt: null });
      if (pathname === '/_debug/client-log' && method === 'POST') {
        // Let tests observe payloads without touching the real server.
        await page.evaluate((p) => {
          (window as any).__e2e_dbg_uploads = (window as any).__e2e_dbg_uploads || [];
          (window as any).__e2e_dbg_uploads.push(p);
        }, body);
        return respond({ ok: true });
      }
      return respond({});
    } catch (err) {
      return respond({ error: String(err) }, 500);
    }
  });
}

export async function setupStubs(page: Page, initial?: ApiStubState) {
  await installFirebaseStub(page);
  await installApiStub(page, initial);
}

// ── PEAK OS 정산 API 스텁 ────────────────────────────────────
// 서버 저장으로 옮긴 뒤 화면이 GET/POST/PATCH/DELETE 를 쓴다.
// 메모리에 들고 있다가 그대로 돌려주므로 새로고침 없이도 왕복이 확인된다.

const COST_VIEWERS = ['패션TV봉이', '손명아', '김대호', '박종원', '전현우'];
const FINANCE_REVIEWERS = ['패션TV봉이', '박종원', '김대호', '손명아'];
const FINANCE_OPERATION_VIEWERS = ['패션TV봉이', '박종원', '김대호', '손명아', '전현우'];
const ACCOUNT_PREVIEW_VIEWERS = ['패션TV봉이', '박종원', '김대호'];
const FINAL_EXECUTION_VIEWERS = ['패션TV봉이', '박종원', '김대호', '손명아'];

/** 서버처럼 기본 단가표를 담되, 권한이 없으면 회사원가를 지워서 준다. */
export function createPeakosStore(viewerName = '', viewerRole = 'manager'): any {
  const showCost = COST_VIEWERS.includes(viewerName);
  return {
    viewer: viewerName,
    viewerRole,
    intake: [],
    prices: BASE_PRICES.map(([a, b, c, cost, unit]) => ({
      key: `${a}|${b}|${c}`, a, b, c,
      cost: showCost ? cost : null,
      unit, custom: false, edited: false,
    })),
    credit: [], creditRequests: [], financeRequests: [], financeRequestEvents: [], taxInvoiceEvidence: {}, serviceRequests: [], fund: null, monthly: {},
    settlementCompletion: {},
    settlementCompletionAudit: {},
    settlementCompletionDelayMs: 0,
    settlementCompletionActive: 0,
    settlementCompletionMaxActive: 0,
    vendorReconciliations: [],
    bank: {
      accounts: [],
      collectorConfigured: false,
      autoReconciliationEnabled: false,
      canSync: false,
      canViewBalances: false,
      connection: { status: 'DISABLED', code: 'IBK_COLLECTOR_DISABLED' },
      transactions: [],
      syncRuns: [],
    },
  };
}

function upsert(list: any[], row: any) {
  const i = list.findIndex(x => x.id === row.id);
  if (i >= 0) list[i] = row; else list.push(row);
}

function completionRuleForSource(source: any) {
  if (String(source?.kind || '') !== 'sale') return '';
  if (source.view === 'direct-execution') return 'DIRECT_EXECUTION_8TH';
  if (source.view === 'monthly-manage') return 'MONTHLY_MANAGEMENT_30D';
  if (source.view === 'monthly-guarantee' && source.c === '건바이') return 'PER_ITEM_24H';
  if (source.view === 'monthly-guarantee' && source.c === '월보장') return 'MONTHLY_GUARANTEE_25D';
  return '';
}

function stubCompletionEligibility(ruleCode: string, evidence: any) {
  const reasons: any[] = [];
  const now = Date.parse('2026-08-17T12:00:00.000Z');
  const add = (code: string, message: string) => reasons.push({ code, message });
  let eligibleAt: string | null = null;
  let requiredDurationHours: number | null = null;
  let observedDurationHours: number | null = null;
  if (ruleCode === 'DIRECT_EXECUTION_8TH') {
    if (evidence.completedIssueCount === null || evidence.completedIssueCount === undefined) {
      add('MISSING_COMPLETED_ISSUE_COUNT', '완료 회차 근거가 없습니다.');
    } else if (Number(evidence.completedIssueCount) < 8) {
      add('EIGHTH_ISSUANCE_NOT_COMPLETED', '직접실행 완료 회차가 8회 미만입니다.');
    }
    if (!evidence.eighthIssueCompletedAt) {
      add('MISSING_EIGHTH_ISSUANCE_COMPLETED_AT', '8회차 완료 시각 근거가 없습니다.');
    } else if (Date.parse(evidence.eighthIssueCompletedAt) > now) {
      add('FUTURE_EIGHTH_ISSUANCE_COMPLETED_AT', '8회차 완료 시각이 현재보다 미래입니다.');
    } else {
      eligibleAt = new Date(evidence.eighthIssueCompletedAt).toISOString();
    }
  } else {
    const service = ruleCode === 'MONTHLY_MANAGEMENT_30D';
    const start = service ? evidence.serviceStartedAt : evidence.exposureStartedAt;
    const end = service ? evidence.serviceCompletedAt : evidence.exposureCompletedAt;
    requiredDurationHours = ruleCode === 'PER_ITEM_24H' ? 24
      : ruleCode === 'MONTHLY_GUARANTEE_25D' ? 25 * 24 : 30 * 24;
    if (!start) add(service ? 'MISSING_SERVICE_STARTED_AT' : 'MISSING_EXPOSURE_STARTED_AT', `${service ? '서비스' : '노출'} 시작 근거가 없습니다.`);
    if (!end) add(service ? 'MISSING_SERVICE_COMPLETED_AT' : 'MISSING_EXPOSURE_COMPLETED_AT', `${service ? '서비스' : '노출'} 완료 근거가 없습니다.`);
    const startMs = Date.parse(start || '');
    const endMs = Date.parse(end || '');
    if (Number.isFinite(startMs) && startMs > now) add(service ? 'FUTURE_SERVICE_STARTED_AT' : 'FUTURE_EXPOSURE_STARTED_AT', `${service ? '서비스' : '노출'} 시작 시각이 현재보다 미래입니다.`);
    if (Number.isFinite(endMs) && endMs > now) add(service ? 'FUTURE_SERVICE_COMPLETED_AT' : 'FUTURE_EXPOSURE_COMPLETED_AT', `${service ? '서비스' : '노출'} 완료 시각이 현재보다 미래입니다.`);
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      observedDurationHours = (endMs - startMs) / 3_600_000;
      if (endMs < startMs) add('COMPLETION_BEFORE_START', '완료 시각이 시작 시각보다 빠릅니다.');
      else if (observedDurationHours < Number(requiredDurationHours)) add('REQUIRED_DURATION_NOT_MET', `완료 기간이 ${requiredDurationHours}시간에 미달합니다.`);
      eligibleAt = new Date(endMs).toISOString();
    }
  }
  const labels: Record<string, string> = {
    DIRECT_EXECUTION_8TH: '직접실행 8회차 완료',
    MONTHLY_GUARANTEE_25D: '월보장 25일 노출 완료',
    PER_ITEM_24H: '건바이 24시간 노출 완료',
    MONTHLY_MANAGEMENT_30D: '월관리 30일 완료',
  };
  return {
    ruleCode,
    ruleLabel: labels[ruleCode] || ruleCode,
    eligible: reasons.length === 0,
    state: reasons.length ? 'PENDING_EVIDENCE' : 'ELIGIBLE',
    reasons,
    requiredDurationHours,
    observedDurationHours,
    eligibleAt: reasons.length ? null : eligibleAt,
    eligibleAtKst: null,
    evaluatedAt: new Date(now).toISOString(),
    evaluatedAtKst: '2026-08-17 21:00:00 KST',
    timeZone: 'Asia/Seoul',
  };
}

function stubCompletionState(source: any, current: any = null) {
  const ruleCode = current?.ruleCode || completionRuleForSource(source);
  const evidence = {
    exposureStartedAt: null,
    exposureCompletedAt: null,
    serviceStartedAt: null,
    serviceCompletedAt: null,
    completedIssueCount: null,
    eighthIssueCompletedAt: null,
    ...(current?.evidence || {}),
  };
  return {
    tracked: current?.tracked === true,
    sourceId: String(source.id),
    ruleCode,
    status: current?.status || 'OPEN',
    locked: ['COMPLETED', 'FROZEN'].includes(String(current?.status || 'OPEN')),
    rowVersion: Number(current?.rowVersion || 0),
    evidence,
    evidenceUpdatedAt: current?.evidenceUpdatedAt || null,
    evidenceUpdatedByName: current?.evidenceUpdatedByName || '',
    eligibility: stubCompletionEligibility(ruleCode, evidence),
    lifecycle: {
      completedAt: null, completedByName: '', completionReason: '',
      frozenAt: null, frozenByName: '', freezeReason: '',
      reopenedAt: null, reopenedByName: '', reopenReason: '',
      ...(current?.lifecycle || {}),
    },
  };
}

/** /api/peakos/* 를 처리했으면 true. 아니면 호출한 쪽이 이어서 처리한다. */
export function handlePeakos(store: any, route: any): boolean {
  const req = route.request();
  const path = new URL(req.url()).pathname.replace(/^\/api/, '');
  if (!path.startsWith('/peakos')) return false;

  const method = req.method();
  const parts = path.split('/').filter(Boolean);       // peakos, <area>, ...
  const area = parts[1];
  const tail = parts.slice(2).map(decodeURIComponent);
  let body: any = {};
  try { body = JSON.parse(req.postData() || '{}'); } catch { body = {}; }

  const send = (payload: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });

  if (area === 'todos') {
    const date = String(new URL(req.url()).searchParams.get('date') || '');
    if (method === 'GET' && !tail.length) {
      send({
        date, timeZone: 'Asia/Seoul', readOnly: false,
        capabilities: { create: true, edit: true, reorder: true, archive: true },
        items: [],
      });
      return true;
    }
    send({ code: 'TODO_NOT_FOUND', error: '테스트 할 일 항목이 없습니다.' }, method === 'GET' ? 404 : 405);
    return true;
  }

  if (area === 'settlement-completion') {
    const id = String(tail[0] || '');
    const source = Object.entries(store.monthly || {}).flatMap(([view, entries]) =>
      (Array.isArray(entries) ? entries : []).map((row: any) => ({ ...row, view }))
    ).find((row: any) => String(row.id || '') === id && row.kind === 'sale');
    if (!source) {
      send({ code: 'SETTLEMENT_COMPLETION_SOURCE_NOT_FOUND', error: '정산 원본 판매 행을 찾지 못했습니다.' }, 404);
      return true;
    }
    const ruleCode = completionRuleForSource(source);
    if (!ruleCode) {
      send({ code: 'SETTLEMENT_SOURCE_RULE_UNMAPPED', error: '이 판매 행의 정산 완료 규칙이 정해지지 않았습니다.' }, 422);
      return true;
    }
    const stored = store.settlementCompletion?.[id];
    const current = stubCompletionState(source, stored);
    if (method === 'GET' && tail[1] === 'audit') {
      send({ rows: store.settlementCompletionAudit?.[id] || [] });
      return true;
    }
    if (method === 'GET' && !tail[1]) {
      const delay = Math.max(0, Number(store.settlementCompletionDelayMs || 0));
      if (!delay) send(current);
      else {
        store.settlementCompletionActive = Number(store.settlementCompletionActive || 0) + 1;
        store.settlementCompletionMaxActive = Math.max(
          Number(store.settlementCompletionMaxActive || 0),
          store.settlementCompletionActive,
        );
        setTimeout(() => {
          store.settlementCompletionActive -= 1;
          void send(current);
        }, delay);
      }
      return true;
    }
    const role = String(store.viewerRole || '');
    if (!['admin', 'manager'].includes(role) || role === 'oversight') {
      send({ code: 'SETTLEMENT_COMPLETION_WRITE_FORBIDDEN', error: '정산 완료 근거를 변경할 권한이 없습니다.' }, 403);
      return true;
    }
    const expected = Number(body.expectedVersion);
    if (!Number.isSafeInteger(expected) || expected !== Number(current.rowVersion)) {
      send({ code: 'SETTLEMENT_COMPLETION_VERSION_CONFLICT', error: '정산 완료 상태가 다른 화면에서 먼저 변경되었습니다.' }, 409);
      return true;
    }
    const reason = String(body.reason || '').replace(/\s+/g, ' ').trim();
    if (reason.length < 8) {
      send({ code: 'SETTLEMENT_COMPLETION_REASON_REQUIRED', error: '정산 상태 변경 사유를 8자 이상 입력해 주세요.' }, 400);
      return true;
    }
    let updated: any = null;
    let action = '';
    if (method === 'PUT' && tail[1] === 'evidence') {
      if (current.status !== 'OPEN') {
        send({ code: 'SETTLEMENT_COMPLETION_STATE_CONFLICT', error: '열린 정산에서만 완료 근거를 변경할 수 있습니다.' }, 409);
        return true;
      }
      updated = stubCompletionState(source, {
        ...current,
        tracked: true,
        rowVersion: Number(current.rowVersion) + 1,
        evidence: { ...(body.evidence || {}) },
        evidenceUpdatedAt: '2026-08-17T12:00:00.000Z',
        evidenceUpdatedByName: store.viewer,
      });
      action = 'EVIDENCE_UPDATED';
    } else if (method === 'POST' && ['complete', 'freeze', 'reopen'].includes(String(tail[1] || ''))) {
      const transition = String(tail[1]);
      if (transition === 'complete') {
        if (!current.tracked || current.status !== 'OPEN' || !current.eligibility.eligible) {
          send({
            code: 'SETTLEMENT_COMPLETION_NOT_ELIGIBLE',
            error: '완료 조건을 충족하지 않아 정산 완료 처리할 수 없습니다.',
            details: { reasons: current.eligibility.reasons },
          }, 409);
          return true;
        }
        updated = stubCompletionState(source, {
          ...current, status: 'COMPLETED', rowVersion: current.rowVersion + 1,
          lifecycle: {
            ...current.lifecycle,
            completedAt: '2026-08-17T12:00:00.000Z',
            completedByName: store.viewer,
            completionReason: reason,
          },
        });
        action = 'COMPLETED';
      } else if (transition === 'freeze') {
        if (current.status !== 'COMPLETED') {
          send({ code: 'SETTLEMENT_COMPLETION_STATE_CONFLICT', error: '완료된 정산만 동결할 수 있습니다.' }, 409);
          return true;
        }
        updated = stubCompletionState(source, {
          ...current, status: 'FROZEN', rowVersion: current.rowVersion + 1,
          lifecycle: {
            ...current.lifecycle,
            frozenAt: '2026-08-17T12:00:00.000Z',
            frozenByName: store.viewer,
            freezeReason: reason,
          },
        });
        action = 'FROZEN';
      } else {
        if (role !== 'admin') {
          send({ code: 'SETTLEMENT_COMPLETION_REOPEN_FORBIDDEN', error: '정산 재개는 관리자만 할 수 있습니다.' }, 403);
          return true;
        }
        if (!['COMPLETED', 'FROZEN'].includes(current.status)) {
          send({ code: 'SETTLEMENT_COMPLETION_STATE_CONFLICT', error: '완료 또는 동결된 정산만 재개할 수 있습니다.' }, 409);
          return true;
        }
        updated = stubCompletionState(source, {
          ...current, status: 'OPEN', rowVersion: current.rowVersion + 1,
          lifecycle: {
            ...current.lifecycle,
            completedAt: null, completedByName: '', completionReason: '',
            frozenAt: null, frozenByName: '', freezeReason: '',
            reopenedAt: '2026-08-17T12:00:00.000Z',
            reopenedByName: store.viewer,
            reopenReason: reason,
          },
        });
        action = 'REOPENED';
      }
    }
    if (!updated) {
      send({ error: '허용되지 않은 요청입니다.' }, 405);
      return true;
    }
    store.settlementCompletion[id] = updated;
    store.settlementCompletionAudit[id] = store.settlementCompletionAudit[id] || [];
    store.settlementCompletionAudit[id].unshift({
      action, rowVersion: updated.rowVersion, actorName: store.viewer, reason,
      createdAt: '2026-08-17T12:00:00.000Z',
    });
    send(updated);
    return true;
  }

  // 통장 원장은 조회 화면만 E2E에서 재현한다. 쓰기/동기화 요청은 405로
  // 막아 focused UI 테스트가 실제 DB나 은행으로 빠져나가지 못하게 한다.
  if (area === 'bank') {
    if (method !== 'GET') {
      send({ error: 'E2E 통장 스텁은 조회만 허용합니다.' }, 405);
      return true;
    }

    const bank = store.bank || {};
    const resource = tail[0];
    if (resource === 'accounts') {
      send({
        accounts: Array.isArray(bank.accounts) ? bank.accounts : [],
        collectorConfigured: bank.collectorConfigured === true,
        autoReconciliationEnabled: bank.autoReconciliationEnabled === true,
        canSync: bank.canSync === true,
        canViewBalances: bank.canViewBalances === true,
        connection: bank.connection && typeof bank.connection === 'object'
          ? bank.connection
          : { status: bank.collectorConfigured === true ? 'READY' : 'DISABLED' },
      });
      return true;
    }

    if (resource === 'transactions') {
      const url = new URL(req.url());
      const accountId = url.searchParams.get('accountId') || '';
      const direction = (url.searchParams.get('direction') || '').toUpperCase();
      const status = (url.searchParams.get('status') || '').toUpperCase();
      const query = (url.searchParams.get('q') || '').trim().toLowerCase();
      const from = Date.parse(url.searchParams.get('from') || '');
      const to = Date.parse(url.searchParams.get('to') || '');
      const page = Math.max(Number(url.searchParams.get('page')) || 1, 1);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
      const filtered = (Array.isArray(bank.transactions) ? bank.transactions : []).filter((row: any) => {
        if (accountId && String(row.accountId || '') !== accountId) return false;
        if (direction && String(row.direction || '').toUpperCase() !== direction) return false;
        if (status && String(row.status || '').toUpperCase() !== status) return false;
        const transactionAt = Date.parse(String(row.transactionAt || ''));
        if (Number.isFinite(from) && (!Number.isFinite(transactionAt) || transactionAt < from)) return false;
        if (Number.isFinite(to) && (!Number.isFinite(transactionAt) || transactionAt >= to)) return false;
        if (query) {
          const haystack = `${row.summary || ''} ${row.counterpartyName || ''}`.toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      });
      const start = (page - 1) * limit;
      const transactions = filtered.slice(start, start + limit);
      send({
        transactions,
        summary: {
          total: filtered.length,
          depositTotal: bank.canViewBalances === true ? filtered
            .filter((row: any) => row.direction === 'DEPOSIT')
            .reduce((sum: number, row: any) => sum + Number(row.amount || 0), 0) : null,
          withdrawalTotal: bank.canViewBalances === true ? filtered
            .filter((row: any) => row.direction === 'WITHDRAWAL')
            .reduce((sum: number, row: any) => sum + Number(row.amount || 0), 0) : null,
          unmatchedCount: filtered.filter((row: any) => row.status === 'UNMATCHED').length,
        },
        pagination: {
          page,
          limit,
          total: filtered.length,
          totalPages: Math.ceil(filtered.length / limit),
        },
      });
      return true;
    }

    if (resource === 'sync-runs') {
      send({ runs: Array.isArray(bank.syncRuns) ? bank.syncRuns : [] });
      return true;
    }

    send({ error: 'E2E 통장 API를 찾을 수 없습니다.' }, 404);
    return true;
  }

  if (area === 'vendor-reconciliations') {
    if (!FINANCE_REVIEWERS.includes(String(store.viewer || '').trim())) {
      send({ code: 'VENDOR_RECONCILIATION_FINANCE_FORBIDDEN', error: '공급사 정산은 지정된 재무 담당자만 볼 수 있습니다.' }, 403);
      return true;
    }
    if (method === 'GET') {
      send({ rows: Array.isArray(store.vendorReconciliations) ? store.vendorReconciliations : [] });
      return true;
    }
    if (method !== 'POST') {
      send({ error: '허용되지 않은 요청입니다.' }, 405);
      return true;
    }

    const history = Array.isArray(store.vendorReconciliations) ? store.vendorReconciliations : [];
    store.vendorReconciliations = history;
    const requested = Array.isArray(body.rows) ? body.rows : [];
    const replay = history.find((batch: any) => batch.idempotencyKey === body.idempotencyKey);
    const requestShape = JSON.stringify({
      supplier: body.supplier, deliveredQty: body.deliveredQty, paidDate: body.paidDate,
      bank: body.bank, memo: body.memo, rows: requested,
    });
    if (replay) {
      if (replay.requestShape !== requestShape) {
        send({ code: 'VENDOR_RECONCILIATION_IDEMPOTENCY_CONFLICT', error: '같은 재시도 키에 다른 대사 내용이 사용되었습니다.' }, 409);
      } else {
        const { requestShape: _requestShape, idempotencyKey: _idempotencyKey, ...publicBatch } = replay;
        send({ ...publicBatch, replayed: true });
      }
      return true;
    }

    const submitted = requested.map((entry: any) => store.intake.find((row: any) => row.id === entry.id));
    if (!requested.length || submitted.some((row: any) => !row)) {
      send({ code: 'VENDOR_RECONCILIATION_SOURCE_NOT_FOUND', error: '일부 접수 행을 찾지 못했습니다.' }, 404);
      return true;
    }
    const versionConflict = requested.find((entry: any, index: number) => (
      Number(submitted[index].rowVersion) !== Number(entry.expectedRowVersion)
    ));
    if (versionConflict) {
      send({ code: 'VENDOR_RECONCILIATION_VERSION_CONFLICT', error: '다른 작업자가 먼저 접수 행을 수정했습니다.' }, 409);
      return true;
    }
    const supplier = String(body.supplier || '').trim();
    const eligible = store.intake.filter((row: any) => (
      row.vendorPaid !== true
      && ['normal', 'use'].includes(String(row.kind || ''))
      && Number.isSafeInteger(Number(row.qty))
      && Number(row.qty) > 0
      && String(row.supplier || '').trim() === supplier
    ));
    const submittedIds = [...new Set(requested.map((entry: any) => String(entry.id)))].sort();
    const eligibleIds = eligible.map((row: any) => String(row.id)).sort();
    if (submittedIds.length !== requested.length || JSON.stringify(submittedIds) !== JSON.stringify(eligibleIds)) {
      send({ code: 'VENDOR_RECONCILIATION_SELECTION_STALE', error: '공급사의 현재 미지급 접수 목록이 바뀌었습니다.' }, 409);
      return true;
    }
    const invalidCost = eligible.some((row: any) => !Number.isSafeInteger(Number(row.cost)) || Number(row.cost) <= 0);
    if (invalidCost) {
      send({ code: 'VENDOR_RECONCILIATION_COST_REQUIRED', error: '확정 원가가 없는 접수가 있습니다.' }, 409);
      return true;
    }
    const settledQty = eligible.reduce((sum: number, row: any) => sum + Number(row.qty), 0);
    const totalDue = eligible.reduce((sum: number, row: any) => sum + Number(row.qty) * Number(row.cost), 0);
    if (Number(body.deliveredQty) !== settledQty) {
      send({ code: 'VENDOR_RECONCILIATION_QTY_MISMATCH', error: `접수 수량 ${settledQty}개와 공급사 전달 수량 ${body.deliveredQty}개가 일치하지 않습니다.` }, 409);
      return true;
    }
    const completedAt = '2026-08-17T12:00:00.000Z';
    const savedRows = eligible.map((row: any) => {
      const index = store.intake.findIndex((current: any) => current.id === row.id);
      store.intake[index] = {
        ...row,
        vendorPaid: true,
        vendorPaidAmount: Number(row.qty) * Number(row.cost),
        vendorPaidDate: body.paidDate,
        vendorBank: body.bank,
        vendorBy: store.viewer,
        vendorMemo: body.memo,
        rowVersion: Number(row.rowVersion) + 1,
      };
      return store.intake[index];
    });
    const sequence = String(history.length + 1).padStart(12, '0');
    const publicBatch = {
      id: `00000000-0000-4000-8000-${sequence}`,
      supplier,
      status: 'COMPLETED',
      rowVersion: 1,
      itemCount: savedRows.length,
      deliveredQty: settledQty,
      settledQty,
      totalDue,
      bank: body.bank,
      paidDate: body.paidDate,
      memo: body.memo,
      completedByName: store.viewer,
      completedAt,
      replayed: false,
      rows: savedRows,
    };
    history.unshift({ ...publicBatch, idempotencyKey: body.idempotencyKey, requestShape });
    send(publicBatch, 201);
    return true;
  }

  if (area === 'intake') {
    const ensureVersions = () => {
      store.intake.forEach((row: any) => {
        if (!Number.isInteger(Number(row.rowVersion)) || Number(row.rowVersion) < 1) row.rowVersion = 1;
      });
    };
    ensureVersions();
    if (method === 'GET') {
      const params = new URL(req.url()).searchParams;
      const owner = params.get('owner');
      const scope = params.get('scope');
      if (owner) {
        // 서버와 같은 규칙: 지정 3계정만 미리보기 조회를 하고,
        // 패션TV봉이가 아니면 보호 대상 계정은 못 본다.
        const previewViewers = ['패션TV봉이', '박종원', '김대호'];
        const masters = ['패션TV봉이'];
        const protectedOwners = ['김진봉', '패션TV봉이', '손명아'];
        const me = store.viewer || '';
        const isMaster = masters.includes(me);
        if (!previewViewers.includes(me) || (!isMaster && protectedOwners.includes(owner))) {
          route.fulfill({ status: 403, contentType: 'application/json',
            body: JSON.stringify({ error: `${owner} 계정의 접수는 볼 수 없습니다.` }) });
          return true;
        }
        send(store.intake.filter((x: any) => String(x.ownerName || '').trim() === owner));
        return true;
      }
      if (scope === 'all') {
        if (!FINANCE_OPERATION_VIEWERS.includes(String(store.viewer || '').trim())) {
          send({ error: '전체 접수는 지정된 인원만 볼 수 있습니다.' }, 403);
          return true;
        }
        send(store.intake);
        return true;
      }
      // 기본 GET은 로그인 계정의 개인 원장만 반환한다. 최종정산은 반드시
      // scope=all을 별도로 요청해야 두 범위가 테스트에서도 섞이지 않는다.
      send(store.intake.filter((row: any) => {
        const ownerName = String(row.ownerName || '').trim();
        if (ownerName) return ownerName === String(store.viewer || '').trim();
        const ownerId = String(row.owner || '').trim();
        return !ownerId || ownerId === 'e2e-test-user';
      }));
    }
    else if (method === 'PUT' && tail[1] === 'bank-match-eligibility') {
      const index = store.intake.findIndex((row: any) => row.id === tail[0]);
      if (index < 0) send({ error: '접수를 찾을 수 없습니다.' }, 404);
      else if (Number(body.expectedRowVersion) !== Number(store.intake[index].rowVersion)) {
        send({ error: '다른 작업자가 먼저 수정했습니다.' }, 409);
      } else {
        store.intake[index] = {
          ...store.intake[index],
          bankMatchEligible: body.eligible === true,
          bankMatchApprovedAt: body.eligible === true ? '2026-08-09T00:00:00.000Z' : null,
          rowVersion: Number(store.intake[index].rowVersion) + 1,
        };
        send(store.intake[index]);
      }
    }
    else if (method === 'DELETE') {
      const index = store.intake.findIndex((x: any) => x.id === tail[0]);
      if (index < 0) send({ error: '접수를 찾을 수 없습니다.' }, 404);
      else if (Number(body.expectedRowVersion) !== Number(store.intake[index].rowVersion)) {
        send({ error: '다른 작업자가 먼저 수정했습니다.', code: 'INTAKE_VERSION_CONFLICT' }, 409);
      } else if (['paid', 'partial', 'wrong'].includes(String(store.intake[index].paid || ''))
        || Number(store.intake[index].paidAmount || 0) !== 0
        || store.intake[index].vendorPaid === true) {
        send({ error: '재무 확정 행은 삭제할 수 없습니다.', code: 'INTAKE_FINANCE_CONFIRMED' }, 409);
      } else if (store.intake.some((row: any) => String(row.refOf || '') === String(tail[0]))) {
        send({ error: '연결된 행을 먼저 정리해 주세요.', code: 'INTAKE_RELATION_PARENT' }, 409);
      } else {
        store.intake.splice(index, 1);
        send({ deleted: tail[0] });
      }
    } else if (method === 'PATCH') {
      const requested = Array.isArray(body.rows) ? body.rows : [];
      const conflict = requested.find((entry: any) => {
        const current = store.intake.find((row: any) => row.id === entry.id);
        return !current || Number(current.rowVersion) !== Number(entry.expectedRowVersion);
      });
      if (conflict) {
        const exists = store.intake.some((row: any) => row.id === conflict.id);
        send({
          error: exists ? '다른 작업자가 먼저 수정했습니다.' : '접수를 찾을 수 없습니다.',
          ...(exists ? { code: 'INTAKE_VERSION_CONFLICT' } : {}),
        }, exists ? 409 : 404);
      } else {
        const rows = requested.map((entry: any) => {
          const index = store.intake.findIndex((row: any) => row.id === entry.id);
          store.intake[index] = {
            ...store.intake[index],
            ...(entry.changes || {}),
            rowVersion: Number(store.intake[index].rowVersion) + 1,
          };
          const recalculatesPaid = body.action === 'payment'
            || (body.action === 'business'
              && ['expectedDepositAmount', 'sell', 'qty', 'kind']
                .some(field => Object.prototype.hasOwnProperty.call(entry.changes || {}, field)));
          if (recalculatesPaid) {
            const row = store.intake[index];
            const sign = row.kind === 'refund' ? -1 : 1;
            const expectedRaw = Number(row.expectedDepositAmount ?? (Number(row.sell) || 0) * (Number(row.qty) || 0)) || 0;
            const paidRaw = Number(row.paidAmount) || 0;
            const expected = expectedRaw < 0 ? expectedRaw : expectedRaw * sign;
            const paid = paidRaw < 0 ? paidRaw : paidRaw * sign;
            row.paid = !paid
              ? 'none'
              : paid === expected
                ? 'paid'
                : Math.sign(paid) === Math.sign(expected) && Math.abs(paid) < Math.abs(expected)
                  ? 'partial'
                  : 'wrong';
            if (body.action === 'payment') row.paidAuto = false;
          }
          if (body.action === 'vendor') {
            const row = store.intake[index];
            const sign = row.kind === 'refund' ? -1 : 1;
            const semanticQty = (Number(row.qty) || 0) * sign;
            row.vendorPaidAmount = Number(row.cost) * semanticQty;
            row.vendorBy = store.viewer;
          }
          return store.intake[index];
        });
        send({ rows });
      }
    } else if (method === 'POST') {
      const requested = Array.isArray(body.rows) ? body.rows : [];
      if (requested.some((row: any) => store.intake.some((current: any) => current.id === row.id))) {
        send({ error: '이미 존재하는 접수입니다.', code: 'INTAKE_ID_CONFLICT' }, 409);
      } else {
        const rows = requested.map((row: any) => ({ ...row, rowVersion: 1 }));
        store.intake.push(...rows);
        send({ rows });
      }
    } else {
      send({ error: '허용되지 않은 요청입니다.' }, 405);
    }
    return true;
  }

  if (area === 'prices') {
    if (method === 'GET') send(store.prices);
    else if (method === 'DELETE') {
      const base = BASE_PRICES.find(([a, b, c]) => `${a}|${b}|${c}` === tail[0]);
      if (base) {
        const [a, b, c, cost, unit] = base;
        const reset = { key: tail[0], a, b, c, cost, unit, custom: false, edited: false };
        const index = store.prices.findIndex((row: any) => row.key === tail[0]);
        if (index >= 0) store.prices[index] = reset;
        else store.prices.push(reset);
        send({ reset: tail[0] });
      } else {
        store.prices = store.prices.filter((x: any) => x.key !== tail[0]);
        send({ deleted: tail[0] });
      }
    } else {
      const i = store.prices.findIndex((x: any) => x.key === body.key);
      const base = BASE_PRICES.find(([a, b, c]) => `${a}|${b}|${c}` === body.key);
      const edited = Boolean(!body.custom && base
        && (body.cost !== base[3] || body.unit !== base[4]));
      const saved = { ...body, edited };
      if (i >= 0) store.prices[i] = saved; else store.prices.push(saved);
      send({ saved: body.key });
    }
    return true;
  }

  if (area === 'credit') {
    if (method === 'GET') send(store.credit);
    else if (method === 'DELETE') {
      store.credit = store.credit.filter((x: any) => x.id !== tail[0]);
      send({ deleted: tail[0] });
    } else {
      (body.rows || []).forEach((row: any) => upsert(store.credit, row));
      send({ saved: (body.rows || []).length });
    }
    return true;
  }

  if (area === 'credit-requests') {
    if (method === 'GET') {
      const scope = new URL(req.url()).searchParams.get('scope') === 'all' ? 'all' : 'mine';
      const requests = scope === 'all'
        ? store.creditRequests
        : store.creditRequests.filter((row: any) => row.requesterUid === 'e2e-test-user');
      send({ requests, scope });
    } else if (method === 'POST') {
      const record = {
        id: `credit-request-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        requesterUid: 'e2e-test-user',
        requesterName: store.viewer,
        targetAccountId: body.targetAccountId,
        requestDate: body.requestDate,
        client: body.client,
        depositorName: body.depositorName,
        product: body.product,
        vendor: body.vendor,
        expectedAmount: body.expectedAmount,
        pointAmount: body.pointAmount,
        memo: body.memo || '',
        status: 'PENDING',
        bankTransactionId: null,
      };
      store.creditRequests.unshift(record);
      send({ request: record, created: true }, 201);
    } else if (method === 'DELETE') {
      const record = store.creditRequests.find((row: any) => row.id === tail[0]);
      if (!record || record.status !== 'PENDING') {
        send({ error: '대기 요청을 찾지 못했습니다.' }, 409);
      } else {
        record.status = 'CANCELLED';
        send({ request: record, cancelled: record.id });
      }
    } else {
      send({ error: '허용되지 않은 요청입니다.' }, 405);
    }
    return true;
  }

  if (area === 'final-execution') {
    if (method !== 'GET') {
      send({ error: '최종실행정산서는 조회 전용입니다.' }, 405);
      return true;
    }
    if (!FINAL_EXECUTION_VIEWERS.includes(store.viewer)) {
      send({ error: '최종실행정산서 열람 권한이 없습니다.' }, 403);
      return true;
    }
    const rows = Object.entries(store.monthly || {}).flatMap(([view, entries]) =>
      (Array.isArray(entries) ? entries : []).map((row: any) => ({ ...row, view }))
    );
    send({ rows });
    return true;
  }

  if (area === 'finance-requests') {
    const id = tail[0] || '';
    const reviewer = FINANCE_REVIEWERS.includes(String(store.viewer || '').trim());
    const kindToView: Record<string, string> = {
      TAX_ADVANCE: 'tax-advance',
      TAX_CORRECTION: 'tax-correction',
      REFUND_CLIENT: 'refund-client',
      REFUND_MISTAKEN: 'refund-mistaken',
      EXPENSE_AD: 'expense-ad',
      EXPENSE_SUPPLIES: 'expense-supplies',
    };
    const requestTypeOf = (row: any) => String(
      row?.requestType || row?.type || row?.view || row?.category
      || kindToView[String(row?.kind || '').toUpperCase()] || '',
    ).trim();
    const workspaceOf = (row: any) => String(row?.workspaceId || row?.workspace_id || 'ws_peak');
    const isRefund = (row: any) => ['REFUND_CLIENT', 'REFUND_MISTAKEN']
      .includes(String(row?.kind || '').toUpperCase());
    const eligibleRefundDeposits = (request: any) => {
      const requestWorkspace = workspaceOf(request);
      const requestAmount = Number(request?.amountVat || request?.amount_vat || 0);
      const sourceAccountId = String(request?.sourceAccountId || request?.source_account_id || '');
      const used = new Set((Array.isArray(store.financeRequests) ? store.financeRequests : [])
        .filter((row: any) => row !== request
          && workspaceOf(row) === requestWorkspace
          && isRefund(row)
          && String(row.status || '').toUpperCase() === 'COMPLETED'
          && (row.bankTransactionId || row.bank_transaction_id))
        .map((row: any) => String(row.bankTransactionId || row.bank_transaction_id)));
      return (Array.isArray(store.bank?.transactions) ? store.bank.transactions : [])
        .filter((row: any) => workspaceOf(row) === requestWorkspace)
        .filter((row: any) => String(row.direction || '').toUpperCase() === 'DEPOSIT')
        .filter((row: any) => ['BANK_SYNC', 'COLLECTOR'].includes(String(row.source || '').toUpperCase()))
        .filter((row: any) => !['IGNORED', 'REVERSED'].includes(String(row.status || row.reconciliationStatus || '').toUpperCase()))
        .filter((row: any) => Number(row.amount || 0) >= requestAmount)
        .filter((row: any) => !sourceAccountId || String(row.accountId || row.account_id || '') === sourceAccountId)
        .filter((row: any) => !used.has(String(row.id || '')));
    };
    (Array.isArray(store.financeRequests) ? store.financeRequests : []).forEach((row: any) => {
      if (!Number.isSafeInteger(Number(row.version)) || Number(row.version) < 1) row.version = 1;
      if (!row.workspaceId && !row.workspace_id) row.workspaceId = 'ws_peak';
      if (!Object.prototype.hasOwnProperty.call(row, 'currentInvoiceEvidenceId')) {
        row.currentInvoiceEvidenceId = row.current_invoice_evidence_id || null;
      }
    });

    if (tail[1] === 'invoice-evidence') {
      const request = (Array.isArray(store.financeRequests) ? store.financeRequests : [])
        .find((row: any) => String(row.id || '') === id);
      if (!request) {
        send({ error: '금융 요청을 찾지 못했습니다.' }, 404);
        return true;
      }
      store.taxInvoiceEvidence = store.taxInvoiceEvidence || {};
      const rows = Array.isArray(store.taxInvoiceEvidence[id]) ? store.taxInvoiceEvidence[id] : [];
      if (method === 'GET' && tail.length === 2) {
        const mine = String(request.requesterUid || '') === 'e2e-test-user';
        if (!reviewer && !mine) {
          send({ error: '다른 사용자의 증빙을 볼 수 없습니다.' }, 403);
          return true;
        }
        const output = rows.map((row: any) => reviewer ? row : ({
          ...row,
          invoiceNumber: `${'*'.repeat(Math.max(0, String(row.invoiceNumber || '').length - 4))}${String(row.invoiceNumber || '').slice(-4)}`,
          supplierRegistrationNumber: `${String(row.supplierRegistrationNumber || '').slice(0, 3)}-**-**${String(row.supplierRegistrationNumber || '').slice(-3)}`,
          documentIdentifier: `${'*'.repeat(Math.max(0, String(row.documentIdentifier || '').length - 4))}${String(row.documentIdentifier || '').slice(-4)}`,
          correctionReason: '',
          protectedOriginalAvailable: false,
          originalFilename: undefined,
          sha256: undefined,
          contentPath: undefined,
        }));
        send({
          request: {
            id,
            invoiceStatus: request.invoiceStatus,
            version: Number(request.version),
            currentEvidenceId: request.currentInvoiceEvidenceId || null,
          },
          evidence: output,
          masked: !reviewer,
          registrationOnly: true,
          externalIssuancePerformed: false,
        });
        return true;
      }
      if (method === 'GET' && tail[2] && tail[3] === 'content') {
        if (!reviewer) {
          send({ error: '증빙 원본은 재무 검토자만 볼 수 있습니다.' }, 403);
          return true;
        }
        const evidence = rows.find((row: any) => String(row.id || '') === String(tail[2] || ''));
        if (!evidence) {
          send({ error: '증빙 원본을 찾지 못했습니다.' }, 404);
          return true;
        }
        void route.fulfill({
          status: 200,
          contentType: String(evidence.mimeType || 'application/pdf'),
          headers: { 'Content-Disposition': `attachment; filename="${evidence.originalFilename || 'invoice.pdf'}"` },
          body: '%PDF-1.4\n%%EOF\n',
        });
        return true;
      }
      if (method === 'POST' && tail.length === 2) {
        if (!reviewer) {
          send({ error: '발급 증빙 등록 권한이 없습니다.' }, 403);
          return true;
        }
        const raw = String(req.postData() || '');
        const field = (name: string) => {
          const match = new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n]*)`).exec(raw);
          return String(match?.[1] || '').trim();
        };
        if (!/name="document";\s*filename="[^"]+"/i.test(raw)) {
          send({ error: '세금계산서 원본 파일이 필요합니다.' }, 400);
          return true;
        }
        if (Number(field('expectedVersion')) !== Number(request.version)) {
          send({ code: 'TAX_INVOICE_EVIDENCE_VERSION_CONFLICT', error: '다른 화면에서 요청이 먼저 변경되었습니다.' }, 409);
          return true;
        }
        const targetStatus = field('invoiceStatus').toUpperCase();
        if (!['ISSUED', 'CORRECTED'].includes(targetStatus)) {
          send({ error: '증빙 등록 상태를 확인해 주세요.' }, 400);
          return true;
        }
        const currentEvidenceId = String(request.currentInvoiceEvidenceId || '');
        const evidenceId = `96c9d661-5349-4684-8962-${String(rows.length + 1).padStart(12, '0')}`;
        const evidence = {
          id: evidenceId,
          requestId: id,
          revision: rows.length + 1,
          action: currentEvidenceId && String(request.invoiceStatus || '').toUpperCase() === targetStatus
            ? 'REPLACEMENT'
            : (targetStatus === 'CORRECTED' ? 'CORRECTION' : 'ISSUE'),
          invoiceStatus: targetStatus,
          invoiceNumber: field('invoiceNumber'),
          issuedAt: field('issuedAt'),
          supplierRegistrationNumber: field('supplierRegistrationNumber'),
          documentIdentifier: field('documentIdentifier'),
          correctionReason: field('correctionReason'),
          mimeType: raw.includes('Content-Type: image/png') ? 'image/png'
            : (raw.includes('Content-Type: image/jpeg') ? 'image/jpeg' : 'application/pdf'),
          sizeBytes: Math.max(1, raw.length),
          supersedesEvidenceId: currentEvidenceId || null,
          registeredByName: store.viewer,
          createdAt: '2026-08-17T09:00:00.000Z',
          protectedOriginalAvailable: true,
          originalFilename: /name="document";\s*filename="([^"]+)"/i.exec(raw)?.[1] || 'invoice.pdf',
          sha256: 'a'.repeat(64),
          contentPath: `/api/peakos/finance-requests/${id}/invoice-evidence/${evidenceId}/content`,
          registrationOnly: true,
          externalIssuancePerformed: false,
        };
        rows.unshift(evidence);
        store.taxInvoiceEvidence[id] = rows;
        store.lastTaxInvoiceMultipart = raw;
        request.invoiceRequested = true;
        request.invoiceStatus = targetStatus;
        request.currentInvoiceEvidenceId = evidenceId;
        request.current_invoice_evidence_id = evidenceId;
        request.invoiceEvidenceUrl = '';
        request.version = Number(request.version) + 1;
        send({
          evidence,
          request: {
            id,
            invoiceStatus: targetStatus,
            currentEvidenceId: evidenceId,
            version: Number(request.version),
          },
          message: '외부에서 발급된 세금계산서의 검증 증빙을 등록했습니다.',
          registrationOnly: true,
          externalIssuancePerformed: false,
        }, 201);
        return true;
      }
    }

    if (method === 'GET' && tail[1] === 'refund-deposits') {
      if (!reviewer) {
        send({ error: '환불 입금 확인 권한이 없습니다.' }, 403);
        return true;
      }
      const request = (Array.isArray(store.financeRequests) ? store.financeRequests : [])
        .find((row: any) => String(row.id || '') === id);
      if (!request) {
        send({ error: '금융 요청을 찾지 못했습니다.' }, 404);
        return true;
      }
      if (!isRefund(request)) {
        send({ error: '환불 요청에만 입금 거래를 연결할 수 있습니다.' }, 409);
        return true;
      }
      if (!['APPROVED', 'PROCESSING'].includes(String(request.status || '').toUpperCase())) {
        send({ error: '승인 또는 처리 중인 환불 요청에서만 입금 거래를 선택할 수 있습니다.' }, 409);
        return true;
      }
      const url = new URL(req.url());
      const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
      const page = Math.max(1, Number(url.searchParams.get('page') || 1));
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 50)));
      const candidates = eligibleRefundDeposits(request).filter((row: any) => {
        if (!query) return true;
        return `${row.summary || ''} ${row.counterpartyName || row.counterparty_name || ''}`
          .toLowerCase().includes(query);
      });
      const total = candidates.length;
      const start = (page - 1) * limit;
      const deposits = candidates.slice(start, start + limit).map((row: any) => ({
        id: String(row.id),
        accountId: row.accountId || row.account_id,
        transactionAt: row.transactionAt || row.transaction_at,
        amount: Number(row.amount || 0),
        summary: String(row.summary || ''),
        counterpartyName: String(row.counterpartyName || row.counterparty_name || ''),
        status: row.status || row.reconciliationStatus || row.reconciliation_status,
        source: row.source,
      }));
      store.financeRequestEvents = Array.isArray(store.financeRequestEvents) ? store.financeRequestEvents : [];
      store.financeRequestEvents.push({
        requestId: id,
        type: 'FINANCE_REQUEST_REFUND_DEPOSIT_CANDIDATES_VIEWED',
        page,
        limit,
        returned: deposits.length,
        searchApplied: Boolean(query),
      });
      send({
        request: {
          id: String(request.id),
          kind: request.kind,
          amountVat: Number(request.amountVat || request.amount_vat || 0),
          sourceAccountId: request.sourceAccountId || request.source_account_id || null,
          status: request.status,
          version: Number(request.version),
        },
        deposits,
        pagination: {
          page,
          limit,
          total,
          totalPages: total ? Math.ceil(total / limit) : 0,
          total_pages: total ? Math.ceil(total / limit) : 0,
        },
      });
      return true;
    }

    if (method === 'GET') {
      const url = new URL(req.url());
      const requestedType = String(
        url.searchParams.get('requestType')
        || url.searchParams.get('type')
        || url.searchParams.get('view')
        || '',
      ).trim();
      const wantsAll = url.searchParams.get('scope') === 'all';
      const kinds = url.searchParams.getAll('kind')
        .flatMap(value => value.split(','))
        .map(value => value.trim().toUpperCase())
        .filter(Boolean);
      const excludedStatuses = String(url.searchParams.get('excludeStatus') || url.searchParams.get('exclude_status') || '')
        .split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
      const invoiceOnly = ['true', '1'].includes(String(url.searchParams.get('invoiceRequested') || url.searchParams.get('invoice_requested') || '').toLowerCase());
      const from = String(url.searchParams.get('from') || '');
      const to = String(url.searchParams.get('to') || '');
      const page = Math.max(1, Number(url.searchParams.get('page') || 1));
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 50)));
      const filtered = (Array.isArray(store.financeRequests) ? store.financeRequests : [])
        .filter((row: any) => {
          const rowType = requestTypeOf(row);
          if (!requestedType) return true;
          if (requestedType === 'refund-history') {
            return rowType === 'refund-client' || rowType === 'refund-mistaken';
          }
          if (requestedType === 'refund-invoice') {
            return rowType === 'refund-client' && row.invoiceRequested === true;
          }
          return rowType === requestedType;
        })
        .filter((row: any) => !kinds.length || kinds.includes(String(row.kind || '').toUpperCase()))
        .filter((row: any) => !invoiceOnly || row.invoiceRequested === true)
        .filter((row: any) => !excludedStatuses.includes(String(row.status || '').toUpperCase()))
        .filter((row: any) => !from || String(row.requestDate || '').slice(0, 10) >= from)
        .filter((row: any) => !to || String(row.requestDate || '').slice(0, 10) <= to)
        .filter((row: any) => reviewer && wantsAll
          ? true
          : String(row.requesterUid || '') === 'e2e-test-user');
      const total = filtered.length;
      const totalPages = total ? Math.ceil(total / limit) : 0;
      const start = (page - 1) * limit;
      const requests = filtered.slice(start, start + limit);
      send({
        requests,
        scope: reviewer && wantsAll ? 'all' : 'mine',
        pagination: { page, limit, total, totalPages, total_pages: totalPages },
      });
      return true;
    }

    if (method === 'POST') {
      const now = '2026-08-08T09:00:00+09:00';
      const kind = String(body.kind || '').toUpperCase();
      const taxInvoiceRequest = kind === 'TAX_ADVANCE' || kind === 'TAX_CORRECTION';
      const invoiceRequested = taxInvoiceRequest || body.invoiceRequested === true;
      const record = {
        ...body,
        id: `finance-request-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        requesterUid: 'e2e-test-user',
        requesterName: store.viewer,
        requestType: requestTypeOf(body),
        requestDate: String(body.requestDate || body.date || '2026-08-08').slice(0, 10),
        client: String(body.client || body.clientName || body.vendor || body.counterparty || ''),
        clientName: String(body.clientName || body.client || body.vendor || body.counterparty || ''),
        amount: Number(body.amount || body.amountVat || body.requestAmount || 0),
        amountVat: Number(body.amountVat || body.amount || body.requestAmount || 0),
        memo: String(body.memo || body.reason || ''),
        reason: String(body.reason || body.memo || ''),
        status: String(body.status || 'PENDING'),
        invoiceRequested,
        invoiceStatus: kind === 'TAX_CORRECTION'
          ? 'CORRECTION_REQUESTED'
          : (invoiceRequested ? 'REQUESTED' : 'NOT_REQUESTED'),
        workspaceId: String(body.workspaceId || body.workspace_id || 'ws_peak'),
        version: 1,
        currentInvoiceEvidenceId: null,
        createdAt: now,
        updatedAt: now,
      };
      store.financeRequests.unshift(record);
      send({ request: record, created: true }, 201);
      return true;
    }

    const index = (Array.isArray(store.financeRequests) ? store.financeRequests : [])
      .findIndex((row: any) => String(row.id || '') === id);
    if (index < 0) {
      send({ error: '재무 요청을 찾지 못했습니다.' }, 404);
      return true;
    }
    const mine = String(store.financeRequests[index].requesterUid || '') === 'e2e-test-user';

    if (method === 'PATCH') {
      if (!reviewer) {
        send({ error: '수정 권한이 없습니다.' }, 403);
        return true;
      }
      const current = store.financeRequests[index];
      if (['ISSUED', 'CORRECTED'].includes(String(body.invoiceStatus || '').toUpperCase())
        || Object.prototype.hasOwnProperty.call(body, 'invoiceEvidenceUrl')
        || Object.prototype.hasOwnProperty.call(body, 'invoice_evidence_url')) {
        send({
          code: 'TAX_INVOICE_EVIDENCE_PROTECTED_UPLOAD_REQUIRED',
          error: '발급·정정 완료는 발급번호와 보호된 원본 파일을 증빙 등록 화면에서 함께 등록해야 합니다.',
        }, 409);
        return true;
      }
      const currentVersion = Number(current.version);
      const hasExpectedVersion = Object.prototype.hasOwnProperty.call(body, 'expectedVersion');
      const statusTransition = Object.prototype.hasOwnProperty.call(body, 'status')
        && String(body.status || '').toUpperCase() !== String(current.status || '').toUpperCase();
      if (statusTransition && !hasExpectedVersion) {
        send({ error: 'expectedVersion이 필요합니다.' }, 400);
        return true;
      }
      if (hasExpectedVersion && Number(body.expectedVersion) !== currentVersion) {
        send({ error: '금융 요청이 다른 화면에서 먼저 변경되었습니다.', code: 'FINANCE_REQUEST_VERSION_CONFLICT' }, 409);
        return true;
      }
      const nextStatus = String(body.status ?? current.status ?? '').toUpperCase();
      const requestedBankTransactionId = String(body.bankTransactionId ?? current.bankTransactionId ?? '');
      if (isRefund(current) && nextStatus === 'COMPLETED'
          && String(current.status || '').toUpperCase() !== 'COMPLETED') {
        const candidate = eligibleRefundDeposits(current)
          .find((row: any) => String(row.id || '') === requestedBankTransactionId);
        if (!candidate) {
          send({ error: '같은 워크스페이스의 검증된 입금 거래를 선택해야 합니다.', code: 'FINANCE_REQUEST_REFUND_DEPOSIT_INVALID' }, 409);
          return true;
        }
      }
      const { expectedVersion: _expectedVersion, ...changes } = body;
      const updated = {
        ...current,
        ...changes,
        id: current.id,
        requesterUid: current.requesterUid,
        requesterName: current.requesterName,
        version: currentVersion + 1,
        updatedAt: '2026-08-08T10:00:00+09:00',
      };
      if (isRefund(current) && nextStatus === 'COMPLETED'
          && String(current.status || '').toUpperCase() !== 'COMPLETED') {
        updated.bankTransactionId = requestedBankTransactionId;
        updated.refundDepositConfirmedAt = '2026-08-08T10:00:00+09:00';
        updated.refundDepositConfirmedByUid = 'e2e-test-user';
        updated.refundDepositConfirmedByName = store.viewer;
        updated.processedAt = '2026-08-08T10:00:00+09:00';
        updated.processedByUid = 'e2e-test-user';
        updated.processedByName = store.viewer;
      }
      if (['REJECTED', 'CANCELLED'].includes(String(updated.status || '').toUpperCase())
          && !['ISSUED', 'CORRECTED'].includes(String(updated.invoiceStatus || '').toUpperCase())) {
        updated.invoiceStatus = updated.invoiceRequested ? 'CANCELLED' : 'NOT_REQUESTED';
      }
      store.financeRequests[index] = updated;
      send({ request: updated, updated: true });
      return true;
    }

    if (method === 'DELETE') {
      if (!reviewer && !mine) {
        send({ error: '삭제 권한이 없습니다.' }, 403);
        return true;
      }
      if (Number(body.expectedVersion) !== Number(store.financeRequests[index].version)) {
        send({ error: '금융 요청이 다른 화면에서 먼저 변경되었습니다.', code: 'FINANCE_REQUEST_VERSION_CONFLICT' }, 409);
        return true;
      }
      const cancelled = {
        ...store.financeRequests[index],
        status: 'CANCELLED',
        invoiceStatus: store.financeRequests[index].invoiceRequested === true
          && !['ISSUED', 'CORRECTED'].includes(String(store.financeRequests[index].invoiceStatus || '').toUpperCase())
          ? 'CANCELLED'
          : store.financeRequests[index].invoiceStatus,
        version: Number(store.financeRequests[index].version) + 1,
        updatedAt: '2026-08-08T10:00:00+09:00',
      };
      store.financeRequests[index] = cancelled;
      send({ request: cancelled, cancelled: true });
      return true;
    }

    send({ error: '허용되지 않은 요청입니다.' }, 405);
    return true;
  }

  if (area === 'monthly') {
    const view = tail[0];
    store.monthly[view] = store.monthly[view] || [];
    store.monthly[view].forEach((row: any) => {
      if (!Number.isInteger(Number(row.rowVersion)) || Number(row.rowVersion) < 1) row.rowVersion = 1;
    });
    if (method === 'GET') send(store.monthly[view]);
    else if (method === 'DELETE') {
      const id = tail[1];
      const current = store.monthly[view].find((row: any) => row.id === id);
      if (!current) send({ error: '월별 정산 행을 찾지 못했습니다.' }, 404);
      else if (Number(body.expectedRowVersion) !== Number(current.rowVersion)) {
        send({ error: '다른 작업자가 먼저 수정했습니다.' }, 409);
      } else if (['COMPLETED', 'FROZEN'].includes(String(store.settlementCompletion?.[id]?.status || ''))) {
        send({
          code: 'SETTLEMENT_COMPLETION_SOURCE_LOCKED',
          error: '완료 또는 동결된 정산 원본은 재개 후 삭제할 수 있습니다.',
        }, 409);
      } else if (store.settlementCompletion?.[id]?.tracked === true) {
        send({
          code: 'SETTLEMENT_COMPLETION_SOURCE_ATTACHED',
          error: '완료 근거와 감사 이력이 연결된 원본은 삭제할 수 없습니다.',
        }, 409);
      } else if (current.kind === 'sale'
        && store.monthly[view].some((row: any) => String(row.parentId || '') === String(id))) {
        send({ error: '붙어 있는 실행 건을 먼저 삭제해 주세요.' }, 409);
      } else {
        store.monthly[view] = store.monthly[view].filter((x: any) => x.id !== id);
        send({ deleted: id });
      }
    } else if (method === 'PATCH') {
      const requested = Array.isArray(body.rows) ? body.rows : [];
      const conflict = requested.find((entry: any) => {
        const current = store.monthly[view].find((row: any) => row.id === entry.id);
        return !current || Number(current.rowVersion) !== Number(entry.expectedRowVersion);
      });
      const locked = requested.find((entry: any) => ['COMPLETED', 'FROZEN']
        .includes(String(store.settlementCompletion?.[entry.id]?.status || '')));
      const changesRule = requested.find((entry: any) => store.settlementCompletion?.[entry.id]?.tracked === true
        && Object.prototype.hasOwnProperty.call(entry.changes || {}, 'c'));
      if (conflict) {
        const exists = store.monthly[view].some((row: any) => row.id === conflict.id);
        send({ error: exists ? '다른 작업자가 먼저 수정했습니다.' : '월별 정산 행을 찾지 못했습니다.' }, exists ? 409 : 404);
      } else if (locked) {
        send({
          code: 'SETTLEMENT_COMPLETION_SOURCE_LOCKED',
          error: '완료 또는 동결된 정산 원본은 재개 후 수정할 수 있습니다.',
        }, 409);
      } else if (changesRule) {
        send({
          code: 'SETTLEMENT_COMPLETION_SOURCE_ATTACHED',
          error: '완료 근거가 연결된 원본의 정산 규칙은 바꿀 수 없습니다.',
        }, 409);
      } else {
        const rows = requested.map((entry: any) => {
          const index = store.monthly[view].findIndex((row: any) => row.id === entry.id);
          store.monthly[view][index] = {
            ...store.monthly[view][index],
            ...(entry.changes || {}),
            rowVersion: Number(store.monthly[view][index].rowVersion) + 1,
          };
          return store.monthly[view][index];
        });
        send({ rows });
      }
    } else if (method === 'POST') {
      const requested = Array.isArray(body.rows) ? body.rows : [];
      if (requested.some((row: any) => store.monthly[view].some((current: any) => current.id === row.id))) {
        send({ error: '이미 존재하는 월별 정산 행입니다.' }, 409);
      } else {
        const rows = requested.map((row: any) => ({ ...row, rowVersion: 1 }));
        store.monthly[view].push(...rows);
        send({ rows });
      }
    } else {
      send({ error: '허용되지 않은 요청입니다.' }, 405);
    }
    return true;
  }

  if (area === 'fund') {
    if (method === 'GET') send(store.fund);
    else { store.fund = body.board; send({ saved: true }); }
    return true;
  }

  send([]);
  return true;
}

/** 계정 정보와 PEAK OS 스텁을 한 번에 깐다. */
export async function installPeakosStub(
  page: Page,
  user: {
    name: string; uid?: string; role?: string; group_name?: string; group_type?: string;
    peakos_can_view_finance_operations?: boolean;
    peakos_can_view_tax_purchase?: boolean;
    peakos_can_preview_accounts?: boolean;
  }
) {
  const store = createPeakosStore(user.name, user.role || 'manager');
  await page.route('**/api/**', route => {
    if (handlePeakos(store, route)) return;
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    let payload: unknown = [];
    if (path === '/users/me') {
      payload = {
        uid: user.uid || 'e2e-test-user',
        name: user.name,
        role: user.role || 'manager',
        approved: true,
        is_active: true,
        group_name: user.group_name || '본사 영업팀',
        group_type: user.group_type || (String(user.group_name || '본사 영업팀').includes('영업') ? 'sales' : 'support'),
        peakos_can_read_bank: true,
        peakos_can_view_bank_balances: FINANCE_REVIEWERS.includes(user.name),
        peakos_can_review_finance: FINANCE_REVIEWERS.includes(user.name),
        peakos_can_view_finance_operations: user.peakos_can_view_finance_operations
          ?? FINANCE_OPERATION_VIEWERS.includes(user.name),
        peakos_can_view_tax_purchase: user.peakos_can_view_tax_purchase
          ?? FINANCE_OPERATION_VIEWERS.includes(user.name),
        peakos_can_preview_accounts: user.peakos_can_preview_accounts
          ?? ACCOUNT_PREVIEW_VIEWERS.includes(user.name),
        peakos_special_settlement_views:
          user.name === '김지홍' ? ['monthly-guarantee']
            : user.name === '박우진' ? ['monthly-manage']
              : user.name === '김대호' ? ['direct-execution'] : [],
        peakos_can_view_final_execution: FINAL_EXECUTION_VIEWERS.includes(user.name),
      };
    } else if (path === '/service-requests') {
      payload = { canManage: false, requests: store.serviceRequests };
    } else if (path === '/chat-rooms/unread') {
      payload = {};
    } else if (path === '/projects') {
      payload = { canManageAll: false, projects: [] };
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  return store;
}

// 로그인 직후 뜨는 리마인더 팝업은 모달이라 메뉴 클릭을 가로막는다.
// 팝업 자체를 검사하는 스펙이 아니면 닫고 시작한다.
export async function dismissReminder(page: any) {
  const close = page.locator('#reminderPanel [data-reminder-close]');
  if (await close.isVisible({ timeout: 2000 }).catch(() => false)) {
    await close.click().catch(() => {});
  }
}
