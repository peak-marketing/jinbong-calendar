'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createPeakosCompanyDocumentService,
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
    ...overrides,
  };
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

test('보호 목록은 경로나 해시 없이 검증된 메타데이터만 반환한다', async t => {
  const { root, service, logs } = fixture(t);
  const res = response();
  await service.list(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.documents.length, 1);
  assert.deepEqual(Object.keys(res.body.documents[0]).sort(), [
    'available', 'branch', 'filename', 'folder', 'height', 'id', 'mimeType', 'size', 'updatedAt', 'width',
  ]);
  assert.equal(res.body.documents[0].available, true);
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
