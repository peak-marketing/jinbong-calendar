'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BankSyncError,
  normalizeBankTransaction,
  publicAccount,
  publicTransaction,
  registerPeakosBanking,
  safeErrorMessage,
  saveTransactions,
} = require('./peakos-banking');

const goodRow = {
  providerTransactionKey: 'provider-row-1',
  providerKeyStable: true,
  transactionAt: '2026-08-06T09:03:00+09:00',
  direction: 'DEPOSIT',
  amount: '1,100,000원',
  balance: 125034000,
  summary: '입금',
  counterpartyName: '테스트거래처',
  counterpartyAccount: '12345678901234',
};

test('거래를 정규화하고 상대 계좌를 마스킹한다', () => {
  const row = normalizeBankTransaction('hq-sales', goodRow, 'BANK_SYNC');
  assert.equal(row.amount, 1100000);
  assert.equal(row.transactionAt.toISOString(), '2026-08-06T00:03:00.000Z');
  assert.match(row.counterpartyAccountMasked, /^12-\*+-1234$/);
  assert.match(row.providerTransactionKey, /^[a-f0-9]{64}$/);
  assert.equal(row.counterpartyAccountMasked.includes('12345678901234'), false);
});

test('거래키는 같은 원본 ID여도 통장별로 다르다', () => {
  const left = normalizeBankTransaction('hq-sales', goodRow, 'BANK_SYNC');
  const right = normalizeBankTransaction('hq-operating', goodRow, 'BANK_SYNC');
  assert.notEqual(left.providerTransactionKey, right.providerTransactionKey);
});

test('시간대 없는 일시와 애매한 금액을 거부한다', () => {
  assert.throws(
    () => normalizeBankTransaction('hq-sales', { ...goodRow, transactionAt: '2026-08-06 09:03:00' }, 'BANK_SYNC'),
    /시간대/,
  );
  assert.throws(
    () => normalizeBankTransaction('hq-sales', { ...goodRow, amount: '1,100.50' }, 'BANK_SYNC'),
    /형식/,
  );
  assert.throws(
    () => normalizeBankTransaction('hq-sales', { ...goodRow, amount: '1e6' }, 'BANK_SYNC'),
    /형식/,
  );
});

test('공개 API 객체에 원본 계좌·payload·provider key를 넣지 않는다', () => {
  const account = publicAccount({
    id: 'hq-sales', provider: 'IBK', bank_name: '기업은행', display_name: '매출통장',
    branch_id: 'hq', account_number_masked: '12-********-7890', currency: 'KRW', is_active: true,
    latest_balance: 5000000, latest_balance_at: '2026-08-06T00:00:00.000Z',
    full_account_number: '12345678901234', raw_payload: 'secret',
  });
  const transaction = publicTransaction({
    id: 1, account_id: 'hq-sales', transaction_at: new Date(), direction: 'DEPOSIT', amount: 1,
    balance: 5000000,
    reconciliation_status: 'UNMATCHED', source: 'BANK_SYNC', provider_transaction_key: 'secret-key',
    raw_payload: 'secret', counterparty_account: '12345678901234',
  });
  assert.equal('fullAccountNumber' in account, false);
  assert.equal('rawPayload' in account, false);
  assert.equal('providerTransactionKey' in transaction, false);
  assert.equal('rawPayload' in transaction, false);
  assert.equal('counterpartyAccount' in transaction, false);
  assert.equal(account.latestBalance, null);
  assert.equal(account.latestBalanceAt, null);
  assert.equal(transaction.balance, null);
  assert.equal(publicAccount({ latest_balance: 5000000 }, { includeBalance: true }).latestBalance, 5000000);
  assert.equal(publicTransaction({ id: 1, balance: 5000000 }, { includeBalance: true }).balance, 5000000);
});

test('오류 문구의 계좌·토큰을 마스킹한다', () => {
  const message = safeErrorMessage(new Error(
    'account=123-456-789012 token=abcdefghijklmnop Bearer abcdefghijklmnopqrstuvwxyz',
  ));
  assert.equal(message.includes('123-456-789012'), false);
  assert.equal(message.includes('abcdefghijklmnop'), false);
  assert.equal(message.includes('abcdefghijklmnopqrstuvwxyz'), false);
});

test('한 요청 안의 중복 거래를 DB 쓰기 전에 거부한다', async () => {
  let queryCount = 0;
  const client = { query: async () => { queryCount += 1; return { rows: [] }; } };
  await assert.rejects(
    saveTransactions(client, 'hq-sales', [goodRow, { ...goodRow }], 'BANK_SYNC'),
    /중복된 거래/,
  );
  assert.equal(queryCount, 0);
});

test('같은 제공기관 키의 핵심 거래값이 달라지면 충돌로 중단한다', async () => {
  const client = {
    query: async sql => {
      assert.match(sql, /ON CONFLICT \(account_id, provider_transaction_key\)/);
      return { rows: [] };
    },
  };
  await assert.rejects(
    saveTransactions(client, 'hq-sales', [goodRow], 'BANK_SYNC'),
    error => error?.code === 'BANK_TRANSACTION_KEY_COLLISION',
  );
});

