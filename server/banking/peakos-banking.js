'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 10000;
const MAX_IMPORT_ROWS = 2000;
const ALLOWED_DIRECTIONS = new Set(['DEPOSIT', 'WITHDRAWAL']);
const ALLOWED_STATUSES = new Set(['UNMATCHED', 'PROPOSED', 'MATCHED', 'IGNORED', 'REVERSED']);
const ALLOWED_SOURCES = new Set(['BANK_SYNC', 'CSV_IMPORT', 'COLLECTOR']);
const ALLOWED_SYNC_TRIGGERS = new Set(['MANUAL', 'SCHEDULED']);
const PUBLIC_ACCOUNT_IDS = Object.freeze([
  'ibk-hq-sales',
  'ibk-review-space',
  'ibk-reward-space',
]);
const PUBLIC_ACCOUNT_ID_SET = new Set(PUBLIC_ACCOUNT_IDS);
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,79}$/i;
const ISO_TIMESTAMP_WITH_ZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

class BankValidationError extends Error {
  constructor(message, code = 'BANK_INVALID_REQUEST') {
    super(message);
    this.name = 'BankValidationError';
    this.code = code;
  }
}

class BankSyncError extends Error {
  constructor(message, code = 'BANK_SYNC_FAILED', statusCode = 502, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'BankSyncError';
    this.code = code;
    this.statusCode = statusCode;
    this.recordFailure = options.recordFailure !== false;
    this.requestId = options.requestId || null;
  }
}

function cleanText(value, maxLength = 300) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
}

function parsePositiveInteger(value, fieldName) {
  const parsed = parseStrictInteger(value, fieldName);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new BankValidationError(`${fieldName}은 0보다 큰 정수여야 합니다.`);
  }
  return parsed;
}

function parseOptionalInteger(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  return parseStrictInteger(value, fieldName);
}

function parseStrictInteger(value, fieldName) {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return value;
    throw new BankValidationError(`${fieldName} 형식이 올바르지 않습니다.`);
  }
  if (typeof value !== 'string') {
    throw new BankValidationError(`${fieldName} 형식이 올바르지 않습니다.`);
  }
  const text = value.trim();
  // 정수 또는 올바른 3자리 쉼표 표기만 허용한다. 소수점·지수·임의 문자는
  // 제거해서 다른 금액으로 해석하지 않고 즉시 거부한다.
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\s*원)?$/.test(text)) {
    throw new BankValidationError(`${fieldName} 형식이 올바르지 않습니다.`);
  }
  const parsed = Number(text.replace(/\s*원$/, '').replace(/,/g, ''));
  if (!Number.isSafeInteger(parsed)) {
    throw new BankValidationError(`${fieldName} 형식이 올바르지 않습니다.`);
  }
  return parsed;
}

function parseTimestamp(value, fieldName = '거래일시') {
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return new Date(value.getTime());
    throw new BankValidationError(`${fieldName} 형식이 올바르지 않습니다.`);
  }
  if (typeof value !== 'string' || !ISO_TIMESTAMP_WITH_ZONE_PATTERN.test(value.trim())) {
    throw new BankValidationError(`${fieldName}에는 시간대가 포함된 ISO 8601 일시가 필요합니다.`);
  }
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) throw new BankValidationError(`${fieldName} 형식이 올바르지 않습니다.`);
  return date;
}

