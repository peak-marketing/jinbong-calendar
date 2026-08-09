'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const sharp = require('sharp');

const { createPeakosCompanyDocumentService } = require('./peakos-company-documents');

const {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_BYTES,
  DEFAULT_RETRIES,
  convertRawInventory,
  createGoogleDriveDownloader,
  importClientDocuments,
  parseCliArgs,
  runCli,
  validateInventory,
  validateManifest,
} = require('./import-peakos-client-documents');

const FIXED_NOW = new Date('2026-08-09T12:34:56.000Z');
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\nstartxref\n0\n%%EOF\n', 'ascii');
const ANIMATED_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAIfkEAAAAAAAsAAAAAAEAAQAAAgJEAQA7', 'base64');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function inventoryDocument({
  clientName = '테스트 거래처',
  filename,
  driveFileId,
  mimeType,
  bytes,
  parent = 'parent_folder_001',
}) {
  return {
    clientName,
    filename,
    driveFileId,
    mimeType,
    parent,
    size: bytes.length,
  };
}

function inventory(documents) {
  return { version: 1, documents };
}

function driveResponse(document, bytes, overrides = {}) {
  return {
    bytes,
    metadata: {
      id: document.driveFileId,
      name: document.filename,
      mimeType: document.mimeType,
      size: bytes.length,
      ...overrides,
    },
  };
}

function driveHeaders(document, bytes, { mimeType = document.mimeType, filename = document.filename } = {}) {
  const latin1Filename = Buffer.from(filename, 'utf8').toString('latin1');
  return {
    'content-length': String(bytes.length),
    'content-type': mimeType,
    'content-disposition': `attachment; filename="${latin1Filename}"`,
  };
}

function rawRow(document, overrides = {}) {
  return {
    clientName: document.clientName,
    id: document.driveFileId,
    mime: document.mimeType,
    name: document.filename,
    parent: document.parent,
    size: document.size,
    ...overrides,
  };
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'peakos-client-import-'));
  const root = path.join(base, 'private-documents');
  const inventoryPath = path.join(base, 'inventory.json');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, inventoryPath };
}

