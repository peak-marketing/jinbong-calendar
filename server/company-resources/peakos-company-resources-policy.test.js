'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  loadCompanyResourceAccess,
  normalizeDevelopmentCostCreate,
  normalizeDocumentUpload,
  normalizeEquipmentCreate,
  requestIsPreview,
} = require('./peakos-company-resources-policy');

function request(overrides = {}) {
  return {
    uid: 'finance-uid',
    userDoc: { approved: true, is_active: true, name: '표시명은 권한이 아님' },
    workspace: { id: 'ws_peak', role: 'admin', permissions: { documents: 'write' } },
    headers: {},
    get(name) { return this.headers[String(name).toLowerCase()]; },
    ...overrides,
  };
}

function client(row) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return { rows: row ? [row] : [] };
    },
  };
}

test('권한은 req.workspace 역할/표시명이 아니라 DB 직접 멤버십과 서버 UID capability로 판정한다', async () => {
  const db = client({ role: 'member', permissions: { documents: 'write' } });
  await assert.rejects(
    loadCompanyResourceAccess({
      client: db,
      req: request({ userDoc: { approved: true, name: '패션TV봉이' } }),
      mode: 'write',
      canReviewFinance: () => false,
    }),
    error => error.code === 'COMPANY_RESOURCE_WRITE_FORBIDDEN',
  );
  assert.deepEqual(db.calls[0].params, ['ws_peak', 'finance-uid']);

  const allowed = await loadCompanyResourceAccess({
    client: client({ role: 'member', permissions: { documents: 'write' } }),
    req: request(), mode: 'write', canReviewFinance: req => req.uid === 'finance-uid',
  });
  assert.equal(allowed.workspaceId, 'ws_peak');
  assert.equal(allowed.financeWrite, true);
});

test('5번째 운영 열람자는 비품만 읽고 보호자료·개발비와 임의 admin은 열지 못한다', async () => {
  const direct = { role: 'member', permissions: { documents: 'read' } };
  const fifthViewer = request({ uid: 'operations-viewer-uid' });
  const equipment = await loadCompanyResourceAccess({
    client: client(direct), req: fifthViewer, mode: 'read', resource: 'EQUIPMENT_USAGE',
    canSeeFinanceOperations: req => req.uid === 'operations-viewer-uid',
    canReviewFinance: () => false,
  });
  assert.equal(equipment.financeRead, true);
  for (const resource of ['DEVELOPMENT_COST', 'PROTECTED_DOCUMENT']) {
    await assert.rejects(
      loadCompanyResourceAccess({
        client: client(direct), req: fifthViewer, mode: 'read', resource,
        canSeeFinanceOperations: () => true, canReviewFinance: () => false,
      }),
      error => error.code === 'COMPANY_RESOURCE_READ_FORBIDDEN',
    );
  }
  await assert.rejects(
    loadCompanyResourceAccess({
      client: client({ role: 'admin', permissions: { documents: 'write' } }),
      req: request({ uid: 'unlisted-admin' }), mode: 'read', resource: 'EQUIPMENT_USAGE',
      canSeeFinanceOperations: () => false, canReviewFinance: () => false,
    }),
    error => error.code === 'COMPANY_RESOURCE_READ_FORBIDDEN',
  );
});

test('preview/restricted/oversight/비활성·타 workspace 멤버십은 읽기도 fail closed다', async () => {
  const cases = [
    [request({ headers: { 'x-peakos-preview': '1' } }), 'COMPANY_RESOURCE_PREVIEW_FORBIDDEN'],
    [request({ headers: { 'x-peakos-preview-persona': 'admin' } }), 'COMPANY_RESOURCE_PREVIEW_FORBIDDEN'],
    [request({ userDoc: { approved: true, chat_only: true } }), 'COMPANY_RESOURCE_ACCOUNT_RESTRICTED'],
    [request({ userDoc: { approved: true, external_calendar_only: true } }), 'COMPANY_RESOURCE_ACCOUNT_RESTRICTED'],
  ];
  for (const [req, code] of cases) {
    await assert.rejects(
      loadCompanyResourceAccess({ client: client({ role: 'admin', permissions: { documents: 'write' } }), req }),
      error => error.code === code,
    );
  }
  await assert.rejects(
    loadCompanyResourceAccess({
      client: client({ role: 'oversight', permissions: { documents: 'write' } }),
      req: request(), canSeeFinanceOperations: () => true,
    }),
    error => error.code === 'COMPANY_RESOURCE_DIRECT_MEMBERSHIP_REQUIRED',
  );
  await assert.rejects(
    loadCompanyResourceAccess({
      client: client(null), req: request(), canSeeFinanceOperations: () => true,
    }),
    error => error.code === 'COMPANY_RESOURCE_DIRECT_MEMBERSHIP_REQUIRED',
  );
  assert.equal(requestIsPreview(request({ headers: { 'x-peakos-preview-owner': 'uid' } })), true);
});

test('원장/문서 입력은 exact 필드·날짜·정수·버전 체인을 검증한다', () => {
  assert.deepEqual(normalizeEquipmentCreate({
    usedOn: '2026-08-17', itemName: '노트북', purpose: '현장 상담', quantity: 1,
    usedByUid: 'sales-uid', memo: '',
  }), {
    usedOn: '2026-08-17', itemName: '노트북', purpose: '현장 상담', quantity: 1,
    usedByUid: 'sales-uid', memo: '',
  });
  assert.throws(() => normalizeEquipmentCreate({
    usedOn: '2026-02-30', itemName: '노트북', purpose: '상담', quantity: 1,
  }), error => error.code === 'COMPANY_RESOURCE_DATE_INVALID');
  assert.throws(() => normalizeEquipmentCreate({
    usedOn: '2026-08-17', itemName: '노트북', purpose: '상담', quantity: 1.5,
  }), /정수/);
  assert.equal(normalizeDevelopmentCostCreate({
    spentOn: '2026-08-17', title: 'CRM 개발', vendor: '개발사', amountKrw: 100000,
    memo: '', evidenceDocumentId: '123e4567-e89b-42d3-a456-426614174000',
  }).amountKrw, 100000);
  assert.throws(() => normalizeDevelopmentCostCreate({
    spentOn: '2026-08-17', title: 'CRM 개발', vendor: '개발사', amountKrw: 100,
    memo: '', evidenceDocumentId: 'bad', extra: true,
  }), /허용되지/);
  assert.equal(normalizeDocumentUpload({
    category: 'bank_copy', title: '법인 통장',
    replacesDocumentId: '123e4567-e89b-42d3-a456-426614174000', expectedVersion: '2',
  }).expectedVersion, 2);
  assert.throws(() => normalizeDocumentUpload({
    category: 'BANK_COPY', title: '법인 통장', expectedVersion: 2,
  }), /교체할 자료/);
});
