'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PLATFORM_SYNC_CRON,
  createPlatformSettlementSyncRuntime,
} = require('./peakos-platform-sync-runtime');

const INDEX_SOURCE = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');

test('startup은 scheduler 생성 전에 미설정 provider 연결 상태를 정리한다', () => {
  const serviceCreation = INDEX_SOURCE.indexOf('const peakosPlatformSettlementSyncService = createPlatformSettlementSyncService');
  const reconciliation = INDEX_SOURCE.indexOf('await peakosPlatformSettlementSyncService.reconcileConnectionStates()');
  const runtimeCreation = INDEX_SOURCE.indexOf('peakosPlatformSettlementSyncRuntime = createPlatformSettlementSyncRuntime');
  assert.ok(serviceCreation >= 0);
  assert.ok(reconciliation > serviceCreation);
  assert.ok(runtimeCreation > reconciliation);
});

test('disabled 또는 key 미설정 runtime은 scheduler와 외부 sync를 시작하지 않는다', async () => {
  let syncCalls = 0;
  let scheduleCalls = 0;
  const disabled = createPlatformSettlementSyncRuntime({
    service: {
      configuredProviders: ['rewardspace'],
      syncCurrentAndPrevious: async () => { syncCalls += 1; },
    },
    scheduleCron: () => { scheduleCalls += 1; },
    enabled: false,
  });
  assert.equal(disabled.startScheduler(), null);
  assert.deepEqual(await disabled.run('startup'), { skipped: true, reason: 'disabled' });

  const unconfigured = createPlatformSettlementSyncRuntime({
    service: { configuredProviders: [], syncCurrentAndPrevious: async () => { syncCalls += 1; } },
    scheduleCron: () => { scheduleCalls += 1; },
    enabled: true,
  });
  assert.equal(unconfigured.startScheduler(), null);
  assert.deepEqual(await unconfigured.run('startup'), { skipped: true, reason: 'not_configured' });
  assert.equal(syncCalls, 0);
  assert.equal(scheduleCalls, 0);
});

test('scheduler는 KST 매일 02:17 한 번만 등록하고 current+previous service를 호출한다', async () => {
  let scheduled;
  let syncCalls = 0;
  const logs = [];
  const runtime = createPlatformSettlementSyncRuntime({
    service: {
      configuredProviders: ['rewardspace', 'reviewspace', 'keywordmaster'],
      syncCurrentAndPrevious: async () => {
        syncCalls += 1;
        return [
          { month: '2026-07', providers: [{ provider: 'rewardspace', ok: true }] },
          { month: '2026-08', providers: [{ provider: 'rewardspace', ok: true }] },
        ];
      },
    },
    scheduleCron: (...args) => { scheduled = args; return { stop() {} }; },
    enabled: true,
    logger: { info: line => logs.push(line), error: line => logs.push(line) },
  });

  assert.ok(runtime.startScheduler());
  assert.equal(PLATFORM_SYNC_CRON, '17 2 * * *');
  assert.equal(scheduled[0], PLATFORM_SYNC_CRON);
  assert.equal(scheduled[2].timezone, 'Asia/Seoul');
  const result = await scheduled[1]();
  assert.deepEqual(result, { skipped: false, months: 2, providers: 2, failedProviders: 0 });
  assert.equal(syncCalls, 1);
  assert.match(logs[0], /months=2 providers=2 failed=0/);
});

test('동시 실행을 막고 upstream 오류 원문이나 key를 로그에 남기지 않는다', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const logs = [];
  let calls = 0;
  const runtime = createPlatformSettlementSyncRuntime({
    service: {
      configuredProviders: ['rewardspace'],
      syncCurrentAndPrevious: async () => {
        calls += 1;
        await pending;
        const error = new Error('secret=vendor-key-do-not-log');
        error.code = 'PLATFORM_CONNECTOR_HTTP_ERROR';
        throw error;
      },
    },
    scheduleCron: () => null,
    enabled: true,
    logger: { info: line => logs.push(line), error: line => logs.push(line) },
  });

  const first = runtime.run('startup');
  assert.deepEqual(await runtime.run('scheduled'), { skipped: true, reason: 'busy' });
  release();
  assert.deepEqual(await first, {
    skipped: false,
    failed: true,
    code: 'PLATFORM_CONNECTOR_HTTP_ERROR',
  });
  assert.equal(calls, 1);
  assert.equal(logs.some(line => /vendor-key|secret=/.test(line)), false);
  assert.match(logs[0], /code=PLATFORM_CONNECTOR_HTTP_ERROR/);
});
