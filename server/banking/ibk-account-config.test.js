'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const util = require('node:util');

const {
  DEFAULT_IBK_SECRET_PATH,
  IbkAccountConfigError,
  loadIbkAccountConfig,
} = require('./ibk-account-config');

const ACCOUNT_FIXTURES = Object.freeze([
  Object.freeze({ id: 'ibk-hq-sales', prefix: 'PEAKOS_IBK_HQ_SALES' }),
  Object.freeze({ id: 'ibk-hq-supplier', prefix: 'PEAKOS_IBK_HQ_SUPPLIER' }),
  Object.freeze({ id: 'ibk-hq-fixed', prefix: 'PEAKOS_IBK_HQ_FIXED' }),
  Object.freeze({ id: 'ibk-review-space', prefix: 'PEAKOS_IBK_REVIEW_SPACE' }),
  Object.freeze({ id: 'ibk-reward-space', prefix: 'PEAKOS_IBK_REWARD_SPACE' }),
]);

function syntheticAccountNumber(index) {
  return `${String(index).padStart(2, '0')}${String(index).repeat(8)}${String(index).padStart(4, '0')}`;
}

function validValues() {
  const values = new Map([
    ['PEAKOS_IBK_IDENTITY_NUMBER', `${'1'.repeat(3)}${'2'.repeat(7)}`],
  ]);
  ACCOUNT_FIXTURES.forEach(({ prefix }, index) => {
    values.set(`${prefix}_ACCOUNT_NUMBER`, syntheticAccountNumber(index + 1));
    values.set(`${prefix}_ACCOUNT_PASSWORD`, String(index + 1).repeat(4));
  });
  return values;
}

function serializeValues(values, { duplicateKey, unknownKey } = {}) {
  const lines = ['# test-only synthetic credentials'];
  for (const [key, value] of values) lines.push(`${key}=${value}`);
  if (duplicateKey) lines.push(`${duplicateKey}=${values.get(duplicateKey)}`);
  if (unknownKey) lines.push(`${unknownKey}=${'8'.repeat(8)}`);
  return `${lines.join('\n')}\n`;
}

function makeSecretFixture(t, contents = serializeValues(validValues())) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peakos-ibk-config-'));
  const secretPath = path.join(directory, 'ibk-accounts.env');
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(secretPath, contents, { mode: 0o600 });
  fs.chmodSync(secretPath, 0o600);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, secretPath };
}

function assertConfigError(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof IbkAccountConfigError, true);
    assert.equal(error.code, code);
    return true;
  });
}

