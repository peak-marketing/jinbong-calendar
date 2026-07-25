import { test, expect, Page } from '@playwright/test';
import { defaultApiState, setupStubs } from './helpers';

function buildChatState() {
  const state = defaultApiState();
  state.users = [
    {
      uid: 'e2e-test-user',
      name: 'E2E Test',
      email: 'e2e@test.local',
      role: 'admin',
      approved: true,
      is_active: true,
    },
    {
      uid: 'peer-user',
      name: '동료',
      email: 'peer@test.local',
      role: 'member',
      approved: true,
      is_active: true,
    },
  ];
  state.chatRooms = [
    {
      id: 'room-alpha',
      name: '알파룸',
      creator_id: 'e2e-test-user',
      created_at: '2026-04-21T09:00:00.000Z',
      delete_requested: false,
    },
    {
      id: 'room-beta',
      name: '베타룸',
      creator_id: 'e2e-test-user',
      created_at: '2026-04-21T09:01:00.000Z',
      delete_requested: false,
    },
  ];
  state.chatMembers = {
    'room-alpha': [
      { uid: 'e2e-test-user', name: 'E2E Test', email: 'e2e@test.local', photo_url: '', is_creator: true },
      { uid: 'peer-user', name: '동료', email: 'peer@test.local', photo_url: '', is_creator: false },
    ],
    'room-beta': [
      { uid: 'e2e-test-user', name: 'E2E Test', email: 'e2e@test.local', photo_url: '', is_creator: true },
      { uid: 'peer-user', name: '동료', email: 'peer@test.local', photo_url: '', is_creator: false },
    ],
  };
  state.chatMessages = {
    'room-alpha': [
      {
        id: 'alpha-1',
        text: '기존 알파 메시지',
        uid: 'peer-user',
        name: '동료',
        photo_url: '',
        image_url: '',
        file_url: '',
        file_name: '',
        room_id: 'room-alpha',
        created_at: '2026-04-21T09:05:00.000Z',
      },
    ],
    'room-beta': [
      {
        id: 'beta-1',
        text: '기존 베타 메시지',
        uid: 'peer-user',
        name: '동료',
        photo_url: '',
        image_url: '',
        file_url: '',
        file_name: '',
        room_id: 'room-beta',
        created_at: '2026-04-21T09:06:00.000Z',
      },
    ],
  };
  state.chatUnreadCounts = {
    'room-alpha': 0,
    'room-beta': 0,
  };
  return state;
}

async function pushIncomingMessage(page: Page, roomId: string, text: string, createdAt: string) {
  await page.evaluate(({ roomId, text, createdAt }) => {
    const state = (window as any).__e2e_api_state;
    state.chatMessages = state.chatMessages || {};
    state.chatMessages[roomId] = state.chatMessages[roomId] || [];
    state.chatMessages[roomId].push({
      id: `incoming-${Date.now()}`,
      text,
      uid: 'peer-user',
      name: '동료',
      photo_url: '',
      image_url: '',
      file_url: '',
      file_name: '',
      room_id: roomId,
      created_at: createdAt,
    });
    state.chatUnreadCounts = state.chatUnreadCounts || {};
    state.chatUnreadCounts[roomId] = (state.chatUnreadCounts[roomId] || 0) + 1;
  }, { roomId, text, createdAt });
}

test.describe('chat room realtime UX', () => {
  test.beforeEach(async ({ page }) => {
    await setupStubs(page, buildChatState());
  });

  test('chat room list updates latest preview without reload', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.evaluate(() => (window as any).navTo('chat'));

    const roomItems = page.locator('.room-item');
    await expect(roomItems).toHaveCount(2);
    await expect(roomItems.first()).toContainText('베타룸');
    await expect(roomItems.first()).toContainText('동료: 기존 베타 메시지');

    await pushIncomingMessage(page, 'room-alpha', '실시간 새 메시지', '2026-04-21T09:10:00.000Z');

    await expect.poll(async () => roomItems.first().innerText(), { timeout: 8_000 }).toContain('알파룸');
    await expect.poll(async () => roomItems.first().innerText(), { timeout: 8_000 }).toContain('동료: 실시간 새 메시지');
  });

  test('standalone chat room title shows the room name', async ({ page }) => {
    await page.goto('/?page=chat&roomId=room-alpha&chatWindow=1');

    await expect(page.locator('#mainTitle')).toHaveText('알파룸', { timeout: 15_000 });
    await expect(page).toHaveTitle(/알파룸/, { timeout: 15_000 });
  });
});