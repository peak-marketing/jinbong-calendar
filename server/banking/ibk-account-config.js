'use strict';

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const DEFAULT_IBK_SECRET_PATH = '/root/.peakos-secrets/ibk-accounts.env';
const MAX_SECRET_FILE_BYTES = 16 * 1024;

const ACCOUNT_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'ibk-hq-sales',
    numberKey: 'PEAKOS_IBK_HQ_SALES_ACCOUNT_NUMBER',
    passwordKey: 'PEAKOS_IBK_HQ_SALES_ACCOUNT_PASSWORD',
  }),
  Object.freeze({
    id: 'ibk-hq-supplier',
    numberKey: 'PEAKOS_IBK_HQ_SUPPLIER_ACCOUNT_NUMBER',
    passwordKey: 'PEAKOS_IBK_HQ_SUPPLIER_ACCOUNT_PASSWORD',
  }),
  Object.freeze({
    id: 'ibk-hq-fixed',
    numberKey: 'PEAKOS_IBK_HQ_FIXED_ACCOUNT_NUMBER',
    passwordKey: 'PEAKOS_IBK_HQ_FIXED_ACCOUNT_PASSWORD',
  }),
  Object.freeze({
    id: 'ibk-review-space',
    numberKey: 'PEAKOS_IBK_REVIEW_SPACE_ACCOUNT_NUMBER',
    passwordKey: 'PEAKOS_IBK_REVIEW_SPACE_ACCOUNT_PASSWORD',
  }),
  Object.freeze({
    id: 'ibk-reward-space',
    numberKey: 'PEAKOS_IBK_REWARD_SPACE_ACCOUNT_NUMBER',
    passwordKey: 'PEAKOS_IBK_REWARD_SPACE_ACCOUNT_PASSWORD',
  }),
]);

const IDENTITY_KEY = 'PEAKOS_IBK_IDENTITY_NUMBER';
const ALLOWED_SECRET_KEYS = Object.freeze([
  IDENTITY_KEY,
  ...ACCOUNT_DEFINITIONS.flatMap(({ numberKey, passwordKey }) => [numberKey, passwordKey]),
]);
const ALLOWED_SECRET_KEY_SET = new Set(ALLOWED_SECRET_KEYS);

class IbkAccountConfigError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'IbkAccountConfigError';
    this.code = code;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
    };
  }
}

function configError(message, code, cause) {
  return new IbkAccountConfigError(message, code, cause ? { cause } : undefined);
}

function assertExactMode(stat, expectedMode, kind) {
  const actualMode = stat.mode & 0o7777;
  if (actualMode !== expectedMode) {
    throw configError(
      kind === 'directory'
        ? 'IBK 시크릿 상위 디렉터리 권한은 0700이어야 합니다.'
        : 'IBK 시크릿 파일 권한은 0600이어야 합니다.',
      kind === 'directory' ? 'IBK_SECRET_DIRECTORY_MODE' : 'IBK_SECRET_FILE_MODE',
    );
  }
}

function currentEffectiveUid() {
  const uidGetter = typeof process.geteuid === 'function'
    ? process.geteuid
    : typeof process.getuid === 'function'
      ? process.getuid
      : null;
  if (!uidGetter) return null;

  let uid;
  try {
    uid = uidGetter.call(process);
  } catch (error) {
    throw configError('IBK 시크릿 소유권 검사 기준을 확인할 수 없습니다.', 'IBK_SECRET_OWNER_CHECK_FAILED', error);
  }
  if (!Number.isInteger(uid) || uid < 0) {
    throw configError('IBK 시크릿 소유권 검사 기준이 올바르지 않습니다.', 'IBK_SECRET_OWNER_CHECK_FAILED');
  }
  return uid;
}

function assertOwner(stat, expectedUid, kind) {
  if (expectedUid === null) return;
  if (!Number.isInteger(stat.uid) || stat.uid !== expectedUid) {
    throw configError(
      kind === 'directory'
        ? 'IBK 시크릿 상위 디렉터리 소유자가 실행 사용자와 다릅니다.'
        : 'IBK 시크릿 파일 소유자가 실행 사용자와 다릅니다.',
      kind === 'directory' ? 'IBK_SECRET_DIRECTORY_OWNER' : 'IBK_SECRET_FILE_OWNER',
    );
  }
}

