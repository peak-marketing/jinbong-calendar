'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CREDIT_ACCOUNT_IDS,
  assertCreditApprovalInvariant,
  ensurePeakosCreditRequestInfrastructure,
  normalizeCreateInput,
  normalizeDepositorName,
  reconcileCreditRequests,
  registerPeakosCreditRequests,
} = require('./peakos-credit-requests');
const { AUTO_MATCH_MAX_AGE_DAYS } = require('./peakos-auto-match-policy');

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function makeRequest(overrides = {}) {
  return {
    uid: 'user-1',
    userDoc: { approved: true, is_active: true, name: '요청자' },
    query: {},
    params: {},
    headers: {},
    body: {},
    ...overrides,
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined,
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

function requestRow(overrides = {}) {
  return {
    id: 'f1a87d58-307e-4ec6-a90e-f2e96936079f',
    requester_uid: 'user-1',
    requester_name: '요청자',
    target_account_id: 'ibk-review-space',
    request_date: '2026-08-06',
    client: '테스트 거래처',
    depositor_name: '테스트입금자',
    product: '리뷰 상품',
    vendor: '리뷰스페이스',
    expected_amount: '110000',
    point_amount: '100000',
    memo: '자동 승인 대기',
    status: 'PENDING',
    bank_transaction_id: null,
    approved_at: null,
    cancelled_at: null,
    created_at: '2026-08-06T00:00:00.000Z',
    updated_at: '2026-08-06T00:00:00.000Z',
    ...overrides,
  };
}

function validBody(overrides = {}) {
  return {
    targetAccountId: 'ibk-review-space',
    requestDate: '2026-08-06',
    client: '테스트 거래처',
    depositorName: '테스트입금자',
    product: '리뷰 상품',
    vendor: '리뷰스페이스',
    expectedAmount: 110000,
    pointAmount: 100000,
    memo: '자동 승인 대기',
    ...overrides,
  };
}

function createRouteHarness({ pool, canReview = () => false } = {}) {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'delete']) {
    app[method] = (routePath, ...handlers) => {
      routes.set(`${method.toUpperCase()} ${routePath}`, handlers.at(-1));
    };
  }
  registerPeakosCreditRequests({
    app,
    authMiddleware: (_req, _res, next) => next(),
    pool,
    canReview,
    getActor: req => ({ uid: req.uid, name: req.userDoc?.name || '' }),
    logger: { error() {} },
  });
  return (method, routePath) => {
    const handler = routes.get(`${method.toUpperCase()} ${routePath}`);
    assert.equal(typeof handler, 'function', `${method} ${routePath} route`);
    return handler;
  };
}

test('대상 통장은 리뷰·리워드 두 계좌로만 고정된다', () => {
  assert.deepEqual(CREDIT_ACCOUNT_IDS, ['ibk-review-space', 'ibk-reward-space']);
  assert.equal(Object.isFrozen(CREDIT_ACCOUNT_IDS), true);
  assert.throws(
    () => normalizeCreateInput(validBody({ targetAccountId: 'ibk-hq-sales' })),
    /대상 통장/,
  );
});

test('요청 입력은 실제 날짜와 양의 안전 정수만 받고 임의 반올림을 하지 않는다', () => {
  const normalized = normalizeCreateInput(validBody({
    client: '  테스트   거래처 ',
    expectedAmount: '110000',
  }));
  assert.equal(normalized.client, '테스트 거래처');
  assert.equal(normalized.expectedAmount, 110000);
  assert.throws(() => normalizeCreateInput(validBody({ requestDate: '2026-02-30' })), /요청일/);
  assert.throws(() => normalizeCreateInput(validBody({ expectedAmount: 1.1 })), /정수/);
  assert.throws(() => normalizeCreateInput(validBody({ expectedAmount: '110,000' })), /정수/);
  assert.throws(() => normalizeCreateInput(validBody({ pointAmount: 0 })), /정수/);
});

test('DB 필드명과 같은 snake_case 요청도 동일하게 검증한다', () => {
  const input = normalizeCreateInput({
    target_account_id: 'ibk-reward-space',
    request_date: '2026-08-06',
    client: '테스트 거래처',
    depositor_name: '테스트입금자',
    product: '리워드 상품',
    vendor: '리워드스페이스',
    expected_amount: '110000',
    point_amount: '100000',
    memo: '',
  });
  assert.equal(input.targetAccountId, 'ibk-reward-space');
  assert.equal(input.depositorName, '테스트입금자');
  assert.equal(input.expectedAmount, 110000);
});

