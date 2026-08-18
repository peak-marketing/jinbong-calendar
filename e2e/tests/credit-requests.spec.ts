import { expect, test, type Page, type Route } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createPeakosStore, handlePeakos, installFirebaseStub } from './helpers';

const ROOT = path.resolve(__dirname, '../..');

type WorkspaceRole = 'member' | 'manager' | 'admin' | 'oversight';
type CreditFixture = {
  name: string;
  groupType?: string;
  role?: WorkspaceRole;
  workspace?: 'peak' | 'daegu';
  settlements?: 'none' | 'read' | 'write';
  finance?: boolean;
  preview?: boolean;
  chatOnly?: boolean;
};

async function serveOsShell(page: Page) {
  const html = fs.readFileSync(path.join(ROOT, 'business-os-preview.html'));
  const js = fs.readFileSync(path.join(ROOT, 'business-os-preview.js'));
  const css = fs.readFileSync(path.join(ROOT, 'business-os-live.css'));
  await page.route('**/os/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (/^\/os\/w\/[a-z0-9-]+\/?$/.test(pathname) || pathname === '/os/' || pathname === '/os/login') {
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

function bodyOf(route: Route) {
  try { return route.request().postDataJSON(); } catch { return null; }
}

async function installCreditApi(page: Page, fixture: CreditFixture) {
  const workspace = fixture.workspace || 'peak';
  const role = fixture.role || 'member';
  const settlements = fixture.settlements || (role === 'oversight' ? 'read' : 'write');
  const store = createPeakosStore(fixture.name, role);
  const mutations: Array<{ method: string; path: string; body: any; workspace: string }> = [];

  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname.replace(/^\/api/, '');
    const method = request.method().toUpperCase();
    const send = (payload: unknown, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(payload),
    });

    if (pathname === '/users/me') {
      return send({
        uid: 'e2e-test-user', name: fixture.name, email: 'sales@test.local',
        role: role === 'admin' ? 'admin' : 'member', approved: true, is_active: true,
        group_id: 'sales-team', group_name: fixture.groupType === 'sales' ? '본사 영업팀' : '본사 운영팀',
        group_type: fixture.groupType || 'support', chat_only: fixture.chatOnly === true,
        external_calendar_only: false,
        peakos_can_read_bank: true,
        peakos_can_view_bank_balances: fixture.finance === true,
        peakos_can_review_finance: fixture.finance === true,
        peakos_can_view_finance_operations: fixture.finance === true,
        peakos_can_view_tax_purchase: fixture.finance === true,
        peakos_can_preview_accounts: fixture.preview === true,
        peakos_special_settlement_views: [],
        peakos_can_view_final_execution: fixture.finance === true,
      });
    }
    if (pathname === '/os-auth/session') {
      return send({ required: true, verified: true, expiresInSeconds: 3600 });
    }
    if (pathname === '/os/workspaces') {
      return send({
        default_slug: workspace,
        workspaces: [{
          id: `ws_${workspace}`, slug: workspace,
          name: workspace === 'peak' ? '피크마케팅 본사' : '피크마케팅 대구지사',
          kind: workspace === 'peak' ? 'headquarters' : 'branch', role,
        }],
      });
    }
    if (pathname === `/os/workspaces/${workspace}/context`) {
      const oversight = role === 'oversight';
      return send({
        workspace: {
          id: `ws_${workspace}`, slug: workspace,
          name: workspace === 'peak' ? '피크마케팅 본사' : '피크마케팅 대구지사',
          kind: workspace === 'peak' ? 'headquarters' : 'branch',
        },
        membership: { role },
        permissions: {
          calendar: oversight ? 'none' : 'write', chat: oversight ? 'none' : 'write',
          projects: oversight ? 'read' : 'write', settlements,
          documents: 'read', sales: oversight ? 'read' : 'write', headquartersOversight: oversight,
        },
      });
    }
    if (pathname === '/users/all-approved') return send([]);
    if (pathname.startsWith('/peakos/collaboration/')) {
      if (/\/projects(?:\?|$)/.test(pathname)) return send({ canManageAll: false, projects: [] });
      if (/\/chat-rooms\/unread(?:\?|$)/.test(pathname)) return send({});
      return send([]);
    }
    if (pathname.startsWith('/peakos/credit-requests') && method !== 'GET') {
      mutations.push({
        method, path: pathname, body: bodyOf(route),
        workspace: request.headers()['x-peakos-workspace'] || '',
      });
    }
    if (handlePeakos(store, route)) return;
    if (pathname === '/service-requests') return send({ canManage: false, requests: [] });
    return send([]);
  });
  return { store, mutations, workspace };
}

async function openCredit(page: Page, workspace = 'peak') {
  await page.goto(`/os/w/${workspace}`);
  await expect(page.locator('#authGate')).toBeHidden();
  const cluster = page.locator('[data-nav-cluster="finance"]');
  await expect(cluster).toBeVisible();
  if (await cluster.evaluate(element => element.classList.contains('closed'))) {
    await cluster.locator('.nav-cluster-toggle').click();
  }
  const tab = page.locator('.nav-item[data-view="credit"]');
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page.locator('[data-credit-request-form]')).toBeVisible();
}

