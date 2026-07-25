import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

// The user reported that multiple chat-room popup tabs all display the
// generic "피크마케팅" label, making it impossible to tell one from
// another. These tests pin down the dynamic-title behaviour:
//   1. A standalone chat window's document.title ends up as
//      "<roomName> | 피크마케팅" once the page is live.
//   2. The room name is persisted in localStorage so a subsequent
//      popup can set a usable title from the very first paint,
//      *before* Firebase auth and the API round-trip resolve.
//   3. The head-inline bootstrap actually reads that cache and
//      applies it while the main script is still loading.

const STATE = {
  events: [],
  users: [{ uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local', role: 'admin', approved: true, is_active: true }],
  chatRooms: [
    { id: 'r1', name: '마케팅 기획', member_count: 3, created_at: new Date().toISOString() },
    { id: 'r2', name: '개발팀 데일리', member_count: 5, created_at: new Date().toISOString() },
  ],
  chatMessages: { r1: [], r2: [] },
  chatMembers: { r1: [], r2: [] },
  chatUnreadCounts: {},
};

test.describe('chat tab title', () => {
  test('standalone chat window title ends as "<roomName> | 피크마케팅"', async ({ page }) => {
    await setupStubs(page, STATE as any);
    await page.goto('/?page=chat&roomId=r1&chatWindow=1');

    // Wait until the page has moved past the early-bootstrap placeholder
    // and has the authoritative title.
    await expect.poll(
      async () => page.evaluate(() => document.title),
      { timeout: 5000 }
    ).toMatch(/마케팅 기획/);

    expect(await page.title()).toBe('마케팅 기획 | 피크마케팅');
  });

  test('entering a room persists its name into localStorage', async ({ page }) => {
    await setupStubs(page, STATE as any);
    await page.goto('/?page=chat&roomId=r2&chatWindow=1');
    await expect.poll(
      async () => page.evaluate(() => document.title),
      { timeout: 5000 }
    ).toMatch(/개발팀 데일리/);

    const cached = await page.evaluate(
      () => JSON.parse(localStorage.getItem('peakChatRoomNames') || '{}')
    );
    expect(cached.r2).toBe('개발팀 데일리');
  });

  test('early <head> bootstrap applies cached name on first paint', async ({ page, context }) => {
    // First run populates the localStorage cache.
    await setupStubs(page, STATE as any);
    await page.goto('/?page=chat&roomId=r1&chatWindow=1');
    await expect.poll(
      async () => page.evaluate(() => document.title),
      { timeout: 5000 }
    ).toMatch(/마케팅 기획/);
    await page.close();

    // Second run: same origin, same localStorage, but intercept the
    // API so the room list never arrives. The title must still end
    // up with the cached room name — proof that the bootstrap path
    // is doing its job before the main script's rendering runs.
    const page2 = await context.newPage();
    await setupStubs(page2);
    await page2.route('**/api/chat-rooms', route =>
      // Hang so chatRooms stays empty for the whole test.
      new Promise(() => void route)
    );
    await page2.goto('/?page=chat&roomId=r1&chatWindow=1');
    await page2.waitForTimeout(400);
    const title = await page2.title();
    expect(title).toBe('마케팅 기획 | 피크마케팅');
  });
});
