#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  CONNECTOR_DEFINITIONS,
  configuredProviderKeys,
  fetchProviderMonthlySnapshot,
} = require('./peakos-platform-connectors');

const PREFLIGHT_PROVIDER_ORDER = Object.freeze([
  'rewardspace',
  'reviewspace',
  'keywordmaster',
]);
const PREFLIGHT_PROVIDER_SET = new Set(PREFLIGHT_PROVIDER_ORDER);
const PREFLIGHT_ENV_NAMES = Object.freeze(PREFLIGHT_PROVIDER_ORDER.map(
  provider => CONNECTOR_DEFINITIONS[provider].envName,
));
const PREFLIGHT_ENV_NAME_SET = new Set(PREFLIGHT_ENV_NAMES);
const MONTH_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/;
const MAX_SECRET_FILE_BYTES = 16 * 1024;
const SAFE_SOURCE_STATES = new Set(['live', 'draft', 'paid', 'unknown']);

class PlatformPreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlatformPreflightError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PlatformPreflightError(code, message);
}

function safeErrorCode(error) {
  const code = String(error?.code || '');
  return /^PLATFORM_(?:CONNECTOR|PREFLIGHT)_[A-Z0-9_]{1,64}$/.test(code)
    ? code
    : 'PLATFORM_PREFLIGHT_FAILED';
}

function parseArgs(argv) {
  if (!Array.isArray(argv)) fail('PLATFORM_PREFLIGHT_ARGUMENT_INVALID', '인수가 올바르지 않습니다.');
  const options = { all: false, provider: null, month: null, envFile: null };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--all') {
      if (seen.has(token)) fail('PLATFORM_PREFLIGHT_ARGUMENT_INVALID', '중복 인수가 있습니다.');
      seen.add(token);
      options.all = true;
      continue;
    }
    if (!['--provider', '--month', '--env-file'].includes(token) || seen.has(token)) {
      fail('PLATFORM_PREFLIGHT_ARGUMENT_INVALID', '허용되지 않거나 중복된 인수가 있습니다.');
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) {
      fail('PLATFORM_PREFLIGHT_ARGUMENT_INVALID', '인수 값이 필요합니다.');
    }
    seen.add(token);
    if (token === '--provider') options.provider = value;
    if (token === '--month') options.month = value;
    if (token === '--env-file') options.envFile = value;
    index += 1;
  }
  if (options.all === Boolean(options.provider)
      || !MONTH_PATTERN.test(String(options.month || ''))
      || typeof options.envFile !== 'string'
      || !path.isAbsolute(options.envFile)
      || (options.provider && !PREFLIGHT_PROVIDER_SET.has(options.provider))) {
    fail('PLATFORM_PREFLIGHT_ARGUMENT_INVALID', 'provider, month 또는 env-file 인수가 올바르지 않습니다.');
  }
  return Object.freeze(options);
}

function effectiveUid(getEffectiveUid) {
  const getter = getEffectiveUid
    || (typeof process.geteuid === 'function' ? process.geteuid.bind(process) : null);
  if (!getter) fail('PLATFORM_PREFLIGHT_ROOT_REQUIRED', 'root 운영자만 실행할 수 있습니다.');
  let uid;
  try {
    uid = getter();
  } catch (_) {
    fail('PLATFORM_PREFLIGHT_ROOT_REQUIRED', 'root 운영자만 실행할 수 있습니다.');
  }
  if (uid !== 0) fail('PLATFORM_PREFLIGHT_ROOT_REQUIRED', 'root 운영자만 실행할 수 있습니다.');
  return uid;
}

function assertSecureSecretStat(stat) {
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()
      || (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink())) {
    fail('PLATFORM_PREFLIGHT_SECRET_FILE_INVALID', '시크릿 경로는 실제 일반 파일이어야 합니다.');
  }
  if (!Number.isInteger(stat.uid) || stat.uid !== 0) {
    fail('PLATFORM_PREFLIGHT_SECRET_FILE_OWNER', '시크릿 파일 소유자는 root여야 합니다.');
  }
  if ((stat.mode & 0o7777) !== 0o600) {
    fail('PLATFORM_PREFLIGHT_SECRET_FILE_MODE', '시크릿 파일 권한은 0600이어야 합니다.');
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_SECRET_FILE_BYTES) {
    fail('PLATFORM_PREFLIGHT_SECRET_FILE_TOO_LARGE', '시크릿 파일 크기가 허용 범위를 벗어났습니다.');
  }
}

