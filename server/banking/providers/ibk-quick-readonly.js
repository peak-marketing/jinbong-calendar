'use strict';

const crypto = require('node:crypto');
const { parseRfc3339 } = require('../ibk-time');

const IBK_ORIGIN = 'https://kiup.ibk.co.kr';
const IBK_QUICK_PAGE_URL = `${IBK_ORIGIN}/uib/jsp/guest/qcs/qcs10/qcs1010/PQCS101000_i.jsp`;
const IBK_QUICK_ENDPOINT_BASE_URL = `${IBK_ORIGIN}/uib/jsp/guest/qcs/qcs10/qcs1010`;
const IBK_TRANSKEY_JS_URL = `${IBK_ORIGIN}/IBK/uib/sw/raon/Transkey/transkey.js`;
const IBK_TRANSKEY_SERVLET_URL = `${IBK_ORIGIN}/uib/transkeyServlet`;
const IBK_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const ACCOUNT_IDS = Object.freeze([
  'ibk-hq-sales',
  'ibk-hq-supplier',
  'ibk-hq-fixed',
  'ibk-review-space',
  'ibk-reward-space',
]);
const ACCOUNT_ID_SET = new Set(ACCOUNT_IDS);
const ALLOWED_PATHS = new Set([
  new URL(IBK_QUICK_PAGE_URL).pathname,
  new URL(IBK_TRANSKEY_JS_URL).pathname,
  new URL(IBK_TRANSKEY_SERVLET_URL).pathname,
  `${new URL(IBK_QUICK_ENDPOINT_BASE_URL).pathname}/PQCS101000_i1.jsp`,
  `${new URL(IBK_QUICK_ENDPOINT_BASE_URL).pathname}/PQCS101000_i2.jsp`,
  `${new URL(IBK_QUICK_ENDPOINT_BASE_URL).pathname}/PQCS101000_i3.jsp`,
  `${new URL(IBK_QUICK_ENDPOINT_BASE_URL).pathname}/PQCS101000_i4.jsp`,
]);

const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_TRANSKEY_SCRIPT_BYTES = 512 * 1024;
const MAX_TRANSKEY_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOKEN_BYTES = 64 * 1024;
const MAX_KEY_IMAGE_BYTES = 512 * 1024;
const MAX_TRANSACTION_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_COOKIE_BYTES = 8 * 1024;
const MAX_COOKIES = 64;
const MAX_ROWS = 2_000;
const MAX_OBJECT_CHARS = 16 * 1024;
const MAX_QUERY_DAYS = 30;
const DEFAULT_TIMEOUT_MS = 20_000;
const SEED_IV = Buffer.from('4d6f62696c655472616e734b65793130', 'hex');

// RFC 4269, Appendix A.1. The original 8-bit S-boxes keep this implementation
// independent of OpenSSL's optional legacy provider and any remote script.
const SEED_S0 = Buffer.from(`
  A9 85 D6 D3 54 1D AC 25 5D 43 18 1E 51 FC CA 63
  28 44 20 9D E0 E2 C8 17 A5 8F 03 7B BB 13 D2 EE
  70 8C 3F A8 32 DD F6 74 EC 95 0B 57 5C 5B BD 01
  24 1C 73 98 10 CC F2 D9 2C E7 72 83 9B D1 86 C9
  60 50 A3 EB 0D B6 9E 4F B7 5A C6 78 A6 12 AF D5
  61 C3 B4 41 52 7D 8D 08 1F 99 00 19 04 53 F7 E1
  FD 76 2F 27 B0 8B 0E AB A2 6E 93 4D 69 7C 09 0A
  BF EF F3 C5 87 14 FE 64 DE 2E 4B 1A 06 21 6B 66
  02 F5 92 8A 0C B3 7E D0 7A 47 96 E5 26 80 AD DF
  A1 30 37 AE 36 15 22 38 F4 A7 45 4C 81 E9 84 97
  35 CB CE 3C 71 11 C7 89 75 FB DA F8 94 59 82 C4
  FF 49 39 67 C0 CF D7 B8 0F 8E 42 23 91 6C DB A4
  34 F1 48 C2 6F 3D 2D 40 BE 3E BC C1 AA BA 4E 55
  3B DC 68 7F 9C D8 4A 56 77 A0 ED 46 B5 2B 65 FA
  E3 B9 B1 9F 5E F9 E6 B2 31 EA 6D 5F E4 F0 CD 88
  16 3A 58 D4 62 29 07 33 E8 1B 05 79 90 6A 2A 9A
`.replace(/\s/g, ''), 'hex');
const SEED_S1 = Buffer.from(`
  38 E8 2D A6 CF DE B3 B8 AF 60 55 C7 44 6F 6B 5B
  C3 62 33 B5 29 A0 E2 A7 D3 91 11 06 1C BC 36 4B
  EF 88 6C A8 17 C4 16 F4 C2 45 E1 D6 3F 3D 8E 98
  28 4E F6 3E A5 F9 0D DF D8 2B 66 7A 27 2F F1 72
  42 D4 41 C0 73 67 AC 8B F7 AD 80 1F CA 2C AA 34
  D2 0B EE E9 5D 94 18 F8 57 AE 08 C5 13 CD 86 B9
  FF 7D C1 31 F5 8A 6A B1 D1 20 D7 02 22 04 68 71
  07 DB 9D 99 61 BE E6 59 DD 51 90 DC 9A A3 AB D0
  81 0F 47 1A E3 EC 8D BF 96 7B 5C A2 A1 63 23 4D
  C8 9E 9C 3A 0C 2E BA 6E 9F 5A F2 92 F3 49 78 CC
  15 FB 70 75 7F 35 10 03 64 6D C6 74 D5 B4 EA 09
  76 19 FE 40 12 E0 BD 05 FA 01 F0 2A 5E A9 56 43
  85 14 89 9B B0 E5 48 79 97 FC 1E 82 21 8C 1B 5F
  77 54 B2 1D 25 4F 00 46 ED 58 52 EB 7E DA C9 FD
  30 95 65 3C B6 E4 BB 7C 0E 50 39 26 32 84 69 93
  37 E7 24 A4 CB 53 0A 87 D9 4C 83 8F CE 3B 4A B7
`.replace(/\s/g, ''), 'hex');
const SEED_ROUND_CONSTANTS = Object.freeze([
  0x9E3779B9, 0x3C6EF373, 0x78DDE6E6, 0xF1BBCDCC,
  0xE3779B99, 0xC6EF3733, 0x8DDE6E67, 0x1BBCDCCF,
  0x3779B99E, 0x6EF3733C, 0xDDE6E678, 0xBBCDCCF1,
  0x779B99E3, 0xEF3733C6, 0xDE6E678D, 0xBCDCCF1B,
]);

