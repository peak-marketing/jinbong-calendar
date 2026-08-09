'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DryRunArgumentError,
  parseArguments,
  runDryRead,
  safeFailure,
} = require('./ibk-dry-run');

test('live-read 확인과 5개 고정 account ID를 모두 요구한다', () => {
  assert.throws(
    () => parseArguments(['--account', 'ibk-hq-sales']),
    error => error instanceof DryRunArgumentError && error.code === 'LIVE_READ_CONFIRMATION_REQUIRED',
  );
  assert.throws(
    () => parseArguments(['--account', 'unknown', '--live-read']),
    error => error instanceof DryRunArgumentError && error.code === 'DRY_RUN_ACCOUNT_INVALID',
  );
  assert.deepEqual(
    parseArguments([
      '--account', 'ibk-hq-sales',
      '--from', '2026-08-05T00:00:00Z',
      '--to', '2026-08-06T00:00:00Z',
      '--live-read',
    ]),
    {
      accountId: 'ibk-hq-sales',
      from: '2026-08-05T00:00:00Z',
      to: '2026-08-06T00:00:00Z',
      liveRead: true,
    },
  );
});

test('dry-run 출력은 건수·기간만 남기고 거래 금액과 이름을 버린다', async () => {
  const collector = async () => ({
    accountId: 'ibk-hq-sales',
    from: '2026-08-05T00:00:00.000Z',
    to: '2026-08-06T00:00:00.000Z',
    noData: false,
    transactions: [{
      amount: 999999,
      counterpartyName: 'sensitive-name',
      providerKeyStable: true,
    }],
  });
  const output = await runDryRead({
    accountId: 'ibk-hq-sales',
    from: null,
    to: null,
    collector,
  });
  assert.deepEqual(output, {
    ok: true,
    accountId: 'ibk-hq-sales',
    range: {
      from: '2026-08-05T00:00:00.000Z',
      to: '2026-08-06T00:00:00.000Z',
    },
    transactionCount: 1,
    stableKeyCount: 1,
    fallbackKeyCount: 0,
    noData: false,
  });
  assert.equal(JSON.stringify(output).includes('999999'), false);
  assert.equal(JSON.stringify(output).includes('sensitive-name'), false);
});

test('기본 dry-run은 시크릿의 공개 마스크를 선택한 통장에 바인딩한다', async () => {
  let receivedAccount;
  let receivedConfigOptions = 'not-called';
  const output = await runDryRead({
    accountId: 'ibk-hq-sales',
    from: '2026-08-05T00:00:00Z',
    to: '2026-08-06T00:00:00Z',
    loadConfig: (configOptions) => {
      receivedConfigOptions = configOptions;
      return ({
        publicAccounts: [{ id: 'ibk-hq-sales', accountNumberMasked: '12-********-3456' }],
      });
    },
    createCollector: () => async ({ account }) => {
      receivedAccount = account;
      return {
        from: '2026-08-05T00:00:00.000Z',
        to: '2026-08-06T00:00:00.000Z',
        transactions: [],
      };
    },
  });
  assert.equal(receivedConfigOptions, undefined);
  assert.equal(receivedAccount.accountNumberMasked, '12-********-3456');
  assert.equal(output.noData, true);
});

test('실패 출력은 스택과 오류 문구를 버리고 code만 남긴다', () => {
  const error = new Error('account=12345678901234 password=0000');
  error.code = 'IBK_NETWORK_ERROR';
  assert.deepEqual(safeFailure(error, 'ibk-hq-sales'), {
    ok: false,
    accountId: 'ibk-hq-sales',
    errorCode: 'IBK_NETWORK_ERROR',
  });
  assert.equal(JSON.stringify(safeFailure(error)).includes(error.message), false);
  assert.deepEqual(safeFailure({ code: 'UNTRUSTED_REMOTE_CODE' }), {
    ok: false,
    accountId: null,
    errorCode: 'IBK_DRY_RUN_FAILED',
  });
  assert.deepEqual(safeFailure({ code: 'IBK_FORMAT_TRANSACTION_DATE' }, 'ibk-hq-sales'), {
    ok: false,
    accountId: 'ibk-hq-sales',
    errorCode: 'IBK_FORMAT_TRANSACTION_DATE',
  });
});
