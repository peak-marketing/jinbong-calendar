'use strict';

const crypto = require('node:crypto');
const multer = require('multer');
const {
  TaxInvoiceEvidencePolicyError,
  canReadOriginal,
  canReadRequest,
  canRegister,
  evidenceAction,
  maskRegistrationNumber,
  maskTail,
  normalizeEvidenceId,
  normalizeMetadata,
  normalizeRequestId,
  selectedWorkspace,
} = require('./peakos-tax-invoice-evidence-policy');
const {
  MAX_EVIDENCE_BYTES,
  createTaxInvoiceEvidenceStorage,
} = require('./peakos-tax-invoice-evidence-storage');

const REQUEST_COLUMNS = `id, workspace_id, requester_uid, requester_name, kind,
  invoice_requested, invoice_status, current_invoice_evidence_id, version`;
const REQUEST_JOIN_COLUMNS = `request.id, request.workspace_id,
  request.requester_uid, request.requester_name, request.kind,
  request.invoice_requested, request.invoice_status,
  request.current_invoice_evidence_id, request.version`;
const EVIDENCE_COLUMNS = `id, workspace_id, finance_request_id, revision,
  action_kind, target_invoice_status, invoice_number, issued_at,
  supplier_registration_number, document_identifier, correction_reason,
  stored_key, original_filename, mime_type, size_bytes, sha256,
  supersedes_evidence_id, registered_by_uid, registered_by_name, created_at`;

class TaxInvoiceEvidenceRouteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'TaxInvoiceEvidenceRouteError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

function routeFail(status, code, message) {
  throw new TaxInvoiceEvidenceRouteError(status, code, message);
}

function safeActor(req, getName) {
  const uid = String(req?.uid || '').trim();
  const name = String(getName(req) || '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!uid || uid.length > 256 || !name || name.length > 160) {
    routeFail(403, 'TAX_INVOICE_EVIDENCE_ACTOR_REQUIRED', '증빙 등록 담당자 계정을 확인할 수 없습니다.');
  }
  return Object.freeze({ uid, name });
}

function evidenceOut(row, { reveal = false } = {}) {
  const evidenceId = String(row.id);
  const requestId = String(row.finance_request_id);
  const base = {
    id: evidenceId,
    requestId,
    revision: Number(row.revision),
    action: String(row.action_kind),
    invoiceStatus: String(row.target_invoice_status),
    invoiceNumber: reveal ? String(row.invoice_number) : maskTail(row.invoice_number),
    issuedAt: new Date(row.issued_at).toISOString(),
    supplierRegistrationNumber: reveal
      ? String(row.supplier_registration_number)
      : maskRegistrationNumber(row.supplier_registration_number),
    documentIdentifier: reveal ? String(row.document_identifier) : maskTail(row.document_identifier),
    correctionReason: reveal ? String(row.correction_reason || '') : '',
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    supersedesEvidenceId: row.supersedes_evidence_id ? String(row.supersedes_evidence_id) : null,
    registeredByName: String(row.registered_by_name),
    createdAt: new Date(row.created_at).toISOString(),
    protectedOriginalAvailable: reveal,
    registrationOnly: true,
    externalIssuancePerformed: false,
  };
  if (!reveal) return Object.freeze(base);
  return Object.freeze({
    ...base,
    originalFilename: String(row.original_filename),
    sha256: String(row.sha256),
    contentPath: `/api/peakos/finance-requests/${encodeURIComponent(requestId)}/invoice-evidence/${encodeURIComponent(evidenceId)}/content`,
  });
}

function setPrivateHeaders(res) {
  res.set?.('Cache-Control', 'private, no-store');
  res.set?.('X-Content-Type-Options', 'nosniff');
  res.vary?.('X-PeakOS-Workspace');
}

