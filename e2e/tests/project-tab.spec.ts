import { test, expect } from '@playwright/test';
import { setupStubs } from './helpers';

test.describe('project tab', () => {
  test('supports multiple projects with search and status filters', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 850 });
    await setupStubs(page, {
      events: [],
      ideas: [],
      users: [
        { uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local', role: 'admin', approved: true, is_active: true },
      ],
      chatRooms: [],
      chatMessages: {},
      chatMembers: {},
      chatUnreadCounts: {},
      chatRoomGroups: [],
      eventChecklist: {},
      attendance: [],
      projects: [
        {
          id: 'project-a',
          name: '리뷰스페이스 개선',
          description: '리뷰 플랫폼 정리',
          status: 'active',
          deadline: '2026-06-30',
          owner_id: 'e2e-test-user',
          owner_name: 'E2E',
          members: [{ uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local', role: 'manager' }],
          tasks: [],
          updates: [],
          comments: [],
          taskComments: [],
          events: [],
          canManage: true,
          deleted: false,
          created_at: '2026-06-25T00:00:00.000Z',
          updated_at: '2026-06-25T00:00:00.000Z',
        },
        {
          id: 'project-b',
          name: '키워드마스터 고도화',
          description: '검색 데이터 개선',
          status: 'review',
          deadline: '2026-07-05',
          owner_id: 'e2e-test-user',
          owner_name: 'E2E',
          members: [{ uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local', role: 'manager' }],
          tasks: [],
          updates: [],
          comments: [],
          taskComments: [],
          events: [],
          canManage: true,
          deleted: false,
          created_at: '2026-06-25T00:00:00.000Z',
          updated_at: '2026-06-25T00:00:00.000Z',
        },
      ],
    });

    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.locator('.sidebar-item').filter({ hasText: '프로젝트' }).click();

    await expect(page.getByText('리뷰스페이스 개선')).toBeVisible();
    await expect(page.getByText('키워드마스터 고도화')).toBeVisible();

    await page.getByPlaceholder('프로젝트명, 멤버, 설명 검색').fill('키워드');
    await expect(page.getByText('키워드마스터 고도화')).toBeVisible();
    await expect(page.getByText('리뷰스페이스 개선')).toHaveCount(0);

    await page.getByPlaceholder('프로젝트명, 멤버, 설명 검색').fill('');
    await page.getByRole('button', { name: /완료 0/ }).click();
    await expect(page.getByText('조건에 맞는 프로젝트가 없습니다')).toBeVisible();
  });

  test('shows project detail tabs and supports task, update, and talk entries', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 850 });
    await setupStubs(page, {
      events: [],
      ideas: [],
      users: [
        { uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local', role: 'admin', approved: true, is_active: true },
        { uid: 'member-1', name: '김대호', email: 'daeho@test.local', role: 'member', approved: true, is_active: true },
      ],
      chatRooms: [],
      chatMessages: {},
      chatMembers: {},
      chatUnreadCounts: {},
      chatRoomGroups: [],
      eventChecklist: {},
      attendance: [],
      projects: [{
        id: 'project-1',
        name: '리뷰스페이스 개선',
        description: '회의 후 업무와 진행사항을 관리합니다.',
        status: 'active',
        deadline: '2026-06-30',
        owner_id: 'e2e-test-user',
        owner_name: 'E2E',
        members: [
          { uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local', role: 'manager' },
          { uid: 'member-1', name: '김대호', email: 'daeho@test.local', role: 'member' },
        ],
        tasks: [],
        updates: [],
        comments: [],
        taskComments: [],
        events: [],
        canManage: true,
        deleted: false,
        created_at: '2026-06-25T00:00:00.000Z',
        updated_at: '2026-06-25T00:00:00.000Z',
      }],
    });

    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.locator('.sidebar-item').filter({ hasText: '프로젝트' }).click();

    await expect(page.getByText('프로젝트 상황판')).toBeVisible();
    await page.getByText('리뷰스페이스 개선').click();
    await expect(page.getByRole('button', { name: '업무' })).toBeVisible();
    await expect(page.getByText('참여 멤버')).toBeVisible();

    await page.getByRole('button', { name: '업무' }).click();
    await page.getByRole('button', { name: '+ 업무' }).click();
    await page.locator('#projectTaskTitle').fill('정산 화면 문구 정리');
    await page.locator('#projectTaskAssignee').selectOption('member-1');
    await page.getByRole('button', { name: '저장' }).click();
    await expect(page.getByText('정산 화면 문구 정리').first()).toBeVisible();
    await expect(page.getByText('담당 김대호').first()).toBeVisible();
    await page.locator('#projectTaskCommentInput').fill('이 업무는 문구 초안부터 확인하겠습니다.');
    await page.locator('#mainBody').getByRole('button', { name: '등록' }).click();
    await expect(page.getByText('이 업무는 문구 초안부터 확인하겠습니다.')).toBeVisible();

    await page.getByRole('button', { name: '진행사항' }).click();
    await page.getByRole('button', { name: '+ 진행사항' }).click();
    await page.locator('#projectUpdateStatus').fill('회의 완료');
    await page.locator('#projectUpdateContent').fill('담당자별 업무를 정리했습니다.');
    await page.locator('#modalContent').getByRole('button', { name: '등록' }).click();
    await expect(page.getByText('담당자별 업무를 정리했습니다.')).toBeVisible();
    await page.locator('#mainBody').getByRole('button', { name: '수정' }).click();
    await expect(page.locator('#projectUpdateStatus')).toHaveValue('회의 완료');
    await expect(page.locator('#projectUpdateContent')).toHaveValue('담당자별 업무를 정리했습니다.');
    await page.locator('#projectUpdateStatus').fill('회의 후속 확인');
    await page.locator('#projectUpdateContent').fill('담당자별 업무와 확인 일정을 수정했습니다.');
    await page.getByRole('button', { name: '수정 저장' }).click();
    await expect(page.getByText('담당자별 업무와 확인 일정을 수정했습니다.')).toBeVisible();
    await expect(page.getByText(/수정됨/)).toBeVisible();

    await page.getByRole('button', { name: '일정' }).click();
    await page.getByRole('button', { name: '+ 회의일정' }).first().click();
    await page.locator('#projectMeetingTitle').fill('리뷰스페이스 주간 회의');
    await page.locator('#projectMeetingDate').fill('2026-06-29');
    await page.locator('#projectMeetingTime').fill('14:30');
    await page.locator('#projectMeetingMemo').fill('참여자 캘린더에 자동 공유되는 회의입니다.');
    await page.locator('#modalContent').getByRole('button', { name: '등록' }).click();
    await expect(page.getByText('리뷰스페이스 주간 회의')).toBeVisible();
    await expect(page.getByText(/팀 공유/)).toBeVisible();
  });

  test('assigns a task to all project members and tracks individual completion', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 850 });
    await setupStubs(page, {
      events: [],
      ideas: [],
      users: [
        { uid: 'e2e-test-user', name: '나영업', email: 'me@test.local', role: 'admin', approved: true, is_active: true },
        { uid: 'sales-1', name: '김영업', email: 'sales1@test.local', role: 'member', approved: true, is_active: true },
        { uid: 'sales-2', name: '이영업', email: 'sales2@test.local', role: 'member', approved: true, is_active: true },
      ],
      chatRooms: [],
      chatMessages: {},
      chatMembers: {},
      chatUnreadCounts: {},
      chatRoomGroups: [],
      eventChecklist: {},
      attendance: [],
      projects: [{
        id: 'project-all',
        name: '영업 공동 프로젝트',
        description: '모두 담당 업무 완료율을 확인합니다.',
        status: 'active',
        deadline: '2026-08-15',
        owner_id: 'e2e-test-user',
        owner_name: '나영업',
        members: [
          { uid: 'e2e-test-user', name: '나영업', email: 'me@test.local', role: 'manager' },
          { uid: 'sales-1', name: '김영업', email: 'sales1@test.local', role: 'member' },
          { uid: 'sales-2', name: '이영업', email: 'sales2@test.local', role: 'member' },
        ],
        tasks: [{
          id: 'task-all',
          project_id: 'project-all',
          title: '이번 주 고객 후속 연락',
          description: '담당자별로 완료 후 체크해주세요.',
          status: 'doing',
          assignment_mode: 'all',
          assignee_name: '모두',
          assignee_count: 3,
          completed_assignee_count: 2,
          assignees: [
            { uid: 'e2e-test-user', name: '나영업', completed: false, completedAt: null },
            { uid: 'sales-1', name: '김영업', completed: true, completedAt: '2026-07-25T01:00:00.000Z' },
            { uid: 'sales-2', name: '이영업', completed: true, completedAt: '2026-07-25T01:00:00.000Z' },
          ],
          due_date: '2026-07-31',
        }],
        updates: [],
        comments: [],
        taskComments: [],
        events: [],
        canManage: true,
        deleted: false,
        created_at: '2026-07-25T00:00:00.000Z',
        updated_at: '2026-07-25T00:00:00.000Z',
      }],
    });

    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.locator('.sidebar-item').filter({ hasText: '프로젝트' }).click();
    await page.getByText('영업 공동 프로젝트').click();

    await expect(page.getByText('담당 모두 3명').first()).toBeVisible();
    await expect(page.getByText('2/3명 · 67%').first()).toBeVisible();
    await page.getByTitle('내 완료 체크').first().click();
    await expect(page.getByText('3/3명 · 100%').first()).toBeVisible();
    await expect(page.getByText('검토요청').first()).toBeVisible();

    await page.getByRole('button', { name: '업무' }).click();
    await page.getByRole('button', { name: '+ 업무' }).click();
    await expect(page.locator('#projectTaskAssignee').locator('option[value="__all__"]')).toHaveText('모두 (프로젝트 참여자 전원)');
    await page.getByRole('button', { name: '취소' }).click();
  });

  test('switches between project-wide and task conversations', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 850 });
    await setupStubs(page, {
      events: [],
      ideas: [],
      users: [
        { uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local', role: 'admin', approved: true, is_active: true },
      ],
      chatRooms: [],
      chatMessages: {},
      chatMembers: {},
      chatUnreadCounts: {},
      chatRoomGroups: [],
      eventChecklist: {},
      attendance: [],
      projects: [{
        id: 'project-talk',
        name: '대화 분리 프로젝트',
        description: '전체 대화와 업무 대화를 분리합니다.',
        status: 'active',
        deadline: '',
        owner_id: 'e2e-test-user',
        owner_name: 'E2E',
        members: [{ uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local', role: 'manager' }],
        tasks: [{ id: 'task-talk', project_id: 'project-talk', title: '랜딩 문구 정리', status: 'doing', assignee_name: 'E2E', assignee_uid: 'e2e-test-user', due_date: '' }],
        updates: [],
        comments: [{ id: 'comment-total', content: '전체 프로젝트 공유사항입니다.', author_uid: 'e2e-test-user', author_name: 'E2E', created_at: '2026-06-25T00:00:00.000Z' }],
        taskComments: [{ id: 'comment-task', task_id: 'task-talk', content: '업무별 확인사항입니다.', author_uid: 'e2e-test-user', author_name: 'E2E', created_at: '2026-06-25T00:00:00.000Z' }],
        events: [],
        canManage: true,
        deleted: false,
        created_at: '2026-06-25T00:00:00.000Z',
        updated_at: '2026-06-25T00:00:00.000Z',
      }],
    });

    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.locator('.sidebar-item').filter({ hasText: '프로젝트' }).click();
    await page.getByText('대화 분리 프로젝트').click();

    await expect(page.getByText('프로젝트 전체 대화')).toBeVisible();
    await expect(page.getByText('전체 프로젝트 공유사항입니다.')).toBeVisible();

    await page.getByRole('button', { name: '업무' }).click();
    await page.getByText('랜딩 문구 정리').first().click();
    await expect(page.getByText('업무 대화')).toBeVisible();
    await expect(page.getByText('업무별 확인사항입니다.')).toBeVisible();

    await page.locator('.project-talk-panel').getByRole('button', { name: '전체' }).click();
    await expect(page.getByText('프로젝트 전체 대화')).toBeVisible();
    await expect(page.getByText('전체 프로젝트 공유사항입니다.')).toBeVisible();
  });

  test('lets an assignee request review directly from a task card', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 850 });
    await setupStubs(page, {
      events: [],
      ideas: [],
      users: [
        { uid: 'e2e-test-user', name: '김대호', email: 'daeho@test.local', role: 'member', approved: true, is_active: true },
      ],
      chatRooms: [],
      chatMessages: {},
      chatMembers: {},
      chatUnreadCounts: {},
      chatRoomGroups: [],
      eventChecklist: {},
      attendance: [],
      projects: [{
        id: 'project-review-request',
        name: '검토 요청 프로젝트',
        description: '담당자가 검토를 요청합니다.',
        status: 'active',
        deadline: '',
        owner_id: 'owner-1',
        owner_name: '대표',
        members: [{ uid: 'e2e-test-user', name: '김대호', email: 'daeho@test.local', role: 'member' }],
        tasks: [{ id: 'task-review-request', project_id: 'project-review-request', title: '랜딩 문구 작성', status: 'doing', assignee_uid: 'e2e-test-user', assignee_name: '김대호', due_date: '' }],
        updates: [],
        comments: [],
        taskComments: [],
        events: [],
        canManage: false,
        deleted: false,
        created_at: '2026-06-25T00:00:00.000Z',
        updated_at: '2026-06-25T00:00:00.000Z',
      }],
    });

    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.locator('.sidebar-item').filter({ hasText: '프로젝트' }).click();
    await page.getByText('검토 요청 프로젝트').click();
    await page.getByRole('button', { name: '업무' }).click();

    await page.locator('#mainBody').getByRole('button', { name: '검토요청' }).click();
    await expect(page.locator('#mainBody').getByText('검토요청').first()).toBeVisible();
  });

  test('lets a project manager complete or reopen a review-requested task', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 850 });
    await setupStubs(page, {
      events: [],
      ideas: [],
      users: [
        { uid: 'e2e-test-user', name: '대표', email: 'owner@test.local', role: 'admin', approved: true, is_active: true },
      ],
      chatRooms: [],
      chatMessages: {},
      chatMembers: {},
      chatUnreadCounts: {},
      chatRoomGroups: [],
      eventChecklist: {},
      attendance: [],
      projects: [{
        id: 'project-review-manage',
        name: '검토 처리 프로젝트',
        description: '관리자가 검토를 처리합니다.',
        status: 'active',
        deadline: '',
        owner_id: 'e2e-test-user',
        owner_name: '대표',
        members: [{ uid: 'e2e-test-user', name: '대표', email: 'owner@test.local', role: 'manager' }],
        tasks: [{ id: 'task-review-manage', project_id: 'project-review-manage', title: '정산 화면 검토', status: 'review', assignee_uid: 'member-1', assignee_name: '김대호', due_date: '' }],
        updates: [],
        comments: [],
        taskComments: [],
        events: [],
        canManage: true,
        deleted: false,
        created_at: '2026-06-25T00:00:00.000Z',
        updated_at: '2026-06-25T00:00:00.000Z',
      }],
    });

    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.locator('.sidebar-item').filter({ hasText: '프로젝트' }).click();
    await page.getByText('검토 처리 프로젝트').click();
    await page.getByRole('button', { name: '업무' }).click();

    await expect(page.locator('#mainBody').getByRole('button', { name: '완료 처리' })).toBeVisible();
    await expect(page.locator('#mainBody').getByRole('button', { name: '다시 진행' })).toBeVisible();
    await page.locator('#mainBody').getByRole('button', { name: '완료 처리' }).click();
    await expect(page.locator('#mainBody').getByText('완료').first()).toBeVisible();
  });

  test('opens shared project meetings on the personal calendar', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 850 });
    const meeting = {
      id: 'meeting-shared',
      project_id: 'project-shared',
      type: 'meeting',
      title: '키워드 마스터 판매 기획 회의',
      date: '2026-07-07',
      time: '15:00',
      memo: '프로젝트 회의',
      scope: 'team',
      owner_id: 'owner-1',
      owner_name: '대표',
      is_shared: true,
      deleted: false,
    };
    await setupStubs(page, {
      events: [meeting],
      ideas: [],
      users: [
        { uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local', role: 'member', approved: true, is_active: true },
      ],
      chatRooms: [],
      chatMessages: {},
      chatMembers: {},
      chatUnreadCounts: {},
      chatRoomGroups: [],
      eventChecklist: {},
      attendance: [],
      projects: [{
        id: 'project-shared',
        name: '키워드 마스터',
        description: '공유 회의 테스트',
        status: 'active',
        deadline: '',
        owner_id: 'owner-1',
        owner_name: '대표',
        members: [{ uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local', role: 'member' }],
        tasks: [],
        updates: [],
        comments: [],
        taskComments: [],
        events: [meeting],
        canManage: false,
        deleted: false,
        created_at: '2026-06-25T00:00:00.000Z',
        updated_at: '2026-06-25T00:00:00.000Z',
      }],
    });

    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.locator('.sidebar-item').filter({ hasText: '프로젝트' }).click();
    await page.getByText('키워드 마스터').click();
    await page.getByRole('button', { name: '일정' }).click();
    await page.getByRole('button', { name: '캘린더에서 보기' }).click();

    await expect(page.getByText('2026.07')).toBeVisible();
    await expect(page.locator('#rightPanel').getByText('📁 프로젝트 회의')).toBeVisible();
    await expect(page.locator('#rightPanel').getByText('키워드 마스터 판매 기획 회의')).toBeVisible();
    const closeButton = page.getByRole('button', { name: '닫기' });
    if (await closeButton.isVisible().catch(() => false)) await closeButton.click();
    await page.locator('#rightPanel').getByText('키워드 마스터 판매 기획 회의').click();
    await expect(page.locator('#mainTitle')).toHaveText('📁 프로젝트');
    await expect(page.locator('#mainBody').getByText('키워드 마스터').first()).toBeVisible();
  });

  test('refreshes stale calendar data when selecting a date and highlights project meetings', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 850 });
    await setupStubs(page, {
      events: [{
        id: 'reviewspace-team-todo',
        type: 'todo',
        title: '리뷰스페이스',
        date: '2026-07-07',
        scope: 'team',
        owner_id: 'member-1',
        owner_name: '김지홍',
        deleted: false,
      }],
      ideas: [],
      users: [
        { uid: 'e2e-test-user', name: '패션TV봉이', email: 'e2e@test.local', role: 'admin', approved: true, is_active: true },
      ],
      chatRooms: [],
      chatMessages: {},
      chatMembers: {},
      chatUnreadCounts: {},
      chatRoomGroups: [],
      eventChecklist: {},
      attendance: [],
      projects: [],
    });

    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });

    await page.evaluate(() => {
      const state = (window as any).__e2e_api_state;
      state.events.unshift({
        id: 'project-meeting-late',
        type: 'meeting',
        title: '키워드 마스터 판매 기획 회의',
        date: '2026-07-07',
        time: '15:00',
        memo: '회의 안건',
        scope: 'team',
        owner_id: 'e2e-test-user',
        owner_name: '패션TV봉이',
        project_id: 'project-keyword',
        deleted: false,
      });
    });

    await page.locator('.cal-cell[data-date="2026-07-07"]').click();

    await expect(page.locator('#rightPanel').getByText('📁 프로젝트 회의')).toBeVisible();
    await expect(page.locator('#rightPanel').getByText('키워드 마스터 판매 기획 회의')).toBeVisible();
  });

  test('hides project meeting events from archived or deleted duplicate projects', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 850 });
    const activeMeeting = {
      id: 'active-project-meeting',
      type: 'meeting',
      title: '장기,단기적인 프로젝트에 대한 회의',
      date: '2026-07-03',
      time: '15:00',
      scope: 'team',
      owner_id: 'e2e-test-user',
      owner_name: 'E2E',
      project_id: 'active-project',
      deleted: false,
    };
    const archivedMeeting = {
      ...activeMeeting,
      id: 'archived-project-meeting',
      project_id: 'archived-project',
    };
    await setupStubs(page, {
      events: [activeMeeting, archivedMeeting],
      ideas: [],
      users: [
        { uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local', role: 'admin', approved: true, is_active: true },
      ],
      chatRooms: [],
      chatMessages: {},
      chatMembers: {},
      chatUnreadCounts: {},
      chatRoomGroups: [],
      eventChecklist: {},
      attendance: [],
      projects: [
        {
          id: 'active-project',
          name: '단기,장기 프로젝트 회의',
          status: 'active',
          owner_id: 'e2e-test-user',
          owner_name: 'E2E',
          members: [],
          tasks: [],
          updates: [],
          comments: [],
          taskComments: [],
          events: [activeMeeting],
          canManage: true,
          deleted: false,
        },
        {
          id: 'archived-project',
          name: '단기,장기 프로젝트 회의',
          status: 'archived',
          owner_id: 'e2e-test-user',
          owner_name: 'E2E',
          members: [],
          tasks: [],
          updates: [],
          comments: [],
          taskComments: [],
          events: [archivedMeeting],
          canManage: true,
          deleted: true,
        },
      ],
    });

    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.locator('.cal-cell[data-date="2026-07-03"]').click();

    await expect(page.locator('#rightPanel').getByText('📁 프로젝트 회의')).toBeVisible();
    await expect(page.locator('#rightPanel').getByText('장기,단기적인 프로젝트에 대한 회의')).toHaveCount(1);
  });
});
