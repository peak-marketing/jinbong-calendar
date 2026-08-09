import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const DOCUMENTS = [
  { id: 'head-office', branch: '본사', filename: '본사 사업자등록증.png' },
  { id: 'jeonju-office', branch: '전주 지사', filename: '전주 지사 사업자등록증.png' },
  { id: 'daegu-office', branch: '대구 지사', filename: '대구 지사 사업자등록증.png' },
];

async function installCompanyUser(page: Parameters<typeof installFirebaseStub>[0]) {
  await installFirebaseStub(page);
  await installPeakosStub(page, {
    name: '김대호',
    uid: 'e2e-test-user',
    role: 'manager',
    group_name: '본사 경영지원팀',
  });
}

test('보호된 본사·지사 원본을 미리 보고 각각 저장한다', async ({ page }) => {
  await installCompanyUser(page);
  const requests: { path: string; authorization: string }[] = [];
  await page.addInitScript(() => {
    const original = URL.revokeObjectURL.bind(URL);
    (window as any).__company_revoked_urls = [];
    URL.revokeObjectURL = (url: string) => {
      (window as any).__company_revoked_urls.push(url);
      original(url);
    };
  });
  await page.route('**/api/peakos/company-documents**', route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    requests.push({ path: pathname, authorization: request.headers().authorization || '' });
    if (pathname.endsWith('/company-documents')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'private, no-store' },
        body: JSON.stringify({
          documents: DOCUMENTS.map(document => ({
            ...document,
            folder: 'branches',
            mimeType: 'image/png',
            width: 1,
            height: 1,
            size: PNG.length,
            updatedAt: '2026-08-09T00:00:00.000Z',
            available: true,
          })),
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'attachment; filename="protected.png"',
      },
      body: PNG,
    });
  });

  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  await page.locator('.nav-item[data-view="company"]').click();

  await expect(page.locator('[data-company-certificate-folders] [data-company-folder]')).toHaveCount(2);
  await expect(page.locator('[data-company-folder="branches"]')).toContainText('본사 및 지사 사업자등록증');
  await expect(page.locator('[data-company-folder="branches"]')).toContainText('3/3 연결');
  await expect(page.locator('[data-company-folder="clients"]')).toContainText('거래처 사업자등록증');

  const certificates = page.locator('[data-company-folder-content="branches"] [data-company-certificate]');
  await expect(certificates).toHaveCount(3);
  await expect(certificates.nth(0)).toContainText('본사 사업자등록증.png');
  await expect(certificates.nth(1)).toContainText('전주 지사 사업자등록증.png');
  await expect(certificates.nth(2)).toContainText('대구 지사 사업자등록증.png');
  await expect(certificates).toContainText(['보호 연결 완료', '보호 연결 완료', '보호 연결 완료']);
  await expect(certificates.nth(0).locator('[data-company-document-preview]'))
    .toHaveAttribute('aria-label', '본사 사업자등록증 미리보기');
  await expect(certificates.nth(0).locator('[data-company-document-download]'))
    .toHaveAttribute('aria-label', '본사 사업자등록증 PNG 저장');
  expect(requests.filter(request => request.path.endsWith('/content'))).toHaveLength(0);

  const headOfficePreview = certificates.nth(0).locator('[data-company-document-preview]');
  await headOfficePreview.click();
  const preview = page.locator('[data-company-document-image="head-office"]');
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
  const previewUrl = await preview.getAttribute('src');
  expect(previewUrl).toMatch(/^blob:/);
  await expect.poll(() => page.evaluate(() => (window as any).__company_revoked_urls)).toContain(previewUrl);
  await page.locator('#readonlyModalClose').click();
  await expect(page.locator('[data-company-document-image]')).toHaveCount(0);
  await expect(headOfficePreview).toBeFocused();

  const downloadEvent = page.waitForEvent('download');
  await certificates.nth(1).locator('[data-company-document-download]').click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('전주 지사 사업자등록증.png');
  const stream = await download.createReadStream();
  if (!stream) throw new Error('사업자등록증 다운로드 스트림이 없습니다.');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect([...Buffer.concat(chunks).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  await expect.poll(() => page.evaluate(() => (window as any).__company_revoked_urls.length)).toBeGreaterThanOrEqual(2);

  expect(requests).not.toHaveLength(0);
  expect(requests.every(request => request.authorization === 'Bearer e2e-token')).toBe(true);
  await expect(page.locator('[data-company-folder-content="clients"]')).toContainText('등록된 거래처 사업자등록증이 없습니다');

  await page.setViewportSize({ width: 390, height: 844 });
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
});

