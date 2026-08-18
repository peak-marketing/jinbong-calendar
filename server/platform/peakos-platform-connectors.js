'use strict';

const crypto = require('node:crypto');

const {
  KST_TIME_ZONE,
  monthBounds,
  normalizeExactName,
} = require('./peakos-platform-monthly-settlement');

const MONTH_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
// RewardSpace's documented monthly payout endpoint can take a little over
// 10 seconds for a full-month response. Keep the request bounded, but leave
// enough room for a valid response before treating it as unavailable.
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ROWS = 10_000;
const REVIEWSPACE_MAX_REQUESTS_PER_HOUR = 10;

// These are intentionally fixed. Do not accept a URL or an environment-variable
// name from a request, database row, or workspace setting.
const CONNECTOR_DEFINITIONS = Object.freeze({
  rewardspace: Object.freeze({
    provider: 'rewardspace',
    label: '리워드스페이스',
    origin: 'https://rewardspace.kr',
    pathname: '/api/external/payouts',
    monthParameter: 'ym',
    envName: 'PEAKOS_REWARDSPACE_API_KEY',
    credentialSecretRef: 'env:PEAKOS_REWARDSPACE_API_KEY',
    adapterVersion: 'rewardspace-monthly:v1',
  }),
  reviewspace: Object.freeze({
    provider: 'reviewspace',
    label: '리뷰스페이스',
    origin: 'https://review-space.kr',
    pathname: '/api/external/v1/monthly-commission',
    monthParameter: 'period',
    envName: 'PEAKOS_REVIEWSPACE_API_KEY',
    credentialSecretRef: 'env:PEAKOS_REVIEWSPACE_API_KEY',
    adapterVersion: 'reviewspace-monthly:v1',
  }),
  keywordmaster: Object.freeze({
    provider: 'keywordmaster',
    label: '키워드마스터',
    origin: 'https://keywordmaster.kr',
    pathname: '/api/external/settlements',
    monthParameter: 'ym',
    envName: 'PEAKOS_KEYWORDMASTER_API_KEY',
    credentialSecretRef: 'env:PEAKOS_KEYWORDMASTER_API_KEY',
    adapterVersion: 'keywordmaster-monthly:v1',
  }),
});

const CONFIGURED_PROVIDER_ORDER = Object.freeze(Object.keys(CONNECTOR_DEFINITIONS));

