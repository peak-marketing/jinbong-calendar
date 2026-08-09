'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const fixture = require('./fixtures/ibk-quick-readonly.json');
const providerModule = require('./ibk-quick-readonly');

const {
  ACCOUNT_IDS,
  IbkReadonlyError,
  assertPinnedAsset,
  createIbkQuickReadonlyProvider,
  encodeTranskeyField,
  parseIbkQuickTransactions,
  parseTranskeyCertificateScript,
  parseTranskeyNumberKeys,
  resolveRange,
  seedEncryptGeo,
  sha256Pins,
  _internals,
} = providerModule;

const TRANSKEY_JS_PIN = sha256Pins(Buffer.from(fixture.certificateScript, 'utf8')).sri;

function credentials() {
  return ACCOUNT_IDS.map((id, index) => ({
    id,
    accountNumber: (10_000_000_000_000n + BigInt(index + 1)).toString(),
    accountPassword: String(1_000 + index),
    identityNumber: '1234567',
  }));
}

function numberKeySource() {
  const keys = Array.from({ length: 10 }, (_, index) => `
var key = new Key();
key.name = "";
key.addPoint(${index * 20}, 0);
key.addPoint(${index * 20 + 10}, 0);
key.addPoint(${index * 20 + 10}, 10);
key.addPoint(${index * 20}, 10);
number.push(key);`).join('\n');
  return `var number = new Array();${keys}\nreturn [number];`;
}

function okResponse(body, headers = {}) {
  return new Response(body, { status: 200, headers });
}

function createFixtureFetch(options = {}) {
  const calls = [];
  let finalForm = null;
  const fetchImpl = async (urlValue, init) => {
    const url = new URL(urlValue);
    calls.push({ url: url.toString(), init });
    if (options.firstResponse) return options.firstResponse;
    if (url.pathname.endsWith('/PQCS101000_i.jsp')) {
      return okResponse('<html>fixture page</html>', { 'set-cookie': 'fixture_sid=abc123; Secure; HttpOnly' });
    }
    if (url.pathname.endsWith('/transkey.js')) {
      return options.transkeyScriptResponse || okResponse(fixture.certificateScript);
    }
    if (url.pathname === '/uib/transkeyServlet' && init.method === 'GET' && url.searchParams.get('op') === 'getToken') {
      return okResponse(fixture.tokenScript);
    }
    if (url.pathname === '/uib/transkeyServlet' && init.method === 'POST') {
      const body = new URLSearchParams(init.body);
      if (body.get('op') === 'setSessionKey') return okResponse(numberKeySource());
      if (body.get('op') === 'allocation') return okResponse('allocated');
    }
    if (url.pathname === '/uib/transkeyServlet' && init.method === 'GET' && url.searchParams.get('op') === 'getKey') {
      const png = Buffer.concat([
        Buffer.from('89504e470d0a1a0a', 'hex'),
        Buffer.from('fixture image bytes'),
      ]);
      return new Response(png, {
        status: options.keyImageStatus || 200,
        headers: { 'content-type': options.keyImageContentType || 'image/png' },
      });
    }
    if (/\/PQCS101000_i[1-4]\.jsp$/.test(url.pathname)) {
      finalForm = new URLSearchParams(init.body);
      if (options.transactionResponse) return options.transactionResponse;
      return okResponse("[{TRN_YMD:'20260806131415',TRN_AMT1:'0',TRN_AMT2:'7,000',AFTR_BAL:'0',TRN_SMR:'fixture deposit',GEAR_ACN:'123456789012',BNPR_CON:'online',TRN_SRNO:'fixture-1',TRN_CUSTOM_SEQ:'fixture-2',ROW_ID:'fixture-3',UNSAFE_VALUE:'must-not-be-a-field-name'}]");
    }
    throw new Error('unexpected fixture URL');
  };
  return { fetchImpl, calls, getFinalForm: () => finalForm };
}

function assertCode(code) {
  return (error) => error instanceof IbkReadonlyError && error.code === code;
}

