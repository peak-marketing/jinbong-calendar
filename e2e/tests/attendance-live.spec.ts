import { expect, test, type Page, type Route } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createPeakosStore, handlePeakos, installFirebaseStub } from './helpers';

const ROOT = path.resolve(__dirname, '../..');
const FIXED_NOW = new Date('2026-08-17T00:31:00.000Z'); // 2026-08-17 09:31 KST
const SELF_UID = 'e2e-test-user';

type AttendanceRole = 'admin' | 'manager' | 'member' | 'oversight';
type AttendanceRecord = {
  id: string;
  userUid: string;
  userName: string;
  groupId: string;
  date: string;
  checkIn: string;
  checkOut: string | null;
  workedMinutes: number | null;
  isHoliday: boolean;
  isLate: boolean;
  version: number;
};
type AttendanceCall = {
  method: string;
  path: string;
  month: string;
  scope: string;
  workspace: string;
  preview: string;
};
type Delay = { month: string; gate: Promise<void> };
type AttendanceFixture = {
  role: AttendanceRole;
  userName: string;
  workspaceSlug?: 'peak' | 'daegu';
  previewEnabled?: boolean;
  headquartersOversight?: boolean;
  records: Record<string, AttendanceRecord[]>;
  calls: AttendanceCall[];
  delay?: Delay;
};

function attendanceRecord(overrides: Partial<AttendanceRecord> = {}): AttendanceRecord {
  return {
    id: 'attendance-self-1',
    userUid: SELF_UID,
    userName: '영업 담당자',
    groupId: 'sales-team',
    date: '2026-08-14',
    checkIn: '09:05',
    checkOut: '18:03',
    workedMinutes: 538,
    isHoliday: false,
    isLate: true,
    version: 2,
    ...overrides,
  };
}

