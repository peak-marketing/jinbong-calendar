import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const ITEM = { id: 'ai1', title: '공급사에 단가 확정 회신', assignee: { uid: 'e2e-test-user', name: '김대호' }, dueDate: '2026-08-22', taskId: null };
const MEETING = {
  id: 'mt1', mediumId: 'm1', smallId: 's1',
  title: '8월 단가 확정 회의', description: '', location: '본사 회의실',
  startDate: '2026-08-20', endDate: '2026-08-20', startTime: '17:30', endTime: '19:00',
  organizer: { uid: 'l', name: '전현우' }, status: 'scheduled', version: 2, eventId: 'e1',
  notes: '퍼니지 단가 8,200원으로 확정', notesWrittenAt: null, notesWrittenBy: null,
  attendees: [{ uid: 'e2e-test-user', name: '김대호' }], actionItems: [ITEM],
};
const PROJECT = {
  id: 'p1', name: '매출', description: '', status: 'active', version: 1,
  lead: { uid: 'l', name: '전현우', rank: '팀장' },
  members: [{ uid: 'l', name: '전현우', rank: '팀장', active: true },
    { uid: 'e2e-test-user', name: '김대호', rank: '부장', active: true }],
  mediumCategories: [{
    id: 'm1', name: '인스타그램', manager: { uid: 'l', name: '전현우' }, meetings: [],
    smallCategories: [{ id: 's1', name: '단가체크', tasks: [], meetings: [MEETING] }],
  }],
  capabilities: { manageProject: true },
};

async function open(page, handlers: any = {}) {
  await installFirebaseStub(page);
  await installPeakosStub(page, { name: '김대호', group_name: '본사 영업팀' });
  await page.route('**/new-projects', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ readOnly: false, capabilities: { viewPortfolio: true, createProject: true }, projects: [PROJECT] }) }));
  await page.route('**/new-projects/p1/meetings/mt1/notes', async route => {
    handlers.onNotes?.(route.request().method(), route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ meeting: { ...MEETING, version: 3, actionItems: [ITEM, { id: 'ai2', title: '리뷰 소재 3종 준비', assignee: null, dueDate: null, taskId: null }] } }) });
  });
  await page.route('**/new-projects/p1/meetings/mt1/action-items/*/task', async route => {
    handlers.onConvert?.(route.request().postDataJSON());
    const id = route.request().url().match(/action-items\/([^/]+)\/task/)?.[1];
    await route.fulfill({ status: 201, contentType: 'application/json',
      body: JSON.stringify({ task: { id: 't9' }, actionItem: { ...ITEM, id, taskId: 't9' } }) });
  });
  await page.route('**/new-projects/p1', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ readOnly: false, capabilities: { manageProject: true }, project: PROJECT }) }));
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto('/business-os-preview.html');
  for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) if (await c.isVisible()) await c.click();
  await page.locator('.nav-item[data-view="new-projects"]').click();
  await page.locator('[data-structured-project-open="p1"]').click();
}

test('회의 카드는 회의록과 나온 할 일 건수를 보여 준다', async ({ page }) => {
  await open(page);
  const meeting = page.locator('.structured-meeting');
  await expect(meeting.locator('.structured-meeting-outcome')).toContainText('회의록 작성됨');
  // 아직 업무로 만들지 않았으므로 그렇게 말해야 한다.
  await expect(meeting.locator('.structured-meeting-outcome')).toContainText('할 일 1건 · 아직 업무 없음');
  await expect(meeting.locator('[data-structured-meeting-notes]')).toHaveText('회의록 보기');
});

