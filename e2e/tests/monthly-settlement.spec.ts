import { expect, test, type Page, type Route } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createPeakosStore, handlePeakos } from './helpers';

const ROOT = path.resolve(__dirname, '../..');
const FIXED_NOW = new Date('2026-01-15T03:00:00.000Z');
const PROVIDERS = [
  ['rewardspace', '리워드스페이스'],
  ['reviewspace', '리뷰스페이스'],
  ['keywordmaster', '키워드마스터'],
  ['brandautospace', '브랜드오토스페이스'],
  ['reviewflow', '리뷰플로우'],
] as const;

type Role = 'admin' | 'manager' | 'member';
type MonthlyCall = { uid: string; workspace: string; month: string; search: string; preview: string };
type TestUser = {
  uid: string;
  name: string;
  role: Role;
  preview?: boolean;
  groupType?: string;
  financeOperations?: boolean;
};
type TestWorkspace = { id: string; slug: string; name: string; role: Role; settlements?: 'none' | 'read' | 'write' };
type DelayControl = {
  uid: string;
  workspace: string;
  month: string;
  gate: Promise<void>;
};
type MonthlyFixture = {
  initialUid: string;
  users: Record<string, TestUser>;
  workspaces: TestWorkspace[];
  calls: MonthlyCall[];
  payload: (uid: string, workspace: string, month: string) => any;
  delay?: DelayControl;
};

function platformRow(
  key: typeof PROVIDERS[number][0],
  label: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    key,
    label,
    status: 'available',
    dataState: 'available',
    sales: 10_000,
    profit: 3_000,
    transactionCount: 1,
    lastImportedAt: '2026-01-15T01:00:00.000Z',
    coverage: { state: 'complete', from: '2026-01-01', to: '2026-01-15' },
    ...overrides,
  };
}

function completePayload(user: TestUser, month: string, marker = 1) {
  const platforms = PROVIDERS.map(([key, label], index) => platformRow(key, label, {
    sales: marker * 10_000 + index * 1_000,
    profit: marker * 3_000 + index * 500,
  }));
  return {
    scope: 'self',
    month,
    timezone: 'Asia/Seoul',
    owner: { uid: user.uid, name: user.name },
    personal: { sales: marker * 170_000, profit: marker * 65_000, transactionCount: 4 },
    platformTotal: {
      sales: platforms.reduce((sum, row) => sum + Number(row.sales), 0),
      profit: platforms.reduce((sum, row) => sum + Number(row.profit), 0),
      transactionCount: 5,
      salesProviderCount: 5,
      profitProviderCount: 5,
      transactionProviderCount: 5,
      providerCount: 5,
      complete: true,
      note: '개인 정산과 더하지 않습니다.',
    },
    platforms,
    generatedAt: '2026-01-15T03:00:00.000Z',
  };
}

function mixedCoveragePayload(user: TestUser, month: string) {
  return {
    scope: 'self',
    month,
    timezone: 'Asia/Seoul',
    owner: { uid: user.uid, name: user.name },
    personal: { sales: 170_000, profit: 65_000, transactionCount: 4 },
    platformTotal: {
      sales: 123_000,
      profit: 45_000,
      transactionCount: 2,
      salesProviderCount: 2,
      profitProviderCount: 2,
      transactionProviderCount: 2,
      providerCount: 5,
      complete: false,
      note: '개인 정산과 더하지 않습니다.',
    },
    platforms: [
      platformRow('rewardspace', '리워드스페이스', {
        sales: 123_000, profit: 45_000, transactionCount: 2,
        sourceState: 'paid', sourceChangedAfterSettlement: true,
        profitBasis: 'reward_distributor_margin',
      }),
      platformRow('reviewspace', '리뷰스페이스', {
        status: 'no_data', dataState: 'no_data', sales: 0, profit: 0, transactionCount: 0,
        sourceState: 'live', sourceChangedAfterSettlement: false,
        profitBasis: 'review_spread_profit',
      }),
      platformRow('keywordmaster', '키워드마스터', {
        status: 'not_covered', dataState: 'not_covered', sales: null, profit: null,
        transactionCount: null, coverage: { state: 'none', from: null, to: null },
        sourceState: 'unknown', sourceChangedAfterSettlement: false, profitBasis: 'unavailable',
      }),
      platformRow('brandautospace', '브랜드오토스페이스', {
        status: 'never_imported', dataState: 'never_imported', sales: null, profit: null,
        transactionCount: null, lastImportedAt: null,
        coverage: { state: 'none', from: null, to: null },
      }),
      platformRow('reviewflow', '리뷰플로우', {
        status: 'not_connected', dataState: 'not_connected', sales: null, profit: null,
        transactionCount: null, lastImportedAt: null,
        coverage: { state: 'none', from: null, to: null },
      }),
      // The client contract must ignore unknown providers instead of widening the fixed allowlist.
      { key: 'unexpected-provider', label: '다른 사람 원장', sales: 9_999_999, profit: 9_999_999 },
    ],
    generatedAt: '2026-01-15T03:00:00.000Z',
  };
}

