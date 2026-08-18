'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PREFLIGHT_ENV_NAMES,
  executePlatformPreflight,
  main,
  parseArgs,
  parseSecretEnvironment,
  readSecretEnvironmentFile,
} = require('./peakos-platform-preflight');

const SECRET_PATH = '/root/.peakos-secrets/platform-api.env';
const FAKE_SECRETS = Object.freeze({
  PEAKOS_REWARDSPACE_API_KEY: 'reward-test-key',
  PEAKOS_REVIEWSPACE_API_KEY: 'review-test-key',
  PEAKOS_KEYWORDMASTER_API_KEY: 'keyword-test-key',
});

function copySecrets(source = FAKE_SECRETS) {
  return Object.assign(Object.create(null), source);
}

function fakeSnapshot(provider) {
  return {
    provider,
    sourceState: provider === 'keywordmaster' ? 'unknown' : 'live',
    skippedRowCount: 1,
    rows: [{
      externalSalespersonName: '출력되면 안 되는 영업자',
      salesAmount: '990001',
      profitAmount: '880001',
    }],
  };
}

function rootStat(stat, overrides = {}) {
  return new Proxy(stat, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
      if (property === 'uid') return 0;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function rootFs(overrides = {}) {
  return {
    constants: fs.constants,
    lstatSync: target => rootStat(fs.lstatSync(target), overrides.lstat || {}),
    realpathSync: target => path.resolve(target),
    openSync: fs.openSync.bind(fs),
    fstatSync: descriptor => rootStat(fs.fstatSync(descriptor), overrides.fstat || {}),
    readFileSync: fs.readFileSync.bind(fs),
    closeSync: fs.closeSync.bind(fs),
  };
}

test('CLI 인수는 단일 provider 또는 --all, 월, 절대 env-file만 허용한다', () => {
  assert.deepEqual(parseArgs([
    '--provider', 'rewardspace', '--month', '2026-08', '--env-file', SECRET_PATH,
  ]), {
    all: false, provider: 'rewardspace', month: '2026-08', envFile: SECRET_PATH,
  });
  assert.deepEqual(parseArgs([
    '--all', '--month', '2026-08', '--env-file', SECRET_PATH,
  ]), {
    all: true, provider: null, month: '2026-08', envFile: SECRET_PATH,
  });
  for (const args of [
    ['--provider', 'brandautospace', '--month', '2026-08', '--env-file', SECRET_PATH],
    ['--provider', 'rewardspace', '--all', '--month', '2026-08', '--env-file', SECRET_PATH],
    ['--provider', 'rewardspace', '--month', '2026-13', '--env-file', SECRET_PATH],
    ['--provider', 'rewardspace', '--month', '2026-08', '--env-file', 'relative.env'],
    ['--provider', 'rewardspace', '--month', '2026-08', '--env-file', SECRET_PATH, '--debug'],
  ]) {
    assert.throws(() => parseArgs(args), { code: 'PLATFORM_PREFLIGHT_ARGUMENT_INVALID' });
  }
});

test('env parser는 세 고정 이름의 비어 있지 않은 subset만 받고 blank·unknown·duplicate를 거부한다', () => {
  assert.deepEqual(PREFLIGHT_ENV_NAMES, [
    'PEAKOS_REWARDSPACE_API_KEY',
    'PEAKOS_REVIEWSPACE_API_KEY',
    'PEAKOS_KEYWORDMASTER_API_KEY',
  ]);
  const parsed = parseSecretEnvironment([
    '# rotated operator secret',
    'PEAKOS_REWARDSPACE_API_KEY=reward-test-key',
    '',
  ].join('\n'));
  assert.equal(parsed.PEAKOS_REWARDSPACE_API_KEY, 'reward-test-key');
  assert.throws(() => parseSecretEnvironment(''), { code: 'PLATFORM_PREFLIGHT_CONFIG_INVALID' });
  assert.throws(
    () => parseSecretEnvironment('PEAKOS_REWARDSPACE_API_KEY='),
    { code: 'PLATFORM_PREFLIGHT_CONFIG_INVALID' },
  );
  assert.throws(
    () => parseSecretEnvironment('PEAKOS_PLATFORM_SYNC_ENABLED=true'),
    { code: 'PLATFORM_PREFLIGHT_CONFIG_INVALID' },
  );
  assert.throws(
    () => parseSecretEnvironment([
      'PEAKOS_REWARDSPACE_API_KEY=reward-test-key',
      'PEAKOS_REWARDSPACE_API_KEY=another-test-key',
    ].join('\n')),
    { code: 'PLATFORM_PREFLIGHT_CONFIG_INVALID' },
  );
});

test('secret file loader는 root 실행자·root owner·0600·regular·no-symlink를 고정한다', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peakos-platform-preflight-'));
  const secretFile = path.join(directory, 'platform.env');
  fs.writeFileSync(secretFile, 'PEAKOS_REWARDSPACE_API_KEY=reward-test-key\n', { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const loaded = readSecretEnvironmentFile(secretFile, {
    fsImpl: rootFs(), getEffectiveUid: () => 0,
  });
  assert.equal(loaded.PEAKOS_REWARDSPACE_API_KEY, 'reward-test-key');

  let touched = false;
  assert.throws(() => readSecretEnvironmentFile(secretFile, {
    fsImpl: { lstatSync() { touched = true; } }, getEffectiveUid: () => 1000,
  }), { code: 'PLATFORM_PREFLIGHT_ROOT_REQUIRED' });
  assert.equal(touched, false);

  assert.throws(() => readSecretEnvironmentFile(secretFile, {
    fsImpl: rootFs({ lstat: { uid: 1000 } }), getEffectiveUid: () => 0,
  }), { code: 'PLATFORM_PREFLIGHT_SECRET_FILE_OWNER' });
  assert.throws(() => readSecretEnvironmentFile(secretFile, {
    fsImpl: rootFs({ lstat: { mode: 0o100640 } }), getEffectiveUid: () => 0,
  }), { code: 'PLATFORM_PREFLIGHT_SECRET_FILE_MODE' });

  const blankFile = path.join(directory, 'pending-blank.env');
  fs.writeFileSync(blankFile, '', { mode: 0o600 });
  assert.throws(() => readSecretEnvironmentFile(blankFile, {
    fsImpl: rootFs(), getEffectiveUid: () => 0,
  }), { code: 'PLATFORM_PREFLIGHT_CONFIG_INVALID' });

  assert.throws(() => readSecretEnvironmentFile(directory, {
    fsImpl: rootFs(), getEffectiveUid: () => 0,
  }), { code: 'PLATFORM_PREFLIGHT_SECRET_FILE_INVALID' });

  const link = path.join(directory, 'platform-link.env');
  fs.symlinkSync(secretFile, link);
  assert.throws(() => readSecretEnvironmentFile(link, {
    fsImpl: rootFs(), getEffectiveUid: () => 0,
  }), { code: 'PLATFORM_PREFLIGHT_SECRET_FILE_INVALID' });
});

test('single preflight는 기존 connector로 정확히 한 번 fetch하고 안전 메타만 반환한다', async () => {
  let requestCount = 0;
  const secret = FAKE_SECRETS.PEAKOS_REWARDSPACE_API_KEY;
  const confidentialName = '출력되면 안 되는 영업자';
  const payload = {
    ok: true,
    ym: '2026-08',
    status: 'NONE',
    periodEnded: false,
    range: { from: '2026-08-01', to: '2026-08-31' },
    effective: {
      accounts: [{
        payTo: 'sales-a', name: confidentialName, sales: 990001,
        distCost: 110000, spread: 880001, commission: 70001, lines: 1,
      }],
      managers: [],
      totals: {
        sales: 990001, spread: 880001, lines: 1,
        commission: 70001, incentive: 0, payoutTotal: 70001,
      },
    },
    drift: 0,
  };
  const report = await executePlatformPreflight([
    '--provider', 'rewardspace', '--month', '2026-08', '--env-file', SECRET_PATH,
  ], {
    loadSecretEnvironment: () => copySecrets({ PEAKOS_REWARDSPACE_API_KEY: secret }),
    fetchImpl: async (url, options) => {
      requestCount += 1;
      assert.equal(new URL(url).pathname, '/api/external/payouts');
      assert.equal(options.headers['X-API-KEY'], secret);
      return {
        ok: true,
        status: 200,
        redirected: false,
        url,
        headers: { get: name => (name === 'content-type' ? 'application/json' : null) },
        text: async () => JSON.stringify(payload),
      };
    },
  });
  assert.equal(requestCount, 1);
  assert.deepEqual(report, {
    provider: 'rewardspace', ok: true, sourceState: 'live', rowCount: 1, skippedRowCount: 0,
  });
  const output = JSON.stringify(report);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes(confidentialName), false);
  assert.equal(output.includes('990001'), false);
  assert.equal(output.includes('880001'), false);
});

test('--all은 세 provider를 고정 순서로 직렬 실행하고 raw 행을 반환하지 않는다', async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const report = await executePlatformPreflight([
    '--all', '--month', '2026-08', '--env-file', SECRET_PATH,
  ], {
    loadSecretEnvironment: () => copySecrets(),
    fetchSnapshot: async ({ provider, env }) => {
      order.push(provider);
      assert.deepEqual(Object.keys(env), [
        `PEAKOS_${provider === 'rewardspace' ? 'REWARDSPACE' : provider === 'reviewspace' ? 'REVIEWSPACE' : 'KEYWORDMASTER'}_API_KEY`,
      ]);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setImmediate(resolve));
      active -= 1;
      return fakeSnapshot(provider);
    },
  });
  assert.deepEqual(order, ['rewardspace', 'reviewspace', 'keywordmaster']);
  assert.equal(maxActive, 1);
  assert.equal(report.ok, true);
  assert.equal(report.results.length, 3);
  const output = JSON.stringify(report);
  assert.equal(output.includes('출력되면 안 되는 영업자'), false);
  assert.equal(output.includes('990001'), false);
  assert.equal(output.includes('880001'), false);
  for (const secret of Object.values(FAKE_SECRETS)) assert.equal(output.includes(secret), false);
});

