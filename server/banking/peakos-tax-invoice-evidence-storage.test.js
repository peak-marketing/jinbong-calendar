'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_EVIDENCE_BYTES,
  createTaxInvoiceEvidenceStorage,
  detectedMimeType,
  safeOriginalFilename,
  targetPath,
  validateEvidenceFile,
} = require('./peakos-tax-invoice-evidence-storage');

function pdfBytes(extra = '') {
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${extra}startxref\n0\n%%EOF\n`, 'latin1');
}

function pngBytes() {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const buffer = Buffer.alloc(12 + data.length);
    buffer.writeUInt32BE(data.length, 0);
    buffer.write(type, 4, 4, 'ascii');
    data.copy(buffer, 8);
    return buffer;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', Buffer.from([0])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('PDF/PNG 실제 내용과 선언 MIME가 일치해야 한다', () => {
  assert.equal(detectedMimeType(pdfBytes()), 'application/pdf');
  assert.equal(detectedMimeType(pngBytes()), 'image/png');
  const valid = validateEvidenceFile({
    buffer: pdfBytes(), mimetype: 'application/pdf', originalname: 'invoice.pdf',
  });
  assert.equal(valid.mimeType, 'application/pdf');
  assert.match(valid.sha256, /^[0-9a-f]{64}$/);
  assert.throws(
    () => validateEvidenceFile({ buffer: pdfBytes(), mimetype: 'image/png' }),
    error => error.code === 'TAX_INVOICE_EVIDENCE_FILE_CONTENT_INVALID',
  );
  assert.throws(
    () => validateEvidenceFile({ buffer: Buffer.alloc(MAX_EVIDENCE_BYTES + 1), mimetype: 'application/pdf' }),
    error => error.code === 'TAX_INVOICE_EVIDENCE_FILE_SIZE_INVALID',
  );
});

test('위험한 PDF action과 polyglot trailing data를 거부한다', () => {
  assert.equal(detectedMimeType(pdfBytes('/JavaScript (alert)\n')), null);
  assert.equal(detectedMimeType(Buffer.concat([pngBytes(), Buffer.from('<script>')])), null);
});

test('원본 파일명과 저장 경로는 traversal·실행 확장자를 제거한다', () => {
  assert.equal(safeOriginalFilename('../../invoice.exe', 'pdf'), 'invoice.pdf');
  assert.equal(safeOriginalFilename('정상 계산서.pdf', 'pdf'), '정상 계산서.pdf');
  assert.throws(
    () => targetPath('/tmp/evidence', 'ws_peak', '../invoice.pdf'),
    error => error.code === 'TAX_INVOICE_EVIDENCE_STORAGE_INVALID',
  );
});

test('보호 저장소는 0700/0600, checksum 검증, symlink/tamper 차단을 강제한다', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peakos-tax-evidence-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storage = createTaxInvoiceEvidenceStorage({ root });
  const stored = await storage.store('ws_peak', {
    buffer: pdfBytes(),
    mimetype: 'application/pdf',
    originalname: '../../tax-invoice.exe',
  });
  assert.match(stored.storedKey, /^[0-9a-f-]+\.pdf$/);
  assert.equal(stored.originalFilename, 'tax-invoice.pdf');
  assert.equal(fs.statSync(path.join(root, 'ws_peak')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(stored.absolutePath).mode & 0o777, 0o600);
  const record = {
    stored_key: stored.storedKey,
    mime_type: stored.mimeType,
    size_bytes: stored.sizeBytes,
    sha256: stored.sha256,
  };
  assert.deepEqual(await storage.read('ws_peak', record), pdfBytes());

  fs.writeFileSync(stored.absolutePath, pdfBytes('tampered\n'), { mode: 0o600 });
  await assert.rejects(
    storage.read('ws_peak', record),
    error => error.code === 'TAX_INVOICE_EVIDENCE_STORAGE_TAMPERED',
  );
});

test('저장 식별자 충돌은 기존 immutable 증빙 원본을 보존한다', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peakos-tax-evidence-collision-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'ws_peak');
  fs.mkdirSync(workspaceRoot, { mode: 0o700 });
  const ids = [
    '123e4567-e89b-42d3-a456-426614174000',
    '223e4567-e89b-42d3-a456-426614174000',
  ];
  const existingPath = path.join(workspaceRoot, `${ids[0]}.pdf`);
  const existing = pdfBytes('immutable-existing\n');
  fs.writeFileSync(existingPath, existing, { mode: 0o600, flag: 'wx' });
  let index = 0;
  const storage = createTaxInvoiceEvidenceStorage({ root, randomUUID: () => ids[index++] });
  await assert.rejects(
    storage.store('ws_peak', {
      buffer: pdfBytes(), mimetype: 'application/pdf', originalname: 'new.pdf',
    }),
    error => error.code === 'TAX_INVOICE_EVIDENCE_STORAGE_WRITE_FAILED',
  );
  assert.deepEqual(fs.readFileSync(existingPath), existing);
});
