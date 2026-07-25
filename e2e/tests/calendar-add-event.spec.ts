import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

// All interaction with app state goes through the public function hooks
// (refreshCalendarUi, upsertLocalEvent, fetchEvents, selectMonthDate,
// todayStr, eventsForDate) which are function declarations and therefore
// available on `window` even though the `let`-declared state isn't.

test.describe('calendar add-event UX', () => {
  test.beforeEach(async ({ page }) => {
    await setupStubs(page);
    page.on('pageerror', err => console.log('[pageerror]', err.message));
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
  });

  test('patching month view preserves the grid DOM node (no full wipe)', async ({ page }) => {
    await page.evaluate(() => {
      document.querySelector('.cal-grid.month-grid')!.setAttribute('data-e2e-marker', '1');
    });

    await page.evaluate(() => {
      const w = window as any;
      w.upsertLocalEvent({
        id: 'e2e-1', title: 'E2E Event', type: 'meeting', date: w.todayStr(),
        scope: 'personal', owner_id: 'e2e-test-user',
      });
      w.refreshCalendarUi({ keepScroll: true });
    });

    const stillThere = await page.evaluate(() =>
      !!document.querySelector('.cal-grid.month-grid[data-e2e-marker="1"]')
    );
    expect(stillThere).toBe(true);
  });

  test('today cell gains has-items class after adding an event', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as any;
      w.upsertLocalEvent({
        id: 'e2e-2', title: 'Partial Update Test', type: 'meeting', date: w.todayStr(),
        scope: 'personal', owner_id: 'e2e-test-user',
      });
      w.refreshCalendarUi({ keepScroll: true });
    });

    const hasItems = await page.evaluate(() => {
      const today = (window as any).todayStr();
      const cell = document.querySelector(`.cal-cell[data-date="${today}"]`);
      return cell?.classList.contains('has-items') ?? false;
    });
    expect(hasItems).toBe(true);
  });

  test('scroll position is preserved across refreshCalendarUi', async ({ page }) => {
    // Make the mobile-day-panel / right-panel stretch to create scrollable
    // content, then scroll and trigger another refresh.
    await page.setViewportSize({ width: 800, height: 600 });
    await page.evaluate(() => {
      const w = window as any;
      const today = w.todayStr();
      const d = new Date(today + 'T00:00:00');
      for (let i = 0; i < 30; i++) {
        const ds = new Date(d.getTime() + i * 86400000).toISOString().slice(0, 10);
        w.upsertLocalEvent({
          id: 'bulk-' + i, title: 'ev ' + i, type: 'meeting', date: ds,
          scope: 'personal', owner_id: 'e2e-test-user',
        });
      }
      w.refreshCalendarUi({ keepScroll: true });
      document.getElementById('mainBody')!.scrollTop = 150;
    });

    const before = await page.evaluate(() => document.getElementById('mainBody')!.scrollTop);
    expect(before).toBeGreaterThan(0);

    await page.evaluate(() => {
      const w = window as any;
      w.upsertLocalEvent({
        id: 'later', title: 'later', type: 'meeting', date: w.todayStr(),
        scope: 'personal', owner_id: 'e2e-test-user',
      });
      w.refreshCalendarUi({ keepScroll: true });
    });

    await page.waitForTimeout(250);
    const after = await page.evaluate(() => document.getElementById('mainBody')!.scrollTop);
    expect(after).toBeGreaterThan(0);
    expect(Math.abs(after - before)).toBeLessThan(20);
  });

  test('fetchEvents does not evict an event the user just added locally', async ({ page }) => {
    // The stub `/api/events` GET returns whatever the route handler sees
    // in __e2e_api_state.events. We deliberately do NOT add the event to
    // that state, only to the local app. After fetchEvents, the local
    // event should survive thanks to recentLocalUpserts.
    await page.evaluate(() => {
      const w = window as any;
      w.upsertLocalEvent({
        id: 'pending-1', title: 'Just added', type: 'meeting', date: w.todayStr(),
        scope: 'personal', owner_id: 'e2e-test-user',
      });
      w.refreshCalendarUi({ keepScroll: true });
    });

    // Sanity: event visible before fetchEvents.
    const seenBefore = await page.evaluate(() => {
      const w = window as any;
      return w.eventsForDate(w.todayStr()).some((e: any) => e.id === 'pending-1');
    });
    expect(seenBefore).toBe(true);

    await page.evaluate(() => (window as any).fetchEvents());

    const seenAfter = await page.evaluate(() => {
      const w = window as any;
      return w.eventsForDate(w.todayStr()).some((e: any) => e.id === 'pending-1');
    });
    expect(seenAfter).toBe(true);
  });

  test('selecting a day patches the selected class without rebuilding the grid', async ({ page }) => {
    const result = await page.evaluate(() => {
      const cells = document.querySelectorAll('.cal-cell[data-date]');
      const target = cells[Math.min(10, cells.length - 1)] as HTMLElement;
      const ds = target.dataset.date!;
      document.querySelector('.cal-grid.month-grid')!.setAttribute('data-e2e-marker', 'sel');
      (window as any).selectMonthDate(ds);
      const selectedNow = document.querySelector(`.cal-cell[data-date="${ds}"]`)?.classList.contains('selected');
      const markerSurvived = !!document.querySelector('.cal-grid.month-grid[data-e2e-marker="sel"]');
      return { selectedNow, markerSurvived };
    });
    expect(result.selectedNow).toBe(true);
    expect(result.markerSurvived).toBe(true);
  });

  test('no navigation occurs after swUpdateAvailable flag flip', async ({ page }) => {
    let navCount = 0;
    page.on('framenavigated', () => { navCount += 1; });

    // Reset counter after the baseline is stable.
    await page.waitForTimeout(100);
    navCount = 0;

    await page.evaluate(() => {
      // The old code did `location.reload()` here; the new code just
      // flips an unobtrusive flag. This must NOT navigate the page.
      (window as any).swUpdateAvailable = true;
    });

    await page.waitForTimeout(500);
    expect(navCount).toBe(0);
  });
});
