import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const IDEAS = [
  { id: 'i1', title: '리뷰 요청 폼을 카카오톡으로', category: '개발', summary: '요약',
    detail: '자세한 내용', status: 'open', version: 1, createdAt: '2026-08-12T01:00:00.000Z',
    author: { uid: 'e2e-test-user', name: '김대호' },
    capabilities: { edit: true, remove: true, setStatus: true } },
  { id: 'i2', title: '남이 올린 아이디어', category: '영업', summary: '', detail: '',
    status: 'adopted', visibility: 'shared', attachments: [], viewers: [], version: 2, createdAt: '2026-08-10T01:00:00.000Z',
    author: { uid: 'other', name: '패션TV봉이' },
    capabilities: { edit: false, remove: false, setStatus: false } },
];

async function open(page, { onWrite = null } = {}) {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  // 기본 스텁에는 나 혼자라 고를 사람이 없다. 동료를 한 명 세운다.
  await page.route('**/users/all-approved', route => route.fulfill({ status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      { uid: 'e2e-test-user', name: '김대호', approved: true, is_active: true },
      { uid: 'sonmyeonga', name: '손명아', approved: true, is_active: true },
    ]) }));
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
  // 폼 위에 붙어 있던 안내 문구는 없앴다. 화면이 설명 없이도 읽혀야 한다.
  await expect(page.locator('#moduleView')).not.toContainText('누구나 올릴 수 있고');
  await expect(page.locator('.module-statusbar small')).toHaveCount(0);
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
    // 아무것도 안 고르면 개인이다.
    visibility: 'private', attachments: [], viewerUids: [],
  });
});

test('공개 범위를 고르지 않으면 개인으로 나간다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onWrite: (_m, _u, body) => { sent = body; } });
  const form = page.locator('#ideaForm');
  await expect(form.locator('[name="visibility"][value="private"]')).toBeChecked();
  await form.locator('[name="title"]').fill('기본값 확인');
  await form.locator('button[type="submit"]').click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent.visibility).toBe('private');
});

test('함께 볼 아이디어로 고르면 그대로 보낸다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onWrite: (_m, _u, body) => { sent = body; } });
  const form = page.locator('#ideaForm');
  await form.locator('[name="title"]').fill('같이 봅시다');
  await form.locator('[name="visibility"][value="shared"]').check();
  await form.locator('button[type="submit"]').click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent.visibility).toBe('shared');
});

test('카드마다 개인인지 함께 보는지 표시된다', async ({ page }) => {
  await open(page);
  const cards = page.locator('.idea-card');
  await expect(cards.nth(0).locator('.idea-visibility')).toHaveText('개인');
  await expect(cards.nth(1).locator('.idea-visibility')).toHaveText('함께 보기');

  // 공개 범위로 걸러 볼 수 있다.
  await page.locator('[data-idea-visibility]').selectOption('shared');
  await expect(page.locator('.idea-card')).toHaveCount(1);
  await expect(page.locator('.idea-card').first()).toContainText('남이 올린 아이디어');
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

test('지정 구성원을 고르면 명단이 함께 나가고, 비우면 막는다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onWrite: (_m, _u, body) => { sent = body; } });
  const form = page.locator('#ideaForm');
  await form.locator('[name="title"]').fill('재무만 봅니다');

  // 개인·함께 보기일 때는 명단 칸이 아예 없다.
  await expect(form.locator('[data-idea-viewer-field]')).toBeHidden();
  await form.locator('[name="visibility"][value="members"]').check();
  await expect(form.locator('[data-idea-viewer-field]')).toBeVisible();

  // 아무도 안 고르고 올리면 막는다.
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('.toast, [data-toast]').first()).toContainText('구성원을 한 명 이상');
  expect(sent).toBeNull();

  const first = form.locator('.idea-viewer-option input').first();
  await first.check();
  const uid = await first.inputValue();
  await form.locator('button[type="submit"]').click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent.visibility).toBe('members');
  expect(sent.viewerUids).toEqual([uid]);
});

test('함께 보기로 되돌리면 명단은 딸려 가지 않는다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onWrite: (_m, _u, body) => { sent = body; } });
  const form = page.locator('#ideaForm');
  await form.locator('[name="title"]').fill('되돌리기');
  await form.locator('[name="visibility"][value="members"]').check();
  await form.locator('.idea-viewer-option input').first().check();
  await form.locator('[name="visibility"][value="shared"]').check();
  await expect(form.locator('[data-idea-viewer-field]')).toBeHidden();
  await form.locator('button[type="submit"]').click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent.visibility).toBe('shared');
  expect(sent.viewerUids).toEqual([]);
});
