import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
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

async function openCompanyView(page: Parameters<typeof installFirebaseStub>[0]) {
  const cluster = page.locator('[data-nav-cluster="company"]');
  if ((await cluster.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await cluster.locator(':scope > .nav-cluster-toggle').click();
  }
  await cluster.locator('.nav-item[data-view="company"]').click();
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
  await openCompanyView(page);

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
  expect(requests.filter(request => request.path.endsWith('/company-documents'))).toHaveLength(1);
  await expect(page.locator('[data-company-folder="clients"]')).toContainText('선택 후 조회');
  await expect(page.locator('[data-company-folder-content="clients"]')).toHaveCount(0);

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
  await openCompanyView(page);

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
  await openCompanyView(page);

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
  await openCompanyView(page);
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
  await openCompanyView(page);
  await page.locator('[data-company-document-preview="head-office"]').click();
  await expect(page.locator('[data-company-document-image="head-office"]')).toBeVisible();

  await page.evaluate(() => (window as any).firebase.auth().signOut());

  await expect(page.locator('#authGate')).toBeVisible();
  await expect(page.locator('#readonlyDetailModal')).toBeHidden();
  await expect(page.locator('[data-company-document-image]')).toHaveCount(0);
});

test('거래처 폴더를 지연 조회하고 이미지 미리보기와 PDF 다운로드를 분리한다', async ({ page }) => {
  await installCompanyUser(page);
  const longClientName = '<img src=x onerror=alert(1)> 매우 긴 거래처 이름 '.repeat(8);
  const listRequests: Array<{ folder: string; q: string; page: string; limit: string; authorization: string }> = [];
  const contentRequests: Array<{ id: string; authorization: string }> = [];
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
    const url = new URL(request.url());
    if (url.pathname.endsWith('/company-documents')) {
      listRequests.push({
        folder: url.searchParams.get('folder') || 'branches',
        q: url.searchParams.get('q') || '',
        page: url.searchParams.get('page') || '',
        limit: url.searchParams.get('limit') || '',
        authorization: request.headers().authorization || '',
      });
      if (url.searchParams.get('folder') === 'clients') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            documents: [
              {
                id: 'client-png', clientName: '피크 협력사', filename: '피크 협력사 사업자등록증.png',
                mimeType: 'image/png', size: PNG.length, updatedAt: '2026-08-08T00:00:00.000Z',
                available: true, canPreview: true,
              },
              {
                id: 'client-jpeg', clientName: longClientName, filename: '촬영본 사업자등록증.jpeg',
                mimeType: 'image/jpeg', size: JPEG.length, updatedAt: '2026-08-07T00:00:00.000Z',
                available: true, canPreview: true,
              },
              {
                id: 'client-pdf', clientName: 'PDF 거래처', filename: '정산/등록증.pdf',
                mimeType: 'application/pdf', size: PDF.length, updatedAt: '2026-08-06T00:00:00.000Z',
                available: true, canPreview: true,
              },
            ],
            pagination: { page: 1, limit: 25, total: 3, totalPages: 1 },
          }),
        });
      }
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
    const id = decodeURIComponent(url.pathname.split('/').at(-2) || '');
    contentRequests.push({ id, authorization: request.headers().authorization || '' });
    const content = id === 'client-jpeg' ? JPEG : id === 'client-pdf' ? PDF : PNG;
    const contentType = id === 'client-jpeg' ? 'image/jpeg' : id === 'client-pdf' ? 'application/pdf' : 'image/png';
    return route.fulfill({
      status: 200,
      contentType,
      headers: { 'Cache-Control': 'private, no-store', 'Content-Disposition': 'attachment' },
      body: content,
    });
  });

  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  await openCompanyView(page);
  await expect(page.locator('[data-company-folder="branches"]')).toContainText('3/3 연결');
  expect(listRequests.map(request => request.folder)).toEqual(['branches']);

  const clientsFolder = page.locator('[data-company-folder="clients"]');
  await expect(clientsFolder).toHaveAttribute('role', 'button');
  await expect(clientsFolder).toHaveAttribute('aria-pressed', 'false');
  await clientsFolder.focus();
  await clientsFolder.press('Enter');

  await expect(page.locator('[data-company-folder="clients"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-company-folder-content="branches"]')).toHaveCount(0);
  const clientRows = page.locator('[data-company-client-document]');
  await expect(clientRows).toHaveCount(3);
  expect(listRequests.at(-1)).toMatchObject({ folder: 'clients', q: '', page: '1', limit: '25', authorization: 'Bearer e2e-token' });
  await expect(page.locator('[data-company-client-document="client-jpeg"]')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('[data-company-client-document="client-jpeg"] img')).toHaveCount(0);

  const jpegPreviewButton = page.locator('[data-company-client-document="client-jpeg"] [data-company-document-preview]');
  await expect(jpegPreviewButton).toHaveAttribute('aria-label', /촬영본 사업자등록증\.jpeg 미리보기$/);
  await jpegPreviewButton.click();
  const jpegPreview = page.locator('[data-company-document-image="client-jpeg"]');
  await expect(jpegPreview).toBeVisible();
  await expect.poll(() => jpegPreview.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
  const jpegUrl = await jpegPreview.getAttribute('src');
  expect(jpegUrl).toMatch(/^blob:/);
  await expect.poll(() => page.evaluate(() => (window as any).__company_revoked_urls)).toContain(jpegUrl);
  await page.locator('#readonlyModalClose').click();
  await expect(jpegPreviewButton).toBeFocused();

  const pdfRow = page.locator('[data-company-client-document="client-pdf"]');
  await expect(pdfRow).toContainText('정산/등록증.pdf');
  await expect(pdfRow.locator('[data-company-document-preview]')).toHaveCount(0);
  await expect(pdfRow.locator('[data-company-document-download-only]')).toContainText('PDF · 다운로드만');
  expect(contentRequests.map(request => request.id)).toEqual(['client-jpeg']);
  const downloadEvent = page.waitForEvent('download');
  await pdfRow.locator('[data-company-document-download]').click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('정산_등록증.pdf');
  const stream = await download.createReadStream();
  if (!stream) throw new Error('PDF 사업자등록증 다운로드 스트림이 없습니다.');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).subarray(0, 5).toString()).toBe('%PDF-');
  expect(contentRequests.at(-1)).toEqual({ id: 'client-pdf', authorization: 'Bearer e2e-token' });

  await page.setViewportSize({ width: 390, height: 844 });
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
});

