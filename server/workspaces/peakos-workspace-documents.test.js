'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createPeakosWorkspaceDocumentService,
  safeStoredPath,
} = require('./peakos-workspace-documents');

function captureResponse() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    vary() { return this; },
    json(payload) { this.payload = payload; return this; },
    send(payload) { this.payload = payload; return this; },
  };
}

test('workspace 문서 목록은 선택 workspace와 folder로만 조회한다', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return { rows: [{
        id: 'doc-1', category: 'clients', title: '거래처 자료', mime_type: 'application/pdf',
        size_bytes: 123, sha256: 'a'.repeat(64), total_count: 1,
      }] };
    },
  };
  const service = createPeakosWorkspaceDocumentService({ pool, root: '/var/lib/peakos/workspace-documents' });
  const req = {
    workspace: { id: 'ws_daegu' },
    query: { folder: 'clients', page: '1', limit: '25', q: '거래처' },
  };
  const res = captureResponse();
  await service.list(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.folder, 'clients');
  assert.equal(res.payload.documents.length, 1);
  assert.equal(res.payload.pagination.total, 1);
  assert.equal(Object.hasOwn(res.payload.documents[0], 'sha256'), false);
  assert.match(calls[0].sql, /workspace_id = \$1/);
  assert.deepEqual(calls[0].params.slice(0, 3), ['ws_daegu', 'clients', '거래처']);
});

test('workspace 문서 원본은 같은 workspace DB row와 private file hash가 모두 맞아야 한다', async t => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'peakos-workspace-docs-'));
  t.after(async () => fs.promises.rm(tempRoot, { recursive: true, force: true }));
  const workspaceId = 'ws_jeonju';
  const storedKey = 'document-1.pdf';
  const workspaceRoot = path.join(tempRoot, workspaceId);
  await fs.promises.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from('%PDF-1.4\nworkspace-only-test\n%%EOF\n');
  await fs.promises.writeFile(path.join(workspaceRoot, storedKey), bytes, { mode: 0o600 });
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const pool = {
    async query(_sql, params) {
      assert.deepEqual(params, [workspaceId, 'doc-1']);
      return { rows: [{
        id: 'doc-1', stored_key: storedKey, mime_type: 'application/pdf',
        size_bytes: bytes.length, sha256, title: '전주 자료',
      }] };
    },
  };
  const service = createPeakosWorkspaceDocumentService({ pool, root: tempRoot });
  const res = captureResponse();
  await service.content({ workspace: { id: workspaceId }, params: { id: 'doc-1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.deepEqual(res.payload, bytes);
});

test('workspace 문서 저장키는 workspace 디렉터리 밖으로 나갈 수 없다', () => {
  assert.throws(
    () => safeStoredPath('/var/lib/peakos/workspace-documents', 'ws_daegu', '../peak/secret.pdf'),
    error => error.code === 'WORKSPACE_DOCUMENT_STORAGE_INVALID',
  );
  assert.throws(
    () => safeStoredPath('/var/lib/peakos/workspace-documents', 'ws_daegu', '/etc/passwd'),
    error => error.code === 'WORKSPACE_DOCUMENT_STORAGE_INVALID',
  );
});

test('workspace 문서 root는 공개 저장소 밖 절대 경로만 허용한다', () => {
  assert.throws(
    () => createPeakosWorkspaceDocumentService({
      pool: { query: async () => ({ rows: [] }) },
      root: './uploads/workspace-documents',
    }),
    /절대 경로/,
  );
});
