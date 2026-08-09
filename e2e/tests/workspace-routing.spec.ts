import { expect, test, type Page, type Route } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { installFirebaseStub } from './helpers';

const ROOT = path.resolve(__dirname, '../..');
const VALID_SLUGS = ['peak', 'build-solution', 'jeonju', 'daegu'] as const;

type WorkspaceRole = 'admin' | 'manager' | 'member' | 'oversight';
type ApiCall = { path: string; search: string; method: string; workspace: string; pageUrl: string };

type WorkspaceTestOptions = {
  defaultSlug?: string;
  activeRoles?: Partial<Record<(typeof VALID_SLUGS)[number], WorkspaceRole>>;
  permissions?: Partial<Record<(typeof VALID_SLUGS)[number], Record<string, unknown>>>;
  intakeRows?: Partial<Record<(typeof VALID_SLUGS)[number], Record<string, unknown>[]>>;
  companyDocuments?: Partial<Record<(typeof VALID_SLUGS)[number], Record<string, unknown>[]>>;
};

const names: Record<(typeof VALID_SLUGS)[number], string> = {
  peak: '피크마케팅',
  'build-solution': '빌드솔루션',
  jeonju: '전주지사',
  daegu: '대구지사',
};

function send(route: Route, payload: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(payload),
  });
}

async function serveWorkspaceShell(page: Page) {
  const html = fs.readFileSync(path.join(ROOT, 'business-os-preview.html'));
  const js = fs.readFileSync(path.join(ROOT, 'business-os-preview.js'));
  const css = fs.readFileSync(path.join(ROOT, 'business-os-live.css'));
  await page.route('**/os/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/os/' || /^\/os\/w\/[^/]+\/?$/.test(pathname)) {
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

async function installWorkspaceApi(page: Page, options: WorkspaceTestOptions = {}) {
  const calls: ApiCall[] = [];
  const roles = options.activeRoles || {
    peak: 'admin',
    daegu: 'member',
  };
  const defaultSlug = options.defaultSlug || 'peak';
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const apiPath = url.pathname.replace(/^\/api/, '');
    const workspace = request.headers()['x-peakos-workspace'] || '';
    calls.push({ path: apiPath, search: url.search, method: request.method(), workspace, pageUrl: request.frame().url() });

    if (apiPath === '/users/me') {
      return send(route, {
        uid: 'e2e-test-user', name: '김대호', email: 'e2e@test.local', role: 'admin',
        approved: true, is_active: true, group_name: '본사 영업팀', group_type: 'sales',
        peakos_can_view_finance_operations: true, peakos_can_view_tax_purchase: true,
        peakos_can_preview_accounts: true, peakos_can_read_bank: true,
        peakos_can_review_finance: true, peakos_can_view_final_execution: true,
      });
    }
    if (apiPath === '/os-auth/session') {
      return send(route, { required: true, verified: true, expiresInSeconds: 3600 });
    }
    if (apiPath === '/os/workspaces') {
      return send(route, {
        default_slug: defaultSlug,
        workspaces: VALID_SLUGS
          .filter(slug => roles[slug])
          .map(slug => ({ id: `workspace-${slug}`, slug, name: names[slug], kind: slug === 'peak' ? 'headquarters' : 'branch', role: roles[slug] })),
      });
    }
    const contextMatch = /^\/os\/workspaces\/([^/]+)\/context$/.exec(apiPath);
    if (contextMatch) {
      const slug = decodeURIComponent(contextMatch[1]) as (typeof VALID_SLUGS)[number];
      const role = roles[slug];
      if (!role || workspace !== slug) {
        return send(route, { error: 'workspace denied', code: 'PEAKOS_WORKSPACE_FORBIDDEN' }, 403);
      }
      const standard = role === 'oversight'
        ? { calendar: 'none', chat: 'none', projects: 'read', settlements: 'read', documents: 'read', headquartersOversight: true }
        : { calendar: 'write', chat: 'write', projects: 'write', settlements: 'write', documents: 'write', headquartersOversight: false };
      return send(route, {
        workspace: { id: `workspace-${slug}`, slug, name: names[slug], kind: slug === 'peak' ? 'headquarters' : 'branch' },
        membership: { role },
        permissions: { ...standard, ...(options.permissions?.[slug] || {}) },
      });
    }

    if (apiPath === '/peakos/prices') return send(route, []);
    if (apiPath.startsWith('/peakos/collaboration/events/checklist-summary')) return send(route, {});
    if (apiPath.startsWith('/peakos/collaboration/events')) return send(route, []);
    if (apiPath === '/peakos/collaboration/chat-rooms/unread') return send(route, {});
    if (apiPath === '/peakos/collaboration/chat-rooms') return send(route, []);
    if (apiPath === '/peakos/collaboration/projects') {
      return send(route, {
        projects: [{
          id: `${workspace}-project`, name: workspace === 'peak' ? '본사 비공개 프로젝트' : `${names[workspace as keyof typeof names]} 프로젝트`,
          status: 'active', owner_name: '담당자', task_count: 0, done_task_count: 0,
        }],
      });
    }
    const projectDetail = /^\/peakos\/collaboration\/projects\/([^/]+)$/.exec(apiPath);
    if (projectDetail && request.method() === 'GET') {
      return send(route, {
        id: projectDetail[1],
        name: workspace === 'peak' ? '본사 비공개 프로젝트' : `${names[workspace as keyof typeof names]} 프로젝트`,
        status: 'active', owner_name: '담당자', canManage: true, deadline: '',
        members: [], tasks: [], updates: [], events: [], comments: [],
      });
    }
    if (apiPath.startsWith('/peakos/collaboration/users/all-approved')) return send(route, []);
    if (apiPath === '/peakos/company-documents') {
      return send(route, { folder: 'branches', documents: options.companyDocuments?.[workspace as keyof typeof names] || [] });
    }
    if (apiPath === '/peakos/intake') {
      return send(route, options.intakeRows?.[workspace as keyof typeof names] || []);
    }
    if (apiPath === '/peakos/final-execution') return send(route, { rows: [] });

    // Peak's existing singleton loaders are irrelevant to these routing tests.
    // Return empty shapes, but record every call so non-Peak zero-request rules
    // can assert that none of these endpoints were touched.
    if (apiPath === '/service-requests') return send(route, { canManage: false, requests: [] });
    if (apiPath === '/ideas') return send(route, []);
    if (apiPath.startsWith('/peakos/')) return send(route, []);
    return send(route, []);
  });
  return calls;
}

