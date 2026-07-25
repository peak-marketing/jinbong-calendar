import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

// Two user-visible features that landed together:
//
// (A) In-room message search — a 🔍 button in the chat-room header
//     opens an inline bar identical in spirit to KakaoTalk's 대화내용
//     검색: typing highlights matching bubbles, ↑/↓ navigates between
//     them, Esc closes.
//
// (B) Popup dedupe — clicking the same chat room again (or an admin
//     pushing "새 창으로 열기" twice) must refocus the existing popup
//     instead of spawning a second one.

function stateWithRoom(messages: Array<{ id: string; text: string }>) {
  return {
    events: [],
    users: [{
      uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local',
      role: 'admin', approved: true, is_active: true,
    }],
    chatRooms: [{ id: 'r1', name: '프로젝트방', member_count: 2, creator_id: 'e2e-test-user', created_at: new Date().toISOString() }],
    chatMessages: {
      r1: messages.map(m => ({
        id: m.id, text: m.text, uid: 'e2e-test-user',
        name: 'E2E', photo_url: '', image_url: '', file_url: '', file_name: '',
        room_id: 'r1', created_at: new Date().toISOString(),
      })),
    },
    chatMembers: { r1: [] },
    chatUnreadCounts: {},
  };
}

test.describe('in-room message search', () => {
  test.beforeEach(async ({ page }) => {
    const state = stateWithRoom([
      { id: 'm1', text: '안녕 점심 뭐 먹지' },
      { id: 'm2', text: '나는 부가세 정리 중' },
      { id: 'm3', text: '부가세 납부일 내일임' },
      { id: 'm4', text: '오늘 날씨 좋다' },
      { id: 'm5', text: '부가세 확인 부탁해' },
    ]);
    await setupStubs(page, state as any);
    page.on('pageerror', err => console.error('[pageerror]', err.message));
    await page.goto('/');
    // Default admin user lands on calendar; switch to chat tab.
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.evaluate(() => (window as any).navTo('chat'));
    await page.waitForFunction(
      () => document.getElementById('mainBody')?.innerHTML.includes('chatRoomSearchInput'),
      { timeout: 15_000 }
    );
    // Open the room and wait for the messages to land.
    await page.evaluate(() => (window as any).enterRoom('r1', '프로젝트방'));
    await page.waitForSelector('.msg-bubble', { timeout: 10_000 });
  });

  test('🔍 button toggles the inline search bar', async ({ page }) => {
    await expect(page.locator('#chatSearchBar')).toBeHidden();
    await page.evaluate(() => (window as any).toggleChatSearchBar());
    await expect(page.locator('#chatSearchBar')).toBeVisible();
    await page.evaluate(() => (window as any).toggleChatSearchBar());
    await expect(page.locator('#chatSearchBar')).toBeHidden();
  });

  test('typing highlights matching bubbles and counts them', async ({ page }) => {
    await page.evaluate(() => (window as any).toggleChatSearchBar());
    await page.evaluate(() => (window as any).onChatSearchInput('부가세'));

    const hits = await page.locator('.msg-bubble.chat-search-hit').count();
    expect(hits).toBe(3);
    const active = await page.locator('.msg-bubble.chat-search-hit-active').count();
    expect(active).toBe(1);
    const counter = await page.locator('#chatSearchCount').textContent();
    // Three matches total, starts cursored on the most recent hit.
    expect(counter).toMatch(/3\s*\/\s*3/);
  });

  test('↑ / ↓ navigate between matches and wrap around', async ({ page }) => {
    await page.evaluate(() => (window as any).toggleChatSearchBar());
    await page.evaluate(() => (window as any).onChatSearchInput('부가세'));

    // Starting cursor = last (3/3). Nav down wraps to 1/3.
    await page.evaluate(() => (window as any).chatSearchNav(1));
    expect(await page.locator('#chatSearchCount').textContent()).toMatch(/1\s*\/\s*3/);
    await page.evaluate(() => (window as any).chatSearchNav(1));
    expect(await page.locator('#chatSearchCount').textContent()).toMatch(/2\s*\/\s*3/);
    // Nav up from 2 lands on 1.
    await page.evaluate(() => (window as any).chatSearchNav(-1));
    expect(await page.locator('#chatSearchCount').textContent()).toMatch(/1\s*\/\s*3/);
  });

  test('empty query clears all hits, zero counter', async ({ page }) => {
    await page.evaluate(() => (window as any).toggleChatSearchBar());
    await page.evaluate(() => (window as any).onChatSearchInput('부가세'));
    expect(await page.locator('.msg-bubble.chat-search-hit').count()).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).onChatSearchInput(''));
    expect(await page.locator('.msg-bubble.chat-search-hit').count()).toBe(0);
    expect(await page.locator('#chatSearchCount').textContent()).toMatch(/0\s*\/\s*0/);
  });

  test('Ctrl+F opens the search bar and focuses the input', async ({ page }) => {
    await expect(page.locator('#chatSearchBar')).toBeHidden();
    // Dispatch a synthetic Ctrl+F keydown — Playwright's keyboard.press
    // would otherwise be swallowed by DevTools' built-in find-in-page
    // on some browsers. Going through the raw event API triggers the
    // same path the page would see from a real user keystroke.
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'f', ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });
    await expect(page.locator('#chatSearchBar')).toBeVisible();
    const focused = await page.evaluate(() => document.activeElement?.id);
    expect(focused).toBe('chatSearchInput');
  });

  test('Cmd+F also opens the search bar (macOS-style)', async ({ page }) => {
    await expect(page.locator('#chatSearchBar')).toBeHidden();
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'f', metaKey: true, bubbles: true, cancelable: true,
      }));
    });
    await expect(page.locator('#chatSearchBar')).toBeVisible();
  });

  test('close bar (✕) wipes query + highlights', async ({ page }) => {
    await page.evaluate(() => (window as any).toggleChatSearchBar());
    await page.evaluate(() => (window as any).onChatSearchInput('부가세'));
    expect(await page.locator('.msg-bubble.chat-search-hit').count()).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).closeChatSearchBar());
    await expect(page.locator('#chatSearchBar')).toBeHidden();
    expect(await page.locator('.msg-bubble.chat-search-hit').count()).toBe(0);
  });
});

