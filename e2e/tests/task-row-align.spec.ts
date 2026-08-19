import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';
const mk = (id: string, title: string, status: string, desc: string) => ({ id, title, description:desc, status,
  dueDate:null, version:1, workflowVersion:1, attachments:[], history:[], assignedBy:{uid:'l',name:'전현우'},
  assignee:{uid:'e2e-test-user',name:'김대호'}, reviewer:{uid:'l',name:'전현우'},
  capabilities:{ submit:true, approve:false, requestRevision:false, edit:true, reassign:true } });
const P = { id:'p1', name:'매출', description:'', status:'active', version:1, lead:{uid:'l',name:'전현우'},
  members:[{uid:'l',name:'전현우',active:true},{uid:'e2e-test-user',name:'김대호',active:true}],
  mediumCategories:[{ id:'m1', name:'중', manager:{uid:'l',name:'전현우'}, smallCategories:[{ id:'s1', name:'소', tasks:[
    mk('t1','제안서 상품파악','todo','인스타그램 해당 제안서 상품 파악 알고리즘 부스트 상품은 첫 달, 한 달 기준으로 안내가 필요합니다'),
    mk('t2','지시사항','done',''),
    mk('t3','얼마설정','doing',''),
    mk('t4','단가이렇게','acknowledged','')] }] }],
  capabilities:{ manageProject:true } };
test('업무 행은 내용 길이와 상관없이 같은 열에 정렬된다', async ({ page }) => {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/new-projects', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{viewPortfolio:true,createProject:true}, projects:[P] }) }));
  await page.route('**/new-projects/p1', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{manageProject:true}, project: P }) }));
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="new-projects"]').click();
  await page.locator('[data-structured-project-open="p1"]').click();
  await page.locator('.structured-task-row').first().waitFor();
  const xs = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.structured-task-row')];
    return rows.map(r => ({
      title: Math.round((r.querySelector('.structured-task-main > strong') as HTMLElement).getBoundingClientRect().x),
      flow: Math.round((r.querySelector('.structured-assignment-flow') as HTMLElement).getBoundingClientRect().x),
      hist: Math.round((r.querySelector('.structured-task-history') as HTMLElement)?.getBoundingClientRect().x ?? -1),
    }));
  });
  // 설명이 있든 없든, 버튼이 몇 개든 같은 x 위치여야 한다.
  const titles = new Set(xs.map(x => x.title));
  const flows = new Set(xs.map(x => x.flow));
  expect(titles.size).toBe(1);
  expect(flows.size).toBe(1);
});
