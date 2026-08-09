import { expect, test, type Page } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const FULL_ACCOUNT_SENTINEL = '12345678901234';
const RAW_PAYLOAD_SENTINEL = 'RAW_BANK_PAYLOAD_MUST_NOT_RENDER';

const bankAccounts = [
  {
    id: 'ibk-hq-sales',
    provider: 'IBK_QUICK',
    bankName: 'IBK기업은행',
    displayName: '본사 매출통장',
    branchId: 'hq',
    accountNumberMasked: '12-********-7890',
    // 서버 계약 밖의 민감 필드가 실수로 화면에 직렬화되지 않는지도 확인한다.
    accountNumber: FULL_ACCOUNT_SENTINEL,
    currency: 'KRW',
    purpose: '매출 입금',
    active: true,
    latestBalance: 125_034_000,
    latestBalanceAt: '2026-08-06T09:10:00+09:00',
    lastSyncStartedAt: '2026-08-06T09:09:00+09:00',
    lastSyncSucceededAt: '2026-08-06T09:10:00+09:00',
    lastSyncError: null,
    unmatchedCount: 1,
  },
  {
    id: 'ibk-hq-supplier',
    provider: 'MANUAL_IMPORT',
    bankName: '테스트은행',
    displayName: '본사 운영통장',
    branchId: 'hq',
    accountNumberMasked: '98-******-4321',
    currency: 'KRW',
    purpose: '공급처·고정비',
    active: true,
    latestBalance: 38_210_000,
    latestBalanceAt: '2026-08-06T08:30:00+09:00',
    lastSyncStartedAt: null,
    lastSyncSucceededAt: null,
    lastSyncError: null,
    unmatchedCount: 0,
  },
  {
    id: 'ibk-hq-fixed',
    provider: 'IBK_QUICK',
    bankName: 'IBK기업은행',
    displayName: '고정비용통장',
    branchId: 'hq',
    accountNumberMasked: '56-********-1035',
    currency: 'KRW',
    purpose: '광고비 지급',
    active: true,
    latestBalance: 9_800_000,
    latestBalanceAt: '2026-08-06T08:40:00+09:00',
    lastSyncStartedAt: null,
    lastSyncSucceededAt: null,
    lastSyncError: null,
    unmatchedCount: 0,
  },
  {
    id: 'ibk-review-space',
    provider: 'IBK_QUICK',
    bankName: 'IBK기업은행',
    displayName: '리뷰스페이스통장',
    branchId: 'hq',
    accountNumberMasked: '07-********-4015',
    currency: 'KRW',
    purpose: '리뷰스페이스 운영',
    active: true,
    latestBalance: 4_500_000,
    latestBalanceAt: '2026-08-06T08:45:00+09:00',
    lastSyncStartedAt: null,
    lastSyncSucceededAt: null,
    lastSyncError: null,
    unmatchedCount: 0,
  },
  {
    id: 'ibk-reward-space',
    provider: 'IBK_QUICK',
    bankName: 'IBK기업은행',
    displayName: '리워드스페이스통장',
    branchId: 'hq',
    accountNumberMasked: '07-********-4022',
    currency: 'KRW',
    purpose: '리워드스페이스 운영',
    active: true,
    latestBalance: 6_700_000,
    latestBalanceAt: '2026-08-06T08:50:00+09:00',
    lastSyncStartedAt: null,
    lastSyncSucceededAt: null,
    lastSyncError: null,
    unmatchedCount: 0,
  },
];

