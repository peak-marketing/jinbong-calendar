'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  execute,
  normalizeResult,
  parseRequest,
  parseSelectedEnvironment,
  toPublicFailure,
} = require('./ibk-quick-worker');

const REQUEST = Object.freeze({
  version: 1,
  accountId: 'ibk-hq-sales',
  from: '2026-08-05T00:00:00.000Z',
  to: '2026-08-06T00:00:00.000Z',
  requestId: null,
});
const PIN = 'a'.repeat(64);

function environment() {
  return {
    IBK_QUICK_ACCOUNT_ID: REQUEST.accountId,
    IBK_QUICK_ACCOUNT_NUMBER: '12123456783456',
    IBK_QUICK_ACCOUNT_PASSWORD: '4321',
    IBK_QUICK_IDENTITY_NUMBER: '1234567',
    IBK_QUICK_TIMEOUT_MS: '20000',
    IBK_QUICK_TRANSKEY_JS_SHA256: PIN,
  };
}

function providerResult() {
  return {
    from: '2026-08-05T09:00:00+09:00',
    to: '2026-08-06T09:00:00+09:00',
    rawHtml: 'must-not-leave-worker',
    transactions: [{
      providerTransactionKey: `IBK_QUICK:${'a'.repeat(32)}`,
      providerKeyStable: false,
      transactionAt: '2026-08-05T10:20:30+09:00',
      direction: 'WITHDRAWAL',
      amount: 12000,
      balance: 34000,
      summary: '테스트',
      counterpartyName: '거래처',
      counterpartyAccount: '12345678901234',
      branch: '온라인',
      rawPayload: 'must-not-leave-worker',
    }],
  };
}

test('worker input accepts only the exact public request schema', () => {
  assert.deepEqual(parseRequest(JSON.stringify(REQUEST)), {
    accountId: REQUEST.accountId,
    from: REQUEST.from,
    to: REQUEST.to,
    requestId: null,
  });
  assert.throws(() => parseRequest(JSON.stringify({ ...REQUEST, accountPassword: '0000' })));
  assert.throws(() => parseRequest(JSON.stringify({ ...REQUEST, accountId: 'unknown' })));
  assert.throws(() => parseRequest(JSON.stringify({ ...REQUEST, from: '2026-08-05 00:00:00' })));
  assert.throws(() => parseRequest(JSON.stringify({ ...REQUEST, from: '2026-02-30T00:00:00Z' })));
});

test('selected environment is bound to the request and requires a valid pin', () => {
  const selected = parseSelectedEnvironment(environment(), REQUEST.accountId);
  assert.equal(selected.credentials.id, REQUEST.accountId);
  assert.equal(selected.credentials.accountNumber.length, 14);
  assert.equal(selected.credentials.accountPassword.length, 4);
  assert.equal(selected.credentials.identityNumber.length, 7);
  assert.equal(selected.transkeyJsSha256, PIN);
  assert.throws(() => parseSelectedEnvironment({ ...environment(), IBK_QUICK_ACCOUNT_ID: 'ibk-hq-fixed' }, REQUEST.accountId));
  const noPin = environment();
  delete noPin.IBK_QUICK_TRANSKEY_JS_SHA256;
  assert.throws(() => parseSelectedEnvironment(noPin, REQUEST.accountId));
});

test('provider output is reduced to public fields and secret text is redacted', () => {
  const output = normalizeResult(REQUEST, {
    ...providerResult(),
    transactions: [{
      ...providerResult().transactions[0],
      summary: 'account 12123456783456 password 4321',
    }],
  }, ['12123456783456', '4321', '1234567']);
  assert.deepEqual(Object.keys(output).sort(), [
    'accountId', 'from', 'noData', 'ok', 'to', 'transactions',
  ]);
  assert.deepEqual(Object.keys(output.transactions[0]).sort(), [
    'amount', 'balance', 'branch', 'counterpartyAccountMasked', 'counterpartyName',
    'direction', 'providerKeyStable', 'providerTransactionKey', 'summary', 'transactionAt',
  ]);
  assert.match(output.transactions[0].counterpartyAccountMasked, /^12-\*+-1234$/);
  assert.equal(JSON.stringify(output).includes('must-not-leave-worker'), false);
  assert.equal(JSON.stringify(output).includes('12123456783456'), false);
  assert.equal(JSON.stringify(output).includes('4321'), false);
});

test('execute passes exactly one credential record and clears child secret env', async () => {
  const childEnvironment = environment();
  let providerOptions;
  let queryInput;
  const output = await execute(REQUEST, {
    environment: childEnvironment,
    createProvider(options) {
      providerOptions = options;
      return {
        async query(input) {
          queryInput = input;
          return providerResult();
        },
      };
    },
  });

  assert.equal(Array.isArray(providerOptions.accounts), true);
  assert.equal(providerOptions.accounts.length, 1);
  assert.equal(providerOptions.accounts[0].id, REQUEST.accountId);
  assert.equal(providerOptions.timeoutMs, 20000);
  assert.equal(providerOptions.transkeyJsSha256, PIN);
  assert.deepEqual(queryInput, {
    accountId: REQUEST.accountId,
    from: REQUEST.from,
    to: REQUEST.to,
  });
  assert.equal(Object.keys(childEnvironment).length, 0);
  assert.equal(output.ok, true);
  assert.equal(JSON.stringify(output).includes('12123456783456'), false);
  assert.equal(JSON.stringify(output).includes('4321'), false);
});

test('errors expose only allowlisted code and fixed message', () => {
  const providerError = new Error('remote account=12345678901234');
  providerError.code = 'IBK_ASSET_PIN_MISMATCH';
  assert.deepEqual(toPublicFailure(providerError), {
    code: 'IBK_ASSET_PIN_MISMATCH',
    message: 'IBK 보안 자산 무결성 검증에 실패했습니다.',
  });
  providerError.code = 'IBK_FORMAT_TRANSACTION_STRUCTURE';
  assert.deepEqual(toPublicFailure(providerError), {
    code: 'IBK_FORMAT_TRANSACTION_STRUCTURE',
    message: 'IBK 거래조회 행 구조가 변경되었습니다.',
  });
  assert.equal(JSON.stringify(toPublicFailure(new Error('secret value'))).includes('secret value'), false);
});

test('worker source cannot read the parent secret file', () => {
  const source = fs.readFileSync(path.join(__dirname, 'ibk-quick-worker.js'), 'utf8');
  assert.doesNotMatch(source, /PEAKOS_IBK_SECRET_FILE|loadIbkAccountConfig|ibk-account-config/);
});