const PUBLIC_ERRORS = Object.freeze({
  IBK_CONFIG_INVALID: 'IBK 조회 설정이 올바르지 않습니다.',
  IBK_ASSET_PIN_REQUIRED: '검증된 IBK 보안 자산 해시가 설정되지 않았습니다.',
  IBK_ASSET_PIN_MISMATCH: 'IBK 보안 자산 무결성 검증에 실패했습니다.',
  IBK_ACCOUNT_NOT_CONFIGURED: '설정되지 않은 IBK 통장입니다.',
  IBK_RANGE_INVALID: 'IBK 조회 기간이 올바르지 않습니다.',
  IBK_RANGE_TOO_LARGE: 'IBK 빠른조회 기간은 최대 30일입니다.',
  IBK_NETWORK_ERROR: 'IBK 빠른조회 서버에 연결하지 못했습니다.',
  IBK_NETWORK_PAGE: 'IBK 빠른조회 초기 페이지에 연결하지 못했습니다.',
  IBK_NETWORK_TRANSKEY: 'IBK 보안키 서비스에 연결하지 못했습니다.',
  IBK_NETWORK_TRANSACTION: 'IBK 거래조회 서비스에 연결하지 못했습니다.',
  IBK_REQUEST_TIMEOUT: 'IBK 빠른조회 요청 시간이 초과되었습니다.',
  IBK_RESPONSE_TOO_LARGE: 'IBK 빠른조회 응답이 허용 크기를 초과했습니다.',
  IBK_RESPONSE_FORMAT_CHANGED: 'IBK 빠른조회 응답 형식이 변경되었습니다.',
  IBK_FORMAT_PAGE_RESPONSE: 'IBK 빠른조회 초기 페이지 응답 형식이 변경되었습니다.',
  IBK_FORMAT_TRANSKEY_RESPONSE: 'IBK 보안키 응답 형식이 변경되었습니다.',
  IBK_FORMAT_TRANSACTION_RESPONSE: 'IBK 거래조회 응답 형식이 변경되었습니다.',
  IBK_FORMAT_TRANSACTION_STRUCTURE: 'IBK 거래조회 행 구조가 변경되었습니다.',
  IBK_FORMAT_TRANSACTION_DATE: 'IBK 거래일시 필드 형식이 변경되었습니다.',
  IBK_FORMAT_WITHDRAWAL_AMOUNT: 'IBK 출금액 필드 형식이 변경되었습니다.',
  IBK_FORMAT_OBJECT_WITHDRAWAL_AMOUNT: 'IBK 거래 객체의 출금액 필드 형식이 변경되었습니다.',
  IBK_FORMAT_TABLE_WITHDRAWAL_AMOUNT: 'IBK 거래 표의 출금액 필드 형식이 변경되었습니다.',
  IBK_FORMAT_OBJECT_WITHDRAWAL_TEXT: 'IBK 거래 객체의 출금액 필드가 텍스트 형식입니다.',
  IBK_FORMAT_OBJECT_WITHDRAWAL_SIGNED: 'IBK 거래 객체의 출금액 필드가 부호 형식입니다.',
  IBK_FORMAT_OBJECT_WITHDRAWAL_DECIMAL: 'IBK 거래 객체의 출금액 필드가 소수 형식입니다.',
  IBK_FORMAT_OBJECT_WITHDRAWAL_CURRENCY: 'IBK 거래 객체의 출금액 필드가 통화표기 형식입니다.',
  IBK_FORMAT_OBJECT_WITHDRAWAL_MIXED: 'IBK 거래 객체의 출금액 필드가 혼합 형식입니다.',
  IBK_FORMAT_DEPOSIT_AMOUNT: 'IBK 입금액 필드 형식이 변경되었습니다.',
  IBK_FORMAT_BALANCE: 'IBK 잔액 필드 형식이 변경되었습니다.',
  IBK_FORMAT_DIRECTION: 'IBK 입출금 구분 형식이 변경되었습니다.',
  IBK_BANK_RESPONSE_ERROR: 'IBK 빠른조회 응답이 오류를 반환했습니다.',
  IBK_TRANSKEY_ERROR: 'IBK 보안키 입력을 준비하지 못했습니다.',
  IBK_SEED_UNAVAILABLE: 'IBK 보안 암호화 기능을 사용할 수 없습니다.',
  IBK_QUERY_FAILED: 'IBK 빠른조회를 완료하지 못했습니다.',
});

class IbkReadonlyError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(PUBLIC_ERRORS, code) ? code : 'IBK_QUERY_FAILED';
    super(PUBLIC_ERRORS[safeCode]);
    this.name = 'IbkReadonlyError';
    this.code = safeCode;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message };
  }
}

function fail(code) {
  throw new IbkReadonlyError(code);
}

async function withFormatStage(code, networkCode, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IbkReadonlyError && error.code === 'IBK_RESPONSE_FORMAT_CHANGED') {
      fail(code);
    }
    if (error instanceof IbkReadonlyError && error.code === 'IBK_NETWORK_ERROR') {
      fail(networkCode);
    }
    throw error;
  }
}

function withFormatStageSync(code, operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof IbkReadonlyError && error.code === 'IBK_RESPONSE_FORMAT_CHANGED') {
      fail(code);
    }
    throw error;
  }
}

function normalizeSha256Pins(value) {
  const entries = Array.isArray(value)
    ? value
    : String(value || '').split(/[\s,]+/).filter(Boolean);
  if (!entries.length) fail('IBK_ASSET_PIN_REQUIRED');
  if (entries.length > 8 || entries.some((entry) => typeof entry !== 'string' || !(
    /^[a-f0-9]{64}$/i.test(entry) || /^sha256-[A-Za-z0-9+/]{43}=$/.test(entry)
  ))) fail('IBK_CONFIG_INVALID');
  return Object.freeze(entries.map((entry) => (
    /^[a-f0-9]{64}$/i.test(entry) ? entry.toLowerCase() : entry
  )));
}

function sha256Pins(buffer) {
  if (!Buffer.isBuffer(buffer)) fail('IBK_CONFIG_INVALID');
  const digest = crypto.createHash('sha256').update(buffer).digest();
  return Object.freeze({
    hex: digest.toString('hex'),
    sri: `sha256-${digest.toString('base64')}`,
  });
}

function assertPinnedAsset(buffer, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length < 1 || allowlist.length > 8) {
    fail('IBK_ASSET_PIN_REQUIRED');
  }
  const calculated = sha256Pins(buffer);
  if (!allowlist.some((pin) => pin === calculated.hex || pin === calculated.sri)) {
    fail('IBK_ASSET_PIN_MISMATCH');
  }
  return calculated;
}

function assertAllowedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('IBK_NETWORK_ERROR');
  }
  if (url.protocol !== 'https:'
    || url.hostname !== 'kiup.ibk.co.kr'
    || (url.port && url.port !== '443')
    || url.username
    || url.password
    || url.hash
    || !ALLOWED_PATHS.has(url.pathname)) {
    fail('IBK_NETWORK_ERROR');
  }
  return url;
}

function normalizeCredential(record, fallbackId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('IBK_CONFIG_INVALID');
  const id = String(record.id || fallbackId || '');
  const accountNumber = String(record.accountNumber || '');
  const accountPassword = String(record.accountPassword || '');
  const rawIdentity = String(record.identityNumber || '');
  if (!ACCOUNT_ID_SET.has(id)
    || !/^\d{10}$|^\d{11}$|^\d{14}$/.test(accountNumber)
    || !/^\d{4}$/.test(accountPassword)
    || !/^\d{7}$|^\d{10}$/.test(rawIdentity)) {
    fail('IBK_CONFIG_INVALID');
  }
  return Object.freeze({
    id,
    accountNumber,
    accountPassword,
    identityNumber: rawIdentity.length === 10 ? rawIdentity.slice(-7) : rawIdentity,
  });
}

function normalizeAccounts(accounts) {
  let records;
  if (accounts && typeof accounts.getCredentials === 'function') {
    try {
      records = ACCOUNT_IDS.map((id) => normalizeCredential(accounts.getCredentials(id), id));
    } catch (error) {
      if (error instanceof IbkReadonlyError) throw error;
      fail('IBK_CONFIG_INVALID');
    }
  } else if (Array.isArray(accounts)) {
    records = accounts.map((record) => normalizeCredential(record));
  } else if (accounts instanceof Map) {
    records = Array.from(accounts, ([id, record]) => normalizeCredential(record, id));
  } else {
    fail('IBK_CONFIG_INVALID');
  }

  if (records.length < 1 || records.length > ACCOUNT_IDS.length) fail('IBK_CONFIG_INVALID');
  const byId = new Map();
  const numbers = new Set();
  for (const record of records) {
    if (byId.has(record.id) || numbers.has(record.accountNumber)) fail('IBK_CONFIG_INVALID');
    byId.set(record.id, record);
    numbers.add(record.accountNumber);
  }
  return byId;
}

function parseInstant(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return new Date(value.getTime());
    fail('IBK_RANGE_INVALID');
  }
  const parsed = parseRfc3339(value);
  if (!parsed) fail('IBK_RANGE_INVALID');
  return parsed;
}

function formatInstantKst(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const values = ['year', 'month', 'day', 'hour', 'minute', 'second'].map(get);
  if (values.some((part) => !part)) fail('IBK_RANGE_INVALID');
  const milliseconds = date.getUTCMilliseconds();
  const fraction = milliseconds ? `.${String(milliseconds).padStart(3, '0')}` : '';
  return `${values[0]}-${values[1]}-${values[2]}T${values[3]}:${values[4]}:${values[5]}${fraction}+09:00`;
}

