import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

test.describe('attendance check-in month guard', () => {
  test('check-in button is disabled when viewing a different attendance month', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setupStubs(page, {
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
      chatRoomGroups: [],
      eventChecklist: {},
      attendance: [],
    });

    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.evaluate(() => (window as any).navTo('report'));
    await page.getByRole('button', { name: '출근 보고서' }).click();

    await expect(page.getByRole('button', { name: /출근하기/ })).toBeVisible();

    await page.evaluate(() => (window as any).changeAttMonth(-1));
    await expect(page.getByRole('button', { name: /출근하기/ })).toHaveCount(0);
    await expect(page.getByText('출근 체크는 오늘이 포함된 달에서만 가능합니다.')).toBeVisible();

    await page.getByRole('button', { name: /이번 달로 이동/ }).click();
    await expect(page.getByRole('button', { name: /출근하기/ })).toBeVisible();
  });
});
