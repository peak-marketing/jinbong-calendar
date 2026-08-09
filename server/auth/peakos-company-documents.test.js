'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_CLIENT_MANIFEST_BYTES,
  createPeakosCompanyDocumentService,
  parseJpegStructure,
  parseClientManifest,
  registerPeakosCompanyDocuments,
  resolveDocumentRoot,
} = require('./peakos-company-documents');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const DOCUMENT = Object.freeze({
  id: 'head-office', folder: 'branches', branch: '본사',
  filename: '본사 사업자등록증.png', storedFilename: 'head-office.png',
  mimeType: 'image/png', width: 1, height: 1,
  sha256: crypto.createHash('sha256').update(PNG).digest('hex'),
});

function multiScanJpegFixture() {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc2, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33, 0xff, 0x01,
    0xff, 0xdc, 0x00, 0x04, 0x00, 0x02, 0x44,
    0xff, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x01, 0x3f, 0x00,
    0x55, 0xff, 0x00, 0x66, 0xff, 0xd7, 0x77,
    0xff, 0xd9,
  ]);
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[String(name).toLowerCase()] = String(value); return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}

function request(overrides = {}) {
  return {
    uid: 'uid-allowed',
    userDoc: { approved: true, is_active: true },
    osSecondAuth: { required: true, verified: true, uid: 'uid-allowed' },
    params: {},
    query: {},
    ...overrides,
  };
}

function fixtureUuid(index, prefix = 'a') {
  return `${prefix.repeat(8)}-${prefix.repeat(4)}-4${prefix.repeat(3)}-8${prefix.repeat(3)}-${index.toString(16).padStart(12, '0')}`;
}

