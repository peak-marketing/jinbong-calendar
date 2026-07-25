import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

// Regression net for the "pages feel slow to open" symptom the user
// reported after the chat rewrite. Each page render used to stack
// 2-4 serial awaits before first paint; we've parallelised the
// independent ones. These tests assert that by intercepting fetches
// with a small artificial delay — if two independent fetches have
// landed within ~20ms of each other, they were issued in parallel.

async function delayedRoute(page: import('@playwright/test').Page, match: RegExp, body: any, delayMs = 120) {
  await page.route(url => match.test(url.toString()), async route => {
    await new Promise(r => setTimeout(r, delayMs));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test.describe('page transitions are parallelised', () => {
  test.beforeEach(async ({ page }) => {
    await setupStubs(page);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
  });

  test('notice page: /notices and /notices/can-write fire together, not one after the other', async ({ page }) => {
    const started: Record<string, number> = {};
    page.on('request', req => {
      const url = req.url();
      if (/\/api\/notices$/.test(url)) started.notices = performance.now();
      if (/\/api\/notices\/can-write$/.test(url)) started.canWrite = performance.now();
    });

    // Intercept both with a slow response so any serial await is
    // unambiguous from parallel. 120ms is above browser scheduler
    // noise but below our assertion threshold.
    await delayedRoute(page, /\/api\/notices$/, [], 120);
    await delayedRoute(page, /\/api\/notices\/can-write$/, { canWrite: true }, 120);

    await page.evaluate(() => (window as any).navTo('notice'));
    await page.waitForTimeout(400);

    expect(started.notices).toBeGreaterThan(0);
    expect(started.canWrite).toBeGreaterThan(0);
    // Serial would mean canWrite only fires AFTER notices resolves
    // (i.e. >=120ms later). Parallel should put them within a few
    // ms of each other.
    const gap = Math.abs(started.canWrite - started.notices);
    expect(gap, `notices + can-write were ${gap}ms apart (expect parallel)`).toBeLessThan(20);
  });
});
