import { Page } from '@playwright/test';

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
      signInWithPopup: async () => ({ user: fakeUser }),
      signInWithRedirect: async () => undefined,
      getRedirectResult: async () => ({ user: null }),
      signOut: async () => { listeners.forEach(l => l(null)); },
    };
    const messagingStub: any = {
      onMessage: () => () => {},
      getToken: async () => '',
      deleteToken: async () => true,
      onTokenRefresh: () => () => {},
    };
    function GoogleAuthProvider() {}
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
          return project ? { ...project, canManage: true } : null;
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
        const task = await page.evaluate(({ projectId, body }) => {
          const state = (window as any).__e2e_api_state || {};
          const project = (state.projects || []).find((p: any) => String(p.id) === String(projectId));
          if (!project) return null;
          const assignee = (project.members || []).find((m: any) => String(m.uid) === String(body?.assigneeUid || ''));
          const record = {
            id: 'task-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
            project_id: projectId,
            title: String(body?.title || ''),
            description: String(body?.description || ''),
            assignee_uid: assignee?.uid || '',
            assignee_name: assignee?.name || '',
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
        return respond(events);
      }
      if (pathname === '/events' && method === 'POST') {
        const rec = {
          id: 'ev-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
          owner_id: 'e2e-test-user',
          owner_name: 'E2E',
          deleted: false,
          ...body,
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
        return respond(rec);
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
        await page.evaluate(({ id, patch }) => {
          const state = (window as any).__e2e_api_state;
          const arr = state.events;
          const i = arr.findIndex((e: any) => e.id === id);
          if (i >= 0) arr[i] = { ...arr[i], ...patch };
          if (Array.isArray(patch?.shareWith)) {
            state.eventShares = state.eventShares || {};
            state.eventShares[id] = [...patch.shareWith];
          }
        }, { id, patch: body });
        const updated = await page.evaluate((id) => {
          const state = (window as any).__e2e_api_state || {};
          return (state.events || []).find((event: any) => event.id === id) || null;
        }, id);
        return respond(updated || { id, ...body });
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
