'use strict';

// Machine-only entry point. It writes exactly one bounded JSON document to
// stdout and never logs bank responses, credentials, or stack traces.
const { createIbkQuickReadonlyProvider } = require('../providers/ibk-quick-readonly');
const { parseRfc3339 } = require('../ibk-time');

const MAX_INPUT_BYTES = 4 * 1024;
const MAX_TRANSACTIONS = 2_000;
const ACCOUNT_IDS = new Set([
  'ibk-hq-sales',
  'ibk-hq-supplier',
  'ibk-hq-fixed',
  'ibk-review-space',
  'ibk-reward-space',
]);

const PUBLIC_ERROR_CODES = new Set([
  'IBK_ACCOUNT_NOT_CONFIGURED',
  'IBK_ASSET_PIN_REQUIRED',
  'IBK_ASSET_PIN_MISMATCH',
  'IBK_RANGE_INVALID',
  'IBK_RANGE_TOO_LARGE',
  'IBK_NETWORK_ERROR',
  'IBK_NETWORK_PAGE',
  'IBK_NETWORK_TRANSKEY',
  'IBK_NETWORK_TRANSACTION',
  'IBK_REQUEST_TIMEOUT',
  'IBK_RESPONSE_TOO_LARGE',
  'IBK_RESPONSE_FORMAT_CHANGED',
  'IBK_FORMAT_PAGE_RESPONSE',
  'IBK_FORMAT_TRANSKEY_RESPONSE',
  'IBK_FORMAT_TRANSACTION_RESPONSE',
  'IBK_FORMAT_TRANSACTION_STRUCTURE',
  'IBK_FORMAT_TRANSACTION_DATE',
  'IBK_FORMAT_WITHDRAWAL_AMOUNT',
  'IBK_FORMAT_OBJECT_WITHDRAWAL_AMOUNT',
  'IBK_FORMAT_TABLE_WITHDRAWAL_AMOUNT',
  'IBK_FORMAT_OBJECT_WITHDRAWAL_TEXT',
  'IBK_FORMAT_OBJECT_WITHDRAWAL_SIGNED',
  'IBK_FORMAT_OBJECT_WITHDRAWAL_DECIMAL',
  'IBK_FORMAT_OBJECT_WITHDRAWAL_CURRENCY',
  'IBK_FORMAT_OBJECT_WITHDRAWAL_MIXED',
  'IBK_FORMAT_DEPOSIT_AMOUNT',
  'IBK_FORMAT_BALANCE',
  'IBK_FORMAT_DIRECTION',
  'IBK_BANK_RESPONSE_ERROR',
  'IBK_TRANSKEY_ERROR',
  'IBK_SEED_UNAVAILABLE',
  'IBK_QUERY_FAILED',
]);
const PUBLIC_MESSAGES = Object.freeze({
  IBK_ACCOUNT_NOT_CONFIGURED: '이 통장은 IBK 조회 대상으로 설정되지 않았습니다.',
  IBK_ASSET_PIN_REQUIRED: '검증된 IBK 보안 자산 해시가 설정되지 않았습니다.',
  IBK_ASSET_PIN_MISMATCH: 'IBK 보안 자산 무결성 검증에 실패했습니다.',
  IBK_CONFIGURATION_ERROR: 'IBK 조회 설정을 안전하게 읽지 못했습니다.',
  IBK_RANGE_INVALID: 'IBK 조회 기간이 올바르지 않습니다.',
  IBK_RANGE_TOO_LARGE: 'IBK 조회 기간은 최대 30일입니다.',
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
  IBK_SEED_UNAVAILABLE: '조회 전용 암호화 모듈을 사용할 수 없습니다.',
  IBK_QUERY_FAILED: 'IBK 조회를 완료하지 못했습니다.',
  IBK_WORKER_FAILED: 'IBK 조회 작업을 실행하지 못했습니다.',
});

class WorkerInputError extends Error {
  constructor() {
    super(PUBLIC_MESSAGES.IBK_WORKER_FAILED);
    this.code = 'IBK_WORKER_FAILED';
  }
}

function isTimestamp(value) {
  return parseRfc3339(value) !== null;
}

