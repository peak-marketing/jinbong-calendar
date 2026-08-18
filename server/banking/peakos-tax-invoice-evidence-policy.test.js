'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TaxInvoiceEvidencePolicyError,
  assertGenericFinancePatchDoesNotClaimIssuance,
  canReadOriginal,
  canReadRequest,
  canRegister,
  evidenceAction,
  invoiceNumber,
  isValidKoreanBusinessRegistrationNumber,
  normalizeMetadata,
  previewRequest,
  selectedWorkspace,
  supplierRegistrationNumber,
} = require('./peakos-tax-invoice-evidence-policy');

function request(overrides = {}) {
  return {
    uid: 'sales-1',
    userDoc: { approved: true, is_active: true },
    workspace: {
      id: 'ws_peak', role: 'manager', headquartersOversight: false,
      permissions: { settlements: 'write' },
    },
    headers: {},
    ...overrides,
  };
}

function validMetadata(overrides = {}) {
  return {
    expectedVersion: '3',
    invoiceStatus: 'ISSUED',
    invoiceNumber: '20260817-12345678',
    issuedAt: '2026-08-17T02:03:04.000Z',
    supplierRegistrationNumber: '220-81-62517',
    documentIdentifier: 'HOMETAX-20260817-01',
    correctionReason: '',
    ...overrides,
  };
}

test('발급번호·발급일시·공급자·문서 식별자를 엄격하게 정규화한다', () => {
  const input = normalizeMetadata(validMetadata(), {
    now: new Date('2026-08-17T03:00:00.000Z'),
  });
  assert.deepEqual(input, {
    expectedVersion: 3,
    invoiceStatus: 'ISSUED',
    invoiceNumber: '20260817-12345678',
    issuedAt: '2026-08-17T02:03:04.000Z',
    supplierRegistrationNumber: '2208162517',
    documentIdentifier: 'HOMETAX-20260817-01',
    correctionReason: '',
  });
  assert.equal(isValidKoreanBusinessRegistrationNumber('2208162517'), true);
  assert.equal(isValidKoreanBusinessRegistrationNumber('2208162518'), false);
});

test('정정완료는 사유가 필요하고 URL·임의 필드는 입력으로 받지 않는다', () => {
  assert.throws(
    () => normalizeMetadata(validMetadata({ invoiceStatus: 'CORRECTED' }), {
      now: new Date('2026-08-17T03:00:00.000Z'),
    }),
    error => error instanceof TaxInvoiceEvidencePolicyError,
  );
  assert.throws(
    () => normalizeMetadata({ ...validMetadata(), invoiceEvidenceUrl: 'https://example.test/invoice.pdf' }, {
      now: new Date('2026-08-17T03:00:00.000Z'),
    }),
    error => error.code === 'TAX_INVOICE_EVIDENCE_FIELDS_NOT_ALLOWED',
  );
});

test('legacy generic PATCH는 migration 전후 모두 URL-only terminal 완료를 409 계약으로 거부한다', () => {
  for (const patch of [
    { invoiceStatus: 'ISSUED', invoiceEvidenceUrl: 'https://example.test/invoice.pdf' },
    { invoiceStatus: 'CORRECTED' },
    { invoiceEvidenceUrl: 'https://example.test/invoice.pdf' },
    { invoice_evidence_url: 'https://example.test/invoice.pdf' },
  ]) {
    assert.throws(
      () => assertGenericFinancePatchDoesNotClaimIssuance(patch),
      error => error.status === 409
        && error.code === 'TAX_INVOICE_EVIDENCE_PROTECTED_UPLOAD_REQUIRED',
    );
  }
  assert.doesNotThrow(() => assertGenericFinancePatchDoesNotClaimIssuance({ invoiceStatus: 'PROCESSING' }));
  assert.doesNotThrow(() => assertGenericFinancePatchDoesNotClaimIssuance({ status: 'APPROVED' }));
});

test('발급번호와 사업자번호의 형식·길이·체크섬을 검증한다', () => {
  assert.equal(invoiceNumber(' 20260817-ab123456 '), '20260817-AB123456');
  assert.equal(supplierRegistrationNumber('220-81-62517'), '2208162517');
  for (const bad of ['123', 'ABC-DEFG-HIJK', '12345678--90', '12345678/90']) {
    assert.throws(() => invoiceNumber(bad));
  }
  assert.throws(
    () => supplierRegistrationNumber('220-81-62518'),
    error => error.code === 'TAX_INVOICE_EVIDENCE_SUPPLIER_NUMBER_INVALID',
  );
});

test('요청 버전과 미래 발급시각이 fail-closed 된다', () => {
  assert.throws(
    () => normalizeMetadata(validMetadata({ expectedVersion: '02' }), {
      now: new Date('2026-08-17T03:00:00.000Z'),
    }),
    error => error.code === 'TAX_INVOICE_EVIDENCE_EXPECTED_VERSION_REQUIRED',
  );
  assert.throws(
    () => normalizeMetadata(validMetadata({ issuedAt: '2026-08-17T04:00:00.000Z' }), {
      now: new Date('2026-08-17T03:00:00.000Z'),
    }),
    error => error.code === 'TAX_INVOICE_EVIDENCE_ISSUED_AT_INVALID',
  );
});

test('발급·정정·교체 action은 현재 상태와 current evidence로 결정한다', () => {
  assert.equal(evidenceAction({ invoice_status: 'REQUESTED' }, 'ISSUED'), 'ISSUE');
  assert.equal(evidenceAction({
    invoice_status: 'CORRECTION_REQUESTED', current_invoice_evidence_id: 'old',
  }, 'CORRECTED'), 'CORRECTION');
  assert.equal(evidenceAction({
    invoice_status: 'ISSUED', current_invoice_evidence_id: 'old',
  }, 'ISSUED'), 'REPLACEMENT');
  assert.throws(
    () => evidenceAction({ invoice_status: 'REQUESTED' }, 'CORRECTED'),
    error => error.code === 'TAX_INVOICE_EVIDENCE_STATE_CONFLICT',
  );
});

test('권한은 reviewer mutation, requester masked read, reviewer original read로 분리한다', () => {
  const reviewer = request();
  const ownRow = { workspace_id: 'ws_peak', requester_uid: 'sales-1' };
  assert.equal(canRegister(reviewer, () => true), true);
  assert.equal(canReadRequest(reviewer, ownRow, () => false), true);
  assert.equal(canReadOriginal(reviewer, ownRow, () => false), false);
  assert.equal(canReadOriginal(reviewer, ownRow, () => true), true);
  assert.equal(selectedWorkspace(reviewer), 'ws_peak');

  assert.equal(canRegister(request({ headers: { 'x-peakos-preview': 'true' } }), () => true), false);
  assert.equal(previewRequest(request({ headers: { 'x-peakos-preview': 'true' } })), true);
  assert.equal(canRegister(request({ workspace: {
    ...reviewer.workspace, headquartersOversight: true, role: 'oversight',
  } }), () => true), false);
  assert.equal(canRegister(request({ userDoc: {
    approved: true, is_active: true, chat_only: true,
  } }), () => true), false);
  assert.throws(() => selectedWorkspace(request({ workspace: {
    ...reviewer.workspace, permissions: { settlements: 'none' },
  } })), error => error.code === 'TAX_INVOICE_EVIDENCE_READ_FORBIDDEN');
});
