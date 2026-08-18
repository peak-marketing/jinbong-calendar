#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { Pool } = require('pg');

const {
  calculatePlatformMonthlyAggregateDigest,
  ensurePeakosPlatformSettlementInfrastructure,
  importPlatformMonthlyAggregateSnapshot,
} = require('./peakos-platform-monthly-settlement');
const {
  configuredProviderKeys,
  createPlatformSettlementSyncService,
} = require('./peakos-platform-connectors');
const {
  PREFLIGHT_ENV_NAMES,
  PREFLIGHT_PROVIDER_ORDER,
  readSecretEnvironmentFile,
} = require('./peakos-platform-preflight');

const CANARY_CONFIRMATION = 'IMPORT_PLATFORM_CURRENT_PREVIOUS';
const CANARY_POOL_OPTIONS = Object.freeze({
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});
const PROVIDER_SET = new Set(PREFLIGHT_PROVIDER_ORDER);
const MONTH_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/;

class PlatformCanaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlatformCanaryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PlatformCanaryError(code, message);
}

function safeCanaryCode(errorOrCode, fallback = 'PLATFORM_CANARY_FAILED') {
  const code = typeof errorOrCode === 'string'
    ? errorOrCode
    : String(errorOrCode?.code || '');
  if (code === 'PEAKOS_PLATFORM_SETTLEMENT_MIGRATION_REQUIRED') {
    return 'PLATFORM_CANARY_DB_NOT_READY';
  }
  return /^PLATFORM_[A-Z0-9_]{1,71}$/.test(code) ? code : fallback;
}

function parseCanaryArgs(argv) {
  if (!Array.isArray(argv)) fail('PLATFORM_CANARY_ARGUMENT_INVALID', '인수가 올바르지 않습니다.');
  const options = { provider: null, envFile: null, confirm: null };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!['--provider', '--env-file', '--confirm'].includes(token) || seen.has(token)) {
      fail('PLATFORM_CANARY_ARGUMENT_INVALID', '허용되지 않거나 중복된 인수가 있습니다.');
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) {
      fail('PLATFORM_CANARY_ARGUMENT_INVALID', '인수 값이 필요합니다.');
    }
    seen.add(token);
    if (token === '--provider') options.provider = value;
    if (token === '--env-file') options.envFile = value;
    if (token === '--confirm') options.confirm = value;
    index += 1;
  }
  if (!PROVIDER_SET.has(options.provider)
      || typeof options.envFile !== 'string'
      || !path.isAbsolute(options.envFile)
      || options.confirm !== CANARY_CONFIRMATION) {
    fail('PLATFORM_CANARY_ARGUMENT_INVALID', 'provider, env-file 또는 확인 문구가 올바르지 않습니다.');
  }
  return Object.freeze(options);
}

function assertAllProviderSecrets(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    fail('PLATFORM_CANARY_CONFIG_INVALID', '플랫폼 시크릿 설정이 올바르지 않습니다.');
  }
  let configured;
  try {
    configured = configuredProviderKeys(environment);
  } catch (_) {
    fail('PLATFORM_CANARY_CONFIG_INVALID', '플랫폼 시크릿 설정이 올바르지 않습니다.');
  }
  if (configured.length !== PREFLIGHT_PROVIDER_ORDER.length
      || PREFLIGHT_PROVIDER_ORDER.some(provider => !configured.includes(provider))) {
    fail('PLATFORM_CANARY_CONFIG_INVALID', 'canary import에는 세 플랫폼 시크릿이 모두 필요합니다.');
  }
}

function strictCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasInvalidCountField(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  return Object.entries(value).some(
    ([name, count]) => /Count$/.test(name) && !strictCount(count),
  );
}

function previousMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber - 2, 1)).toISOString().slice(0, 7);
}

function expectedCanaryMonths(referenceTime) {
  const clock = referenceTime instanceof Date ? referenceTime : new Date(referenceTime);
  if (!Number.isFinite(clock.getTime())) {
    fail('PLATFORM_CANARY_CONFIG_INVALID', 'canary 기준 시각이 올바르지 않습니다.');
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(clock).map(part => [part.type, part.value]));
  const current = `${parts.year}-${parts.month}`;
  if (!MONTH_PATTERN.test(current)) {
    fail('PLATFORM_CANARY_CONFIG_INVALID', 'canary 기준 월이 올바르지 않습니다.');
  }
  return Object.freeze([previousMonth(current), current]);
}

function invalidMonthSummary(provider, month) {
  return Object.freeze({
    provider,
    month: MONTH_PATTERN.test(String(month || '')) ? String(month) : 'unknown',
    ok: false,
    code: 'PLATFORM_CANARY_RESULT_INVALID',
  });
}