test('동일 시각에 서로 다른 거래 후 잔액이 있으면 계좌 최신 잔액을 null로 보수 처리한다', async () => {
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (/INSERT INTO peakos_bank_transactions/.test(sql)) return { rows: [{ inserted: true }] };
      if (/COUNT\(DISTINCT balance\)/.test(sql)) {
        return { rows: [{ distinct_balance_count: 2 }] };
      }
      if (/UPDATE peakos_bank_accounts/.test(sql)) return { rows: [] };
      throw new Error('unexpected query');
    },
  };
  await saveTransactions(client, 'hq-sales', [goodRow], 'BANK_SYNC');
  const update = calls.find(call => /UPDATE peakos_bank_accounts/.test(call.sql));
  assert.match(update.sql, /SET latest_balance = NULL/);
  assert.deepEqual(update.values, ['hq-sales', new Date(goodRow.transactionAt)]);
});

function createRouteHarness(options = {}) {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'put', 'post']) {
    app[method] = (routePath, ...handlers) => {
      routes.set(`${method.toUpperCase()} ${routePath}`, handlers.at(-1));
    };
  }
  const services = registerPeakosBanking({
    app,
    authMiddleware: (_req, _res, next) => next(),
    pool: options.pool,
    canRead: options.canRead || (() => true),
    canReadTaxPurchase: options.canReadTaxPurchase || (() => false),
    canViewBalances: options.canViewBalances || (() => false),
    canSync: options.canSync || (() => false),
    canManage: options.canManage || (() => false),
    getActor: req => ({ uid: req.uid, name: req.userDoc?.name || '' }),
    collector: options.collector || null,
    afterSync: options.afterSync || null,
    allowImport: options.allowImport === true,
    autoReconciliationEnabled: options.autoReconciliationEnabled === true,
  });
  const route = (method, routePath) => {
    const handler = routes.get(`${method.toUpperCase()} ${routePath}`);
    assert.equal(typeof handler, 'function', `${method} ${routePath} 라우트가 등록되어야 한다.`);
    return handler;
  };
  route.services = services;
  return route;
}

function makeRequest(overrides = {}) {
  return {
    uid: 'ordinary-reader',
    userDoc: { approved: true, is_active: true, name: '일반사용자' },
    headers: {},
    socket: {},
    query: {},
    params: {},
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

const accountRow = {
  id: 'hq-sales',
  provider: 'IBK',
  bank_name: '기업은행',
  display_name: '매출통장',
  branch_id: 'hq',
  account_number_masked: '12-********-7890',
  currency: 'KRW',
  purpose: '매출',
  is_active: true,
  latest_balance: 987654321,
  latest_balance_at: '2026-08-06T00:00:00.000Z',
  unmatched_count: 2,
};

const transactionRow = {
  id: 11,
  account_id: 'hq-sales',
  transaction_at: '2026-08-06T00:03:00.000Z',
  direction: 'DEPOSIT',
  amount: 1100000,
  balance: 987654321,
  summary: '입금',
  counterparty_name: '테스트거래처',
  counterparty_account_masked: '12-********-1234',
  branch_text: '본점',
  reconciliation_status: 'UNMATCHED',
  source: 'BANK_SYNC',
  first_seen_at: '2026-08-06T00:04:00.000Z',
};

const PUBLIC_ACCOUNT_IDS = [
  'ibk-hq-sales',
  'ibk-review-space',
  'ibk-reward-space',
];
const TAX_PURCHASE_ACCOUNT_IDS = [
  'ibk-hq-fixed',
  'ibk-hq-supplier',
];
const FUTURE_ACCOUNT_ID = 'ibk-future-new-account';

test('일반 조회자의 계좌 목록은 SQL·응답 모두 공개 3계좌 allowlist로 제한한다', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return {
        rows: [
          { ...accountRow, id: 'ibk-hq-fixed' },
          { ...accountRow, id: FUTURE_ACCOUNT_ID },
          ...PUBLIC_ACCOUNT_IDS.map(id => ({ ...accountRow, id })),
        ],
      };
    },
  };
  const route = createRouteHarness({ pool });
  const response = makeResponse();

  await route('GET', '/api/peakos/bank/accounts')(makeRequest(), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.canViewBalances, false);
  assert.equal(response.body.autoReconciliationEnabled, false);
  assert.deepEqual(response.body.accounts.map(account => account.id), PUBLIC_ACCOUNT_IDS);
  assert.equal(response.body.accounts[0].latestBalance, null);
  assert.equal(response.body.accounts[0].latestBalanceAt, null);
  assert.match(calls[0].sql, /CASE WHEN \$1::boolean THEN a\.latest_balance ELSE NULL::bigint/);
  assert.match(calls[0].sql, /a\.id = ANY\(\$3::text\[\]\)/);
  assert.doesNotMatch(calls[0].sql, /NOT \(a\.id = ANY/);
  assert.deepEqual(calls[0].values, [false, false, PUBLIC_ACCOUNT_IDS]);
});

