'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizePartyName,
  reconcileAccountTransactions,
} = require('./peakos-bank-reconciliation');
const { AUTO_MATCH_MAX_AGE_DAYS } = require('./peakos-auto-match-policy');

function createMockPool({ transaction, candidates = [], activeAllocation = null, allocationInserted = true } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') return { rows: [] };
      if (normalized.startsWith('SELECT id FROM peakos_bank_transactions')) {
        return { rows: transaction ? [{ id: transaction.id }] : [] };
      }
      if (normalized.startsWith('SELECT id, account_id, transaction_at')) return { rows: transaction ? [transaction] : [] };
      if (normalized.startsWith('SELECT a.intake_id, a.allocated_amount')) {
        return { rows: activeAllocation ? [{
          ...activeAllocation,
          allocated_amount: activeAllocation.allocated_amount ?? transaction.amount,
          valid_intake_id: activeAllocation.valid_intake_id ?? activeAllocation.intake_id,
        }] : [] };
      }
      if (normalized.startsWith('SELECT i.id,')) {
        return {
          rows: candidates.map(row => ({ created_at: transaction?.transaction_at, ...row })),
        };
      }
      if (normalized.startsWith('INSERT INTO peakos_bank_allocations')) {
        return { rows: allocationInserted ? [{ id: 'allocation-1' }] : [] };
      }
      if (normalized.startsWith('SELECT transaction_id, intake_id')) return { rows: [] };
      if (normalized.startsWith('UPDATE peakos_intake')) return { rows: [{ id: candidates[0]?.id }] };
      if (normalized.startsWith('UPDATE peakos_bank_transactions')) return { rows: [] };
      if (normalized.startsWith('INSERT INTO peakos_bank_audit_log')) return { rows: [] };
      throw new Error(`Unexpected SQL in mock: ${normalized}`);
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };
  return {
    calls,
    pool: { connect: async () => client },
  };
}

function bankTransaction(overrides = {}) {
  return {
    id: '101',
    account_id: 'ibk-hq-sales',
    transaction_at: new Date('2026-08-06T00:03:00.000Z'),
    direction: 'DEPOSIT',
    amount: '1100000',
    counterparty_name: '테스트 거래처',
    reconciliation_status: 'UNMATCHED',
    ...overrides,
  };
}

test('이름 정규화는 Unicode·대소문자·공백만 보정하고 문장부호는 유지한다', () => {
  assert.equal(normalizePartyName(' Ｔｅｓｔ\u200b 거래처 '), 'test거래처');
  assert.notEqual(normalizePartyName('테스트거래처'), normalizePartyName('테스트거래처!'));
});

test('매출통장이 아니면 DB를 조회하지 않고 건너뛴다', async () => {
  let connected = false;
  const result = await reconcileAccountTransactions({
    pool: { connect: async () => { connected = true; } },
    accountId: 'ibk-hq-fixed',
  });
  assert.equal(result.ineligibleAccount, true);
  assert.equal(result.scanned, 0);
  assert.equal(connected, false);
});

