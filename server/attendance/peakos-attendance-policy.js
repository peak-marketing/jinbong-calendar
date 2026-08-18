'use strict';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,120}$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const TEAM_ROLES = new Set(['admin', 'manager', 'oversight']);

class AttendanceError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
  }
}

class AttendanceValidationError extends AttendanceError {
  constructor(message, code = 'ATTENDANCE_INVALID') {
    super(message, code, 400);
  }
}

class AttendanceForbiddenError extends AttendanceError {
  constructor(message, code = 'ATTENDANCE_FORBIDDEN') {
    super(message, code, 403);
  }
}

class AttendanceConflictError extends AttendanceError {
  constructor(message, code = 'ATTENDANCE_CONFLICT') {
    super(message, code, 409);
  }
}

function kstParts(value = new Date()) {
  const instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new AttendanceValidationError('서버 시간을 확인할 수 없습니다.', 'ATTENDANCE_CLOCK_INVALID');
  }
  const shifted = new Date(instant.getTime() + KST_OFFSET_MS);
  const iso = shifted.toISOString();
  return Object.freeze({
    date: iso.slice(0, 10),
    month: iso.slice(0, 7),
    time: iso.slice(11, 16),
    instant,
  });
}

function parseMonth(value, now = new Date()) {
  if (value === undefined || value === null || value === '') return kstParts(now).month;
  if (typeof value !== 'string') {
    throw new AttendanceValidationError('조회 월은 YYYY-MM 형식이어야 합니다.', 'ATTENDANCE_MONTH_INVALID');
  }
  const normalized = value.trim();
  const match = normalized.match(MONTH_PATTERN);
  if (!match) {
    throw new AttendanceValidationError('조회 월은 YYYY-MM 형식이어야 합니다.', 'ATTENDANCE_MONTH_INVALID');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) {
    throw new AttendanceValidationError('조회 월이 올바르지 않습니다.', 'ATTENDANCE_MONTH_INVALID');
  }
  return normalized;
}

function monthRange(month) {
  const normalized = parseMonth(month);
  const [year, monthNumber] = normalized.split('-').map(Number);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  return Object.freeze({
    month: normalized,
    from: `${normalized}-01`,
    to: `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`,
  });
}

function previewRequested(req) {
  const raw = typeof req?.get === 'function'
    ? req.get('x-peakos-preview')
    : req?.headers?.['x-peakos-preview'];
  return String(Array.isArray(raw) ? raw[0] : raw || '').trim() === '1';
}

function normalizeName(req) {
  const source = req?.userDoc?.name || req?.userName || req?.userDoc?.email || req?.uid || '';
  const name = String(source).normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name || name.length > 160 || /\p{Cc}/u.test(name)) {
    throw new AttendanceForbiddenError('계정 이름을 확인할 수 없습니다.', 'ATTENDANCE_ACTOR_INVALID');
  }
  return name;
}

