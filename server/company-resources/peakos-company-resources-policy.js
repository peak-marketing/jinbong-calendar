'use strict';

const WORKSPACE_ID_PATTERN = /^ws_[a-z0-9_]{1,60}$/;
const UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOCUMENT_CATEGORIES = Object.freeze([
  'BANK_COPY',
  'COMPANY_MATERIAL',
  'DEVELOPMENT_COST_EVIDENCE',
]);
const COMPANY_RESOURCE_SCOPES = Object.freeze([
  'EQUIPMENT_USAGE',
  'DEVELOPMENT_COST',
  'PROTECTED_DOCUMENT',
]);

class CompanyResourceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'CompanyResourceError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new CompanyResourceError(status, code, message);
}

function header(req, name) {
  return typeof req?.get === 'function'
    ? req.get(name)
    : req?.headers?.[String(name).toLowerCase()];
}

function requestIsPreview(req) {
  return /^(?:1|true|yes|on)$/i.test(String(header(req, 'x-peakos-preview') || '').trim())
    || Boolean(header(req, 'x-peakos-preview-persona') || header(req, 'x-peakos-preview-owner'));
}

function normalizeWorkspaceId(req) {
  const workspaceId = String(req?.workspace?.id || '').trim();
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    fail(403, 'COMPANY_RESOURCE_WORKSPACE_REQUIRED', '선택한 워크스페이스를 확인할 수 없습니다.');
  }
  return workspaceId;
}

function normalizeUid(value, code = 'COMPANY_RESOURCE_ACCOUNT_INVALID') {
  const uid = String(value || '').trim();
  if (!UID_PATTERN.test(uid)) fail(401, code, '로그인 계정을 확인할 수 없습니다.');
  return uid;
}

function normalizeUuid(value, code = 'COMPANY_RESOURCE_ID_INVALID') {
  const id = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) fail(400, code, '자료 식별자가 올바르지 않습니다.');
  return id;
}

function approvedActive(req) {
  return Boolean(req?.uid
    && req?.userDoc?.approved === true
    && req?.userDoc?.is_active !== false
    && req?.userDoc?.chat_only !== true
    && req?.userDoc?.external_calendar_only !== true);
}

