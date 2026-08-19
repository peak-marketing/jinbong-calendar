import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';
const dayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
test('대시보드 카드는 미완료를 빨강, 완료를 검정으로 나눠 보여준다', async ({ page }) => {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/peakos/todos?**', async r => {
    const date = new URL(r.request().url()).searchParams.get('date') || '';
    await r.fulfill({ status:200, contentType:'application/json', body: JSON.stringify({ readOnly:false,
      capabilities:{ create:true, edit:true }, date, items:[
        { id:'a', title:'끝난 일', date: dayKey(), startTime:'', endTime:'', category:'', memo:'', done:true, sortOrder:10, version:1 },
        { id:'b', title:'남은 일', date: dayKey(), startTime:'', endTime:'', category:'', memo:'', done:false, sortOrder:20, version:1 },
        { id:'c', title:'남은 일2', date: dayKey(), startTime:'', endTime:'', category:'', memo:'', done:false, sortOrder:30, version:1 },
      ] }) });
  });
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="dashboard"]').click();
  const card = page.locator('.executive-metric-card.tasks');
  await expect(card).toContainText('TODAY');
  await expect(card.locator('.pending')).toHaveText('미완료 2건');
  await expect(card.locator('.done')).toHaveText('완료 1건');
  const colors = await card.locator('.executive-metric-split > b').evaluateAll(els => els.map(e => getComputedStyle(e as HTMLElement).color));
  console.log('PROBE ' + JSON.stringify(colors));
  expect(colors[0]).toBe('rgb(200, 71, 79)');
  expect(colors[1]).toBe('rgb(29, 43, 54)');
  await expect(page.locator('.executive-metric-card.projects')).toContainText('프로젝트');
});
