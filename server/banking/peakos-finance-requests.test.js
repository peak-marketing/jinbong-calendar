'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FinanceRequestForbiddenError,
  FinanceRequestValidationError,
  decryptPayeeAccount,
  deriveEncryptionKey,
  encryptPayeeAccount,
  ensurePeakosFinanceRequestInfrastructure,
  maskPayeeAccount,
  normalizeCreateInput,
  registerPeakosFinanceRequests,
} = require('./peakos-finance-requests');

const SECRET = 'finance-test-secret-'.padEnd(64, 'x');
const ENCRYPTION_KEY = deriveEncryptionKey(SECRET);
const REQUEST_ID = 'b7c8019c-6048-483a-abf7-b47485d9e5ca';
const PAYEE_ACCOUNT = '123-456-789012';

function validBody(overrides = {}) {
  return {
    kind: 'REFUND_CLIENT',
    requestDate: '2026-08-08',
    clientName: '테스트 거래처',
    detail: '미집행 금액 환불',
    amountVat: 121000,
    businessRegistrationUrl: '',
    email: '',
    payeeBank: '테스트은행',
    payeeAccount: PAYEE_ACCOUNT,
    payeeName: '테스트예금주',
    reason: '서비스 미집행 환불',
    invoiceRequested: true,
    evidenceUrl: 'https://files.example.test/refund-proof',
    invoiceEvidenceUrl: '',
    sourceAccountId: 'ibk-hq-sales',
    ...overrides,
  };
}