test('입금자 비교는 NFKC·대소문자·공백만 보정하며 부분·문장부호 일치는 허용하지 않는다', () => {
  assert.equal(normalizeDepositorName(' ＡＣＭＥ 홍 길동 '), 'acme홍길동');
  assert.equal(normalizeDepositorName('Acme홍길동'), 'acme홍길동');
  assert.notEqual(normalizeDepositorName('홍길동'), normalizeDepositorName('홍길동!'));
  assert.notEqual(normalizeDepositorName('홍길동'), normalizeDepositorName('홍길'));
});

test('인프라 함수는 은행 거래 FK·상태 제약·부분 유니크 키가 있는 후속 migration을 실행한다', async () => {
  const calls = [];
  await ensurePeakosCreditRequestInfrastructure({
    query: async sql => {
      calls.push(String(sql));
      return { rows: [] };
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /pg_advisory_xact_lock/);
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS peakos_credit_requests/);
  assert.match(calls[0], /REFERENCES peakos_bank_transactions\(id\)/);
  assert.match(calls[0], /status IN \('PENDING', 'APPROVED', 'CANCELLED'\)/);
  assert.match(calls[0], /target_account_id IN \('ibk-review-space', 'ibk-reward-space'\)/);
  assert.match(calls[0], /requester_idempotency_idx/);
  assert.match(calls[0], /peakos_validate_credit_request_bank_match/);
  assert.match(calls[0], /peakos_credit_requests_bank_match_guard_trg/);
  assert.match(calls[0], /peakos_protect_approved_credit_bank_transaction/);
  assert.match(calls[0], /peakos_bank_transactions_credit_match_guard_trg/);
  assert.match(calls[0], /bank_tx\.account_id IS DISTINCT FROM request\.target_account_id/);
  assert.match(calls[0], /matched_direction IS DISTINCT FROM 'DEPOSIT'/);
});

test('POST는 요청자나 ID를 클라이언트에서 받지 않고 승인된 계정의 서버 UUID로 PENDING을 만든다', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      const statement = normalizeSql(sql);
      calls.push({ sql: statement, params });
      assert.match(statement, /^INSERT INTO peakos_credit_requests/);
      return {
        rows: [requestRow({
          id: params[0],
          requester_uid: params[1],
          requester_name: params[2],
          target_account_id: params[3],
          request_date: params[4],
          client: params[5],
          depositor_name: params[6],
          product: params[7],
          vendor: params[8],
          expected_amount: params[9],
          point_amount: params[10],
          memo: params[11],
        })],
      };
    },
  };
  const route = createRouteHarness({ pool });
  const response = makeResponse();
  await route('POST', '/api/peakos/credit-requests')(
    makeRequest({
      body: { ...validBody(), id: 'attacker-id', requesterUid: 'attacker' },
    }),
    response,
  );

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.created, true);
  assert.match(response.body.request.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(response.body.request.id, 'attacker-id');
  assert.equal(response.body.request.requesterUid, 'user-1');
  assert.equal(response.body.request.status, 'PENDING');
  assert.equal(calls[0].params[1], 'user-1');
  assert.equal(calls[0].params[12], null);
});

test('POST는 미승인·비활성 계정을 DB 전에 차단한다', async () => {
  let queried = false;
  const route = createRouteHarness({
    pool: { query: async () => { queried = true; return { rows: [] }; } },
  });
  const response = makeResponse();
  await route('POST', '/api/peakos/credit-requests')(
    makeRequest({ userDoc: { approved: false, is_active: true, name: '대기자' }, body: validBody() }),
    response,
  );
  assert.equal(response.statusCode, 403);
  assert.equal(queried, false);
});