function serviceResponse() {
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

function httpsFixture(responses, requests = []) {
  return (url, options, callback) => {
    requests.push({ url: new URL(url), options });
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = error => queueMicrotask(() => request.emit('error', error || new Error('destroyed')));
    request.end = () => {
      const fixtureResponse = responses.shift();
      queueMicrotask(() => {
        const response = Readable.from(fixtureResponse.bytes ? [fixtureResponse.bytes] : []);
        response.statusCode = fixtureResponse.statusCode;
        response.headers = fixtureResponse.headers || {};
        callback(response);
      });
    };
    return request;
  };
}

async function imageFixtures() {
  const input = { create: { width: 3, height: 2, channels: 4, background: '#3a94c9' } };
  return {
    png: await sharp(input).png().toBuffer(),
    jpeg: await sharp(input).jpeg({ quality: 90 }).toBuffer(),
    gif: await sharp(input).gif().toBuffer(),
  };
}

test('CLI는 inventory/root 절대 경로만 받고 Drive URL이나 추가 설정을 받지 않는다', () => {
  assert.deepEqual(parseCliArgs([
    '--inventory', '/private/input/client-inventory.json',
    '--root', '/var/lib/peakos/client-documents',
  ]), {
    inventoryPath: '/private/input/client-inventory.json',
    root: '/var/lib/peakos/client-documents',
  });
  assert.throws(() => parseCliArgs(['--inventory', 'relative.json', '--root', '/private']), /절대 경로/);
  assert.throws(() => parseCliArgs(['--inventory', '/private/input.json', '--drive-url', 'forbidden']), /알 수 없는/);
  assert.throws(() => parseCliArgs(['--inventory', '/private/input.json']), /모두 필요/);
  assert.equal(DEFAULT_MAX_BYTES, 50 * 1024 * 1024);
  assert.equal(DEFAULT_CONCURRENCY, 2);
  assert.equal(DEFAULT_RETRIES, 2);
});

test('inventory는 Drive ID와 허용 MIME metadata를 엄격히 검증하고 txt/zip/URL을 거부한다', () => {
  const png = Buffer.alloc(1200);
  const valid = inventory([inventoryDocument({
    filename: '사업자등록증.png',
    driveFileId: 'drive_file_001',
    mimeType: 'image/png',
    bytes: png,
  })]);
  assert.equal(validateInventory(valid), valid);

  assert.throws(() => validateInventory({ ...valid, driveUrl: 'forbidden' }), /필드가 계약/);
  assert.throws(() => validateInventory(inventory([{ ...valid.documents[0], driveFileId: 'https://example.invalid/file' }])), /driveFileId/);
  assert.throws(() => validateInventory(inventory([{ ...valid.documents[0], filename: 'note.txt', mimeType: 'text/plain' }])), /허용되지/);
  assert.throws(() => validateInventory(inventory([{ ...valid.documents[0], filename: 'archive.zip', mimeType: 'application/zip' }])), /허용되지/);
  assert.throws(() => validateInventory(inventory([{ ...valid.documents[0], unexpected: true }])), /필드가 계약/);
});

test('raw 2,061행은 folder/txt/zip을 제외하고 확장자가 잘못된 JPEG를 포함해 대상 695개로 변환한다', () => {
  const rows = [];
  const addRows = (mime, count, nameForIndex) => {
    for (let index = 0; index < count; index += 1) {
      const sequence = rows.length;
      rows.push({
        clientName: sequence < 2 ? `거래처/${sequence + 1}` : `거래처 ${sequence + 1}`,
        id: `drive_fixture_${String(sequence).padStart(5, '0')}`,
        mime,
        name: nameForIndex(index),
        parent: `parent_fixture_${String(sequence).padStart(5, '0')}`,
        size: mime === 'folder' ? 0 : 2048,
      });
    }
  };
  addRows('application/vnd.google-apps.folder', 725, index => `폴더 ${index}`);
  addRows('application/x-zip-compressed', 28, index => `압축 ${index}.zip`);
  addRows('text/plain', 613, index => `텍스트 ${index}.txt`);
  addRows('image/jpeg', 445, index => (index < 5 ? `JPEG ${index}.png` : (index === 5 ? '확장자 없음' : `JPEG ${index}.jpg`)));
  addRows('image/png', 177, index => `PNG ${index}.png`);
  addRows('application/pdf', 72, index => `PDF ${index}.pdf`);
  addRows('image/gif', 1, () => 'GIF.gif');

  const converted = convertRawInventory(rows, { logger: { error() {} } });
  assert.equal(rows.length, 2061);
  assert.equal(converted.inventory.documents.length, 695);
  assert.equal(converted.skipped.length, 0);
  assert.equal(converted.inventory.documents.filter(row => row.mimeType === 'image/jpeg').length, 445);
  assert.equal(converted.inventory.documents.filter(row => row.mimeType === 'image/jpeg' && !/\.jpe?g$/i.test(row.filename)).length, 6);
  assert.equal(converted.inventory.documents.some(row => row.clientName.includes('/')), false);

  const slashTarget = rawRow(inventoryDocument({
    clientName: 'A/B 거래처', filename: '원본.png', driveFileId: 'drive_slash_01', mimeType: 'image/png', bytes: Buffer.alloc(2048),
  }));
  const missingTarget = { ...slashTarget, id: 'drive_missing1', clientName: '' };
  const missingParent = { ...slashTarget, id: 'drive_missing2', parent: null };
  const withSkips = convertRawInventory([slashTarget, missingTarget, missingParent], { logger: { error() {} } });
  assert.equal(withSkips.inventory.documents[0].clientName, 'A/B 거래처');
  assert.deepEqual(withSkips.skipped.map(row => row.code), ['RAW_CLIENT_NAME_MISSING', 'RAW_PARENT_MISSING']);
});

test('PNG/JPEG/GIF/PDF를 검증해 난수 파일명·0600으로 저장하고 manifest를 원자적으로 쓴다', async t => {
  const { root } = fixture(t);
  const images = await imageFixtures();
  const documents = [
    inventoryDocument({ filename: '가나다.png', driveFileId: 'drive_png_001', mimeType: 'image/png', bytes: images.png }),
    inventoryDocument({ filename: '라마바.png', driveFileId: 'drive_jpg_001', mimeType: 'image/jpeg', bytes: images.jpeg }),
    inventoryDocument({ filename: '사아자.gif', driveFileId: 'drive_gif_001', mimeType: 'image/gif', bytes: images.gif }),
    inventoryDocument({ filename: '차카타.pdf', driveFileId: 'drive_pdf_001', mimeType: 'application/pdf', bytes: PDF }),
  ];
  const byId = new Map(documents.map((document, index) => [document.driveFileId, [document, [images.png, images.jpeg, images.gif, PDF][index]]]));
  let active = 0;
  let maximumActive = 0;
  const downloader = async ({ driveFileId }) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setImmediate(resolve));
    const [document, bytes] = byId.get(driveFileId);
    active -= 1;
    return driveResponse(document, bytes);
  };

  const first = await importClientDocuments({
    inventory: inventory(documents),
    root,
    repositoryRoot: '/workspace-fixture',
    downloader,
    now: () => FIXED_NOW,
  });

  assert.equal(maximumActive, 2);
  assert.equal(first.manifest.version, 1);
  assert.equal(first.manifest.generatedAt, FIXED_NOW.toISOString());
  assert.equal(first.manifest.documents.length, 4);
  assert.equal(validateManifest(first.manifest), first.manifest);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, 'files')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, 'quarantine')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, 'client-manifest.json')).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);

  const storedNames = new Set();
  for (const record of first.manifest.documents) {
    assert.equal(record.available, true);
    assert.match(record.id, /^[0-9a-f-]{36}$/);
    assert.match(record.storedFilename, /^[0-9a-f-]{36}\.(?:png|jpg|pdf)$/);
    assert.notEqual(record.id, path.parse(record.storedFilename).name);
    assert.equal(record.storedFilename.includes(record.clientName), false);
    assert.equal(record.storedFilename.includes(record.driveFileId), false);
    assert.equal(storedNames.has(record.storedFilename), false);
    storedNames.add(record.storedFilename);
    const stored = fs.readFileSync(path.join(root, 'files', record.storedFilename));
    assert.equal(fs.statSync(path.join(root, 'files', record.storedFilename)).mode & 0o777, 0o600);
    assert.equal(record.size, stored.length);
    assert.equal(record.sha256, sha256(stored));
    assert.equal(record.errorCode, null);
    assert.equal(record.importedAt, FIXED_NOW.toISOString());
  }

  const gif = first.manifest.documents.find(record => record.originalMimeType === 'image/gif');
  assert.equal(gif.mimeType, 'image/png');
  assert.equal(gif.filename, '사아자.png');
  assert.equal(fs.readFileSync(path.join(root, 'files', gif.storedFilename)).subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(gif.canPreview, true);
  assert.equal(gif.width, 3);
  assert.equal(gif.height, 2);

  const pdf = first.manifest.documents.find(record => record.originalMimeType === 'application/pdf');
  assert.equal(pdf.mimeType, 'application/pdf');
  assert.equal(pdf.canPreview, false);
  assert.equal(pdf.width, null);
  assert.equal(pdf.height, null);
  const jpeg = first.manifest.documents.find(record => record.originalMimeType === 'image/jpeg');
  assert.equal(jpeg.filename, '라마바.jpg');

  const persisted = JSON.parse(fs.readFileSync(path.join(root, 'client-manifest.json'), 'utf8'));
  assert.deepEqual(persisted, first.manifest);

  const firstIds = new Map(first.manifest.documents.map(record => [record.driveFileId, record.id]));
  const firstStoredNames = new Map(first.manifest.documents.map(record => [record.driveFileId, record.storedFilename]));
  const second = await importClientDocuments({
    inventory: inventory(documents),
    root,
    repositoryRoot: '/workspace-fixture',
    downloader,
    now: () => FIXED_NOW,
  });
  for (const record of second.manifest.documents) {
    assert.equal(record.id, firstIds.get(record.driveFileId));
    assert.equal(record.storedFilename, firstStoredNames.get(record.driveFileId));
  }
  assert.equal(fs.readdirSync(path.join(root, 'files')).length, 4);

  const changedPng = await sharp({ create: { width: 4, height: 2, channels: 4, background: '#ef7448' } }).png().toBuffer();
  documents[0] = inventoryDocument({
    filename: '가나다.png', driveFileId: 'drive_png_001', mimeType: 'image/png', bytes: changedPng,
  });
  byId.set('drive_png_001', [documents[0], changedPng]);
  const third = await importClientDocuments({
    inventory: inventory(documents),
    root,
    repositoryRoot: '/workspace-fixture',
    downloader,
    now: () => FIXED_NOW,
  });
  const changedRecord = third.manifest.documents.find(record => record.driveFileId === 'drive_png_001');
  assert.equal(changedRecord.id, firstIds.get('drive_png_001'));
  assert.notEqual(changedRecord.storedFilename, firstStoredNames.get('drive_png_001'));
  assert.equal(fs.existsSync(path.join(root, 'files', firstStoredNames.get('drive_png_001'))), false);
  assert.equal(fs.readdirSync(path.join(root, 'files')).length, 4);

  const pdfRecord = third.manifest.documents.find(record => record.originalMimeType === 'application/pdf');
  const service = createPeakosCompanyDocumentService({
    root,
    repositoryRoot: '/workspace-fixture',
    canRead: () => true,
    logger: { info() {}, error() {} },
  });
  const response = serviceResponse();
  await service.content({
    uid: 'uid-client-docs',
    osSecondAuth: { required: true, verified: true, uid: 'uid-client-docs' },
    params: { id: pdfRecord.id },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, PDF);
  assert.equal(response.headers['content-type'], 'application/pdf');
});