class PlatformConnectorError extends Error {
  constructor(code, statusCode = 502) {
    super(connectorErrorMessage(code));
    this.name = 'PlatformConnectorError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function connectorErrorMessage(code) {
  const messages = {
    PLATFORM_CONNECTOR_CONFIG_INVALID: '플랫폼 API 연동 설정이 올바르지 않습니다.',
    PLATFORM_CONNECTOR_NOT_CONFIGURED: '플랫폼 API가 연동되지 않았습니다.',
    PLATFORM_CONNECTOR_MONTH_INVALID: '플랫폼 정산 조회 월이 올바르지 않습니다.',
    PLATFORM_CONNECTOR_FUTURE_MONTH: '미래 월의 플랫폼 정산은 수집할 수 없습니다.',
    PLATFORM_CONNECTOR_TIMEOUT: '플랫폼 API 요청 시간이 초과됐습니다.',
    PLATFORM_CONNECTOR_NETWORK_ERROR: '플랫폼 API에 연결하지 못했습니다.',
    PLATFORM_CONNECTOR_REDIRECT_BLOCKED: '플랫폼 API의 예상하지 못한 이동 응답을 차단했습니다.',
    PLATFORM_CONNECTOR_HTTP_ERROR: '플랫폼 API가 오류를 응답했습니다.',
    PLATFORM_CONNECTOR_RESPONSE_TOO_LARGE: '플랫폼 API 응답이 크기 제한을 넘었습니다.',
    PLATFORM_CONNECTOR_RESPONSE_INVALID: '플랫폼 API 응답 형식이 계약과 다릅니다.',
    PLATFORM_CONNECTOR_ECHO_MISMATCH: '플랫폼 API가 다른 정산 월을 응답했습니다.',
    PLATFORM_CONNECTOR_DUPLICATE_ROWS: '플랫폼 API 응답에 중복 정산 행이 있습니다.',
    PLATFORM_CONNECTOR_RATE_LIMITED: '플랫폼 API 호출 한도로 인해 다음 동기화까지 대기합니다.',
    PLATFORM_CONNECTOR_IMPORT_FAILED: '플랫폼 정산 스냅샷을 저장하지 못했습니다.',
    PLATFORM_CONNECTOR_CONNECTION_STATE_FAILED: '플랫폼 정산 연결 상태를 기록하지 못했습니다.',
  };
  return messages[code] || '플랫폼 API 연동을 완료하지 못했습니다.';
}

function fail(code, statusCode) {
  throw new PlatformConnectorError(code, statusCode);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validMonth(value) {
  const month = String(value || '');
  if (!MONTH_PATTERN.test(month)) fail('PLATFORM_CONNECTOR_MONTH_INVALID', 400);
  return month;
}

function validDate(value) {
  const text = String(value || '');
  if (!DATE_PATTERN.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function stringField(value, { allowBlank = false, max = 240 } = {}) {
  if (allowBlank && (value === null || value === undefined)) return '';
  if (typeof value !== 'string' || value.length > max) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  const trimmed = value.normalize('NFC').trim();
  if (!allowBlank && !trimmed) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  return trimmed;
}

function integerString(value, { nullable = false, unsigned = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  let text;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
    text = String(value);
  } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    text = value.trim();
    const converted = Number(text);
    if (!Number.isSafeInteger(converted)) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
    text = String(converted);
  } else {
    fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  }
  if (unsigned && text.startsWith('-')) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  return text;
}

function nonnegativeCount(value, fallback = null) {
  if ((value === null || value === undefined) && fallback !== null) return fallback;
  const text = integerString(value, { unsigned: true });
  const count = Number(text);
  if (!Number.isSafeInteger(count)) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  return count;
}

function sumIntegerStrings(values) {
  return values.reduce((total, value) => total + BigInt(value), 0n);
}

function assertIntegerSum(values, expected) {
  const normalizedExpected = integerString(expected);
  if (sumIntegerStrings(values) !== BigInt(normalizedExpected)) {
    fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  }
}

function assertCountSum(values, expected) {
  const normalizedExpected = nonnegativeCount(expected);
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total !== BigInt(normalizedExpected)) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
}

function arrayField(value) {
  if (!Array.isArray(value) || value.length > MAX_ROWS) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  return value;
}

function timestampField(value, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T/.test(value)
      || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(new Date(value).getTime())) {
    fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  }
  return new Date(value).toISOString();
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function isDirectIdentity(identity) {
  return String(identity || '').trim().toLowerCase() === 'direct';
}

function monthlyRowKey(month, identityParts) {
  return `monthly:v1:${month}:${hash(identityParts.join('\u0000'))}`;
}

function finishParsedSnapshot(
  provider,
  month,
  sourceState,
  sourceDrift,
  rows,
  skippedRowCount = 0,
  attributionIssues = [],
  sourceCoverage = null,
) {
  const seen = new Set();
  for (const row of [...rows, ...attributionIssues]) {
    if (seen.has(row.externalRowKey)) fail('PLATFORM_CONNECTOR_DUPLICATE_ROWS');
    seen.add(row.externalRowKey);
  }
  return {
    provider,
    month,
    sourceState,
    sourceDrift,
    rows,
    attributionIssues,
    sourceCoverage,
    skippedRowCount,
    sourceTotalCount: rows.length + attributionIssues.length + skippedRowCount,
  };
}

function parseRewardspaceResponse(payload, month) {
  if (!plainObject(payload) || payload.ok !== true || payload.ym !== month) {
    if (plainObject(payload) && payload.ok === true && typeof payload.ym === 'string') {
      fail('PLATFORM_CONNECTOR_ECHO_MISMATCH');
    }
    fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  }
  const statuses = new Set(['NONE', 'DRAFT', 'PAID']);
  if (!statuses.has(payload.status) || !plainObject(payload.effective)) {
    fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  }
  const expectedRange = monthBounds(month);
  if (!plainObject(payload.range)
      || !validDate(payload.range.from)
      || !validDate(payload.range.to)
      || payload.range.from !== expectedRange.from
      || payload.range.to !== expectedRange.to) {
    fail('PLATFORM_CONNECTOR_ECHO_MISMATCH');
  }
  if (typeof payload.periodEnded !== 'boolean') fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  const accounts = arrayField(payload.effective.accounts);
  const managers = arrayField(payload.effective.managers);
  if (!plainObject(payload.effective.totals)) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  const rows = [];
  let skippedRowCount = 0;
  const rawSales = [];
  const rawSpread = [];
  const rawLines = [];
  const rawCommission = [];
  for (const account of accounts) {
    if (!plainObject(account)) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
    const payTo = stringField(account.payTo, { allowBlank: true, max: 160 });
    const name = stringField(account.name, { allowBlank: true, max: 160 });
    const salesAmount = integerString(account.sales);
    const distributorCostAmount = integerString(account.distCost);
    const profitAmount = integerString(account.spread);
    const commissionAmount = integerString(account.commission);
    const lineCount = String(nonnegativeCount(account.lines));
    assertIntegerSum([distributorCostAmount, profitAmount], salesAmount);
    rawSales.push(salesAmount);
    rawSpread.push(profitAmount);
    rawLines.push(lineCount);
    rawCommission.push(commissionAmount);
    if (!normalizeExactName(name) || isDirectIdentity(payTo)) {
      skippedRowCount += 1;
      continue;
    }
    rows.push({
      externalRowKey: monthlyRowKey(month, [payTo, normalizeExactName(name)]),
      externalSalespersonName: name,
      salesAmount,
      profitAmount,
      profitBasis: 'reward_distributor_margin',
      // RewardSpace explicitly exposes underlying settlement-line count.
      sourceRecordCount: lineCount === null ? null : Number(lineCount),
    });
  }
  assertIntegerSum(rawSales, payload.effective.totals.sales);
  assertIntegerSum(rawSpread, payload.effective.totals.spread);
  assertCountSum(rawLines, payload.effective.totals.lines);
  const managerIncentives = managers.map((manager) => {
    if (!plainObject(manager)) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
    return integerString(manager.amount);
  });
  const totalCommission = integerString(payload.effective.totals.commission);
  const totalIncentive = integerString(payload.effective.totals.incentive);
  const totalPayout = integerString(payload.effective.totals.payoutTotal);
  assertIntegerSum(rawCommission, totalCommission);
  assertIntegerSum(managerIncentives, totalIncentive);
  assertIntegerSum([totalCommission, totalIncentive], totalPayout);
  if (typeof payload.drift !== 'number' || !Number.isSafeInteger(payload.drift)) {
    fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  }
  const drift = String(payload.drift);
  const sourceState = { NONE: 'live', DRAFT: 'draft', PAID: 'paid' }[payload.status];
  return finishParsedSnapshot(
    'rewardspace',
    month,
    sourceState,
    drift,
    rows,
    skippedRowCount,
    [],
    { from: payload.range.from, to: payload.range.to },
  );
}

function parseReviewspaceResponse(payload, month) {
  if (!plainObject(payload) || payload.ok !== true || payload.period !== month) {
    if (plainObject(payload) && payload.ok === true && typeof payload.period === 'string') {
      fail('PLATFORM_CONNECTOR_ECHO_MISMATCH');
    }
    fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  }
  if (!plainObject(payload.summary)) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  const summarySalesCommission = integerString(payload.summary.salesCommissionAmount);
  const summaryManagerIncentive = integerString(payload.summary.managerIncentiveAmount);
  const summaryTotalPayout = integerString(payload.summary.totalPayoutAmount);
  integerString(payload.summary.revenueAmount);
  integerString(payload.summary.spreadProfitAmount);
  assertIntegerSum(
    [summarySalesCommission, summaryManagerIncentive],
    summaryTotalPayout,
  );
  // The v1 guide shows a representative payout row, not an exhaustive array:
  // validate each row's documented composition without inventing an array-total invariant.
  for (const payout of arrayField(payload.payouts)) {
    if (!plainObject(payout)) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
    const salesCommission = integerString(payout.salesCommissionAmount);
    const managerIncentive = integerString(payout.managerIncentiveAmount);
    assertIntegerSum([salesCommission, managerIncentive], payout.totalAmount);
  }

  let sourceState = 'live';
  if (payload.settlement !== null) {
    if (!plainObject(payload.settlement)
        || payload.settlement.periodKey !== month
        || !['DRAFT', 'PAID'].includes(payload.settlement.status)) {
      fail(payload.settlement?.periodKey && payload.settlement.periodKey !== month
        ? 'PLATFORM_CONNECTOR_ECHO_MISMATCH'
        : 'PLATFORM_CONNECTOR_RESPONSE_INVALID');
    }
    const settlementTotal = integerString(payload.settlement.totalAmount);
    timestampField(payload.settlement.generatedAt);
    if (payload.settlement.status === 'DRAFT') {
      if (!own(payload.settlement, 'paidAt') || payload.settlement.paidAt !== null) {
        fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
      }
    } else {
      timestampField(payload.settlement.paidAt);
      assertIntegerSum([settlementTotal], summaryTotalPayout);
    }
    sourceState = { DRAFT: 'draft', PAID: 'paid' }[payload.settlement.status];
  }
  const rows = [];
  let skippedRowCount = 0;
  for (const account of arrayField(payload.bySalesRep)) {
    if (!plainObject(account)) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
    const name = stringField(account.salesRepName, { allowBlank: true, max: 160 });
    const salesAmount = integerString(account.revenueAmount);
    const profitAmount = integerString(account.spreadProfitAmount);
    if (!normalizeExactName(name)) {
      skippedRowCount += 1;
      continue;
    }
    rows.push({
      externalRowKey: monthlyRowKey(month, [normalizeExactName(name)]),
      externalSalespersonName: name,
      salesAmount,
      profitAmount,
      profitBasis: 'review_spread_profit',
      // ReviewSpace does not expose an order/line count for this aggregate.
      sourceRecordCount: null,
    });
  }
  return finishParsedSnapshot('reviewspace', month, sourceState, null, rows, skippedRowCount);
}

function parseKeywordmasterResponse(payload, month) {
  if (!plainObject(payload) || payload.ok !== true || payload.ym !== month) {
    if (plainObject(payload) && payload.ok === true && typeof payload.ym === 'string') {
      fail('PLATFORM_CONNECTOR_ECHO_MISMATCH');
    }
    fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  }
  if (payload.platform !== 'keywordmaster') fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  const rows = [];
  let skippedRowCount = 0;
  if (!plainObject(payload.total)) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  const rawRevenue = [];
  const rawSupply = [];
  const rawCommission = [];
  const rawUserCount = [];
  const distributors = arrayField(payload.byDistributor);
  for (const account of distributors) {
    if (!plainObject(account)) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
    const code = stringField(account.code, { allowBlank: true, max: 160 });
    const name = stringField(account.name, { allowBlank: true, max: 160 });
    const salesAmount = integerString(account.revenue);
    rawRevenue.push(salesAmount);
    rawSupply.push(integerString(account.supplyAmount));
    rawCommission.push(integerString(account.commission));
    rawUserCount.push(String(nonnegativeCount(account.userCount)));
    if (!normalizeExactName(name) || isDirectIdentity(code)) {
      skippedRowCount += 1;
      continue;
    }
    // `commission` is a payout/commission field. It is deliberately not
    // presented as platform operating profit.
    rows.push({
      externalRowKey: monthlyRowKey(month, [code, normalizeExactName(name)]),
      externalSalespersonName: name,
      salesAmount,
      profitAmount: null,
      profitBasis: 'unavailable',
      // userCount is not a settlement-line count.
      sourceRecordCount: null,
    });
  }
  assertIntegerSum(rawRevenue, payload.total.revenue);
  assertIntegerSum(rawSupply, payload.total.supplyAmount);
  assertIntegerSum(rawCommission, payload.total.commission);
  assertCountSum(rawUserCount, payload.total.userCount);
  if (nonnegativeCount(payload.total.distributorCount) !== distributors.length) {
    fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  }
  return finishParsedSnapshot('keywordmaster', month, 'unknown', null, rows, skippedRowCount);
}

function parseProviderResponse(provider, payload, monthInput) {
  const month = validMonth(monthInput);
  if (provider === 'rewardspace') return parseRewardspaceResponse(payload, month);
  if (provider === 'reviewspace') return parseReviewspaceResponse(payload, month);
  if (provider === 'keywordmaster') return parseKeywordmasterResponse(payload, month);
  fail('PLATFORM_CONNECTOR_NOT_CONFIGURED', 400);
}

function responseHeader(response, name) {
  if (response?.headers && typeof response.headers.get === 'function') return response.headers.get(name);
  if (plainObject(response?.headers)) {
    const found = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found ? String(found[1]) : null;
  }
  return null;
}

function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) return abort();
    const done = (callback, value) => {
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => done(resolve, value), error => done(reject, error));
    return undefined;
  });
}

