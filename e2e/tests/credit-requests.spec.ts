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
  test('sales user creates and cancels a pending request without seeing the company credit ledger', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '박우진',
      role: 'manager',
      group_name: '본사 영업팀',
    });
    page.on('dialog', dialog => dialog.accept());

    await openCredit(page);
    await expect(page.getByText('내 충전 요청', { exact: true })).toBeVisible();
    await expect(page.getByText('재무 장부 직접 기입', { exact: true })).toHaveCount(0);

    await page.locator('[data-credit-request="targetAccountId"]').selectOption('ibk-reward-space');
    await page.locator('[data-credit-request="client"]').fill('이투이 업체');
    await page.locator('[data-credit-request="depositorName"]').fill('정확입금자');
    await page.locator('[data-credit-request="product"]').selectOption({ index: 1 });
    await page.locator('[data-credit-request="vendor"]').selectOption({ index: 1 });
    await page.locator('[data-credit-request="expectedAmount"]').fill('250000');
    await page.locator('[data-credit-request="pointAmount"]').fill('240000');
    await page.locator('[data-credit-request="memo"]').fill('자동승인 검증');
    await page.locator('[data-credit-request-submit]').click();

    await expect(page.getByText('이투이 업체', { exact: true })).toBeVisible();
    await expect(page.getByText('정확입금자', { exact: true })).toBeVisible();
    await expect(page.getByText('입금 대기', { exact: true })).toBeVisible();
    expect(store.creditRequests).toHaveLength(1);
    expect(store.creditRequests[0]).toMatchObject({
      targetAccountId: 'ibk-reward-space',
      expectedAmount: 250000,
      pointAmount: 240000,
      status: 'PENDING',
    });

    await page.locator('[data-credit-request-cancel]').click();
    await expect(page.getByText('취소', { exact: true })).toBeVisible();
    expect(store.creditRequests[0].status).toBe('CANCELLED');
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
