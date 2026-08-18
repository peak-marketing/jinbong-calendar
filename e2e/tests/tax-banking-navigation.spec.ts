import { expect, test, type Locator, type Page } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const EXACT_FINANCE_REVIEWERS = ['패션TV봉이', '박종원', '김대호', '손명아'];

const GROUP_VIEWS = {
  'bank-tax': ['invoice', 'tax-advance', 'tax-correction'],
  refund: ['refund-history', 'refund-client', 'refund-mistaken', 'refund-invoice'],
  expense: ['expense-ad', 'expense-supplies'],
  purchase: ['purchase-fixed', 'purchase-supplier'],
} as const;

const REQUEST_VIEWS = [
  'tax-advance',
  'tax-correction',
  'refund-client',
  'refund-mistaken',
  'expense-ad',
  'expense-supplies',
] as const;

const VIEW_GROUP = Object.fromEntries(
  Object.entries(GROUP_VIEWS).flatMap(([group, views]) => views.map(view => [view, group])),
) as Record<string, keyof typeof GROUP_VIEWS>;

const fiveAccounts = [
  ['ibk-hq-sales', '본사 매출통장', '56-********-4017', 125_034_000],
  ['ibk-hq-supplier', '공급처 통장', '56-********-1042', 38_210_000],
  ['ibk-hq-fixed', '고정비용통장', '56-********-1035', 9_800_000],
  ['ibk-review-space', '리뷰스페이스통장', '07-********-4015', 4_500_000],
  ['ibk-reward-space', '리워드스페이스통장', '07-********-4022', 6_700_000],
].map(([id, displayName, accountNumberMasked, latestBalance]) => ({
  id,
  provider: 'IBK_QUICK',
  bankName: 'IBK기업은행',
  displayName,
  branchId: 'hq',
  accountNumberMasked,
  currency: 'KRW',
  purpose: displayName,
  active: true,
  latestBalance,
  latestBalanceAt: '2026-08-08T09:00:00+09:00',
  lastSyncStartedAt: '2026-08-08T08:59:00+09:00',
  lastSyncSucceededAt: '2026-08-08T09:00:00+09:00',
  lastSyncError: null,
  unmatchedCount: 0,
}));

type User = {
  name: string;
  role: string;
  group_name: string;
  group_type?: string;
};

async function setup(page: Page, user: User) {
  await installFirebaseStub(page);
  const store = await installPeakosStub(page, {
    ...user,
    uid: 'e2e-test-user',
    group_type: user.group_type || (user.group_name.includes('영업') ? 'sales' : 'support'),
  });
  const reviewer = EXACT_FINANCE_REVIEWERS.includes(user.name);
  const restricted = new Set(['ibk-hq-supplier', 'ibk-hq-fixed']);
  store.bank = {
    accounts: fiveAccounts
      .filter(account => reviewer || !restricted.has(String(account.id)))
      .map(account => ({
        ...account,
        latestBalance: reviewer ? account.latestBalance : null,
        latestBalanceAt: reviewer ? account.latestBalanceAt : null,
      })),
    collectorConfigured: false,
    autoReconciliationEnabled: false,
    canSync: false,
    canViewBalances: reviewer,
    transactions: [],
    syncRuns: [],
  };
  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  return store;
}