async function readLimitedBody(response, maxBytes, signal) {
  const declared = responseHeader(response, 'content-length');
  if (declared !== null && (!/^\d+$/.test(String(declared).trim()) || Number(declared) > maxBytes)) {
    fail(Number(declared) > maxBytes
      ? 'PLATFORM_CONNECTOR_RESPONSE_TOO_LARGE'
      : 'PLATFORM_CONNECTOR_RESPONSE_INVALID');
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    let chunkCount = 0;
    while (true) {
      const { value, done } = await raceAbort(reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
      bytes += value.byteLength;
      chunkCount += 1;
      if (bytes > maxBytes || chunkCount > 4096) {
        await reader.cancel().catch(() => {});
        fail('PLATFORM_CONNECTOR_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  }
  let buffer;
  if (typeof response.arrayBuffer === 'function') {
    buffer = Buffer.from(await raceAbort(response.arrayBuffer(), signal));
  } else if (typeof response.text === 'function') {
    buffer = Buffer.from(await raceAbort(response.text(), signal), 'utf8');
  } else {
    fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
  }
  if (buffer.byteLength > maxBytes) fail('PLATFORM_CONNECTOR_RESPONSE_TOO_LARGE');
  return buffer.toString('utf8');
}

function validateEnvironmentKey(env, definition) {
  if (!own(env, definition.envName)) return null;
  const value = env[definition.envName];
  if (typeof value !== 'string'
      || value.length < 8
      || value.length > 2048
      || !/^[\x21-\x7E]+$/.test(value)) {
    fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  }
  return value;
}

function configuredProviderKeys(env = process.env) {
  if (!env || typeof env !== 'object') fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  return CONFIGURED_PROVIDER_ORDER.filter(provider => (
    validateEnvironmentKey(env, CONNECTOR_DEFINITIONS[provider]) !== null
  ));
}

function assertedResponseUrl(value, expectedUrl) {
  if (!value) return;
  let parsed;
  try { parsed = new URL(String(value)); } catch (_) { fail('PLATFORM_CONNECTOR_REDIRECT_BLOCKED'); }
  if (parsed.href !== expectedUrl.href) fail('PLATFORM_CONNECTOR_REDIRECT_BLOCKED');
}

async function fetchProviderMonthlySnapshot({
  provider,
  month: monthInput,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  const month = validMonth(monthInput);
  const definition = CONNECTOR_DEFINITIONS[provider];
  if (!definition) fail('PLATFORM_CONNECTOR_NOT_CONFIGURED', 400);
  if (typeof fetchImpl !== 'function'
      || typeof now !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > 60_000
      || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024
      || maxResponseBytes > 5 * 1024 * 1024) {
    fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  }
  const apiKey = validateEnvironmentKey(env, definition);
  if (apiKey === null) fail('PLATFORM_CONNECTOR_NOT_CONFIGURED', 503);
  const url = new URL(definition.pathname, definition.origin);
  url.searchParams.set(definition.monthParameter, month);
  if (url.protocol !== 'https:' || url.origin !== definition.origin || url.pathname !== definition.pathname) {
    fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await raceAbort(fetchImpl(url.href, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'X-API-KEY': apiKey,
      },
    }), controller.signal);
    if (!response || typeof response.status !== 'number' || typeof response.ok !== 'boolean') {
      fail('PLATFORM_CONNECTOR_NETWORK_ERROR');
    }
    assertedResponseUrl(response.url, url);
    if (response.redirected === true || (response.status >= 300 && response.status < 400)) {
      fail('PLATFORM_CONNECTOR_REDIRECT_BLOCKED');
    }
    if (response.status === 429) fail('PLATFORM_CONNECTOR_RATE_LIMITED', 503);
    if (response.ok !== true || response.status < 200 || response.status >= 300) {
      fail('PLATFORM_CONNECTOR_HTTP_ERROR');
    }
    const contentType = responseHeader(response, 'content-type');
    if (!/^application\/json(?:\s*;|$)/i.test(String(contentType || ''))) {
      fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
    }
    const raw = await readLimitedBody(response, maxResponseBytes, controller.signal);
    let payload;
    try { payload = JSON.parse(raw); } catch (_) { fail('PLATFORM_CONNECTOR_RESPONSE_INVALID'); }
    const parsed = parseProviderResponse(provider, payload, month);
    const observed = now();
    const observedDate = observed instanceof Date ? observed : new Date(observed);
    if (!Number.isFinite(observedDate.getTime())) fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
    return { ...parsed, observedAt: observedDate.toISOString() };
  } catch (error) {
    if (error instanceof PlatformConnectorError) throw error;
    if (controller.signal.aborted || error?.name === 'AbortError') fail('PLATFORM_CONNECTOR_TIMEOUT');
    fail('PLATFORM_CONNECTOR_NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
  }
}

function filterRowsForWorkspaces(rows, workspaceMembers) {
  if (!Array.isArray(rows) || !Array.isArray(workspaceMembers)) {
    fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  }
  const workspaceIds = new Set();
  const candidates = new Map();
  for (const member of workspaceMembers) {
    if (!plainObject(member)) fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
    const workspaceId = String(member.workspaceId || '').trim();
    if (!workspaceId) fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
    workspaceIds.add(workspaceId);
    if (member.uid === null || member.uid === undefined) continue;
    const uid = String(member.uid).trim();
    const ownerNameSnapshot = String(member.name || '').normalize('NFC').trim();
    const name = normalizeExactName(ownerNameSnapshot);
    if (!uid || !name) continue;
    const entries = candidates.get(name) || [];
    if (!entries.some(entry => entry.workspaceId === workspaceId && entry.uid === uid)) {
      entries.push({ workspaceId, uid, ownerNameSnapshot });
    }
    candidates.set(name, entries);
  }
  const byWorkspace = new Map([...workspaceIds].map(workspaceId => [workspaceId, {
    workspaceId,
    rows: [],
    attributionIssues: [],
  }]));
  let globalUnmatchedCount = 0;
  let globalAmbiguousCount = 0;
  for (const row of rows) {
    const normalizedName = normalizeExactName(row?.externalSalespersonName);
    const matches = candidates.get(normalizedName) || [];
    if (matches.length === 1) {
      byWorkspace.get(matches[0].workspaceId)?.rows.push({
        ...row,
        attributionStatus: 'mapped',
        ownerUid: matches[0].uid,
        ownerNameSnapshot: matches[0].ownerNameSnapshot,
      });
      continue;
    }
    if (!matches.length) {
      globalUnmatchedCount += 1;
      continue;
    }
    globalAmbiguousCount += 1;
    for (const workspaceId of new Set(matches.map(match => match.workspaceId))) {
      byWorkspace.get(workspaceId)?.attributionIssues.push({
        externalRowKey: String(row.externalRowKey),
        externalSalespersonName: String(row.externalSalespersonName),
      });
    }
  }
  return {
    workspaces: [...byWorkspace.values()].sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)),
    globalUnmatchedCount,
    globalAmbiguousCount,
  };
}

async function loadActiveWorkspaceMembers(pool) {
  const workspaces = await pool.query(
    `SELECT id AS workspace_id
       FROM public.peakos_workspaces
      WHERE active = TRUE
      ORDER BY id`,
  );
  const members = await pool.query(
    `SELECT membership.workspace_id, users.uid, users.name
       FROM public.peakos_workspace_memberships membership
       JOIN public.peakos_workspaces workspace
         ON workspace.id = membership.workspace_id AND workspace.active = TRUE
       JOIN public.users ON users.uid = membership.user_uid
      WHERE membership.active = TRUE
        AND membership.role IN ('admin','manager','member')
        AND users.approved = TRUE
        AND COALESCE(users.is_active, TRUE) = TRUE
        AND COALESCE(users.chat_only, FALSE) = FALSE
        AND COALESCE(users.external_calendar_only, FALSE) = FALSE
      ORDER BY membership.workspace_id, users.uid`,
  );
  const result = workspaces.rows.map(row => ({
    workspaceId: String(row.workspace_id),
    uid: null,
    name: null,
  }));
  for (const row of members.rows) {
    result.push({
      workspaceId: String(row.workspace_id),
      uid: String(row.uid),
      name: String(row.name || ''),
    });
  }
  return result;
}

function safeConnectionErrorCode(error) {
  const code = String(error?.code || '');
  return /^PLATFORM_[A-Z0-9_]{1,71}$/.test(code) ? code : 'PLATFORM_CONNECTOR_IMPORT_FAILED';
}

async function appendPlatformConnectionState({
  pool,
  workspaceId,
  provider,
  connectionState,
  credentialSecretRef,
  successfulImportAt = null,
  errorCode = null,
  actor,
  now = new Date(),
} = {}) {
  if (!pool || typeof pool.connect !== 'function') fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  const definition = CONNECTOR_DEFINITIONS[provider];
  const selectedWorkspace = String(workspaceId || '').trim();
  const actorUid = String(actor?.uid || '').trim();
  if (!definition) {
    fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  }
  if (!selectedWorkspace || selectedWorkspace.length > 120
      || !actorUid || actorUid.length > 200) {
    fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  }
  if (!['pending', 'ready', 'error', 'disabled'].includes(connectionState)) {
    fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  }
  if ((connectionState === 'disabled' && credentialSecretRef !== null)
      || (connectionState !== 'disabled'
        && credentialSecretRef !== definition.credentialSecretRef)) {
    fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  }
  if (connectionState === 'error' && !/^PLATFORM_[A-Z0-9_]{1,71}$/.test(String(errorCode || ''))) {
    fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  }
  if (connectionState !== 'error' && errorCode !== null) {
    fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  }
  let successfulImportIso = null;
  if (connectionState === 'ready') {
    const successful = successfulImportAt instanceof Date
      ? successfulImportAt : new Date(successfulImportAt);
    if (!Number.isFinite(successful.getTime())) fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
    successfulImportIso = successful.toISOString();
  }
  const created = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(created.getTime())) fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `peakos-platform-connection-v1:${selectedWorkspace}:${provider}`,
    ]);
    const latest = await client.query(
      `SELECT version, last_successful_import_at
         FROM public.peakos_platform_connections
        WHERE workspace_id = $1 AND provider = $2
        ORDER BY version DESC
        LIMIT 1`,
      [selectedWorkspace, provider],
    );
    const version = Number(latest.rows[0]?.version || 0) + 1;
    const lastSuccessful = connectionState === 'ready'
      ? successfulImportIso
      : latest.rows[0]?.last_successful_import_at || null;
    await client.query(
      `INSERT INTO public.peakos_platform_connections
        (workspace_id,provider,version,connection_state,credential_secret_ref,
         last_successful_import_at,last_error_code,actor_uid,actor_name_snapshot,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        selectedWorkspace, provider, version, connectionState, credentialSecretRef,
        lastSuccessful, connectionState === 'error' ? errorCode : null,
        actorUid, String(actor?.name || '').slice(0, 160), created.toISOString(),
      ],
    );
    await client.query('COMMIT');
    return { workspaceId: selectedWorkspace, provider, version, connectionState };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function previousMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber - 2, 1)).toISOString().slice(0, 7);
}

function formatKstDate(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: KST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function reconcileUnconfiguredProviderStates({
  pool,
  workspaceIds,
  configuredProviders,
  appendConnectionState = appendPlatformConnectionState,
  now = new Date(),
} = {}) {
  if (!pool || typeof pool.query !== 'function'
      || !Array.isArray(workspaceIds)
      || !Array.isArray(configuredProviders)
      || typeof appendConnectionState !== 'function') {
    fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  }
  if (!workspaceIds.length) return [];
  const configured = new Set(configuredProviders);
  const missingProviders = CONFIGURED_PROVIDER_ORDER.filter(provider => !configured.has(provider));
  if (!missingProviders.length) return [];
  const latest = await pool.query(
    `SELECT DISTINCT ON (workspace_id, provider)
            workspace_id, provider, connection_state
       FROM public.peakos_platform_connections
      WHERE workspace_id = ANY($1::text[])
        AND provider = ANY($2::text[])
      ORDER BY workspace_id, provider, version DESC`,
    [workspaceIds, missingProviders],
  );
  const disabled = [];
  for (const row of latest.rows) {
    if (row.connection_state === 'disabled') continue;
    const provider = String(row.provider);
    const workspaceId = String(row.workspace_id);
    await appendConnectionState({
      pool,
      workspaceId,
      provider,
      connectionState: 'disabled',
      credentialSecretRef: null,
      errorCode: null,
      actor: { uid: 'system:platform-connector-config', name: '플랫폼 연동 설정 조정' },
      now,
    });
    disabled.push({ workspaceId, provider });
  }
  return disabled;
}

async function reviewspaceRateAllowed(pool) {
  const result = await pool.query(
    `SELECT COUNT(DISTINCT created_at)::int AS attempt_count
       FROM public.peakos_platform_connections
      WHERE provider = 'reviewspace'
        AND connection_state = 'pending'
        AND actor_uid = 'system:reviewspace-monthly-sync'
        AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour'`,
  );
  const count = Number(result.rows[0]?.attempt_count || 0);
  if (!Number.isSafeInteger(count) || count < 0) fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  return count < REVIEWSPACE_MAX_REQUESTS_PER_HOUR;
}