function resolveRange(from, to, now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail('IBK_CONFIG_INVALID');
  const rangeTo = parseInstant(to, new Date(now.getTime()));
  const rangeFrom = parseInstant(from, new Date(rangeTo.getTime() - 86_400_000));
  const duration = rangeTo.getTime() - rangeFrom.getTime();
  if (duration <= 0) fail('IBK_RANGE_INVALID');
  if (duration > MAX_QUERY_DAYS * 86_400_000) fail('IBK_RANGE_TOO_LARGE');
  return {
    fromDate: rangeFrom,
    toDate: rangeTo,
    from: formatInstantKst(rangeFrom),
    to: formatInstantKst(rangeTo),
  };
}

function kstDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return { year: get('year'), month: get('month'), day: get('day') };
}

function ymd(parts) {
  return `${parts.year}${parts.month}${parts.day}`;
}

function dashedYmd(parts) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function accountEndpointUrl(accountNumber) {
  const code = accountNumber.length === 14
    ? accountNumber.slice(9, 11)
    : accountNumber.length === 10 || accountNumber.length === 11
      ? '01'
      : '';
  if (code === '96') return `${IBK_QUICK_ENDPOINT_BASE_URL}/PQCS101000_i1.jsp`;
  if (['14', '15', '17', '18', '20', '28'].includes(code)) {
    return `${IBK_QUICK_ENDPOINT_BASE_URL}/PQCS101000_i2.jsp`;
  }
  if (code === '29') return `${IBK_QUICK_ENDPOINT_BASE_URL}/PQCS101000_i3.jsp`;
  return `${IBK_QUICK_ENDPOINT_BASE_URL}/PQCS101000_i4.jsp`;
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  merge(response) {
    const headers = response?.headers;
    if (!headers || typeof headers.get !== 'function') fail('IBK_NETWORK_ERROR');
    let values = [];
    if (typeof headers.getSetCookie === 'function') values = headers.getSetCookie();
    else if (headers.get('set-cookie')) values = [headers.get('set-cookie')];
    if (!Array.isArray(values) || values.length > MAX_COOKIES) fail('IBK_NETWORK_ERROR');

    for (const value of values) {
      if (typeof value !== 'string' || /[\r\n]/.test(value)) fail('IBK_NETWORK_ERROR');
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)
        || cookieValue.length > 2_048
        || /[\s;,]/.test(cookieValue)) {
        fail('IBK_NETWORK_ERROR');
      }
      this.cookies.set(name, cookieValue);
      if (this.cookies.size > MAX_COOKIES || Buffer.byteLength(this.header(), 'utf8') > MAX_COOKIE_BYTES) {
        fail('IBK_NETWORK_ERROR');
      }
    }
  }

  header() {
    return Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join('; ');
  }
}

function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => reject(abortError());
    const finish = (callback, value) => {
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function readLimitedBuffer(response, maxBytes, signal) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && !/^\d+$/.test(contentLength.trim())) fail('IBK_RESPONSE_FORMAT_CHANGED');
  if (contentLength !== null && Number(contentLength) > maxBytes) fail('IBK_RESPONSE_TOO_LARGE');

  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await raceAbort(response.arrayBuffer(), signal));
    if (buffer.length > maxBytes) fail('IBK_RESPONSE_TOO_LARGE');
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let chunkCount = 0;
  while (true) {
    const { value, done } = await raceAbort(reader.read(), signal);
    if (done) break;
    if (!(value instanceof Uint8Array)) fail('IBK_RESPONSE_FORMAT_CHANGED');
    total += value.byteLength;
    chunkCount += 1;
    if (total > maxBytes || chunkCount > 4_096) {
      await reader.cancel().catch(() => {});
      fail('IBK_RESPONSE_TOO_LARGE');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function fixedFetchBuffer(fetchImpl, jar, value, init, maxBytes, signal, policy = null) {
  const url = assertAllowedUrl(value);
  const method = String(init?.method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) fail('IBK_NETWORK_ERROR');
  const body = init?.body === undefined ? undefined : String(init.body);
  if (body !== undefined && Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) fail('IBK_TRANSKEY_ERROR');
  const headers = new Headers(init?.headers || {});
  headers.set('User-Agent', IBK_BROWSER_USER_AGENT);
  const cookie = jar.header();
  if (cookie) headers.set('Cookie', cookie);
  else headers.delete('Cookie');

  let response;
  try {
    response = await raceAbort(fetchImpl(url, {
      method,
      body: method === 'POST' ? body : undefined,
      headers,
      signal,
      redirect: 'manual',
    }), signal);
  } catch (error) {
    if (error instanceof IbkReadonlyError) throw error;
    if (signal.aborted || error?.name === 'AbortError') fail('IBK_REQUEST_TIMEOUT');
    fail('IBK_NETWORK_ERROR');
  }

  if (!response || typeof response.status !== 'number' || !response.headers) fail('IBK_NETWORK_ERROR');
  if (response.url) assertAllowedUrl(response.url);
  jar.merge(response);
  if (response.status >= 300 && response.status < 400) fail('IBK_NETWORK_ERROR');
  const acceptsLiveKeyImage500 = policy === 'IBK_KEY_IMAGE'
    && response.status === 500
    && method === 'GET'
    && url.pathname === new URL(IBK_TRANSKEY_SERVLET_URL).pathname
    && url.searchParams.get('op') === 'getKey'
    && /^image\/png(?:\s*;|$)/i.test(response.headers.get('content-type') || '');
  if ((response.status < 200 || response.status >= 300) && !acceptsLiveKeyImage500) {
    fail('IBK_BANK_RESPONSE_ERROR');
  }

  try {
    const buffer = await readLimitedBuffer(response, maxBytes, signal);
    if (acceptsLiveKeyImage500
      && (buffer.length < 8
        || !buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))) {
      fail('IBK_BANK_RESPONSE_ERROR');
    }
    return buffer;
  } catch (error) {
    if (error instanceof IbkReadonlyError) throw error;
    if (signal.aborted || error?.name === 'AbortError') fail('IBK_REQUEST_TIMEOUT');
    fail('IBK_NETWORK_ERROR');
  }
}

function decode(buffer, encoding = 'utf-8') {
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    fail('IBK_RESPONSE_FORMAT_CHANGED');
  }
}

