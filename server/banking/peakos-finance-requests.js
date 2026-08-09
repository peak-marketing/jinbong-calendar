'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FINANCE_REQUEST_KINDS = Object.freeze([
  'TAX_ADVANCE',
  'TAX_CORRECTION',
  'REFUND_CLIENT',
  'REFUND_MISTAKEN',
  'EXPENSE_AD',
  'EXPENSE_SUPPLIES',
]);
const FINANCE_REQUEST_KIND_SET = new Set(FINANCE_REQUEST_KINDS);
const REFUND_KIND_SET = new Set(['REFUND_CLIENT', 'REFUND_MISTAKEN']);
const TAX_KIND_SET = new Set(['TAX_ADVANCE', 'TAX_CORRECTION']);

const FINANCE_REQUEST_STATUSES = Object.freeze([
  'PENDING',
  'REVIEWING',
  'APPROVED',
  'PROCESSING',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
]);
const FINANCE_REQUEST_STATUS_SET = new Set(FINANCE_REQUEST_STATUSES);
const REQUEST_STATUS_TRANSITIONS = Object.freeze({
  PENDING: new Set(['REVIEWING', 'APPROVED', 'PROCESSING', 'REJECTED', 'CANCELLED']),
  REVIEWING: new Set(['APPROVED', 'PROCESSING', 'REJECTED', 'CANCELLED']),
  APPROVED: new Set(['PROCESSING', 'COMPLETED', 'REJECTED']),
  PROCESSING: new Set(['APPROVED', 'COMPLETED', 'REJECTED']),
  COMPLETED: new Set(),
  REJECTED: new Set(),
  CANCELLED: new Set(),
});

const FINANCE_INVOICE_STATUSES = Object.freeze([
  'NOT_REQUESTED',
  'REQUESTED',
  'PROCESSING',
  'ISSUED',
  'CORRECTION_REQUESTED',
  'CORRECTED',
  'FAILED',
  'CANCELLED',
]);
const FINANCE_INVOICE_STATUS_SET = new Set(FINANCE_INVOICE_STATUSES);
const INVOICE_STATUS_TRANSITIONS = Object.freeze({
  NOT_REQUESTED: new Set(['REQUESTED']),
  REQUESTED: new Set(['NOT_REQUESTED', 'PROCESSING', 'ISSUED', 'CORRECTION_REQUESTED', 'FAILED', 'CANCELLED']),
  PROCESSING: new Set(['ISSUED', 'CORRECTION_REQUESTED', 'CORRECTED', 'FAILED', 'CANCELLED']),
  ISSUED: new Set(['CORRECTION_REQUESTED']),
  CORRECTION_REQUESTED: new Set(['PROCESSING', 'CORRECTED', 'FAILED', 'CANCELLED']),
  CORRECTED: new Set(['CORRECTION_REQUESTED']),
  FAILED: new Set(['REQUESTED', 'PROCESSING', 'CANCELLED']),
  CANCELLED: new Set(['REQUESTED']),
});
const NEGATIVE_REQUEST_TERMINAL_STATUS_SET = new Set(['REJECTED', 'CANCELLED']);
const PRESERVED_INVOICE_TERMINAL_STATUS_SET = new Set(['ISSUED', 'CORRECTED']);

const SOURCE_ACCOUNT_IDS = Object.freeze([
  'ibk-hq-sales',
  'ibk-hq-supplier',
  'ibk-hq-fixed',
  'ibk-review-space',
  'ibk-reward-space',
]);
const SOURCE_ACCOUNT_ID_SET = new Set(SOURCE_ACCOUNT_IDS);
const RESTRICTED_SOURCE_ACCOUNT_ID_SET = new Set(['ibk-hq-supplier', 'ibk-hq-fixed']);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;
const PLATFORM_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const DEFAULT_LIST_ROWS = 500;
const MAX_LIST_ROWS = 500;
const MAX_LIST_PAGE = 10000;
const ACCOUNT_ENCRYPTION_VERSION = 1;
const ACCOUNT_IV_BYTES = 12;
const ACCOUNT_TAG_BYTES = 16;
const HKDF_SALT = Buffer.from('peakos-finance-requests:v1', 'utf8');
const HKDF_INFO = Buffer.from('payee-account:aes-256-gcm:v1', 'utf8');

const REQUEST_COLUMNS = `id, requester_uid, requester_name, kind, request_date,
  client_name, detail, amount_vat, business_registration_url, email,
  payee_bank, payee_account_ciphertext, payee_account_iv,
  payee_account_auth_tag, payee_account_encryption_version, payee_name,
  reason, invoice_requested, invoice_status, evidence_url,
  invoice_evidence_url, source_account_id, status, processing_note,
  processed_by_uid, processed_by_name, processed_at, cancelled_at,
  platform_key, external_document_id, bank_transaction_id, idempotency_key,
  created_at, updated_at`;

class FinanceRequestError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
  }
}

class FinanceRequestValidationError extends FinanceRequestError {
  constructor(message, code = 'FINANCE_REQUEST_INVALID') {
    super(message, code, 400);
  }
}

class FinanceRequestForbiddenError extends FinanceRequestError {
  constructor(message, code = 'FINANCE_REQUEST_FORBIDDEN') {
    super(message, code, 403);
  }
}

class FinanceRequestConflictError extends FinanceRequestError {
  constructor(message, code = 'FINANCE_REQUEST_CONFLICT') {
    super(message, code, 409);
  }
}

function validateText(value, fieldName, maxLength, { optional = false } = {}) {
  if (value === null || value === undefined) {
    if (optional) return '';
    throw new FinanceRequestValidationError(`${fieldName}을(를) 입력해 주세요.`);
  }
  if (typeof value !== 'string') {
    throw new FinanceRequestValidationError(`${fieldName} 형식이 올바르지 않습니다.`);
  }
  if (/\p{Cc}/u.test(value)) {
    throw new FinanceRequestValidationError(`${fieldName}에 허용되지 않는 문자가 있습니다.`);
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized && !optional) {
    throw new FinanceRequestValidationError(`${fieldName}을(를) 입력해 주세요.`);
  }
  if (normalized.length > maxLength) {
    throw new FinanceRequestValidationError(`${fieldName}은(는) ${maxLength}자 이하여야 합니다.`);
  }
  return normalized;
}

function parseRequestDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new FinanceRequestValidationError('요청일은 YYYY-MM-DD 형식이어야 합니다.');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new FinanceRequestValidationError('요청일이 올바르지 않습니다.');
  }
  return value;
}

function parsePositiveInteger(value, fieldName) {
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new FinanceRequestValidationError(`${fieldName}은(는) 0보다 큰 원 단위 정수여야 합니다.`);
  }
  return parsed;
}

function parseOptionalBankTransactionId(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = typeof value === 'number' ? String(value) : String(value).trim();
  if (!/^\d+$/.test(normalized) || BigInt(normalized) <= 0n || BigInt(normalized) > 9223372036854775807n) {
    throw new FinanceRequestValidationError('통장 거래 식별자가 올바르지 않습니다.');
  }
  return normalized;
}

function validateUrl(value, fieldName, { optional = true } = {}) {
  const normalized = validateText(value ?? '', fieldName, 2000, { optional });
  if (!normalized) return '';
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_) {
    throw new FinanceRequestValidationError(`${fieldName} 주소가 올바르지 않습니다.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new FinanceRequestValidationError(`${fieldName}은(는) 안전한 HTTPS 주소여야 합니다.`);
  }
  return parsed.toString();
}

function validateEmail(value, { required = false } = {}) {
  const email = validateText(value ?? '', '이메일', 320, { optional: !required });
  if (!email) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new FinanceRequestValidationError('이메일 형식이 올바르지 않습니다.');
  }
  return email;
}

function parseBoolean(value, fieldName, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new FinanceRequestValidationError(`${fieldName}은(는) true 또는 false여야 합니다.`);
  }
  return value;
}

function normalizeSourceAccountId(value, { allowRestricted = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new FinanceRequestValidationError('출금 통장 형식이 올바르지 않습니다.');
  }
  const accountId = value.trim();
  if (!SOURCE_ACCOUNT_ID_SET.has(accountId)) {
    throw new FinanceRequestValidationError('출금 통장이 올바르지 않습니다.');
  }
  if (RESTRICTED_SOURCE_ACCOUNT_ID_SET.has(accountId) && !allowRestricted) {
    throw new FinanceRequestForbiddenError('이 통장을 지정할 권한이 없습니다.');
  }
  return accountId;
}

function normalizeCreateInput(body, { allowRestrictedSource = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new FinanceRequestValidationError('금융 요청 내용이 필요합니다.');
  }
  const kind = String(body.kind || '').trim().toUpperCase();
  if (!FINANCE_REQUEST_KIND_SET.has(kind)) {
    throw new FinanceRequestValidationError('요청 종류가 올바르지 않습니다.');
  }
  const refund = REFUND_KIND_SET.has(kind);
  const taxAdvance = kind === 'TAX_ADVANCE';
  const taxCorrection = kind === 'TAX_CORRECTION';
  const requiresPayee = refund || kind === 'EXPENSE_AD';
  const payeeAccount = validateText(
    body.payeeAccount ?? body.payee_account ?? '',
    '지급 계좌번호',
    120,
    { optional: !requiresPayee },
  );
  const invoiceRequested = TAX_KIND_SET.has(kind)
    ? true
    : parseBoolean(body.invoiceRequested ?? body.invoice_requested, '계산서 요청', false);
  return {
    kind,
    requestDate: parseRequestDate(body.requestDate ?? body.request_date),
    clientName: validateText(body.clientName ?? body.client_name, '업체명', 200),
    detail: validateText(body.detail, '상세내용', 2000),
    amountVat: parsePositiveInteger(body.amountVat ?? body.amount_vat, 'VAT 포함 금액'),
    businessRegistrationUrl: validateUrl(
      body.businessRegistrationUrl ?? body.business_registration_url ?? '',
      '사업자등록증',
      { optional: !(taxAdvance || taxCorrection) },
    ),
    email: validateEmail(body.email ?? '', { required: taxAdvance || taxCorrection }),
    payeeBank: validateText(body.payeeBank ?? body.payee_bank ?? '', '지급 은행', 120, { optional: !requiresPayee }),
    payeeAccount,
    payeeName: validateText(body.payeeName ?? body.payee_name ?? '', '예금주명', 160, { optional: !requiresPayee }),
    reason: validateText(body.reason ?? '', '사유', 2000),
    invoiceRequested,
    invoiceStatus: taxCorrection
      ? 'CORRECTION_REQUESTED'
      : (invoiceRequested ? 'REQUESTED' : 'NOT_REQUESTED'),
    evidenceUrl: validateUrl(body.evidenceUrl ?? body.evidence_url ?? '', '증빙자료', { optional: true }),
    invoiceEvidenceUrl: validateUrl(
      body.invoiceEvidenceUrl ?? body.invoice_evidence_url ?? '',
      '계산서 증빙',
      { optional: true },
    ),
    sourceAccountId: normalizeSourceAccountId(
      body.sourceAccountId ?? body.source_account_id,
      { allowRestricted: allowRestrictedSource },
    ),
  };
}

function normalizeActor(actor) {
  return {
    uid: validateText(actor?.uid, '요청자 식별자', 256),
    name: validateText(actor?.name, '요청자 이름', 120),
  };
}

function parseIdempotencyKey(req) {
  const headerValue = typeof req.get === 'function'
    ? req.get('Idempotency-Key')
    : req.headers?.['idempotency-key'];
  // 현재 SPA의 callApi는 사용자 정의 헤더를 받지 않으므로 body fallback도
  // 지원한다. 둘 다 있으면 프록시·표준 클라이언트가 보내는 헤더가 우선이다.
  const raw = headerValue !== undefined && headerValue !== null && headerValue !== ''
    ? headerValue
    : (req.body?.idempotencyKey ?? req.body?.idempotency_key);
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw).trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new FinanceRequestValidationError(
      'Idempotency-Key는 8~120자의 영문, 숫자, 점, 밑줄, 콜론 또는 하이픈이어야 합니다.',
      'FINANCE_REQUEST_INVALID_IDEMPOTENCY_KEY',
    );
  }
  return value;
}

function deriveEncryptionKey(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('금융 요청 계좌 암호화 비밀키는 32바이트 이상이어야 합니다.');
  }
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), HKDF_SALT, HKDF_INFO, 32));
}

function accountAad(requestId) {
  return Buffer.from(`peakos-finance-request:${requestId}:payee-account:v1`, 'utf8');
}

function encryptPayeeAccount(value, encryptionKey, requestId) {
  if (!value) {
    return { ciphertext: null, iv: null, authTag: null, version: null };
  }
  const iv = crypto.randomBytes(ACCOUNT_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(accountAad(requestId));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
    version: ACCOUNT_ENCRYPTION_VERSION,
  };
}

function decryptPayeeAccount(row, encryptionKey) {
  if (!row?.payee_account_ciphertext) return '';
  if (Number(row.payee_account_encryption_version) !== ACCOUNT_ENCRYPTION_VERSION) {
    throw new Error('지원하지 않는 금융 계좌 암호화 버전입니다.');
  }
  const iv = Buffer.from(row.payee_account_iv || []);
  const authTag = Buffer.from(row.payee_account_auth_tag || []);
  if (iv.length !== ACCOUNT_IV_BYTES || authTag.length !== ACCOUNT_TAG_BYTES) {
    throw new Error('금융 계좌 암호문 형식이 올바르지 않습니다.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAAD(accountAad(String(row.id)));
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(Buffer.from(row.payee_account_ciphertext)),
    decipher.final(),
  ]).toString('utf8');
}

function maskPayeeAccount(value) {
  const text = String(value || '');
  if (!text) return '';
  const digitIndexes = [];
  [...text].forEach((character, index) => {
    if (/\d/.test(character)) digitIndexes.push(index);
  });
  const visibleCount = Math.min(4, Math.max(0, digitIndexes.length - 4));
  const visible = new Set(digitIndexes.slice(-visibleCount));
  return [...text].map((character, index) => (/\d/.test(character) && !visible.has(index) ? '*' : character)).join('');
}

function formatDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
}

function publicInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : String(value);
}

function publicFinanceRequest(row, { encryptionKey, revealPayeeAccount = false } = {}) {
  const payeeAccount = decryptPayeeAccount(row, encryptionKey);
  const maskedAccount = maskPayeeAccount(payeeAccount);
  const request = {
    id: String(row.id),
    requesterUid: row.requester_uid,
    requesterName: row.requester_name,
    kind: row.kind,
    requestDate: formatDate(row.request_date),
    clientName: row.client_name,
    detail: row.detail || '',
    amountVat: publicInteger(row.amount_vat),
    businessRegistrationUrl: row.business_registration_url || '',
    email: row.email || '',
    payeeBank: row.payee_bank || '',
    payeeAccount: revealPayeeAccount ? payeeAccount : maskedAccount,
    payeeAccountMasked: maskedAccount,
    payeeAccountRevealed: revealPayeeAccount && Boolean(payeeAccount),
    payeeName: row.payee_name || '',
    reason: row.reason || '',
    invoiceRequested: row.invoice_requested === true,
    invoiceStatus: row.invoice_status,
    evidenceUrl: row.evidence_url || '',
    invoiceEvidenceUrl: row.invoice_evidence_url || '',
    sourceAccountId: row.source_account_id || null,
    status: row.status,
    processingNote: row.processing_note || '',
    processedByUid: row.processed_by_uid || null,
    processedByName: row.processed_by_name || null,
    processedAt: row.processed_at || null,
    cancelledAt: row.cancelled_at || null,
    platformKey: row.platform_key || null,
    externalDocumentId: row.external_document_id || null,
    bankTransactionId: row.bank_transaction_id === null || row.bank_transaction_id === undefined
      ? null
      : String(row.bank_transaction_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  // The current browser client reads camelCase while import/admin tooling still
  // uses the database-style snake_case names. Both aliases carry the exact same
  // redacted/revealed value so the authorization boundary cannot be bypassed by
  // selecting a different response key.
  return {
    ...request,
    requester_uid: request.requesterUid,
    requester_name: request.requesterName,
    request_date: request.requestDate,
    client_name: request.clientName,
    amount_vat: request.amountVat,
    business_registration_url: request.businessRegistrationUrl,
    payee_bank: request.payeeBank,
    payee_account: request.payeeAccount,
    payee_account_masked: request.payeeAccountMasked,
    payee_account_revealed: request.payeeAccountRevealed,
    payee_name: request.payeeName,
    invoice_requested: request.invoiceRequested,
    invoice_status: request.invoiceStatus,
    evidence_url: request.evidenceUrl,
    invoice_evidence_url: request.invoiceEvidenceUrl,
    source_account_id: request.sourceAccountId,
    processing_note: request.processingNote,
    processed_by_uid: request.processedByUid,
    processed_by_name: request.processedByName,
    processed_at: request.processedAt,
    cancelled_at: request.cancelledAt,
    platform_key: request.platformKey,
    external_document_id: request.externalDocumentId,
    bank_transaction_id: request.bankTransactionId,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
}

function sameCreatePayload(row, input, encryptionKey) {
  return row.kind === input.kind
    && formatDate(row.request_date) === input.requestDate
    && row.client_name === input.clientName
    && String(row.detail || '') === input.detail
    && String(row.amount_vat) === String(input.amountVat)
    && String(row.business_registration_url || '') === input.businessRegistrationUrl
    && String(row.email || '') === input.email
    && String(row.payee_bank || '') === input.payeeBank
    && decryptPayeeAccount(row, encryptionKey) === input.payeeAccount
    && String(row.payee_name || '') === input.payeeName
    && String(row.reason || '') === input.reason
    && row.invoice_requested === input.invoiceRequested
    && row.invoice_status === input.invoiceStatus
    && String(row.evidence_url || '') === input.evidenceUrl
    && String(row.invoice_evidence_url || '') === input.invoiceEvidenceUrl
    && (row.source_account_id || null) === input.sourceAccountId;
}

function approvedAndActive(req) {
  return Boolean(
    req?.uid
      && req.userDoc
      && req.userDoc.approved === true
      && req.userDoc.is_active !== false,
  );
}

function logFailure(logger, label, error) {
  if (!logger || typeof logger.error !== 'function') return;
  const code = /^[A-Z0-9_]{2,80}$/.test(String(error?.code || ''))
    ? String(error.code)
    : 'UNEXPECTED';
  logger.error(`${label}: ${code}`);
}

function sendError(res, error, fallbackMessage, logger, label) {
  if (error instanceof FinanceRequestError) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  if (error?.code === '23505') {
    return res.status(409).json({
      error: '같은 외부 문서 또는 요청 키가 이미 사용되었습니다.',
      code: 'FINANCE_REQUEST_UNIQUE_CONFLICT',
    });
  }
  logFailure(logger, label, error);
  return res.status(500).json({ error: fallbackMessage });
}

async function ensurePeakosFinanceRequestInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  const migrationPath = path.join(__dirname, '..', 'migrations', '20260808_peakos_finance_requests.sql');
  await pool.query(fs.readFileSync(migrationPath, 'utf8'));
}

async function insertEvent(client, {
  requestId,
  eventType,
  actor,
  fromStatus = null,
  toStatus = null,
  fromInvoiceStatus = null,
  toInvoiceStatus = null,
  note = '',
  metadata = {},
}) {
  await client.query(
    `INSERT INTO peakos_finance_request_events
      (request_id, event_type, actor_uid, actor_name, from_status, to_status,
       from_invoice_status, to_invoice_status, note, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      requestId,
      eventType,
      actor.uid,
      actor.name,
      fromStatus,
      toStatus,
      fromInvoiceStatus,
      toInvoiceStatus,
      note,
      JSON.stringify(metadata || {}),
    ],
  );
}

