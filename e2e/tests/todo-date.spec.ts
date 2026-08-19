import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const dayKey = (offset: number) => {
  const now = new Date();
  const shifted = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
};

test('할 일 날짜는 오늘을 따라가되 직접 고른 날짜는 유지된다', async ({ page }) => {
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
  expect(seen.at(-1)).toBe(dayKey(0));

  // 직접 어제로 옮기면 그 선택을 유지해야 한다.
  await page.locator('[data-todo-date-prev]').click();
  await expect.poll(() => seen.at(-1)).toBe(dayKey(-1));
  await page.locator('.nav-item[data-view="dashboard"]').click();
  await openTodo();
  await expect(page.locator('[data-todo-date-today]')).toBeEnabled();

  // 오늘 버튼을 누르면 다시 오늘을 따라간다.
  await page.locator('[data-todo-date-today]').click();
  await expect.poll(() => seen.at(-1)).toBe(dayKey(0));
  await page.locator('.nav-item[data-view="dashboard"]').click();
  await openTodo();
  await expect(page.locator('[data-todo-date-today]')).toBeDisabled();
  console.log('PROBE ' + JSON.stringify(seen));
});
