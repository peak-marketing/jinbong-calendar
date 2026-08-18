import { expect, test, type Page, type Route } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createPeakosStore, handlePeakos, installFirebaseStub } from './helpers';

const ROOT = path.resolve(__dirname, '../..');
const COMPANY_RESOURCE_VIEWS = [
  ['company-equipment-usage', '비품 사용 내역'],
  ['company-development-costs', '개발비'],
  ['company-bank-copies', '통장사본'],
  ['company-materials', '기타 회사자료'],
] as const;

type EquipmentEntry = {
  id: string;
  usedOn: string;
  itemName: string;
  purpose: string;
  quantity: number;
  usedByUid: string;
  usedByName: string;
  memo: string;
  status: 'ACTIVE' | 'VOIDED';
  voidReason: string;
  rowVersion: number;
  recordedByName: string;
  createdAt: string;
  updatedAt: string;
};

type CompanyResourceCall = {
  method: string;
  path: string;
  workspace: string;
};

type CompanyResourceFixture = {
  entries: EquipmentEntry[];
  previewEnabled?: boolean;
  financeReviewer?: boolean;
  calls: CompanyResourceCall[];
};

function equipmentEntry(overrides: Partial<EquipmentEntry> = {}): EquipmentEntry {
  return {
    id: '123e4567-e89b-42d3-a456-426614174000',
    usedOn: '2026-08-17',
    itemName: '상담용 노트북',
    purpose: '대구 현장 상담',
    quantity: 1,
    usedByUid: 'e2e-test-user',
    usedByName: '재무 담당자',
    memo: '오후 반납 예정',
    status: 'ACTIVE',
    voidReason: '',
    rowVersion: 1,
    recordedByName: '재무 담당자',
    createdAt: '2026-08-17T01:00:00.000Z',
    updatedAt: '2026-08-17T01:00:00.000Z',
    ...overrides,
  };
}

