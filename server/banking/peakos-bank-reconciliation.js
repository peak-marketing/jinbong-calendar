'use strict';

const fs = require('fs');
const path = require('path');
const {
  AUTO_MATCH_MAX_AGE_DAYS,
  isWithinAutoMatchWindow,
} = require('./peakos-auto-match-policy');

const SALES_ACCOUNT_ID = 'ibk-hq-sales';
const SYSTEM_UID = 'system:bank-reconciliation';
const SYSTEM_NAME = '자동 입금확인';
const AUTO_PAID_MEMO = '통장 자동 입금확인';
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,79}$/i;

function normalizePartyName(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g, '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('ko-KR')
    .replace(/\s+/gu, '');
  return text;
}

function parseOptionalTimestamp(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${fieldName}의 일시 형식이 올바르지 않습니다.`);
  return parsed;
}

function emptyCounts(accountId, ineligibleAccount = false) {
  return {
    accountId,
    ineligibleAccount,
    scanned: 0,
    matched: 0,
    proposed: 0,
    unmatched: 0,
    alreadyMatched: 0,
    failed: 0,
  };
}

function cleanRequestId(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, 160) : null;
}

async function ensurePeakosBankReconciliationInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  const migrationPath = path.join(__dirname, '..', 'migrations', '20260806_z_peakos_bank_reconciliation.sql');
  await pool.query(fs.readFileSync(migrationPath, 'utf8'));
}

async function writeAudit(client, {
  action,
  transactionId,
  requestId,
  metadata,
}) {
  await client.query(
    `INSERT INTO peakos_bank_audit_log
      (action, entity_type, entity_id, actor_uid, actor_name, request_id, reason, metadata)
     VALUES ($1, 'BANK_TRANSACTION', $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      action,
      String(transactionId),
      SYSTEM_UID,
      SYSTEM_NAME,
      requestId,
      AUTO_PAID_MEMO,
      JSON.stringify(metadata || {}),
    ],
  );
}

async function recordTransactionFailure(client, transactionId, requestId, error) {
  const errorCode = /^[A-Z0-9_]{2,80}$/.test(String(error?.code || ''))
    ? String(error.code)
    : 'BANK_RECONCILIATION_FAILED';
  await writeAudit(client, {
    action: 'BANK_AUTO_MATCH_FAILED',
    transactionId,
    requestId,
    metadata: { errorCode, retryable: true },
  });
}

async function lockTransaction(client, transactionId) {
  const result = await client.query(
    `SELECT id, account_id, transaction_at, direction, amount,
            counterparty_name, reconciliation_status
       FROM peakos_bank_transactions
      WHERE id = $1
      FOR UPDATE`,
    [transactionId],
  );
  return result.rows[0] || null;
}

async function findLockedCandidates(client, transaction) {
  const result = await client.query(
    `SELECT i.id,
            COALESCE(NULLIF(btrim(i.expected_payer), ''), i.client) AS match_name,
            i.created_at
      FROM peakos_intake i
      WHERE i.kind IN ('normal', 'reserve')
        AND i.bank_match_eligible = TRUE
        AND i.bank_match_approved_by_uid IS NOT NULL
        AND i.bank_match_approved_at IS NOT NULL
        AND ((COALESCE(i.sell, 0)::numeric * COALESCE(i.qty, 0)::numeric)
          - COALESCE(i.paid_amount, 0)::numeric) > 0
        AND ((COALESCE(i.sell, 0)::numeric * COALESCE(i.qty, 0)::numeric)
          - COALESCE(i.paid_amount, 0)::numeric) = $1::numeric
        AND $3::integer > 0
        AND i.created_at >= $2::timestamptz - ($3::integer * INTERVAL '1 day')
        AND i.created_at <= $2::timestamptz + INTERVAL '1 hour'
        AND NOT EXISTS (
          SELECT 1
            FROM peakos_bank_allocations allocation
           WHERE allocation.intake_id = i.id
             AND allocation.status = 'ACTIVE'
        )
      ORDER BY i.created_at, i.id
      FOR UPDATE OF i`,
    [transaction.amount, transaction.transaction_at, AUTO_MATCH_MAX_AGE_DAYS],
  );

  const incoming = normalizePartyName(transaction.counterparty_name);
  if (!incoming) return [];
  return result.rows.filter(row => {
    if (!isWithinAutoMatchWindow(row.created_at, transaction.transaction_at)) return false;
    const expected = normalizePartyName(row.match_name);
    return expected && expected === incoming;
  });
}

