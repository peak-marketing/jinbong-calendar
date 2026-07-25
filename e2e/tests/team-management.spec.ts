import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

const TEAM_STATE = {
  events: [],
  ideas: [],
  users: [
    { uid: 'e2e-test-user', name: '관리자', email: 'admin@test.local', role: 'admin', approved: true, is_active: true },
    { uid: 'active-member', name: '활성직원', email: 'active@test.local', role: 'member', group_id: 'daegu', approved: true, is_active: true },
    { uid: 'inactive-member', name: '유재상', email: 'inactive@test.local', role: 'member', group_id: 'daegu', approved: false, is_active: false },
    { uid: 'pending-member', name: '신규직원', email: 'pending@test.local', role: 'member', group_id: null, approved: false, is_active: true },
  ],
  groups: [
    { id: 'daegu', name: '대구지사', group_type: 'sales', show_sales_report: true },
    { id: 'jeonju', name: '전주지사', group_type: 'sales', show_sales_report: true },
  ],
  chatRooms: [],
  chatMessages: {},
  chatMembers: {},
  chatUnreadCounts: {},
};

async function openTeamManagement(page: any) {
  await setupStubs(page, TEAM_STATE as any);
  page.on('dialog', (dialog: any) => dialog.accept());
  await page.goto('/');
  await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
  await page.evaluate(() => (window as any).openAdminPanel());
  await expect(page.locator('#modalContent')).toContainText('팀 관리');
}

test.describe('team management account states', () => {
  test('inactive users are excluded from their former group and pending list', async ({ page }) => {
    await openTeamManagement(page);

    await expect(page.locator('#modalContent')).toContainText('대구지사 (1명)');
    await expect(page.locator('#modalContent')).toContainText('전주지사 (0명)');
    await expect(page.getByText('유재상', { exact: true })).toHaveCount(1);
    await expect(page.getByText('비활성화된 직원 (1명)', { exact: false })).toBeVisible();
  });

  test('a pending approval can be cancelled into the inactive list', async ({ page }) => {
    await openTeamManagement(page);

    const pendingCard = page.locator('.card').filter({ hasText: '신규직원' });
    await expect(pendingCard).toHaveCount(1);
    await pendingCard.getByRole('button', { name: '취소' }).click();

    await expect(page.locator('.card').filter({ hasText: '신규직원' })).toHaveCount(0);
    await expect(page.getByText('비활성화된 직원 (2명)', { exact: false })).toBeVisible();
    await expect(page.getByText('신규직원', { exact: true })).toHaveCount(1);
  });
});