test('같은 사용자 Idempotency-Key 재시도는 같은 요청을 돌려주고 다른 payload면 충돌한다', async () => {
  const existing = requestRow();
  let existingRow = existing;
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      const statement = normalizeSql(sql);
      calls.push({ sql: statement, params });
      if (statement.startsWith('INSERT INTO peakos_credit_requests')) return { rows: [] };
      if (statement.startsWith('SELECT id, requester_uid')) return { rows: [existingRow] };
      throw new Error(`Unexpected SQL: ${statement}`);
    },
  };
  const route = createRouteHarness({ pool });
  const retry = makeResponse();
  await route('POST', '/api/peakos/credit-requests')(
    makeRequest({ headers: { 'idempotency-key': 'credit:retry-001' }, body: validBody() }),
    retry,
  );
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.created, false);
  assert.equal(retry.body.request.id, existing.id);
  assert.equal(calls.length, 2);

  existingRow = requestRow({ expected_amount: '220000' });
  const conflict = makeResponse();
  await route('POST', '/api/peakos/credit-requests')(
    makeRequest({ headers: { 'idempotency-key': 'credit:retry-001' }, body: validBody() }),
    conflict,
  );
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, 'CREDIT_REQUEST_IDEMPOTENCY_CONFLICT');
});

test('GET은 기본적으로 본인 요청만 읽고 검토 callback이 허용한 경우에만 전체를 읽는다', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params = []) => {
      calls.push({ sql: normalizeSql(sql), params });
      return { rows: [requestRow()] };
    },
  };
  const ordinaryRoute = createRouteHarness({ pool });
  const mine = makeResponse();
  await ordinaryRoute('GET', '/api/peakos/credit-requests')(makeRequest(), mine);
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.body.scope, 'mine');
  assert.deepEqual(calls[0].params, ['user-1']);

  const forbidden = makeResponse();
  await ordinaryRoute('GET', '/api/peakos/credit-requests')(
    makeRequest({ query: { scope: 'all' } }),
    forbidden,
  );
  assert.equal(forbidden.statusCode, 403);
  assert.equal(calls.length, 1);

  const reviewerRoute = createRouteHarness({ pool, canReview: () => true });
  const all = makeResponse();
  await reviewerRoute('GET', '/api/peakos/credit-requests')(
    makeRequest({ query: { scope: 'all' } }),
    all,
  );
  assert.equal(all.statusCode, 200);
  assert.equal(all.body.scope, 'all');
  assert.deepEqual(calls[1].params, []);
});

test('DELETE는 본인의 PENDING을 CANCELLED로 바꾸며 다른 사용자 요청은 검토자만 취소한다', async () => {
  const id = requestRow().id;
  let updateRows = [requestRow({
    status: 'CANCELLED',
    cancelled_at: '2026-08-06T01:00:00.000Z',
  })];
  let lookupRow = null;
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      const statement = normalizeSql(sql);
      calls.push({ sql: statement, params });
      if (statement.startsWith('UPDATE peakos_credit_requests')) return { rows: updateRows };
      if (statement.startsWith('SELECT requester_uid, status')) return { rows: lookupRow ? [lookupRow] : [] };
      throw new Error(`Unexpected SQL: ${statement}`);
    },
  };
  const ownRoute = createRouteHarness({ pool });
  const own = makeResponse();
  await ownRoute('DELETE', '/api/peakos/credit-requests/:id')(
    makeRequest({ params: { id } }),
    own,
  );
  assert.equal(own.statusCode, 200);
  assert.equal(own.body.request.status, 'CANCELLED');
  assert.deepEqual(calls[0].params, [id, 'user-1', false]);

  updateRows = [];
  lookupRow = { requester_uid: 'user-2', status: 'PENDING' };
  const other = makeResponse();
  await ownRoute('DELETE', '/api/peakos/credit-requests/:id')(
    makeRequest({ params: { id } }),
    other,
  );
  assert.equal(other.statusCode, 403);

  updateRows = [requestRow({
    requester_uid: 'user-2',
    status: 'CANCELLED',
    cancelled_at: '2026-08-06T01:00:00.000Z',
  })];
  const reviewerRoute = createRouteHarness({ pool, canReview: () => true });
  const reviewer = makeResponse();
  await reviewerRoute('DELETE', '/api/peakos/credit-requests/:id')(
    makeRequest({ params: { id } }),
    reviewer,
  );
  assert.equal(reviewer.statusCode, 200);
  assert.equal(calls.at(-1).params[2], true);
});