function defaultFixture(overrides: Partial<MonthlyFixture> = {}): MonthlyFixture {
  const user: TestUser = {
    uid: 'uid-self', name: '김대호', role: 'member', groupType: 'support',
  };
  const fixture: MonthlyFixture = {
    initialUid: user.uid,
    users: { [user.uid]: user },
    workspaces: [{
      id: 'ws_peak', slug: 'peak', name: '피크마케팅 본사', role: 'member', settlements: 'none',
    }],
    calls: [],
    payload: (uid, _workspace, month) => completePayload(user, month, uid === user.uid ? 1 : 2),
    ...overrides,
  };
  return fixture;
}

async function serveOsShell(page: Page) {
  const html = fs.readFileSync(path.join(ROOT, 'business-os-preview.html'));
  const js = fs.readFileSync(path.join(ROOT, 'business-os-preview.js'));
  const css = fs.readFileSync(path.join(ROOT, 'business-os-live.css'));
  await page.route('**/os/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/os/' || pathname === '/os/login' || /^\/os\/w\/[a-z0-9-]+\/?$/.test(pathname)) {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    if (pathname === '/os/business-os-preview.js') {
      return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: js });
    }
    if (pathname === '/os/business-os-live.css') {
      return route.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body: css });
    }
    return route.continue();
  });
}

async function installSwitchableFirebase(page: Page, initialUid: string) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: '/* stubbed by monthly settlement E2E */',
  }));
  await page.addInitScript((uid) => {
    const listeners: Array<(user: any) => void> = [];
    const makeUser = (id: string) => ({
      uid: id,
      email: `${id}@test.local`,
      displayName: id,
      getIdToken: async () => `token:${id}`,
    });
    const authStub: any = {
      currentUser: makeUser(uid),
      setPersistence: async () => {},
      getRedirectResult: async () => ({ user: null }),
      onAuthStateChanged(callback: (user: any) => void) {
        listeners.push(callback);
        Promise.resolve().then(() => callback(authStub.currentUser));
        return () => {};
      },
      signInWithPopup: async () => ({ user: authStub.currentUser }),
      signInWithRedirect: async () => {},
      signOut: async () => {
        authStub.currentUser = null;
        listeners.forEach(callback => callback(null));
      },
    };
    function GoogleAuthProvider(this: any) {
      this.setCustomParameters = () => this;
    }
    (window as any).__monthlySwitchAccount = (nextUid: string) => {
      authStub.currentUser = makeUser(nextUid);
      listeners.forEach(callback => callback(authStub.currentUser));
    };
    (window as any).firebase = {
      apps: [],
      initializeApp: () => ({}),
      auth: Object.assign(() => authStub, {
        GoogleAuthProvider,
        Auth: { Persistence: { LOCAL: 'LOCAL' } },
      }),
      messaging: Object.assign(() => ({ onMessage: () => () => {} }), { isSupported: async () => false }),
    };
  }, initialUid);
}

function authenticatedUid(route: Route, fallback: string) {
  const header = route.request().headers().authorization || '';
  const match = header.match(/^Bearer token:(.+)$/);
  return match?.[1] || fallback;
}

