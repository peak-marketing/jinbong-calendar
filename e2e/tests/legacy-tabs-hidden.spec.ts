import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';
test('기존 파라곤 탭은 메뉴에서 보이지 않는다', async ({ page }) => {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  const visible = await page.locator('.app-sidebar .nav-item[data-view]:not([hidden])')
    .evaluateAll(els => els.map(e => (e as HTMLElement).dataset.view));
  console.log('PROBE ' + JSON.stringify(visible));
  expect(visible).not.toContain('review');
  expect(visible).not.toContain('chat');
  expect(visible).toContain('todo');
  expect(visible).toContain('new-projects');
  expect(visible).toContain('my-work');
});