test.describe('chat room list search Korean IME', () => {
  test('composition updates keep the input node mounted and preserve completed Hangul', async ({ page }) => {
    const state = {
      events: [],
      users: [{
        uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local',
        role: 'admin', approved: true, is_active: true,
      }],
      chatRooms: [
        { id: 'r1', name: '대호 채팅방', member_count: 2, creator_id: 'e2e-test-user', created_at: '2026-04-27T00:00:00.000Z' },
        { id: 'r2', name: '리뷰스페이스', member_count: 2, creator_id: 'e2e-test-user', created_at: '2026-04-26T00:00:00.000Z' },
      ],
      chatMessages: { r1: [], r2: [] },
      chatMembers: { r1: [], r2: [] },
      chatUnreadCounts: {},
      chatRoomGroups: [],
    };
    await setupStubs(page, state as any);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.evaluate(() => (window as any).navTo('chat'));
    await page.waitForSelector('#chatRoomSearchInput', { timeout: 10_000 });

    const result = await page.evaluate(() => {
      const w = window as any;
      const body = document.getElementById('mainBody')!;
      const input = document.getElementById('chatRoomSearchInput') as HTMLInputElement;
      input.focus();
      const before = input;

      input.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
      input.value = 'ㄷ';
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: 'ㄷ',
        inputType: 'insertCompositionText',
        isComposing: true,
      } as InputEventInit));

      // Simulate the production 5s chat-list refresh that used to
      // recreate the search input mid-composition and decompose 한글.
      w.renderChatRoomList(body);
      const sameDuringComposition = document.getElementById('chatRoomSearchInput') === before;

      before.value = '대호';
      before.dispatchEvent(new CompositionEvent('compositionend', { data: '대호' }));
      before.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: '대호',
        inputType: 'insertText',
      }));

      const after = document.getElementById('chatRoomSearchInput') as HTMLInputElement;
      return {
        sameDuringComposition,
        sameAfterComposition: after === before,
        value: after.value,
        resultText: document.getElementById('chatRoomListResults')?.textContent || '',
      };
    });

    expect(result.sameDuringComposition).toBe(true);
    expect(result.sameAfterComposition).toBe(true);
    expect(result.value).toBe('대호');
    expect(result.resultText).toContain('대호 채팅방');
    expect(result.resultText).not.toContain('리뷰스페이스');
  });
});