// 20260806_peakos_banking.sql의 초기 화면용 5계좌와 같은 공개 필드.
// accountNumber는 서버 계약 밖의 가짜 전체번호로, DOM에 직렬화되지 않는지 확인한다.
const inactiveMigrationAccounts = [
  {
    id: 'ibk-hq-sales',
    provider: 'IBK_QUICK',
    bankName: 'IBK기업은행',
    displayName: '본사 매출통장',
    branchId: 'hq',
    accountNumberMasked: '56-********-4017',
    accountNumber: '91234567890001',
    currency: 'KRW',
    purpose: '매출 입금',
    active: false,
    latestBalance: null,
    latestBalanceAt: null,
    lastSyncStartedAt: null,
    lastSyncSucceededAt: null,
    lastSyncError: null,
    unmatchedCount: 0,
  },
  {
    id: 'ibk-hq-supplier',
    provider: 'IBK_QUICK',
    bankName: 'IBK기업은행',
    displayName: '공급처 통장',
    branchId: 'hq',
    accountNumberMasked: '56-********-1042',
    accountNumber: '91234567890002',
    currency: 'KRW',
    purpose: '공급처 지급',
    active: false,
    latestBalance: null,
    latestBalanceAt: null,
    lastSyncStartedAt: null,
    lastSyncSucceededAt: null,
    lastSyncError: null,
    unmatchedCount: 0,
  },
  {
    id: 'ibk-hq-fixed',
    provider: 'IBK_QUICK',
    bankName: 'IBK기업은행',
    displayName: '고정비용통장',
    branchId: 'hq',
    accountNumberMasked: '56-********-1035',
    accountNumber: '91234567890003',
    currency: 'KRW',
    purpose: '광고비 지급',
    active: false,
    latestBalance: null,
    latestBalanceAt: null,
    lastSyncStartedAt: null,
    lastSyncSucceededAt: null,
    lastSyncError: null,
    unmatchedCount: 0,
  },
  {
    id: 'ibk-review-space',
    provider: 'IBK_QUICK',
    bankName: 'IBK기업은행',
    displayName: '리뷰스페이스통장',
    branchId: 'hq',
    accountNumberMasked: '07-********-4015',
    accountNumber: '91234567890004',
    currency: 'KRW',
    purpose: '리뷰스페이스 운영',
    active: false,
    latestBalance: null,
    latestBalanceAt: null,
    lastSyncStartedAt: null,
    lastSyncSucceededAt: null,
    lastSyncError: null,
    unmatchedCount: 0,
  },
  {
    id: 'ibk-reward-space',
    provider: 'IBK_QUICK',
    bankName: 'IBK기업은행',
    displayName: '리워드스페이스통장',
    branchId: 'hq',
    accountNumberMasked: '07-********-4022',
    accountNumber: '91234567890005',
    currency: 'KRW',
    purpose: '리워드스페이스 운영',
    active: false,
    latestBalance: null,
    latestBalanceAt: null,
    lastSyncStartedAt: null,
    lastSyncSucceededAt: null,
    lastSyncError: null,
    unmatchedCount: 0,
  },
];

const bankTransactions = [
  {
    id: 'tx-deposit-1',
    accountId: 'ibk-hq-sales',
    transactionAt: '2026-08-06T09:03:00+09:00',
    direction: 'DEPOSIT',
    amount: 1_100_000,
    balance: 125_034_000,
    summary: '테스트광고 입금',
    counterpartyName: '테스트광고',
    counterpartyAccountMasked: '11-****-7788',
    counterpartyAccount: '99887766554433',
    branch: '전자금융',
    status: 'UNMATCHED',
    source: 'COLLECTOR',
    firstSeenAt: '2026-08-06T09:10:00+09:00',
    rawPayload: RAW_PAYLOAD_SENTINEL,
  },
  {
    id: 'tx-withdrawal-1',
    accountId: 'ibk-hq-supplier',
    transactionAt: '2026-08-06T08:20:00+09:00',
    direction: 'WITHDRAWAL',
    amount: 420_000,
    balance: 38_210_000,
    summary: '테스트 공급처 지급',
    counterpartyName: '테스트공급처',
    counterpartyAccountMasked: '22-****-9900',
    branch: '기업인터넷',
    status: 'MATCHED',
    source: 'CSV_IMPORT',
    firstSeenAt: '2026-08-06T08:30:00+09:00',
  },
];