test('JPEG는 marker EOI 뒤 payload만 lossless trim하고 service에서 그대로 제공한다', async t => {
  const { root } = fixture(t);
  const jpeg = await sharp({
    create: { width: 4, height: 3, channels: 3, background: '#3a94c9' },
  }).jpeg({ quality: 91, progressive: true }).toBuffer();
  const trailingPayload = Buffer.concat([
    Buffer.from('trailing-polyglot-', 'ascii'),
    Buffer.from([0xff, 0xd9]),
    Buffer.from('-false-eoi', 'ascii'),
  ]);
  const downloaded = Buffer.concat([jpeg, trailingPayload]);
  const document = inventoryDocument({
    filename: '후행 데이터.jpg',
    driveFileId: 'drive_jpeg_tail1',
    mimeType: 'image/jpeg',
    bytes: downloaded,
  });
  const result = await importClientDocuments({
    inventory: inventory([document]),
    root,
    repositoryRoot: '/workspace-fixture',
    downloader: async () => driveResponse(document, downloaded),
    now: () => FIXED_NOW,
    logger: { error() {} },
  });

  const record = result.manifest.documents[0];
  assert.equal(record.available, true);
  assert.equal(record.size, jpeg.length);
  assert.equal(record.sha256, sha256(jpeg));
  assert.equal(record.width, 4);
  assert.equal(record.height, 3);
  assert.deepEqual(fs.readFileSync(path.join(root, 'files', record.storedFilename)), jpeg);

  const service = createPeakosCompanyDocumentService({
    root,
    repositoryRoot: '/workspace-fixture',
    canRead: () => true,
    logger: { info() {}, error() {} },
  });
  const response = serviceResponse();
  await service.content({
    uid: 'uid-client-docs',
    osSecondAuth: { required: true, verified: true, uid: 'uid-client-docs' },
    params: { id: record.id },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'image/jpeg');
  assert.deepEqual(response.body, jpeg);

  const untrimmedManifest = JSON.parse(JSON.stringify(result.manifest));
  untrimmedManifest.documents[0].size = downloaded.length;
  untrimmedManifest.documents[0].sha256 = sha256(downloaded);
  fs.writeFileSync(
    path.join(root, 'client-manifest.json'),
    JSON.stringify(untrimmedManifest),
    { mode: 0o600 },
  );
  fs.chmodSync(path.join(root, 'client-manifest.json'), 0o600);
  fs.writeFileSync(path.join(root, 'files', record.storedFilename), downloaded, { mode: 0o600 });
  const strictService = createPeakosCompanyDocumentService({
    root,
    repositoryRoot: '/workspace-fixture',
    canRead: () => true,
    logger: { info() {}, error() {} },
  });
  const rejected = serviceResponse();
  await strictService.content({
    uid: 'uid-client-docs',
    osSecondAuth: { required: true, verified: true, uid: 'uid-client-docs' },
    params: { id: record.id },
  }, rejected);
  assert.equal(rejected.statusCode, 503);
});

test('metadata 위조·능동 PDF·다운로드 실패는 quarantine하고 unavailable manifest로 제한한다', async t => {
  const { root } = fixture(t);
  const { png } = await imageFixtures();
  const activePdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /OpenAction 2 0 R /Java#53cript (x) >>\nendobj\n%%EOF\n', 'ascii');
  const documents = [
    inventoryDocument({ filename: 'metadata.png', driveFileId: 'drive_bad_meta', mimeType: 'image/png', bytes: png }),
    inventoryDocument({ filename: 'active.pdf', driveFileId: 'drive_bad_pdf1', mimeType: 'application/pdf', bytes: activePdf }),
    inventoryDocument({ filename: 'animated.gif', driveFileId: 'drive_bad_gif1', mimeType: 'image/gif', bytes: ANIMATED_GIF }),
    inventoryDocument({ filename: 'offline.png', driveFileId: 'drive_offline1', mimeType: 'image/png', bytes: png }),
  ];
  const attempts = new Map();
  const logs = [];
  const result = await importClientDocuments({
    inventory: inventory(documents),
    root,
    repositoryRoot: '/workspace-fixture',
    retries: 2,
    sleep: async () => {},
    now: () => FIXED_NOW,
    logger: { error: line => logs.push(line) },
    downloader: async ({ driveFileId }) => {
      attempts.set(driveFileId, (attempts.get(driveFileId) || 0) + 1);
      if (driveFileId === 'drive_offline1') throw new Error('fixture offline');
      const document = documents.find(item => item.driveFileId === driveFileId);
      if (driveFileId === 'drive_bad_meta') return driveResponse(document, png, { name: '다른파일.png' });
      if (driveFileId === 'drive_bad_gif1') return driveResponse(document, ANIMATED_GIF);
      return driveResponse(document, activePdf);
    },
  });

  assert.equal(attempts.get('drive_offline1'), 3);
  assert.equal(attempts.get('drive_bad_meta'), 1);
  assert.deepEqual(result.manifest.documents.map(record => record.errorCode), [
    'DRIVE_METADATA_MISMATCH',
    'PDF_ACTIVE_CONTENT_FORBIDDEN',
    'IMAGE_MULTIFRAME_FORBIDDEN',
    'DOWNLOAD_FAILED',
  ]);
  for (const record of result.manifest.documents) {
    assert.equal(record.available, false);
    assert.equal(record.storedFilename, null);
    assert.equal(record.mimeType, null);
    assert.equal(record.size, null);
    assert.equal(record.sha256, null);
    assert.equal(record.width, null);
    assert.equal(record.height, null);
    assert.equal(record.canPreview, false);
  }
  assert.equal(fs.readdirSync(path.join(root, 'files')).length, 0);
  const quarantined = fs.readdirSync(path.join(root, 'quarantine'));
  assert.equal(quarantined.filter(name => name.endsWith('.bin')).length, 3);
  assert.equal(quarantined.filter(name => name.endsWith('.json')).length, 4);
  for (const name of quarantined) assert.equal(fs.statSync(path.join(root, 'quarantine', name)).mode & 0o777, 0o600);
  assert.equal(logs.some(line => line.includes('fixture offline')), false);
});

test('stream download는 제한을 넘는 즉시 중단되고 위장·손상 파일은 저장되지 않는다', async t => {
  const { root } = fixture(t);
  const fakePng = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.alloc(1016),
  ]);
  const oversized = Buffer.alloc(1025, 1);
  const documents = [
    inventoryDocument({ filename: 'oversized.png', driveFileId: 'drive_stream01', mimeType: 'image/png', bytes: fakePng }),
    inventoryDocument({ filename: 'corrupt.png', driveFileId: 'drive_corrupt1', mimeType: 'image/png', bytes: fakePng }),
  ];
  const result = await importClientDocuments({
    inventory: inventory(documents),
    root,
    repositoryRoot: '/workspace-fixture',
    maxBytes: 1024,
    retries: 0,
    now: () => FIXED_NOW,
    logger: { error() {} },
    downloader: async ({ driveFileId }) => {
      const document = documents.find(item => item.driveFileId === driveFileId);
      if (driveFileId === 'drive_stream01') {
        return { bytes: Readable.from([oversized.subarray(0, 700), oversized.subarray(700)]), metadata: driveResponse(document, fakePng).metadata };
      }
      return driveResponse(document, fakePng);
    },
  });
  assert.equal(result.manifest.documents[0].errorCode, 'DOWNLOAD_TOO_LARGE');
  assert.equal(result.manifest.documents[1].errorCode, 'IMAGE_INVALID');
  assert.equal(fs.readdirSync(path.join(root, 'files')).length, 0);
});