function parsePageInteger(value, fieldName, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value) || !/^\d+$/.test(String(value))) {
    throw new BankValidationError(`${fieldName}은 정수여야 합니다.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new BankValidationError(`${fieldName} 범위가 올바르지 않습니다.`);
  }
  return parsed;
}

function maskAccountNumber(value) {
  const raw = cleanText(value, 80);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 5) return '*'.repeat(Math.max(4, digits.length));
  const suffixLength = Math.min(4, digits.length - 2);
  return `${digits.slice(0, 2)}-${'*'.repeat(Math.max(4, digits.length - 2 - suffixLength))}-${digits.slice(-suffixLength)}`;
}

function normalizeMaskedAccountNumber(value) {
  const raw = cleanText(value, 80);
  if (!raw) return null;
  const normalized = raw.replace(/[xX•●]/g, '*').replace(/\s+/g, '');
  const digits = normalized.replace(/\D/g, '');
  const masks = normalized.match(/\*/g) || [];
  if (!/^[0-9*-]+$/.test(normalized) || masks.length < 4 || digits.length > 6 || /\d{5,}/.test(normalized)) {
    throw new BankValidationError('계좌번호는 전체 번호가 아닌 마스킹된 값만 저장할 수 있습니다.');
  }
  return normalized;
}

function stableTransactionKey(accountId, row) {
  const sourceKey = cleanText(row.providerTransactionKey || row.transactionKey, 240);
  if (sourceKey) {
    return crypto.createHash('sha256').update(`${accountId}\u0000${sourceKey}`).digest('hex');
  }
  return crypto.createHash('sha256').update(JSON.stringify({
    accountId,
    transactionAt: row.transactionAt,
    direction: row.direction || row.type,
    amount: row.amount,
    balance: row.balance,
    summary: row.summary,
    counterpartyName: row.counterpartyName,
    branch: row.branch,
  })).digest('hex');
}

function normalizeBankTransaction(accountId, row, source = 'COLLECTOR') {
  if (!ACCOUNT_ID_PATTERN.test(String(accountId || ''))) {
    throw new BankValidationError('통장 ID 형식이 올바르지 않습니다.');
  }
  if (!ALLOWED_SOURCES.has(source)) throw new BankValidationError('거래 출처가 올바르지 않습니다.');
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new BankValidationError('거래 데이터가 비어 있습니다.');
  }
  if (source === 'BANK_SYNC'
      && !cleanText(row.providerTransactionKey || row.transactionKey, 240)) {
    throw new BankValidationError(
      '은행 동기화 거래에는 제공기관 거래 식별자가 필요합니다.',
      'BANK_PROVIDER_TRANSACTION_KEY_REQUIRED',
    );
  }
  if (source === 'BANK_SYNC' && typeof row.providerKeyStable !== 'boolean') {
    throw new BankValidationError(
      '은행 동기화 거래의 제공기관 식별자 안정성 표시가 필요합니다.',
      'BANK_PROVIDER_KEY_STABILITY_REQUIRED',
    );
  }
  const direction = String(row.direction || row.type || '').trim().toUpperCase();
  if (!ALLOWED_DIRECTIONS.has(direction)) {
    throw new BankValidationError('입출금 구분은 DEPOSIT 또는 WITHDRAWAL이어야 합니다.');
  }
  const transactionAt = parseTimestamp(row.transactionAt || row.transaction_at);
  const amount = parsePositiveInteger(row.amount, '거래금액');
  const balance = parseOptionalInteger(row.balance, '거래 후 잔액');
  const providerTransactionKey = stableTransactionKey(accountId, {
    ...row,
    transactionAt: transactionAt.toISOString(),
    direction,
    amount,
    balance,
  });

  return {
    accountId,
    providerTransactionKey,
    providerKeyStable: row.providerKeyStable === true,
    transactionAt,
    direction,
    amount,
    balance,
    summary: cleanText(row.summary, 300),
    counterpartyName: cleanText(row.counterpartyName || row.counterparty_name, 160),
    counterpartyAccountMasked: maskAccountNumber(
      row.counterpartyAccountMasked || row.counterpartyAccount || row.counterparty_account,
    ),
    branchText: cleanText(row.branch || row.branchText, 160),
    source,
  };
}

function asMoneyNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : String(value);
}

function publicAccount(row, { includeBalance = false } = {}) {
  return {
    id: row.id,
    provider: row.provider,
    bankName: row.bank_name,
    displayName: row.display_name,
    branchId: row.branch_id,
    accountNumberMasked: row.account_number_masked,
    currency: row.currency,
    purpose: row.purpose || '',
    active: Boolean(row.is_active),
    latestBalance: includeBalance ? asMoneyNumber(row.latest_balance) : null,
    latestBalanceAt: includeBalance ? row.latest_balance_at : null,
    lastSyncStartedAt: row.last_sync_started_at,
    lastSyncSucceededAt: row.last_sync_succeeded_at,
    lastSyncError: row.last_sync_error ? '최근 동기화에 실패했습니다.' : null,
    unmatchedCount: Number(row.unmatched_count || 0),
  };
}

function publicTransaction(row, { includeBalance = false } = {}) {
  return {
    id: String(row.id),
    accountId: row.account_id,
    transactionAt: row.transaction_at,
    direction: row.direction,
    amount: asMoneyNumber(row.amount),
    balance: includeBalance ? asMoneyNumber(row.balance) : null,
    summary: row.summary || '',
    counterpartyName: row.counterparty_name || '',
    counterpartyAccountMasked: row.counterparty_account_masked || '',
    branch: row.branch_text || '',
    status: row.reconciliation_status,
    source: row.source,
    firstSeenAt: row.first_seen_at,
  };
}

function requestIp(req) {
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real.slice(0, 80);
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop()?.trim();
  return (forwarded || req.socket?.remoteAddress || '').slice(0, 80);
}

function safeErrorMessage(error) {
  const message = cleanText(error?.message || error, 500) || '알 수 없는 오류';
  return message
    // 하이픈·공백이 들어간 계좌·식별번호도 로그에 남지 않는다.
    .replace(/(?:\d[\s-]?){8,}\d/g, '[계좌정보 마스킹]')
    .replace(/(password|passwd|secret|token|identity|pin|비밀번호|식별번호)\s*[=:]\s*\S+/gi, '$1=[마스킹]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [마스킹]');
}

function isPublicAccountId(accountId) {
  return PUBLIC_ACCOUNT_ID_SET.has(String(accountId || '').trim());
}

function publicSyncRun(row) {
  return {
    id: String(row.id),
    accountId: row.account_id,
    status: row.status,
    triggerType: row.trigger_type,
    requestedByName: row.requested_by_name || '',
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    rangeFrom: row.range_from,
    rangeTo: row.range_to,
    fetchedCount: Number(row.fetched_count || 0),
    insertedCount: Number(row.inserted_count || 0),
    updatedCount: Number(row.updated_count || 0),
    errorCode: row.error_code || null,
    errorMessage: row.error_message ? '동기화에 실패했습니다.' : null,
    requestId: row.request_id || null,
  };
}

async function ensurePeakosBankInfrastructure(pool) {
  const migrationPath = path.join(__dirname, '..', 'migrations', '20260806_peakos_banking.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  await pool.query(sql);
}

function normalizeAuditContext(context) {
  if (!context) return { requestId: null, ipAddress: null };
  return {
    requestId: cleanText(context.requestId || context.bankRequestId, 120),
    ipAddress: context.ipAddress !== undefined
      ? cleanText(context.ipAddress, 80)
      : (context.headers ? requestIp(context) : null),
  };
}

async function insertAudit(client, context, actor, action, entityType, entityId, reason, metadata = {}) {
  const auditContext = normalizeAuditContext(context);
  await client.query(
    `INSERT INTO peakos_bank_audit_log
      (action, entity_type, entity_id, actor_uid, actor_name, request_id, ip_address, reason, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      action,
      entityType,
      String(entityId),
      actor.uid || null,
      actor.name || null,
      auditContext.requestId,
      auditContext.ipAddress,
      cleanText(reason, 500),
      JSON.stringify(metadata || {}),
    ],
  );
}

