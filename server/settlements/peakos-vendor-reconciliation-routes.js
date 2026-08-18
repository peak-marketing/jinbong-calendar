'use strict';

const crypto = require('node:crypto');
const {
  VendorReconciliationPolicyError,
  canWriteVendorReconciliation,
  cleanText,
  settlementMath,
  supplierForIntake,
} = require('./peakos-vendor-reconciliation-policy');

const WORKSPACE_ID_PATTERN = /^ws_[a-z0-9_]{1,60}$/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,80}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class VendorReconciliationRouteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'VendorReconciliationRouteError';
    this.status = status;
    this.code = code;
  }
}

function routeFail(status, code, message) {
  throw new VendorReconciliationRouteError(status, code, message);
}

function normalizeText(value, { label, minimum = 1, maximum }) {
  const raw = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
  if (raw.length < minimum || raw.length > maximum) {
    routeFail(400, 'VENDOR_RECONCILIATION_TEXT_INVALID', `${label}을(를) 확인해 주세요.`);
  }
  return cleanText(raw, maximum);
}

function dateKey(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    routeFail(400, 'VENDOR_RECONCILIATION_DATE_INVALID', '공급사 지급일을 확인해 주세요.');
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    routeFail(400, 'VENDOR_RECONCILIATION_DATE_INVALID', '공급사 지급일을 확인해 주세요.');
  }
  return text;
}

function positiveSafeInteger(value, code, message, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) routeFail(400, code, message);
  return number;
}

function sourceId(value) {
  const id = String(value || '').trim();
  if (!SOURCE_ID_PATTERN.test(id)) {
    routeFail(400, 'VENDOR_RECONCILIATION_SOURCE_ID_INVALID', '접수 행 ID를 확인해 주세요.');
  }
  return id;
}

function uuid(value, code, message) {
  const id = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) routeFail(400, code, message);
  return id;
}

function assertExactFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    routeFail(400, 'VENDOR_RECONCILIATION_BODY_INVALID', `${label} 형식을 확인해 주세요.`);
  }
  if (Object.keys(value).some(key => !allowed.has(key))) {
    routeFail(400, 'VENDOR_RECONCILIATION_FIELDS_NOT_ALLOWED', `${label}에 허용되지 않은 값이 있습니다.`);
  }
}

function normalizeRequest(body) {
  assertExactFields(
    body,
    new Set(['idempotencyKey', 'supplier', 'deliveredQty', 'paidDate', 'bank', 'memo', 'rows']),
    '공급사 대사 요청',
  );
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 500) {
    routeFail(400, 'VENDOR_RECONCILIATION_ROWS_INVALID', '한 번에 1~500개 접수 행을 대사할 수 있습니다.');
  }
  const seen = new Set();
  const normalizedRows = rows.map(item => {
    assertExactFields(item, new Set(['id', 'expectedRowVersion']), '공급사 대사 접수 행');
    const id = sourceId(item.id);
    if (seen.has(id)) routeFail(409, 'VENDOR_RECONCILIATION_SOURCE_DUPLICATE', '같은 접수 행이 요청에 중복되었습니다.');
    seen.add(id);
    const expectedRowVersion = positiveSafeInteger(
      item.expectedRowVersion,
      'VENDOR_RECONCILIATION_VERSION_REQUIRED',
      '각 접수 행의 최신 버전이 필요합니다.',
      Number.MAX_SAFE_INTEGER,
    );
    return Object.freeze({ id, expectedRowVersion });
  }).sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({
    idempotencyKey: uuid(
      body.idempotencyKey,
      'VENDOR_RECONCILIATION_IDEMPOTENCY_KEY_INVALID',
      '공급사 대사 재시도 키를 확인해 주세요.',
    ),
    supplier: normalizeText(body.supplier, { label: '공급처명', maximum: 120 }),
    deliveredQty: positiveSafeInteger(
      body.deliveredQty,
      'VENDOR_RECONCILIATION_DELIVERED_QTY_INVALID',
      '공급사 전달 수량은 1 이상의 정수여야 합니다.',
      500_000_000,
    ),
    paidDate: dateKey(body.paidDate),
    bank: normalizeText(body.bank, { label: '지급 통장', maximum: 80 }),
    memo: normalizeText(body.memo, { label: '정산 특이사항', minimum: 8, maximum: 500 }),
    rows: Object.freeze(normalizedRows),
  });
}

