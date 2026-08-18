'use strict';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,120}$/;

class TodoError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'TodoError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function invalid(message, code = 'TODO_INVALID') {
  throw new TodoError(400, code, message);
}

function previewRequested(req) {
  const raw = typeof req?.get === 'function'
    ? req.get('x-peakos-preview')
    : req?.headers?.['x-peakos-preview'];
  if (Array.isArray(raw)) return true;
  return /^(?:1|true|yes|on)$/i.test(String(raw || '').trim());
}

function normalizeActorName(req) {
  const raw = req?.userDoc?.name || req?.userName || req?.userDoc?.email || req?.uid || '';
  const name = String(raw).normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name || name.length > 160 || /\p{Cc}/u.test(name)) {
    throw new TodoError(403, 'TODO_ACTOR_INVALID', '로그인 계정 이름을 확인할 수 없습니다.');
  }
  return name;
}

function todoAccess(req, { action = 'read' } = {}) {
  if (!['read', 'write'].includes(action)) throw new TypeError('todo action must be read or write');
  if (previewRequested(req)) {
    throw new TodoError(403, 'TODO_PREVIEW_FORBIDDEN', '계정 미리보기에서는 할 일을 조회하거나 변경할 수 없습니다.');
  }
  if (req?.userDoc?.approved !== true || req?.userDoc?.is_active === false) {
    throw new TodoError(403, 'TODO_ACCOUNT_INACTIVE', '승인된 활성 계정만 할 일을 사용할 수 있습니다.');
  }
  if (req?.userDoc?.chat_only === true || req?.userDoc?.external_calendar_only === true) {
    throw new TodoError(403, 'TODO_RESTRICTED_ACCOUNT', '제한 계정에서는 PEAK OS 할 일을 사용할 수 없습니다.');
  }
  if (req?.workspaceSelectedByHeader !== true) {
    throw new TodoError(400, 'PEAKOS_WORKSPACE_REQUIRED', '워크스페이스를 명시적으로 선택해 주세요.');
  }

  const uid = String(req?.uid || '').trim();
  if (!uid || uid.length > 200 || /\p{Cc}/u.test(uid)) {
    throw new TodoError(403, 'TODO_ACTOR_INVALID', '로그인 계정을 확인할 수 없습니다.');
  }
  const workspaceId = String(req?.workspace?.id || '').trim();
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new TodoError(403, 'TODO_WORKSPACE_REQUIRED', '워크스페이스를 확인할 수 없습니다.');
  }
  const role = String(req?.workspace?.role || '').trim().toLowerCase();
  if (!['admin', 'manager', 'member'].includes(role)
      || req?.workspace?.headquartersOversight === true) {
    throw new TodoError(403, 'TODO_DIRECT_MEMBERSHIP_REQUIRED', '현재 조직의 직접 구성원만 할 일을 사용할 수 있습니다.');
  }
  const permission = String(req?.workspace?.permissions?.calendar || '').toLowerCase();
  if (!['read', 'write'].includes(permission)
      || (action === 'write' && permission !== 'write')) {
    throw new TodoError(
      403,
      action === 'write' ? 'PEAKOS_WORKSPACE_READ_ONLY' : 'PEAKOS_WORKSPACE_AREA_FORBIDDEN',
      action === 'write'
        ? '읽기 전용 권한으로는 할 일을 변경할 수 없습니다.'
        : '이 워크스페이스에서 할 일을 볼 수 없습니다.',
    );
  }
  return Object.freeze({
    uid,
    name: normalizeActorName(req),
    workspaceId,
    role,
    writable: permission === 'write',
  });
}

