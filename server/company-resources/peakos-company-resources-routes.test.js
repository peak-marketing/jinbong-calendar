'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createPeakosCompanyResourceService,
  publicAuditState,
  registerPeakosCompanyResourceRoutes,
  serializeCapabilities,
} = require('./peakos-company-resources-routes');

const ID = '123e4567-e89b-42d3-a456-426614174000';
const DOCUMENT_ID = '223e4567-e89b-42d3-a456-426614174000';

function response() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    vary() { return this; },
  };
}

function request(overrides = {}) {
  return {
    uid: 'finance-uid',
    userDoc: { approved: true, is_active: true, name: '재무 담당' },
    workspace: { id: 'ws_peak', role: 'member', permissions: { documents: 'read' } },
    headers: {}, query: {}, params: {}, body: {},
    get(name) { return this.headers[String(name).toLowerCase()]; },
    ...overrides,
  };
}

function fakePool(handler) {
  const calls = [];
  const client = {
    calls,
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      return handler(normalized, params, calls);
    },
    release() {},
  };
  return {
    calls,
    query: (...args) => client.query(...args),
    connect: async () => client,
  };
}

function service(pool, overrides = {}) {
  return createPeakosCompanyResourceService({
    pool,
    storage: {
      async store() {
        return {
          storedKey: '323e4567-e89b-42d3-a456-426614174000.png',
          originalFilename: '법인통장.png', mimeType: 'image/png', sizeBytes: 68,
          sha256: 'a'.repeat(64),
        };
      },
      async read() { return Buffer.from('verified'); },
      async remove() {},
    },
    canSeeFinanceOperations: req => req.uid === 'finance-uid',
    canReviewFinance: req => req.uid === 'finance-uid',
    getName: req => req.userDoc.name,
    clock: () => new Date('2026-08-17T12:00:00.000Z'),
    randomUUID: () => ID,
    logger: { error() {} },
    ...overrides,
  });
}

function membership() {
  return { role: 'member', permissions: { documents: 'write' } };
}

test('쓰기 capability는 서버 financeWrite와 workspace documents:write가 모두 있을 때만 공개한다', () => {
  assert.deepEqual(serializeCapabilities({ isAdmin: false, financeWrite: false }), { canWrite: false });
  assert.deepEqual(serializeCapabilities({ isAdmin: true, financeWrite: false, permissions: { documents: 'write' } }), { canWrite: false });
  assert.deepEqual(serializeCapabilities({ isAdmin: false, financeWrite: true, permissions: { documents: 'write' } }), { canWrite: true });
  assert.deepEqual(serializeCapabilities({ isAdmin: false, financeWrite: true, permissions: { documents: 'read' } }), { canWrite: false });
  assert.deepEqual(serializeCapabilities({ role: 'admin', financeRead: true }), { canWrite: false });
});

