import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const EXPENSES = [
  { id: 'e1', spentOn: '2026-08-20', category: 'ai', serviceName: 'ChatGPT Plus',
    amount: 29000, cardName: '국민카드', isSubscription: true, renewsOn: '2026-09-20',
    paid: true, memo: '개발 계정', version: 1, createdBy: { uid: 'u', name: '김동우' } },
  { id: 'e2', spentOn: '2026-08-18', category: 'server', serviceName: 'AWS Lightsail',
    amount: 12500, cardName: '', isSubscription: false, renewsOn: null,
    paid: false, memo: '', version: 1, createdBy: { uid: 'u', name: '김동우' } },
];

async function open(page, { status = 200, onWrite = null } = {}) {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김동우', group_name: '본사 개발팀' });
  await page.route('**/peakos/dev-expenses', async route => {
    if (route.request().method() === 'POST') {
      onWrite?.(route.request().postDataJSON());
      return route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify({ expense: EXPENSES[0] }) });
    }
    if (status !== 200) {
      return route.fulfill({ status, contentType: 'application/json',
        body: JSON.stringify({ code: 'DEV_EXPENSE_FORBIDDEN', error: '개발비 내역을 볼 권한이 없습니다.' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ expenses: EXPENSES, categories: [], cards: ['국민카드'], canWrite: true }) });
  });
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
}

test('개발비 탭은 합계와 내역을 보여 준다', async ({ page }) => {
  await open(page);
  await page.locator('.nav-item[data-view="dev-expense"]').click();
  const view = page.locator('#devExpenseView');
  await expect(view).toBeVisible();

  // 전체 41,500 / 구독 29,000 / 미결제 12,500
  const summary = view.locator('.dev-expense-summary > span');
  await expect(summary.nth(0)).toContainText('41,500원');
  await expect(summary.nth(1)).toContainText('29,000원');
  await expect(summary.nth(2)).toContainText('12,500원');

  await expect(view.locator('.dev-expense-row:not(.is-head)')).toHaveCount(2);
  const first = view.locator('.dev-expense-row:not(.is-head)').first();
  await expect(first).toContainText('ChatGPT Plus');
  await expect(first.locator('.dev-expense-category')).toHaveText('AI 사용');
  await expect(first.locator('.dev-expense-paid')).toHaveText('결제완료');
  await expect(view.locator('.dev-expense-row:not(.is-head)').nth(1).locator('.dev-expense-paid')).toHaveText('미결제');
});

test('개발비를 적으면 카드·구독·결제 여부까지 함께 보낸다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onWrite: body => { sent = body; } });
  await page.locator('.nav-item[data-view="dev-expense"]').click();
  await page.locator('[data-dev-expense-create]').click();

  const form = page.locator('#devExpenseForm');
  await expect(form).toBeVisible();
  await form.locator('[name="spentOn"]').fill('2026-08-20');
  await form.locator('[name="category"]').selectOption('hosting');
  await form.locator('[name="serviceName"]').fill('가비아 호스팅');
  await form.locator('[name="amount"]').fill('33000');
  await form.locator('[name="cardName"]').fill('기업카드');
  await form.locator('[name="isSubscription"]').check();
  await form.locator('[name="renewsOn"]').fill('2026-11-20');
  await form.locator('[name="paid"]').check();
  await form.locator('[name="memo"]').fill('연 단위 결제');
  await form.locator('button[type="submit"]').click();

  await expect.poll(() => sent).not.toBeNull();
  expect(sent).toEqual({
    spentOn: '2026-08-20', category: 'hosting', serviceName: '가비아 호스팅',
    amount: '33000', cardName: '기업카드', isSubscription: true,
    renewsOn: '2026-11-20', paid: true, memo: '연 단위 결제',
  });
});

test('구독이 아니면 다음 결제일을 아예 적지 못한다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onWrite: body => { sent = body; } });
  await page.locator('.nav-item[data-view="dev-expense"]').click();
  await page.locator('[data-dev-expense-create]').click();
  const form = page.locator('#devExpenseForm');

  // 기본은 구독 아님 → 갱신일 칸이 잠겨 있다.
  await expect(form.locator('[name="renewsOn"]')).toBeDisabled();
  await form.locator('[name="isSubscription"]').check();
  await expect(form.locator('[name="renewsOn"]')).toBeEnabled();

  // 구독인데 결제일을 비우면 보내지 않는다.
  await form.locator('[name="serviceName"]').fill('구독인데 날짜 없음');
  await form.locator('[name="amount"]').fill('1000');
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('.toast, [data-toast]').first()).toContainText('다음 결제일을 정해');
  expect(sent).toBeNull();
});

test('권한이 없으면 개발비 탭 자체가 사라진다', async ({ page }) => {
  await open(page, { status: 403 });
  // 서버가 403을 주면 메뉴가 아예 열리지 않는다.
  // 볼 수 없는 메뉴를 남겨 두면 눌러 보게 되고, 눌러도 아무 일이 없으면 고장으로 읽힌다.
  const nav = page.locator('.nav-item[data-view="dev-expense"]');
  await expect(nav).toBeHidden();
  await expect(nav).toHaveAttribute('data-nav-locked', 'true');

  // 권한 있는 사람에게는 같은 자리에 보인다.
  await open(page);
  await expect(page.locator('.nav-item[data-view="dev-expense"]')).toBeVisible();
});