function clientRecord(index, overrides = {}) {
  const id = fixtureUuid(index, 'a');
  const storedId = fixtureUuid(index, 'b');
  return {
    id,
    clientName: `거래처 ${String(index).padStart(2, '0')}`,
    filename: `거래처 ${String(index).padStart(2, '0')} 사업자등록증.png`,
    driveFileId: `drive-file-${String(index).padStart(6, '0')}`,
    available: true,
    storedFilename: `${storedId}.png`,
    mimeType: 'image/png',
    originalMimeType: 'image/png',
    size: PNG.length,
    sha256: crypto.createHash('sha256').update(PNG).digest('hex'),
    width: 1,
    height: 1,
    canPreview: true,
    errorCode: null,
    importedAt: `2026-08-09T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    ...overrides,
  };
}

function writeClientManifest(root, documents, overrides = {}) {
  const manifest = {
    version: 1,
    generatedAt: '2026-08-09T00:10:00.000Z',
    documents,
    ...overrides,
  };
  const manifestPath = path.join(root, 'client-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  fs.chmodSync(manifestPath, 0o600);
  return manifestPath;
}

function writeClientOriginal(root, record, bytes = PNG) {
  if (!record.storedFilename) return;
  const filesRoot = path.join(root, 'files');
  fs.mkdirSync(filesRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(filesRoot, 0o700);
  fs.writeFileSync(path.join(filesRoot, record.storedFilename), bytes, { mode: 0o600 });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peakos-company-documents-'));
  fs.writeFileSync(path.join(root, DOCUMENT.storedFilename), PNG, { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = [];
  const service = createPeakosCompanyDocumentService({
    root,
    repositoryRoot: path.resolve('/workspace-fixture'),
    documents: [DOCUMENT],
    canRead: req => req.uid === 'uid-allowed' && req.userDoc?.approved === true && req.userDoc?.is_active !== false,
    logger: { info: line => logs.push(line), error: line => logs.push(line) },
  });
  return { root, service, logs };
}

test('JPEG parser는 stuffing·restart·DNL·다중 scan을 따라 실제 EOI 위치만 반환한다', () => {
  const canonical = multiScanJpegFixture();
  const trailing = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xd9, 0x00]);
  assert.deepEqual(parseJpegStructure(Buffer.concat([canonical, trailing])), {
    width: 3,
    height: 2,
    eoiOffset: canonical.length,
  });
  assert.equal(parseJpegStructure(canonical.subarray(0, canonical.length - 1)), null);

  const malformedDnl = Buffer.from(canonical);
  const dnlOffset = malformedDnl.indexOf(Buffer.from([0xff, 0xdc, 0x00, 0x04]));
  malformedDnl[dnlOffset + 3] = 0x05;
  assert.equal(parseJpegStructure(malformedDnl), null);

  const malformedSos = Buffer.from(canonical);
  const sosOffset = malformedSos.indexOf(Buffer.from([0xff, 0xda, 0x00, 0x08]));
  malformedSos[sosOffset + 3] = 0x07;
  assert.equal(parseJpegStructure(malformedSos), null);
});

test('보호 목록은 경로나 해시 없이 검증된 메타데이터만 반환한다', async t => {
  const { root, service, logs } = fixture(t);
  const res = response();
  await service.list(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.documents.length, 1);
  assert.deepEqual(Object.keys(res.body.documents[0]).sort(), [
    'available', 'branch', 'canPreview', 'filename', 'folder', 'height', 'id', 'mimeType', 'size', 'updatedAt', 'width',
  ]);
  assert.equal(res.body.documents[0].available, true);
  assert.equal(res.body.documents[0].canPreview, true);
  assert.equal(JSON.stringify(res.body).includes(root), false);
  assert.equal(res.headers['cache-control'], 'private, no-store, max-age=0');
  assert.equal(res.headers.vary, 'Authorization, Cookie');
  assert.match(logs[0], /"action":"list"/);
});

test('원본은 허용된 UID와 실제 추가 인증을 모두 통과해야 내려간다', async t => {
  const { service } = fixture(t);

  const forbidden = response();
  await service.content(request({ uid: 'uid-other', osSecondAuth: { required: true, verified: true, uid: 'uid-other' } }), forbidden);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.body.code, 'COMPANY_DOCUMENT_FORBIDDEN');

  const noSecondAuth = response();
  await service.content(request({ osSecondAuth: { required: false, verified: true } }), noSecondAuth);
  assert.equal(noSecondAuth.statusCode, 403);
  assert.equal(noSecondAuth.body.code, 'COMPANY_DOCUMENT_SECOND_AUTH_REQUIRED');

  const allowed = response();
  await service.content(request({ params: { id: DOCUMENT.id } }), allowed);
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(allowed.body, PNG);
  assert.equal(allowed.headers['content-type'], 'image/png');
  assert.equal(allowed.headers['content-length'], String(PNG.length));
  assert.match(allowed.headers['content-disposition'], /^attachment;/);
  assert.match(allowed.headers['content-disposition'], /filename\*=UTF-8''/);
  assert.equal(allowed.headers['x-content-type-options'], 'nosniff');
  assert.equal(allowed.headers['cross-origin-resource-policy'], 'same-origin');
});

test('알 수 없는 ID, 누락·변조·심볼릭 링크는 안전하게 거부한다', async t => {
  const { root, service } = fixture(t);

  const unknown = response();
  await service.content(request({ params: { id: '../head-office' } }), unknown);
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.code, 'COMPANY_DOCUMENT_NOT_FOUND');

  fs.writeFileSync(path.join(root, DOCUMENT.storedFilename), Buffer.from('not a png'));
  const tampered = response();
  await service.content(request({ params: { id: DOCUMENT.id } }), tampered);
  assert.equal(tampered.statusCode, 503);
  assert.equal(tampered.body.code, 'COMPANY_DOCUMENT_STORAGE_UNAVAILABLE');

  fs.rmSync(path.join(root, DOCUMENT.storedFilename));
  fs.symlinkSync('/etc/hosts', path.join(root, DOCUMENT.storedFilename));
  const linked = response();
  await service.content(request({ params: { id: DOCUMENT.id } }), linked);
  assert.equal(linked.statusCode, 503);
});

test('느슨한 저장소·파일 권한은 원본 제공과 성공 감사를 거부한다', async t => {
  const { root, service, logs } = fixture(t);

  fs.chmodSync(path.join(root, DOCUMENT.storedFilename), 0o644);
  const publicFile = response();
  await service.content(request({ params: { id: DOCUMENT.id } }), publicFile);
  assert.equal(publicFile.statusCode, 503);

  fs.chmodSync(path.join(root, DOCUMENT.storedFilename), 0o600);
  fs.chmodSync(root, 0o755);
  const publicRoot = response();
  await service.list(request(), publicRoot);
  assert.equal(publicRoot.statusCode, 200);
  assert.equal(publicRoot.body.documents[0].available, false);
  assert.match(logs.at(-1), /"outcome":"COMPANY_DOCUMENT_STORAGE_DEGRADED"/);
});

test('거래처 목록은 private manifest 한 페이지씩 검색하고 내부 저장 정보를 숨긴다', async t => {
  const { root, service } = fixture(t);
  const records = Array.from({ length: 27 }, (_value, index) => clientRecord(index + 1));
  records.forEach(record => writeClientOriginal(root, record));
  writeClientManifest(root, records);

  const first = response();
  await service.list(request({ query: { folder: 'clients', page: '1', limit: '25' } }), first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.folder, 'clients');
  assert.equal(first.body.documents.length, 25);
  assert.deepEqual(first.body.pagination, { page: 1, limit: 25, total: 27, totalPages: 2 });
  assert.equal(first.body.documents[0].clientName, '거래처 01');
  assert.equal(first.body.documents[0].size, PNG.length);
  assert.equal(first.body.documents[0].canPreview, true);
  const serialized = JSON.stringify(first.body);
  assert.equal(serialized.includes('drive-file-'), false);
  assert.equal(serialized.includes('storedFilename'), false);
  assert.equal(serialized.includes('sha256'), false);
  assert.equal(serialized.includes(root), false);

  const second = response();
  await service.list(request({ query: { folder: 'clients', page: '2', limit: '25' } }), second);
  assert.equal(second.body.documents.length, 2);
  assert.deepEqual(
    new Set([...first.body.documents, ...second.body.documents].map(document => document.id)).size,
    27,
  );

  const searched = response();
  await service.list(request({ query: { folder: 'clients', q: '거래처 26', page: '1', limit: '25' } }), searched);
  assert.equal(searched.body.pagination.total, 1);
  assert.equal(searched.body.documents[0].clientName, '거래처 26');
});

test('거래처 원본도 opaque ID로만 찾고 hash·형식·권한을 다시 검증한다', async t => {
  const { root, service } = fixture(t);
  const available = clientRecord(1);
  const unavailable = clientRecord(2, {
    available: false,
    storedFilename: null,
    mimeType: null,
    size: null,
    sha256: null,
    width: null,
    height: null,
    canPreview: false,
    errorCode: 'IMAGE_INVALID',
  });
  writeClientOriginal(root, available);
  writeClientManifest(root, [available, unavailable]);

  const allowed = response();
  await service.content(request({ params: { id: available.id } }), allowed);
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(allowed.body, PNG);
  assert.equal(allowed.headers['content-type'], 'image/png');
  assert.match(allowed.headers['content-disposition'], /^attachment;/);
  assert.equal(String(allowed.headers['content-disposition']).includes(available.driveFileId), false);
  assert.equal(allowed.headers['referrer-policy'], 'no-referrer');

  const quarantined = response();
  await service.content(request({ params: { id: unavailable.id } }), quarantined);
  assert.equal(quarantined.statusCode, 503);
  assert.equal(quarantined.body.code, 'COMPANY_DOCUMENT_STORAGE_UNAVAILABLE');

  const traversal = response();
  await service.content(request({ params: { id: '../' + available.id } }), traversal);
  assert.equal(traversal.statusCode, 404);

  fs.writeFileSync(path.join(root, 'files', available.storedFilename), Buffer.concat([PNG, Buffer.from('tampered')]));
  const tampered = response();
  await service.content(request({ params: { id: available.id } }), tampered);
  assert.equal(tampered.statusCode, 503);
});

test('PDF 거래처 문서는 보수 검사를 통과해도 다운로드 전용이며 active token은 거부한다', async t => {
  const { root, service } = fixture(t);
  const safePdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Root 1 0 R >>\nstartxref\n45\n%%EOF\n',
    'latin1',
  );
  const record = clientRecord(3, {
    filename: 'PDF 거래처 사업자등록증.pdf',
    storedFilename: `${fixtureUuid(3, 'b')}.pdf`,
    mimeType: 'application/pdf',
    originalMimeType: 'application/pdf',
    size: safePdf.length,
    sha256: crypto.createHash('sha256').update(safePdf).digest('hex'),
    width: null,
    height: null,
    canPreview: false,
  });
  writeClientOriginal(root, record, safePdf);
  writeClientManifest(root, [record]);

  const listed = response();
  await service.list(request({ query: { folder: 'clients' } }), listed);
  assert.equal(listed.body.documents[0].available, true);
  assert.equal(listed.body.documents[0].canPreview, false);

  const downloaded = response();
  await service.content(request({ params: { id: record.id } }), downloaded);
  assert.equal(downloaded.statusCode, 200);
  assert.equal(downloaded.headers['content-type'], 'application/pdf');
  assert.match(downloaded.headers['content-disposition'], /^attachment;/);

  const activePdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /OpenAction 2 0 R /Java#53cript (alert) >>\nendobj\nstartxref\n9\n%%EOF\n',
    'latin1',
  );
  fs.writeFileSync(path.join(root, 'files', record.storedFilename), activePdf, { mode: 0o600 });
  const updated = { ...record, size: activePdf.length, sha256: crypto.createHash('sha256').update(activePdf).digest('hex') };
  writeClientManifest(root, [updated], { generatedAt: '2026-08-09T00:11:00.000Z' });
  const rejected = response();
  await service.content(request({ params: { id: record.id } }), rejected);
  assert.equal(rejected.statusCode, 503);
});

test('거래처 manifest는 strict schema·0600·O_NOFOLLOW를 위반하면 fail closed한다', async t => {
  const { root, service } = fixture(t);
  const record = clientRecord(1);
  writeClientOriginal(root, record);

  assert.doesNotThrow(() => parseClientManifest(Buffer.from(JSON.stringify({
    version: 1,
    generatedAt: '2026-08-09T00:10:00.000Z',
    documents: [{ ...record, clientName: '라이트(에이치에스/조상일)', filename: '업체/사업자등록증.png' }],
  }))));

  const extraField = { ...record, unexpected: true };
  assert.throws(
    () => parseClientManifest(Buffer.from(JSON.stringify({
      version: 1, generatedAt: '2026-08-09T00:10:00.000Z', documents: [extraField],
    }))),
    /구조/,
  );
  assert.throws(
    () => parseClientManifest(Buffer.alloc(MAX_CLIENT_MANIFEST_BYTES + 1, 0x20)),
    /크기/,
  );

  const manifestPath = writeClientManifest(root, [record]);
  fs.chmodSync(manifestPath, 0o644);
  const loose = response();
  await service.list(request({ query: { folder: 'clients' } }), loose);
  assert.equal(loose.statusCode, 503);
  assert.equal(loose.body.code, 'COMPANY_DOCUMENT_INDEX_UNAVAILABLE');

  fs.rmSync(manifestPath);
  const external = path.join(path.dirname(root), `outside-client-manifest-${process.pid}.json`);
  fs.writeFileSync(external, JSON.stringify({
    version: 1, generatedAt: '2026-08-09T00:10:00.000Z', documents: [record],
  }), { mode: 0o600 });
  fs.symlinkSync(external, manifestPath);
  t.after(() => fs.rmSync(external, { force: true }));
  const linked = response();
  await service.list(request({ query: { folder: 'clients' } }), linked);
  assert.equal(linked.statusCode, 503);
});

test('거래처 files 디렉터리는 0700 실제 하위 경로만 허용한다', async t => {
  const { root, service } = fixture(t);
  const record = clientRecord(1);
  writeClientOriginal(root, record);
  writeClientManifest(root, [record]);
  const filesRoot = path.join(root, 'files');

  fs.chmodSync(filesRoot, 0o755);
  const loose = response();
  await service.list(request({ query: { folder: 'clients' } }), loose);
  assert.equal(loose.statusCode, 503);

  fs.rmSync(filesRoot, { recursive: true, force: true });
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'peakos-company-files-outside-'));
  fs.writeFileSync(path.join(external, record.storedFilename), PNG, { mode: 0o600 });
  fs.symlinkSync(external, filesRoot);
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  const linked = response();
  await service.list(request({ query: { folder: 'clients' } }), linked);
  assert.equal(linked.statusCode, 503);
});

test('거래처 검색 페이지 입력은 제한 범위의 정수와 안전한 문자열만 받는다', async t => {
  const { root, service } = fixture(t);
  writeClientManifest(root, []);
  for (const query of [
    { folder: 'clients', page: '0' },
    { folder: 'clients', page: '1.5' },
    { folder: 'clients', page: '10001' },
    { folder: 'clients', limit: '101' },
    { folder: 'clients', q: 'a'.repeat(81) },
    { folder: 'clients', q: 'bad\u0000query' },
    { folder: '../clients' },
  ]) {
    const res = response();
    await service.list(request({ query }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(query));
    assert.equal(res.body.code, 'COMPANY_DOCUMENT_QUERY_INVALID');
  }
});

test('저장소는 실제 경로 기준으로 공개 저장소 밖이어야 한다', t => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peakos-company-root-'));
  const repositoryRoot = path.join(fixtureRoot, 'repository');
  const uploadsRoot = path.join(repositoryRoot, 'uploads');
  const externalRoot = path.join(fixtureRoot, 'external');
  fs.mkdirSync(path.join(uploadsRoot, 'private'), { recursive: true });
  fs.mkdirSync(externalRoot);
  fs.symlinkSync(uploadsRoot, path.join(externalRoot, 'linked-uploads'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  assert.throws(() => resolveDocumentRoot('relative/path'), /절대 경로/);
  assert.throws(
    () => resolveDocumentRoot(path.join(uploadsRoot, 'private'), { repositoryRoot }),
    /공개 코드와 uploads 밖/,
  );
  assert.throws(
    () => resolveDocumentRoot(path.join(externalRoot, 'linked-uploads', 'private'), { repositoryRoot }),
    /공개 코드와 uploads 밖/,
  );
  assert.equal(
    resolveDocumentRoot(path.join(externalRoot, 'private-documents'), { repositoryRoot }),
    path.join(externalRoot, 'private-documents'),
  );
});

test('라우터는 목록과 원본 GET 두 개만 등록한다', () => {
  const routes = [];
  const app = { get: (route, handler) => routes.push([route, handler]) };
  registerPeakosCompanyDocuments({
    app,
    root: '/var/lib/peakos/company-documents',
    repositoryRoot: '/srv/app',
    documents: [DOCUMENT],
    canRead: () => false,
    logger: { info() {}, error() {} },
  });
  assert.deepEqual(routes.map(([route]) => route), [
    '/api/peakos/company-documents',
    '/api/peakos/company-documents/:id/content',
  ]);
});
