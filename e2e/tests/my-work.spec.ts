import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const TASKS = {
  readOnly: false,
  tasks: [
    {
      id: 't1', title: 'API 연동 마무리', description: 'postBack URL 검증', status: 'doing',
      dueDate: '2026-08-20', version: 1, attachments: [],
      assignedBy: { uid: 'lead', name: '김대호' }, reviewer: { uid: 'lead', name: '김대호' },
      project: { id: 'p1', name: '개발', status: 'active' },
      medium: { id: 'm1', name: '리워드스페이스' }, small: { id: 's1', name: '체리그라운드' },
    },
    {
      id: 't2', title: '계약서 법무검토 회신 확인', description: '', status: 'todo',
      dueDate: null, version: 1, attachments: [],
      assignedBy: { uid: 'lead', name: '김대호' }, reviewer: { uid: 'lead', name: '김대호' },
      project: { id: 'p2', name: '관리', status: 'active' },
      medium: { id: 'm2', name: '리워드스페이스' }, small: { id: 's2', name: 'TNK 팩토리' },
    },
    {
      id: 't3', title: '미션 연동 점검', description: '', status: 'done',
      dueDate: '2026-08-10', version: 2, attachments: [],
      assignedBy: { uid: 'lead', name: '김대호' }, reviewer: { uid: 'lead', name: '김대호' },
      project: { id: 'p1', name: '개발', status: 'active' },
      medium: { id: 'm1', name: '리워드스페이스' }, small: { id: 's3', name: '아바티' },
    },
  ],
};

test('업무 현황 탭은 내 업무만 상태별로 모으고 눌러서 상세를 연다', async ({ page }) => {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  let myTasksCalls = 0;
  await page.route('**/new-projects/my-tasks', async route => {
    myTasksCalls += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TASKS) });
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/business-os-preview.html');
  for (const cluster of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) {
    if (await cluster.isVisible()) await cluster.click();
  }
  await page.locator('.nav-item[data-view="my-work"]').click();

  const view = page.locator('#myWorkView');
  await expect(view).toBeVisible();
  await expect(view.locator('.my-work-head em')).toHaveText('2건 남음 · 전체 3건');

  // 상태별로 그룹이 나뉘고, 각 행에 기한·프로젝트·분류가 함께 보인다.
  const groups = view.locator('.my-work-group');
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(0).locator('.my-work-group-label')).toHaveText('진행 중');
  await expect(groups.nth(1).locator('.my-work-group-label')).toHaveText('대기');
  await expect(groups.nth(2).locator('.my-work-group-label')).toHaveText('완료');
  await expect(groups.nth(0)).toContainText('API 연동 마무리');
  await expect(groups.nth(0)).toContainText('개발');
  await expect(groups.nth(0)).toContainText('리워드스페이스 › 체리그라운드');
  await expect(groups.nth(1)).toContainText('기한 없음');

  // 업무를 누르면 그 업무의 상세가 열린다.
  await view.locator('[data-my-work-open="t1"]').click();
  const detail = page.locator('.task-detail');
  await expect(detail).toBeVisible();
  // 제목은 모달 헤더에, 나머지는 본문에 들어간다.
  await expect(page.locator('#readonlyDetailModal')).toContainText('API 연동 마무리');
  await expect(detail).toContainText('postBack URL 검증');
  await expect(detail).toContainText('리워드스페이스');
  await expect(detail).toContainText('체리그라운드');
  await detail.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(detail).toBeHidden();

  // 기존 파라곤 할 일 API는 건드리지 않는다.
  expect(myTasksCalls).toBeGreaterThan(0);
});
