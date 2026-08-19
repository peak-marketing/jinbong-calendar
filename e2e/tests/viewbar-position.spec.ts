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
