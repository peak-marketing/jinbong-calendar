import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { setupStubs } from './helpers';

const SERVER = fs.readFileSync(path.resolve(__dirname, '../../server/index.js'), 'utf8');

function baseState() {
  const users = [
    { uid: 'e2e-test-user', name: 'Owner', email: 'owner@test.local', role: 'member', approved: true, is_active: true },
    { uid: 'member-kim', name: '김대호', email: 'kim@test.local', role: 'member', approved: true, is_active: true },
  ];
  return {
    events: [],
    ideas: [],
    users,
    chatRooms: [],
    chatMessages: {},
    chatMembers: {},
    chatUnreadCounts: {},
    chatTyping: {},
    chatRoomGroups: [],
    eventChecklist: {},
    eventShares: {},
    groups: [],
  };
}

test.describe('latest chat, typing and mentions', () => {
  test('all chat rooms are ordered by latest activity across groups', async ({ page }) => {
    const state: any = baseState();
    state.chatRoomGroups = [
      { id: 'group-a', name: '업무', color: '#ff6b5f' },
      { id: 'group-b', name: '외부', color: '#5aa7ff' },
    ];
    state.chatRooms = [
      { id: 'old-room', name: '오래된 방', creator_id: 'e2e-test-user', group_id: 'group-a', created_at: '2026-07-01T00:00:00Z' },
      { id: 'new-room', name: '가장 최신 방', creator_id: 'e2e-test-user', group_id: 'group-b', created_at: '2026-07-01T00:00:00Z' },
      { id: 'middle-room', name: '중간 방', creator_id: 'e2e-test-user', group_id: 'group-a', created_at: '2026-07-01T00:00:00Z' },
    ];
    state.chatMessages = {
      'old-room': [{ id: 'm1', text: 'old', uid: 'member-kim', name: '김대호', room_id: 'old-room', created_at: '2026-07-20T01:00:00Z' }],
      'new-room': [{ id: 'm2', text: 'new', uid: 'member-kim', name: '김대호', room_id: 'new-room', created_at: '2026-07-21T08:00:00Z' }],
      'middle-room': [{ id: 'm3', text: 'middle', uid: 'member-kim', name: '김대호', room_id: 'middle-room', created_at: '2026-07-21T05:00:00Z' }],
    };
    state.chatMembers = {
      'old-room': state.users,
      'new-room': state.users,
      'middle-room': state.users,
    };

    await setupStubs(page, state);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.evaluate(() => (window as any).navTo('chat'));
    await page.waitForSelector('#chatRoomListResults .room-item');

    const roomNames = await page.locator('#chatRoomListResults .room-item').evaluateAll(items =>
      items.map(item => String(item.textContent || '').replace(/\s+/g, ' ').trim())
    );
    expect(roomNames[0]).toContain('가장 최신 방');
    expect(roomNames[1]).toContain('중간 방');
    expect(roomNames[2]).toContain('오래된 방');
  });

  test('room opens at the latest message and shows another member typing', async ({ page }) => {
    const state: any = baseState();
    state.chatRooms = [{ id: 'room-1', name: '실시간 방', creator_id: 'e2e-test-user', created_at: '2026-07-21T00:00:00Z' }];
    state.chatMembers = { 'room-1': state.users };
    state.chatTyping = { 'room-1': [{ uid: 'member-kim', name: '김대호' }] };
    state.chatMessages = {
      'room-1': Array.from({ length: 80 }, (_, index) => ({
        id: `m-${index}`,
        text: `메시지 ${index}`,
        uid: index % 2 ? 'member-kim' : 'e2e-test-user',
        name: index % 2 ? '김대호' : 'Owner',
        room_id: 'room-1',
        created_at: new Date(Date.UTC(2026, 6, 21, 0, index)).toISOString(),
      })),
    };

    await setupStubs(page, state);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.evaluate(() => {
      (window as any).navTo('chat');
      (window as any).enterRoom('room-1', '실시간 방');
    });

    await expect(page.locator('#chatTypingIndicator')).toContainText('김대호님이 입력 중');
    await expect.poll(() => page.locator('#chatMsgs').evaluate(el =>
      el.scrollHeight - el.scrollTop - el.clientHeight
    )).toBeLessThan(8);

    await page.evaluate(() => {
      (window as any).__e2e_api_state.chatTyping['room-1'] = [];
      return (window as any).fetchChatTypingState();
    });
    await expect(page.locator('#chatTypingIndicator')).toBeHidden();
  });

  test('@ opens a member picker and sends a mention target', async ({ page }) => {
    const state: any = baseState();
    state.chatRooms = [{ id: 'room-mention', name: '언급 방', creator_id: 'e2e-test-user', created_at: '2026-07-21T00:00:00Z' }];
    state.chatMembers = { 'room-mention': state.users };
    state.chatMessages = { 'room-mention': [] };

    await setupStubs(page, state);
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.evaluate(() => {
      (window as any).navTo('chat');
      (window as any).enterRoom('room-mention', '언급 방');
    });

    const input = page.locator('#chatInput');
    await input.fill('@김');
    await expect(page.locator('#chatMentionMenu')).toBeVisible();
    await page.locator('.chat-mention-option').filter({ hasText: '김대호' }).click();
    await expect(input).toHaveValue('@김대호 ');
    await input.fill('@김대호 확인 부탁드립니다');
    await input.press('Enter');

    await expect.poll(() => page.evaluate(() => (
      (window as any).__e2e_api_state.chatMessages['room-mention']?.length || 0
    ))).toBe(1);
    const sent = await page.evaluate(() => (window as any).__e2e_api_state.chatMessages['room-mention'][0]);
    expect(sent.text).toBe('@김대호 확인 부탁드립니다');
    expect(sent.mention_user_ids).toEqual(['member-kim']);

    await page.evaluate(() => {
      (window as any).__e2e_api_state.chatMessages['room-mention'].push({
        id: 'mention-me', text: '@Owner 확인해주세요', uid: 'member-kim', name: '김대호',
        room_id: 'room-mention', created_at: new Date().toISOString(),
      });
      return (window as any).fetchRoomMessages();
    });
    await expect(page.locator('.msg.mentioned')).toContainText('@Owner');
  });

  test('server typing and mention notifications require room membership', () => {
    const typingGet = SERVER.match(/app\.get\('\/api\/chat-rooms\/:roomId\/typing'[\s\S]*?\n\}\);/);
    const typingPost = SERVER.match(/app\.post\('\/api\/chat-rooms\/:roomId\/typing'[\s\S]*?\n\}\);/);
    const messagesPost = SERVER.match(/app\.post\('\/api\/chat-rooms\/:roomId\/messages'[\s\S]*?\n\}\);/);
    expect(typingGet?.[0]).toContain('isChatRoomMember');
    expect(typingPost?.[0]).toContain('isChatRoomMember');
    expect(messagesPost?.[0]).toContain('chatTextMentionsName');
    expect(messagesPost?.[0]).toContain("kind: isMentioned ? 'chat-mention' : 'chat'");
    expect(SERVER).toContain("kind === 'chat' || kind === 'chat-mention'");
  });
});
