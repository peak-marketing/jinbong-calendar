import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

const EXTERNAL_CALENDAR_STATE = {
  events: [
    {
      id: 'own-1',
      type: 'meeting',
      title: '외부 본인 일정',
      date: new Date().toISOString().slice(0, 10),
      scope: 'personal',
      owner_id: 'e2e-test-user',
      owner_name: 'External',
      deleted: false,
    },
  ],
  users: [{
    uid: 'e2e-test-user',
    name: 'External',
    email: 'external@test.local',
    role: 'member',
    approved: true,
    is_active: true,
    chat_only: false,
    external_calendar_only: true,
  }],
  chatRooms: [],
  chatMessages: {},
  chatMembers: {},
  chatUnreadCounts: {},
};

test.describe('external calendar only mode', () => {
  test('shows only calendar and chat tabs, and clamps other pages to calendar', async ({ page }) => {
    await setupStubs(page, EXTERNAL_CALENDAR_STATE as any);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });

    const visibleSidebar = await page.evaluate(() =>
      [...document.querySelectorAll('.sidebar-item')]
        .filter(el => getComputedStyle(el).display !== 'none')
        .map(el => el.textContent?.trim())
    );
    expect(visibleSidebar.some(t => (t || '').includes('캘린더'))).toBe(true);
    expect(visibleSidebar.some(t => (t || '').includes('채팅'))).toBe(true);
    expect(visibleSidebar.some(t => (t || '').includes('보고서'))).toBe(false);
    expect(visibleSidebar.some(t => (t || '').includes('공지'))).toBe(false);
    expect(visibleSidebar.some(t => (t || '').includes('아이디어'))).toBe(false);

    const after = await page.evaluate(() => {
      const w = window as any;
      w.navTo('report');
      const reportTitle = document.getElementById('mainTitle')?.textContent || '';
      w.navTo('idea');
      const ideaTitle = document.getElementById('mainTitle')?.textContent || '';
      w.navTo('chat');
      const chatTitle = document.getElementById('mainTitle')?.textContent || '';
      return { reportTitle, ideaTitle, chatTitle };
    });
    expect(after.reportTitle).toContain('캘린더');
    expect(after.ideaTitle).toContain('캘린더');
    expect(after.chatTitle).toContain('채팅');
  });

  test('boot fetches events and chat data, but skips internal pages', async ({ page }) => {
    const apis: string[] = [];
    page.on('request', req => {
      const match = req.url().match(/\/api\/([^?]+)/);
      if (match) apis.push(match[1]);
    });
    await setupStubs(page, EXTERNAL_CALENDAR_STATE as any);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.waitForTimeout(400);

    expect(apis.some(a => a === 'events' || a.startsWith('events?'))).toBe(true);
    expect(apis).toContain('chat-rooms');
    expect(apis).not.toContain('ideas');
    expect(apis).not.toContain('idea-cats');
    expect(apis).not.toContain('event-types');
    expect(apis).not.toContain('todo-cats');
    expect(apis.some(a => a.startsWith('notices/unread'))).toBe(false);
    expect(apis.some(a => a.startsWith('reports/'))).toBe(false);
  });
});
