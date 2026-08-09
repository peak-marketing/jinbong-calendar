import { expect, test, type Page } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

async function openCredit(page: Page) {
  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  const cluster = page.locator('[data-nav-cluster="finance"]');
  if (await cluster.evaluate(element => element.classList.contains('closed'))) {
    await cluster.locator('.nav-cluster-toggle').click();
  }
  const tab = page.locator('.nav-item[data-view="credit"]');
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page.locator('.module-section-head strong', { hasText: '충전금 요청' }).first()).toBeVisible();
}

test.describe('PEAK OS credit requests', () => {
  test('sales user cannot enter the credit request screen after finance navigation is restricted', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '박우진',
      role: 'manager',
      group_name: '본사 영업팀',
    });
    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    const finance = page.locator('[data-nav-cluster="finance"]');
    await expect(finance).toBeHidden();
    await finance.locator('[data-view="credit"]')
      .evaluate(element => (element as HTMLElement).click());
    await expect(page.locator('#pageCrumb')).toHaveText('피크마케팅');
    await expect(page.locator('[data-credit-request-form]')).toHaveCount(0);
    expect(store.creditRequests).toHaveLength(0);
  });

  test('designated finance reviewer sees all requests and the separate company ledger', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '손명아',
      role: 'manager',
      group_name: '본사 세무팀',
    });
    store.creditRequests.push({
      id: 'credit-request-finance-review',
      requesterUid: 'sales-user',
      requesterName: '영업담당자',
      targetAccountId: 'ibk-review-space',
      requestDate: '2026-08-06',
      client: '검토 업체',
      depositorName: '검토입금자',
      product: '플레이스',
      vendor: '검토공급처',
      expectedAmount: 330000,
      pointAmount: 320000,
      memo: '',
      status: 'PENDING',
      bankTransactionId: null,
    });

    await openCredit(page);
    await expect(page.getByText('전체 충전 요청', { exact: true })).toBeVisible();
    await expect(page.getByText('영업담당자', { exact: true })).toBeVisible();
    await expect(page.getByText('검토 업체', { exact: true })).toBeVisible();
    await expect(page.getByText('재무 장부 직접 기입', { exact: true })).toBeVisible();
  });
});