test('잔액 capability exact4 사용자는 allowlist 밖 기존·신규 계좌와 잔액을 모두 보고 감사 로그를 남긴다', async () => {
  const calls = [];
  const restrictedRow = { ...accountRow, id: 'ibk-hq-supplier', display_name: '본사 공급사 통장' };
  const futureRow = { ...accountRow, id: FUTURE_ACCOUNT_ID, display_name: '신규 통장' };
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (/INSERT INTO peakos_bank_audit_log/.test(sql)) return { rows: [] };
      return { rows: [restrictedRow, futureRow] };
    },
  };
  const permittedUids = new Set(['uid-fashion-tv', 'uid-park', 'uid-kim', 'uid-son']);
  const route = createRouteHarness({
    pool,
    canRead: () => false,
    canViewBalances: req => permittedUids.has(req.uid),
    autoReconciliationEnabled: true,
  });
  const response = makeResponse();

  await route('GET', '/api/peakos/bank/accounts')(
    makeRequest({ uid: 'uid-son', userDoc: { approved: true, is_active: true, name: '손명아' } }),
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.canViewBalances, true);
  assert.equal(response.body.autoReconciliationEnabled, true);
  assert.deepEqual(response.body.accounts.map(account => account.id), ['ibk-hq-supplier', FUTURE_ACCOUNT_ID]);
  assert.equal(response.body.accounts.every(account => account.latestBalance === 987654321), true);
  assert.deepEqual(calls[0].values, [true, true, PUBLIC_ACCOUNT_IDS]);
  const audit = calls.find(call => /INSERT INTO peakos_bank_audit_log/.test(call.sql));
  assert.equal(audit.values[0], 'BANK_BALANCE_ACCOUNTS_READ');
});

test('전현우는 tax-purchase scope에서 매입 두 계좌만 잔액 없이 읽는다', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return {
        rows: [
          ...TAX_PURCHASE_ACCOUNT_IDS.map(id => ({ ...accountRow, id })),
          { ...accountRow, id: PUBLIC_ACCOUNT_IDS[0] },
          { ...accountRow, id: FUTURE_ACCOUNT_ID },
        ],
      };
    },
  };
  const route = createRouteHarness({
    pool,
    canReadTaxPurchase: req => req.uid === 'uid-jeon',
  });
  const response = makeResponse();

  await route('GET', '/api/peakos/bank/accounts')(
    makeRequest({ uid: 'uid-jeon', query: { scope: 'tax-purchase' } }),
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.scope, 'tax-purchase');
  assert.equal(response.body.canViewBalances, false);
  assert.deepEqual(response.body.accounts.map(account => account.id), TAX_PURCHASE_ACCOUNT_IDS);
  assert.equal(response.body.accounts.every(account => account.latestBalance === null), true);
  assert.equal(response.body.accounts.every(account => account.latestBalanceAt === null), true);
  assert.equal(response.body.accounts.every(account => account.canSync === false), true);
  assert.equal(response.body.accounts.every(account => account.canManage === false), true);
  assert.match(calls[0].sql, /WHERE \$2::boolean OR a\.id = ANY\(\$3::text\[\]\)/);
  assert.deepEqual(calls[0].values, [false, false, TAX_PURCHASE_ACCOUNT_IDS]);
});

test('전현우도 scope 없는 일반 계좌 목록에서는 공개 3계좌만 읽는다', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return {
        rows: [
          ...TAX_PURCHASE_ACCOUNT_IDS.map(id => ({ ...accountRow, id })),
          { ...accountRow, id: FUTURE_ACCOUNT_ID },
          ...PUBLIC_ACCOUNT_IDS.map(id => ({ ...accountRow, id })),
        ],
      };
    },
  };
  const route = createRouteHarness({
    pool,
    canReadTaxPurchase: req => req.uid === 'uid-jeon',
  });
  const response = makeResponse();

  await route('GET', '/api/peakos/bank/accounts')(
    makeRequest({ uid: 'uid-jeon' }),
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.scope, 'bank');
  assert.deepEqual(response.body.accounts.map(account => account.id), PUBLIC_ACCOUNT_IDS);
  assert.equal(response.body.accounts.every(account => account.latestBalance === null), true);
  assert.deepEqual(calls[0].values, [false, false, PUBLIC_ACCOUNT_IDS]);
});

