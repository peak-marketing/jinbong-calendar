'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadIbkAccountConfig } = require('../ibk-account-config');
const { parseRfc3339 } = require('../ibk-time');

const DEFAULT_SECRET_PATH = '/root/.peakos-secrets/ibk-accounts.env';
const DEFAULT_WORKER_PATH = path.join(__dirname, '..', 'workers', 'ibk-quick-worker.js');
const DEFAULT_LOOKBACK_DAYS = 1;
const DEFAULT_NETWORK_TIMEOUT_MS = 20_000;
const MAX_RANGE_DAYS = 30;
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_TRANSACTIONS = 2_000;
const IBK_ACCOUNT_IDS = Object.freeze([
  'ibk-hq-sales',
  'ibk-hq-supplier',
  'ibk-hq-fixed',
  'ibk-review-space',
  'ibk-reward-space',
]);
const IBK_ACCOUNT_ID_SET = new Set(IBK_ACCOUNT_IDS);

const PUBLIC_ERRORS = Object.freeze({
  IBK_ACCOUNT_NOT_CONFIGURED: '이 통장은 IBK 조회 대상으로 설정되지 않았습니다.',
  IBK_ACCOUNT_MISMATCH: '통장 표시정보와 IBK 조회 자격정보가 일치하지 않습니다.',
  IBK_ASSET_PIN_REQUIRED: '검증된 IBK 보안 자산 해시가 설정되지 않았습니다.',
  IBK_ASSET_PIN_MISMATCH: 'IBK 보안 자산 무결성 검증에 실패했습니다.',
  IBK_BANK_RESPONSE_ERROR: 'IBK 빠른조회 응답이 오류를 반환했습니다.',
  IBK_CONFIGURATION_ERROR: 'IBK 조회 설정을 안전하게 읽지 못했습니다.',
  IBK_NETWORK_ERROR: 'IBK 빠른조회 서버에 연결하지 못했습니다.',
  IBK_NETWORK_PAGE: 'IBK 빠른조회 초기 페이지에 연결하지 못했습니다.',
  IBK_NETWORK_TRANSKEY: 'IBK 보안키 서비스에 연결하지 못했습니다.',
  IBK_NETWORK_TRANSACTION: 'IBK 거래조회 서비스에 연결하지 못했습니다.',
  IBK_QUERY_FAILED: 'IBK 조회를 완료하지 못했습니다.',
  IBK_RANGE_INVALID: 'IBK 조회 기간이 올바르지 않습니다.',
  IBK_RANGE_TOO_LARGE: 'IBK 조회 기간은 최대 30일입니다.',
  IBK_REQUEST_TIMEOUT: 'IBK 빠른조회 요청 시간이 초과되었습니다.',
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
  IBK_RESPONSE_TOO_LARGE: 'IBK 빠른조회 응답이 허용 크기를 초과했습니다.',
  IBK_SEED_UNAVAILABLE: '조회 전용 암호화 모듈을 사용할 수 없습니다.',
  IBK_TRANSKEY_ERROR: 'IBK 보안키 입력을 준비하지 못했습니다.',
  IBK_WORKER_FAILED: 'IBK 조회 작업을 실행하지 못했습니다.',
  IBK_WORKER_INVALID_OUTPUT: 'IBK 조회 결과를 검증하지 못했습니다.',
  IBK_WORKER_OUTPUT_LIMIT: 'IBK 조회 결과가 허용 크기를 초과했습니다.',
  IBK_WORKER_TIMEOUT: 'IBK 조회 작업 시간이 초과되었습니다.',
});

class IbkCollectorError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(PUBLIC_ERRORS, code) ? code : 'IBK_WORKER_FAILED';
    super(PUBLIC_ERRORS[safeCode]);
    this.name = 'IbkCollectorError';
    this.code = safeCode;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message };
  }
}

function fail(code) {
  throw new IbkCollectorError(code);
}

function parseTimestamp(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail('IBK_RANGE_INVALID');
    return new Date(value.getTime());
  }
  const parsed = parseRfc3339(value);
  if (!parsed) fail('IBK_RANGE_INVALID');
  return parsed;
}

