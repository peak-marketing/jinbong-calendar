'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertChecklistMutationAllowed,
  checklistMutationDecision,
  normalizeChecklistCreateBody,
  normalizeChecklistUpdateBody,
  normalizeInstructionDateRange,
} = require('./peakos-event-checklist-policy');

function request({ uid = 'owner-uid', role = 'member', workspaceRole = 'member' } = {}) {
  return {
    uid,
    userDoc: { approved: true, is_active: true, role },
    workspace: { role: workspaceRole },
  };
}

test('title-only legacy-compatible creates remain valid while client snapshots are rejected', () => {
  assert.deepEqual(normalizeChecklistCreateBody({ title: '  영업 DB 후속 전화  ' }), {
    title: '영업 DB 후속 전화',
    instructorUid: null,
  });
  assert.deepEqual(normalizeChecklistCreateBody({
    title: '보고서 확인',
    instructorUid: 'instructor-uid',
  }), {
    title: '보고서 확인',
    instructorUid: 'instructor-uid',
  });
  assert.throws(
    () => normalizeChecklistCreateBody({
      title: '보고서 확인',
      instructorUid: 'instructor-uid',
      instructorName: '위조된 이름',
    }),
    error => error.statusCode === 400 && error.code === 'PEAKOS_CHECKLIST_BODY_INVALID',
  );
});

test('updates require a strict boolean or a real title/instructor change', () => {
  assert.deepEqual(normalizeChecklistUpdateBody({ done: true }), { done: true });
  assert.deepEqual(normalizeChecklistUpdateBody({ instructorUid: null }), { instructorUid: null });
  assert.throws(
    () => normalizeChecklistUpdateBody({ done: 'true' }),
    error => error.code === 'PEAKOS_CHECKLIST_DONE_INVALID',
  );
  assert.throws(
    () => normalizeChecklistUpdateBody({}),
    error => error.code === 'PEAKOS_CHECKLIST_BODY_EMPTY',
  );
});

test('only the event owner or an admin can mutate checklist directives', () => {
  const event = { owner_id: 'owner-uid' };
  assert.equal(checklistMutationDecision(request(), event).allowed, true);
  assert.equal(checklistMutationDecision(request({ uid: 'admin', role: 'admin' }), event).allowed, true);
  assert.equal(checklistMutationDecision(request({ uid: 'workspace-admin', workspaceRole: 'admin' }), event).allowed, true);

  for (const actor of [
    request({ uid: 'selected-instructor' }),
    request({ uid: 'shared-viewer' }),
    request({ uid: 'team-manager', role: 'manager' }),
  ]) {
    const decision = checklistMutationDecision(actor, event);
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, 'PEAKOS_CHECKLIST_MUTATION_FORBIDDEN');
    assert.throws(
      () => assertChecklistMutationAllowed(actor, event),
      error => error.statusCode === 403,
    );
  }
});

test('instruction inbox date navigation is bounded and calendar-valid', () => {
  assert.deepEqual(normalizeInstructionDateRange({ date: '2026-08-17' }), {
    from: '2026-08-17',
    to: '2026-08-17',
  });
  assert.deepEqual(normalizeInstructionDateRange({
    from: '2026-08-01',
    to: '2026-08-31',
  }), { from: '2026-08-01', to: '2026-08-31' });
  assert.throws(() => normalizeInstructionDateRange({ date: '2026-02-30' }), /확인/);
  assert.throws(() => normalizeInstructionDateRange({
    from: '2026-08-18',
    to: '2026-08-17',
  }), error => error.code === 'PEAKOS_CHECKLIST_DATE_RANGE_INVALID');
});