function readSecretFile(secretPath) {
  if (typeof secretPath !== 'string' || !secretPath || !path.isAbsolute(secretPath)) {
    throw configError('IBK 시크릿 파일은 절대 경로로 지정해야 합니다.', 'IBK_SECRET_PATH_INVALID');
  }

  const parentPath = path.dirname(secretPath);
  const effectiveUid = currentEffectiveUid();
  let parentStat;
  let fileStatBeforeOpen;

  try {
    parentStat = fs.lstatSync(parentPath);
    fileStatBeforeOpen = fs.lstatSync(secretPath);
  } catch (error) {
    throw configError('IBK 시크릿 파일 또는 상위 디렉터리를 확인할 수 없습니다.', 'IBK_SECRET_NOT_ACCESSIBLE', error);
  }

  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw configError('IBK 시크릿 상위 경로는 실제 디렉터리여야 합니다.', 'IBK_SECRET_DIRECTORY_INVALID');
  }
  assertExactMode(parentStat, 0o700, 'directory');
  assertOwner(parentStat, effectiveUid, 'directory');

  if (!fileStatBeforeOpen.isFile() || fileStatBeforeOpen.isSymbolicLink()) {
    throw configError('IBK 시크릿 경로는 실제 일반 파일이어야 합니다.', 'IBK_SECRET_FILE_INVALID');
  }
  assertExactMode(fileStatBeforeOpen, 0o600, 'file');
  assertOwner(fileStatBeforeOpen, effectiveUid, 'file');

  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(secretPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const openedFileStat = fs.fstatSync(fileDescriptor);

    if (!openedFileStat.isFile()
      || openedFileStat.dev !== fileStatBeforeOpen.dev
      || openedFileStat.ino !== fileStatBeforeOpen.ino) {
      throw configError('IBK 시크릿 파일이 확인 도중 변경되었습니다.', 'IBK_SECRET_FILE_CHANGED');
    }
    assertExactMode(openedFileStat, 0o600, 'file');
    assertOwner(openedFileStat, effectiveUid, 'file');

    const parentStatAfterOpen = fs.lstatSync(parentPath);
    if (!parentStatAfterOpen.isDirectory()
      || parentStatAfterOpen.isSymbolicLink()
      || parentStatAfterOpen.dev !== parentStat.dev
      || parentStatAfterOpen.ino !== parentStat.ino) {
      throw configError('IBK 시크릿 상위 디렉터리가 확인 도중 변경되었습니다.', 'IBK_SECRET_DIRECTORY_CHANGED');
    }
    assertExactMode(parentStatAfterOpen, 0o700, 'directory');
    assertOwner(parentStatAfterOpen, effectiveUid, 'directory');

    if (openedFileStat.size > MAX_SECRET_FILE_BYTES) {
      throw configError('IBK 시크릿 파일 크기가 허용 범위를 초과했습니다.', 'IBK_SECRET_FILE_TOO_LARGE');
    }

    return fs.readFileSync(fileDescriptor, 'utf8');
  } catch (error) {
    if (error instanceof IbkAccountConfigError) throw error;
    throw configError('IBK 시크릿 파일을 안전하게 읽을 수 없습니다.', 'IBK_SECRET_READ_FAILED', error);
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
  }
}

function parseSecrets(contents) {
  const values = new Map();
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      throw configError('IBK 시크릿 파일 형식이 올바르지 않습니다.', 'IBK_SECRET_FORMAT_INVALID');
    }

    const [, key, rawValue] = match;
    if (!ALLOWED_SECRET_KEY_SET.has(key)) {
      throw configError('IBK 시크릿 파일에 허용되지 않은 키가 있습니다.', 'IBK_SECRET_KEY_UNKNOWN');
    }
    if (values.has(key)) {
      throw configError('IBK 시크릿 파일에 중복된 키가 있습니다.', 'IBK_SECRET_KEY_DUPLICATE');
    }

    values.set(key, rawValue.trim());
  }

  if (values.size !== ALLOWED_SECRET_KEYS.length
    || ALLOWED_SECRET_KEYS.some((key) => !values.has(key))) {
    throw configError('IBK 시크릿 파일에 필수 키가 누락되었습니다.', 'IBK_SECRET_KEY_MISSING');
  }

  return values;
}