function summarizeCanaryMonth(provider, result) {
  const month = MONTH_PATTERN.test(String(result?.month || ''))
    ? String(result.month)
    : null;
  if (!month || hasInvalidCountField(result)) return invalidMonthSummary(provider, month);
  if (result?.skipped === true) {
    if (!Array.isArray(result.providers) || result.providers.length !== 0) {
      return invalidMonthSummary(provider, month);
    }
    return Object.freeze({
      provider,
      month,
      ok: false,
      disabledConnectionCount: 0,
      code: result.reason === 'locked'
        ? 'PLATFORM_CANARY_LOCKED'
        : 'PLATFORM_CANARY_SKIPPED',
    });
  }
  if (result?.skipped !== false
      || !Array.isArray(result.disabledConnections)
      || !Array.isArray(result.providers)
      || result.providers.length !== 1
      || result.providers[0]?.provider !== provider) {
    return invalidMonthSummary(provider, month);
  }
  const disabledConnectionCount = result.disabledConnections.length;
  const providerResult = result.providers[0];
  if (hasInvalidCountField(providerResult)
      || typeof providerResult.ok !== 'boolean'
      || !strictCount(providerResult.workspaceCount)) {
    return invalidMonthSummary(provider, month);
  }
  const workspaceResults = providerResult.workspaces === undefined
    ? [] : providerResult.workspaces;
  if (!Array.isArray(workspaceResults)
      || workspaceResults.length !== providerResult.workspaceCount
      || workspaceResults.some(item => (
        hasInvalidCountField(item)
        || typeof item.ok !== 'boolean'
        || (item.duplicate !== undefined && typeof item.duplicate !== 'boolean')
      ))) {
    return invalidMonthSummary(provider, month);
  }
  const successCountNames = [
    'sourceRowCount',
    'skippedSourceRowCount',
    'globalUnmatchedCount',
    'globalAmbiguousCount',
  ];
  if (providerResult.ok === true && (
    successCountNames.some(name => !Object.hasOwn(providerResult, name))
    || workspaceResults.some(item => (
      item.ok !== true
      || !Object.hasOwn(item, 'rowCount')
      || !Object.hasOwn(item, 'attributionIssueCount')
    ))
  )) {
    return invalidMonthSummary(provider, month);
  }
  const optionalCount = (value, name) => (
    Object.hasOwn(value, name) ? value[name] : 0
  );
  const workspaceCount = providerResult.workspaceCount;
  const successfulWorkspaceCount = workspaceResults.filter(item => item?.ok === true).length;
  const failedWorkspaceCount = workspaceResults.filter(item => item?.ok !== true).length;
  const duplicateWorkspaceCount = workspaceResults.filter(item => item?.duplicate === true).length;
  const attributionIssueCount = workspaceResults.reduce(
    (total, item) => total + optionalCount(item, 'attributionIssueCount'),
    0,
  );
  if (!strictCount(attributionIssueCount)) return invalidMonthSummary(provider, month);
  const globalUnmatchedCount = optionalCount(providerResult, 'globalUnmatchedCount');
  const globalAmbiguousCount = optionalCount(providerResult, 'globalAmbiguousCount');
  let code = null;
  if (disabledConnectionCount > 0) code = 'PLATFORM_CANARY_RECONCILE_DISABLED';
  else if (providerResult.ok !== true) {
    code = safeCanaryCode(
      providerResult.code
        || workspaceResults.find(item => item?.ok !== true)?.code,
      'PLATFORM_CANARY_IMPORT_FAILED',
    );
  } else if (workspaceCount === 0 || successfulWorkspaceCount !== workspaceCount) {
    code = 'PLATFORM_CANARY_WORKSPACE_COUNT_INVALID';
  } else if (globalUnmatchedCount > 0
      || globalAmbiguousCount > 0
      || attributionIssueCount > 0) {
    code = 'PLATFORM_CANARY_ATTRIBUTION_ISSUES';
  }
  return Object.freeze({
    provider,
    month,
    ok: code === null,
    sourceRowCount: optionalCount(providerResult, 'sourceRowCount'),
    skippedSourceRowCount: optionalCount(providerResult, 'skippedSourceRowCount'),
    workspaceCount,
    successfulWorkspaceCount,
    failedWorkspaceCount,
    duplicateWorkspaceCount,
    attributionIssueCount,
    globalUnmatchedCount,
    globalAmbiguousCount,
    disabledConnectionCount,
    ...(code ? { code } : {}),
  });
}