function financeRow(overrides = {}) {
  const id = overrides.id || REQUEST_ID;
  const encrypted = encryptPayeeAccount(
    overrides.plainPayeeAccount === undefined ? PAYEE_ACCOUNT : overrides.plainPayeeAccount,
    ENCRYPTION_KEY,
    id,
  );
  return {
    id,
    requester_uid: 'user-1',
    requester_name: '요청자',
    kind: 'REFUND_CLIENT',
    request_date: '2026-08-08',
    client_name: '테스트 거래처',
    detail: '미집행 금액 환불',
    amount_vat: '121000',
    business_registration_url: '',
    email: '',
    payee_bank: '테스트은행',
    payee_account_ciphertext: encrypted.ciphertext,
    payee_account_iv: encrypted.iv,
    payee_account_auth_tag: encrypted.authTag,
    payee_account_encryption_version: encrypted.version,
    payee_name: '테스트예금주',
    reason: '서비스 미집행 환불',
    invoice_requested: true,
    invoice_status: 'REQUESTED',
    evidence_url: 'https://files.example.test/refund-proof',
    invoice_evidence_url: '',
    source_account_id: 'ibk-hq-sales',
    status: 'PENDING',
    processing_note: '',
    processed_by_uid: null,
    processed_by_name: null,
    processed_at: null,
    cancelled_at: null,
    platform_key: null,
    external_document_id: null,
    bank_transaction_id: null,
    idempotency_key: 'finance-request-0001',
    created_at: '2026-08-08T00:00:00.000Z',
    updated_at: '2026-08-08T00:00:00.000Z',
    ...overrides,
  };
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function makeRequest(overrides = {}) {
  return {
    uid: 'user-1',
    userDoc: { approved: true, is_active: true, name: '요청자', role: 'admin' },
    query: {},
    params: {},
    body: {},
    headers: {},
    ...overrides,
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function createRouteHarness({ pool, canReview = () => false } = {}) {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) {
    app[method] = (routePath, ...handlers) => {
      routes.set(`${method.toUpperCase()} ${routePath}`, handlers.at(-1));
    };
  }
  registerPeakosFinanceRequests({
    app,
    authMiddleware: (_req, _res, next) => next(),
    pool,
    canReview,
    getActor: req => ({ uid: req.uid, name: req.userDoc?.name || '' }),
    encryptionSecret: SECRET,
    logger: null,
  });
  return (method, routePath) => {
    const handler = routes.get(`${method.toUpperCase()} ${routePath}`);
    assert.equal(typeof handler, 'function', `${method} ${routePath} 라우트가 등록되어야 한다.`);
    return handler;
  };
}

function transactionalPool(queryHandler) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = normalizeSql(sql);
      calls.push({ sql: statement, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) return { rows: [] };
      return queryHandler(statement, params, calls);
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };
  return {
    calls,
    pool: {
      query: async (sql, params = []) => queryHandler(normalizeSql(sql), params, calls),
      connect: async () => client,
    },
  };
}

test('migration은 암호문 장부·멱등성·외부문서 유일성·상태 감사 이벤트를 만든다', async () => {
  const calls = [];
  await ensurePeakosFinanceRequestInfrastructure({
    query: async sql => {
      calls.push(String(sql));
      return { rows: [] };
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS peakos_finance_requests/);
  assert.match(calls[0], /\bid TEXT PRIMARY KEY\b/);
  assert.match(calls[0], /\brequest_id TEXT NOT NULL\b/);
  assert.match(calls[0], /payee_account_ciphertext BYTEA/);
  assert.match(calls[0], /AES|payee_account_auth_tag|encryption_version/i);
  assert.match(calls[0], /requester_idempotency_idx/);
  assert.match(calls[0], /external_document_idx/);
  assert.match(calls[0], /refund_terminal_invoice_check/);
  assert.match(calls[0], /peakos_finance_requests_requester_date_idx/);
  assert.match(calls[0], /peakos_finance_requests_date_idx/);
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS peakos_finance_request_events/);
  assert.doesNotMatch(calls[0], /payee_account\s+TEXT/i);
});

test('계좌번호는 AES-GCM 암호문으로 왕복하고 일반 출력용으로 끝자리만 마스킹한다', () => {
  const encrypted = encryptPayeeAccount(PAYEE_ACCOUNT, ENCRYPTION_KEY, REQUEST_ID);
  assert.equal(encrypted.iv.length, 12);
  assert.equal(encrypted.authTag.length, 16);
  assert.equal(encrypted.ciphertext.includes(Buffer.from(PAYEE_ACCOUNT)), false);
  assert.equal(decryptPayeeAccount({
    id: REQUEST_ID,
    payee_account_ciphertext: encrypted.ciphertext,
    payee_account_iv: encrypted.iv,
    payee_account_auth_tag: encrypted.authTag,
    payee_account_encryption_version: encrypted.version,
  }, ENCRYPTION_KEY), PAYEE_ACCOUNT);
  assert.equal(maskPayeeAccount(PAYEE_ACCOUNT), '***-***-**9012');
  assert.throws(() => decryptPayeeAccount({
    id: 'c7c8019c-6048-483a-abf7-b47485d9e5ca',
    payee_account_ciphertext: encrypted.ciphertext,
    payee_account_iv: encrypted.iv,
    payee_account_auth_tag: encrypted.authTag,
    payee_account_encryption_version: encrypted.version,
  }, ENCRYPTION_KEY));
  assert.throws(() => deriveEncryptionKey('too-short'), /32바이트/);
});

test('요청 종류별 필수값과 민감 출금 통장 권한을 검증한다', () => {
  const normalized = normalizeCreateInput(validBody());
  assert.equal(normalized.kind, 'REFUND_CLIENT');
  assert.equal(normalized.invoiceStatus, 'REQUESTED');

  const taxAdvance = normalizeCreateInput(validBody({
    kind: 'TAX_ADVANCE',
    businessRegistrationUrl: 'https://files.example.test/business-registration',
    email: 'tax@example.test',
    payeeBank: '', payeeAccount: '', payeeName: '',
  }));
  assert.equal(taxAdvance.invoiceRequested, true);
  assert.equal(taxAdvance.invoiceStatus, 'REQUESTED');

  const taxCorrection = normalizeCreateInput(validBody({
    kind: 'TAX_CORRECTION',
    businessRegistrationUrl: 'https://files.example.test/business-registration',
    email: 'tax@example.test',
    payeeBank: '', payeeAccount: '', payeeName: '',
  }));
  assert.equal(taxCorrection.invoiceRequested, true);
  assert.equal(taxCorrection.invoiceStatus, 'CORRECTION_REQUESTED');

  assert.throws(
    () => normalizeCreateInput(validBody({ payeeAccount: '' })),
    FinanceRequestValidationError,
  );
  assert.throws(
    () => normalizeCreateInput(validBody({ sourceAccountId: 'ibk-hq-fixed' })),
    FinanceRequestForbiddenError,
  );
  assert.equal(
    normalizeCreateInput(validBody({ sourceAccountId: 'ibk-hq-fixed' }), { allowRestrictedSource: true }).sourceAccountId,
    'ibk-hq-fixed',
  );
  assert.throws(() => normalizeCreateInput(validBody({
    kind: 'TAX_ADVANCE',
    businessRegistrationUrl: '',
    email: '',
    payeeBank: '', payeeAccount: '', payeeName: '', reason: '',
  })), /사업자등록증/);
  assert.throws(() => normalizeCreateInput(validBody({
    kind: 'TAX_CORRECTION',
    businessRegistrationUrl: '',
    email: 'tax@example.test',
    payeeBank: '', payeeAccount: '', payeeName: '',
  })), /사업자등록증/);
  assert.throws(() => normalizeCreateInput(validBody({
    kind: 'TAX_CORRECTION',
    businessRegistrationUrl: 'https://files.example.test/business-registration',
    email: '',
    payeeBank: '', payeeAccount: '', payeeName: '',
  })), /이메일/);
  assert.throws(() => normalizeCreateInput(validBody({ kind: 'EXPENSE_SUPPLIES', reason: '' })), /사유/);
  assert.throws(() => normalizeCreateInput(validBody({
    kind: 'EXPENSE_AD',
    invoiceRequested: false,
    payeeBank: '', payeeAccount: '', payeeName: '',
  })), /지급 은행|지급 계좌번호|예금주명/);
  assert.throws(() => normalizeCreateInput(validBody({ amountVat: '1.1' })), /정수/);
  assert.throws(() => normalizeCreateInput(validBody({ evidenceUrl: 'http://unsafe.example.test/a' })), /HTTPS/);
});

test('GET mine은 본인 행만 마스킹하고, 정확한 검토자의 scope=all만 원문을 복호화한다', async () => {
  const calls = [];
  const row = financeRow();
  const pool = {
    query: async (sql, params) => {
      const statement = normalizeSql(sql);
      calls.push({ sql: statement, params });
      if (statement.startsWith('SELECT COUNT(*)')) return { rows: [{ total: '1' }] };
      if (statement.startsWith('SELECT id, requester_uid')) return { rows: [row] };
      if (statement.startsWith('INSERT INTO peakos_finance_request_events')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${statement}`);
    },
    connect: async () => { throw new Error('GET은 connect하지 않아야 한다.'); },
  };

  const mineRoute = createRouteHarness({ pool });
  const mine = makeResponse();
  await mineRoute('GET', '/api/peakos/finance-requests')(makeRequest(), mine);
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.body.scope, 'mine');
  assert.equal(mine.body.requests[0].payeeAccount, '***-***-**9012');
  assert.equal(mine.body.requests[0].payee_account, '***-***-**9012');
  assert.equal(mine.body.requests[0].payeeAccountRevealed, false);
  assert.deepEqual(
    calls.find(call => call.sql.startsWith('SELECT id, requester_uid')).params,
    ['user-1', 500, 0],
  );
  assert.deepEqual(mine.body.pagination, {
    page: 1, limit: 500, total: 1, totalPages: 1, total_pages: 1,
  });

  const allRoute = createRouteHarness({ pool, canReview: req => req.uid === 'finance-uid' });
  const all = makeResponse();
  await allRoute('GET', '/api/peakos/finance-requests')(
    makeRequest({ uid: 'finance-uid', query: { scope: 'all' }, userDoc: { approved: true, is_active: true, name: '표시이름 변경됨' } }),
    all,
  );
  assert.equal(all.statusCode, 200);
  assert.equal(all.body.requests[0].payeeAccount, PAYEE_ACCOUNT);
  assert.equal(all.body.requests[0].payee_account, PAYEE_ACCOUNT);
  assert.equal(all.body.requests[0].payeeAccountRevealed, true);
  const allList = calls.filter(call => call.sql.startsWith('SELECT id, requester_uid')).at(-1);
  assert.deepEqual(allList.params, [500, 0]);
  const audit = calls.find(call => call.sql.includes('FINANCE_REQUEST_PAYEE_ACCOUNT_VIEWED'));
  assert.ok(audit, '계좌 원문 조회에는 감사 이벤트가 기록되어야 한다.');
  assert.match(audit.sql, /unnest\(\$1::text\[\]\)/);
  assert.deepEqual(audit.params.slice(0, 3), [[REQUEST_ID], 'finance-uid', '표시이름 변경됨']);
});

test('GET은 기간·복수 kind·계산서 여부·제외 상태를 서버에서 필터하고 전체 건수로 페이지를 계산한다', async () => {
  const calls = [];
  const row = financeRow();
  const pool = {
    query: async (sql, params) => {
      const statement = normalizeSql(sql);
      calls.push({ sql: statement, params });
      if (statement.startsWith('SELECT COUNT(*)')) return { rows: [{ total: '76' }] };
      if (statement.startsWith('SELECT id, requester_uid')) return { rows: [row] };
      if (statement.startsWith('INSERT INTO peakos_finance_request_events')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${statement}`);
    },
    connect: async () => { throw new Error('GET은 connect하지 않아야 한다.'); },
  };
  const route = createRouteHarness({ pool, canReview: () => true });
  const response = makeResponse();
  await route('GET', '/api/peakos/finance-requests')(
    makeRequest({
      uid: 'finance-uid',
      userDoc: { approved: true, is_active: true, name: '재무검토자' },
      query: {
        scope: 'all',
        kind: ['REFUND_CLIENT', 'REFUND_MISTAKEN,REFUND_CLIENT'],
        invoice_requested: 'true',
        exclude_status: 'REJECTED,CANCELLED',
        from: '2026-01-01',
        to: '2026-06-30',
        page: '2',
        limit: '25',
      },
    }),
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.pagination, {
    page: 2, limit: 25, total: 76, totalPages: 4, total_pages: 4,
  });
  assert.equal(response.body.truncated, true);
  assert.equal(response.body.filters.invoiceRequested, true);
  assert.equal(response.body.filters.invoice_requested, true);
  const list = calls.find(call => call.sql.startsWith('SELECT id, requester_uid'));
  const count = calls.find(call => call.sql.startsWith('SELECT COUNT(*)'));
  assert.match(list.sql, /kind = ANY\(\$1::text\[\]\)/);
  assert.match(list.sql, /NOT \(status = ANY\(\$2::text\[\]\)\)/);
  assert.match(list.sql, /invoice_requested = \$3/);
  assert.match(list.sql, /request_date >= \$4::date/);
  assert.match(list.sql, /request_date <= \$5::date/);
  assert.deepEqual(list.params, [
    ['REFUND_CLIENT', 'REFUND_MISTAKEN'],
    ['REJECTED', 'CANCELLED'],
    true,
    '2026-01-01',
    '2026-06-30',
    25,
    25,
  ]);
  assert.deepEqual(count.params, list.params.slice(0, -2));
});

test('GET은 잘못된 기간·페이지·필터 조합을 DB 조회 전에 거부한다', async () => {
  let queryCount = 0;
  const pool = {
    query: async () => { queryCount += 1; return { rows: [] }; },
    connect: async () => { throw new Error('GET은 connect하지 않아야 한다.'); },
  };
  const route = createRouteHarness({ pool });
  for (const query of [
    { from: '2026-08-09', to: '2026-08-08' },
    { from: '2026-02-30' },
    { page: '0' },
    { limit: '501' },
    { kind: 'REFUND_CLIENT,UNKNOWN' },
    { status: 'REJECTED', excludeStatus: 'REJECTED' },
  ]) {
    const response = makeResponse();
    await route('GET', '/api/peakos/finance-requests')(makeRequest({ query }), response);
    assert.equal(response.statusCode, 400);
  }
  assert.equal(queryCount, 0);
});

test('표시이름이 검토자와 같거나 admin이어도 capability가 없으면 scope=all을 쿼리 전에 거부한다', async () => {
  let queryCount = 0;
  const pool = {
    query: async () => { queryCount += 1; throw new Error('DB를 조회하면 안 된다.'); },
    connect: async () => { throw new Error('DB에 연결하면 안 된다.'); },
  };
  const route = createRouteHarness({ pool, canReview: () => false });
  const response = makeResponse();
  await route('GET', '/api/peakos/finance-requests')(
    makeRequest({ query: { scope: 'all' }, userDoc: { approved: true, is_active: true, role: 'admin', name: '패션TV봉이' } }),
    response,
  );
  assert.equal(response.statusCode, 403);
  assert.equal(queryCount, 0);
});

test('POST는 계좌 원문 없이 암호문과 안전한 감사 이벤트를 한 트랜잭션에 저장한다', async () => {
  const mock = transactionalPool((sql, params) => {
    if (sql.startsWith('INSERT INTO peakos_finance_requests')) {
      return { rows: [financeRow({
        id: params[0],
        requester_uid: params[1],
        requester_name: params[2],
        kind: params[3],
        request_date: params[4],
        client_name: params[5],
        detail: params[6],
        amount_vat: String(params[7]),
        business_registration_url: params[8],
        email: params[9],
        payee_bank: params[10],
        payee_account_ciphertext: params[11],
        payee_account_iv: params[12],
        payee_account_auth_tag: params[13],
        payee_account_encryption_version: params[14],
        payee_name: params[15],
        reason: params[16],
        invoice_requested: params[17],
        invoice_status: params[18],
        evidence_url: params[19],
        invoice_evidence_url: params[20],
        source_account_id: params[21],
        idempotency_key: params[22],
      })] };
    }
    if (sql.startsWith('INSERT INTO peakos_finance_request_events')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const route = createRouteHarness({ pool: mock.pool });
  const response = makeResponse();
  await route('POST', '/api/peakos/finance-requests')(
    makeRequest({ body: validBody({ idempotencyKey: 'finance-body-key-0001' }) }),
    response,
  );
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.created, true);
  assert.equal(response.body.request.payeeAccount, '***-***-**9012');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.match(response.headers.Location, /^\/api\/peakos\/finance-requests\//);
  const sql = mock.calls.map(call => call.sql);
  assert.ok(sql.indexOf('BEGIN') < sql.indexOf('COMMIT'));
  assert.ok(sql.some(statement => statement.startsWith('INSERT INTO peakos_finance_request_events')));
  assert.equal(sql.at(-1), 'RELEASE');
  assert.equal(JSON.stringify(mock.calls.map(call => call.params)).includes(PAYEE_ACCOUNT), false);
  const insert = mock.calls.find(call => call.sql.startsWith('INSERT INTO peakos_finance_requests'));
  assert.ok(Buffer.isBuffer(insert.params[11]));
  assert.equal(insert.params[11].includes(Buffer.from(PAYEE_ACCOUNT)), false);
  assert.equal(insert.params[22], 'finance-body-key-0001');
});

test('동일 Idempotency-Key 재시도는 같은 payload만 기존 요청으로 반환한다', async () => {
  const row = financeRow();
  const mock = transactionalPool((sql) => {
    if (sql.startsWith('INSERT INTO peakos_finance_requests')) return { rows: [] };
    if (sql.startsWith('SELECT id, requester_uid')) return { rows: [row] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const route = createRouteHarness({ pool: mock.pool });
  const response = makeResponse();
  await route('POST', '/api/peakos/finance-requests')(
    makeRequest({
      body: validBody({ idempotencyKey: 'body-key-must-not-win' }),
      headers: { 'idempotency-key': 'finance-request-0001' },
    }),
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.created, false);
  assert.equal(mock.calls.some(call => call.sql.startsWith('INSERT INTO peakos_finance_request_events')), false);
  const retryLookup = mock.calls.find(call => call.sql.startsWith('SELECT id, requester_uid'));
  assert.deepEqual(retryLookup.params, ['user-1', 'finance-request-0001']);

  const conflictMock = transactionalPool((sql) => {
    if (sql.startsWith('INSERT INTO peakos_finance_requests')) return { rows: [] };
    if (sql.startsWith('SELECT id, requester_uid')) return { rows: [financeRow({ amount_vat: '999999' })] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const conflictRoute = createRouteHarness({ pool: conflictMock.pool });
  const conflict = makeResponse();
  await conflictRoute('POST', '/api/peakos/finance-requests')(
    makeRequest({ body: validBody(), headers: { 'idempotency-key': 'finance-request-0001' } }),
    conflict,
  );
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, 'FINANCE_REQUEST_IDEMPOTENCY_CONFLICT');
});

test('일반 직원은 민감 출금 통장을 지정한 POST를 DB 연결 전에 거부당한다', async () => {
  let connectCount = 0;
  const pool = {
    query: async () => ({ rows: [] }),
    connect: async () => { connectCount += 1; throw new Error('연결하면 안 된다.'); },
  };
  const route = createRouteHarness({ pool });
  const response = makeResponse();
  await route('POST', '/api/peakos/finance-requests')(
    makeRequest({ body: validBody({ sourceAccountId: 'ibk-hq-fixed' }) }),
    response,
  );
  assert.equal(response.statusCode, 403);
  assert.equal(connectCount, 0);
});

test('PATCH는 정확한 검토자만 상태·계산서·민감 통장·외부문서를 처리하고 이벤트를 남긴다', async () => {
  let deniedConnects = 0;
  const deniedPool = {
    query: async () => ({ rows: [] }),
    connect: async () => { deniedConnects += 1; throw new Error('연결하면 안 된다.'); },
  };
  const deniedRoute = createRouteHarness({ pool: deniedPool, canReview: () => false });
  const denied = makeResponse();
  await deniedRoute('PATCH', '/api/peakos/finance-requests/:id')(
    makeRequest({ params: { id: REQUEST_ID }, body: { status: 'PROCESSING' }, userDoc: { approved: true, is_active: true, role: 'admin', name: '박종원' } }),
    denied,
  );
  assert.equal(denied.statusCode, 403);
  assert.equal(deniedConnects, 0);

  const current = financeRow();
  const mock = transactionalPool((sql, params) => {
    if (sql.startsWith('SELECT id, requester_uid')) return { rows: [current] };
    if (sql.startsWith('UPDATE peakos_finance_requests')) {
      return { rows: [{
        ...current,
        status: params[1],
        invoice_requested: params[2],
        invoice_status: params[3],
        processing_note: params[4],
        invoice_evidence_url: params[5],
        source_account_id: params[6],
        platform_key: params[7],
        external_document_id: params[8],
        bank_transaction_id: params[9],
        processed_by_uid: params[10],
        processed_by_name: params[11],
        processed_at: '2026-08-08T01:00:00.000Z',
      }] };
    }
    if (sql.startsWith('INSERT INTO peakos_finance_request_events')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const route = createRouteHarness({ pool: mock.pool, canReview: req => req.uid === 'finance-uid' });
  const response = makeResponse();
  await route('PATCH', '/api/peakos/finance-requests/:id')(
    makeRequest({
      uid: 'finance-uid',
      params: { id: REQUEST_ID },
      userDoc: { approved: true, is_active: true, role: 'member', name: '표시이름 변경됨' },
      body: {
        status: 'PROCESSING',
        invoiceStatus: 'ISSUED',
        processingNote: '지급 및 계산서 확인 중',
        invoiceEvidenceUrl: 'https://files.example.test/invoice',
        sourceAccountId: 'ibk-hq-fixed',
        platformKey: 'platform-one',
        externalDocumentId: 'invoice-2026-0001',
        processedByUid: 'attacker-controlled-value',
      },
    }),
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.request.status, 'PROCESSING');
  assert.equal(response.body.request.invoiceStatus, 'ISSUED');
  assert.equal(response.body.request.sourceAccountId, 'ibk-hq-fixed');
  assert.equal(response.body.request.processedByUid, 'finance-uid');
  assert.equal(response.body.request.payeeAccount, '***-***-**9012');
  const update = mock.calls.find(call => call.sql.startsWith('UPDATE peakos_finance_requests'));
  assert.equal(update.params[10], 'finance-uid');
  assert.equal(update.params.includes('attacker-controlled-value'), false);
  assert.ok(mock.calls.some(call => call.sql.startsWith('INSERT INTO peakos_finance_request_events')));
});

test('PATCH는 환불 반려 시 진행 중 계산서를 함께 취소하고 발행 완료 계산서는 보존한다', async () => {
  const pendingInvoice = financeRow({ invoice_requested: true, invoice_status: 'PROCESSING' });
  const cancelledMock = transactionalPool((sql, params) => {
    if (sql.startsWith('SELECT id, requester_uid')) return { rows: [pendingInvoice] };
    if (sql.startsWith('UPDATE peakos_finance_requests')) {
      return { rows: [{
        ...pendingInvoice,
        status: params[1],
        invoice_requested: params[2],
        invoice_status: params[3],
        processed_by_uid: params[10],
        processed_by_name: params[11],
      }] };
    }
    if (sql.startsWith('INSERT INTO peakos_finance_request_events')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const cancelledRoute = createRouteHarness({ pool: cancelledMock.pool, canReview: () => true });
  const cancelledResponse = makeResponse();
  await cancelledRoute('PATCH', '/api/peakos/finance-requests/:id')(
    makeRequest({ params: { id: REQUEST_ID }, body: { status: 'REJECTED', processingNote: '환불 불가' } }),
    cancelledResponse,
  );
  assert.equal(cancelledResponse.statusCode, 200);
  assert.equal(cancelledResponse.body.request.status, 'REJECTED');
  assert.equal(cancelledResponse.body.request.invoiceStatus, 'CANCELLED');
  const cancelledUpdate = cancelledMock.calls.find(call => call.sql.startsWith('UPDATE peakos_finance_requests'));
  assert.deepEqual(cancelledUpdate.params.slice(1, 4), ['REJECTED', true, 'CANCELLED']);
  const cancelledEvent = cancelledMock.calls.find(call => call.sql.startsWith('INSERT INTO peakos_finance_request_events'));
  assert.equal(cancelledEvent.params[6], 'PROCESSING');
  assert.equal(cancelledEvent.params[7], 'CANCELLED');
  assert.equal(JSON.parse(cancelledEvent.params[9]).invoiceAutoCancelled, true);

  const issuedInvoice = financeRow({ invoice_requested: true, invoice_status: 'ISSUED' });
  const preservedMock = transactionalPool((sql, params) => {
    if (sql.startsWith('SELECT id, requester_uid')) return { rows: [issuedInvoice] };
    if (sql.startsWith('UPDATE peakos_finance_requests')) {
      return { rows: [{
        ...issuedInvoice,
        status: params[1],
        invoice_requested: params[2],
        invoice_status: params[3],
      }] };
    }
    if (sql.startsWith('INSERT INTO peakos_finance_request_events')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const preservedRoute = createRouteHarness({ pool: preservedMock.pool, canReview: () => true });
  const preservedResponse = makeResponse();
  await preservedRoute('PATCH', '/api/peakos/finance-requests/:id')(
    makeRequest({ params: { id: REQUEST_ID }, body: { status: 'REJECTED' } }),
    preservedResponse,
  );
  assert.equal(preservedResponse.statusCode, 200);
  assert.equal(preservedResponse.body.request.invoiceStatus, 'ISSUED');
  const preservedUpdate = preservedMock.calls.find(call => call.sql.startsWith('UPDATE peakos_finance_requests'));
  assert.deepEqual(preservedUpdate.params.slice(1, 4), ['REJECTED', true, 'ISSUED']);

  const conflictMock = transactionalPool((sql) => {
    if (sql.startsWith('SELECT id, requester_uid')) return { rows: [issuedInvoice] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const conflictRoute = createRouteHarness({ pool: conflictMock.pool, canReview: () => true });
  const conflict = makeResponse();
  await conflictRoute('PATCH', '/api/peakos/finance-requests/:id')(
    makeRequest({
      params: { id: REQUEST_ID },
      body: { status: 'REJECTED', invoiceStatus: 'CORRECTION_REQUESTED' },
    }),
    conflict,
  );
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, 'FINANCE_REQUEST_TERMINAL_INVOICE_CONFLICT');
  assert.equal(conflictMock.calls.some(call => call.sql.startsWith('UPDATE peakos_finance_requests')), false);

  const activeConflictMock = transactionalPool((sql) => {
    if (sql.startsWith('SELECT id, requester_uid')) return { rows: [pendingInvoice] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const activeConflictRoute = createRouteHarness({ pool: activeConflictMock.pool, canReview: () => true });
  const activeConflict = makeResponse();
  await activeConflictRoute('PATCH', '/api/peakos/finance-requests/:id')(
    makeRequest({
      params: { id: REQUEST_ID },
      body: { status: 'REJECTED', invoiceStatus: 'PROCESSING' },
    }),
    activeConflict,
  );
  assert.equal(activeConflict.statusCode, 409);
  assert.equal(activeConflict.body.code, 'FINANCE_REQUEST_TERMINAL_INVOICE_CONFLICT');
});

test('DELETE는 본인의 PENDING만 CANCELLED로 바꾸고 상태 이벤트를 함께 저장한다', async () => {
  const current = financeRow();
  const mock = transactionalPool((sql, params) => {
    if (sql.startsWith('SELECT id, requester_uid')) return { rows: [current] };
    if (sql.startsWith('UPDATE peakos_finance_requests')) return { rows: [{
      ...current,
      status: 'CANCELLED',
      invoice_requested: params[1],
      invoice_status: params[2],
      cancelled_at: '2026-08-08T01:00:00.000Z',
    }] };
    if (sql.startsWith('INSERT INTO peakos_finance_request_events')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const route = createRouteHarness({ pool: mock.pool });
  const response = makeResponse();
  await route('DELETE', '/api/peakos/finance-requests/:id')(
    makeRequest({ params: { id: REQUEST_ID }, body: { reason: '요청 내용 변경' } }),
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.request.status, 'CANCELLED');
  assert.equal(response.body.request.invoiceStatus, 'CANCELLED');
  const update = mock.calls.find(call => call.sql.startsWith('UPDATE peakos_finance_requests'));
  assert.deepEqual(update.params, [REQUEST_ID, true, 'CANCELLED']);
  assert.ok(mock.calls.some(call => call.sql.startsWith('INSERT INTO peakos_finance_request_events')));

  const otherMock = transactionalPool((sql) => {
    if (sql.startsWith('SELECT id, requester_uid')) return { rows: [current] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const otherRoute = createRouteHarness({ pool: otherMock.pool });
  const other = makeResponse();
  await otherRoute('DELETE', '/api/peakos/finance-requests/:id')(
    makeRequest({ uid: 'other-user', params: { id: REQUEST_ID } }),
    other,
  );
  assert.equal(other.statusCode, 403);
  assert.equal(otherMock.calls.some(call => call.sql.startsWith('UPDATE peakos_finance_requests')), false);
});

test('승인되지 않았거나 비활성인 계정은 모든 금융요청 진입점에서 거부된다', async () => {
  let touched = false;
  const pool = {
    query: async () => { touched = true; return { rows: [] }; },
    connect: async () => { touched = true; throw new Error('연결 금지'); },
  };
  const route = createRouteHarness({ pool, canReview: () => true });
  for (const [method, routePath, request] of [
    ['GET', '/api/peakos/finance-requests', makeRequest({ userDoc: { approved: false, is_active: true } })],
    ['POST', '/api/peakos/finance-requests', makeRequest({ userDoc: { approved: false, is_active: true }, body: validBody() })],
    ['PATCH', '/api/peakos/finance-requests/:id', makeRequest({ userDoc: { approved: true, is_active: false }, params: { id: REQUEST_ID }, body: { status: 'PROCESSING' } })],
    ['DELETE', '/api/peakos/finance-requests/:id', makeRequest({ userDoc: { approved: true, is_active: false }, params: { id: REQUEST_ID } })],
  ]) {
    const response = makeResponse();
    await route(method, routePath)(request, response);
    assert.equal(response.statusCode, 403);
  }
  assert.equal(touched, false);
});
