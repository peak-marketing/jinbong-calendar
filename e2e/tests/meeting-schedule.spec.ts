import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const MEETING = {
  id: 'mt1', mediumId: 'm1', smallId: null,
  title: '8월 단가 확정 회의', description: '공급사 단가표 검토', location: '본사 회의실',
  startDate: '2026-08-20', endDate: '2026-08-20', startTime: '17:30', endTime: '19:00',
  organizer: { uid: 'l', name: '전현우' }, status: 'scheduled', version: 1, eventId: 'e1',
  attendees: [{ uid: 'e2e-test-user', name: '김대호' }],
};
const PROJECT = {
  id: 'p1', name: '매출', description: '', status: 'active', version: 1,
  lead: { uid: 'l', name: '전현우', rank: '팀장' },
  members: [{ uid: 'l', name: '전현우', rank: '팀장', active: true },
    { uid: 'e2e-test-user', name: '김대호', rank: '부장', active: true }],
  mediumCategories: [{
    id: 'm1', name: '인스타그램', manager: { uid: 'l', name: '전현우' }, meetings: [MEETING],
    smallCategories: [{ id: 's1', name: '단가체크', tasks: [], meetings: [] }],
  }],
  capabilities: { manageProject: true },
};

async function open(page, { onCreate = null } = {}) {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/new-projects', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ readOnly: false, capabilities: { viewPortfolio: true, createProject: true }, projects: [PROJECT] }) }));
  await page.route('**/new-projects/p1/mediums/m1/meetings', async route => {
    onCreate?.(route.request().postDataJSON());
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ meeting: MEETING }) });
  });
  await page.route('**/new-projects/p1', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ readOnly: false, capabilities: { manageProject: true }, project: PROJECT }) }));
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="new-projects"]').click();
  await page.locator('[data-structured-project-open="p1"]').click();
}

test('잡힌 회의는 분류 안에 일정·주최자·참석자와 함께 보인다', async ({ page }) => {
  await open(page);
  const meeting = page.locator('.structured-meeting');
  await expect(meeting).toHaveCount(1);
  // 시작~종료가 한 줄로 읽혀야 한다.
  await expect(meeting.locator('.structured-meeting-when')).toHaveText('2026-08-20 17:30~19:00');
  await expect(meeting).toContainText('8월 단가 확정 회의');
  await expect(meeting).toContainText('본사 회의실');
  await expect(meeting.locator('.structured-meeting-people')).toContainText('전현우');
  await expect(meeting.locator('.structured-meeting-people')).toContainText('김대호');
});

test('회의 일정 버튼을 누르면 주최자·참석자·기간·장소를 정해 보낸다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onCreate: body => { sent = body; } });

  await page.locator('.structured-split-head [data-structured-meeting-create]').click();
  const form = page.locator('#structuredMeetingForm');
  await expect(form).toBeVisible();

  await form.locator('[name="title"]').fill('9월 킥오프');
  await form.locator('[name="location"]').fill('구글 미트');
  await form.locator('[name="organizerUid"]').selectOption('l');
  await form.locator('[name="startDate"]').fill('2026-09-01');
  await form.locator('[name="endDate"]').fill('2026-09-02');
  await form.locator('[name="startTime"]').fill('10:00');
  await form.locator('[name="endTime"]').fill('11:30');
  await form.locator('[name="description"]').fill('분기 목표 정리');
  await form.locator('.structured-meeting-attendee input[value="e2e-test-user"]').check();
  await form.locator('button[type="submit"]').click();

  await expect.poll(() => sent).not.toBeNull();
  expect(sent).toEqual({
    title: '9월 킥오프', description: '분기 목표 정리', location: '구글 미트',
    startDate: '2026-09-01', endDate: '2026-09-02', startTime: '10:00', endTime: '11:30',
    organizerUid: 'l', attendeeUids: ['e2e-test-user'],
  });
});

test('종료일·종료 시간이 거꾸로면 보내지 않고 막는다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onCreate: body => { sent = body; } });
  await page.locator('.structured-split-head [data-structured-meeting-create]').click();
  const form = page.locator('#structuredMeetingForm');
  await form.locator('[name="title"]').fill('거꾸로 회의');
  await form.locator('[name="startDate"]').fill('2026-09-10');
  await form.locator('[name="endDate"]').fill('2026-09-09');
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('.toast, [data-toast]').first()).toContainText('종료일이 시작일보다 빠릅니다');

  // 같은 날인데 끝나는 시각이 더 이르면 그것도 막는다.
  await form.locator('[name="endDate"]').fill('2026-09-10');
  await form.locator('[name="startTime"]').fill('15:00');
  await form.locator('[name="endTime"]').fill('14:00');
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('.toast, [data-toast]').first()).toContainText('종료 시간이 시작 시간보다');
  expect(sent).toBeNull();
});

test('보드 보기에서도 회의를 잡되, 중분류를 먼저 고르게 한다', async ({ page }) => {
  let sent: any = null;
  await open(page, { onCreate: body => { sent = body; } });
  await page.locator('[data-structured-task-view="board"]').click();

  // 보드는 여러 중분류를 한 번에 본다. 어디에 잡을지 모른 채로 열지 않는다.
  await page.locator('[data-structured-board-meeting]').click();
  await expect(page.locator('.toast, [data-toast]').first()).toContainText('업무 중분류를 위 필터에서 먼저');
  await expect(page.locator('#structuredMeetingForm')).toHaveCount(0);

  await page.locator('[data-structured-board-medium-filter]').selectOption('m1');
  await page.locator('[data-structured-board-meeting]').click();
  const form = page.locator('#structuredMeetingForm');
  await expect(form).toBeVisible();
  await form.locator('[name="title"]').fill('보드에서 잡은 회의');
  await form.locator('[name="startDate"]').fill('2026-09-05');
  await form.locator('button[type="submit"]').click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent.title).toBe('보드에서 잡은 회의');
  expect(sent.startDate).toBe('2026-09-05');
});

test('보드 검색칸은 테두리 안에 들어맞는다', async ({ page }) => {
  await open(page);
  await page.locator('[data-structured-task-view="board"]').click();
  // 안쪽 input이 상자보다 크면 테두리와 돋보기를 덮어 상자가 깨져 보인다.
  const fit = await page.evaluate(() => {
    const box = document.querySelector('.structured-board-search') as HTMLElement;
    const input = box.querySelector('input') as HTMLElement;
    return {
      boxH: Math.round(box.getBoundingClientRect().height),
      inputH: Math.round(input.getBoundingClientRect().height),
      bg: getComputedStyle(input).backgroundColor,
      iconVisible: (box.querySelector('span') as HTMLElement).getBoundingClientRect().width > 0,
    };
  });
  expect(fit.inputH).toBeLessThanOrEqual(fit.boxH);
  expect(fit.bg).toBe('rgba(0, 0, 0, 0)');
  expect(fit.iconVisible).toBe(true);
});
