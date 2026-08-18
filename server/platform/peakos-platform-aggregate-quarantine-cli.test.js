'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  APPLY_CONFIRMATION,
  main,
  parseArgs,
} = require('./peakos-platform-aggregate-quarantine-cli');

const CLI_SOURCE = fs.readFileSync(path.resolve(
  __dirname,
  'peakos-platform-aggregate-quarantine-cli.js',
), 'utf8');

test('quarantine CLI는 inspect/apply 범위를 중복 없는 명시적 인수로만 해석한다', () => {
  assert.deepEqual(parseArgs([
    'inspect', '--workspace', 'ws_peak', '--provider', 'rewardspace', '--month', '2026-08',
  ]), {
    command: 'inspect', workspace: 'ws_peak', provider: 'rewardspace', month: '2026-08',
  });
  assert.throws(
    () => parseArgs(['inspect', '--month', '2026-08', '--month', '2026-07']),
    /한 번만 지정/,
  );
  assert.throws(() => parseArgs(['inspect', '--month']), /값이 필요/);
  assert.throws(() => parseArgs(['inspect', '2026-08']), /알 수 없는 인수/);
});

test('quarantine apply는 DB 연결 전에 run CAS·감사자·사유·operation key·확인문구를 모두 요구한다', async () => {
  let poolConstructed = false;
  class ForbiddenPool {
    constructor() { poolConstructed = true; }
  }
  const base = [
    'apply',
    '--workspace', 'ws_peak',
    '--provider', 'rewardspace',
    '--month', '2026-08',
    '--run-id', '11111111-1111-4111-8111-111111111111',
    '--expected-latest-run-id', '11111111-1111-4111-8111-111111111111',
    '--operation-key', 'quarantine:rewardspace:2026-08:001',
    '--reason', '잘못 수집된 월 집계 격리',
    '--actor-uid', 'operator-uid',
    '--actor-name', '운영자',
  ];

  await assert.rejects(main(base, { PoolClass: ForbiddenPool }), /--confirm은 필수/);
  await assert.rejects(main([
    ...base, '--confirm', 'WRONG_CONFIRMATION',
  ], { PoolClass: ForbiddenPool }), /확인 문구가 일치하지 않습니다/);
  assert.equal(poolConstructed, false);
  assert.equal(APPLY_CONFIRMATION, 'QUARANTINE_PLATFORM_AGGREGATE_RUN');
});

test('quarantine CLI는 HTTP/self mutation surface를 만들지 않고 명시 run ID를 primitive에 전달한다', () => {
  assert.match(CLI_SOURCE, /runId: args\.runId/);
  assert.match(CLI_SOURCE, /expectedLatestRunId: args\.expectedLatestRunId/);
  assert.match(CLI_SOURCE, /operationKey: args\.operationKey/);
  assert.match(CLI_SOURCE, /actor: \{ uid: args\.actorUid, name: args\.actorName \}/);
  assert.doesNotMatch(CLI_SOURCE, /\b(?:app|router)\.(?:post|put|patch|delete)\s*\(/i);
  assert.doesNotMatch(CLI_SOURCE, /api[_ -]?key/i);
});
