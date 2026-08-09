'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  AUTO_MATCH_MAX_AGE_ENV,
  DEFAULT_AUTO_MATCH_MAX_AGE_DAYS,
  isWithinAutoMatchWindow,
  parseAutoMatchMaxAgeDays,
} = require('./peakos-auto-match-policy');

test('자동매칭 과거 하한은 기본 30일이고 0은 자동매칭을 완전히 끈다', () => {
  assert.equal(parseAutoMatchMaxAgeDays(null), DEFAULT_AUTO_MATCH_MAX_AGE_DAYS);
  assert.equal(parseAutoMatchMaxAgeDays('0'), 0);
  assert.equal(parseAutoMatchMaxAgeDays('30'), 30);
  assert.equal(parseAutoMatchMaxAgeDays('90'), 90);

  const transactionAt = new Date('2026-08-06T00:00:00.000Z');
  assert.equal(isWithinAutoMatchWindow('2026-07-07T00:00:00.000Z', transactionAt, 30), true);
  assert.equal(isWithinAutoMatchWindow('2026-07-06T23:59:59.999Z', transactionAt, 30), false);
  assert.equal(isWithinAutoMatchWindow('2026-08-06T01:00:00.000Z', transactionAt, 30), true);
  assert.equal(isWithinAutoMatchWindow('2026-08-06T01:00:00.001Z', transactionAt, 30), false);
  assert.equal(isWithinAutoMatchWindow('2026-08-06T00:00:00.000Z', transactionAt, 0), false);
});

test('잘못되거나 과도한 자동매칭 기간 설정은 fail-closed로 거부한다', () => {
  for (const value of ['-1', '1.5', '91', 'unlimited', 'Infinity']) {
    assert.throws(
      () => parseAutoMatchMaxAgeDays(value),
      error => error instanceof Error && error.message.includes(AUTO_MATCH_MAX_AGE_ENV),
    );
  }
  assert.equal(isWithinAutoMatchWindow('invalid', new Date(), 30), false);
  assert.equal(isWithinAutoMatchWindow(new Date(), 'invalid', 30), false);
});

test('잘못된 환경값이면 정책 모듈 로드 단계에서 프로세스가 실패한다', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "require('./peakos-auto-match-policy')"],
    {
      cwd: path.join(__dirname),
      env: { ...process.env, [AUTO_MATCH_MAX_AGE_ENV]: '91' },
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(AUTO_MATCH_MAX_AGE_ENV));
});