function normalizeIdentityNumber(value) {
  if (!/^\d{7}$/.test(value) && !/^\d{10}$/.test(value)) {
    throw configError('IBK 식별번호는 숫자 7자리 또는 10자리여야 합니다.', 'IBK_IDENTITY_INVALID');
  }
  return value.length === 10 ? value.slice(-7) : value;
}

function maskAccountNumber(accountNumber) {
  return `${accountNumber.slice(0, 2)}-${'*'.repeat(accountNumber.length - 6)}-${accountNumber.slice(-4)}`;
}

function createCredentials(id, accountNumber, accountPassword, identityNumber) {
  const publicView = Object.freeze({
    id,
    accountNumberMasked: maskAccountNumber(accountNumber),
  });
  const credentials = {};

  Object.defineProperties(credentials, {
    id: { value: id, enumerable: true },
    accountNumberMasked: { value: publicView.accountNumberMasked, enumerable: true },
    accountNumber: { value: accountNumber, enumerable: false },
    accountPassword: { value: accountPassword, enumerable: false },
    identityNumber: { value: identityNumber, enumerable: false },
    toJSON: { value: () => publicView, enumerable: false },
    [util.inspect.custom]: { value: () => publicView, enumerable: false },
  });

  return Object.freeze(credentials);
}

function buildAccountRegistry(values) {
  const identityNumber = normalizeIdentityNumber(values.get(IDENTITY_KEY));
  const accountNumbers = new Set();
  const credentialsById = new Map();

  for (const definition of ACCOUNT_DEFINITIONS) {
    const accountNumber = values.get(definition.numberKey);
    const accountPassword = values.get(definition.passwordKey);

    if (!/^\d{14}$/.test(accountNumber)) {
      throw configError('IBK 계좌번호는 숫자 14자리여야 합니다.', 'IBK_ACCOUNT_NUMBER_INVALID');
    }
    if (!/^\d{4}$/.test(accountPassword)) {
      throw configError('IBK 계좌 비밀번호는 숫자 4자리여야 합니다.', 'IBK_ACCOUNT_PASSWORD_INVALID');
    }
    if (accountNumbers.has(accountNumber)) {
      throw configError('IBK 계좌번호가 중복되었습니다.', 'IBK_ACCOUNT_NUMBER_DUPLICATE');
    }

    accountNumbers.add(accountNumber);
    credentialsById.set(
      definition.id,
      createCredentials(definition.id, accountNumber, accountPassword, identityNumber),
    );
  }

  const publicAccounts = Object.freeze(ACCOUNT_DEFINITIONS.map(({ id }) => Object.freeze({
    id,
    accountNumberMasked: maskAccountNumber(credentialsById.get(id).accountNumber),
  })));

  return Object.freeze({
    publicAccounts,
    getCredentials(accountId) {
      const credentials = credentialsById.get(accountId);
      if (!credentials) {
        throw configError('설정되지 않은 IBK 통장 ID입니다.', 'IBK_ACCOUNT_ID_UNKNOWN');
      }
      return credentials;
    },
    toJSON() {
      return publicAccounts;
    },
  });
}

function loadIbkAccountConfig(options) {
  let secretPath = DEFAULT_IBK_SECRET_PATH;
  if (typeof options === 'string') {
    secretPath = options;
  } else if (options !== undefined) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw configError('IBK 시크릿 경로 옵션 형식이 올바르지 않습니다.', 'IBK_SECRET_PATH_INVALID');
    }
    if (Object.prototype.hasOwnProperty.call(options, 'secretPath')) {
      secretPath = options.secretPath;
    }
  }
  const contents = readSecretFile(secretPath);
  return buildAccountRegistry(parseSecrets(contents));
}

module.exports = {
  DEFAULT_IBK_SECRET_PATH,
  IbkAccountConfigError,
  loadIbkAccountConfig,
};