function parseRequest(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_INPUT_BYTES) {
    throw new WorkerInputError();
  }
  let request;
  try {
    request = JSON.parse(source);
  } catch {
    throw new WorkerInputError();
  }
  const keys = request && typeof request === 'object' && !Array.isArray(request)
    ? Object.keys(request).sort()
    : [];
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || JSON.stringify(keys) !== JSON.stringify(['accountId', 'from', 'requestId', 'to', 'version'])
    || request.version !== 1
    || !ACCOUNT_IDS.has(request.accountId)
    || !isTimestamp(request.from)
    || !isTimestamp(request.to)
    || new Date(request.from) >= new Date(request.to)
    || !(request.requestId === null
      || (typeof request.requestId === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(request.requestId)))) {
    throw new WorkerInputError();
  }
  return Object.freeze({
    accountId: request.accountId,
    from: request.from,
    to: request.to,
    requestId: request.requestId,
  });
}

function readRequest(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    stream.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) {
        rejected = true;
        stream.pause();
        chunks.forEach((part) => part.fill(0));
        reject(new WorkerInputError());
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.once('error', () => reject(new WorkerInputError()));
    stream.once('end', () => {
      if (rejected) return;
      const source = Buffer.concat(chunks, size);
      try {
        resolve(parseRequest(source.toString('utf8')));
      } catch (error) {
        reject(error);
      } finally {
        source.fill(0);
        chunks.forEach((chunk) => chunk.fill(0));
      }
    });
  });
}

function parseSelectedEnvironment(environment, accountId) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new WorkerInputError();
  }
  const selectedId = String(environment.IBK_QUICK_ACCOUNT_ID || '');
  const accountNumber = String(environment.IBK_QUICK_ACCOUNT_NUMBER || '');
  const accountPassword = String(environment.IBK_QUICK_ACCOUNT_PASSWORD || '');
  const rawIdentityNumber = String(environment.IBK_QUICK_IDENTITY_NUMBER || '');
  const timeoutText = String(environment.IBK_QUICK_TIMEOUT_MS || '');
  const transkeyJsSha256 = String(environment.IBK_QUICK_TRANSKEY_JS_SHA256 || '');
  const pins = transkeyJsSha256.split(/[\s,]+/).filter(Boolean);
  if (selectedId !== accountId
    || !ACCOUNT_IDS.has(selectedId)
    || !/^\d{10}$|^\d{11}$|^\d{14}$/.test(accountNumber)
    || !/^\d{4}$/.test(accountPassword)
    || !/^\d{7}$|^\d{10}$/.test(rawIdentityNumber)
    || !/^\d+$/.test(timeoutText)
    || !Number.isSafeInteger(Number(timeoutText))
    || Number(timeoutText) < 5_000
    || Number(timeoutText) > 60_000
    || pins.length < 1
    || pins.length > 8
    || pins.some((pin) => !(
      /^[a-f0-9]{64}$/i.test(pin) || /^sha256-[A-Za-z0-9+/]{43}=$/.test(pin)
    ))) {
    throw new WorkerInputError();
  }
  return Object.freeze({
    credentials: Object.freeze({
      id: selectedId,
      accountNumber,
      accountPassword,
      identityNumber: rawIdentityNumber.length === 10
        ? rawIdentityNumber.slice(-7)
        : rawIdentityNumber,
    }),
    timeoutMs: Number(timeoutText),
    transkeyJsSha256: pins.join(','),
  });
}

function clearSensitiveEnvironment(environment) {
  for (const name of [
    'IBK_QUICK_ACCOUNT_ID',
    'IBK_QUICK_ACCOUNT_NUMBER',
    'IBK_QUICK_ACCOUNT_PASSWORD',
    'IBK_QUICK_IDENTITY_NUMBER',
    'IBK_QUICK_TIMEOUT_MS',
    'IBK_QUICK_TRANSKEY_JS_SHA256',
  ]) {
    try {
      delete environment[name];
    } catch {
      // Frozen injected test environments are already isolated.
    }
  }
}

