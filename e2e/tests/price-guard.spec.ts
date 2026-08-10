import { test, expect, type Page } from '@playwright/test';
import { installFirebaseStub, installPeakosStub, handlePeakos, createPeakosStore } from './helpers';

async function openNavView(page: Page, view: string) {
  const tab = page.locator(`.app-sidebar .nav-item[data-view="${view}"]`).first();
  const cluster = tab.locator('xpath=ancestor::*[@data-nav-cluster][1]');
  if (await cluster.count() && (await cluster.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await cluster.locator(':scope > .nav-cluster-toggle').click();
  }
  await expect(tab).toBeVisible();
  await tab.click();
}

// 서버가 회사원가를 걸러 내려주는지, 화면 파일에는 값이 없는지
test('단가표가 화면 파일에 없다', async ({ page }) => {
  const res = await page.request.get('/business-os-preview.js');
  const body = await res.text();
  expect(body).not.toContain('const PRICE_TABLE = [\n');
  for (const n of ['17000', '45000', '13000', '19000']) {
    expect(body, `${n} 이 파일에 남아 있으면 안 됨`).not.toContain(`, ${n}, `);
  }
});

for (const [name, seesCost] of [['김대호', true]] as [string, boolean][]) {
  test(`단가표 수신 - ${name}`, async ({ page }) => {
    await installFirebaseStub(page);
    const store = createPeakosStore();
    // 서버가 하는 일을 그대로 흉내낸다: 권한 없으면 cost 를 null 로
    store.prices = [
      { key: '블로그|최적화블로그|최블 B', a: '블로그', b: '최적화블로그', c: '최블 B',
        cost: seesCost ? 17000 : null, unit: 19000, custom: false },
    ];
    await page.route('**/api/**', route => {
      if (handlePeakos(store, route)) return;
      const p = new URL(route.request().url()).pathname.replace(/^\/api/, '');
      let payload: unknown = [];
      if (p === '/users/me') {
        payload = {
          uid: 'u', name, role: 'manager', approved: true, is_active: true,
          group_name: '본사 영업팀', peakos_can_view_finance_operations: seesCost,
        };
      }
      else if (p === '/chat-rooms/unread') payload = {};
      else if (p === '/projects') payload = { canManageAll: false, projects: [] };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    // 회사원가는 최종정산서 화면에서만 드러난다. 개인정산서는 누구든 영업자단가 기준.
    const view = seesCost ? 'final-settlement' : 'settlement';
    await openNavView(page, view);
    await page.locator('[data-price-table]').click();
    await page.locator('#priceSearch').fill('최블 B');
    const row = page.locator('.price-table tbody tr').first();
    await expect(row).toContainText('19,000');
    await expect(row).toContainText('17,000');
  });
}

// 영업자는 개인 정산서의 영업자단가만 보고, 서버도 회사원가를 안 내려보낸다.
test('영업자는 회사원가에 닿을 수 없다 - 김용일', async ({ page }) => {
  await installFirebaseStub(page);
  const store = createPeakosStore();
  let sentCost: unknown = 'not-called';
  store.prices = [
    { key: '블로그|최적화블로그|최블 B', a: '블로그', b: '최적화블로그', c: '최블 B',
      cost: null, unit: 19000, custom: false },   // 서버가 이미 null 로 지워서 보냄
  ];
  await page.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    if (p === '/peakos/prices') sentCost = store.prices[0].cost;
    if (handlePeakos(store, route)) return;
    let payload: unknown = [];
    if (p === '/users/me') payload = { uid: 'u', name: '김용일', role: 'manager', approved: true, is_active: true, group_name: '본사 영업팀' };
    else if (p === '/chat-rooms/unread') payload = {};
    else if (p === '/projects') payload = { canManageAll: false, projects: [] };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();

  // 개인 정산서는 열 수 있지만 단가표에는 영업자단가만 표시된다.
  await openNavView(page, 'settlement');
  await expect(page.locator('#moduleView')).toBeVisible();
  await page.locator('[data-price-table]').click();
  await page.locator('#priceSearch').fill('최블 B');
  const row = page.locator('.price-table tbody tr').first();
  await expect(row).toContainText('19,000');
  await expect(row).not.toContainText('17,000');

  // 서버가 내려보낸 회사원가는 비어 있다
  expect(sentCost).toBeNull();
});

test('단가 저장 실패는 성공 표시를 하지 않고 서버 단가로 되돌린다', async ({ page }) => {
  await installFirebaseStub(page);
  await installPeakosStub(page, {
    name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀',
  });
  let failNext = true;
  await page.route('**/api/peakos/prices', async route => {
    if (route.request().method() === 'PUT' && failNext) {
      failNext = false;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '단가 저장 테스트 실패' }) });
      return;
    }
    await route.fallback();
  });

  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  // 재무 메뉴가 접혀 있을 수 있어 권한 검증이 끝난 실제 메뉴 버튼을 직접 연다.
  await page.evaluate(() => (document.querySelector('.nav-item[data-view="final-settlement"]') as HTMLElement)?.click());
  await page.locator('[data-price-table]').click();
  await page.locator('#priceSearch').fill('자동완성 슬롯');
  const row = page.locator('.price-table tbody tr').filter({ hasText: '슬롯' }).first();
  await expect(row).toContainText('15,000');
  await row.locator('[data-price-edit-open]').click();
  await page.locator('[data-price-edit="unit"]').fill('99999');
  await page.locator('[data-price-edit-save]').click();
  await expect(page.locator('.toast')).toContainText('단가를 저장하지 못했습니다. 단가 저장 테스트 실패');
  await expect(page.locator('.toast')).not.toContainText('서버에 저장했습니다');
  await expect(page.locator('.price-table tbody tr').filter({ hasText: '슬롯' }).first()).toContainText('15,000');
});