test.describe('chat popup dedupe', () => {
  test('openChatRoomInWindow twice reuses the same popup', async ({ page }) => {
    const state = stateWithRoom([]);
    await setupStubs(page, state as any);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });

    const count = await page.evaluate(() => {
      const w = window as any;
      let opened = 0;
      const orig = window.open;
      // Pretend every window.open succeeds — track how many times it
      // was actually called (dedupe should skip the 2nd call).
      (window as any).open = function (...args: any[]) {
        opened += 1;
        return { closed: false, focus: () => {} } as any;
      };
      try {
        w.openChatRoomInWindow('r1');
        w.openChatRoomInWindow('r1');
        w.openChatRoomInWindow('r1');
      } finally {
        (window as any).open = orig;
      }
      return opened;
    });
    expect(count).toBe(1);
  });

  test('a closed popup allows a fresh window.open', async ({ page }) => {
    const state = stateWithRoom([]);
    await setupStubs(page, state as any);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });

    const count = await page.evaluate(() => {
      const w = window as any;
      let opened = 0;
      let returned: any;
      (window as any).open = function () {
        opened += 1;
        returned = { closed: false, focus: () => {} };
        return returned;
      };
      w.openChatRoomInWindow('r1');
      // Simulate the user closing the first popup.
      returned.closed = true;
      w.openChatRoomInWindow('r1');
      return opened;
    });
    expect(count).toBe(2);
  });

  // The dedupe winner is chosen by visibility: a *visible* older peer
  // kicks the newcomer; a *hidden* older peer steps aside for the
  // newcomer. That's the only way to escape the "ghost popup" loop
  // users hit when an invisible stale popup kept killing every fresh
  // click.

  test('visible older popup KICKS the new popup (active session preserved)', async ({ context }) => {
    await context.addInitScript(() => {
      const w = window as any;
      w.__closeCalled = 0;
      w.__focusCalled = 0;
      const origFocus = window.focus.bind(window);
      window.close = () => { w.__closeCalled += 1; };
      window.focus = () => { w.__focusCalled += 1; try { origFocus(); } catch (_) {} };
      // Force visible for both tabs in this test.
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    });

    const pageA = await context.newPage();
    await setupStubs(pageA);
    await pageA.goto('/?page=chat&chatWindow=1&roomId=rdup1');
    await pageA.waitForTimeout(200);

    const pageB = await context.newPage();
    await setupStubs(pageB);
    await pageB.goto('/?page=chat&chatWindow=1&roomId=rdup1');
    await pageB.waitForTimeout(400);

    const aState = await pageA.evaluate(() => (window as any).__closeCalled);
    const bState = await pageB.evaluate(() => (window as any).__closeCalled);
    // Active older A stays; newer B is kicked.
    expect(aState).toBe(0);
    expect(bState).toBeGreaterThanOrEqual(1);
  });

  test('hidden older popup yields to the new popup (ghost popup unblocks user)', async ({ context }) => {
    const pageA = await context.newPage();
    // Older popup pretends to be hidden (the ghost scenario).
    await pageA.addInitScript(() => {
      (window as any).__closeCalled = 0;
      window.close = () => { (window as any).__closeCalled += 1; };
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    });
    await setupStubs(pageA);
    await pageA.goto('/?page=chat&chatWindow=1&roomId=rdup2');
    await pageA.waitForTimeout(200);

    // New popup is visible (the user's actual click).
    const pageB = await context.newPage();
    await pageB.addInitScript(() => {
      (window as any).__closeCalled = 0;
      window.close = () => { (window as any).__closeCalled += 1; };
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    });
    await setupStubs(pageB);
    await pageB.goto('/?page=chat&chatWindow=1&roomId=rdup2');
    await pageB.waitForTimeout(400);

    const aClose = await pageA.evaluate(() => (window as any).__closeCalled);
    const bClose = await pageB.evaluate(() => (window as any).__closeCalled);
    // Hidden ghost (A) closes itself; visible newcomer (B) survives.
    expect(aClose).toBeGreaterThanOrEqual(1);
    expect(bClose).toBe(0);
  });

  test('single standalone chat window does NOT self-close', async ({ context }) => {
    await context.addInitScript(() => {
      (window as any).__closeCalled = 0;
      const origClose = window.close.bind(window);
      window.close = () => { (window as any).__closeCalled += 1; };
    });
    const page = await context.newPage();
    await setupStubs(page);
    await page.goto('/?page=chat&chatWindow=1&roomId=solo');
    await page.waitForTimeout(300);
    const closeCalled = await page.evaluate(() => (window as any).__closeCalled);
    expect(closeCalled).toBe(0);
  });
});