async function setup(page: Page, options: WorkspaceTestOptions = {}) {
  await installFirebaseStub(page);
  await serveWorkspaceShell(page);
  return installWorkspaceApi(page, options);
}

async function expandMainNavigation(page: Page) {
  const cluster = page.locator('[data-nav-cluster="main"]');
  if ((await cluster.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await cluster.locator(':scope > .nav-cluster-toggle').click();
  }
}

async function expectNavLocked(page: Page, view: string, locked: boolean) {
  const item = page.locator(`.app-sidebar .nav-item[data-view="${view}"]`);
  await expect(item).toHaveAttribute('data-nav-locked', locked ? 'true' : 'false');
  expect(await item.evaluate(element => (element as HTMLElement).hidden)).toBe(locked);
}

test('canonical workspace route sends a non-overridable workspace header and keeps new workspaces empty', async ({ page }) => {
  const calls = await setup(page, { defaultSlug: 'daegu', activeRoles: { peak: 'admin', daegu: 'member' } });
  await page.goto('/os/w/daegu');
  await expect(page.locator('#authGate')).toBeHidden();
  await expect(page.locator('[data-active-workspace-name]')).toHaveText('대구지사 OS');
  await expect(page.locator('[data-workspace-selector]')).toHaveValue('daegu');
  await expect(page.locator('[data-nav-cluster="sales-operations"]')).not.toHaveClass(/\bclosed\b/);
  for (const cluster of ['main', 'company', 'finance', 'tax-banking', 'tools']) {
    await expect(page.locator(`[data-nav-cluster="${cluster}"]`)).toHaveClass(/\bclosed\b/);
  }
  await expandMainNavigation(page);

  const protectedCalls = calls.filter(call => call.path !== '/os/workspaces');
  expect(protectedCalls.length).toBeGreaterThan(0);
  expect(protectedCalls.every(call => call.workspace === 'daegu')).toBe(true);
  expect(calls.filter(call => call.path === '/os/workspaces').every(call => call.workspace === '')).toBe(true);

  const forbiddenPrefixes = [
    '/peakos/bank', '/peakos/finance-requests', '/peakos/credit', '/peakos/fund',
    '/reports', '/ideas', '/service-requests',
  ];
  expect(calls.filter(call => forbiddenPrefixes.some(prefix => call.path.startsWith(prefix)))).toEqual([]);
  expect(calls.filter(call => call.path === '/peakos/intake' && call.search === '')).toHaveLength(1);
  expect(calls.some(call => call.path === '/peakos/intake' && call.search.includes('scope=all'))).toBe(false);
  expect(calls.some(call => call.path.startsWith('/peakos/monthly/'))).toBe(false);
  expect(calls.some(call => call.path === '/peakos/final-execution')).toBe(false);
  await expect(page.locator('[data-view="calendar"]')).toBeVisible();
  await expect(page.locator('[data-view="chat"]')).toBeVisible();
  await expect(page.locator('[data-view="review"]')).toBeVisible();
  await expectNavLocked(page, 'settlement', false);
  await expectNavLocked(page, 'final-settlement', true);
  await expectNavLocked(page, 'final-execution-settlement', true);
  await expectNavLocked(page, 'monthly-guarantee', true);
  await expectNavLocked(page, 'monthly-manage', true);
  await expectNavLocked(page, 'direct-execution', true);
  await expectNavLocked(page, 'company', false);
  await expectNavLocked(page, 'documents', false);
  await expectNavLocked(page, 'organization', true);
  await expectNavLocked(page, 'services', true);
  await expect(page.locator('[data-isolated-workspace-home]')).toContainText('등록된 운영 데이터가 없습니다');
  await expect(page.locator('#dashboardView')).not.toContainText('본사 비공개');

  await page.locator('.app-sidebar .nav-item[data-view="review"]')
    .evaluate(element => (element as HTMLElement).click());
  await expect(page.locator('#reviewView')).toContainText('대구지사 프로젝트');
  await page.locator('[data-project-id="daegu-project"]').click();
  await expect(page.locator('#collaborationProjectCommentForm [data-workspace-attachment-unavailable]')).toContainText('전용 보관함 준비 후');
  await expect(page.locator('#collaborationProjectCommentForm input[type="file"]')).toHaveCount(0);
  expect(calls.some(call => call.path.includes('/projects/upload'))).toBe(false);

  await page.locator('.app-sidebar .nav-item[data-view="chat"]')
    .evaluate(element => (element as HTMLElement).click());
  const attach = page.locator('#chatAttachButton');
  await expect(attach).toBeDisabled();
  expect(await attach.evaluate(element => (element as HTMLElement).hidden)).toBe(true);
  await expect(page.locator('#chatComposer [data-workspace-attachment-unavailable]')).toHaveCount(1);
  expect(calls.some(call => call.path.includes('/upload-file') || /\/chat-rooms\/[^/]+\/upload$/.test(call.path))).toBe(false);

  await page.locator('.app-sidebar .nav-item[data-view="company"]')
    .evaluate(element => (element as HTMLElement).click());
  await expect(page.locator('[data-isolated-company-documents]')).toContainText('등록된 회사 자료가 없습니다');
  const companyDocumentCalls = calls.filter(call => call.path === '/peakos/company-documents');
  expect(companyDocumentCalls.length).toBeGreaterThan(0);
  expect(companyDocumentCalls.every(call => call.workspace === 'daegu')).toBe(true);
});

for (const slug of ['build-solution', 'jeonju'] as const) {
  test(`${slug} canonical route starts as its own empty workspace`, async ({ page }) => {
    const calls = await setup(page, { defaultSlug: slug, activeRoles: { [slug]: 'member' as const } });
    await page.goto(`/os/w/${slug}`);
    await expect(page.locator('#authGate')).toBeHidden();
    await expect(page.locator('[data-active-workspace-name]')).toHaveText(`${names[slug]} OS`);
    const businessCalls = calls.filter(call => call.path.startsWith('/peakos/'));
    expect(businessCalls.length).toBeGreaterThan(0);
    expect(businessCalls.every(call => call.workspace === slug)).toBe(true);
    expect(calls.filter(call => call.path === '/peakos/intake' && call.search === '')).toHaveLength(1);
    expect(calls.some(call => call.path === '/peakos/intake' && call.search.includes('scope=all'))).toBe(false);
    expect(calls.some(call => call.path.startsWith('/peakos/monthly/'))).toBe(false);
    expect(calls.some(call => call.path === '/peakos/final-execution')).toBe(false);
    expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
    await expectNavLocked(page, 'final-settlement', true);
    await expectNavLocked(page, 'final-execution-settlement', true);
    await expectNavLocked(page, 'monthly-guarantee', true);
    await expect(page.locator('[data-isolated-workspace-home]')).toContainText('등록된 운영 데이터가 없습니다');
  });
}

test('branch manager loads the workspace-wide final ledgers but no unassigned monthly ledgers', async ({ page }) => {
  const calls = await setup(page, { defaultSlug: 'daegu', activeRoles: { daegu: 'manager' } });
  await page.goto('/os/w/daegu');
  await expect(page.locator('#authGate')).toBeHidden();

  expect(calls.filter(call => call.path === '/peakos/intake' && call.search === '')).toHaveLength(1);
  expect(calls.filter(call => call.path === '/peakos/intake' && call.search === '?scope=all')).toHaveLength(1);
  expect(calls.filter(call => call.path === '/peakos/final-execution')).toHaveLength(1);
  expect(calls.some(call => call.path.startsWith('/peakos/monthly/'))).toBe(false);
  await expectNavLocked(page, 'settlement', false);
  await expectNavLocked(page, 'final-settlement', false);
  await expectNavLocked(page, 'final-execution-settlement', false);
  await expectNavLocked(page, 'monthly-guarantee', true);
  await expectNavLocked(page, 'monthly-manage', true);
  await expectNavLocked(page, 'direct-execution', true);
});

test('HQ oversight is server-capability driven, branch read-only, and cannot see calendar/chat or mutation controls', async ({ page }) => {
  const calls = await setup(page, {
    defaultSlug: 'peak',
    activeRoles: { peak: 'admin', daegu: 'oversight' },
    intakeRows: {
      daegu: [{
        id: 'daegu-intake-1', rowVersion: 1, date: '2026-08-09', client: '대구 격리 업체',
        a: '블로그', b: '원고', c: '일반', unit: 1000, qty: 1, sell: 2000,
        owner: 'daegu-user', ownerName: '대구직원', kind: 'normal', paid: 'none',
      }],
    },
    companyDocuments: {
      daegu: [{
        id: 'daegu-doc-1', folder: 'branches', branch: '대구지사', filename: '대구 전용 회사자료.pdf',
        mimeType: 'application/pdf', size: 4096, available: true, canPreview: false, updatedAt: '2026-08-09T00:00:00Z',
      }],
    },
  });
  await page.goto('/os/w/daegu');
  await expect(page.locator('#authGate')).toBeHidden();
  await expandMainNavigation(page);
  await expect(page.locator('[data-workspace-readonly]')).toBeVisible();
  await expectNavLocked(page, 'calendar', true);
  await expectNavLocked(page, 'chat', true);
  await expect(page.locator('[data-view="review"]')).toBeVisible();
  await expectNavLocked(page, 'settlement', false);
  await expectNavLocked(page, 'final-settlement', false);
  await expectNavLocked(page, 'final-execution-settlement', false);
  await expectNavLocked(page, 'monthly-guarantee', false);
  await expectNavLocked(page, 'monthly-manage', false);
  await expectNavLocked(page, 'direct-execution', false);
  await expectNavLocked(page, 'company', false);
  await expectNavLocked(page, 'documents', false);
  await expectNavLocked(page, 'reports', true);
  await expect(page.locator('[data-collab-project-create]')).toHaveCount(0);
  await expect(page.locator('#reviewView')).toContainText('대구지사 프로젝트');
  await page.locator('.app-sidebar .nav-item[data-view="settlement"]')
    .evaluate(element => (element as HTMLElement).click());
  await expect(page.locator('[data-intake-add]')).toHaveCount(0);
  await expect(page.locator('[data-intake-edit]')).toHaveCount(0);
  await expect(page.locator('[data-intake-remove]')).toHaveCount(0);
  await expect(page.locator('#moduleView')).toContainText('본사 열람 모드');
  await expect(page.locator('#moduleView')).toContainText('대구 격리 업체');
  await page.locator('.app-sidebar .nav-item[data-view="monthly-guarantee"]')
    .evaluate(element => (element as HTMLElement).click());
  await expect(page.locator('[data-monthly-add]')).toHaveCount(0);
  await expect(page.locator('[data-monthly-remove]')).toHaveCount(0);
  await page.locator('.app-sidebar .nav-item[data-view="company"]')
    .evaluate(element => (element as HTMLElement).click());
  await expect(page.locator('[data-isolated-company-documents]')).toContainText('대구 전용 회사자료.pdf');
  expect(calls.filter(call => call.path === '/peakos/intake' && call.search === '?scope=all')).toHaveLength(1);
  expect(calls.some(call => call.path === '/peakos/intake' && call.search === '')).toBe(false);
  expect(calls.filter(call => call.path.startsWith('/peakos/monthly/') && call.search === '?scope=all')).toHaveLength(3);
  expect(calls.filter(call => call.path === '/peakos/final-execution')).toHaveLength(1);
  expect(calls.some(call => call.path.includes('/collaboration/events'))).toBe(false);
  expect(calls.some(call => call.path.includes('/collaboration/chat-rooms'))).toBe(false);
  expect(calls.some(call => call.path.includes('/projects/upload') || call.path.includes('/upload-file'))).toBe(false);
  expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
});

test('/os/ resolves only the server default membership before any business API is requested', async ({ page }) => {
  const calls = await setup(page, { defaultSlug: 'daegu', activeRoles: { peak: 'oversight', daegu: 'member' } });
  await page.goto('/os/');
  await page.waitForURL(/\/os\/w\/daegu$/);
  await expect(page.locator('#authGate')).toBeHidden();
  const firstBusinessCall = calls.findIndex(call => call.path.startsWith('/peakos/') || call.path === '/ideas' || call.path === '/service-requests');
  const contextCall = calls.findIndex(call => call.path === '/os/workspaces/daegu/context');
  expect(contextCall).toBeGreaterThanOrEqual(0);
  expect(firstBusinessCall).toBeGreaterThan(contextCall);
  expect(calls.slice(0, contextCall).some(call => call.path.startsWith('/peakos/'))).toBe(false);
  expect(calls.filter(call => call.path.startsWith('/peakos/')).every(call => call.workspace === 'daegu')).toBe(true);
});

test('invalid workspace slug fails closed before authentication or data requests', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/os/w/not-a-workspace');
  await expect(page.locator('#authGate')).toBeVisible();
  await expect(page.locator('#authGate')).toContainText('올바르지 않은 워크스페이스 주소');
  expect(calls).toEqual([]);
});

test('selector performs a full canonical navigation and no Peak project remains after switching', async ({ page }) => {
  const calls = await setup(page, { defaultSlug: 'peak', activeRoles: { peak: 'admin', daegu: 'member' } });
  await page.goto('/os/w/peak');
  await expect(page.locator('#authGate')).toBeHidden();
  await expandMainNavigation(page);
  await page.locator('[data-view="review"]').click();
  await expect(page.locator('#reviewView')).toContainText('본사 비공개 프로젝트');

  await page.locator('[data-workspace-selector]').selectOption('daegu');
  await page.waitForURL(/\/os\/w\/daegu$/);
  await expect(page.locator('#authGate')).toBeHidden();
  await expandMainNavigation(page);
  await page.locator('[data-view="review"]').click();
  await expect(page.locator('#reviewView')).toContainText('대구지사 프로젝트');
  await expect(page.locator('body')).not.toContainText('본사 비공개 프로젝트');
  expect(calls.filter(call => call.path.startsWith('/peakos/collaboration/') && call.workspace === 'daegu').length).toBeGreaterThan(0);
});
