import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';
const P = { id:'p1', name:'매출', description:'', status:'active', version:1, lead:{uid:'l',name:'김대호'},
  members:[{uid:'l',name:'김대호',active:true}],
  mediumCategories:[{ id:'m1', name:'중분류', manager:{uid:'l',name:'김대호'}, smallCategories:[{ id:'s1', name:'소분류', tasks:[] }] }],
  capabilities:{ manageProject:true } };
test('보기 전환 토글은 어느 화면에서도 같은 자리에 있다', async ({ page }) => {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/new-projects', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{viewPortfolio:true,createProject:true}, projects:[P] }) }));
  await page.route('**/new-projects/p1', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{manageProject:true}, project: P }) }));
  await page.setViewportSize({ width: 1500, height: 700 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="new-projects"]').click();
  await page.locator('[data-structured-project-open="p1"]').click();
  const navX = async () => await page.evaluate(() =>
    Math.round((document.querySelector('.structured-task-viewbar > nav') as HTMLElement).getBoundingClientRect().x));
  const xs: Record<string, number> = {};
  for (const view of ['split', 'hierarchy', 'board']) {
    await page.locator(`[data-structured-task-view="${view}"]`).click();
    await page.waitForTimeout(150);
    xs[view] = await navX();
  }
  console.log('PROBE ' + JSON.stringify(xs));
  expect(new Set(Object.values(xs)).size).toBe(1);
});

test('대분류 머리줄은 따로 한 줄을 쓰지 않고 업무 보기 줄에 들어간다', async ({ page }) => {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/new-projects', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{viewPortfolio:true,createProject:true}, projects:[P] }) }));
  await page.route('**/new-projects/p1', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{manageProject:true}, project: P }) }));
  await page.setViewportSize({ width: 1500, height: 700 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="new-projects"]').click();
  await page.locator('[data-structured-project-open="p1"]').click();
  const bar = page.locator('.structured-task-viewbar');
  await bar.waitFor();

  // 히어로 위의 독립된 머리줄은 사라졌고, 그 항목들이 업무 보기 줄 안에 있다.
  await expect(page.locator('.structured-detail-nav')).toHaveCount(0);
  await expect(bar.locator('[data-structured-project-back]')).toBeVisible();
  await expect(bar.locator('[data-structured-project-edit]')).toBeVisible();
  await expect(bar.locator('[data-structured-medium-create]')).toBeVisible();

  // 히어로가 화면 맨 위로 올라와야 한 줄을 실제로 돌려받은 것이다.
  const [heroY, barY] = await page.evaluate(() => [
    (document.querySelector('.structured-detail-hero') as HTMLElement).getBoundingClientRect().top,
    (document.querySelector('.structured-task-viewbar') as HTMLElement).getBoundingClientRect().top,
  ]);
  expect(heroY).toBeLessThan(barY);

  // 돌아가기는 탭 왼쪽, 설정·추가는 탭 오른쪽 끝에 선다.
  const box = async (sel: string) => (await bar.locator(sel).boundingBox())!;
  const back = await box('[data-structured-project-back]');
  const tabs = await box('nav');
  const add = await box('[data-structured-medium-create]');
  expect(back.x + back.width).toBeLessThanOrEqual(tabs.x + 1);
  expect(add.x).toBeGreaterThan(tabs.x + tabs.width);
  // 줄바꿈 없이 한 줄이어야 한다.
  expect(Math.abs(back.y - add.y)).toBeLessThan(back.height + add.height);
});