function requestDigest(input) {
  return crypto.createHash('sha256').update(JSON.stringify({
    supplier: input.supplier,
    deliveredQty: input.deliveredQty,
    paidDate: input.paidDate,
    bank: input.bank,
    memo: input.memo,
    rows: input.rows,
  })).digest('hex');
}

function requestIsPreview(req) {
  const headers = req?.headers || {};
  const preview = typeof req?.get === 'function' ? req.get('x-peakos-preview') : headers['x-peakos-preview'];
  return /^(?:1|true|yes|on)$/i.test(String(preview || '').trim())
    || Boolean(headers['x-peakos-preview-persona'] || headers['x-peakos-preview-owner']);
}

function selectedWorkspace(req, getWorkspaceId) {
  const workspaceId = String(getWorkspaceId(req) || '').trim();
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)
      || String(req?.workspace?.id || '') !== workspaceId) {
    routeFail(403, 'VENDOR_RECONCILIATION_WORKSPACE_REQUIRED', '선택한 워크스페이스를 확인할 수 없습니다.');
  }
  if (!['read', 'write'].includes(req?.workspace?.permissions?.settlements)) {
    routeFail(403, 'VENDOR_RECONCILIATION_READ_FORBIDDEN', '이 워크스페이스의 공급사 정산을 볼 수 없습니다.');
  }
  return workspaceId;
}

function actor(req, getName) {
  const uid = String(req?.uid || '').trim();
  const name = cleanText(getName(req), 160);
  if (!uid || uid.length > 256 || !name) {
    routeFail(403, 'VENDOR_RECONCILIATION_ACTOR_REQUIRED', '작업자 계정을 확인할 수 없습니다.');
  }
  return Object.freeze({ uid, name });
}

function requestId(req) {
  const candidate = String(req?.get?.('x-request-id') || req?.headers?.['x-request-id'] || '').trim();
  return /^[A-Za-z0-9:_-]{8,160}$/.test(candidate) ? candidate : crypto.randomUUID();
}

function batchOut(batch, items = []) {
  return Object.freeze({
    id: String(batch.id),
    supplier: String(batch.supplier),
    status: String(batch.status),
    rowVersion: Number(batch.row_version),
    itemCount: Number(batch.item_count),
    deliveredQty: Number(batch.delivered_qty),
    settledQty: Number(batch.settled_qty),
    totalDue: Number(batch.total_due),
    bank: String(batch.bank_label),
    paidDate: String(batch.paid_date instanceof Date
      ? batch.paid_date.toISOString().slice(0, 10) : batch.paid_date).slice(0, 10),
    memo: String(batch.memo),
    completedByName: String(batch.completed_by_name),
    completedAt: new Date(batch.completed_at).toISOString(),
    items: items.map(item => Object.freeze({
      sourceId: String(item.source_intake_id),
      sourceExpectedRowVersion: Number(item.source_expected_row_version),
      sourceSettledRowVersion: Number(item.source_settled_row_version),
      qty: Number(item.semantic_qty),
      cost: Number(item.cost_per_unit),
      due: Number(item.due_amount),
    })),
  });
}

