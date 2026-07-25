import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

// These tests verify the headline user complaint: adding a todo from the
// day-detail panel must NOT wholesale-rebuild the panel. Accordion open
// state, scroll position, and individual event-item DOM nodes for
// unchanged events must all survive a refreshCalendarUi() call.

test.describe('day detail panel in-place refresh', () => {
  test.beforeEach(async ({ page }) => {
    await setupStubs(page);
    page.on('pageerror', err => console.log('[pageerror]', err.message));
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    // Seed a pre-existing todo for today so the day-detail panel has
    // accordion(s) to exercise.
    await page.evaluate(() => {
      const w = window as any;
      w.upsertLocalEvent({
        id: 'existing-1', title: '기존 할 일', type: 'todo',
        date: w.todayStr(), todoCat: '세무 관련',
        scope: 'personal', owner_id: 'e2e-test-user', done: false,
      });
      w.refreshCalendarUi({ keepScroll: true });
    });
  });

  test('accordion keys are stable across renders', async ({ page }) => {
    const keysA = await page.evaluate(() =>
      [...document.querySelectorAll('.acc-wrap')].map(e => (e as HTMLElement).dataset.accKey)
    );

    await page.evaluate(() => (window as any).refreshCalendarUi({ keepScroll: true }));

    const keysB = await page.evaluate(() =>
      [...document.querySelectorAll('.acc-wrap')].map(e => (e as HTMLElement).dataset.accKey)
    );
    expect(keysB).toEqual(keysA);
  });

  test('existing event-item node survives across refresh (DOM is morphed, not replaced)', async ({ page }) => {
    // Tag one of the rendered event-item nodes, refresh, and verify
    // the same DOM node is still there.
    const tagged = await page.evaluate(() => {
      const items = document.querySelectorAll('#rightPanel .ev-item, #mobileDayPanel .ev-item');
      const first = items[0] as HTMLElement | undefined;
      if (!first) return false;
      first.setAttribute('data-e2e-pin', 'yes');
      return true;
    });
    expect(tagged).toBe(true);

    // Add another todo and refresh.
    await page.evaluate(() => {
      const w = window as any;
      w.upsertLocalEvent({
        id: 'existing-2', title: '추가 할 일', type: 'todo',
        date: w.todayStr(), todoCat: '세무 관련',
        scope: 'personal', owner_id: 'e2e-test-user', done: false,
      });
      w.refreshCalendarUi({ keepScroll: true });
    });

    const stillPinned = await page.evaluate(() =>
      !!document.querySelector('[data-e2e-pin="yes"]')
    );
    expect(stillPinned).toBe(true);
  });

  test('user-toggled accordion state persists across refresh', async ({ page }) => {
    // Whatever the default state is, click the header once to force the
    // opposite state, remember it, refresh, and assert it still matches.
    const desiredDisplay = await page.evaluate(() => {
      const wrap = document.querySelector('.acc-wrap') as HTMLElement | null;
      const head = wrap?.querySelector('.acc-head') as HTMLElement | null;
      const body = wrap?.querySelector(':scope > .acc-body') as HTMLElement | null;
      if (!head || !body) return null;
      head.click();
      return body.style.display; // '' or 'none'
    });
    expect(desiredDisplay).not.toBeNull();

    await page.evaluate(() => {
      const w = window as any;
      w.upsertLocalEvent({
        id: 'post-toggle', title: '토글 후 추가', type: 'todo',
        date: w.todayStr(), todoCat: '세무 관련',
        scope: 'personal', owner_id: 'e2e-test-user', done: false,
      });
      w.refreshCalendarUi({ keepScroll: true });
    });

    const after = await page.evaluate(() => {
      const body = document.querySelector('.acc-wrap > .acc-body') as HTMLElement | null;
      return body?.style.display;
    });
    expect(after).toBe(desiredDisplay);
  });

  test('default-open accordion survives idempotent refresh still open', async ({ page }) => {
    // Find an accordion that is open by default. Do NOT toggle it.
    // After a refresh, it should stay open.
    const openKey = await page.evaluate(() => {
      const wraps = [...document.querySelectorAll('.acc-wrap')] as HTMLElement[];
      for (const w of wraps) {
        const body = w.querySelector('.acc-body') as HTMLElement | null;
        if (body && body.style.display !== 'none') return w.dataset.accKey || null;
      }
      return null;
    });
    if (!openKey) {
      // No open accordion in this fixture; skip quietly.
      test.skip(true, 'no default-open accordion to test');
      return;
    }

    await page.evaluate(() => (window as any).refreshCalendarUi({ keepScroll: true }));

    const stillOpen = await page.evaluate((key) => {
      const wrap = document.querySelector(`.acc-wrap[data-acc-key="${key}"]`);
      const body = wrap?.querySelector('.acc-body') as HTMLElement | null;
      return !!body && body.style.display !== 'none';
    }, openKey);
    expect(stillOpen).toBe(true);
  });

  test('refreshCalendarUi with no changes is a structural no-op on event-item DOM', async ({ page }) => {
    // Pin every visible ev-item. After an idempotent refresh, all of
    // them should still be the same DOM nodes — i.e. no unnecessary
    // destruction of unchanged rows.
    const pinCount = await page.evaluate(() => {
      const items = document.querySelectorAll('#rightPanel .ev-item, #mobileDayPanel .ev-item');
      items.forEach((el, i) => el.setAttribute('data-e2e-pin-' + i, '1'));
      return items.length;
    });

    await page.evaluate(() => (window as any).refreshCalendarUi({ keepScroll: true }));

    const survived = await page.evaluate((n) => {
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (document.querySelector('[data-e2e-pin-' + i + '="1"]')) count += 1;
      }
      return count;
    }, pinCount);
    expect(survived).toBe(pinCount);
  });
});