function defaultFixture(overrides: Partial<AttendanceFixture> = {}): AttendanceFixture {
  return {
    role: 'member',
    userName: '영업 담당자',
    records: { '2026-08': [attendanceRecord()] },
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

function teamSummary(fixture: AttendanceFixture, records: AttendanceRecord[]) {
  const selfRecords = records.filter(row => row.userUid === SELF_UID);
  const otherRecords = records.filter(row => row.userUid === 'uid-colleague');
  return [
    {
      uid: SELF_UID,
      name: fixture.userName,
      groupId: 'sales-team',
      role: fixture.role,
      presentDays: selfRecords.length,
      lateDays: selfRecords.filter(row => row.isLate).length,
      openDays: selfRecords.filter(row => !row.checkOut).length,
      workedMinutes: selfRecords.reduce((sum, row) => sum + (row.workedMinutes || 0), 0),
    },
    {
      uid: 'uid-colleague',
      name: '동료 영업자',
      groupId: 'sales-team',
      role: 'member',
      presentDays: otherRecords.length,
      lateDays: otherRecords.filter(row => row.isLate).length,
      openDays: otherRecords.filter(row => !row.checkOut).length,
      workedMinutes: otherRecords.reduce((sum, row) => sum + (row.workedMinutes || 0), 0),
    },
  ];
}

async function installApi(page: Page, fixture: AttendanceFixture) {
  const workspaceSlug = fixture.workspaceSlug || 'peak';
  const workspaceId = workspaceSlug === 'peak' ? 'ws_peak' : 'ws_daegu';
  const workspaceName = workspaceSlug === 'peak' ? '피크마케팅 본사' : '피크마케팅 대구지사';
  const store = createPeakosStore(fixture.userName, fixture.role === 'oversight' ? 'admin' : fixture.role);
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
        uid: SELF_UID,
        name: fixture.userName,
        email: 'attendance@test.local',
        role: fixture.role,
        approved: true,
        is_active: true,
        group_id: 'sales-team',
        group_name: '영업팀',
        group_type: fixture.headquartersOversight ? 'support' : 'sales',
        peakos_can_preview_accounts: fixture.previewEnabled === true,
      });
    }
    if (pathname === '/os-auth/session') {
      return send({ required: true, verified: true, expiresInSeconds: 3600 });
    }
    if (pathname === '/os/workspaces') {
      return send({
        default_slug: workspaceSlug,
        workspaces: [{
          id: workspaceId, slug: workspaceSlug, name: workspaceName,
          kind: workspaceSlug === 'peak' ? 'headquarters' : 'branch', role: fixture.role,
        }],
      });
    }
    if (pathname === `/os/workspaces/${workspaceSlug}/context`) {
      return send({
        workspace: {
          id: workspaceId, slug: workspaceSlug, name: workspaceName,
          kind: workspaceSlug === 'peak' ? 'headquarters' : 'branch',
        },
        membership: { role: fixture.role },
        permissions: {
          calendar: 'write', chat: 'write', projects: 'write', settlements: 'write',
          documents: 'read', sales: 'write',
          headquartersOversight: fixture.headquartersOversight === true,
        },
      });
    }
    if (pathname === '/peakos/attendance/month' && method === 'GET') {
      const month = url.searchParams.get('month') || '';
      const scope = url.searchParams.get('scope') || '';
      fixture.calls.push({
        method, path: pathname, month, scope,
        workspace: request.headers()['x-peakos-workspace'] || '',
        preview: request.headers()['x-peakos-preview'] || '',
      });
      if (fixture.delay?.month === month) await fixture.delay.gate;
      const allRecords = fixture.records[month] || [];
      const records = scope === 'self' ? allRecords.filter(row => row.userUid === SELF_UID) : allRecords;
      const team = scope === 'team';
      return send({
        month,
        timeZone: 'Asia/Seoul',
        scope,
        canViewTeam: team,
        readOnly: fixture.role === 'oversight' || fixture.headquartersOversight === true,
        records,
        members: team ? [
          { uid: SELF_UID, name: fixture.userName, groupId: 'sales-team', role: fixture.role },
          { uid: 'uid-colleague', name: '동료 영업자', groupId: 'sales-team', role: 'member' },
        ] : [{ uid: SELF_UID, name: fixture.userName, groupId: 'sales-team', role: fixture.role }],
        summary: team ? teamSummary(fixture, records) : [],
      });
    }
    if (/^\/peakos\/attendance\/(?:check-in|check-out)$/.test(pathname) && method === 'POST') {
      fixture.calls.push({
        method, path: pathname, month: '2026-08', scope: 'self',
        workspace: request.headers()['x-peakos-workspace'] || '',
        preview: request.headers()['x-peakos-preview'] || '',
      });
      const current = fixture.records['2026-08'] ||= [];
      let today = current.find(row => row.userUid === SELF_UID && row.date === '2026-08-17');
      if (pathname.endsWith('/check-in')) {
        const alreadyRecorded = Boolean(today);
        if (!today) {
          today = attendanceRecord({
            id: 'attendance-today', date: '2026-08-17', checkIn: '09:31', checkOut: null,
            workedMinutes: null, isLate: false, version: 1,
          });
          current.push(today);
        }
        return send({ record: today, alreadyRecorded });
      }
      if (!today) return send({ code: 'ATTENDANCE_CHECK_IN_REQUIRED', error: '먼저 출근을 등록해 주세요.' }, 409);
      const alreadyRecorded = Boolean(today.checkOut);
      if (!today.checkOut) Object.assign(today, { checkOut: '18:02', workedMinutes: 511, version: 2 });
      return send({ record: today, alreadyRecorded });
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

async function setup(
  page: Page,
  fixture: AttendanceFixture,
  options: { width?: number; height?: number; dark?: boolean } = {},
) {
  await page.clock.install({ time: FIXED_NOW });
  await page.setViewportSize({ width: options.width || 1440, height: options.height || 900 });
  if (options.dark) {
    await page.addInitScript(() => localStorage.setItem('peakos-color-theme-v1', 'dark'));
  }
  await installFirebaseStub(page);
  await serveOsShell(page);
  await installApi(page, fixture);
  await page.goto(`/os/w/${fixture.workspaceSlug || 'peak'}`);
  await expect(page.locator('#authGate')).toBeHidden();
}

async function openAttendance(page: Page, waitForReady = true) {
  if (await page.locator('.mobile-menu').isVisible()) await page.locator('.mobile-menu').click();
  const cluster = page.locator('[data-nav-cluster="finance"]');
  if ((await cluster.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await cluster.locator(':scope > .nav-cluster-toggle').click();
  }
  await page.locator('.nav-item[data-view="reports"]').click();
  const root = page.locator('.attendance-module');
  await expect(root).toBeVisible();
  if (waitForReady) await expect(root).toHaveAttribute('data-attendance-state', 'ready');
  return root;
}

test('일반 영업자는 본인 KST 기록만 보고 출근·퇴근을 한 번씩 등록한다', async ({ page }) => {
  const fixture = defaultFixture();
  await setup(page, fixture);
  const root = await openAttendance(page);

  await expect(root).toContainText('2026년 8월');
  await expect(root).toContainText('8월 14일');
  await expect(root).not.toContainText('동료 영업자');
  expect(fixture.calls[0]).toMatchObject({
    method: 'GET', month: '2026-08', scope: 'self', workspace: 'peak', preview: '0',
  });

  await root.locator('[data-attendance-action="check-in"]').click();
  await expect(root).toContainText('09:31');
  await expect(root.locator('[data-attendance-action="check-out"]')).toBeVisible();
  await root.locator('[data-attendance-action="check-out"]').click();
  await expect(root).toContainText('18:02');
  await expect(root.locator('[data-attendance-action]')).toHaveCount(0);

  expect(fixture.calls.filter(call => call.path.endsWith('/check-in'))).toHaveLength(1);
  expect(fixture.calls.filter(call => call.path.endsWith('/check-out'))).toHaveLength(1);
  expect(fixture.calls.filter(call => call.method === 'POST').every(call => (
    call.workspace === 'peak' && call.preview === '0'
  ))).toBeTruthy();
});

test('지사 보고서에는 이관되지 않은 매출 버킷 없이 근태만 노출한다', async ({ page }) => {
  const fixture = defaultFixture({ role: 'manager', workspaceSlug: 'daegu' });
  await setup(page, fixture);
  await openAttendance(page);
  await expect(page.locator('[data-report-type="attendance"]')).toBeVisible();
  await expect(page.locator('[data-report-type="daily"], [data-report-type="weekly"], [data-report-type="monthly"], [data-report-type="quarterly"]')).toHaveCount(0);
  await expect(page.locator('.module-security')).toContainText('지사 매출 보고서는 워크스페이스 이관 전까지 노출하지 않습니다');
  expect(fixture.calls.every(call => call.path === '/peakos/attendance/month')).toBe(true);
  expect(fixture.calls.every(call => call.workspace === 'daegu')).toBe(true);
});

test('관리자는 같은 워크스페이스 팀 요약을 보며 oversight는 읽기 전용이다', async ({ page }) => {
  const fixture = defaultFixture({
    role: 'manager',
    userName: '영업 팀장',
    records: {
      '2026-08': [
        attendanceRecord(),
        attendanceRecord({
          id: 'attendance-colleague', userUid: 'uid-colleague', userName: '동료 영업자',
          date: '2026-08-17', checkIn: '08:58', checkOut: null, workedMinutes: null, isLate: false, version: 1,
        }),
      ],
    },
  });
  await setup(page, fixture);
  const root = await openAttendance(page);
  await expect(root).toContainText('워크스페이스 근태 요약');
  await expect(root).toContainText('동료 영업자');
  await expect(root).toContainText('근무 중');
  expect(fixture.calls[0]).toMatchObject({ scope: 'team', workspace: 'peak', preview: '0' });

  const oversightPage = await page.context().newPage();
  const oversight = defaultFixture({
    role: 'oversight', headquartersOversight: true, userName: '본사 열람자',
    records: fixture.records, calls: [],
  });
  await setup(oversightPage, oversight);
  const oversightRoot = await openAttendance(oversightPage);
  await expect(oversightRoot.locator('.attendance-scope')).toContainText('읽기 전용');
  await expect(oversightRoot.locator('[data-attendance-action]')).toHaveCount(0);
  expect(oversight.calls.filter(call => call.method === 'POST')).toHaveLength(0);
  await oversightPage.close();
});

test('계정 미리보기는 근태·보고매출 GET과 mutation을 모두 0건으로 유지한다', async ({ page }) => {
  const fixture = defaultFixture({ role: 'admin', previewEnabled: true, userName: '패션TV봉이' });
  const salesSummaryRequests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/peakos/reports/sales-summary') {
      salesSummaryRequests.push(request.url());
    }
  });
  await setup(page, fixture);
  await page.locator('#personaSelect').selectOption('김대호');
  const root = await openAttendance(page, false);
  await expect(root).toHaveAttribute('data-attendance-state', 'private');
  await expect(root).toContainText('계정 미리보기에서는 근태 자료를 요청하지 않습니다');
  expect(fixture.calls.filter(call => call.path.startsWith('/peakos/attendance'))).toHaveLength(0);
  await page.locator('[data-report-type="weekly"]').click();
  await expect(page.locator('[data-report-preview-private]')).toContainText('보고 매출을 불러오지 않습니다');
  expect(salesSummaryRequests).toHaveLength(0);
});

