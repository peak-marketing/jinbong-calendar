'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  AUTO_MATCH_MAX_AGE_DAYS,
  isWithinAutoMatchWindow,
} = require('./peakos-auto-match-policy');

const CREDIT_ACCOUNT_IDS = Object.freeze(['ibk-review-space', 'ibk-reward-space']);
const CREDIT_ACCOUNT_ID_SET = new Set(CREDIT_ACCOUNT_IDS);
const CREDIT_REQUEST_STATUSES = Object.freeze(['PENDING', 'APPROVED', 'CANCELLED']);
const SYSTEM_UID = 'system:credit-request-reconciliation';
const SYSTEM_NAME = '충전금 자동 입금확인';
const AUTO_APPROVAL_REASON = '충전 요청 통장 자동 승인';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP_WITH_ZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;

const REQUEST_COLUMNS = `id, requester_uid, requester_name, target_account_id,
  request_date, client, depositor_name, product, vendor, expected_amount,
  point_amount, memo, status, bank_transaction_id, approved_at, cancelled_at,
  created_at, updated_at`;

class CreditRequestValidationError extends Error {
  constructor(message, code = 'CREDIT_REQUEST_INVALID') {
    super(message);
    this.name = 'CreditRequestValidationError';
    this.code = code;
    this.statusCode = 400;
  }
}

class CreditRequestConflictError extends Error {
  constructor(message, code = 'CREDIT_REQUEST_CONFLICT') {
    super(message);
    this.name = 'CreditRequestConflictError';
    this.code = code;
    this.statusCode = 409;
  }
}

function validateText(value, fieldName, maxLength, { optional = false } = {}) {
  if (value === null || value === undefined) {
    if (optional) return '';
    throw new CreditRequestValidationError(`${fieldName}을(를) 입력해 주세요.`);
  }
  if (typeof value !== 'string') {
    throw new CreditRequestValidationError(`${fieldName} 형식이 올바르지 않습니다.`);
  }
  if (/\p{Cc}/u.test(value)) {
    throw new CreditRequestValidationError(`${fieldName}에 허용되지 않는 문자가 있습니다.`);
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized && !optional) {
    throw new CreditRequestValidationError(`${fieldName}을(를) 입력해 주세요.`);
  }
  if (normalized.length > maxLength) {
    throw new CreditRequestValidationError(`${fieldName}은(는) ${maxLength}자 이하여야 합니다.`);
  }
  return normalized;
}

function parsePositiveInteger(value, fieldName) {
  let parsed;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    throw new CreditRequestValidationError(`${fieldName}은(는) 0보다 큰 정수여야 합니다.`);
  }
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CreditRequestValidationError(`${fieldName}은(는) 0보다 큰 정수여야 합니다.`);
  }
  return parsed;
}

function parseRequestDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CreditRequestValidationError('요청일은 YYYY-MM-DD 형식이어야 합니다.');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new CreditRequestValidationError('요청일이 올바르지 않습니다.');
  }
  return value;
}

function parseOptionalTimestamp(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return new Date(value.getTime());
    throw new CreditRequestValidationError(`${fieldName} 일시가 올바르지 않습니다.`);
  }
  if (typeof value !== 'string' || !TIMESTAMP_WITH_ZONE_PATTERN.test(value.trim())) {
    throw new CreditRequestValidationError(`${fieldName}에는 시간대가 포함된 ISO 8601 일시가 필요합니다.`);
  }
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new CreditRequestValidationError(`${fieldName} 일시가 올바르지 않습니다.`);
  }
  return parsed;
}

function normalizeDepositorName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ko-KR')
    .replace(/\s+/gu, '');
}

function normalizeCreateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CreditRequestValidationError('충전 요청 내용이 필요합니다.');
  }
  const targetAccountId = String(body.targetAccountId ?? body.target_account_id ?? '').trim();
  if (!CREDIT_ACCOUNT_ID_SET.has(targetAccountId)) {
    throw new CreditRequestValidationError('충전 요청 대상 통장이 올바르지 않습니다.');
  }
  return {
    targetAccountId,
    requestDate: parseRequestDate(body.requestDate ?? body.request_date ?? body.date),
    client: validateText(body.client, '거래처', 200),
    depositorName: validateText(body.depositorName ?? body.depositor_name, '입금자명', 160),
    product: validateText(body.product, '상품', 120),
    vendor: validateText(body.vendor, '공급처', 120),
    expectedAmount: parsePositiveInteger(body.expectedAmount ?? body.expected_amount, '예상 입금액'),
    pointAmount: parsePositiveInteger(body.pointAmount ?? body.point_amount, '충전 포인트'),
    memo: validateText(body.memo ?? '', '메모', 500, { optional: true }),
  };
}

function normalizeActor(actor) {
  return {
    uid: validateText(actor?.uid, '요청자 식별자', 256),
    name: validateText(actor?.name, '요청자 이름', 120),
  };
}

function parseIdempotencyKey(req) {
  const raw = typeof req.get === 'function'
    ? req.get('Idempotency-Key')
    : req.headers?.['idempotency-key'];
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw).trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new CreditRequestValidationError(
      'Idempotency-Key는 8~120자의 영문, 숫자, 점, 밑줄, 콜론 또는 하이픈이어야 합니다.',
      'CREDIT_REQUEST_INVALID_IDEMPOTENCY_KEY',
    );
  }
  return value;
}

function formatDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
}

function publicInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : String(value);
}

