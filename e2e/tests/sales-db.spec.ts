import { expect, test, type Page, type Route } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createPeakosStore, handlePeakos, installFirebaseStub } from './helpers';

const ROOT = path.resolve(__dirname, '../..');
const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_LEAD_ID = '22222222-2222-4222-8222-222222222222';

type SalesCall = { method: string; path: string; search: string; body: any; preview: string; workspace: string };
type SalesFixture = {
  role: 'member' | 'manager' | 'admin' | 'oversight';
  groupType?: string;
  userName?: string;
  previewEnabled?: boolean;
  calls: SalesCall[];
  leads: any[];
  callLogs: Record<string, any[]>;
  owners: Array<{ uid: string; name: string }>;
};

function contact({ masked = false } = {}) {
  return masked
    ? { contactName: null, phone: null, phoneMasked: '***-****-5678', address: null, memo: null, redacted: true }
    : {
      contactName: '홍길동 <svg/onload=alert(1)>', phone: '01012345678', phoneMasked: '***-****-5678',
      address: '대구광역시 테스트로 1', memo: '<script>window.__salesXss=1</script> 관심 고객', redacted: false,
    };
}

function makeLead() {
  return {
    id: LEAD_ID,
    companyName: '<img src=x onerror="window.__salesXss=1"> 안전렌탈',
    owner: { uid: 'e2e-test-user', name: '영업 담당자' },
    contact: contact(), channel: 'phone', source: 'manual', status: 'follow_up',
    nextFollowupAt: '2026-08-18T06:30:00.000Z', lastContactAt: '2026-08-17T02:00:00.000Z',
    version: 1, archived: false, archivedAt: null,
    createdBy: { uid: 'e2e-test-user', name: '영업 담당자' },
    createdAt: '2026-08-16T01:00:00.000Z', updatedAt: '2026-08-17T02:00:00.000Z',
  };
}

function collectionLead(lead: any) {
  return {
    ...lead,
    contact: {
      ...contact({ masked: true }),
      phoneMasked: lead?.contact?.phoneMasked || '***-****-****',
    },
  };
}

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

function parseBody(route: Route) {
  try { return route.request().postDataJSON(); } catch { return null; }
}