function parseMultiListFilter(value, allowed, fieldName) {
  if (value === undefined || value === null || value === '') return [];
  const rawValues = Array.isArray(value) ? value : [value];
  const normalized = [];
  for (const rawValue of rawValues) {
    if (typeof rawValue !== 'string') {
      throw new FinanceRequestValidationError(`${fieldName} 값이 올바르지 않습니다.`);
    }
    for (const candidate of rawValue.split(',')) {
      const item = candidate.trim().toUpperCase();
      if (!item || !allowed.has(item)) {
        throw new FinanceRequestValidationError(`${fieldName} 값이 올바르지 않습니다.`);
      }
      if (!normalized.includes(item)) normalized.push(item);
    }
  }
  return normalized;
}

function parseQueryBoolean(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new FinanceRequestValidationError(`${fieldName}은(는) 한 번만 지정해 주세요.`);
    }
    return parseQueryBoolean(value[0], fieldName);
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new FinanceRequestValidationError(`${fieldName}은(는) true 또는 false여야 합니다.`);
}

function parsePageInteger(value, fieldName, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value) || !/^\d+$/.test(String(value).trim())) {
    throw new FinanceRequestValidationError(`${fieldName}은(는) 정수여야 합니다.`);
  }
  const parsed = Number(String(value).trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new FinanceRequestValidationError(`${fieldName} 범위가 올바르지 않습니다.`);
  }
  return parsed;
}

