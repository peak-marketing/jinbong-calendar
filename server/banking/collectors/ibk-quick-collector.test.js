'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  IbkCollectorError,
  buildWorkerEnvironment,
  createIbkQuickCollector,
  normalizeWorkerResult,
  redactSensitiveText,
  resolveRange,
} = require('./ibk-quick-collector');

const FROM = '2026-08-05T00:00:00.000Z';
const TO = '2026-08-06T00:00:00.000Z';
const PIN = 'a'.repeat(64);
const successWorker = path.join(__dirname, 'fixtures', 'public-success-worker.js');
const hangingWorker = path.join(__dirname, 'fixtures', 'hanging-worker.js');
const stderrWorker = path.join(__dirname, 'fixtures', 'stderr-secret-worker.js');
const ACCOUNTS = Object.freeze({
  'ibk-hq-sales': Object.freeze({ number: '12123456783456', mask: '12-********-3456' }),
  'ibk-hq-supplier': Object.freeze({ number: '22123456783457', mask: '22-********-3457' }),
  'ibk-hq-fixed': Object.freeze({ number: '32123456783458', mask: '32-********-3458' }),
  'ibk-review-space': Object.freeze({ number: '42123456783459', mask: '42-********-3459' }),
  'ibk-reward-space': Object.freeze({ number: '52123456783460', mask: '52-********-3460' }),
});

function secretsText() {
  return [
    'PEAKOS_IBK_IDENTITY_NUMBER=1234567',
    `PEAKOS_IBK_HQ_SALES_ACCOUNT_NUMBER=${ACCOUNTS['ibk-hq-sales'].number}`,
    'PEAKOS_IBK_HQ_SALES_ACCOUNT_PASSWORD=4321',
    `PEAKOS_IBK_HQ_SUPPLIER_ACCOUNT_NUMBER=${ACCOUNTS['ibk-hq-supplier'].number}`,
    'PEAKOS_IBK_HQ_SUPPLIER_ACCOUNT_PASSWORD=4321',
    `PEAKOS_IBK_HQ_FIXED_ACCOUNT_NUMBER=${ACCOUNTS['ibk-hq-fixed'].number}`,
    'PEAKOS_IBK_HQ_FIXED_ACCOUNT_PASSWORD=4321',
    `PEAKOS_IBK_REVIEW_SPACE_ACCOUNT_NUMBER=${ACCOUNTS['ibk-review-space'].number}`,
    'PEAKOS_IBK_REVIEW_SPACE_ACCOUNT_PASSWORD=4321',
    `PEAKOS_IBK_REWARD_SPACE_ACCOUNT_NUMBER=${ACCOUNTS['ibk-reward-space'].number}`,
    'PEAKOS_IBK_REWARD_SPACE_ACCOUNT_PASSWORD=4321',
    '',
  ].join('\n');
}

