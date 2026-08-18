import { expect, test, type Page } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const FINANCE_VIEWERS = ['김대호', '패션TV봉이', '박종원', '손명아', '전현우'];
const FINAL_EXECUTION_VIEWERS = ['김대호', '패션TV봉이', '박종원', '손명아'];
const PREVIEW_VIEWERS = ['김대호', '패션TV봉이', '박종원'];

type Capabilities = {
  finance?: boolean;
  purchase?: boolean;
  preview?: boolean;
};

async function openOs(page: Page, name: string, capabilities: Capabilities = {}) {
  await installFirebaseStub(page);
  const store = await installPeakosStub(page, {
    name,
    uid: 'e2e-test-user',
    role: name.includes('관리자') || name === '패션TV봉이' ? 'admin' : 'manager',
    group_name: '본사 경영지원팀',
    group_type: 'support',
    ...(capabilities.finance === undefined
      ? {} : { peakos_can_view_finance_operations: capabilities.finance }),
    ...(capabilities.purchase === undefined
      ? {} : { peakos_can_view_tax_purchase: capabilities.purchase }),
    ...(capabilities.preview === undefined
      ? {} : { peakos_can_preview_accounts: capabilities.preview }),
  });
  return store;
}

async function finishOpen(page: Page) {
  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
}

async function expandCluster(page: Page, selector: string) {
  const cluster = page.locator(selector);
  await expect(cluster).toBeVisible();
  if ((await cluster.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await cluster.locator(':scope > .nav-cluster-toggle').click();
  }
  return cluster;
}

async function expandSubcluster(subcluster: ReturnType<Page['locator']>) {
  await expect(subcluster).toBeVisible();
  if ((await subcluster.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await subcluster.locator(':scope > .nav-subcluster-toggle').click();
  }
  return subcluster;
}

for (const name of FINANCE_VIEWERS) {
  test(`서버 재무 capability가 있는 지정 계정만 재무 · 운영을 본다 — ${name}`, async ({ page }) => {
    await openOs(page, name);
    await finishOpen(page);

    const finance = await expandCluster(page, '[data-nav-cluster="finance"]');
    await expect(finance.locator('[data-view="credit"]')).toBeVisible();
    // 보고서·근태는 재무 capability가 아니라 승인된 direct workspace
    // membership의 self/team scope로 연다. 이 legacy shell fixture에는
    // workspace context가 없으므로 민감 재무 탭과 별개로 닫혀 있어야 한다.
    await expect(finance.locator('[data-view="reports"]')).toBeHidden();
    await expect(finance.locator('[data-view="final-settlement"]')).toBeVisible();
    await expect(finance.locator('[data-view="closing"]')).toBeVisible();
    await expect(finance.locator('[data-view="platform"]')).toBeVisible();
    if (FINAL_EXECUTION_VIEWERS.includes(name)) {
      await expect(finance.locator('[data-view="final-execution-settlement"]')).toBeVisible();
    } else {
      await expect(finance.locator('[data-view="final-execution-settlement"]')).toBeHidden();
    }

    const taxBanking = await expandCluster(page, '[data-nav-cluster="tax-banking"]');
    await expect(taxBanking.locator('[data-tax-banking-group="purchase"]')).toBeVisible();
  });
}

for (const account of [
  { name: '김진봉', role: 'manager' },
  { name: '일반 직원', role: 'manager' },
  { name: '임의 관리자', role: 'admin' },
]) {
  test(`지정 외 계정은 재무 · 운영 전체와 강제 진입이 차단된다 — ${account.name}`, async ({ page }) => {
    const store = await openOs(page, account.name, { finance: false });
    const allIntakeRequests: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/api/peakos/intake' && url.searchParams.get('scope') === 'all') {
        allIntakeRequests.push(url.href);
      }
    });
    await finishOpen(page);

    const finance = page.locator('[data-nav-cluster="finance"]');
    await expect(finance).toBeHidden();
    await expect(finance.locator('.nav-item[data-view]')).toHaveCount(7);
    await expect(finance.locator('.nav-item[data-view]:visible')).toHaveCount(0);
    expect(store.prices.every((row: { cost: number | null }) => row.cost === null)).toBe(true);

    await finance.locator('[data-view="credit"]').evaluate(element => (element as HTMLElement).click());
    await expect(page.locator('#pageCrumb')).toHaveText('대시보드');
    await expect(page.locator('#moduleView [data-credit-request-form]')).toHaveCount(0);

    await finance.locator('[data-view="final-settlement"]')
      .evaluate(element => (element as HTMLElement).click());
    await expect(page.locator('#pageCrumb')).toHaveText('대시보드');
    await expect(page.locator('.final-settlement')).toHaveCount(0);

    await finance.locator('[data-view="closing"]')
      .evaluate(element => (element as HTMLElement).click());
    await expect(page.locator('#pageCrumb')).toHaveText('대시보드');
    await expect(page.locator('[data-finance-period-filter="closing"]')).toHaveCount(0);
    expect(allIntakeRequests).toHaveLength(0);
  });
}

