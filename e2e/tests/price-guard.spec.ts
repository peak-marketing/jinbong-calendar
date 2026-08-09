import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub, handlePeakos, createPeakosStore } from './helpers';

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
      if (p === '/users/me') payload = { uid: 'u', name, role: 'manager', approved: true, is_active: true, group_name: '본사 영업팀' };
      else if (p === '/chat-rooms/unread') payload = {};
      else if (p === '/projects') payload = { canManageAll: false, projects: [] };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    // 회사원가는 최종정산서 화면에서만 드러난다. 개인정산서는 누구든 영업자단가 기준.
    const view = seesCost ? 'final-settlement' : 'settlement';
    await page.evaluate(v => (document.querySelector(`.nav-item[data-view="${v}"]`) as HTMLElement)?.click(), view);
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
  await expect(page.locator('.nav-item[data-view="settlement"]')).toBeVisible();
  await page.evaluate(() => (document.querySelector('.nav-item[data-view="settlement"]') as HTMLElement)?.click());
  await expect(page.locator('#moduleView')).toBeVisible();
  await page.locator('[data-price-table]').click();
  await page.locator('#priceSearch').fill('최블 B');
  const row = page.locator('.price-table tbody tr').first();
  await expect(row).toContainText('19,000');
  await expect(row).not.toContainText('17,000');

  // 서버가 내려보낸 회사원가는 비어 있다
  expect(sentCost).toBeNull();
});