function temporarySecretFile(mode = 0o600) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peakos-ibk-collector-'));
  const file = path.join(directory, 'ibk.env');
  fs.writeFileSync(file, secretsText(), { mode: 0o600 });
  fs.chmodSync(directory, 0o700);
  fs.chmodSync(file, mode);
  return {
    file,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function publicAccount(accountId = 'ibk-hq-sales') {
  return {
    id: accountId,
    provider: 'IBK_QUICK',
    accountNumberMasked: ACCOUNTS[accountId].mask,
  };
}

function expectCode(code) {
  return (error) => {
    assert.equal(error instanceof IbkCollectorError, true);
    assert.equal(error.code, code);
    return true;
  };
}

function makeCollector(secretPath, workerPath = successWorker, options = {}) {
  return createIbkQuickCollector({
    enabled: true,
    secretPath,
    workerPath,
    runtimeEnv: { PEAKOS_IBK_TRANSKEY_JS_SHA256: PIN },
    workerTimeoutMs: 2_000,
    ...options,
  });
}

test('collector remains disabled until explicitly enabled', () => {
  assert.equal(createIbkQuickCollector(), null);
  assert.equal(createIbkQuickCollector({ enabled: false }), null);
});

test('child receives one selected account and no inherited parent environment', () => {
  const environment = buildWorkerEnvironment({
    accountId: 'ibk-hq-sales',
    credentials: {
      accountNumber: ACCOUNTS['ibk-hq-sales'].number,
      accountPassword: '4321',
      identityNumber: '1234567',
    },
    timeoutMs: 20000,
    transkeyJsSha256: PIN,
  });
  assert.deepEqual(Object.keys(environment).sort(), [
    'IBK_QUICK_ACCOUNT_ID',
    'IBK_QUICK_ACCOUNT_NUMBER',
    'IBK_QUICK_ACCOUNT_PASSWORD',
    'IBK_QUICK_IDENTITY_NUMBER',
    'IBK_QUICK_TIMEOUT_MS',
    'IBK_QUICK_TRANSKEY_JS_SHA256',
    'LANG',
    'NODE_ENV',
    'TZ',
  ]);
  assert.equal('PEAKOS_IBK_HQ_SUPPLIER_ACCOUNT_NUMBER' in environment, false);
  assert.equal('PEAKOS_IBK_SECRET_FILE' in environment, false);
  assert.equal('PGPASSWORD' in environment, false);
  assert.equal('NODE_OPTIONS' in environment, false);
});

test('all five fixed account IDs complete an offline worker handshake', async () => {
  const secret = temporarySecretFile();
  try {
    for (const accountId of Object.keys(ACCOUNTS)) {
      const result = await makeCollector(secret.file)({
        account: publicAccount(accountId),
        from: FROM,
        to: TO,
        requestId: '00000000-0000-4000-8000-000000000000',
      });
      assert.equal(result.transactions.length, 1);
      assert.equal(new Date(result.from).getTime(), new Date(FROM).getTime());
      assert.equal(new Date(result.to).getTime(), new Date(TO).getTime());
      assert.equal(Object.hasOwn(result.transactions[0], 'rawPayload'), false);
      assert.equal(result.transactions[0].providerKeyStable, false);
      assert.equal(result.transactions[0].counterpartyAccount, '12-******-7890');
    }
  } finally {
    secret.cleanup();
  }
});

test('wrong display mask, unsafe file mode, and missing pin fail before spawn', async () => {
  const safe = temporarySecretFile();
  const unsafe = temporarySecretFile(0o640);
  let spawned = 0;
  const spawnImpl = () => {
    spawned += 1;
    throw new Error('must not spawn');
  };
  try {
    await assert.rejects(
      createIbkQuickCollector({
        enabled: true,
        secretPath: safe.file,
        runtimeEnv: { PEAKOS_IBK_TRANSKEY_JS_SHA256: PIN },
        spawnImpl,
      })({
        account: { ...publicAccount(), accountNumberMasked: '99-********-9999' },
        from: FROM,
        to: TO,
      }),
      expectCode('IBK_ACCOUNT_MISMATCH'),
    );
    await assert.rejects(
      createIbkQuickCollector({
        enabled: true,
        secretPath: unsafe.file,
        runtimeEnv: { PEAKOS_IBK_TRANSKEY_JS_SHA256: PIN },
        spawnImpl,
      })({ account: publicAccount(), from: FROM, to: TO }),
      expectCode('IBK_CONFIGURATION_ERROR'),
    );
    await assert.rejects(
      createIbkQuickCollector({
        enabled: true,
        secretPath: safe.file,
        runtimeEnv: {},
        spawnImpl,
      })({ account: publicAccount(), from: FROM, to: TO }),
      expectCode('IBK_ASSET_PIN_REQUIRED'),
    );
    assert.equal(spawned, 0);
  } finally {
    safe.cleanup();
    unsafe.cleanup();
  }
});

test('strict stdout schema rejects added raw fields and wrong account binding', () => {
  const base = {
    ok: true,
    accountId: 'ibk-hq-sales',
    from: FROM,
    to: TO,
    noData: false,
    transactions: [],
  };
  assert.throws(
    () => normalizeWorkerResult({ ...base, rawHtml: '<secret>' }, {
      accountId: 'ibk-hq-sales', from: FROM, to: TO,
    }),
    expectCode('IBK_WORKER_INVALID_OUTPUT'),
  );
  assert.throws(
    () => normalizeWorkerResult({ ...base, accountId: 'ibk-hq-fixed' }, {
      accountId: 'ibk-hq-sales', from: FROM, to: TO,
    }),
    expectCode('IBK_WORKER_INVALID_OUTPUT'),
  );
});

test('stalled worker is killed at the parent deadline', async () => {
  const secret = temporarySecretFile();
  try {
    const collector = makeCollector(secret.file, hangingWorker, { workerTimeoutMs: 75 });
    await assert.rejects(
      collector({ account: publicAccount(), from: FROM, to: TO }),
      expectCode('IBK_WORKER_TIMEOUT'),
    );
  } finally {
    secret.cleanup();
  }
});

test('worker stderr and untrusted error messages never escape', async () => {
  const secret = temporarySecretFile();
  try {
    let caught;
    try {
      await makeCollector(secret.file, stderrWorker)({ account: publicAccount(), from: FROM, to: TO });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught instanceof IbkCollectorError, true);
    assert.equal(caught.code, 'IBK_NETWORK_ERROR');
    const publicError = JSON.stringify(caught);
    assert.equal(publicError.includes(ACCOUNTS['ibk-hq-sales'].number), false);
    assert.equal(publicError.includes('4321'), false);
    assert.equal(publicError.includes('1234567'), false);
  } finally {
    secret.cleanup();
  }
});

test('range and redaction guards reject unsafe values', () => {
  assert.deepEqual(resolveRange(FROM, TO), { from: FROM, to: TO });
  assert.throws(() => resolveRange('2026-08-05 00:00:00', TO), expectCode('IBK_RANGE_INVALID'));
  assert.throws(() => resolveRange('2026-02-30T00:00:00Z', TO), expectCode('IBK_RANGE_INVALID'));
  assert.throws(
    () => resolveRange('2026-07-01T00:00:00.000Z', TO),
    expectCode('IBK_RANGE_TOO_LARGE'),
  );
  const redacted = redactSensitiveText(
    'account 12123456783456 identity=1234567 password=4321',
    ['12123456783456', '1234567', '4321'],
  );
  assert.equal(redacted.includes('12123456783456'), false);
  assert.equal(redacted.includes('1234567'), false);
  assert.equal(redacted.includes('4321'), false);
});