test('SEED-CBC reproduces the browser fixture without remote code execution', () => {
  const encoded = seedEncryptGeo(
    fixture.seed.geo,
    fixture.seed.sessionKey,
    fixture.seed.randomPadByte,
  );
  assert.equal(encoded, fixture.seed.browserCsv);
  assert.equal(
    encoded.split(',').map((part) => part.padStart(2, '0')).join(''),
    fixture.seed.ciphertextHex,
  );

  const digitMap = new Map(Array.from({ length: 10 }, (_, digit) => [String(digit), `${digit} 5`]));
  const sequence = [42, 43, 0];
  const field = encodeTranskeyField('01', digitMap, fixture.seed.sessionKey, () => sequence.shift());
  assert.equal(field.placeholder, '00');
  assert.match(field.actualHidden, /^\$(?:[a-f0-9]+,){15}[a-f0-9]+\$(?:[a-f0-9]+,){15}[a-f0-9]+$/);
  assert.equal(field.paddedHidden, field.actualHidden);
  assert.match(field.hmac, /^[a-f0-9]{64}$/);
});

test('local SEED block cipher matches RFC 4269 vectors', () => {
  assert.equal(
    _internals.seedEncryptBlock(
      Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'),
      Buffer.alloc(16),
    ).toString('hex'),
    '5ebac6e0054e166819aff1cc6d346cdb',
  );
  assert.equal(
    _internals.seedEncryptBlock(
      Buffer.alloc(16),
      Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'),
    ).toString('hex'),
    'c11f22f20140505084483597e4370f43',
  );
});

test('certificate parser treats transkey.js as inert data and enforces one valid RSA certificate', () => {
  const pem = parseTranskeyCertificateScript(fixture.certificateScript);
  assert.match(pem, /^-----BEGIN CERTIFICATE-----\n/);
  assert.match(pem, /\n-----END CERTIFICATE-----$/);

  assert.throws(
    () => parseTranskeyCertificateScript(`${fixture.certificateScript}\n${fixture.certificateScript}`),
    assertCode('IBK_TRANSKEY_ERROR'),
  );
  assert.throws(
    () => parseTranskeyCertificateScript('var cert_pub = "-----BEGIN CERTIFICATE-----AAAA-----END CERTIFICATE-----";'),
    assertCode('IBK_TRANSKEY_ERROR'),
  );
  assert.throws(
    () => parseTranskeyCertificateScript(`var cert_pub = "${'A'.repeat(513 * 1024)}";`),
    assertCode('IBK_TRANSKEY_ERROR'),
  );
});

test('transkey.js bytes require an exact SHA-256 pin before certificate parsing', async () => {
  const scriptBytes = Buffer.from(fixture.certificateScript, 'utf8');
  assert.equal(assertPinnedAsset(scriptBytes, [TRANSKEY_JS_PIN]).sri, TRANSKEY_JS_PIN);
  assert.throws(
    () => assertPinnedAsset(scriptBytes, ['0'.repeat(64)]),
    assertCode('IBK_ASSET_PIN_MISMATCH'),
  );
  assert.throws(
    () => createIbkQuickReadonlyProvider({ accounts: [credentials()[0]] }),
    assertCode('IBK_ASSET_PIN_REQUIRED'),
  );

  const fake = createFixtureFetch();
  const provider = createIbkQuickReadonlyProvider({
    accounts: [credentials()[0]],
    transkeyJsSha256: '0'.repeat(64),
    fetchImpl: fake.fetchImpl,
    timeoutMs: 1_000,
  });
  await assert.rejects(
    provider.query({ accountId: 'ibk-hq-sales' }),
    assertCode('IBK_ASSET_PIN_MISMATCH'),
  );
});

test('number-key parser accepts bounded geometry and rejects malformed coordinates', () => {
  const keys = parseTranskeyNumberKeys(numberKeySource());
  assert.equal(keys.length, 10);
  const embeddedWithoutReturn = numberKeySource().replace(/\nreturn \[number\];$/, '')
    + '\nvar key = new Key(); key.name = "letter";';
  assert.equal(parseTranskeyNumberKeys(`<html>${embeddedWithoutReturn}</html>`).length, 10);
  assert.deepEqual(_internals.mapTranskeyDigits(keys, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).get('3'), '65 5');
  assert.throws(
    () => parseTranskeyNumberKeys(numberKeySource().replace('key.addPoint(0, 0);', 'key.addPoint(9999, 0);')),
    assertCode('IBK_TRANSKEY_ERROR'),
  );
});

