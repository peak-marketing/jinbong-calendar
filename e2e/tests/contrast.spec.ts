import { test } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const mk = (id:string,t:string,st:string,d='')=>({id,title:t,description:d,status:st,dueDate:null,version:1,
  workflowVersion:1,attachments:[],history:[{action:'submit',actor:{uid:'l'},actorName:'전현우',createdAt:'2026-08-18T02:00:00Z'}],
  assignedBy:{uid:'l',name:'전현우'},assignee:{uid:'e2e-test-user',name:'김대호'},
  reviewer:{uid:'l',name:'전현우'},capabilities:{submit:true,approve:false,requestRevision:false,edit:true,reassign:true}});
const MEETING = { id:'mt1', mediumId:'m1', smallId:'s1', title:'8월 단가 확정 회의', description:'검토',
  location:'본사 회의실', startDate:'2026-08-20', endDate:'2026-08-20', startTime:'17:30', endTime:'19:00',
  organizer:{uid:'l',name:'전현우'}, status:'scheduled', version:2, eventId:'e1',
  notes:'확정', attendees:[{uid:'e2e-test-user',name:'김대호'}],
  actionItems:[{id:'ai1',title:'회신',assignee:{uid:'e2e-test-user',name:'김대호'},dueDate:'2026-08-22',taskId:null}] };
const P = { id:'p1', name:'매출', description:'설명', status:'active', version:1, lead:{uid:'l',name:'전현우',rank:'팀장'},
  members:[{uid:'l',name:'전현우',rank:'팀장',active:true},{uid:'e2e-test-user',name:'김대호',rank:'부장',active:true}],
  mediumCategories:[{ id:'m1', name:'인스타그램', manager:{uid:'e2e-test-user',name:'김대호'}, meetings:[],
    smallCategories:[{ id:'s1', name:'단가체크', meetings:[MEETING], tasks:[
      mk('t1','지시받음 업무','todo','설명입니다'), mk('t2','확인완료 업무','acknowledged'),
      mk('t3','진행중 업무','doing'), mk('t4','진행완료 업무','review'),
      mk('t5','수정요청 업무','revision'), mk('t6','업무완료 업무','done')] }] }],
  capabilities:{ manageProject:true } };
const EXPENSES = [
  { id:'e1', spentOn:'2026-08-20', category:'ai', serviceName:'ChatGPT Plus', amount:29000,
    cardName:'국민카드', isSubscription:true, renewsOn:'2026-09-20', paid:true, memo:'메모', version:1,
    createdBy:{uid:'u',name:'김동우'} },
  { id:'e2', spentOn:'2026-08-18', category:'server', serviceName:'AWS', amount:12500,
    cardName:'', isSubscription:false, renewsOn:null, paid:false, memo:'', version:1,
    createdBy:{uid:'u',name:'김동우'} },
];
const TASKS = { tasks: [ { ...mk('w1','내 업무','doing'), project:{id:'p1',name:'매출',status:'active'},
  medium:{id:'m1',name:'인스타그램'}, small:{id:'s1',name:'단가체크'} } ] };

const AUDIT = `(() => {
  const toRgb = c => { const m = c.match(/[\\d.]+/g); return m ? m.slice(0,3).map(Number) : null; };
  const alpha = c => { const m = c.match(/[\\d.]+/g); return m && m.length > 3 ? Number(m[3]) : 1; };
  const lum = ([r,g,b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
    return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b); };
  const ratio = (a,b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
  const bgOf = el => { let n = el;
    while (n && n !== document.documentElement) { const c = getComputedStyle(n).backgroundColor;
      if (c && alpha(c) > 0.5) return toRgb(c); n = n.parentElement; }
    return toRgb(getComputedStyle(document.body).backgroundColor) || [255,255,255]; };
  const out = [];
  document.querySelectorAll('*').forEach(el => {
    const e = el; const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    if (e.offsetParent === null && getComputedStyle(e).position !== 'fixed') return;
    const text = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
    if (!text) return;
    const cs = getComputedStyle(e);
    const fg = toRgb(cs.color); if (!fg) return;
    if (alpha(cs.color) < 0.5) return;
    const bg = bgOf(e); if (!bg) return;
    const size = parseFloat(cs.fontSize); const weight = Number(cs.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(fg, bg);
    const chain = (n) => { const parts = []; let c = n;
      for (let i = 0; i < 3 && c && c !== document.body; i++) {
        parts.unshift((c.className && String(c.className).split(' ')[0]) || c.tagName.toLowerCase()); c = c.parentElement; }
      return parts.join(' > '); };
    if (got < need) out.push({ owner: (e.parentElement && String(e.parentElement.className).split(' ')[0]) || '', sel: chain(e),
      text: text.slice(0, 18), fg: cs.color, bg: 'rgb(' + bg.join(',') + ')', ratio: Math.round(got*100)/100, need });
  });
  return out;
})()`;

async function boot(page) {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/new-projects/my-tasks', r => r.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(TASKS) }));
  await page.route('**/new-projects', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{viewPortfolio:true,createProject:true}, projects:[P] }) }));
  await page.route('**/new-projects/p1', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ readOnly:false, capabilities:{manageProject:true}, project: P }) }));
  await page.route('**/peakos/dev-expenses**', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ expenses: EXPENSES, categories: [], cards: ['국민카드'], canWrite: true }) }));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/business-os-preview.html');
  await page.waitForTimeout(1200);
}

// 색을 하드코딩하면 한쪽 테마에서 배경에 묻힌다. 실제로 회의·개발비·상태 색이
// 다크에서 명암비 1.1까지 떨어져 아무것도 안 보였다. 화면을 눈으로 보는 대신
// 브라우저가 실제로 칠한 색을 재서 WCAG AA(본문 4.5:1) 미만을 잡는다.
for (const theme of ['dark', 'light']) {
  test(`${theme} 모드에서 모든 글자가 배경과 충분히 구별된다`, async ({ page }) => {
    await boot(page);
    await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
    const found: any[] = [];
    const grab = async (label: string) => {
      await page.waitForTimeout(250);
      const rows = await page.evaluate(AUDIT);
      (rows as any[]).forEach(r => found.push({ ...r, where: label }));
    };
    await page.locator('.nav-item[data-view="new-projects"]').click();
    await page.locator('[data-structured-project-open="p1"]').click();
    await grab('프로젝트');
    await page.locator('[data-structured-meeting-notes]').click();
    await grab('회의록');
    await page.locator('[data-collab-cancel]').click();
    await page.locator('.nav-item[data-view="my-work"]').click();
    await grab('업무현황');
    await page.locator('.nav-item[data-view="dev-expense"]').click();
    await grab('개발비');
    const uniq = new Map();
    found.forEach(r => { const k = r.where + '|' + r.sel + '|' + r.fg; if (!uniq.has(k)) uniq.set(k, r); });
    const failures = [...uniq.values()].sort((a, b) => a.ratio - b.ratio);
    if (failures.length) {
      const lines = failures.map(r =>
        `  ${r.ratio.toFixed(2)} (필요 ${r.need}) ${r.where} · ${r.sel} '${r.text}' fg=${r.fg} bg=${r.bg}`);
      throw new Error(`${theme} 모드에서 글자가 배경에 묻힙니다 (${failures.length}곳):\n${lines.join('\n')}`);
    }
  });
}