function publicCreditRequest(row) {
  return {
    id: String(row.id),
    requesterUid: row.requester_uid,
    requesterName: row.requester_name,
    targetAccountId: row.target_account_id,
    requestDate: formatDate(row.request_date),
    client: row.client,
    depositorName: row.depositor_name,
    product: row.product,
    vendor: row.vendor,
    expectedAmount: publicInteger(row.expected_amount),
    pointAmount: publicInteger(row.point_amount),
    memo: row.memo || '',
    status: row.status,
    bankTransactionId: row.bank_transaction_id === null || row.bank_transaction_id === undefined
      ? null
      : String(row.bank_transaction_id),
    approvedAt: row.approved_at || null,
    cancelledAt: row.cancelled_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sameCreatePayload(row, input) {
  return row.target_account_id === input.targetAccountId
    && formatDate(row.request_date) === input.requestDate
    && row.client === input.client
    && row.depositor_name === input.depositorName
    && row.product === input.product
    && row.vendor === input.vendor
    && String(row.expected_amount) === String(input.expectedAmount)
    && String(row.point_amount) === String(input.pointAmount)
    && String(row.memo || '') === input.memo;
}

function approvedAndActive(req) {
  return Boolean(
    req.uid
      && req.userDoc
      && req.userDoc.approved === true
      && req.userDoc.is_active !== false,
  );
}

function logFailure(logger, label, error) {
  if (!logger || typeof logger.error !== 'function') return;
  const code = /^[A-Z0-9_]{2,80}$/.test(String(error?.code || ''))
    ? String(error.code)
    : 'UNEXPECTED';
  logger.error(`${label}: ${code}`);
}

function sendError(res, error, fallbackMessage, logger, label) {
  if (error instanceof CreditRequestValidationError || error instanceof CreditRequestConflictError) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  logFailure(logger, label, error);
  return res.status(500).json({ error: fallbackMessage });
}

async function ensurePeakosCreditRequestInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  const migrationPath = path.join(__dirname, '..', 'migrations', '20260807_peakos_credit_requests.sql');
  await pool.query(fs.readFileSync(migrationPath, 'utf8'));
}

function registerPeakosCreditRequests({
  app,
  authMiddleware,
  pool,
  canReview,
  getActor,
  logger = console,
}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function' || typeof app.delete !== 'function') {
    throw new TypeError('Express app의 get/post/delete가 필요합니다.');
  }
  if (typeof authMiddleware !== 'function') throw new TypeError('authMiddleware가 필요합니다.');
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  const reviewAllowed = typeof canReview === 'function' ? canReview : () => false;
  const actorOf = typeof getActor === 'function'
    ? getActor
    : req => ({ uid: req.uid, name: req.userDoc?.name || '' });

  app.get('/api/peakos/credit-requests', authMiddleware, async (req, res) => {
    if (!approvedAndActive(req)) return res.status(403).json({ error: '승인된 사용자만 충전 요청을 볼 수 있습니다.' });
    try {
      const scope = String(req.query?.scope || 'mine').trim();
      if (!['mine', 'all'].includes(scope)) {
        throw new CreditRequestValidationError('scope는 mine 또는 all이어야 합니다.');
      }
      if (scope === 'all' && reviewAllowed(req) !== true) {
        return res.status(403).json({ error: '전체 충전 요청 검토 권한이 없습니다.' });
      }
      const result = scope === 'all'
        ? await pool.query(`SELECT ${REQUEST_COLUMNS} FROM peakos_credit_requests ORDER BY created_at DESC, id DESC`)
        : await pool.query(
          `SELECT ${REQUEST_COLUMNS} FROM peakos_credit_requests
            WHERE requester_uid = $1 ORDER BY created_at DESC, id DESC`,
          [String(req.uid)],
        );
      res.set?.('Cache-Control', 'no-store');
      return res.json({ requests: result.rows.map(publicCreditRequest), scope });
    } catch (error) {
      return sendError(res, error, '충전 요청을 불러오지 못했습니다.', logger, 'credit request read failed');
    }
  });

  app.post('/api/peakos/credit-requests', authMiddleware, async (req, res) => {
    if (!approvedAndActive(req)) return res.status(403).json({ error: '승인된 사용자만 충전을 요청할 수 있습니다.' });
    try {
      const input = normalizeCreateInput(req.body);
      const actor = normalizeActor(actorOf(req));
      const idempotencyKey = parseIdempotencyKey(req);
      const id = crypto.randomUUID();
      const inserted = await pool.query(
        `INSERT INTO peakos_credit_requests
          (id, requester_uid, requester_name, target_account_id, request_date,
           client, depositor_name, product, vendor, expected_amount, point_amount,
           memo, status, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING',$13)
         ON CONFLICT DO NOTHING
         RETURNING ${REQUEST_COLUMNS}`,
        [
          id,
          actor.uid,
          actor.name,
          input.targetAccountId,
          input.requestDate,
          input.client,
          input.depositorName,
          input.product,
          input.vendor,
          input.expectedAmount,
          input.pointAmount,
          input.memo,
          idempotencyKey,
        ],
      );
      let row = inserted.rows[0];
      let created = true;
      if (!row) {
        if (!idempotencyKey) {
          throw new CreditRequestConflictError('충전 요청 식별자를 만들지 못했습니다. 다시 시도해 주세요.');
        }
        const existing = await pool.query(
          `SELECT ${REQUEST_COLUMNS} FROM peakos_credit_requests
            WHERE requester_uid = $1 AND idempotency_key = $2`,
          [actor.uid, idempotencyKey],
        );
        row = existing.rows[0];
        if (!row || !sameCreatePayload(row, input)) {
          throw new CreditRequestConflictError(
            '같은 Idempotency-Key가 다른 충전 요청에 이미 사용되었습니다.',
            'CREDIT_REQUEST_IDEMPOTENCY_CONFLICT',
          );
        }
        created = false;
      }
      res.set?.('Cache-Control', 'no-store');
      res.set?.('Location', `/api/peakos/credit-requests/${row.id}`);
      return res.status(created ? 201 : 200).json({ request: publicCreditRequest(row), created });
    } catch (error) {
      return sendError(res, error, '충전 요청을 저장하지 못했습니다.', logger, 'credit request create failed');
    }
  });

  app.delete('/api/peakos/credit-requests/:id', authMiddleware, async (req, res) => {
    if (!approvedAndActive(req)) return res.status(403).json({ error: '승인된 사용자만 충전 요청을 취소할 수 있습니다.' });
    try {
      const id = String(req.params?.id || '').trim();
      if (!UUID_PATTERN.test(id)) throw new CreditRequestValidationError('충전 요청 ID가 올바르지 않습니다.');
      const reviewer = reviewAllowed(req) === true;
      const cancelled = await pool.query(
        `UPDATE peakos_credit_requests
            SET status = 'CANCELLED', cancelled_at = NOW(), updated_at = NOW()
          WHERE id = $1
            AND status = 'PENDING'
            AND (requester_uid = $2 OR $3::boolean)
        RETURNING ${REQUEST_COLUMNS}`,
        [id, String(req.uid), reviewer],
      );
      if (!cancelled.rows[0]) {
        const existing = await pool.query(
          'SELECT requester_uid, status FROM peakos_credit_requests WHERE id = $1',
          [id],
        );
        if (!existing.rows[0]) return res.status(404).json({ error: '충전 요청을 찾지 못했습니다.' });
        if (!reviewer && existing.rows[0].requester_uid !== String(req.uid)) {
          return res.status(403).json({ error: '다른 사용자의 충전 요청은 취소할 수 없습니다.' });
        }
        return res.status(409).json({ error: '대기 중인 충전 요청만 취소할 수 있습니다.' });
      }
      res.set?.('Cache-Control', 'no-store');
      return res.json({ request: publicCreditRequest(cancelled.rows[0]), cancelled: id });
    } catch (error) {
      return sendError(res, error, '충전 요청을 취소하지 못했습니다.', logger, 'credit request cancel failed');
    }
  });
}

