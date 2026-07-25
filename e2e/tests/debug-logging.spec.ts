import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

// Two complementary assertions:
//   1) With the debug flag OFF, the calendar produces zero [cal ...] logs —
//      production users should never see the noise.
//   2) With ?debug=1 ON, instrumented paths actually fire and
//      window.__calDump() / window.__calSummary() are available so the
//      user can hand a trace back for diagnosis.

test.describe('debug logging harness', () => {
  test('debug OFF: no [cal ...] console lines during normal boot', async ({ page }) => {
    const calLines: string[] = [];
    page.on('console', msg => {
      const t = msg.text();
      if (t.includes('[cal')) calLines.push(t);
    });
    await setupStubs(page);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });

    // Give polling one tick's worth of time to also stay silent.
    await page.waitForTimeout(300);

    expect(calLines, 'debug logger must be silent when flag is off').toEqual([]);
    const hasHelpers = await page.evaluate(() =>
      typeof (window as any).__calDump === 'function'
    );
    expect(hasHelpers, 'no __calDump helper when debug is off').toBe(false);
  });

  test('debug ON via ?debug=1: key paths are logged', async ({ page }) => {
    const calLines: string[] = [];
    page.on('console', msg => {
      const t = msg.text();
      if (t.includes('[cal')) calLines.push(t);
    });
    await setupStubs(page);
    await page.goto('/?debug=1');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });

    // Trigger a user-action path that should log.
    await page.evaluate(() => {
      const w = window as any;
      w.upsertLocalEvent({
        id: 'dbg-1', title: 'dbg', type: 'meeting', date: w.todayStr(),
        scope: 'personal', owner_id: 'e2e-test-user',
      });
      w.refreshCalendarUi({ keepScroll: true });
    });
    await page.waitForTimeout(100);

    const tags = calLines.map(l => {
      // Strip ANSI color markers and prefix `[cal+...s] tag ...` → keep `tag`.
      const m = l.match(/\[cal\+[^\]]+\]\s+([^\s,]+)/);
      return m ? m[1] : null;
    }).filter(Boolean);

    expect(tags).toEqual(expect.arrayContaining(['api', 'refreshCalendarUi', 'upsertLocalEvent']));

    const summary = await page.evaluate(() => (window as any).__calSummary());
    expect(summary, 'summary should expose counts').toBeTruthy();
    expect(Object.keys(summary).length).toBeGreaterThan(0);

    const dumpLength = await page.evaluate(() => (window as any).__calDump().length);
    expect(dumpLength).toBeGreaterThan(0);
  });

  test('debug ON: logs are batched and POSTed to /api/_debug/client-log', async ({ page }) => {
    await setupStubs(page);
    await page.goto('/?debug=1');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    // Let boot-time batches drain first so we can observe a fresh batch
    // triggered by user action.
    await page.waitForTimeout(1500);

    await page.evaluate(() => {
      const w = window as any;
      w.upsertLocalEvent({
        id: 'dbg-server-1', title: 'server', type: 'meeting', date: w.todayStr(),
        scope: 'personal', owner_id: 'e2e-test-user',
      });
      w.refreshCalendarUi({ keepScroll: true });
    });

    // 800ms batch timer + network + stub roundtrip.
    await page.waitForTimeout(2000);

    const uploads = await page.evaluate(() => (window as any).__e2e_dbg_uploads || []);
    expect(uploads.length).toBeGreaterThan(0);

    const allTags = uploads.flatMap((u: any) => (u.entries || []).map((e: any) => e.tag));
    // upsertLocalEvent logs itself as 'upsertLocalEvent (insert)' etc.
    expect(allTags).toContain('refreshCalendarUi');
    expect(allTags.some((t: string) => t.startsWith('upsertLocalEvent'))).toBe(true);

    expect(uploads[0].session).toMatch(/^[a-z0-9]+$/);
    expect(uploads[0].url).toMatch(/debug=1/);
  });

  test('debug OFF: nothing is POSTed to /api/_debug/client-log', async ({ page }) => {
    await setupStubs(page);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.waitForTimeout(1200);

    const uploads = await page.evaluate(() => (window as any).__e2e_dbg_uploads || []);
    expect(uploads).toEqual([]);
  });

  test('debug ON: renderPage (full wipe) is logged as a warning-tag, partial updates are not', async ({ page }) => {
    const warnTags: string[] = [];
    const logTags: string[] = [];
    page.on('console', msg => {
      const t = msg.text();
      if (!t.includes('[cal')) return;
      const tagMatch = t.match(/\[cal\+[^\]]+\]\s+([^\s,]+)/);
      if (!tagMatch) return;
      if (msg.type() === 'warning') warnTags.push(tagMatch[1]);
      else logTags.push(tagMatch[1]);
    });
    await setupStubs(page);
    await page.goto('/?debug=1');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });

    warnTags.length = 0;
    logTags.length = 0;

    // A partial refresh should NOT emit !renderPage.
    await page.evaluate(() => {
      const w = window as any;
      w.upsertLocalEvent({
        id: 'dbg-partial', title: 'x', type: 'todo', date: w.todayStr(),
        scope: 'personal', owner_id: 'e2e-test-user',
      });
      w.refreshCalendarUi({ keepScroll: true });
    });
    await page.waitForTimeout(50);

    expect(warnTags).not.toContain('renderPage');
    expect(logTags).toEqual(expect.arrayContaining(['refreshCalendarUi']));
  });
});
