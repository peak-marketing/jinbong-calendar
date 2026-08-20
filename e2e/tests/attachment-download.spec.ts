import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

// 올린 파일을 나중에 못 받는 문제가 있었다. 서버는 파일을 잘 내주지만
// 링크에 download 속성이 없어서 브라우저가 미리보기만 열거나, 저장해도
// "1776302453943_zryhg43xat.jpg" 같은 서버 파일명으로 떨어졌다.
const IDEAS = [{
  id: 'i1', title: '자료 첨부', category: '', summary: '', detail: '',
  status: 'open', visibility: 'private', version: 1, createdAt: '2026-08-20T01:00:00.000Z',
  author: { uid: 'e2e-test-user', name: '김대호' },
  attachments: [{ url: '/uploads/1776302453943_zryhg43xat.jpg', name: '자금계획 최종.pdf', size: 20480 }],
  viewers: [], capabilities: { edit: true, remove: true, setStatus: false, setViewers: true },
}];

test('첨부는 원래 이름 그대로 내려받을 수 있다', async ({ page }) => {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/peakos/ideas**', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ideas: IDEAS, statuses: [], canManage: false }) }));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="ideas"]').click();

  const box = page.locator('.idea-attachments');
  await expect(box).toBeVisible();

  // 이름을 누르면 미리보기가 열린다.
  const preview = box.locator('a').first();
  await expect(preview).toHaveText('자금계획 최종.pdf');
  await expect(preview).toHaveAttribute('target', '_blank');

  // ↓ 는 서버 파일명이 아니라 올릴 때의 이름으로 저장한다.
  const download = box.locator('a.attach-download');
  await expect(download).toHaveAttribute('download', '자금계획 최종.pdf');
  await expect(download).toHaveAttribute('href', '/uploads/1776302453943_zryhg43xat.jpg');
});

test('실제로 눌렀을 때 그 이름으로 파일이 떨어진다', async ({ page }) => {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/peakos/ideas**', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ideas: IDEAS, statuses: [], canManage: false }) }));
  // 서버가 파일을 내주는 상황을 그대로 재현한다.
  await page.route('**/uploads/1776302453943_zryhg43xat.jpg', r => r.fulfill({
    status: 200, contentType: 'application/pdf', body: Buffer.from('%PDF-1.4 probe') }));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="ideas"]').click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.idea-attachments a.attach-download').click(),
  ]);
  expect(download.suggestedFilename()).toBe('자금계획 최종.pdf');
});