test('request-token parser accepts the bounded 11-character IBK form', () => {
  assert.equal(
    _internals.parseRequestToken('var TK_requestToken = "Abc_123-xyz";'),
    'Abc_123-xyz',
  );
  assert.throws(
    () => _internals.parseRequestToken('var TK_requestToken = "short";'),
    assertCode('IBK_TRANSKEY_ERROR'),
  );
});

test('transaction parser returns only normalized, masked KST records', () => {
  const parsed = parseIbkQuickTransactions(fixture.transactionResponse, { accountId: 'ibk-hq-sales' });
  assert.equal(parsed.noData, false);
  assert.equal(parsed.transactions.length, 2);
  assert.deepEqual(parsed.transactions.map((row) => row.transactionAt), [
    '2026-08-06T11:02:03+09:00',
    '2026-08-06T12:34:56+09:00',
  ]);
  assert.deepEqual(parsed.transactions.map((row) => row.direction), ['WITHDRAWAL', 'DEPOSIT']);
  assert.deepEqual(parsed.transactions.map((row) => row.amount), [50_000, 1_234_500]);
  assert.equal(parsed.transactions[0].counterpartyAccount, '02-******-6789');
  assert.equal(parsed.transactions[1].counterpartyAccount, '12-******-9012');
  for (const row of parsed.transactions) {
    assert.match(row.providerTransactionKey, /^IBK_QUICK:[a-f0-9]{32}$/);
    assert.equal(row.providerKeyStable, false);
    assert.equal(Object.hasOwn(row, 'rawPayload'), false);
    assert.equal(Object.hasOwn(row, 'rawHtml'), false);
  }

  const zeroBalance = parseIbkQuickTransactions(
    "[{TRN_YMD:'20260806131415',TRN_AMT1:'0',TRN_AMT2:'1',AFTR_BAL:'0'}]",
    { accountId: 'ibk-hq-sales' },
  );
  assert.equal(zeroBalance.transactions[0].balance, 0);
  const dashPlaceholder = parseIbkQuickTransactions(
    "[{TRN_YMD:'20260806131415',TRN_AMT1:'-',TRN_AMT2:'1,000',AFTR_BAL:'—'}]",
    { accountId: 'ibk-hq-sales' },
  );
  assert.equal(dashPlaceholder.transactions[0].direction, 'DEPOSIT');
  assert.equal(dashPlaceholder.transactions[0].amount, 1_000);
  assert.equal(dashPlaceholder.transactions[0].balance, null);
  const decimalZeroAmounts = parseIbkQuickTransactions(
    "[{TRN_YMD:'20260806131415',TRN_AMT1:'0.00',TRN_AMT2:'1,000.0000',AFTR_BAL:'2,000.0'}]",
    { accountId: 'ibk-hq-sales' },
  );
  assert.equal(decimalZeroAmounts.transactions[0].direction, 'DEPOSIT');
  assert.equal(decimalZeroAmounts.transactions[0].amount, 1_000);
  assert.equal(decimalZeroAmounts.transactions[0].balance, 2_000);
  assert.deepEqual(
    parseIbkQuickTransactions(fixture.noDataResponse, { accountId: 'ibk-hq-sales' }),
    { noData: true, transactions: [] },
  );
});

