import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';
const dayKey = (offset: number) => {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};
test('지난 미완료 할 일이 오늘 목록으로 넘어온다', async ({ page }) => {
  let carryFlag = '';
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/peakos/todos?**', async route => {
    const url = new URL(route.request().url());
    carryFlag = url.searchParams.get('carryOver') || '';
    const date = url.searchParams.get('date') || '';
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      readOnly: false, capabilities: { create: true, edit: true, reorder: true }, date,
      items: [
        { id: 'old', title: '어제 못 끝낸 일', date: dayKey(-1), startTime: '', endTime: '', category: '', memo: '', done: false, sortOrder: 10, version: 1 },
        { id: 'new', title: '오늘 할 일', date: dayKey(0), startTime: '', endTime: '', category: '', memo: '', done: false, sortOrder: 20, version: 1 },
      ],
    }) });
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="todo"]').click();
  await page.locator('[data-todo-progress]').waitFor();
  expect(carryFlag).toBe('1');
  // 상단 제목 바는 사라지고, 날짜 조회는 투두리스트 헤더로 옮겼다.
  await expect(page.locator('.todo-dashboard-toolbar')).toHaveCount(0);
  await expect(page.locator('[data-todo-date-prev]')).toHaveCount(0);
  await expect(page.locator('[data-todo-date-input]')).toBeVisible();
  // 어제 일은 이월 표시와 함께 같은 목록에 있다.
  const carried = page.locator('[data-personal-todo-id="old"]');
  await expect(carried).toContainText('어제 못 끝낸 일');
  await expect(carried.locator('.todo-dashboard-task-carry')).toBeVisible();
  await expect(page.locator('[data-personal-todo-id="new"] .todo-dashboard-task-carry')).toHaveCount(0);
  console.log('PROBE carryOver=' + carryFlag);
});