function normalizeStrictObject(value, allowedKeys, field = '요청') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${field} 형식이 올바르지 않습니다.`, 'TODO_BODY_INVALID');
  }
  const unknown = Object.keys(value).filter(key => !allowedKeys.includes(key));
  if (unknown.length) invalid(`허용되지 않은 항목입니다: ${unknown.join(', ')}`, 'TODO_BODY_INVALID');
  return value;
}

function normalizeDate(value, { field = '날짜' } = {}) {
  if (typeof value !== 'string') invalid(`${field}는 YYYY-MM-DD 형식이어야 합니다.`, 'TODO_DATE_INVALID');
  const date = value.trim();
  const match = date.match(DATE_PATTERN);
  if (!match) invalid(`${field}는 YYYY-MM-DD 형식이어야 합니다.`, 'TODO_DATE_INVALID');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || year > 2100
      || check.getUTCFullYear() !== year
      || check.getUTCMonth() !== month - 1
      || check.getUTCDate() !== day) {
    invalid(`${field}가 올바르지 않습니다.`, 'TODO_DATE_INVALID');
  }
  return date;
}

function normalizeTime(value, { field = '시간' } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !TIME_PATTERN.test(value.trim())) {
    invalid(`${field}은 HH:MM 형식이어야 합니다.`, 'TODO_TIME_INVALID');
  }
  return value.trim();
}

function validateTimeRange(startTime, endTime) {
  if (!startTime && endTime) {
    invalid('종료 시간을 입력하려면 시작 시간이 필요합니다.', 'TODO_TIME_RANGE_INVALID');
  }
  if (startTime && endTime && startTime >= endTime) {
    invalid('종료 시간은 시작 시간보다 늦어야 합니다.', 'TODO_TIME_RANGE_INVALID');
  }
}

function normalizeText(value, {
  field,
  required = true,
  max,
  defaultValue,
} = {}) {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof value !== 'string') invalid(`${field}을(를) 확인해 주세요.`, 'TODO_TEXT_INVALID');
  const text = value.normalize('NFKC').trim();
  if ((required && !text) || text.length > max || /\p{Cc}/u.test(text)) {
    invalid(`${field}을(를) 확인해 주세요.`, 'TODO_TEXT_INVALID');
  }
  return text;
}

function normalizeMemo(value, { defaultValue } = {}) {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof value !== 'string') invalid('메모를 확인해 주세요.', 'TODO_MEMO_INVALID');
  const memo = value.normalize('NFKC').trim();
  if (memo.length > 5000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(memo)) {
    invalid('메모는 5,000자 이하로 입력해 주세요.', 'TODO_MEMO_INVALID');
  }
  return memo;
}

function normalizeBoolean(value, { field, defaultValue } = {}) {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof value !== 'boolean') invalid(`${field}을(를) 확인해 주세요.`, 'TODO_BOOLEAN_INVALID');
  return value;
}

function normalizeInteger(value, { field, min = 0, max = 2147483647, defaultValue } = {}) {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (!Number.isInteger(value) || value < min || value > max) {
    invalid(`${field}을(를) 확인해 주세요.`, 'TODO_INTEGER_INVALID');
  }
  return value;
}

function normalizeId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) invalid('할 일 ID가 올바르지 않습니다.', 'TODO_ID_INVALID');
  return id;
}

function normalizeExpectedVersion(value) {
  return normalizeInteger(value, { field: '예상 버전', min: 1, max: 2147483647 });
}

function normalizeSortOrder(value, { defaultValue } = {}) {
  return normalizeInteger(value, { field: '정렬 순서', min: 0, max: 1000000, defaultValue });
}

function normalizeCreateBody(body) {
  normalizeStrictObject(body, [
    'title', 'date', 'startTime', 'endTime', 'category', 'memo', 'done', 'sortOrder',
  ], '할 일');
  const startTime = normalizeTime(body.startTime, { field: '시작 시간' });
  const endTime = normalizeTime(body.endTime, { field: '종료 시간' });
  validateTimeRange(startTime, endTime);
  return Object.freeze({
    title: normalizeText(body.title, { field: '할 일', max: 240 }),
    date: normalizeDate(body.date),
    startTime: startTime === undefined ? null : startTime,
    endTime: endTime === undefined ? null : endTime,
    category: normalizeText(body.category, {
      field: '분류', required: false, max: 80, defaultValue: '일반',
    }) || '일반',
    memo: normalizeMemo(body.memo, { defaultValue: '' }),
    done: normalizeBoolean(body.done, { field: '완료 상태', defaultValue: false }),
    sortOrder: normalizeSortOrder(body.sortOrder, { defaultValue: 0 }),
  });
}

function normalizePatchBody(body) {
  normalizeStrictObject(body, [
    'title', 'date', 'startTime', 'endTime', 'category', 'memo', 'done', 'sortOrder',
    'expectedVersion',
  ], '할 일 수정');
  const result = { expectedVersion: normalizeExpectedVersion(body.expectedVersion) };
  if (body.title !== undefined) result.title = normalizeText(body.title, { field: '할 일', max: 240 });
  if (body.date !== undefined) result.date = normalizeDate(body.date);
  if (body.startTime !== undefined) result.startTime = normalizeTime(body.startTime, { field: '시작 시간' });
  if (body.endTime !== undefined) result.endTime = normalizeTime(body.endTime, { field: '종료 시간' });
  if (body.category !== undefined) {
    result.category = normalizeText(body.category, { field: '분류', required: false, max: 80 }) || '일반';
  }
  if (body.memo !== undefined) result.memo = normalizeMemo(body.memo);
  if (body.done !== undefined) result.done = normalizeBoolean(body.done, { field: '완료 상태' });
  if (body.sortOrder !== undefined) result.sortOrder = normalizeSortOrder(body.sortOrder);
  if (Object.keys(result).length === 1) invalid('변경할 할 일 내용을 입력해 주세요.', 'TODO_BODY_EMPTY');
  return result;
}

function normalizeDeleteBody(body) {
  normalizeStrictObject(body, ['expectedVersion'], '할 일 보관');
  return Object.freeze({ expectedVersion: normalizeExpectedVersion(body.expectedVersion) });
}

function normalizeReorderBody(body) {
  normalizeStrictObject(body, ['items'], '할 일 정렬');
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 500) {
    invalid('정렬할 항목을 1~500개로 보내 주세요.', 'TODO_REORDER_INVALID');
  }
  const seen = new Set();
  const items = body.items.map(item => {
    normalizeStrictObject(item, ['id', 'sortOrder', 'expectedVersion'], '정렬 항목');
    const id = normalizeId(item.id);
    if (seen.has(id)) invalid('동일한 할 일을 중복해 정렬할 수 없습니다.', 'TODO_REORDER_DUPLICATE');
    seen.add(id);
    return Object.freeze({
      id,
      sortOrder: normalizeSortOrder(item.sortOrder),
      expectedVersion: normalizeExpectedVersion(item.expectedVersion),
    });
  });
  return Object.freeze(items);
}

module.exports = {
  TodoError,
  normalizeCreateBody,
  normalizeDate,
  normalizeDeleteBody,
  normalizeExpectedVersion,
  normalizeId,
  normalizePatchBody,
  normalizeReorderBody,
  normalizeStrictObject,
  normalizeTime,
  previewRequested,
  todoAccess,
  validateTimeRange,
};