test('transaction parser rejects ambiguous money, invalid dates, bank errors, and row floods', () => {
  assert.throws(
    () => parseIbkQuickTransactions(
      "[{TRN_YMD:'20260806131415',TRN_AMT1:'header label',TRN_AMT2:'0',AFTR_BAL:'0'}]",
      { accountId: 'ibk-hq-sales' },
    ),
    assertCode('IBK_FORMAT_OBJECT_WITHDRAWAL_TEXT'),
  );
  assert.throws(
    () => parseIbkQuickTransactions(
      '<table><tr><td>2026-08-06</td><td>header label</td><td>0</td><td>0</td><td>x</td><td></td><td></td><td></td><td></td></tr></table>',
      { accountId: 'ibk-hq-sales' },
    ),
    assertCode('IBK_FORMAT_TABLE_WITHDRAWAL_AMOUNT'),
  );
  assert.throws(
    () => parseIbkQuickTransactions(
      "[{TRN_YMD:'20260806131415',TRN_AMT1:'0',TRN_AMT2:'1.25',AFTR_BAL:'0'}]",
      { accountId: 'ibk-hq-sales' },
    ),
    assertCode('IBK_FORMAT_DEPOSIT_AMOUNT'),
  );
  assert.throws(
    () => parseIbkQuickTransactions(
      "[{TRN_YMD:'20260806131415',TRN_AMT1:'0',TRN_AMT2:'-1000',AFTR_BAL:'0'}]",
      { accountId: 'ibk-hq-sales' },
    ),
    assertCode('IBK_FORMAT_DEPOSIT_AMOUNT'),
  );
  assert.throws(
    () => parseIbkQuickTransactions(
      "[{TRN_YMD:'20260230131415',TRN_AMT1:'0',TRN_AMT2:'1',AFTR_BAL:'0'}]",
      { accountId: 'ibk-hq-sales' },
    ),
    assertCode('IBK_FORMAT_TRANSACTION_DATE'),
  );
  assert.throws(
    () => parseIbkQuickTransactions(
      "[{TRN_YMD:'20260806131415',TRN_AMT1:'1',TRN_AMT2:'2',AFTR_BAL:'0'}]",
      { accountId: 'ibk-hq-sales' },
    ),
    assertCode('IBK_FORMAT_DIRECTION'),
  );
  assert.throws(
    () => parseIbkQuickTransactions(
      "[{TRN_YMD:'20260806131415',TRN_AMT1:'0',TRN_AMT2:'1',AFTR_BAL:'unknown'}]",
      { accountId: 'ibk-hq-sales' },
    ),
    assertCode('IBK_FORMAT_BALANCE'),
  );
  assert.throws(
    () => parseIbkQuickTransactions('<html><body>unexpected fixture</body></html>', { accountId: 'ibk-hq-sales' }),
    assertCode('IBK_FORMAT_TRANSACTION_STRUCTURE'),
  );
  assert.throws(
    () => parseIbkQuickTransactions('{"result":"error","ERROR_CODE":"contains-remote-details"}', { accountId: 'ibk-hq-sales' }),
    assertCode('IBK_BANK_RESPONSE_ERROR'),
  );
  assert.throws(
    () => parseIbkQuickTransactions('<script>uf_alert("주민/사업자번호를 정확하게 입력하세요.");</script>', { accountId: 'ibk-hq-sales' }),
    assertCode('IBK_BANK_RESPONSE_ERROR'),
  );
  const row = "{TRN_YMD:'20260806131415',TRN_AMT1:'0',TRN_AMT2:'1'}";
  assert.throws(
    () => parseIbkQuickTransactions(row.repeat(2_001), { accountId: 'ibk-hq-sales' }),
    assertCode('IBK_RESPONSE_TOO_LARGE'),
  );
});

test('range output is RFC3339 in KST and limits query duration', () => {
  const range = resolveRange('2026-08-05T15:00:00Z', '2026-08-06T14:59:59Z');
  assert.equal(range.from, '2026-08-06T00:00:00+09:00');
  assert.equal(range.to, '2026-08-06T23:59:59+09:00');
  assert.throws(
    () => resolveRange('2026-01-01T00:00:00Z', '2026-02-01T00:00:01Z'),
    assertCode('IBK_RANGE_TOO_LARGE'),
  );
  assert.throws(
    () => resolveRange('2026-08-06', '2026-08-07T00:00:00Z'),
    assertCode('IBK_RANGE_INVALID'),
  );
  assert.throws(
    () => resolveRange('2026-02-30T00:00:00Z', '2026-03-03T00:00:00Z'),
    assertCode('IBK_RANGE_INVALID'),
  );
  assert.throws(
    () => resolveRange('2026-08-06T00:00Z', '2026-08-07T00:00:00Z'),
    assertCode('IBK_RANGE_INVALID'),
  );
});