function errorResponse(res, error, logger = console) {
  if (error instanceof TaxInvoiceEvidencePolicyError
      || error instanceof TaxInvoiceEvidenceRouteError) {
    return res.status(error.statusCode || error.status || 400).json({ code: error.code, error: error.message });
  }
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({
      code: error.code === 'LIMIT_FILE_SIZE'
        ? 'TAX_INVOICE_EVIDENCE_FILE_TOO_LARGE'
        : 'TAX_INVOICE_EVIDENCE_MULTIPART_INVALID',
      error: error.code === 'LIMIT_FILE_SIZE'
        ? '증빙 파일은 10MB 이하여야 합니다.'
        : '증빙 파일 업로드 형식을 확인해 주세요.',
    });
  }
  if (error?.code === '23505') {
    return res.status(409).json({
      code: 'TAX_INVOICE_EVIDENCE_DOCUMENT_CONFLICT',
      error: '같은 공급자와 발급번호의 증빙이 이미 등록되어 있습니다.',
    });
  }
  if (error?.code === '40001' || error?.code === '40P01') {
    return res.status(409).json({
      code: 'TAX_INVOICE_EVIDENCE_RETRY_REQUIRED',
      error: '다른 증빙 작업과 겹쳤습니다. 최신 요청을 불러와 다시 시도해 주세요.',
    });
  }
  if (error?.constraint === 'peakos_finance_requests_terminal_invoice_evidence_check'
      || error?.constraint === 'peakos_finance_requests_invoice_evidence_chain_check'
      || error?.constraint === 'peakos_tax_invoice_evidence_request_state_check') {
    return res.status(409).json({
      code: 'TAX_INVOICE_EVIDENCE_STATE_CONFLICT',
      error: '계산서 상태와 보호 증빙 이력이 일치하지 않습니다. 최신 요청을 확인해 주세요.',
    });
  }
  if (['42P01', '42703', '42883', '42501'].includes(String(error?.code || ''))) {
    return res.status(503).json({
      code: 'TAX_INVOICE_EVIDENCE_SCHEMA_NOT_READY',
      error: '세금계산서 증빙 데이터 준비가 아직 끝나지 않았습니다.',
    });
  }
  logger.error?.('tax invoice evidence route failed:', error?.message || error);
  return res.status(500).json({
    code: 'TAX_INVOICE_EVIDENCE_FAILED',
    error: '세금계산서 발급 증빙을 처리하지 못했습니다.',
  });
}

function createUploadMiddleware() {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_EVIDENCE_BYTES,
      files: 1,
      fields: 8,
      parts: 9,
      fieldNameSize: 80,
      fieldSize: 4 * 1024,
    },
    fileFilter(_req, file, callback) {
      if (!['application/pdf', 'image/png', 'image/jpeg'].includes(String(file?.mimetype || '').toLowerCase())) {
        return callback(new TaxInvoiceEvidencePolicyError(
          400,
          'TAX_INVOICE_EVIDENCE_MIME_INVALID',
          'PDF, PNG, JPEG 증빙만 등록할 수 있습니다.',
        ));
      }
      return callback(null, true);
    },
  });
  return upload.single('document');
}

