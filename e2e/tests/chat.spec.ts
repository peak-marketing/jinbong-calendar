import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub, dismissReminder } from './helpers';

const ROOMS = [
  { id: 'c1', name: '리뷰스페이스 환불 건', memberCount: 3, unread: 2,
    lastMessage: { body: '오후에 봅시다', name: '이종혁', attachments: 0 },
    createdBy: { uid: 'e2e-test-user', name: '김대호' } },
  { id: 'c2', name: '개발 협의', memberCount: 2, unread: 0,
    lastMessage: null, createdBy: { uid: 'j', name: '이종혁' } },
];
const THREAD = {
  room: { id: 'c1', name: '리뷰스페이스 환불 건' },
  members: [{ uid: 'e2e-test-user', name: '김대호' }, { uid: 'j', name: '이종혁' }],
  messages: [
    { id: 'm1', body: '환불 버튼 건 얘기 좀 하시죠', attachments: [],
      author: { uid: 'e2e-test-user', name: '김대호' }, mine: true, createdAt: '2026-08-20T01:00:00.000Z' },
    { id: 'm2', body: '오후에 봅시다', attachments: [],
      author: { uid: 'j', name: '이종혁' }, mine: false, createdAt: '2026-08-20T02:00:00.000Z' },
  ],
};

async function open(page, { onWrite = null } = {}) {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  // 기본 스텁의 catch-all 이 나중에 등록되면 앞선 라우트를 덮는다. 여기서 건다.
  await page.route('**/users/all-approved', r => r.fulfill({ status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{ uid: 'e2e-test-user', name: '김대호' }, { uid: 'j', name: '이종혁' }]) }));
  await page.route('**/peakos/chat/rooms/*/messages', async route => {
    if (route.request().method() === 'POST') {
      onWrite?.(route.request().url(), route.request().postDataJSON());
      return route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify({ message: THREAD.messages[0] }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(THREAD) });
  });
  await page.route('**/peakos/chat/rooms/*/read', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
  await page.route('**/peakos/chat/rooms', async route => {
    if (route.request().method() === 'POST') {
      onWrite?.(route.request().url(), route.request().postDataJSON());
      return route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify({ room: { id: 'c9', name: '새 방', memberCount: 2, unread: 0 } }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ rooms: ROOMS, unreadTotal: 2 }) });
  });
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto('/business-os-preview.html');
  // 로그인 게이트가 걷히기 전에 누르면 그 화면이 클릭을 다 먹는다.
  await expect(page.locator('.auth-gate')).toBeHidden();
  await dismissReminder(page);
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
}

test('채팅 탭이 다시 보이고 안 읽은 수가 메뉴에 뜬다', async ({ page }) => {
  await open(page);
  const nav = page.locator('.nav-item[data-view="chat"]');
  await expect(nav).toBeVisible();
  await expect(nav.locator('.nav-badge')).toHaveText('2');
});

test('방을 고르면 대화가 열리고 내 말과 남의 말이 구분된다', async ({ page }) => {
  await open(page);
  await page.locator('.nav-item[data-view="chat"]').click();
  await expect(page.locator('.peak-chat-room')).toHaveCount(2);
  await expect(page.locator('.peak-chat-room').first()).toContainText('리뷰스페이스 환불 건');
  await expect(page.locator('.peak-chat-room').first().locator('em')).toHaveText('2');

  await page.locator('[data-chat-open="c1"]').click();
  await expect(page.locator('.peak-chat-log')).toBeVisible();
  await expect(page.locator('.peak-chat-message')).toHaveCount(2);
  await expect(page.locator('.peak-chat-message').first()).toHaveClass(/is-mine/);
  await expect(page.locator('.peak-chat-message').nth(1)).not.toHaveClass(/is-mine/);
  await expect(page.locator('.peak-chat-thread-head')).toContainText('김대호, 이종혁');
});

test('Enter로 보내고, 빈 메시지는 보내지 않는다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onWrite: (url, body) => { sent = { url, body }; } });
  await page.locator('.nav-item[data-view="chat"]').click();
  await page.locator('[data-chat-open="c1"]').click();
  const box = page.locator('.peak-chat-compose textarea');

  // 빈 채로 Enter는 아무 일도 없어야 한다.
  await box.click();
  await box.press('Enter');
  await page.waitForTimeout(300);
  expect(sent).toBeNull();

  await box.fill('오늘 오후 3시 어떠세요');
  await box.press('Enter');
  await expect.poll(() => sent).not.toBeNull();
  expect(sent.url).toContain('/chat/rooms/c1/messages');
  expect(sent.body).toEqual({ body: '오늘 오후 3시 어떠세요', attachments: [] });
});

test('새 대화를 만들 때 참여자를 고른다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onWrite: (url, body) => { sent = { url, body }; } });
  await page.locator('.nav-item[data-view="chat"]').click();
  await page.locator('[data-chat-create]').click();

  const form = page.locator('#peakChatRoomForm');
  await expect(form).toBeVisible();
  await form.locator('[name="name"]').fill('단가 협의');
  await form.locator('.idea-viewer-option input').first().check();
  await form.locator('button[type="submit"]').click();

  await expect.poll(() => sent).not.toBeNull();
  expect(sent.body.name).toBe('단가 협의');
  expect(sent.body.memberUids).toEqual(['j']);
});