test('tax-purchase 계좌 scope는 exact UID 권한과 정확한 scope를 모두 요구한다', async () => {
  let queryCount = 0;
  const pool = { query: async () => { queryCount += 1; return { rows: [] }; } };
  const route = createRouteHarness({
    pool,
    canReadTaxPurchase: req => req.uid === 'uid-jeon',
  });

  const ordinary = makeResponse();
  await route('GET', '/api/peakos/bank/accounts')(
    makeRequest({ uid: 'ordinary-reader', query: { scope: 'tax-purchase' } }),
    ordinary,
  );
  assert.equal(ordinary.statusCode, 403);

  for (const scope of ['purchase', 'tax-purchase-extra', ['tax-purchase']]) {
    const invalid = makeResponse();
    await route('GET', '/api/peakos/bank/accounts')(
      makeRequest({ uid: 'uid-jeon', query: { scope } }),
      invalid,
    );
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.body.code, 'BANK_INVALID_SCOPE');
  }
  assert.equal(queryCount, 0);
});

test('거래의 알 수 없는 scope와 동기화 이력의 tax-purchase scope는 DB 전에 거부한다', async () => {
  let queryCount = 0;
  const pool = { query: async () => { queryCount += 1; return { rows: [] }; } };
  const route = createRouteHarness({
    pool,
    canReadTaxPurchase: () => true,
  });

  const transaction = makeResponse();
  await route('GET', '/api/peakos/bank/transactions')(
    makeRequest({ query: { scope: 'unknown' } }),
    transaction,
  );
  assert.equal(transaction.statusCode, 400);
  assert.equal(transaction.body.code, 'BANK_INVALID_SCOPE');

  const syncRuns = makeResponse();
  await route('GET', '/api/peakos/bank/sync-runs')(
    makeRequest({ query: { scope: 'tax-purchase' } }),
    syncRuns,
  );
  assert.equal(syncRuns.statusCode, 400);
  assert.equal(syncRuns.body.code, 'BANK_INVALID_SCOPE');
  assert.equal(queryCount, 0);
});

test('민감 조회 감사 로그 저장에 실패하면 잔액 응답을 보내지 않는다', async () => {
  let queryCount = 0;
  const pool = {
    query: async () => {
      queryCount += 1;
      if (queryCount === 1) return { rows: [accountRow] };
      throw new Error('감사 로그 저장 실패');
    },
  };
  const route = createRouteHarness({ pool, canViewBalances: () => true });
  const response = makeResponse();
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await route('GET', '/api/peakos/bank/accounts')(makeRequest(), response);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(queryCount, 2);
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.accounts, undefined);
});

test('일반 조회자의 거래와 합계는 SQL·응답 모두 공개 3계좌 allowlist로 제한하고 잔액을 제거한다', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (/SELECT COUNT\(\*\)::integer AS total/.test(sql)) {
        return { rows: [{ total: 3, deposit_total: 3300000, withdrawal_total: 0, unmatched_count: 3 }] };
      }
      return {
        rows: [
          { ...transactionRow, id: 12, account_id: 'ibk-hq-supplier' },
          { ...transactionRow, id: 13, account_id: FUTURE_ACCOUNT_ID },
          ...PUBLIC_ACCOUNT_IDS.map((accountId, index) => ({
            ...transactionRow,
            id: 20 + index,
            account_id: accountId,
          })),
        ],
      };
    },
  };
  const route = createRouteHarness({ pool });
  const response = makeResponse();

  await route('GET', '/api/peakos/bank/transactions')(makeRequest(), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.transactions.map(transaction => transaction.accountId), PUBLIC_ACCOUNT_IDS);
  assert.equal(response.body.transactions[0].balance, null);
  assert.equal(response.body.summary.depositTotal, null);
  assert.equal(response.body.summary.withdrawalTotal, null);
  assert.match(calls[0].sql, /NULL::bigint AS balance/);
  assert.match(calls[0].sql, /t\.account_id = ANY\(\$1::text\[\]\)/);
  assert.doesNotMatch(calls[0].sql, /NOT \(t\.account_id = ANY/);
  assert.match(calls[1].sql, /NULL::bigint AS deposit_total/);
  assert.match(calls[1].sql, /NULL::bigint AS withdrawal_total/);
  assert.deepEqual(calls[0].values[0], PUBLIC_ACCOUNT_IDS);
});

test('일반 조회자가 allowlist 밖 기존·신규 accountId를 직접 지정하면 DB 조회 전에 거부한다', async () => {
  let queryCount = 0;
  const pool = {
    query: async () => {
      queryCount += 1;
      throw new Error('DB를 조회하면 안 된다.');
    },
  };
  const route = createRouteHarness({ pool });

  for (const accountId of ['ibk-hq-fixed', FUTURE_ACCOUNT_ID]) {
    for (const [routePath, errorPattern] of [
      ['/api/peakos/bank/transactions', /거래내역/],
      ['/api/peakos/bank/sync-runs', /동기화 이력/],
    ]) {
      const response = makeResponse();
      await route('GET', routePath)(makeRequest({ query: { accountId } }), response);
      assert.equal(response.statusCode, 403);
      assert.match(response.body.error, errorPattern);
    }
  }
  assert.equal(queryCount, 0);
});

