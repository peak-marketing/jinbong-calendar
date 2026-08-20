import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub, dismissReminder } from './helpers';

const MINE = {
  id: 'r1', productName: '리뷰스페이스', title: '환불 버튼이 안 눌립니다',
  content: '거래처환불 화면에서', status: 'requested', priority: 'high', managerNote: '',
  attachments: [], version: 1, createdAt: '2026-08-20T01:00:00.000Z',
  requester: { uid: 'e2e-test-user', name: '김대호' }, assignee: null, comments: [], unreadCount: 0,
  capabilities: { edit: true, remove: true, triage: false, reopen: false, comment: true },
};
const TRIAGED = {
  id: 'r2', productName: '리뷰스페이스', title: '이미 처리 중인 건',
  content: '', status: 'working', priority: 'normal', managerNote: '확인 중',
  attachments: [], version: 3, createdAt: '2026-08-18T01:00:00.000Z',
  requester: { uid: 'e2e-test-user', name: '김대호' },
  assignee: { uid: 'jonghyuk', name: '이종혁' },
  comments: [
    { id: 'c1', body: '확인했습니다', fromStatus: 'requested', toStatus: 'reviewing',
      author: { uid: 'jonghyuk', name: '이종혁' }, createdAt: '2026-08-19T01:00:00.000Z' },
  ],
  capabilities: { edit: false, remove: false, triage: false, reopen: false, comment: true },
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
  // 리마인더 팝업이 먼저 뜨면 메뉴 클릭을 가로막는다. 닫고 시작한다.
  await dismissReminder(page);
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="requests"]').click();
  await dismissReminder(page);
  await expect(page.locator('#requestForm')).toBeVisible();
  // 데이터가 다 들어온 뒤에야 뜨는 경우가 있어 마지막으로 한 번 더 확인한다.
  await dismissReminder(page);
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

// 아이디어와 개발수정요청은 PEAK OS가 직접 들고 있다. 파라곤 표를 다시 읽기
// 시작하면 한쪽에서 고친 내용이 다른 쪽을 덮어써 조용히 어긋난다.
test('파라곤 쪽 데이터는 더 이상 읽지 않는다', async ({ page }) => {
  const legacy: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (/^\/api\/(ideas|service-requests)(\/|\?|$)/.test(url.pathname)) legacy.push(url.pathname);
  });
  await open(page);
  await page.locator('.nav-item[data-view="ideas"]').click();
  await page.waitForTimeout(400);
  await page.locator('.nav-item[data-view="requests"]').click();
  await page.waitForTimeout(400);

  expect(legacy, `파라곤 경로를 아직 부릅니다: ${legacy.join(', ')}`).toEqual([]);
  // 화면에 파라곤 안내도 남아 있지 않아야 한다.
  await expect(page.locator('#moduleView')).not.toContainText('파라곤');
});

test('요청마다 대화가 오가고 상태 변화도 같은 줄기에 남는다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onWrite: (method, url, body) => { sent = { method, url, body }; } });
  await page.locator('.ledger-table tbody tr').nth(1).locator('[data-request-thread]').click();

  const thread = page.locator('.request-thread');
  await expect(thread).toBeVisible();
  // 담당자가 상태를 바꾸며 남긴 말이 흐름으로 보인다.
  await expect(thread.locator('.request-thread-item')).toHaveCount(1);
  await expect(thread.locator('.request-thread-move')).toHaveText('요청 → 확인완료');
  await expect(thread.locator('.request-thread-item p')).toHaveText('확인했습니다');

  await thread.locator('textarea').fill('저도 같은 증상 봤습니다');
  await thread.locator('button[type="submit"]').click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent.method).toBe('POST');
  expect(sent.url).toContain('/service-requests/r2/comments');
  expect(sent.body).toEqual({ body: '저도 같은 증상 봤습니다' });
});

test('완료된 내 요청은 이유를 적어야 다시 열 수 있다', async ({ page }) => {
  let sent: any = null;
  const DONE = { ...MINE, id: 'r3', status: 'done', comments: [],
    capabilities: { edit: false, remove: false, triage: false, reopen: true, comment: true } };
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/peakos/ideas**', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ideas: [], statuses: [], canManage: false }) }));
  await page.route('**/peakos/service-requests**', async route => {
    if (route.request().method() !== 'GET') {
      sent = { url: route.request().url(), body: route.request().postDataJSON() };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ requests: [DONE], statuses: [], priorities: [], assignees: [], canManage: false }) });
  });
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="requests"]').click();
  await page.locator('[data-request-thread]').click();

  // 이유 없이 되돌리면 담당자가 다시 물어봐야 한다.
  await page.locator('[data-request-reopen]').click();
  await expect(page.locator('.toast, [data-toast]').first()).toContainText('어떤 점이 아직 안 됐는지');
  expect(sent).toBeNull();

  await page.locator('.request-thread textarea').fill('환불 버튼은 됐는데 목록이 안 바뀝니다');
  await page.locator('[data-request-reopen]').click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent.url).toContain('/service-requests/r3/reopen');
  expect(sent.body).toEqual({ body: '환불 버튼은 됐는데 목록이 안 바뀝니다' });
});