function defaultFixture(overrides: Partial<CompanyResourceFixture> = {}): CompanyResourceFixture {
  return {
    entries: [equipmentEntry()],
    financeReviewer: true,
    calls: [],
    ...overrides,
  };
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

async function installApi(page: Page, fixture: CompanyResourceFixture) {
  const store = createPeakosStore('재무 담당자', 'manager');
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname.replace(/^\/api/, '');
    const method = request.method();
    const send = (payload: unknown, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });

    if (pathname === '/users/me') {
      return send({
        uid: 'e2e-test-user',
        name: '재무 담당자',
        email: 'finance@test.local',
        role: 'manager',
        approved: true,
        is_active: true,
        group_id: 'finance-team',
        group_name: '본사 경영지원팀',
        group_type: 'support',
        peakos_can_view_finance_operations: true,
        peakos_can_review_finance: fixture.financeReviewer !== false,
        peakos_can_preview_accounts: fixture.previewEnabled === true,
      });
    }
    if (pathname === '/users/all-approved') {
      return send([
        {
          uid: 'e2e-test-user', name: '재무 담당자', email: 'finance@test.local',
          role: 'manager', approved: true, is_active: true,
          group_id: 'finance-team', group_name: '본사 경영지원팀', group_type: 'support',
        },
        {
          uid: 'preview-sales-user', name: '김대호', email: 'sales@test.local',
          role: 'manager', approved: true, is_active: true,
          group_id: 'sales-team', group_name: '본사 영업팀', group_type: 'sales',
        },
      ]);
    }
    if (pathname === '/os-auth/session') {
      return send({ required: true, verified: true, expiresInSeconds: 3600 });
    }
    if (pathname === '/os/workspaces') {
      return send({
        default_slug: 'peak',
        workspaces: [{
          id: 'ws_peak', slug: 'peak', name: '피크마케팅 본사', kind: 'headquarters', role: 'manager',
        }],
      });
    }
    if (pathname === '/os/workspaces/peak/context') {
      return send({
        workspace: { id: 'ws_peak', slug: 'peak', name: '피크마케팅 본사', kind: 'headquarters' },
        membership: { role: 'manager' },
        permissions: {
          calendar: 'write', chat: 'write', projects: 'write', settlements: 'write',
          documents: 'write', sales: 'read', headquartersOversight: false,
        },
      });
    }
    if (pathname.startsWith('/peakos/company-resources')) {
      fixture.calls.push({
        method,
        path: pathname + url.search,
        workspace: request.headers()['x-peakos-workspace'] || '',
      });
      if (pathname === '/peakos/company-resources/equipment-usage' && method === 'GET') {
        return send({ entries: fixture.entries, capabilities: { canWrite: fixture.financeReviewer !== false } });
      }
      if (pathname === '/peakos/company-resources/development-costs' && method === 'GET') {
        return send({ entries: [], capabilities: { canWrite: fixture.financeReviewer !== false } });
      }
      if (pathname === '/peakos/company-resources/documents' && method === 'GET') {
        return send({
          category: url.searchParams.get('category'),
          documents: [],
          capabilities: { canWrite: fixture.financeReviewer !== false },
        });
      }
      return send({ code: 'E2E_UNHANDLED_COMPANY_RESOURCE', error: '처리하지 않은 회사자료 요청' }, 405);
    }

    if (pathname === '/peakos/collaboration/events') return send([]);
    if (pathname === '/peakos/collaboration/events/checklist-summary') return send({});
    if (pathname === '/peakos/collaboration/chat-rooms') return send([]);
    if (pathname === '/peakos/collaboration/chat-rooms/unread') return send({});
    if (pathname === '/peakos/collaboration/projects') return send({ projects: [] });
    if (pathname === '/peakos/collaboration/projects/my-tasks') return send({ readOnly: false, tasks: [] });
    if (pathname === '/service-requests') return send({ canManage: false, requests: [] });
    if (pathname === '/ideas') return send([]);
    if (handlePeakos(store, route)) return;
    return send([]);
  });
}

async function setup(page: Page, fixture: CompanyResourceFixture) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFirebaseStub(page);
  await serveOsShell(page);
  await installApi(page, fixture);
  await page.goto('/os/w/peak');
  await expect(page.locator('#authGate')).toBeHidden();
}

async function openCompanyResourceNavigation(page: Page) {
  const salesOperations = page.locator('[data-nav-cluster="sales-operations"]');
  await expect(salesOperations).toBeVisible();
  if ((await salesOperations.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await salesOperations.locator(':scope > .nav-cluster-toggle').click();
  }
  const companyResources = salesOperations.locator('[data-nav-subcluster="company-resources"]');
  await expect(companyResources).toBeVisible();
  if ((await companyResources.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await companyResources.locator(':scope > .nav-subcluster-toggle').click();
  }
  return companyResources;
}

test('권한 있는 실제 계정은 영업 운영의 회사자료 4개 탭과 workspace 비품 원장을 본다', async ({ page }) => {
  const fixture = defaultFixture();
  await setup(page, fixture);
  const navigation = await openCompanyResourceNavigation(page);

  expect(fixture.calls).toHaveLength(0);
  for (const [view, label] of COMPANY_RESOURCE_VIEWS) {
    const tab = navigation.locator(`.nav-item[data-view="${view}"]`);
    await expect(tab).toBeVisible();
    await expect(tab).toContainText(label);
    await expect(tab).toHaveAttribute('data-nav-locked', 'false');
  }

  await navigation.locator('[data-view="company-equipment-usage"]').click();
  const root = page.locator('[data-company-resources-root]');
  await expect(root).toBeVisible();
  await expect(root).toHaveAttribute('data-company-resources-state', 'ready');
  await expect(root.locator('[data-company-equipment-form]')).toBeVisible();
  const row = root.locator('[data-company-equipment-row]').first();
  await expect(row).toContainText('상담용 노트북');
  await expect(row).toContainText('대구 현장 상담');
  await expect(row).toContainText('재무 담당자');
  await expect(row).toContainText('1');

  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0]).toMatchObject({ method: 'GET', workspace: 'peak' });
  expect(fixture.calls[0].path).toMatch(/^\/peakos\/company-resources\/equipment-usage(?:\?limit=(?:50|100))?$/);
});