test('provider accepts one scoped account and completes a fixture-only request flow', async () => {
  // The live servlet currently returns a valid PNG body with status 500 for
  // getKey. Only that exact, validated response shape is accepted.
  const fake = createFixtureFetch({ keyImageStatus: 500 });
  const provider = createIbkQuickReadonlyProvider({
    accounts: [credentials()[0]],
    transkeyJsSha256: TRANSKEY_JS_PIN,
    fetchImpl: fake.fetchImpl,
    detectDigitKeyIndexes: async () => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    randomBytes: (size) => Buffer.alloc(size, 1),
    randomInt: (minimum) => minimum,
    now: () => new Date('2026-08-06T00:00:00Z'),
    timeoutMs: 2_000,
    diagnosticFieldNames: true,
  });
  const result = await provider.query({
    accountId: 'ibk-hq-sales',
    from: '2026-08-05T15:00:00Z',
    to: '2026-08-06T14:59:59Z',
  });

  assert.equal(result.from, '2026-08-06T00:00:00+09:00');
  assert.equal(result.to, '2026-08-06T23:59:59+09:00');
  assert.equal(result.transactions.length, 1);
  assert.deepEqual(result.diagnosticFieldNames, ['ROW_ID', 'TRN_CUSTOM_SEQ', 'TRN_SRNO']);
  assert.deepEqual(result.transactions[0], {
    providerTransactionKey: result.transactions[0].providerTransactionKey,
    providerKeyStable: true,
    transactionAt: '2026-08-06T13:14:15+09:00',
    direction: 'DEPOSIT',
    amount: 7_000,
    balance: 0,
    summary: 'fixture deposit',
    counterpartyName: 'fixture deposit',
    counterpartyAccount: '12-******-9012',
    branch: 'online',
  });
  assert.equal(Object.hasOwn(result, 'rawHtml'), false);
  assert.equal(JSON.stringify(result).includes('rawPayload'), false);

  assert.ok(fake.calls.length >= 9);
  for (const call of fake.calls) {
    const url = new URL(call.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'kiup.ibk.co.kr');
    assert.equal(call.init.redirect, 'manual');
    assert.doesNotMatch(url.pathname, /TranskeyLib/i);
  }
  const form = fake.getFinalForm();
  assert.ok(form);
  assert.equal(form.get('acnt_pwd'), '0000');
  assert.equal(form.get('rnno'), '0000000');
  assert.notEqual(form.get('E2E_acnt_pwd'), '1000');
  assert.notEqual(form.get('E2E_rnno'), '1234567');
  assert.match(form.get('transkey_HM_acnt_pwd'), /^[a-f0-9]{64}$/);
  const outside = await provider.query({
    accountId: 'ibk-hq-sales',
    from: '2026-08-06T14:00:00+09:00',
    to: '2026-08-06T15:00:00+09:00',
  });
  assert.equal(outside.transactions.length, 0);
  await assert.rejects(
    provider.query({ accountId: 'ibk-hq-fixed' }),
    assertCode('IBK_ACCOUNT_NOT_CONFIGURED'),
  );
});