test('수정한 기본 단가는 새로고침 뒤에도 되돌리기 상태를 복원한다', async ({ page }) => {
  await installFirebaseStub(page);
  await installPeakosStub(page, {
    name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀',
  });

  const openPrices = async () => {
    await page.evaluate(() => (document.querySelector('.nav-item[data-view="final-settlement"]') as HTMLElement)?.click());
    await page.locator('[data-price-table]').click();
    await page.locator('#priceSearch').fill('자동완성 슬롯');
  };

  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  await openPrices();
  let row = page.locator('.price-table tbody tr').filter({ hasText: '슬롯' }).first();
  await row.locator('[data-price-edit-open]').click();
  await page.locator('[data-price-edit="unit"]').fill('99999');
  await page.locator('[data-price-edit-save]').click();
  await expect(page.locator('.toast')).toContainText('단가를 서버에 저장했습니다.');

  await page.reload();
  await expect(page.locator('#authGate')).toBeHidden();
  await openPrices();
  row = page.locator('.price-table tbody tr').filter({ hasText: '슬롯' }).first();
  await expect(row).toContainText('99,999');
  await expect(row.locator('[data-price-edit-reset]')).toHaveCount(1);
  await row.locator('[data-price-edit-reset]').click();
  row = page.locator('.price-table tbody tr').filter({ hasText: '슬롯' }).first();
  await expect(row).toContainText('15,000');
  await expect(row.locator('[data-price-edit-reset]')).toHaveCount(0);
});

test('추가 상품은 기본단가 되돌리기가 아니라 서버에서 실제 삭제한다', async ({ page }) => {
  await installFirebaseStub(page);
  const store = await installPeakosStub(page, {
    name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀',
  });
  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  await page.evaluate(() => (document.querySelector('.nav-item[data-view="final-settlement"]') as HTMLElement)?.click());
  await page.locator('[data-price-table]').click();
  await page.locator('[data-price-add]').click();
  await page.locator('#newMajor').fill('블로그');
  await page.locator('#newMiddle').fill('서버삭제테스트');
  await page.locator('#newMinor').fill('추가상품');
  await page.locator('#newCost').fill('8000');
  await page.locator('#newUnit').fill('9000');
  await page.locator('[data-price-add-save]').click();
  await expect(page.locator('.toast')).toContainText('서버 단가표에 추가했습니다.');

  await page.locator('#priceSearch').fill('서버삭제테스트');
  const row = page.locator('.price-table tbody tr').filter({ hasText: '추가상품' }).first();
  await expect(row.locator('[data-price-edit-reset]')).toHaveText('삭제');
  await row.locator('[data-price-edit-reset]').click();
  await expect(page.locator('.toast')).toContainText('서버 단가표에서 삭제했습니다.');
  await expect(page.locator('.price-table tbody')).toContainText('찾는 상품이 없습니다.');
  expect(store.prices.some((item: any) => item.key === '블로그|서버삭제테스트|추가상품')).toBe(false);
});
