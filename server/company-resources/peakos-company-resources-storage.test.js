'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createCompanyResourceStorage,
  safeOriginalFilename,
  targetPath,
  validateDocumentFile,
} = require('./peakos-company-resources-storage');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const UUIDS = [
  '123e4567-e89b-42d3-a456-426614174000',
  '223e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000',
];

test('업로드는 선언 MIME가 아니라 실제 PDF/PNG/JPEG 구조를 확인한다', () => {
  const metadata = validateDocumentFile({ buffer: PNG, mimetype: 'image/png' });
  assert.equal(metadata.mimeType, 'image/png');
  assert.equal(metadata.sizeBytes, PNG.length);
  assert.equal(metadata.sha256.length, 64);
  assert.throws(
    () => validateDocumentFile({ buffer: PNG, mimetype: 'image/jpeg' }),
    error => error.code === 'COMPANY_RESOURCE_FILE_CONTENT_INVALID',
  );
  assert.throws(
    () => validateDocumentFile({ buffer: Buffer.from('<svg><script/></svg>'), mimetype: 'image/png' }),
    error => ['COMPANY_RESOURCE_FILE_SIZE_INVALID', 'COMPANY_RESOURCE_FILE_CONTENT_INVALID'].includes(error.code),
  );
  assert.equal(safeOriginalFilename('../../악성.exe', 'png').includes('/'), false);
});

test('보호 저장소는 random key·0700/0600·hash를 강제하고 변조를 차단한다', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'peakos-company-resource-'));
  await fs.promises.chmod(root, 0o700);
  t.after(async () => fs.promises.rm(root, { recursive: true, force: true }));
  let index = 0;
  const storage = createCompanyResourceStorage({ root, randomUUID: () => UUIDS[index++] });
  const stored = await storage.store('ws_peak', {
    buffer: PNG, mimetype: 'image/png', originalname: '../법인통장.png',
  });
  assert.equal(stored.storedKey, `${UUIDS[0]}.png`);
  assert.equal(stored.originalFilename, '법인통장.png');
  const file = path.join(root, 'ws_peak', stored.storedKey);
  assert.equal((await fs.promises.stat(path.join(root, 'ws_peak'))).mode & 0o777, 0o700);
  assert.equal((await fs.promises.stat(file)).mode & 0o777, 0o600);
  const read = await storage.read('ws_peak', {
    stored_key: stored.storedKey,
    mime_type: stored.mimeType,
    size_bytes: stored.sizeBytes,
    sha256: stored.sha256,
  });
  assert.deepEqual(read, PNG);

  await fs.promises.writeFile(file, Buffer.concat([PNG.subarray(0, -1), Buffer.from([0])]));
  await assert.rejects(
    storage.read('ws_peak', {
      stored_key: stored.storedKey,
      mime_type: stored.mimeType,
      size_bytes: stored.sizeBytes,
      sha256: stored.sha256,
    }),
    error => ['COMPANY_RESOURCE_STORAGE_TAMPERED', 'COMPANY_RESOURCE_STORAGE_UNAVAILABLE'].includes(error.code),
  );
});

test('workspace/stored key 경로 traversal과 공개 uploads 내부 root는 거절한다', () => {
  assert.throws(
    () => targetPath('/var/lib/peakos/company-resources', 'ws_peak', '../secret.pdf'),
    error => error.code === 'COMPANY_RESOURCE_STORAGE_INVALID',
  );
  assert.throws(
    () => createCompanyResourceStorage({ root: path.resolve(__dirname, '..', '..', 'uploads', 'company') }),
    /uploads 밖/,
  );
});

test('저장 식별자 충돌은 기존 immutable 원본을 삭제하거나 덮어쓰지 않는다', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'peakos-company-resource-collision-'));
  await fs.promises.chmod(root, 0o700);
  t.after(async () => fs.promises.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'ws_peak');
  await fs.promises.mkdir(workspaceRoot, { mode: 0o700 });
  const existingPath = path.join(workspaceRoot, `${UUIDS[0]}.png`);
  const existing = Buffer.from('immutable-existing-document');
  await fs.promises.writeFile(existingPath, existing, { mode: 0o600, flag: 'wx' });
  let index = 0;
  const storage = createCompanyResourceStorage({ root, randomUUID: () => UUIDS[index++] });
  await assert.rejects(
    storage.store('ws_peak', { buffer: PNG, mimetype: 'image/png', originalname: '새자료.png' }),
    error => error.code === 'COMPANY_RESOURCE_STORAGE_WRITE_FAILED',
  );
  assert.deepEqual(await fs.promises.readFile(existingPath), existing);
});
