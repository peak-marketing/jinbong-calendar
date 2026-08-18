import { expect, test, type Locator, type Page } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

type Seed = {
  key: string;
  date: string;
  client: string;
  sales: number;
  credit: number;
};

const seeds: Seed[] = [
  { key: 'july-outside', date: '2026-07-31', client: '칠월외부업체', sales: 70_000, credit: 7_000 },
  { key: 'august-start', date: '2026-08-01', client: '팔월시작업체', sales: 100_000, credit: 10_000 },
  { key: 'august-middle', date: '2026-08-15', client: '팔월중간업체', sales: 200_000, credit: 20_000 },
  { key: 'august-end', date: '2026-08-31', client: '팔월끝업체', sales: 300_000, credit: 30_000 },
  { key: 'september-edge', date: '2026-09-01', client: '구월경계업체', sales: 400_000, credit: 40_000 },
  { key: 'september-outside', date: '2026-09-02', client: '구월외부업체', sales: 900_000, credit: 90_000 },
];

const augustClients = ['팔월시작업체', '팔월중간업체', '팔월끝업체'];
const rangeClients = ['팔월중간업체', '팔월끝업체', '구월경계업체'];

function intakeRow(seed: Seed) {
  return {
    id: `intake-${seed.key}`,
    ownerName: '김대호',
    date: seed.date,
    client: seed.client,
    expectedPayer: seed.client,
    a: '블로그',
    b: '원고',
    c: '프리미엄원고대필',
    unit: 10_000,
    qty: 1,
    sell: seed.sales,
    cost: 5_000,
    memo: `${seed.client} 접수`,
    kind: 'normal',
    refOf: '',
    supplier: '테스트공급처',
    manager: '',
    finalOnly: false,
    paid: 'none',
    paidAmount: 0,
    payer: '',
    paidDate: '',
    paidMemo: '',
    paidAuto: false,
    vendorPaid: false,
    vendorPaidDate: '',
    vendorBank: '',
    vendorBy: '',
    vendorMemo: '',
  };
}

function creditRow(seed: Seed) {
  return {
    id: `credit-${seed.key}`,
    ownerName: '김대호',
    date: seed.date,
    client: `충전-${seed.client}`,
    product: '블로그',
    vendor: '테스트공급처',
    kind: 'charge',
    paid: seed.credit,
    point: seed.credit + 1_000,
    memo: `${seed.client} 충전`,
  };
}

function creditRequest(seed: Seed) {
  return {
    id: `request-${seed.key}`,
    requesterUid: 'e2e-test-user',
    requesterName: '김대호',
    targetAccountId: 'ibk-review-space',
    requestDate: seed.date,
    client: `요청-${seed.client}`,
    depositorName: `입금-${seed.client}`,
    product: '블로그',
    vendor: '테스트공급처',
    expectedAmount: seed.credit,
    pointAmount: seed.credit + 1_000,
    memo: `${seed.client} 요청`,
    status: 'PENDING',
    bankTransactionId: null,
  };
}

async function seedFinanceData(page: Page) {
  await installFirebaseStub(page);
  const store = await installPeakosStub(page, {
    name: '김대호',
    uid: 'e2e-test-user',
    role: 'manager',
    group_name: '본사 경영지원팀',
  });
  store.intake = seeds.map(intakeRow);
  store.credit = seeds.map(creditRow);
  store.creditRequests = seeds.map(creditRequest);
  return store;
}

async function openView(page: Page, view: string) {
  const tab = page.locator(`.nav-item[data-view="${view}"]`);
  const cluster = tab.locator('xpath=ancestor::section[contains(@class, "nav-cluster")]');
  if ((await cluster.getAttribute('class'))?.includes('closed')) {
    await cluster.locator('.nav-cluster-toggle').click();
  }
  const subcluster = tab.locator('xpath=ancestor::*[@data-nav-subcluster][1]');
  if (await subcluster.count()) {
    if ((await subcluster.getAttribute('class'))?.includes('closed')) {
      await subcluster.locator(':scope > button').first().click();
    }
  }
  await expect(tab).toBeVisible();
  await tab.click();
  const period = page.locator(`[data-finance-period-filter="${view}"]`);
  await expect(period).toBeVisible();
  return period;
}

