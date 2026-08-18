import { expect, test, type Locator, type Page } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const REQUEST_ID = 'b7c8019c-6048-483a-abf7-b47485d9e5ca';
const EVIDENCE_ID = '96c9d661-5349-4684-8962-000000000001';

async function expand(element: Locator) {
  if ((await element.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await element.locator(':scope > button').first().click();
  }
}

async function openTaxAdvance(page: Page) {
  const cluster = page.locator('[data-nav-cluster="tax-banking"]');
  await expect(cluster).toBeVisible();
  await expand(cluster);
  const group = cluster.locator('[data-tax-banking-group="bank-tax"]');
  await expand(group);
  await group.locator('[data-view="tax-advance"]').click();
  const module = page.locator('[data-finance-request-module="tax-advance"]');
  await expect(module).toBeVisible();
  return module;
}

function financeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    requesterUid: 'e2e-test-user',
    requesterName: '영업자 A',
    kind: 'TAX_ADVANCE',
    requestType: 'tax-advance',
    requestDate: '2026-08-17',
    clientName: '테스트 거래처',
    detail: '세금계산서 선발행',
    amountVat: 1_100_000,
    reason: '주문 확정',
    status: 'PROCESSING',
    invoiceRequested: true,
    invoiceStatus: 'REQUESTED',
    currentInvoiceEvidenceId: null,
    version: 1,
    workspaceId: 'ws_peak',
    ...overrides,
  };
}

test.describe('세금계산서 보호 발급 증빙', () => {
  test('재무 검토자는 URL PATCH가 아닌 multipart 원본+메타데이터로만 발급 증빙을 등록한다', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '박종원',
      role: 'manager',
      group_name: '본사 경영지원팀',
    });
    store.financeRequests.push(financeRequest({ requesterUid: 'other-sales-uid' }));
    const requests: Array<{ method: string; url: string; body: string }> = [];
    page.on('request', request => {
      if (request.url().includes(`/api/peakos/finance-requests/${REQUEST_ID}`)) {
        requests.push({ method: request.method(), url: request.url(), body: request.postData() || '' });
      }
    });

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    const module = await openTaxAdvance(page);
    const row = module.locator(`[data-finance-request-row="${REQUEST_ID}"]`);
    await expect(row.getByRole('button', { name: '발급 증빙 등록' })).toBeVisible();
    await row.getByRole('button', { name: '발급 증빙 등록' }).click();

    const form = page.locator(`[data-tax-invoice-evidence-form="${REQUEST_ID}"]`);
    await expect(form).toBeVisible();
    await expect(form).toContainText('외부 세금계산서 발행 API가 아닙니다');
    await form.locator('[name="invoiceNumber"]').fill('20260817-000001');
    await form.locator('[name="supplierRegistrationNumber"]').fill('2208162517');
    await form.locator('[name="documentIdentifier"]').fill('platform-document-0001');
    await form.locator('[name="document"]').setInputFiles({
      name: 'issued-tax-invoice.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
    });
    await form.locator('[data-tax-invoice-evidence-submit]').click();

    await expect.poll(() => store.financeRequests[0].invoiceStatus).toBe('ISSUED');
    await expect.poll(() => store.financeRequests[0].currentInvoiceEvidenceId).toBe(EVIDENCE_ID);
    expect(store.financeRequests[0].version).toBe(2);
    expect(store.taxInvoiceEvidence[REQUEST_ID]).toHaveLength(1);
    expect(store.taxInvoiceEvidence[REQUEST_ID][0]).toMatchObject({
      id: EVIDENCE_ID,
      action: 'ISSUE',
      invoiceNumber: '20260817-000001',
      supplierRegistrationNumber: '2208162517',
      documentIdentifier: 'platform-document-0001',
      registrationOnly: true,
      externalIssuancePerformed: false,
    });
    const evidencePost = requests.find(request => request.method === 'POST' && request.url.endsWith('/invoice-evidence'));
    expect(evidencePost?.body).toContain('name="expectedVersion"');
    expect(evidencePost?.body).toContain('name="invoiceNumber"');
    expect(evidencePost?.body).toContain('name="document"; filename="issued-tax-invoice.pdf"');
    expect(requests.some(request => request.method === 'PATCH'
      && /"invoiceStatus":"(?:ISSUED|CORRECTED)"/.test(request.body))).toBe(false);
    expect(requests.some(request => request.body.includes('invoiceEvidenceUrl'))).toBe(false);

    const refreshed = module.locator(`[data-finance-request-row="${REQUEST_ID}"]`);
    await expect(refreshed).toContainText('보호 원본·메타데이터 연결됨');
    await refreshed.getByRole('button', { name: '발급 증빙 이력' }).click();
    const history = page.locator(`[data-tax-invoice-evidence-history="${REQUEST_ID}"]`);
    await expect(history).toContainText('20260817-000001');
    await expect(history).toContainText('2208162517');
    const downloadButton = history.getByRole('button', { name: '보호 원본 다운로드' });
    await expect(downloadButton).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await downloadButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('issued-tax-invoice.pdf');
  });

  test('요청자는 증빙 이력을 마스킹해 보고 원본·교체 권한을 받지 않는다', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '영업자 A',
      role: 'member',
      group_name: '본사 영업팀',
    });
    store.financeRequests.push(financeRequest({
      invoiceStatus: 'ISSUED',
      currentInvoiceEvidenceId: EVIDENCE_ID,
      version: 2,
    }));
    store.taxInvoiceEvidence[REQUEST_ID] = [{
      id: EVIDENCE_ID,
      requestId: REQUEST_ID,
      revision: 1,
      action: 'ISSUE',
      invoiceStatus: 'ISSUED',
      invoiceNumber: '20260817-000001',
      issuedAt: '2026-08-17T08:30:00.000Z',
      supplierRegistrationNumber: '2208162517',
      documentIdentifier: 'platform-document-0001',
      correctionReason: '',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      supersedesEvidenceId: null,
      registeredByName: '박종원',
      createdAt: '2026-08-17T09:00:00.000Z',
      protectedOriginalAvailable: true,
      originalFilename: 'issued-tax-invoice.pdf',
      sha256: 'a'.repeat(64),
      registrationOnly: true,
      externalIssuancePerformed: false,
    }];

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    const module = await openTaxAdvance(page);
    const row = module.locator(`[data-finance-request-row="${REQUEST_ID}"]`);
    await expect(row.getByRole('button', { name: '보호 증빙 교체' })).toHaveCount(0);
    await row.getByRole('button', { name: '발급 증빙 이력' }).click();

    const history = page.locator(`[data-tax-invoice-evidence-history="${REQUEST_ID}"]`);
    await expect(history).toContainText('요청자 열람');
    await expect(history).toContainText('***********0001');
    await expect(history).toContainText('220-**-**517');
    await expect(history).not.toContainText('platform-document-0001');
    await expect(history.getByRole('button', { name: '보호 원본 다운로드' })).toHaveCount(0);
  });
});