test('비품 사용 원장이 비어 있어도 쓰기 capability와 명시적 empty-state를 유지한다', async ({ page }) => {
  const fixture = defaultFixture({ entries: [] });
  await setup(page, fixture);
  const navigation = await openCompanyResourceNavigation(page);
  await navigation.locator('[data-view="company-equipment-usage"]').click();

  const root = page.locator('[data-company-resources-root]');
  await expect(root).toHaveAttribute('data-company-resources-state', 'ready');
  await expect(root.locator('[data-company-equipment-form]')).toBeVisible();
  await expect(root.locator('[data-company-equipment-row]')).toHaveCount(0);
  await expect(root.locator('[data-company-resources-empty]')).toContainText('등록된 비품 사용 내역이 없습니다');
  expect(fixture.calls.filter(call => call.path.startsWith('/peakos/company-resources'))).toHaveLength(1);
});

test('5번째 운영 열람자는 비품 탭만 보고 보호 회사자료 탭과 API에는 접근하지 못한다', async ({ page }) => {
  const fixture = defaultFixture({ financeReviewer: false });
  await setup(page, fixture);
  const navigation = await openCompanyResourceNavigation(page);
  await expect(navigation.locator('[data-view="company-equipment-usage"]')).toBeVisible();
  for (const view of ['company-development-costs', 'company-bank-copies', 'company-materials']) {
    await expect(navigation.locator(`[data-view="${view}"]`)).toBeHidden();
  }
  await navigation.locator('[data-view="company-equipment-usage"]').click();
  await expect(page.locator('[data-company-resources-root]')).toHaveAttribute(
    'data-company-resource-view', 'company-equipment-usage',
  );
  expect(fixture.calls.every(call => call.path.includes('/equipment-usage'))).toBeTruthy();

  await page.evaluate(() => {
    (document.querySelector('[data-view="company-materials"]') as HTMLButtonElement | null)?.click();
  });
  await expect(page.locator('[data-company-resources-root][data-company-resource-view="company-materials"]')).toHaveCount(0);
  expect(fixture.calls.some(call => call.path.includes('COMPANY_MATERIAL'))).toBeFalsy();
});

test('계정 미리보기는 회사자료 4개 탭을 잠그고 강제 클릭에도 API 요청을 만들지 않는다', async ({ page }) => {
  const fixture = defaultFixture({ previewEnabled: true });
  await setup(page, fixture);
  await expect(page.locator('#personaSelect')).toBeVisible();
  await page.locator('#personaSelect').selectOption('김대호');

  const navigation = page.locator('[data-nav-subcluster="company-resources"]');
  await expect(navigation).toBeHidden();
  for (const [view] of COMPANY_RESOURCE_VIEWS) {
    const tab = navigation.locator(`.nav-item[data-view="${view}"]`);
    await expect(tab).toHaveAttribute('data-nav-locked', 'true');
    await expect(tab).toBeHidden();
  }

  // CSS/hidden 속성을 제거해도 activateView의 권한 게이트가 한 번 더 막아야 한다.
  await navigation.locator('[data-view="company-equipment-usage"]').evaluate((node: HTMLButtonElement) => {
    node.hidden = false;
    node.click();
  });
  await expect(page.locator('[data-company-resources-root]')).toHaveCount(0);
  await expect.poll(() => fixture.calls.filter(call => (
    call.path.startsWith('/peakos/company-resources')
  )).length).toBe(0);
});