test('거래처 검색은 debounce하고 늦게 도착한 이전 검색 결과를 버린다', async ({ page }) => {
  await installCompanyUser(page);
  let releaseOldSearch: () => void = () => {};
  let markOldSearchFulfilled: () => void = () => {};
  const oldSearchGate = new Promise<void>(resolve => { releaseOldSearch = resolve; });
  const oldSearchFulfilled = new Promise<void>(resolve => { markOldSearchFulfilled = resolve; });
  const clientQueries: string[] = [];
  await page.route('**/api/peakos/company-documents**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith('/company-documents')) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    if (url.searchParams.get('folder') !== 'clients') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ documents: DOCUMENTS.map(document => ({ ...document, size: PNG.length, available: true })) }),
      });
    }
    const query = url.searchParams.get('q') || '';
    clientQueries.push(query);
    if (query === '오래된 거래처') await oldSearchGate;
    const clientName = query === '오래된 거래처' ? '버려져야 할 이전 결과' : query === '최종 거래처' ? '최종 거래처 결과' : '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        documents: clientName ? [{
          id: query === '오래된 거래처' ? 'stale-client' : 'fresh-client',
          clientName,
          filename: `${clientName}.png`,
          mimeType: 'image/png',
          size: PNG.length,
          available: true,
          canPreview: true,
        }] : [],
        pagination: { page: 1, limit: 25, total: clientName ? 1 : 0, totalPages: clientName ? 1 : 0 },
      }),
    });
    if (query === '오래된 거래처') markOldSearchFulfilled();
  });

  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  await openCompanyView(page);
  await page.locator('[data-company-folder="clients"]').click();
  await expect(page.locator('[data-company-folder-content="clients"]')).toContainText('등록된 거래처 사업자등록증이 없습니다');

  const search = page.locator('[data-company-client-search]');
  await expect(search).toHaveAttribute('maxlength', '80');
  await search.fill('가'.repeat(81));
  await expect.poll(() => clientQueries.at(-1)?.length).toBe(80);
  expect(clientQueries.at(-1)).toBe('가'.repeat(80));
  await search.fill('오래된 거래처');
  await expect.poll(() => clientQueries).toContain('오래된 거래처');
  await search.evaluate(input => {
    const field = input as HTMLInputElement;
    field.value = '중간 거래처';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.value = '최종 거래처';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await expect(page.locator('[data-company-client-document="fresh-client"]')).toContainText('최종 거래처 결과');
  await expect(search).toBeFocused();
  expect(clientQueries).not.toContain('중간 거래처');
  releaseOldSearch();
  await oldSearchFulfilled;
  await page.waitForTimeout(50);
  await expect(page.locator('[data-company-client-document="fresh-client"]')).toContainText('최종 거래처 결과');
  await expect(page.locator('[data-company-client-document="stale-client"]')).toHaveCount(0);
  expect(clientQueries).toEqual(['', '가'.repeat(80), '오래된 거래처', '최종 거래처']);
});

