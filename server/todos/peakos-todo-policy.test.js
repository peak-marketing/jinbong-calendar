'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeCreateBody,
  normalizeDate,
  normalizePatchBody,
  normalizeReorderBody,
  todoAccess,
} = require('./peakos-todo-policy');

function request(overrides = {}) {
  return {
    uid: 'owner-uid',
    userName: '김대호',
    userDoc: {
      name: '김대호', approved: true, is_active: true,
      chat_only: false, external_calendar_only: false,
    },
    workspaceSelectedByHeader: true,
    workspace: {
      id: 'ws_peak', role: 'member', headquartersOversight: false,
      permissions: { calendar: 'write' },
    },
    headers: {},
    get(name) { return this.headers[String(name).toLowerCase()]; },
    ...overrides,
  };
}

test('date/time validation is calendar-exact and memo preserves line breaks and tabs', () => {
  assert.equal(normalizeDate('2026-08-18'), '2026-08-18');
  assert.throws(() => normalizeDate('2026-02-29'), error => error.code === 'TODO_DATE_INVALID');
  assert.throws(() => normalizeDate('2026-13-01'), error => error.code === 'TODO_DATE_INVALID');

  const body = normalizeCreateBody({
    title: 'API 연동 확인',
    date: '2026-08-18',
    startTime: '09:05',
    endTime: '10:30',
    category: '',
    memo: '첫째 줄\n\t둘째 줄',
  });
  assert.equal(body.category, '일반');
  assert.equal(body.memo, '첫째 줄\n\t둘째 줄');
  assert.throws(
    () => normalizeCreateBody({
      title: '오류', date: '2026-08-18', startTime: '', endTime: '10:00',
    }),
    error => error.code === 'TODO_TIME_RANGE_INVALID',
  );
  assert.throws(
    () => normalizePatchBody({ expectedVersion: 1, memo: 'bad\u0000value' }),
    error => error.code === 'TODO_MEMO_INVALID',
  );
});

test('strict mutation DTOs reject owner overrides, empty patches, duplicates, and missing versions', () => {
  assert.throws(
    () => normalizeCreateBody({ title: '속임', date: '2026-08-18', ownerUid: 'other' }),
    error => error.code === 'TODO_BODY_INVALID',
  );
  assert.throws(
    () => normalizePatchBody({ expectedVersion: 1 }),
    error => error.code === 'TODO_BODY_EMPTY',
  );
  const id = '11111111-1111-4111-8111-111111111111';
  assert.throws(
    () => normalizeReorderBody({ items: [
      { id, sortOrder: 0, expectedVersion: 1 },
      { id, sortOrder: 1, expectedVersion: 1 },
    ] }),
    error => error.code === 'TODO_REORDER_DUPLICATE',
  );
  assert.throws(
    () => normalizeReorderBody({ items: [{ id, sortOrder: 0 }] }),
    error => error.code === 'TODO_INTEGER_INVALID',
  );
});

test('access requires approved active direct selected membership and blocks preview/restricted/oversight', () => {
  assert.equal(todoAccess(request(), { action: 'read' }).writable, true);
  assert.equal(todoAccess(request({
    workspace: {
      id: 'ws_peak', role: 'member', headquartersOversight: false,
      permissions: { calendar: 'read' },
    },
  }), { action: 'read' }).writable, false);
  assert.throws(
    () => todoAccess(request({ headers: { 'x-peakos-preview': '1' } })),
    error => error.code === 'TODO_PREVIEW_FORBIDDEN',
  );
  assert.throws(
    () => todoAccess(request({ workspaceSelectedByHeader: false })),
    error => error.code === 'PEAKOS_WORKSPACE_REQUIRED',
  );
  assert.throws(
    () => todoAccess(request({ userDoc: { approved: true, is_active: true, chat_only: true } })),
    error => error.code === 'TODO_RESTRICTED_ACCOUNT',
  );
  assert.throws(
    () => todoAccess(request({
      workspace: {
        id: 'ws_branch', role: 'oversight', headquartersOversight: true,
        permissions: { calendar: 'read' },
      },
    })),
    error => error.code === 'TODO_DIRECT_MEMBERSHIP_REQUIRED',
  );
  assert.throws(
    () => todoAccess(request({
      workspace: {
        id: 'ws_peak', role: 'member', headquartersOversight: false,
        permissions: { calendar: 'read' },
      },
    }), { action: 'write' }),
    error => error.code === 'PEAKOS_WORKSPACE_READ_ONLY',
  );
});