test('built-in downloader는 redirect host·HTTPS·Content-Length·MIME를 매 hop 검증한다', async () => {
  const { png, jpeg } = await imageFixtures();
  const document = inventoryDocument({
    filename: '다운로드.png', driveFileId: 'drive_https_01', mimeType: 'image/png', bytes: png,
  });
  const requests = [];
  const downloader = createGoogleDriveDownloader({
    requestImpl: httpsFixture([
      { statusCode: 302, headers: { location: 'https://www.googleapis.com/fixture-media' } },
      { statusCode: 200, headers: driveHeaders(document, png), bytes: png },
    ], requests),
  });
  const result = await downloader({ driveFileId: document.driveFileId, document });
  assert.deepEqual(result.bytes, png);
  assert.deepEqual(requests.map(request => request.url.hostname), [
    'drive.usercontent.google.com',
    'www.googleapis.com',
  ]);

  const evilRedirect = createGoogleDriveDownloader({
    requestImpl: httpsFixture([{ statusCode: 302, headers: { location: 'https://example.invalid/private' } }]),
  });
  await assert.rejects(
    () => evilRedirect({ driveFileId: document.driveFileId, document }),
    error => error.code === 'DOWNLOAD_FAILED' && error.retryable === false,
  );

  const badMetadata = createGoogleDriveDownloader({
    requestImpl: httpsFixture([{
      statusCode: 200,
      headers: { ...driveHeaders(document, png), 'content-length': String(png.length + 1), 'content-type': 'text/html' },
      bytes: png,
    }]),
  });
  await assert.rejects(
    () => badMetadata({ driveFileId: document.driveFileId, document }),
    error => error.code === 'DRIVE_METADATA_MISMATCH' && error.retryable === false,
  );

  const pdfDocument = inventoryDocument({
    filename: '공개 PDF.pdf', driveFileId: 'drive_https_pdf', mimeType: 'application/pdf', bytes: PDF,
  });
  const pdfDownloader = createGoogleDriveDownloader({
    requestImpl: httpsFixture([{
      statusCode: 200,
      headers: driveHeaders(pdfDocument, PDF, { mimeType: 'application/octet-stream' }),
      bytes: PDF,
    }]),
  });
  const pdfResult = await pdfDownloader({ driveFileId: pdfDocument.driveFileId, document: pdfDocument });
  assert.equal(pdfResult.metadata.mimeType, 'application/pdf');
  assert.deepEqual(pdfResult.bytes, PDF);

  const extensionlessJpeg = inventoryDocument({
    filename: '확장자 없는 사업자등록증', driveFileId: 'drive_no_ext_1', mimeType: 'image/jpeg', bytes: jpeg,
  });
  const extensionlessDownloader = createGoogleDriveDownloader({
    requestImpl: httpsFixture([{
      statusCode: 200,
      headers: driveHeaders(extensionlessJpeg, jpeg, { filename: `${extensionlessJpeg.filename}.jpg` }),
      bytes: jpeg,
    }]),
  });
  const extensionlessResult = await extensionlessDownloader({
    driveFileId: extensionlessJpeg.driveFileId,
    document: extensionlessJpeg,
  });
  assert.deepEqual(extensionlessResult.bytes, jpeg);

  const wrongName = createGoogleDriveDownloader({
    requestImpl: httpsFixture([{
      statusCode: 200,
      headers: driveHeaders(document, png, { filename: '다른 문서.png' }),
      bytes: png,
    }]),
  });
  await assert.rejects(
    () => wrongName({ driveFileId: document.driveFileId, document }),
    error => error.code === 'DRIVE_METADATA_MISMATCH',
  );
});

