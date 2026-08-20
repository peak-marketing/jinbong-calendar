import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const IDEAS = [
  { id: 'i1', title: '리뷰 요청 폼을 카카오톡으로', category: '개발', summary: '요약',
    detail: '자세한 내용', status: 'open', version: 1, createdAt: '2026-08-12T01:00:00.000Z',
    author: { uid: 'e2e-test-user', name: '김대호' },
    capabilities: { edit: true, remove: true, setStatus: true } },
  { id: 'i2', title: '남이 올린 아이디어', category: '영업', summary: '', detail: '',
    status: 'adopted', version: 2, createdAt: '2026-08-10T01:00:00.000Z',
    author: { uid: 'other', name: '패션TV봉이' },
    capabilities: { edit: false, remove: false, setStatus: false } },
];

async function open(page, { onWrite = null } = {}) {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/peakos/ideas**', async route => {
    const method = route.request().method();
    if (method !== 'GET') {
      onWrite?.(method, route.request().url(), route.request().postDataJSON());
      return route.fulfill({ status: method === 'POST' ? 201 : 200, contentType: 'application/json',
        body: JSON.stringify({ idea: IDEAS[0], ok: true }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ideas: IDEAS, statuses: ['open','reviewing','adopted','dropped'], canManage: true }) });
  });
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="ideas"]').click();
  await expect(page.locator('#ideaForm')).toBeVisible();
}

test('아이디어 탭에서 바로 글을 올릴 수 있다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onWrite: (method, _url, body) => { sent = { method, body }; } });

  // 예전에는 읽기 전용이라 폼이 아예 없었다.
  const form = page.locator('#ideaForm');
  await form.locator('[name="title"]').fill('리뷰 요청 폼을 카카오톡으로 받기');
  await form.locator('[name="category"]').fill('개발');
  await form.locator('[name="summary"]').fill('한 문장 요약');
  await form.locator('[name="detail"]').fill('이렇게 하면 좋겠습니다');
  await form.locator('button[type="submit"]').click();

  await expect.poll(() => sent).not.toBeNull();
  expect(sent.method).toBe('POST');
  expect(sent.body).toEqual({
    title: '리뷰 요청 폼을 카카오톡으로 받기', category: '개발',
    summary: '한 문장 요약', detail: '이렇게 하면 좋겠습니다',
  });
});

test('파라곤 안내 문구가 사라지고 올라온 아이디어가 보인다', async ({ page }) => {
  await open(page);
  const view = page.locator('#moduleView');
  await expect(view).not.toContainText('파라곤에 쌓아 온');
  await expect(view).not.toContainText('기존 파라곤과 같은 자료입니다');
  await expect(view).not.toContainText('읽기 전용');

  await expect(view.locator('.idea-card')).toHaveCount(2);
  await expect(view.locator('.idea-card').first()).toContainText('리뷰 요청 폼을 카카오톡으로');
  await expect(view.locator('.idea-card').first().locator('.idea-status')).toHaveText('접수');
  await expect(view.locator('.idea-card').nth(1).locator('.idea-status')).toHaveText('채택');
});

test('내 글만 고치고 지울 수 있다', async ({ page }) => {
  await open(page);
  const cards = page.locator('.idea-card');
  await expect(cards.nth(0).locator('[data-idea-edit]')).toBeVisible();
  await expect(cards.nth(0).locator('[data-idea-delete]')).toBeVisible();
  // 남이 올린 글에는 수정·삭제 버튼이 아예 없다.
  await expect(cards.nth(1).locator('[data-idea-edit]')).toHaveCount(0);
  await expect(cards.nth(1).locator('[data-idea-delete]')).toHaveCount(0);
});

test('제목이 비면 보내지 않는다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onWrite: (method, _url, body) => { sent = { method, body }; } });
  await page.locator('#ideaForm [name="detail"]').fill('제목 없이 내용만');
  await page.locator('#ideaForm button[type="submit"]').click();
  await page.waitForTimeout(400);
  expect(sent).toBeNull();
});
