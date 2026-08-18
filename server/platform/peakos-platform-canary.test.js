'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CANARY_CONFIRMATION,
  CANARY_POOL_OPTIONS,
  assertAllProviderSecrets,
  expectedCanaryMonths,
  executePlatformCanary,
  main,
  parseCanaryArgs,
  summarizeCanaryMonth,
  summarizeCanaryRun,
} = require('./peakos-platform-canary');

const SECRET_PATH = '/root/.peakos-secrets/platform-api.env';
const FAKE_SECRETS = Object.freeze({
  PEAKOS_REWARDSPACE_API_KEY: 'reward-test-key',
  PEAKOS_REVIEWSPACE_API_KEY: 'review-test-key',
  PEAKOS_KEYWORDMASTER_API_KEY: 'keyword-test-key',
});

function copySecrets(source = FAKE_SECRETS) {
  return Object.assign(Object.create(null), source);
}

function monthResult(month, overrides = {}) {
  return {
    month,
    skipped: false,
    disabledConnections: [],
    providers: [{
      provider: 'rewardspace',
      ok: true,
      sourceRowCount: 1,
      skippedSourceRowCount: 0,
      globalUnmatchedCount: 0,
      globalAmbiguousCount: 0,
      workspaceCount: 1,
      workspaces: [{
        workspaceId: 'workspace-id-must-not-leak',
        salespersonName: '영업자명이 출력되면 안 됨',
        amount: '990001',
        ok: true,
        rowCount: 1,
        attributionIssueCount: 0,
        duplicate: false,
      }],
      ...overrides,
    }],
  };
}

test('canary 인수는 지정 provider, 절대 env file, 명시적 확인 문구만 허용한다', () => {
  assert.deepEqual(parseCanaryArgs([
    '--provider', 'rewardspace',
    '--env-file', SECRET_PATH,
    '--confirm', CANARY_CONFIRMATION,
  ]), {
    provider: 'rewardspace', envFile: SECRET_PATH, confirm: CANARY_CONFIRMATION,
  });
  for (const args of [
    ['--provider', 'unknown', '--env-file', SECRET_PATH, '--confirm', CANARY_CONFIRMATION],
    ['--provider', 'rewardspace', '--env-file', 'relative.env', '--confirm', CANARY_CONFIRMATION],
    ['--provider', 'rewardspace', '--env-file', SECRET_PATH, '--confirm', 'YES'],
    ['--provider', 'rewardspace', '--env-file', SECRET_PATH, '--confirm', CANARY_CONFIRMATION, '--all'],
  ]) {
    assert.throws(() => parseCanaryArgs(args), { code: 'PLATFORM_CANARY_ARGUMENT_INVALID' });
  }
});

test('canary는 선택 provider와 무관하게 세 공급사 key가 모두 있어야 한다', () => {
  assert.doesNotThrow(() => assertAllProviderSecrets(copySecrets()));
  assert.throws(
    () => assertAllProviderSecrets(copySecrets({ PEAKOS_REWARDSPACE_API_KEY: 'reward-test-key' })),
    { code: 'PLATFORM_CANARY_CONFIG_INVALID' },
  );
});

