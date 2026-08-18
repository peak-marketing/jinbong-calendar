'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AttendanceForbiddenError,
  AttendanceValidationError,
  attendanceAccess,
  kstParts,
  monthRange,
  parseMonth,
  resolveReadScope,
} = require('./peakos-attendance-policy');

function request({
  uid = 'member-1', role = 'member', permission = 'write', oversight = false,
  approved = true, active = true, preview = false, chatOnly = false,
  externalCalendarOnly = false, workspaceId = 'ws_daegu', groupId = 'sales-daegu',
} = {}) {
  return {
    uid,
    userName: uid,
    userDoc: {
      name: uid,
      approved,
      is_active: active,
      chat_only: chatOnly,
      external_calendar_only: externalCalendarOnly,
      group_id: groupId,
    },
    workspace: {
      id: workspaceId,
      role,
      permissions: { settlements: permission },
      headquartersOversight: oversight,
    },
    headers: preview ? { 'x-peakos-preview': '1' } : {},
  };
}

test('KST date, month and minute are stable across the UTC date boundary', () => {
  const value = kstParts(new Date('2026-08-16T15:03:44.000Z'));
  assert.deepEqual(
    { date: value.date, month: value.month, time: value.time },
    { date: '2026-08-17', month: '2026-08', time: '00:03' },
  );
  assert.equal(parseMonth('', new Date('2026-08-16T15:03:44.000Z')), '2026-08');
  assert.deepEqual(monthRange('2026-12'), {
    month: '2026-12', from: '2026-12-01', to: '2027-01-01',
  });
});

test('invalid month values fail closed rather than changing query shape', () => {
  for (const value of ['2026-00', '2026-13', '26-08', '2026-08%', '1999-12', 202608]) {
    assert.throws(() => parseMonth(value), AttendanceValidationError);
  }
});

test('preview, inactive and restricted accounts cannot read attendance', () => {
  for (const req of [
    request({ preview: true }),
    request({ approved: false }),
    request({ active: false }),
    request({ chatOnly: true }),
    request({ externalCalendarOnly: true }),
  ]) {
    assert.throws(() => attendanceAccess(req), AttendanceForbiddenError);
  }
});

test('ordinary members cannot forge another user or team scope', () => {
  const req = request();
  assert.deepEqual(
    resolveReadScope(req, { scope: 'self' }),
    {
      uid: 'member-1', name: 'member-1', workspaceId: 'ws_daegu', role: 'member',
      groupId: 'sales-daegu', readOnly: false, canViewTeam: false,
      scope: 'self', targetUid: 'member-1',
    },
  );
  assert.throws(
    () => resolveReadScope(req, { scope: 'self', targetUid: 'another-user' }),
    error => error.code === 'ATTENDANCE_TARGET_FORBIDDEN',
  );
  assert.throws(
    () => resolveReadScope(req, { scope: 'team' }),
    error => error.code === 'ATTENDANCE_TARGET_FORBIDDEN',
  );
});

test('workspace manager/admin and oversight can read team scope, but oversight is read-only', () => {
  for (const role of ['manager', 'admin']) {
    const access = resolveReadScope(request({ role }), { scope: 'team', targetUid: 'member-2' });
    assert.equal(access.canViewTeam, true);
    assert.equal(access.targetUid, 'member-2');
    assert.equal(access.readOnly, false);
    assert.doesNotThrow(() => attendanceAccess(request({ role }), { action: 'write' }));
  }

  const oversight = request({ role: 'oversight', permission: 'read', oversight: true });
  assert.equal(resolveReadScope(oversight, { scope: 'team' }).readOnly, true);
  assert.throws(
    () => attendanceAccess(oversight, { action: 'write' }),
    error => error.code === 'PEAKOS_WORKSPACE_READ_ONLY',
  );
});

test('manager team scope requires a current group while admin and oversight remain workspace-scoped', () => {
  assert.throws(
    () => resolveReadScope(request({ role: 'manager', groupId: null }), { scope: 'team' }),
    error => error.code === 'ATTENDANCE_TARGET_FORBIDDEN',
  );
  assert.equal(resolveReadScope(request({ role: 'admin', groupId: null }), { scope: 'team' }).canViewTeam, true);
  assert.equal(resolveReadScope(request({ role: 'oversight', groupId: null, permission: 'read', oversight: true }), { scope: 'team' }).canViewTeam, true);
});

test('missing or denied settlements-area permission fails closed', () => {
  assert.throws(
    () => attendanceAccess(request({ permission: 'none' })),
    error => error.code === 'PEAKOS_WORKSPACE_AREA_FORBIDDEN',
  );
  assert.throws(
    () => attendanceAccess(request({ permission: 'read' }), { action: 'write' }),
    error => error.code === 'PEAKOS_WORKSPACE_READ_ONLY',
  );
  assert.throws(
    () => attendanceAccess(request({ workspaceId: '' })),
    error => error.code === 'ATTENDANCE_WORKSPACE_REQUIRED',
  );
});
