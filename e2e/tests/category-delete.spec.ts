import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const mk = (id: string, title: string) => ({ id, title, description: '', status: 'todo', dueDate: null,
  version: 1, workflowVersion: 1, attachments: [], history: [],
  assignedBy: { uid: 'l', name: '전현우' }, assignee: { uid: 'e2e-test-user', name: '김대호' },
  reviewer: { uid: 'l', name: '전현우' },
  capabilities: { submit: true, approve: false, requestRevision: false, edit: true, reassign: true } });

// m1은 내가 중분류 담당자, m2는 남의 중분류다.
const project = (canManage: boolean) => ({
  id: 'p1', name: '매출', description: '', status: 'active', version: 1,
  lead: { uid: 'l', name: '전현우', rank: '팀장' },
  members: [{ uid: 'l', name: '전현우', rank: '팀장', active: true },
    { uid: 'e2e-test-user', name: '김대호', rank: '부장', active: true }],
  mediumCategories: [
    { id: 'm1', name: '개발비 사용', manager: { uid: 'e2e-test-user', name: '김대호' }, meetings: [],
      smallCategories: [
        { id: 's1', name: '클로드 사용내역', tasks: [], meetings: [] },
        { id: 's2', name: 'GPT 사용내역', tasks: [mk('t1', 'GPT')], meetings: [] }] },
    { id: 'm2', name: '남의 중분류', manager: { uid: 'l', name: '전현우' }, meetings: [],
      smallCategories: [{ id: 's3', name: '남의 소분류', tasks: [], meetings: [] }] },
  ],
  capabilities: { manageProject: canManage },
});

async function open(page, { canManage = false, onDelete = null } = {}) {
  const P = project(canManage);
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/new-projects', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ readOnly: false, capabilities: { viewPortfolio: true, createProject: true }, projects: [P] }) }));
  await page.route('**/new-projects/p1/mediums/**', async route => {
    if (route.request().method() === 'DELETE') {
      onDelete?.(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    return route.fallback();
  });
  await page.route('**/new-projects/p1', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ readOnly: false, capabilities: { manageProject: canManage }, project: P }) }));
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="new-projects"]').click();
  await page.locator('[data-structured-project-open="p1"]').click();
}

test('중분류 담당자는 프로젝트 관리자가 아니어도 자기 소분류를 지울 수 있다', async ({ page }) => {
  let deleted = '';
  await open(page, { canManage: false, onDelete: url => { deleted = url; } });

  const empty = page.locator('.structured-split-block').filter({ hasText: '클로드 사용내역' });
  await expect(empty.locator('[data-structured-small-delete]')).toBeEnabled();

  page.once('dialog', d => d.accept());
  await empty.locator('[data-structured-small-delete]').click();
  await expect.poll(() => deleted).toContain('/mediums/m1/smalls/s1');
});

test('할 일이 남은 소분류는 지울 수 없다고 알린다', async ({ page }) => {
  await open(page, { canManage: false });
  const used = page.locator('.structured-split-block').filter({ hasText: 'GPT 사용내역' });
  const button = used.locator('[data-structured-small-delete]');
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', /할 일을 모두 지운 뒤/);
});

test('남의 중분류에서는 소분류를 손대지 못한다', async ({ page }) => {
  await open(page, { canManage: false });
  await page.locator('[data-structured-split-medium="m2"]').click();
  await expect(page.locator('.structured-split-detail [data-structured-small-delete]')).toHaveCount(0);
  await expect(page.locator('.structured-split-detail [data-structured-task-create]')).toHaveCount(0);
});

test('중분류 삭제는 프로젝트 관리자만 보이고, 소분류가 남아 있으면 막힌다', async ({ page }) => {
  await open(page, { canManage: false });
  await expect(page.locator('[data-structured-medium-delete]')).toHaveCount(0);

  await open(page, { canManage: true });
  const del = page.locator('.structured-split-head [data-structured-medium-delete]');
  await expect(del).toBeVisible();
  await expect(del).toBeDisabled();
});
