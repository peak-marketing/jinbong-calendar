import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { setupStubs } from './helpers';

test.describe('team event collaboration', () => {
  test('shared team members can add checklist items without event edit controls', async ({ page }) => {
    await setupStubs(page, {
      events: [{
        id: 'shared-team',
        title: 'Shared team todo',
        type: 'todo',
        date: '2026-06-04',
        scope: 'team',
        owner_id: 'owner-user',
        owner_name: 'Owner',
        done: false,
        deleted: false,
      }],
      ideas: [],
      users: [{
        uid: 'e2e-test-user',
        name: 'Shared Member',
        email: 'member@test.local',
        role: 'user',
        approved: true,
        is_active: true,
      }],
      chatRooms: [],
      chatMessages: {},
      chatMembers: {},
      chatUnreadCounts: {},
      chatRoomGroups: [],
      eventChecklist: {
        'shared-team': [{
          id: 'cl-existing',
          event_id: 'shared-team',
          title: 'Existing checklist',
          done: false,
          sort_order: 0,
          created_at: '2026-06-04T00:00:00.000Z',
        }],
      },
    });

    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.evaluate(() => (window as any).openEventDetail('shared-team'));

    await expect(page.locator('#newCheckItem')).toBeVisible();
    await expect(page.getByText('✏️ 수정')).toHaveCount(0);
    await expect(page.getByText('🗑 삭제')).toHaveCount(0);

    await page.locator('#newCheckItem').fill('Added by shared member');
    await page.locator('#newCheckItem').press('Enter');

    await expect.poll(() => page.evaluate(() => (
      (window as any).__e2e_api_state.eventChecklist['shared-team'] || []
    ).length)).toBe(2);
    await expect(page.getByText('Added by shared member')).toBeVisible();
  });

  test('completing all checklist items marks the todo done and removes it from incomplete panel', async ({ page }) => {
    const today = new Date().toISOString().slice(0, 10);
    await setupStubs(page, {
      events: [{
        id: 'checklist-done-todo',
        title: '완료되면 숨겨질 일',
        type: 'todo',
        date: today,
        scope: 'personal',
        owner_id: 'e2e-test-user',
        owner_name: 'Shared Member',
        todo_cat: '세무 관련',
        done: false,
        deleted: false,
      }],
      ideas: [],
      users: [{
        uid: 'e2e-test-user',
        name: 'Shared Member',
        email: 'member@test.local',
        role: 'user',
        approved: true,
        is_active: true,
      }],
      chatRooms: [],
      chatMessages: {},
      chatMembers: {},
      chatUnreadCounts: {},
      chatRoomGroups: [],
      eventChecklist: {
        'checklist-done-todo': [{
          id: 'cl-last',
          event_id: 'checklist-done-todo',
          title: '마지막 체크',
          done: false,
          sort_order: 0,
          created_at: '2026-06-04T00:00:00.000Z',
        }],
      },
    });

    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await expect.poll(() => page.evaluate(() =>
      document.querySelector('#rightPanel')?.textContent?.includes('완료되면 숨겨질 일') || false
    )).toBe(true);

    await page.evaluate(() => (window as any).openEventDetail('checklist-done-todo'));
    await page.locator('#modalContent .todo-check').first().click();

    await expect.poll(() => page.evaluate(() =>
      (window as any).eventsForDate((window as any).todayStr()).find((event: any) => event.id === 'checklist-done-todo')?.done === true
    )).toBe(true);
    await expect.poll(() => page.evaluate(() =>
      document.querySelector('#rightPanel')?.textContent?.includes('완료되면 숨겨질 일') || false
    )).toBe(false);
  });

  test('server hides completed shared team events from non-privileged recipients', () => {
    const server = fs.readFileSync(
      path.resolve(__dirname, '../../server/index.js'),
      'utf8'
    );
    const handler = server.match(/app\.get\('\/api\/events'[\s\S]*?\n\}\);/);
    expect(handler).not.toBeNull();
    const src = handler![0];
    expect(src).toContain('sharedDoneWhere');
    expect(src).toMatch(/e\.scope = 'team'/);
    expect(src).toMatch(/e\.done = true/);
    expect(src).toMatch(/e\.owner_id <> \$1/);
    expect(src).toMatch(/es\.user_id = \$1/);
  });

  test('server checklist mutations allow event participants, not only owners', () => {
    const server = fs.readFileSync(
      path.resolve(__dirname, '../../server/index.js'),
      'utf8'
    );
    const postHandler = server.match(/app\.post\('\/api\/events\/:id\/checklist'[\s\S]*?\n\}\);/);
    const putHandler = server.match(/app\.put\('\/api\/events\/:eventId\/checklist\/:itemId'[\s\S]*?\n\}\);/);
    const deleteHandler = server.match(/app\.delete\('\/api\/events\/:eventId\/checklist\/:itemId'[\s\S]*?\n\}\);/);
    for (const handler of [postHandler, putHandler, deleteHandler]) {
      expect(handler).not.toBeNull();
      expect(handler![0]).toContain('canAccessEvent(req');
      expect(handler![0]).not.toContain('requireOwner: true');
    }
  });
});