async function installApi(page: Page, fixture: SalesFixture) {
  const user = {
    uid: 'e2e-test-user', name: fixture.userName || '영업 담당자', email: 'sales@test.local',
    role: fixture.role === 'admin' ? 'admin' : 'member', approved: true, is_active: true,
    group_id: 'sales-group', group_name: fixture.groupType === 'support' ? '운영팀' : '영업팀',
    group_type: fixture.groupType || 'sales', peakos_can_preview_accounts: fixture.previewEnabled === true,
  };
  const peakos = createPeakosStore(user.name, user.role);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname.replace(/^\/api/, '');
    const method = request.method().toUpperCase();
    const body = parseBody(route);
    const send = (payload: unknown, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(payload),
    });

    if (pathname === '/users/me') return send(user);
    if (pathname === '/os-auth/session') return send({ required: true, verified: true, expiresInSeconds: 3600 });
    if (pathname === '/os/workspaces') {
      return send({
        default_slug: 'daegu',
        workspaces: [{ id: 'ws_daegu', slug: 'daegu', name: '피크마케팅 대구지사', kind: 'branch', role: fixture.role }],
      });
    }
    if (pathname === '/os/workspaces/daegu/context') {
      const oversight = fixture.role === 'oversight';
      return send({
        workspace: { id: 'ws_daegu', slug: 'daegu', name: '피크마케팅 대구지사', kind: 'branch' },
        membership: { role: fixture.role },
        permissions: {
          calendar: oversight ? 'none' : 'write', chat: oversight ? 'none' : 'write',
          projects: oversight ? 'read' : 'write', settlements: oversight ? 'read' : 'write',
          documents: 'read', sales: oversight ? 'read' : 'write', headquartersOversight: oversight,
        },
      });
    }

    if (pathname.startsWith('/peakos/sales-leads')) {
      fixture.calls.push({
        method, path: pathname, search: url.search, body,
        preview: request.headers()['x-peakos-preview'] || '',
        workspace: request.headers()['x-peakos-workspace'] || '',
      });
      const oversight = fixture.role === 'oversight';
      if (pathname === '/peakos/sales-leads/summary' && method === 'GET') {
        return send({
          readOnly: oversight, piiAccess: oversight ? 'masked' : 'full', total: fixture.leads.filter(lead => !lead.archived).length,
          statuses: { new: 0, contacted: 0, follow_up: 1, won: 0, lost: 0, do_not_call: 0 },
          followUps: { overdue: 1, today: 0 },
        });
      }
      if (pathname === '/peakos/sales-leads/owners' && method === 'GET') {
        return send({ readOnly: oversight, owners: fixture.owners });
      }
      if (pathname === '/peakos/sales-leads' && method === 'GET') {
        const includeArchived = url.searchParams.get('includeArchived') === 'true';
        const status = url.searchParams.get('status');
        const ownerUid = url.searchParams.get('ownerUid');
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const rows = fixture.leads.filter(lead => (includeArchived || !lead.archived)
          && (!status || lead.status === status)
          && (!ownerUid || lead.owner.uid === ownerUid)
          && (!q || String(lead.companyName).toLowerCase().includes(q) || String(lead.contact.phone).replace(/\D/g, '') === q.replace(/\D/g, '')));
        return send({
          readOnly: oversight, piiAccess: 'masked', detailPiiAccess: oversight ? 'masked' : 'full',
          leads: rows.map(collectionLead), total: rows.length, limit: 50, offset: 0,
        });
      }
      if (pathname === '/peakos/sales-leads' && method === 'POST') {
        const lead = {
          ...makeLead(), id: CREATED_LEAD_ID, companyName: body.companyName,
          owner: { uid: body.ownerUid, name: fixture.owners.find(owner => owner.uid === body.ownerUid)?.name || body.ownerUid },
          contact: { contactName: body.contactName, phone: body.phone.replace(/\D/g, ''), phoneMasked: `***-****-${body.phone.replace(/\D/g, '').slice(-4)}`, address: body.address, memo: body.memo, redacted: false },
          channel: body.channel, source: body.source, status: body.status, nextFollowupAt: body.nextFollowupAt,
        };
        fixture.leads.push(lead);
        return send({ lead }, 201);
      }
      const detail = pathname.match(/^\/peakos\/sales-leads\/([0-9a-f-]+)$/);
      if (detail && method === 'GET') {
        const lead = fixture.leads.find(item => item.id === detail[1]);
        if (!lead) return send({ code: 'SALES_LEAD_NOT_FOUND', error: '리드를 찾을 수 없습니다.' }, 404);
        return send({
          readOnly: oversight, piiAccess: oversight ? 'masked' : 'full',
          lead: oversight ? collectionLead(lead) : lead,
          calls: (fixture.callLogs[lead.id] || []).map(call => oversight ? { ...call, note: null, noteRedacted: true } : call),
        });
      }
      if (detail && method === 'PATCH') {
        const lead = fixture.leads.find(item => item.id === detail[1]);
        if (!lead || Number(body.expectedVersion) !== Number(lead.version)) {
          return send({ code: 'SALES_VERSION_CONFLICT', error: '다른 사용자가 먼저 변경했습니다.' }, 409);
        }
        Object.assign(lead, {
          companyName: body.companyName, channel: body.channel, source: body.source, status: body.status,
          nextFollowupAt: body.nextFollowupAt,
          owner: { uid: body.ownerUid, name: fixture.owners.find(owner => owner.uid === body.ownerUid)?.name || body.ownerUid },
          contact: { contactName: body.contactName, phone: body.phone.replace(/\D/g, ''), phoneMasked: `***-****-${body.phone.replace(/\D/g, '').slice(-4)}`, address: body.address, memo: body.memo, redacted: false },
          version: lead.version + 1,
        });
        return send({ lead });
      }
      const callMatch = pathname.match(/^\/peakos\/sales-leads\/([0-9a-f-]+)\/calls$/);
      if (callMatch && method === 'POST') {
        const lead = fixture.leads.find(item => item.id === callMatch[1]);
        if (!lead || Number(body.expectedVersion) !== Number(lead.version)) {
          return send({ code: 'SALES_VERSION_CONFLICT', error: '다른 사용자가 먼저 변경했습니다.' }, 409);
        }
        const call = {
          id: '33333333-3333-4333-8333-333333333333', leadId: lead.id,
          actor: { uid: user.uid, name: user.name }, disposition: body.disposition,
          occurredAt: body.occurredAt, durationSeconds: body.durationSeconds, note: body.note,
          noteRedacted: false, nextFollowupAt: body.nextFollowupAt, createdAt: body.occurredAt,
        };
        fixture.callLogs[lead.id] ||= [];
        fixture.callLogs[lead.id].unshift(call);
        lead.version += 1;
        lead.status = body.leadStatus || lead.status;
        lead.nextFollowupAt = body.nextFollowupAt;
        lead.lastContactAt = body.occurredAt;
        return send({ lead, call }, 201);
      }
      const archiveMatch = pathname.match(/^\/peakos\/sales-leads\/([0-9a-f-]+)\/archive$/);
      if (archiveMatch && method === 'POST') {
        const lead = fixture.leads.find(item => item.id === archiveMatch[1]);
        if (!lead || Number(body.expectedVersion) !== Number(lead.version)) {
          return send({ code: 'SALES_VERSION_CONFLICT', error: '다른 사용자가 먼저 변경했습니다.' }, 409);
        }
        lead.archived = true;
        lead.archivedAt = new Date().toISOString();
        lead.version += 1;
        return send({ archived: true, lead });
      }
      return send({ error: 'sales fixture route missing' }, 404);
    }

    if (pathname === '/peakos/collaboration/events') return send([]);
    if (pathname === '/peakos/collaboration/events/checklist-summary') return send({});
    if (pathname === '/peakos/collaboration/chat-rooms') return send([]);
    if (pathname === '/peakos/collaboration/chat-rooms/unread') return send({});
    if (pathname === '/peakos/collaboration/projects') return send({ projects: [] });
    if (pathname === '/peakos/collaboration/projects/my-tasks') return send({ readOnly: false, tasks: [] });
    if (pathname === '/service-requests') return send({ canManage: false, requests: [] });
    if (pathname === '/ideas') return send([]);
    if (handlePeakos(peakos, route)) return;
    return send([]);
  });
}

