import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';
const mkTask = (id: string, title: string) => ({ id, title, description:'', status:'todo', dueDate:null, version:1,
  workflowVersion:1, attachments:[], history:[], assignedBy:{uid:'l',name:'김대호'}, assignee:{uid:'e2e-test-user',name:'전현우'},
  reviewer:{uid:'l',name:'김대호'}, capabilities:{ submit:true, approve:false, requestRevision:false, edit:true, reassign:true } });
const PROJECT = { id:'p1', name:'매출', description:'매출관리', status:'active', version:1,
  lead:{uid:'l',name:'김대호',rank:'부장'},
  members:[{uid:'l',name:'김대호',rank:'부장',active:true},{uid:'e2e-test-user',name:'전현우',rank:'팀장',active:true}],
  mediumCategories:[
    { id:'m1', name:'매출1', manager:{uid:'l',name:'김대호',rank:'부장'}, smallCategories:[
      { id:'s1', name:'체리그라운드', tasks:[mkTask('t1','API 연동')] },
      { id:'s2', name:'TNK 팩토리', tasks:[] } ] },
    { id:'m2', name:'매출2', manager:{uid:'l',name:'김대호',rank:'부장'}, smallCategories:[] },
  ],
  capabilities:{ manageProject:true, viewPortfolio:true } };
test('분할 보기는 중분류를 고르면 오른쪽에 그 중분류 전체를 펼친다', async ({ page }) => {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/new-projects', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{viewPortfolio:true,createProject:true}, projects:[PROJECT] }) }));
  await page.route('**/new-projects/p1', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{manageProject:true}, project: PROJECT }) }));
  await page.setViewportSize({ width: 1500, height: 760 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="new-projects"]').click();
  await page.locator('[data-structured-project-open="p1"]').click();
  await page.locator('.structured-split').waitFor();
  // 기본은 첫 중분류가 선택돼 그 전체가 오른쪽에 펼쳐진다.
  await expect(page.locator('[data-structured-split-medium="m1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.structured-split-detail')).toContainText('체리그라운드');
  await expect(page.locator('.structured-split-detail')).toContainText('TNK 팩토리');
  // 고른 중분류만 소분류가 펼쳐지고 나머지는 접혀 있다.
  await expect(page.locator('[data-structured-split-medium="m1"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-structured-split-medium="m2"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-structured-split-small]')).toHaveCount(2);
  await page.locator('[data-structured-split-medium="m2"]').click();
  await expect(page.locator('[data-structured-split-small]')).toHaveCount(0);
  await page.locator('[data-structured-split-medium="m1"]').click();
  await expect(page.locator('[data-structured-split-small]')).toHaveCount(2);

  // 열려 있는 중분류를 다시 누르면 소분류만 접히고 오른쪽 상세는 유지된다.
  await page.locator('[data-structured-split-medium="m1"]').click();
  await expect(page.locator('[data-structured-split-medium="m1"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-structured-split-small]')).toHaveCount(0);
  await expect(page.locator('.structured-split-detail')).toContainText('체리그라운드');
  await page.locator('[data-structured-split-medium="m1"]').click();
  await expect(page.locator('[data-structured-split-small]')).toHaveCount(2);

  // 소분류를 고르면 그 하나만 보인다.
  await page.locator('[data-structured-split-small="s1"]').click();
  await expect(page.locator('.structured-split-detail')).not.toContainText('TNK 팩토리');
  // 다시 중분류를 고르면 전체로 돌아온다.
  await page.locator('[data-structured-split-medium="m1"]').click();
  await expect(page.locator('.structured-split-detail')).toContainText('TNK 팩토리');

  // 담당자는 확인완료 · 진행중 · 진행완료를 직접 고른다.
  const actions: string[] = [];
  await page.route('**/tasks/t1/review', async route => {
    actions.push(String(JSON.parse(route.request().postData() || '{}').action));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  const steps = page.locator('.structured-task-steps > button');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toHaveText('확인완료');
  await expect(steps.nth(1)).toHaveText('진행중');
  await expect(steps.nth(2)).toHaveText('진행완료');
  await steps.nth(0).click();
  await expect.poll(() => actions).toContain('acknowledge');
});
