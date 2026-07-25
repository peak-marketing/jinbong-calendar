import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

function bulkChatState() {
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
    chatRoomGroups: [
      { id: 'sales', name: '영업팀', color: '#5AA7FF', room_count: 2 },
      { id: 'dev', name: '개발팀', color: '#FF6B5F', room_count: 0 },
    ],
    chatRooms: [
      { id: 'r1', name: '리뷰스페이스', group_id: 'sales', member_count: 2, creator_id: 'e2e-test-user', created_at: '2026-07-01T00:00:00.000Z' },
      { id: 'r2', name: '키워드마스터', group_id: 'sales', member_count: 2, creator_id: 'e2e-test-user', created_at: '2026-07-02T00:00:00.000Z' },
      { id: 'r3', name: '정산서 이미지', member_count: 2, creator_id: 'e2e-test-user', created_at: '2026-07-03T00:00:00.000Z' },
    ],
    chatMessages: { r1: [], r2: [], r3: [] },
    chatMembers: { r1: [], r2: [], r3: [] },
    chatUnreadCounts: {},
  };
}

async function openChatList(page: any) {
  await setupStubs(page, bulkChatState() as any);
  page.on('dialog', (dialog: any) => dialog.accept());
  await page.goto('/');
  await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
  await page.evaluate(() => (window as any).navTo('chat'));
  await page.waitForSelector('#chatRoomSearchInput', { timeout: 10_000 });
}

test.describe('chat room bulk management', () => {
  test('selected rooms move to another group in one action', async ({ page }) => {
    await openChatList(page);

    await page.getByRole('button', { name: '일괄 선택' }).click();
    await page.locator('.room-item').filter({ hasText: '리뷰스페이스' }).click();
    await page.locator('.room-item').filter({ hasText: '키워드마스터' }).click();
    await expect(page.getByText('선택 2개')).toBeVisible();

    await page.getByRole('button', { name: '그룹 이동' }).click();
    await page.locator('#bulkChatRoomGroupId').selectOption('dev');
    await page.getByRole('button', { name: '변경' }).click();

    await expect(page.locator('.room-item').filter({ hasText: '리뷰스페이스' })).toContainText('개발팀');
    await expect(page.locator('.room-item').filter({ hasText: '키워드마스터' })).toContainText('개발팀');
  });

  test('selected rooms can be marked as delete requested together', async ({ page }) => {
    await openChatList(page);

    await page.getByRole('button', { name: '일괄 선택' }).click();
    await page.locator('.room-item').filter({ hasText: '정산서 이미지' }).click();
    await page.getByRole('button', { name: '삭제 요청' }).click();

    await expect(page.locator('.room-item').filter({ hasText: '정산서 이미지' })).toContainText('삭제 요청');
  });
});