test('capability 누락·false는 이름이나 admin 역할과 무관하게 fail closed한다', async ({ page }) => {
  await openOs(page, '김대호', { finance: false, purchase: false, preview: false });
  await finishOpen(page);

  await expect(page.locator('[data-nav-cluster="finance"]')).toBeHidden();
  await expect(page.locator('[data-tax-banking-group="purchase"]')).toBeHidden();
  await expect(page.locator('#accountPreviewSlot')).toBeHidden();
});

test('일반 직원은 세금 및 입금을 유지하고 세금계산서 매입만 보지 않는다', async ({ page }) => {
  await openOs(page, '일반 영업자', { finance: false, purchase: false, preview: false });
  await finishOpen(page);

  const taxBanking = await expandCluster(page, '[data-nav-cluster="tax-banking"]');
  await expect(taxBanking.locator('[data-view="bank"]')).toBeVisible();
  await expect(taxBanking.locator('[data-tax-banking-group="bank-tax"]')).toBeVisible();
  await expect(taxBanking.locator('[data-tax-banking-group="refund"]')).toBeVisible();
  await expect(taxBanking.locator('[data-tax-banking-group="expense"]')).toBeVisible();
  await expect(taxBanking.locator('[data-tax-banking-group="purchase"]')).toBeHidden();

  await taxBanking.locator('[data-view="purchase-fixed"]')
    .evaluate(element => (element as HTMLElement).click());
  await expect(page.locator('#pageCrumb')).toHaveText('대시보드');
  await expect(page.locator('[data-purchase-ledger]')).toHaveCount(0);
});

