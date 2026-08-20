import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const REQ = (id: string, title: string, status = 'requested') => ({
  id, productName: '리뷰스페이스', title, content: '설명', status, priority: 'normal',
  managerNote: '', attachments: [], version: 1, createdAt: '2026-08-20T01:00:00.000Z',
  requester: { uid: 'someone', name: '손명아' }, assignee: null, comments: [], unreadCount: 0,
  capabilities: { edit: false, remove: false, triage: true, reopen: false, comment: true },
});

async function boot(page, { requests = [], canManage = false, unreadTotal = 0 } = {}) {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '이종혁', group_name: '본사 개발팀' });
  await page.route('**/peakos/ideas**', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ideas: [], statuses: [], canManage: false }) }));
  await page.route('**/peakos/service-requests**', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ requests, statuses: [], priorities: [],
      assignees: [{ uid: 'j', name: '이종혁' }], canManage, unreadTotal }) }));
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto('/business-os-preview.html');
  await page.waitForTimeout(900);
}

test('개발 담당자에게 새 수정요청이 팝업으로 뜬다', async ({ page }) => {
  await boot(page, { canManage: true, requests: [REQ('r1', '환불 버튼 오류'), REQ('r2', '로그인 지연')] });
  const popup = page.locator('.reminder-popup');
  await expect(popup).toBeVisible();
  await expect(popup).toContainText('새로운 수정요청이 2건 있습니다');
  await expect(popup).toContainText('환불 버튼 오류');

  // 보러 가기를 누르면 그 탭으로 옮겨 준다.
  await popup.locator('[data-reminder-go="requests"]').click();
  await expect(page.locator('#moduleView .request-table')).toBeVisible();
});

test('답이 온 요청도 함께 알려 준다', async ({ page }) => {
  await boot(page, { canManage: false, unreadTotal: 3, requests: [REQ('r1', '내 요청', 'working')] });
  await expect(page.locator('.reminder-popup')).toContainText('새 글이 3건');
});

test('알릴 것이 없으면 뜨지 않는다', async ({ page }) => {
  await boot(page, { canManage: true, requests: [REQ('r1', '이미 처리 중', 'working')] });
  await expect(page.locator('#reminderPanel')).toHaveCount(0);
});

test('30분 뒤 다시 알림을 누르면 지금은 닫히고 나중에 다시 뜬다', async ({ page }) => {
  await boot(page, { canManage: true, requests: [REQ('r1', '환불 버튼 오류')] });
  await page.locator('[data-reminder-snooze]').click();
  await expect(page.locator('#reminderPanel')).toHaveCount(0);

  // 미뤄 둔 시각이 남아 다음 확인 때 건너뛴다.
  const until = await page.evaluate(() => Number(localStorage.getItem('peakos-reminder-snoozed-until') || 0));
  expect(until).toBeGreaterThan(Date.now());
  expect(until).toBeLessThan(Date.now() + 31 * 60 * 1000);
});

test('오늘까지인 업무와 마감이 지난 업무를 나눠서 알려 준다', async ({ page }) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const task = (id: string, title: string, dueDate: string | null, status = 'todo') => ({
    id, title, description: '', status, dueDate, version: 1, attachments: [],
    assignedBy: { uid: 'l', name: '전현우' }, reviewer: { uid: 'l', name: '전현우' },
    project: { id: 'p1', name: '매출', status: 'active' },
    medium: { id: 'm1', name: '중분류' }, small: { id: 's1', name: '소분류' },
  });
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/peakos/ideas**', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ideas: [], statuses: [], canManage: false }) }));
  await page.route('**/peakos/service-requests**', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ requests: [], statuses: [], priorities: [], assignees: [], canManage: false, unreadTotal: 0 }) }));
  await page.route('**/new-projects/my-tasks', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ tasks: [
      task('t1', '오늘까지 단가 확정', today),
      task('t2', '지난주에 끝냈어야 할 일', '2026-08-01'),
      // 완료된 건과 기한 없는 건은 세지 않는다.
      task('t3', '이미 끝낸 일', today, 'done'),
      task('t4', '기한 없는 일', null),
    ] }) }));
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto('/business-os-preview.html');
  await page.waitForTimeout(1200);

  const popup = page.locator('.reminder-popup');
  await expect(popup).toBeVisible();
  await expect(popup).toContainText('마감일이 지난 업무가 1건');
  await expect(popup).toContainText('지난주에 끝냈어야 할 일');
  await expect(popup).toContainText('오늘까지인 업무가 1건');
  await expect(popup).toContainText('오늘까지 단가 확정');
  // 완료된 건은 끼지 않는다.
  await expect(popup).not.toContainText('이미 끝낸 일');
});