function queryAlias(query, camelName, snakeName) {
  const camelValue = query?.[camelName];
  const snakeValue = query?.[snakeName];
  if (camelValue !== undefined && snakeValue !== undefined
      && JSON.stringify(camelValue) !== JSON.stringify(snakeValue)) {
    throw new FinanceRequestValidationError(`${camelName}과 ${snakeName} 값을 동시에 다르게 지정할 수 없습니다.`);
  }
  return camelValue !== undefined ? camelValue : snakeValue;
}

function reconcileRefundTerminalInvoice(current, requestStatus, invoiceRequested, invoiceStatus, {
  invoiceFieldsSupplied = false,
} = {}) {
  const result = {
    invoiceRequested,
    invoiceStatus,
    invoiceAutoCancelled: false,
    invoiceCancellationSkipped: false,
  };
  if (!REFUND_KIND_SET.has(current.kind) || !NEGATIVE_REQUEST_TERMINAL_STATUS_SET.has(requestStatus)) {
    assertTransition(current.invoice_status, invoiceStatus, INVOICE_STATUS_TRANSITIONS, '계산서 상태');
    return result;
  }

  if (PRESERVED_INVOICE_TERMINAL_STATUS_SET.has(current.invoice_status)) {
    if (invoiceFieldsSupplied
        && (invoiceStatus !== current.invoice_status || invoiceRequested !== true)) {
      throw new FinanceRequestConflictError(
        '이미 발행 또는 정정 완료된 계산서는 환불 요청 종료와 함께 변경할 수 없습니다.',
        'FINANCE_REQUEST_TERMINAL_INVOICE_CONFLICT',
      );
    }
    result.invoiceRequested = true;
    result.invoiceStatus = current.invoice_status;
    result.invoiceCancellationSkipped = true;
    return result;
  }

  if (PRESERVED_INVOICE_TERMINAL_STATUS_SET.has(invoiceStatus)) {
    throw new FinanceRequestConflictError(
      '환불 요청을 반려 또는 취소하면서 계산서를 새로 발행 완료 처리할 수 없습니다.',
      'FINANCE_REQUEST_TERMINAL_INVOICE_CONFLICT',
    );
  }

  if (invoiceFieldsSupplied && !['NOT_REQUESTED', 'CANCELLED'].includes(invoiceStatus)) {
    throw new FinanceRequestConflictError(
      '환불 요청을 반려 또는 취소하면서 처리 중인 계산서 상태를 지정할 수 없습니다.',
      'FINANCE_REQUEST_TERMINAL_INVOICE_CONFLICT',
    );
  }

  const hasInvoiceWorkflow = current.invoice_requested === true
    || invoiceRequested === true
    || current.invoice_status !== 'NOT_REQUESTED'
    || invoiceStatus !== 'NOT_REQUESTED';
  if (!hasInvoiceWorkflow) {
    result.invoiceRequested = false;
    result.invoiceStatus = 'NOT_REQUESTED';
    return result;
  }

  assertTransition(current.invoice_status, 'CANCELLED', INVOICE_STATUS_TRANSITIONS, '계산서 상태');
  result.invoiceRequested = true;
  result.invoiceStatus = 'CANCELLED';
  result.invoiceAutoCancelled = current.invoice_status !== 'CANCELLED';
  return result;
}