test('늦게 도착한 이전 월 응답을 버리고 390px 다크 화면의 조작 영역을 44px 이상 유지한다', async ({ page }) => {
  let releaseAugust!: () => void;
  const augustGate = new Promise<void>(resolve => { releaseAugust = resolve; });
  const fixture = defaultFixture({
    records: {
      '2026-08': [attendanceRecord({ userName: '오래된 8월 응답' })],
      '2026-07': [attendanceRecord({
        id: 'attendance-july', date: '2026-07-11', userName: '영업 담당자', checkIn: '08:44', isLate: false,
      })],
    },
    delay: { month: '2026-08', gate: augustGate },
  });
  await setup(page, fixture, { width: 390, height: 844, dark: true });
  const root = await openAttendance(page, false);
  await expect.poll(() => fixture.calls.some(call => call.month === '2026-08')).toBeTruthy();
  await root.locator('[data-attendance-month="-1"]').click();
  await expect(root).toHaveAttribute('data-attendance-state', 'ready');
  await expect(root).toContainText('2026년 7월');
  await expect(root).toContainText('08:44');
  releaseAugust();
  await page.waitForTimeout(50);
  await expect(root).toContainText('2026년 7월');
  await expect(root).not.toContainText('09:05');

  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  const heights = await root.locator('button:visible').evaluateAll(nodes => (
    nodes.map(node => Math.round(node.getBoundingClientRect().height))
  ));
  expect(heights.length).toBeGreaterThan(0);
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
