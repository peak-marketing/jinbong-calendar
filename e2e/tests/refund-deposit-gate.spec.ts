import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const REFUND_ID = '11111111-1111-4111-8111-111111111111';

async function expand(element: Locator) {
  if ((await element.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await element.locator(':scope > button').first().click();
  }
}

async function openRefundClient(page: Page) {
  const cluster = page.locator('[data-nav-cluster="tax-banking"]');
  await expect(cluster).toBeVisible();
  await expand(cluster);
  const group = cluster.locator('[data-nav-subcluster][data-tax-banking-group="refund"]');
  await expand(group);
  await group.locator('.nav-item[data-view="refund-client"]').click();
  return page.locator('#moduleView');
}

function refundRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: REFUND_ID,
    workspaceId: 'ws_peak',
    requesterUid: 'sales-user-1',
    requesterName: '테스트 영업자',
    kind: 'REFUND_CLIENT',
    requestDate: '2026-08-08',
    clientName: '입금확인 환불업체',
    detail: '계약 취소 전액 환불',
    amountVat: 330_000,
    reason: '계약 취소',
    payeeBank: '기업은행',
    payeeAccount: '12345678901234',
    payeeName: '환불 예금주',
    sourceAccountId: 'ibk-hq-sales',
    status: 'PROCESSING',
    invoiceRequested: false,
    invoiceStatus: 'NOT_REQUESTED',
    version: 3,
    ...overrides,
  };
}

function bankTransaction(id: string, counterpartyName: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: 'ws_peak',
    accountId: 'ibk-hq-sales',
    transactionAt: '2026-08-08T08:30:00+09:00',
    direction: 'DEPOSIT',
    amount: 330_000,
    summary: `${counterpartyName} 원입금`,
    counterpartyName,
    status: 'UNMATCHED',
    source: 'BANK_SYNC',
    providerKey: `secret-${id}`,
    balanceAfter: 99_999_999,
    ...overrides,
  };
}

async function setup(page: Page) {
  await installFirebaseStub(page);
  const store = await installPeakosStub(page, {
    name: '박종원',
    uid: 'e2e-test-user',
    role: 'manager',
    group_name: '본사 경영지원팀',
    group_type: 'support',
  });
  store.financeRequests.push(refundRequest());
  store.bank.transactions.push(
    bankTransaction('201', '정상입금자'),
    bankTransaction('202', '다른워크스페이스', { workspaceId: 'ws_daegu' }),
    bankTransaction('203', '다른통장', { accountId: 'ibk-review-space' }),
    bankTransaction('204', '출금거래', { direction: 'WITHDRAWAL' }),
    bankTransaction('205', '수기CSV', { source: 'CSV_IMPORT' }),
    bankTransaction('206', '취소된입금', { status: 'REVERSED' }),
    bankTransaction('207', '금액부족', { amount: 329_999 }),
  );
  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  return store;
}

function requestBody(request: Request) {
  try { return request.postDataJSON(); } catch { return null; }
}

test.describe('환불 완료 입금 게이트', () => {
  test('검증된 같은 워크스페이스 원입금 한 건을 명시 확인해야 환불을 완료한다', async ({ page }) => {
    const mutations: Array<Record<string, unknown>> = [];
    page.on('request', request => {
      if (request.method() === 'PATCH' && new URL(request.url()).pathname.endsWith(`/finance-requests/${REFUND_ID}`)) {
        mutations.push(requestBody(request));
      }
    });
    const store = await setup(page);
    const module = await openRefundClient(page);
    const row = module.locator(`[data-finance-request-row="${REFUND_ID}"]`);
    const opener = row.locator('[data-finance-status="COMPLETED"]');
    await opener.click();

    const modal = page.locator('#readonlyDetailModal');
    await expect(modal).toBeVisible();
    await expect(page.locator('.app')).toHaveJSProperty('inert', true);
    const closeButton = modal.locator('#readonlyModalClose');
    const closeBox = await closeButton.boundingBox();
    expect(closeBox?.width || 0).toBeGreaterThanOrEqual(44);
    expect(closeBox?.height || 0).toBeGreaterThanOrEqual(44);
    await modal.locator('button:not([disabled])').last().focus();
    await page.keyboard.press('Tab');
    await expect(closeButton).toBeFocused();
    await closeButton.click();
    await expect(modal).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(page.locator('.app')).toHaveJSProperty('inert', false);
    await opener.click();
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('정상입금자');
    for (const hidden of ['다른워크스페이스', '다른통장', '출금거래', '수기CSV', '취소된입금', '금액부족']) {
      await expect(modal).not.toContainText(hidden);
    }
    await expect(modal).not.toContainText('99,999,999');
    await expect(modal).not.toContainText('secret-201');

    const complete = modal.locator('[data-refund-deposit-complete]');
    await expect(complete).toBeDisabled();
    await modal.locator('[data-refund-deposit-option][value="201"]').check();
    await expect(complete).toBeDisabled();
    await modal.locator('[data-refund-deposit-confirm]').check();
    await expect(complete).toBeEnabled();
    await complete.click();

    await expect(modal).toBeHidden();
    await expect.poll(() => store.financeRequests[0].status).toBe('COMPLETED');
    expect(store.financeRequests[0]).toMatchObject({
      version: 4,
      bankTransactionId: '201',
      refundDepositConfirmedByUid: 'e2e-test-user',
      refundDepositConfirmedByName: '박종원',
    });
    expect(mutations.at(-1)).toEqual({
      status: 'COMPLETED',
      expectedVersion: 3,
      bankTransactionId: '201',
    });
    expect(store.financeRequestEvents).toContainEqual(expect.objectContaining({
      requestId: REFUND_ID,
      type: 'FINANCE_REQUEST_REFUND_DEPOSIT_CANDIDATES_VIEWED',
    }));
    await expect(module.locator(`[data-finance-request-row="${REFUND_ID}"]`)).toContainText('입금 확인');
    await expect(module.locator(`[data-finance-request-row="${REFUND_ID}"]`)).toContainText('연결 거래 #201');
  });

  test('후보 조회 뒤 버전이 바뀌면 완료를 거부하고 최신 요청을 다시 불러온다', async ({ page }) => {
    const store = await setup(page);
    const module = await openRefundClient(page);
    await module.locator(`[data-finance-request-row="${REFUND_ID}"] [data-finance-status="COMPLETED"]`).click();

    const modal = page.locator('#readonlyDetailModal');
    await expect(modal).toContainText('정상입금자');
    await modal.locator('[data-refund-deposit-option][value="201"]').check();
    await modal.locator('[data-refund-deposit-confirm]').check();
    store.financeRequests[0].version = 4;
    await modal.locator('[data-refund-deposit-complete]').click();

    await expect(modal).toBeHidden();
    expect(store.financeRequests[0]).toMatchObject({ status: 'PROCESSING', version: 4 });
    expect(store.financeRequests[0].bankTransactionId).toBeUndefined();
    await expect(page.locator('.toast')).toContainText('다른 화면에서 먼저 변경');
    await expect(module.locator(`[data-finance-request-row="${REFUND_ID}"]`)).toContainText('처리 중');
  });
});