async function installApi(page: Page, fixture: MonthlyFixture) {
  const stores = new Map(Object.values(fixture.users).map(user => [
    user.uid,
    createPeakosStore(user.name, user.role),
  ]));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname.replace(/^\/api/, '');
    const uid = authenticatedUid(route, fixture.initialUid);
    const user = fixture.users[uid] || fixture.users[fixture.initialUid];
    const send = (payload: unknown, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(payload),
    });

    if (pathname === '/users/me') {
      return send({
        uid: user.uid,
        name: user.name,
        email: `${user.uid}@test.local`,
        role: user.role,
        approved: true,
        is_active: true,
        group_id: 'support-team',
        group_name: '본사 경영지원팀',
        group_type: user.groupType || 'support',
        peakos_can_preview_accounts: user.preview === true,
        peakos_can_view_finance_operations: user.financeOperations === true,
      });
    }
    if (pathname === '/os-auth/session') {
      return send({ required: true, verified: true, expiresInSeconds: 3600 });
    }
    if (pathname === '/os/workspaces') {
      return send({
        default_slug: fixture.workspaces[0].slug,
        workspaces: fixture.workspaces.map(workspace => ({
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          kind: workspace.slug === 'peak' ? 'headquarters' : 'branch',
          role: workspace.role,
        })),
      });
    }
    const contextMatch = pathname.match(/^\/os\/workspaces\/([^/]+)\/context$/);
    if (contextMatch) {
      const slug = decodeURIComponent(contextMatch[1]);
      const workspace = fixture.workspaces.find(row => row.slug === slug);
      if (!workspace) return send({ code: 'WORKSPACE_NOT_FOUND', error: '워크스페이스 없음' }, 404);
      return send({
        workspace: {
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          kind: workspace.slug === 'peak' ? 'headquarters' : 'branch',
        },
        membership: { role: workspace.role },
        permissions: {
          calendar: 'write',
          chat: 'write',
          projects: 'write',
          settlements: workspace.settlements || 'none',
          documents: 'read',
          sales: 'none',
          headquartersOversight: false,
        },
      });
    }
    if (pathname === '/peakos/monthly-settlement/self') {
      const workspace = request.headers()['x-peakos-workspace'] || '';
      const month = url.searchParams.get('month') || '';
      fixture.calls.push({
        uid,
        workspace,
        month,
        search: url.search,
        preview: request.headers()['x-peakos-preview'] || '',
      });
      if (fixture.delay
        && fixture.delay.uid === uid
        && fixture.delay.workspace === workspace
        && fixture.delay.month === month) {
        await fixture.delay.gate;
      }
      return send(fixture.payload(uid, workspace, month));
    }

    if (pathname === '/peakos/collaboration/events') return send([]);
    if (pathname === '/peakos/collaboration/events/checklist-summary') return send({});
    if (pathname === '/peakos/collaboration/chat-rooms') return send([]);
    if (pathname === '/peakos/collaboration/chat-rooms/unread') return send({});
    if (pathname === '/peakos/collaboration/projects') return send({ projects: [] });
    if (pathname === '/peakos/collaboration/projects/my-tasks') return send({ readOnly: false, tasks: [] });
    if (pathname === '/service-requests') return send({ canManage: false, requests: [] });
    if (pathname === '/ideas') return send([]);
    const store = stores.get(uid) || stores.get(fixture.initialUid)!;
    if (handlePeakos(store, route)) return;
    return send([]);
  });
}

async function setup(
  page: Page,
  fixture: MonthlyFixture,
  options: { width?: number; height?: number; theme?: 'light' | 'dark'; slug?: string } = {},
) {
  await page.clock.install({ time: FIXED_NOW });
  await page.setViewportSize({ width: options.width || 1440, height: options.height || 900 });
  if (options.theme) {
    await page.addInitScript(theme => localStorage.setItem('peakos-color-theme-v1', theme), options.theme);
  }
  await installSwitchableFirebase(page, fixture.initialUid);
  await serveOsShell(page);
  await installApi(page, fixture);
  await page.goto(`/os/w/${options.slug || fixture.workspaces[0].slug}`);
  await expect(page.locator('#authGate')).toBeHidden();
}