async function setup(page: Page, fixture: SalesFixture, viewport?: { width: number; height: number }) {
  if (viewport) await page.setViewportSize(viewport);
  await installFirebaseStub(page);
  await serveOsShell(page);
  await installApi(page, fixture);
  await page.goto('/os/w/daegu');
  await expect(page.locator('#authGate')).toBeHidden();
}

async function openSalesDb(page: Page) {
  const cluster = page.locator('[data-nav-cluster="sales-operations"]');
  if (await cluster.evaluate(node => node.classList.contains('closed'))) {
    await cluster.locator(':scope > .nav-cluster-toggle').click();
  }
  const button = page.locator('.nav-item[data-view="sales-db"]');
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('[data-sales-db-root]')).toBeVisible();
  await expect(page.locator('[data-sales-db-root]')).toHaveAttribute('data-sales-db-state', 'ready');
}

test.describe('워크스페이스 영업 DB', () => {
  test('신규 콜 대상을 canonical 담당자와 후속일로 저장하고 목록·상세에 다시 표시한다', async ({ page }) => {
    const fixture: SalesFixture = {
      role: 'manager', calls: [], leads: [], callLogs: {},
      owners: [
        { uid: 'e2e-test-user', name: '영업 담당자' },
        { uid: 'other-sales', name: '다른 영업자' },
      ],
    };
    await setup(page, fixture);
    await openSalesDb(page);

    await page.locator('[data-sales-lead-create]').click();
    const form = page.locator('#salesLeadEditorForm');
    await expect(form.locator('select[name="ownerUid"] option')).toHaveCount(2);
    await form.locator('input[name="companyName"]').fill('신규 테스트 영업처');
    await form.locator('input[name="contactName"]').fill('신규 담당자');
    await form.locator('input[name="phone"]').fill('010-9999-8888');
    await form.locator('select[name="ownerUid"]').selectOption('other-sales');
    await form.locator('select[name="status"]').selectOption('follow_up');
    await form.locator('input[name="nextFollowupAt"]').fill('2026-08-20T17:30');
    await form.locator('button[type="submit"]').click();

    await expect.poll(() => fixture.calls.find(call => (
      call.method === 'POST' && call.path === '/peakos/sales-leads'
    ))).not.toBeUndefined();
    const saved = fixture.calls.find(call => call.method === 'POST' && call.path === '/peakos/sales-leads');
    expect(saved?.body).toMatchObject({
      companyName: '신규 테스트 영업처', phone: '010-9999-8888',
      ownerUid: 'other-sales', status: 'follow_up',
    });
    expect(saved?.body?.nextFollowupAt).toContain('2026-08-20T17:30:00.000Z');

    const createdRow = page.locator(`[data-sales-lead-open="${CREATED_LEAD_ID}"]`);
    await expect(createdRow).toContainText('신규 테스트 영업처');
    await expect(createdRow).toContainText('***-****-8888');
    await expect(createdRow).not.toContainText('01099998888');
    await createdRow.click();
    await expect(page.locator('[data-sales-lead-drawer]')).toContainText('01099998888');
    await expect(page.locator('[data-sales-lead-drawer]')).toContainText('다른 영업자');
    await page.locator('.nav-item[data-view="calendar"]').evaluate(button => (button as HTMLButtonElement).click());
    await expect(page.locator('[data-sales-lead-call-link], [data-sales-lead-phone-copy]')).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain('01099998888');
  });

  test('목록은 마스킹하고 상세·수정·콜·보관은 버전 계약과 escaped text를 지킨다', async ({ page }) => {
    const fixture: SalesFixture = {
      role: 'manager', calls: [], leads: [makeLead()], callLogs: {},
      owners: [
        { uid: 'e2e-test-user', name: '영업 담당자' },
        { uid: 'other-sales', name: '다른 영업자' },
      ],
    };
    await setup(page, fixture);
    expect(fixture.calls).toHaveLength(0);
    await openSalesDb(page);

    expect(fixture.calls.filter(call => call.method === 'GET').map(call => call.path)).toEqual(expect.arrayContaining([
      '/peakos/sales-leads', '/peakos/sales-leads/summary', '/peakos/sales-leads/owners',
    ]));
    expect(fixture.calls.every(call => call.workspace === 'daegu' && call.preview === '0')).toBeTruthy();
    await expect(page.locator('.sales-lead-list')).toContainText('***-****-5678');
    await expect(page.locator('.sales-lead-list')).not.toContainText('01012345678');
    await expect(page.locator('.sales-lead-list')).toContainText('<img src=x onerror="window.__salesXss=1"> 안전렌탈');
    await expect(page.locator('.sales-lead-list img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__salesXss || 0)).toBe(0);

    await page.locator(`[data-sales-lead-open="${LEAD_ID}"]`).click();
    await expect(page.locator('[data-sales-lead-drawer]')).toContainText('01012345678');
    await expect(page.locator('[data-sales-lead-call-link]')).toHaveAttribute('href', 'tel:01012345678');
    await expect(page.locator('[data-sales-lead-phone-copy]')).toHaveCount(1);
    await expect(page.locator('[data-sales-lead-drawer]')).toContainText('<script>window.__salesXss=1</script> 관심 고객');
    await expect(page.locator('[data-sales-lead-drawer] script')).toHaveCount(0);

    await page.locator('[data-sales-lead-edit]').click();
    await page.locator('#salesLeadEditorForm input[name="companyName"]').fill('수정된 안전렌탈');
    await page.locator('#salesLeadEditorForm button[type="submit"]').click();
    await expect.poll(() => fixture.calls.find(call => call.method === 'PATCH')?.body?.expectedVersion).toBe(1);
    await expect(page.locator('[data-sales-lead-drawer]')).toContainText('수정된 안전렌탈');

    await page.locator('[data-sales-lead-call]').click();
    await page.locator('#salesCallEditorForm select[name="disposition"]').selectOption('callback');
    await page.locator('#salesCallEditorForm input[name="durationSeconds"]').fill('180');
    await page.locator('#salesCallEditorForm textarea[name="note"]').fill('내일 다시 연락');
    await page.locator('#salesCallEditorForm button[type="submit"]').click();
    await expect.poll(() => fixture.calls.find(call => call.path.endsWith('/calls'))?.body?.expectedVersion).toBe(2);
    await expect(page.locator('[data-sales-lead-drawer]')).toContainText('내일 다시 연락');

    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-sales-lead-archive]').click();
    await expect.poll(() => fixture.calls.find(call => call.path.endsWith('/archive'))?.body?.expectedVersion).toBe(3);
    await expect(page.locator(`[data-sales-lead-open="${LEAD_ID}"]`)).toHaveCount(0);
  });

  test('지연된 첫 상세 실패가 같은 리드 재조회 성공을 덮어쓰지 않는다', async ({ page }) => {
    const fixture: SalesFixture = {
      role: 'manager', calls: [], leads: [makeLead()], callLogs: {},
      owners: [{ uid: 'e2e-test-user', name: '영업 담당자' }],
    };
    await setup(page, fixture);

    let releaseFirstFailure!: () => void;
    const firstFailureGate = new Promise<void>(resolve => { releaseFirstFailure = resolve; });
    let detailAttempts = 0;
    let firstFailureDelivered = false;
    await page.route(`**/api/peakos/sales-leads/${LEAD_ID}`, async route => {
      if (route.request().method().toUpperCase() !== 'GET') return route.fallback();
      detailAttempts += 1;
      if (detailAttempts !== 1) return route.fallback();
      await firstFailureGate;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'SALES_DETAIL_DELAYED_FAILURE', error: '지연된 상세 조회 실패' }),
      });
      firstFailureDelivered = true;
    });

    await openSalesDb(page);
    const leadRow = page.locator(`[data-sales-lead-open="${LEAD_ID}"]`);
    await leadRow.click();
    await expect.poll(() => detailAttempts).toBe(1);

    // 로딩 중 다시 같은 리드를 여는 요청은 앞선 요청보다 새 generation이어야 한다.
    await leadRow.evaluate(button => (button as HTMLButtonElement).click());
    await expect.poll(() => detailAttempts).toBe(2);
    const drawer = page.locator('[data-sales-lead-drawer]');
    await expect(drawer).toContainText('01012345678');

    releaseFirstFailure();
    await expect.poll(() => firstFailureDelivered).toBeTruthy();
    await expect(drawer).toContainText('01012345678');
    await expect(drawer).not.toContainText('상세를 불러오지 못했습니다');
    await expect(page.locator('[data-sales-lead-retry]')).toHaveCount(0);
  });

  test('업체명 전용 검색과 X·Escape·화면 이탈이 민감한 영업 폼 DOM을 즉시 폐기한다', async ({ page }) => {
    const fixture: SalesFixture = {
      role: 'manager', calls: [], leads: [makeLead()], callLogs: {},
      owners: [{ uid: 'e2e-test-user', name: '영업 담당자' }],
    };
    await setup(page, fixture);
    await openSalesDb(page);

    const search = page.locator('.sales-db-search input');
    await expect(search).toHaveAttribute('placeholder', '업체명');
    const listGets = () => fixture.calls.filter(call => call.method === 'GET'
      && call.path === '/peakos/sales-leads').length;
    const readsBeforePhoneSearch = listGets();
    await search.fill('010-1234-5678');
    await page.locator('[data-sales-db-filter-form] button[type="submit"]').click();
    await expect(page.locator('.toast')).toContainText('업체명으로만 검색');
    expect(listGets()).toBe(readsBeforePhoneSearch);

    await page.locator(`[data-sales-lead-open="${LEAD_ID}"]`).click();
    const drawer = page.locator('[data-sales-lead-drawer]');
    await expect(drawer).toContainText('01012345678');

    await page.locator('[data-sales-lead-edit]').click();
    await page.locator('#salesLeadEditorForm input[name="phone"]').fill('010-9999-0001');
    await page.locator('#salesLeadEditorForm textarea[name="memo"]').fill('X 닫기 뒤 남으면 안 되는 메모');
    await page.locator('#readonlyModalClose').click();
    await expect(page.locator('#readonlyDetailModal')).toBeHidden();
    await expect(page.locator('[data-sales-lead-modal]')).toHaveCount(0);

    await page.locator('[data-sales-lead-call]').click();
    await page.locator('#salesCallEditorForm textarea[name="note"]').fill('Escape 뒤 남으면 안 되는 통화 메모');
    await page.keyboard.press('Escape');
    await expect(page.locator('#readonlyDetailModal')).toBeHidden();
    await expect(page.locator('[data-sales-lead-modal]')).toHaveCount(0);

    await page.locator('[data-sales-lead-edit]').click();
    await page.locator('#salesLeadEditorForm input[name="phone"]').fill('010-9999-0002');
    await page.locator('.nav-item[data-view="calendar"]').evaluate(button => (button as HTMLButtonElement).click());
    await expect(page.locator('#calendarView')).toBeVisible();
    await expect(page.locator('[data-sales-lead-modal], [data-sales-lead-drawer]')).toHaveCount(0);
    await expect(page.locator('#readonlyModalBody')).toBeEmpty();
  });

  test('본사 oversight는 업체명 검색과 마스킹 상세만 제공하고 모든 쓰기 UI를 숨긴다', async ({ page }) => {
    const fixture: SalesFixture = {
      role: 'oversight', groupType: 'support', calls: [], leads: [makeLead()], callLogs: {},
      owners: [{ uid: 'e2e-test-user', name: '본사 열람자' }],
    };
    await setup(page, fixture);
    await openSalesDb(page);
    await expect(page.locator('.sales-db-readonly')).toContainText('본사 열람');
    await expect(page.locator('[data-sales-lead-create]')).toHaveCount(0);
    await expect(page.locator('.sales-db-search input')).toHaveAttribute('placeholder', '업체명');

    await page.locator(`[data-sales-lead-open="${LEAD_ID}"]`).click();
    await expect(page.locator('[data-sales-lead-drawer]')).toContainText('***-****-5678');
    await expect(page.locator('[data-sales-lead-drawer]')).not.toContainText('01012345678');
    await expect(page.locator('[data-sales-lead-call-link], [data-sales-lead-phone-copy]')).toHaveCount(0);
    await expect(page.locator('[data-sales-lead-edit], [data-sales-lead-call], [data-sales-lead-archive]')).toHaveCount(0);
    await page.locator('[data-sales-lead-close]').last().click();

    const listGets = () => fixture.calls.filter(call => call.method === 'GET' && call.path === '/peakos/sales-leads').length;
    const before = listGets();
    await page.locator('.sales-db-search input').fill('01012345678');
    await page.locator('[data-sales-db-filter-form] button[type="submit"]').click();
    await expect(page.locator('.toast')).toContainText('업체명으로만 검색');
    expect(listGets()).toBe(before);
  });

  test('비영업 계정과 계정 미리보기는 내비게이션을 숨기고 sales 요청을 0건으로 유지한다', async ({ page }) => {
    const nonSales: SalesFixture = {
      role: 'member', groupType: 'support', calls: [], leads: [makeLead()], callLogs: {}, owners: [],
    };
    await setup(page, nonSales);
    await expect(page.locator('.nav-item[data-view="sales-db"]')).toBeHidden();
    expect(nonSales.calls).toHaveLength(0);

    const previewPage = await page.context().newPage();
    const preview: SalesFixture = {
      role: 'admin', userName: '패션TV봉이', previewEnabled: true,
      calls: [], leads: [makeLead()], callLogs: {}, owners: [],
    };
    await setup(previewPage, preview);
    await previewPage.locator('#personaSelect').selectOption('김대호');
    await expect(previewPage.locator('.nav-item[data-view="sales-db"]')).toBeHidden();
    expect(preview.calls).toHaveLength(0);
    await previewPage.close();
  });

  test('390px에서 가로 넘침 없이 주요 조작 영역을 44px 이상 유지한다', async ({ page }) => {
    const fixture: SalesFixture = {
      role: 'member', calls: [], leads: [makeLead()], callLogs: {},
      owners: [{ uid: 'e2e-test-user', name: '영업 담당자' }],
    };
    await setup(page, fixture, { width: 390, height: 844 });
    await page.locator('.mobile-menu').click();
    await openSalesDb(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    const heights = await page.locator('.sales-db-button:visible, .sales-db-filters input:visible, .sales-db-filters select:visible, button.sales-lead-row:visible').evaluateAll(nodes => (
      nodes.map(node => Math.round(node.getBoundingClientRect().height))
    ));
    expect(heights.length).toBeGreaterThan(0);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
  });
});
