import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

// Regression net for the sitewide-slowdown the user reported after the
// chat rewrite. Desktop browsers fire `visibilitychange` and
// `window.focus` in sequence on tab-return, so without dedupe every
// wake-up doubled the number of GETs to /chat-rooms/unread,
// /notices/unread/count, and /events. The debug log showed the two
// bursts landing ~11ms apart. onAppResume() must collapse them.

test.describe('tab-wake dedupe', () => {
  test.beforeEach(async ({ page }) => {
    await setupStubs(page);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
  });

  test('back-to-back visibilitychange + focus only fires one wake fetch burst', async ({ page }) => {
    // Count wake-triggered GETs to endpoints the resume handler hits.
    // Filter out unrelated boot traffic by starting our counter only
    // after waitForSelector resolved (boot is already complete).
    const wakeRequests: string[] = [];
    page.on('request', req => {
      const url = req.url();
      if (!/\/api\/(chat-rooms\/unread|notices\/unread\/count|events)(\?|$)/.test(url)) return;
      wakeRequests.push(url);
    });

    // Wait for any in-flight boot traffic to settle.
    await page.waitForTimeout(400);
    wakeRequests.length = 0;

    // Fire visibilitychange then focus in rapid succession, the way
    // Chrome/Firefox actually dispatch them on tab-return.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });

    await page.waitForTimeout(500);

    const counts: Record<string, number> = {};
    for (const url of wakeRequests) {
      const key = url.replace(/^.*\/api/, '').split('?')[0];
      counts[key] = (counts[key] || 0) + 1;
    }

    // Each endpoint should be hit at most once — the secondary wake
    // event must be deduped. (GET /events is only issued by the
    // resume handler here since polling runs on a 5s interval and we
    // only waited 500ms.)
    for (const [ep, n] of Object.entries(counts)) {
      expect(n, `${ep} was requested ${n}× by a single wake burst`).toBeLessThanOrEqual(1);
    }
  });

  test('wake dedupe window releases after ~1s so later wakes still work', async ({ page }) => {
    const wakeRequests: string[] = [];
    page.on('request', req => {
      const url = req.url();
      if (!/\/api\/chat-rooms\/unread(\?|$)/.test(url)) return;
      wakeRequests.push(url);
    });

    await page.waitForTimeout(400);
    wakeRequests.length = 0;

    // First wake.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await page.waitForTimeout(200);
    const afterFirst = wakeRequests.length;
    expect(afterFirst).toBe(1);

    // Wait past the dedupe window, then wake again.
    await page.waitForTimeout(1100);
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(200);

    expect(wakeRequests.length).toBe(afterFirst + 1);
  });
});