test('거래처 문서를 25건씩 이동하고 점검 중 원본을 다시 확인한다', async ({ page }) => {
  await installCompanyUser(page);
  const requestedPages: number[] = [];
  let firstPageCalls = 0;
  await page.route('**/api/peakos/company-documents**', route => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith('/company-documents')) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    if (url.searchParams.get('folder') !== 'clients') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ documents: DOCUMENTS.map(document => ({ ...document, size: PNG.length, available: true })) }),
      });
    }
    const requestedPage = Number(url.searchParams.get('page') || 1);
    requestedPages.push(requestedPage);
    if (requestedPage === 1) firstPageCalls += 1;
    const count = requestedPage === 3 ? 3 : 25;
    const documents = Array.from({ length: count }, (_, index) => ({
      id: `client-page-${requestedPage}-${index + 1}`,
      clientName: `${requestedPage}페이지 거래처 ${index + 1}`,
      filename: `${requestedPage}-${index + 1}.png`,
      mimeType: 'image/png',
      size: PNG.length,
      available: requestedPage !== 1 || index !== 0 || firstPageCalls > 1,
      canPreview: true,
    }));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ documents, pagination: { page: requestedPage, limit: 25, total: 53, totalPages: 3 } }),
    });
  });

  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  await openCompanyView(page);
  await page.locator('[data-company-folder="clients"]').click();

  const rows = page.locator('[data-company-client-document]');
  await expect(rows).toHaveCount(25);
  await expect(page.locator('[data-company-client-document="client-page-1-1"]')).toContainText('원본 점검 필요');
  await expect(page.locator('[data-company-client-document="client-page-1-1"] [data-company-document-download]')).toBeDisabled();
  await expect(page.locator('[data-company-client-refresh]')).toBeVisible();
  await page.locator('[data-company-client-refresh]').click();
  await expect(page.locator('[data-company-client-document="client-page-1-1"] [data-company-document-download]')).toBeEnabled();

  await expect(page.locator('[aria-label="거래처 사업자등록증 페이지"]')).toContainText('1 / 3 페이지');
  await expect(page.locator('[aria-label="이전 거래처 문서 페이지"]')).toBeDisabled();
  await page.locator('[aria-label="다음 거래처 문서 페이지"]').click();
  await expect(page.locator('[data-company-client-document="client-page-2-1"]')).toBeVisible();
  await expect(rows).toHaveCount(25);
  await expect(page.locator('[aria-label="거래처 사업자등록증 페이지"]')).toContainText('2 / 3 페이지');

  await page.locator('[aria-label="다음 거래처 문서 페이지"]').click();
  await expect(page.locator('[data-company-client-document="client-page-3-1"]')).toBeVisible();
  await expect(rows).toHaveCount(3);
  await expect(page.locator('[aria-label="거래처 사업자등록증 페이지"]')).toContainText('3 / 3 페이지');
  await expect(page.locator('[aria-label="다음 거래처 문서 페이지"]')).toBeDisabled();
  expect(requestedPages).toEqual([1, 1, 2, 3]);
});

test('거래처 미리보기 응답 전에 로그아웃하면 이전 인증 결과를 표시하지 않는다', async ({ page }) => {
  await installCompanyUser(page);
  let releaseContent: () => void = () => {};
  let markContentFulfilled: () => void = () => {};
  const contentGate = new Promise<void>(resolve => { releaseContent = resolve; });
  const contentFulfilled = new Promise<void>(resolve => { markContentFulfilled = resolve; });
  await page.route('**/api/peakos/company-documents**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/company-documents')) {
      const clients = url.searchParams.get('folder') === 'clients';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(clients ? {
          documents: [{
            id: 'client-auth-stale', clientName: '이전 계정 거래처', filename: '이전 계정 원본.png',
            mimeType: 'image/png', size: PNG.length, available: true, canPreview: true,
          }],
          pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
        } : {
          documents: DOCUMENTS.map(document => ({ ...document, size: PNG.length, available: true })),
        }),
      });
    }
    await contentGate;
    await route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    markContentFulfilled();
  });

  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  await openCompanyView(page);
  await page.locator('[data-company-folder="clients"]').click();
  await page.locator('[data-company-client-document="client-auth-stale"] [data-company-document-preview]').click();
  await expect(page.locator('#readonlyModalBody')).toContainText('보호 원본을 확인하고 있습니다');

  await page.evaluate(() => (window as any).firebase.auth().signOut());
  releaseContent();
  await contentFulfilled;

  await expect(page.locator('#authGate')).toBeVisible();
  await expect(page.locator('#readonlyDetailModal')).toBeHidden();
  await expect(page.locator('[data-company-document-image]')).toHaveCount(0);
  await expect(page.locator('[data-company-client-document]')).toHaveCount(0);
});