function assertTerminalInvoiceConsistency(kind, requestStatus, invoiceRequested, invoiceStatus) {
  if ((invoiceRequested === false) !== (invoiceStatus === 'NOT_REQUESTED')) {
    throw new FinanceRequestConflictError(
      '계산서 요청 여부와 계산서 상태가 일치하지 않습니다.',
      'FINANCE_REQUEST_INVOICE_STATE_CONFLICT',
    );
  }
  if (!REFUND_KIND_SET.has(kind) || !NEGATIVE_REQUEST_TERMINAL_STATUS_SET.has(requestStatus)) return;
  const allowed = invoiceStatus === 'NOT_REQUESTED'
    || invoiceStatus === 'CANCELLED'
    || PRESERVED_INVOICE_TERMINAL_STATUS_SET.has(invoiceStatus);
  if (!allowed) {
    throw new FinanceRequestConflictError(
      '종료된 환불 요청에 처리 중인 계산서 상태를 남길 수 없습니다.',
      'FINANCE_REQUEST_TERMINAL_INVOICE_CONFLICT',
    );
  }
}

async function insertPayeeAccountReadAudit(pool, rows, actor, metadata) {
  const requestIds = rows
    .filter(row => row.payee_account_ciphertext)
    .map(row => String(row.id));
  if (!requestIds.length) return;
  await pool.query(
    `INSERT INTO peakos_finance_request_events
      (request_id, event_type, actor_uid, actor_name, note, metadata)
     SELECT request_id, 'FINANCE_REQUEST_PAYEE_ACCOUNT_VIEWED', $2, $3, '', $4::jsonb
       FROM unnest($1::text[]) AS requested(request_id)`,
    [requestIds, actor.uid, actor.name, JSON.stringify(metadata || {})],
  );
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function parseOptionalPlatformKey(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim();
  if (!PLATFORM_KEY_PATTERN.test(normalized)) {
    throw new FinanceRequestValidationError('플랫폼 식별자가 올바르지 않습니다.');
  }
  return normalized;
}

function parseOptionalExternalDocumentId(value) {
  if (value === null || value === undefined || value === '') return null;
  return validateText(String(value), '외부 문서 식별자', 240);
}

function assertTransition(current, next, transitions, fieldName) {
  if (current === next) return;
  if (!transitions[current]?.has(next)) {
    throw new FinanceRequestConflictError(`${fieldName}을(를) ${current}에서 ${next}(으)로 바꿀 수 없습니다.`);
  }
}

function normalizeOperatorPatch(body, current) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new FinanceRequestValidationError('처리할 금융 요청 내용이 필요합니다.');
  }
  const suppliedKeys = [
    'status', 'invoiceRequested', 'invoiceStatus', 'processingNote',
    'invoiceEvidenceUrl', 'sourceAccountId', 'platformKey',
    'externalDocumentId', 'bankTransactionId',
  ];
  if (!suppliedKeys.some(key => hasOwn(body, key))) {
    throw new FinanceRequestValidationError('변경할 처리 상태나 계산서 정보가 없습니다.');
  }

  const status = hasOwn(body, 'status') ? String(body.status).trim().toUpperCase() : current.status;
  if (!FINANCE_REQUEST_STATUS_SET.has(status)) {
    throw new FinanceRequestValidationError('처리 상태가 올바르지 않습니다.');
  }
  assertTransition(current.status, status, REQUEST_STATUS_TRANSITIONS, '처리 상태');

  let invoiceRequested = current.invoice_requested === true;
  let invoiceStatus = current.invoice_status;
  const invoiceFieldsSupplied = hasOwn(body, 'invoiceRequested') || hasOwn(body, 'invoiceStatus');
  if (hasOwn(body, 'invoiceRequested')) {
    invoiceRequested = parseBoolean(body.invoiceRequested, '계산서 요청');
    invoiceStatus = invoiceRequested ? (invoiceStatus === 'NOT_REQUESTED' ? 'REQUESTED' : invoiceStatus) : 'NOT_REQUESTED';
  }
  if (hasOwn(body, 'invoiceStatus')) {
    invoiceStatus = String(body.invoiceStatus).trim().toUpperCase();
    if (!FINANCE_INVOICE_STATUS_SET.has(invoiceStatus)) {
      throw new FinanceRequestValidationError('계산서 상태가 올바르지 않습니다.');
    }
    invoiceRequested = invoiceStatus !== 'NOT_REQUESTED';
  }
  const reconciledInvoice = reconcileRefundTerminalInvoice(
    current,
    status,
    invoiceRequested,
    invoiceStatus,
    { invoiceFieldsSupplied },
  );
  invoiceRequested = reconciledInvoice.invoiceRequested;
  invoiceStatus = reconciledInvoice.invoiceStatus;
  assertTerminalInvoiceConsistency(current.kind, status, invoiceRequested, invoiceStatus);

  const processingNote = hasOwn(body, 'processingNote')
    ? validateText(body.processingNote ?? '', '처리 메모', 2000, { optional: true })
    : String(current.processing_note || '');
  const invoiceEvidenceUrl = hasOwn(body, 'invoiceEvidenceUrl')
    ? validateUrl(body.invoiceEvidenceUrl ?? '', '계산서 증빙', { optional: true })
    : String(current.invoice_evidence_url || '');
  const sourceAccountId = hasOwn(body, 'sourceAccountId')
    ? normalizeSourceAccountId(body.sourceAccountId, { allowRestricted: true })
    : (current.source_account_id || null);
  const platformKey = hasOwn(body, 'platformKey')
    ? parseOptionalPlatformKey(body.platformKey)
    : (current.platform_key || null);
  const externalDocumentId = hasOwn(body, 'externalDocumentId')
    ? parseOptionalExternalDocumentId(body.externalDocumentId)
    : (current.external_document_id || null);
  if (externalDocumentId && !platformKey) {
    throw new FinanceRequestValidationError('외부 문서 식별자에는 플랫폼 식별자가 필요합니다.');
  }
  const bankTransactionId = hasOwn(body, 'bankTransactionId')
    ? parseOptionalBankTransactionId(body.bankTransactionId)
    : (current.bank_transaction_id === null || current.bank_transaction_id === undefined
      ? null
      : String(current.bank_transaction_id));

  return {
    status,
    invoiceRequested,
    invoiceStatus,
    processingNote,
    invoiceEvidenceUrl,
    sourceAccountId,
    platformKey,
    externalDocumentId,
    bankTransactionId,
    invoiceAutoCancelled: reconciledInvoice.invoiceAutoCancelled,
    invoiceCancellationSkipped: reconciledInvoice.invoiceCancellationSkipped,
  };
}

