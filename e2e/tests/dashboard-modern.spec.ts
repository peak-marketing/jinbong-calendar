import { expect, test, type Page } from '@playwright/test';
import { createPeakosStore, handlePeakos, installFirebaseStub } from './helpers';

type DashboardUser = {
  name: string;
  role?: 'admin' | 'manager' | 'member';
  finance?: boolean;
  preview?: boolean;
  groupName?: string;
};

type ApiCall = { path: string; search: string };

const FIXED_NOW = new Date('2026-08-11T15:30:00.000Z'); // 2026-08-12 00:30 KST

function row(overrides: Record<string, unknown>) {
  return {
    id: `dashboard-${String(overrides.id || Math.random())}`,
    owner: 'e2e-test-user',
    ownerName: '김대호',
    date: '2026-08-10',
    kind: 'normal',
    qty: 1,
    sell: 0,
    cost: 0,
    ...overrides,
  };
}

async function setupDashboard(
  page: Page,
  user: DashboardUser,
  rows: Record<string, unknown>[],
  options: {
    delayedPreviewOwner?: string;
    previewRows?: Record<string, unknown>[];
    events?: Record<string, unknown>[];
    todos?: Record<string, unknown>[];
    projects?: Record<string, unknown>[];
    chatRooms?: Record<string, unknown>[];
    unreadCounts?: Record<string, number>;
  } = {},
) {
  await page.clock.install({ time: FIXED_NOW });
  await installFirebaseStub(page);
  const store = createPeakosStore(user.name, user.role || 'manager');
  store.intake = rows;
  const calls: ApiCall[] = [];
  let releasePreview: (() => void) | null = null;
  const previewGate = options.delayedPreviewOwner
    ? new Promise<void>(resolve => { releasePreview = resolve; })
    : null;

  await page.route('**/api/**', async route => {
    const requestUrl = new URL(route.request().url());
    const path = requestUrl.pathname.replace(/^\/api/, '');
    const collaborationPath = path.replace(/^\/peakos\/collaboration/, '') || '/';
    calls.push({ path, search: requestUrl.search });

    if (path === '/peakos/todos' && route.request().method() === 'GET') {
      const date = String(requestUrl.searchParams.get('date') || '');
      const source = options.todos || [];
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          date, timeZone: 'Asia/Seoul', readOnly: false,
          capabilities: { create: true, edit: true, reorder: true, archive: true },
          items: source.filter(todo => todo.date === date),
        }),
      });
    }

    if (path === '/peakos/intake'
      && requestUrl.searchParams.get('owner') === options.delayedPreviewOwner
      && previewGate) {
      await previewGate;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(options.previewRows || []),
      });
    }
    if (!path.startsWith('/peakos/collaboration') && handlePeakos(store, route)) return;

    let payload: unknown = [];
    if (collaborationPath === '/users/me') {
      payload = {
        uid: 'e2e-test-user', name: user.name, role: user.role || 'manager',
        approved: true, is_active: true, group_name: user.groupName || '본사 경영지원팀',
        group_type: 'support', peakos_can_read_bank: user.finance === true,
        peakos_can_view_bank_balances: user.finance === true,
        peakos_can_review_finance: user.finance === true,
        peakos_can_view_finance_operations: user.finance === true,
        peakos_can_view_tax_purchase: user.finance === true,
        peakos_can_preview_accounts: user.preview === true,
        peakos_can_view_final_execution: user.finance === true,
      };
    } else if (collaborationPath === '/events') {
      payload = options.events || [];
    } else if (collaborationPath === '/events/checklist-summary') {
      payload = {};
    } else if (collaborationPath === '/chat-rooms') {
      payload = options.chatRooms || [];
    } else if (collaborationPath === '/chat-rooms/unread') {
      payload = options.unreadCounts || {};
    } else if (collaborationPath === '/projects') {
      payload = { canManageAll: false, projects: options.projects || [] };
    } else if (collaborationPath === '/projects/my-tasks') {
      payload = { tasks: [] };
    } else if (collaborationPath === '/service-requests') {
      payload = { canManage: false, requests: [] };
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  // The signed-in shell deliberately lands on Calendar. Exercise the real
  // navigation handler while keeping the default-collapsed sidebar intact.
  await page.locator('.app-sidebar [data-view="dashboard"]')
    .evaluate(element => (element as HTMLElement).click());
  await expect(page.locator('[data-dashboard-finance-chart]')).toBeVisible();
  return {
    calls,
    releasePreview: () => releasePreview?.(),
  };
}

