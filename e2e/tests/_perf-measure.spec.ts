import { test, Page } from '@playwright/test';
import { setupStubs } from './helpers';

// Ad-hoc perf harness. Runs inside Playwright's own TS loader so the
// Firebase init-script stubs don't trip over esbuild's __name helper.
// Measures end-to-end timings for the interactions the user flagged:
// boot, click a day cell, open add-event modal, nav to chat, open
// a room, nav to notice. Run with:
//   npx playwright test tests/_perf-measure.spec.ts --reporter=list
// This file is prefixed with _ so CI can exclude it; it's debug-only.

// Match production scale so timings reflect reality: a manager's
// /events returns ~5500 rows after date scoping, with heavy days
// holding 30-50 events. 20 chat rooms, each with a handful of
// placeholder messages.
function seededState() {
  const events: any[] = [];
  const today = new Date();
  for (let i = -365; i < 365; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const ds = d.toISOString().slice(0, 10);
    const count = Math.abs(i) < 30 ? 40 : 10;
    for (let j = 0; j < count; j++) {
      events.push({
        id: `ev-${i}-${j}`,
        title: `Event ${i} ${j} — 어떤 업무 설명`,
        type: j % 3 === 0 ? 'todo' : (j % 3 === 1 ? 'meeting' : 'memo'),
        date: ds,
        scope: j % 4 === 0 ? 'team' : 'personal',
        owner_id: 'e2e-test-user',
        owner_name: 'E2E',
        done: j % 5 === 0,
        deleted: false,
        todo_cat: j % 2 === 0 ? '세무 관련' : null,
        memo: `memo text for ${i}-${j}`,
      });
    }
  }
  const chatRooms: any[] = [];
  for (let i = 0; i < 20; i++) {
    chatRooms.push({
      id: `r${i}`,
      name: `채팅방 ${i}`,
      member_count: 3 + (i % 5),
      creator_id: 'e2e-test-user',
      created_at: new Date(Date.now() - i * 3600000).toISOString(),
    });
  }
  const chatMessages: Record<string, any[]> = {};
  const chatMembers: Record<string, any[]> = {};
  for (const r of chatRooms) {
    chatMessages[r.id] = Array.from({ length: 5 }).map((_, k) => ({
      id: `m${r.id}-${k}`, text: `msg ${k}`, uid: 'e2e-test-user', name: 'E2E', room_id: r.id,
      created_at: new Date(Date.now() - k * 60000).toISOString(),
    }));
    chatMembers[r.id] = [];
  }
  return {
    events,
    users: [{ uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local', role: 'admin', approved: true, is_active: true }],
    chatRooms,
    chatMessages,
    chatMembers,
    chatUnreadCounts: {},
  };
}

async function timeAction(page: Page, setup: () => Promise<void>, wait: () => Promise<void>): Promise<number> {
  await setup();
  const started = await page.evaluate(() => performance.now());
  await wait();
  const ended = await page.evaluate(() => performance.now());
  return Math.round(ended - started);
}

async function scenario(page: Page, debug: boolean) {
  const state = seededState();
  await setupStubs(page, state as any);
  const results: Record<string, number> = {};

  // Override /events with a Node-side serialized response. The
  // default stub shells out to page.evaluate to read state, and the
  // CDP round-trip for a multi-MB JSON payload dominated our
  // measurement (~2.5s) hiding the actual in-page cost. Pre-serialising
  // the JSON Node-side makes `response time` reflect real network +
  // parse + mapEventRecord work.
  const eventsJsonCache = new Map<string, string>();
  await page.route('**/api/events*', (route, request) => {
    const url = new URL(request.url());
    if (url.pathname !== '/api/events' || request.method() !== 'GET') return route.fallback();
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    const key = `${from}|${to}`;
    if (!eventsJsonCache.has(key)) {
      const filtered = state.events.filter(e =>
        (!from || String(e.date) >= from) && (!to || String(e.date) <= to)
      );
      eventsJsonCache.set(key, JSON.stringify(filtered));
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: eventsJsonCache.get(key) });
  });

  // Capture arrival-at timings: how long until each api endpoint
  // returns its FIRST successful response, and how much wall-clock
  // passes between Firebase auth resolving and the calendar grid
  // appearing in the DOM.
  const apiTimings: Record<string, number> = {};
  const pageLoadStart = Date.now();
  page.on('response', r => {
    const url = r.url();
    const m = url.match(/\/api\/([^?]+)/);
    if (!m) return;
    const k = m[1];
    if (!(k in apiTimings)) apiTimings[k] = Date.now() - pageLoadStart;
  });

  // Inject an in-page timer that records where each phase of
  // initApp finishes, independent of the CDP round-trips that
  // make network-log-based timing unreliable.
  await page.addInitScript(() => {
    const marks: Array<[string, number]> = [];
    (window as any).__bootMarks = marks;
    (window as any).__bootMark = (label: string) => marks.push([label, performance.now()]);
  });

  // Boot
  const bootStart = Date.now();
  await page.goto('/' + (debug ? '?debug=1' : ''));
  await page.waitForSelector('.cal-grid.month-grid', { timeout: 20_000 });
  results['boot → grid visible'] = Date.now() - bootStart;

  // Breakdown sub-timings.
  const perf = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    return {
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
      loadEvent: Math.round(nav.loadEventEnd - nav.startTime),
      bootMarks: (window as any).__bootMarks as Array<[string, number]>,
      eventsLen: ((window as any).events || []).length,
    };
  });
  results['  · DOMContentLoaded'] = perf.domContentLoaded;
  results['  · load event'] = perf.loadEvent;
  for (const [k, v] of Object.entries(apiTimings)) {
    results[`  · api ${k}`] = v;
  }
  for (const [label, t] of perf.bootMarks) {
    results[`  · mark ${label}`] = Math.round(t);
  }
  results['  · events loaded'] = perf.eventsLen;

  // Let boot work finish
  await page.waitForTimeout(300);

  // Click day cell → patchCalendarMonthView completes
  results['click day cell (selectMonthDate)'] = await page.evaluate(() => {
    const cells = document.querySelectorAll('.cal-cell[data-date]');
    const target = cells[15] as HTMLElement;
    const t0 = performance.now();
    (window as any).selectMonthDate(target.dataset.date);
    return Math.round(performance.now() - t0);
  });

  // openAddEvent → modal visible
  results['openAddEvent → modal'] = await page.evaluate(() => {
    const t0 = performance.now();
    (window as any).openAddEvent();
    // openAddEvent is synchronous — modal DOM populated inline.
    return Math.round(performance.now() - t0);
  });
  await page.evaluate(() => (window as any).closeModal());
  await page.waitForTimeout(50);

  // All nav timings measured purely in-page to avoid CDP polling
  // noise from waitForSelector. Unique-to-page selectors are hard to
  // keep fresh, so instead we snapshot mainBody's childElementCount
  // before navigating and wait for it to *change twice* — once when
  // the page-render wipes, once when the new content lands — OR for
  // a page-specific marker string in innerHTML.
  async function timeNav(target: string, marker: RegExp) {
    return await page.evaluate(async ({ target, markerSrc }) => {
      const body = document.getElementById('mainBody');
      const marker = new RegExp(markerSrc);
      const t0 = performance.now();
      (window as any).navTo(target);
      while (performance.now() - t0 < 5000) {
        if (body && marker.test(body.innerHTML)) break;
        await new Promise(r => requestAnimationFrame(r));
      }
      return Math.round(performance.now() - t0);
    }, { target, markerSrc: marker.source });
  }

  // navTo to some page OTHER than calendar to avoid false-positive
  // markers left over in body. Then time each transition from a
  // known state.
  results['navTo(chat) → room list'] = await timeNav('chat', /class="room-item"|채팅방이 없습니다/);
  results['enterRoom → chat-wrap'] = await page.evaluate(async () => {
    const body = document.getElementById('mainBody');
    const t0 = performance.now();
    (window as any).enterRoom('r0', '채팅방 0');
    while (performance.now() - t0 < 5000) {
      if (body && body.innerHTML.includes('chat-wrap')) break;
      await new Promise(r => requestAnimationFrame(r));
    }
    return Math.round(performance.now() - t0);
  });
  // Back to chat list, then over to notice (guarantees a clean transition).
  await page.evaluate(() => (window as any).navTo('chat'));
  await page.waitForTimeout(50);
  results['navTo(notice) → rendered'] = await timeNav('notice', /openAddNotice|등록된 글이 없습니다/);
  results['navTo(report) → rendered'] = await timeNav('report', /openWriteReport|openWriteWorkReport|reportSubTab/);
  results['navTo(calendar) from report'] = await timeNav('calendar', /cal-grid month-grid/);

  return results;
}

test.describe.configure({ mode: 'serial' });
test('perf: debug off', async ({ page }) => {
  const r = await scenario(page, false);
  console.log('\n================= DEBUG OFF =================');
  for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(44)}${String(v).padStart(6)} ms`);
});

test('perf: debug on', async ({ page }) => {
  const r = await scenario(page, true);
  console.log('\n================= DEBUG ON (?debug=1) =================');
  for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(44)}${String(v).padStart(6)} ms`);
});
