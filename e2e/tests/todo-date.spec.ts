import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const todayKey = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

test('할 일 화면은 언제 열어도 한국시간 오늘 기준으로 조회한다', async ({ page }) => {
  const seen: string[] = [];
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/peakos/todos?**', async route => {
    const date = new URL(route.request().url()).searchParams.get('date') || '';
    seen.push(date);
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ readOnly: false, capabilities: { create: true, edit: true }, date, items: [] }) });
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();

  const openTodo = async () => {
    await page.locator('.nav-item[data-view="todo"]').click();
    await page.locator('[data-todo-progress]').waitFor();
  };

  await openTodo();
  expect(seen.at(-1)).toBe(todayKey());

  // 다른 탭을 다녀와도 오늘 기준을 유지한다. (오래 열어둔 탭이 어제에 머물던 문제)
  await page.locator('.nav-item[data-view="dashboard"]').click();
  await openTodo();
  expect(seen.at(-1)).toBe(todayKey());
  await expect(page.locator('[data-todo-date-input]')).toHaveValue(todayKey());

  // 날짜를 직접 골라 지난 날짜도 조회할 수 있다.
  await page.locator('[data-todo-date-input]').fill('2026-08-01');
  await expect.poll(() => seen.at(-1)).toBe('2026-08-01');
  await page.locator('[data-todo-date-today]').click();
  await expect.poll(() => seen.at(-1)).toBe(todayKey());
  console.log('PROBE ' + JSON.stringify(seen));
});
