import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';
const TASK = { id:'t1', title:'제안서 상품파악', description:'상품 안내', status:'todo', dueDate:null, version:1,
  workflowVersion:1, history:[], assignedBy:{uid:'l',name:'김대호'}, assignee:{uid:'e2e-test-user',name:'전현우'},
  reviewer:{uid:'l',name:'김대호'},
  attachments:[{ url:'/uploads/1_a.pdf', name:'상품자료.pdf', size:204800, mimeType:'application/pdf' }],
  capabilities:{ submit:true, approve:false, requestRevision:false, edit:true, reassign:true } };
const P = { id:'p1', name:'매출', description:'', status:'active', version:1, lead:{uid:'l',name:'김대호'},
  members:[{uid:'l',name:'김대호',active:true},{uid:'e2e-test-user',name:'전현우',active:true}],
  mediumCategories:[{ id:'m1', name:'중', manager:{uid:'l',name:'김대호'}, smallCategories:[{ id:'s1', name:'소', tasks:[TASK] }] }],
  capabilities:{ manageProject:true } };
test('첨부파일은 분할 상세와 보드 상세 양쪽에서 보인다', async ({ page }) => {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/new-projects', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{viewPortfolio:true,createProject:true}, projects:[P] }) }));
  await page.route('**/new-projects/p1', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{manageProject:true}, project: P }) }));
  await page.setViewportSize({ width: 1500, height: 850 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="new-projects"]').click();
  await page.locator('[data-structured-project-open="p1"]').click();

  // 분할 보기: 제목을 눌러 여는 상세
  await page.locator('[data-structured-task-detail]').first().click();
  await expect(page.locator('.task-detail')).toContainText('상품자료.pdf');
  await page.locator('.task-detail').getByRole('button', { name: '닫기', exact: true }).click();

  // 보드 보기: 카드 선택 시 오른쪽 상세
  await page.locator('[data-structured-task-view="board"]').click();
  await page.locator('[data-structured-board-task-open]').first().click();
  const drawer = page.locator('[data-structured-task-drawer]');
  await expect(drawer).toContainText('첨부파일');
  await expect(drawer).toContainText('상품자료.pdf');
  await expect(drawer).toContainText('200.0KB');
});