test('--all은 세 키가 모두 없으면 외부 호출 전에 config invalid로 중단한다', async () => {
  let fetchCount = 0;
  await assert.rejects(
    executePlatformPreflight([
      '--all', '--month', '2026-08', '--env-file', SECRET_PATH,
    ], {
      loadSecretEnvironment: () => copySecrets({ PEAKOS_REWARDSPACE_API_KEY: 'reward-test-key' }),
      fetchSnapshot: async () => { fetchCount += 1; },
    }),
    { code: 'PLATFORM_PREFLIGHT_CONFIG_INVALID' },
  );
  assert.equal(fetchCount, 0);
});

test('connector 실패와 예상 밖 오류는 원문·키 없이 안전한 code만 출력한다', async () => {
  const secret = FAKE_SECRETS.PEAKOS_REWARDSPACE_API_KEY;
  const lines = [];
  let exitCode = 0;
  const report = await main([
    '--provider', 'rewardspace', '--month', '2026-08', '--env-file', SECRET_PATH,
  ], {
    loadSecretEnvironment: () => copySecrets({ PEAKOS_REWARDSPACE_API_KEY: secret }),
    fetchSnapshot: async () => {
      const error = new Error(`upstream raw response salesperson=홍길동 amount=123456 secret=${secret}`);
      error.code = 'PLATFORM_CONNECTOR_HTTP_ERROR';
      throw error;
    },
    writeOutput: line => lines.push(line),
    setExitCode: code => { exitCode = code; },
  });
  assert.deepEqual(report, {
    provider: 'rewardspace', ok: false, errorCode: 'PLATFORM_CONNECTOR_HTTP_ERROR',
  });
  assert.equal(exitCode, 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes(secret), false);
  assert.equal(lines[0].includes('홍길동'), false);
  assert.equal(lines[0].includes('123456'), false);
  assert.equal(lines[0].includes('raw response'), false);
});
