import { test } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';
const PROJECT = { id:'p1', name:'매출', description:'', status:'active', version:1,
  lead:{uid:'l',name:'김대호',rank:'부장'},
  members:[{uid:'l',name:'김대호',rank:'부장',active:true},{uid:'w',name:'전현우',rank:'팀장',active:true}],
  mediumCategories:[{ id:'m1', name:'매출1', manager:{uid:'l',name:'김대호'}, smallCategories:[{ id:'s1', name:'콜', tasks:[] }] }],
  capabilities:{ manageProject:true, viewPortfolio:true } };
test('upload', async ({ page }) => {
  const calls: string[] = [];
  page.on('console', m => { if (m.type() === 'error') calls.push('CONSOLE_ERR ' + m.text().slice(0, 160)); });
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/new-projects', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{viewPortfolio:true,createProject:true}, projects:[PROJECT] }) }));
  await page.route('**/new-projects/p1', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{manageProject:true}, project: PROJECT }) }));
  await page.route('**/new-projects/uploads', async r => {
    calls.push('UPLOAD_HIT method=' + r.request().method());
    await r.fulfill({ status:200, contentType:'application/json',
      body: JSON.stringify({ attachments: [{ url:'/uploads/1_a.pdf', name:'제안서.pdf', size:12345, mimeType:'application/pdf' }] }) });
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="new-projects"]').click();
  await page.locator('[data-structured-project-open="p1"]').click();
  await page.locator('[data-structured-task-create]').first().click();
  await page.locator('#structuredTaskForm').waitFor();
  await page.locator('[data-task-attach-input]').setInputFiles({ name: '제안서.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
  await page.waitForTimeout(700);
  calls.push('LIST=' + (await page.locator('[data-task-attach-list]').innerText()).replace(/\n/g, '|'));
  console.log('PROBE ' + JSON.stringify(calls));
});
