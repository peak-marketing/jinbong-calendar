import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';
const mk = (id: string, title: string, status: string) => ({ id, title, description:'', status, dueDate:null,
  version:1, workflowVersion:1, attachments:[], history:[], assignedBy:{uid:'l',name:'전현우'},
  assignee:{uid:'e2e-test-user',name:'김대호'}, reviewer:{uid:'l',name:'전현우'},
  capabilities:{ submit:true, approve:false, requestRevision:false, edit:true, reassign:true } });
const P = { id:'p1', name:'매출', description:'', status:'active', version:1, lead:{uid:'l',name:'전현우'},
  members:[{uid:'l',name:'전현우',active:true},{uid:'e2e-test-user',name:'김대호',active:true}],
  mediumCategories:[{ id:'m1', name:'중', manager:{uid:'l',name:'전현우'}, smallCategories:[{ id:'s1', name:'소', tasks:[
    // 일부러 뒤섞어 둔다 — 화면은 진행 순서대로 다시 세워야 한다.
    mk('t6','f','done'), mk('t3','c','doing'), mk('t5','e','revision'),
    mk('t1','a','todo'), mk('t4','d','review'), mk('t2','b','acknowledged')] }] }],
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
  // 지시받음 흰색 · 확인완료 파랑 · 진행중 노랑 · 진행완료 주황 · 수정요청 빨강 · 업무완료 초록.
  const EXPECTED: Record<string, string> = {
    'status-todo': 'rgb(255, 255, 255)',
    'status-acknowledged': 'rgb(43, 136, 190)',
    'status-doing': 'rgb(242, 193, 78)',
    'status-review': 'rgb(234, 136, 92)',
    'status-revision': 'rgb(210, 104, 111)',
    'status-done': 'rgb(63, 143, 104)',
  };
  // 화면에 나온 상태는 하나도 빠짐없이 정해진 색이어야 한다.
  for (const line of colors) {
    const key = line.split(' ')[0];
    expect(EXPECTED[key], `색이 정해지지 않은 상태: ${key}`).toBeTruthy();
    expect(line, key).toContain(`bg=${EXPECTED[key]}`);
  }
  // 뒤섞인 채로 내려와도 지시받음 → 확인완료 → 진행중 → 진행완료 → 수정요청 → 업무완료 차례로 선다.
  expect(colors.map(c => c.split(' ')[0])).toEqual(Object.keys(EXPECTED));
});