test('fixed URL, size, redirect, timeout, and generic-error boundaries are enforced', async () => {
  assert.throws(
    () => _internals.assertAllowedUrl('https://kiup.ibk.co.kr.evil.example/uib/transkeyServlet'),
    assertCode('IBK_NETWORK_ERROR'),
  );
  assert.throws(
    () => _internals.assertAllowedUrl('https://kiup.ibk.co.kr/unknown'),
    assertCode('IBK_NETWORK_ERROR'),
  );

  const oversized = createIbkQuickReadonlyProvider({
    accounts: credentials(),
    transkeyJsSha256: TRANSKEY_JS_PIN,
    fetchImpl: async () => okResponse('x', { 'content-length': String(1024 * 1024 + 1) }),
    timeoutMs: 1_000,
  });
  await assert.rejects(
    oversized.query({ accountId: 'ibk-hq-sales' }),
    assertCode('IBK_RESPONSE_TOO_LARGE'),
  );

  const malformedPage = createIbkQuickReadonlyProvider({
    accounts: credentials(),
    transkeyJsSha256: TRANSKEY_JS_PIN,
    fetchImpl: async () => okResponse('x', { 'content-length': 'invalid' }),
    timeoutMs: 1_000,
  });
  await assert.rejects(
    malformedPage.query({ accountId: 'ibk-hq-sales' }),
    assertCode('IBK_FORMAT_PAGE_RESPONSE'),
  );

  const malformedTranskeyFetch = createFixtureFetch({
    transkeyScriptResponse: okResponse('x', { 'content-length': 'invalid' }),
  });
  const malformedTranskey = createIbkQuickReadonlyProvider({
    accounts: [credentials()[0]],
    transkeyJsSha256: TRANSKEY_JS_PIN,
    fetchImpl: malformedTranskeyFetch.fetchImpl,
    timeoutMs: 1_000,
  });
  await assert.rejects(
    malformedTranskey.query({ accountId: 'ibk-hq-sales' }),
    assertCode('IBK_FORMAT_TRANSKEY_RESPONSE'),
  );

  const malformedTransactionFetch = createFixtureFetch({
    transactionResponse: okResponse('x', { 'content-length': 'invalid' }),
  });
  const malformedTransaction = createIbkQuickReadonlyProvider({
    accounts: [credentials()[0]],
    transkeyJsSha256: TRANSKEY_JS_PIN,
    fetchImpl: malformedTransactionFetch.fetchImpl,
    detectDigitKeyIndexes: async () => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    randomBytes: size => Buffer.alloc(size, 1),
    randomInt: minimum => minimum,
    timeoutMs: 1_000,
  });
  await assert.rejects(
    malformedTransaction.query({ accountId: 'ibk-hq-sales' }),
    assertCode('IBK_FORMAT_TRANSACTION_RESPONSE'),
  );

  const redirected = createIbkQuickReadonlyProvider({
    accounts: credentials(),
    transkeyJsSha256: TRANSKEY_JS_PIN,
    fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }),
    timeoutMs: 1_000,
  });
  await assert.rejects(
    redirected.query({ accountId: 'ibk-hq-sales' }),
    assertCode('IBK_NETWORK_PAGE'),
  );

  const invalidKeyImageFetch = createFixtureFetch({
    keyImageStatus: 500,
    keyImageContentType: 'text/plain',
  });
  const invalidKeyImage = createIbkQuickReadonlyProvider({
    accounts: [credentials()[0]],
    transkeyJsSha256: TRANSKEY_JS_PIN,
    fetchImpl: invalidKeyImageFetch.fetchImpl,
    detectDigitKeyIndexes: async () => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    randomBytes: size => Buffer.alloc(size, 1),
    randomInt: minimum => minimum,
    timeoutMs: 1_000,
  });
  await assert.rejects(
    invalidKeyImage.query({ accountId: 'ibk-hq-sales' }),
    assertCode('IBK_BANK_RESPONSE_ERROR'),
  );

  const timedOut = createIbkQuickReadonlyProvider({
    accounts: credentials(),
    transkeyJsSha256: TRANSKEY_JS_PIN,
    fetchImpl: async () => new Promise(() => {}),
    timeoutMs: 25,
  });
  await assert.rejects(
    timedOut.query({ accountId: 'ibk-hq-sales' }),
    (error) => assertCode('IBK_REQUEST_TIMEOUT')(error)
      && !error.message.includes('1000')
      && !error.message.includes('1234567'),
  );

  const detectorFetch = createFixtureFetch();
  let detectorStarted = false;
  const detectorTimedOut = createIbkQuickReadonlyProvider({
    accounts: [credentials()[0]],
    transkeyJsSha256: TRANSKEY_JS_PIN,
    fetchImpl: detectorFetch.fetchImpl,
    detectDigitKeyIndexes: async () => {
      detectorStarted = true;
      return new Promise(() => {});
    },
    randomBytes: (size) => Buffer.alloc(size, 1),
    randomInt: (minimum) => minimum,
    timeoutMs: 100,
  });
  await assert.rejects(
    detectorTimedOut.query({ accountId: 'ibk-hq-sales' }),
    assertCode('IBK_REQUEST_TIMEOUT'),
  );
  assert.equal(detectorStarted, true);
});

test('provider source contains no dynamic remote-code path or raw response contract', () => {
  const source = fs.readFileSync(path.join(__dirname, 'ibk-quick-readonly.js'), 'utf8');
  assert.doesNotMatch(source, /node:vm|require\(['"](?:node:)?vm['"]\)|TranskeyLib|eval\s*\(|new\s+Function\b/);
  assert.doesNotMatch(source, /rawHtml|rawPayload/);
});