test('canary는 DB readiness 뒤 선택 provider 이전월→현재월 sync를 한 번 호출하고 안전 count만 반환한다', async () => {
  const order = [];
  const secrets = copySecrets();
  let receivedEnvironment;
  let receivedPoolOptions;
  class FakePool {
    constructor(options) {
      receivedPoolOptions = options;
      order.push('pool');
    }
    async end() { order.push('end'); }
  }
  const report = await executePlatformCanary([
    '--provider', 'rewardspace',
    '--env-file', SECRET_PATH,
    '--confirm', CANARY_CONFIRMATION,
  ], {
    PoolClass: FakePool,
    loadSecretEnvironment() {
      order.push('load');
      return secrets;
    },
    async ensureInfrastructure(pool) {
      assert.ok(pool instanceof FakePool);
      order.push('readiness');
    },
    createSyncService({ pool, env }) {
      assert.ok(pool instanceof FakePool);
      receivedEnvironment = env;
      order.push('service');
      return {
        configuredProviders: ['rewardspace', 'reviewspace', 'keywordmaster'],
        async syncProviderCurrentAndPrevious(provider, referenceClock) {
          assert.equal(provider, 'rewardspace');
          assert.equal(referenceClock.toISOString(), '2026-08-17T03:00:00.000Z');
          order.push('sync');
          return [monthResult('2026-07'), monthResult('2026-08')];
        },
      };
    },
    now: () => new Date('2026-08-17T03:00:00Z'),
  });

  assert.deepEqual(order, ['load', 'pool', 'readiness', 'service', 'sync', 'end']);
  assert.deepEqual(receivedPoolOptions, {
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  assert.deepEqual(CANARY_POOL_OPTIONS, receivedPoolOptions);
  assert.equal(receivedEnvironment, secrets);
  assert.deepEqual(report, {
    provider: 'rewardspace',
    ok: true,
    monthCount: 2,
    months: [
      {
        provider: 'rewardspace', month: '2026-07', ok: true,
        sourceRowCount: 1, skippedSourceRowCount: 0, workspaceCount: 1,
        successfulWorkspaceCount: 1, failedWorkspaceCount: 0,
        duplicateWorkspaceCount: 0, attributionIssueCount: 0,
        globalUnmatchedCount: 0, globalAmbiguousCount: 0,
        disabledConnectionCount: 0,
      },
      {
        provider: 'rewardspace', month: '2026-08', ok: true,
        sourceRowCount: 1, skippedSourceRowCount: 0, workspaceCount: 1,
        successfulWorkspaceCount: 1, failedWorkspaceCount: 0,
        duplicateWorkspaceCount: 0, attributionIssueCount: 0,
        globalUnmatchedCount: 0, globalAmbiguousCount: 0,
        disabledConnectionCount: 0,
      },
    ],
  });
  const output = JSON.stringify(report);
  for (const forbidden of [
    ...Object.values(FAKE_SECRETS),
    'workspace-id-must-not-leak', '영업자명이 출력되면 안 됨', '990001',
  ]) {
    assert.equal(output.includes(forbidden), false);
  }
  assert.deepEqual(Object.keys(secrets), []);
});

test('KST 기준 월은 경계 시각에도 previous/current 두 달을 정확히 계산한다', () => {
  assert.deepEqual(
    expectedCanaryMonths(new Date('2026-08-31T15:30:00Z')),
    ['2026-08', '2026-09'],
  );
  assert.throws(
    () => expectedCanaryMonths(new Date('invalid')),
    { code: 'PLATFORM_CANARY_CONFIG_INVALID' },
  );
});

test('세 key가 아니면 pool/readiness/sync 전에 fail-closed하고 메모리 key를 지운다', async () => {
  const secrets = copySecrets({ PEAKOS_REWARDSPACE_API_KEY: 'reward-test-key' });
  let poolCount = 0;
  let readinessCount = 0;
  class FakePool {
    constructor() { poolCount += 1; }
  }
  await assert.rejects(
    executePlatformCanary([
      '--provider', 'rewardspace',
      '--env-file', SECRET_PATH,
      '--confirm', CANARY_CONFIRMATION,
    ], {
      PoolClass: FakePool,
      loadSecretEnvironment: () => secrets,
      ensureInfrastructure: async () => { readinessCount += 1; },
    }),
    { code: 'PLATFORM_CANARY_CONFIG_INVALID' },
  );
  assert.equal(poolCount, 0);
  assert.equal(readinessCount, 0);
  assert.deepEqual(Object.keys(secrets), []);
});

test('DB readiness 실패는 sync를 시작하지 않고 migration 상세 대신 안전 code로 축약한다', async () => {
  let syncCount = 0;
  class FakePool { async end() {} }
  const lines = [];
  let exitCode = 0;
  const report = await main([
    '--provider', 'rewardspace',
    '--env-file', SECRET_PATH,
    '--confirm', CANARY_CONFIRMATION,
  ], {
    PoolClass: FakePool,
    loadSecretEnvironment: () => copySecrets(),
    async ensureInfrastructure() {
      const error = new Error('private table and constraint details');
      error.code = 'PEAKOS_PLATFORM_SETTLEMENT_MIGRATION_REQUIRED';
      throw error;
    },
    createSyncService() {
      syncCount += 1;
      throw new Error('must not create service');
    },
    writeOutput: line => lines.push(line),
    setExitCode: code => { exitCode = code; },
  });
  assert.deepEqual(report, {
    provider: 'rewardspace', ok: false, code: 'PLATFORM_CANARY_DB_NOT_READY',
  });
  assert.equal(syncCount, 0);
  assert.equal(exitCode, 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes('private table'), false);
  assert.equal(lines[0].includes('constraint'), false);
});

test('귀속·동명이인·disabled 상태는 성공으로 표시하지 않고 ID나 상세를 출력하지 않는다', () => {
  const report = summarizeCanaryMonth('rewardspace', monthResult('2026-08', {
    globalUnmatchedCount: 2,
    globalAmbiguousCount: 1,
    workspaces: [{
      workspaceId: 'private-workspace',
      ok: true,
      rowCount: 4,
      attributionIssueCount: 3,
      duplicate: true,
    }],
  }));
  assert.equal(report.ok, false);
  assert.equal(report.code, 'PLATFORM_CANARY_ATTRIBUTION_ISSUES');
  assert.equal(report.globalUnmatchedCount, 2);
  assert.equal(report.globalAmbiguousCount, 1);
  assert.equal(report.attributionIssueCount, 3);
  assert.equal(report.duplicateWorkspaceCount, 1);
  assert.equal(JSON.stringify(report).includes('private-workspace'), false);
});

test('문자열·음수·unsafe integer count는 보정하지 않고 RESULT_INVALID로 거부한다', () => {
  const malformedResults = [
    monthResult('2026-08', { sourceRowCount: '1' }),
    monthResult('2026-08', { skippedSourceRowCount: -1 }),
    monthResult('2026-08', { workspaceCount: Number.MAX_SAFE_INTEGER + 1 }),
    monthResult('2026-08', { globalUnmatchedCount: 0.5 }),
    monthResult('2026-08', {
      workspaces: [{
        workspaceId: 'private-workspace', ok: true, rowCount: '1',
        attributionIssueCount: 0, duplicate: false,
      }],
    }),
    monthResult('2026-08', {
      workspaces: [{
        workspaceId: 'private-workspace', ok: true, rowCount: 1,
        attributionIssueCount: -1, duplicate: false,
      }],
    }),
  ];
  for (const result of malformedResults) {
    assert.deepEqual(summarizeCanaryMonth('rewardspace', result), {
      provider: 'rewardspace', month: '2026-08', ok: false,
      code: 'PLATFORM_CANARY_RESULT_INVALID',
    });
  }
});

test('월 결과는 선택 provider 정확히 하나만 허용하고 extra/wrong provider를 거부한다', () => {
  const extraProvider = monthResult('2026-08');
  extraProvider.providers.push({
    provider: 'reviewspace', ok: false, workspaceCount: 0,
  });
  const wrongProvider = monthResult('2026-08');
  wrongProvider.providers[0].provider = 'reviewspace';
  for (const result of [extraProvider, wrongProvider]) {
    assert.equal(summarizeCanaryMonth('rewardspace', result).ok, false);
    assert.equal(
      summarizeCanaryMonth('rewardspace', result).code,
      'PLATFORM_CANARY_RESULT_INVALID',
    );
  }
});

test('결과 월은 KST expected previous/current 순서와 서로 다른 값을 강제한다', () => {
  const expected = ['2026-07', '2026-08'];
  for (const results of [
    [monthResult('2026-08'), monthResult('2026-07')],
    [monthResult('2026-08'), monthResult('2026-08')],
    [monthResult('2026-07'), monthResult('2026-07')],
  ]) {
    assert.deepEqual(summarizeCanaryRun('rewardspace', results, [], expected), {
      provider: 'rewardspace', ok: false, monthCount: 2,
      code: 'PLATFORM_CANARY_RESULT_INVALID', months: [],
    });
  }
});

test('예상 밖 오류는 원문·key 없이 provider와 안전 code 한 줄만 출력한다', async () => {
  const lines = [];
  let exitCode = 0;
  const secret = FAKE_SECRETS.PEAKOS_REWARDSPACE_API_KEY;
  const report = await main([
    '--provider', 'rewardspace',
    '--env-file', SECRET_PATH,
    '--confirm', CANARY_CONFIRMATION,
  ], {
    loadSecretEnvironment() {
      throw new Error(`raw response 영업자=홍길동 amount=123456 key=${secret}`);
    },
    writeOutput: line => lines.push(line),
    setExitCode: code => { exitCode = code; },
  });
  assert.deepEqual(report, {
    provider: 'rewardspace', ok: false, code: 'PLATFORM_CANARY_FAILED',
  });
  assert.equal(exitCode, 1);
  assert.equal(lines.length, 1);
  for (const forbidden of [secret, 'raw response', '홍길동', '123456']) {
    assert.equal(lines[0].includes(forbidden), false);
  }
});

test('canary source와 package script는 PM2/sync flag를 변경하지 않는다', () => {
  const source = fs.readFileSync(path.resolve(__dirname, 'peakos-platform-canary.js'), 'utf8');
  assert.doesNotMatch(source, /\bpm2\b/i);
  assert.doesNotMatch(source, /PEAKOS_PLATFORM_SYNC_(?:ENABLED|ON_STARTUP)/);
  assert.doesNotMatch(source, /process\.env\s*(?:\.|\[)/);
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['platform:canary'], 'node platform/peakos-platform-canary.js');
});