test('회의록에 결정사항과 할 일을 적어 저장한다', async ({ page }) => {
  const calls: any[] = [];
  await open(page, { onNotes: (method, body) => calls.push({ method, body }) });
  await page.locator('[data-structured-meeting-notes]').click();
  const form = page.locator('#structuredMeetingNotesForm');
  await expect(form).toBeVisible();
  // 이미 적힌 회의록과 할 일이 그대로 실려 있어야 한다.
  await expect(form.locator('[name="notes"]')).toHaveValue('퍼니지 단가 8,200원으로 확정');
  await expect(form.locator('[data-action-item-title="0"]')).toHaveValue('공급사에 단가 확정 회신');

  await form.locator('[data-action-item-add]').click();
  await form.locator('[data-action-item-title="1"]').fill('리뷰 소재 3종 준비');
  await form.locator('button[type="submit"]').click();

  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].method).toBe('PUT');
  expect(calls[0].body).toEqual({
    notes: '퍼니지 단가 8,200원으로 확정',
    actionItems: [
      { id: 'ai1', title: '공급사에 단가 확정 회신', assigneeUid: 'e2e-test-user', dueDate: '2026-08-22' },
      { title: '리뷰 소재 3종 준비' },
    ],
    expectedVersion: 2,
  });
  // 저장 뒤 서버가 준 ID를 받아 둬야 다음 저장이 같은 줄을 또 만들지 않는다.
  await expect(form.locator('[data-action-item-convert="1"]')).toBeEnabled();
});

test('담당자가 있는 할 일은 한 번에 업무가 되고, 없으면 막는다', async ({ page }) => {
  let converted: any = 'none';
  await open(page, { onConvert: body => { converted = body; } });
  await page.locator('[data-structured-meeting-notes]').click();
  const form = page.locator('#structuredMeetingNotesForm');

  await form.locator('[data-action-item-convert="0"]').click();
  await expect.poll(() => converted).not.toBe('none');
  // 소분류 회의라 어디에 만들지 다시 묻지 않는다.
  expect(converted).toEqual({});
  await expect(form.locator('.structured-action-item').first()).toHaveClass(/is-converted/);
  await expect(form.locator('.structured-action-item-done').first()).toHaveText('업무 생성됨');

  // 담당자 없는 줄은 업무로 만들 수 없다.
  await form.locator('[data-action-item-add]').click();
  await form.locator('[data-action-item-title="1"]').fill('담당자 없는 할 일');
  await form.locator('[data-action-item-convert="1"]').click();
  await expect(page.locator('.toast, [data-toast]').first()).toContainText('담당자를 정해야');
});

test('방금 적은 할 일도 저장 없이 바로 업무가 된다', async ({ page }) => {
  const calls: any[] = [];
  let converted: any = 'none';
  await open(page, {
    onNotes: (method, body) => calls.push(body),
    onConvert: body => { converted = body; },
  });
  await page.locator('[data-structured-meeting-notes]').click();
  const form = page.locator('#structuredMeetingNotesForm');

  // 새 줄을 적고 곧바로 업무로 만들기를 누른다. 회의록 저장을 먼저 시키지 않는다.
  await form.locator('[data-action-item-add]').click();
  await expect(form.locator('[data-action-item-convert="1"]')).toBeEnabled();
  await form.locator('[data-action-item-title="1"]').fill('리뷰 소재 3종 준비');
  await form.locator('[data-action-item-assignee="1"]').selectOption('l');
  await form.locator('[data-action-item-convert="1"]').click();

  // 회의록이 먼저 저장되고, 서버가 준 ID로 업무 전환까지 이어져야 한다.
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].actionItems.at(-1)).toEqual({ title: '리뷰 소재 3종 준비', assigneeUid: 'l' });
  await expect.poll(() => converted).not.toBe('none');
});

test('내용이 비어 있는 줄은 업무로 만들지 않는다', async ({ page }) => {
  let converted: any = 'none';
  await open(page, { onConvert: body => { converted = body; } });
  await page.locator('[data-structured-meeting-notes]').click();
  const form = page.locator('#structuredMeetingNotesForm');
  await form.locator('[data-action-item-add]').click();
  await form.locator('[data-action-item-convert="1"]').click();
  await expect(page.locator('.toast, [data-toast]').first()).toContainText('할 일 내용을 먼저');
  expect(converted).toBe('none');
});