async function expectSharedPeriod(
  page: Page,
  view: string,
  mode: 'month' | 'range',
  label: string,
) {
  const period = page.locator(`[data-finance-period-filter="${view}"]`);
  await expect(period.locator(`[data-finance-period-mode="${mode}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(period.locator('.finance-period-result strong')).toHaveText(label);
  return period;
}

async function expectOnlyClients(results: Locator, included: string[], excluded: string[]) {
  for (const client of included) await expect(results.filter({ hasText: client }).first()).toBeVisible();
  for (const client of excluded) await expect(results.filter({ hasText: client })).toHaveCount(0);
}

test.describe('재무 탭 공통 월별·기간별 조회', () => {
  test('개인정산서 첫 진입은 현재 월 최신 원장부터 보여주고 전체 이력은 명시적으로 연다', async ({ page }) => {
    await seedFinanceData(page);
    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();

    const period = await openView(page, 'settlement');
    await expect(period.locator('[data-finance-period-mode="month"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(period.locator('[data-finance-period-month]')).toHaveValue('2026-08');
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(3);
    await expectOnlyClients(
      page.locator('#moduleView .ledger-day'),
      augustClients,
      ['칠월외부업체', '구월경계업체', '구월외부업체'],
    );

    await period.locator('[data-finance-period-mode="all"]').click();
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(6);
  });

  test('탭·입금 필터를 바꾸면 숨겨진 선택을 버리고 정산서 재불러오기도 조회 기간을 지킨다', async ({ page }) => {
    const store = await seedFinanceData(page);
    store.intake = [
      intakeRow({ key: 'shared-july', date: '2026-07-31', client: '공통정산업체', sales: 70_000, credit: 7_000 }),
      intakeRow({ key: 'shared-august', date: '2026-08-15', client: '공통정산업체', sales: 200_000, credit: 20_000 }),
      intakeRow({ key: 'other-august', date: '2026-08-20', client: '다른업체', sales: 300_000, credit: 30_000 }),
    ];

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();

    const settlementPeriod = await openView(page, 'settlement');
    await settlementPeriod.locator('[data-finance-period-mode="month"]').click();
    await page.locator('[data-finance-period-month]').fill('2026-08');
    await page.locator('[data-ledger-filter="client"]').selectOption('공통정산업체');
    await page.locator('[data-intake-pick]').check();
    await expect(page.locator('#moduleView .pick-bar')).toContainText('1건');

    await openView(page, 'deposit-check');
    await expect(page.locator('#moduleView .pick-bar')).toHaveCount(0);
    await page.locator('[data-intake-pick]').first().check();
    await expect(page.locator('#moduleView .pick-bar')).toContainText('1건');
    await page.locator('[data-deposit-filter="client"]').selectOption('다른업체');
    await expect(page.locator('#moduleView .pick-bar')).toHaveCount(0);

    await openView(page, 'settlement');
    await page.locator('[data-ledger-filter="client"]').selectOption('공통정산업체');
    await page.locator('[data-estimate-open]').click();
    await expect(page.locator('#readonlyDetailModal')).toBeVisible();
    await expect(page.locator('#estLines tr')).toHaveCount(1);
    await expect(page.locator('#readonlyModalBody')).toContainText('2026년 8월 접수만 불러옵니다');
    await page.locator('[data-est-load]').click();
    await expect(page.locator('#estLines tr')).toHaveCount(1);
    await expect(page.locator('#estLines')).toContainText('200,000');
    await expect(page.locator('#estLines')).not.toContainText('70,000');
  });

  test('개인정산서에서 고른 8월이 다른 재무 탭에 유지되고 8월 밖 자료를 제외한다', async ({ page }) => {
    await seedFinanceData(page);
    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();

    const settlementPeriod = await openView(page, 'settlement');
    await settlementPeriod.locator('[data-finance-period-mode="month"]').click();
    await page.locator('[data-finance-period-month]').fill('2026-08');
    await expectSharedPeriod(page, 'settlement', 'month', '2026년 8월');
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(3);
    await expectOnlyClients(page.locator('#moduleView .ledger-day'), augustClients, ['칠월외부업체', '구월경계업체', '구월외부업체']);
    await expect(page.locator('#moduleView .settlement-kpi-card.sales strong')).toHaveText('600,000');

    await openView(page, 'deposit-check');
    const depositPeriod = await expectSharedPeriod(page, 'deposit-check', 'month', '2026년 8월');
    await expect(depositPeriod.locator('[data-finance-period-month]')).toHaveValue('2026-08');
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(3);
    await expectOnlyClients(page.locator('#moduleView .sales-table'), augustClients, ['칠월외부업체', '구월경계업체', '구월외부업체']);
    await expect(page.locator('#moduleView .module-statusbar')).toContainText('미수 600,000원');

    await openView(page, 'invoice');
    await expectSharedPeriod(page, 'invoice', 'month', '2026년 8월');
    await expect(page.locator('#moduleView .sales-table tbody tr')).toHaveCount(3);
    await expectOnlyClients(page.locator('#moduleView .sales-table'), augustClients, ['칠월외부업체', '구월경계업체', '구월외부업체']);
    await expect(page.locator('#moduleView .module-chip').filter({ hasText: '공급가액' })).toContainText('공급가액 600,000 · 세액 60,000');

    await openView(page, 'credit');
    await expectSharedPeriod(page, 'credit', 'month', '2026년 8월');
    const requestSection = page.locator('#moduleView .module-section').filter({ hasText: '전체 충전 요청' });
    const creditLedger = page.locator('#moduleView .module-section').filter({ hasText: '충전금 장부' });
    await expect(requestSection.locator('.ledger-table tbody tr')).toHaveCount(3);
    await expect(creditLedger.locator('.ledger-table tbody tr')).toHaveCount(3);
    await expectOnlyClients(
      page.locator('#moduleView .sales-table'),
      augustClients.flatMap(client => [`요청-${client}`, `충전-${client}`]),
      ['요청-칠월외부업체', '충전-칠월외부업체', '요청-구월경계업체', '충전-구월경계업체'],
    );
    await expect(page.locator('#moduleView .module-chip').filter({ hasText: '입금 60,000원' })).toContainText('포인트 63,000P');

    await openView(page, 'closing');
    await expectSharedPeriod(page, 'closing', 'month', '2026년 8월');
    await expect(page.locator('#moduleView .sales-table tbody tr')).toHaveCount(1);
    await expect(page.locator('#moduleView .sales-table tbody tr')).toContainText('2026년 08월');
    await expect(page.locator('#moduleView .final-total')).toContainText('판매가액 600,000');
    await expect(page.locator('#moduleView')).not.toContainText('2026년 07월');
    await expect(page.locator('#moduleView')).not.toContainText('2026년 09월');

    await openView(page, 'tax-advance');
    await expectSharedPeriod(page, 'tax-advance', 'month', '2026년 8월');
    await expect(page.locator('#moduleView')).toContainText('세금계산서 선발행 요청');
    await expect(page.locator('#moduleView [data-finance-request-form]')).toBeVisible();
    await expect(page.locator('#moduleView')).toContainText('조회 조건에 맞는 요청이 없습니다.');
  });

  test('개인정산서의 기간별 조회가 양 끝 날짜를 포함해 모든 재무 탭에 유지된다', async ({ page }) => {
    await seedFinanceData(page);
    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();

    const settlementPeriod = await openView(page, 'settlement');
    await settlementPeriod.locator('[data-finance-period-mode="range"]').click();
    await page.locator('[data-finance-period-from]').fill('2026-08-15');
    await page.locator('[data-finance-period-to]').fill('2026-09-01');
    const rangeLabel = '2026-08-15 ~ 2026-09-01';
    await expectSharedPeriod(page, 'settlement', 'range', rangeLabel);
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(3);
    await expectOnlyClients(page.locator('#moduleView .ledger-day'), rangeClients, ['칠월외부업체', '팔월시작업체', '구월외부업체']);
    await expect(page.locator('#moduleView .settlement-kpi-card.sales strong')).toHaveText('900,000');

    await openView(page, 'deposit-check');
    const depositPeriod = await expectSharedPeriod(page, 'deposit-check', 'range', rangeLabel);
    await expect(depositPeriod.locator('[data-finance-period-from]')).toHaveValue('2026-08-15');
    await expect(depositPeriod.locator('[data-finance-period-to]')).toHaveValue('2026-09-01');
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(3);
    await expectOnlyClients(page.locator('#moduleView .sales-table'), rangeClients, ['칠월외부업체', '팔월시작업체', '구월외부업체']);
    await expect(page.locator('#moduleView .module-statusbar')).toContainText('미수 900,000원');

    await openView(page, 'invoice');
    await expectSharedPeriod(page, 'invoice', 'range', rangeLabel);
    await expect(page.locator('#moduleView .sales-table tbody tr')).toHaveCount(3);
    await expectOnlyClients(page.locator('#moduleView .sales-table'), rangeClients, ['칠월외부업체', '팔월시작업체', '구월외부업체']);
    await expect(page.locator('#moduleView .module-chip').filter({ hasText: '공급가액' })).toContainText('공급가액 900,000 · 세액 90,000');

    await openView(page, 'credit');
    await expectSharedPeriod(page, 'credit', 'range', rangeLabel);
    const requestSection = page.locator('#moduleView .module-section').filter({ hasText: '전체 충전 요청' });
    const creditLedger = page.locator('#moduleView .module-section').filter({ hasText: '충전금 장부' });
    await expect(requestSection.locator('.ledger-table tbody tr')).toHaveCount(3);
    await expect(creditLedger.locator('.ledger-table tbody tr')).toHaveCount(3);
    await expectOnlyClients(
      page.locator('#moduleView .sales-table'),
      rangeClients.flatMap(client => [`요청-${client}`, `충전-${client}`]),
      ['요청-칠월외부업체', '충전-팔월시작업체', '요청-구월외부업체'],
    );
    await expect(page.locator('#moduleView .module-chip').filter({ hasText: '입금 90,000원' })).toContainText('포인트 93,000P');

    await openView(page, 'closing');
    await expectSharedPeriod(page, 'closing', 'range', rangeLabel);
    await expect(page.locator('#moduleView .sales-table tbody tr')).toHaveCount(2);
    await expect(page.locator('#moduleView .sales-table tbody')).toContainText('2026년 08월');
    await expect(page.locator('#moduleView .sales-table tbody')).toContainText('2026년 09월');
    await expect(page.locator('#moduleView .final-total')).toContainText('판매가액 900,000');
    await expect(page.locator('#moduleView')).not.toContainText('2026년 07월');

    await openView(page, 'tax-advance');
    const taxPeriod = await expectSharedPeriod(page, 'tax-advance', 'range', rangeLabel);
    await expect(taxPeriod.locator('[data-finance-period-from]')).toHaveValue('2026-08-15');
    await expect(taxPeriod.locator('[data-finance-period-to]')).toHaveValue('2026-09-01');
    await expect(page.locator('#moduleView')).toContainText('세금계산서 선발행 요청');
    await expect(page.locator('#moduleView [data-finance-request-form]')).toBeVisible();
    await expect(page.locator('#moduleView')).toContainText('조회 조건에 맞는 요청이 없습니다.');
  });
});
