import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

// When a standalone chat popup is opened while the browser is
// minimized or in the background, Chrome aggressively throttles its
// timers/fetches and Firebase auth.onAuthStateChanged can take tens
// of seconds to fire. Without a recovery path, the splash screen
// ("피크마케팅") is visible forever from the user's perspective.
// The watchdog shows a "다시 시도" button when the splash is still up
// 8s after page load, and again 3s after the page becomes visible
// (e.g. the user brings the window forward).

async function blockAuthResolution(page: import('@playwright/test').Page) {
  // Replace onAuthStateChanged with a no-op before the page scripts
  // see it, so the splash stays visible and we can observe the
  // watchdog in isolation.
  await page.addInitScript(() => {
    // The helpers.ts firebase stub runs first; this wins.
    const orig = (window as any).firebase;
    Object.defineProperty(window, 'firebase', {
      configurable: true,
      get() { return orig; },
      set(v) {
        // When the page scripts assign firebase (they don't, but just in case).
        Object.defineProperty(window, 'firebase', { value: v });
      },
    });
    // Override auth() to return a stub whose onAuthStateChanged never fires.
    const origAuth = orig && orig.auth;
    if (origAuth) {
      const frozen = {
        currentUser: null,
        onAuthStateChanged() { /* intentionally never calls cb */ return () => {}; },
        signInWithPopup: async () => ({}),
        signInWithRedirect: async () => undefined,
        getRedirectResult: async () => ({ user: null }),
        signOut: async () => {},
        setPersistence: async () => {},
      };
      (window as any).firebase.auth = Object.assign(() => frozen, origAuth);
    }
  });
}

test.describe('splash watchdog', () => {
  test('shows "다시 시도" banner when splash is still visible 8s after load', async ({ page }) => {
    await setupStubs(page);
    await blockAuthResolution(page);
    await page.goto('/');
    // Confirm splash is up and no banner yet.
    await expect(page.locator('#splashScreen')).toBeVisible();
    await expect(page.locator('#splashStuckBanner')).toHaveCount(0);
    // Wait for the 8s watchdog to fire, plus a small buffer.
    await page.waitForSelector('#splashStuckBanner', { timeout: 12_000 });
    await expect(page.locator('#splashStuckBanner')).toBeVisible();
    await expect(page.locator('#splashStuckBanner button')).toContainText('다시 시도');
  });

  test('watchdog is cancelled once the app successfully shows a screen', async ({ page }) => {
    // Normal boot — default stub resolves auth fast. The banner must
    // NOT appear and the watchdog must stop before its 8s deadline.
    const stuckBannerSeen = { seen: false };
    page.on('request', () => {}); // ensure page handlers work
    await setupStubs(page);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    // Give the watchdog's 8s deadline plenty of margin — it should
    // already have been cleared in showScreen().
    await page.waitForTimeout(9_000);
    const bannerCount = await page.locator('#splashStuckBanner').count();
    expect(bannerCount).toBe(0);
  });

  test('becoming visible while splash is up re-arms the watchdog with a 3s delay', async ({ page }) => {
    await setupStubs(page);
    await blockAuthResolution(page);
    await page.goto('/');
    await expect(page.locator('#splashScreen')).toBeVisible();
    // Simulate: page becomes hidden, then visible again (e.g. user
    // brings the window forward after unminimizing the browser).
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // The 3s visibility-driven watchdog should fire well before the
    // original 8s one.
    await page.waitForSelector('#splashStuckBanner', { timeout: 6_000 });
  });
});
