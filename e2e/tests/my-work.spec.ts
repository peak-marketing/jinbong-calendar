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
      id: 't4', title: '확인만 한 업무', description: '', status: 'acknowledged',
      dueDate: null, version: 1, attachments: [],
      assignedBy: { uid: 'lead', name: '김대호' }, reviewer: { uid: 'lead', name: '김대호' },
      project: { id: 'p1', name: '개발', status: 'active' },
      medium: { id: 'm1', name: '리워드스페이스' }, small: { id: 's4', name: '퍼니지' },
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

  // 상태별 그룹은 왼쪽 목록에 남는다.
  // 상태 이름은 업무 화면 표기와 같아야 하고, 어떤 상태도 누락되면 안 된다.
  const groups = view.locator('.my-work-group');
  await expect(groups).toHaveCount(4);
  await expect(groups.locator('.my-work-group-label')).toHaveText(['지시받음', '확인완료', '진행중', '업무완료']);
  await expect(view.locator('[data-my-work-open]')).toHaveCount(4);

  // 처음에는 첫 업무가 선택되어 오른쪽에 상세가 열린다.
  const detail = view.locator('.my-work-detail');
  await expect(view.locator('[data-my-work-open="t1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(detail).toContainText('API 연동 마무리');
  await expect(detail).toContainText('postBack URL 검증');
  await expect(detail).toContainText('리워드스페이스');

  // 다른 업무를 누르면 오른쪽만 바뀐다.
  await view.locator('[data-my-work-open="t2"]').click();
  await expect(view.locator('[data-my-work-open="t2"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(detail).toContainText('계약서 법무검토 회신 확인');
  await expect(detail).not.toContainText('postBack URL 검증');

  // 완료 표시에는 체크 문자를 쓰지 않는다(색으로만 구분).
  expect((await view.locator('.my-work-mark.status-done').innerText()).trim()).toBe('');

  // 기존 파라곤 할 일 API는 건드리지 않는다.
  expect(myTasksCalls).toBeGreaterThan(0);
});
