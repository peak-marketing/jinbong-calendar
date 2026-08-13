import { expect, test, type Page } from '@playwright/test';
import { setupStubs } from './helpers';

const THEME_KEY = 'peakos-color-theme-v1';

async function openOs(page: Page) {
  await setupStubs(page);
  await page.route('**/api/users/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local', role: 'admin',
      approved: true, is_active: true, group_name: '본사 경영지원팀', group_type: 'support',
    }),
  }));
  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#themeToggle')).toBeVisible();
}

test.describe('OS colour theme toggle', () => {
  test('starts light, switches in place, persists across reload, and restores light', async ({ page }) => {
    await openOs(page);

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('#themeToggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#themeToggle')).toHaveAttribute('title', '다크 모드로 변경');
    await expect(page.locator('#themeToggle .theme-toggle-label')).toHaveText('다크');

    await page.locator('#themeToggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#themeToggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#themeToggle')).toHaveAttribute('title', '라이트 모드로 변경');
    await expect(page.locator('#themeToggle .theme-toggle-label')).toHaveText('라이트');
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), THEME_KEY)).toBe('dark');

    await page.reload();
    await expect(page.locator('#authGate')).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#themeToggle')).toHaveAttribute('aria-pressed', 'true');

    await page.locator('#themeToggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('#themeToggle')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), THEME_KEY)).toBe('light');
  });

  test('mobile control keeps a 44px touch target and its accessible state', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openOs(page);

    const toggle = page.locator('#themeToggle');
    const box = await toggle.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);

    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveAttribute('title', '라이트 모드로 변경');
    await expect(page.locator('.theme-toggle-icon')).toHaveText('☀');
  });
});