async function saveTransactions(client, accountId, rows, source) {
  if (!Array.isArray(rows) || rows.length > MAX_IMPORT_ROWS) {
    throw new BankValidationError(`거래내역은 한 번에 ${MAX_IMPORT_ROWS}건까지 반영할 수 있습니다.`);
  }
  let inserted = 0;
  let updated = 0;
  let latest = null;
  let latestWithBalance = null;
  let latestBalanceAmbiguous = false;
  const normalizedRows = rows.map((input, index) => {
    try {
      return normalizeBankTransaction(accountId, input, source);
    } catch (error) {
      if (error instanceof BankValidationError) {
        throw new BankValidationError(`${index + 1}번째 거래: ${error.message}`, error.code);
      }
      throw error;
    }
  });
  const seenKeys = new Set();
  for (const row of normalizedRows) {
    if (seenKeys.has(row.providerTransactionKey)) {
      throw new BankValidationError('한 요청 안에 중복된 거래가 있습니다.', 'BANK_DUPLICATE_TRANSACTION');
    }
    seenKeys.add(row.providerTransactionKey);
  }

  for (const row of normalizedRows) {
    const result = await client.query(
      `INSERT INTO peakos_bank_transactions AS existing
        (account_id, provider_transaction_key, provider_key_stable, transaction_at, direction, amount, balance,
         summary, counterparty_name, counterparty_account_masked, branch_text, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (account_id, provider_transaction_key) DO UPDATE SET
         balance = EXCLUDED.balance,
         summary = EXCLUDED.summary,
         counterparty_name = EXCLUDED.counterparty_name,
         counterparty_account_masked = EXCLUDED.counterparty_account_masked,
         branch_text = EXCLUDED.branch_text,
         provider_key_stable = existing.provider_key_stable AND EXCLUDED.provider_key_stable,
         last_seen_at = NOW(),
         updated_at = NOW()
       WHERE existing.transaction_at = EXCLUDED.transaction_at
         AND existing.direction = EXCLUDED.direction
         AND existing.amount = EXCLUDED.amount
       RETURNING (xmax = 0) AS inserted`,
      [
        row.accountId,
        row.providerTransactionKey,
        row.providerKeyStable,
        row.transactionAt,
        row.direction,
        row.amount,
        row.balance,
        row.summary,
        row.counterpartyName,
        row.counterpartyAccountMasked,
        row.branchText,
        row.source,
      ],
    );
    if (!result.rows[0]) {
      throw new BankValidationError(
        '같은 제공기관 거래 식별자에 다른 거래 핵심값이 들어왔습니다.',
        'BANK_TRANSACTION_KEY_COLLISION',
      );
    }
    if (result.rows[0].inserted) inserted += 1;
    else updated += 1;
    if (!latest || row.transactionAt > latest.transactionAt) latest = row;
    if (row.balance !== null) {
      if (!latestWithBalance || row.transactionAt > latestWithBalance.transactionAt) {
        latestWithBalance = row;
        latestBalanceAmbiguous = false;
      } else if (row.transactionAt.getTime() === latestWithBalance.transactionAt.getTime()
          && String(row.balance) !== String(latestWithBalance.balance)) {
        latestBalanceAmbiguous = true;
      }
    }
  }

  if (latestWithBalance) {
    // IBK quick inquiry timestamps may have only second precision. Include
    // rows saved by earlier runs before deciding whether a balance is
    // unambiguous; otherwise two separate syncs in the same second could
    // silently replace one another's account balance.
    const balanceCheck = await client.query(
      `SELECT COUNT(DISTINCT balance)::integer AS distinct_balance_count
         FROM peakos_bank_transactions
        WHERE account_id = $1
          AND transaction_at = $2
          AND balance IS NOT NULL`,
      [accountId, latestWithBalance.transactionAt],
    );
    latestBalanceAmbiguous = latestBalanceAmbiguous
      || Number(balanceCheck.rows[0]?.distinct_balance_count || 0) > 1;
    if (latestBalanceAmbiguous) {
      await client.query(
        `UPDATE peakos_bank_accounts
            SET latest_balance = NULL,
                latest_balance_at = $2,
                updated_at = NOW()
          WHERE id = $1
            AND ($2::timestamptz >= COALESCE(latest_balance_at, '-infinity'::timestamptz))`,
        [accountId, latestWithBalance.transactionAt],
      );
    } else {
      await client.query(
        `UPDATE peakos_bank_accounts
            SET latest_balance = $2,
                latest_balance_at = $3,
                updated_at = NOW()
          WHERE id = $1
            AND ($3::timestamptz >= COALESCE(latest_balance_at, '-infinity'::timestamptz))`,
        [accountId, latestWithBalance.balance, latestWithBalance.transactionAt],
      );
    }
  }

  return { inserted, updated, latest };
}

