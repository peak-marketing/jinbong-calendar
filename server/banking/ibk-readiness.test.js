'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createIbkQuickCollector,
  inspectIbkQuickReadiness,
} = require('./collectors/ibk-quick-collector');
const { buildBankConnectionHealth } = require('./peakos-banking');

const PIN = 'a'.repeat(64);
const configuredAccounts = [
  { id: 'ibk-hq-sales', accountNumberMasked: '56-********-4017' },
  { id: 'ibk-hq-supplier', accountNumberMasked: '56-********-1042' },
  { id: 'ibk-hq-fixed', accountNumberMasked: '56-********-1035' },
  { id: 'ibk-review-space', accountNumberMasked: '07-********-4015' },
  { id: 'ibk-reward-space', accountNumberMasked: '07-********-4022' },
];

function maskedRegistry() {
  return {
    publicAccounts: configuredAccounts,
    getCredentials() {
      throw new Error('readiness must not request credential values');
    },
  };
}

test('IBK preflight is network-free and returns only masked operational metadata', () => {
  let loadCount = 0;
  const result = inspectIbkQuickReadiness({
    enabled: true,
    runtimeEnv: {
      PEAKOS_IBK_TRANSKEY_JS_SHA256: PIN,
      PEAKOS_IBK_SCHEDULER_ENABLED: 'true',
    },
    secretPath: '/safe/test/ibk.env',
    loadConfig(options) {
      loadCount += 1;
      assert.deepEqual(options, { secretPath: '/safe/test/ibk.env' });
      return maskedRegistry();
    },
  });

  assert.equal(loadCount, 1);
  assert.deepEqual(result, {
    ready: true,
    status: 'READY',
    code: null,
    collectorEnabled: true,
    schedulerEnabled: true,
    credentialsReady: true,
    pinReady: true,
    configuredAccountCount: 5,
    configuredAccounts,
  });
  assert.equal(JSON.stringify(result).includes('password'), false);
  assert.equal(JSON.stringify(result).includes('identity'), false);
});

test('IBK preflight fails closed for disabled collector, missing pin and secret loader errors', () => {
  let loadCount = 0;
  const disabled = inspectIbkQuickReadiness({
    enabled: false,
    loadConfig() {
      loadCount += 1;
    },
  });
  assert.equal(disabled.status, 'DISABLED');
  assert.equal(disabled.code, 'IBK_COLLECTOR_DISABLED');
  assert.equal(loadCount, 0);

  const missingPin = inspectIbkQuickReadiness({
    enabled: true,
    runtimeEnv: {},
    loadConfig() {
      loadCount += 1;
    },
  });
  assert.equal(missingPin.status, 'BLOCKED');
  assert.equal(missingPin.code, 'IBK_ASSET_PIN_REQUIRED');
  assert.equal(loadCount, 0);

  const configError = Object.assign(new Error('must not be returned'), {
    code: 'IBK_SECRET_FILE_MODE',
  });
  const invalidSecret = inspectIbkQuickReadiness({
    enabled: true,
    runtimeEnv: { PEAKOS_IBK_TRANSKEY_JS_SHA256: PIN },
    loadConfig() {
      throw configError;
    },
  });
  assert.equal(invalidSecret.status, 'BLOCKED');
  assert.equal(invalidSecret.code, 'IBK_SECRET_FILE_MODE');
  assert.equal('message' in invalidSecret, false);

  const incompleteMapping = inspectIbkQuickReadiness({
    enabled: true,
    runtimeEnv: { PEAKOS_IBK_TRANSKEY_JS_SHA256: PIN },
    loadConfig() {
      return { publicAccounts: configuredAccounts.slice(0, 4) };
    },
  });
  assert.equal(incompleteMapping.status, 'BLOCKED');
  assert.equal(incompleteMapping.code, 'IBK_CONFIGURATION_ERROR');
});

