import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { setupStubs } from './helpers';

const SERVER = fs.readFileSync(path.resolve(__dirname, '../../server/index.js'), 'utf8');

test.describe('team event safety', () => {
  test('new team event keeps same-group defaults and stores checklist once', async ({ page }) => {
    await setupStubs(page, {
      events: [],
      ideas: [],
      users: [
        { uid: 'e2e-test-user', name: 'Owner', email: 'owner@test.local', role: 'member', approved: true, is_active: true, group_id: 'group-a', group_name: '본사 개발팀' },
        { uid: 'same-group', name: 'Same Group', email: 'same@test.local', role: 'member', approved: true, is_active: true, group_id: 'group-a', group_name: '본사 개발팀' },
        { uid: 'other-group', name: 'Other Group', email: 'other@test.local', role: 'member', approved: true, is_active: true, group_id: 'group-b', group_name: '전주지사' },
      ],
      chatRooms: [],
      chatMessages: {},
      chatMembers: {},
      chatUnreadCounts: {},
      chatRoomGroups: [],
      eventChecklist: {},
      eventShares: {},
      groups: [],
    });

    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.evaluate(() => (window as any).openAddEvent());
    await page.locator('#evScopeTeam').click();

    await expect(page.locator('.share-check[value="same-group"]')).toBeChecked();
    await expect(page.locator('.share-check[value="other-group"]')).not.toBeChecked();

    await page.locator('#evTitle').fill('반복 팀 일정');
    await page.locator('#newChecklistInput').fill('첫 체크');
    await page.locator('#newChecklistInput').press('Enter');
    await page.locator('#evRepeat').selectOption('weekly');
    const startDate = await page.locator('#evDate').inputValue();
    const end = new Date(`${startDate}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 21);
    await page.locator('#evRepeatEnd').fill(end.toISOString().slice(0, 10));
    await page.getByRole('button', { name: '저장', exact: true }).click();

    await expect.poll(() => page.evaluate(() => (window as any).__e2e_api_state.events.length)).toBe(1);
    const stored = await page.evaluate(() => {
      const state = (window as any).__e2e_api_state;
      const event = state.events[0];
      return {
        event,
        checklist: state.eventChecklist[event.id],
        shares: state.eventShares[event.id],
      };
    });
    expect(stored.event.repeatType).toBe('weekly');
    expect(stored.checklist).toHaveLength(1);
    expect(stored.checklist[0].title).toBe('첫 체크');
    expect(stored.shares).toEqual(['same-group']);
  });

  test('editing a team event loads and replaces the actual share list', async ({ page }) => {
    await setupStubs(page, {
      events: [{
        id: 'editable-team-event',
        title: '공유 수정 일정',
        type: 'meeting',
        date: '2026-07-21',
        scope: 'team',
        owner_id: 'e2e-test-user',
        owner_name: 'Owner',
        deleted: false,
      }],
      ideas: [],
      users: [
        { uid: 'e2e-test-user', name: 'Owner', email: 'owner@test.local', role: 'member', approved: true, is_active: true, group_id: 'group-a' },
        { uid: 'member-a', name: 'Member A', email: 'a@test.local', role: 'member', approved: true, is_active: true, group_id: 'group-a' },
        { uid: 'member-b', name: 'Member B', email: 'b@test.local', role: 'member', approved: true, is_active: true, group_id: 'group-b' },
      ],
      chatRooms: [],
      chatMessages: {},
      chatMembers: {},
      chatUnreadCounts: {},
      chatRoomGroups: [],
      eventChecklist: {},
      eventShares: { 'editable-team-event': ['member-a'] },
      groups: [],
    });

    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.evaluate(() => (window as any).editEventModal('editable-team-event'));

    await expect(page.locator('.share-check[value="member-a"]')).toBeChecked();
    await expect(page.locator('.share-check[value="member-b"]')).not.toBeChecked();
    await page.locator('.share-check[value="member-a"]').uncheck();
    await page.locator('.share-check[value="member-b"]').check();
    await page.getByRole('button', { name: '저장', exact: true }).click();

    await expect.poll(() => page.evaluate(() => (
      (window as any).__e2e_api_state.eventShares['editable-team-event'] || []
    ).join(','))).toBe('member-b');
  });

  test('server caps repeats and copies shares and checklist to every occurrence', () => {
    const post = SERVER.match(/app\.post\('\/api\/events'[\s\S]*?\n\}\);/);
    expect(post).not.toBeNull();
    expect(SERVER).toContain('maxEnd.setUTCFullYear(maxEnd.getUTCFullYear() + 2)');
    expect(SERVER).toContain('dates.length > 750');
    expect(post![0]).toContain('const eventIds = [parent.id]');
    expect(post![0]).toContain('FROM unnest($1::text[]) AS event_ids(event_id)');
    expect(post![0]).toContain('INSERT INTO event_checklist');
    expect(post![0]).toContain('INSERT INTO event_shares');
  });

  test('server limits manager team visibility to their group and blocks inactive pushes', () => {
    const list = SERVER.match(/app\.get\('\/api\/events'[\s\S]*?\n\}\);/);
    expect(list).not.toBeNull();
    expect(list![0]).toContain("e.scope = 'team' AND event_owner.group_id");
    expect(list![0]).toContain("e.scope = 'team' AND e.done = true");

    const notification = SERVER.match(/async function isNotificationEnabled[\s\S]*?\n\}/);
    expect(notification).not.toBeNull();
    expect(notification![0]).toContain('approved');
    expect(notification![0]).toContain('is_active');
  });
});