function parseSecretEnvironment(contents) {
  if (typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > MAX_SECRET_FILE_BYTES) {
    fail('PLATFORM_PREFLIGHT_CONFIG_INVALID', '플랫폼 시크릿 설정이 올바르지 않습니다.');
  }
  const environment = Object.create(null);
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/);
  let configuredCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !PREFLIGHT_ENV_NAME_SET.has(match[1])) {
      fail('PLATFORM_PREFLIGHT_CONFIG_INVALID', '플랫폼 시크릿 설정이 올바르지 않습니다.');
    }
    const [, name, value] = match;
    if (Object.prototype.hasOwnProperty.call(environment, name) || value.length === 0) {
      fail('PLATFORM_PREFLIGHT_CONFIG_INVALID', '플랫폼 시크릿 설정이 올바르지 않습니다.');
    }
    environment[name] = value;
    configuredCount += 1;
  }
  if (configuredCount === 0) {
    fail('PLATFORM_PREFLIGHT_CONFIG_INVALID', '플랫폼 시크릿 설정이 비어 있습니다.');
  }
  try {
    configuredProviderKeys(environment);
  } catch (_) {
    fail('PLATFORM_PREFLIGHT_CONFIG_INVALID', '플랫폼 시크릿 설정이 올바르지 않습니다.');
  }
  return environment;
}

function readSecretEnvironmentFile(secretPath, {
  fsImpl = fs,
  getEffectiveUid,
} = {}) {
  effectiveUid(getEffectiveUid);
  if (typeof secretPath !== 'string' || !path.isAbsolute(secretPath)) {
    fail('PLATFORM_PREFLIGHT_SECRET_PATH_INVALID', '시크릿 파일은 절대 경로여야 합니다.');
  }
  const resolved = path.resolve(secretPath);
  let before;
  let descriptor;
  try {
    before = fsImpl.lstatSync(resolved);
    assertSecureSecretStat(before);
    const realpath = typeof fsImpl.realpathSync?.native === 'function'
      ? fsImpl.realpathSync.native(resolved)
      : fsImpl.realpathSync(resolved);
    if (realpath !== resolved) {
      fail('PLATFORM_PREFLIGHT_SECRET_FILE_INVALID', '시크릿 경로에 심볼릭 링크를 사용할 수 없습니다.');
    }
    if (!fsImpl.constants
        || !Number.isInteger(fsImpl.constants.O_RDONLY)
        || !Number.isInteger(fsImpl.constants.O_NOFOLLOW)
        || fsImpl.constants.O_NOFOLLOW <= 0) {
      fail('PLATFORM_PREFLIGHT_SECRET_FILE_INVALID', '심볼릭 링크 차단 기능을 확인할 수 없습니다.');
    }
    descriptor = fsImpl.openSync(
      resolved,
      fsImpl.constants.O_RDONLY | fsImpl.constants.O_NOFOLLOW,
    );
    const opened = fsImpl.fstatSync(descriptor);
    assertSecureSecretStat(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      fail('PLATFORM_PREFLIGHT_SECRET_FILE_CHANGED', '시크릿 파일이 확인 도중 변경되었습니다.');
    }
    const contents = fsImpl.readFileSync(descriptor, 'utf8');
    return parseSecretEnvironment(contents);
  } catch (error) {
    if (error instanceof PlatformPreflightError) throw error;
    fail('PLATFORM_PREFLIGHT_SECRET_READ_FAILED', '시크릿 파일을 안전하게 읽지 못했습니다.');
  } finally {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch (_) { /* best-effort close */ }
    }
  }
}