function cleanText(value, maxLength, sensitiveValues = []) {
  if (value === null || value === undefined) return null;
  let source = String(value);
  for (const secret of sensitiveValues) {
    if (secret) source = source.split(secret).join('[마스킹]');
  }
  const cleaned = source
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/(?:\d[\s-]?){8,}\d/g, '[계좌정보 마스킹]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function maskedAccount(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).replace(/[xX•●]/g, '*').replace(/\s+/g, '');
  const digits = text.replace(/\D/g, '');
  const masks = text.match(/\*/g) || [];
  if (/^[0-9*-]+$/.test(text) && masks.length >= 4 && digits.length <= 6 && !/\d{5,}/.test(text)) {
    return text.slice(0, 80);
  }
  if (digits.length < 8) return null;
  const suffixLength = Math.min(4, digits.length - 2);
  return `${digits.slice(0, 2)}-${'*'.repeat(Math.max(4, digits.length - 2 - suffixLength))}-${digits.slice(-suffixLength)}`;
}

function normalizeResult(request, result, sensitiveValues = []) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !isTimestamp(result.from)
    || !isTimestamp(result.to)
    || new Date(result.from) >= new Date(result.to)
    || new Date(result.from).getTime() !== new Date(request.from).getTime()
    || new Date(result.to).getTime() !== new Date(request.to).getTime()
    || !Array.isArray(result.transactions)
    || result.transactions.length > MAX_TRANSACTIONS) {
    throw new WorkerInputError();
  }
  const transactions = result.transactions.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new WorkerInputError();
    const providerTransactionKey = String(row.providerTransactionKey || '');
    if (!/^IBK_QUICK:[a-f0-9]{32}$/.test(providerTransactionKey)
      || typeof row.providerKeyStable !== 'boolean'
      || !isTimestamp(row.transactionAt)
      || !['DEPOSIT', 'WITHDRAWAL'].includes(row.direction)
      || !Number.isSafeInteger(row.amount)
      || row.amount <= 0
      || !(row.balance === null || Number.isSafeInteger(row.balance))) {
      throw new WorkerInputError();
    }
    return {
      providerTransactionKey,
      providerKeyStable: row.providerKeyStable,
      transactionAt: row.transactionAt,
      direction: row.direction,
      amount: row.amount,
      balance: row.balance,
      summary: cleanText(row.summary, 300, sensitiveValues),
      counterpartyName: cleanText(row.counterpartyName, 160, sensitiveValues),
      counterpartyAccountMasked: maskedAccount(row.counterpartyAccount),
      branch: cleanText(row.branch, 160, sensitiveValues),
    };
  });
  return {
    ok: true,
    accountId: request.accountId,
    from: result.from,
    to: result.to,
    noData: transactions.length === 0,
    transactions,
  };
}

function toPublicFailure(error) {
  const code = PUBLIC_ERROR_CODES.has(error?.code) ? error.code : 'IBK_WORKER_FAILED';
  return { code, message: PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.IBK_WORKER_FAILED };
}

async function execute(request, options = {}) {
  const createProvider = options.createProvider || createIbkQuickReadonlyProvider;
  const environment = options.environment || process.env;
  const selected = parseSelectedEnvironment(environment, request.accountId);
  clearSensitiveEnvironment(environment);
  const provider = createProvider({
    accounts: [selected.credentials],
    timeoutMs: selected.timeoutMs,
    transkeyJsSha256: selected.transkeyJsSha256,
  });
  const result = await provider.query({
    accountId: request.accountId,
    from: request.from,
    to: request.to,
  });
  return normalizeResult(request, result, [
    selected.credentials.accountNumber,
    selected.credentials.accountPassword,
    selected.credentials.identityNumber,
  ]);
}

let emitted = false;
function emit(payload, failed) {
  if (emitted) return;
  emitted = true;
  process.exitCode = failed ? 1 : 0;
  process.stdout.write(JSON.stringify(payload));
}

async function main() {
  try {
    const request = await readRequest();
    emit(await execute(request), false);
  } catch (error) {
    emit({ ok: false, error: toPublicFailure(error) }, true);
  }
}

if (require.main === module) {
  process.once('uncaughtException', (error) => emit({ ok: false, error: toPublicFailure(error) }, true));
  process.once('unhandledRejection', (error) => emit({ ok: false, error: toPublicFailure(error) }, true));
  main();
}

module.exports = {
  clearSensitiveEnvironment,
  execute,
  maskedAccount,
  normalizeResult,
  parseRequest,
  parseSelectedEnvironment,
  readRequest,
  toPublicFailure,
};