test('전현우의 매입 거래는 명시적 tax-purchase scope에서만 열리고 잔액·합계는 제거된다', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (/SELECT COUNT\(\*\)::integer AS total/.test(sql)) {
        return { rows: [{ total: 1, deposit_total: 1100000, withdrawal_total: 0, unmatched_count: 1 }] };
      }
      return {
        rows: [
          { ...transactionRow, id: 31, account_id: 'ibk-hq-fixed' },
          { ...transactionRow, id: 32, account_id: PUBLIC_ACCOUNT_IDS[0] },
          { ...transactionRow, id: 33, account_id: FUTURE_ACCOUNT_ID },
        ],
      };
    },
  };
  const route = createRouteHarness({
    pool,
    canReadTaxPurchase: req => req.uid === 'uid-jeon',
  });

  const withoutScope = makeResponse();
  await route('GET', '/api/peakos/bank/transactions')(
    makeRequest({ uid: 'uid-jeon', query: { accountId: 'ibk-hq-fixed' } }),
    withoutScope,
  );
  assert.equal(withoutScope.statusCode, 403);
  assert.equal(calls.length, 0);

  const scoped = makeResponse();
  await route('GET', '/api/peakos/bank/transactions')(
    makeRequest({
      uid: 'uid-jeon',
      query: { scope: 'tax-purchase', accountId: 'ibk-hq-fixed' },
    }),
    scoped,
  );
  assert.equal(scoped.statusCode, 200);
  assert.equal(scoped.body.scope, 'tax-purchase');
  assert.deepEqual(scoped.body.transactions.map(transaction => transaction.accountId), ['ibk-hq-fixed']);
  assert.equal(scoped.body.transactions[0].balance, null);
  assert.equal(scoped.body.summary.depositTotal, null);
  assert.equal(scoped.body.summary.withdrawalTotal, null);
  assert.match(calls[0].sql, /NULL::bigint AS balance/);
  assert.match(calls[0].sql, /t\.account_id = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(calls[0].values.slice(0, 2), [TAX_PURCHASE_ACCOUNT_IDS, 'ibk-hq-fixed']);
});

test('tax-purchase scope는 공개·미래 계좌를 거부하고 잔액 권한자에게도 매입 두 계좌로 고정한다', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (/INSERT INTO peakos_bank_audit_log/.test(sql)) return { rows: [] };
      if (/SELECT COUNT\(\*\)::integer AS total/.test(sql)) {
        return { rows: [{ total: 2, deposit_total: 2200000, withdrawal_total: 0, unmatched_count: 2 }] };
      }
      return {
        rows: [
          ...TAX_PURCHASE_ACCOUNT_IDS.map((accountId, index) => ({
            ...transactionRow,
            id: 41 + index,
            account_id: accountId,
          })),
          { ...transactionRow, id: 43, account_id: FUTURE_ACCOUNT_ID },
        ],
      };
    },
  };
  const route = createRouteHarness({
    pool,
    canReadTaxPurchase: req => req.uid === 'uid-kim',
    canViewBalances: req => req.uid === 'uid-kim',
  });

  for (const accountId of [PUBLIC_ACCOUNT_IDS[0], FUTURE_ACCOUNT_ID]) {
    const denied = makeResponse();
    await route('GET', '/api/peakos/bank/transactions')(
      makeRequest({ uid: 'uid-kim', query: { scope: 'tax-purchase', accountId } }),
      denied,
    );
    assert.equal(denied.statusCode, 403);
  }
  assert.equal(calls.length, 0);

  const scoped = makeResponse();
  await route('GET', '/api/peakos/bank/transactions')(
    makeRequest({ uid: 'uid-kim', query: { scope: 'tax-purchase' } }),
    scoped,
  );
  assert.equal(scoped.statusCode, 200);
  assert.deepEqual(scoped.body.transactions.map(transaction => transaction.accountId), TAX_PURCHASE_ACCOUNT_IDS);
  assert.equal(scoped.body.transactions.every(transaction => transaction.balance === 987654321), true);
  assert.match(calls[0].sql, /t\.account_id = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(calls[0].values[0], TAX_PURCHASE_ACCOUNT_IDS);
});

test('일반 조회자의 무필터 동기화 이력도 SQL·응답 모두 공개 3계좌 allowlist로 제한한다', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return {
        rows: [
          { id: 1, account_id: 'ibk-hq-fixed', status: 'SUCCEEDED', trigger_type: 'MANUAL' },
          { id: 2, account_id: FUTURE_ACCOUNT_ID, status: 'SUCCEEDED', trigger_type: 'MANUAL' },
          ...PUBLIC_ACCOUNT_IDS.map((accountId, index) => ({
            id: 10 + index,
            account_id: accountId,
            status: 'SUCCEEDED',
            trigger_type: 'MANUAL',
          })),
        ],
      };
    },
  };
  const route = createRouteHarness({ pool });
  const response = makeResponse();

  await route('GET', '/api/peakos/bank/sync-runs')(makeRequest(), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.runs.map(run => run.accountId), PUBLIC_ACCOUNT_IDS);
  assert.match(calls[0].sql, /account_id = ANY\(\$1::text\[\]\)/);
  assert.doesNotMatch(calls[0].sql, /NOT \(account_id = ANY/);
  assert.deepEqual(calls[0].values, [PUBLIC_ACCOUNT_IDS, 30]);
});