function registerPeakosFinanceRequests({
  app,
  authMiddleware,
  pool,
  canReview,
  getActor,
  encryptionSecret,
  logger = console,
}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
      || typeof app.patch !== 'function' || typeof app.delete !== 'function') {
    throw new TypeError('Express app의 get/post/patch/delete가 필요합니다.');
  }
  if (typeof authMiddleware !== 'function') throw new TypeError('authMiddleware가 필요합니다.');
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('pool.query와 pool.connect가 필요합니다.');
  }
  const reviewAllowed = typeof canReview === 'function' ? canReview : () => false;
  const actorOf = typeof getActor === 'function'
    ? getActor
    : req => ({ uid: req.uid, name: req.userDoc?.name || '' });
  const encryptionKey = deriveEncryptionKey(encryptionSecret);

  app.get('/api/peakos/finance-requests', authMiddleware, async (req, res) => {
    if (!approvedAndActive(req)) {
      return res.status(403).json({ error: '승인된 사용자만 금융 요청을 볼 수 있습니다.' });
    }
    try {
      const scope = String(req.query?.scope || 'mine').trim();
      if (!['mine', 'all'].includes(scope)) {
        throw new FinanceRequestValidationError('scope는 mine 또는 all이어야 합니다.');
      }
      const reviewer = reviewAllowed(req) === true;
      if (scope === 'all' && !reviewer) {
        return res.status(403).json({ error: '전체 금융 요청 검토 권한이 없습니다.' });
      }
      const kinds = parseMultiListFilter(req.query?.kind, FINANCE_REQUEST_KIND_SET, 'kind');
      const statuses = parseMultiListFilter(req.query?.status, FINANCE_REQUEST_STATUS_SET, 'status');
      const excludedStatuses = parseMultiListFilter(
        queryAlias(req.query, 'excludeStatus', 'exclude_status'),
        FINANCE_REQUEST_STATUS_SET,
        'excludeStatus',
      );
      if (statuses.some(status => excludedStatuses.includes(status))) {
        throw new FinanceRequestValidationError('status와 excludeStatus에 같은 상태를 지정할 수 없습니다.');
      }
      const invoiceRequested = parseQueryBoolean(
        queryAlias(req.query, 'invoiceRequested', 'invoice_requested'),
        'invoiceRequested',
      );
      const from = req.query?.from ? parseRequestDate(req.query.from) : '';
      const to = req.query?.to ? parseRequestDate(req.query.to) : '';
      if (from && to && from > to) {
        throw new FinanceRequestValidationError('종료일은 시작일과 같거나 뒤여야 합니다.');
      }
      const limit = parsePageInteger(req.query?.limit, 'limit', DEFAULT_LIST_ROWS, MAX_LIST_ROWS);
      const page = parsePageInteger(req.query?.page, 'page', 1, MAX_LIST_PAGE);
      const offset = (page - 1) * limit;
      const values = [];
      const where = [];
      if (scope === 'mine') {
        values.push(String(req.uid));
        where.push(`requester_uid = $${values.length}`);
      }
      if (kinds.length) {
        values.push(kinds);
        where.push(`kind = ANY($${values.length}::text[])`);
      }
      if (statuses.length) {
        values.push(statuses);
        where.push(`status = ANY($${values.length}::text[])`);
      }
      if (excludedStatuses.length) {
        values.push(excludedStatuses);
        where.push(`NOT (status = ANY($${values.length}::text[]))`);
      }
      if (invoiceRequested !== null) {
        values.push(invoiceRequested);
        where.push(`invoice_requested = $${values.length}`);
      }
      if (from) {
        values.push(from);
        where.push(`request_date >= $${values.length}::date`);
      }
      if (to) {
        values.push(to);
        where.push(`request_date <= $${values.length}::date`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [result, countResult] = await Promise.all([
        pool.query(
        `SELECT ${REQUEST_COLUMNS}
           FROM peakos_finance_requests
          ${whereSql}
          ORDER BY request_date DESC, created_at DESC, id DESC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, limit, offset],
        ),
        pool.query(
          `SELECT COUNT(*)::bigint AS total
             FROM peakos_finance_requests
            ${whereSql}`,
          values,
        ),
      ]);
      const revealPayeeAccount = scope === 'all' && reviewer;
      const total = Number(countResult.rows[0]?.total || 0);
      if (!Number.isSafeInteger(total) || total < 0) {
        throw new Error('금융 요청 전체 건수 형식이 올바르지 않습니다.');
      }
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      if (revealPayeeAccount) {
        const actor = normalizeActor(actorOf(req));
        await insertPayeeAccountReadAudit(pool, result.rows, actor, {
          scope,
          page,
          limit,
          from: from || null,
          to: to || null,
          kinds,
        });
      }
      const pagination = {
        page,
        limit,
        total,
        totalPages,
        total_pages: totalPages,
      };
      res.set?.('Cache-Control', 'no-store');
      return res.json({
        requests: result.rows.map(row => publicFinanceRequest(row, { encryptionKey, revealPayeeAccount })),
        scope,
        pagination,
        filters: {
          from: from || null,
          to: to || null,
          kinds,
          invoiceRequested,
          invoice_requested: invoiceRequested,
          excludedStatuses,
          excluded_statuses: excludedStatuses,
        },
        truncated: offset + result.rows.length < total,
      });
    } catch (error) {
      return sendError(res, error, '금융 요청을 불러오지 못했습니다.', logger, 'finance request read failed');
    }
  });

  app.get('/api/peakos/finance-requests/:id/events', authMiddleware, async (req, res) => {
    if (!approvedAndActive(req)) {
      return res.status(403).json({ error: '승인된 사용자만 금융 요청 이력을 볼 수 있습니다.' });
    }
    try {
      const id = String(req.params?.id || '').trim();
      if (!UUID_PATTERN.test(id)) throw new FinanceRequestValidationError('금융 요청 ID가 올바르지 않습니다.');
      const owner = await pool.query('SELECT requester_uid FROM peakos_finance_requests WHERE id = $1', [id]);
      if (!owner.rows[0]) return res.status(404).json({ error: '금융 요청을 찾지 못했습니다.' });
      if (owner.rows[0].requester_uid !== String(req.uid) && reviewAllowed(req) !== true) {
        return res.status(403).json({ error: '다른 사용자의 금융 요청 이력을 볼 수 없습니다.' });
      }
      const events = await pool.query(
        `SELECT id, request_id, event_type, actor_uid, actor_name, from_status,
                to_status, from_invoice_status, to_invoice_status, note,
                metadata, created_at
           FROM peakos_finance_request_events
          WHERE request_id = $1
          ORDER BY created_at, id`,
        [id],
      );
      res.set?.('Cache-Control', 'no-store');
      return res.json({
        events: events.rows.map(row => ({
          id: String(row.id),
          requestId: row.request_id,
          eventType: row.event_type,
          actorUid: row.actor_uid,
          actorName: row.actor_name,
          fromStatus: row.from_status || null,
          toStatus: row.to_status || null,
          fromInvoiceStatus: row.from_invoice_status || null,
          toInvoiceStatus: row.to_invoice_status || null,
          note: row.note || '',
          metadata: row.metadata || {},
          createdAt: row.created_at,
        })),
      });
    } catch (error) {
      return sendError(res, error, '금융 요청 이력을 불러오지 못했습니다.', logger, 'finance request event read failed');
    }
  });

  app.post('/api/peakos/finance-requests', authMiddleware, async (req, res) => {
    if (!approvedAndActive(req)) {
      return res.status(403).json({ error: '승인된 사용자만 금융 요청을 등록할 수 있습니다.' });
    }
    let client;
    try {
      const reviewer = reviewAllowed(req) === true;
      const input = normalizeCreateInput(req.body, { allowRestrictedSource: reviewer });
      const actor = normalizeActor(actorOf(req));
      const idempotencyKey = parseIdempotencyKey(req);
      const id = crypto.randomUUID();
      const encrypted = encryptPayeeAccount(input.payeeAccount, encryptionKey, id);
      client = await pool.connect();
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO peakos_finance_requests
          (id, requester_uid, requester_name, kind, request_date, client_name,
           detail, amount_vat, business_registration_url, email, payee_bank,
           payee_account_ciphertext, payee_account_iv, payee_account_auth_tag,
           payee_account_encryption_version, payee_name, reason,
           invoice_requested, invoice_status, evidence_url, invoice_evidence_url,
           source_account_id, status, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 $17,$18,$19,$20,$21,$22,'PENDING',$23)
         ON CONFLICT DO NOTHING
         RETURNING ${REQUEST_COLUMNS}`,
        [
          id,
          actor.uid,
          actor.name,
          input.kind,
          input.requestDate,
          input.clientName,
          input.detail,
          input.amountVat,
          input.businessRegistrationUrl,
          input.email,
          input.payeeBank,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.version,
          input.payeeName,
          input.reason,
          input.invoiceRequested,
          input.invoiceStatus,
          input.evidenceUrl,
          input.invoiceEvidenceUrl,
          input.sourceAccountId,
          idempotencyKey,
        ],
      );
      let row = inserted.rows[0];
      let created = true;
      if (row) {
        await insertEvent(client, {
          requestId: row.id,
          eventType: 'FINANCE_REQUEST_CREATED',
          actor,
          toStatus: 'PENDING',
          toInvoiceStatus: input.invoiceStatus,
          metadata: {
            kind: input.kind,
            amountVat: input.amountVat,
            sourceAccountId: input.sourceAccountId,
            invoiceRequested: input.invoiceRequested,
          },
        });
      } else {
        if (!idempotencyKey) {
          throw new FinanceRequestConflictError('금융 요청 식별자를 만들지 못했습니다. 다시 시도해 주세요.');
        }
        const existing = await client.query(
          `SELECT ${REQUEST_COLUMNS}
             FROM peakos_finance_requests
            WHERE requester_uid = $1 AND idempotency_key = $2
            FOR UPDATE`,
          [actor.uid, idempotencyKey],
        );
        row = existing.rows[0];
        if (!row || !sameCreatePayload(row, input, encryptionKey)) {
          throw new FinanceRequestConflictError(
            '같은 Idempotency-Key가 다른 금융 요청에 이미 사용되었습니다.',
            'FINANCE_REQUEST_IDEMPOTENCY_CONFLICT',
          );
        }
        created = false;
      }
      await client.query('COMMIT');
      res.set?.('Cache-Control', 'no-store');
      res.set?.('Location', `/api/peakos/finance-requests/${row.id}`);
      return res.status(created ? 201 : 200).json({
        request: publicFinanceRequest(row, { encryptionKey, revealPayeeAccount: false }),
        created,
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error, '금융 요청을 저장하지 못했습니다.', logger, 'finance request create failed');
    } finally {
      client?.release?.();
    }
  });

  app.patch('/api/peakos/finance-requests/:id', authMiddleware, async (req, res) => {
    if (!approvedAndActive(req) || reviewAllowed(req) !== true) {
      return res.status(403).json({ error: '금융 요청 처리 권한이 없습니다.' });
    }
    let client;
    try {
      const id = String(req.params?.id || '').trim();
      if (!UUID_PATTERN.test(id)) throw new FinanceRequestValidationError('금융 요청 ID가 올바르지 않습니다.');
      const actor = normalizeActor(actorOf(req));
      client = await pool.connect();
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT ${REQUEST_COLUMNS} FROM peakos_finance_requests WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const current = existing.rows[0];
      if (!current) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: '금융 요청을 찾지 못했습니다.' });
      }
      const patch = normalizeOperatorPatch(req.body, current);

      if (patch.bankTransactionId) {
        const transaction = await client.query(
          `SELECT id, account_id
             FROM peakos_bank_transactions
            WHERE id = $1
            FOR SHARE`,
          [patch.bankTransactionId],
        );
        if (!transaction.rows[0]) {
          throw new FinanceRequestConflictError('연결할 통장 거래를 찾지 못했습니다.');
        }
        if (patch.sourceAccountId && transaction.rows[0].account_id !== patch.sourceAccountId) {
          throw new FinanceRequestConflictError('선택한 출금 통장과 연결 거래의 통장이 다릅니다.');
        }
        if (!patch.sourceAccountId) patch.sourceAccountId = transaction.rows[0].account_id;
      }

      const cancelledAtSql = patch.status === 'CANCELLED' ? 'NOW()' : 'NULL';
      const updated = await client.query(
        `UPDATE peakos_finance_requests
            SET status = $2,
                invoice_requested = $3,
                invoice_status = $4,
                processing_note = $5,
                invoice_evidence_url = $6,
                source_account_id = $7,
                platform_key = $8,
                external_document_id = $9,
                bank_transaction_id = $10,
                processed_by_uid = $11,
                processed_by_name = $12,
                processed_at = CASE
                  WHEN $2 IN ('COMPLETED', 'REJECTED', 'CANCELLED')
                    THEN COALESCE(processed_at, NOW())
                  ELSE processed_at
                END,
                cancelled_at = ${cancelledAtSql},
                updated_at = NOW()
          WHERE id = $1
        RETURNING ${REQUEST_COLUMNS}`,
        [
          id,
          patch.status,
          patch.invoiceRequested,
          patch.invoiceStatus,
          patch.processingNote,
          patch.invoiceEvidenceUrl,
          patch.sourceAccountId,
          patch.platformKey,
          patch.externalDocumentId,
          patch.bankTransactionId,
          actor.uid,
          actor.name,
        ],
      );
      const row = updated.rows[0];
      await insertEvent(client, {
        requestId: id,
        eventType: 'FINANCE_REQUEST_PROCESSED',
        actor,
        fromStatus: current.status,
        toStatus: row.status,
        fromInvoiceStatus: current.invoice_status,
        toInvoiceStatus: row.invoice_status,
        note: patch.processingNote,
        metadata: {
          sourceAccountId: patch.sourceAccountId,
          platformKey: patch.platformKey,
          hasExternalDocument: Boolean(patch.externalDocumentId),
          hasBankTransaction: Boolean(patch.bankTransactionId),
          invoiceAutoCancelled: patch.invoiceAutoCancelled,
          invoiceCancellationSkipped: patch.invoiceCancellationSkipped,
        },
      });
      await client.query('COMMIT');
      res.set?.('Cache-Control', 'no-store');
      return res.json({ request: publicFinanceRequest(row, { encryptionKey, revealPayeeAccount: false }) });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error, '금융 요청 처리 상태를 저장하지 못했습니다.', logger, 'finance request patch failed');
    } finally {
      client?.release?.();
    }
  });

  app.delete('/api/peakos/finance-requests/:id', authMiddleware, async (req, res) => {
    if (!approvedAndActive(req)) {
      return res.status(403).json({ error: '승인된 사용자만 금융 요청을 취소할 수 있습니다.' });
    }
    let client;
    try {
      const id = String(req.params?.id || '').trim();
      if (!UUID_PATTERN.test(id)) throw new FinanceRequestValidationError('금융 요청 ID가 올바르지 않습니다.');
      const actor = normalizeActor(actorOf(req));
      const reviewer = reviewAllowed(req) === true;
      const note = validateText(req.body?.reason ?? '', '취소 사유', 2000, { optional: true });
      client = await pool.connect();
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT ${REQUEST_COLUMNS} FROM peakos_finance_requests WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const current = existing.rows[0];
      if (!current) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: '금융 요청을 찾지 못했습니다.' });
      }
      if (!reviewer && current.requester_uid !== String(req.uid)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: '다른 사용자의 금융 요청은 취소할 수 없습니다.' });
      }
      if (current.status !== 'PENDING') {
        throw new FinanceRequestConflictError('대기 중인 금융 요청만 취소할 수 있습니다.');
      }
      const reconciledInvoice = reconcileRefundTerminalInvoice(
        current,
        'CANCELLED',
        current.invoice_requested === true,
        current.invoice_status,
      );
      assertTerminalInvoiceConsistency(
        current.kind,
        'CANCELLED',
        reconciledInvoice.invoiceRequested,
        reconciledInvoice.invoiceStatus,
      );
      const cancelled = await client.query(
        `UPDATE peakos_finance_requests
            SET status = 'CANCELLED',
                invoice_requested = $2,
                invoice_status = $3,
                cancelled_at = NOW(),
                updated_at = NOW()
          WHERE id = $1 AND status = 'PENDING'
        RETURNING ${REQUEST_COLUMNS}`,
        [id, reconciledInvoice.invoiceRequested, reconciledInvoice.invoiceStatus],
      );
      if (!cancelled.rows[0]) {
        throw new FinanceRequestConflictError('금융 요청 상태가 이미 변경되었습니다.');
      }
      await insertEvent(client, {
        requestId: id,
        eventType: 'FINANCE_REQUEST_CANCELLED',
        actor,
        fromStatus: 'PENDING',
        toStatus: 'CANCELLED',
        fromInvoiceStatus: current.invoice_status,
        toInvoiceStatus: cancelled.rows[0].invoice_status,
        note,
        metadata: {
          invoiceAutoCancelled: reconciledInvoice.invoiceAutoCancelled,
          invoiceCancellationSkipped: reconciledInvoice.invoiceCancellationSkipped,
        },
      });
      await client.query('COMMIT');
      res.set?.('Cache-Control', 'no-store');
      return res.json({
        request: publicFinanceRequest(cancelled.rows[0], { encryptionKey, revealPayeeAccount: false }),
        cancelled: id,
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error, '금융 요청을 취소하지 못했습니다.', logger, 'finance request cancel failed');
    } finally {
      client?.release?.();
    }
  });
}

module.exports = {
  FINANCE_INVOICE_STATUSES,
  FINANCE_REQUEST_KINDS,
  FINANCE_REQUEST_STATUSES,
  SOURCE_ACCOUNT_IDS,
  FinanceRequestConflictError,
  FinanceRequestForbiddenError,
  FinanceRequestValidationError,
  decryptPayeeAccount,
  deriveEncryptionKey,
  encryptPayeeAccount,
  ensurePeakosFinanceRequestInfrastructure,
  maskPayeeAccount,
  normalizeCreateInput,
  normalizeOperatorPatch,
  publicFinanceRequest,
  registerPeakosFinanceRequests,
};
