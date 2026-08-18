'use strict';

const SALES_LEAD_STATUSES = Object.freeze(['new', 'contacted', 'follow_up', 'won', 'lost', 'do_not_call']);
const SALES_LEAD_CHANNELS = Object.freeze(['phone', 'field', 'online']);
const SALES_LEAD_SOURCES = Object.freeze(['manual', 'referral', 'inbound', 'other']);
const SALES_CALL_DISPOSITIONS = Object.freeze([
  'connected', 'no_answer', 'busy', 'callback', 'interested', 'won', 'lost', 'do_not_call',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

class SalesLeadHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'SalesLeadHttpError';
    this.status = status;
    this.code = code;
  }
}

function invalid(code, message, status = 400) {
  throw new SalesLeadHttpError(status, code, message);
}

function requestIsPreview(req) {
  const raw = typeof req?.get === 'function'
    ? req.get('x-peakos-preview')
    : req?.headers?.['x-peakos-preview'];
  return /^(?:1|true|yes|on)$/i.test(String(raw || '').trim());
}

function actorName(req) {
  return String(req?.userDoc?.name || req?.userName || req?.userEmail || '사용자')
    .trim().slice(0, 160) || '사용자';
}

function createSalesLeadContext(req) {
  if (req?.userDoc?.approved !== true || req?.userDoc?.is_active === false) {
    invalid('SALES_ACCOUNT_INACTIVE', '승인된 활성 계정만 영업 DB를 사용할 수 있습니다.', 403);
  }
  if (req?.userDoc?.chat_only === true || req?.userDoc?.external_calendar_only === true) {
    invalid('SALES_ACCOUNT_RESTRICTED', '채팅 전용 또는 외부 캘린더 전용 계정은 영업 DB를 사용할 수 없습니다.', 403);
  }
  const workspace = req?.workspace || {};
  if (!workspace.id) invalid('SALES_WORKSPACE_REQUIRED', '워크스페이스를 선택해 주세요.', 400);
  const uid = String(req?.uid || '').trim();
  if (!UID_PATTERN.test(uid)) invalid('SALES_ACCOUNT_INVALID', '로그인 계정을 확인할 수 없습니다.', 401);

  const isOversight = workspace.headquartersOversight === true || workspace.role === 'oversight';
  const isManager = !isOversight && ['admin', 'manager'].includes(String(workspace.role));
  const isSalesMember = !isOversight
    && workspace.role === 'member'
    && String(req.userDoc.group_type || '').trim() === 'sales';
  if (!isOversight && !isManager && !isSalesMember) {
    invalid('SALES_ROLE_FORBIDDEN', '영업 구성원 또는 선택 조직 관리자만 영업 DB를 사용할 수 있습니다.', 403);
  }
  return Object.freeze({
    uid,
    name: actorName(req),
    workspaceId: String(workspace.id),
    workspace,
    isOversight,
    isManager,
    isSalesMember,
    readOnly: isOversight,
    scope: isSalesMember ? 'own' : 'workspace',
    preview: requestIsPreview(req),
  });
}

function assertSalesWrite(context) {
  if (context.preview) invalid('SALES_PREVIEW_READ_ONLY', '계정 미리보기에서는 영업 DB를 변경할 수 없습니다.', 403);
  if (context.readOnly) invalid('SALES_OVERSIGHT_READ_ONLY', '본사 열람 권한으로 지사 영업 DB를 변경할 수 없습니다.', 403);
}

function normalizeStrictObject(value, allowedKeys, label = '요청') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('SALES_BODY_INVALID', `${label} 형식이 올바르지 않습니다.`);
  }
  if (Object.keys(value).some(key => !allowedKeys.includes(key))) {
    invalid('SALES_BODY_FIELD_INVALID', `${label}에 허용되지 않은 항목이 있습니다.`);
  }
  return value;
}

function normalizeUuid(value, field = 'ID') {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(id)) invalid('SALES_ID_INVALID', `${field}가 올바르지 않습니다.`);
  return id;
}

function normalizeUid(value, field = '사용자') {
  const uid = typeof value === 'string' ? value.trim() : '';
  if (!UID_PATTERN.test(uid)) invalid('SALES_UID_INVALID', `${field} 식별자가 올바르지 않습니다.`);
  return uid;
}

function normalizeText(value, { field = '내용', required = true, max = 4000 } = {}) {
  if (value === undefined || value === null) {
    if (!required) return '';
    invalid('SALES_TEXT_REQUIRED', `${field}을(를) 입력해 주세요.`);
  }
  if (typeof value !== 'string') invalid('SALES_TEXT_INVALID', `${field} 형식이 올바르지 않습니다.`);
  const text = value.trim();
  if (required && !text) invalid('SALES_TEXT_REQUIRED', `${field}을(를) 입력해 주세요.`);
  if (text.length > max) invalid('SALES_TEXT_TOO_LONG', `${field}은(는) ${max}자 이하여야 합니다.`);
  return text;
}

function normalizeEnum(value, values, field, { defaultValue, required = true } = {}) {
  const candidate = value === undefined ? defaultValue : value;
  if (!required && (candidate === null || candidate === '')) return null;
  const normalized = typeof candidate === 'string' ? candidate.trim() : '';
  if (!values.includes(normalized)) invalid('SALES_ENUM_INVALID', `${field} 값이 올바르지 않습니다.`);
  return normalized;
}

function normalizePhone(value) {
  if (typeof value !== 'string') invalid('SALES_PHONE_INVALID', '전화번호 형식이 올바르지 않습니다.');
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('82') && digits.length >= 10 && digits.length <= 13) digits = `0${digits.slice(2)}`;
  if (digits.length < 8 || digits.length > 15) invalid('SALES_PHONE_INVALID', '전화번호는 숫자 8~15자리여야 합니다.');
  return digits;
}

function normalizeTimestamp(value, { field = '일시', required = false, allowNull = true } = {}) {
  if (value === undefined) {
    if (required) invalid('SALES_TIME_REQUIRED', `${field}을(를) 입력해 주세요.`);
    return undefined;
  }
  if (value === null || value === '') {
    if (allowNull) return null;
    invalid('SALES_TIME_REQUIRED', `${field}을(를) 입력해 주세요.`);
  }
  if (typeof value !== 'string') invalid('SALES_TIME_INVALID', `${field} 형식이 올바르지 않습니다.`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) invalid('SALES_TIME_INVALID', `${field} 형식이 올바르지 않습니다.`);
  return new Date(millis).toISOString();
}

function normalizeExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
    invalid('SALES_VERSION_INVALID', 'expectedVersion이 올바르지 않습니다.');
  }
  return value;
}

function normalizeDuration(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 86400) {
    invalid('SALES_DURATION_INVALID', '통화 시간은 0~86400초여야 합니다.');
  }
  return value;
}

module.exports = {
  SALES_CALL_DISPOSITIONS,
  SALES_LEAD_CHANNELS,
  SALES_LEAD_SOURCES,
  SALES_LEAD_STATUSES,
  SalesLeadHttpError,
  actorName,
  assertSalesWrite,
  createSalesLeadContext,
  normalizeDuration,
  normalizeEnum,
  normalizeExpectedVersion,
  normalizePhone,
  normalizeStrictObject,
  normalizeText,
  normalizeTimestamp,
  normalizeUid,
  normalizeUuid,
  requestIsPreview,
};
