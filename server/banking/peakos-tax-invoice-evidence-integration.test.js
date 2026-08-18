'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const financeSource = fs.readFileSync(path.join(__dirname, 'peakos-finance-requests.js'), 'utf8');
const browserSource = fs.readFileSync(path.join(ROOT, 'business-os-preview.js'), 'utf8');

test('startup은 finance 후 exact tax-evidence readiness를 통과해야 라우트를 연다', () => {
  assert.match(indexSource, /ensurePeakosTaxInvoiceEvidenceInfrastructure/);
  assert.match(indexSource, /registerPeakosTaxInvoiceEvidenceRoutes/);
  assert.ok(
    indexSource.indexOf('await ensurePeakosFinanceRequestInfrastructure(pool);')
      < indexSource.indexOf('await ensurePeakosTaxInvoiceEvidenceInfrastructure(pool);'),
  );
  assert.ok(
    indexSource.indexOf('await ensurePeakosTaxInvoiceEvidenceInfrastructure(pool);')
      < indexSource.indexOf('registerPeakosTaxInvoiceEvidenceRoutes({'),
  );
  assert.match(indexSource, /storageRoot: process\.env\.PEAKOS_TAX_INVOICE_EVIDENCE_ROOT \|\| undefined/);
  assert.match(indexSource, /\^\\\/finance-requests\(\?:\\\/\|\$\)\//);
});

test('일반 finance PATCH는 terminal·URL-only 완료 가드를 상태 정규화 전에 적용한다', () => {
  const functionStart = financeSource.indexOf('function normalizeOperatorPatch(body, current)');
  const helperCall = financeSource.indexOf('assertGenericFinancePatchDoesNotClaimIssuance(body);', functionStart);
  const statusNormalization = financeSource.indexOf("const status = hasOwn(body, 'status')", functionStart);
  assert.ok(functionStart >= 0 && helperCall > functionStart && helperCall < statusNormalization);
  assert.match(financeSource, /new FinanceRequestConflictError\(error\.message, error\.code\)/);
  assert.match(financeSource, /current_invoice_evidence_id/);
  assert.match(financeSource, /currentInvoiceEvidenceId/);
});

test('브라우저는 외부 발행을 주장하지 않고 multipart 보호 증빙·masked 이력만 연결한다', () => {
  assert.match(browserSource, /data-finance-invoice-evidence="ISSUED"/);
  assert.match(browserSource, /data-tax-invoice-evidence-form/);
  assert.match(browserSource, /new FormData\(\)/);
  assert.match(browserSource, /formData\.append\('document', file, file\.name\)/);
  assert.match(browserSource, /\/invoice-evidence`/);
  assert.match(browserSource, /registrationOnly !== true/);
  assert.match(browserSource, /externalIssuancePerformed !== false/);
  assert.match(browserSource, /외부 세금계산서 발행 API가 아닙니다/);
  assert.match(browserSource, /과거 계산서 참고 링크\(완료 근거 아님\)/);
  assert.match(browserSource, /options\.responseType === 'blob'/);
  assert.match(browserSource, /\^\\\/peakos\\\/finance-requests/);
  assert.doesNotMatch(browserSource, /prompt\('권한이 제한된 계산서/);
});