test('비품 사용 내역은 서버 직접 membership의 대상 UID를 확인한 뒤 workspace 원장에 저장한다', async () => {
  const pool = fakePool((sql, params) => {
    if (sql.startsWith('BEGIN') || sql === 'COMMIT') return { rows: [] };
    if (sql.includes('FROM peakos_workspace_memberships') && sql.includes('SELECT role')) return { rows: [membership()] };
    if (sql.includes('COALESCE(NULLIF(BTRIM(account.name)')) {
      assert.deepEqual(params, ['ws_peak', 'sales-uid']);
      return { rows: [{ user_uid: 'sales-uid', user_name: '영업자' }] };
    }
    if (sql.startsWith('INSERT INTO peakos_equipment_usage_entries')) return { rows: [{
      id: ID, used_on: '2026-08-17', item_name: '노트북', purpose: '현장 상담',
      quantity: 1, used_by_uid: 'sales-uid', used_by_name: '영업자', memo: '',
      status: 'ACTIVE', void_reason: '', row_version: 1, recorded_by_name: '재무 담당',
      created_at: new Date(), updated_at: new Date(),
    }] };
    throw new Error(`unexpected SQL ${sql}`);
  });
  const res = response();
  await service(pool).equipmentCreate(request({ body: {
    usedOn: '2026-08-17', itemName: '노트북', purpose: '현장 상담', quantity: 1,
    usedByUid: 'sales-uid', memo: '',
  } }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.entry.usedByUid, 'sales-uid');
  assert.ok(pool.calls.some(call => call.sql.startsWith('BEGIN ISOLATION LEVEL SERIALIZABLE')));
  assert.ok(pool.calls.every(call => !call.params.includes('다른-workspace')));
});

test('개발비는 같은 workspace의 활성 DEVELOPMENT_COST_EVIDENCE 없이는 404로 닫힌다', async () => {
  const pool = fakePool(sql => {
    if (sql.startsWith('BEGIN') || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('FROM peakos_workspace_memberships')) return { rows: [membership()] };
    if (sql.includes('FROM peakos_protected_company_documents')) return { rows: [] };
    throw new Error(`unexpected SQL ${sql}`);
  });
  const res = response();
  await service(pool).developmentCostCreate(request({ body: {
    spentOn: '2026-08-17', title: 'CRM 개발비', vendor: '개발사', amountKrw: 500000,
    memo: '', evidenceDocumentId: DOCUMENT_ID,
  } }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'COMPANY_RESOURCE_EVIDENCE_NOT_FOUND');
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(pool.calls.some(call => call.sql.startsWith('INSERT INTO peakos_development_cost_entries')), false);
});

test('통장사본/기타 회사자료는 random stored key만 DB에 기록하고 새 버전은 expectedVersion으로 직렬화한다', async () => {
  const pool = fakePool((sql, params) => {
    if (sql.startsWith('BEGIN') || sql === 'COMMIT') return { rows: [] };
    if (sql.includes('FROM peakos_workspace_memberships')) return { rows: [membership()] };
    if (sql.startsWith('SELECT id, logical_document_id')) return { rows: [{
      id: DOCUMENT_ID, logical_document_id: DOCUMENT_ID, revision: 1,
      category: 'BANK_COPY', status: 'ACTIVE', row_version: 3,
    }] };
    if (sql.startsWith('UPDATE peakos_protected_company_documents')) return { rows: [{ id: DOCUMENT_ID }] };
    if (sql.startsWith('INSERT INTO peakos_protected_company_documents')) {
      assert.equal(params[0], 'ws_peak');
      assert.equal(params[2], DOCUMENT_ID);
      assert.equal(params[3], 2);
      assert.equal(params[4], DOCUMENT_ID);
      assert.equal(params[8], '323e4567-e89b-42d3-a456-426614174000.png');
      assert.equal(params.some(value => String(value).includes('../')), false);
      return { rows: [{
        id: ID, logical_document_id: DOCUMENT_ID, revision: 2,
        supersedes_document_id: DOCUMENT_ID, category: 'BANK_COPY', title: '법인 통장',
        original_filename: '법인통장.png', mime_type: 'image/png', size_bytes: 68,
        sha256: 'a'.repeat(64), status: 'ACTIVE', archive_reason: '', row_version: 1,
        uploaded_by_name: '재무 담당', created_at: new Date(), updated_at: new Date(),
      }] };
    }
    throw new Error(`unexpected SQL ${sql}`);
  });
  const res = response();
  await service(pool).documentUpload(request({
    body: {
      category: 'BANK_COPY', title: '법인 통장',
      replacesDocumentId: DOCUMENT_ID, expectedVersion: '3',
    },
    file: { buffer: Buffer.from('not used by fake storage'), mimetype: 'image/png' },
  }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.document.revision, 2);
  assert.ok(pool.calls.some(call => call.sql.includes('FOR UPDATE')));
});

test('업로드 DB 실패 시 새 보호 파일을 제거하고 transaction을 rollback한다', async () => {
  const removed = [];
  const pool = fakePool(sql => {
    if (sql.startsWith('BEGIN') || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('FROM peakos_workspace_memberships')) return { rows: [membership()] };
    if (sql.startsWith('INSERT INTO peakos_protected_company_documents')) {
      const error = new Error('conflict');
      error.code = '23505';
      throw error;
    }
    throw new Error(`unexpected SQL ${sql}`);
  });
  const storage = {
    async store() {
      return {
        storedKey: '323e4567-e89b-42d3-a456-426614174000.png',
        originalFilename: '자료.png', mimeType: 'image/png', sizeBytes: 68, sha256: 'b'.repeat(64),
      };
    },
    async read() { return Buffer.alloc(0); },
    async remove(workspaceId, key) { removed.push([workspaceId, key]); },
  };
  const res = response();
  await service(pool, { storage }).documentUpload(request({
    body: { category: 'COMPANY_MATERIAL', title: '회사 자료' }, file: { buffer: Buffer.alloc(64) },
  }), res);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(removed, [['ws_peak', '323e4567-e89b-42d3-a456-426614174000.png']]);
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
});

test('다른 workspace의 문서 ID는 존재 여부를 숨기고 404를 반환한다', async () => {
  const pool = fakePool((sql, params) => {
    if (sql.includes('FROM peakos_workspace_memberships')) return { rows: [membership()] };
    if (sql.includes('FROM peakos_protected_company_documents')) {
      assert.deepEqual(params, ['ws_peak', DOCUMENT_ID]);
      return { rows: [] };
    }
    throw new Error(`unexpected SQL ${sql}`);
  });
  const res = response();
  await service(pool).documentContent(request({ params: { id: DOCUMENT_ID } }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'COMPANY_RESOURCE_DOCUMENT_NOT_FOUND');
});

test('등록 함수는 4개 영역과 audit/content 경로를 auth 뒤에 연결하고 업로드 전에 쓰기 권한을 확인한다', () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push(['GET', path, handlers]); },
    post(path, ...handlers) { routes.push(['POST', path, handlers]); },
  };
  const pool = fakePool(() => ({ rows: [] }));
  function auth(_req, _res, next) { next?.(); }
  function upload(_req, _res, next) { next?.(); }
  registerPeakosCompanyResourceRoutes({
    app, pool, authMiddleware: auth, uploadMiddleware: upload,
    storage: { store() {}, read() {}, remove() {} },
  });
  assert.equal(routes.length, 11);
  assert.ok(routes.some(([method, path, handlers]) => method === 'GET'
    && path.endsWith('/equipment-usage') && handlers[0] === auth));
  const documentUploadRoute = routes.find(([method, path]) => method === 'POST'
    && path.endsWith('/documents'));
  assert.ok(documentUploadRoute);
  assert.equal(documentUploadRoute[2][0], auth);
  assert.equal(documentUploadRoute[2][2], upload);
  assert.equal(typeof documentUploadRoute[2][1], 'function');
});

test('권한 없는 문서 업로드는 multipart body를 읽기 전에 거부한다', async () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push(['GET', path, handlers]); },
    post(path, ...handlers) { routes.push(['POST', path, handlers]); },
  };
  const pool = fakePool(sql => {
    if (sql.includes('FROM peakos_workspace_memberships')) {
      return { rows: [{ role: 'member', permissions: { documents: 'write' } }] };
    }
    throw new Error(`unexpected SQL ${sql}`);
  });
  let uploadCalled = false;
  function auth(_req, _res, next) { next(); }
  function upload(_req, _res, next) { uploadCalled = true; next(); }
  registerPeakosCompanyResourceRoutes({
    app, pool, authMiddleware: auth, uploadMiddleware: upload,
    canSeeFinanceOperations: () => false,
    canReviewFinance: () => false,
    storage: { store() {}, read() {}, remove() {} },
    logger: { error() {} },
  });
  const route = routes.find(([method, path]) => method === 'POST' && path.endsWith('/documents'));
  const req = request({ uid: 'ordinary-uid' });
  const res = response();
  await route[2][1](req, res, () => { uploadCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'COMPANY_RESOURCE_WRITE_FORBIDDEN');
  assert.equal(uploadCalled, false);
});

test('브라우저 audit 응답에는 private stored key와 checksum을 노출하지 않는다', () => {
  assert.deepEqual(publicAuditState({
    title: '통장사본', stored_key: 'private-random.pdf', sha256: 'a'.repeat(64), row_version: 1,
  }), { title: '통장사본', row_version: 1 });
});