function normalizePermissions(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function loadCompanyResourceAccess({
  client,
  req,
  mode = 'read',
  resource = 'PROTECTED_DOCUMENT',
  canSeeFinanceOperations = () => false,
  canReviewFinance = () => false,
} = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('client.query가 필요합니다.');
  if (!['read', 'write'].includes(mode)) throw new TypeError('mode는 read 또는 write여야 합니다.');
  if (!COMPANY_RESOURCE_SCOPES.includes(resource)) throw new TypeError('회사 자료 권한 구분이 올바르지 않습니다.');
  if (!approvedActive(req)) {
    fail(403, 'COMPANY_RESOURCE_ACCOUNT_RESTRICTED', '승인된 일반 계정만 회사 자료를 사용할 수 있습니다.');
  }
  if (requestIsPreview(req)) {
    fail(403, 'COMPANY_RESOURCE_PREVIEW_FORBIDDEN', '계정 미리보기에서는 회사 자료를 사용할 수 없습니다.');
  }
  const workspaceId = normalizeWorkspaceId(req);
  const uid = normalizeUid(req.uid);
  const membershipResult = await client.query(
    `SELECT role, permissions
       FROM peakos_workspace_memberships
      WHERE workspace_id = $1 AND user_uid = $2 AND active = TRUE`,
    [workspaceId, uid],
  );
  const membership = membershipResult.rows[0];
  if (!membership || membership.role === 'oversight') {
    fail(403, 'COMPANY_RESOURCE_DIRECT_MEMBERSHIP_REQUIRED', '선택 조직의 직접 구성원만 회사 자료를 사용할 수 있습니다.');
  }
  const permissions = normalizePermissions(membership.permissions);
  if (!['read', 'write'].includes(String(permissions.documents || ''))) {
    fail(403, 'COMPANY_RESOURCE_DOCUMENT_PERMISSION_REQUIRED', '선택 조직의 회사 자료 권한이 필요합니다.');
  }
  if (mode === 'write' && permissions.documents !== 'write') {
    fail(403, 'COMPANY_RESOURCE_DOCUMENT_WRITE_PERMISSION_REQUIRED', '선택 조직의 회사 자료 쓰기 권한이 필요합니다.');
  }
  const isAdmin = membership.role === 'admin';
  const financeRead = Boolean(canSeeFinanceOperations(req));
  const financeWrite = Boolean(canReviewFinance(req));
  // The user-provided access contract is category-specific: the five finance
  // operation viewers may read equipment usage, while development cost and
  // every protected document stay within the four finance operators. A
  // workspace role (including admin) must never widen these UID capabilities.
  const canReadResource = resource === 'EQUIPMENT_USAGE'
    ? (financeRead || financeWrite)
    : financeWrite;
  if (mode === 'read' && !canReadResource) {
    fail(403, 'COMPANY_RESOURCE_READ_FORBIDDEN', '회사 자료 열람 권한이 없습니다.');
  }
  if (mode === 'write' && !financeWrite) {
    fail(403, 'COMPANY_RESOURCE_WRITE_FORBIDDEN', '회사 자료 변경은 서버에서 지정한 재무 담당자만 할 수 있습니다.');
  }
  return Object.freeze({
    workspaceId,
    uid,
    role: String(membership.role),
    permissions: Object.freeze({ ...permissions }),
    isAdmin,
    financeRead,
    financeWrite,
  });
}

function strictObject(value, allowedKeys, code = 'COMPANY_RESOURCE_BODY_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(400, code, '요청 형식이 올바르지 않습니다.');
  }
  if (Object.keys(value).some(key => !allowedKeys.includes(key))) {
    fail(400, 'COMPANY_RESOURCE_FIELDS_NOT_ALLOWED', '허용되지 않은 요청 항목이 있습니다.');
  }
  return value;
}

function cleanText(value, {
  field = '내용', minimum = 0, maximum = 500, required = minimum > 0,
} = {}) {
  if (value === undefined || value === null) {
    if (required) fail(400, 'COMPANY_RESOURCE_TEXT_REQUIRED', `${field}을(를) 입력해 주세요.`);
    return '';
  }
  if (typeof value !== 'string') fail(400, 'COMPANY_RESOURCE_TEXT_INVALID', `${field} 형식이 올바르지 않습니다.`);
  const text = value
    .normalize('NFKC')
    .replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length < minimum || text.length > maximum) {
    fail(400, 'COMPANY_RESOURCE_TEXT_LENGTH_INVALID', `${field}은(는) ${minimum}~${maximum}자여야 합니다.`);
  }
  return text;
}

function strictDate(value, field = '날짜') {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    fail(400, 'COMPANY_RESOURCE_DATE_INVALID', `${field} 형식이 올바르지 않습니다.`);
  }
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    fail(400, 'COMPANY_RESOURCE_DATE_INVALID', `${field} 값이 올바르지 않습니다.`);
  }
  return text;
}

function positiveInteger(value, {
  field = '수량', maximum = Number.MAX_SAFE_INTEGER,
} = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    fail(400, 'COMPANY_RESOURCE_INTEGER_INVALID', `${field}은(는) 1 이상의 정수여야 합니다.`);
  }
  return number;
}

function expectedVersion(value) {
  return positiveInteger(value, { field: '예상 버전', maximum: Number.MAX_SAFE_INTEGER });
}

function normalizeCategory(value) {
  const category = String(value || '').trim().toUpperCase();
  if (!DOCUMENT_CATEGORIES.includes(category)) {
    fail(400, 'COMPANY_RESOURCE_CATEGORY_INVALID', '회사 자료 구분이 올바르지 않습니다.');
  }
  return category;
}