test('built-in HTTPS의 일시적 실패는 제한된 backoff 뒤 재시도한다', async t => {
  const { root } = fixture(t);
  const { png } = await imageFixtures();
  const document = inventoryDocument({
    filename: '재시도.png', driveFileId: 'drive_retry_01', mimeType: 'image/png', bytes: png,
  });
  const requests = [];
  const downloader = createGoogleDriveDownloader({
    requestImpl: httpsFixture([
      { statusCode: 503, headers: {} },
      { statusCode: 200, headers: driveHeaders(document, png), bytes: png },
    ], requests),
  });
  const result = await importClientDocuments({
    inventory: inventory([document]),
    root,
    repositoryRoot: '/workspace-fixture',
    downloader,
    retries: 2,
    sleep: async () => {},
    now: () => FIXED_NOW,
    logger: { error() {} },
  });
  assert.equal(requests.length, 2);
  assert.equal(result.manifest.documents[0].available, true);
});

test('manifest publish 뒤 strict orphan만 정리하고 임의 파일과 심볼릭 링크는 보존한다', async t => {
  const { root } = fixture(t);
  const { png } = await imageFixtures();
  const document = inventoryDocument({
    filename: '정리.png', driveFileId: 'drive_gc_0001', mimeType: 'image/png', bytes: png,
  });
  const options = {
    inventory: inventory([document]),
    root,
    repositoryRoot: '/workspace-fixture',
    downloader: async () => driveResponse(document, png),
    now: () => FIXED_NOW,
    logger: { error() {} },
  };
  await importClientDocuments(options);
  const filesRoot = path.join(root, 'files');
  const orphan = `${crypto.randomUUID()}.png`;
  const linked = `${crypto.randomUUID()}.pdf`;
  fs.writeFileSync(path.join(filesRoot, orphan), png, { mode: 0o600 });
  fs.writeFileSync(path.join(filesRoot, 'operator-note.txt'), 'do not delete', { mode: 0o600 });
  fs.symlinkSync('operator-note.txt', path.join(filesRoot, linked));
  const logs = [];
  await importClientDocuments({ ...options, logger: { error: line => logs.push(line) } });
  assert.equal(fs.existsSync(path.join(filesRoot, orphan)), false);
  assert.equal(fs.existsSync(path.join(filesRoot, 'operator-note.txt')), true);
  assert.equal(fs.lstatSync(path.join(filesRoot, linked)).isSymbolicLink(), true);
  assert.equal(logs.filter(line => line.includes('unknown-private-file-preserved')).length, 2);
});

