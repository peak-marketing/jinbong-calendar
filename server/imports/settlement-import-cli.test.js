'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertReportPins,
  readSecretValue,
  writeSecureJson,
} = require('./settlement-import-cli');

test('report/apply는 원본 manifest와 정규화 plan 해시를 모두 고정한다', () => {
  const plan = {
    manifestSha256: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
    report: { baseline: { ok: true } },
  };
  const saved = {
    version: 2,
    manifestSha256: plan.manifestSha256,
    planSha256: plan.planSha256,
    report: { baseline: { ok: true } },
  };
  assert.doesNotThrow(() => assertReportPins(plan, saved));
  assert.throws(() => assertReportPins(plan, { ...saved, planSha256: 'c'.repeat(64) }), /파서/);
  assert.throws(() => assertReportPins(plan, { ...saved, manifestSha256: 'd'.repeat(64) }), /원본/);
  assert.throws(() => assertReportPins(plan, { ...saved, report: { baseline: { ok: false } } }), /K\/L\/N/);
});

test('secret/report 파일은 mode600을 강제하고 기존 파일을 덮어쓰지 않는다', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'settlement-cli-test-'));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'report.json');
  await writeSecureJson(output, { safe: true });
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readSecretValue({
    environmentName: 'TEST_SECRET', filePath: output,
  })), { safe: true });
  await assert.rejects(() => writeSecureJson(output, { overwritten: true }), /EEXIST/);

  const unsafe = path.join(directory, 'unsafe.json');
  await fs.writeFile(unsafe, '{}', { mode: 0o644 });
  await assert.rejects(() => readSecretValue({
    environmentName: 'TEST_SECRET', filePath: unsafe,
  }), /mode 600/);
});