test('전현우는 매입 거래를 tax-purchase scope로 읽고 통장 잔액은 보지 않는다', async ({ page }) => {
  const store = await openOs(page, '전현우');
  const requests: URL[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/peakos/bank/accounts'
      || url.pathname === '/api/peakos/bank/transactions') requests.push(url);
  });
  store.bank = {
    accounts: [{
      id: 'ibk-hq-fixed', provider: 'IBK_QUICK', bankName: 'IBK기업은행',
      displayName: '고정비용통장', branchId: 'hq', accountNumberMasked: '56-********-1035',
      currency: 'KRW', purpose: '광고비·비품·복리후생 매입', active: true,
      latestBalance: null, latestBalanceAt: null,
    }],
    collectorConfigured: false,
    autoReconciliationEnabled: false,
    canSync: false,
    canViewBalances: false,
    transactions: [{
      id: 'fixed-withdrawal', accountId: 'ibk-hq-fixed',
      transactionAt: '2026-08-08T09:10:00+09:00', direction: 'WITHDRAWAL',
      amount: 110_000, balance: null, summary: '고정 광고비 결제',
      counterpartyName: '광고플랫폼', status: 'UNMATCHED', source: 'COLLECTOR',
    }],
    syncRuns: [],
  };
  await finishOpen(page);

  const taxBanking = await expandCluster(page, '[data-nav-cluster="tax-banking"]');
  const purchase = taxBanking.locator('[data-tax-banking-group="purchase"]');
  await expect(purchase).toBeVisible();
  await expandSubcluster(purchase);
  await purchase.locator('[data-view="purchase-fixed"]').click();

  const ledger = page.locator('[data-purchase-ledger="ibk-hq-fixed"]');
  await expect(ledger).toBeVisible();
  await expect(ledger).toContainText('광고플랫폼');
  await expect(ledger).toContainText('110,000원');
  await expect(ledger.locator('[data-purchase-balance-private]')).toContainText('잔액 비공개');
  await expect(ledger).not.toContainText('9,800,000');
  await expect(ledger).toContainText('패션TV봉이 · 박종원 · 김대호 · 손명아 · 전현우만 볼 수 있습니다');

  await expect.poll(() => requests.length).toBeGreaterThanOrEqual(2);
  expect(requests.filter(url => url.pathname.includes('/bank/')).every(
    url => url.searchParams.get('scope') === 'tax-purchase',
  )).toBe(true);
});

test('기존 잔액 권한 계정의 매입 화면은 서버가 허용한 잔액만 표시한다', async ({ page }) => {
  const store = await openOs(page, '김대호');
  store.bank = {
    accounts: [{
      id: 'ibk-hq-fixed', provider: 'IBK_QUICK', bankName: 'IBK기업은행',
      displayName: '고정비용통장', branchId: 'hq', accountNumberMasked: '56-********-1035',
      currency: 'KRW', purpose: '광고비·비품·복리후생 매입', active: true,
      latestBalance: 9_800_000, latestBalanceAt: '2026-08-08T09:00:00+09:00',
    }],
    collectorConfigured: false,
    autoReconciliationEnabled: false,
    canSync: false,
    canViewBalances: true,
    transactions: [],
    syncRuns: [],
  };
  await finishOpen(page);

  const taxBanking = await expandCluster(page, '[data-nav-cluster="tax-banking"]');
  const purchase = taxBanking.locator('[data-tax-banking-group="purchase"]');
  await expandSubcluster(purchase);
  await purchase.locator('[data-view="purchase-fixed"]').click();
  const ledger = page.locator('[data-purchase-ledger="ibk-hq-fixed"]');
  await expect(ledger).toContainText('9,800,000원');
  await expect(ledger.locator('[data-purchase-balance-private]')).toHaveCount(0);
});

for (const name of PREVIEW_VIEWERS) {
  test(`서버 preview capability가 있는 지정 계정만 계정 미리보기를 본다 — ${name}`, async ({ page }) => {
    await openOs(page, name);
    await finishOpen(page);
    await expect(page.locator('#accountPreviewSlot')).toBeVisible();
    await expect(page.locator('#personaSelect')).toBeVisible();
  });
}