test('O_EXCL 임시파일 충돌은 기존 파일을 삭제하거나 덮어쓰지 않는다', async t => {
  const { root } = fixture(t);
  const { png } = await imageFixtures();
  const existingDocument = inventoryDocument({
    filename: '기존.png', driveFileId: 'drive_existing1', mimeType: 'image/png', bytes: png,
  });
  const first = await importClientDocuments({
    inventory: inventory([existingDocument]),
    root,
    repositoryRoot: '/workspace-fixture',
    downloader: async () => driveResponse(existingDocument, png),
    now: () => FIXED_NOW,
    logger: { error() {} },
  });

  const collisionUuid = crypto.randomUUID();
  const collisionPath = path.join(root, 'files', `.blob.${collisionUuid}.tmp`);
  const sentinel = Buffer.from('operator-owned collision sentinel', 'utf8');
  fs.writeFileSync(collisionPath, sentinel, { mode: 0o600 });
  const newDocument = inventoryDocument({
    filename: '신규.png', driveFileId: 'drive_collision1', mimeType: 'image/png', bytes: png,
  });
  const generated = [
    crypto.randomUUID(),
    crypto.randomUUID(),
    collisionUuid,
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  ];
  const result = await importClientDocuments({
    inventory: inventory([existingDocument, newDocument]),
    root,
    repositoryRoot: '/workspace-fixture',
    downloader: async ({ driveFileId }) => (
      driveFileId === existingDocument.driveFileId
        ? driveResponse(existingDocument, png)
        : driveResponse(newDocument, png)
    ),
    uuidFactory: () => generated.shift() || crypto.randomUUID(),
    now: () => FIXED_NOW,
    logger: { error() {} },
  });

  assert.deepEqual(fs.readFileSync(collisionPath), sentinel);
  const existingRecord = first.manifest.documents[0];
  assert.equal(fs.existsSync(path.join(root, 'files', existingRecord.storedFilename)), true);
  assert.equal(result.manifest.documents.find(record => record.driveFileId === newDocument.driveFileId).available, false);
});