const bankPeriodBoundaryTransactions = [
  {
    id: 'tx-before-august',
    accountId: 'ibk-hq-sales',
    transactionAt: '2026-07-31T23:59:59+09:00',
    direction: 'DEPOSIT',
    amount: 101,
    balance: 1_000_101,
    summary: '7월 마지막 거래',
    counterpartyName: '7월말 경계 밖',
    status: 'UNMATCHED',
    source: 'COLLECTOR',
  },
  {
    id: 'tx-august-start',
    accountId: 'ibk-hq-sales',
    transactionAt: '2026-08-01T00:00:00+09:00',
    direction: 'DEPOSIT',
    amount: 202,
    balance: 1_000_303,
    summary: '8월 첫 거래',
    counterpartyName: '8월 시작 경계',
    status: 'UNMATCHED',
    source: 'COLLECTOR',
  },
  {
    id: 'tx-august-end',
    accountId: 'ibk-hq-sales',
    transactionAt: '2026-08-31T23:59:59+09:00',
    direction: 'WITHDRAWAL',
    amount: 303,
    balance: 1_000_000,
    summary: '8월 마지막 거래',
    counterpartyName: '8월 종료 경계',
    status: 'MATCHED',
    source: 'COLLECTOR',
  },
  {
    id: 'tx-september-start',
    accountId: 'ibk-hq-sales',
    transactionAt: '2026-09-01T00:00:00+09:00',
    direction: 'DEPOSIT',
    amount: 404,
    balance: 1_000_404,
    summary: '9월 첫 거래',
    counterpartyName: '9월 시작 경계',
    status: 'UNMATCHED',
    source: 'COLLECTOR',
  },
];

const bankSyncRuns = [
  {
    id: '501',
    account_id: 'ibk-hq-sales',
    status: 'SUCCEEDED',
    trigger_type: 'SCHEDULED',
    requested_by_name: 'E2E 관리자',
    started_at: '2026-08-06T09:09:00+09:00',
    finished_at: '2026-08-06T09:10:00+09:00',
    range_from: '2026-08-05T00:00:00+09:00',
    range_to: '2026-08-06T09:09:00+09:00',
    fetched_count: 2,
    inserted_count: 2,
    updated_count: 0,
    error_code: null,
    error_message: null,
    request_id: 'e2e-bank-run-501',
  },
  {
    id: '500',
    account_id: 'ibk-hq-supplier',
    status: 'FAILED',
    trigger_type: 'IMPORT',
    requested_by_name: '재무 담당자',
    started_at: '2026-08-05T18:00:00+09:00',
    finished_at: '2026-08-05T18:00:02+09:00',
    range_from: null,
    range_to: null,
    fetched_count: 0,
    inserted_count: 0,
    updated_count: 0,
    error_code: 'E2E_IMPORT_ERROR',
    error_message: '테스트용 실패 이력',
    request_id: 'e2e-bank-run-500',
  },
];

type BankRequest = { method: string; path: string; search: string };

async function installBankLedgerScenario(
  page: Page,
  user: { name: string; role: string; group_name: string },
  bankOverrides: {
    accounts?: any[];
    collectorConfigured?: boolean;
    autoReconciliationEnabled?: boolean;
    canViewBalances?: boolean;
    transactions?: any[];
    syncRuns?: any[];
  } = {},
) {
  await installFirebaseStub(page);
  const requests: BankRequest[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/peakos/bank/')) return;
    requests.push({ method: request.method(), path: url.pathname, search: url.search });
  });

  const store = await installPeakosStub(page, {
    ...user,
    uid: 'e2e-bank-user',
  });
  const canViewBalances = bankOverrides.canViewBalances
    ?? ['패션TV봉이', '박종원', '김대호', '손명아'].includes(user.name);
  const restrictedAccountIds = new Set(['ibk-hq-supplier', 'ibk-hq-fixed']);
  const accounts = (bankOverrides.accounts ?? bankAccounts)
    .filter((row: any) => canViewBalances || !restrictedAccountIds.has(String(row.id)))
    .map((row: any) => ({
      ...row,
      latestBalance: canViewBalances ? row.latestBalance : null,
      latestBalanceAt: canViewBalances ? row.latestBalanceAt : null,
    }));
  const visibleAccountIds = new Set(accounts.map((row: any) => String(row.id)));
  const transactions = (bankOverrides.transactions ?? bankTransactions)
    .filter((row: any) => visibleAccountIds.has(String(row.accountId)))
    .map((row: any) => ({ ...row, balance: canViewBalances ? row.balance : null }));
  const syncRuns = (bankOverrides.syncRuns ?? bankSyncRuns)
    .filter((row: any) => visibleAccountIds.has(String(row.accountId ?? row.account_id)));
  store.bank = {
    accounts,
    collectorConfigured: bankOverrides.collectorConfigured ?? false,
    autoReconciliationEnabled: bankOverrides.autoReconciliationEnabled ?? false,
    canViewBalances,
    transactions,
    syncRuns,
  };
  return requests;
}

