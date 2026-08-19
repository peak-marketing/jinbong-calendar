import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

test('할 일을 완료하면 완료 수와 진행률이 올라간다', async ({ page }) => {
  const todos = [
    { id: 'a', title: '첫 일', date: '', startTime: '', endTime: '', category: '', memo: '', done: false, sortOrder: 10, version: 1, capabilities: { edit: true, delete: true } },
    { id: 'b', title: '둘째 일', date: '', startTime: '', endTime: '', category: '', memo: '', done: false, sortOrder: 20, version: 1, capabilities: { edit: true, delete: true } },
  ];
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/peakos/todos?**', async route => {
    const url = new URL(route.request().url());
    const date = url.searchParams.get('date') || '';
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ readOnly: false, capabilities: { create: true, edit: true, delete: true, reorder: true }, date, items: todos.map(t => ({ ...t, date })) }) });
  });
  await page.route('**/peakos/todos/*', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    const id = route.request().url().split('/').pop() || '';
    const found = todos.find(t => t.id === id);
    if (found && body.done !== undefined) { found.done = body.done; found.version += 1; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, todo: found }) });
  });
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="todo"]').click();
  await page.locator('[data-peakos-todo-toggle]').first().waitFor();

  const read = async () => await page.evaluate(() => ({
    all: document.querySelector('[data-todo-stat="all"] strong')?.textContent,
    remaining: document.querySelector('[data-todo-stat="remaining"] strong')?.textContent,
    complete: document.querySelector('[data-todo-stat="complete"] strong')?.textContent,
    percent: document.querySelector('[data-todo-stat="complete"] small')?.textContent,
    bar: document.querySelector('[data-todo-progress] strong')?.textContent,
    barValue: document.querySelector('[data-todo-progress]')?.getAttribute('aria-valuenow'),
  }));
  console.log('PROBE 전 ' + JSON.stringify(await read()));
  await page.locator('[data-peakos-todo-toggle]').first().click();
  await page.waitForTimeout(800);
  const after = await read();
  console.log('PROBE 후 ' + JSON.stringify(after));
  expect(after.complete).toBe('1');
  expect(after.remaining).toBe('1');
});
