import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

// 아이디어·개발수정요청은 여러 사람이 같이 쓴다. 접속할 때 한 번만 읽으면
// 남이 올린 글이 새로고침 전까지 보이지 않는다.
const REQ = (id: string, title: string) => ({
  id, productName: '리뷰스페이스', title, content: '', status: 'requested', priority: 'normal',
  managerNote: '', attachments: [], version: 1, createdAt: '2026-08-20T01:00:00.000Z',
  requester: { uid: 'e2e-test-user', name: '김대호' }, assignee: null, comments: [],
  capabilities: { edit: true, remove: true, triage: false, reopen: false, comment: true },
});

test('탭을 다시 열면 남이 올린 요청도 새로고침 없이 보인다', async ({ page }) => {
  let listCalls = 0;
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/peakos/ideas**', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ideas: [], statuses: [], canManage: false }) }));
  await page.route('**/peakos/service-requests**', route => {
    listCalls += 1;
    // 두 번째 조회부터 남이 올린 요청이 하나 더 있다.
    const requests = listCalls > 1
      ? [REQ('r1', '내 요청'), REQ('r2', '남이 방금 올린 요청')]
      : [REQ('r1', '내 요청')];
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ requests, statuses: [], priorities: [], assignees: [], canManage: false }) });
  });
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();

  await page.locator('.nav-item[data-view="requests"]').click();
  await expect(page.locator('.request-table tbody tr')).toHaveCount(2);
  await expect(page.locator('.request-table')).toContainText('남이 방금 올린 요청');

  // 다른 탭에 갔다 돌아와도 다시 읽는다.
  await page.locator('.nav-item[data-view="ideas"]').click();
  await page.locator('.nav-item[data-view="requests"]').click();
  await expect.poll(() => listCalls).toBeGreaterThan(2);
});

test('새 버전이 올라오면 화면이 먼저 알려 준다', async ({ page }) => {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/business-os-preview.html');
  await page.waitForTimeout(500);

  // 배포가 일어난 상황을 재현한다: 문서가 다른 버전을 가리킨다.
  await page.route('**/business-os-preview.html?_=*', route => route.fulfill({
    status: 200, contentType: 'text/html',
    body: '<script src="./business-os-preview.js?v=20991231-newer"></script>',
  }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  const notice = page.locator('#deployNotice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('새 버전이 올라왔습니다');
  await expect(notice.locator('[data-deploy-reload]')).toBeVisible();
});
