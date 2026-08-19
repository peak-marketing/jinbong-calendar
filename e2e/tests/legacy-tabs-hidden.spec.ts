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
  // 주요 메뉴는 대시보드 → 캘린더 → 투두리스트 → 프로젝트 → 내 업무 → 아이디어 → 개발 수정요청 순서.
  expect(visible.slice(0, 7)).toEqual(['dashboard', 'calendar', 'todo', 'new-projects', 'my-work', 'ideas', 'requests']);
  const label = async (view: string) => (await page.locator(`.app-sidebar .nav-item[data-view="${view}"]`).innerText()).trim();
  expect(await label('todo')).toContain('투두리스트');
  expect(await label('new-projects')).toContain('프로젝트');
  expect(await label('requests')).toContain('개발 수정요청');
});