function summarizeCanaryRun(provider, results, diagnosticCodes = [], expectedMonths = []) {
  const resultMonths = Array.isArray(results)
    ? results.map(result => String(result?.month || ''))
    : [];
  const monthsAreExact = Array.isArray(expectedMonths)
    && expectedMonths.length === 2
    && expectedMonths.every(month => MONTH_PATTERN.test(String(month)))
    && expectedMonths[0] !== expectedMonths[1]
    && resultMonths.length === 2
    && resultMonths[0] === expectedMonths[0]
    && resultMonths[1] === expectedMonths[1]
    && resultMonths[0] !== resultMonths[1];
  if (!monthsAreExact) {
    return Object.freeze({
      provider,
      ok: false,
      monthCount: Array.isArray(results) ? results.length : 0,
      code: 'PLATFORM_CANARY_RESULT_INVALID',
      months: Object.freeze([]),
    });
  }
  const months = Object.freeze(results.map(result => summarizeCanaryMonth(provider, result)));
  const diagnostics = diagnosticCodes.map(code => safeCanaryCode(code));
  const code = diagnostics[0] || null;
  return Object.freeze({
    provider,
    ok: months.every(month => month.ok === true) && !code,
    monthCount: months.length,
    ...(code ? { code } : {}),
    months,
  });
}

async function executePlatformCanary(argv, {
  PoolClass = Pool,
  loadSecretEnvironment = readSecretEnvironmentFile,
  ensureInfrastructure = ensurePeakosPlatformSettlementInfrastructure,
  createSyncService = createPlatformSettlementSyncService,
  importMonthlySnapshot = importPlatformMonthlyAggregateSnapshot,
  calculateSnapshotDigest = calculatePlatformMonthlyAggregateDigest,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const options = parseCanaryArgs(argv);
  let environment;
  let pool;
  try {
    environment = loadSecretEnvironment(options.envFile);
    assertAllProviderSecrets(environment);
    if (typeof now !== 'function') {
      fail('PLATFORM_CANARY_CONFIG_INVALID', 'canary 기준 시각 설정이 올바르지 않습니다.');
    }
    const clockValue = now();
    const referenceClock = clockValue instanceof Date ? new Date(clockValue.getTime()) : new Date(clockValue);
    const expectedMonths = expectedCanaryMonths(referenceClock);
    if (typeof PoolClass !== 'function') {
      fail('PLATFORM_CANARY_CONFIG_INVALID', 'DB pool 설정이 올바르지 않습니다.');
    }
    pool = new PoolClass({ ...CANARY_POOL_OPTIONS });
    await ensureInfrastructure(pool);
    const diagnosticCodes = [];
    const service = createSyncService({
      pool,
      env: environment,
      fetchImpl,
      now,
      importMonthlySnapshot,
      calculateSnapshotDigest,
      logger: {
        error(_message, metadata = {}) {
          diagnosticCodes.push(safeCanaryCode(metadata.code));
        },
      },
    });
    if (!service
        || !Array.isArray(service.configuredProviders)
        || service.configuredProviders.length !== PREFLIGHT_PROVIDER_ORDER.length
        || PREFLIGHT_PROVIDER_ORDER.some(provider => !service.configuredProviders.includes(provider))
        || typeof service.syncProviderCurrentAndPrevious !== 'function') {
      fail('PLATFORM_CANARY_CONFIG_INVALID', 'provider-selective sync service가 준비되지 않았습니다.');
    }
    const results = await service.syncProviderCurrentAndPrevious(options.provider, referenceClock);
    return summarizeCanaryRun(options.provider, results, diagnosticCodes, expectedMonths);
  } finally {
    if (environment && typeof environment === 'object') {
      for (const name of PREFLIGHT_ENV_NAMES) {
        try { delete environment[name]; } catch (_) { /* best-effort memory cleanup */ }
      }
    }
    if (pool && typeof pool.end === 'function') await pool.end();
  }
}

function selectedProvider(argv) {
  const index = Array.isArray(argv) ? argv.indexOf('--provider') : -1;
  const provider = index >= 0 ? argv[index + 1] : null;
  return PROVIDER_SET.has(provider) ? provider : null;
}

async function main(argv = process.argv.slice(2), {
  writeOutput = line => process.stdout.write(line),
  setExitCode = code => { process.exitCode = code; },
  ...dependencies
} = {}) {
  let report;
  try {
    report = await executePlatformCanary(argv, dependencies);
  } catch (error) {
    const provider = selectedProvider(argv);
    report = Object.freeze({
      ...(provider ? { provider } : {}),
      ok: false,
      code: safeCanaryCode(error),
    });
  }
  writeOutput(`${JSON.stringify(report)}\n`);
  if (report.ok !== true) setExitCode(1);
  return report;
}

if (require.main === module) {
  void main();
}

module.exports = {
  CANARY_CONFIRMATION,
  CANARY_POOL_OPTIONS,
  PlatformCanaryError,
  assertAllProviderSecrets,
  expectedCanaryMonths,
  executePlatformCanary,
  main,
  parseCanaryArgs,
  safeCanaryCode,
  summarizeCanaryMonth,
  summarizeCanaryRun,
};