function cleanRequestId(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, 160) : null;
}

function emptyReconciliationCounts(accountId, ineligibleAccount = false) {
  return {
    accountId,
    ineligibleAccount,
    scanned: 0,
    approved: 0,
    proposed: 0,
    unmatched: 0,
    alreadyApproved: 0,
    failed: 0,
  };
}

async function writeSystemAudit(client, {
  action,
  entityType,
  entityId,
  requestId,
  reason,
  metadata,
}) {
  await client.query(
    `INSERT INTO peakos_bank_audit_log
      (action, entity_type, entity_id, actor_uid, actor_name, request_id, reason, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      action,
      entityType,
      String(entityId),
      SYSTEM_UID,
      SYSTEM_NAME,
      requestId,
      reason,
      JSON.stringify(metadata || {}),
    ],
  );
}

async function lockBankTransaction(client, transactionId) {
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

async function findExactCreditCandidates(client, transaction) {
  const result = await client.query(
    `SELECT id, requester_uid, requester_name, target_account_id, request_date,
            client, depositor_name, product, vendor, expected_amount,
            point_amount, memo, created_at
       FROM peakos_credit_requests
      WHERE target_account_id = $1
        AND status = 'PENDING'
        AND expected_amount = $2::bigint
        AND $4::integer > 0
        AND created_at >= $3::timestamptz - ($4::integer * INTERVAL '1 day')
        AND created_at <= $3::timestamptz + INTERVAL '1 hour'
      ORDER BY created_at, id
      FOR UPDATE`,
    [
      transaction.account_id,
      transaction.amount,
      transaction.transaction_at,
      AUTO_MATCH_MAX_AGE_DAYS,
    ],
  );
  const incomingName = normalizeDepositorName(transaction.counterparty_name);
  if (!incomingName) return [];
  return result.rows.filter(candidate => (
    isWithinAutoMatchWindow(candidate.created_at, transaction.transaction_at)
      && normalizeDepositorName(candidate.depositor_name) === incomingName
  ));
}

async function markProposed(client, transaction, candidateCount, requestId) {
  const updated = await client.query(
    `UPDATE peakos_bank_transactions
        SET reconciliation_status = 'PROPOSED', updated_at = NOW()
      WHERE id = $1 AND reconciliation_status <> 'PROPOSED'
      RETURNING id`,
    [transaction.id],
  );
  if (!updated.rows[0]) return;
  await writeSystemAudit(client, {
    action: 'CREDIT_REQUEST_AUTO_MATCH_PROPOSED',
    entityType: 'BANK_TRANSACTION',
    entityId: transaction.id,
    requestId,
    reason: '정확히 일치하는 대기 요청이 여러 건입니다.',
    metadata: {
      accountId: transaction.account_id,
      candidateCount,
      method: 'EXACT_AMOUNT_DEPOSITOR',
    },
  });
}

async function clearProposal(client, transaction, requestId) {
  const updated = await client.query(
    `UPDATE peakos_bank_transactions
        SET reconciliation_status = 'UNMATCHED', updated_at = NOW()
      WHERE id = $1 AND reconciliation_status = 'PROPOSED'
      RETURNING id`,
    [transaction.id],
  );
  if (!updated.rows[0]) return;
  await writeSystemAudit(client, {
    action: 'CREDIT_REQUEST_AUTO_MATCH_PROPOSAL_CLEARED',
    entityType: 'BANK_TRANSACTION',
    entityId: transaction.id,
    requestId,
    reason: '정확히 일치하는 대기 요청이 없습니다.',
    metadata: {
      accountId: transaction.account_id,
      candidateCount: 0,
      method: 'EXACT_AMOUNT_DEPOSITOR',
    },
  });
}

async function findApprovedRequestForTransaction(client, transactionId) {
  const result = await client.query(
    `SELECT r.id, r.target_account_id, r.expected_amount, r.point_amount,
            c.id AS ledger_id, c.paid AS ledger_paid, c.point AS ledger_point
       FROM peakos_credit_requests r
       LEFT JOIN peakos_credit c ON c.id = r.id
      WHERE r.bank_transaction_id = $1 AND r.status = 'APPROVED'
      FOR UPDATE OF r`,
    [transactionId],
  );
  return result.rows[0] || null;
}

function assertCreditApprovalInvariant(transaction, candidate) {
  const transactionAccountId = typeof transaction?.account_id === 'string'
    ? transaction.account_id.trim()
    : '';
  const candidateAccountId = typeof candidate?.target_account_id === 'string'
    ? candidate.target_account_id.trim()
    : '';
  const matches = Boolean(transaction
    && candidate
    && transaction.direction === 'DEPOSIT'
    && transactionAccountId
    && candidateAccountId
    && transactionAccountId === candidateAccountId
    && transaction.amount !== null
    && transaction.amount !== undefined
    && candidate.expected_amount !== null
    && candidate.expected_amount !== undefined
    && String(transaction.amount) === String(candidate.expected_amount));
  if (!matches) {
    throw new CreditRequestConflictError(
      '충전 요청과 은행 거래의 통장·입출금 구분·금액이 일치하지 않습니다.',
      'CREDIT_REQUEST_BANK_TRANSACTION_MISMATCH',
    );
  }
}

async function approveExactCandidate(client, transaction, candidate, requestId) {
  assertCreditApprovalInvariant(transaction, candidate);
  await client.query(
    `INSERT INTO peakos_credit
      (id, owner_uid, owner_name, date, client, product, vendor, kind, paid, point, memo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'charge',$8,$9,$10)`,
    [
      candidate.id,
      candidate.requester_uid,
      candidate.requester_name,
      candidate.request_date,
      candidate.client,
      candidate.product,
      candidate.vendor,
      candidate.expected_amount,
      candidate.point_amount,
      candidate.memo || '',
    ],
  );

  const approved = await client.query(
    `UPDATE peakos_credit_requests
        SET status = 'APPROVED', bank_transaction_id = $2,
            approved_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING' AND bank_transaction_id IS NULL
        AND target_account_id = $3
        AND expected_amount = $4::bigint
        AND EXISTS (
          SELECT 1
            FROM peakos_bank_transactions transaction_guard
           WHERE transaction_guard.id = $2
             AND transaction_guard.account_id = peakos_credit_requests.target_account_id
             AND transaction_guard.direction = 'DEPOSIT'
             AND transaction_guard.amount = peakos_credit_requests.expected_amount
        )
      RETURNING id`,
    [candidate.id, transaction.id, transaction.account_id, transaction.amount],
  );
  if (!approved.rows[0]) {
    const error = new CreditRequestConflictError(
      '충전 요청 상태가 변경되어 자동 승인하지 않았습니다.',
      'CREDIT_REQUEST_STALE_CANDIDATE',
    );
    throw error;
  }

  await client.query(
    `UPDATE peakos_bank_transactions
        SET reconciliation_status = 'MATCHED', updated_at = NOW()
      WHERE id = $1`,
    [transaction.id],
  );
  await writeSystemAudit(client, {
    action: 'CREDIT_REQUEST_AUTO_APPROVED',
    entityType: 'CREDIT_REQUEST',
    entityId: candidate.id,
    requestId,
    reason: AUTO_APPROVAL_REASON,
    metadata: {
      accountId: transaction.account_id,
      bankTransactionId: String(transaction.id),
      expectedAmount: String(candidate.expected_amount),
      pointAmount: String(candidate.point_amount),
      method: 'EXACT_AMOUNT_DEPOSITOR',
    },
  });
}

async function reconcileCreditRequests({
  pool,
  accountId,
  from = null,
  to = null,
  requestId = null,
} = {}) {
  const normalizedAccountId = String(accountId || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,79}$/i.test(normalizedAccountId)) {
    throw new CreditRequestValidationError('accountId 형식이 올바르지 않습니다.');
  }
  if (!CREDIT_ACCOUNT_ID_SET.has(normalizedAccountId)) {
    return emptyReconciliationCounts(normalizedAccountId, true);
  }
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect가 필요합니다.');
  const rangeFrom = parseOptionalTimestamp(from, 'from');
  const rangeTo = parseOptionalTimestamp(to, 'to');
  if (rangeFrom && rangeTo && rangeFrom >= rangeTo) {
    throw new CreditRequestValidationError('to는 from보다 뒤여야 합니다.');
  }
  const safeRequestId = cleanRequestId(requestId);
  const counts = emptyReconciliationCounts(normalizedAccountId);
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
        const transaction = await lockBankTransaction(client, pendingRow.id);
        if (!transaction
            || transaction.account_id !== normalizedAccountId
            || transaction.direction !== 'DEPOSIT'
            || !['UNMATCHED', 'PROPOSED'].includes(transaction.reconciliation_status)) {
          await client.query('COMMIT');
          continue;
        }
        counts.scanned += 1;

        const alreadyApproved = await findApprovedRequestForTransaction(client, transaction.id);
        if (alreadyApproved) {
          assertCreditApprovalInvariant(transaction, alreadyApproved);
          if (!alreadyApproved.ledger_id
              || String(alreadyApproved.expected_amount) !== String(alreadyApproved.ledger_paid)
              || String(alreadyApproved.point_amount) !== String(alreadyApproved.ledger_point)) {
            const error = new CreditRequestConflictError(
              '승인 요청과 충전금 장부가 일치하지 않습니다.',
              'CREDIT_REQUEST_INVALID_APPROVED_LEDGER',
            );
            throw error;
          }
          await client.query(
            `UPDATE peakos_bank_transactions
                SET reconciliation_status = 'MATCHED', updated_at = NOW()
              WHERE id = $1`,
            [transaction.id],
          );
          counts.alreadyApproved += 1;
          await client.query('COMMIT');
          continue;
        }

        const candidates = await findExactCreditCandidates(client, transaction);
        if (candidates.length > 1) {
          await markProposed(client, transaction, candidates.length, safeRequestId);
          counts.proposed += 1;
        } else if (candidates.length === 1) {
          await approveExactCandidate(client, transaction, candidates[0], safeRequestId);
          counts.approved += 1;
        } else {
          await clearProposal(client, transaction, safeRequestId);
          counts.unmatched += 1;
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        counts.failed += 1;
        await client.query('BEGIN');
        try {
          const errorCode = /^[A-Z0-9_]{2,80}$/.test(String(error?.code || ''))
            ? String(error.code)
            : 'CREDIT_REQUEST_RECONCILIATION_FAILED';
          await writeSystemAudit(client, {
            action: 'CREDIT_REQUEST_AUTO_MATCH_FAILED',
            entityType: 'BANK_TRANSACTION',
            entityId: pendingRow.id,
            requestId: safeRequestId,
            reason: '충전 요청 자동 승인 재시도 필요',
            metadata: { errorCode, retryable: true },
          });
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
  CREDIT_ACCOUNT_IDS,
  CREDIT_REQUEST_STATUSES,
  CreditRequestConflictError,
  CreditRequestValidationError,
  assertCreditApprovalInvariant,
  ensurePeakosCreditRequestInfrastructure,
  normalizeCreateInput,
  normalizeDepositorName,
  publicCreditRequest,
  reconcileCreditRequests,
  registerPeakosCreditRequests,
};
