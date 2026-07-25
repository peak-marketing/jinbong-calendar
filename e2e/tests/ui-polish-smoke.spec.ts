import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

const sampleState = {
  events: [
    {
      id: 'ui-meeting',
      title: '디자인 점검 회의',
      type: 'meeting',
      date: '2026-06-04',
      time: '14:00',
      scope: 'team',
      owner_id: 'e2e-test-user',
      owner_name: 'E2E',
      done: false,
      deleted: false,
    },
    {
      id: 'ui-todo',
      title: '모바일 카드 간격 확인',
      type: 'todo',
      date: '2026-06-04',
      scope: 'personal',
      owner_id: 'e2e-test-user',
      owner_name: 'E2E',
      todo_cat: '세무 관련',
      done: false,
      deleted: false,
    },
  ],
  ideas: [],
  users: [{
    uid: 'e2e-test-user',
    name: 'E2E',
    email: 'e2e@test.local',
    role: 'admin',
    approved: true,
    is_active: true,
  }],
  chatRooms: [{
    id: 'room-1',
    name: '디자인 회의방',
    member_count: 3,
    created_at: '2026-06-04T00:00:00.000Z',
    last_message_text: 'PC와 모바일 UI 확인',
    last_message_at: '2026-06-04T01:00:00.000Z',
  }],
  chatMessages: {},
  chatMembers: {},
  chatUnreadCounts: {},
  chatRoomGroups: [],
  eventChecklist: {},
};

test.describe('ui polish smoke', () => {
  test('desktop calendar layout stays contained and modal is centered', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupStubs(page, sampleState);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });

    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.calendar-split')).toBeVisible();
    await expect(page.locator('.calendar-side-panel')).toBeVisible();

    const overflow = await page.evaluate(() => {
      const body = document.getElementById('mainBody')!;
      return body.scrollWidth - body.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(2);

    await page.evaluate(() => (window as any).openAddEvent());
    const modal = page.locator('#modalContent');
    await expect(modal).toBeVisible();
    const box = await modal.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThan(40);
    expect(box!.y + box!.height).toBeLessThan(880);
  });

  test('mobile calendar keeps bottom tabs visible and modal as bottom sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupStubs(page, sampleState);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });

    await expect(page.locator('.sidebar')).toHaveCSS('display', 'none');
    await expect(page.locator('.mobile-tabs')).toBeVisible();

    const overflow = await page.evaluate(() => {
      const body = document.getElementById('mainBody')!;
      return Math.max(document.documentElement.scrollWidth - window.innerWidth, body.scrollWidth - body.clientWidth);
    });
    expect(overflow).toBeLessThanOrEqual(2);

    await page.evaluate(() => (window as any).openAddEvent());
    const box = await page.locator('#modalContent').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(380);
    expect(box!.y + box!.height).toBeGreaterThan(830);
  });
});