function bankTransaction(overrides = {}) {
  return {
    id: '501',
    account_id: 'ibk-review-space',
    transaction_at: new Date('2026-08-06T00:03:00.000Z'),
    direction: 'DEPOSIT',
    amount: '110000',
    counterparty_name: '테스트 입금자',
    reconciliation_status: 'UNMATCHED',
    ...overrides,
  };
}

function candidateRow(overrides = {}) {
  return {
    id: requestRow().id,
    requester_uid: 'user-1',
    requester_name: '요청자',
    target_account_id: 'ibk-review-space',
    request_date: '2026-08-06',
    client: '테스트 거래처',
    depositor_name: '테스트입금자',
    product: '리뷰 상품',
    vendor: '리뷰스페이스',
    expected_amount: '110000',
    point_amount: '100000',
    memo: '자동 승인 대기',
    created_at: new Date('2026-08-06T00:00:00.000Z'),
    ...overrides,
  };
}

function createReconciliationPool({
  transaction = bankTransaction(),
  candidates = [],
  linkedRequest = null,
  failLedger = false,
} = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = normalizeSql(sql);
      calls.push({ sql: statement, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) return { rows: [] };
      if (statement.startsWith('SELECT id FROM peakos_bank_transactions')) {
        return { rows: transaction ? [{ id: transaction.id }] : [] };
      }
      if (statement.startsWith('SELECT id, account_id, transaction_at')) {
        return { rows: transaction ? [transaction] : [] };
      }
      if (statement.startsWith('SELECT r.id, r.target_account_id')) {
        return { rows: linkedRequest ? [{
          ...linkedRequest,
          target_account_id: linkedRequest.target_account_id ?? transaction.account_id,
          expected_amount: linkedRequest.expected_amount ?? transaction.amount,
          point_amount: linkedRequest.point_amount ?? '100000',
          ledger_id: linkedRequest.ledger_id ?? linkedRequest.id,
          ledger_paid: linkedRequest.ledger_paid ?? linkedRequest.expected_amount ?? transaction.amount,
          ledger_point: linkedRequest.ledger_point ?? '100000',
        }] : [] };
      }
      if (statement.startsWith('SELECT id, requester_uid, requester_name, target_account_id')) {
        return { rows: candidates };
      }
      if (statement.startsWith('INSERT INTO peakos_credit ')) {
        if (failLedger) {
          const error = new Error('ledger conflict');
          error.code = '23505';
          throw error;
        }
        return { rows: [{ id: candidates[0]?.id }] };
      }
      if (statement.startsWith('UPDATE peakos_credit_requests')) return { rows: [{ id: candidates[0]?.id }] };
      if (statement.startsWith('UPDATE peakos_bank_transactions')) {
        if (statement.includes("reconciliation_status <> 'PROPOSED'")) return { rows: [{ id: transaction.id }] };
        if (statement.includes("reconciliation_status = 'PROPOSED'")) {
          return { rows: transaction.reconciliation_status === 'PROPOSED' ? [{ id: transaction.id }] : [] };
        }
        return { rows: [{ id: transaction.id }] };
      }
      if (statement.startsWith('INSERT INTO peakos_bank_audit_log')) return { rows: [] };
      throw new Error(`Unexpected SQL in mock: ${statement}`);
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };
  return { calls, pool: { connect: async () => client } };
}