function resolveRange(from, to, lookbackDays = DEFAULT_LOOKBACK_DAYS, now = new Date()) {
  const rangeTo = to === null || to === undefined || to === '' ? new Date(now.getTime()) : parseTimestamp(to);
  const rangeFrom = from === null || from === undefined || from === ''
    ? new Date(rangeTo.getTime() - lookbackDays * 86_400_000)
    : parseTimestamp(from);
  if (rangeFrom >= rangeTo) fail('IBK_RANGE_INVALID');
  if (rangeTo.getTime() - rangeFrom.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    fail('IBK_RANGE_TOO_LARGE');
  }
  return Object.freeze({ from: rangeFrom.toISOString(), to: rangeTo.toISOString() });
}

function parseIntegerSetting(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value).trim())) fail('IBK_CONFIGURATION_ERROR');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail('IBK_CONFIGURATION_ERROR');
  return parsed;
}

function normalizePinAllowlist(value) {
  const entries = String(value || '').split(/[\s,]+/).filter(Boolean);
  if (!entries.length) fail('IBK_ASSET_PIN_REQUIRED');
  if (entries.length > 8 || entries.some((entry) => !(
    /^[a-f0-9]{64}$/i.test(entry) || /^sha256-[A-Za-z0-9+/]{43}=$/.test(entry)
  ))) fail('IBK_CONFIGURATION_ERROR');
  return entries.join(',');
}

function normalizeMask(value) {
  return String(value || '').replace(/[xX•●]/g, '*').replace(/\s+/g, '');
}

