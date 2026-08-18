'use strict';

const MAX_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 500;
const MAX_INBOX_RANGE_DAYS = 366;

function internalCalendarRuleEventSql(eventAlias = 'e') {
  const alias = String(eventAlias || '').trim();
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new TypeError('일정 SQL 별칭을 확인해 주세요.');
  }
  return `(COALESCE(${alias}.todo_cat, '') = '보고서'
  OR COALESCE(${alias}.title, '') LIKE '%보고서 작성%'
  OR COALESCE(${alias}.title, '') LIKE '%보고서 확인%'
  OR COALESCE(${alias}.title, '') LIKE '%업무보고 작성%')`;
}

class PeakosEventChecklistDirectiveError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'PeakosEventChecklistDirectiveError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function directiveError(statusCode, code, message) {
  return new PeakosEventChecklistDirectiveError(statusCode, code, message);
}

function assertPlainObject(value, label = '요청') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw directiveError(400, 'PEAKOS_CHECKLIST_BODY_INVALID', `${label} 형식이 올바르지 않습니다.`);
  }
  return value;
}

function assertOnlyKeys(value, allowedKeys, label = '요청') {
  const body = assertPlainObject(value, label);
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(body).filter(key => !allowed.has(key));
  if (unknown.length) {
    throw directiveError(
      400,
      'PEAKOS_CHECKLIST_BODY_INVALID',
      `${label}에 허용되지 않은 항목이 있습니다: ${unknown.join(', ')}`,
    );
  }
  return body;
}

function normalizeIdentifier(value, label) {
  const text = String(value ?? '').trim();
  if (!text || text.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(text)) {
    throw directiveError(400, 'PEAKOS_CHECKLIST_ID_INVALID', `${label}을(를) 확인해 주세요.`);
  }
  return text;
}

function normalizeInstructorUid(value, { optional = false } = {}) {
  if ((value === undefined && optional) || value === null) return value;
  return normalizeIdentifier(value, '지시자');
}

function normalizeTitle(value) {
  if (typeof value !== 'string') {
    throw directiveError(400, 'PEAKOS_CHECKLIST_TITLE_INVALID', '체크리스트 제목을 입력해 주세요.');
  }
  const title = value.trim();
  if (!title || title.length > MAX_TITLE_LENGTH || /\u0000/.test(title)) {
    throw directiveError(
      400,
      'PEAKOS_CHECKLIST_TITLE_INVALID',
      `체크리스트 제목은 1~${MAX_TITLE_LENGTH}자로 입력해 주세요.`,
    );
  }
  return title;
}

function normalizeChecklistCreateBody(value) {
  const body = assertOnlyKeys(value, ['title', 'instructorUid'], '체크리스트 추가');
  return {
    title: normalizeTitle(body.title),
    instructorUid: body.instructorUid === undefined
      ? null
      : normalizeInstructorUid(body.instructorUid),
  };
}

function normalizeChecklistUpdateBody(value) {
  const body = assertOnlyKeys(value, ['title', 'done', 'instructorUid'], '체크리스트 수정');
  const result = {};
  if (body.title !== undefined) result.title = normalizeTitle(body.title);
  if (body.done !== undefined) {
    if (typeof body.done !== 'boolean') {
      throw directiveError(400, 'PEAKOS_CHECKLIST_DONE_INVALID', '완료 여부를 확인해 주세요.');
    }
    result.done = body.done;
  }
  if (body.instructorUid !== undefined) {
    result.instructorUid = normalizeInstructorUid(body.instructorUid, { optional: true });
  }
  if (!Object.keys(result).length) {
    throw directiveError(400, 'PEAKOS_CHECKLIST_BODY_EMPTY', '변경할 내용을 입력해 주세요.');
  }
  return result;
}

function checklistMutationDecision(req, event) {
  if (!req?.uid || req?.userDoc?.approved !== true || req?.userDoc?.is_active === false) {
    return {
      allowed: false,
      statusCode: 403,
      code: 'PEAKOS_CHECKLIST_NOT_APPROVED',
      message: '승인된 활성 계정만 체크리스트를 변경할 수 있습니다.',
    };
  }
  if (!event) {
    return {
      allowed: false,
      statusCode: 404,
      code: 'PEAKOS_CHECKLIST_EVENT_NOT_FOUND',
      message: '일정을 찾을 수 없습니다.',
    };
  }
  const isOwner = String(event.owner_id || '') === String(req.uid);
  const isAdmin = req.userDoc?.role === 'admin' || req.workspace?.role === 'admin';
  if (isOwner || isAdmin) return { allowed: true, isOwner, isAdmin };
  return {
    allowed: false,
    statusCode: 403,
    code: 'PEAKOS_CHECKLIST_MUTATION_FORBIDDEN',
    message: '일정 소유자나 관리자만 체크리스트를 변경할 수 있습니다.',
  };
}

function assertChecklistMutationAllowed(req, event) {
  const decision = checklistMutationDecision(req, event);
  if (!decision.allowed) {
    throw directiveError(decision.statusCode, decision.code, decision.message);
  }
  return decision;
}

function parseIsoDate(value, label) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw directiveError(400, 'PEAKOS_CHECKLIST_DATE_INVALID', `${label}를 YYYY-MM-DD 형식으로 입력해 주세요.`);
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw directiveError(400, 'PEAKOS_CHECKLIST_DATE_INVALID', `${label}를 확인해 주세요.`);
  }
  return { text, date };
}

function normalizeInstructionDateRange(query = {}, now = new Date()) {
  const fallback = new Date(now).toISOString().slice(0, 10);
  const from = parseIsoDate(query.from || query.date || fallback, '시작일');
  const to = parseIsoDate(query.to || query.date || from.text, '종료일');
  const rangeDays = Math.floor((to.date.getTime() - from.date.getTime()) / 86400000) + 1;
  if (rangeDays < 1 || rangeDays > MAX_INBOX_RANGE_DAYS) {
    throw directiveError(
      400,
      'PEAKOS_CHECKLIST_DATE_RANGE_INVALID',
      `조회 기간은 1~${MAX_INBOX_RANGE_DAYS}일로 지정해 주세요.`,
    );
  }
  return { from: from.text, to: to.text };
}

module.exports = {
  MAX_INBOX_RANGE_DAYS,
  MAX_TITLE_LENGTH,
  PeakosEventChecklistDirectiveError,
  assertChecklistMutationAllowed,
  checklistMutationDecision,
  internalCalendarRuleEventSql,
  normalizeChecklistCreateBody,
  normalizeChecklistUpdateBody,
  normalizeIdentifier,
  normalizeInstructionDateRange,
  normalizeInstructorUid,
};
