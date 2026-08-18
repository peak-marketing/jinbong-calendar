'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SOURCE_DOCUMENTS } = require('./settlement-source-manifest');
const {
  CAPTURE_MANIFEST_FILE,
  assertPlanMatchesCapture,
  captureSourceDirectory,
  safeSourceFilePath,
  verifyCapturedSourceDirectory,
} = require('./settlement-source-capture');

function documents() {
  return SOURCE_DOCUMENTS.map((document, index) => ({
    ...document,
    documentId: `externaldocumentidentifier${String(index + 1).padStart(3, '0')}`,
  }));
}

function workbook(slot) {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64 + slot, slot)]);
}

function fakeFetch(sourceDocuments, { fail = false } = {}) {
  return async url => {
    const index = sourceDocuments.findIndex(document => String(url).includes(document.documentId));
    if (fail || index < 0) {
      return { ok: false, status: 503, headers: { get: () => null } };
    }
    const buffer = workbook(index + 1);
    return {
      ok: true,
      headers: { get: name => (name === 'content-length' ? String(buffer.length) : null) },
      arrayBuffer: async () => buffer,
    };
  };
}

test('7 XLSX를 신규 mode700 디렉터리에 mode600 atomic capture하고 무식별자 manifest를 pin한다', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'settlement-capture-test-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const sourceDir = path.join(parent, 'snapshot');
  const sourceDocuments = documents();
  const result = await captureSourceDirectory({
    documents: sourceDocuments,
    sourceDir,
    fetchImpl: fakeFetch(sourceDocuments),
    now: new Date('2026-08-17T15:00:00.000Z'),
  });
  assert.equal((await fs.stat(sourceDir)).mode & 0o777, 0o700);
  for (const document of sourceDocuments) {
    assert.equal((await fs.stat(path.join(sourceDir, document.fileName))).mode & 0o777, 0o600);
  }
  const manifestText = await fs.readFile(path.join(sourceDir, CAPTURE_MANIFEST_FILE), 'utf8');
  assert.equal(sourceDocuments.some(document => manifestText.includes(document.documentId)), false);
  assert.equal(sourceDocuments.some(document => manifestText.includes(document.ownerName)), false);
  assert.equal(sourceDocuments.some(document => manifestText.includes(document.fileName)), false);
  const verified = await verifyCapturedSourceDirectory(sourceDir, sourceDocuments);
  assert.equal(verified.manifestSha256, result.manifest.manifestSha256);
  assert.equal(assertPlanMatchesCapture({
    sourceFiles: verified.files.map((file, index) => ({
      key: `slot-${index + 1}`, sha256: file.sha256, byteLength: file.byteLength,
    })),
  }, verified), true);
});

test('capture fileName path traversal과 중복 경로를 allowlist 경계에서 거부한다', () => {
  assert.throws(
    () => safeSourceFilePath('/private/capture', { fileName: '../escape.xlsx' }),
    /allowlist/,
  );
  assert.throws(
    () => safeSourceFilePath('/private/capture', { fileName: 'nested/source.xlsx' }),
    /allowlist/,
  );
});

test('capture 후 XLSX 내용·모드·디렉터리 구성 drift를 모두 fail-closed한다', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'settlement-capture-drift-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const sourceDir = path.join(parent, 'snapshot');
  const sourceDocuments = documents();
  await captureSourceDirectory({
    documents: sourceDocuments, sourceDir, fetchImpl: fakeFetch(sourceDocuments),
  });
  const first = path.join(sourceDir, sourceDocuments[0].fileName);
  await fs.appendFile(first, Buffer.from([1]));
  await assert.rejects(verifyCapturedSourceDirectory(sourceDir, sourceDocuments), /pin|hash/);
  await fs.truncate(first, workbook(1).length);
  await fs.chmod(first, 0o644);
  await assert.rejects(verifyCapturedSourceDirectory(sourceDir, sourceDocuments), /권한/);
  await fs.chmod(first, 0o600);
  await fs.writeFile(path.join(sourceDir, 'unexpected.txt'), 'x', { mode: 0o600 });
  await assert.rejects(verifyCapturedSourceDirectory(sourceDir, sourceDocuments), /구성/);
});

test('HTTP capture 실패 시 완성되지 않은 신규 디렉터리를 남기지 않는다', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'settlement-capture-fail-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const sourceDir = path.join(parent, 'snapshot');
  const sourceDocuments = documents();
  await assert.rejects(captureSourceDirectory({
    documents: sourceDocuments,
    sourceDir,
    fetchImpl: fakeFetch(sourceDocuments, { fail: true }),
  }), /HTTP/);
  await assert.rejects(fs.lstat(sourceDir), error => error?.code === 'ENOENT');
});
