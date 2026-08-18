'use strict';

const ALLOWED_MIME_TYPES = Object.freeze(new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
]));
const TERMINAL_INVOICE_STATUSES = Object.freeze(new Set(['ISSUED', 'CORRECTED']));
const WORKSPACE_ID_PATTERN = /^ws_[a-z0-9_]{1,60}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class TaxInvoiceEvidencePolicyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'TaxInvoiceEvidencePolicyError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new TaxInvoiceEvidencePolicyError(status, code, message);
}

function cleanText(value, { label, minimum = 1, maximum }) {
  if (typeof value !== 'string') {
    fail(400, 'TAX_INVOICE_EVIDENCE_TEXT_INVALID', `${label} 형식을 확인해 주세요.`);
  }
  const normalized = value
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
  if (normalized.length < minimum || normalized.length > maximum
      || /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(normalized)) {
    fail(400, 'TAX_INVOICE_EVIDENCE_TEXT_INVALID', `${label} 형식을 확인해 주세요.`);
  }
  return normalized;
}

function invoiceNumber(value) {
  const normalized = cleanText(String(value ?? '').toUpperCase(), {
    label: '발급번호',
    minimum: 8,
    maximum: 40,
  });
  const compact = normalized.replace(/-/g, '');
  const digitCount = (compact.match(/[0-9]/g) || []).length;
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(normalized)
      || compact.length < 8 || compact.length > 32 || digitCount < 6) {
    fail(400, 'TAX_INVOICE_EVIDENCE_INVOICE_NUMBER_INVALID', '발급번호 형식이나 길이를 확인해 주세요.');
  }
  return normalized;
}

function isValidKoreanBusinessRegistrationNumber(value) {
  if (!/^\d{10}$/.test(String(value || ''))) return false;
  const digits = [...String(value)].map(Number);
  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += digits[index] * weights[index];
  sum += Math.floor((digits[8] * 5) / 10);
  return (10 - (sum % 10)) % 10 === digits[9];
}

function supplierRegistrationNumber(value) {
  const normalized = String(value ?? '').replace(/[^0-9]/g, '');
  if (!isValidKoreanBusinessRegistrationNumber(normalized)) {
    fail(400, 'TAX_INVOICE_EVIDENCE_SUPPLIER_NUMBER_INVALID', '공급자 사업자등록번호를 확인해 주세요.');
  }
  return normalized;
}

function documentIdentifier(value) {
  const normalized = cleanText(value, {
    label: '문서 식별자',
    minimum: 4,
    maximum: 120,
  });
  if (/[\\/]/u.test(normalized)) {
    fail(400, 'TAX_INVOICE_EVIDENCE_DOCUMENT_ID_INVALID', '문서 식별자 형식을 확인해 주세요.');
  }
  return normalized;
}

function correctionReason(value, required) {
  const raw = typeof value === 'string' ? value : '';
  if (!raw.trim() && !required) return '';
  return cleanText(raw, {
    label: '정정 사유',
    minimum: required ? 4 : 1,
    maximum: 500,
  });
}

function strictInstant(value, now = new Date()) {
  if (typeof value !== 'string' || value.length > 40) {
    fail(400, 'TAX_INVOICE_EVIDENCE_ISSUED_AT_INVALID', '발급일시를 ISO 8601 형식으로 입력해 주세요.');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value
      || parsed.getTime() < Date.parse('2000-01-01T00:00:00.000Z')
      || parsed.getTime() > now.getTime() + (10 * 60 * 1000)) {
    fail(400, 'TAX_INVOICE_EVIDENCE_ISSUED_AT_INVALID', '발급일시를 확인해 주세요.');
  }
  return parsed.toISOString();
}

function expectedVersion(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647
      || String(number) !== String(value).trim()) {
    fail(400, 'TAX_INVOICE_EVIDENCE_EXPECTED_VERSION_REQUIRED', '최신 요청 버전이 필요합니다.');
  }
  return number;
}

function targetStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!TERMINAL_INVOICE_STATUSES.has(normalized)) {
    fail(400, 'TAX_INVOICE_EVIDENCE_TARGET_STATUS_INVALID', '증빙 등록 상태를 확인해 주세요.');
  }
  return normalized;
}

function assertGenericFinancePatchDoesNotClaimIssuance(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const invoiceStatus = Object.prototype.hasOwnProperty.call(body, 'invoiceStatus')
    ? String(body.invoiceStatus || '').trim().toUpperCase()
    : '';
  const suppliedLegacyEvidenceUrl = Object.prototype.hasOwnProperty.call(body, 'invoiceEvidenceUrl')
    || Object.prototype.hasOwnProperty.call(body, 'invoice_evidence_url');
  if (TERMINAL_INVOICE_STATUSES.has(invoiceStatus) || suppliedLegacyEvidenceUrl) {
    fail(
      409,
      'TAX_INVOICE_EVIDENCE_PROTECTED_UPLOAD_REQUIRED',
      '발급·정정 완료는 발급번호와 보호된 원본 파일을 증빙 등록 화면에서 함께 등록해야 합니다.',
    );
  }
}

