'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isRfc3339, parseRfc3339 } = require('./ibk-time');

test('strict RFC3339 달력과 offset을 검증한다', () => {
  assert.equal(parseRfc3339('2026-08-06T12:34:56.123+09:00').toISOString(), '2026-08-06T03:34:56.123Z');
  assert.equal(isRfc3339('2024-02-29T23:59:59Z'), true);
  for (const invalid of [
    '2026-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-08-06 12:34:56',
    '2026-08-06T24:00:00Z',
    '2026-08-06T12:00:00+14:01',
    '2026-08-06T12:00:00+15:00',
  ]) assert.equal(isRfc3339(invalid), false, invalid);
});