test('잔액 capability는 민감 거래의 잔액·합계 조회를 허용하고 감사 로그를 남긴다', async () => {
  const calls = [];
  const sensitiveTransaction = { ...transactionRow, account_id: 'ibk-hq-supplier' };
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (/INSERT INTO peakos_bank_audit_log/.test(sql)) return { rows: [] };
      if (/SELECT COUNT\(\*\)::integer AS total/.test(sql)) {
        return { rows: [{ total: 1, deposit_total: 1100000, withdrawal_total: 0, unmatched_count: 1 }] };
      }
      return { rows: [sensitiveTransaction] };
    },
  };
  const route = createRouteHarness({
    pool,
    canRead: () => false,
    canViewBalances: req => req.uid === 'uid-park',
  });
  const response = makeResponse();

  await route('GET', '/api/peakos/bank/transactions')(
    makeRequest({ uid: 'uid-park', query: { accountId: 'ibk-hq-supplier' } }),
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.transactions[0].balance, 987654321);
  assert.equal(response.body.summary.depositTotal, 1100000);
  assert.equal(response.body.summary.withdrawalTotal, 0);
  assert.match(calls[0].sql, /t\.balance AS balance/);
  assert.doesNotMatch(calls[0].sql, /NOT \(t\.account_id = ANY/);
  assert.match(calls[1].sql, /COALESCE\(SUM\(amount\)/);
  const audit = calls.find(call => /INSERT INTO peakos_bank_audit_log/.test(call.sql));
  assert.equal(audit.values[0], 'BANK_BALANCE_TRANSACTIONS_READ');
});

test('일반 관리·동기화 권한이 있어도 allowlist 밖 기존·신규 계좌는 DB 연결 전 변경·import·sync를 거부한다', async () => {
  let connectCount = 0;
  let collectorCount = 0;
  const pool = {
    connect: async () => {
      connectCount += 1;
      throw new Error('DB 연결을 시도하면 안 된다.');
    },
  };
  const route = createRouteHarness({
    pool,
    canManage: () => true,
    canSync: () => true,
    allowImport: true,
    collector: async () => {
      collectorCount += 1;
      return { transactions: [] };
    },
  });
  const cases = [
    ['PUT', '/api/peakos/bank/accounts/:accountId', {}],
    ['POST', '/api/peakos/bank/accounts/:accountId/import', { transactions: [goodRow], reason: '테스트 자료 반영' }],
    ['POST', '/api/peakos/bank/accounts/:accountId/sync', {}],
  ];

  for (const accountId of ['ibk-hq-supplier', FUTURE_ACCOUNT_ID]) {
    for (const [method, routePath, body] of cases) {
      const response = makeResponse();
      await route(method, routePath)(
        makeRequest({ params: { accountId }, body }),
        response,
      );
      assert.equal(response.statusCode, 403);
    }
  }
  assert.equal(connectCount, 0);
  assert.equal(collectorCount, 0);
});

function createSyncClient({ locked = true, account = accountRow, runId = 701 } = {}) {
  const calls = [];
  const events = [];
  const client = {
    released: false,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked }] };
      if (/FROM peakos_bank_accounts/.test(sql) && /is_active = true/.test(sql)) {
        return { rows: account ? [account] : [] };
      }
      if (/INSERT INTO peakos_bank_sync_runs/.test(sql)) return { rows: [{ id: runId }] };
      if (/INSERT INTO peakos_bank_transactions/.test(sql)) return { rows: [{ inserted: true }] };
      if (String(sql).trim() === 'COMMIT') events.push('commit');
      if (/pg_advisory_unlock/.test(sql)) events.push('unlock');
      return { rows: [] };
    },
    release() {
      this.released = true;
      events.push('release');
    },
  };
  return { client, calls, events };
}

