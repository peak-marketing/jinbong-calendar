import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

// Clicking a chat image used to window.open('_blank') the raw URL —
// on mobile/PWA that replaced the chat tab so closing it kicked the
// user out of the chat room. The new viewer is a full-screen overlay
// that sits above every other modal and closes cleanly via ✕, Esc, or
// a click on the backdrop.

test.describe('image viewer overlay', () => {
  test('openImageViewer() mounts overlay, closeImageViewer() / ✕ / Esc / backdrop all close it', async ({ page }) => {
    await setupStubs(page);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });

    // openImageViewer mounts an overlay with the image URL visible.
    await page.evaluate(() =>
      (window as any).openImageViewer('https://example.com/test.png')
    );
    await expect(page.locator('#imgViewerOverlay')).toBeVisible();
    await expect(page.locator('#imgViewerOverlay img')).toHaveAttribute(
      'src', 'https://example.com/test.png'
    );

    // ✕ button closes.
    await page.locator('.img-viewer-close').click();
    await expect(page.locator('#imgViewerOverlay')).toHaveCount(0);

    // Open again, close with Esc.
    await page.evaluate(() =>
      (window as any).openImageViewer('https://example.com/test.png')
    );
    await expect(page.locator('#imgViewerOverlay')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#imgViewerOverlay')).toHaveCount(0);

    // Open again, click the dim backdrop (not the image itself).
    await page.evaluate(() =>
      (window as any).openImageViewer('https://example.com/test.png')
    );
    await expect(page.locator('#imgViewerOverlay')).toBeVisible();
    // Click at the top-left of the overlay which is guaranteed to
    // be the backdrop, not the centered image.
    await page.locator('#imgViewerOverlay').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#imgViewerOverlay')).toHaveCount(0);
  });

  test('opening the viewer twice cleanly replaces the previous overlay', async ({ page }) => {
    await setupStubs(page);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });

    await page.evaluate(() => {
      const w = window as any;
      w.openImageViewer('https://example.com/a.png');
      w.openImageViewer('https://example.com/b.png');
    });
    // Only one overlay, and it shows the second image.
    await expect(page.locator('#imgViewerOverlay')).toHaveCount(1);
    await expect(page.locator('#imgViewerOverlay img')).toHaveAttribute(
      'src', 'https://example.com/b.png'
    );
  });

  test('chat image bubble wires onclick to openImageViewer (not window.open)', async ({ page }) => {
    // Static inspection via page.content so we don't need a room with
    // images rendered for the assertion.
    await setupStubs(page);
    await page.goto('/');
    await page.waitForFunction(() => typeof (window as any).buildChatMessageHtml === 'function', { timeout: 15_000 });

    const html = await page.evaluate(() => {
      const w = window as any;
      return w.buildChatMessageHtml({
        id: 'x', uid: 'someone-else', name: 'X',
        imageUrl: 'https://cdn.example/pic.jpg',
        text: '', createdAt: new Date().toISOString(),
      });
    });
    expect(html).toContain("openImageViewer('https://cdn.example/pic.jpg')");
    expect(html).not.toContain("window.open('https://cdn.example/pic.jpg'");
  });
});
