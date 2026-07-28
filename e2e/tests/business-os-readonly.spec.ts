import { test, expect } from '@playwright/test';
import { installFirebaseStub } from './helpers';

test.describe('Business OS read-only operating data', () => {
  test('renders account-scoped Paragon data and only issues GET requests', async ({ page }) => {
    await installFirebaseStub(page);
    const apiMethods: string[] = [];
    const salesSummaryQueries: string[] = [];
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
        description: '프로젝트 상세 업무 설명',
        status: 'review',
        due_date: date,
        assignees: [{ uid: 'e2e-test-user', name: 'E2E', completed: true }],
      }],
      updates: [{ id: 'update-1', author_name: 'E2E', content: '진행사항 원문', created_at: `${date}T09:00:00Z` }],
      comments: [{ id: 'comment-1', author_name: '동료', content: '프로젝트 전체 대화 원문', attachments: [], created_at: `${date}T10:00:00Z` }],
      events: [{ id: 'project-event-1', title: '프로젝트 회의', date, time: '16:00', memo: '회의 일정 원문' }],
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
        }, {
          id: 'event-live-2',
          type: 'meeting',
          title: '팀 운영 회의',
          date,
          time: '16:00',
          todo_cat: '',
          scope: 'team',
          owner_id: 'colleague',
          owner_name: '동료',
          done: false,
        }, {
          id: 'event-live-3',
          type: 'todo',
          title: '일일 보고서 작성',
          date,
          time: '18:00',
          todo_cat: '보고서',
          scope: 'personal',
          owner_id: 'e2e-test-user',
          owner_name: 'E2E',
          done: true,
        }];
      } else if (pathname === '/events/checklist-summary') {
        payload = { 'event-live-1': { total: 3, completed: 1 } };
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
      } else if (pathname === '/users/all-approved') {
        payload = [
          { uid: 'e2e-test-user', name: 'E2E', email: 'e2e@test.local', group_name: '개발팀' },
          { uid: 'user-kdh', name: '김대호', email: 'kdh@test.local', group_name: '본사 영업팀' },
        ];
      } else if (pathname === '/reports/sales-summary') {
        salesSummaryQueries.push(new URL(request.url()).search);
        payload = {
          from: '2026-06-01',
          to: '2026-07-26',
          bucket: 'week',
          scope: 'all',
          bucketKeys: ['2026-07-13', '2026-07-20'],
          authors: [
            {
              authorId: 'author-1',
              name: '박종원',
              groupName: '본사 영업팀',
              total: 35745660,
              reportCount: 9,
              amounts: { '2026-07-13': 12841920, '2026-07-20': 22903740 },
              reportCounts: { '2026-07-13': 4, '2026-07-20': 5 },
            },
            {
              authorId: 'author-2',
              name: '깨비승짱',
              groupName: '대구지사',
              total: 1093600,
              reportCount: 6,
              amounts: { '2026-07-13': 62500, '2026-07-20': 1031100 },
              reportCounts: { '2026-07-13': 3, '2026-07-20': 3 },
            },
          ],
          groups: [
            { name: '본사 영업팀', total: 35745660, amounts: {} },
            { name: '대구지사', total: 1093600, amounts: {} },
          ],
          fields: [
            { name: '리워드', amount: 20000000 },
            { name: '블로그', amount: 16839260 },
          ],
          totals: { amount: 36839260, reportCount: 15, authorCount: 2 },
          previous: { from: '2026-05-04', to: '2026-06-28', amount: 30000000, changeRate: 0.2279 },
        };
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await expect(page.locator('.prototype-bar')).toContainText('운영 데이터 · 읽기 전용');
    await expect(page.locator('.app-sidebar [data-nav-cluster]')).toHaveCount(4);
    await expect(page.locator('.app-sidebar .sidebar-tree-heading')).toHaveCount(0);
    await expect(page.locator('[data-nav-cluster="finance"]')).toHaveClass(/closed/);
    await expect(page.locator('[data-nav-cluster="tools"]')).toHaveClass(/closed/);
    await page.locator('#sidebarTabSearch').fill('세금');
    await expect(page.locator('[data-nav-cluster="finance"]')).toHaveClass(/search-open/);
    await expect(page.locator('.nav-item[data-view="tax"]')).toBeVisible();
    await page.locator('#sidebarTabSearch').fill('');
    await expect(page.locator('[data-nav-cluster="finance"]')).toHaveClass(/closed/);
    await expect(page.locator('#dashboardView')).toContainText('오늘 운영 업무');
    await expect(page.locator('#dashboardView')).toContainText('아직 전달받은 실제 데이터가 없습니다');
    await expect(page.locator('#dashboardView')).not.toContainText('₩ 4,820만');

    await page.locator('.nav-item[data-view="todo"]').click();
    await expect(page.locator('#todoView')).toContainText('오늘 운영 업무');
    await expect(page.locator('#todoView .todo-task-check').first()).toBeDisabled();
    await expect(page.locator('#todoView')).not.toContainText('현재 계정에 허용된 오늘 업무를 조회합니다');

    await page.locator('.nav-item[data-view="calendar"]').click();
    await expect(page.locator('#calendarView')).toContainText('오늘 운영 업무');
    await expect(page.locator('#calendarMonthLabel')).toHaveText(`${year}년 ${today.getMonth() + 1}월`);
    await expect(page.locator('#homeCalendarAgenda .agenda-date span')).toContainText(`${year}년 ${today.getMonth() + 1}월 ${today.getDate()}일`);
    await expect(page.locator('#homeCalendarAgenda .agenda-day-stats')).toContainText('내 일정');
    await expect(page.locator('#homeCalendarAgenda .agenda-day-stats')).toContainText('팀 일정');
    await expect(page.locator('#homeCalendarAgenda .agenda-report-section')).toContainText('일일 보고서 작성');
    await expect(page.locator('#homeCalendarAgenda')).toContainText('체크리스트 1/3');
    await page.locator('#homeCalendarAgenda [data-agenda-scope="team"]').click();
    await expect(page.locator('#homeCalendarAgenda')).toContainText('팀 운영 회의');
    await page.locator('#homeCalendarAgenda [data-agenda-scope="all"]').click();
    const nextMonth = new Date(year, today.getMonth() + 1, 1);
    await page.locator('#calendarNext').click();
    await expect(page.locator('#calendarMonthLabel')).toHaveText(`${nextMonth.getFullYear()}년 ${nextMonth.getMonth() + 1}월`);
    await expect(page.locator('#homeCalendarAgenda .agenda-date span')).toContainText(`${nextMonth.getFullYear()}년 ${nextMonth.getMonth() + 1}월 1일`);
    await page.locator('#calendarPrev').click();

    await page.locator('.nav-item[data-view="chat"]').click();
    await page.locator('[data-room-id="room-live-1"]').click();
    await expect(page.locator('#chatThreadMessages')).toContainText('실제 채팅 메시지');
    await expect(page.locator('#chatMessageInput')).toBeDisabled();

    await page.locator('.nav-item[data-view="review"]').click();
    await expect(page.locator('#reviewView .review-page-toolbar')).toHaveCount(0);
    await expect(page.locator('#reviewSearchInput')).toHaveCount(0);
    await page.locator('[data-project-id="project-live-1"]').click();
    await expect(page.locator('#reviewView .project-detail-page')).toBeVisible();
    await expect(page.locator('#reviewView')).toContainText('운영 데이터 연결 프로젝트');
    await expect(page.locator('#reviewView')).toContainText('읽기 전용 업무 확인');
    await expect(page.locator('#reviewView')).toContainText('진행사항 원문');
    await expect(page.locator('#reviewView')).toContainText('프로젝트 전체 대화 원문');
    await expect(page.locator('#reviewView .project-comment-compose textarea')).toBeDisabled();
    await page.locator('[data-project-detail-tab="schedule"]').click();
    await expect(page.locator('#reviewView')).toContainText('프로젝트 회의');
    await page.locator('[data-project-back]').click();
    await expect(page.locator('[data-project-id="project-live-1"]')).toBeVisible();

    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await page.locator('.nav-item[data-view="reports"]').click();
    await expect(page.locator('#moduleView')).toContainText('출근보고서');
    await expect(page.locator('#moduleView')).toContainText('분기별보고서');
    await expect(page.locator('#moduleView .sales-chart')).toHaveCount(0);

    // 주간보고서: 운영 보고서 매출이 실제 숫자로 표시되어야 한다
    await page.locator('[data-report-type="weekly"]').click();
    await expect(page.locator('#moduleView .sales-chart')).toHaveCount(1);
    await expect(page.locator('#moduleView')).not.toContainText('매출 데이터 연결 후 표시');
    await expect(page.locator('#moduleView .sales-kpi').first()).toContainText('3,684만원');
    await expect(page.locator('#moduleView .sales-kpi').first()).toContainText('36,839,260원');
    await expect(page.locator('#moduleView .sales-change')).toContainText('+22.8%');
    await expect(page.locator('#moduleView .sales-table tbody tr').first()).toContainText('박종원');
    await expect(page.locator('#moduleView .sales-table tbody tr').first()).toContainText('22,903,740');
    await expect(page.locator('#moduleView .sales-table tbody tr')).toHaveCount(2);
    await expect(page.locator('#moduleView .sales-table tfoot')).toContainText('36,839,260');
    await expect(page.locator('#moduleView .sales-bar-label').first()).toHaveText('7/13~7/19');
    await expect(page.locator('#moduleView')).toContainText('리워드');
    await expect(page.locator('#moduleView .sales-basis')).toContainText('수금액·미수잔액은 제외');
    expect(salesSummaryQueries.length).toBeGreaterThan(0);
    expect(salesSummaryQueries[0]).toContain('bucket=week');
    expect(salesSummaryQueries[0]).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);

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

    await page.locator('.nav-item[data-view="organization"]').click();
    await expect(page.locator('#moduleView')).toContainText('경영지원팀');
    await expect(page.locator('#moduleView')).toContainText('플랫폼 영업팀');
    await expect(page.locator('#moduleView')).toContainText('세무팀');
    await expect(page.locator('#moduleView .org-node.team.sub.current')).toContainText('개발팀');
    await expect(page.locator('#moduleView .org-node.team.sub.current')).toContainText('내 소속');
    await expect(page.locator('#moduleView [data-open-permissions]')).toBeVisible();

    // 기본은 피라미드 보기 모드 — 직급은 노드에만 보이고 입력칸은 없다
    await expect(page.locator('#moduleView .org-chart.view')).toHaveCount(1);
    await expect(page.locator('#moduleView .org-tree')).toHaveCount(3);
    await expect(page.locator('#moduleView .org-branch')).toHaveCount(3);
    await expect(page.locator('#moduleView')).toContainText('김진봉');
    await expect(page.locator('#moduleView .org-master-chip')).toHaveText('MASTER');
    await expect(page.locator('#moduleView [data-org-rank]')).toHaveCount(0);
    await expect(page.locator('#moduleView .org-node.person').filter({ hasText: '김대호' })).toContainText('부장');

    // 본사 트리: 대표 → 팀 2개 → 그 아래 구성원·하위팀으로 갈라진다
    const hqTree = page.locator('#moduleView [data-org-branch="hq"] .org-tree-scale');
    await expect(hqTree.locator('> ul > li > .org-node.lead')).toHaveCount(1);
    await expect(hqTree.locator('> ul > li > ul > li > .org-node.team')).toHaveCount(2);
    // 경영지원팀 아래 하위팀(개발팀·세무팀)이 한 단계 더 내려간다
    await expect(hqTree.locator('.org-node.team.sub')).toHaveCount(2);
    await expect(hqTree.locator('.org-node.team.sub').first()).toContainText('개발팀');
    // 계정이 없는 구성원도 조직도에는 나와야 한다
    await expect(page.locator('#moduleView .org-node.person').filter({ hasText: '은시후' })).toContainText('주임');
    // 조직도에 이름이 없는 계정은 숨기지 않고 따로 모아 보여 준다
    await expect(page.locator('#moduleView')).toContainText('조직도 미배치 계정');

    // 직급 수정을 누르면 세로 나열 + 입력칸으로 바뀐다
    await page.locator('#moduleView [data-org-edit-toggle]').click();
    await expect(page.locator('#moduleView .org-chart.edit')).toHaveCount(1);
    await expect(page.locator('#moduleView .org-tree')).toHaveCount(0);
    const daehoRank = page.locator('#moduleView [data-org-rank="김대호"]');
    await expect(daehoRank).toHaveValue('부장');
    await expect(daehoRank).toBeEnabled();
    await expect(page.locator('#moduleView .org-member').filter({ hasText: '은시후' })).toContainText('계정 없음');
    await expect(page.locator('#moduleView .org-member').filter({ hasText: '김대호' })).toContainText('계정 연결됨');

    // 직급 변경은 화면에만 반영되고 서버로 나가지 않는다 (GET 단언이 이를 잠근다)
    await daehoRank.selectOption('이사');
    await expect(page.locator('#moduleView [data-org-rank="김대호"]')).toHaveValue('이사');

    // 수정 완료를 누르면 다시 피라미드로 돌아오고 바뀐 직급이 반영된다
    await page.locator('#moduleView [data-org-edit-toggle]').click();
    await expect(page.locator('#moduleView .org-chart.view')).toHaveCount(1);
    await expect(page.locator('#moduleView .org-node.person').filter({ hasText: '김대호' })).toContainText('이사');

    // 지사 필터
    await page.locator('#moduleView [data-org-branch-filter]').selectOption('jeonju');
    await expect(page.locator('#moduleView .org-branch')).toHaveCount(1);
    await expect(page.locator('#moduleView')).toContainText('손지호');
    await page.locator('#moduleView [data-org-branch-filter]').selectOption('all');

    await page.locator('.nav-item[data-view="settlement"]').click();
    await expect(page.locator('#moduleView')).toContainText('내 개인정산서');
    await expect(page.locator('#moduleView')).toContainText('최종정산서');

    await page.locator('.nav-item[data-view="tax"]').click();
    await expect(page.locator('#moduleView')).toContainText('거래처별 사업자등록증');
    await expect(page.locator('#moduleView')).toContainText('세금계산서');

    await page.locator('.nav-item[data-view="platform"]').click();
    await expect(page.locator('#moduleView')).toContainText('API 통합 정산 흐름');

    await page.locator('[data-nav-cluster="tools"] .nav-cluster-toggle').click();
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
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await page.locator('.nav-item[data-view="settlement"]').click();
    await expect(page.locator('#moduleView')).toContainText('내 개인정산서');
    await expect(page.locator('#moduleView')).not.toContainText('최종정산서');
    await expect(page.locator('#moduleView')).toContainText('본인의 개인정산서만 표시');

    // 부장 미만 계정은 직급 수정 버튼도 권한 관리도 볼 수 없다
    await page.locator('.nav-item[data-view="organization"]').click();
    await expect(page.locator('#moduleView [data-open-permissions]')).toHaveCount(0);
    await expect(page.locator('#moduleView [data-org-edit-toggle]')).toHaveCount(0);
    await expect(page.locator('#moduleView [data-org-rank]')).toHaveCount(0);
    await expect(page.locator('#moduleView')).toContainText('부장 이상만 수정할 수 있으며');
    await expect(page.locator('#moduleView')).toContainText('현재 계정은 조회만 가능합니다');
  });

  test('shows no invented amounts when the account has no sales rows', async ({ page }) => {
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
      } else if (pathname === '/reports/sales-summary') {
        payload = {
          from: '2026-06-01',
          to: '2026-07-26',
          bucket: 'week',
          scope: 'self',
          bucketKeys: [],
          authors: [],
          groups: [],
          fields: [],
          totals: { amount: 0, reportCount: 0, authorCount: 0 },
          previous: { from: '2026-04-06', to: '2026-05-31', amount: 0, changeRate: null },
        };
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await page.locator('.nav-item[data-view="reports"]').click();
    await page.locator('[data-report-type="weekly"]').click();
    await expect(page.locator('#moduleView .sales-state')).toContainText('보고 매출이 없습니다');
    await expect(page.locator('#moduleView .sales-chart')).toHaveCount(0);
    await expect(page.locator('#moduleView .sales-table')).toHaveCount(0);
    await expect(page.locator('#moduleView .sales-kpi')).toHaveCount(0);
    // 금액 자리에 임의의 숫자가 채워지지 않아야 한다
    await expect(page.locator('#salesSummaryPane')).not.toHaveText(/\d[\d,]*\s*원/);
  });
});
