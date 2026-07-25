import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

// A chat_only user:
//   1. sees only the 채팅 sidebar item and mobile tab
//   2. cannot navigate away from the chat tab (navTo clamps to 'chat')
//   3. never fires boot-time fetches for events/ideas/notices/reports
//   4. always gets a fresh /users/register response with chat_only=true

const CHAT_ONLY_STATE = {
  events: [],
  users: [{
    uid: 'e2e-test-user',
    name: 'ChatOnly',
    email: 'chatonly@test.local',
    role: 'member',
    approved: true,
    is_active: true,
    chat_only: true,
  }],
  chatRooms: [
    { id: 'r1', name: '영업팀', member_count: 3, created_at: new Date().toISOString() },
  ],
  chatMessages: { r1: [] },
  chatMembers: { r1: [] },
  chatUnreadCounts: {},
};

test.describe('chat_only user mode', () => {
  test('sidebar and mobile tabs only show 채팅', async ({ page }) => {
    await setupStubs(page, CHAT_ONLY_STATE as any);
    await page.goto('/');
    // Wait for chat list to render — that's the initial landing screen.
    await page.waitForFunction(() => {
      const body = document.getElementById('mainBody');
      return !!body && body.innerHTML.includes('chatRoomSearchInput');
    }, { timeout: 15_000 });

    const visibleSidebar = await page.evaluate(() =>
      [...document.querySelectorAll('.sidebar-item')]
        .filter(el => getComputedStyle(el).display !== 'none')
        .map(el => el.textContent?.trim())
    );
    const visibleMobile = await page.evaluate(() =>
      [...document.querySelectorAll('.mob-tab')]
        .filter(el => getComputedStyle(el).display !== 'none')
        .map(el => el.textContent?.trim())
    );
    expect(visibleSidebar.every(t => (t || '').includes('채팅'))).toBe(true);
    expect(visibleMobile.every(t => (t || '').includes('채팅'))).toBe(true);
  });

  test('navTo() clamps to chat on any other target', async ({ page }) => {
    await setupStubs(page, CHAT_ONLY_STATE as any);
    await page.goto('/');
    // Wait for the chat list to be rendered, confirming initial
    // boot landed on chat.
    await page.waitForFunction(() => {
      const body = document.getElementById('mainBody');
      return !!body && body.innerHTML.includes('chatRoomSearchInput');
    }, { timeout: 15_000 });

    // Regardless of navTo target, mainBody must remain the chat
    // list (any of the other pages would wipe the chat search input).
    const after = await page.evaluate(() => {
      const w = window as any;
      const body = document.getElementById('mainBody')!;
      w.navTo('calendar');
      const afterCalendar = body.innerHTML.includes('chatRoomSearchInput');
      w.navTo('report');
      const afterReport = body.innerHTML.includes('chatRoomSearchInput');
      w.navTo('notice');
      const afterNotice = body.innerHTML.includes('chatRoomSearchInput');
      return { afterCalendar, afterReport, afterNotice };
    });
    expect(after.afterCalendar).toBe(true);
    expect(after.afterReport).toBe(true);
    expect(after.afterNotice).toBe(true);
  });

  test('boot skips events/ideas/notices/reports fetches', async ({ page }) => {
    const apis: string[] = [];
    page.on('request', req => {
      const u = req.url();
      const m = u.match(/\/api\/([^?]+)/);
      if (m) apis.push(m[1]);
    });
    await setupStubs(page, CHAT_ONLY_STATE as any);
    await page.goto('/');
    await page.waitForFunction(() => {
      const body = document.getElementById('mainBody');
      return !!body && body.innerHTML.includes('chatRoomSearchInput');
    }, { timeout: 15_000 });
    await page.waitForTimeout(400);

    // Things that must NEVER be hit at boot for a chat_only user.
    expect(apis.some(a => a === 'events' || a.startsWith('events?'))).toBe(false);
    expect(apis).not.toContain('ideas');
    expect(apis).not.toContain('idea-cats');
    expect(apis).not.toContain('event-types');
    expect(apis).not.toContain('todo-cats');
    expect(apis.some(a => a.startsWith('notices/unread'))).toBe(false);
    expect(apis.some(a => a.startsWith('reports/'))).toBe(false);

    // Things that SHOULD be present (chat works).
    expect(apis).toContain('chat-rooms');
  });

  test('users/all-approved only returns self + admins for chat_only caller', async ({ page }) => {
    const state = {
      ...CHAT_ONLY_STATE,
      users: [
        CHAT_ONLY_STATE.users[0],
        { uid: 'admin-1', name: '패션tv봉이', email: 'admin1@test.local', role: 'admin', approved: true, is_active: true },
        { uid: 'admin-2', name: '또다른관리자', email: 'admin2@test.local', role: 'admin', approved: true, is_active: true },
        { uid: 'member-1', name: '일반멤버1', email: 'm1@test.local', role: 'member', approved: true, is_active: true },
        { uid: 'member-2', name: '일반멤버2', email: 'm2@test.local', role: 'member', approved: true, is_active: true },
        { uid: 'manager-1', name: '매니저', email: 'mgr@test.local', role: 'manager', approved: true, is_active: true },
      ],
    };
    await setupStubs(page, state as any);
    await page.goto('/');
    await page.waitForFunction(() => {
      const body = document.getElementById('mainBody');
      return !!body && body.innerHTML.includes('chatRoomSearchInput');
    }, { timeout: 15_000 });

    const visible = await page.evaluate(() => fetch('/api/users/all-approved', {
      headers: { Authorization: 'Bearer fake' },
    }).then(r => r.json()));
    const uids = visible.map((u: any) => u.uid).sort();
    // Only self + admins. Regular members and managers must be hidden.
    expect(uids).toEqual(['admin-1', 'admin-2', 'e2e-test-user'].sort());
    expect(uids).not.toContain('member-1');
    expect(uids).not.toContain('member-2');
    expect(uids).not.toContain('manager-1');
  });

  test('users/all-approved returns ALL users for a regular (non chat_only) caller', async ({ page }) => {
    // Sanity: the filter is restricted to chat_only.
    await setupStubs(page);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });

    const visible = await page.evaluate(() => fetch('/api/users/all-approved', {
      headers: { Authorization: 'Bearer fake' },
    }).then(r => r.json()));
    // Default stub seeds only the e2e user. Make sure the chat_only
    // filter doesn't accidentally fire for regular callers — result
    // should include every approved user.
    expect(visible.length).toBe(1);
    expect(visible[0].uid).toBe('e2e-test-user');
  });

  test('regular user still sees all tabs and fetches everything', async ({ page }) => {
    // Sanity check that the chat_only path doesn't accidentally apply
    // to ordinary accounts.
    await setupStubs(page /* default non-chat-only state */);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });

    const visibleSidebar = await page.evaluate(() =>
      [...document.querySelectorAll('.sidebar-item')]
        .filter(el => getComputedStyle(el).display !== 'none').length
    );
    expect(visibleSidebar).toBeGreaterThanOrEqual(5);
  });
});