function attendanceAccess(req, { action = 'read' } = {}) {
  if (!['read', 'write'].includes(action)) throw new TypeError('attendance action must be read or write');
  if (previewRequested(req)) {
    throw new AttendanceForbiddenError(
      '계정 미리보기에서는 근태 정보를 조회하거나 변경할 수 없습니다.',
      'ATTENDANCE_PREVIEW_FORBIDDEN',
    );
  }
  if (req?.userDoc?.approved !== true || req?.userDoc?.is_active === false) {
    throw new AttendanceForbiddenError(
      '승인된 활성 계정만 근태 기능을 사용할 수 있습니다.',
      'ATTENDANCE_ACCOUNT_INACTIVE',
    );
  }
  if (req?.userDoc?.chat_only === true || req?.userDoc?.external_calendar_only === true) {
    throw new AttendanceForbiddenError(
      '제한 계정에서는 근태 기능을 사용할 수 없습니다.',
      'ATTENDANCE_RESTRICTED_ACCOUNT',
    );
  }

  const uid = String(req?.uid || '').trim();
  if (!uid || uid.length > 200 || /\p{Cc}/u.test(uid)) {
    throw new AttendanceForbiddenError('로그인 계정을 확인할 수 없습니다.', 'ATTENDANCE_ACTOR_INVALID');
  }
  const workspaceId = String(req?.workspace?.id || '').trim();
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new AttendanceForbiddenError(
      '근태 워크스페이스를 확인할 수 없습니다.',
      'ATTENDANCE_WORKSPACE_REQUIRED',
    );
  }
  const role = String(req?.workspace?.role || 'member').trim().toLowerCase();
  if (!['admin', 'manager', 'member', 'oversight'].includes(role)) {
    throw new AttendanceForbiddenError('워크스페이스 역할을 확인할 수 없습니다.');
  }

  // Business OS의 보고서 화면은 settlements area에 속한다. 같은 영역을
  // 서버에서도 다시 검사해 UI를 우회한 호출이 권한을 넓히지 못하게 한다.
  const permission = String(req?.workspace?.permissions?.settlements || '').toLowerCase();
  if (!['read', 'write'].includes(permission)) {
    throw new AttendanceForbiddenError(
      '이 워크스페이스에서 근태 기록을 볼 수 없습니다.',
      'PEAKOS_WORKSPACE_AREA_FORBIDDEN',
    );
  }
  const readOnly = role === 'oversight' || req?.workspace?.headquartersOversight === true;
  if (action === 'write' && (permission !== 'write' || readOnly)) {
    throw new AttendanceForbiddenError(
      '본사 열람 또는 읽기 전용 권한으로 근태 기록을 변경할 수 없습니다.',
      'PEAKOS_WORKSPACE_READ_ONLY',
    );
  }

  const rawGroupId = req?.userDoc?.group_id;
  const groupId = rawGroupId === null || rawGroupId === undefined
    ? null : String(rawGroupId).trim();
  if (groupId && (groupId.length > 200 || /\p{Cc}/u.test(groupId))) {
    throw new AttendanceForbiddenError('소속 팀을 확인할 수 없습니다.', 'ATTENDANCE_GROUP_INVALID');
  }
  const canViewTeam = role === 'manager'
    ? Boolean(groupId)
    : TEAM_ROLES.has(role);
  return Object.freeze({
    uid,
    name: normalizeName(req),
    workspaceId,
    role,
    groupId: groupId || null,
    readOnly,
    canViewTeam,
  });
}

function normalizeScope(value) {
  const scope = String(value || 'self').trim().toLowerCase();
  if (!['self', 'team'].includes(scope)) {
    throw new AttendanceValidationError('근태 조회 범위가 올바르지 않습니다.', 'ATTENDANCE_SCOPE_INVALID');
  }
  return scope;
}

function resolveReadScope(req, { scope, targetUid } = {}) {
  const access = attendanceAccess(req, { action: 'read' });
  const normalizedScope = normalizeScope(scope);
  const target = targetUid === undefined || targetUid === null || targetUid === ''
    ? null
    : String(targetUid).trim();
  if (target && (!target.length || target.length > 200 || /\p{Cc}/u.test(target))) {
    throw new AttendanceValidationError('조회 대상 계정이 올바르지 않습니다.', 'ATTENDANCE_TARGET_INVALID');
  }

  if (!access.canViewTeam) {
    if (normalizedScope !== 'self' || (target && target !== access.uid)) {
      throw new AttendanceForbiddenError(
        '일반 구성원은 본인의 근태 기록만 볼 수 있습니다.',
        'ATTENDANCE_TARGET_FORBIDDEN',
      );
    }
    return Object.freeze({ ...access, scope: 'self', targetUid: access.uid });
  }
  if (normalizedScope === 'self') {
    if (target && target !== access.uid) {
      throw new AttendanceForbiddenError(
        '다른 구성원 조회는 팀 범위로 요청해 주세요.',
        'ATTENDANCE_TARGET_FORBIDDEN',
      );
    }
    return Object.freeze({ ...access, scope: 'self', targetUid: access.uid });
  }
  return Object.freeze({ ...access, scope: 'team', targetUid: target });
}

module.exports = {
  AttendanceConflictError,
  AttendanceError,
  AttendanceForbiddenError,
  AttendanceValidationError,
  attendanceAccess,
  kstParts,
  monthRange,
  normalizeScope,
  parseMonth,
  previewRequested,
  resolveReadScope,
};