function registerPeakosTaxInvoiceEvidenceRoutes({
  app,
  authMiddleware,
  pool,
  canReviewFinance,
  getName,
  storage = null,
  storageRoot,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  logger = console,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('Express app.get/post가 필요합니다.');
  }
  if (typeof authMiddleware !== 'function' || !pool || typeof pool.connect !== 'function'
      || typeof pool.query !== 'function' || typeof canReviewFinance !== 'function'
      || typeof getName !== 'function') {
    throw new TypeError('세금계산서 증빙 라우트 의존성이 필요합니다.');
  }
  const evidenceStorage = storage || createTaxInvoiceEvidenceStorage({
    root: storageRoot,
    randomUUID,
  });
  const uploadSingle = createUploadMiddleware();

  function registrationGate(req, res, next) {
    try {
      selectedWorkspace(req);
      if (!canRegister(req, canReviewFinance)) {
        routeFail(403, 'TAX_INVOICE_EVIDENCE_WRITE_FORBIDDEN', '지정된 재무 검토자만 발급 증빙을 등록할 수 있습니다.');
      }
      return next();
    } catch (error) {
      return errorResponse(res, error, logger);
    }
  }

  function uploadGate(req, res, next) {
    return uploadSingle(req, res, error => {
      if (error) return errorResponse(res, error, logger);
      return next();
    });
  }

  app.get('/api/peakos/finance-requests/:id/invoice-evidence', authMiddleware, async (req, res) => {
    try {
      const workspaceId = selectedWorkspace(req);
      const requestId = normalizeRequestId(req.params?.id);
      const requestResult = await pool.query(
        `SELECT ${REQUEST_COLUMNS} FROM peakos_finance_requests
          WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, requestId],
      );
      const request = requestResult.rows[0];
      if (!request) routeFail(404, 'TAX_INVOICE_EVIDENCE_REQUEST_NOT_FOUND', '이 워크스페이스에서 금융 요청을 찾지 못했습니다.');
      if (!canReadRequest(req, request, canReviewFinance)) {
        routeFail(403, 'TAX_INVOICE_EVIDENCE_READ_FORBIDDEN', '다른 사용자의 세금계산서 증빙을 볼 수 없습니다.');
      }
      const reveal = canReadOriginal(req, request, canReviewFinance);
      const evidenceResult = await pool.query(
        `SELECT ${EVIDENCE_COLUMNS} FROM peakos_tax_invoice_evidence
          WHERE workspace_id = $1 AND finance_request_id = $2
          ORDER BY revision DESC, created_at DESC, id DESC`,
        [workspaceId, requestId],
      );
      setPrivateHeaders(res);
      return res.json({
        request: {
          id: requestId,
          invoiceStatus: request.invoice_status,
          version: Number(request.version),
          currentEvidenceId: request.current_invoice_evidence_id
            ? String(request.current_invoice_evidence_id) : null,
        },
        evidence: evidenceResult.rows.map(row => evidenceOut(row, { reveal })),
        masked: !reveal,
        registrationOnly: true,
        externalIssuancePerformed: false,
      });
    } catch (error) {
      return errorResponse(res, error, logger);
    }
  });

  app.get(
    '/api/peakos/finance-requests/:id/invoice-evidence/:evidenceId/content',
    authMiddleware,
    async (req, res) => {
      try {
        const workspaceId = selectedWorkspace(req);
        const requestId = normalizeRequestId(req.params?.id);
        const evidenceId = normalizeEvidenceId(req.params?.evidenceId);
        const result = await pool.query(
          `SELECT ${REQUEST_JOIN_COLUMNS},
                  evidence.stored_key, evidence.original_filename,
                  evidence.mime_type, evidence.size_bytes, evidence.sha256
             FROM peakos_finance_requests request
             JOIN peakos_tax_invoice_evidence evidence
               ON evidence.workspace_id = request.workspace_id
              AND evidence.finance_request_id = request.id
            WHERE request.workspace_id = $1 AND request.id = $2 AND evidence.id = $3`,
          [workspaceId, requestId, evidenceId],
        );
        const row = result.rows[0];
        if (!row) routeFail(404, 'TAX_INVOICE_EVIDENCE_NOT_FOUND', '이 워크스페이스에서 증빙 원본을 찾지 못했습니다.');
        if (!canReadOriginal(req, row, canReviewFinance)) {
          routeFail(403, 'TAX_INVOICE_EVIDENCE_ORIGINAL_FORBIDDEN', '증빙 원본은 지정된 재무 검토자만 볼 수 있습니다.');
        }
        const bytes = await evidenceStorage.read(workspaceId, row);
        const fallbackExtension = row.mime_type === 'application/pdf' ? 'pdf'
          : (row.mime_type === 'image/png' ? 'png' : 'jpg');
        const fallback = `tax-invoice-evidence-${evidenceId}.${fallbackExtension}`;
        const encoded = encodeURIComponent(String(row.original_filename)).replace(/[!'()*]/g, character => (
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`
        ));
        setPrivateHeaders(res);
        res.set?.('Content-Security-Policy', "default-src 'none'; sandbox");
        res.set?.('Content-Type', String(row.mime_type));
        res.set?.('Content-Length', String(bytes.length));
        res.set?.('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
        return res.status(200).send(bytes);
      } catch (error) {
        return errorResponse(res, error, logger);
      }
    },
  );

  app.post(
    '/api/peakos/finance-requests/:id/invoice-evidence',
    authMiddleware,
    registrationGate,
    uploadGate,
    async (req, res) => {
      let client;
      let stored;
      let commitStarted = false;
      try {
        const workspaceId = selectedWorkspace(req);
        const requestId = normalizeRequestId(req.params?.id);
        if (!req.file) routeFail(400, 'TAX_INVOICE_EVIDENCE_FILE_REQUIRED', '세금계산서 원본 파일을 첨부해 주세요.');
        const now = clock();
        const input = normalizeMetadata(req.body, { now });
        const actor = safeActor(req, getName);

        client = await pool.connect();
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const requestResult = await client.query(
          `SELECT ${REQUEST_COLUMNS} FROM peakos_finance_requests
            WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
          [workspaceId, requestId],
        );
        const request = requestResult.rows[0];
        if (!request) routeFail(404, 'TAX_INVOICE_EVIDENCE_REQUEST_NOT_FOUND', '이 워크스페이스에서 금융 요청을 찾지 못했습니다.');
        if (Number(request.version) !== input.expectedVersion) {
          routeFail(409, 'TAX_INVOICE_EVIDENCE_VERSION_CONFLICT', '다른 화면에서 요청이 먼저 변경되었습니다. 최신 요청을 다시 불러와 주세요.');
        }
        if (request.invoice_requested !== true) {
          routeFail(409, 'TAX_INVOICE_EVIDENCE_NOT_REQUESTED', '계산서 요청이 없는 금융 요청에는 발급 증빙을 등록할 수 없습니다.');
        }
        const action = evidenceAction(request, input.invoiceStatus);
        let currentEvidence = null;
        if (request.current_invoice_evidence_id) {
          const currentResult = await client.query(
            `SELECT ${EVIDENCE_COLUMNS} FROM peakos_tax_invoice_evidence
              WHERE workspace_id = $1 AND finance_request_id = $2 AND id = $3`,
            [workspaceId, requestId, request.current_invoice_evidence_id],
          );
          currentEvidence = currentResult.rows[0];
          if (!currentEvidence) routeFail(409, 'TAX_INVOICE_EVIDENCE_CHAIN_INVALID', '현재 계산서 증빙 이력을 확인할 수 없습니다.');
        }
        stored = await evidenceStorage.store(workspaceId, req.file);
        if (action === 'REPLACEMENT' && currentEvidence?.sha256 === stored.sha256) {
          routeFail(409, 'TAX_INVOICE_EVIDENCE_IDENTICAL_REPLACEMENT', '현재 증빙과 같은 파일은 교체 증빙으로 다시 등록할 수 없습니다.');
        }

        const evidenceId = randomUUID();
        const revision = currentEvidence ? Number(currentEvidence.revision) + 1 : 1;
        const inserted = await client.query(
          `INSERT INTO peakos_tax_invoice_evidence
            (id, workspace_id, finance_request_id, revision, action_kind,
             target_invoice_status, invoice_number, issued_at,
             supplier_registration_number, document_identifier, correction_reason,
             stored_key, original_filename, mime_type, size_bytes, sha256,
             supersedes_evidence_id, registered_by_uid, registered_by_name, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
           RETURNING ${EVIDENCE_COLUMNS}`,
          [
            evidenceId,
            workspaceId,
            requestId,
            revision,
            action,
            input.invoiceStatus,
            input.invoiceNumber,
            input.issuedAt,
            input.supplierRegistrationNumber,
            input.documentIdentifier,
            input.correctionReason,
            stored.storedKey,
            stored.originalFilename,
            stored.mimeType,
            stored.sizeBytes,
            stored.sha256,
            currentEvidence?.id || null,
            actor.uid,
            actor.name,
            now,
          ],
        );
        const evidence = inserted.rows[0];
        const updated = await client.query(
          `UPDATE peakos_finance_requests
              SET invoice_requested = TRUE,
                  invoice_status = $3,
                  current_invoice_evidence_id = $4,
                  invoice_evidence_url = '',
                  processed_by_uid = $5,
                  processed_by_name = $6,
                  version = version + 1,
                  updated_at = $7
            WHERE workspace_id = $1 AND id = $2 AND version = $8
          RETURNING version, invoice_status, current_invoice_evidence_id`,
          [workspaceId, requestId, input.invoiceStatus, evidence.id, actor.uid, actor.name, now, input.expectedVersion],
        );
        if (!updated.rows[0]) {
          routeFail(409, 'TAX_INVOICE_EVIDENCE_VERSION_CONFLICT', '다른 화면에서 요청이 먼저 변경되었습니다. 최신 요청을 다시 불러와 주세요.');
        }
        await client.query(
          `INSERT INTO peakos_finance_request_events
            (workspace_id, request_id, event_type, actor_uid, actor_name,
             from_invoice_status, to_invoice_status, note, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'',$8::jsonb)`,
          [
            workspaceId,
            requestId,
            action === 'REPLACEMENT'
              ? 'FINANCE_REQUEST_INVOICE_EVIDENCE_REPLACED'
              : (action === 'CORRECTION'
                ? 'FINANCE_REQUEST_INVOICE_EVIDENCE_CORRECTED'
                : 'FINANCE_REQUEST_INVOICE_EVIDENCE_REGISTERED'),
            actor.uid,
            actor.name,
            request.invoice_status,
            input.invoiceStatus,
            JSON.stringify({
              evidenceId: String(evidence.id),
              revision,
              mimeType: stored.mimeType,
              sizeBytes: stored.sizeBytes,
              sha256: stored.sha256,
              registrationOnly: true,
              externalIssuancePerformed: false,
              expectedVersion: input.expectedVersion,
              resultingVersion: Number(updated.rows[0].version),
            }),
          ],
        );
        commitStarted = true;
        await client.query('COMMIT');
        setPrivateHeaders(res);
        return res.status(201).json({
          evidence: evidenceOut(evidence, { reveal: true }),
          request: {
            id: requestId,
            invoiceStatus: updated.rows[0].invoice_status,
            currentEvidenceId: String(updated.rows[0].current_invoice_evidence_id),
            version: Number(updated.rows[0].version),
          },
          message: '외부에서 발급된 세금계산서의 검증 증빙을 등록했습니다.',
          registrationOnly: true,
          externalIssuancePerformed: false,
        });
      } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (stored && !commitStarted) {
          const workspaceId = String(req?.workspace?.id || '');
          await evidenceStorage.remove(workspaceId, stored.storedKey).catch(cleanupError => {
            logger.error?.('tax invoice evidence cleanup failed:', cleanupError?.message || cleanupError);
          });
        }
        return errorResponse(res, error, logger);
      } finally {
        client?.release?.();
      }
    },
  );

  return Object.freeze({ evidenceStorage });
}

module.exports = {
  EVIDENCE_COLUMNS,
  REQUEST_COLUMNS,
  REQUEST_JOIN_COLUMNS,
  TaxInvoiceEvidenceRouteError,
  createUploadMiddleware,
  errorResponse,
  evidenceOut,
  registerPeakosTaxInvoiceEvidenceRoutes,
  safeActor,
};
