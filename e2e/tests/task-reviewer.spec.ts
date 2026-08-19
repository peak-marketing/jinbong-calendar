import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';
const P = { id:'p1', name:'매출', description:'', status:'active', version:1, lead:{uid:'l',name:'김대호'},
  members:[{uid:'l',name:'김대호',rank:'부장',active:true},{uid:'w',name:'전현우',rank:'팀장',active:true},{uid:'c',name:'손명아',rank:'실장',active:true}],
  mediumCategories:[{ id:'m1', name:'중분류', manager:{uid:'l',name:'김대호'}, smallCategories:[{ id:'s1', name:'소분류', tasks:[] }] }],
  capabilities:{ manageProject:true } };
test('업무 지시자·담당자·검토자를 각각 고를 수 있다', async ({ page }) => {
  let sent: any = null;
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/new-projects', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{viewPortfolio:true,createProject:true}, projects:[P] }) }));
  await page.route('**/new-projects/p1', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{manageProject:true}, project: P }) }));
  await page.route('**/smalls/s1/tasks', async r => {
    sent = JSON.parse(r.request().postData() || '{}');
    await r.fulfill({ status:200, contentType:'application/json', body:'{"ok":true}' });
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="new-projects"]').click();
  await page.locator('[data-structured-project-open="p1"]').click();
  await page.locator('[data-structured-task-create]').first().click();
  const form = page.locator('#structuredTaskForm');
  await form.waitFor();
  // 세 항목이 각각 존재한다.
  await expect(form.locator('select[name="assignedByUid"]')).toBeVisible();
  await expect(form.locator('select[name="assigneeUid"]')).toBeVisible();
  await expect(form.locator('select[name="reviewerUid"]')).toBeVisible();
  await form.locator('input[name="title"]').fill('검토자 지정 업무');
  await form.locator('select[name="assignedByUid"]').selectOption('l');
  await form.locator('select[name="assigneeUid"]').selectOption('w');
  await form.locator('select[name="reviewerUid"]').selectOption('c');
  await form.getByRole('button', { name: /배정|토스/ }).click();
  await expect.poll(() => sent?.reviewerUid).toBe('c');
  console.log('PROBE ' + JSON.stringify({ assignedByUid: sent?.assignedByUid, assigneeUid: sent?.assigneeUid, reviewerUid: sent?.reviewerUid }));
});