test('보호 저장소 권한 오류에는 원본 버튼을 열지 않는다', async ({ page }) => {
  await installCompanyUser(page);
  const authorization: string[] = [];
  await page.route('**/api/peakos/company-documents**', route => {
    authorization.push(route.request().headers().authorization || '');
    return route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        error: '사업자등록증은 추가 이메일 인증이 활성화된 계정만 볼 수 있습니다.',
        code: 'COMPANY_DOCUMENT_SECOND_AUTH_REQUIRED',
      }),
    });
  });

  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  await page.locator('.nav-item[data-view="company"]').click();

  await expect(page.locator('[data-company-folder-content="branches"]')).toContainText('보호 자료를 불러오지 못했습니다');
  await expect(page.locator('[data-company-folder-content="branches"]')).toContainText('추가 이메일 인증');
  await expect(page.locator('[data-company-document-refresh]')).toBeVisible();
  await expect(page.locator('[data-company-document-preview]:enabled')).toHaveCount(0);
  await expect(page.locator('[data-company-document-download]:enabled')).toHaveCount(0);
  expect(authorization).toEqual(['Bearer e2e-token']);
});

test('원본 점검 상태에서 보호 목록을 다시 확인한다', async ({ page }) => {
  await installCompanyUser(page);
  let listCalls = 0;
  await page.route('**/api/peakos/company-documents**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/company-documents')) {
      listCalls += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          documents: DOCUMENTS.map(document => ({
            ...document,
            folder: 'branches',
            mimeType: 'image/png',
            size: listCalls > 1 ? PNG.length : 0,
            updatedAt: '2026-08-09T00:00:00.000Z',
            available: listCalls > 1,
          })),
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });

  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  await page.locator('.nav-item[data-view="company"]').click();

  await expect(page.locator('[data-company-folder="branches"]')).toContainText('0/3 연결');
  await expect(page.locator('[data-company-document-refresh]')).toBeVisible();
  await expect(page.locator('[data-company-document-preview]:enabled')).toHaveCount(0);

  await page.locator('[data-company-document-refresh]').click();
  await expect(page.locator('[data-company-folder="branches"]')).toContainText('3/3 연결');
  await expect(page.locator('[data-company-document-preview]:enabled')).toHaveCount(3);
  await expect(page.locator('[data-company-document-download]:enabled')).toHaveCount(3);
  expect(listCalls).toBe(2);
});

test('미리보기의 지연 응답이 다른 모달을 덮어쓰지 않는다', async ({ page }) => {
  await installCompanyUser(page);
  let releaseContent: () => void = () => {};
  let markContentFulfilled: () => void = () => {};
  const contentGate = new Promise<void>(resolve => { releaseContent = resolve; });
  const contentFulfilled = new Promise<void>(resolve => { markContentFulfilled = resolve; });
  await page.route('**/api/peakos/company-documents**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/company-documents')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          documents: DOCUMENTS.map(document => ({
            ...document, folder: 'branches', mimeType: 'image/png', size: PNG.length, available: true,
          })),
        }),
      });
    }
    await contentGate;
    await route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    markContentFulfilled();
  });

  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  await page.locator('.nav-item[data-view="company"]').click();
  await page.locator('[data-company-document-preview="head-office"]').click();
  await expect(page.locator('#readonlyModalBody')).toContainText('보호 원본을 확인하고 있습니다');

  await page.evaluate(() => {
    (document.querySelector('.nav-item[data-view="services"]') as HTMLButtonElement).click();
    (document.querySelector('[data-service-add]') as HTMLButtonElement).click();
  });
  await expect(page.locator('#serviceDraftForm')).toBeVisible();
  releaseContent();
  await contentFulfilled;

  await expect(page.locator('#serviceDraftForm')).toBeVisible();
  await expect(page.locator('#readonlyModalTitle')).toHaveText('상품 등록 · 로컬 시안');
  await expect(page.locator('[data-company-document-image]')).toHaveCount(0);
});

test('로그아웃하면 열려 있던 보호 원본을 DOM에서 제거한다', async ({ page }) => {
  await installCompanyUser(page);
  await page.route('**/api/peakos/company-documents**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/company-documents')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          documents: DOCUMENTS.map(document => ({
            ...document, folder: 'branches', mimeType: 'image/png', size: PNG.length, available: true,
          })),
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });

  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  await page.locator('.nav-item[data-view="company"]').click();
  await page.locator('[data-company-document-preview="head-office"]').click();
  await expect(page.locator('[data-company-document-image="head-office"]')).toBeVisible();

  await page.evaluate(() => (window as any).firebase.auth().signOut());

  await expect(page.locator('#authGate')).toBeVisible();
  await expect(page.locator('#readonlyDetailModal')).toBeHidden();
  await expect(page.locator('[data-company-document-image]')).toHaveCount(0);
});