test('enabled collector exposes a non-enumerable local readiness check', () => {
  const collector = createIbkQuickCollector({
    enabled: true,
    secretPath: '/safe/test/ibk.env',
    runtimeEnv: { PEAKOS_IBK_TRANSKEY_JS_SHA256: PIN },
    loadConfig: maskedRegistry,
  });
  assert.equal(typeof collector, 'function');
  assert.equal(typeof collector.getReadiness, 'function');
  assert.equal(Object.keys(collector).includes('getReadiness'), false);
  assert.equal(collector.getReadiness().status, 'MANUAL_ONLY');
});

function account(overrides = {}) {
  return {
    id: 'ibk-hq-sales',
    account_number_masked: '56-********-4017',
    is_active: true,
    last_sync_succeeded_at: '2026-08-17T12:50:00.000Z',
    last_sync_error: null,
    ...overrides,
  };
}

function collectorWith(readiness) {
  const collector = async () => ({ transactions: [] });
  collector.getReadiness = () => readiness;
  return collector;
}

const readyMetadata = {
  ready: true,
  status: 'READY',
  code: null,
  collectorEnabled: true,
  schedulerEnabled: true,
  credentialsReady: true,
  pinReady: true,
  configuredAccountCount: 5,
  configuredAccounts,
};

test('bank connection health distinguishes healthy, first-sync, stale and mapping blockers', () => {
  const now = new Date('2026-08-17T13:00:00.000Z');
  const healthy = buildBankConnectionHealth({
    collector: collectorWith(readyMetadata),
    accounts: [
      account(),
      account({
        id: 'ibk-hq-supplier',
        account_number_masked: '56-********-1042',
        last_sync_succeeded_at: '2026-08-17T12:45:00.000Z',
      }),
    ],
    now,
  });
  assert.equal(healthy.status, 'HEALTHY');
  assert.equal(healthy.connectedAccountCount, 2);
  assert.equal(healthy.synchronizedAccountCount, 2);
  assert.equal(healthy.lastSuccessfulSyncAt, '2026-08-17T12:50:00.000Z');
  assert.equal(JSON.stringify(healthy).includes('********'), false);
  assert.equal('configuredAccounts' in healthy, false);

  const waiting = buildBankConnectionHealth({
    collector: collectorWith(readyMetadata),
    accounts: [account({ last_sync_succeeded_at: null })],
    now,
  });
  assert.equal(waiting.status, 'WAITING_FIRST_SYNC');
  assert.equal(waiting.code, 'IBK_FIRST_SYNC_REQUIRED');

  const stale = buildBankConnectionHealth({
    collector: collectorWith(readyMetadata),
    accounts: [account({ last_sync_succeeded_at: '2026-08-17T10:00:00.000Z' })],
    now,
  });
  assert.equal(stale.status, 'STALE');
  assert.equal(stale.code, 'IBK_SYNC_STALE');

  const mismatch = buildBankConnectionHealth({
    collector: collectorWith(readyMetadata),
    accounts: [account({ account_number_masked: '00-********-0000' })],
    now,
  });
  assert.equal(mismatch.status, 'BLOCKED');
  assert.equal(mismatch.code, 'IBK_ACCOUNT_MAPPING_INCOMPLETE');
});

test('bank connection health reports disabled and recent failure without leaking errors', () => {
  const disabled = buildBankConnectionHealth({ collector: null, accounts: [account()] });
  assert.equal(disabled.status, 'DISABLED');
  assert.equal(disabled.code, 'IBK_COLLECTOR_DISABLED');
  assert.equal(disabled.collectorEnabled, false);

  const failed = buildBankConnectionHealth({
    collector: collectorWith(readyMetadata),
    accounts: [account({ last_sync_error: 'raw bank error must not be exposed' })],
    now: new Date('2026-08-17T13:00:00.000Z'),
  });
  assert.equal(failed.status, 'STALE');
  assert.equal(failed.code, 'IBK_RECENT_SYNC_FAILED');
  assert.equal(JSON.stringify(failed).includes('raw bank error'), false);
});
