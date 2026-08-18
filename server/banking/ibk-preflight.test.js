'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildPreflightReport } = require('./ibk-preflight');

test('offline preflight emits flags and account IDs without secret material', () => {
  let calls = 0;
  const report = buildPreflightReport({
    environment: {
      PEAKOS_IBK_ENABLED: 'true',
      PEAKOS_IBK_SCHEDULER_ENABLED: 'true',
      PEAKOS_IBK_TRANSKEY_JS_SHA256: 'b'.repeat(64),
    },
    secretPath: '/safe/ibk.env',
    loadConfig(options) {
      calls += 1;
      assert.deepEqual(options, { secretPath: '/safe/ibk.env' });
      return {
        publicAccounts: [
          { id: 'ibk-hq-sales', accountNumberMasked: '56-********-4017' },
          { id: 'ibk-hq-supplier', accountNumberMasked: '56-********-1042' },
          { id: 'ibk-hq-fixed', accountNumberMasked: '56-********-1035' },
          { id: 'ibk-review-space', accountNumberMasked: '07-********-4015' },
          { id: 'ibk-reward-space', accountNumberMasked: '07-********-4022' },
        ],
      };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(report, {
    ok: true,
    status: 'READY',
    errorCode: null,
    collectorEnabled: true,
    schedulerEnabled: true,
    pinReady: true,
    credentialsReady: true,
    configuredAccountCount: 5,
    configuredAccountIds: [
      'ibk-hq-sales',
      'ibk-hq-supplier',
      'ibk-hq-fixed',
      'ibk-review-space',
      'ibk-reward-space',
    ],
    networkRequestPerformed: false,
  });
  assert.equal(JSON.stringify(report).includes('********'), false);
});

test('offline preflight fails closed before loading secrets when collector is disabled', () => {
  let called = false;
  const report = buildPreflightReport({
    environment: {},
    loadConfig() {
      called = true;
    },
  });
  assert.equal(called, false);
  assert.equal(report.ok, false);
  assert.equal(report.errorCode, 'IBK_COLLECTOR_DISABLED');
  assert.equal(report.networkRequestPerformed, false);
});
