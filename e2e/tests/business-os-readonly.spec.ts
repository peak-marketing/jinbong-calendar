import { test, expect } from '@playwright/test';
import { installFirebaseStub } from './helpers';

test.describe('Business OS read-only operating data', () => {
  test('renders account-scoped Paragon data and only issues GET requests', async ({ page }) => {
    await installFirebaseStub(page);
    const apiMethods: string[] = [];
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const today = new Date();
    const year = today.getFullYear();
    const date = [
      year,
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-');

    const project = {
      id: 'project-live-1',
      name: '운영 데이터 연결 프로젝트',
      description: '기존 파라곤 프로젝트 설명',
      status: 'active',
      owner_name: 'E2E',
      deadline: date,
      members: [{ uid: 'e2e-test-user', name: 'E2E' }],
      member_names: 'E2E',
      member_count: 1,
      task_count: 1,
      done_task_count: 0,
      tasks: [{
        id: 'task-live-1',
        title: '읽기 전용 업무 확인',
        status: 'review',
        due_date: date,
        assignees: [{ uid: 'e2e-test-user', name: 'E2E', completed: true }],
      }],
      updates: [{ id: 'update-1', author_name: 'E2E', content: '진행사항 원문', created_at: `${date}T09:00:00Z` }],
    };

    await page.route('**/api/**', route => {
      const request = route.request();
      apiMethods.push(request.method());
      const pathname = new URL(request.url()).pathname.replace(/^\/api/, '');
      let payload: unknown = {};
      if (pathname === '/users/me') {
        payload = { uid: 'e2e-test-user', name: 'E2E', role: 'admin', approved: true, is_active: true, group_name: '개발팀' };
      } else if (pathname === '/events') {
        payload = [{
          id: 'event-live-1',
          type: 'todo',
          title: '오늘 운영 업무',
          date,
          time: '15:00',
          memo: '파라곤에 저장된 설명',
          todo_cat: '개발 업무',
          scope: 'personal',
          owner_id: 'e2e-test-user',
          owner_name: 'E2E',
          done: false,
        }];
      } else if (pathname === '/chat-rooms') {
        payload = [{
          id: 'room-live-1',
          name: '운영 채팅방',
          member_count: 2,
          last_message_sender: '동료',
          last_message_text: '운영 메시지',
          last_message_at: `${date}T10:00:00Z`,
        }];
      } else if (pathname === '/chat-rooms/unread') {
        payload = { 'room-live-1': 2 };
      } else if (pathname === '/chat-rooms/room-live-1/messages') {
        payload = [{
          id: 'message-live-1',
          uid: 'colleague',
          name: '동료',
          text: '실제 채팅 메시지',
          created_at: `${date}T10:00:00Z`,
        }];
      } else if (pathname === '/projects') {
        payload = { canManageAll: true, projects: [project] };
      } else if (pathname === '/projects/project-live-1') {
        payload = project;
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await expect(page.locator('.prototype-bar')).toContainText('운영 데이터 · 읽기 전용');
    await expect(page.locator('#dashboardView')).toContainText('오늘 운영 업무');
    await expect(page.locator('#dashboardView')).toContainText('아직 전달받은 실제 데이터가 없습니다');
    await expect(page.locator('#dashboardView')).not.toContainText('₩ 4,820만');

    await page.locator('.nav-item[data-view="todo"]').click();
    await expect(page.locator('#todoView')).toContainText('오늘 운영 업무');
    await expect(page.locator('#todoView .todo-task-check')).toBeDisabled();
    await expect(page.locator('#todoView')).not.toContainText('현재 계정에 허용된 오늘 업무를 조회합니다');

    await page.locator('.nav-item[data-view="calendar"]').click();
    await expect(page.locator('#calendarView')).toContainText('오늘 운영 업무');

    await page.locator('.nav-item[data-view="chat"]').click();
    await page.locator('[data-room-id="room-live-1"]').click();
    await expect(page.locator('#chatThreadMessages')).toContainText('실제 채팅 메시지');
    await expect(page.locator('#chatMessageInput')).toBeDisabled();

    await page.locator('.nav-item[data-view="review"]').click();
    await expect(page.locator('#reviewView .review-page-toolbar')).toHaveCount(0);
    await expect(page.locator('#reviewSearchInput')).toHaveCount(0);
    await page.locator('[data-project-id="project-live-1"]').click();
    await expect(page.locator('#readonlyDetailModal')).toContainText('읽기 전용 업무 확인');
    await expect(page.locator('#readonlyDetailModal')).toContainText('진행사항 원문');
    await page.locator('#readonlyModalClose').click();

    await page.locator('.nav-item[data-view="reports"]').click();
    await expect(page.locator('#moduleView')).toContainText('출근보고서');
    await expect(page.locator('#moduleView')).toContainText('분기별보고서');
    await expect(page.locator('#moduleView .report-chart')).toHaveCount(0);
    await page.locator('[data-report-type="weekly"]').click();
    await expect(page.locator('#moduleView')).toContainText('주간보고서 매출 추이');
    await expect(page.locator('#moduleView')).toContainText('매출 데이터 연결 후 표시');
    await expect(page.locator('#moduleView .report-chart')).toHaveCount(1);

    await page.locator('.nav-item[data-view="documents"]').click();
    await expect(page.locator('#moduleView')).toContainText('협업제안서');
    await expect(page.locator('#moduleView')).toContainText('교육메뉴얼');
    await expect(page.locator('#moduleView')).toContainText('상품별 교육자료');

    await page.locator('.nav-item[data-view="services"]').click();
    await expect(page.locator('#moduleView .service-card')).toHaveCount(16);
    await expect(page.locator('#moduleView')).toContainText('브랜드오토스페이스');
    await page.locator('[data-service-filter="review"]').click();
    await expect(page.locator('#moduleView .service-card')).toHaveCount(2);
    await page.locator('[data-service-add]').click();
    await page.locator('#serviceDraftForm input[name="name"]').fill('신규 테스트 상품');
    await page.locator('#serviceDraftForm textarea[name="description"]').fill('로컬 등록 검증용 상품');
    await page.locator('#serviceDraftForm button[type="submit"]').click();
    await expect(page.locator('#moduleView')).toContainText('신규 테스트 상품');
    await expect(page.locator('#moduleView .service-card')).toHaveCount(17);

    await page.locator('.nav-item[data-view="company"]').click();
    await expect(page.locator('#moduleView')).toContainText('사업자등록증');
    await expect(page.locator('#moduleView')).toContainText('회사 자료');

    await page.locator('.nav-item[data-view="settlement"]').click();
    await expect(page.locator('#moduleView')).toContainText('내 개인정산서');
    await expect(page.locator('#moduleView')).toContainText('최종정산서');

    await page.locator('.nav-item[data-view="tax"]').click();
    await expect(page.locator('#moduleView')).toContainText('거래처별 사업자등록증');
    await expect(page.locator('#moduleView')).toContainText('세금계산서');

    await page.locator('.nav-item[data-view="platform"]').click();
    await expect(page.locator('#moduleView')).toContainText('API 통합 정산 흐름');

    await page.locator('.nav-item[data-view="saas"]').click();
    await expect(page.locator('#moduleView')).toContainText('SaaS 사이트 목록');

    expect(apiMethods.length).toBeGreaterThan(0);
    expect(new Set(apiMethods)).toEqual(new Set(['GET']));
    expect(pageErrors).toEqual([]);
  });

  test('hides final settlement from a regular member account', async ({ page }) => {
    await installFirebaseStub(page);
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
      let payload: unknown = [];
      if (pathname === '/users/me') {
        payload = { uid: 'e2e-test-user', name: '일반 영업자', role: 'member', approved: true, is_active: true, group_name: '영업팀' };
      } else if (pathname === '/chat-rooms/unread') {
        payload = {};
      } else if (pathname === '/projects') {
        payload = { canManageAll: false, projects: [] };
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('.nav-item[data-view="settlement"]').click();
    await expect(page.locator('#moduleView')).toContainText('내 개인정산서');
    await expect(page.locator('#moduleView')).not.toContainText('최종정산서');
    await expect(page.locator('#moduleView')).toContainText('본인의 개인정산서만 표시');
  });
});