async function openMonthlySettlement(page: Page, { waitForReady = true } = {}) {
  if (await page.locator('.mobile-menu').isVisible()) {
    await page.locator('.mobile-menu').click();
  }
  const cluster = page.locator('[data-nav-cluster="sales-operations"]');
  await expect(cluster).toBeVisible();
  if ((await cluster.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await cluster.locator(':scope > .nav-cluster-toggle').click();
  }
  const nav = page.locator('.nav-item[data-view="monthly-settlement"]');
  await expect(nav).toBeVisible();
  await nav.click();
  const root = page.locator('[data-monthly-settlement]');
  await expect(root).toBeVisible();
  if (waitForReady) await expect(root).toHaveAttribute('data-monthly-settlement-state', /^(ready|partial)$/);
  return root;
}

async function openPersonalSettlement(page: Page) {
  if (await page.locator('.mobile-menu').isVisible()) {
    await page.locator('.mobile-menu').click();
  }
  const cluster = page.locator('[data-nav-cluster="sales-operations"]');
  await expect(cluster).toBeVisible();
  if ((await cluster.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await cluster.locator(':scope > .nav-cluster-toggle').click();
  }
  const nav = page.locator('.nav-item[data-view="settlement"]');
  await expect(nav).toBeVisible();
  await nav.click();
  const root = page.locator('#moduleView .personal-settlement-experience');
  await expect(root).toBeVisible();
  return root;
}

for (const role of ['admin', 'manager', 'member'] as const) {
  test(`${role} direct 계정은 settlements:none이어도 실제 OS 월 정산 nav와 self API를 사용한다`, async ({ page }) => {
    const user: TestUser = { uid: `uid-${role}`, name: `${role} 본인`, role, groupType: 'support' };
    const fixture = defaultFixture({
      initialUid: user.uid,
      users: { [user.uid]: user },
      workspaces: [{ id: 'ws_peak', slug: 'peak', name: '피크마케팅 본사', role, settlements: 'none' }],
      calls: [],
      payload: (_uid, _workspace, month) => completePayload(user, month),
    });
    await setup(page, fixture);
    const root = await openMonthlySettlement(page);

    await expect(root).toHaveAttribute('data-monthly-settlement-scope', 'self');
    await expect(root.locator('.monthly-settlement-boundary')).toContainText('실시간 잠정 조회');
    await expect(root.locator('.monthly-settlement-boundary')).toContainText('월 마감·승인 전에는');
    await expect(root.locator('.monthly-settlement-boundary')).toContainText('금액이 바뀔 수 있습니다');
    await expect(root.locator('.monthly-settlement-footer')).toContainText(`${user.name} 본인 전용`);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({
      uid: user.uid, workspace: 'peak', month: '2026-01', search: '?month=2026-01', preview: '',
    });
  });
}

test('기존 개인 정산 합계와 고정 5개 플랫폼의 no-data/missing 상태를 서로 섞거나 0으로 위장하지 않는다', async ({ page }) => {
  const fixture = defaultFixture();
  const user = fixture.users[fixture.initialUid];
  fixture.payload = (_uid, _workspace, month) => mixedCoveragePayload(user, month);
  await setup(page, fixture);
  const root = await openMonthlySettlement(page);

  await expect(root.locator('[data-monthly-settlement-kpi="personal-sales"]')).toContainText('170,000원');
  await expect(root.locator('[data-monthly-settlement-kpi="personal-profit"]')).toContainText('65,000원');
  await expect(root.locator('[data-monthly-settlement-platform-total]')).toContainText('123,000원');
  await expect(root).not.toContainText('293,000원');
  await expect(root.locator('[data-monthly-settlement-platforms] tbody tr')).toHaveCount(5);
  await expect(root).not.toContainText('다른 사람 원장');

  const reward = root.locator('[data-monthly-settlement-platform="rewardspace"]');
  await expect(reward).toContainText('123,000원');
  await expect(reward).toContainText('영업자 마진');
  await expect(reward).toContainText('지급 확정 후 변동 확인');
  await expect(reward).toHaveAttribute('data-monthly-settlement-source-state', 'paid');
  const noData = root.locator('[data-monthly-settlement-platform="reviewspace"]');
  await expect(noData).toHaveAttribute('data-monthly-settlement-platform-data-state', 'no_data');
  await expect(noData).toContainText('거래 없음');
  await expect(noData).toContainText('0원');
  await expect(noData).toContainText('매출 - 영업자단가');
  await expect(noData).toContainText('실시간 잠정');
  const notCovered = root.locator('[data-monthly-settlement-platform="keywordmaster"]');
  await expect(notCovered).toHaveAttribute('data-monthly-settlement-platform-state', 'not_covered');
  await expect(notCovered).toContainText('선택 월 미수집');
  await expect(notCovered).toContainText('영업이익 API 미제공');
  await expect(notCovered).not.toContainText('0원');
  for (const key of ['brandautospace', 'reviewflow']) {
    await expect(root.locator(`[data-monthly-settlement-platform="${key}"]`)).not.toContainText('0원');
  }
});

test('개인정산서와 플랫폼 안내의 API 현황 버튼은 실제 월 정산 플랫폼 상태 표로 이동한다', async ({ page }) => {
  const user: TestUser = {
    uid: 'uid-api-guide', name: '김대호', role: 'manager', groupType: 'support', financeOperations: true,
  };
  const fixture = defaultFixture({
    initialUid: user.uid,
    users: { [user.uid]: user },
    workspaces: [{ id: 'ws_peak', slug: 'peak', name: '피크마케팅 본사', role: 'manager', settlements: 'write' }],
    calls: [],
    payload: (_uid, _workspace, month) => completePayload(user, month),
  });
  await setup(page, fixture);

  const personal = await openPersonalSettlement(page);
  await expect(personal.locator('.personal-settlement-hero')).toHaveCount(0);
  await personal.locator('[data-open-monthly-platform-status]').click();
  const monthly = page.locator('[data-monthly-settlement]');
  await expect(monthly).toHaveAttribute('data-monthly-settlement-state', /^(ready|partial)$/);
  await expect(monthly.locator('[data-monthly-settlement-toggle="platforms"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(monthly.locator('[data-monthly-settlement-platforms] tbody tr')).toHaveCount(5);
  await expect(monthly.locator('[data-monthly-settlement-toggle="platforms"]')).toBeFocused();

  const platformToggle = monthly.locator('[data-monthly-settlement-toggle="platforms"]');
  await platformToggle.click();
  await expect(platformToggle).toHaveAttribute('aria-expanded', 'false');
  await monthly.locator('[data-monthly-settlement-platform-jump]').click();
  await expect(platformToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(platformToggle).toBeFocused();

  const financeCluster = page.locator('[data-nav-cluster="finance"]');
  if ((await financeCluster.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await financeCluster.locator(':scope > .nav-cluster-toggle').click();
  }
  await page.locator('.nav-item[data-view="platform"]').click();
  await expect(page.locator('#moduleView')).toContainText('영업 운영 → 월 정산 → 플랫폼별 정산');
  await expect(page.locator('#moduleView')).toContainText('실제 서버 응답 기준');
  await page.locator('#moduleView [data-open-monthly-platform-status]').click();
  await expect(page.locator('[data-monthly-settlement-platforms] tbody tr')).toHaveCount(5);
  expect(fixture.calls.length).toBeGreaterThanOrEqual(1);
});

test('내 exact name의 미해결 attribution은 partial/null로 표시하고 0원 실적으로 확정하지 않는다', async ({ page }) => {
  const fixture = defaultFixture();
  const user = fixture.users[fixture.initialUid];
  fixture.payload = (_uid, _workspace, month) => {
    const payload: any = completePayload(user, month);
    payload.platforms[0] = platformRow('rewardspace', '리워드스페이스', {
      status: 'partial',
      dataState: 'partial',
      sales: null,
      profit: null,
      transactionCount: null,
      attributionIssueCount: 1,
    });
    payload.platformTotal = {
      ...payload.platformTotal,
      sales: payload.platforms.slice(1).reduce((sum, row) => sum + Number(row.sales), 0),
      profit: payload.platforms.slice(1).reduce((sum, row) => sum + Number(row.profit), 0),
      transactionCount: 4,
      salesProviderCount: 4,
      profitProviderCount: 4,
      transactionProviderCount: 4,
      complete: false,
    };
    return payload;
  };
  await setup(page, fixture);
  const root = await openMonthlySettlement(page);

  const row = root.locator('[data-monthly-settlement-platform="rewardspace"]');
  await expect(row).toHaveAttribute('data-monthly-settlement-platform-state', 'partial');
  await expect(row).toContainText('확인 필요');
  await expect(row).toContainText('영업자 이름 연결 확인');
  await expect(row).not.toContainText('0원');
});

test('KST 선택 월은 2026년 1월에서 2025년 12월로 넘어갔다가 되돌아온다', async ({ page }) => {
  const fixture = defaultFixture();
  await setup(page, fixture);
  const root = await openMonthlySettlement(page);
  await expect(root).toHaveAttribute('data-monthly-settlement-month', '2026-01');

  await root.locator('[data-monthly-settlement-prev]').click();
  await expect(root).toHaveAttribute('data-monthly-settlement-month', '2025-12');
  await expect.poll(() => fixture.calls.at(-1)?.month).toBe('2025-12');
  await root.locator('[data-monthly-settlement-next]').click();
  await expect(root).toHaveAttribute('data-monthly-settlement-month', '2026-01');
  await expect.poll(() => fixture.calls.at(-1)?.month).toBe('2026-01');
  expect(fixture.calls.map(call => call.month)).toEqual(['2026-01', '2025-12', '2026-01']);
});

test('계정 미리보기에서 탭을 열면 self 요청이 0건이고 private placeholder만 남는다', async ({ page }) => {
  const user: TestUser = { uid: 'uid-master', name: '패션TV봉이', role: 'admin', preview: true };
  const fixture = defaultFixture({
    initialUid: user.uid,
    users: { [user.uid]: user },
    workspaces: [{ id: 'ws_peak', slug: 'peak', name: '피크마케팅 본사', role: 'admin', settlements: 'write' }],
    calls: [],
    payload: (_uid, _workspace, month) => completePayload(user, month, 9),
  });
  await setup(page, fixture);
  await page.locator('#personaSelect').selectOption('김대호');
  const personal = await openPersonalSettlement(page);
  await personal.locator('[data-open-monthly-platform-status]').click();
  await expect(page.locator('.toast')).toContainText('승인된 실제 계정의 월 정산');
  expect(fixture.calls).toHaveLength(0);
  const root = await openMonthlySettlement(page, { waitForReady: false });

  await expect(root).toHaveAttribute('data-monthly-settlement-state', 'private');
  await expect(root).toHaveAttribute('data-monthly-settlement-scope', 'preview');
  await expect(root).toContainText('계정 미리보기에서는 월 정산을 불러오지 않습니다');
  await page.waitForTimeout(100);
  expect(fixture.calls).toHaveLength(0);
  await expect(root).not.toContainText('1,530,000원');
});

test('진행 중 self 응답은 미리보기 전환 직후 폐기되고 이전 금액 DOM이 복구되지 않는다', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const user: TestUser = { uid: 'uid-master', name: '패션TV봉이', role: 'admin', preview: true };
  const fixture = defaultFixture({
    initialUid: user.uid,
    users: { [user.uid]: user },
    workspaces: [{ id: 'ws_peak', slug: 'peak', name: '피크마케팅 본사', role: 'admin', settlements: 'none' }],
    calls: [],
    payload: (_uid, _workspace, month) => completePayload(user, month, 9),
    delay: { uid: user.uid, workspace: 'peak', month: '2026-01', gate },
  });
  await setup(page, fixture);
  const root = await openMonthlySettlement(page, { waitForReady: false });
  await expect.poll(() => fixture.calls.length).toBe(1);
  await page.locator('#personaSelect').selectOption('김대호');
  await expect(root).toHaveAttribute('data-monthly-settlement-state', 'private');
  release();

  await page.waitForTimeout(100);
  await expect(root).toHaveAttribute('data-monthly-settlement-state', 'private');
  await expect(root).not.toContainText('1,530,000원');
  expect(fixture.calls).toHaveLength(1);
});

test('늦은 이전 workspace 응답은 지사 전환 뒤 새 workspace self 화면을 덮지 않는다', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = defaultFixture({
    workspaces: [
      { id: 'ws_peak', slug: 'peak', name: '피크마케팅 본사', role: 'member', settlements: 'none' },
      { id: 'ws_daegu', slug: 'daegu', name: '피크마케팅 대구지사', role: 'member', settlements: 'none' },
    ],
    calls: [],
    delay: { uid: 'uid-self', workspace: 'peak', month: '2026-01', gate },
  });
  const user = fixture.users[fixture.initialUid];
  fixture.payload = (_uid, workspace, month) => completePayload(user, month, workspace === 'peak' ? 91 : 22);
  await setup(page, fixture);
  await openMonthlySettlement(page, { waitForReady: false });
  await expect.poll(() => fixture.calls.filter(call => call.workspace === 'peak').length).toBe(1);

  const switching = page.locator('[data-workspace-selector]').selectOption('daegu');
  await page.waitForURL(/\/os\/w\/daegu$/);
  release();
  await switching;
  await expect(page.locator('#authGate')).toBeHidden();
  const daeguRoot = await openMonthlySettlement(page);
  await expect(daeguRoot.locator('[data-monthly-settlement-kpi="personal-sales"]')).toContainText('3,740,000원');
  await expect(daeguRoot).not.toContainText('15,470,000원');
  expect(fixture.calls.some(call => call.workspace === 'daegu')).toBeTruthy();
});

test('로그인 UID가 바뀌면 늦은 이전 계정 응답을 버리고 새 UID self 응답만 표시한다', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first: TestUser = { uid: 'uid-first', name: '첫 계정', role: 'member' };
  const second: TestUser = { uid: 'uid-second', name: '두번째 계정', role: 'member' };
  const fixture = defaultFixture({
    initialUid: first.uid,
    users: { [first.uid]: first, [second.uid]: second },
    workspaces: [{ id: 'ws_peak', slug: 'peak', name: '피크마케팅 본사', role: 'member', settlements: 'none' }],
    calls: [],
    payload: (uid, _workspace, month) => completePayload(uid === first.uid ? first : second, month, uid === first.uid ? 81 : 12),
    delay: { uid: first.uid, workspace: 'peak', month: '2026-01', gate },
  });
  await setup(page, fixture);
  await openMonthlySettlement(page, { waitForReady: false });
  await expect.poll(() => fixture.calls.filter(call => call.uid === first.uid).length).toBe(1);

  await page.evaluate((uid) => (window as any).__monthlySwitchAccount(uid), second.uid);
  await expect.poll(() => page.locator('.member-copy strong').textContent()).toContain(second.name);
  const secondRoot = await openMonthlySettlement(page);
  await expect(secondRoot.locator('[data-monthly-settlement-kpi="personal-sales"]')).toContainText('2,040,000원');
  release();

  await page.waitForTimeout(100);
  await expect(secondRoot).toContainText(`${second.name} 본인 전용`);
  await expect(secondRoot).not.toContainText('13,770,000원');
  expect(fixture.calls.some(call => call.uid === second.uid)).toBeTruthy();
});

function parseRgb(value: string) {
  const parts = value.match(/[\d.]+/g)?.map(Number) || [];
  return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0, a: parts[3] ?? 1 };
}

function luminance({ r, g, b }: { r: number; g: number; b: number }) {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground: string, background: string) {
  const light = Math.max(luminance(parseRgb(foreground)), luminance(parseRgb(background)));
  const dark = Math.min(luminance(parseRgb(foreground)), luminance(parseRgb(background)));
  return (light + 0.05) / (dark + 0.05);
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 768, 390]) {
    test(`${width}px ${theme} 월 정산은 overflow·대비·모바일 44px 계약을 지킨다`, async ({ page }) => {
      const fixture = defaultFixture();
      const user = fixture.users[fixture.initialUid];
      fixture.payload = (_uid, _workspace, month) => mixedCoveragePayload(user, month);
      await setup(page, fixture, { width, height: width === 390 ? 844 : 900, theme });
      const root = await openMonthlySettlement(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

      const samples = [
        '.monthly-settlement-header-meta > span:last-child',
        '[data-monthly-settlement-platform="rewardspace"] .monthly-settlement-status',
        '[data-monthly-settlement-platform="rewardspace"] td small',
        '.monthly-settlement-footer small',
      ];
      for (const selector of samples) {
        const style = await root.locator(selector).first().evaluate(element => {
          let current: Element | null = element;
          let background = 'rgba(0, 0, 0, 0)';
          while (current) {
            const candidate = getComputedStyle(current).backgroundColor;
            if (!candidate.endsWith(', 0)') && candidate !== 'transparent') {
              background = candidate;
              break;
            }
            current = current.parentElement;
          }
          const computed = getComputedStyle(element);
          return { color: computed.color, background, fontSize: parseFloat(computed.fontSize) };
        });
        expect(style.fontSize, `${selector} minimum text size`).toBeGreaterThanOrEqual(10);
        expect(contrastRatio(style.color, style.background), `${theme} ${selector} contrast`).toBeGreaterThanOrEqual(4.5);
      }

      const personalToggle = root.locator('[data-monthly-settlement-toggle="personal"]');
      await personalToggle.click();
      await expect(personalToggle).toHaveAttribute('aria-expanded', 'false');
      await personalToggle.click();
      await expect(personalToggle).toHaveAttribute('aria-expanded', 'true');

      if (width === 390) {
        const heights = await root.locator([
          '[data-monthly-settlement-prev]',
          '[data-monthly-settlement-next]',
          '[data-monthly-settlement-today]',
          '[data-monthly-settlement-platform-jump]',
          '[data-monthly-settlement-toggle]',
          '[data-monthly-settlement-refresh]',
        ].join(',')).evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height)));
        expect(heights.length).toBeGreaterThan(0);
        expect(Math.min(...heights), `${theme} mobile touch target`).toBeGreaterThanOrEqual(44);
      }
    });
  }
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 768, 390]) {
    test(`${width}px ${theme} 개인정산서는 hero 없이 흰 헤더 안 조회범위와 44px 조작부를 유지한다`, async ({ page }) => {
      const user: TestUser = { uid: `uid-layout-${theme}-${width}`, name: '김대호', role: 'manager' };
      const fixture = defaultFixture({
        initialUid: user.uid,
        users: { [user.uid]: user },
        workspaces: [{ id: 'ws_peak', slug: 'peak', name: '피크마케팅 본사', role: 'manager', settlements: 'write' }],
      });
      await setup(page, fixture, { width, height: width === 390 ? 844 : 900, theme });
      const root = await openPersonalSettlement(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(root.locator('.personal-settlement-hero')).toHaveCount(0);

      const deck = root.locator('.settlement-control-deck');
      await expect(deck).toContainText('조회 범위');
      expect(await deck.evaluate(element => element.parentElement?.classList.contains('settlement-command-bar'))).toBe(true);
      const surfaces = await root.locator('.settlement-command-bar').evaluate(element => ({
        header: getComputedStyle(element).backgroundColor,
        filters: getComputedStyle(element.querySelector('.settlement-control-deck')!).backgroundColor,
      }));
      expect(surfaces.filters).toBe(surfaces.header);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

      const heights = await root.locator('.settlement-command-bar :is(button, input, select)').evaluateAll(nodes => nodes
        .filter(node => (node as HTMLElement).offsetParent !== null)
        .map(node => Math.round(node.getBoundingClientRect().height)));
      expect(heights.length).toBeGreaterThan(0);
      expect(Math.min(...heights), `${theme} ${width}px touch target`).toBeGreaterThanOrEqual(44);
    });
  }
}
