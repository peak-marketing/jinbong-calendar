'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  APPLY_CONFIRMATION,
  assertExpectedCounts,
  createPinnedReport,
  parseArgs,
  parseExpectedCounts,
  sourceDateBounds,
  validatePinnedReport,
  verifyBackupFile,
} = require('./settlement-refresh-cli');

const EXPECTED_ARGS = Object.freeze({
  expectIntakeInsert: '84',
  expectMonthlyInsert: '6',
  expectIntakeUpdate: '48',
  expectMonthlyUpdate: '0',
  expectMissing: '0',
  expectConflict: '0',
});

test('refresh CLI는 explicit dry-run/apply 인수만 파싱하고 강한 확인 문구를 공개한다', () => {
  assert.equal(APPLY_CONFIRMATION, 'APPLY_CURRENT_SETTLEMENT_REFRESH');
  assert.deepEqual(parseArgs([
    'dry-run', '--source-map-file', '/private/source.json',
    '--uid-map-file', '/private/uid.json', '--backup-file', '/private/db.dump',
  ]), {
    command: 'dry-run', sourceMapFile: '/private/source.json',
    uidMapFile: '/private/uid.json', backupFile: '/private/db.dump',
  });
  assert.throws(() => parseArgs(['dry-run', 'stray']), /알 수 없는 인수/);
});

test('operator가 고정 snapshot으로 승인한 84+6 insert/48+0 update/0 missing/0 conflict를 exact로 강제한다', () => {
  const expected = parseExpectedCounts(EXPECTED_ARGS);
  assert.deepEqual(expected, {
    intakeInsert: 84,
    monthlyInsert: 6,
    intakeUpdate: 48,
    monthlyUpdate: 0,
    missing: 0,
    conflict: 0,
  });
  assert.equal(assertExpectedCounts({ ...expected, source: 1850 }, expected), true);
  assert.throws(
    () => assertExpectedCounts({ ...expected, intakeUpdate: 47 }, expected),
    /승인된 delta/,
  );
  assert.throws(() => parseExpectedCounts({}), /기대 건수/);
});

test('backup preflight는 mode 600·일반 파일·최소 크기·24시간 freshness를 pin한다', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'settlement-refresh-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const backup = path.join(directory, 'database.dump');
  await fs.writeFile(backup, Buffer.alloc(2048, 7), { mode: 0o600 });
  const pin = await verifyBackupFile(backup);
  assert.equal(pin.byteLength, 2048);
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);

  await fs.chmod(backup, 0o644);
  await assert.rejects(verifyBackupFile(backup), /mode 600/);
});

test('backup preflight는 오래된 artifact를 거부한다', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'settlement-refresh-old-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const backup = path.join(directory, 'database.dump');
  await fs.writeFile(backup, Buffer.alloc(2048, 3), { mode: 0o600 });
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await fs.utimes(backup, old, old);
  await assert.rejects(verifyBackupFile(backup), /24시간/);
});

test('dry-run report는 source/DB/operation/backup 네 pin과 안전 counts만 저장한다', () => {
  const plan = {
    manifestSha256: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
    records: {
      intake: [{ date: '2026-08-17' }],
      monthly: [{ date: '2026-08-13' }],
    },
  };
  const classification = {
    safe: true,
    databaseStateSha256: 'c'.repeat(64),
    operationSha256: 'd'.repeat(64),
    counts: { insert: 90, update: 46, missing: 0, conflict: 0 },
  };
  const report = createPinnedReport({
    plan, classification,
    backupPin: { sha256: 'e'.repeat(64), byteLength: 4096 },
    capturePin: { manifestSha256: 'f'.repeat(64) },
    now: new Date('2026-08-17T15:00:00.000Z'),
  });
  assert.deepEqual(report.sourceDates, { from: '2026-08-13', to: '2026-08-17' });
  assert.deepEqual(report.counts, classification.counts);
  assert.equal(Object.hasOwn(report, 'operations'), false);
  assert.equal(Object.hasOwn(report, 'sourceSnapshot'), false);
  assert.doesNotThrow(() => validatePinnedReport(
    report,
    { sha256: 'e'.repeat(64), byteLength: 4096 },
    { manifestSha256: 'f'.repeat(64) },
    Date.parse('2026-08-17T16:00:00.000Z'),
  ));
});

test('apply report는 unsafe·stale·backup drift를 모두 거부한다', () => {
  const good = {
    version: 1, safe: true, createdAt: new Date().toISOString(),
    manifestSha256: 'a'.repeat(64), planSha256: 'b'.repeat(64),
    databaseStateSha256: 'c'.repeat(64), operationSha256: 'd'.repeat(64),
    backupSha256: 'e'.repeat(64), backupBytes: 4096,
    captureManifestSha256: 'f'.repeat(64),
  };
  assert.throws(() => validatePinnedReport(
    { ...good, safe: false }, { sha256: 'e'.repeat(64), byteLength: 4096 },
    { manifestSha256: 'f'.repeat(64) },
  ), /안전 검증/);
  assert.throws(() => validatePinnedReport(
    good, { sha256: 'f'.repeat(64), byteLength: 4096 },
    { manifestSha256: 'f'.repeat(64) },
  ), /백업/);
  assert.throws(() => validatePinnedReport(
    good, { sha256: 'e'.repeat(64), byteLength: 4096 },
    { manifestSha256: '9'.repeat(64) },
  ), /capture/);
  assert.throws(() => validatePinnedReport(
    { ...good, createdAt: '2026-08-15T00:00:00.000Z' },
    { sha256: 'e'.repeat(64), byteLength: 4096 },
    { manifestSha256: 'f'.repeat(64) },
    Date.parse('2026-08-17T00:00:01.000Z'),
  ), /24시간/);
});

test('source date bounds는 개인/특수 정산의 전체 범위를 합쳐 계산한다', () => {
  assert.deepEqual(sourceDateBounds({
    records: { intake: [{ date: '2026-08-17' }], monthly: [{ date: '2026-06-01' }] },
  }), { from: '2026-06-01', to: '2026-08-17' });
});