function exactMaskedAccount(value) {
  const text = normalizeMask(value);
  const digits = text.replace(/\D/g, '');
  const masks = text.match(/\*/g) || [];
  if (/^[0-9*-]+$/.test(text) && masks.length >= 4 && digits.length <= 6 && !/\d{5,}/.test(text)) {
    return text.slice(0, 80);
  }
  if (digits.length < 8) return null;
  return `${digits.slice(0, 2)}-${'*'.repeat(digits.length - 6)}-${digits.slice(-4)}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactSensitiveText(value, sensitiveValues = []) {
  let text = String(value ?? '');
  for (const secret of sensitiveValues) {
    if (secret) text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '[마스킹]');
  }
  return text
    .replace(/(?:\d[\s-]?){8,}\d/g, '[계좌정보 마스킹]')
    .replace(/(password|passwd|secret|token|identity|pin|비밀번호|식별번호)\s*[=:]\s*\S+/gi, '$1=[마스킹]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [마스킹]');
}

function cleanText(value, maxLength, sensitiveValues) {
  if (value === null || value === undefined) return null;
  const cleaned = redactSensitiveText(value, sensitiveValues)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function isTimestamp(value) {
  return parseRfc3339(value) !== null;
}

function normalizeWorkerResult(payload, expected, sensitiveValues = []) {
  const payloadKeys = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload).sort()
    : [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || JSON.stringify(payloadKeys) !== JSON.stringify(['accountId', 'from', 'noData', 'ok', 'to', 'transactions'])
    || payload.ok !== true
    || payload.accountId !== expected.accountId
    || !isTimestamp(payload.from) || !isTimestamp(payload.to)
    || new Date(payload.from) >= new Date(payload.to)
    || new Date(payload.from).getTime() !== new Date(expected.from).getTime()
    || new Date(payload.to).getTime() !== new Date(expected.to).getTime()
    || !Array.isArray(payload.transactions) || payload.transactions.length > MAX_TRANSACTIONS) {
    fail('IBK_WORKER_INVALID_OUTPUT');
  }
  const transactions = payload.transactions.map((row) => {
    const rowKeys = row && typeof row === 'object' && !Array.isArray(row)
      ? Object.keys(row).sort()
      : [];
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || JSON.stringify(rowKeys) !== JSON.stringify([
        'amount', 'balance', 'branch', 'counterpartyAccountMasked', 'counterpartyName',
        'direction', 'providerKeyStable', 'providerTransactionKey', 'summary', 'transactionAt',
      ])) fail('IBK_WORKER_INVALID_OUTPUT');
    const providerTransactionKey = String(row.providerTransactionKey || '');
    if (!/^IBK_QUICK:[a-f0-9]{32}$/i.test(providerTransactionKey)
      || typeof row.providerKeyStable !== 'boolean'
      || !isTimestamp(row.transactionAt)
      || !['DEPOSIT', 'WITHDRAWAL'].includes(row.direction)
      || !Number.isSafeInteger(row.amount) || row.amount <= 0
      || !(row.balance === null || Number.isSafeInteger(row.balance))) {
      fail('IBK_WORKER_INVALID_OUTPUT');
    }
    return Object.freeze({
      providerTransactionKey,
      providerKeyStable: row.providerKeyStable,
      transactionAt: row.transactionAt,
      direction: row.direction,
      amount: row.amount,
      balance: row.balance,
      summary: cleanText(row.summary, 300, sensitiveValues),
      counterpartyName: cleanText(row.counterpartyName, 160, sensitiveValues),
      counterpartyAccount: exactMaskedAccount(
        row.counterpartyAccountMasked ?? row.counterpartyAccount,
      ),
      branch: cleanText(row.branch, 160, sensitiveValues),
    });
  });
  return Object.freeze({
    from: payload.from,
    to: payload.to,
    transactions: Object.freeze(transactions),
  });
}

function buildWorkerEnvironment({ accountId, credentials, timeoutMs, transkeyJsSha256 }) {
  return Object.freeze({
    NODE_ENV: 'production',
    TZ: 'Asia/Seoul',
    LANG: 'C.UTF-8',
    IBK_QUICK_ACCOUNT_ID: accountId,
    IBK_QUICK_ACCOUNT_NUMBER: credentials.accountNumber,
    IBK_QUICK_ACCOUNT_PASSWORD: credentials.accountPassword,
    IBK_QUICK_IDENTITY_NUMBER: credentials.identityNumber,
    IBK_QUICK_TIMEOUT_MS: String(timeoutMs),
    IBK_QUICK_TRANSKEY_JS_SHA256: transkeyJsSha256,
  });
}

function workerError(payload) {
  const code = typeof payload?.error?.code === 'string' ? payload.error.code : '';
  return new IbkCollectorError(Object.hasOwn(PUBLIC_ERRORS, code) ? code : 'IBK_WORKER_FAILED');
}

function runWorker({ request, environment, workerPath, workerTimeoutMs, spawnImpl, sensitiveValues }) {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let terminationCode = null;
    let child;
    let timer;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (stderr.length) {
        redactSensitiveText(stderr.toString('utf8'), sensitiveValues);
        stderr.fill(0);
      }
      if (error) reject(error);
      else resolve(result);
    };

    try {
      child = spawnImpl(process.execPath, [
        '--disallow-code-generation-from-strings',
        '--disable-proto=throw',
        '--max-old-space-size=192',
        workerPath,
      ], {
        cwd: path.dirname(workerPath),
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(new IbkCollectorError('IBK_WORKER_FAILED'));
      return;
    }

    const terminate = (code) => {
      terminationCode ||= code;
      if (!child.killed) child.kill('SIGKILL');
    };
    timer = setTimeout(() => terminate('IBK_WORKER_TIMEOUT'), workerTimeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > MAX_STDOUT_BYTES) {
        terminate('IBK_WORKER_OUTPUT_LIMIT');
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length + chunk.length > MAX_STDERR_BYTES) {
        terminate('IBK_WORKER_OUTPUT_LIMIT');
        return;
      }
      stderr = Buffer.concat([stderr, chunk]);
    });
    child.once('error', () => finish(new IbkCollectorError('IBK_WORKER_FAILED')));
    child.once('close', (exitCode) => {
      if (terminationCode) {
        finish(new IbkCollectorError(terminationCode));
        return;
      }
      let payload;
      try {
        const output = stdout.toString('utf8').trim();
        if (!output) throw new Error('empty');
        payload = JSON.parse(output);
      } catch {
        finish(new IbkCollectorError('IBK_WORKER_INVALID_OUTPUT'));
        return;
      } finally {
        stdout.fill(0);
      }
      if (payload?.ok === false) {
        finish(workerError(payload));
        return;
      }
      if (exitCode !== 0) {
        finish(new IbkCollectorError('IBK_WORKER_FAILED'));
        return;
      }
      try {
        finish(null, normalizeWorkerResult(payload, request, sensitiveValues));
      } catch (error) {
        finish(error instanceof IbkCollectorError ? error : new IbkCollectorError('IBK_WORKER_INVALID_OUTPUT'));
      }
    });

    const serialized = JSON.stringify(request);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
      terminate('IBK_WORKER_FAILED');
      return;
    }
    child.stdin.on('error', () => {});
    child.stdin.end(serialized);
  });
}

function createIbkQuickCollector(options = {}) {
  if (options.enabled !== true) return null;
  const secretPath = options.secretPath || options.secretsPath || DEFAULT_SECRET_PATH;
  const workerPath = path.resolve(options.workerPath || DEFAULT_WORKER_PATH);
  const runtimeEnv = options.runtimeEnv || process.env;
  const spawnImpl = options.spawnImpl || spawn;
  const workerTimeoutOverride = options.workerTimeoutMs ?? options.processTimeoutMs;
  if (!path.isAbsolute(secretPath) || typeof spawnImpl !== 'function') fail('IBK_CONFIGURATION_ERROR');
  if (workerTimeoutOverride !== undefined
    && (!Number.isSafeInteger(workerTimeoutOverride) || workerTimeoutOverride < 25 || workerTimeoutOverride > 120_000)) {
    fail('IBK_CONFIGURATION_ERROR');
  }

  return async function collectIbkQuick({ account, from = null, to = null, requestId = null } = {}) {
    const accountId = String(account?.id || '');
    if (!IBK_ACCOUNT_ID_SET.has(accountId) || account?.provider !== 'IBK_QUICK') {
      fail('IBK_ACCOUNT_NOT_CONFIGURED');
    }

    let registry;
    let credentials;
    try {
      registry = loadIbkAccountConfig({ secretPath });
      credentials = registry.getCredentials(accountId);
      registry = null;
    } catch {
      fail('IBK_CONFIGURATION_ERROR');
    }
    if (normalizeMask(account.accountNumberMasked) !== normalizeMask(credentials.accountNumberMasked)) {
      fail('IBK_ACCOUNT_MISMATCH');
    }

    const lookbackDays = parseIntegerSetting(
      runtimeEnv.PEAKOS_IBK_LOOKBACK_DAYS,
      DEFAULT_LOOKBACK_DAYS,
      1,
      MAX_RANGE_DAYS,
    );
    const timeoutMs = parseIntegerSetting(
      runtimeEnv.PEAKOS_IBK_TIMEOUT_MS,
      DEFAULT_NETWORK_TIMEOUT_MS,
      5_000,
      60_000,
    );
    const transkeyJsSha256 = normalizePinAllowlist(runtimeEnv.PEAKOS_IBK_TRANSKEY_JS_SHA256);
    const range = resolveRange(from, to, lookbackDays);
    const safeRequestId = typeof requestId === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(requestId)
      ? requestId
      : null;
    const request = Object.freeze({
      version: 1,
      accountId,
      from: range.from,
      to: range.to,
      requestId: safeRequestId,
    });
    const environment = buildWorkerEnvironment({
      accountId,
      credentials,
      timeoutMs,
      transkeyJsSha256,
    });
    const sensitiveValues = [
      credentials.accountNumber,
      credentials.accountPassword,
      credentials.identityNumber,
    ];
    return runWorker({
      request,
      environment,
      workerPath,
      workerTimeoutMs: workerTimeoutOverride ?? timeoutMs + 3_000,
      spawnImpl,
      sensitiveValues,
    });
  };
}

module.exports = {
  DEFAULT_SECRET_PATH,
  DEFAULT_WORKER_PATH,
  IBK_ACCOUNT_IDS,
  IbkCollectorError,
  buildWorkerEnvironment,
  createIbkQuickCollector,
  normalizePinAllowlist,
  normalizeWorkerResult,
  redactSensitiveText,
  resolveRange,
};
