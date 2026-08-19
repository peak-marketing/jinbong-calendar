import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';
const mk = (id: string, title: string, due: string | null) => ({ id, title, description:'', status:'todo', dueDate:due,
  version:1, workflowVersion:1, attachments:[], history:[], assignedBy:{uid:'l',name:'김대호'},
  assignee:{uid:'w',name:'전현우'}, reviewer:{uid:'l',name:'김대호'},
  capabilities:{ submit:false, approve:false, requestRevision:false, edit:true, reassign:true } });
// 날짜를 고정하면 내일 깨지므로 오늘 기준 상대 날짜로 만든다.
const dayKey = (offset: number) => {
  const now = new Date();
  const shifted = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(shifted);
};
const P = { id:'p1', name:'매출', description:'', status:'active', version:1, lead:{uid:'l',name:'김대호'},
  members:[{uid:'l',name:'김대호',active:true},{uid:'w',name:'전현우',active:true}],
  mediumCategories:[{ id:'m1', name:'중', manager:{uid:'l',name:'김대호'}, smallCategories:[{ id:'s1', name:'소', tasks:[
    mk('t1','지난 업무', dayKey(-1)), mk('t2','오늘 업무', dayKey(0)), mk('t3','이틀 뒤', dayKey(2))] }] }],
  capabilities:{ manageProject:true } };
test('마감 배지는 D-DAY 형식으로 표시한다', async ({ page }) => {
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
  await page.locator('.structured-task-row').first().waitFor();
  const labels = await page.locator('.structured-task-row .project-deadline-badge').allTextContents();
  console.log('PROBE ' + JSON.stringify(labels));
  expect(labels).toEqual(['D+1', 'D-DAY', 'D-2']);
});