test('registerPeakosBanking은 SCHEDULED에서도 사용할 수 있는 syncAccount 서비스를 반환한다', async () => {
  const syncDb = createSyncClient();
  const collectorInputs = [];
  const afterSyncInputs = [];
  const route = createRouteHarness({
    pool: { connect: async () => syncDb.client },
    collector: async input => {
      collectorInputs.push(input);
      return {
        transactions: [goodRow],
        from: '2026-08-01T00:00:00+09:00',
        to: '2026-08-07T00:00:00+09:00',
      };
    },
    afterSync: async input => {
      assert.equal(syncDb.client.released, true);
      syncDb.events.push('afterSync');
      afterSyncInputs.push(input);
    },
  });

  assert.equal(typeof route.services.syncAccount, 'function');
  const result = await route.services.syncAccount({
    accountId: 'hq-sales',
    from: '2026-08-01T00:00:00+09:00',
    to: '2026-08-07T00:00:00+09:00',
    triggerType: 'SCHEDULED',
    actor: { uid: 'bank-scheduler', name: '자동 동기화' },
    requestId: 'scheduled-request-1',
  });

  assert.deepEqual(result, {
    requestId: 'scheduled-request-1',
    runId: '701',
    triggerType: 'SCHEDULED',
    fetched: 1,
    inserted: 1,
    updated: 0,
    afterSync: { ok: true },
  });
  assert.equal(collectorInputs[0].triggerType, 'SCHEDULED');
  assert.equal(collectorInputs[0].account.latestBalance, null);
  const runInsert = syncDb.calls.find(call => /INSERT INTO peakos_bank_sync_runs/.test(call.sql));
  assert.deepEqual(runInsert.values, [
    'hq-sales', 'SCHEDULED', 'bank-scheduler', '자동 동기화', 'scheduled-request-1',
  ]);
  const audit = syncDb.calls.find(call => /INSERT INTO peakos_bank_audit_log/.test(call.sql));
  assert.equal(audit.values[0], 'BANK_SYNC');
  assert.equal(audit.values[5], 'scheduled-request-1');
  assert.equal(audit.values[6], null);
  assert.deepEqual(afterSyncInputs[0], {
    accountId: 'hq-sales',
    runId: '701',
    requestId: 'scheduled-request-1',
    triggerType: 'SCHEDULED',
    actor: { uid: 'bank-scheduler', name: '자동 동기화' },
    from: new Date('2026-07-31T15:00:00.000Z'),
    to: new Date('2026-08-06T15:00:00.000Z'),
    fetched: 1,
    inserted: 1,
    updated: 0,
  });
  assert.deepEqual(syncDb.events, ['commit', 'unlock', 'release', 'afterSync']);
});

test('syncAccount은 MANUAL·SCHEDULED 외 trigger를 DB 연결 전에 거부한다', async () => {
  let connectCount = 0;
  const route = createRouteHarness({
    pool: { connect: async () => { connectCount += 1; } },
    collector: async () => ({ transactions: [] }),
  });

  await assert.rejects(
    route.services.syncAccount({ accountId: 'hq-sales', triggerType: 'IMPORT' }),
    error => error.code === 'BANK_INVALID_SYNC_TRIGGER' && /MANUAL/.test(error.message),
  );
  assert.equal(connectCount, 0);
});

test('수집기가 없으면 서비스와 HTTP가 동일한 typed 오류로 실패한다', async () => {
  let connectCount = 0;
  const route = createRouteHarness({
    pool: { connect: async () => { connectCount += 1; } },
    canSync: () => true,
  });

  await assert.rejects(
    route.services.syncAccount({
      accountId: 'hq-sales',
      triggerType: 'SCHEDULED',
      requestId: 'missing-collector',
    }),
    error => (
      error instanceof BankSyncError
      && error.code === 'BANK_COLLECTOR_NOT_CONFIGURED'
      && error.statusCode === 503
      && error.requestId === 'missing-collector'
    ),
  );

  const response = makeResponse();
  await route('POST', '/api/peakos/bank/accounts/:accountId/sync')(
    makeRequest({ params: { accountId: 'ibk-hq-sales' } }),
    response,
  );
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'BANK_COLLECTOR_NOT_CONFIGURED');
  assert.match(response.body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(connectCount, 0);
});

test('advisory lock을 획득하지 못하면 실행 이력을 만들지 않고 typed 충돌을 반환한다', async () => {
  const syncDb = createSyncClient({ locked: false });
  const route = createRouteHarness({
    pool: { connect: async () => syncDb.client },
    collector: async () => ({ transactions: [] }),
  });

  await assert.rejects(
    route.services.syncAccount({ accountId: 'hq-sales', triggerType: 'MANUAL' }),
    error => error instanceof BankSyncError && error.code === 'BANK_SYNC_IN_PROGRESS' && error.statusCode === 409,
  );
  assert.equal(syncDb.calls.some(call => /INSERT INTO peakos_bank_sync_runs/.test(call.sql)), false);
  assert.equal(syncDb.calls.some(call => /pg_advisory_unlock/.test(call.sql)), false);
  assert.equal(syncDb.client.released, true);
});