function createPlatformSettlementSyncService({
  pool,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  now = () => new Date(),
  importMonthlySnapshot,
  calculateSnapshotDigest,
  appendConnectionState = appendPlatformConnectionState,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function'
      || typeof importMonthlySnapshot !== 'function'
      || typeof calculateSnapshotDigest !== 'function'
      || typeof appendConnectionState !== 'function'
      || typeof fetchImpl !== 'function'
      || typeof now !== 'function') {
    fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
  }
  const configuredProviders = Object.freeze(configuredProviderKeys(env));

  async function reconcileConnectionStates() {
    const workspaceMembers = await loadActiveWorkspaceMembers(pool);
    const workspaceIds = [...new Set(workspaceMembers.map(item => item.workspaceId))];
    return reconcileUnconfiguredProviderStates({
      pool,
      workspaceIds,
      configuredProviders,
      appendConnectionState,
      now: now(),
    });
  }

  function providersForRun(requestedProviders) {
    if (!Array.isArray(requestedProviders)) fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
    const selected = requestedProviders.map(provider => String(provider || ''));
    if (new Set(selected).size !== selected.length
        || selected.some(provider => !CONNECTOR_DEFINITIONS[provider])) {
      fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
    }
    if (selected.some(provider => !configuredProviders.includes(provider))) {
      fail('PLATFORM_CONNECTOR_NOT_CONFIGURED', 503);
    }
    return selected;
  }

  async function syncMonthForProviders(monthInput, requestedProviders) {
    const month = validMonth(monthInput);
    const providersToSync = providersForRun(requestedProviders);
    const clockValue = now();
    const clock = clockValue instanceof Date ? clockValue : new Date(clockValue);
    if (!Number.isFinite(clock.getTime())) fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
    const range = monthBounds(month, clock);
    const today = formatKstDate(clock);
    if (today < range.from) fail('PLATFORM_CONNECTOR_FUTURE_MONTH', 400);
    const coveredTo = today < range.to ? today : range.to;
    const lockClient = await pool.connect();
    let locked = false;
    try {
      const lock = await lockClient.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [
        'peakos-platform-provider-sync-v2',
      ]);
      locked = lock.rows[0]?.locked === true;
      if (!locked) return { month, skipped: true, reason: 'locked', providers: [] };

      const workspaceMembers = await loadActiveWorkspaceMembers(pool);
      const workspaceIds = [...new Set(workspaceMembers.map(item => item.workspaceId))];
      const disabledConnections = await reconcileUnconfiguredProviderStates({
        pool,
        workspaceIds,
        configuredProviders,
        appendConnectionState,
        now: clock,
      });
      const providerResults = [];
      for (const provider of providersToSync) {
        const definition = CONNECTOR_DEFINITIONS[provider];
        const actor = { uid: `system:${provider}-monthly-sync`, name: `${definition.label} 정산 수집기` };
        if (!workspaceIds.length) {
          providerResults.push({
            provider, ok: true, skipped: true, reason: 'no_active_workspaces', workspaceCount: 0,
          });
          continue;
        }
        if (provider === 'reviewspace') {
          const rateAllowed = await reviewspaceRateAllowed(pool);
          if (!rateAllowed) {
            for (const workspaceId of workspaceIds) {
              await appendConnectionState({
                pool, workspaceId, provider, connectionState: 'error',
                credentialSecretRef: definition.credentialSecretRef,
                errorCode: 'PLATFORM_CONNECTOR_RATE_LIMITED', actor, now: clock,
              }).catch(() => {});
            }
            providerResults.push({
              provider, ok: false, code: 'PLATFORM_CONNECTOR_RATE_LIMITED', workspaceCount: 0,
            });
            continue;
          }
          try {
            for (const workspaceId of workspaceIds) {
              await appendConnectionState({
                pool, workspaceId, provider, connectionState: 'pending',
                credentialSecretRef: definition.credentialSecretRef,
                errorCode: null, actor, now: clock,
              });
            }
          } catch (_) {
            providerResults.push({
              provider, ok: false, code: 'PLATFORM_CONNECTOR_IMPORT_FAILED', workspaceCount: 0,
            });
            continue;
          }
        }
        let snapshot;
        try {
          snapshot = await fetchProviderMonthlySnapshot({
            provider, month, env, fetchImpl, now, timeoutMs, maxResponseBytes,
          });
        } catch (error) {
          const errorCode = safeConnectionErrorCode(error);
          for (const workspaceId of workspaceIds) {
            await appendConnectionState({
              pool, workspaceId, provider, connectionState: 'error',
              credentialSecretRef: definition.credentialSecretRef,
              errorCode, actor, now: clock,
            }).catch(() => {});
          }
          logger.error?.('platform settlement connector failed', { provider, month, code: errorCode });
          providerResults.push({ provider, ok: false, code: errorCode, workspaceCount: 0 });
          continue;
        }

        const assignment = filterRowsForWorkspaces(snapshot.rows, workspaceMembers);
        const providerCoveredFrom = snapshot.sourceCoverage?.from || range.from;
        const providerCoverageLimit = snapshot.sourceCoverage?.to || range.to;
        const providerCoveredTo = coveredTo < providerCoverageLimit ? coveredTo : providerCoverageLimit;
        if (providerCoveredFrom !== range.from
            || !validDate(providerCoveredTo)
            || providerCoveredTo < providerCoveredFrom) {
          fail('PLATFORM_CONNECTOR_ECHO_MISMATCH');
        }
        const digestPayload = {
          provider,
          month,
          coveredFrom: providerCoveredFrom,
          coveredTo: providerCoveredTo,
          sourceTotalCount: snapshot.sourceTotalCount,
          globalUnmatchedCount: assignment.globalUnmatchedCount,
          sourceState: snapshot.sourceState,
          sourceDrift: snapshot.sourceDrift,
        };
        const workspaceResults = [];
        for (const workspace of assignment.workspaces) {
          let result;
          try {
            const sourceExcludedCount = snapshot.sourceTotalCount
              - workspace.rows.length
              - workspace.attributionIssues.length
              - assignment.globalUnmatchedCount;
            if (!Number.isSafeInteger(sourceExcludedCount) || sourceExcludedCount < 0) {
              fail('PLATFORM_CONNECTOR_RESPONSE_INVALID');
            }
            const snapshotPayload = {
              pool,
              workspaceId: workspace.workspaceId,
              provider,
              month,
              coveredFrom: providerCoveredFrom,
              coveredTo: providerCoveredTo,
              sourceTotalCount: snapshot.sourceTotalCount,
              globalUnmatchedCount: assignment.globalUnmatchedCount,
              sourceExcludedCount,
              rows: workspace.rows,
              attributionIssues: workspace.attributionIssues,
              sourceState: snapshot.sourceState,
              sourceDrift: snapshot.sourceDrift,
              adapterVersion: definition.adapterVersion,
              actor,
              observedAt: snapshot.observedAt,
            };
            const sourceDigest = await calculateSnapshotDigest({
              ...digestPayload,
              sourceExcludedCount,
              rows: workspace.rows,
              attributionIssues: workspace.attributionIssues,
            });
            if (!/^[0-9a-f]{64}$/.test(String(sourceDigest || ''))) {
              fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
            }
            const idempotencyKey = `monthly:v1:${month}:${sourceDigest}`;
            result = await importMonthlySnapshot({
              ...snapshotPayload,
              idempotencyKey,
              sourceDigest,
            });
          } catch (error) {
            const errorCode = safeConnectionErrorCode(error);
            await appendConnectionState({
              pool,
              workspaceId: workspace.workspaceId,
              provider,
              connectionState: 'error',
              credentialSecretRef: definition.credentialSecretRef,
              errorCode,
              actor,
              now: clock,
            }).catch(() => {});
            logger.error?.('platform settlement snapshot import failed', {
              provider, month, workspaceId: workspace.workspaceId, code: errorCode,
            });
            workspaceResults.push({
              workspaceId: workspace.workspaceId,
              ok: false,
              connectionReady: false,
              code: errorCode,
            });
            continue;
          }

          try {
            await appendConnectionState({
              pool,
              workspaceId: workspace.workspaceId,
              provider,
              connectionState: 'ready',
              credentialSecretRef: definition.credentialSecretRef,
              successfulImportAt: snapshot.observedAt,
              actor,
              now: clock,
            });
          } catch (_) {
            const errorCode = 'PLATFORM_CONNECTOR_CONNECTION_STATE_FAILED';
            await appendConnectionState({
              pool,
              workspaceId: workspace.workspaceId,
              provider,
              connectionState: 'error',
              credentialSecretRef: definition.credentialSecretRef,
              errorCode,
              actor,
              now: clock,
            }).catch(() => {});
            logger.error?.('platform settlement connection state append failed', {
              provider, month, code: errorCode,
            });
            workspaceResults.push({
              workspaceId: workspace.workspaceId,
              ok: false,
              connectionReady: false,
              rowCount: workspace.rows.length,
              attributionIssueCount: workspace.attributionIssues.length,
              duplicate: result?.duplicate === true,
              code: errorCode,
            });
            continue;
          }

          workspaceResults.push({
            workspaceId: workspace.workspaceId,
            ok: true,
            connectionReady: true,
            rowCount: workspace.rows.length,
            attributionIssueCount: workspace.attributionIssues.length,
            duplicate: result?.duplicate === true,
          });
        }
        providerResults.push({
          provider,
          ok: workspaceResults.every(result => result.ok),
          sourceRowCount: snapshot.sourceTotalCount,
          skippedSourceRowCount: snapshot.skippedRowCount,
          globalUnmatchedCount: assignment.globalUnmatchedCount,
          globalAmbiguousCount: assignment.globalAmbiguousCount,
          workspaceCount: workspaceResults.length,
          workspaces: workspaceResults,
        });
      }
      return { month, skipped: false, disabledConnections, providers: providerResults };
    } finally {
      let releaseError = null;
      if (locked) {
        try {
          const unlocked = await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [
            'peakos-platform-provider-sync-v2',
          ]);
          if (unlocked.rows[0]?.pg_advisory_unlock !== true) {
            releaseError = new Error('platform settlement advisory unlock was not confirmed');
          }
        } catch (_) {
          releaseError = new Error('platform settlement advisory unlock failed');
        }
      }
      if (releaseError) {
        logger.error?.('platform settlement scheduler lock release failed', {
          code: 'PLATFORM_CONNECTOR_LOCK_RELEASE_FAILED',
        });
      }
      lockClient.release(releaseError || undefined);
    }
  }

  async function syncMonth(monthInput) {
    return syncMonthForProviders(monthInput, configuredProviders);
  }

  async function syncProviderMonth(provider, monthInput) {
    return syncMonthForProviders(monthInput, [provider]);
  }

  async function syncCurrentAndPrevious() {
    const clockValue = now();
    const clock = clockValue instanceof Date ? clockValue : new Date(clockValue);
    if (!Number.isFinite(clock.getTime())) fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
    const current = formatKstDate(clock).slice(0, 7);
    return [await syncMonth(previousMonth(current)), await syncMonth(current)];
  }

  async function syncProviderCurrentAndPrevious(provider, referenceTime) {
    providersForRun([provider]);
    const clockValue = referenceTime === undefined ? now() : referenceTime;
    const clock = clockValue instanceof Date ? clockValue : new Date(clockValue);
    if (!Number.isFinite(clock.getTime())) fail('PLATFORM_CONNECTOR_CONFIG_INVALID', 500);
    const current = formatKstDate(clock).slice(0, 7);
    return [
      await syncProviderMonth(provider, previousMonth(current)),
      await syncProviderMonth(provider, current),
    ];
  }

  return Object.freeze({
    configuredProviders,
    reconcileConnectionStates,
    syncMonth,
    syncCurrentAndPrevious,
    syncProviderMonth,
    syncProviderCurrentAndPrevious,
  });
}

module.exports = {
  CONNECTOR_DEFINITIONS,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  PlatformConnectorError,
  appendPlatformConnectionState,
  configuredProviderKeys,
  createPlatformSettlementSyncService,
  fetchProviderMonthlySnapshot,
  filterRowsForWorkspaces,
  parseProviderResponse,
  reconcileUnconfiguredProviderStates,
};