async function expand(element: Locator) {
  if ((await element.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await element.locator(':scope > button').first().click();
  }
}

async function taxBankingCluster(page: Page) {
  const cluster = page.locator('[data-nav-cluster="tax-banking"]');
  await expect(cluster).toBeVisible();
  await expand(cluster);
  return cluster;
}

async function openView(page: Page, view: string) {
  const cluster = await taxBankingCluster(page);
  if (view === 'bank') {
    const tab = cluster.locator(':scope > .nav-cluster-items > .nav-item[data-view="bank"]');
    await expect(tab).toBeVisible();
    await tab.click();
    return page.locator('#moduleView');
  }
  const group = cluster.locator(
    `[data-nav-subcluster][data-tax-banking-group="${VIEW_GROUP[view]}"]`,
  );
  await expect(group).toBeVisible();
  await expand(group);
  const tab = group.locator(`.nav-item[data-view="${view}"]`);
  await expect(tab).toBeVisible();
  await tab.click();
  return page.locator('#moduleView');
}

async function fillIfPresent(form: Locator, key: string, value: string) {
  const field = form.locator(`[data-finance-request="${key}"]`);
  if (await field.count()) await field.fill(value);
}

test.describe('세금 · 통장 계층 메뉴와 재무 요청', () => {
  test('네 개 하위 묶음에 12개 leaf가 배치되고 매입은 지정 네 계정에게만 열린다', async ({ page }) => {
    await setup(page, {
      name: '김대호',
      role: 'manager',
      group_name: '본사 경영지원팀',
    });

    const cluster = await taxBankingCluster(page);
    for (const [groupName, views] of Object.entries(GROUP_VIEWS)) {
      const group = cluster.locator(
        `[data-nav-subcluster][data-tax-banking-group="${groupName}"]`,
      );
      await expect(group).toHaveCount(1);
      await expand(group);
      for (const view of views) {
        await expect(group.locator(`.nav-item[data-view="${view}"]`)).toBeVisible();
      }
    }
    await expect(cluster.locator(':scope > .nav-cluster-items > .nav-item[data-view="bank"]')).toBeVisible();
    await expect(cluster.locator('.nav-item[data-view]')).toHaveCount(12);
  });

  for (const account of [
    { name: '일반 영업자', role: 'member', group_name: '본사 영업팀' },
    { name: '임의 관리자', role: 'admin', group_name: '본사 경영지원팀' },
  ]) {
    test(`${account.name}는 일반 3계좌만 보고 잔액·매입 하위 메뉴를 보지 않는다`, async ({ page }) => {
      await setup(page, account);
      const cluster = await taxBankingCluster(page);
      const purchase = cluster.locator('[data-tax-banking-group="purchase"]');
      await expect(purchase.locator('[data-view="purchase-fixed"]')).toBeHidden();
      await expect(purchase.locator('[data-view="purchase-supplier"]')).toBeHidden();

      const ledger = await openView(page, 'bank');
      const accountCards = ledger.locator('[data-bank-ledger] .bank-account-card');
      await expect(accountCards).toHaveCount(3);
      await expect(accountCards.filter({ hasText: '본사 매출통장' })).toHaveCount(1);
      await expect(accountCards.filter({ hasText: '리뷰스페이스통장' })).toHaveCount(1);
      await expect(accountCards.filter({ hasText: '리워드스페이스통장' })).toHaveCount(1);
      await expect(accountCards.filter({ hasText: '공급처 통장' })).toHaveCount(0);
      await expect(accountCards.filter({ hasText: '고정비용통장' })).toHaveCount(0);
      await expect(ledger).not.toContainText('통장 잔액 합계');
      await expect(ledger).not.toContainText('거래 후 잔액');
      await expect(ledger).not.toContainText('125,034,000');
    });
  }

  test('지정 네 계정은 5계좌 잔액과 매입 소분류를 함께 본다', async ({ page }) => {
    const store = await setup(page, {
      name: '손명아',
      role: 'member',
      group_name: '본사 경영지원팀',
    });
    store.bank.transactions = [
      {
        id: 'fixed-withdrawal', accountId: 'ibk-hq-fixed',
        transactionAt: '2026-08-08T09:10:00+09:00', direction: 'WITHDRAWAL',
        amount: 110_000, balance: 9_690_000, summary: '고정 광고비 결제',
        counterpartyName: '광고플랫폼', status: 'UNMATCHED', source: 'COLLECTOR',
      },
      {
        id: 'supplier-withdrawal', accountId: 'ibk-hq-supplier',
        transactionAt: '2026-08-08T09:20:00+09:00', direction: 'WITHDRAWAL',
        amount: 220_000, balance: 37_990_000, summary: '공급처 정산',
        counterpartyName: '테스트공급처', status: 'UNMATCHED', source: 'COLLECTOR',
      },
    ];
    for (let index = 1; index <= 100; index += 1) {
      store.bank.transactions.push({
        id: `fixed-extra-${index}`, accountId: 'ibk-hq-fixed',
        transactionAt: '2026-08-08T09:30:00+09:00', direction: 'WITHDRAWAL',
        amount: 1_000 + index, balance: 9_600_000 - index, summary: `고정비 추가 ${index}`,
        counterpartyName: `고정비업체 ${index}`, status: 'UNMATCHED', source: 'COLLECTOR',
      });
    }
    const cluster = await taxBankingCluster(page);
    const purchase = cluster.locator('[data-tax-banking-group="purchase"]');
    await expand(purchase);
    await expect(purchase.locator('[data-view="purchase-fixed"]')).toBeVisible();
    await expect(purchase.locator('[data-view="purchase-supplier"]')).toBeVisible();

    const ledger = await openView(page, 'bank');
    await expect(ledger.locator('[data-bank-ledger] .bank-account-card')).toHaveCount(5);
    await expect(ledger).toContainText('공급처 통장');
    await expect(ledger).toContainText('고정비용통장');
    await expect(ledger).toContainText('125,034,000');

    const fixed = await openView(page, 'purchase-fixed');
    const fixedLedger = fixed.locator('[data-purchase-ledger="ibk-hq-fixed"]');
    await expect(fixedLedger).toBeVisible();
    await expect(fixedLedger).toContainText('광고플랫폼');
    await expect(fixedLedger).toContainText('110,000원');
    await expect(fixedLedger).not.toContainText('테스트공급처');
    await expect(fixedLedger.locator('[aria-label="매입 거래 페이지"]')).toContainText('1 / 2 페이지');
    await fixedLedger.locator('[data-purchase-page="2"]').click();
    await expect(fixedLedger.locator('[aria-label="매입 거래 페이지"]')).toContainText('2 / 2 페이지');
    await expect(fixedLedger).toContainText('고정비 추가 100');

    const supplier = await openView(page, 'purchase-supplier');
    const supplierLedger = supplier.locator('[data-purchase-ledger="ibk-hq-supplier"]');
    await expect(supplierLedger).toBeVisible();
    await expect(supplierLedger).toContainText('테스트공급처');
    await expect(supplierLedger).toContainText('220,000원');
    await expect(supplierLedger).not.toContainText('광고플랫폼');
  });

  test('각 요청 화면에서 저장한 내용은 로그인한 직원의 내역으로 즉시 보인다', async ({ page }) => {
    const store = await setup(page, {
      name: '일반 영업자',
      role: 'member',
      group_name: '본사 영업팀',
    });

    for (const [index, view] of REQUEST_VIEWS.entries()) {
      const module = await openView(page, view);
      const form = module.locator(`[data-finance-request-module="${view}"] [data-finance-request-form]`);
      await expect(form).toBeVisible();
      const client = `${view}-요청업체`;
      await form.locator('[data-finance-request="requestDate"]').fill(`2026-08-${String(index + 1).padStart(2, '0')}`);
      await form.locator('[data-finance-request="client"]').fill(client);
      await form.locator('[data-finance-request="amount"]').fill(String(110_000 + index * 11_000));
      await form.locator('[data-finance-request="memo"]').fill(`${view} E2E 사유`);
      await fillIfPresent(form, 'detail', `${view} 상세 내용`);
      await fillIfPresent(form, 'businessRegistrationUrl', 'https://drive.example.test/business');
      await fillIfPresent(form, 'email', 'tax@example.test');
      await fillIfPresent(form, 'payeeBank', '기업은행');
      await fillIfPresent(form, 'payeeAccount', '12345678901234');
      await fillIfPresent(form, 'payeeName', `${view} 예금주`);
      await fillIfPresent(form, 'evidenceUrl', 'https://drive.example.test/evidence');
      if (view === 'refund-client') {
        const invoiceRequested = form.locator('[data-finance-request="invoiceRequested"]');
        await expect(invoiceRequested).toBeVisible();
        if (!(await invoiceRequested.isChecked())) await invoiceRequested.check();
      }
      await form.locator('[data-finance-request-submit]').click();

      await expect.poll(() => store.financeRequests.some(
        (row: any) => row.requestType === view && row.clientName === client,
      )).toBe(true);
      const ownList = module.locator(`[data-finance-request-module="${view}"] [data-finance-request-list]`);
      await expect(ownList).toContainText(client);
    }
    await expect(store.financeRequests).toHaveLength(REQUEST_VIEWS.length);
    expect(store.financeRequests.find((row: any) => row.kind === 'TAX_ADVANCE')).toMatchObject({
      invoiceRequested: true,
      invoiceStatus: 'REQUESTED',
    });
    expect(store.financeRequests.find((row: any) => row.kind === 'TAX_CORRECTION')).toMatchObject({
      invoiceRequested: true,
      invoiceStatus: 'CORRECTION_REQUESTED',
    });
    const lastClient = `${REQUEST_VIEWS.at(-1)}-요청업체`;
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-finance-request-module="expense-supplies"] [data-finance-cancel]').click();
    await expect.poll(() => store.financeRequests.length).toBe(REQUEST_VIEWS.length);
    await expect.poll(() => store.financeRequests.find((row: any) => row.clientName === lastClient)?.status).toBe('CANCELLED');
    await expect(page.locator('[data-finance-request-module="expense-supplies"]')).toContainText(lastClient);
    await expect(page.locator('[data-finance-request-module="expense-supplies"]')).toContainText('취소');
  });

  test('지정 재무 담당자는 다른 직원 요청을 전체 조회하고 처리 상태를 바꾼다', async ({ page }) => {
    const store = await setup(page, {
      name: '박종원',
      role: 'manager',
      group_name: '본사 경영지원팀',
    });
    store.financeRequests.push({
      id: 'other-employee-expense',
      requesterUid: 'other-employee-uid',
      requesterName: '다른 영업자',
      kind: 'EXPENSE_AD',
      requestDate: '2026-08-08',
      clientName: '다른직원광고업체',
      detail: '커뮤니티 광고 충전',
      amountVat: 550_000,
      reason: '광고 캠페인 집행',
      payeeBank: '기업은행',
      payeeAccount: '12345678901234',
      payeeName: '광고업체',
      status: 'PENDING',
      invoiceRequested: false,
    });

    const module = await openView(page, 'expense-ad');
    await module.locator('[data-finance-request-refresh]').click();
    const row = module.locator('[data-finance-request-row="other-employee-expense"]');
    await expect(row).toContainText('다른직원광고업체');
    await expect(row).toContainText('다른 영업자');
    await row.locator('[data-finance-status="PROCESSING"]').click();
    await expect.poll(() => store.financeRequests[0].status).toBe('PROCESSING');
    page.once('dialog', dialog => dialog.accept());
    await module.locator('[data-finance-request-row="other-employee-expense"] [data-finance-status="COMPLETED"]').click();
    await expect.poll(() => store.financeRequests[0].status).toBe('COMPLETED');
    await expect(module.locator('[data-finance-request-row="other-employee-expense"]')).toContainText('처리 완료');
  });

  test('업체 환불의 계산서 요청은 환불 이력과 환불 계산서 큐에 함께 연결된다', async ({ page }) => {
    const store = await setup(page, {
      name: '일반 영업자',
      role: 'member',
      group_name: '본사 영업팀',
    });

    const clientRefund = await openView(page, 'refund-client');
    const form = clientRefund.locator('[data-finance-request-form]');
    await form.locator('[data-finance-request="requestDate"]').fill('2026-08-08');
    await form.locator('[data-finance-request="client"]').fill('환불계산서연결업체');
    await form.locator('[data-finance-request="amount"]').fill('330000');
    await form.locator('[data-finance-request="memo"]').fill('계약 취소 환불');
    await fillIfPresent(form, 'detail', '계약 취소로 전액 환불');
    await fillIfPresent(form, 'payeeBank', '기업은행');
    await fillIfPresent(form, 'payeeAccount', '12345678901234');
    await fillIfPresent(form, 'payeeName', '환불계산서예금주');
    await fillIfPresent(form, 'evidenceUrl', 'https://drive.example.test/refund');
    const checkbox = form.locator('[data-finance-request="invoiceRequested"]');
    if (!(await checkbox.isChecked())) await checkbox.check();
    await form.locator('[data-finance-request-submit]').click();
    await expect.poll(() => store.financeRequests.length).toBe(1);
    expect(store.financeRequests[0]).toMatchObject({
      requestType: 'refund-client',
      clientName: '환불계산서연결업체',
      amountVat: 330000,
      invoiceRequested: true,
    });

    const history = await openView(page, 'refund-history');
    await expect(history.locator('[data-finance-request-list]')).toContainText('환불계산서연결업체');
    await expect(history.locator('[data-finance-request-list]')).toContainText('330,000');

    const invoiceQueue = await openView(page, 'refund-invoice');
    await expect(invoiceQueue.locator('[data-finance-request-list]')).toContainText('환불계산서연결업체');
    await expect(invoiceQueue.locator('[data-finance-request-list]')).toContainText('330,000');

    const refundId = String(store.financeRequests[0].id);
    const refundDetail = await openView(page, 'refund-client');
    page.once('dialog', dialog => dialog.accept());
    await refundDetail.locator(`[data-finance-request-row="${refundId}"] [data-finance-cancel]`).click();
    await expect.poll(() => store.financeRequests[0].status).toBe('CANCELLED');
    await expect.poll(() => store.financeRequests[0].invoiceStatus).toBe('CANCELLED');

    const cancelledHistory = await openView(page, 'refund-history');
    await expect(cancelledHistory.locator('[data-finance-request-list]')).toContainText('환불계산서연결업체');
    await expect(cancelledHistory.locator('[data-finance-request-list]')).toContainText('취소');
    const cancelledInvoiceQueue = await openView(page, 'refund-invoice');
    await expect(cancelledInvoiceQueue).not.toContainText('환불계산서연결업체');
  });

  test('재무 요청은 선택 월을 서버 쿼리로 조회하고 50건 이후 페이지도 이동한다', async ({ page }) => {
    const store = await setup(page, {
      name: '일반 영업자',
      role: 'member',
      group_name: '본사 영업팀',
    });
    const requestedUrls: string[] = [];
    page.on('request', request => {
      if (request.url().includes('/api/peakos/finance-requests?')) requestedUrls.push(request.url());
    });
    for (let index = 1; index <= 52; index += 1) {
      store.financeRequests.push({
        id: `august-ad-${index}`,
        requesterUid: 'e2e-test-user', requesterName: '일반 영업자', kind: 'EXPENSE_AD',
        requestDate: '2026-08-08', clientName: `8월 광고 ${String(index).padStart(2, '0')}`,
        detail: '광고비', amountVat: 110_000, reason: '8월 집행', status: 'PENDING',
        invoiceRequested: false, invoiceStatus: 'NOT_REQUESTED',
      });
    }
    store.financeRequests.push({
      id: 'july-ad', requesterUid: 'e2e-test-user', requesterName: '일반 영업자', kind: 'EXPENSE_AD',
      requestDate: '2026-07-31', clientName: '7월 광고', detail: '광고비', amountVat: 220_000,
      reason: '7월 집행', status: 'PENDING', invoiceRequested: false, invoiceStatus: 'NOT_REQUESTED',
    });

    const module = await openView(page, 'expense-ad');
    // 재무 장부의 실사용 기본값은 이번 달이므로 첫 조회부터 8월 52건만 보인다.
    await expect(module).toContainText('전체 52건');
    await expect(module.getByLabel('금융 요청 페이지')).toContainText('1 / 2 페이지');
    await module.locator('[data-finance-request-page="2"]').click();
    await expect(module.getByLabel('금융 요청 페이지')).toContainText('2 / 2 페이지');

    await module.locator('[data-finance-period-mode="month"]').click();
    const month = module.locator('[data-finance-period-month]');
    await expect(month).toHaveValue('2026-08');
    await expect(module).toContainText('전체 52건');
    await expect(module).not.toContainText('7월 광고');
    await expect.poll(() => requestedUrls.some(raw => {
      const url = new URL(raw);
      return url.searchParams.get('kind') === 'EXPENSE_AD'
        && url.searchParams.get('from') === '2026-08-01'
        && url.searchParams.get('to') === '2026-08-31'
        && url.searchParams.get('page') === '1';
    })).toBe(true);
  });

  test('390px 모바일에서 계층 메뉴와 요청 폼이 문서 폭을 넓히지 않는다', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page, {
      name: '일반 영업자',
      role: 'member',
      group_name: '본사 영업팀',
    });

    await page.locator('.mobile-menu').click();
    const module = await openView(page, 'expense-ad');
    await expect(module.locator('[data-finance-request-form]')).toBeVisible();
    await page.locator('.mobile-menu').click();
    const cluster = await taxBankingCluster(page);
    await expand(cluster.locator('[data-tax-banking-group="expense"]'));

    const widths = await page.evaluate(() => {
      const module = document.querySelector('#moduleView') as HTMLElement;
      const sidebar = document.querySelector('.app-sidebar') as HTMLElement;
      return {
        documentClient: document.documentElement.clientWidth,
        documentScroll: document.documentElement.scrollWidth,
        moduleClient: module.clientWidth,
        moduleScroll: module.scrollWidth,
        sidebarClient: sidebar.clientWidth,
        sidebarScroll: sidebar.scrollWidth,
      };
    });
    expect(widths.documentScroll).toBeLessThanOrEqual(widths.documentClient + 1);
    expect(widths.moduleScroll).toBeLessThanOrEqual(widths.moduleClient + 1);
    expect(widths.sidebarScroll).toBeLessThanOrEqual(widths.sidebarClient + 1);
  });
});