test('수집 실패는 run·account를 정리하고 민감 오류를 외부에 노출하지 않는다', async () => {
  const syncDb = createSyncClient();
  let afterSyncCount = 0;
  const route = createRouteHarness({
    pool: { connect: async () => syncDb.client },
    collector: async () => {
      throw new Error('token=supersecretvalue account=123-456-789012');
    },
    afterSync: async () => { afterSyncCount += 1; },
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  let thrown;
  try {
    await route.services.syncAccount({
      accountId: 'hq-sales',
      triggerType: 'SCHEDULED',
      requestId: 'failed-request',
    });
  } catch (error) {
    thrown = error;
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(thrown instanceof BankSyncError, true);
  assert.equal(thrown.code, 'BANK_SYNC_FAILED');
  assert.equal(thrown.message, '통장 조회에 실패했습니다.');
  const failedRun = syncDb.calls.find(call => /error_code = \$2, error_message = \$3/.test(call.sql));
  assert.deepEqual(failedRun.values.slice(0, 2), [701, 'BANK_SYNC_FAILED']);
  assert.equal(failedRun.values[2].includes('supersecretvalue'), false);
  assert.equal(failedRun.values[2].includes('123-456-789012'), false);
  assert.equal(syncDb.calls.some(call => /SET last_sync_error = \$2/.test(call.sql)), true);
  assert.equal(syncDb.calls.some(call => String(call.sql).trim() === 'BEGIN'), false);
  assert.equal(afterSyncCount, 0);
  assert.equal(syncDb.client.released, true);
});

test('거래 save 실패는 원장 transaction을 rollback한 뒤 run을 FAILED로 정리한다', async () => {
  const syncDb = createSyncClient();
  const route = createRouteHarness({
    pool: { connect: async () => syncDb.client },
    collector: async () => ({ transactions: [{ ...goodRow, amount: 'invalid-amount' }] }),
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      route.services.syncAccount({ accountId: 'hq-sales', triggerType: 'MANUAL' }),
      error => error instanceof BankSyncError && error.code === 'BANK_SYNC_FAILED',
    );
  } finally {
    console.error = originalConsoleError;
  }

  const beginIndex = syncDb.calls.findIndex(call => String(call.sql).trim() === 'BEGIN');
  const rollbackIndex = syncDb.calls.findIndex(call => String(call.sql).trim() === 'ROLLBACK');
  const failedIndex = syncDb.calls.findIndex(call => /error_code = \$2, error_message = \$3/.test(call.sql));
  assert.notEqual(beginIndex, -1);
  assert.equal(beginIndex < rollbackIndex, true);
  assert.equal(rollbackIndex < failedIndex, true);
  assert.equal(syncDb.calls.some(call => String(call.sql).trim() === 'COMMIT'), false);
});

test('afterSync 실패는 COMMIT된 은행 sync를 되돌리지 않고 안전한 결과로만 보고한다', async () => {
  const syncDb = createSyncClient();
  const route = createRouteHarness({
    pool: { connect: async () => syncDb.client },
    collector: async () => ({ transactions: [] }),
    afterSync: async () => {
      assert.equal(syncDb.client.released, true);
      throw new Error('reconcile token=verysecretvalue account=123-456-789012');
    },
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await route.services.syncAccount({
      accountId: 'hq-sales',
      triggerType: 'MANUAL',
      requestId: 'after-sync-failure',
      actor: { uid: 'manual-user', name: '수동 사용자' },
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(result.afterSync, {
    ok: false,
    code: 'BANK_AFTER_SYNC_FAILED',
    message: '통장 동기화 후속 처리에 실패했습니다.',
  });
  assert.equal(JSON.stringify(result).includes('verysecretvalue'), false);
  const commitIndex = syncDb.calls.findIndex(call => String(call.sql).trim() === 'COMMIT');
  assert.notEqual(commitIndex, -1);
  const afterCommitCalls = syncDb.calls.slice(commitIndex + 1);
  assert.equal(afterCommitCalls.some(call => /error_code = \$2, error_message = \$3/.test(call.sql)), false);
  assert.equal(afterCommitCalls.some(call => /SET last_sync_error = \$2/.test(call.sql)), false);
  assert.equal(syncDb.calls.some(call => /status = 'SUCCEEDED'/.test(call.sql)), true);
});

test('HTTP 수동 sync는 공통 syncAccount 흐름을 MANUAL trigger로 사용한다', async () => {
  const syncDb = createSyncClient({ account: { ...accountRow, id: 'ibk-hq-sales' } });
  const collectorInputs = [];
  const route = createRouteHarness({
    pool: { connect: async () => syncDb.client },
    canSync: () => true,
    collector: async input => {
      collectorInputs.push(input);
      return { transactions: [] };
    },
  });
  const response = makeResponse();

  await route('POST', '/api/peakos/bank/accounts/:accountId/sync')(
    makeRequest({
      uid: 'manual-user',
      userDoc: { approved: true, is_active: true, name: '수동 사용자' },
      params: { accountId: 'ibk-hq-sales' },
      body: { from: '2026-08-01T00:00:00+09:00', to: '2026-08-02T00:00:00+09:00' },
    }),
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.triggerType, 'MANUAL');
  assert.equal(collectorInputs[0].triggerType, 'MANUAL');
  const runInsert = syncDb.calls.find(call => /INSERT INTO peakos_bank_sync_runs/.test(call.sql));
  assert.equal(runInsert.values[1], 'MANUAL');
  assert.equal(runInsert.values[2], 'manual-user');
});