test('정확한 통장·금액·입금자 후보 하나만 충전 원장과 승인 상태에 한 트랜잭션으로 반영한다', async () => {
  const mock = createReconciliationPool({
    transaction: bankTransaction({ counterparty_name: ' ＴＥＳＴ   입금자 ' }),
    candidates: [candidateRow({ depositor_name: 'test입금자' })],
  });
  const result = await reconcileCreditRequests({
    pool: mock.pool,
    accountId: 'ibk-review-space',
    requestId: 'bank-sync-501',
  });

  assert.deepEqual(result, {
    accountId: 'ibk-review-space',
    ineligibleAccount: false,
    scanned: 1,
    approved: 1,
    proposed: 0,
    unmatched: 0,
    alreadyApproved: 0,
    failed: 0,
  });
  const sql = mock.calls.map(call => call.sql);
  assert.match(sql.find(statement => statement.includes("status = 'PENDING'")), /expected_amount = \$2::bigint/);
  assert.ok(sql.some(statement => statement.includes('provider_key_stable = TRUE')));
  assert.ok(sql.some(statement => statement.includes("created_at >= $3::timestamptz - ($4::integer * INTERVAL '1 day')")));
  assert.ok(sql.some(statement => statement.includes("INTERVAL '1 hour'")));
  const candidateQuery = mock.calls.find(call => call.sql.startsWith('SELECT id, requester_uid'));
  assert.equal(candidateQuery.params[3], AUTO_MATCH_MAX_AGE_DAYS);
  assert.equal(sql.some(statement => /LIKE|similarity|levenshtein/i.test(statement)), false);
  const ledger = mock.calls.find(call => call.sql.startsWith('INSERT INTO peakos_credit '));
  assert.equal(ledger.params[7], '110000');
  assert.equal(ledger.params[8], '100000');
  assert.ok(sql.some(statement => statement.includes("status = 'APPROVED'")));
  const approval = mock.calls.find(call => call.sql.startsWith('UPDATE peakos_credit_requests'));
  assert.ok(approval.sql.includes('transaction_guard.account_id = peakos_credit_requests.target_account_id'));
  assert.ok(approval.sql.includes("transaction_guard.direction = 'DEPOSIT'"));
  assert.ok(approval.sql.includes('transaction_guard.amount = peakos_credit_requests.expected_amount'));
  assert.ok(sql.some(statement => statement.includes("reconciliation_status = 'MATCHED'")));
  assert.ok(sql.some(statement => statement.startsWith('INSERT INTO peakos_bank_audit_log')));
  assert.ok(sql.indexOf('BEGIN') < sql.indexOf('COMMIT'));
  assert.equal(sql.at(-1), 'RELEASE');
});

test('동일 금액·입금자의 대기 요청이 둘이면 거래를 PROPOSED로만 표시한다', async () => {
  const mock = createReconciliationPool({
    candidates: [
      candidateRow(),
      candidateRow({ id: 'c2c5019c-6048-483a-abf7-b47485d9e5cb', depositor_name: '테스트 입금자' }),
    ],
  });
  const result = await reconcileCreditRequests({ pool: mock.pool, accountId: 'ibk-review-space' });
  assert.equal(result.proposed, 1);
  assert.equal(result.approved, 0);
  const sql = mock.calls.map(call => call.sql);
  assert.ok(sql.some(statement => statement.includes("reconciliation_status = 'PROPOSED'")));
  assert.equal(sql.some(statement => statement.startsWith('INSERT INTO peakos_credit ')), false);
  assert.equal(sql.some(statement => statement.startsWith('UPDATE peakos_credit_requests')), false);
});

