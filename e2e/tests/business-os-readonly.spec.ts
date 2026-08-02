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
    await expect(page.locator('#moduleView')).toContainText('경영지원');
    await expect(page.locator('#moduleView')).toContainText('플랫폼 영업');
    await expect(page.locator('#moduleView')).toContainText('세무');
    await expect(page.locator('#moduleView .org-node.team.sub.current')).toContainText('개발');
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
    await expect(hqTree.locator('.org-node.team.sub').first()).toContainText('개발');

    // 팀 카드 → 최상위 직급 → 나머지 구성원·하위팀이 한 줄에 나란히
    const supportDivision = hqTree.locator('> ul > li > ul > li').filter({ hasText: '경영지원' });
    await expect(supportDivision.locator('> ul > li > .org-node.person')).toContainText('김대호');
    const supportChildren = supportDivision.locator('> ul > li > ul > li > .org-node');
    await expect(supportChildren).toHaveCount(3);
    await expect(supportChildren.nth(0)).toContainText('전현우');
    await expect(supportChildren.nth(1)).toContainText('개발');
    await expect(supportChildren.nth(2)).toContainText('세무');

    // 팀 카드 안에는 구성원이 직급 순으로 들어간다
    const devCard = page.locator('#moduleView .org-node.team.sub').filter({ hasText: '개발' }).first();
    await expect(devCard.locator('.org-person')).toHaveCount(2);
    await expect(devCard.locator('.org-person').nth(0)).toContainText('이종혁');
    await expect(devCard.locator('.org-person').nth(0)).toContainText('대리');
    await expect(devCard.locator('.org-person').nth(1)).toContainText('김동우');

    // 플랫폼 영업팀은 부장 아래 나머지 5명이 한 카드에 직급 순으로 들어간다
    const salesRoster = page.locator('#moduleView .org-node.roster').filter({ hasText: '플랫폼 영업' });
    await expect(salesRoster.locator('.org-person')).toHaveCount(5);
    await expect(salesRoster.locator('.org-person').first()).toContainText('김지홍');
    await expect(salesRoster.locator('.org-person').nth(1)).toContainText('박우진');
    // 계정이 없는 구성원도 조직도에는 나와야 한다
    await expect(salesRoster.locator('.org-person').last()).toContainText('은시후');

    // 같은 직급인 대구지사 이사 세 명은 한 줄에 나란히 선다
    const daeguTier = page.locator('#moduleView [data-org-branch="daegu"] .org-tier');
    await expect(daeguTier.locator('.org-node.person')).toHaveCount(3);
    await expect(daeguTier.locator('.org-node.person').first()).toContainText('임규태');
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

    // 시트접수: 분류를 고르면 단가표에서 영업자 단가가 자동으로 붙는다
    await page.locator('[data-intake="a"]').selectOption('블로그');
    await page.locator('[data-intake="b"]').selectOption('최적화블로그');
    await page.locator('[data-intake="c"]').selectOption('최블 B');
    await expect(page.locator('[data-intake="unit"]')).toHaveValue('19000');
    await expect(page.locator('[data-intake="unit"]')).toHaveAttribute('readonly', '');

    // 상시변동 상품은 단가 칸이 열려 직접 입력한다
    await page.locator('[data-intake="a"]').selectOption('플레이스');
    await expect(page.locator('[data-intake="unit"]')).not.toHaveAttribute('readonly', '');
    await expect(page.locator('#moduleView')).toContainText('상시변동 상품 · 직접 입력');

    // 다시 고정 단가 상품으로 돌아와 접수 등록
    await page.locator('[data-intake="a"]').selectOption('블로그');
    await page.locator('[data-intake="b"]').selectOption('최적화블로그');
    await page.locator('[data-intake="c"]').selectOption('최블 B');
    await page.locator('[data-intake="client"]').fill('명동미용실');
    await page.locator('[data-intake="qty"]').fill('10');
    await page.locator('[data-intake="sell"]').fill('25000');
    // 영업자 공급가액 190,000 · 매출 250,000 · 영업이익 60,000
    await expect(page.locator('#moduleView .intake-calc .profit strong')).toHaveText('60,000');
    await page.locator('[data-intake-add]').click();

    // 개인정산서에 일자별로 쌓인다
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(1);
    await expect(page.locator('#moduleView .ledger-table tbody tr').first()).toContainText('명동미용실');
    await expect(page.locator('#moduleView .ledger-total')).toContainText('250,000');
    // 부장 이상은 회사 원가까지 본다 (최블 B 원가 17,000 × 10)
    await expect(page.locator('#moduleView .ledger-table th', { hasText: '회사원가' })).toHaveCount(1);
    await expect(page.locator('#moduleView .ledger-total')).toContainText('170,000');

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
    await expect(page.locator('.nav-item[data-view="final-settlement"]')).toBeHidden();
    // 영업자에게는 회사 원가를 감춘다
    await expect(page.locator('#moduleView .intake-calc .masked')).toContainText('표시 안 함');
    await expect(page.locator('#moduleView')).toContainText('회사 원가는 감춥니다');
    await expect(page.locator('#moduleView .ledger-table th', { hasText: '회사원가' })).toHaveCount(0);

    // 부장 미만 계정은 직급 수정 버튼도 권한 관리도 볼 수 없다
    await page.locator('.nav-item[data-view="organization"]').click();
    await expect(page.locator('#moduleView [data-open-permissions]')).toHaveCount(0);
    await expect(page.locator('#moduleView [data-org-edit-toggle]')).toHaveCount(0);
    await expect(page.locator('#moduleView [data-org-rank]')).toHaveCount(0);
    await expect(page.locator('#moduleView')).toContainText('부장 이상만 수정할 수 있으며');
    await expect(page.locator('#moduleView')).toContainText('현재 계정은 조회만 가능합니다');
  });

  // 최종정산서는 직급이 아니라 지정된 사람만 본다.
  // 같은 팀장이라도 전현우는 보고 김지홍은 보지 못한다.
  for (const [name, role, allowed] of [
    ['전현우', 'manager', true],
    ['손명아', 'member', true],
    ['박종원', 'manager', true],
    ['김지홍', 'manager', false],
    ['김주현', 'manager', false],
    ['김용일', 'manager', false],
  ] as [string, string, boolean][]) {
    test(`final settlement is ${allowed ? 'visible' : 'hidden'} for ${name}`, async ({ page }) => {
      await installFirebaseStub(page);
      await page.route('**/api/**', route => {
        const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
        let payload: unknown = [];
        if (pathname === '/users/me') {
          payload = { uid: 'e2e-test-user', name, role, approved: true, is_active: true, group_name: '본사 영업팀' };
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
      // 접수 화면은 누구에게나 열린다
      await expect(page.locator('#moduleView .intake-form')).toHaveCount(1);
      const tab = page.locator('.nav-item[data-view="final-settlement"]');
      if (allowed) {
        await expect(tab).toBeVisible();
        await tab.click();
        await expect(page.locator('#moduleView .final-settlement')).toHaveCount(1);
      } else {
        // 탭을 감춘 것으로 끝내지 않고 화면 자체도 막혀 있어야 한다
        await expect(tab).toBeHidden();
        await page.evaluate(() => (document.querySelector('.nav-item[data-view="final-settlement"]') as HTMLElement)?.click());
        await expect(page.locator('#moduleView')).toContainText('열람 권한이 없습니다');
        await expect(page.locator('#moduleView .final-settlement')).toHaveCount(0);
      }
    });
  }

  test('caps reservation drawdown and refunds at the original amount', async ({ page }) => {
    await installFirebaseStub(page);
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
      let payload: unknown = [];
      if (pathname === '/users/me') {
        payload = { uid: 'e2e-test-user', name: '김대호', role: 'manager', approved: true, is_active: true, group_name: '본사 경영지원팀' };
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

    const fillRow = async (qty: string) => {
      await page.locator('[data-intake="a"]').selectOption('블로그');
      await page.locator('[data-intake="b"]').selectOption('원고');
      await page.locator('[data-intake="c"]').selectOption('프리미엄원고대필');
      await page.locator('[data-intake="client"]').fill('한결에이전시');
      await page.locator('[data-intake="qty"]').fill(qty);
      await page.locator('[data-intake="sell"]').fill('5000');
    };
    const rows = page.locator('#moduleView .ledger-table tbody tr');

    // 예약최초건 10개를 선입금으로 받는다 — 매출로는 잡히지 않는다
    await page.locator('[data-intake-kind="reserve"]').click();
    await fillRow('10');
    await page.locator('[data-intake-add]').click();
    await expect(rows).toHaveCount(1);
    await expect(page.locator('#moduleView .ledger-total')).toContainText('매출 0');

    // 입금 전에는 예약금 잔여가 잡히지 않고 차감도 막힌다
    await expect(page.locator('#moduleView .ledger-total')).not.toContainText('예약금 잔여');
    await page.locator('[data-intake-kind="use"]').click();
    await expect(page.locator('[data-intake="refOf"] option')).toHaveCount(1);
    await expect(page.locator('#moduleView .intake-limit')).toContainText('입금 대기 1건');

    // 예약금을 받고 나서야 차감할 수 있다
    await page.locator('[data-intake-kind="reserve"]').click();
    await page.locator('#moduleView .paid-chip').first().click();
    await expect(page.locator('#paidAmount')).toHaveValue('50000');
    await page.locator('#paidMemo').fill('국민은행 선입금 확인');
    await page.locator('[data-paid-save]').click();
    await expect(page.locator('#moduleView .ledger-total')).toContainText('예약금 잔여 50,000');

    // 예약건 작업은 잔여 수량을 넘을 수 없다.
    // 업체·상품·판매단가는 예약에서 승계되어 잠기므로 수량만 넣는다.
    await page.locator('[data-intake-kind="use"]').click();
    await page.locator('[data-intake="refOf"]').selectOption({ index: 1 });
    await expect(page.locator('#moduleView .intake-limit')).toContainText('잔여 수량 10');
    await page.locator('[data-intake="qty"]').fill('12');
    await page.locator('[data-intake-add]').click();
    await expect(rows).toHaveCount(1);

    // 쓴 것보다 많이 되돌릴 수는 없다 (아직 0개 사용)
    await page.locator('[data-intake="qty"]').fill('-1');
    await page.locator('[data-intake-add]').click();
    await expect(rows).toHaveCount(1);
    await expect(page.locator('#moduleView .ledger-total')).toContainText('예약금 잔여 50,000');

    // 4개만 차감하면 잔여가 6개로 준다
    await page.locator('[data-intake="qty"]').fill('4');
    await page.locator('[data-intake-add]').click();
    await expect(rows).toHaveCount(2);
    await expect(page.locator('#moduleView .ledger-total')).toContainText('예약금 잔여 30,000');
    // 예약금에서 충당되므로 미입금이 생기지 않는다
    await expect(page.locator('#moduleView .ledger-total')).toContainText('미입금 0');

    // 환불은 원래 건수를 넘을 수 없다
    await page.locator('[data-intake-kind="refund"]').click();
    await page.locator('[data-intake="refOf"]').selectOption({ index: 1 });
    await expect(page.locator('#moduleView .intake-limit')).toContainText('환불 가능 수량 4');
    await expect(page.locator('#moduleView .intake-limit')).toContainText('예약 잔여로 되돌아갑니다');
    await page.locator('[data-intake="qty"]').fill('6');
    await page.locator('[data-intake-add]').click();
    await expect(rows).toHaveCount(2);

    // 2개 환불하면 마이너스로 잡히고, 그만큼 예약 잔여로 되돌아간다.
    // 돈은 우리가 그대로 들고 있으므로 미입금이 생기지 않는다.
    await page.locator('[data-intake="qty"]').fill('2');
    await page.locator('[data-intake-add]').click();
    await expect(rows).toHaveCount(3);
    await expect(page.locator('#moduleView .kind-badge.refund')).toHaveCount(1);
    await expect(page.locator('#moduleView .ledger-total')).toContainText('매출 10,000');
    await expect(page.locator('#moduleView .ledger-total')).toContainText('예약금 잔여 40,000');
    await expect(page.locator('#moduleView .ledger-total')).toContainText('미입금 0');
  });

  // 공급사 정산에서도 원가를 같이 빼야 하므로 음수 수량으로 되돌릴 수 있다.
  test('reverses a drawdown with a negative quantity and restores the reserve', async ({ page }) => {
    await installFirebaseStub(page);
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
      let payload: unknown = [];
      if (pathname === '/users/me') {
        payload = { uid: 'e2e-test-user', name: '김대호', role: 'manager', approved: true, is_active: true, group_name: '본사 경영지원팀' };
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

    // 원고 100개 선입금 — 회사원가 10,000짜리 상품
    await page.locator('[data-intake-kind="reserve"]').click();
    await page.locator('[data-intake="a"]').selectOption('블로그');
    await page.locator('[data-intake="b"]').selectOption('원고');
    await page.locator('[data-intake="c"]').selectOption('프리미엄원고대필');
    await page.locator('[data-intake="client"]').fill('나스컴퍼니');
    await page.locator('[data-intake="qty"]').fill('100');
    await page.locator('[data-intake="sell"]').fill('50000');
    await page.locator('[data-intake-add]').click();
    await page.locator('#moduleView .paid-chip').first().click();
    await page.locator('#paidMemo').fill('국민은행 선입금 확인');
    await page.locator('[data-paid-save]').click();

    await page.locator('[data-intake-kind="use"]').click();
    await page.locator('[data-intake="refOf"]').selectOption({ index: 1 });
    await page.locator('[data-intake="qty"]').fill('40');
    await page.locator('[data-intake-add]').click();
    await expect(page.locator('#moduleView .ledger-total')).toContainText('회사원가 400,000');

    // -10으로 되돌리면 매출·회사원가가 함께 빠지고 예약 잔여가 돌아온다
    await page.locator('[data-intake="refOf"]').selectOption({ index: 1 });
    await page.locator('[data-intake="qty"]').fill('-10');
    await page.locator('[data-intake-add]').click();
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(3);
    await expect(page.locator('#moduleView .ledger-total')).toContainText('매출 1,500,000');
    await expect(page.locator('#moduleView .ledger-total')).toContainText('회사원가 300,000');
    await expect(page.locator('#moduleView .ledger-total')).toContainText('예약금 잔여 3,500,000');
    await expect(page.locator('[data-intake="refOf"] option').nth(1)).toContainText('잔여 70개');

    // 실제로 쓴 30개보다 많이 되돌릴 수는 없다
    await page.locator('[data-intake="refOf"]').selectOption({ index: 1 });
    await page.locator('[data-intake="qty"]').fill('-50');
    await page.locator('[data-intake-add]').click();
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(3);

    // 예약최초건은 음수로 넣을 수 없다
    await page.locator('[data-intake-kind="reserve"]').click();
    await page.locator('[data-intake="a"]').selectOption('블로그');
    await page.locator('[data-intake="b"]').selectOption('원고');
    await page.locator('[data-intake="c"]').selectOption('프리미엄원고대필');
    await page.locator('[data-intake="client"]').fill('테스트');
    await page.locator('[data-intake="qty"]').fill('-5');
    await page.locator('[data-intake="sell"]').fill('1000');
    await page.locator('[data-intake-add]').click();
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(3);
  });

  // 최종정산서에는 당일접수·예약건 작업·환불·예약건환불만 올라간다.
  // 예약최초건은 아직 일이 들어가지 않아 매출이 아니므로 빠진다.
  test('final settlement lists only worked rows and drops the reservation', async ({ page }) => {
    await installFirebaseStub(page);
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
      let payload: unknown = [];
      if (pathname === '/users/me') {
        payload = { uid: 'e2e-test-user', name: '김대호', role: 'manager', approved: true, is_active: true, group_name: '본사 경영지원팀' };
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

    const pick = async (b: string, c: string) => {
      await page.locator('[data-intake="a"]').selectOption('블로그');
      await page.locator('[data-intake="b"]').selectOption(b);
      await page.locator('[data-intake="c"]').selectOption(c);
    };

    // 당일접수 4개
    await pick('최적화블로그', '최블 B');
    await page.locator('[data-intake="client"]').fill('한결에이전시');
    await page.locator('[data-intake="qty"]').fill('4');
    await page.locator('[data-intake="sell"]').fill('25000');
    await page.locator('[data-intake-add]').click();

    // 예약최초건 10개 + 입금
    await page.locator('[data-intake-kind="reserve"]').click();
    await pick('원고', '프리미엄원고대필');
    await page.locator('[data-intake="client"]').fill('나스컴퍼니');
    await page.locator('[data-intake="qty"]').fill('10');
    await page.locator('[data-intake="sell"]').fill('50000');
    await page.locator('[data-intake-add]').click();
    await page.locator('#moduleView .paid-chip').nth(1).click();
    await page.locator('#paidMemo').fill('국민은행 선입금 확인');
    await page.locator('[data-paid-save]').click();

    // 예약건 작업 6개
    await page.locator('[data-intake-kind="use"]').click();
    await page.locator('[data-intake="refOf"]').selectOption({ index: 1 });
    await page.locator('[data-intake="qty"]').fill('6');
    await page.locator('[data-intake-add]').click();

    // 당일접수 1개 환불 + 예약건 작업 2개 환불(= 예약건환불)
    await page.locator('[data-intake-kind="refund"]').click();
    await page.locator('[data-intake="refOf"]').selectOption({ index: 1 });  // 당일접수 최블 B
    await page.locator('[data-intake="qty"]').fill('1');
    await page.locator('[data-intake-add]').click();
    await page.locator('[data-intake="refOf"]').selectOption({ index: 2 });  // 예약건 작업
    await page.locator('[data-intake="qty"]').fill('2');
    await page.locator('[data-intake-add]').click();

    // 배지로 환불과 예약건환불이 갈린다
    await expect(page.locator('#moduleView .kind-badge', { hasText: '예약건환불' })).toHaveCount(1);

    await page.locator('.nav-item[data-view="final-settlement"]').click();
    const final = page.locator('#moduleView .final-settlement');
    await expect(final).toHaveCount(1);
    const rows = final.locator('.final-table tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('당일접수');
    await expect(rows.nth(1)).toContainText('예약건 작업');
    await expect(rows.nth(2)).toContainText('환불');
    await expect(rows.nth(3)).toContainText('예약건환불');

    // 예약최초건은 구분에도 없고 매출에도 안 잡힌다
    await expect(final.locator('.final-table')).not.toContainText('예약최초건');
    await expect(final).toContainText('예약최초건 1건');
    await expect(final).toContainText('최종정산서에 올리지 않습니다');

    // 당일 3건(75,000) + 예약건 작업 4건(200,000) = 275,000
    await expect(final.locator('.final-total')).toContainText('매출 275,000');
  });

  // 예약건 작업은 예약최초건의 업체명·메모·상품·판매단가를 그대로 따른다.
  // 영업자 단가만 예외이며 부장 이상만 고칠 수 있다.
  for (const [name, canEditUnit] of [['김대호', true], ['김용일', false]] as [string, boolean][]) {
    test(`reservation drawdown inherits its terms for ${name}`, async ({ page }) => {
      await installFirebaseStub(page);
      await page.route('**/api/**', route => {
        const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
        let payload: unknown = [];
        if (pathname === '/users/me') {
          payload = { uid: 'e2e-test-user', name, role: 'manager', approved: true, is_active: true, group_name: '본사 영업팀' };
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

      // 같은 업체에 메모만 다른 예약 두 건
      const addReserve = async (qty: string, sell: string, memo: string) => {
        await page.locator('[data-intake="a"]').selectOption('블로그');
        await page.locator('[data-intake="b"]').selectOption('원고');
        await page.locator('[data-intake="c"]').selectOption('프리미엄원고대필');
        await page.locator('[data-intake="client"]').fill('한결에이전시');
        await page.locator('[data-intake="qty"]').fill(qty);
        await page.locator('[data-intake="sell"]').fill(sell);
        await page.locator('[data-intake="memo"]').fill(memo);
        await page.locator('[data-intake-add]').click();
      };
      await page.locator('[data-intake-kind="reserve"]').click();
      await addReserve('10', '5000', '8월 캠페인');
      await addReserve('6', '7000', '9월 캠페인');

      // 예약최초건은 아직 일한 게 아니라 매출도 영업이익도 잡히지 않는다
      await expect(page.locator('#moduleView .ledger-total')).toContainText('매출 0');
      await expect(page.locator('#moduleView .ledger-total')).toContainText('영업이익 0');

      // 입금이 확인된 예약만 차감 목록에 오른다
      for (const [index, memo] of [[0, '국민은행 8월 선입금'], [1, '국민은행 9월 선입금']] as [number, string][]) {
        await page.locator('#moduleView .paid-chip').nth(index).click();
        await page.locator('#paidMemo').fill(memo);
        await page.locator('[data-paid-save]').click();
      }

      // 목록은 업체명 - 메모로 구분된다
      await page.locator('[data-intake-kind="use"]').click();
      await expect(page.locator('[data-intake="refOf"] option').nth(1)).toContainText('한결에이전시 - 8월 캠페인');
      await page.locator('[data-intake="refOf"]').selectOption({ index: 2 });

      // 업체명·메모·분류·판매단가는 예약에서 가져와 잠긴다
      await expect(page.locator('[data-intake="client"]')).toHaveValue('한결에이전시');
      await expect(page.locator('[data-intake="memo"]')).toHaveValue('9월 캠페인');
      await expect(page.locator('[data-intake="sell"]')).toHaveValue('7000');
      await expect(page.locator('[data-intake="client"]')).toHaveAttribute('readonly', '');
      await expect(page.locator('[data-intake="sell"]')).toHaveAttribute('readonly', '');
      await expect(page.locator('[data-intake="a"]')).toBeDisabled();

      // 영업자 단가만 부장 이상에게 열린다
      if (canEditUnit) {
        await expect(page.locator('[data-intake="unit"]')).not.toHaveAttribute('readonly', '');
      } else {
        await expect(page.locator('[data-intake="unit"]')).toHaveAttribute('readonly', '');
      }
    });
  }

  test('filters the ledger by period, client, product and deposit state', async ({ page }) => {
    await installFirebaseStub(page);
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
      let payload: unknown = [];
      if (pathname === '/users/me') {
        payload = { uid: 'e2e-test-user', name: '김대호', role: 'manager', approved: true, is_active: true, group_name: '본사 경영지원팀' };
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

    const add = async (date: string, client: string, b: string, c: string, sell: string, memo: string) => {
      await page.locator('[data-intake="date"]').fill(date);
      await page.locator('[data-intake="a"]').selectOption('블로그');
      await page.locator('[data-intake="b"]').selectOption(b);
      await page.locator('[data-intake="c"]').selectOption(c);
      await page.locator('[data-intake="client"]').fill(client);
      await page.locator('[data-intake="qty"]').fill('1');
      await page.locator('[data-intake="sell"]').fill(sell);
      await page.locator('[data-intake="memo"]').fill(memo);
      await page.locator('[data-intake-add]').click();
    };
    await add('2026-08-01', '한결에이전시', '원고', '프리미엄원고대필', '14000', '예약건');
    await add('2026-08-03', '명동미용실', '최적화블로그', '최블 B', '25000', '');

    const rows = page.locator('#moduleView .ledger-table tbody tr');
    await expect(rows).toHaveCount(2);
    // 접수 특이사항이 표에 나온다
    await expect(page.locator('#moduleView .ledger-memo').filter({ hasText: '예약건' })).toHaveCount(1);

    // 거래처
    await page.locator('[data-ledger-filter="client"]').selectOption('명동미용실');
    await expect(rows).toHaveCount(1);
    await expect(page.locator('#moduleView .ledger-total')).toContainText('매출 25,000');
    await page.locator('[data-ledger-filter="client"]').selectOption('');

    // 기간
    await page.locator('[data-ledger-filter="from"]').fill('2026-08-02');
    await expect(rows).toHaveCount(1);
    await page.locator('[data-ledger-filter-reset]').click();
    await expect(rows).toHaveCount(2);

    // 입금 상태
    await page.locator('#moduleView .paid-chip').first().click();
    await page.locator('#paidMemo').fill('국민은행 통장 입금 확인');
    await page.locator('[data-paid-save]').click();
    await page.locator('[data-ledger-filter="paid"]').selectOption('unpaid');
    await expect(rows).toHaveCount(1);
    await page.locator('[data-ledger-filter="paid"]').selectOption('paid');
    await expect(rows).toHaveCount(1);
    await expect(page.locator('#moduleView .paid-chip span').first()).toHaveText('입금');
  });

  test('splits one deposit across several intake rows', async ({ page }) => {
    await installFirebaseStub(page);
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
      let payload: unknown = [];
      if (pathname === '/users/me') {
        payload = { uid: 'e2e-test-user', name: '김대호', role: 'manager', approved: true, is_active: true, group_name: '본사 경영지원팀' };
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

    // 같은 업체로 두 건 접수 — 판매액 20,000 + 30,000
    for (const [b, c, qty, sell] of [
      ['최적화블로그', '최블 B', '4', '5000'],
      ['원고', '프리미엄원고대필', '2', '15000'],
    ] as [string, string, string, string][]) {
      await page.locator('[data-intake="a"]').selectOption('블로그');
      await page.locator('[data-intake="b"]').selectOption(b);
      await page.locator('[data-intake="c"]').selectOption(c);
      await page.locator('[data-intake="client"]').fill('한결에이전시');
      await page.locator('[data-intake="qty"]').fill(qty);
      await page.locator('[data-intake="sell"]').fill(sell);
      await page.locator('[data-intake-add]').click();
    }
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(2);
    await expect(page.locator('#moduleView .paid-chip span').first()).toHaveText('미입금');

    // 두 건을 묶어 한 번에 입금 처리
    await page.locator('[data-intake-pick]').nth(0).check();
    await page.locator('[data-intake-pick]').nth(1).check();
    await expect(page.locator('#moduleView .pick-bar')).toContainText('2건');
    await page.locator('[data-paid-bulk]').click();
    // 판매액 합계가 기본값으로 채워진다
    await expect(page.locator('#paidAmount')).toHaveValue('50000');

    // 저장 버튼은 입력한 금액을 따라간다. 0원이면 확인이 아니라 수정이다.
    await expect(page.locator('[data-paid-save]')).toHaveText('입금확인');
    await page.locator('#paidAmount').fill('0');
    await expect(page.locator('[data-paid-save]')).toHaveText('입금내용 수정');
    await page.locator('#paidAmount').fill('50000');
    await expect(page.locator('[data-paid-save]')).toHaveText('입금확인');

    // 입금 특이사항이 8자 미만이면 입금확인이 되지 않는다
    await page.locator('#paidMemo').fill('짧음');
    await page.locator('[data-paid-save]').click();
    await expect(page.locator('#paidMemo')).toBeVisible();
    await expect(page.locator('#moduleView .paid-chip span').first()).toHaveText('미입금');

    // 창 바깥을 눌러도 닫히지 않는다
    await page.mouse.click(60, 400);
    await expect(page.locator('#paidMemo')).toBeVisible();

    await page.locator('#paidMemo').fill('국민은행 통장 입금 확인');
    await page.locator('[data-paid-save]').click();

    // 합계만큼 들어왔으니 두 건 모두 입금 완료
    await expect(page.locator('#moduleView .paid-chip span').nth(0)).toHaveText('입금');
    await expect(page.locator('#moduleView .paid-chip span').nth(1)).toHaveText('입금');
    await expect(page.locator('#moduleView .ledger-total')).toContainText('입금 50,000');
    await expect(page.locator('#moduleView .ledger-total')).toContainText('미입금 0');

    // 이미 입금된 건을 다시 열면 저장 버튼이 수정으로 바뀐다
    await page.locator('#moduleView .paid-chip').first().click();
    await expect(page.locator('[data-paid-save]')).toHaveText('입금내용 수정');
    // 입금액을 0으로 넣으면 미입금으로 돌아간다
    await page.locator('#paidAmount').fill('0');
    await page.locator('[data-paid-save]').click();
    await expect(page.locator('#moduleView .paid-chip span').first()).toHaveText('미입금');
  });

  // 하위 계정 정산서는 대표·김대호·박종원만 연다.
  for (const [name, allowed] of [
    ['김대호', true],
    ['박종원', true],
    ['전현우', false],
    ['김지홍', false],
  ] as [string, boolean][]) {
    test(`team ledger is ${allowed ? 'open' : 'closed'} for ${name}`, async ({ page }) => {
      await installFirebaseStub(page);
      await page.route('**/api/**', route => {
        const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
        let payload: unknown = [];
        if (pathname === '/users/me') {
          payload = { uid: 'e2e-test-user', name, role: 'manager', approved: true, is_active: true, group_name: '본사 영업팀' };
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
      await expect(page.locator('#moduleView .team-roster')).toHaveCount(allowed ? 1 : 0);
      if (allowed) {
        // 본사에서 대표와 자기 자신을 뺀 나머지가 목록에 오른다
        await expect(page.locator('#moduleView .team-member')).toHaveCount(10);
        await expect(page.locator('#moduleView .team-member', { hasText: name })).toHaveCount(0);
        await expect(page.locator('#moduleView .team-member', { hasText: '김진봉' })).toHaveCount(0);
      }
    });
  }

  // 정산서는 본사 기준으로 먼저 잡는다. 지사는 접수 경로와 상품이 달라 따로 만든다.
  for (const [name, group, branch, open] of [
    ['김용일', '본사 영업팀', '본사', true],
    ['진영석', '대구지사', '대구지사', false],
    ['손지호', '전주지사', '전주지사', false],
  ] as [string, string, string, boolean][]) {
    test(`intake is ${open ? 'open' : 'closed'} for ${branch}`, async ({ page }) => {
      await installFirebaseStub(page);
      await page.route('**/api/**', route => {
        const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
        let payload: unknown = [];
        if (pathname === '/users/me') {
          payload = { uid: 'e2e-test-user', name, role: 'manager', approved: true, is_active: true, group_name: group };
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
      await expect(page.locator('#moduleView .intake-form')).toHaveCount(open ? 1 : 0);
      if (!open) {
        await expect(page.locator('#moduleView')).toContainText(`${branch} 정산서`);
        await expect(page.locator('#moduleView')).toContainText('지사는 따로 봅니다');
      }
    });
  }

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
