import { test, expect, type Page, type Route } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createPeakosStore, handlePeakos, installFirebaseStub } from './helpers';

const ROOT = path.resolve(__dirname, '../..');
const OS_HTML = fs.readFileSync(path.join(ROOT, 'business-os-preview.html'));
const OS_JS = fs.readFileSync(path.join(ROOT, 'business-os-preview.js'));
const OS_CSS = fs.readFileSync(path.join(ROOT, 'business-os-live.css'));

type OsAuthOptions = {
  required: boolean;
  verified?: boolean;
  sessionRequiresAuthWith401?: boolean;
  expirePeakosOnLoad?: boolean;
};

type OsAuthCall = {
  method: string;
  path: string;
  body: any;
  authorization: string;
  tabId: string;
};

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type HeldSession = {
  tabId: string;
  used: boolean;
  started: Deferred;
  release: Deferred;
};

type OsAuthSharedState = {
  verified: boolean;
  sessionInvalidated: boolean;
  peakosExpirySent: boolean;
  calls: OsAuthCall[];
  heldSession: HeldSession | null;
};

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function createOsAuthSharedState(options: OsAuthOptions): OsAuthSharedState {
  return {
    verified: options.verified === true,
    sessionInvalidated: false,
    peakosExpirySent: false,
    calls: [],
    heldSession: null,
  };
}

function holdNextSession(state: OsAuthSharedState, tabId: string) {
  const hold: HeldSession = {
    tabId,
    used: false,
    started: deferred(),
    release: deferred(),
  };
  state.heldSession = hold;
  return {
    started: hold.started.promise,
    release: hold.release.resolve,
  };
}

async function serveOsRoutes(page: Page) {
  await page.route('**/os/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/os/' || pathname === '/os/login' || pathname === '/os/login/') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: OS_HTML });
    }
    if (pathname === '/os/business-os-preview.js') {
      return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: OS_JS });
    }
    if (pathname === '/os/business-os-live.css') {
      return route.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body: OS_CSS });
    }
    return route.continue();
  });
}

async function installOsApi(
  page: Page,
  options: OsAuthOptions,
  state = createOsAuthSharedState(options),
  tabId = 'page',
) {
  const calls = state.calls;
  const peakos = createPeakosStore('김대호', 'manager');

  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname.replace(/^\/api/, '');
    let body: any = null;
    try { body = request.postDataJSON(); } catch { body = null; }
    calls.push({
      method: request.method(),
      path: pathname,
      body,
      authorization: request.headers().authorization || '',
      tabId,
    });

    if (options.expirePeakosOnLoad && pathname === '/peakos/intake' && !state.peakosExpirySent) {
      state.peakosExpirySent = true;
      state.sessionInvalidated = true;
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: '추가 인증 세션이 만료되었습니다.',
          code: 'OS_AUTH_SESSION_INVALID',
          required: true,
          verified: false,
        }),
      });
    }

    if (pathname.startsWith('/peakos/') && options.required && (!state.verified || state.sessionInvalidated)) {
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: state.sessionInvalidated ? '추가 인증 세션이 만료되었습니다.' : '추가 인증이 필요합니다.',
          code: state.sessionInvalidated ? 'OS_AUTH_SESSION_INVALID' : 'OS_AUTH_SESSION_REQUIRED',
          required: true,
          verified: false,
        }),
      });
    }

    if (handlePeakos(peakos, route)) return;
    const send = (payload: unknown, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });

    if (pathname === '/users/me') return send({
      uid: 'e2e-test-user',
      name: '김대호',
      email: 'kimdaeho@paragon-info.kr',
      role: 'manager',
      approved: true,
      is_active: true,
      group_name: '본사 영업팀',
      group_type: 'sales',
      peakos_special_settlement_views: ['direct-execution'],
    });
    if (pathname === '/os-auth/session') {
      const verifiedAtRequest = state.verified;
      const invalidatedAtRequest = state.sessionInvalidated;
      const hold = state.heldSession;
      if (hold && !hold.used && hold.tabId === tabId) {
        hold.used = true;
        hold.started.resolve();
        await hold.release.promise;
      }
      if (invalidatedAtRequest) {
        return send({
          error: 'PEAK OS 추가 인증 세션이 만료되었습니다.',
          code: 'OS_AUTH_SESSION_INVALID',
          required: true,
          verified: false,
        }, 401);
      }
      if (options.sessionRequiresAuthWith401 && options.required && !verifiedAtRequest) {
        return send({
          error: 'PEAK OS 추가 인증이 필요합니다.',
          code: 'OS_AUTH_SESSION_REQUIRED',
          required: true,
          verified: false,
        }, 401);
      }
      return send({ required: options.required, verified: verifiedAtRequest });
    }
    if (pathname === '/os-auth/email/request' && request.method() === 'POST') return send({
      ok: true,
      maskedEmail: 'kim***@paragon-info.kr',
      challengeId: 'challenge-e2e-1',
      expiresInSeconds: 300,
      retryAfterSeconds: 60,
    });
    if (pathname === '/os-auth/email/verify' && request.method() === 'POST') {
      if (body?.challengeId !== 'challenge-e2e-1' || body?.code !== '123456') {
        return send({ error: '인증번호가 올바르지 않습니다.' }, 401);
      }
      state.verified = true;
      return send({ ok: true, verified: true });
    }
    if (pathname === '/os-auth/logout' && request.method() === 'POST') return send({ ok: true });
    if (pathname === '/events') return send([]);
    if (pathname === '/events/checklist-summary') return send({});
    if (pathname === '/chat-rooms') return send([]);
    if (pathname === '/chat-rooms/unread') return send({});
    if (pathname === '/projects') return send({ canManageAll: false, projects: [] });
    if (pathname === '/ideas') return send([]);
    if (pathname === '/service-requests') return send({ canManage: false, requests: [] });
    return send([]);
  });

  return calls;
}

