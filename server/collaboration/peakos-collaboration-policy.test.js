'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EVENT_REORDER_LIMIT,
  authorizeEventReorder,
  normalizeChatMessageId,
  normalizeEventReorderItems,
} = require('./peakos-collaboration-policy');

test('normalizes a bounded, unique event reorder request', () => {
  assert.deepEqual(normalizeEventReorderItems([
    { id: 'todo-1', sortOrder: 0, todoCat: ' 영업 업무 ' },
    { id: 'todo-2', sortOrder: 1 },
  ]), {
    ok: true,
    items: [
      { id: 'todo-1', sortOrder: 0, todoCat: '영업 업무' },
      { id: 'todo-2', sortOrder: 1, todoCat: undefined },
    ],
  });
  assert.equal(normalizeEventReorderItems([]).code, 'EVENT_REORDER_ITEMS_REQUIRED');
  assert.equal(normalizeEventReorderItems([
    { id: 'same', sortOrder: 0 },
    { id: 'same', sortOrder: 1 },
  ]).code, 'EVENT_REORDER_ID_DUPLICATED');
  assert.equal(normalizeEventReorderItems([
    { id: 'todo', sortOrder: 1.5 },
  ]).code, 'EVENT_REORDER_SORT_INVALID');
  assert.equal(
    normalizeEventReorderItems(Array.from({ length: EVENT_REORDER_LIMIT + 1 }, (_, index) => ({ id: `todo-${index}`, sortOrder: index }))).code,
    'EVENT_REORDER_LIMIT_EXCEEDED',
  );
});

test('event reorder is all-or-nothing for owner/admin and rejects foreign or hidden rows', () => {
  const items = [
    { id: 'mine-1', sortOrder: 0 },
    { id: 'mine-2', sortOrder: 1 },
  ];
  const mine = [
    { id: 'mine-1', type: 'todo', owner_id: 'user-1', is_internal_rule: false },
    { id: 'mine-2', type: 'todo', owner_id: 'user-1', is_internal_rule: false },
  ];
  assert.deepEqual(authorizeEventReorder({ items, rows: mine, uid: 'user-1', role: 'member' }), { ok: true });

  const mixedOwner = [mine[0], { ...mine[1], owner_id: 'other-user' }];
  assert.equal(
    authorizeEventReorder({ items, rows: mixedOwner, uid: 'user-1', role: 'member' }).code,
    'EVENT_REORDER_NOT_AUTHORIZED',
  );
  assert.deepEqual(
    authorizeEventReorder({ items, rows: mixedOwner, uid: 'admin-1', role: 'admin' }),
    { ok: true },
  );
  assert.equal(
    authorizeEventReorder({ items, rows: mine.slice(0, 1), uid: 'user-1', role: 'member' }).code,
    'EVENT_REORDER_NOT_AUTHORIZED',
  );
  assert.equal(
    authorizeEventReorder({
      items,
      rows: [mine[0], { ...mine[1], is_internal_rule: true }],
      uid: 'user-1',
      role: 'member',
      externalCalendarOnly: true,
    }).code,
    'EVENT_REORDER_NOT_AUTHORIZED',
  );
  assert.equal(
    authorizeEventReorder({ items, rows: [mine[0], { ...mine[1], type: 'meeting' }], uid: 'user-1', role: 'member' }).code,
    'EVENT_REORDER_TODO_ONLY',
  );
});

test('chat read marker accepts only canonical stored UUID message IDs', () => {
  assert.equal(
    normalizeChatMessageId('001155AE-5DB3-45A0-B430-21C8324528EE'),
    '001155ae-5db3-45a0-b430-21c8324528ee',
  );
  assert.equal(normalizeChatMessageId(123), null);
  assert.equal(normalizeChatMessageId('0001'), null);
  assert.equal(normalizeChatMessageId('not-a-uuid'), null);
  assert.equal(normalizeChatMessageId('1 OR 1=1'), null);
  assert.equal(normalizeChatMessageId('001155ae-5db3-05a0-b430-21c8324528ee'), null);
  assert.equal(normalizeChatMessageId(undefined), null);
});