test('동시 importer는 private O_EXCL lock으로 즉시 fail closed한다', async t => {
  const { root } = fixture(t);
  const { png } = await imageFixtures();
  const document = inventoryDocument({
    filename: '잠금.png', driveFileId: 'drive_lock_001', mimeType: 'image/png', bytes: png,
  });
  let releaseDownload;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { releaseDownload = resolve; });
  const first = importClientDocuments({
    inventory: inventory([document]),
    root,
    repositoryRoot: '/workspace-fixture',
    downloader: async () => {
      markStarted();
      await gate;
      return driveResponse(document, png);
    },
    now: () => FIXED_NOW,
    logger: { error() {} },
  });
  await started;
  await assert.rejects(
    () => importClientDocuments({
      inventory: inventory([document]),
      root,
      repositoryRoot: '/workspace-fixture',
      downloader: async () => driveResponse(document, png),
      now: () => FIXED_NOW,
      logger: { error() {} },
    }),
    error => error.code === 'CLIENT_IMPORT_LOCKED',
  );
  releaseDownload();
  await first;
  assert.equal(fs.existsSync(path.join(root, '.client-import.lock')), false);
});

test('runCli built-in downloader는 raw 배열을 읽고 fixture HTTPS로만 실행한다', async t => {
  const { root, inventoryPath } = fixture(t);
  const { png } = await imageFixtures();
  const document = inventoryDocument({
    filename: 'CLI 사업자등록증.png',
    driveFileId: 'drive_cli_001',
    mimeType: 'image/png',
    bytes: png,
  });
  fs.writeFileSync(inventoryPath, JSON.stringify([rawRow(document)]), { mode: 0o600 });
  const logs = [];
  const requests = [];
  const result = await runCli(['--inventory', inventoryPath, '--root', root], {
    allowedRoot: root,
    repositoryRoot: '/workspace-fixture',
    requestImpl: httpsFixture([{
      statusCode: 200,
      headers: driveHeaders(document, png),
      bytes: png,
    }], requests),
    now: () => FIXED_NOW,
    logger: { info: line => logs.push(line), error: line => logs.push(line) },
  });
  assert.equal(result.manifest.documents[0].available, true);
  assert.match(logs.at(-1), /available 1 \/ unavailable 0 \/ raw 제외 0/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.protocol, 'https:');
  assert.equal(requests[0].url.hostname, 'drive.usercontent.google.com');
  assert.equal(requests[0].url.searchParams.get('id'), document.driveFileId);
  await assert.rejects(
    () => runCli(['--inventory', inventoryPath, '--root', path.join(root, 'typo')], {
      allowedRoot: root,
      repositoryRoot: '/workspace-fixture',
      requestImpl: httpsFixture([]),
    }),
    /승인된 보호 경로/,
  );
});

test('programmatic importer도 광범위한 시스템 디렉터리를 변경하지 않는다', async () => {
  const before = fs.statSync('/tmp').mode & 0o7777;
  await assert.rejects(
    () => importClientDocuments({
      inventory: inventory([]),
      root: '/tmp',
      repositoryRoot: '/workspace-fixture',
      downloader: async () => { throw new Error('호출되면 안 됨'); },
      logger: { error() {} },
    }),
    /PRIVATE_ROOT_TOO_BROAD/,
  );
  assert.equal(fs.statSync('/tmp').mode & 0o7777, before);
});