test.describe('PEAK OS credit requests', () => {
  test.beforeEach(async ({ page }) => {
    await installFirebaseStub(page);
    await serveOsShell(page);
  });

  test('approved direct Peak salesperson creates and cancels only their own request without company ledger access', async ({ page }) => {
    const { store, mutations } = await installCreditApi(page, {
      name: '박우진', groupType: 'sales', role: 'member', workspace: 'peak', settlements: 'write',
    });
    await openCredit(page);

    await expect(page.getByText('내 충전 요청', { exact: true })).toBeVisible();
    await expect(page.getByText('재무 장부 직접 기입', { exact: true })).toHaveCount(0);
    await page.locator('[data-credit-request="client"]').fill('직속 영업 거래처');
    await page.locator('[data-credit-request="depositorName"]').fill('홍길동');
    await page.locator('[data-credit-request="product"]').selectOption('플레이스');
    await page.locator('[data-credit-request="vendor"]').selectOption('피크마케팅');
    await page.locator('[data-credit-request="expectedAmount"]').fill('110000');
    await page.locator('[data-credit-request="pointAmount"]').fill('100000');
    await page.locator('[data-credit-request-submit]').click();

    await expect(page.getByText('직속 영업 거래처', { exact: true })).toBeVisible();
    expect(store.creditRequests).toHaveLength(1);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ method: 'POST', path: '/peakos/credit-requests', workspace: 'peak' });

    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-credit-request-cancel]').click();
    await expect(page.getByText('취소', { exact: true })).toBeVisible();
    expect(store.creditRequests[0].status).toBe('CANCELLED');
    expect(mutations.at(-1)?.method).toBe('DELETE');
  });

  test('designated finance reviewer sees all requests and the separate company ledger', async ({ page }) => {
    const { store } = await installCreditApi(page, {
      name: '손명아', groupType: 'support', role: 'manager', workspace: 'peak', settlements: 'write', finance: true,
    });
    store.creditRequests.push({
      id: 'credit-request-finance-review', requesterUid: 'sales-user', requesterName: '영업담당자',
      targetAccountId: 'ibk-review-space', requestDate: '2026-08-06', client: '검토 업체',
      depositorName: '검토입금자', product: '플레이스', vendor: '피크마케팅',
      expectedAmount: 330000, pointAmount: 320000, memo: '', status: 'PENDING', bankTransactionId: null,
    });

    await openCredit(page);
    await expect(page.getByText('전체 충전 요청', { exact: true })).toBeVisible();
    await expect(page.getByText('영업담당자', { exact: true })).toBeVisible();
    await expect(page.getByText('검토 업체', { exact: true })).toBeVisible();
    await expect(page.getByText('재무 장부 직접 기입', { exact: true })).toBeVisible();
  });

  test('account preview removes the request form and cannot emit a mutation', async ({ page }) => {
    const { mutations } = await installCreditApi(page, {
      name: '김대호', groupType: 'support', role: 'manager', workspace: 'peak', settlements: 'write', finance: true, preview: true,
    });
    await openCredit(page);
    await page.locator('#personaSelect').selectOption('전현우');
    await expect(page.locator('.persona-preview-warning')).toBeVisible();
    await expect(page.locator('[data-credit-request-form]')).toHaveCount(0);
    expect(mutations).toHaveLength(0);
  });

  for (const denied of [
    { title: 'branch direct member', fixture: { name: '지사영업자', groupType: 'sales', role: 'member' as const, workspace: 'daegu' as const, settlements: 'write' as const } },
    { title: 'headquarters oversight', fixture: { name: '본사열람자', groupType: 'support', role: 'oversight' as const, workspace: 'daegu' as const, settlements: 'read' as const } },
    { title: 'read-only Peak membership', fixture: { name: '읽기계정', groupType: 'sales', role: 'member' as const, workspace: 'peak' as const, settlements: 'read' as const } },
    { title: 'restricted Peak account', fixture: { name: '채팅전용', groupType: 'sales', role: 'member' as const, workspace: 'peak' as const, settlements: 'write' as const, chatOnly: true } },
  ]) {
    test(`${denied.title} cannot reveal or mutate credit requests`, async ({ page }) => {
      const { mutations, workspace } = await installCreditApi(page, denied.fixture);
      await page.goto(`/os/w/${workspace}`);
      await expect(page.locator('#authGate')).toBeHidden();
      const tab = page.locator('.nav-item[data-view="credit"]');
      await expect(tab).toBeHidden();
      await tab.evaluate(element => (element as HTMLElement).click());
      await expect(page.locator('[data-credit-request-form]')).toHaveCount(0);
      expect(mutations).toHaveLength(0);
    });
  }
});
