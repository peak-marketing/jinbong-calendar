'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const {
  registerPeakosTaxInvoiceEvidenceRoutes,
} = require('./peakos-tax-invoice-evidence-routes');

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const EVIDENCE_ID = '22222222-2222-4222-8222-222222222222';

function pdfBytes() {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nstartxref\n0\n%%EOF\n', 'latin1');
}

class FakePool {
  constructor() {
    this.request = {
      id: REQUEST_ID,
      workspace_id: 'ws_peak',
      requester_uid: 'sales-one',
      requester_name: '요청자',
      kind: 'TAX_ADVANCE',
      invoice_requested: true,
      invoice_status: 'REQUESTED',
      current_invoice_evidence_id: null,
      version: 1,
    };
    this.evidence = [];
    this.events = [];
  }

  async query(source, values = []) {
    const sql = String(source).replace(/\s+/g, ' ').trim();
    if (/^(?:BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };

    if (sql.includes('JOIN peakos_tax_invoice_evidence evidence')) {
      const [workspaceId, requestId, evidenceId] = values;
      const row = this.evidence.find(item => item.workspace_id === workspaceId
        && item.finance_request_id === requestId && item.id === evidenceId);
      if (!row || this.request.workspace_id !== workspaceId || this.request.id !== requestId) return { rows: [] };
      return { rows: [{ ...this.request, ...row }] };
    }
    if (sql.startsWith('SELECT id, workspace_id, requester_uid')) {
      const [workspaceId, requestId] = values;
      return { rows: this.request.workspace_id === workspaceId && this.request.id === requestId
        ? [{ ...this.request }] : [] };
    }
    if (sql.startsWith('SELECT id, workspace_id, finance_request_id')) {
      const [workspaceId, requestId, evidenceId] = values;
      const rows = this.evidence.filter(item => item.workspace_id === workspaceId
        && item.finance_request_id === requestId
        && (evidenceId === undefined || item.id === evidenceId));
      return { rows: rows.map(row => ({ ...row })) };
    }
    if (sql.startsWith('INSERT INTO peakos_tax_invoice_evidence')) {
      const row = {
        id: values[0], workspace_id: values[1], finance_request_id: values[2],
        revision: values[3], action_kind: values[4], target_invoice_status: values[5],
        invoice_number: values[6], issued_at: values[7],
        supplier_registration_number: values[8], document_identifier: values[9],
        correction_reason: values[10], stored_key: values[11],
        original_filename: values[12], mime_type: values[13], size_bytes: values[14],
        sha256: values[15], supersedes_evidence_id: values[16],
        registered_by_uid: values[17], registered_by_name: values[18], created_at: values[19],
      };
      this.evidence.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE peakos_finance_requests')) {
      const [workspaceId, requestId, invoiceStatus, evidenceId, uid, name, , expectedVersion] = values;
      if (this.request.workspace_id !== workspaceId || this.request.id !== requestId
          || this.request.version !== expectedVersion) return { rows: [], rowCount: 0 };
      this.request = {
        ...this.request,
        invoice_requested: true,
        invoice_status: invoiceStatus,
        current_invoice_evidence_id: evidenceId,
        processed_by_uid: uid,
        processed_by_name: name,
        version: this.request.version + 1,
      };
      return { rows: [{
        version: this.request.version,
        invoice_status: this.request.invoice_status,
        current_invoice_evidence_id: this.request.current_invoice_evidence_id,
      }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO peakos_finance_request_events')) {
      this.events.push(values);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  }

  async connect() {
    return { query: this.query.bind(this), release() {} };
  }
}

function auth(req, _res, next) {
  req.uid = String(req.get('x-user') || 'sales-one');
  req.userDoc = {
    approved: req.get('x-approved') !== 'false',
    is_active: req.get('x-active') !== 'false',
    chat_only: req.get('x-chat-only') === 'true',
  };
  const oversight = req.get('x-oversight') === 'true';
  req.workspace = {
    id: String(req.get('x-workspace') || 'ws_peak'),
    role: oversight ? 'oversight' : 'manager',
    headquartersOversight: oversight,
    permissions: { settlements: String(req.get('x-settlements') || 'write') },
  };
  next();
}

async function startFixture(t) {
  const pool = new FakePool();
  const stored = [];
  const storage = {
    async store(_workspaceId, file) {
      const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
      const record = {
        storedKey: '33333333-3333-4333-8333-333333333333.pdf',
        originalFilename: 'invoice.pdf', mimeType: 'application/pdf',
        sizeBytes: file.buffer.length, sha256,
      };
      stored.push(record);
      return record;
    },
    async read() { return pdfBytes(); },
    async remove() {},
  };
  const app = express();
  registerPeakosTaxInvoiceEvidenceRoutes({
    app,
    authMiddleware: auth,
    pool,
    canReviewFinance: req => req.get('x-review') === 'true',
    getName: req => (req.get('x-review') === 'true' ? '재무검토자' : '요청자'),
    storage,
    clock: () => new Date('2026-08-17T03:00:00.000Z'),
    randomUUID: () => EVIDENCE_ID,
    logger: { error() {} },
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  return {
    pool, stored,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

function evidenceForm(overrides = {}, { includeFile = true } = {}) {
  const form = new FormData();
  const fields = {
    expectedVersion: '1',
    invoiceStatus: 'ISSUED',
    invoiceNumber: '20260817-12345678',
    issuedAt: '2026-08-17T02:03:04.000Z',
    supplierRegistrationNumber: '220-81-62517',
    documentIdentifier: 'HOMETAX-20260817-01',
    correctionReason: '',
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (includeFile) form.append('document', new Blob([pdfBytes()], { type: 'application/pdf' }), 'invoice.pdf');
  return form;
}

async function responseJson(response) {
  const body = await response.json();
  return { status: response.status, body };
}

test('reviewer만 보호 원본과 metadata로 발급 증빙을 등록하고 version을 증가시킨다', async t => {
  const fixture = await startFixture(t);
  const response = await fetch(`${fixture.origin}/api/peakos/finance-requests/${REQUEST_ID}/invoice-evidence`, {
    method: 'POST', headers: { 'x-user': 'reviewer', 'x-review': 'true' }, body: evidenceForm(),
  });
  const result = await responseJson(response);
  assert.equal(result.status, 201);
  assert.equal(result.body.registrationOnly, true);
  assert.equal(result.body.externalIssuancePerformed, false);
  assert.equal(result.body.request.invoiceStatus, 'ISSUED');
  assert.equal(result.body.request.version, 2);
  assert.equal(result.body.evidence.invoiceNumber, '20260817-12345678');
  assert.equal(fixture.pool.events.length, 1);
  assert.equal(fixture.stored.length, 1);
});

test('요청자는 masked metadata만 보고 보호 원본은 내려받지 못한다', async t => {
  const fixture = await startFixture(t);
  const registered = await fetch(`${fixture.origin}/api/peakos/finance-requests/${REQUEST_ID}/invoice-evidence`, {
    method: 'POST', headers: { 'x-user': 'reviewer', 'x-review': 'true' }, body: evidenceForm(),
  });
  assert.equal(registered.status, 201);

  const list = await responseJson(await fetch(
    `${fixture.origin}/api/peakos/finance-requests/${REQUEST_ID}/invoice-evidence`,
    { headers: { 'x-user': 'sales-one' } },
  ));
  assert.equal(list.status, 200);
  assert.equal(list.body.masked, true);
  assert.match(list.body.evidence[0].invoiceNumber, /^\*+/);
  assert.equal(list.body.evidence[0].protectedOriginalAvailable, false);
  assert.equal(list.body.evidence[0].contentPath, undefined);

  const content = await responseJson(await fetch(
    `${fixture.origin}/api/peakos/finance-requests/${REQUEST_ID}/invoice-evidence/${EVIDENCE_ID}/content`,
    { headers: { 'x-user': 'sales-one' } },
  ));
  assert.equal(content.status, 403);
  assert.equal(content.body.code, 'TAX_INVOICE_EVIDENCE_ORIGINAL_FORBIDDEN');
});

test('reviewer original read는 attachment/nosniff/no-store를 강제한다', async t => {
  const fixture = await startFixture(t);
  await fetch(`${fixture.origin}/api/peakos/finance-requests/${REQUEST_ID}/invoice-evidence`, {
    method: 'POST', headers: { 'x-user': 'reviewer', 'x-review': 'true' }, body: evidenceForm(),
  });
  const response = await fetch(
    `${fixture.origin}/api/peakos/finance-requests/${REQUEST_ID}/invoice-evidence/${EVIDENCE_ID}/content`,
    { headers: { 'x-user': 'reviewer', 'x-review': 'true' } },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdfBytes());
});

test('preview/oversight/non-reviewer/restricted account mutation은 multipart 저장 전에 차단한다', async t => {
  const fixture = await startFixture(t);
  const cases = [
    { 'x-user': 'reviewer', 'x-review': 'true', 'x-peakos-preview': 'true' },
    { 'x-user': 'reviewer', 'x-review': 'true', 'x-oversight': 'true' },
    { 'x-user': 'sales-one' },
    { 'x-user': 'reviewer', 'x-review': 'true', 'x-chat-only': 'true' },
  ];
  for (const headers of cases) {
    const response = await fetch(`${fixture.origin}/api/peakos/finance-requests/${REQUEST_ID}/invoice-evidence`, {
      method: 'POST', headers, body: evidenceForm(),
    });
    assert.equal(response.status, 403);
  }
  assert.equal(fixture.stored.length, 0);
});

test('stale expectedVersion, URL-only/no-file, cross-workspace access가 fail-closed 된다', async t => {
  const fixture = await startFixture(t);
  const stale = await responseJson(await fetch(
    `${fixture.origin}/api/peakos/finance-requests/${REQUEST_ID}/invoice-evidence`,
    {
      method: 'POST', headers: { 'x-user': 'reviewer', 'x-review': 'true' },
      body: evidenceForm({ expectedVersion: '2' }),
    },
  ));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'TAX_INVOICE_EVIDENCE_VERSION_CONFLICT');

  const urlOnly = await responseJson(await fetch(
    `${fixture.origin}/api/peakos/finance-requests/${REQUEST_ID}/invoice-evidence`,
    {
      method: 'POST', headers: { 'x-user': 'reviewer', 'x-review': 'true' },
      body: evidenceForm({ invoiceEvidenceUrl: 'https://example.test/invoice.pdf' }, { includeFile: false }),
    },
  ));
  assert.equal(urlOnly.status, 400);
  assert.ok(['TAX_INVOICE_EVIDENCE_FILE_REQUIRED', 'TAX_INVOICE_EVIDENCE_FIELDS_NOT_ALLOWED'].includes(urlOnly.body.code));

  const crossWorkspace = await responseJson(await fetch(
    `${fixture.origin}/api/peakos/finance-requests/${REQUEST_ID}/invoice-evidence`,
    { headers: { 'x-user': 'reviewer', 'x-review': 'true', 'x-workspace': 'ws_branch' } },
  ));
  assert.equal(crossWorkspace.status, 404);
});