async function loadBatch(database, workspaceId, batchId) {
  const batchResult = await database.query(
    `SELECT * FROM peakos_vendor_settlement_batches
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, batchId],
  );
  if (!batchResult.rows[0]) return null;
  const itemResult = await database.query(
    `SELECT * FROM peakos_vendor_settlement_items
      WHERE workspace_id = $1 AND batch_id = $2
      ORDER BY item_ordinal`,
    [workspaceId, batchId],
  );
  return batchOut(batchResult.rows[0], itemResult.rows);
}

function sourceSetEquals(leftRows, rightRows) {
  if (leftRows.length !== rightRows.length) return false;
  const rightIds = new Set(rightRows.map(row => String(row.id)));
  return leftRows.every(row => rightIds.has(String(row.id)));
}

function errorResponse(res, error, logger) {
  if (error instanceof VendorReconciliationRouteError
      || error instanceof VendorReconciliationPolicyError) {
    return res.status(error.status || 400).json({ code: error.code, error: error.message });
  }
  if (error?.code === '40001' || error?.code === '40P01') {
    return res.status(409).json({
      code: 'VENDOR_RECONCILIATION_RETRY_REQUIRED',
      error: '다른 정산 작업과 겹쳤습니다. 최신 자료를 다시 불러와 시도해 주세요.',
    });
  }
  if (error?.code === '23505') {
    return res.status(409).json({
      code: 'VENDOR_RECONCILIATION_SOURCE_ALREADY_SETTLED',
      error: '이미 다른 공급사 대사에 포함된 접수 행이 있습니다.',
    });
  }
  if (error?.constraint === 'peakos_intake_vendor_batch_required'
      || error?.constraint === 'peakos_intake_vendor_reconciliation_lock'
      || error?.constraint === 'peakos_intake_vendor_reconciliation_evidence_check'
      || error?.constraint === 'peakos_vendor_reconciliation_batch_totals_check'
      || error?.constraint === 'peakos_vendor_reconciliation_source_snapshot_check') {
    return res.status(409).json({
      code: 'VENDOR_RECONCILIATION_STATE_CONFLICT',
      error: '공급사 대사 근거와 현재 접수 원장이 일치하지 않습니다.',
    });
  }
  if (['42P01', '42703', '42883', '42501'].includes(String(error?.code || ''))) {
    return res.status(503).json({
      code: 'VENDOR_RECONCILIATION_SCHEMA_NOT_READY',
      error: '공급사 대사 데이터 준비가 아직 끝나지 않았습니다.',
    });
  }
  logger.error?.('vendor reconciliation route failed:', error?.message || error);
  return res.status(500).json({
    code: 'VENDOR_RECONCILIATION_FAILED',
    error: '공급사 대사를 처리하지 못했습니다.',
  });
}

function registerPeakosVendorReconciliationRoutes({
  app,
  authMiddleware,
  pool,
  approvedActive,
  getName,
  canReviewFinance,
  getWorkspaceId = req => req?.workspace?.id,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  logger = console,
}) {
  if (!app || !pool || typeof pool.connect !== 'function') throw new TypeError('app과 pool이 필요합니다.');
  if (typeof approvedActive !== 'function' || typeof getName !== 'function'
      || typeof canReviewFinance !== 'function') throw new TypeError('공급사 대사 계정 정책 함수가 필요합니다.');

  function assertAccount(req) {
    if (!approvedActive(req)) {
      routeFail(403, 'VENDOR_RECONCILIATION_ACCOUNT_FORBIDDEN', '승인된 활성 계정만 공급사 정산을 볼 수 있습니다.');
    }
  }

  function assertFinanceRead(req) {
    if (!canReviewFinance(req)) {
      routeFail(403, 'VENDOR_RECONCILIATION_FINANCE_FORBIDDEN', '공급사 정산은 지정된 재무 담당자만 볼 수 있습니다.');
    }
  }

  app.get('/api/peakos/vendor-reconciliations', authMiddleware, async (req, res) => {
    try {
      assertAccount(req);
      assertFinanceRead(req);
      const workspaceId = selectedWorkspace(req, getWorkspaceId);
      const limit = req.query?.limit === undefined ? 50 : Number(req.query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        routeFail(400, 'VENDOR_RECONCILIATION_LIMIT_INVALID', '공급사 대사 이력은 1~100건까지 볼 수 있습니다.');
      }
      const result = await pool.query(
        `SELECT * FROM peakos_vendor_settlement_batches
          WHERE workspace_id = $1
          ORDER BY completed_at DESC, id DESC LIMIT $2`,
        [workspaceId, limit],
      );
      res.set?.('Cache-Control', 'private, no-store');
      res.vary?.('X-PeakOS-Workspace');
      return res.json({ rows: result.rows.map(row => batchOut(row)) });
    } catch (error) { return errorResponse(res, error, logger); }
  });

  app.get('/api/peakos/vendor-reconciliations/:batchId', authMiddleware, async (req, res) => {
    try {
      assertAccount(req);
      assertFinanceRead(req);
      const workspaceId = selectedWorkspace(req, getWorkspaceId);
      const batchId = uuid(
        req.params.batchId,
        'VENDOR_RECONCILIATION_BATCH_ID_INVALID',
        '공급사 대사 ID를 확인해 주세요.',
      );
      const result = await loadBatch(pool, workspaceId, batchId);
      if (!result) routeFail(404, 'VENDOR_RECONCILIATION_NOT_FOUND', '이 워크스페이스에서 공급사 대사를 찾지 못했습니다.');
      res.set?.('Cache-Control', 'private, no-store');
      res.vary?.('X-PeakOS-Workspace');
      return res.json(result);
    } catch (error) { return errorResponse(res, error, logger); }
  });

  app.post('/api/peakos/vendor-reconciliations', authMiddleware, async (req, res) => {
    let workspaceId;
    let input;
    let currentActor;
    try {
      assertAccount(req);
      workspaceId = selectedWorkspace(req, getWorkspaceId);
      if (requestIsPreview(req)) {
        routeFail(403, 'VENDOR_RECONCILIATION_PREVIEW_READ_ONLY', '계정 미리보기에서는 공급사 정산을 확정할 수 없습니다.');
      }
      if (!canWriteVendorReconciliation(req, { canReviewFinance })) {
        routeFail(403, 'VENDOR_RECONCILIATION_WRITE_FORBIDDEN', '이 워크스페이스에서 공급사 정산을 확정할 권한이 없습니다.');
      }
      input = normalizeRequest(req.body);
      currentActor = actor(req, getName);
    } catch (error) { return errorResponse(res, error, logger); }

    const digest = requestDigest(input);
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`peakos-vendor-reconciliation-v1:${workspaceId}`],
      );

      const replay = await client.query(
        `SELECT id, request_digest
           FROM peakos_vendor_settlement_batches
          WHERE workspace_id = $1 AND completed_by_uid = $2 AND idempotency_key = $3`,
        [workspaceId, currentActor.uid, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (String(replay.rows[0].request_digest) !== digest) {
          routeFail(409, 'VENDOR_RECONCILIATION_IDEMPOTENCY_CONFLICT', '같은 재시도 키에 다른 공급사 대사 내용이 사용되었습니다.');
        }
        const existing = await loadBatch(client, workspaceId, replay.rows[0].id);
        await client.query('COMMIT');
        return res.status(200).json({ ...existing, replayed: true });
      }

      const submittedIds = input.rows.map(row => row.id);
      const submittedResult = await client.query(
        `SELECT * FROM peakos_intake
          WHERE workspace_id = $1 AND id = ANY($2::text[])
          ORDER BY id FOR UPDATE`,
        [workspaceId, submittedIds],
      );
      if (submittedResult.rows.length !== submittedIds.length) {
        routeFail(404, 'VENDOR_RECONCILIATION_SOURCE_NOT_FOUND', '이 워크스페이스에서 일부 접수 행을 찾지 못했습니다.');
      }

      // Lock the complete open supplier universe, not only browser-selected
      // rows. Omitting one current open row is therefore a stale conflict.
      const openResult = await client.query(
        `SELECT * FROM peakos_intake
          WHERE workspace_id = $1
            AND vendor_paid = FALSE
            AND kind IN ('normal','use')
            AND qty > 0
          ORDER BY id FOR UPDATE`,
        [workspaceId],
      );
      const supplierRows = openResult.rows.filter(row => supplierForIntake(row) === input.supplier);
      if (!sourceSetEquals(input.rows, supplierRows)) {
        routeFail(409, 'VENDOR_RECONCILIATION_SELECTION_STALE', '공급사의 현재 미지급 접수 목록이 바뀌었습니다. 최신 목록을 다시 확인해 주세요.');
      }

      const expectedVersionById = new Map(input.rows.map(row => [row.id, row.expectedRowVersion]));
      const mathRows = supplierRows.map(row => {
        const expectedRowVersion = expectedVersionById.get(String(row.id));
        if (Number(row.row_version) !== expectedRowVersion) {
          routeFail(409, 'VENDOR_RECONCILIATION_VERSION_CONFLICT', '다른 작업자가 먼저 접수 행을 수정했습니다. 최신 목록을 다시 확인해 주세요.');
        }
        const math = settlementMath(row);
        return Object.freeze({ row, expectedRowVersion, ...math });
      });
      const settledQty = mathRows.reduce((sum, item) => sum + item.semanticQty, 0);
      const totalDue = mathRows.reduce((sum, item) => sum + item.due, 0);
      if (!Number.isSafeInteger(settledQty) || !Number.isSafeInteger(totalDue)) {
        routeFail(409, 'VENDOR_RECONCILIATION_TOTAL_INVALID', '공급사 대사 합계가 안전한 정수 범위를 벗어났습니다.');
      }
      if (settledQty !== input.deliveredQty) {
        routeFail(409, 'VENDOR_RECONCILIATION_QTY_MISMATCH', `접수 수량 ${settledQty}개와 공급사 전달 수량 ${input.deliveredQty}개가 일치하지 않습니다.`);
      }

      const batchId = randomUUID();
      const now = clock();
      const batchInsert = await client.query(
        `INSERT INTO peakos_vendor_settlement_batches
          (id,workspace_id,idempotency_key,request_digest,supplier,status,row_version,
           item_count,delivered_qty,settled_qty,total_due,bank_label,paid_date,memo,
           completed_by_uid,completed_by_name,completed_at,created_at)
         VALUES ($1,$2,$3,$4,$5,'COMPLETED',1,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$14)
         RETURNING *`,
        [batchId, workspaceId, input.idempotencyKey, digest, input.supplier,
          mathRows.length, settledQty, totalDue, input.bank, input.paidDate, input.memo,
          currentActor.uid, currentActor.name, now],
      );

      const savedItems = [];
      const savedRows = [];
      const auditRequestId = requestId(req);
      for (const [index, item] of mathRows.entries()) {
        const sourceSettledRowVersion = item.expectedRowVersion + 1;
        const insertedItem = await client.query(
          `INSERT INTO peakos_vendor_settlement_items
            (workspace_id,batch_id,source_intake_id,item_ordinal,
             source_expected_row_version,source_settled_row_version,source_kind,
             resolved_supplier,semantic_qty,cost_per_unit,due_amount,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING *`,
          [workspaceId, batchId, item.row.id, index + 1, item.expectedRowVersion,
            sourceSettledRowVersion, item.row.kind, input.supplier, item.semanticQty,
            item.cost, item.due, now],
        );
        savedItems.push(insertedItem.rows[0]);

        const update = await client.query(
          `UPDATE peakos_intake
              SET vendor_paid = TRUE,
                  vendor_paid_amount = $4,
                  vendor_paid_date = $5,
                  vendor_bank = $6,
                  vendor_by = $7,
                  vendor_memo = $8,
                  row_version = row_version + 1,
                  updated_at = $9
            WHERE workspace_id = $1 AND id = $2 AND row_version = $3
          RETURNING *`,
          [workspaceId, item.row.id, item.expectedRowVersion, item.due, input.paidDate,
            input.bank, currentActor.name, input.memo, now],
        );
        if (!update.rows[0]) {
          routeFail(409, 'VENDOR_RECONCILIATION_VERSION_CONFLICT', '다른 작업자가 먼저 접수 행을 수정했습니다.');
        }
        savedRows.push(update.rows[0]);
        await client.query(
          `INSERT INTO peakos_intake_audit_log
            (workspace_id,target_id,action,row_version,actor_uid,actor_name,request_id,
             before_state,after_state,metadata)
           VALUES ($1,$2,'VENDOR_BATCH_SETTLED',$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)`,
          [workspaceId, item.row.id, sourceSettledRowVersion, currentActor.uid,
            currentActor.name, auditRequestId, JSON.stringify(item.row),
            JSON.stringify(update.rows[0]), JSON.stringify({
              batchId,
              semanticQty: item.semanticQty,
              dueAmount: item.due,
            })],
        );
      }
      await client.query('SET CONSTRAINTS peakos_vendor_settlement_batches_validate, peakos_vendor_settlement_items_validate IMMEDIATE');
      await client.query('COMMIT');
      return res.status(201).json({
        ...batchOut(batchInsert.rows[0], savedItems),
        replayed: false,
        rows: savedRows.map(row => Object.freeze({
          id: String(row.id),
          rowVersion: Number(row.row_version),
          vendorPaid: row.vendor_paid === true,
          vendorPaidAmount: Number(row.vendor_paid_amount),
          vendorPaidDate: String(row.vendor_paid_date),
          vendorBank: String(row.vendor_bank),
          vendorBy: String(row.vendor_by),
          vendorMemo: String(row.vendor_memo),
        })),
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return errorResponse(res, error, logger);
    } finally { client.release(); }
  });
}

module.exports = {
  VendorReconciliationRouteError,
  batchOut,
  normalizeRequest,
  registerPeakosVendorReconciliationRoutes,
  requestDigest,
  requestIsPreview,
  sourceSetEquals,
};
