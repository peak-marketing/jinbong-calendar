import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const MINE = {
  id: 'r1', productName: '리뷰스페이스', title: '환불 버튼이 안 눌립니다',
  content: '거래처환불 화면에서', status: 'requested', priority: 'high', managerNote: '',
  attachments: [], version: 1, createdAt: '2026-08-20T01:00:00.000Z',
  requester: { uid: 'e2e-test-user', name: '김대호' }, assignee: null,
  capabilities: { edit: true, remove: true, triage: false },
};
const TRIAGED = {
  id: 'r2', productName: '리뷰스페이스', title: '이미 처리 중인 건',
  content: '', status: 'working', priority: 'normal', managerNote: '확인 중',
  attachments: [], version: 3, createdAt: '2026-08-18T01:00:00.000Z',
  requester: { uid: 'e2e-test-user', name: '김대호' },
  assignee: { uid: 'jonghyuk', name: '이종혁' },
  capabilities: { edit: false, remove: false, triage: false },
};

async function open(page, { canManage = false, onWrite = null } = {}) {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/peakos/ideas**', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ideas: [], statuses: [], canManage: false }) }));
  await page.route('**/peakos/service-requests**', async route => {
    const method = route.request().method();
    if (method !== 'GET') {
      onWrite?.(method, route.request().url(), route.request().postDataJSON());
      return route.fulfill({ status: method === 'POST' ? 201 : 200, contentType: 'application/json',
        body: JSON.stringify({ request: MINE, ok: true }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({
        requests: [MINE, { ...TRIAGED, capabilities: { edit: canManage, remove: canManage, triage: canManage } }],
        statuses: ['requested', 'reviewing', 'working', 'done', 'rejected'],
        priorities: ['urgent', 'high', 'normal', 'low'],
        assignees: [{ uid: 'jonghyuk', name: '이종혁' }, { uid: 'dongwoo', name: '김동우' }],
        canManage,
      }) });
  });
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="requests"]').click();
  await expect(page.locator('#requestForm')).toBeVisible();
}

test('전 직원이 개발수정요청을 올릴 수 있고 받는 사람을 고른다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onWrite: (_m, _u, body) => { sent = body; } });
  const form = page.locator('#requestForm');
  await form.locator('[name="title"]').fill('로그인이 안 됩니다');
  await form.locator('[name="productName"]').fill('리뷰스페이스');
  await form.locator('[name="priority"]').selectOption('urgent');
  await form.locator('[name="content"]').fill('어제부터 로그인 화면에서 멈춥니다');
  await form.locator('[name="assigneeUid"]').selectOption('jonghyuk');
  await form.locator('button[type="submit"]').click();

  await expect.poll(() => sent).not.toBeNull();
  expect(sent).toEqual({
    title: '로그인이 안 됩니다', productName: '리뷰스페이스',
    content: '어제부터 로그인 화면에서 멈춥니다', priority: 'urgent',
    assigneeUid: 'jonghyuk', attachments: [],
  });
});

test('받는 사람을 비우면 미지정으로 나간다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onWrite: (_m, _u, body) => { sent = body; } });
  await page.locator('#requestForm [name="title"]').fill('나중에 정할게요');
  await page.locator('#requestForm button[type="submit"]').click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent.assigneeUid).toBe('');
});

test('일반 사용자에게는 처리 버튼이 없고, 처리 시작된 건은 손댈 수 없다', async ({ page }) => {
  await open(page, { canManage: false });
  const rows = page.locator('.ledger-table tbody tr');
  await expect(rows).toHaveCount(2);
  // 아직 요청 상태인 내 건은 고치고 지울 수 있다.
  await expect(rows.nth(0).locator('[data-request-edit]')).toBeVisible();
  await expect(rows.nth(0).locator('[data-request-triage]')).toHaveCount(0);
  // 이미 처리 중인 건은 버튼이 아예 없다.
  await expect(rows.nth(1).locator('[data-request-edit]')).toHaveCount(0);
  await expect(rows.nth(1).locator('[data-request-delete]')).toHaveCount(0);
});

test('개발 담당자는 상태와 받는 사람을 바꾼다', async ({ page }) => {
  let sent: any = null;
  await open(page, { canManage: true, onWrite: (_m, _u, body) => { sent = body; } });
  await page.locator('.ledger-table tbody tr').nth(1).locator('[data-request-triage]').click();

  const form = page.locator('#requestEditForm');
  await expect(form).toBeVisible();
  await form.locator('[name="status"]').selectOption('done');
  await form.locator('[name="assigneeUid"]').selectOption('dongwoo');
  await form.locator('[name="managerNote"]').fill('배포 완료');
  await form.locator('button[type="submit"]').click();

  await expect.poll(() => sent).not.toBeNull();
  expect(sent.status).toBe('done');
  expect(sent.assigneeUid).toBe('dongwoo');
  expect(sent.managerNote).toBe('배포 완료');
  expect(sent.expectedVersion).toBe(3);
});

test('요청자에게는 상태·담당 칸이 보이지 않는다', async ({ page }) => {
  await open(page, { canManage: false });
  await page.locator('.ledger-table tbody tr').nth(0).locator('[data-request-edit]').click();
  const form = page.locator('#requestEditForm');
  await expect(form).toBeVisible();
  // 상태와 담당은 개발 담당자 몫이다.
  await expect(form.locator('[name="status"]')).toHaveCount(0);
  await expect(form.locator('[name="assigneeUid"]')).toHaveCount(0);
  await expect(form.locator('[name="managerNote"]')).toHaveCount(0);
});