function parseTranskeyCertificateScript(source) {
  if (typeof source !== 'string'
    || Buffer.byteLength(source, 'utf8') > MAX_TRANSKEY_SCRIPT_BYTES
    || source.includes('\u0000')) {
    fail('IBK_TRANSKEY_ERROR');
  }
  const matches = [];
  const declaration = /(?:^|[;\r\n])\s*var\s+cert_pub\s*=\s*"([^"\\\r\n]{256,20000})"\s*;/g;
  for (const match of source.matchAll(declaration)) matches.push(match[1]);
  if (matches.length !== 1) fail('IBK_TRANSKEY_ERROR');

  const certificateMatch = /^-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\t ]{512,16384})-----END CERTIFICATE-----$/.exec(matches[0]);
  if (!certificateMatch) fail('IBK_TRANSKEY_ERROR');
  const base64 = certificateMatch[1].replace(/[\t ]/g, '');
  if (base64.length < 512 || base64.length > 16_384 || base64.length % 4 !== 0) fail('IBK_TRANSKEY_ERROR');
  const der = Buffer.from(base64, 'base64');
  const canonical = der.toString('base64').replace(/=+$/, '');
  if (der.length < 384 || der.length > 12_288 || canonical !== base64.replace(/=+$/, '')) {
    fail('IBK_TRANSKEY_ERROR');
  }
  const pem = `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;
  try {
    const certificate = new crypto.X509Certificate(pem);
    const details = certificate.publicKey.asymmetricKeyDetails || {};
    if (certificate.raw.length !== der.length
      || !crypto.timingSafeEqual(certificate.raw, der)
      || certificate.publicKey.asymmetricKeyType !== 'rsa'
      || !Number.isInteger(details.modulusLength)
      || details.modulusLength < 2_048
      || details.modulusLength > 4_096) {
      fail('IBK_TRANSKEY_ERROR');
    }
  } catch (error) {
    if (error instanceof IbkReadonlyError) throw error;
    fail('IBK_TRANSKEY_ERROR');
  }
  return pem;
}

function parseRequestToken(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_TOKEN_BYTES) {
    fail('IBK_TRANSKEY_ERROR');
  }
  const tokens = [];
  // The current IBK endpoint issues an 11-character token. Keep a strict
  // alphabet and upper bound while accepting the observed short form.
  const pattern = /(?:^|[;\r\n])\s*(?:var\s+)?TK_requestToken\s*=\s*["']?([A-Za-z0-9._~-]{8,256})["']?\s*;/g;
  for (const match of source.matchAll(pattern)) tokens.push(match[1]);
  if (tokens.length !== 1) fail('IBK_TRANSKEY_ERROR');
  return tokens[0];
}

function parseTranskeyNumberKeys(source) {
  if (typeof source !== 'string'
    || Buffer.byteLength(source, 'utf8') > MAX_TRANSKEY_RESPONSE_BYTES
    || source.includes('\u0000')) {
    fail('IBK_TRANSKEY_ERROR');
  }
  const start = source.indexOf('var number = new Array();');
  if (start < 0) fail('IBK_TRANSKEY_ERROR');
  const end = source.indexOf('return [', start);
  if (end > start && end - start > MAX_TRANSKEY_RESPONSE_BYTES) fail('IBK_TRANSKEY_ERROR');
  // Some live responses embed the number array in an HTML page without the
  // library's `return [` trailer. The entire response is already size-bounded;
  // only definitions explicitly pushed to `number` are considered below.
  const segment = source.slice(start, end > start ? end : undefined);
  const chunks = segment.split('var key = new Key();').slice(1);
  if (chunks.length < 10 || chunks.length > 128) fail('IBK_TRANSKEY_ERROR');

  const keys = [];
  for (const chunk of chunks) {
    const pushAt = chunk.indexOf('number.push(key);');
    if (pushAt < 0) continue;
    if (pushAt > 16_384) fail('IBK_TRANSKEY_ERROR');
    const definition = chunk.slice(0, pushAt);
    const nameMatch = /key\.name\s*=\s*"([^"\\]{0,128})"\s*;/.exec(definition);
    if (!nameMatch) fail('IBK_TRANSKEY_ERROR');
    if (nameMatch[1]) continue;
    const points = [];
    for (const match of definition.matchAll(/key\.addPoint\((\d{1,4}),\s*(\d{1,4})\)\s*;/g)) {
      const x = Number(match[1]);
      const y = Number(match[2]);
      if (x > 4_096 || y > 4_096) fail('IBK_TRANSKEY_ERROR');
      points.push(Object.freeze([x, y]));
      if (points.length > 128) fail('IBK_TRANSKEY_ERROR');
    }
    if (points.length < 3) fail('IBK_TRANSKEY_ERROR');
    keys.push(Object.freeze(points));
  }
  if (keys.length < 10 || keys.length > 20) fail('IBK_TRANSKEY_ERROR');
  return Object.freeze(keys);
}

function centerOf(points) {
  if (!Array.isArray(points) || points.length < 3 || points.length > 128) fail('IBK_TRANSKEY_ERROR');
  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    if (!Array.isArray(point) || point.length !== 2
      || !Number.isInteger(point[0]) || !Number.isInteger(point[1])) {
      fail('IBK_TRANSKEY_ERROR');
    }
    sumX += point[0];
    sumY += point[1];
  }
  return `${Math.round(sumX / points.length)} ${Math.round(sumY / points.length)}`;
}

function mapTranskeyDigits(numberKeys, digitKeyIndexes) {
  if (!Array.isArray(digitKeyIndexes)
    || digitKeyIndexes.length !== 10
    || new Set(digitKeyIndexes).size !== 10) {
    fail('IBK_TRANSKEY_ERROR');
  }
  const digitToGeo = new Map();
  for (let digit = 0; digit < 10; digit += 1) {
    const index = digitKeyIndexes[digit];
    if (!Number.isInteger(index) || index < 0 || index >= numberKeys.length) fail('IBK_TRANSKEY_ERROR');
    digitToGeo.set(String(digit), centerOf(numberKeys[index]));
  }
  return digitToGeo;
}

async function defaultDetectDigitKeyIndexes(imageBuffer, numberKeys) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0 || imageBuffer.length > MAX_KEY_IMAGE_BYTES) {
    fail('IBK_TRANSKEY_ERROR');
  }
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    fail('IBK_TRANSKEY_ERROR');
  }

  let pixels;
  try {
    pixels = await sharp(imageBuffer, { failOn: 'error', limitInputPixels: 4_194_304 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    fail('IBK_TRANSKEY_ERROR');
  }
  const { data, info } = pixels;
  if (!info || !Number.isInteger(info.width) || !Number.isInteger(info.height)
    || info.width < 1 || info.height < 1
    || info.width > 2_048 || info.height > 2_048
    || data.length !== info.width * info.height * 4) {
    fail('IBK_TRANSKEY_ERROR');
  }

  const indexes = [];
  for (let index = 0; index < numberKeys.length; index += 1) {
    const points = numberKeys[index];
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    const minX = Math.max(0, Math.min(...xs));
    const maxX = Math.min(info.width - 1, Math.max(...xs));
    const minY = Math.max(0, Math.min(...ys));
    const maxY = Math.min(info.height - 1, Math.max(...ys));
    let darkGrayPixels = 0;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const offset = (y * info.width + x) * 4;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        const alpha = data[offset + 3];
        const max = Math.max(red, green, blue);
        const min = Math.min(red, green, blue);
        if (alpha > 20 && max < 150 && max - min < 40) darkGrayPixels += 1;
      }
    }
    if (darkGrayPixels >= 10) indexes.push(index);
  }
  if (indexes.length !== 10) fail('IBK_TRANSKEY_ERROR');
  return indexes;
}

function seedG(value) {
  const x0 = value & 0xff;
  const x1 = (value >>> 8) & 0xff;
  const x2 = (value >>> 16) & 0xff;
  const x3 = value >>> 24;
  const a = SEED_S0[x0];
  const b = SEED_S1[x1];
  const c = SEED_S0[x2];
  const d = SEED_S1[x3];
  const z0 = (a & 0xfc) ^ (b & 0xf3) ^ (c & 0xcf) ^ (d & 0x3f);
  const z1 = (a & 0xf3) ^ (b & 0xcf) ^ (c & 0x3f) ^ (d & 0xfc);
  const z2 = (a & 0xcf) ^ (b & 0x3f) ^ (c & 0xfc) ^ (d & 0xf3);
  const z3 = (a & 0x3f) ^ (b & 0xfc) ^ (c & 0xf3) ^ (d & 0xcf);
  return ((z3 << 24) | (z2 << 16) | (z1 << 8) | z0) >>> 0;
}

function seedRoundKeys(key) {
  if (!Buffer.isBuffer(key) || key.length !== 16) fail('IBK_TRANSKEY_ERROR');
  const roundKeys = new Uint32Array(32);
  let key0 = key.readUInt32BE(0);
  let key1 = key.readUInt32BE(4);
  let key2 = key.readUInt32BE(8);
  let key3 = key.readUInt32BE(12);
  for (let round = 0; round < 16; round += 1) {
    const constant = SEED_ROUND_CONSTANTS[round];
    roundKeys[round * 2] = seedG((key0 + key2 - constant) >>> 0);
    roundKeys[round * 2 + 1] = seedG((key1 - key3 + constant) >>> 0);
    if (round % 2 === 0) {
      const previousKey0 = key0;
      key0 = ((key0 >>> 8) | (key1 << 24)) >>> 0;
      key1 = ((key1 >>> 8) | (previousKey0 << 24)) >>> 0;
    } else {
      const previousKey2 = key2;
      key2 = ((key2 << 8) | (key3 >>> 24)) >>> 0;
      key3 = ((key3 << 8) | (previousKey2 >>> 24)) >>> 0;
    }
  }
  return roundKeys;
}

function seedRound(right0, right1, roundKey0, roundKey1) {
  let output0 = (right0 ^ roundKey0) >>> 0;
  let output1 = (right1 ^ roundKey1 ^ output0) >>> 0;
  output1 = seedG(output1);
  output0 = seedG((output0 + output1) >>> 0);
  output1 = seedG((output1 + output0) >>> 0);
  output0 = (output0 + output1) >>> 0;
  return [output0, output1];
}

function seedEncryptBlock(input, key) {
  if (!Buffer.isBuffer(input) || input.length !== 16
    || !Buffer.isBuffer(key) || key.length !== 16) {
    fail('IBK_TRANSKEY_ERROR');
  }
  const roundKeys = seedRoundKeys(key);
  let left0 = input.readUInt32BE(0);
  let left1 = input.readUInt32BE(4);
  let right0 = input.readUInt32BE(8);
  let right1 = input.readUInt32BE(12);
  for (let round = 0; round < 15; round += 1) {
    const [output0, output1] = seedRound(
      right0,
      right1,
      roundKeys[round * 2],
      roundKeys[round * 2 + 1],
    );
    const previousRight0 = right0;
    const previousRight1 = right1;
    right0 = (left0 ^ output0) >>> 0;
    right1 = (left1 ^ output1) >>> 0;
    left0 = previousRight0;
    left1 = previousRight1;
  }
  const [output0, output1] = seedRound(right0, right1, roundKeys[30], roundKeys[31]);
  left0 = (left0 ^ output0) >>> 0;
  left1 = (left1 ^ output1) >>> 0;

  const encrypted = Buffer.allocUnsafe(16);
  encrypted.writeUInt32BE(left0, 0);
  encrypted.writeUInt32BE(left1, 4);
  encrypted.writeUInt32BE(right0, 8);
  encrypted.writeUInt32BE(right1, 12);
  return encrypted;
}

function seedEncryptGeo(geo, sessionKey, randomPadByte) {
  if (typeof geo !== 'string'
    || !/^[0-9lud ]{1,13}$/.test(geo)
    || typeof sessionKey !== 'string'
    || !/^[a-f0-9]{16}$/i.test(sessionKey)
    || !Number.isInteger(randomPadByte)
    || randomPadByte < 0
    || randomPadByte > 99) {
    fail('IBK_TRANSKEY_ERROR');
  }
  const key = Buffer.from(Array.from(sessionKey, (character) => Number.parseInt(character, 16)));
  const input = Buffer.alloc(16);
  for (let index = 0; index < geo.length; index += 1) {
    const character = geo[index];
    input[index] = 'lud '.includes(character) ? character.charCodeAt(0) : Number(character);
  }
  input[geo.length] = 32;
  input[geo.length + 1] = 101;
  input[geo.length + 2] = randomPadByte;

  try {
    for (let index = 0; index < input.length; index += 1) input[index] ^= SEED_IV[index];
    const encrypted = seedEncryptBlock(input, key);
    return Array.from(encrypted, (byte) => byte.toString(16)).join(',');
  } catch (error) {
    if (error instanceof IbkReadonlyError) throw error;
    fail('IBK_TRANSKEY_ERROR');
  }
}

function checkedRandomInt(randomInt, minimum, maximum) {
  let value;
  try {
    value = randomInt(minimum, maximum);
  } catch {
    fail('IBK_TRANSKEY_ERROR');
  }
  if (!Number.isSafeInteger(value) || value < minimum || value >= maximum) fail('IBK_TRANSKEY_ERROR');
  return value;
}

function encodeTranskeyField(value, digitToGeo, sessionKey, randomInt = crypto.randomInt) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value) || !(digitToGeo instanceof Map)) {
    fail('IBK_TRANSKEY_ERROR');
  }
  const encode = (geo) => seedEncryptGeo(geo, sessionKey, checkedRandomInt(randomInt, 0, 100));
  const chunks = Array.from(value, (digit) => {
    const geo = digitToGeo.get(digit);
    if (typeof geo !== 'string') fail('IBK_TRANSKEY_ERROR');
    return encode(geo);
  });
  const actualHidden = `$${chunks.join('$')}`;
  const paddedChunks = [...chunks];
  const dummyCount = checkedRandomInt(randomInt, 0, 10);
  for (let index = 0; index < dummyCount; index += 1) paddedChunks.push(encode('d 0 0'));
  const paddedHidden = `$${paddedChunks.join('$')}`;
  return Object.freeze({
    actualHidden,
    paddedHidden,
    hmac: crypto.createHmac('sha256', sessionKey).update(paddedHidden).digest('hex'),
    placeholder: '0'.repeat(value.length),
  });
}

function cleanText(value, maxLength = 300) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\\r|\\n/g, ' ')
    .replace(/<[^>]{0,2048}>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function parseBankInteger(value, emptyValue, allowSigned = false, formatCode = 'IBK_RESPONSE_FORMAT_CHANGED') {
  const text = cleanText(value, 80);
  if (!text) return emptyValue;
  if (/^[-–—－]$/.test(text)) return emptyValue;
  const decimalZeroPattern = allowSigned
    ? /^([+-]?(?:\d+|\d{1,3}(?:,\d{3})+))\.0{1,4}(?:\s*원)?$/
    : /^((?:\d+|\d{1,3}(?:,\d{3})+))\.0{1,4}(?:\s*원)?$/;
  const decimalZero = decimalZeroPattern.exec(text);
  if (decimalZero) {
    const parsed = Number(decimalZero[1].replace(/,/g, ''));
    if (!Number.isSafeInteger(parsed)) fail(formatCode);
    return parsed;
  }
  const pattern = allowSigned
    ? /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\s*원)?$/
    : /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\s*원)?$/;
  if (!pattern.test(text)) {
    fail(formatCode);
  }
  const parsed = Number(text.replace(/\s*원$/, '').replace(/,/g, ''));
  if (!Number.isSafeInteger(parsed)) fail(formatCode);
  return parsed;
}

function validCalendarParts(year, month, day, hour, minute, second) {
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day
    && probe.getUTCHours() === hour
    && probe.getUTCMinutes() === minute
    && probe.getUTCSeconds() === second;
}

const BANK_TIMESTAMP_PATTERN = /^(\d{4})[-./]?(\d{2})[-./]?(\d{2})(?:[ T]?(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)?$/;

function parseBankTimestamp(value, formatCode = 'IBK_RESPONSE_FORMAT_CHANGED') {
  const text = cleanText(value, 80);
  const match = BANK_TIMESTAMP_PATTERN.exec(text);
  if (!match) fail(formatCode);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  if (!validCalendarParts(year, month, day, hour, minute, second)) fail(formatCode);
  const pad = (number) => String(number).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+09:00`;
}