async function markProposed(client, transaction, candidateCount, requestId) {
  if (transaction.reconciliation_status === 'PROPOSED') return;
  await client.query(
    `UPDATE peakos_bank_transactions
        SET reconciliation_status = 'PROPOSED', updated_at = NOW()
      WHERE id = $1`,
    [transaction.id],
  );
  await writeAudit(client, {
    action: 'BANK_AUTO_MATCH_PROPOSED',
    transactionId: transaction.id,
    requestId,
    metadata: {
      accountId: transaction.account_id,
      candidateCount,
      method: 'EXACT',
    },
  });
}

async function markUnmatched(client, transaction, requestId) {
  if (transaction.reconciliation_status !== 'PROPOSED') return;
  await client.query(
    `UPDATE peakos_bank_transactions
        SET reconciliation_status = 'UNMATCHED', updated_at = NOW()
      WHERE id = $1`,
    [transaction.id],
  );
  await writeAudit(client, {
    action: 'BANK_AUTO_MATCH_PROPOSAL_CLEARED',
    transactionId: transaction.id,
    requestId,
    metadata: { accountId: transaction.account_id, candidateCount: 0, method: 'EXACT' },
  });
}

async function applyExactMatch(client, transaction, candidate, requestId) {
  const allocation = await client.query(
    `INSERT INTO peakos_bank_allocations
      (transaction_id, intake_id, allocated_amount, status, match_method,
       confidence, reason, created_by_uid, created_by_name)
     VALUES ($1, $2, $3, 'ACTIVE', 'EXACT', 1.0000, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [transaction.id, candidate.id, transaction.amount, AUTO_PAID_MEMO, SYSTEM_UID, SYSTEM_NAME],
  );

  if (!allocation.rows[0]) {
    const existing = await client.query(
      `SELECT transaction_id, intake_id
         FROM peakos_bank_allocations
        WHERE status = 'ACTIVE'
          AND (transaction_id = $1 OR intake_id = $2)
        FOR UPDATE`,
      [transaction.id, candidate.id],
    );
    const same = existing.rows.some(row => (
      String(row.transaction_id) === String(transaction.id)
        && String(row.intake_id) === String(candidate.id)
    ));
    if (same) {
      await client.query(
        `UPDATE peakos_bank_transactions
            SET reconciliation_status = 'MATCHED', updated_at = NOW()
          WHERE id = $1`,
        [transaction.id],
      );
      return 'alreadyMatched';
    }
    const error = new Error('자동 매칭 후보가 다른 거래에서 먼저 사용되었습니다.');
    error.code = 'BANK_RECONCILIATION_ALLOCATION_CONFLICT';
    throw error;
  }

  const intake = await client.query(
    `UPDATE peakos_intake
        SET paid = 'paid',
            paid_amount = COALESCE(paid_amount, 0)::numeric + $2::numeric,
            payer = COALESCE(NULLIF(btrim(payer), ''), $3),
            paid_date = to_char($4::timestamptz AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD'),
            paid_memo = CASE
              WHEN COALESCE(btrim(paid_memo), '') = '' THEN $5
              ELSE left(paid_memo || ' · ' || $5, 500)
            END,
            paid_auto = TRUE,
            updated_at = NOW()
      WHERE id = $1
        AND kind IN ('normal', 'reserve')
        AND bank_match_eligible = TRUE
        AND bank_match_approved_by_uid IS NOT NULL
        AND bank_match_approved_at IS NOT NULL
        AND ((COALESCE(sell, 0)::numeric * COALESCE(qty, 0)::numeric)
          - COALESCE(paid_amount, 0)::numeric) = $2::numeric
        AND ((COALESCE(sell, 0)::numeric * COALESCE(qty, 0)::numeric)
          - COALESCE(paid_amount, 0)::numeric) > 0
      RETURNING id`,
    [candidate.id, transaction.amount, transaction.counterparty_name, transaction.transaction_at, AUTO_PAID_MEMO],
  );
  if (!intake.rows[0]) {
    const error = new Error('입금 매칭 중 정산서 잔액이 변경되었습니다.');
    error.code = 'BANK_RECONCILIATION_STALE_CANDIDATE';
    throw error;
  }

  await client.query(
    `UPDATE peakos_bank_transactions
        SET reconciliation_status = 'MATCHED', updated_at = NOW()
      WHERE id = $1`,
    [transaction.id],
  );
  await writeAudit(client, {
    action: 'BANK_AUTO_MATCHED',
    transactionId: transaction.id,
    requestId,
    metadata: {
      accountId: transaction.account_id,
      intakeId: String(candidate.id),
      amount: String(transaction.amount),
      method: 'EXACT',
    },
  });
  return 'matched';
}

async function reconcileAccountTransactions({ pool, accountId, from = null, to = null, requestId = null } = {}) {
  const normalizedAccountId = String(accountId || '').trim();
  if (!ACCOUNT_ID_PATTERN.test(normalizedAccountId)) throw new TypeError('accountId 형식이 올바르지 않습니다.');
  if (normalizedAccountId !== SALES_ACCOUNT_ID) return emptyCounts(normalizedAccountId, true);
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect가 필요합니다.');

  const rangeFrom = parseOptionalTimestamp(from, 'from');
  const rangeTo = parseOptionalTimestamp(to, 'to');
  if (rangeFrom && rangeTo && rangeFrom >= rangeTo) throw new RangeError('to는 from보다 뒤여야 합니다.');
  const safeRequestId = cleanRequestId(requestId);
  const counts = emptyCounts(normalizedAccountId);
  const client = await pool.connect();

  try {
    const pending = await client.query(
      `SELECT id
         FROM peakos_bank_transactions
        WHERE account_id = $1
          AND direction = 'DEPOSIT'
          AND provider_key_stable = TRUE
          AND reconciliation_status IN ('UNMATCHED', 'PROPOSED')
          AND ($2::timestamptz IS NULL OR transaction_at >= $2)
          AND ($3::timestamptz IS NULL OR transaction_at < $3)
        ORDER BY transaction_at, id`,
      [normalizedAccountId, rangeFrom, rangeTo],
    );

    for (const pendingRow of pending.rows) {
      await client.query('BEGIN');
      try {
        const transaction = await lockTransaction(client, pendingRow.id);
        if (!transaction
            || transaction.account_id !== SALES_ACCOUNT_ID
            || transaction.direction !== 'DEPOSIT'
            || !['UNMATCHED', 'PROPOSED'].includes(transaction.reconciliation_status)) {
          await client.query('COMMIT');
          continue;
        }
        counts.scanned += 1;

        const activeAllocation = await client.query(
          `SELECT a.intake_id, a.allocated_amount, i.id AS valid_intake_id
             FROM peakos_bank_allocations a
             LEFT JOIN peakos_intake i ON i.id = a.intake_id
            WHERE a.transaction_id = $1 AND a.status = 'ACTIVE'
            FOR UPDATE OF a`,
          [transaction.id],
        );
        if (activeAllocation.rows[0]) {
          const allocation = activeAllocation.rows[0];
          if (!allocation.valid_intake_id
              || String(allocation.allocated_amount) !== String(transaction.amount)) {
            const error = new Error('활성 입금 할당의 대상 또는 금액이 거래와 일치하지 않습니다.');
            error.code = 'BANK_RECONCILIATION_INVALID_ALLOCATION';
            throw error;
          }
          await client.query(
            `UPDATE peakos_bank_transactions
                SET reconciliation_status = 'MATCHED', updated_at = NOW()
              WHERE id = $1`,
            [transaction.id],
          );
          counts.alreadyMatched += 1;
          await client.query('COMMIT');
          continue;
        }

        const candidates = await findLockedCandidates(client, transaction);
        if (candidates.length > 1) {
          await markProposed(client, transaction, candidates.length, safeRequestId);
          counts.proposed += 1;
        } else if (candidates.length === 1) {
          const result = await applyExactMatch(client, transaction, candidates[0], safeRequestId);
          if (result === 'matched') counts.matched += 1;
          else if (result === 'alreadyMatched') counts.alreadyMatched += 1;
        } else {
          await markUnmatched(client, transaction, safeRequestId);
          counts.unmatched += 1;
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        counts.failed += 1;
        await client.query('BEGIN');
        try {
          await recordTransactionFailure(client, pendingRow.id, safeRequestId, error);
          await client.query('COMMIT');
        } catch (_) {
          await client.query('ROLLBACK').catch(() => {});
        }
      }
    }
    return counts;
  } finally {
    client.release();
  }
}

module.exports = {
  SALES_ACCOUNT_ID,
  ensurePeakosBankReconciliationInfrastructure,
  normalizePartyName,
  reconcileAccountTransactions,
};
