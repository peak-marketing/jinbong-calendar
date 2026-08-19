import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';
const mk = (id: string, title: string, status: string) => ({ id, title, description:'', status, dueDate:null,
  version:1, workflowVersion:1, attachments:[], history:[], assignedBy:{uid:'l',name:'전현우'},
  assignee:{uid:'e2e-test-user',name:'김대호'}, reviewer:{uid:'l',name:'전현우'},
  capabilities:{ submit:true, approve:false, requestRevision:false, edit:true, reassign:true } });
const P = { id:'p1', name:'매출', description:'', status:'active', version:1, lead:{uid:'l',name:'전현우'},
  members:[{uid:'l',name:'전현우',active:true},{uid:'e2e-test-user',name:'김대호',active:true}],
  mediumCategories:[{ id:'m1', name:'중', manager:{uid:'l',name:'전현우'}, smallCategories:[{ id:'s1', name:'소', tasks:[
    mk('t1','a','todo'), mk('t2','b','acknowledged'), mk('t3','c','doing'),
    mk('t4','d','review'), mk('t5','e','revision'), mk('t6','f','done')] }] }],
  capabilities:{ manageProject:true } };
test('업무 상태 동그라미는 상태별 색을 가진다', async ({ page }) => {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/new-projects', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{viewPortfolio:true,createProject:true}, projects:[P] }) }));
  await page.route('**/new-projects/p1', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{manageProject:true}, project: P }) }));
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="new-projects"]').click();
  await page.locator('[data-structured-project-open="p1"]').click();
  await page.locator('.structured-task-check').first().waitFor();
  const colors = await page.locator('.structured-task-check').evaluateAll(els => els.map(el => {
    const s = getComputedStyle(el as HTMLElement);
    return `${(el as HTMLElement).className.match(/status-[a-z]+/)?.[0]} bg=${s.backgroundColor} border=${s.borderTopColor}`;
  }));
  console.log('PROBE ' + JSON.stringify(colors, null, 0));
  // 확인완료는 채우지 않고, 승인완료는 초록으로 덮는다.
  expect(colors.find(c => c.startsWith('status-acknowledged'))).toContain('bg=rgb(255, 255, 255)');
  expect(colors.find(c => c.startsWith('status-done'))).toContain('bg=rgb(63, 143, 104)');
  expect(colors.find(c => c.startsWith('status-revision'))).toContain('bg=rgb(210, 104, 111)');
  expect(colors.find(c => c.startsWith('status-doing'))).toContain('bg=rgb(247, 217, 138)');
});