test.describe('modern finance dashboard', () => {
  test('shows exact blue revenue and red company profit with KST cutoff, freshness and negative refunds', async ({ page }) => {
    await setupDashboard(page, { name: '김대호', finance: true }, [
      row({ id: 'sale-a', date: '2026-08-10', qty: 2, sell: 100_000, cost: 60_000 }),
      row({ id: 'refund-a', date: '2026-08-10', kind: 'refund', qty: 1, sell: 30_000, cost: 10_000 }),
      // Imported adjustment rows may already carry a negative quantity. The
      // refund kind must not flip that established sign back to positive.
      row({ id: 'refund-negative-qty', date: '2026-08-11', kind: 'refund', qty: -1, sell: 10_000, cost: 4_000 }),
      row({ id: 'sale-b', date: '2026-08-11', sell: 50_000, cost: 20_000 }),
      row({ id: 'kst-today', date: '2026-08-12', sell: 90_000, cost: 40_000 }),
      row({ id: 'future', date: '2026-08-13', sell: 9_000_000, cost: 1 }),
      row({ id: 'reserve', date: '2026-08-12', kind: 'reserve', sell: 7_000_000, cost: 1 }),
    ]);

    const dashboard = page.locator('.executive-dashboard');
    await expect(dashboard).toHaveAttribute('data-dashboard-finance-state', 'complete');
    await expect(dashboard).toHaveAttribute('data-dashboard-finance-scope', 'company');
    await expect(dashboard).toHaveAttribute('data-dashboard-latest-date', '2026-08-12');
    await expect(page.locator('[data-dashboard-period="month"]')).toBeVisible();
    await expect(page.locator('[data-dashboard-profit-status="verified"]')).toContainText('회사 이익 산식 확인됨');
    await expect(page.locator('.executive-metric-card.revenue')).toContainText('30만원');
    await expect(page.locator('.executive-metric-card.profit')).toContainText('13만원');
    await expect(page.locator('.executive-metric-card.revenue')).toContainText('5건');
    await expect(page.locator('[data-dashboard-freshness]')).toHaveAttribute('data-latest-date', '2026-08-12');
    await expect(page.locator('[data-dashboard-freshness]')).toContainText('8/12까지 집계');

    expect(await page.locator('.executive-chart-point.revenue title').allTextContents()).toEqual([
      '2026-08-10 본사 전체 매출 170,000원',
      '2026-08-11 본사 전체 매출 40,000원',
      '2026-08-12 본사 전체 매출 90,000원',
    ]);
    expect(await page.locator('.executive-chart-point.profit title').allTextContents()).toEqual([
      '2026-08-10 회사 영업이익 60,000원',
      '2026-08-11 회사 영업이익 24,000원',
      '2026-08-12 회사 영업이익 50,000원',
    ]);
    await expect(page.locator('[data-dashboard-chart-svg]')).toHaveAttribute(
      'aria-label', '본사 전체 매출과 회사 영업이익의 일별 추이',
    );
    await expect(page.locator('[data-dashboard-chart-svg] desc')).toContainText(
      '2026-08-10: 본사 전체 매출 170,000원, 회사 영업이익 60,000원',
    );
    await expect(page.locator('[data-dashboard-series="revenue"]')).toContainText('일별 매출 추이');
    await expect(page.locator('[data-dashboard-series="company-profit"]')).toContainText('일별 영업이익 추이');
    const lineStyles = await page.locator('[data-dashboard-chart-svg]').evaluate(svg => {
      const style = (selector: string) => getComputedStyle(svg.querySelector(selector) as SVGPathElement);
      const revenue = style('.executive-chart-line.revenue');
      const profit = style('.executive-chart-line.profit');
      return {
        revenueStroke: revenue.stroke,
        revenueDash: revenue.strokeDasharray,
        profitStroke: profit.stroke,
        profitDash: profit.strokeDasharray,
      };
    });
    expect(lineStyles).toMatchObject({
      revenueStroke: 'rgb(80, 118, 147)',
      revenueDash: 'none',
      profitStroke: 'rgb(173, 98, 102)',
      profitDash: '8px, 5px',
    });
  });

  test('marks partial cost coverage without fabricating profit for the missing day', async ({ page }) => {
    await setupDashboard(page, { name: '김대호', finance: true }, [
      row({ id: 'known-a', date: '2026-08-10', sell: 100_000, cost: 60_000 }),
      row({ id: 'missing', date: '2026-08-11', sell: 80_000, cost: null }),
      row({ id: 'known-b', date: '2026-08-12', sell: 50_000, cost: 20_000 }),
    ]);

    await expect(page.locator('.executive-dashboard')).toHaveAttribute('data-dashboard-finance-state', 'partial');
    await expect(page.locator('[data-dashboard-profit-status="partial"]')).toContainText('회사 원가 미입력 1건');
    await expect(page.locator('.executive-metric-card.profit > strong')).toHaveText('확인 필요');
    expect(await page.locator('.executive-chart-point.profit title').allTextContents()).toEqual([
      '2026-08-10 회사 영업이익 40,000원',
      '2026-08-12 회사 영업이익 30,000원',
    ]);
    await expect(page.locator('.executive-chart-point.profit title', { hasText: '2026-08-11' })).toHaveCount(0);
  });

  test('shows no false red zero line when every company cost is missing', async ({ page }) => {
    await setupDashboard(page, { name: '김대호', finance: true }, [
      row({ id: 'missing-a', date: '2026-08-10', sell: 100_000, cost: null }),
      row({ id: 'missing-b', date: '2026-08-12', sell: 50_000, cost: undefined }),
    ]);

    await expect(page.locator('.executive-dashboard')).toHaveAttribute('data-dashboard-finance-state', 'partial');
    await expect(page.locator('.executive-chart-line.profit')).toHaveCount(0);
    await expect(page.locator('.executive-chart-point.profit')).toHaveCount(0);
    await expect(page.locator('.executive-metric-card.profit > strong')).toHaveText('확인 필요');
    await expect(page.locator('[data-dashboard-finance-chart]')).not.toContainText('영업이익 0원');
  });

  test('treats a ready company ledger with no rows as empty rather than verified zero profit', async ({ page }) => {
    await setupDashboard(page, { name: '김대호', finance: true }, []);

    await expect(page.locator('.executive-dashboard')).toHaveAttribute('data-dashboard-finance-state', 'empty');
    await expect(page.locator('.executive-metric-card.profit > strong')).toHaveText('자료 없음');
    await expect(page.locator('[data-dashboard-profit-status="empty"]')).toContainText('이번 달 정산 접수 없음');
    await expect(page.locator('.executive-chart-line.revenue')).toHaveCount(0);
    await expect(page.locator('.executive-chart-point.revenue')).toHaveCount(0);
    await expect(page.locator('.executive-chart-line.profit')).toHaveCount(0);
    await expect(page.locator('.executive-chart-point.profit')).toHaveCount(0);
    await expect(page.locator('[data-dashboard-finance-chart]')).not.toContainText('회사 영업이익 0원');
    await expect(page.locator('[data-dashboard-chart-svg] desc')).toContainText('이번 달 등록된 정산 접수가 없습니다');
  });

  test('keeps company profit locked for an ordinary account without leaking hidden values', async ({ page }) => {
    await setupDashboard(page, {
      name: '일반 영업자', role: 'member', finance: false, groupName: '본사 영업팀',
    }, [row({ id: 'private-cost', ownerName: '일반 영업자', sell: 100_000, cost: 60_000 })]);

    const dashboard = page.locator('.executive-dashboard');
    await expect(dashboard).toHaveAttribute('data-dashboard-finance-state', 'restricted');
    await expect(dashboard).toHaveAttribute('data-dashboard-finance-scope', 'self');
    await expect(page.locator('.executive-metric-card.revenue')).toContainText('10만원');
    await expect(page.locator('.executive-metric-card.profit > strong')).toHaveText('권한 제한');
    await expect(page.locator('[data-dashboard-profit-status="locked"]')).toContainText('회사 영업이익 비공개');
    await expect(page.locator('.executive-chart-line.profit')).toHaveCount(0);
    await expect(page.locator('.executive-chart-point.profit')).toHaveCount(0);
    await expect(page.locator('[data-dashboard-finance-chart]')).not.toContainText('40,000');
    await expect(page.locator('[data-dashboard-chart-svg]')).toHaveAttribute('aria-label', /회사 영업이익 권한 제한/);
  });

  test('purges authenticated finance synchronously on persona preview and only loads target-owned rows', async ({ page }) => {
    const setup = await setupDashboard(page, { name: '김대호', finance: true, preview: true }, [
      row({ id: 'actual-private', sell: 310_000, cost: 170_000 }),
    ], {
      delayedPreviewOwner: '박우진',
      previewRows: [row({ id: 'preview-own', ownerName: '박우진', date: '2026-08-11', sell: 70_000, cost: 1 })],
      todos: [{
        id: 'actual-private-todo', title: '실계정 비공개 할 일', date: '2026-08-12',
        startTime: '', endTime: '', category: '일반', memo: '', done: false,
        sortOrder: 10, version: 1, ownerUid: 'e2e-test-user', ownerName: '김대호',
        createdAt: '2026-08-11T15:30:00.000Z', updatedAt: '2026-08-11T15:30:00.000Z',
      }],
      projects: [{
        id: 'actual-private-project', name: '실계정 비공개 프로젝트', status: 'active',
        owner_name: '김대호', task_count: 2, done_task_count: 1,
      }],
      chatRooms: [{ id: 'actual-private-room', name: '실계정 비공개 채팅' }],
      unreadCounts: { 'actual-private-room': 7 },
    });
    await expect(page.locator('.executive-metric-card.profit')).toContainText('14만원');
    await expect(page.locator('.executive-metric-card.tasks > strong')).toHaveText('1건');
    await expect(page.locator('.executive-metric-card.projects > strong')).toHaveText('1개');
    // 카드는 이제 미완료·완료 건수를 나눠 보여준다 (채팅 미읽음 표기는 제거).
    await expect(page.locator('.executive-metric-card.projects .executive-metric-split')).toBeVisible();
    await expect(page.locator('.executive-list')).toContainText('실계정 비공개 할 일');
    await expect(page.locator('.executive-project-list')).toContainText('실계정 비공개 프로젝트');
    const callCutoff = setup.calls.length;

    try {
      const sameFrame = await page.evaluate(() => {
        const select = document.querySelector('#personaSelect') as HTMLSelectElement;
        select.value = '박우진';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() || '';
        return {
          scope: document.querySelector('.executive-dashboard')?.getAttribute('data-dashboard-finance-scope'),
          tasks: text('.executive-metric-card.tasks > strong'),
          projects: text('.executive-metric-card.projects > strong'),
          projectMeta: text('.executive-metric-card.projects > small'),
          todoList: text('.executive-list'),
          projectList: text('.executive-project-list'),
        };
      });
      expect(sameFrame).toMatchObject({
        scope: 'preview', tasks: '0건', projects: '0개',
      });
      // 미리보기 전환 프레임에서도 카드 수치가 즉시 0으로 비워져야 한다.
      expect(sameFrame.projectMeta).toContain('미완료 0개');
      expect(sameFrame.todoList).not.toContain('실계정 비공개 할 일');
      expect(sameFrame.projectList).not.toContain('실계정 비공개 프로젝트');
      await expect(page.locator('.executive-dashboard')).toHaveAttribute('data-dashboard-finance-scope', 'preview');
      await expect(page.locator('.executive-dashboard')).toHaveAttribute('data-dashboard-finance-state', 'restricted');
      await expect(page.locator('.executive-metric-card.revenue > strong')).toHaveText('자료 없음');
      await expect(page.locator('.executive-chart-line.profit')).toHaveCount(0);
      await expect(page.locator('#dashboardView')).not.toContainText('31만원');
      await expect(page.locator('#dashboardView')).not.toContainText('14만원');

      const previewCalls = setup.calls.slice(callCutoff);
      expect(previewCalls.some(call => call.path === '/peakos/intake' && call.search.includes('owner=%EB%B0%95%EC%9A%B0%EC%A7%84'))).toBe(true);
      expect(previewCalls.some(call => call.path === '/peakos/intake' && call.search.includes('scope=all'))).toBe(false);
      expect(previewCalls.some(call => ['/peakos/prices', '/peakos/bank/accounts', '/peakos/final-execution'].includes(call.path))).toBe(false);
    } finally {
      setup.releasePreview();
    }

    await expect(page.locator('.executive-metric-card.revenue')).toContainText('7만원');
    await expect(page.locator('.executive-metric-card.profit > strong')).toHaveText('권한 제한');
    await expect(page.locator('.executive-chart-point.profit')).toHaveCount(0);
  });

  test('uses the standalone todo response and ignores legacy Paragon events', async ({ page }) => {
    await setupDashboard(page, { name: '김대호', finance: true }, [], {
      events: [{
        id: 'legacy-mine', type: 'todo', title: '기존 개인 할 일', date: '2026-08-12',
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false,
      }, {
        id: 'other', type: 'todo', title: '다른 사람 개인 할 일', date: '2026-08-12',
        scope: 'personal', owner_id: 'other-user', owner_name: '동료', done: false,
      }, {
        id: 'team', type: 'todo', title: '팀 범위 할 일', date: '2026-08-12',
        scope: 'team', owner_id: 'other-user', owner_name: '동료', done: false,
      }, {
        id: 'meeting', type: 'meeting', title: '내 미팅', date: '2026-08-12',
        scope: 'personal', owner_id: 'e2e-test-user', owner_name: '김대호', done: false,
      }],
      todos: [{
        id: 'standalone-mine', title: 'PEAK OS 개인 할 일', date: '2026-08-12',
        startTime: '', endTime: '', category: '일반', memo: '', done: false,
        sortOrder: 10, version: 1, ownerUid: 'e2e-test-user', ownerName: '김대호',
        createdAt: '2026-08-11T15:30:00.000Z', updatedAt: '2026-08-11T15:30:00.000Z',
      }],
    });

    await expect(page.locator('.executive-metric-card.tasks > strong')).toHaveText('1건');
    await expect(page.locator('.executive-list-row')).toHaveCount(1);
    await expect(page.locator('.executive-list')).toContainText('PEAK OS 개인 할 일');
    await expect(page.locator('.executive-list')).not.toContainText('기존 개인 할 일');
    await expect(page.locator('.executive-list')).not.toContainText('다른 사람 개인 할 일');
    await expect(page.locator('.executive-list')).not.toContainText('팀 범위 할 일');
    await expect(page.locator('.executive-list')).not.toContainText('내 미팅');
  });

  test('discards a stale delayed persona response after returning to the real account', async ({ page }) => {
    const setup = await setupDashboard(page, { name: '김대호', finance: true, preview: true }, [
      row({ id: 'actual-current', sell: 310_000, cost: 170_000 }),
    ], {
      delayedPreviewOwner: '박우진',
      previewRows: [row({ id: 'stale-preview', ownerName: '박우진', sell: 70_000, cost: 1 })],
    });

    await page.locator('#personaSelect').selectOption('박우진');
    await expect(page.locator('.executive-dashboard')).toHaveAttribute('data-dashboard-finance-scope', 'preview');
    await expect(page.locator('.executive-metric-card.revenue > strong')).toHaveText('자료 없음');

    await page.locator('#personaSelect').selectOption('');
    await expect(page.locator('.executive-dashboard')).toHaveAttribute('data-dashboard-finance-scope', 'company');
    await expect(page.locator('.executive-metric-card.revenue')).toContainText('31만원');
    setup.releasePreview();

    await expect.poll(async () => page.locator('.executive-dashboard').getAttribute('data-dashboard-finance-scope'))
      .toBe('company');
    await expect(page.locator('.executive-metric-card.revenue')).toContainText('31만원');
    await expect(page.locator('.executive-metric-card.revenue > strong')).not.toHaveText('7만원');
    await expect(page.locator('.executive-chart-point.revenue title', { hasText: '70,000원' })).toHaveCount(0);
    await expect(page.locator('.executive-metric-card.profit')).toContainText('14만원');
  });

  test('fits 1440, 768 and 390 widths while preserving chart labels', async ({ page }) => {
    await setupDashboard(page, { name: '김대호', finance: true }, [
      row({ id: 'responsive', date: '2026-08-12', sell: 100_000, cost: 60_000 }),
    ]);

    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await expect(page.locator('[data-dashboard-finance-chart]')).toBeVisible();
      await expect(page.locator('[data-dashboard-series="revenue"]')).toBeVisible();
      await expect(page.locator('[data-dashboard-series="company-profit"]')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `document overflow at ${width}px`).toBeLessThanOrEqual(1);
      if (width === 390) {
        const chartScroll = await page.locator('.executive-chart-canvas').evaluate(element => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }));
        expect(chartScroll.scrollWidth).toBeGreaterThan(chartScroll.clientWidth);
        const dashboardButtons = await page.locator('.executive-card-head.compact > button').all();
        expect(dashboardButtons).toHaveLength(2);
        for (const button of dashboardButtons) {
          expect((await button.boundingBox())?.height || 0, '390px dashboard touch target').toBeGreaterThanOrEqual(44);
        }
      }
    }
  });
});