// 공용 원장 표 스타일을 물려받아 머리는 왼쪽·칸은 오른쪽으로 갈렸고 제목만 또
// 왼쪽이었다. 열마다 기준이 다르면 표 전체가 어긋나 보인다.
test('표는 머리와 칸이 모두 같은 축에 선다', async ({ page }) => {
  await open(page, { canManage: true });
  await dismissReminder(page);
  const mismatched = await page.evaluate(() => {
    const table = document.querySelector('.request-table') as HTMLElement;
    const out: string[] = [];
    [...table.querySelectorAll('thead th')].forEach((head, index) => {
      const headAlign = getComputedStyle(head as HTMLElement).textAlign;
      const cell = table.querySelector(`tbody tr:first-child > *:nth-child(${index + 1})`) as HTMLElement;
      const cellAlign = getComputedStyle(cell).textAlign;
      const headX = Math.round(head.getBoundingClientRect().x);
      const cellX = Math.round(cell.getBoundingClientRect().x);
      if (headAlign !== 'center' || cellAlign !== 'center' || Math.abs(headX - cellX) > 1) {
        out.push(`${head.textContent!.trim() || '(빈칸)'}: 머리 ${headAlign}@${headX} · 칸 ${cellAlign}@${cellX}`);
      }
    });
    return out;
  });
  expect(mismatched, mismatched.join(' / ')).toEqual([]);
});

// 답이 와도 탭을 열어 한 줄씩 눌러 봐야 알 수 있으면 아무도 모른다.
test('답이 온 요청은 메뉴 배지와 줄에서 바로 티가 난다', async ({ page }) => {
  const UNREAD = { ...MINE, id: 'r9', title: '답이 온 요청', unreadCount: 2,
    comments: [
      { id: 'c1', body: '확인했습니다', fromStatus: '', toStatus: '',
        author: { uid: 'jonghyuk', name: '이종혁' }, createdAt: '2026-08-20T02:00:00.000Z' },
      { id: 'c2', body: '오늘 배포합니다', fromStatus: '', toStatus: '',
        author: { uid: 'jonghyuk', name: '이종혁' }, createdAt: '2026-08-20T03:00:00.000Z' },
    ] };
  let readCalled = '';
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/peakos/ideas**', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ideas: [], statuses: [], canManage: false }) }));
  await page.route('**/peakos/service-requests**', async route => {
    const url = route.request().url();
    if (route.request().method() === 'POST' && url.endsWith('/read')) {
      readCalled = url;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ requests: [UNREAD], statuses: [], priorities: [], assignees: [],
        canManage: false, unreadTotal: 2 }) });
  });
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto('/business-os-preview.html');
  await dismissReminder(page);
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="requests"]').click();
  await dismissReminder(page);

  // 메뉴에 숫자가 붙는다.
  const badge = page.locator('.nav-item[data-view="requests"] .nav-badge');
  await expect(badge).toHaveText('2');
  // 줄과 버튼에도 표시된다.
  await expect(page.locator('.request-table tbody tr').first()).toHaveClass(/has-unread/);
  await expect(page.locator('[data-request-thread]')).toHaveClass(/has-unread/);
  await expect(page.locator('[data-request-thread] em')).toHaveText('+2');

  // 열면 읽은 것으로 표시한다.
  await page.locator('[data-request-thread]').click();
  await expect.poll(() => readCalled).toContain('/service-requests/r9/read');
});

// 제목만 눌리면 그 아래 미리보기를 눌렀을 때 아무 일도 안 일어나 고장으로 읽힌다.
test('표에는 제목만 두고, 나머지는 상세에서 본다', async ({ page }) => {
  await open(page, { canManage: true });
  await dismissReminder(page);
  const cell = page.locator('.request-table tbody tr').nth(1).locator('th[scope="row"]');

  // 눌러서 볼 수 있으니 표에 내용 미리보기·처리 메모를 늘어놓지 않는다.
  await expect(cell.locator('.request-note')).toHaveCount(0);
  await expect(cell).not.toContainText('처리 메모');

  // 제목 칸을 누르면 상세가 열리고, 거기에 처리 메모가 있다.
  const title = (await cell.locator('.request-title-name').innerText()).trim();
  await cell.locator('.request-title').click();
  await expect(page.locator('.request-detail')).toBeVisible();
  await expect(page.locator('#readonlyModalTitle, .readonly-modal-head strong').first())
    .toContainText(title);
  await expect(page.locator('.request-detail')).toContainText('처리 메모');
});

// 상세와 대화는 다른 것이다. 제목을 누르면 무슨 요청인지 읽고,
// 대화는 대화대로 열려야 한다.
test('제목은 상세를, 대화 버튼은 대화를 연다', async ({ page }) => {
  await open(page, { canManage: true });
  await dismissReminder(page);

  // 제목 → 상세. 대화창이 아니다.
  await page.locator('.request-table tbody tr').nth(1).locator('.request-title-name').click();
  await expect(page.locator('.request-detail')).toBeVisible();
  await expect(page.locator('.request-thread')).toHaveCount(0);
  await expect(page.locator('.request-detail-facts')).toContainText('이종혁');
  await expect(page.locator('.request-detail-block').first()).toContainText('요청 내용');

  // 상세에서 대화로 건너갈 수 있다.
  await page.locator('[data-detail-thread]').click();
  await expect(page.locator('.request-thread')).toBeVisible();
  await expect(page.locator('.request-thread-form')).toBeVisible();

  // 대화에서 다시 요청 내용을 볼 수도 있다.
  await page.locator('[data-thread-detail]').click();
  await expect(page.locator('.request-detail')).toBeVisible();
});

test('대화 버튼은 곧바로 대화를 연다', async ({ page }) => {
  await open(page, { canManage: true });
  await dismissReminder(page);
  await page.locator('.request-table tbody tr').nth(1).locator('[data-request-thread]').click();
  await expect(page.locator('.request-thread')).toBeVisible();
  await expect(page.locator('.request-detail')).toHaveCount(0);
});
