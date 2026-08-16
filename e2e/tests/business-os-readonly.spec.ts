import { test, expect, type Download, type Page } from '@playwright/test';
import { createPeakosStore, handlePeakos, installFirebaseStub, installPeakosStub } from './helpers';


// 접수 폼은 기본으로 접혀 있다. 폼을 쓰는 테스트는 먼저 펼친다.
async function openIntake(page: Page) {
  const toggle = page.locator('[data-intake-toggle]');
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await expect(page.locator('[data-intake="client"]')).toBeVisible();
}

async function revealNavView(page: Page, view: string) {
  const tab = page.locator(`.app-sidebar .nav-item[data-view="${view}"]`).first();
  const cluster = tab.locator('xpath=ancestor::*[@data-nav-cluster][1]');
  if (await cluster.count() && (await cluster.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await cluster.locator(':scope > .nav-cluster-toggle').click();
  }
  const subcluster = tab.locator('xpath=ancestor::*[@data-nav-subcluster][1]');
  if (await subcluster.count() && (await subcluster.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await subcluster.locator(':scope > .nav-subcluster-toggle').click();
  }
  await expect(tab).toBeVisible();
  return tab;
}

async function openNavView(page: Page, view: string) {
  const tab = await revealNavView(page, view);
  await tab.click();
}

test.describe('Business OS read-only operating data', () => {
  test('renders account-scoped Paragon data through the protected collaboration alias', async ({ page }) => {
    test.setTimeout(60_000);
    await installFirebaseStub(page);
    const apiMethods: { method: string; path: string }[] = [];
    const salesSummaryQueries: string[] = [];
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const koreaToday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date()).reduce<Record<string, string>>((result, part) => {
      if (part.type !== 'literal') result[part.type] = part.value;
      return result;
    }, {});
    const year = Number(koreaToday.year);
    const month = Number(koreaToday.month);
    const day = Number(koreaToday.day);
    const date = `${koreaToday.year}-${koreaToday.month}-${koreaToday.day}`;

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

    const peakStore = createPeakosStore('E2E');


    await page.route('**/api/**', route => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const rawPathname = requestUrl.pathname.replace(/^\/api/, '');
      // This fixture explicitly grants the immutable test UID finance access
      // below. Keep the settlement snapshot aligned with that server grant;
      // handlePeakos' legacy display-name allowlist must not override it.
      if (rawPathname === '/peakos/intake' && requestUrl.searchParams.get('scope') === 'all') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(peakStore.intake),
        });
      }
      if (!rawPathname.startsWith('/peakos/collaboration') && handlePeakos(peakStore, route)) return;
      apiMethods.push({ method: request.method(), path: rawPathname });
      const pathname = rawPathname.replace(/^\/peakos\/collaboration/, '') || '/';
      let payload: unknown = {};
      if (pathname === '/users/me') {
        payload = {
          uid: 'e2e-test-user', name: 'E2E', role: 'admin', approved: true, is_active: true,
          group_name: '개발팀', peakos_can_read_bank: true,
          peakos_can_view_bank_balances: false, peakos_can_review_finance: false,
          peakos_can_view_finance_operations: true,
          peakos_can_view_tax_purchase: false, peakos_can_preview_accounts: false,
        };
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
          id: '001155ae-5db3-45a0-b430-21c8324528ee',
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
    await expect(page.locator('.prototype-bar')).toHaveCount(0);
    await expect(page.locator('.topbar #accountPreviewSlot')).toBeHidden();
    await expect(page.locator('.persona-preview-warning')).toHaveCount(0);
    await expect(page.locator('.app-sidebar [data-nav-cluster]')).toHaveCount(6);
    await expect(page.locator('.app-sidebar .sidebar-tree-heading')).toHaveCount(0);
    await expect(page.locator('[data-nav-cluster="finance"]')).toHaveClass(/closed/);
    await expect(page.locator('[data-nav-cluster="tax-banking"]')).toHaveClass(/closed/);
    await expect(page.locator('[data-nav-cluster="tools"]')).toHaveClass(/closed/);
    await page.locator('#sidebarTabSearch').fill('세금');
    await expect(page.locator('[data-nav-cluster="tax-banking"]')).toHaveClass(/search-open/);
    await expect(page.locator('.nav-item[data-view="invoice"]')).toBeVisible();
    await page.locator('#sidebarTabSearch').fill('');
    await expect(page.locator('[data-nav-cluster="tax-banking"]')).toHaveClass(/closed/);
    await expect(page.locator('#dashboardView')).toContainText('오늘 운영 업무');
    await expect(page.locator('#dashboardView [data-dashboard-finance-state="empty"]')).toHaveCount(1);
    await expect(page.locator('#dashboardView')).toContainText('이번 달 매출 데이터가 없습니다');
    await expect(page.locator('#dashboardView')).not.toContainText('₩ 4,820만');

    await page.locator('[data-nav-cluster="main"] > .nav-cluster-toggle').click();
    await page.locator('.nav-item[data-view="todo"]').click();
    await expect(page.locator('#todoView')).toContainText('오늘 운영 업무');
    await expect(page.locator('#todoView .todo-task-check').first()).toBeEnabled();
    await expect(page.locator('#todoView')).not.toContainText('현재 계정에 허용된 오늘 업무를 조회합니다');

    await page.locator('.nav-item[data-view="calendar"]').click();
    await expect(page.locator('#calendarView')).toContainText('오늘 운영 업무');
    await expect(page.locator('#calendarMonthLabel')).toHaveText(`${year}년 ${month}월`);
    await expect(page.locator('#homeCalendarAgenda .agenda-date span')).toContainText(`${year}년 ${month}월 ${day}일`);
    await expect(page.locator('#homeCalendarAgenda .agenda-day-stats')).toContainText('내 일정');
    await expect(page.locator('#homeCalendarAgenda .agenda-day-stats')).toContainText('팀 일정');
    await expect(page.locator('#homeCalendarAgenda .agenda-report-section')).toContainText('일일 보고서 작성');
    await expect(page.locator('#homeCalendarAgenda')).toContainText('체크리스트 1/3');
    await expect(page.locator('#calendarView .panel-subtitle')).toHaveCount(0);
    await page.locator('#homeCalendarAgenda [data-agenda-scope="team"]').click();
    await expect(page.locator('#homeCalendarAgenda')).toContainText('팀 운영 회의');
    await page.locator('#homeCalendarAgenda [data-agenda-scope="all"]').click();
    const nextMonth = new Date(year, month, 1);
    await page.locator('#calendarNext').click();
    await expect(page.locator('#calendarMonthLabel')).toHaveText(`${nextMonth.getFullYear()}년 ${nextMonth.getMonth() + 1}월`);
    await expect(page.locator('#homeCalendarAgenda .agenda-date span')).toContainText(`${nextMonth.getFullYear()}년 ${nextMonth.getMonth() + 1}월 1일`);
    await page.locator('#calendarPrev').click();

    await page.locator('.nav-item[data-view="chat"]').click();
    await page.locator('[data-room-id="room-live-1"]').click();
    await expect(page.locator('#chatThreadMessages')).toContainText('실제 채팅 메시지');
    await expect(page.locator('#chatMessageInput')).toBeEnabled();

    await page.locator('.nav-item[data-view="review"]').click();
    await expect(page.locator('#reviewView .review-page-toolbar')).toHaveCount(1);
    await expect(page.locator('#reviewSearchInput')).toHaveCount(0);
    await page.locator('[data-project-id="project-live-1"]').click();
    await expect(page.locator('#reviewView .project-detail-page')).toBeVisible();
    await expect(page.locator('#reviewView')).toContainText('운영 데이터 연결 프로젝트');
    await expect(page.locator('#reviewView')).toContainText('읽기 전용 업무 확인');
    await expect(page.locator('#reviewView')).toContainText('진행사항 원문');
    await expect(page.locator('#reviewView')).toContainText('프로젝트 전체 대화 원문');
    await expect(page.locator('#reviewView .project-comment-compose textarea')).toBeEnabled();
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

    await page.locator('[data-nav-cluster="company"] > .nav-cluster-toggle').click();
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

    await openNavView(page, 'settlement');
    await openIntake(page);
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
    // 개인정산서는 부장이 봐도 영업자 단가 기준이라 회사 원가가 없다
    await expect(page.locator('#moduleView .ledger-table th', { hasText: '회사원가' })).toHaveCount(0);
    await expect(page.locator('#moduleView .ledger-total')).not.toContainText('회사원가');

    // 임의 admin 표시 역할만으로는 서버의 회사 원가 UID 권한이 생기지 않는다.
    await openNavView(page, 'final-settlement');
    await expect(page.locator('.final-total')).toContainText('회사 공급가 0');
    await openNavView(page, 'settlement');

    await page.locator('[data-nav-cluster="tax-banking"] > .nav-cluster-toggle').click();
    await openNavView(page, 'invoice');
    await expect(page.locator('#moduleView')).toContainText('세금계산서 매출');
    await expect(page.locator('#moduleView')).toContainText('발행 대상');

    await page.locator('.nav-item[data-view="platform"]').click();
    await expect(page.locator('#moduleView')).toContainText('API 통합 정산 흐름');

    await page.locator('[data-nav-cluster="tools"] .nav-cluster-toggle').click();
    await page.locator('.nav-item[data-view="saas"]').click();
    await expect(page.locator('#moduleView')).toContainText('SaaS 사이트 목록');

    expect(apiMethods.length).toBeGreaterThan(0);
    expect(apiMethods.some(call => call.path === '/peakos/collaboration/events')).toBe(true);
    // 정산 데이터만 서버에 쓴다. 그 밖의 운영 데이터는 여전히 읽기만 한다.
    expect(new Set(apiMethods.filter(m => !m.path.startsWith('/peakos')).map(m => m.method)))
      .toEqual(new Set(['GET']));
    expect(pageErrors).toEqual([]);
  });

  test('hides final settlement from a regular member account', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '일반 영업자', uid: 'e2e-test-user', role: 'member', group_name: '영업팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openNavView(page, 'settlement');
    await openIntake(page);
    await expect(page.locator('#moduleView')).toContainText('내 개인정산서');
    await expect(page.locator('.nav-item[data-view="final-settlement"]')).toBeHidden();
    // 영업자에게는 회사 원가를 감춘다
    await expect(page.locator('#moduleView .intake-calc .masked')).toContainText('표시 안 함');
    await expect(page.locator('#moduleView')).toContainText('회사 원가는 감춥니다');
    await expect(page.locator('#moduleView .ledger-table th', { hasText: '회사원가' })).toHaveCount(0);

    // 일반 영업자에게는 회사 관리의 조직도 진입점 자체를 노출하지 않는다.
    await expect(page.locator('.nav-item[data-view="organization"]')).toBeHidden();
    await expect(page.locator('#moduleView [data-open-permissions]')).toHaveCount(0);
    await expect(page.locator('#moduleView [data-org-edit-toggle]')).toHaveCount(0);
    await expect(page.locator('#moduleView [data-org-rank]')).toHaveCount(0);
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
      const peakStore = createPeakosStore(name);

      await page.route('**/api/**', route => {
        if (handlePeakos(peakStore, route)) return;
        const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
        let payload: unknown = [];
        if (pathname === '/users/me') {
          payload = {
            uid: 'e2e-test-user', name, role, approved: true, is_active: true,
            group_name: '본사 영업팀', peakos_can_view_finance_operations: allowed,
          };
        } else if (pathname === '/chat-rooms/unread') {
          payload = {};
        } else if (pathname === '/projects') {
          payload = { canManageAll: false, projects: [] };
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
      });

      await page.goto('/business-os-preview.html');
      await expect(page.locator('#authGate')).toBeHidden();
      await openNavView(page, 'settlement');
      await openIntake(page);
      // 접수 화면은 누구에게나 열린다
      await expect(page.locator('#moduleView .intake-form')).toHaveCount(1);
      const tab = page.locator('.nav-item[data-view="final-settlement"]');
      if (allowed) {
        await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
        await expect(tab).toBeVisible();
        await tab.click();
        await expect(page.locator('#moduleView .final-settlement')).toHaveCount(1);
      } else {
        // 숨은 버튼을 DOM에서 호출해도 최종정산서 내용은 만들지 않는다.
        await expect(tab).toBeHidden();
        await page.evaluate(() => (document.querySelector('.nav-item[data-view="final-settlement"]') as HTMLElement)?.click());
        await expect(page.locator('#moduleView .final-settlement')).toHaveCount(0);
      }
    });
  }

  test('caps reservation drawdown and refunds at the original amount', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await openNavView(page, 'settlement');
    await openIntake(page);

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
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await openNavView(page, 'settlement');
    await openIntake(page);

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
    await openNavView(page, 'final-settlement');
    await expect(page.locator('.final-total')).toContainText('회사 공급가 400,000');
    await openNavView(page, 'settlement');

    // -10으로 되돌리면 매출·회사원가가 함께 빠지고 예약 잔여가 돌아온다
    await page.locator('[data-intake="refOf"]').selectOption({ index: 1 });
    await page.locator('[data-intake="qty"]').fill('-10');
    await page.locator('[data-intake-add]').click();
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(3);
    await expect(page.locator('#moduleView .ledger-total')).toContainText('매출 1,500,000');
    await openNavView(page, 'final-settlement');
    await expect(page.locator('.final-total')).toContainText('회사 공급가 300,000');
    await openNavView(page, 'settlement');
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

  // 접수담당자는 실제로 접수를 넣은 사람과 따로 고르며, 최종정산서에만 나온다.
  test('tags an intake with a manager shown only on the final settlement', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await openNavView(page, 'settlement');
    await openIntake(page);

    // 접수 등록에서 담당자를 함께 보내지 않는다. 담당 배정은 최종정산 전용
    // manager 액션으로만 저장해 일반 영업 수정 권한과 분리한다.
    await expect(page.locator('[data-intake="manager"]')).toHaveCount(0);

    for (const [date, client] of [['2026-08-01', '한결에이전시'], ['2026-08-02', '나스컴퍼니']] as [string, string][]) {
      await page.locator('[data-intake="date"]').fill(date);
      await page.locator('[data-intake="a"]').selectOption('블로그');
      await page.locator('[data-intake="b"]').selectOption('원고');
      await page.locator('[data-intake="c"]').selectOption('프리미엄원고대필');
      await page.locator('[data-intake="client"]').fill(client);
      await page.locator('[data-intake="qty"]').fill('10');
      await page.locator('[data-intake="sell"]').fill('15000');
      await page.locator('[data-intake-add]').click();
    }

    // 개인정산서에는 담당자 열이 없다
    await expect(page.locator('#moduleView .ledger-table thead').first()).not.toContainText('접수담당자');

    // 최종정산서에서만 접수담당자와 접수자가 갈린다
    await openNavView(page, 'final-settlement');
    await openIntake(page);
    const head = page.locator('.final-day-table thead').first();
    await expect(head).toContainText('접수담당자');
    await expect(head).toContainText('접수자');

    await page.locator('[data-final-assign]').click();
    await page.locator('#assignFrom').fill('2026-08-01');
    await page.locator('#assignTo').fill('2026-08-01');
    await page.locator('#assignManager').selectOption('박종원');
    await page.locator('[data-assign-save]').click();

    const rows = page.locator('.final-day-table tbody tr');
    // 최신 일자가 먼저이므로 8/02는 미배정, 8/01만 박종원이다.
    await expect(rows.nth(0).locator('td').nth(0)).toHaveText('담당 없음');
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('김대호');
    await expect(rows.nth(1).locator('td').nth(0)).toHaveText('박종원');
    await expect(rows.nth(1).locator('td').nth(1)).toHaveText('김대호');
  });

  // 최종정산서는 담당자를 정리할 수 있게 기간으로도 조회한다.
  test('filters the final settlement by period', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();

    // 상단 '＋ 새 업무' 버튼은 쓰지 않아 없앴다
    await expect(page.locator('.top-actions .primary-button')).toHaveCount(0);

    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await openNavView(page, 'settlement');
    await openIntake(page);

    for (const [date, client, b, c] of [
      ['2026-08-01', '한결에이전시', '원고', '프리미엄원고대필'],
      ['2026-08-02', '나스컴퍼니', '원고', '프리미엄원고대필'],
      ['2026-08-03', '파인트리', '최적화블로그', '최블 B'],
    ] as [string, string, string, string][]) {
      await page.locator('[data-intake="date"]').fill(date);
      await page.locator('[data-intake="a"]').selectOption('블로그');
      await page.locator('[data-intake="b"]').selectOption(b);
      await page.locator('[data-intake="c"]').selectOption(c);
      await page.locator('[data-intake="client"]').fill(client);
      await page.locator('[data-intake="qty"]').fill('10');
      await page.locator('[data-intake="sell"]').fill('15000');
      await page.locator('[data-intake-add]').click();
    }

    await openNavView(page, 'final-settlement');
    await openIntake(page);
    const rows = page.locator('.final-day-table tbody tr');
    await expect(rows).toHaveCount(3);

    await page.locator('[data-final-filter="from"]').fill('2026-08-02');
    await page.locator('[data-final-filter="to"]').fill('2026-08-03');
    await expect(rows).toHaveCount(2);
    await expect(page.locator('.final-settlement .module-section-head small')).toHaveText('조회 2건 / 전체 3건');

    await page.locator('[data-final-filter-reset]').click();
    await expect(rows).toHaveCount(3);

    // 접수가 많아 한 건씩 고르기 어려우니 기간으로 묶어 배정한다.
    // 행마다 선택 상자를 두지 않는다.
    await expect(page.locator('[data-final-manager]')).toHaveCount(0);
    await page.locator('[data-final-assign]').click();

    // 담당이 상품별로 갈리므로 상품으로도 좁힌다. 소분류는 고른 대분류 안에서만 나온다.
    await page.locator('#assignMajor').selectOption('블로그');
    await expect(page.locator('#assignMinor option')).toHaveText(['소분류 전체', '최블 B', '프리미엄원고대필']);
    await page.locator('#assignMinor').selectOption('프리미엄원고대필');
    await page.locator('#assignManager').selectOption('박종원');
    await expect(page.locator('#assignPreview')).toContainText('2건');
    await expect(page.locator('#assignPreview')).toContainText('블로그 › 프리미엄원고대필');

    // 기간까지 겹치면 하루치 한 건만 남는다
    await page.locator('#assignFrom').fill('2026-08-02');
    await page.locator('#assignTo').fill('2026-08-02');
    await expect(page.locator('#assignPreview')).toContainText('1건');
    await page.locator('[data-assign-save]').click();
    await expect(page.locator('#assignPreview')).toBeHidden();

    // 날짜와 상품이 모두 맞는 건만 바뀐다 (최신 날짜부터 내림차순)
    await expect(rows.nth(0).locator('td').nth(0)).toHaveText('담당 없음');
    await expect(rows.nth(1).locator('td').nth(0)).toHaveText('박종원');
    await expect(rows.nth(2).locator('td').nth(0)).toHaveText('담당 없음');
  });

  // 최종정산서에만 적는 건이 있어 거기서도 접수할 수 있고, 그 건은
  // 개인정산서에 올라가지 않는다. 영업자별로도 추려 본다.
  test('records final-only intakes and filters them by salesperson', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();

    const fill = async (date: string, client: string) => {
      await page.locator('[data-intake="date"]').fill(date);
      await page.locator('[data-intake="a"]').selectOption('블로그');
      await page.locator('[data-intake="b"]').selectOption('원고');
      await page.locator('[data-intake="c"]').selectOption('프리미엄원고대필');
      await page.locator('[data-intake="client"]').fill(client);
      await page.locator('[data-intake="qty"]').fill('10');
      await page.locator('[data-intake="sell"]').fill('15000');
      await page.locator('[data-intake-add]').click();
    };

    await openNavView(page, 'settlement');
    await openIntake(page);
    await fill('2026-08-01', '한결에이전시');
    await fill('2026-08-02', '나스컴퍼니');
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(2);

    // 최종정산서에도 접수 폼이 있고, 전용 건임을 알린다
    await openNavView(page, 'final-settlement');
    await openIntake(page);
    await expect(page.locator('#moduleView .module-section-head strong').first()).toHaveText('최종정산서 접수');
    await expect(page.locator('#moduleView .module-section-head .module-chip').first()).toHaveText('최종정산서 전용');
    const finalRows = page.locator('.final-day-table tbody tr');
    await expect(finalRows).toHaveCount(2);

    const assignDate = async (date: string, manager: string) => {
      await page.locator('[data-final-assign]').click();
      await page.locator('#assignFrom').fill(date);
      await page.locator('#assignTo').fill(date);
      await page.locator('#assignManager').selectOption(manager);
      await page.locator('[data-assign-save]').click();
    };
    await assignDate('2026-08-01', '박종원');
    await assignDate('2026-08-02', '김용일');

    await fill('2026-08-03', '퍼플페퍼');
    await expect(finalRows).toHaveCount(3);
    await expect(page.locator('.kind-badge.final-only')).toHaveCount(1);
    await assignDate('2026-08-03', '박종원');

    // 개인정산서에는 올라가지 않는다
    await openNavView(page, 'settlement');
    await openIntake(page);
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(2);
    await expect(page.locator('#moduleView')).not.toContainText('퍼플페퍼');

    // 영업자로 추리면 그 사람 건만 남는다
    await openNavView(page, 'final-settlement');
    await openIntake(page);
    await page.locator('[data-final-filter="manager"]').selectOption('박종원');
    await expect(finalRows).toHaveCount(2);
    await expect(page.locator('.final-settlement .module-section-head small')).toHaveText('조회 2건 / 전체 3건');
    await page.locator('[data-final-filter="manager"]').selectOption('김용일');
    await expect(finalRows).toHaveCount(1);
    await page.locator('[data-final-filter="manager"]').selectOption('none');
    await expect(finalRows).toHaveCount(0);
    await page.locator('[data-final-filter-reset]').click();
    await expect(finalRows).toHaveCount(3);
  });

  // 공급사 정산은 공급처별로 수량을 맞춰 본 뒤에야 지불로 확정된다.
  test('settles suppliers only when the quantity matches', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await openNavView(page, 'settlement');
    await openIntake(page);

    // 같은 공급처(키지애드)로 붙는 상품 두 건 — 20개 + 30개
    for (const [client, qty, sell] of [['한결에이전시', '20', '15000'], ['나스컴퍼니', '30', '14000']] as [string, string, string][]) {
      await page.locator('[data-intake="a"]').selectOption('블로그');
      await page.locator('[data-intake="b"]').selectOption('원고');
      await page.locator('[data-intake="c"]').selectOption('프리미엄원고대필');
      await page.locator('[data-intake="client"]').fill(client);
      await page.locator('[data-intake="qty"]').fill(qty);
      await page.locator('[data-intake="sell"]').fill(sell);
      // 상품을 고르면 시트 기준 공급처가 자동으로 붙는다
      await expect(page.locator('[data-intake="supplier"]')).toHaveValue('키지애드 (50)');
      await page.locator('[data-intake-add]').click();
    }

    await openNavView(page, 'final-settlement');
    await openIntake(page);

    // 일별 취합은 시트와 같은 열로 그린다
    const head = page.locator('.final-day-table thead').first();
    for (const col of ['공급처명', '회사 원가', '회사 공급가', '영업자 공급가액', '판매가액', '영업이익(영업자)', '영업이익(회사)', '공급처 입금']) {
      await expect(head).toContainText(col);
    }

    // 공급처별 지불액 = 회사 원가 10,000 x 50개
    const vendorRow = page.locator('.vendor-table tbody tr', { hasText: '키지애드' });
    await expect(vendorRow).toContainText('50');
    await expect(vendorRow).toContainText('500,000');

    await vendorRow.locator('[data-vendor-settle]').click();
    await expect(page.locator('.paid-summary')).toContainText('500,000');

    // 수량이 다르면 정산되지 않는다
    await page.locator('#vendorQty').fill('45');
    await page.locator('#vendorMemo').fill('국민은행에서 송금 완료');
    await page.locator('[data-vendor-save]').click();
    await expect(page.locator('#vendorQty')).toBeVisible();

    // 특이사항이 짧아도 막힌다
    await page.locator('#vendorQty').fill('50');
    await page.locator('#vendorMemo').fill('송금');
    await page.locator('[data-vendor-save]').click();
    await expect(page.locator('#vendorQty')).toBeVisible();

    // 어느 통장에서 나갔는지 남긴다
    await expect(page.locator('#vendorBank option')).toHaveText(
      ['매출통장', '공급처통장', '고정비용통장', '리워드스페이스통장', '리뷰스페이스통장']
    );
    await expect(page.locator('#vendorBank')).toHaveValue('공급처통장');
    await page.locator('#vendorBank').selectOption('리워드스페이스통장');

    // 정산자명은 클라이언트가 고치지 않고 서버가 인증 사용자로 확정한다.
    await expect(page.locator('#vendorBy')).toHaveCount(0);

    // 수량이 맞아야 지불로 확정된다
    await page.locator('#vendorMemo').fill('국민은행에서 송금 완료');
    await page.locator('[data-vendor-save]').click();
    await expect(page.locator('#vendorQty')).toBeHidden();
    await expect(vendorRow).toContainText('내역 보기');
    await expect(page.locator('.vendor-settlement .module-chip')).toContainText('미지불 0원');
    await expect(vendorRow).toContainText('리워드스페이스통장');
    await expect(vendorRow).toContainText('김대호');
    await expect(page.locator('.final-day-table .vendor-chip.done').first()).toContainText('리워드스페이스통장');
    // 다시 열면 지난번 통장이 잡혀 있다
    await vendorRow.locator('[data-vendor-settle]').click();
    await expect(page.locator('#vendorBank')).toHaveValue('리워드스페이스통장');
    await expect(page.locator('.final-day-table .vendor-chip.done')).toHaveCount(2);
  });

  // 최종정산서에는 당일접수·예약건 작업·환불·예약건환불만 올라간다.
  // 예약최초건은 아직 일이 들어가지 않아 매출이 아니므로 빠진다.
  test('final settlement lists only worked rows and drops the reservation', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await openNavView(page, 'settlement');
    await openIntake(page);

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

    await openNavView(page, 'final-settlement');
    await openIntake(page);
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
    await expect(final.locator('.final-total')).toContainText('판매가액 275,000');
  });

  // 거래처에 보낼 견적서를 접수 건에서 뽑는다. 상품명·카테고리는 자유롭게 고친다.
  test('issues one work estimate per client and downloads it as an image', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await openNavView(page, 'settlement');
    await openIntake(page);

    for (const [client, b, c, qty, sell] of [
      ['장면을만드는사람들', '최적화블로그', '최블 B', '30', '1800'],
      ['장면을만드는사람들', '원고', '프리미엄원고대필', '5', '20000'],
      ['다른업체', '원고', '프리미엄원고대필', '3', '20000'],
    ] as [string, string, string, string, string][]) {
      await page.locator('[data-intake="a"]').selectOption('블로그');
      await page.locator('[data-intake="b"]').selectOption(b);
      await page.locator('[data-intake="c"]').selectOption(c);
      await page.locator('[data-intake="client"]').fill(client);
      await page.locator('[data-intake="qty"]').fill(qty);
      await page.locator('[data-intake="sell"]').fill(sell);
      await page.locator('[data-intake-add]').click();
    }

    // 거래처를 골라 두면 그 업체 건만 한 장으로 묶인다
    await page.locator('[data-ledger-filter="client"]').selectOption('장면을만드는사람들');
    await page.locator('[data-estimate-open]').click();
    await expect(page.locator('#estClient')).toHaveValue('장면을만드는사람들');
    await expect(page.locator('#estLines tr')).toHaveCount(2);
    await expect(page.locator('#estSum')).toContainText('합계 169,400원');

    // 보낼 이름으로 고쳐 쓴다
    await page.locator('[data-est-line="name"]').first().fill('후기성 준최 2');
    await page.locator('[data-est-line="category"]').first().fill('블로그');
    await page.locator('#estCeo').fill('김정후');

    // 필요 없는 줄은 뺀다 — 30 x 1,800 = 54,000 / VAT 5,400
    await page.locator('[data-est-remove]').nth(1).click();
    await expect(page.locator('#estLines tr')).toHaveCount(1);
    await expect(page.locator('#estSum')).toContainText('공급가액 54,000');
    await expect(page.locator('#estSum')).toContainText('세액 5,400');
    await expect(page.locator('#estSum')).toContainText('합계 59,400원');

    // 접수 원본은 그대로다
    const download = page.waitForEvent('download');
    await page.locator('[data-est-download]').click();
    expect((await download).suggestedFilename()).toMatch(/^견적서_장면을만드는사람들_\d{8}\.png$/);

    await page.locator('[data-est-close]').click();
    await page.locator('[data-ledger-filter-reset]').click();
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(3);
    await expect(page.locator('#moduleView .ledger-table tbody')).toContainText('최블 B');
  });

  // 표에서 건을 골라 그 건만 정산서로 내고, 접수 없이 새로 만들 수도 있다.
  test('issues an estimate from picked rows and from scratch', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await openNavView(page, 'settlement');
    await openIntake(page);

    for (const [client, b, c, qty, sell] of [
      ['나스컴퍼니', '최적화블로그', '최블 B', '30', '1800'],
      ['나스컴퍼니', '원고', '프리미엄원고대필', '5', '20000'],
      ['나스컴퍼니', '원고', '외주대필', '2', '9000'],
      ['다른업체', '원고', '프리미엄원고대필', '3', '20000'],
    ] as [string, string, string, string, string][]) {
      await page.locator('[data-intake="a"]').selectOption('블로그');
      await page.locator('[data-intake="b"]').selectOption(b);
      await page.locator('[data-intake="c"]').selectOption(c);
      await page.locator('[data-intake="client"]').fill(client);
      await page.locator('[data-intake="qty"]').fill(qty);
      await page.locator('[data-intake="sell"]').fill(sell);
      await page.locator('[data-intake-add]').click();
    }

    // 같은 업체 두 건을 고르면 그 두 건만 한 장에 담긴다
    const picks = page.locator('[data-intake-pick]');
    await picks.nth(0).check();
    await picks.nth(1).check();
    await page.locator('[data-estimate-pick]').click();
    await expect(page.locator('#estClient')).toHaveValue('나스컴퍼니');
    await expect(page.locator('#estLines tr')).toHaveCount(2);
    await expect(page.locator('#estSum')).toContainText('합계 169,400원');
    await page.locator('[data-est-close]').click();

    // 업체가 다른 건이 섞이면 한 장으로 낼 수 없다
    await picks.nth(3).check();
    await page.locator('[data-estimate-pick]').click();
    await expect(page.locator('#estClient')).toBeHidden();

    // 접수 없이 받을 돈은 빈 정산서로 만든다
    await page.locator('[data-paid-clear-pick]').click();
    await page.locator('[data-estimate-new]').click();
    await expect(page.locator('#estClient')).toHaveValue('');
    await expect(page.locator('#estLines tr')).toHaveCount(1);
    await page.locator('#estClient').fill('신규거래처');

    // 받는 통장이 상품에 따라 달라 정산서마다 고른다
    await expect(page.locator('#estBank option')).toHaveText([
      '피크마케팅 · 기업은행 568-048256-04-017',
      '리워드스페이스 · 기업은행 076-507041-04-022',
      '리뷰스페이스 · 기업은행 076-507041-04-015',
    ]);
    await expect(page.locator('#estBank')).toHaveValue('피크마케팅');
    await page.locator('#estBank').selectOption('리워드스페이스');

    await page.locator('[data-est-line="name"]').first().fill('선입금 건');
    await page.locator('[data-est-line="unit"]').first().fill('300000');
    await page.locator('[data-est-line="qty"]').first().fill('1');
    await expect(page.locator('#estSum')).toContainText('합계 330,000원');

    // 업체 이름을 넣고 접수를 통째로 불러올 수도 있다
    await page.locator('#estClient').fill('나스컴퍼니');
    await page.locator('[data-est-load]').click();
    await expect(page.locator('#estLines tr')).toHaveCount(3);
    await expect(page.locator('#estSum')).toContainText('합계 189,200원');
    await page.locator('[data-est-clear]').click();
    await expect(page.locator('#estLines tr')).toHaveCount(0);
  });

  // 단가는 상품별로 고칠 수 있고, 고친 값이 접수 화면과 영업자 단가표에 함께 간다.
  test('edits a single product price while account preview keeps financial data private', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();

    // 개인정산서 단가표에서는 고칠 수 없다
    await openNavView(page, 'settlement');
    await page.locator('[data-price-table]').click();
    await expect(page.locator('[data-price-edit-open]')).toHaveCount(0);
    await page.locator('[data-price-close]').click();

    // 최종정산서에서 최블 B 단가를 고친다 (17,000 / 19,000)
    await openNavView(page, 'final-settlement');
    await page.locator('[data-price-table]').click();
    await page.locator('#priceSearch').fill('최블 B');
    const row = page.locator('.price-table tbody tr').first();
    await expect(row).toContainText('17,000');
    await expect(row).toContainText('19,000');

    await row.locator('[data-price-edit-open]').click();
    await page.locator('[data-price-edit="cost"]').fill('18000');
    await page.locator('[data-price-edit="unit"]').fill('21000');
    await page.locator('[data-price-edit-save]').click();

    const edited = page.locator('.price-table tbody tr').first();
    await expect(edited.locator('.kind-badge.edited')).toHaveCount(1);
    await expect(edited).toContainText('18,000');
    await expect(edited).toContainText('21,000');
    await page.locator('[data-price-close]').click();

    // 접수 화면 단가도 따라간다
    await openIntake(page);
    await page.locator('[data-intake="a"]').selectOption('블로그');
    await page.locator('[data-intake="b"]').selectOption('최적화블로그');
    await page.locator('[data-intake="c"]').selectOption('최블 B');
    await expect(page.locator('[data-intake="unit"]')).toHaveValue('21000');

    // 계정 미리보기는 대상자의 메뉴 구조만 재현하며 금융 API·단가 데이터는
    // 읽지 않는다. 실제 타 계정 로그인 공유는 서버 단가 계약에서 검증한다.
    await page.locator('#personaSelect').selectOption('김용일');
    await openNavView(page, 'settlement');
    await page.locator('[data-price-table]').click();
    await page.locator('#priceSearch').fill('최블 B');
    const shared = page.locator('.price-table tbody tr').first();
    await expect(shared).toContainText('찾는 상품이 없습니다.');
    await expect(shared).not.toContainText('21,000');
    await expect(shared).not.toContainText('18,000');
    await expect(page.locator('[data-price-edit-open]')).toHaveCount(0);
    await page.locator('[data-price-close]').click();

    // 되돌리면 원래 단가로 돌아온다
    await page.locator('#personaSelect').selectOption('');
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await openNavView(page, 'final-settlement');
    await page.locator('[data-price-table]').click();
    await page.locator('#priceSearch').fill('최블 B');
    await page.locator('[data-price-edit-reset]').first().click();
    const reset = page.locator('.price-table tbody tr').first();
    await expect(reset).toContainText('17,000');
    await expect(reset).toContainText('19,000');
    await expect(reset.locator('.kind-badge.edited')).toHaveCount(0);
  });

  // 미수금 현황은 자금 현황판이다. 대표님 시트의 계산식을 그대로 따른다.
  //   현잔고 + 영업자 미수금 − (공급처 입금 + 선결제) = 실질적으로 남은 금액
  test('adds up the fund board exactly like the owner sheet', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    const go = (view: string) => page.evaluate(
      v => (document.querySelector(`.nav-item[data-view="${v}"]`) as HTMLElement)?.click(), view);
    await go('receivable');

    // 26-07 기준 실제 숫자
    for (const [name, value] of [
      ['리워드스페이스', '58665140'], ['리뷰스페이스', '57833010'],
      ['매출', '54190495'], ['공급처', '18259725'], ['고정비용', '24954829'],
    ] as [string, string][]) {
      await page.locator(`[data-fund-bank="${name}"]`).fill(value);
    }
    for (const [name, value] of [
      ['회사', '3406700'], ['박종원', '16088325'], ['김대호', '0'],
      ['김지홍', '211640'], ['박우진', '0'], ['김주현', '770000'], ['김용일', '194700'],
    ] as [string, string][]) {
      await page.locator(`[data-fund-money="ar"][data-fund-name="${name}"][data-fund-field="total"]`).fill(value);
    }
    for (const [name, value] of [
      ['헬로우드림', '1997380'], ['엠플리파이', '19008880'], ['윙', '1996500'], ['키지애드', '957000'],
      ['H2 C&C', '165000'], ['아바티', '14321530'], ['기발한마케팅', '1925000'], ['데이터봇', '572000'],
    ] as [string, string][]) {
      await page.locator('[data-fund-vendor-add]').click();
      const index = (await page.locator('[data-fund-vendor="name"]').count()) - 1;
      await page.locator(`[data-fund-vendor="name"][data-fund-index="${index}"]`).fill(name);
      await page.locator(`[data-fund-vendor="total"][data-fund-index="${index}"]`).fill(value);
    }

    const out = (key: string) => page.locator(`[data-fund-out="${key}"]`).first();
    await expect(out('bank')).toHaveText('213,903,199');
    await expect(out('ar')).toHaveText('20,671,365');
    await expect(out('vendor')).toHaveText('40,943,290');
    await expect(out('real')).toHaveText('193,631,274');

    // 월급을 넣으면 실제 통장 잔여가 그만큼 줄어든다
    const payrollSaved = page.waitForResponse(response => {
      if (!response.url().includes('/api/peakos/fund') || response.request().method() !== 'PUT') return false;
      const payload = response.request().postDataJSON();
      return String(payload?.board?.payroll?.['박종원'] || '') === '3000000';
    });
    await page.locator('[data-fund-payroll="박종원"]').fill('3000000');
    await expect(out('payroll')).toHaveText('3,000,000');
    await expect(out('after')).toHaveText('190,631,274');
    await payrollSaved;

    // 새로고침해도 남는다
    await page.reload();
    await expect(page.locator('#authGate')).toBeHidden();
    await go('receivable');
    await expect(out('real')).toHaveText('193,631,274');

    // 현재 로그인한 자금 현황 권한 계정에는 탭이 계속 열린다.
    await expect(page.locator('.nav-item[data-view="receivable"]')).toBeVisible();
  });

  // 새로 붙인 다섯 탭. 회사 돈을 다루는 충전금·결산은 지정 인원만 본다.
  test('adds the five new tabs with the right scope', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    const go = (view: string) => page.evaluate(
      v => (document.querySelector(`.nav-item[data-view="${v}"]`) as HTMLElement)?.click(), view);

    await go('settlement');
    await openIntake(page);
    for (const [client, qty, sell] of [['한결에이전시', '10', '25000'], ['나스컴퍼니', '20', '15000']]) {
      await page.locator('[data-intake="a"]').selectOption('블로그');
      await page.locator('[data-intake="b"]').selectOption('최적화블로그');
      await page.locator('[data-intake="c"]').selectOption('최블 B');
      await page.locator('[data-intake="client"]').fill(client);
      await page.locator('[data-intake="qty"]').fill(qty);
      await page.locator('[data-intake="sell"]').fill(sell);
      await page.locator('[data-intake-add]').click();
    }
    // 서버 canonical 응답을 받은 뒤에만 다음 탭으로 이동한다. 저장 완료
    // 렌더가 늦게 돌아와 입금체크 화면을 다시 덮지 않게 한다.
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(2);

    // 입금체크 — 업체별 미수금 (250,000 + 300,000)
    await go('deposit-check');
    await expect(page.locator('#moduleView .module-chip').first()).toContainText('미수 550,000원');

    // 세금계산서 — 공급가액과 세액
    await go('invoice');
    const invoiceRow = page.locator('#moduleView .sales-table tbody tr', { hasText: '나스컴퍼니' });
    await expect(invoiceRow).toContainText('300,000');
    await expect(invoiceRow).toContainText('30,000');

    // 결산 — 월별 합계
    await go('closing');
    await expect(page.locator('#moduleView .sales-table tbody tr').first()).toContainText('2026년 08월');
    await expect(page.locator('#moduleView .final-total')).toContainText('판매가액 550,000');

    // 충전금 — 입금액과 충전 포인트를 따로 적는다
    await go('credit');
    await page.locator('[data-credit="client"]').fill('원앤온리컴퍼니');
    await page.locator('[data-credit="paid"]').fill('300000');
    await page.locator('[data-credit="point"]').fill('330000');
    await page.locator('[data-credit-add]').click();
    const creditRow = page.locator('#moduleView .sales-table tbody tr').first();
    await expect(creditRow).toContainText('300,000');
    await expect(creditRow).toContainText('330,000');
    await expect(creditRow).toContainText('30,000');

    // 명함 — 조직도 정보와 영문 이름을 넣어 제공받은 구조의 한 장으로 받는다
    await go('namecard');
    await expect(page.locator('[data-card="name"]')).toHaveValue('김대호');
    await expect(page.locator('[data-card="rank"]')).toHaveValue('부장');
    await page.locator('[data-card="englishName"]').fill('Dae Ho Kim');
    await page.locator('[data-card="phone"]').fill('010-1234-5678');
    await expect(page.locator('#namecardCanvas')).toHaveJSProperty('width', 1500);
    await expect(page.locator('#namecardCanvas')).toHaveJSProperty('height', 1696);
    await expect(page.locator('#namecardCanvas')).toHaveAttribute('data-template-ready', 'true');
    await expect(page.locator('[data-card-download]')).toHaveCount(1);

    const namecardDownload = page.waitForEvent('download');
    await page.locator('[data-card-download]').click();
    expect((await namecardDownload).suggestedFilename()).toBe('명함_김대호.png');

    // 현재 로그인한 재무 검토 계정에는 다섯 화면이 모두 열린다.
    for (const view of ['credit', 'closing', 'deposit-check', 'invoice', 'namecard']) {
      await expect(page.locator(`.nav-item[data-view="${view}"]`)).toBeVisible();
    }
  });

  test('renders and downloads the supplied 1500x1696 single-sheet namecard layout', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });
    await page.setViewportSize({ width: 390, height: 844 });
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.evaluate(() => {
      (document.querySelector('.nav-item[data-view="namecard"]') as HTMLElement)?.click();
    });

    await expect(page.locator('[data-card="name"]')).toHaveValue('김대호');
    await expect(page.locator('[data-card="rank"]')).toHaveValue('부장');
    const canvas = page.locator('#namecardCanvas');
    await expect(canvas).toHaveAttribute('data-template-ready', 'true');
    const beforeInput = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    await page.locator('[data-card="englishName"]').fill('Dae Ho Kim');
    await page.locator('[data-card="phone"]').fill('010-1234-5678');
    await page.locator('[data-card="email"]').fill('name@peak.kr');

    await expect(canvas).toHaveJSProperty('width', 1500);
    await expect(canvas).toHaveJSProperty('height', 1696);
    await expect(canvas).toHaveCSS('min-width', '0px');
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.width / element.height)).toBeCloseTo(1500 / 1696, 8);
    await expect(page.locator('[data-card-download]')).toHaveCount(1);
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).not.toBe(beforeInput);
    const templateCheck = await canvas.evaluate(async (element: HTMLCanvasElement) => {
      const context = element.getContext('2d')!;
      const image = new Image();
      image.src = '/peak-namecard-template.png?v=20260809-namecardoriginal1';
      await image.decode();
      const reference = document.createElement('canvas');
      reference.width = element.width;
      reference.height = element.height;
      const referenceContext = reference.getContext('2d')!;
      referenceContext.fillStyle = '#ffffff';
      referenceContext.fillRect(0, 0, reference.width, reference.height);
      referenceContext.drawImage(image, 0, 0, reference.width, reference.height);

      let staticPixelMismatches = 0;
      for (const [x, y, width, height] of [[0, 0, 1500, 880], [0, 1085, 1500, 611]]) {
        const actual = context.getImageData(x, y, width, height).data;
        const expected = referenceContext.getImageData(x, y, width, height).data;
        for (let index = 0; index < actual.length; index += 1) {
          if (actual[index] !== expected[index]) staticPixelMismatches += 1;
        }
      }
      const privateBand = referenceContext.getImageData(0, 880, 1500, 205).data;
      let templatePrivateBandNonWhitePixels = 0;
      for (let index = 0; index < privateBand.length; index += 4) {
        if (privateBand[index] !== 255 || privateBand[index + 1] !== 255
          || privateBand[index + 2] !== 255 || privateBand[index + 3] !== 255) {
          templatePrivateBandNonWhitePixels += 1;
        }
      }
      const footer = context.getImageData(50, 650, 560, 180).data;
      let footerWhitePixels = 0;
      for (let index = 0; index < footer.length; index += 4) {
        if (footer[index] > 245 && footer[index + 1] > 245 && footer[index + 2] > 245) footerWhitePixels += 1;
      }
      const blue = [...context.getImageData(500, 500, 1, 1).data].slice(0, 3);
      const symbol = [...context.getImageData(1290, 100, 1, 1).data].slice(0, 3);
      return { staticPixelMismatches, templatePrivateBandNonWhitePixels, footerWhitePixels, blue, symbol };
    });
    expect(templateCheck.staticPixelMismatches).toBe(0);
    expect(templateCheck.templatePrivateBandNonWhitePixels).toBe(0);
    expect(templateCheck.footerWhitePixels).toBeGreaterThan(1_000);
    expect(templateCheck.blue).toEqual([52, 142, 205]);
    expect(templateCheck.symbol).toEqual([255, 255, 255]);

    const verifyPng = async (download: Download) => {
      const stream = await download.createReadStream();
      if (!stream) throw new Error('다운로드 PNG 스트림이 없습니다.');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const png = Buffer.concat(chunks);
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(png.readUInt32BE(16)).toBe(1500);
      expect(png.readUInt32BE(20)).toBe(1696);
    };

    const download = page.waitForEvent('download');
    await page.locator('[data-card-download]').click();
    const downloaded = await download;
    expect(downloaded.suggestedFilename()).toBe('명함_김대호.png');
    await verifyPng(downloaded);

    // 비정상적으로 긴 입력도 각 정보 영역 안에서 줄임표로 처리하고 Canvas 크기를 유지한다.
    await page.locator('[data-card="name"]').fill('김대호'.repeat(40));
    await page.locator('[data-card="englishName"]').fill('Dae Ho Kim With A Very Long English Name '.repeat(8));
    await page.locator('[data-card="team"]').fill('본사 경영지원 전략기획 마케팅 운영팀'.repeat(12));
    await page.locator('[data-card="email"]').fill('very-long-business-email-address-'.repeat(12) + '@peak.kr');
    await expect(canvas).toHaveJSProperty('width', 1500);
    await expect(canvas).toHaveJSProperty('height', 1696);
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(horizontalOverflow).toBeLessThanOrEqual(1);
    expect(pageErrors).toEqual([]);
  });

  // 김지홍 월보장, 박우진 월관리, 김대호 직접실행은 판매 한 건에 실행 여러 건이 붙어
  // 표준 정산서로 담기지 않는다. 각자 별도 탭으로 둔다.
  for (const [name, guarantee, manage, direct] of [
    ['김대호', false, false, true], ['김진봉', false, false, false],
    ['김지홍', true, false, false], ['박우진', false, true, false],
    ['패션TV봉이', false, false, false], ['손명아', false, false, false],
    ['박종원', false, false, false], ['전현우', false, false, false],
    ['김용일', false, false, false], ['은시후', false, false, false],
  ] as [string, boolean, boolean, boolean][]) {
    test(`monthly settlement tabs are scoped for ${name}`, async ({ page }) => {
      await installFirebaseStub(page);
      const peakStore = createPeakosStore(name);

      await page.route('**/api/**', route => {
        if (handlePeakos(peakStore, route)) return;
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
      await revealNavView(page, 'settlement');

      for (const [view, allowed] of [
        ['monthly-guarantee', guarantee],
        ['monthly-manage', manage],
        ['direct-execution', direct],
      ] as [string, boolean][]) {
        const tab = page.locator(`.nav-item[data-view="${view}"]`);
        if (allowed) {
          await expect(tab).toBeVisible();
        } else {
          await expect(tab).toBeHidden();
        }
      }
    });
  }

  // 판매 한 건에 실행 비용을 붙여 묶음별 손익을 낸다.
  test('nests run costs under a monthly sale and nets the profit', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김지홍', uid: 'e2e-test-user', role: 'manager', group_name: '본사 영업팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openNavView(page, 'monthly-guarantee');

    const pick = async (a: string, b: string, c: string) => {
      await page.locator('[data-monthly="a"]').selectOption(a);
      await page.locator('[data-monthly="b"]').selectOption(b);
      await page.locator('[data-monthly="c"]').selectOption(c);
    };

    // 월보장 320,000 한 줄
    await page.locator('[data-monthly="client"]').fill('김지홍월보장_명동미용실');
    await pick('플레이스', '상위노출', '월보장');
    await page.locator('[data-monthly="amount"]').fill('320000');
    await page.locator('[data-monthly="qty"]').fill('1');
    await page.locator('[data-monthly-add]').click();

    const head = page.locator('.monthly-head').first();
    await expect(head).toContainText('판매 320,000');
    await expect(head).toContainText('영업이익 320,000');

    // 매출 카드에서 실행비 추가를 누르면 대상이 자동 연결된다
    await expect(page.getByText('어디에 붙일까요', { exact: true })).toHaveCount(0);
    await page.locator('[data-monthly-run]').first().click();
    await expect(page.locator('[data-monthly="client"]')).toHaveValue('김지홍월보장_명동미용실');
    await pick('블로그', '원고', '프리미엄원고대필');
    await page.locator('[data-monthly="amount"]').fill('11000');
    await page.locator('[data-monthly="qty"]').fill('1');
    await page.locator('[data-monthly-add]').click();

    await expect(head).toContainText('실행 11,000');
    await expect(head).toContainText('영업이익 309,000');
    await expect(page.locator('.monthly-table tbody tr').first()).toContainText('-11,000');
    await expect(page.locator('.ledger-total')).toContainText('영업이익 309,000');

    // 실행 건이 붙은 매출은 일괄 삭제하지 않는다. 실행 건을 먼저 지운 뒤
    // 매출을 지워야 원본 연결과 삭제 이력이 모호해지지 않는다.
    await page.locator('.monthly-head [data-monthly-remove]').first().click();
    await expect(page.locator('.toast')).toContainText('실행 건을 먼저 삭제');
    await expect(page.locator('.monthly-group')).toHaveCount(1);
    await expect(page.locator('.monthly-table tbody tr')).toHaveCount(1);
    await page.locator('.monthly-table [data-monthly-remove]').click();
    await expect(page.locator('.monthly-table tbody tr')).toHaveCount(0);
    await page.locator('.monthly-head [data-monthly-remove]').first().click();
    await expect(page.locator('.monthly-group')).toHaveCount(0);
  });

  // 회사 원가는 직급이 아니라 지정된 다섯 사람만 본다.
  for (const [name, allowed] of [
    ['패션TV봉이', true], ['손명아', true], ['김대호', true], ['박종원', true], ['전현우', true],
    ['김진봉', false],
    ['김지홍', false], ['박우진', false], ['김주현', false], ['김용일', false], ['은시후', false],
    ['이종혁', false], ['김동우', false],
  ] as [string, boolean][]) {
    test(`company cost stays hidden unless named — ${name}`, async ({ page }) => {
      await installFirebaseStub(page);
      const peakStore = createPeakosStore(name);

      await page.route('**/api/**', route => {
        if (handlePeakos(peakStore, route)) return;
        const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
        let payload: unknown = [];
        if (pathname === '/users/me') {
          payload = {
            uid: 'e2e-test-user', name, role: 'manager', approved: true, is_active: true,
            group_name: '본사 영업팀', peakos_can_view_finance_operations: allowed,
          };
        } else if (pathname === '/chat-rooms/unread') {
          payload = {};
        } else if (pathname === '/projects') {
          payload = { canManageAll: false, projects: [] };
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
      });

      await page.goto('/business-os-preview.html');
      await expect(page.locator('#authGate')).toBeHidden();
      await openNavView(page, 'settlement');

      await openIntake(page);
      await page.locator('[data-intake="a"]').selectOption('블로그');
      await page.locator('[data-intake="b"]').selectOption('원고');
      await page.locator('[data-intake="c"]').selectOption('프리미엄원고대필');
      await page.locator('[data-intake="client"]').fill('한결에이전시');
      await page.locator('[data-intake="qty"]').fill('10');
      await page.locator('[data-intake="sell"]').fill('15000');
      await page.locator('[data-intake-add]').click();

      // 개인정산서는 명단 5인에게도 영업자 단가 기준으로만 보인다
      await expect(page.locator('#moduleView .ledger-table thead').first())
        .not.toContainText('회사원가');
      await expect(page.locator('#moduleView .intake-calc')).toContainText('표시 안 함');

      const banner = page.locator('#moduleView .module-security');
      if (allowed) {
        await expect(banner).toContainText('회사 원가는 최종정산서에서만 봅니다');
        // 단가표에서도 회사원가가 보인다
        await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
        await openNavView(page, 'final-settlement');
        await page.locator('[data-price-table]').click();
        await expect(page.locator('.price-table thead th')).toHaveText(['대분류', '중분류', '소분류', '회사원가', '영업자단가', '']);
      } else {
        await expect(banner).toContainText('영업자 단가 기준으로만 표시되며 회사 원가는 감춥니다');
        // 최종정산서 자체가 열리지 않으니 회사원가에 닿을 길이 없다
        await expect(page.locator('.nav-item[data-view="final-settlement"]')).toBeHidden();
        await page.locator('[data-price-table]').click();
        await expect(page.locator('.price-table thead th')).toHaveText(['대분류', '중분류', '소분류', '영업자단가']);
        await expect(page.locator('.price-table')).not.toContainText('회사원가');
      }
    });
  }

  // 단가표는 화면에 따라 열이 다르다. 개인정산서는 영업자단가만.
  for (const [name, allowed] of [['김대호', true], ['김용일', false]] as [string, boolean][]) {
    test(`shows the price table scoped to the screen for ${name}`, async ({ page }) => {
      await installFirebaseStub(page);
      const peakStore = createPeakosStore(name);

      await page.route('**/api/**', route => {
        if (handlePeakos(peakStore, route)) return;
        const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
        let payload: unknown = [];
        if (pathname === '/users/me') {
          payload = {
            uid: 'e2e-test-user', name, role: 'manager', approved: true, is_active: true,
            group_name: '본사 영업팀', peakos_can_view_finance_operations: allowed,
          };
        } else if (pathname === '/chat-rooms/unread') {
          payload = {};
        } else if (pathname === '/projects') {
          payload = { canManageAll: false, projects: [] };
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
      });

      await page.goto('/business-os-preview.html');
      await expect(page.locator('#authGate')).toBeHidden();
      await openNavView(page, 'settlement');

      // 개인정산서에서는 영업자단가만 보인다
      await page.locator('[data-price-table]').click();
      await expect(page.locator('#readonlyModalTitle')).toHaveText('단가표 · 영업자단가');
      await expect(page.locator('.price-warning')).toContainText('주의 · 대외비');
      await expect(page.locator('.price-warning')).toContainText('피크마케팅 회사 내 타인에게 공유는 절대로 금합니다.');
      await expect(page.locator('.price-table thead th')).toHaveText(['대분류', '중분류', '소분류', '영업자단가']);

      // 검색으로 좁힐 수 있다
      await page.locator('#priceSearch').fill('최블');
      await expect(page.locator('#priceTableBody .paid-hint')).toContainText('4건 / 전체 165건');
      await page.locator('#priceSearch').fill('없는상품xyz');
      await expect(page.locator('.price-table tbody')).toContainText('찾는 상품이 없습니다.');
      await page.locator('[data-price-close]').click();

      if (!allowed) return;

      // 최종정산서에서는 회사원가까지 나온다
      await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
      await openNavView(page, 'final-settlement');
      await page.locator('[data-price-table]').click();
      await expect(page.locator('#readonlyModalTitle')).toHaveText('단가표 · 회사원가 / 영업자단가');
      await expect(page.locator('.price-table thead th')).toHaveText(['대분류', '중분류', '소분류', '회사원가', '영업자단가', '']);
    });
  }

  // 최종정산서에서 상품을 추가하면 영업자 단가표에도 영업자단가만 실린다.
  test('adds a product from the final settlement while account preview keeps financial data private', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();

    // 개인정산서 단가표에는 추가 버튼이 없다
    await openNavView(page, 'settlement');
    await page.locator('[data-price-table]').click();
    await expect(page.locator('[data-price-add]')).toHaveCount(0);
    await expect(page.locator('#priceTableBody .paid-hint')).toContainText('전체 165건');
    await page.locator('[data-price-close]').click();

    // 최종정산서에서 추가한다
    await openNavView(page, 'final-settlement');
    await page.locator('[data-price-table]').click();
    await page.locator('[data-price-add]').click();
    await page.locator('#newMajor').fill('블로그');
    await page.locator('#newMiddle').fill('신규상품');
    await page.locator('#newMinor').fill('AI 원고');
    await page.locator('#newCost').fill('8000');
    await page.locator('#newUnit').fill('9500');
    await page.locator('[data-price-add-save]').click();

    await page.locator('#priceSearch').fill('AI 원고');
    const added = page.locator('.price-table tbody tr').first();
    await expect(added).toContainText('추가');
    await expect(added).toContainText('8,000');
    await expect(added).toContainText('9,500');

    // 같은 상품을 또 넣을 수는 없다
    await page.locator('[data-price-add]').click();
    await page.locator('#newMajor').fill('블로그');
    await page.locator('#newMiddle').fill('신규상품');
    await page.locator('#newMinor').fill('AI 원고');
    await page.locator('[data-price-add-save]').click();
    await expect(page.locator('#priceForm')).toBeVisible();
    await page.locator('[data-price-add-cancel]').click();
    await page.locator('[data-price-close]').click();

    // 접수 화면에서도 바로 고를 수 있다
    await openIntake(page);
    await page.locator('[data-intake="a"]').selectOption('블로그');
    await expect(page.locator('[data-intake="b"] option')).toContainText(['신규상품']);

    // 계정 미리보기에서는 금융 API를 호출하지 않으므로 단가 자체를 비운다.
    // 회사 원가뿐 아니라 새 상품의 존재도 실제 타 계정 데이터처럼 노출하지 않는다.
    await page.locator('#personaSelect').selectOption('김용일');
    await openNavView(page, 'settlement');
    await page.locator('[data-price-table]').click();
    await expect(page.locator('.price-table thead th')).toHaveText(['대분류', '중분류', '소분류', '영업자단가']);
    await page.locator('#priceSearch').fill('AI 원고');
    const shared = page.locator('.price-table tbody tr').first();
    await expect(shared).toContainText('찾는 상품이 없습니다.');
    await expect(shared).not.toContainText('9,500');
    await expect(shared).not.toContainText('8,000');

    // 미리보기를 끝내면 서버에 저장한 실제 로그인 계정의 상품은 그대로다.
    await page.locator('[data-price-close]').click();
    await page.locator('#personaSelect').selectOption('');
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await openNavView(page, 'final-settlement');
    await page.locator('[data-price-table]').click();
    await page.locator('#priceSearch').fill('AI 원고');
    const restored = page.locator('.price-table tbody tr').first();
    await expect(restored).toContainText('8,000');
    await expect(restored).toContainText('9,500');
  });

  // 접수 폼은 접혀 있다가 버튼으로 펼치고, 상시변동 상품은 회사 원가를 직접 넣는다.
  test('collapses the intake form and prompts for missing company cost', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await openNavView(page, 'settlement');

    // 처음에는 접혀 있다
    const toggle = page.locator('[data-intake-toggle]');
    await expect(toggle).toHaveText('＋ 접수 등록');
    await expect(page.locator('[data-intake="client"]')).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveText('접기');
    await expect(page.locator('[data-intake="client"]')).toBeVisible();

    // 개인정산서 쪽 접수에는 회사 원가 칸이 없다 — 원가는 최종정산서에서만 다룬다
    await page.locator('[data-intake="a"]').selectOption('플레이스');
    await page.locator('[data-intake="b"]').selectOption('상위노출');
    await page.locator('[data-intake="c"]').selectOption('월보장');
    await expect(page.locator('[data-intake="cost"]')).toHaveCount(0);

    // 원가 없이 등록하면 최종정산서에서 알려 준다
    await page.locator('[data-intake="client"]').fill('군자한의원');
    await page.locator('[data-intake="unit"]').fill('400000');
    await page.locator('[data-intake="qty"]').fill('1');
    await page.locator('[data-intake="sell"]').fill('600000');
    await page.locator('[data-intake-add]').click();

    await openNavView(page, 'final-settlement');

    // 최종정산서 접수에서는 상시변동 상품에 회사 원가 칸이 뜬다
    await openIntake(page);
    await page.locator('[data-intake="a"]').selectOption('플레이스');
    await page.locator('[data-intake="b"]').selectOption('상위노출');
    await page.locator('[data-intake="c"]').selectOption('월보장');
    await expect(page.locator('[data-intake="cost"]')).toBeVisible();
    await expect(page.locator('.intake-field.need')).toContainText('상시변동 · 입력 필요');

    await expect(page.locator('.cost-alert-copy')).toContainText('회사 원가를 넣어야 할 접수 1건');
    await expect(page.locator('.final-total')).toContainText('회사이익 0');

    // 넣으면 알림이 사라지고 회사이익과 공급사 미정산이 잡힌다
    await page.locator('[data-cost-fill]').click();
    await page.locator('[data-cost-for]').first().fill('350000');
    await page.locator('[data-cost-save]').click();
    await expect(page.locator('.cost-alert')).toHaveCount(0);
    await expect(page.locator('.final-total')).toContainText('회사 공급가 350,000');
    await expect(page.locator('.final-total')).toContainText('회사이익 250,000');
    await expect(page.locator('.final-total')).toContainText('공급사 미정산 350,000');
  });

  // 이익을 영업자 기준과 회사 기준으로 나눠 보고, 공급사 미정산도 함께 본다.
  test('splits salesperson and company profit and shows unsettled supplier amounts', async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await openNavView(page, 'settlement');
    await openIntake(page);

    // 프리미엄원고대필 — 회사원가 10,000 / 영업자단가 11,000 / 판매 15,000
    for (const [date, client, qty] of [['2026-08-01', '한결에이전시', '10'], ['2026-08-02', '나스컴퍼니', '20']]) {
      await page.locator('[data-intake="date"]').fill(date);
      await page.locator('[data-intake="a"]').selectOption('블로그');
      await page.locator('[data-intake="b"]').selectOption('원고');
      await page.locator('[data-intake="c"]').selectOption('프리미엄원고대필');
      await page.locator('[data-intake="client"]').fill(client);
      await page.locator('[data-intake="qty"]').fill(qty);
      await page.locator('[data-intake="sell"]').fill('15000');
      await page.locator('[data-intake-add]').click();
    }

    await openNavView(page, 'final-settlement');
    await openIntake(page);

    const head = page.locator('.final-day-table thead').first();
    await expect(head).toContainText('영업이익(영업자)');
    await expect(head).toContainText('영업이익(회사)');

    // 8/02 20개: 판매 300,000 / 영업자공급 220,000 / 회사공급 200,000
    const day = page.locator('.ledger-day-head').first();
    await expect(day).toContainText('판매가액 300,000');
    await expect(day).toContainText('영업자이익 80,000');
    await expect(day).toContainText('회사이익 100,000');
    await expect(day).toContainText('공급사 미정산 200,000');

    const total = page.locator('.final-total');
    await expect(total).toContainText('전체 합계');
    await expect(total).toContainText('영업자이익 120,000');
    await expect(total).toContainText('회사이익 150,000');
    await expect(total).toContainText('공급사 미정산 300,000');

    // 공급사에 지불하면 미정산이 사라진다
    await page.locator('.vendor-table tbody tr').first().locator('[data-vendor-settle]').click();
    await page.locator('#vendorQty').fill('30');
    await page.locator('#vendorMemo').fill('국민은행에서 송금 완료');
    await page.locator('[data-vendor-save]').click();
    await expect(page.locator('#vendorQty')).toBeHidden();
    await expect(page.locator('.ledger-day-head').first()).toContainText('공급사 정산완료');
    await expect(total).toContainText('공급사 미정산 0');

    // 기간을 걸면 그 기간 취합값으로 바뀐다
    await page.locator('[data-final-filter="from"]').fill('2026-08-02');
    await page.locator('[data-final-filter="to"]').fill('2026-08-02');
    await expect(total).toContainText('조회 합계');
    await expect(total).toContainText('판매가액 300,000');
    await expect(total).toContainText('영업자이익 80,000');
    await expect(total).toContainText('회사이익 100,000');
  });

  // 예약건 작업은 예약최초건의 업체명·메모·상품·판매단가를 그대로 따른다.
  // 영업자 단가만 예외이며 부장 이상만 고칠 수 있다.
  for (const [name, canEditUnit] of [['김대호', true], ['김용일', false]] as [string, boolean][]) {
    test(`reservation drawdown inherits its terms for ${name}`, async ({ page }) => {
      await installFirebaseStub(page);
      const peakStore = createPeakosStore(name);

      await page.route('**/api/**', route => {
        if (handlePeakos(peakStore, route)) return;
        const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
        let payload: unknown = [];
        if (pathname === '/users/me') {
          payload = {
            uid: 'e2e-test-user', name, role: 'manager', approved: true, is_active: true,
            group_name: '본사 영업팀', peakos_can_review_finance: name === '김대호',
            peakos_can_view_finance_operations: name === '김대호',
          };
        } else if (pathname === '/chat-rooms/unread') {
          payload = {};
        } else if (pathname === '/projects') {
          payload = { canManageAll: false, projects: [] };
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
      });

      await page.goto('/business-os-preview.html');
      await expect(page.locator('#authGate')).toBeHidden();
      await openNavView(page, 'settlement');
    await openIntake(page);

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

      // 입금이 확인된 예약만 차감 목록에 오른다. 재무 담당자는 UI로
      // 확인하고, 일반 영업자는 버튼 없이 재무팀이 확인한 서버 결과만 받는다.
      if (name === '김대호') {
        for (const memo of ['국민은행 8월 선입금', '국민은행 9월 선입금']) {
          await page.locator('button[data-paid-open]', { hasText: '미입금' }).first().click();
          await page.locator('#paidMemo').fill(memo);
          await page.locator('[data-paid-save]').click();
        }
      } else {
        await expect(page.locator('[data-paid-open]')).toHaveCount(0);
        peakStore.intake.forEach(row => {
          row.paid = 'paid';
          row.paidAmount = Number(row.expectedDepositAmount ?? (Number(row.sell) * Number(row.qty)));
          row.payer = row.client;
          row.paidDate = '2026-08-09';
          row.paidMemo = '재무팀 통장 입금 확인';
          row.rowVersion = Number(row.rowVersion || 0) + 1;
        });
        await page.reload();
        await expect(page.locator('#authGate')).toBeHidden();
        await openNavView(page, 'settlement');
        await openIntake(page);
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
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await openNavView(page, 'settlement');
    await openIntake(page);

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
    await page.locator('[data-finance-period-mode="range"]').click();
    await page.locator('[data-finance-period-from]').fill('2026-08-02');
    await expect(rows).toHaveCount(1);
    await page.locator('[data-finance-period-mode="all"]').click();
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
    await installPeakosStub(page, { name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀' });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await page.locator('[data-nav-cluster="finance"] .nav-cluster-toggle').click();
    await openNavView(page, 'settlement');
    await openIntake(page);

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

    // 신규 입금은 0원으로 바꿔도 '확인' 의미를 유지하고 저장에서 거부한다.
    await expect(page.locator('[data-paid-save]')).toHaveText('입금확인');
    await page.locator('#paidAmount').fill('0');
    await expect(page.locator('[data-paid-save]')).toHaveText('입금확인');
    await page.locator('#paidMemo').fill('국민은행 통장 입금 확인');
    await page.locator('[data-paid-save]').click();
    await expect(page.locator('.toast')).toContainText('입금액은 0보다 큰 금액');
    await expect(page.locator('#paidAmount')).toBeVisible();
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
    // 입금액 0원은 기존 입금을 지우는 방법으로도 허용하지 않는다.
    await page.locator('#paidAmount').fill('0');
    await page.locator('[data-paid-save]').click();
    await expect(page.locator('.toast')).toContainText('입금액은 0보다 큰 금액');
    await expect(page.locator('#paidAmount')).toBeVisible();
    await page.locator('[data-paid-cancel]').click();
    await expect(page.locator('#moduleView .paid-chip span').first()).toHaveText('입금');
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
      const peakStore = createPeakosStore(name);

      await page.route('**/api/**', route => {
        if (handlePeakos(peakStore, route)) return;
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
      await openNavView(page, 'settlement');
      await openIntake(page);
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
      const peakStore = createPeakosStore(name);

      await page.route('**/api/**', route => {
        if (handlePeakos(peakStore, route)) return;
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
      await openNavView(page, 'settlement');
      // 지사는 접수 자체가 열리지 않아 펼칠 폼도 없다
      if (open) await openIntake(page);
      await expect(page.locator('#moduleView .intake-form')).toHaveCount(open ? 1 : 0);
      if (!open) {
        await expect(page.locator('#moduleView')).toContainText(`${branch} 정산서`);
        await expect(page.locator('#moduleView')).toContainText('지사는 따로 봅니다');
      }
    });
  }

  test('shows no invented amounts when the account has no sales rows', async ({ page }) => {
    await installFirebaseStub(page);
    // 보고서 탭 권한은 유지하되 매출 자료만 비어 있는 계정으로 검증한다.
    const peakStore = createPeakosStore('전현우');

    await page.route('**/api/**', route => {
      if (handlePeakos(peakStore, route)) return;
      const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
      let payload: unknown = [];
      if (pathname === '/users/me') {
        payload = {
          uid: 'e2e-test-user', name: '전현우', role: 'manager', approved: true, is_active: true,
          group_name: '본사 경영지원팀', peakos_can_view_finance_operations: true,
        };
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