function registerPeakosBanking({
  app,
  authMiddleware,
  pool,
  canRead,
  canViewBalances,
  canSync,
  canManage,
  getActor,
  collector = null,
  afterSync = null,
  allowImport = false,
  autoReconciliationEnabled = false,
}) {
  const readAllowed = typeof canRead === 'function' ? canRead : () => false;
  // This callback must be UID-backed and return true only for the four people
  // approved to see restricted accounts and any balance values. Default deny
  // keeps the module safe until index.js explicitly wires the policy.
  const balanceAllowed = typeof canViewBalances === 'function' ? canViewBalances : () => false;
  const syncAllowed = typeof canSync === 'function' ? canSync : readAllowed;
  const manageAllowed = typeof canManage === 'function' ? canManage : () => false;
  const importAllowed = allowImport === true;
  const afterSyncHandler = typeof afterSync === 'function' ? afterSync : null;
  const approvedActive = req => Boolean(
    req.userDoc && req.userDoc.approved === true && req.userDoc.is_active !== false,
  );
  const allowed = (req, check) => approvedActive(req) && check(req) === true;
  const canViewBalanceData = req => allowed(req, balanceAllowed);
  const canReadBanking = req => allowed(req, readAllowed) || canViewBalanceData(req);
  const canReadAccount = (req, accountId) => (
    canViewBalanceData(req) || (canReadBanking(req) && isPublicAccountId(accountId))
  );
  const canOperateAccount = (req, accountId, operationAllowed) => (
    allowed(req, operationAllowed) && (canViewBalanceData(req) || isPublicAccountId(accountId))
  );
  const actorOf = typeof getActor === 'function'
    ? getActor
    : req => ({ uid: req.uid || '', name: req.userDoc?.name || '' });

  async function syncAccount(input = {}) {
    const accountId = String(input.accountId || '').trim();
    const triggerType = String(input.triggerType || '').trim().toUpperCase();
    const requestId = cleanText(input.requestId, 120) || crypto.randomUUID();
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new BankValidationError('통장 ID 형식이 올바르지 않습니다.');
    }
    if (!ALLOWED_SYNC_TRIGGERS.has(triggerType)) {
      throw new BankValidationError(
        '동기화 triggerType은 MANUAL 또는 SCHEDULED여야 합니다.',
        'BANK_INVALID_SYNC_TRIGGER',
      );
    }

    const rangeFrom = input.from === null || input.from === undefined || input.from === ''
      ? null
      : parseTimestamp(input.from, '시작일');
    const rangeTo = input.to === null || input.to === undefined || input.to === ''
      ? null
      : parseTimestamp(input.to, '종료일');
    if (rangeFrom && rangeTo && rangeFrom >= rangeTo) {
      throw new BankValidationError('종료일은 시작일보다 뒤여야 합니다.');
    }
    if (!collector) {
      throw new BankSyncError(
        '안전한 조회 전용 수집기가 아직 연결되지 않았습니다.',
        'BANK_COLLECTOR_NOT_CONFIGURED',
        503,
        { recordFailure: false, requestId },
      );
    }

    const actor = {
      uid: cleanText(input.actor?.uid, 160),
      name: cleanText(input.actor?.name, 160),
    };
    let client;
    try {
      client = await pool.connect();
    } catch (error) {
      console.error('peakos bank sync connection error:', safeErrorMessage(error));
      throw new BankSyncError('통장 조회에 실패했습니다.', 'BANK_SYNC_FAILED', 502, {
        cause: error,
        requestId,
      });
    }

    const lockKey = `peakos-bank-sync:${accountId}`;
    let locked = false;
    let runId = null;
    let transactionOpen = false;
    let committed = false;
    let result = null;
    let afterSyncInput = null;
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockKey]);
      locked = Boolean(lock.rows[0]?.locked);
      if (!locked) {
        throw new BankSyncError('이 통장은 이미 동기화 중입니다.', 'BANK_SYNC_IN_PROGRESS', 409, {
          recordFailure: false,
          requestId,
        });
      }

      // 세션 advisory lock을 획득했다면 실제 실행 중인 동기화는 없다. 이전
      // 프로세스가 비정상 종료하며 남긴 RUNNING 상태를 닫아 unique guard를 복구한다.
      await client.query(
        `UPDATE peakos_bank_sync_runs
            SET status = 'FAILED', finished_at = NOW(), error_code = 'ORPHANED_RUN',
                error_message = '이전 동기화 프로세스가 비정상 종료되었습니다.'
          WHERE account_id = $1 AND status = 'RUNNING'`,
        [accountId],
      );

      const accountResult = await client.query(
        `SELECT id, provider, bank_name, display_name, branch_id, account_number_masked,
                currency, purpose, is_active, NULL::bigint AS latest_balance,
                NULL::timestamptz AS latest_balance_at, last_sync_started_at,
                last_sync_succeeded_at,
                CASE WHEN last_sync_error IS NULL THEN NULL ELSE 'FAILED' END AS last_sync_error
           FROM peakos_bank_accounts
          WHERE id = $1 AND is_active = true`,
        [accountId],
      );
      const account = accountResult.rows[0];
      if (!account) {
        throw new BankSyncError('활성화된 통장을 찾지 못했습니다.', 'BANK_ACCOUNT_NOT_FOUND', 404, {
          recordFailure: false,
          requestId,
        });
      }

      const run = await client.query(
        `INSERT INTO peakos_bank_sync_runs
          (account_id, status, trigger_type, requested_by_uid, requested_by_name, request_id)
         VALUES ($1,'RUNNING',$2,$3,$4,$5)
         RETURNING id`,
        [account.id, triggerType, actor.uid, actor.name, requestId],
      );
      runId = run.rows[0].id;
      await client.query(
        'UPDATE peakos_bank_accounts SET last_sync_started_at = NOW(), last_sync_error = NULL WHERE id = $1',
        [account.id],
      );

      const fetched = await collector({
        account: publicAccount(account, { includeBalance: false }),
        from: rangeFrom,
        to: rangeTo,
        triggerType,
        requestId,
      });
      const rows = Array.isArray(fetched?.transactions) ? fetched.transactions : [];
      const resultRangeFrom = fetched?.from ? parseTimestamp(fetched.from, '수집 시작일') : rangeFrom;
      const resultRangeTo = fetched?.to ? parseTimestamp(fetched.to, '수집 종료일') : rangeTo;
      if (resultRangeFrom && resultRangeTo && resultRangeFrom >= resultRangeTo) {
        throw new BankValidationError('수집 종료일은 시작일보다 뒤여야 합니다.');
      }

      await client.query('BEGIN');
      transactionOpen = true;
      const saved = await saveTransactions(client, account.id, rows, 'BANK_SYNC');
      await client.query(
        `UPDATE peakos_bank_sync_runs
            SET status = 'SUCCEEDED', finished_at = NOW(), fetched_count = $2,
                inserted_count = $3, updated_count = $4, range_from = $5, range_to = $6,
                error_code = NULL, error_message = NULL
          WHERE id = $1`,
        [runId, rows.length, saved.inserted, saved.updated, resultRangeFrom, resultRangeTo],
      );
      await client.query(
        `UPDATE peakos_bank_accounts
            SET last_sync_succeeded_at = NOW(), last_sync_error = NULL, updated_at = NOW()
          WHERE id = $1`,
        [account.id],
      );
      await insertAudit(client, { requestId }, actor, 'BANK_SYNC', 'BANK_ACCOUNT', account.id, '조회 전용 동기화', {
        triggerType,
        fetched: rows.length,
        inserted: saved.inserted,
        updated: saved.updated,
      });
      await client.query('COMMIT');
      transactionOpen = false;
      committed = true;

      result = {
        requestId,
        runId: String(runId),
        triggerType,
        fetched: rows.length,
        inserted: saved.inserted,
        updated: saved.updated,
      };
      afterSyncInput = {
        accountId: account.id,
        runId: String(runId),
        requestId,
        triggerType,
        actor: { ...actor },
        from: resultRangeFrom,
        to: resultRangeTo,
        fetched: rows.length,
        inserted: saved.inserted,
        updated: saved.updated,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK').catch(() => {});
        transactionOpen = false;
      }
      if (!committed && error?.recordFailure !== false) {
        const message = safeErrorMessage(error);
        const errorCode = cleanText(error?.code, 80) || 'BANK_SYNC_FAILED';
        if (runId) {
          await client.query(
            `UPDATE peakos_bank_sync_runs
                SET status = 'FAILED', finished_at = NOW(), error_code = $2, error_message = $3
              WHERE id = $1`,
            [runId, errorCode, message],
          ).catch(() => {});
        }
        await client.query(
          'UPDATE peakos_bank_accounts SET last_sync_error = $2, updated_at = NOW() WHERE id = $1',
          [accountId, message],
        ).catch(() => {});
        console.error('peakos bank sync error:', message);
      }
      if (error instanceof BankSyncError) throw error;
      throw new BankSyncError('통장 조회에 실패했습니다.', 'BANK_SYNC_FAILED', 502, {
        cause: error,
        requestId,
      });
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => {});
      client.release();
    }

    // 후속 정산은 은행 원장 COMMIT·lock 해제·connection 반환 후 실행한다.
    // 여기의 실패는 이미 저장된 sync run을 FAILED로 바꾸지 않는다.
    if (afterSyncHandler) {
      try {
        await afterSyncHandler(afterSyncInput);
        result.afterSync = { ok: true };
      } catch (error) {
        console.error('peakos bank after-sync error:', safeErrorMessage(error));
        result.afterSync = {
          ok: false,
          code: 'BANK_AFTER_SYNC_FAILED',
          message: '통장 동기화 후속 처리에 실패했습니다.',
        };
      }
    }
    return result;
  }

  app.get('/api/peakos/bank/accounts', authMiddleware, async (req, res) => {
    if (!canReadBanking(req)) return res.status(403).json({ error: '통장 조회 권한이 없습니다.' });
    try {
      const showBalances = canViewBalanceData(req);
      const result = await pool.query(
        `SELECT a.id, a.provider, a.bank_name, a.display_name, a.branch_id,
                a.account_number_masked, a.currency, a.purpose, a.is_active,
                CASE WHEN $1::boolean THEN a.latest_balance ELSE NULL::bigint END AS latest_balance,
                CASE WHEN $1::boolean THEN a.latest_balance_at ELSE NULL::timestamptz END AS latest_balance_at,
                a.last_sync_started_at, a.last_sync_succeeded_at,
                CASE WHEN a.last_sync_error IS NULL THEN NULL ELSE 'FAILED' END AS last_sync_error,
                COUNT(t.id) FILTER (WHERE t.reconciliation_status = 'UNMATCHED') AS unmatched_count
           FROM peakos_bank_accounts a
           LEFT JOIN peakos_bank_transactions t ON t.account_id = a.id
          WHERE $1::boolean OR a.id = ANY($2::text[])
          GROUP BY a.id
          ORDER BY a.branch_id, a.display_name`,
        [showBalances, PUBLIC_ACCOUNT_IDS],
      );
      const visibleRows = showBalances
        ? result.rows
        : result.rows.filter(row => isPublicAccountId(row.id));
      const actor = actorOf(req);
      if (showBalances) {
        req.bankRequestId = req.bankRequestId || crypto.randomUUID();
        await insertAudit(pool, req, actor, 'BANK_BALANCE_ACCOUNTS_READ', 'BANK_ACCOUNT_SET', 'visible', '잔액 포함 통장 조회', {
          accountCount: visibleRows.length,
        });
      }
      res.set('Cache-Control', 'no-store');
      res.json({
        accounts: visibleRows.map(row => ({
          ...publicAccount(row, { includeBalance: showBalances }),
          canSync: Boolean(collector) && canOperateAccount(req, row.id, syncAllowed),
          canManage: canOperateAccount(req, row.id, manageAllowed),
          canImport: importAllowed && canOperateAccount(req, row.id, manageAllowed),
        })),
        collectorConfigured: Boolean(collector),
        autoReconciliationEnabled: autoReconciliationEnabled === true,
        canViewBalances: showBalances,
        canSync: Boolean(collector) && visibleRows.some(row => canOperateAccount(req, row.id, syncAllowed)),
        canManage: visibleRows.some(row => canOperateAccount(req, row.id, manageAllowed)),
        canImport: importAllowed && visibleRows.some(row => canOperateAccount(req, row.id, manageAllowed)),
      });
    } catch (error) {
      console.error('peakos bank account read error:', safeErrorMessage(error));
      res.status(500).json({ error: '통장 정보를 불러오지 못했습니다.' });
    }
  });

  app.put('/api/peakos/bank/accounts/:accountId', authMiddleware, async (req, res) => {
    const accountId = String(req.params.accountId || '').trim();
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      return res.status(400).json({ error: '통장 ID 형식이 올바르지 않습니다.' });
    }
    if (!canOperateAccount(req, accountId, manageAllowed)) {
      return res.status(403).json({ error: '통장 설정 권한이 없습니다.' });
    }
    const provider = String(req.body?.provider || '').trim().toUpperCase();
    const bankName = cleanText(req.body?.bankName, 120);
    const displayName = cleanText(req.body?.displayName, 120);
    const branchId = cleanText(req.body?.branchId, 80) || 'hq';
    let accountNumberMasked;
    try {
      accountNumberMasked = normalizeMaskedAccountNumber(req.body?.accountNumberMasked);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const currency = String(req.body?.currency || 'KRW').trim().toUpperCase();
    const purpose = cleanText(req.body?.purpose, 200) || '';
    const active = req.body?.active === true;
    if (!/^[A-Z0-9_]{2,40}$/.test(provider) || !bankName || !displayName || !/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({ error: '은행·표시명·통화 정보를 확인해주세요.' });
    }
    const actor = actorOf(req);
    const showBalances = canViewBalanceData(req);
    req.bankRequestId = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO peakos_bank_accounts
          (id, provider, bank_name, display_name, branch_id, account_number_masked, currency, purpose, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           provider = EXCLUDED.provider,
           bank_name = EXCLUDED.bank_name,
           display_name = EXCLUDED.display_name,
           branch_id = EXCLUDED.branch_id,
           account_number_masked = EXCLUDED.account_number_masked,
           currency = EXCLUDED.currency,
           purpose = EXCLUDED.purpose,
           is_active = EXCLUDED.is_active,
           updated_at = NOW()
         RETURNING id, provider, bank_name, display_name, branch_id,
                   account_number_masked, currency, purpose, is_active,
                   ${showBalances ? 'latest_balance' : 'NULL::bigint'} AS latest_balance,
                   ${showBalances ? 'latest_balance_at' : 'NULL::timestamptz'} AS latest_balance_at,
                   last_sync_started_at, last_sync_succeeded_at,
                   CASE WHEN last_sync_error IS NULL THEN NULL ELSE 'FAILED' END AS last_sync_error`,
        [accountId, provider, bankName, displayName, branchId, accountNumberMasked, currency, purpose, active],
      );
      await insertAudit(client, req, actor, 'BANK_ACCOUNT_UPSERT', 'BANK_ACCOUNT', accountId, cleanText(req.body?.reason, 500), {
        provider,
        bankName,
        displayName,
        branchId,
        active,
      });
      await client.query('COMMIT');
      res.json({
        account: publicAccount(result.rows[0], { includeBalance: showBalances }),
        requestId: req.bankRequestId,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('peakos bank account save error:', safeErrorMessage(error));
      res.status(500).json({ error: '통장 설정을 저장하지 못했습니다.' });
    } finally {
      client.release();
    }
  });

  app.get('/api/peakos/bank/transactions', authMiddleware, async (req, res) => {
    if (!canReadBanking(req)) return res.status(403).json({ error: '통장 조회 권한이 없습니다.' });
    const showBalances = canViewBalanceData(req);
    let limit;
    let page;
    try {
      limit = parsePageInteger(req.query.limit, 'limit', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      page = parsePageInteger(req.query.page, 'page', 1, MAX_PAGE);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const offset = (page - 1) * limit;
    const where = [];
    const values = [];
    const add = (sql, value) => {
      values.push(value);
      where.push(sql.replace('?', `$${values.length}`));
    };

    const accountId = cleanText(req.query.accountId, 120);
    const direction = String(req.query.direction || '').toUpperCase();
    const status = String(req.query.status || '').toUpperCase();
    const search = cleanText(req.query.q, 120);
    if (accountId && !ACCOUNT_ID_PATTERN.test(accountId)) {
      return res.status(400).json({ error: 'accountId 형식이 올바르지 않습니다.' });
    }
    if (accountId && !canReadAccount(req, accountId)) {
      return res.status(403).json({ error: '이 통장의 거래내역을 볼 권한이 없습니다.' });
    }
    if (direction && !ALLOWED_DIRECTIONS.has(direction)) {
      return res.status(400).json({ error: 'direction 값이 올바르지 않습니다.' });
    }
    if (status && !ALLOWED_STATUSES.has(status)) {
      return res.status(400).json({ error: 'status 값이 올바르지 않습니다.' });
    }
    // Defense in depth: ordinary readers can see only the explicitly public
    // accounts. Any future account is denied until it is deliberately added.
    if (!showBalances) add('t.account_id = ANY(?::text[])', PUBLIC_ACCOUNT_IDS);
    if (accountId) add('t.account_id = ?', accountId);
    if (direction && ALLOWED_DIRECTIONS.has(direction)) add('t.direction = ?', direction);
    if (status && ALLOWED_STATUSES.has(status)) add('t.reconciliation_status = ?', status);
    try {
      const from = req.query.from ? parseTimestamp(req.query.from, '시작일') : null;
      const to = req.query.to ? parseTimestamp(req.query.to, '종료일') : null;
      if (from && to && from >= to) throw new BankValidationError('종료일은 시작일보다 뒤여야 합니다.');
      if (from) add('t.transaction_at >= ?', from);
      if (to) add('t.transaction_at < ?', to);
    } catch (error) {
      return res.status(400).json({ error: safeErrorMessage(error) });
    }
    if (search) {
      values.push(`%${search}%`);
      where.push(`(COALESCE(t.summary, '') ILIKE $${values.length} OR COALESCE(t.counterparty_name, '') ILIKE $${values.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    try {
      const listValues = [...values, limit, offset];
      const balanceProjection = showBalances ? 't.balance' : 'NULL::bigint';
      const list = await pool.query(
        `SELECT t.id, t.account_id, t.transaction_at, t.direction, t.amount,
                ${balanceProjection} AS balance, t.summary, t.counterparty_name,
                t.counterparty_account_masked, t.branch_text, t.reconciliation_status,
                t.source, t.first_seen_at
           FROM peakos_bank_transactions t
           ${whereSql}
          ORDER BY t.transaction_at DESC, t.id DESC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        listValues,
      );
      const summary = await pool.query(
        `SELECT COUNT(*)::integer AS total,
                ${showBalances ? "COALESCE(SUM(amount) FILTER (WHERE direction = 'DEPOSIT'), 0)" : 'NULL::bigint'} AS deposit_total,
                ${showBalances ? "COALESCE(SUM(amount) FILTER (WHERE direction = 'WITHDRAWAL'), 0)" : 'NULL::bigint'} AS withdrawal_total,
                COUNT(*) FILTER (WHERE reconciliation_status = 'UNMATCHED')::integer AS unmatched_count
           FROM peakos_bank_transactions t
           ${whereSql}`,
        values,
      );
      const totals = summary.rows[0] || {};
      const visibleRows = showBalances
        ? list.rows
        : list.rows.filter(row => isPublicAccountId(row.account_id));
      if (showBalances) {
        req.bankRequestId = req.bankRequestId || crypto.randomUUID();
        await insertAudit(pool, req, actorOf(req), 'BANK_BALANCE_TRANSACTIONS_READ', 'BANK_ACCOUNT', accountId || 'all', '잔액 포함 거래 조회', {
          page,
          limit,
          filteredAccountId: accountId || null,
        });
      }
      res.set('Cache-Control', 'no-store');
      res.json({
        transactions: visibleRows.map(row => publicTransaction(row, { includeBalance: showBalances })),
        summary: {
          total: Number(totals.total || 0),
          depositTotal: showBalances ? (asMoneyNumber(totals.deposit_total) ?? 0) : null,
          withdrawalTotal: showBalances ? (asMoneyNumber(totals.withdrawal_total) ?? 0) : null,
          unmatchedCount: Number(totals.unmatched_count || 0),
        },
        pagination: {
          page,
          limit,
          total: Number(totals.total || 0),
          totalPages: Math.ceil(Number(totals.total || 0) / limit),
        },
      });
    } catch (error) {
      console.error('peakos bank transaction read error:', safeErrorMessage(error));
      res.status(500).json({ error: '통장 거래내역을 불러오지 못했습니다.' });
    }
  });

  app.get('/api/peakos/bank/sync-runs', authMiddleware, async (req, res) => {
    if (!canReadBanking(req)) return res.status(403).json({ error: '통장 조회 권한이 없습니다.' });
    const showBalances = canViewBalanceData(req);
    let limit;
    try {
      limit = parsePageInteger(req.query.limit, 'limit', 30, MAX_PAGE_SIZE);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const accountId = cleanText(req.query.accountId, 120);
    if (accountId && !ACCOUNT_ID_PATTERN.test(accountId)) {
      return res.status(400).json({ error: 'accountId 형식이 올바르지 않습니다.' });
    }
    if (accountId && !canReadAccount(req, accountId)) {
      return res.status(403).json({ error: '이 통장의 동기화 이력을 볼 권한이 없습니다.' });
    }
    const where = [];
    const values = [];
    if (!showBalances) {
      values.push(PUBLIC_ACCOUNT_IDS);
      where.push(`account_id = ANY($${values.length}::text[])`);
    }
    if (accountId) {
      values.push(accountId);
      where.push(`account_id = $${values.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    try {
      values.push(limit);
      const result = await pool.query(
        `SELECT id, account_id, status, trigger_type, requested_by_name, started_at, finished_at,
                range_from, range_to, fetched_count, inserted_count, updated_count,
                error_code, error_message, request_id
           FROM peakos_bank_sync_runs
          ${whereSql}
          ORDER BY started_at DESC
          LIMIT $${values.length}`,
        values,
      );
      const visibleRows = showBalances
        ? result.rows
        : result.rows.filter(row => isPublicAccountId(row.account_id));
      if (showBalances) {
        req.bankRequestId = req.bankRequestId || crypto.randomUUID();
        await insertAudit(pool, req, actorOf(req), 'BANK_RESTRICTED_SYNC_HISTORY_READ', 'BANK_ACCOUNT', accountId || 'all', '민감 통장 동기화 이력 조회', {
          limit,
          filteredAccountId: accountId || null,
        });
      }
      res.set('Cache-Control', 'no-store');
      res.json({ runs: visibleRows.map(publicSyncRun) });
    } catch (error) {
      console.error('peakos bank sync history error:', safeErrorMessage(error));
      res.status(500).json({ error: '통장 동기화 이력을 불러오지 못했습니다.' });
    }
  });

  app.post('/api/peakos/bank/accounts/:accountId/import', authMiddleware, async (req, res) => {
    const accountId = String(req.params.accountId || '').trim();
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      return res.status(400).json({ error: '통장 ID 형식이 올바르지 않습니다.' });
    }
    if (!canOperateAccount(req, accountId, manageAllowed)) {
      return res.status(403).json({ error: '통장 자료 반영 권한이 없습니다.' });
    }
    if (!importAllowed) {
      return res.status(503).json({ error: '통장 자료 가져오기가 비활성화되어 있습니다.', code: 'BANK_IMPORT_DISABLED' });
    }
    const transactions = Array.isArray(req.body?.transactions) ? req.body.transactions : [];
    if (!transactions.length || transactions.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({ error: `거래내역은 한 번에 1~${MAX_IMPORT_ROWS}건까지 반영할 수 있습니다.` });
    }
    const reason = cleanText(req.body?.reason, 500);
    if (!reason || reason.length < 5) {
      return res.status(400).json({ error: '자료 반영 사유를 5자 이상 입력해주세요.' });
    }
    const actor = actorOf(req);
    req.bankRequestId = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const account = await client.query(
        'SELECT id FROM peakos_bank_accounts WHERE id = $1 AND is_active = true FOR UPDATE',
        [accountId],
      );
      if (!account.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: '활성화된 통장을 찾지 못했습니다.' });
      }
      const saved = await saveTransactions(client, accountId, transactions, 'CSV_IMPORT');
      const run = await client.query(
        `INSERT INTO peakos_bank_sync_runs
          (account_id, status, trigger_type, requested_by_uid, requested_by_name,
           finished_at, fetched_count, inserted_count, updated_count, request_id)
         VALUES ($1,'SUCCEEDED','IMPORT',$2,$3,NOW(),$4,$5,$6,$7)
         RETURNING id`,
        [accountId, actor.uid, actor.name, transactions.length, saved.inserted, saved.updated, req.bankRequestId],
      );
      await insertAudit(client, req, actor, 'BANK_IMPORT', 'BANK_ACCOUNT', accountId, reason, {
        rowCount: transactions.length,
        inserted: saved.inserted,
        updated: saved.updated,
      });
      await client.query('COMMIT');
      res.json({
        requestId: req.bankRequestId,
        runId: String(run.rows[0].id),
        fetched: transactions.length,
        inserted: saved.inserted,
        updated: saved.updated,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('peakos bank import error:', safeErrorMessage(error));
      if (error instanceof BankValidationError) {
        return res.status(400).json({ error: error.message, code: error.code, requestId: req.bankRequestId });
      }
      res.status(500).json({ error: '통장 자료를 반영하지 못했습니다.', requestId: req.bankRequestId });
    } finally {
      client.release();
    }
  });

  app.post('/api/peakos/bank/accounts/:accountId/sync', authMiddleware, async (req, res) => {
    const accountId = String(req.params.accountId || '').trim();
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      return res.status(400).json({ error: '통장 ID 형식이 올바르지 않습니다.' });
    }
    if (!canOperateAccount(req, accountId, syncAllowed)) {
      return res.status(403).json({ error: '통장 동기화 권한이 없습니다.' });
    }
    req.bankRequestId = crypto.randomUUID();
    try {
      const result = await syncAccount({
        accountId,
        from: req.body?.from,
        to: req.body?.to,
        triggerType: 'MANUAL',
        actor: actorOf(req),
        requestId: req.bankRequestId,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof BankValidationError) {
        return res.status(400).json({
          error: error.message,
          code: error.code,
          requestId: req.bankRequestId,
        });
      }
      if (error instanceof BankSyncError) {
        return res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
          requestId: error.requestId || req.bankRequestId,
        });
      }
      console.error('peakos bank sync route error:', safeErrorMessage(error));
      res.status(502).json({
        error: '통장 조회에 실패했습니다.',
        code: 'BANK_SYNC_FAILED',
        requestId: req.bankRequestId,
      });
    }
  });

  return { syncAccount };
}

module.exports = {
  BankSyncError,
  ensurePeakosBankInfrastructure,
  maskAccountNumber,
  normalizeBankTransaction,
  publicAccount,
  publicTransaction,
  registerPeakosBanking,
  safeErrorMessage,
  saveTransactions,
};