test('계정 미리보기는 대상 계정의 세금·최종정산 메뉴만 재현하고 금융 API는 호출하지 않는다', async ({ page }) => {
  await openOs(page, '김대호');
  const requests: Array<{ method: string; path: string; search: string }> = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/peakos/')) {
      requests.push({ method: request.method(), path: url.pathname, search: url.search });
    }
  });
  await finishOpen(page);
  requests.length = 0;

  for (const persona of ['손명아', '박종원']) {
    await page.locator('#personaSelect').selectOption(persona);
    const finance = await expandCluster(page, '[data-nav-cluster="finance"]');
    await expect(finance.locator('[data-view="final-settlement"]')).toBeVisible();
    await expect(finance.locator('[data-view="closing"]')).toBeVisible();
    await expect(finance.locator('[data-view="final-execution-settlement"]')).toBeVisible();
    const taxBanking = await expandCluster(page, '[data-nav-cluster="tax-banking"]');
    await expect(taxBanking.locator('[data-tax-banking-group="bank-tax"]')).toBeVisible();
    await expect(taxBanking.locator('[data-tax-banking-group="purchase"]')).toBeVisible();

    await finance.locator('[data-view="final-settlement"]').click();
    await expect(page.locator('[data-finance-persona-preview="final-settlement"]')).toContainText(
      `${persona} 계정에서는 이 탭이 보입니다`,
    );
    await finance.locator('[data-view="final-execution-settlement"]').click();
    await expect(page.locator('[data-finance-persona-preview="final-execution-settlement"]')).toBeVisible();

    const purchase = taxBanking.locator('[data-tax-banking-group="purchase"]');
    await expandSubcluster(purchase);
    await purchase.locator('[data-view="purchase-fixed"]').click();
    await expect(page.locator('[data-finance-persona-preview="purchase-fixed"]')).toBeVisible();
  }

  await page.locator('#personaSelect').selectOption('전현우');
  const finance = await expandCluster(page, '[data-nav-cluster="finance"]');
  await expect(finance.locator('[data-view="final-settlement"]')).toBeVisible();
  await expect(finance.locator('[data-view="closing"]')).toBeVisible();
  await expect(finance.locator('[data-view="final-execution-settlement"]')).toBeHidden();
  await finance.locator('[data-view="final-settlement"]').click();
  await expect(page.locator('[data-finance-persona-preview="final-settlement"]')).toContainText(
    '전현우 계정에서는 이 탭이 보입니다',
  );
  const jeonTax = await expandCluster(page, '[data-nav-cluster="tax-banking"]');
  const jeonPurchase = jeonTax.locator('[data-tax-banking-group="purchase"]');
  await expect(jeonPurchase).toBeVisible();
  await expandSubcluster(jeonPurchase);
  await jeonPurchase.locator('[data-view="purchase-supplier"]').click();
  await expect(page.locator('[data-finance-persona-preview="purchase-supplier"]')).toBeVisible();

  await page.locator('#personaSelect').selectOption('김용일');
  await expect(page.locator('[data-nav-cluster="finance"]')).toBeHidden();
  const ordinaryTax = await expandCluster(page, '[data-nav-cluster="tax-banking"]');
  await expect(ordinaryTax.locator('[data-tax-banking-group="purchase"]')).toBeHidden();
  const invoiceGroup = ordinaryTax.locator('[data-nav-subcluster="tax-invoice"]');
  await expandSubcluster(invoiceGroup);
  const taxInvoice = invoiceGroup.locator('[data-view="invoice"]');
  await expect(taxInvoice).toBeVisible();
  await taxInvoice.click();
  await expect(page.locator('[data-finance-persona-preview="invoice"]')).toBeVisible();

  const sensitiveReads = requests.filter(request => (
    (request.path === '/api/peakos/intake' && request.search.includes('scope=all'))
    || request.path === '/api/peakos/prices'
    || request.path === '/api/peakos/final-execution'
    || request.path.startsWith('/api/peakos/settlement-completion/')
    || request.path.startsWith('/api/peakos/credit')
    || request.path === '/api/peakos/fund'
    || request.path === '/api/peakos/finance-requests'
    || request.path.startsWith('/api/peakos/bank/')
  ));
  expect(requests.filter(request => request.method !== 'GET')).toHaveLength(0);
  expect(sensitiveReads).toHaveLength(0);
});

for (const name of ['손명아', '전현우', '김진봉', '임의 관리자']) {
  test(`지정 외 계정은 이름·직급과 무관하게 계정 미리보기를 보지 않는다 — ${name}`, async ({ page }) => {
    await openOs(page, name, { preview: false });
    await finishOpen(page);
    await expect(page.locator('#accountPreviewSlot')).toBeHidden();
    await expect(page.locator('#personaSelect')).toHaveCount(0);
  });
}