function statWithUid(stat, uid) {
  return new Proxy(stat, {
    get(target, property) {
      if (property === 'uid') return uid;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function withFsStatOverrides({ lstat, fstat }, callback) {
  const originalLstatSync = fs.lstatSync;
  const originalFstatSync = fs.fstatSync;
  if (lstat) {
    fs.lstatSync = (...args) => lstat(originalLstatSync(...args), ...args);
  }
  if (fstat) {
    fs.fstatSync = (...args) => fstat(originalFstatSync(...args), ...args);
  }
  try {
    return callback();
  } finally {
    fs.lstatSync = originalLstatSync;
    fs.fstatSync = originalFstatSync;
  }
}

function withProcessUidApis({ geteuid, getuid }, callback) {
  const geteuidDescriptor = Object.getOwnPropertyDescriptor(process, 'geteuid');
  const getuidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid');

  if (geteuid === undefined) delete process.geteuid;
  else Object.defineProperty(process, 'geteuid', { configurable: true, writable: true, value: geteuid });
  if (getuid === undefined) delete process.getuid;
  else Object.defineProperty(process, 'getuid', { configurable: true, writable: true, value: getuid });

  try {
    return callback();
  } finally {
    if (geteuidDescriptor) Object.defineProperty(process, 'geteuid', geteuidDescriptor);
    else delete process.geteuid;
    if (getuidDescriptor) Object.defineProperty(process, 'getuid', getuidDescriptor);
    else delete process.getuid;
  }
}

test('기본 시크릿 경로가 저장소 밖의 전용 경로다', () => {
  assert.equal(DEFAULT_IBK_SECRET_PATH, '/root/.peakos-secrets/ibk-accounts.env');
});

test('정확한 11개 키를 5개 통장에 매핑하고 공개 객체에는 마스킹 정보만 둔다', (t) => {
  const values = validValues();
  const { secretPath } = makeSecretFixture(t, serializeValues(values));
  const config = loadIbkAccountConfig({ secretPath });

  assert.deepEqual(
    config.publicAccounts.map(({ id }) => id),
    ACCOUNT_FIXTURES.map(({ id }) => id),
  );
  assert.equal(config.publicAccounts.length, 5);
  for (const account of config.publicAccounts) {
    assert.deepEqual(Object.keys(account).sort(), ['accountNumberMasked', 'id']);
    assert.match(account.accountNumberMasked, /^\d{2}-\*{8}-\d{4}$/);
    assert.equal(Object.isFrozen(account), true);
  }

  ACCOUNT_FIXTURES.forEach(({ id, prefix }) => {
    const credentials = config.getCredentials(id);
    assert.equal(credentials.accountNumber === values.get(`${prefix}_ACCOUNT_NUMBER`), true);
    assert.equal(credentials.accountPassword === values.get(`${prefix}_ACCOUNT_PASSWORD`), true);
    assert.equal(credentials.identityNumber.length, 7);
    assert.deepEqual(Object.keys(credentials).sort(), ['accountNumberMasked', 'id']);
    assert.equal(Object.isFrozen(credentials), true);
  });

  const publicRepresentations = [JSON.stringify(config), util.inspect(config.getCredentials(ACCOUNT_FIXTURES[0].id))];
  for (const representation of publicRepresentations) {
    for (const value of values.values()) assert.equal(representation.includes(value), false);
  }
  assert.equal(Object.isFrozen(config.publicAccounts), true);
  assert.equal(Object.isFrozen(config), true);
});

test('숫자 7자리 식별번호도 그대로 허용한다', (t) => {
  const values = validValues();
  values.set('PEAKOS_IBK_IDENTITY_NUMBER', '3'.repeat(7));
  const { secretPath } = makeSecretFixture(t, serializeValues(values));
  const credentials = loadIbkAccountConfig(secretPath).getCredentials(ACCOUNT_FIXTURES[0].id);
  assert.equal(credentials.identityNumber.length, 7);
});

test('허용되지 않은 키, 누락 키, 중복 키를 거부한다', async (t) => {
  await t.test('허용되지 않은 키', (inner) => {
    const { secretPath } = makeSecretFixture(inner, serializeValues(validValues(), {
      unknownKey: 'PEAKOS_IBK_UNEXPECTED',
    }));
    assertConfigError(() => loadIbkAccountConfig({ secretPath }), 'IBK_SECRET_KEY_UNKNOWN');
  });

  await t.test('누락 키', (inner) => {
    const values = validValues();
    values.delete('PEAKOS_IBK_HQ_FIXED_ACCOUNT_PASSWORD');
    const { secretPath } = makeSecretFixture(inner, serializeValues(values));
    assertConfigError(() => loadIbkAccountConfig({ secretPath }), 'IBK_SECRET_KEY_MISSING');
  });

  await t.test('중복 키', (inner) => {
    const values = validValues();
    const { secretPath } = makeSecretFixture(inner, serializeValues(values, {
      duplicateKey: 'PEAKOS_IBK_HQ_SALES_ACCOUNT_NUMBER',
    }));
    assertConfigError(() => loadIbkAccountConfig({ secretPath }), 'IBK_SECRET_KEY_DUPLICATE');
  });
});

test('중복 계좌와 잘못된 계좌번호, 비밀번호, 식별번호를 거부한다', async (t) => {
  await t.test('중복 계좌번호', (inner) => {
    const values = validValues();
    values.set(
      'PEAKOS_IBK_HQ_SUPPLIER_ACCOUNT_NUMBER',
      values.get('PEAKOS_IBK_HQ_SALES_ACCOUNT_NUMBER'),
    );
    const { secretPath } = makeSecretFixture(inner, serializeValues(values));
    assertConfigError(() => loadIbkAccountConfig(secretPath), 'IBK_ACCOUNT_NUMBER_DUPLICATE');
  });

  await t.test('계좌번호 자릿수', (inner) => {
    const values = validValues();
    values.set('PEAKOS_IBK_HQ_SALES_ACCOUNT_NUMBER', '4'.repeat(13));
    const { secretPath } = makeSecretFixture(inner, serializeValues(values));
    assertConfigError(() => loadIbkAccountConfig(secretPath), 'IBK_ACCOUNT_NUMBER_INVALID');
  });

  await t.test('계좌 비밀번호 자릿수', (inner) => {
    const values = validValues();
    values.set('PEAKOS_IBK_HQ_SALES_ACCOUNT_PASSWORD', '5'.repeat(3));
    const { secretPath } = makeSecretFixture(inner, serializeValues(values));
    assertConfigError(() => loadIbkAccountConfig(secretPath), 'IBK_ACCOUNT_PASSWORD_INVALID');
  });

  await t.test('식별번호 자릿수', (inner) => {
    const values = validValues();
    values.set('PEAKOS_IBK_IDENTITY_NUMBER', '6'.repeat(9));
    const { secretPath } = makeSecretFixture(inner, serializeValues(values));
    assertConfigError(() => loadIbkAccountConfig(secretPath), 'IBK_IDENTITY_INVALID');
  });
});

test('검증 오류를 직렬화해도 입력한 민감값을 포함하지 않는다', (t) => {
  const values = validValues();
  const invalidPassword = '9'.repeat(3);
  values.set('PEAKOS_IBK_HQ_SALES_ACCOUNT_PASSWORD', invalidPassword);
  const { secretPath } = makeSecretFixture(t, serializeValues(values));

  let capturedError;
  try {
    loadIbkAccountConfig(secretPath);
  } catch (error) {
    capturedError = error;
  }

  assert.equal(capturedError instanceof IbkAccountConfigError, true);
  const representations = [
    capturedError.message,
    JSON.stringify(capturedError),
    util.inspect(capturedError),
  ];
  for (const representation of representations) {
    assert.equal(representation.includes(invalidPassword), false);
    assert.equal(representation.includes(values.get('PEAKOS_IBK_IDENTITY_NUMBER')), false);
  }
});

test('상위 디렉터리 0700과 시크릿 파일 0600을 강제한다', async (t) => {
  await t.test('상위 디렉터리 권한', (inner) => {
    const { directory, secretPath } = makeSecretFixture(inner);
    fs.chmodSync(directory, 0o750);
    assertConfigError(() => loadIbkAccountConfig(secretPath), 'IBK_SECRET_DIRECTORY_MODE');
  });

  await t.test('시크릿 파일 권한', (inner) => {
    const { secretPath } = makeSecretFixture(inner);
    fs.chmodSync(secretPath, 0o640);
    assertConfigError(() => loadIbkAccountConfig(secretPath), 'IBK_SECRET_FILE_MODE');
  });
});

test('상위 디렉터리와 파일의 effective UID 소유권을 open 전후로 검증한다', async (t) => {
  await t.test('open 전 상위 디렉터리 소유권', (inner) => {
    const { directory, secretPath } = makeSecretFixture(inner);
    const ownerUid = fs.lstatSync(directory).uid;
    const otherUid = ownerUid === 0 ? 1 : ownerUid - 1;

    withProcessUidApis({ geteuid: () => ownerUid, getuid: () => ownerUid }, () => {
      withFsStatOverrides({
        lstat: (stat, target) => (path.resolve(String(target)) === directory
          ? statWithUid(stat, otherUid)
          : stat),
      }, () => {
        assertConfigError(() => loadIbkAccountConfig(secretPath), 'IBK_SECRET_DIRECTORY_OWNER');
      });
    });
  });

  await t.test('open 전 파일 소유권', (inner) => {
    const { directory, secretPath } = makeSecretFixture(inner);
    const ownerUid = fs.lstatSync(directory).uid;
    const otherUid = ownerUid === 0 ? 1 : ownerUid - 1;

    withProcessUidApis({ geteuid: () => ownerUid, getuid: () => ownerUid }, () => {
      withFsStatOverrides({
        lstat: (stat, target) => (path.resolve(String(target)) === secretPath
          ? statWithUid(stat, otherUid)
          : stat),
      }, () => {
        assertConfigError(() => loadIbkAccountConfig(secretPath), 'IBK_SECRET_FILE_OWNER');
      });
    });
  });

  await t.test('open 후 열린 파일 소유권', (inner) => {
    const { directory, secretPath } = makeSecretFixture(inner);
    const ownerUid = fs.lstatSync(directory).uid;
    const otherUid = ownerUid === 0 ? 1 : ownerUid - 1;

    withProcessUidApis({ geteuid: () => ownerUid, getuid: () => ownerUid }, () => {
      withFsStatOverrides({
        fstat: (stat) => statWithUid(stat, otherUid),
      }, () => {
        assertConfigError(() => loadIbkAccountConfig(secretPath), 'IBK_SECRET_FILE_OWNER');
      });
    });
  });

  await t.test('open 후 상위 디렉터리 소유권', (inner) => {
    const { directory, secretPath } = makeSecretFixture(inner);
    const ownerUid = fs.lstatSync(directory).uid;
    const otherUid = ownerUid === 0 ? 1 : ownerUid - 1;
    let parentChecks = 0;

    withProcessUidApis({ geteuid: () => ownerUid, getuid: () => ownerUid }, () => {
      withFsStatOverrides({
        lstat: (stat, target) => {
          if (path.resolve(String(target)) !== directory) return stat;
          parentChecks += 1;
          return parentChecks > 1 ? statWithUid(stat, otherUid) : stat;
        },
      }, () => {
        assertConfigError(() => loadIbkAccountConfig(secretPath), 'IBK_SECRET_DIRECTORY_OWNER');
      });
    });
  });
});

test('geteuid가 없으면 getuid를 사용하고 UID API가 모두 없으면 mode 검사로 유지한다', async (t) => {
  await t.test('getuid fallback', (inner) => {
    const { directory, secretPath } = makeSecretFixture(inner);
    const ownerUid = fs.lstatSync(directory).uid;
    const otherUid = ownerUid === 0 ? 1 : ownerUid - 1;

    withProcessUidApis({ geteuid: undefined, getuid: () => ownerUid }, () => {
      withFsStatOverrides({
        lstat: (stat, target) => (path.resolve(String(target)) === directory
          ? statWithUid(stat, otherUid)
          : stat),
      }, () => {
        assertConfigError(() => loadIbkAccountConfig(secretPath), 'IBK_SECRET_DIRECTORY_OWNER');
      });
    });
  });

  await t.test('UID API가 없는 플랫폼', (inner) => {
    const { secretPath } = makeSecretFixture(inner);
    withProcessUidApis({ geteuid: undefined, getuid: undefined }, () => {
      assert.equal(loadIbkAccountConfig(secretPath).publicAccounts.length, 5);
    });
  });
});

test('심볼릭 링크와 알 수 없는 통장 ID를 거부한다', async (t) => {
  await t.test('시크릿 파일 심볼릭 링크', (inner) => {
    const { directory, secretPath } = makeSecretFixture(inner);
    const linkPath = path.join(directory, 'linked.env');
    fs.symlinkSync(secretPath, linkPath);
    assertConfigError(() => loadIbkAccountConfig(linkPath), 'IBK_SECRET_FILE_INVALID');
  });

  await t.test('알 수 없는 통장 ID', (inner) => {
    const { secretPath } = makeSecretFixture(inner);
    const config = loadIbkAccountConfig(secretPath);
    assertConfigError(() => config.getCredentials('unknown-account'), 'IBK_ACCOUNT_ID_UNKNOWN');
  });
});