test('부분·문장부호·VAT 추정·합산은 자동 승인하지 않는다', async () => {
  const mock = createReconciliationPool({
    transaction: bankTransaction({ counterparty_name: '테스트입금자' }),
    candidates: [candidateRow({ depositor_name: '테스트입금자!' })],
  });
  const result = await reconcileCreditRequests({ pool: mock.pool, accountId: 'ibk-review-space' });
  assert.equal(result.unmatched, 1);
  assert.equal(result.approved, 0);
  const sql = mock.calls.map(call => call.sql);
  assert.equal(sql.some(statement => statement.startsWith('INSERT INTO peakos_credit ')), false);
  assert.equal(sql.some(statement => /1\.1|vat|sum\(/i.test(statement)), false);
});

test('과거 하한보다 오래된 충전 요청은 이름·금액이 같아도 자동 승인하지 않는다', async () => {
  const transaction = bankTransaction();
  const mock = createReconciliationPool({
    transaction,
    candidates: [candidateRow({
      created_at: new Date(
        transaction.transaction_at.getTime()
          - ((AUTO_MATCH_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000),
      ),
    })],
  });
  const result = await reconcileCreditRequests({ pool: mock.pool, accountId: 'ibk-review-space' });

  assert.equal(result.unmatched, 1);
  assert.equal(result.approved, 0);
  const sql = mock.calls.map(call => call.sql);
  assert.equal(sql.some(statement => statement.startsWith('INSERT INTO peakos_credit ')), false);
  assert.equal(sql.some(statement => statement.startsWith('UPDATE peakos_credit_requests')), false);
});

test('충전 승인 불변식은 통장·입금 방향·금액 중 하나라도 다르면 거부한다', () => {
  const transaction = bankTransaction();
  const candidate = candidateRow();
  assert.doesNotThrow(() => assertCreditApprovalInvariant(transaction, candidate));

  for (const [changedTransaction, changedCandidate] of [
    [{ ...transaction, direction: 'WITHDRAWAL' }, candidate],
    [transaction, { ...candidate, target_account_id: 'ibk-reward-space' }],
    [transaction, { ...candidate, expected_amount: '109999' }],
  ]) {
    assert.throws(
      () => assertCreditApprovalInvariant(changedTransaction, changedCandidate),
      error => error.code === 'CREDIT_REQUEST_BANK_TRANSACTION_MISMATCH',
    );
  }
});

test('DB 후보 조회가 변조된 요청을 반환해도 원장 쓰기 전에 차단한다', async () => {
  const mock = createReconciliationPool({
    candidates: [candidateRow({ target_account_id: 'ibk-reward-space' })],
  });
  const result = await reconcileCreditRequests({ pool: mock.pool, accountId: 'ibk-review-space' });

  assert.equal(result.failed, 1);
  assert.equal(result.approved, 0);
  assert.equal(mock.calls.some(call => call.sql.startsWith('INSERT INTO peakos_credit ')), false);
});

test('이미 이 거래로 승인된 요청이 있으면 원장을 다시 넣지 않고 MATCHED 상태만 복구한다', async () => {
  const mock = createReconciliationPool({ linkedRequest: { id: requestRow().id } });
  const result = await reconcileCreditRequests({ pool: mock.pool, accountId: 'ibk-review-space' });
  assert.equal(result.alreadyApproved, 1);
  assert.equal(result.approved, 0);
  const sql = mock.calls.map(call => call.sql);
  assert.equal(sql.some(statement => statement.startsWith('INSERT INTO peakos_credit ')), false);
  assert.ok(sql.some(statement => statement.includes("reconciliation_status = 'MATCHED'")));
});

test('기존 승인 요청이 연결 거래의 통장이나 금액과 다르면 MATCHED 복구를 거부한다', async () => {
  for (const linkedRequest of [
    { id: requestRow().id, target_account_id: 'ibk-reward-space' },
    { id: requestRow().id, expected_amount: '109999', ledger_paid: '109999' },
  ]) {
    const mock = createReconciliationPool({ linkedRequest });
    const result = await reconcileCreditRequests({ pool: mock.pool, accountId: 'ibk-review-space' });
    assert.equal(result.failed, 1);
    assert.equal(result.alreadyApproved, 0);
    assert.equal(
      mock.calls.some(call => call.sql.includes("SET reconciliation_status = 'MATCHED'")),
      false,
    );
  }
});

test('원장 반영 실패 시 승인·거래 변경을 커밋하지 않고 ROLLBACK한다', async () => {
  const mock = createReconciliationPool({ candidates: [candidateRow()], failLedger: true });
  const result = await reconcileCreditRequests({ pool: mock.pool, accountId: 'ibk-review-space' });
  assert.equal(result.failed, 1);
  assert.equal(result.approved, 0);
  const sql = mock.calls.map(call => call.sql);
  assert.ok(sql.includes('ROLLBACK'));
  assert.ok(sql.some(statement => statement.includes('CREDIT_REQUEST_AUTO_MATCH_FAILED')) === false);
  assert.ok(sql.some(statement => statement.startsWith('INSERT INTO peakos_bank_audit_log')));
  assert.equal(sql.at(-1), 'RELEASE');
});

test('리뷰·리워드 외 계좌는 DB를 조회하지 않고, 역전된 범위는 연결 전에 거부한다', async () => {
  let connected = false;
  const pool = { connect: async () => { connected = true; throw new Error('must not connect'); } };
  const skipped = await reconcileCreditRequests({ pool, accountId: 'ibk-hq-sales' });
  assert.equal(skipped.ineligibleAccount, true);
  assert.equal(skipped.scanned, 0);
  assert.equal(connected, false);

  await assert.rejects(
    reconcileCreditRequests({
      pool,
      accountId: 'ibk-reward-space',
      from: '2026-08-07T00:00:00Z',
      to: '2026-08-06T00:00:00Z',
    }),
    /from/,
  );
  assert.equal(connected, false);
});