test('금액·정규화 이름이 정확하고 후보가 하나면 할당·입금확인·감사를 한 트랜잭션에 처리한다', async () => {
  const mock = createMockPool({
    transaction: bankTransaction(),
    candidates: [{ id: 'intake-1', match_name: ' 테스트거래처 ' }],
  });
  const result = await reconcileAccountTransactions({
    pool: mock.pool,
    accountId: 'ibk-hq-sales',
    requestId: 'sync-request-1',
  });

  assert.deepEqual(result, {
    accountId: 'ibk-hq-sales',
    ineligibleAccount: false,
    scanned: 1,
    matched: 1,
    proposed: 0,
    unmatched: 0,
    alreadyMatched: 0,
    failed: 0,
  });
  const sql = mock.calls.map(call => call.sql);
  assert.ok(sql.some(statement => statement.includes("i.kind IN ('normal', 'reserve')")));
  assert.ok(sql.some(statement => statement.includes('i.bank_match_eligible = TRUE')));
  assert.ok(sql.some(statement => statement.includes('i.bank_match_approved_by_uid IS NOT NULL')));
  assert.ok(sql.some(statement => statement.includes('provider_key_stable = TRUE')));
  assert.ok(sql.some(statement => statement.includes("created_at >= $2::timestamptz - ($3::integer * INTERVAL '1 day')")));
  assert.ok(sql.some(statement => statement.includes("INTERVAL '1 hour'")));
  const candidateQuery = mock.calls.find(call => call.sql.startsWith('SELECT i.id,'));
  assert.equal(candidateQuery.params[2], AUTO_MATCH_MAX_AGE_DAYS);
  assert.match(candidateQuery.sql, /COALESCE\(i\.expected_deposit_amount,/);
  assert.match(candidateQuery.sql, /COALESCE\(i\.sell, 0\).*COALESCE\(i\.qty, 0\)/);
  assert.ok(sql.some(statement => statement.startsWith('INSERT INTO peakos_bank_allocations')));
  assert.ok(sql.some(statement => statement.startsWith('UPDATE peakos_intake')));
  const intakeUpdate = mock.calls.find(call => call.sql.startsWith('UPDATE peakos_intake'));
  assert.match(intakeUpdate.sql, /COALESCE\(expected_deposit_amount,/);
  assert.match(intakeUpdate.sql, /row_version = row_version \+ 1/);
  assert.ok(sql.some(statement => statement.includes("reconciliation_status = 'MATCHED'")));
  assert.ok(sql.some(statement => statement.startsWith('INSERT INTO peakos_bank_audit_log')));
  assert.ok(sql.indexOf('BEGIN') < sql.indexOf('COMMIT'));
  assert.equal(sql.at(-1), 'RELEASE');
});

test('동일 금액·이름 후보가 둘이면 PROPOSED만 표시하고 정산서를 변경하지 않는다', async () => {
  const mock = createMockPool({
    transaction: bankTransaction(),
    candidates: [
      { id: 'intake-1', match_name: '테스트거래처' },
      { id: 'intake-2', match_name: '테스트 거래처' },
    ],
  });
  const result = await reconcileAccountTransactions({ pool: mock.pool, accountId: 'ibk-hq-sales' });

  assert.equal(result.proposed, 1);
  assert.equal(result.matched, 0);
  const sql = mock.calls.map(call => call.sql);
  assert.ok(sql.some(statement => statement.includes("reconciliation_status = 'PROPOSED'")));
  assert.equal(sql.some(statement => statement.startsWith('INSERT INTO peakos_bank_allocations')), false);
  assert.equal(sql.some(statement => statement.startsWith('UPDATE peakos_intake')), false);
});

test('부분·유사 이름은 자동 매칭하지 않는다', async () => {
  const mock = createMockPool({
    transaction: bankTransaction({ counterparty_name: '테스트거래처' }),
    candidates: [{ id: 'intake-1', match_name: '테스트거래처!' }],
  });
  const result = await reconcileAccountTransactions({ pool: mock.pool, accountId: 'ibk-hq-sales' });

  assert.equal(result.unmatched, 1);
  assert.equal(result.matched, 0);
  const sql = mock.calls.map(call => call.sql);
  assert.equal(sql.some(statement => statement.startsWith('INSERT INTO peakos_bank_allocations')), false);
  assert.equal(sql.some(statement => statement.startsWith('UPDATE peakos_intake')), false);
});

test('명시적으로 승인된 접수도 과거 하한보다 오래되면 자동 매칭하지 않는다', async () => {
  const transaction = bankTransaction();
  const mock = createMockPool({
    transaction,
    candidates: [{
      id: 'old-intake',
      match_name: '테스트 거래처',
      created_at: new Date(
        transaction.transaction_at.getTime()
          - ((AUTO_MATCH_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000),
      ),
    }],
  });
  const result = await reconcileAccountTransactions({ pool: mock.pool, accountId: 'ibk-hq-sales' });

  assert.equal(result.unmatched, 1);
  assert.equal(result.matched, 0);
  const sql = mock.calls.map(call => call.sql);
  assert.equal(sql.some(statement => statement.startsWith('INSERT INTO peakos_bank_allocations')), false);
  assert.equal(sql.some(statement => statement.startsWith('UPDATE peakos_intake')), false);
});

test('이미 활성 할당이 있는 거래는 정산서 금액을 다시 더하지 않는다', async () => {
  const mock = createMockPool({
    transaction: bankTransaction(),
    activeAllocation: { intake_id: 'intake-1' },
  });
  const result = await reconcileAccountTransactions({ pool: mock.pool, accountId: 'ibk-hq-sales' });

  assert.equal(result.alreadyMatched, 1);
  assert.equal(result.matched, 0);
  const sql = mock.calls.map(call => call.sql);
  assert.equal(sql.some(statement => statement.startsWith('UPDATE peakos_intake')), false);
  assert.equal(sql.some(statement => statement.startsWith('INSERT INTO peakos_bank_allocations')), false);
});

test('조회 범위가 역전되면 쓰기 전에 거부한다', async () => {
  let connected = false;
  await assert.rejects(
    reconcileAccountTransactions({
      pool: { connect: async () => { connected = true; } },
      accountId: 'ibk-hq-sales',
      from: '2026-08-07T00:00:00Z',
      to: '2026-08-06T00:00:00Z',
    }),
    /from/,
  );
  assert.equal(connected, false);
});