function assertProviderSecrets(environment, providers) {
  const configured = new Set(configuredProviderKeys(environment));
  if (providers.some(provider => !configured.has(provider))) {
    fail('PLATFORM_PREFLIGHT_CONFIG_INVALID', '선택한 플랫폼의 시크릿 설정이 없습니다.');
  }
  if (providers.length === PREFLIGHT_PROVIDER_ORDER.length
      && configured.size !== PREFLIGHT_PROVIDER_ORDER.length) {
    fail('PLATFORM_PREFLIGHT_CONFIG_INVALID', '전체 검증에는 세 플랫폼 시크릿이 모두 필요합니다.');
  }
}

function safeSnapshotSummary(provider, snapshot) {
  const rowCount = Array.isArray(snapshot?.rows) ? snapshot.rows.length : -1;
  const skippedRowCount = snapshot?.skippedRowCount;
  const sourceState = String(snapshot?.sourceState || '');
  if (!SAFE_SOURCE_STATES.has(sourceState)
      || !Number.isSafeInteger(rowCount) || rowCount < 0
      || !Number.isSafeInteger(skippedRowCount) || skippedRowCount < 0) {
    fail('PLATFORM_PREFLIGHT_RESULT_INVALID', '플랫폼 검증 결과가 올바르지 않습니다.');
  }
  return Object.freeze({
    provider,
    ok: true,
    sourceState,
    rowCount,
    skippedRowCount,
  });
}

async function executePlatformPreflight(argv, {
  loadSecretEnvironment = readSecretEnvironmentFile,
  fetchSnapshot = fetchProviderMonthlySnapshot,
  fetchImpl,
  now,
} = {}) {
  const options = parseArgs(argv);
  const providers = options.all ? [...PREFLIGHT_PROVIDER_ORDER] : [options.provider];
  let secrets;
  try {
    secrets = loadSecretEnvironment(options.envFile);
    if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
      fail('PLATFORM_PREFLIGHT_CONFIG_INVALID', '플랫폼 시크릿 설정이 올바르지 않습니다.');
    }
    assertProviderSecrets(secrets, providers);
    const results = [];
    for (const provider of providers) {
      const definition = CONNECTOR_DEFINITIONS[provider];
      const isolatedEnvironment = Object.create(null);
      isolatedEnvironment[definition.envName] = secrets[definition.envName];
      try {
        const request = { provider, month: options.month, env: isolatedEnvironment };
        if (fetchImpl !== undefined) request.fetchImpl = fetchImpl;
        if (now !== undefined) request.now = now;
        const snapshot = await fetchSnapshot(request);
        results.push(safeSnapshotSummary(provider, snapshot));
      } catch (error) {
        results.push(Object.freeze({ provider, ok: false, errorCode: safeErrorCode(error) }));
      } finally {
        delete isolatedEnvironment[definition.envName];
      }
    }
    if (!options.all) return results[0];
    return Object.freeze({
      ok: results.every(result => result.ok === true),
      results: Object.freeze(results),
    });
  } finally {
    if (secrets && typeof secrets === 'object') {
      for (const name of PREFLIGHT_ENV_NAMES) {
        try { delete secrets[name]; } catch (_) { /* best-effort memory cleanup */ }
      }
    }
  }
}

function selectedProviderFromArgs(argv) {
  const index = Array.isArray(argv) ? argv.indexOf('--provider') : -1;
  const provider = index >= 0 ? argv[index + 1] : null;
  return PREFLIGHT_PROVIDER_SET.has(provider) ? provider : null;
}

async function main(argv = process.argv.slice(2), {
  writeOutput = line => process.stdout.write(line),
  setExitCode = code => { process.exitCode = code; },
  ...dependencies
} = {}) {
  let report;
  try {
    report = await executePlatformPreflight(argv, dependencies);
  } catch (error) {
    const provider = selectedProviderFromArgs(argv);
    report = Object.freeze({
      ...(provider ? { provider } : {}),
      ok: false,
      errorCode: safeErrorCode(error),
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
  MAX_SECRET_FILE_BYTES,
  PREFLIGHT_ENV_NAMES,
  PREFLIGHT_PROVIDER_ORDER,
  PlatformPreflightError,
  assertSecureSecretStat,
  executePlatformPreflight,
  main,
  parseArgs,
  parseSecretEnvironment,
  readSecretEnvironmentFile,
  safeErrorCode,
  safeSnapshotSummary,
};