async function setup(
  page: Page,
  options: OsAuthOptions,
  state = createOsAuthSharedState(options),
  tabId = 'page',
) {
  await installFirebaseStub(page);
  await serveOsRoutes(page);
  return installOsApi(page, options, state, tabId);
}

async function installDocumentLoadCounter(page: Page, key: string) {
  await page.addInitScript(counterKey => {
    const count = Number(sessionStorage.getItem(counterKey) || 0) + 1;
    sessionStorage.setItem(counterKey, String(count));
  }, key);
}

async function completeEmailOtp(page: Page) {
  await page.getByRole('button', { name: '등록 이메일로 인증번호 받기' }).click();
  await expect(page.locator('.os-auth-otp')).toHaveCount(6);
  for (const [index, digit] of [...'123456'].entries()) {
    await page.locator('.os-auth-otp').nth(index).fill(digit);
  }
  const verifyButton = page.getByRole('button', { name: /PEAK OS 들어가기/ });
  await expect(verifyButton).toBeEnabled();
  await verifyButton.click();
}

test.describe('PEAK OS 이메일 2차 인증', () => {
  test('Google 세션 확인 후 /os/login에서 이메일 OTP로 입장한다', async ({ page }) => {
    const calls = await setup(page, { required: true, sessionRequiresAuthWith401: true });

    await page.goto('/os/');

    await expect(page).toHaveURL(/\/os\/login\?next=%2Fos%2F$/);
    await expect(page.locator('.os-auth-shell > *')).toHaveCount(2);
    await expect(page.locator('.os-auth-progress')).toBeVisible();
    await expect(page.locator('.os-auth-card')).toBeVisible();
    await expect(page.locator('.os-auth-step').nth(0)).toHaveClass(/done/);
    await expect(page.locator('.os-auth-step').nth(1)).toHaveClass(/active/);
    await expect(page.locator('.os-auth-identity')).toContainText('김대호 부장');
    await expect(page.locator('.os-auth-identity')).toContainText('본사');
    await expect(page.locator('.os-auth-identity')).toContainText('kim***@paragon-info.kr');
    await expect(page.locator('.os-auth-message')).toHaveText('');
    await expect(page.getByRole('button', { name: '등록 이메일로 인증번호 받기' })).toBeVisible();
    expect(calls.some(call => call.path === '/events')).toBe(false);

    await page.getByRole('button', { name: '등록 이메일로 인증번호 받기' }).click();

    await expect(page.locator('.os-auth-otp')).toHaveCount(6);
    await expect(page.locator('#emailOtpResend')).toContainText('재전송 01:00');
    const requestCall = calls.find(call => call.path === '/os-auth/email/request');
    expect(requestCall).toMatchObject({ method: 'POST', body: {} });
    expect(requestCall?.authorization).toBe('Bearer e2e-token');

    for (const [index, digit] of [...'123456'].entries()) {
      await page.locator('.os-auth-otp').nth(index).fill(digit);
    }
    const verifyButton = page.getByRole('button', { name: /PEAK OS 들어가기/ });
    await expect(verifyButton).toBeEnabled();
    await verifyButton.click();

    await expect(page).toHaveURL(/\/os\/$/);
    await expect(page.locator('#authGate')).toBeHidden();
    const verifyCall = calls.find(call => call.path === '/os-auth/email/verify');
    expect(verifyCall).toMatchObject({
      method: 'POST',
      body: { code: '123456', challengeId: 'challenge-e2e-1' },
    });
    expect(calls.some(call => call.path === '/events')).toBe(true);
  });

  test('다른 Google 계정 전환은 로그아웃 뒤 직접 클릭으로 계정 선택창을 연다', async ({ page }) => {
    const calls = await setup(page, { required: true, sessionRequiresAuthWith401: true });
    await page.goto('/os/');
    await expect(page.getByRole('button', { name: '다른 Google 계정으로 로그인' })).toBeVisible();

    await page.getByRole('button', { name: '다른 Google 계정으로 로그인' }).click();

    await expect.poll(() => calls.filter(call => call.path === '/os-auth/logout').length).toBe(1);
    const chooser = page.getByRole('button', { name: '다른 Google 계정 선택하기' });
    await expect(chooser).toBeVisible();
    await expect(chooser).toBeEnabled();
    await expect(page.locator('#authStatus')).toContainText('Google 계정 선택창');
    expect(await page.evaluate(() => (window as any).__e2eAuthTrace.signOutCalls)).toBe(1);
    expect(await page.evaluate(() => (window as any).__e2eAuthTrace.popupCalls)).toBe(0);

    await chooser.click();

    await expect.poll(() => page.evaluate(() => (window as any).__e2eAuthTrace.popupCalls)).toBe(1);
    const trace = await page.evaluate(() => (window as any).__e2eAuthTrace);
    expect(trace.redirectCalls).toBe(0);
    expect(trace.providerParameters.at(-1)).toEqual({ prompt: 'select_account' });
    await expect(page.getByRole('button', { name: '다른 Google 계정으로 로그인' })).toBeVisible();
  });

  test('한 탭에서 이메일 인증을 마치면 이미 열린 다른 탭도 새로고침 없이 입장한다', async ({ context, page: tabA }) => {
    const options: OsAuthOptions = { required: true, sessionRequiresAuthWith401: true };
    const state = createOsAuthSharedState(options);
    const tabB = await context.newPage();
    const loadKey = 'e2e-os-multitab-document-loads';
    await installDocumentLoadCounter(tabB, loadKey);
    await Promise.all([
      setup(tabA, options, state, 'tab-a'),
      setup(tabB, options, state, 'tab-b'),
    ]);

    await Promise.all([tabA.goto('/os/'), tabB.goto('/os/')]);
    await expect(tabA.getByRole('button', { name: '등록 이메일로 인증번호 받기' })).toBeVisible();
    await expect(tabB.getByRole('button', { name: '등록 이메일로 인증번호 받기' })).toBeVisible();
    expect(await tabB.evaluate(key => Number(sessionStorage.getItem(key) || 0), loadKey)).toBe(1);

    await completeEmailOtp(tabA);

    await expect(tabA.locator('#authGate')).toBeHidden();
    await expect(tabB.locator('#authGate')).toBeHidden();
    await expect(tabB).toHaveURL(/\/os\/$/);
    expect(await tabB.evaluate(key => Number(sessionStorage.getItem(key) || 0), loadKey)).toBe(1);
    expect(state.calls.filter(call => call.tabId === 'tab-b' && call.path === '/os-auth/session').length)
      .toBeGreaterThanOrEqual(2);
  });

  test('다른 탭의 오래된 세션 응답이 인증 후 도착해도 강제 후속 조회로 입장한다', async ({ context, page: tabA }) => {
    const options: OsAuthOptions = { required: true, sessionRequiresAuthWith401: true };
    const state = createOsAuthSharedState(options);
    const tabB = await context.newPage();
    const loadKey = 'e2e-os-stale-session-document-loads';
    await installDocumentLoadCounter(tabB, loadKey);
    await Promise.all([
      setup(tabA, options, state, 'tab-a'),
      setup(tabB, options, state, 'tab-b'),
    ]);

    await Promise.all([tabA.goto('/os/'), tabB.goto('/os/')]);
    await expect(tabA.getByRole('button', { name: '등록 이메일로 인증번호 받기' })).toBeVisible();
    await expect(tabB.getByRole('button', { name: '등록 이메일로 인증번호 받기' })).toBeVisible();

    await tabA.bringToFront();
    const held = holdNextSession(state, 'tab-b');
    await tabB.evaluate(() => window.dispatchEvent(new Event('focus')));
    await held.started;

    try {
      await completeEmailOtp(tabA);
      await expect(tabA.locator('#authGate')).toBeHidden();
    } finally {
      held.release();
    }

    await expect(tabB.locator('#authGate')).toBeHidden();
    await expect(tabB).toHaveURL(/\/os\/$/);
    expect(await tabB.evaluate(key => Number(sessionStorage.getItem(key) || 0), loadKey)).toBe(1);
    expect(state.calls.filter(call => call.tabId === 'tab-b' && call.path === '/os-auth/session').length)
      .toBeGreaterThanOrEqual(3);
  });

  test('탭 인증 완료 신호만 위조해도 서버 세션이 없으면 절대 입장하지 않는다', async ({ page }) => {
    const options: OsAuthOptions = { required: true, sessionRequiresAuthWith401: true };
    const state = createOsAuthSharedState(options);
    await setup(page, options, state, 'tab-forged');
    await page.goto('/os/');
    await expect(page.getByRole('button', { name: '등록 이메일로 인증번호 받기' })).toBeVisible();
    const sessionCallsBefore = state.calls.filter(call => call.path === '/os-auth/session').length;

    await page.evaluate(async () => {
      const channel = new BroadcastChannel('peakos-os-auth-sync-v1');
      channel.postMessage({
        type: 'verified',
        source: 'forged-tab',
        id: `forged-${Date.now()}`,
        at: Date.now(),
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      channel.close();
    });

    await expect.poll(() => state.calls.filter(call => call.path === '/os-auth/session').length)
      .toBeGreaterThan(sessionCallsBefore);
    await expect(page.locator('#authGate')).toBeVisible();
    await expect(page).toHaveURL(/\/os\/login/);
    expect(state.calls.some(call => call.path.startsWith('/peakos/'))).toBe(false);
  });

  test('required=false 계정은 기존처럼 바로 OS에 입장한다', async ({ page }) => {
    const calls = await setup(page, { required: false });

    await page.goto('/os/');

    await expect(page.locator('#authGate')).toBeHidden();
    await expect(page).toHaveURL(/\/os\/$/);
    expect(calls.some(call => call.path === '/os-auth/email/request')).toBe(false);
    expect(calls.some(call => call.path === '/events')).toBe(true);
  });

  test('이미 인증한 계정은 /os/login을 다시 열어도 안전한 next로 이동한다', async ({ page }) => {
    await setup(page, { required: true, verified: true });

    await page.goto('/os/login?next=https%3A%2F%2Fevil.example%2F');

    await expect(page.locator('#authGate')).toBeHidden();
    await expect(page).toHaveURL(/\/os\/$/);
  });

  test('OS 사용 중 /peakos API가 세션 만료를 알리면 재인증 화면으로 잠긴다', async ({ page }) => {
    await page.addInitScript(() => {
      const key = 'e2e-os-document-loads';
      const count = Number(sessionStorage.getItem(key) || 0) + 1;
      sessionStorage.setItem(key, String(count));
      (window as any).__e2eOsDocumentLoad = count;
    });
    await setup(page, { required: true, verified: true, expirePeakosOnLoad: true });

    await page.goto('/os/');

    await expect(page).toHaveURL(/\/os\/login\?next=%2Fos%2F&reason=session-expired$/);
    await expect(page.locator('#authGate')).toBeVisible();
    await expect(page.getByRole('button', { name: '등록 이메일로 인증번호 받기' })).toBeVisible();
    await expect(page.locator('.os-auth-message')).toContainText('인증 시간이 만료');
    expect(await page.evaluate(() => (window as any).__e2eOsDocumentLoad)).toBeGreaterThanOrEqual(2);
  });

  test('모바일에서도 진행 단계와 인증 카드만 한 열로 보인다', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page, { required: true });

    await page.goto('/os/login');

    await expect(page.locator('.os-auth-shell > *')).toHaveCount(2);
    const progress = await page.locator('.os-auth-progress').boundingBox();
    const card = await page.locator('.os-auth-card').boundingBox();
    expect(progress).not.toBeNull();
    expect(card).not.toBeNull();
    expect(progress!.x).toBeGreaterThanOrEqual(0);
    expect(card!.x).toBeGreaterThanOrEqual(0);
    expect(card!.x + card!.width).toBeLessThanOrEqual(390);
    expect(card!.y).toBeGreaterThan(progress!.y);
  });
});