const KNOWN_ROW_KEYS = Object.freeze([
  'TRN_YMD', 'TRN_DT', 'TRN_DTM',
  'TRN_AMT1', 'WDRW_AMT', 'OUT_AMT',
  'TRN_AMT2', 'MNRC_AMT', 'IN_AMT',
  'AFTR_BAL', 'BAL', 'LDGR_BAL',
  'TRN_SMR', 'SMR', 'RMK', 'TRN_CONT',
  'GEAR_ACN', 'OPP_ACN', 'RCP_ACN',
  'BNPR_CON', 'BR_NM', 'TRN_BR_NM',
  'TRN_BNCD', 'CMS_NO', 'OBC1_AMT',
  'TRN_SRNO', 'TRN_SRN', 'TRN_SEQ', 'TRN_NO', 'TRN_ID',
  'TRN_UNQ_NO', 'TRANSACTION_ID',
]);

function decodeLooseString(value) {
  return value.replace(/\\u([a-f0-9]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([a-f0-9]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\([\\'"nrt])/g, (_, escaped) => ({ n: '\n', r: '\r', t: '\t' }[escaped] || escaped));
}

function readLooseProperty(candidate, key) {
  const property = new RegExp(`(?:^|[,{])\\s*(?:"${key}"|'${key}'|${key})\\s*:\\s*(?:"((?:\\\\.|[^"\\\\]){0,4096})"|'((?:\\\\.|[^'\\\\]){0,4096})'|([^,}\\r\\n]{0,4096}))`, 'i');
  const match = property.exec(candidate);
  if (!match) return undefined;
  if (match[1] !== undefined) return decodeLooseString(match[1]);
  if (match[2] !== undefined) return decodeLooseString(match[2]);
  return match[3].trim().replace(/^null$/i, '');
}

const GRID_WITHDRAWAL_LABELS = new Set(['출금', '출금액', '출금금액', '찾으신금액', '지급금액']);
const GRID_DEPOSIT_LABELS = new Set(['입금', '입금액', '입금금액', '맡기신금액', '수입금액']);

function isGridColumnMetadata(row) {
  const normalizeLabel = (value) => cleanText(value, 80).normalize('NFKC').replace(/\s+/g, '');
  return GRID_WITHDRAWAL_LABELS.has(normalizeLabel(row.TRN_AMT1))
    && GRID_DEPOSIT_LABELS.has(normalizeLabel(row.TRN_AMT2));
}

function objectWithdrawalFormatCode(value) {
  const text = cleanText(value, 80).normalize('NFKC');
  const unsigned = '(?:\\d+|\\d{1,3}(?:,\\d{3})+)';
  if (new RegExp(`^[+-]${unsigned}(?:\\s*원)?$`).test(text)) {
    return 'IBK_FORMAT_OBJECT_WITHDRAWAL_SIGNED';
  }
  if (new RegExp(`^[+-]?${unsigned}\\.\\d+(?:\\s*원)?$`).test(text)) {
    return 'IBK_FORMAT_OBJECT_WITHDRAWAL_DECIMAL';
  }
  if (new RegExp(`^(?:KRW|원|[₩￦])\\s*[+-]?${unsigned}$`, 'i').test(text)
    || new RegExp(`^[+-]?${unsigned}\\s*(?:KRW|[₩￦])$`, 'i').test(text)) {
    return 'IBK_FORMAT_OBJECT_WITHDRAWAL_CURRENCY';
  }
  if (!/\d/.test(text) && /[A-Za-z가-힣]/.test(text)) {
    return 'IBK_FORMAT_OBJECT_WITHDRAWAL_TEXT';
  }
  return 'IBK_FORMAT_OBJECT_WITHDRAWAL_MIXED';
}

function collectSequenceCandidateFieldNames(candidate, fieldNames) {
  if (!(fieldNames instanceof Set)) return;
  const propertyPattern = /(?:^|[,{])\s*(?:"([A-Za-z_][A-Za-z0-9_]{0,63})"|'([A-Za-z_][A-Za-z0-9_]{0,63})'|([A-Za-z_][A-Za-z0-9_]{0,63}))\s*:/g;
  for (const match of candidate.matchAll(propertyPattern)) {
    const name = (match[1] || match[2] || match[3]).toUpperCase();
    if (name === 'TRANSACTION_ID'
      || /^TRN_[A-Z0-9_]{0,40}(?:NO|SEQ|ID|SR)[A-Z0-9_]{0,40}$/.test(name)
      || /^(?:ROW_?ID|_ROW_?ID|JQGRID_ROW_?ID)$/.test(name)) {
      fieldNames.add(name);
      if (fieldNames.size > 64) fail('IBK_RESPONSE_TOO_LARGE');
    }
  }
}

function extractObjectRows(source, diagnosticFieldNames) {
  const rows = [];
  const stack = [];
  let quote = '';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') {
      if (stack.length >= 32) fail('IBK_FORMAT_TRANSACTION_STRUCTURE');
      if (stack.length) stack[stack.length - 1].hasNestedObject = true;
      stack.push({ start: index, hasNestedObject: false });
      continue;
    }
    if (character !== '}') continue;
    const opened = stack.pop();
    if (!opened) continue;
    if (opened.hasNestedObject || index - opened.start + 1 > MAX_OBJECT_CHARS) continue;
    const candidate = source.slice(opened.start, index + 1);
    if (!/(?:TRN_YMD|TRN_AMT1|TRN_AMT2|AFTR_BAL|TRN_SMR|GEAR_ACN|BNPR_CON)/.test(candidate)) continue;
    const row = Object.create(null);
    for (const key of KNOWN_ROW_KEYS) {
      const value = readLooseProperty(candidate, key);
      if (value !== undefined) row[key] = value;
    }
    const transactionDate = ['TRN_YMD', 'TRN_DT', 'TRN_DTM']
      .map((key) => row[key])
      .find((value) => value !== undefined && cleanText(value, 80));
    if (transactionDate !== undefined
      && BANK_TIMESTAMP_PATTERN.test(cleanText(transactionDate, 80))
      && !isGridColumnMetadata(row)) {
      collectSequenceCandidateFieldNames(candidate, diagnosticFieldNames);
      rows.push(row);
    }
    if (rows.length > MAX_ROWS) fail('IBK_RESPONSE_TOO_LARGE');
  }
  return rows;
}

function extractHtmlTableRows(source) {
  const rows = [];
  const rowPattern = /<tr\b[^>]{0,1024}>([\s\S]{0,65536}?)<\/tr\s*>/gi;
  for (const match of source.matchAll(rowPattern)) {
    const cells = [];
    const cellPattern = /<t[dh]\b[^>]{0,1024}>([\s\S]{0,8192}?)<\/t[dh]\s*>/gi;
    for (const cell of match[1].matchAll(cellPattern)) cells.push(cleanText(cell[1], 4_096));
    if (cells.length < 9) continue;
    const dateIndex = cells.findIndex((cell) => /^\d{4}[-./]?\d{2}[-./]?\d{2}/.test(cell));
    if (dateIndex < 0 || cells.length < dateIndex + 9) continue;
    rows.push({
      TRN_YMD: cells[dateIndex],
      TRN_AMT1: cells[dateIndex + 1],
      TRN_AMT2: cells[dateIndex + 2],
      AFTR_BAL: cells[dateIndex + 3],
      TRN_SMR: cells[dateIndex + 4],
      GEAR_ACN: cells[dateIndex + 5] || '',
      TRN_BNCD: cells[dateIndex + 6] || '',
      CMS_NO: cells[dateIndex + 7] || '',
      BNPR_CON: cells[dateIndex + 8] || '',
    });
    if (rows.length > MAX_ROWS) fail('IBK_RESPONSE_TOO_LARGE');
  }
  return rows;
}

function pick(row, keys) {
  for (const key of keys) {
    if (Object.hasOwn(row, key) && cleanText(row[key])) return row[key];
  }
  return '';
}

function maskAccountNumber(value) {
  const digits = cleanText(value, 80).replace(/\D/g, '');
  if (digits.length < 5) return null;
  const suffixLength = Math.min(4, digits.length - 2);
  return `${digits.slice(0, 2)}-${'*'.repeat(Math.max(4, digits.length - 2 - suffixLength))}-${digits.slice(-suffixLength)}`;
}

function normalizeRow(row, accountId, sourceKind) {
  const withdrawalFormatCode = sourceKind === 'TABLE'
    ? 'IBK_FORMAT_TABLE_WITHDRAWAL_AMOUNT'
    : objectWithdrawalFormatCode(pick(row, ['TRN_AMT1', 'WDRW_AMT', 'OUT_AMT']));
  const withdrawal = parseBankInteger(
    pick(row, ['TRN_AMT1', 'WDRW_AMT', 'OUT_AMT']),
    0,
    false,
    withdrawalFormatCode,
  );
  const deposit = parseBankInteger(
    pick(row, ['TRN_AMT2', 'MNRC_AMT', 'IN_AMT']),
    0,
    false,
    'IBK_FORMAT_DEPOSIT_AMOUNT',
  );
  if (withdrawal > 0 && deposit > 0) fail('IBK_FORMAT_DIRECTION');
  if (withdrawal <= 0 && deposit <= 0) return null;
  const direction = deposit > 0 ? 'DEPOSIT' : 'WITHDRAWAL';
  const amount = deposit > 0 ? deposit : withdrawal;
  const transactionAt = parseBankTimestamp(
    pick(row, ['TRN_YMD', 'TRN_DT', 'TRN_DTM']),
    'IBK_FORMAT_TRANSACTION_DATE',
  );
  const balance = parseBankInteger(
    pick(row, ['AFTR_BAL', 'BAL', 'LDGR_BAL']),
    null,
    true,
    'IBK_FORMAT_BALANCE',
  );
  const summary = cleanText(pick(row, ['TRN_SMR', 'SMR', 'RMK', 'TRN_CONT']), 300) || null;
  const counterpartyAccount = maskAccountNumber(pick(row, ['GEAR_ACN', 'OPP_ACN', 'RCP_ACN']));
  const branch = cleanText(pick(row, ['BNPR_CON', 'BR_NM', 'TRN_BR_NM']), 160) || null;
  const providerSequence = cleanText(pick(row, [
    'TRN_SRNO', 'TRN_SRN', 'TRN_SEQ', 'TRN_NO', 'TRN_ID',
    'TRN_UNQ_NO', 'TRANSACTION_ID',
  ]), 160) || null;
  const providerKeyStable = Boolean(providerSequence);
  const providerTransactionKey = `IBK_QUICK:${crypto.createHash('sha256').update(JSON.stringify({
    ...(providerKeyStable
      ? { accountId, transactionDate: transactionAt.slice(0, 10), providerSequence }
      : { accountId, transactionAt, direction, amount, balance, summary, counterpartyAccount, branch }),
  })).digest('hex').slice(0, 32)}`;
  return Object.freeze({
    providerTransactionKey,
    providerKeyStable,
    transactionAt,
    direction,
    amount,
    balance,
    summary,
    counterpartyName: summary,
    counterpartyAccount,
    branch,
  });
}

function hasBankError(source) {
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === 'object'
      && (parsed.ERROR_CODE || parsed.RESPONSE_GUIDE_MESSAGE || parsed.result === 'error');
  } catch {
    return /["']?result["']?\s*[:=]\s*["']error["']/i.test(source)
      || /["']?ERROR_CODE["']?\s*[:=]\s*(?:["'][^"'\r\n]{1,128}["']|[A-Z0-9_-]{1,64})/i.test(source)
      || /["']?RESPONSE_GUIDE_MESSAGE["']?\s*[:=]\s*["'][^"'\r\n]{1,512}["']/i.test(source)
      || /\buf_alert\s*\(\s*["'][^"'\r\n]{1,512}["']/i.test(source)
      || /spErr(?:Code|Title)(?:Pop)?["']?\)[^"'\r\n]{0,256}["'][^"'\r\n]{1,128}["']/i.test(source);
  }
}

function parseIbkQuickTransactions(source, options = {}) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_TRANSACTION_BYTES) {
    fail('IBK_RESPONSE_TOO_LARGE');
  }
  const accountId = String(options.accountId || '');
  if (!ACCOUNT_ID_SET.has(accountId)) fail('IBK_CONFIG_INVALID');
  if (!(options.diagnosticFieldNames === undefined
    || options.diagnosticFieldNames instanceof Set)) {
    fail('IBK_CONFIG_INVALID');
  }
  if (hasBankError(source)) fail('IBK_BANK_RESPONSE_ERROR');

  const objectRows = extractObjectRows(source, options.diagnosticFieldNames);
  const tableRows = extractHtmlTableRows(source);
  if (objectRows.length + tableRows.length > MAX_ROWS) fail('IBK_RESPONSE_TOO_LARGE');
  const transactions = new Map();
  for (const row of objectRows) {
    const normalized = normalizeRow(row, accountId, 'OBJECT');
    if (normalized) transactions.set(normalized.providerTransactionKey, normalized);
  }
  for (const row of tableRows) {
    const normalized = normalizeRow(row, accountId, 'TABLE');
    if (normalized) transactions.set(normalized.providerTransactionKey, normalized);
  }
  const noData = !source.trim()
    || /조회된 내역이 없습니다|거래내역조회 결과가 없습니다/.test(source);
  if (!noData && objectRows.length === 0 && tableRows.length === 0) {
    fail('IBK_FORMAT_TRANSACTION_STRUCTURE');
  }
  return Object.freeze({
    noData,
    transactions: Object.freeze(Array.from(transactions.values()).sort(
      (left, right) => Date.parse(left.transactionAt) - Date.parse(right.transactionAt),
    )),
  });
}

function randomBuffer(randomBytes, size) {
  let value;
  try {
    value = randomBytes(size);
  } catch {
    fail('IBK_TRANSKEY_ERROR');
  }
  if (!Buffer.isBuffer(value) || value.length !== size) fail('IBK_TRANSKEY_ERROR');
  return value;
}

function transkeyPostBody(parameters, randomInt) {
  const cacheBuster = checkedRandomInt(randomInt, 1_000_000_000, 4_000_000_000);
  return `${new URLSearchParams(parameters)}&${cacheBuster}`;
}

async function buildTranskeyFields(context, credentials) {
  const {
    fetchImpl, jar, signal, randomBytes, randomInt, detectDigitKeyIndexes, transkeyJsPins,
  } = context;
  try {
    const scriptBuffer = await fixedFetchBuffer(
      fetchImpl, jar, IBK_TRANSKEY_JS_URL, { method: 'GET' }, MAX_TRANSKEY_SCRIPT_BYTES, signal,
    );
    assertPinnedAsset(scriptBuffer, transkeyJsPins);
    const certificate = parseTranskeyCertificateScript(decode(scriptBuffer));
    const tokenUrl = `${IBK_TRANSKEY_SERVLET_URL}?op=getToken&${checkedRandomInt(randomInt, 1_000_000_000, 4_000_000_000)}`;
    const tokenBuffer = await fixedFetchBuffer(
      fetchImpl,
      jar,
      tokenUrl,
      { method: 'GET', headers: { Referer: IBK_QUICK_PAGE_URL } },
      MAX_TOKEN_BYTES,
      signal,
    );
    const requestToken = parseRequestToken(decode(tokenBuffer));
    const sessionKey = randomBuffer(randomBytes, 8).toString('hex');
    const transkeyUuid = randomBuffer(randomBytes, 32).toString('hex');
    let encryptedSessionKey;
    try {
      encryptedSessionKey = crypto.publicEncrypt({
        key: certificate,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha1',
      }, Buffer.from(sessionKey, 'ascii')).toString('hex');
    } catch {
      fail('IBK_TRANSKEY_ERROR');
    }

    const sessionBody = new URLSearchParams({
      op: 'setSessionKey',
      key: encryptedSessionKey,
      transkeyUuid,
      useCert: 'true',
      mode: 'common',
      TK_requestToken: requestToken,
    });
    const keySourceBuffer = await fixedFetchBuffer(
      fetchImpl,
      jar,
      IBK_TRANSKEY_SERVLET_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: IBK_QUICK_PAGE_URL,
        },
        body: sessionBody,
      },
      MAX_TRANSKEY_RESPONSE_BYTES,
      signal,
    );
    const numberKeys = parseTranskeyNumberKeys(decode(keySourceBuffer));
    const maps = new Map();

    for (const name of ['acnt_pwd', 'rnno']) {
      await fixedFetchBuffer(
        fetchImpl,
        jar,
        IBK_TRANSKEY_SERVLET_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Referer: IBK_QUICK_PAGE_URL,
          },
          body: transkeyPostBody({
            op: 'allocation',
            name,
            keyType: '',
            keyboardType: 'number',
            fieldType: 'password',
            inputName: name,
            transkeyUuid,
            TK_requestToken: requestToken,
            isCrt: 'false',
          }, randomInt),
        },
        MAX_TRANSKEY_RESPONSE_BYTES,
        signal,
      );
      const keyParams = new URLSearchParams({
        op: 'getKey',
        name,
        keyType: 'single',
        keyboardType: 'number',
        fieldType: 'password',
        inputName: name,
        transkeyUuid,
        TK_requestToken: requestToken,
        isCrt: 'false',
      });
      const keyImageUrl = `${IBK_TRANSKEY_SERVLET_URL}?${keyParams}&${checkedRandomInt(randomInt, 1_000_000_000, 4_000_000_000)}`;
      const keyImage = await fixedFetchBuffer(
        fetchImpl,
        jar,
        keyImageUrl,
        { method: 'GET', headers: { Referer: IBK_QUICK_PAGE_URL } },
        MAX_KEY_IMAGE_BYTES,
        signal,
        'IBK_KEY_IMAGE',
      );
      let indexes;
      try {
        indexes = await raceAbort(
          Promise.resolve(detectDigitKeyIndexes(keyImage, numberKeys, name)),
          signal,
        );
      } catch (error) {
        if (error instanceof IbkReadonlyError) throw error;
        if (signal.aborted || error?.name === 'AbortError') fail('IBK_REQUEST_TIMEOUT');
        fail('IBK_TRANSKEY_ERROR');
      }
      maps.set(name, mapTranskeyDigits(numberKeys, indexes));
    }

    const password = encodeTranskeyField(credentials.accountPassword, maps.get('acnt_pwd'), sessionKey, randomInt);
    const identity = encodeTranskeyField(credentials.identityNumber, maps.get('rnno'), sessionKey, randomInt);
    return Object.freeze({
      acnt_pwd: password.placeholder,
      rnno: identity.placeholder,
      _DUMMY_INPUT: '',
      transkeyUuid,
      transkey_acnt_pwd: password.paddedHidden,
      transkey_HM_acnt_pwd: password.hmac,
      Tk_acnt_pwd_separator: 'transkey',
      transkey_rnno: identity.paddedHidden,
      transkey_HM_rnno: identity.hmac,
      Tk_rnno_separator: 'transkey',
      hid_key_data: '',
      hid_enc_data: '',
      E2E_acnt_pwd: password.actualHidden,
      E2E_rnno: identity.actualHidden,
      separate_transkey_gb: 'transkey',
    });
  } catch (error) {
    if (error instanceof IbkReadonlyError) throw error;
    fail('IBK_TRANSKEY_ERROR');
  }
}

function buildBankForm(credentials, range, transkeyFields, now) {
  const start = kstDateParts(range.fromDate);
  const end = kstDateParts(range.toDate);
  const current = kstDateParts(now);
  const fromDay = `${String(Number(current.year) - 5).padStart(4, '0')}${current.month}${current.day}`;
  const today = ymd(current);
  return new URLSearchParams({
    inq_stdd: ymd(start),
    inq_endd: ymd(end),
    cus_acn: credentials.accountNumber,
    inq_dcd: '9',
    otpt_trtp_dcd: '2',
    sevr_prn_rqst_cnt: '',
    ipinsideData: '',
    ipinsideNAT: '',
    ipinsideCOMM: '',
    W_SRVR_DATA_DLPR_EN: 'N',
    W_SRVR_DATA_DLPR: '',
    pageIndex: '1',
    rebound_yn: 'N',
    NEXT_PAGE_TRN_ID_2: '',
    in_cus_acn: credentials.accountNumber,
    acnt_pwd: transkeyFields.acnt_pwd,
    rnno: transkeyFields.rnno,
    rdo_inq_dcd: '9',
    sel_otpt_trtp_dcd: '2',
    inqy_sttg_ymd_yy: start.year,
    inqy_sttg_ymd_mm: start.month,
    inqy_sttg_ymd_dd: start.day,
    inqy_sttg_ymdDateBoxType: 'period',
    inqy_sttg_ymdfromday: `${fromDay}/`,
    inqy_sttg_ymdtoday: `${today}/`,
    inqy_eymd_yy: end.year,
    inqy_eymd_mm: end.month,
    inqy_eymd_dd: end.day,
    inqy_eymdDateBoxType: 'period',
    inqy_eymdfromday: `${fromDay}/`,
    inqy_eymdtoday: `${today}/`,
    inqy_sttg_ymd: dashedYmd(start),
    inqy_eymd: dashedYmd(end),
    ...transkeyFields,
    isAjax: 'true',
    isGrid: 'true',
  });
}

function createIbkQuickReadonlyProvider(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('IBK_CONFIG_INVALID');
  const accounts = normalizeAccounts(options.accounts);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const detectDigitKeyIndexes = options.detectDigitKeyIndexes || defaultDetectDigitKeyIndexes;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const randomInt = options.randomInt || crypto.randomInt;
  const now = options.now || (() => new Date());
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  const transkeyJsPins = normalizeSha256Pins(options.transkeyJsSha256);
  const diagnosticFieldNamesEnabled = options.diagnosticFieldNames === true;
  if (typeof fetchImpl !== 'function'
    || typeof detectDigitKeyIndexes !== 'function'
    || typeof randomBytes !== 'function'
    || typeof randomInt !== 'function'
    || typeof now !== 'function'
    || !(options.diagnosticFieldNames === undefined
      || options.diagnosticFieldNames === false
      || diagnosticFieldNamesEnabled)
    || !Number.isInteger(timeoutMs)
    || timeoutMs < 25
    || timeoutMs > 60_000) {
    fail('IBK_CONFIG_INVALID');
  }

  async function query(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('IBK_CONFIG_INVALID');
    const accountId = String(input.accountId || '');
    const credentials = accounts.get(accountId);
    if (!credentials) fail('IBK_ACCOUNT_NOT_CONFIGURED');
    const queryNow = now();
    const range = resolveRange(input.from, input.to, queryNow);
    const jar = new CookieJar();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      await withFormatStage(
        'IBK_FORMAT_PAGE_RESPONSE',
        'IBK_NETWORK_PAGE',
        () => fixedFetchBuffer(
          fetchImpl,
          jar,
          IBK_QUICK_PAGE_URL,
          { method: 'GET' },
          MAX_PAGE_BYTES,
          controller.signal,
        ),
      );
      const transkeyFields = await withFormatStage(
        'IBK_FORMAT_TRANSKEY_RESPONSE',
        'IBK_NETWORK_TRANSKEY',
        () => buildTranskeyFields({
          fetchImpl,
          jar,
          signal: controller.signal,
          randomBytes,
          randomInt,
          detectDigitKeyIndexes,
          transkeyJsPins,
        }, credentials),
      );
      const form = buildBankForm(credentials, range, transkeyFields, queryNow);
      const response = await withFormatStage(
        'IBK_FORMAT_TRANSACTION_RESPONSE',
        'IBK_NETWORK_TRANSACTION',
        () => fixedFetchBuffer(
          fetchImpl,
          jar,
          accountEndpointUrl(credentials.accountNumber),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              'X-Requested-With': 'XMLHttpRequest',
              Referer: IBK_QUICK_PAGE_URL,
            },
            body: form,
          },
          MAX_TRANSACTION_BYTES,
          controller.signal,
        ),
      );
      const source = withFormatStageSync(
        'IBK_FORMAT_TRANSACTION_RESPONSE',
        () => decode(response, 'euc-kr'),
      );
      const diagnosticFieldNames = diagnosticFieldNamesEnabled ? new Set() : undefined;
      const parsed = parseIbkQuickTransactions(source, { accountId, diagnosticFieldNames });
      const transactions = parsed.transactions.filter((row) => {
        const instant = Date.parse(row.transactionAt);
        return instant >= range.fromDate.getTime() && instant < range.toDate.getTime();
      });
      return Object.freeze({
        from: range.from,
        to: range.to,
        transactions: Object.freeze(transactions),
        ...(diagnosticFieldNamesEnabled
          ? { diagnosticFieldNames: Object.freeze(Array.from(diagnosticFieldNames).sort()) }
          : {}),
      });
    } catch (error) {
      if (error instanceof IbkReadonlyError) throw error;
      if (controller.signal.aborted || error?.name === 'AbortError') fail('IBK_REQUEST_TIMEOUT');
      fail('IBK_QUERY_FAILED');
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({ query });
}

module.exports = {
  ACCOUNT_IDS,
  IBK_BROWSER_USER_AGENT,
  IBK_ORIGIN,
  IBK_TRANSKEY_JS_URL,
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
  _internals: Object.freeze({
    accountEndpointUrl,
    assertAllowedUrl,
    buildBankForm,
    cleanText,
    mapTranskeyDigits,
    parseRequestToken,
    seedEncryptBlock,
  }),
};