function normalizeEquipmentCreate(body) {
  const value = strictObject(body, ['usedOn', 'itemName', 'purpose', 'quantity', 'usedByUid', 'memo']);
  return Object.freeze({
    usedOn: strictDate(value.usedOn, '사용일'),
    itemName: cleanText(value.itemName, { field: '비품명', minimum: 1, maximum: 160 }),
    purpose: cleanText(value.purpose, { field: '사용 목적', minimum: 2, maximum: 500 }),
    quantity: positiveInteger(value.quantity, { field: '사용 수량', maximum: 100000 }),
    usedByUid: value.usedByUid === undefined ? null : normalizeUid(value.usedByUid, 'COMPANY_RESOURCE_USER_INVALID'),
    memo: cleanText(value.memo, { field: '메모', minimum: 0, maximum: 500, required: false }),
  });
}

function normalizeDevelopmentCostCreate(body) {
  const value = strictObject(body, ['spentOn', 'title', 'vendor', 'amountKrw', 'memo', 'evidenceDocumentId']);
  return Object.freeze({
    spentOn: strictDate(value.spentOn, '지출일'),
    title: cleanText(value.title, { field: '개발비 항목', minimum: 2, maximum: 180 }),
    vendor: cleanText(value.vendor, { field: '지급처', minimum: 1, maximum: 160 }),
    amountKrw: positiveInteger(value.amountKrw, { field: '개발비', maximum: 1_000_000_000_000 }),
    memo: cleanText(value.memo, { field: '메모', minimum: 0, maximum: 1000, required: false }),
    evidenceDocumentId: normalizeUuid(value.evidenceDocumentId, 'COMPANY_RESOURCE_EVIDENCE_ID_INVALID'),
  });
}

function normalizeVoid(body) {
  const value = strictObject(body, ['expectedVersion', 'reason']);
  return Object.freeze({
    expectedVersion: expectedVersion(value.expectedVersion),
    reason: cleanText(value.reason, { field: '취소 사유', minimum: 2, maximum: 500 }),
  });
}

function normalizeDocumentUpload(body) {
  const value = strictObject(body || {}, ['category', 'title', 'replacesDocumentId', 'expectedVersion']);
  const replacesDocumentId = value.replacesDocumentId
    ? normalizeUuid(value.replacesDocumentId, 'COMPANY_RESOURCE_REPLACED_ID_INVALID')
    : null;
  if (replacesDocumentId && value.expectedVersion === undefined) {
    fail(400, 'COMPANY_RESOURCE_EXPECTED_VERSION_REQUIRED', '새 버전 등록에는 기존 자료 버전이 필요합니다.');
  }
  if (!replacesDocumentId && value.expectedVersion !== undefined) {
    fail(400, 'COMPANY_RESOURCE_REPLACED_ID_REQUIRED', '예상 버전과 교체할 자료를 함께 입력해 주세요.');
  }
  return Object.freeze({
    category: normalizeCategory(value.category),
    title: cleanText(value.title, { field: '자료명', minimum: 1, maximum: 180 }),
    replacesDocumentId,
    expectedVersion: replacesDocumentId ? expectedVersion(value.expectedVersion) : null,
  });
}

module.exports = {
  COMPANY_RESOURCE_SCOPES,
  CompanyResourceError,
  DOCUMENT_CATEGORIES,
  UID_PATTERN,
  UUID_PATTERN,
  WORKSPACE_ID_PATTERN,
  approvedActive,
  cleanText,
  expectedVersion,
  loadCompanyResourceAccess,
  normalizeCategory,
  normalizeDevelopmentCostCreate,
  normalizeDocumentUpload,
  normalizeEquipmentCreate,
  normalizeUid,
  normalizeUuid,
  normalizeVoid,
  normalizeWorkspaceId,
  positiveInteger,
  requestIsPreview,
  strictDate,
  strictObject,
};