async function openBankLedger(page: Page, fromHiddenNavigation = false) {
  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  const tab = page.locator('.nav-item[data-view="bank"]');

  if (fromHiddenNavigation) {
    await page.evaluate(() => {
      (document.querySelector('.nav-item[data-view="bank"]') as HTMLElement | null)?.click();
    });
  } else {
    const taxBankingCluster = page.locator('[data-nav-cluster="tax-banking"]');
    if (await taxBankingCluster.evaluate(element => element.classList.contains('closed'))) {
      await taxBankingCluster.locator(':scope > .nav-cluster-toggle').click();
    }
    const bankTaxGroup = taxBankingCluster.locator('[data-tax-banking-group="bank-tax"]');
    if ((await bankTaxGroup.getAttribute('class'))?.includes('closed')) {
      await bankTaxGroup.locator(':scope > button').first().click();
    }
    await expect(tab).toBeVisible();
    await tab.click();
  }

  const ledger = page.locator('[data-bank-ledger]');
  await expect(ledger).toBeVisible();
  await expect(page.locator('[data-bank-loading]')).toBeHidden();
  await expect(page.locator('[data-bank-error]')).toBeHidden();
  return ledger;
}

test.describe('PEAK OS bank ledger', () => {
  test('admin sees masked accounts, deposits, withdrawals and sync history from GET stubs', async ({ page }) => {
    const requests = await installBankLedgerScenario(page, {
      name: '김대호',
      role: 'admin',
      group_name: '본사 경영지원팀',
    });

    const ledger = await openBankLedger(page);
    await expect(ledger.locator('.bank-account-card')).toHaveCount(5);
    await expect(ledger.locator('.bank-account-card').first()).toContainText('본사 매출통장');
    await expect(ledger.locator('.bank-account-card').first()).toContainText('IBK기업은행');
    await expect(ledger.locator('.bank-account-card').first()).toContainText('12-********-7890');
    await expect(ledger.locator('.bank-account-card').first()).toContainText('125,034,000');
    await expect(ledger).not.toContainText(FULL_ACCOUNT_SENTINEL);

    const transactionTable = ledger.locator('.bank-transaction-table');
    await expect(transactionTable).toBeVisible();
    await expect(transactionTable).toContainText('입금');
    await expect(transactionTable).toContainText('1,100,000');
    await expect(transactionTable).toContainText('테스트광고');
    await expect(transactionTable).toContainText('출금');
    await expect(transactionTable).toContainText('420,000');
    await expect(transactionTable).toContainText('테스트공급처');
    await expect(ledger).not.toContainText('99887766554433');
    await expect(ledger).not.toContainText(RAW_PAYLOAD_SENTINEL);

    const syncTable = ledger.locator('.bank-sync-table');
    await expect(syncTable).toBeVisible();
    await expect(syncTable).toContainText('E2E 관리자');
    await expect(syncTable).toContainText('재무 담당자');
    await expect(page.locator('[data-bank-sync]')).toBeHidden();
    await expect(ledger.getByText('자동 확인 보류', { exact: true })).toBeVisible();
    await expect(ledger).toContainText('IBK 공식 거래번호가 확인될 때까지');

    await expect.poll(() => requests.map(request => request.path)).toEqual(expect.arrayContaining([
      '/api/peakos/bank/accounts',
      '/api/peakos/bank/transactions',
      '/api/peakos/bank/sync-runs',
    ]));
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    const transactionQuery = new URLSearchParams(
      requests.find(request => request.path.endsWith('/transactions'))?.search,
    );
    expect(transactionQuery.get('page')).toBe('1');
    expect(transactionQuery.get('limit')).toBe('100');
  });

  test('KST 월별·기간별 조회는 경계 시각과 종료일 다음 날을 정확히 적용한다', async ({ page }) => {
    const requests = await installBankLedgerScenario(page, {
      name: '김대호',
      role: 'admin',
      group_name: '본사 경영지원팀',
    }, {
      transactions: bankPeriodBoundaryTransactions,
    });

    const ledger = await openBankLedger(page);
    const transactionRows = ledger.locator('.bank-transaction-table tbody tr');
    const periodFilter = ledger.locator('[data-finance-period-filter="bank"]');
    const latestTransactionQuery = () => {
      const request = requests.filter(item => item.path.endsWith('/transactions')).at(-1);
      return Object.fromEntries(new URLSearchParams(request?.search));
    };
    const setFilterValue = async (selector: string, value: string) => {
      await periodFilter.locator(selector).evaluate((element, nextValue) => {
        const input = element as HTMLInputElement;
        input.value = nextValue;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
    };

    await periodFilter.locator('[data-finance-period-mode="month"]').click();
    await setFilterValue('[data-finance-period-month]', '2026-08');

    await expect.poll(latestTransactionQuery).toMatchObject({
      page: '1',
      limit: '100',
      from: '2026-08-01T00:00:00+09:00',
      to: '2026-09-01T00:00:00+09:00',
    });
    await expect(page.locator('[data-bank-loading]')).toBeHidden();
    await expect(transactionRows).toHaveCount(2);
    await expect(transactionRows).toContainText(['8월 시작 경계', '8월 종료 경계']);
    await expect(ledger).not.toContainText('7월말 경계 밖');
    await expect(ledger).not.toContainText('9월 시작 경계');

    await periodFilter.locator('[data-finance-period-mode="range"]').click();
    await setFilterValue('[data-finance-period-from]', '2026-08-31');
    await setFilterValue('[data-finance-period-to]', '2026-09-01');

    await expect.poll(latestTransactionQuery).toMatchObject({
      page: '1',
      limit: '100',
      from: '2026-08-31T00:00:00+09:00',
      to: '2026-09-02T00:00:00+09:00',
    });
    await expect(page.locator('[data-bank-loading]')).toBeHidden();
    await expect(transactionRows).toHaveCount(2);
    await expect(transactionRows).toContainText(['8월 종료 경계', '9월 시작 경계']);
    await expect(ledger).not.toContainText('7월말 경계 밖');
    await expect(ledger).not.toContainText('8월 시작 경계');
  });

  test('ordinary member reads three operating accounts without balances', async ({ page }) => {
    const requests = await installBankLedgerScenario(page, {
      name: '일반 영업자',
      role: 'member',
      group_name: '본사 영업팀',
    });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    const cluster = page.locator('[data-nav-cluster="tax-banking"]');
    if ((await cluster.getAttribute('class'))?.includes('closed')) {
      await cluster.locator(':scope > .nav-cluster-toggle').click();
    }
    const bankTaxGroup = cluster.locator('[data-tax-banking-group="bank-tax"]');
    if ((await bankTaxGroup.getAttribute('class'))?.includes('closed')) {
      await bankTaxGroup.locator(':scope > button').first().click();
    }
    await expect(page.locator('.nav-item[data-view="bank"]')).toBeVisible();
    await page.locator('.nav-item[data-view="bank"]').click();
    const ledger = page.locator('[data-bank-ledger]');
    await expect(ledger).toBeVisible();
    await expect(page.locator('[data-bank-loading]')).toBeHidden();
    await expect(ledger.locator('.bank-account-card')).toHaveCount(3);
    await expect(ledger).toContainText('본사 매출통장');
    await expect(ledger).toContainText('리뷰스페이스통장');
    await expect(ledger).toContainText('리워드스페이스통장');
    await expect(ledger).not.toContainText('본사 운영통장');
    await expect(ledger).not.toContainText('고정비용통장');
    await expect(ledger).not.toContainText('통장 잔액 합계');
    await expect(ledger).not.toContainText('거래 후 잔액');
    await expect(ledger).not.toContainText('125,034,000');
    await expect.poll(() => requests.map(request => request.path)).toEqual(expect.arrayContaining([
      '/api/peakos/bank/accounts',
      '/api/peakos/bank/transactions',
      '/api/peakos/bank/sync-runs',
    ]));
  });

  test('김진봉 sees general transactions but no restricted account or balance values', async ({ page }) => {
    const requests = await installBankLedgerScenario(page, {
      name: '김진봉',
      role: 'manager',
      group_name: '본사',
    });

    const ledger = await openBankLedger(page);
    await expect(ledger.locator('.bank-account-card')).toHaveCount(3);
    await expect(ledger).toContainText('본사 매출통장');
    await expect(ledger).not.toContainText('본사 운영통장');
    await expect(ledger).not.toContainText('고정비용통장');
    await expect(ledger).toContainText('리뷰스페이스통장');
    await expect(ledger).toContainText('리워드스페이스통장');
    await expect(ledger).not.toContainText('통장 잔액 합계');
    await expect(ledger).not.toContainText('거래 후 잔액');
    await expect(ledger).not.toContainText('125,034,000');
    await expect(ledger).not.toContainText('38,210,000');
    await expect(ledger.locator('.bank-transaction-card')).toHaveCount(1);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });

  test('mobile uses cards for both ledgers and does not widen the page', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const requests = await installBankLedgerScenario(page, {
      name: '김대호',
      role: 'admin',
      group_name: '본사 경영지원팀',
    });

    const ledger = await openBankLedger(page, true);
    await expect(ledger.locator('.bank-transaction-table')).toBeHidden();
    await expect(ledger.locator('.bank-transaction-cards')).toBeVisible();
    await expect(ledger.locator('.bank-transaction-card')).toHaveCount(2);
    await expect(ledger.locator('.bank-transaction-card').first()).toContainText('입금');
    await expect(ledger.locator('.bank-transaction-card').first()).toContainText('1,100,000');
    await expect(ledger.locator('.bank-transaction-card').nth(1)).toContainText('출금');
    await expect(ledger.locator('.bank-transaction-card').nth(1)).toContainText('420,000');

    await expect(ledger.locator('.bank-sync-table')).toBeHidden();
    await expect(ledger.locator('.bank-sync-cards')).toBeVisible();
    await expect(ledger.locator('.bank-sync-card')).toHaveCount(2);
    await expect(ledger.locator('.bank-sync-card').first()).toContainText('E2E 관리자');

    const widths = await page.evaluate(() => {
      const root = document.querySelector('[data-bank-ledger]') as HTMLElement;
      return {
        documentClient: document.documentElement.clientWidth,
        documentScroll: document.documentElement.scrollWidth,
        ledgerClient: root.clientWidth,
        ledgerScroll: root.scrollWidth,
      };
    });
    expect(widths.documentScroll).toBeLessThanOrEqual(widths.documentClient + 1);
    expect(widths.ledgerScroll).toBeLessThanOrEqual(widths.ledgerClient + 1);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });

  test('mobile safely shows all five inactive migration accounts before collector setup', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const requests = await installBankLedgerScenario(page, {
      name: '김대호',
      role: 'admin',
      group_name: '본사 경영지원팀',
    }, {
      accounts: inactiveMigrationAccounts,
      collectorConfigured: false,
      canViewBalances: true,
      transactions: [],
      syncRuns: [],
    });

    const ledger = await openBankLedger(page, true);
    const cards = ledger.locator('.bank-account-card');
    await expect(cards).toHaveCount(5);

    for (const [index, account] of inactiveMigrationAccounts.entries()) {
      const card = cards.nth(index);
      await expect(card).toContainText(account.displayName);
      await expect(card).toContainText(account.accountNumberMasked);
      await expect(card.locator('.bank-account-state')).toHaveText('중지');
      await expect(card).toContainText('미수집');
      await expect(ledger).not.toContainText(account.accountNumber);
    }

    await expect(ledger.getByText('조회 수집기 미설정', { exact: true })).toBeVisible();
    await expect(page.locator('[data-bank-sync]')).toBeHidden();

    const safety = await page.evaluate(() => {
      const root = document.querySelector('[data-bank-ledger]') as HTMLElement;
      return {
        text: root.innerText,
        documentClient: document.documentElement.clientWidth,
        documentScroll: document.documentElement.scrollWidth,
        ledgerClient: root.clientWidth,
        ledgerScroll: root.scrollWidth,
      };
    });
    expect(safety.text).not.toMatch(/\d{10,}/);
    expect(safety.documentScroll).toBeLessThanOrEqual(safety.documentClient + 1);
    expect(safety.ledgerScroll).toBeLessThanOrEqual(safety.ledgerClient + 1);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });
});