function normalizeMetadata(body, { now = new Date() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(400, 'TAX_INVOICE_EVIDENCE_BODY_INVALID', '세금계산서 증빙 정보를 입력해 주세요.');
  }
  const allowed = new Set([
    'expectedVersion',
    'invoiceStatus',
    'invoiceNumber',
    'issuedAt',
    'supplierRegistrationNumber',
    'documentIdentifier',
    'correctionReason',
  ]);
  if (Object.keys(body).some(key => !allowed.has(key))) {
    fail(400, 'TAX_INVOICE_EVIDENCE_FIELDS_NOT_ALLOWED', '허용되지 않은 증빙 정보가 있습니다.');
  }
  const status = targetStatus(body.invoiceStatus);
  if (status === 'ISSUED' && String(body.correctionReason || '').trim()) {
    fail(400, 'TAX_INVOICE_EVIDENCE_CORRECTION_REASON_INVALID', '발급 증빙에는 정정 사유를 입력할 수 없습니다.');
  }
  return Object.freeze({
    expectedVersion: expectedVersion(body.expectedVersion),
    invoiceStatus: status,
    invoiceNumber: invoiceNumber(body.invoiceNumber),
    issuedAt: strictInstant(body.issuedAt, now),
    supplierRegistrationNumber: supplierRegistrationNumber(body.supplierRegistrationNumber),
    documentIdentifier: documentIdentifier(body.documentIdentifier),
    correctionReason: correctionReason(body.correctionReason, status === 'CORRECTED'),
  });
}

function previewRequest(req) {
  const header = name => (typeof req?.get === 'function'
    ? req.get(name)
    : req?.headers?.[String(name).toLowerCase()]);
  return /^(?:1|true|yes|on)$/i.test(String(header('x-peakos-preview') || '').trim())
    || Boolean(header('x-peakos-preview-persona') || header('x-peakos-preview-owner'));
}

function approvedActive(req) {
  return Boolean(req?.uid
    && req?.userDoc?.approved === true
    && req?.userDoc?.is_active !== false
    && req?.userDoc?.chat_only !== true
    && req?.userDoc?.external_calendar_only !== true);
}

function selectedWorkspace(req) {
  const workspaceId = String(req?.workspace?.id || '').trim();
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    fail(403, 'TAX_INVOICE_EVIDENCE_WORKSPACE_REQUIRED', '선택한 워크스페이스를 확인할 수 없습니다.');
  }
  if (!['read', 'write'].includes(req?.workspace?.permissions?.settlements)) {
    fail(403, 'TAX_INVOICE_EVIDENCE_READ_FORBIDDEN', '이 워크스페이스의 정산 증빙을 볼 수 없습니다.');
  }
  return workspaceId;
}

function canReadRequest(req, request, canReviewFinance) {
  if (!approvedActive(req)) return false;
  if (String(request?.workspace_id || '') !== String(req?.workspace?.id || '')) return false;
  return String(request?.requester_uid || '') === String(req.uid)
    || Boolean(canReviewFinance(req));
}

function canReadOriginal(req, request, canReviewFinance) {
  return approvedActive(req)
    && String(request?.workspace_id || '') === String(req?.workspace?.id || '')
    && Boolean(canReviewFinance(req));
}

function canRegister(req, canReviewFinance) {
  return approvedActive(req)
    && !previewRequest(req)
    && req?.workspace?.headquartersOversight !== true
    && req?.workspace?.role !== 'oversight'
    && req?.workspace?.permissions?.settlements === 'write'
    && Boolean(canReviewFinance(req));
}

function evidenceAction(request, targetInvoiceStatus) {
  const currentStatus = String(request?.invoice_status || '');
  const currentEvidenceId = request?.current_invoice_evidence_id || null;
  if (currentEvidenceId && currentStatus === targetInvoiceStatus
      && TERMINAL_INVOICE_STATUSES.has(currentStatus)) {
    return 'REPLACEMENT';
  }
  if (!currentEvidenceId && targetInvoiceStatus === 'ISSUED'
      && ['REQUESTED', 'PROCESSING', 'ISSUED'].includes(currentStatus)) return 'ISSUE';
  if (targetInvoiceStatus === 'CORRECTED'
      && ['CORRECTION_REQUESTED', 'PROCESSING', 'CORRECTED'].includes(currentStatus)) return 'CORRECTION';
  fail(409, 'TAX_INVOICE_EVIDENCE_STATE_CONFLICT', '현재 계산서 상태와 증빙 종류가 일치하지 않습니다.');
}

function maskTail(value, visible = 4) {
  const text = String(value || '');
  if (text.length <= visible) return '*'.repeat(text.length);
  return `${'*'.repeat(text.length - visible)}${text.slice(-visible)}`;
}

function maskRegistrationNumber(value) {
  const text = String(value || '');
  return /^\d{10}$/.test(text) ? `${text.slice(0, 3)}-**-**${text.slice(-3)}` : '';
}

function normalizeRequestId(value) {
  const id = String(value || '').trim();
  if (!UUID_PATTERN.test(id)) {
    fail(400, 'TAX_INVOICE_EVIDENCE_REQUEST_ID_INVALID', '금융 요청 ID를 확인해 주세요.');
  }
  return id;
}

function normalizeEvidenceId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) {
    fail(400, 'TAX_INVOICE_EVIDENCE_ID_INVALID', '세금계산서 증빙 ID를 확인해 주세요.');
  }
  return id;
}

module.exports = {
  ALLOWED_MIME_TYPES,
  TERMINAL_INVOICE_STATUSES,
  TaxInvoiceEvidencePolicyError,
  approvedActive,
  assertGenericFinancePatchDoesNotClaimIssuance,
  canReadOriginal,
  canReadRequest,
  canRegister,
  cleanText,
  documentIdentifier,
  evidenceAction,
  expectedVersion,
  invoiceNumber,
  isValidKoreanBusinessRegistrationNumber,
  maskRegistrationNumber,
  maskTail,
  normalizeEvidenceId,
  normalizeMetadata,
  normalizeRequestId,
  previewRequest,
  selectedWorkspace,
  strictInstant,
  supplierRegistrationNumber,
};
