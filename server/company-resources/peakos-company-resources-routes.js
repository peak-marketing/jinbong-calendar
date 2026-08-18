'use strict';

const crypto = require('node:crypto');
const multer = require('multer');
const {
  CompanyResourceError,
  DOCUMENT_CATEGORIES,
  loadCompanyResourceAccess,
  normalizeCategory,
  normalizeDevelopmentCostCreate,
  normalizeDocumentUpload,
  normalizeEquipmentCreate,
  normalizeUuid,
  normalizeVoid,
  positiveInteger,
} = require('./peakos-company-resources-policy');
const {
  MAX_DOCUMENT_BYTES,
  createCompanyResourceStorage,
} = require('./peakos-company-resources-storage');

function cleanActorName(value) {
  return String(value || '사용자')
    .normalize('NFKC')
    .replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim().slice(0, 160) || '사용자';
}

function pageLimit(value) {
  if (value === undefined || value === '') return 50;
  return positiveInteger(value, { field: '조회 개수', maximum: 100 });
}

function serializeCapabilities(access) {
  return Object.freeze({
    canWrite: Boolean(access?.financeWrite && access?.permissions?.documents === 'write'),
  });
}

function serializeEquipment(row) {
  return Object.freeze({
    id: String(row.id),
    usedOn: String(row.used_on),
    itemName: String(row.item_name),
    purpose: String(row.purpose),
    quantity: Number(row.quantity),
    usedByUid: String(row.used_by_uid),
    usedByName: String(row.used_by_name),
    memo: String(row.memo || ''),
    status: String(row.status),
    voidReason: String(row.void_reason || ''),
    rowVersion: Number(row.row_version),
    recordedByName: String(row.recorded_by_name),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function serializeDevelopmentCost(row) {
  return Object.freeze({
    id: String(row.id),
    spentOn: String(row.spent_on),
    title: String(row.title),
    vendor: String(row.vendor),
    amountKrw: Number(row.amount_krw),
    memo: String(row.memo || ''),
    evidenceDocumentId: String(row.evidence_document_id),
    evidenceTitle: String(row.evidence_title || ''),
    status: String(row.status),
    voidReason: String(row.void_reason || ''),
    rowVersion: Number(row.row_version),
    recordedByName: String(row.recorded_by_name),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function serializeDocument(row) {
  return Object.freeze({
    id: String(row.id),
    logicalDocumentId: String(row.logical_document_id),
    revision: Number(row.revision),
    supersedesDocumentId: row.supersedes_document_id ? String(row.supersedes_document_id) : null,
    category: String(row.category),
    title: String(row.title),
    originalFilename: String(row.original_filename),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    status: String(row.status),
    archiveReason: String(row.archive_reason || ''),
    rowVersion: Number(row.row_version),
    uploadedByName: String(row.uploaded_by_name),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function publicAuditState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value || null;
  const copy = { ...value };
  delete copy.stored_key;
  delete copy.sha256;
  return copy;
}

function serializeAudit(row) {
  return Object.freeze({
    id: Number(row.id),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    action: String(row.action),
    rowVersion: Number(row.row_version),
    actorName: String(row.actor_name),
    beforeState: publicAuditState(row.before_state),
    afterState: publicAuditState(row.after_state),
    createdAt: row.created_at,
  });
}

function pgConflict(error) {
  if (error?.constraint === 'peakos_development_cost_evidence_active_guard') {
    return new CompanyResourceError(409, 'COMPANY_RESOURCE_EVIDENCE_IN_USE', '사용 중인 개발비 증빙은 보관 처리할 수 없습니다.');
  }
  if (error?.constraint === 'peakos_development_cost_evidence_guard') {
    return new CompanyResourceError(409, 'COMPANY_RESOURCE_EVIDENCE_INVALID', '같은 조직의 활성 개발비 증빙이 필요합니다.');
  }
  if (['23505', '23514', '23503'].includes(String(error?.code || ''))) {
    return new CompanyResourceError(409, 'COMPANY_RESOURCE_CONFLICT', '회사 자료가 변경되었거나 현재 상태와 요청이 충돌합니다.');
  }
  return error;
}

function sendError(res, error, logger = console) {
  const normalized = pgConflict(error);
  if (normalized instanceof CompanyResourceError) {
    return res.status(normalized.status).json({ code: normalized.code, error: normalized.message });
  }
  logger.error?.('[company-resources]', error?.message || error);
  return res.status(500).json({
    code: 'COMPANY_RESOURCE_FAILED',
    error: '회사 자료 요청을 처리하지 못했습니다.',
  });
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const value = await callback(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function createUploadMiddleware({ maxBytes = MAX_DOCUMENT_BYTES } = {}) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 8, parts: 9 },
  }).single('file');
  return function companyResourceUpload(req, res, next) {
    upload(req, res, error => {
      if (!error) return next();
      if (error?.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          code: 'COMPANY_RESOURCE_FILE_TOO_LARGE',
          error: '회사 자료 파일은 20MB 이하여야 합니다.',
        });
      }
      return res.status(400).json({
        code: 'COMPANY_RESOURCE_MULTIPART_INVALID',
        error: '회사 자료 업로드 형식이 올바르지 않습니다.',
      });
    });
  };
}

function createPeakosCompanyResourceService({
  pool,
  storage = createCompanyResourceStorage(),
  canSeeFinanceOperations = () => false,
  canReviewFinance = () => false,
  getName = req => req?.userDoc?.name,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('pool.query/connect가 필요합니다.');
  }
  if (!storage || !['store', 'read', 'remove'].every(method => typeof storage[method] === 'function')) {
    throw new TypeError('보호 자료 storage가 필요합니다.');
  }

  const accessOptions = (client, req, mode, resource = 'PROTECTED_DOCUMENT') => loadCompanyResourceAccess({
    client, req, mode, resource, canSeeFinanceOperations, canReviewFinance,
  });

  async function documentWriteGate(req, res, next) {
    try {
      // Authorize before multer buffers an untrusted multipart body. The
      // mutation still revalidates access inside its SERIALIZABLE transaction
      // so a concurrent membership/role change cannot create a TOCTOU gap.
      await accessOptions(pool, req, 'write', 'PROTECTED_DOCUMENT');
      return next();
    } catch (error) {
      return sendError(res, error, logger);
    }
  }

  async function equipmentList(req, res) {
    try {
      const access = await accessOptions(pool, req, 'read', 'EQUIPMENT_USAGE');
      const limit = pageLimit(req.query?.limit);
      const result = await pool.query(
        `SELECT id, used_on, item_name, purpose, quantity, used_by_uid, used_by_name,
                memo, status, void_reason, row_version, recorded_by_name, created_at, updated_at
           FROM peakos_equipment_usage_entries
          WHERE workspace_id = $1
          ORDER BY used_on DESC, created_at DESC, id DESC
          LIMIT $2`,
        [access.workspaceId, limit],
      );
      res.set?.('Cache-Control', 'private, no-store');
      res.vary?.('X-PeakOS-Workspace');
      return res.json({
        entries: result.rows.map(serializeEquipment),
        capabilities: serializeCapabilities(access),
      });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }

  async function equipmentCreate(req, res) {
    try {
      const input = normalizeEquipmentCreate(req.body);
      const created = await withTransaction(pool, async client => {
        const access = await accessOptions(client, req, 'write', 'EQUIPMENT_USAGE');
        const usedByUid = input.usedByUid || access.uid;
        const target = await client.query(
          `SELECT membership.user_uid,
                  COALESCE(NULLIF(BTRIM(account.name), ''), membership.user_uid) AS user_name
             FROM peakos_workspace_memberships membership
             LEFT JOIN users account ON account.uid = membership.user_uid
            WHERE membership.workspace_id = $1 AND membership.user_uid = $2
              AND membership.active = TRUE AND membership.role <> 'oversight'`,
          [access.workspaceId, usedByUid],
        );
        if (!target.rows[0]) {
          throw new CompanyResourceError(404, 'COMPANY_RESOURCE_USER_NOT_FOUND', '선택 조직의 사용자를 찾지 못했습니다.');
        }
        const actorName = cleanActorName(getName(req));
        const now = clock();
        const result = await client.query(
          `INSERT INTO peakos_equipment_usage_entries
             (workspace_id, id, used_on, item_name, purpose, quantity,
              used_by_uid, used_by_name, memo, status, void_reason, row_version,
              recorded_by_uid, recorded_by_name, last_changed_by_uid,
              last_changed_by_name, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE','',1,$10,$11,$10,$11,$12,$12)
           RETURNING id, used_on, item_name, purpose, quantity, used_by_uid, used_by_name,
                     memo, status, void_reason, row_version, recorded_by_name, created_at, updated_at`,
          [access.workspaceId, randomUUID(), input.usedOn, input.itemName, input.purpose,
            input.quantity, usedByUid, cleanActorName(target.rows[0].user_name), input.memo,
            access.uid, actorName, now],
        );
        return result.rows[0];
      });
      return res.status(201).json({ entry: serializeEquipment(created) });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }

  async function equipmentVoid(req, res) {
    try {
      const id = normalizeUuid(req.params?.id);
      const input = normalizeVoid(req.body);
      const updated = await withTransaction(pool, async client => {
        const access = await accessOptions(client, req, 'write', 'EQUIPMENT_USAGE');
        const existing = await client.query(
          `SELECT id, status, row_version
             FROM peakos_equipment_usage_entries
            WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
          [access.workspaceId, id],
        );
        if (!existing.rows[0]) throw new CompanyResourceError(404, 'COMPANY_RESOURCE_NOT_FOUND', '비품 사용 내역을 찾지 못했습니다.');
        if (existing.rows[0].status !== 'ACTIVE' || Number(existing.rows[0].row_version) !== input.expectedVersion) {
          throw new CompanyResourceError(409, 'COMPANY_RESOURCE_VERSION_CONFLICT', '비품 사용 내역이 이미 변경되었습니다.');
        }
        const result = await client.query(
          `UPDATE peakos_equipment_usage_entries
              SET status = 'VOIDED', void_reason = $3, row_version = row_version + 1,
                  last_changed_by_uid = $4, last_changed_by_name = $5,
                  updated_at = GREATEST($6::timestamptz, updated_at + INTERVAL '1 microsecond')
            WHERE workspace_id = $1 AND id = $2 AND status = 'ACTIVE' AND row_version = $7
           RETURNING id, used_on, item_name, purpose, quantity, used_by_uid, used_by_name,
                     memo, status, void_reason, row_version, recorded_by_name, created_at, updated_at`,
          [access.workspaceId, id, input.reason, access.uid, cleanActorName(getName(req)), clock(), input.expectedVersion],
        );
        if (!result.rows[0]) throw new CompanyResourceError(409, 'COMPANY_RESOURCE_VERSION_CONFLICT', '비품 사용 내역이 이미 변경되었습니다.');
        return result.rows[0];
      });
      return res.json({ entry: serializeEquipment(updated) });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }

  async function developmentCostList(req, res) {
    try {
      const access = await accessOptions(pool, req, 'read', 'DEVELOPMENT_COST');
      const limit = pageLimit(req.query?.limit);
      const result = await pool.query(
        `SELECT cost.id, cost.spent_on, cost.title, cost.vendor, cost.amount_krw,
                cost.memo, cost.evidence_document_id, document.title AS evidence_title,
                cost.status, cost.void_reason, cost.row_version, cost.recorded_by_name,
                cost.created_at, cost.updated_at
           FROM peakos_development_cost_entries cost
           JOIN peakos_protected_company_documents document
             ON document.workspace_id = cost.workspace_id AND document.id = cost.evidence_document_id
          WHERE cost.workspace_id = $1
          ORDER BY cost.spent_on DESC, cost.created_at DESC, cost.id DESC
          LIMIT $2`,
        [access.workspaceId, limit],
      );
      res.set?.('Cache-Control', 'private, no-store');
      res.vary?.('X-PeakOS-Workspace');
      return res.json({
        entries: result.rows.map(serializeDevelopmentCost),
        capabilities: serializeCapabilities(access),
      });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }

  async function developmentCostCreate(req, res) {
    try {
      const input = normalizeDevelopmentCostCreate(req.body);
      const created = await withTransaction(pool, async client => {
        const access = await accessOptions(client, req, 'write', 'DEVELOPMENT_COST');
        const evidence = await client.query(
          `SELECT id, title
             FROM peakos_protected_company_documents
            WHERE workspace_id = $1 AND id = $2
              AND category = 'DEVELOPMENT_COST_EVIDENCE' AND status = 'ACTIVE'
            FOR KEY SHARE`,
          [access.workspaceId, input.evidenceDocumentId],
        );
        if (!evidence.rows[0]) {
          throw new CompanyResourceError(404, 'COMPANY_RESOURCE_EVIDENCE_NOT_FOUND', '선택 조직의 활성 개발비 증빙을 찾지 못했습니다.');
        }
        const actorName = cleanActorName(getName(req));
        const now = clock();
        const result = await client.query(
          `INSERT INTO peakos_development_cost_entries
             (workspace_id, id, spent_on, title, vendor, amount_krw, memo,
              evidence_document_id, status, void_reason, row_version,
              recorded_by_uid, recorded_by_name, last_changed_by_uid,
              last_changed_by_name, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE','',1,$9,$10,$9,$10,$11,$11)
           RETURNING id, spent_on, title, vendor, amount_krw, memo,
                     evidence_document_id, status, void_reason, row_version,
                     recorded_by_name, created_at, updated_at`,
          [access.workspaceId, randomUUID(), input.spentOn, input.title, input.vendor,
            input.amountKrw, input.memo, input.evidenceDocumentId,
            access.uid, actorName, now],
        );
        return { ...result.rows[0], evidence_title: evidence.rows[0].title };
      });
      return res.status(201).json({ entry: serializeDevelopmentCost(created) });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }

  async function developmentCostVoid(req, res) {
    try {
      const id = normalizeUuid(req.params?.id);
      const input = normalizeVoid(req.body);
      const updated = await withTransaction(pool, async client => {
        const access = await accessOptions(client, req, 'write', 'DEVELOPMENT_COST');
        const existing = await client.query(
          `SELECT id, status, row_version
             FROM peakos_development_cost_entries
            WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
          [access.workspaceId, id],
        );
        if (!existing.rows[0]) throw new CompanyResourceError(404, 'COMPANY_RESOURCE_NOT_FOUND', '개발비 내역을 찾지 못했습니다.');
        if (existing.rows[0].status !== 'ACTIVE' || Number(existing.rows[0].row_version) !== input.expectedVersion) {
          throw new CompanyResourceError(409, 'COMPANY_RESOURCE_VERSION_CONFLICT', '개발비 내역이 이미 변경되었습니다.');
        }
        const result = await client.query(
          `UPDATE peakos_development_cost_entries
              SET status = 'VOIDED', void_reason = $3, row_version = row_version + 1,
                  last_changed_by_uid = $4, last_changed_by_name = $5,
                  updated_at = GREATEST($6::timestamptz, updated_at + INTERVAL '1 microsecond')
            WHERE workspace_id = $1 AND id = $2 AND status = 'ACTIVE' AND row_version = $7
           RETURNING id, spent_on, title, vendor, amount_krw, memo, evidence_document_id,
                     status, void_reason, row_version, recorded_by_name, created_at, updated_at`,
          [access.workspaceId, id, input.reason, access.uid, cleanActorName(getName(req)), clock(), input.expectedVersion],
        );
        if (!result.rows[0]) throw new CompanyResourceError(409, 'COMPANY_RESOURCE_VERSION_CONFLICT', '개발비 내역이 이미 변경되었습니다.');
        const evidence = await client.query(
          `SELECT title FROM peakos_protected_company_documents
            WHERE workspace_id = $1 AND id = $2`,
          [access.workspaceId, result.rows[0].evidence_document_id],
        );
        return { ...result.rows[0], evidence_title: evidence.rows[0]?.title || '' };
      });
      return res.json({ entry: serializeDevelopmentCost(updated) });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }

  async function documentList(req, res) {
    try {
      const access = await accessOptions(pool, req, 'read');
      const category = normalizeCategory(req.query?.category);
      const includeArchived = String(req.query?.includeArchived || '') === 'true';
      if (req.query?.includeArchived !== undefined
          && !['true', 'false', ''].includes(String(req.query.includeArchived))) {
        throw new CompanyResourceError(400, 'COMPANY_RESOURCE_HISTORY_INVALID', '자료 이력 조회 값이 올바르지 않습니다.');
      }
      const limit = pageLimit(req.query?.limit);
      const result = await pool.query(
        `SELECT id, logical_document_id, revision, supersedes_document_id, category,
                title, original_filename, mime_type, size_bytes, sha256, status,
                archive_reason, row_version, uploaded_by_name, created_at, updated_at
           FROM peakos_protected_company_documents
          WHERE workspace_id = $1 AND category = $2
            AND ($3::boolean = TRUE OR status = 'ACTIVE')
          ORDER BY created_at DESC, revision DESC, id DESC
          LIMIT $4`,
        [access.workspaceId, category, includeArchived, limit],
      );
      res.set?.('Cache-Control', 'private, no-store');
      res.vary?.('X-PeakOS-Workspace');
      return res.json({
        category,
        documents: result.rows.map(serializeDocument),
        capabilities: serializeCapabilities(access),
      });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }

  async function documentUpload(req, res) {
    let stored;
    let workspaceId;
    let transactionCompleted = false;
    try {
      const input = normalizeDocumentUpload(req.body);
      const created = await withTransaction(pool, async client => {
        const access = await accessOptions(client, req, 'write');
        workspaceId = access.workspaceId;
        const actorName = cleanActorName(getName(req));
        const now = clock();
        const id = randomUUID();
        let logicalDocumentId = id;
        let revision = 1;
        let parent = null;
        if (input.replacesDocumentId) {
          const parentResult = await client.query(
            `SELECT id, logical_document_id, revision, category, status, row_version
               FROM peakos_protected_company_documents
              WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
            [access.workspaceId, input.replacesDocumentId],
          );
          parent = parentResult.rows[0];
          if (!parent) throw new CompanyResourceError(404, 'COMPANY_RESOURCE_DOCUMENT_NOT_FOUND', '교체할 회사 자료를 찾지 못했습니다.');
          if (parent.status !== 'ACTIVE' || Number(parent.row_version) !== input.expectedVersion) {
            throw new CompanyResourceError(409, 'COMPANY_RESOURCE_VERSION_CONFLICT', '회사 자료가 이미 변경되었습니다.');
          }
          if (String(parent.category) !== input.category) {
            throw new CompanyResourceError(409, 'COMPANY_RESOURCE_CATEGORY_CONFLICT', '같은 구분의 회사 자료만 새 버전으로 교체할 수 있습니다.');
          }
          logicalDocumentId = parent.logical_document_id;
          revision = Number(parent.revision) + 1;
        }

        stored = await storage.store(access.workspaceId, req.file);
        if (parent) {
          const archived = await client.query(
            `UPDATE peakos_protected_company_documents
                SET status = 'ARCHIVED', archive_reason = $3, row_version = row_version + 1,
                    last_changed_by_uid = $4, last_changed_by_name = $5,
                    updated_at = GREATEST($6::timestamptz, updated_at + INTERVAL '1 microsecond')
              WHERE workspace_id = $1 AND id = $2 AND status = 'ACTIVE' AND row_version = $7
             RETURNING id`,
            [access.workspaceId, parent.id, `새 버전 ${id} 등록`, access.uid,
              actorName, now, input.expectedVersion],
          );
          if (!archived.rows[0]) throw new CompanyResourceError(409, 'COMPANY_RESOURCE_VERSION_CONFLICT', '회사 자료가 이미 변경되었습니다.');
        }
        const result = await client.query(
          `INSERT INTO peakos_protected_company_documents
             (workspace_id, id, logical_document_id, revision, supersedes_document_id,
              category, title, original_filename, stored_key, mime_type, size_bytes,
              sha256, status, archive_reason, row_version, uploaded_by_uid,
              uploaded_by_name, last_changed_by_uid, last_changed_by_name, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ACTIVE','',1,$13,$14,$13,$14,$15,$15)
           RETURNING id, logical_document_id, revision, supersedes_document_id, category,
                     title, original_filename, mime_type, size_bytes, sha256, status,
                     archive_reason, row_version, uploaded_by_name, created_at, updated_at`,
          [access.workspaceId, id, logicalDocumentId, revision, parent?.id || null,
            input.category, input.title, stored.originalFilename, stored.storedKey,
            stored.mimeType, stored.sizeBytes, stored.sha256, access.uid, actorName, now],
        );
        return result.rows[0];
      });
      transactionCompleted = true;
      return res.status(201).json({ document: serializeDocument(created) });
    } catch (error) {
      // Remove only after a known pre-commit/constraint failure. An unknown
      // COMMIT connection error has an ambiguous outcome, so preserving the
      // immutable file is safer than deleting a possibly committed document.
      const knownRollback = error instanceof CompanyResourceError
        || /^23/.test(String(error?.code || ''));
      if (!transactionCompleted && knownRollback && stored && workspaceId) {
        await storage.remove(workspaceId, stored.storedKey).catch(() => {});
      }
      return sendError(res, error, logger);
    }
  }

  async function documentArchive(req, res) {
    try {
      const id = normalizeUuid(req.params?.id);
      const input = normalizeVoid(req.body);
      const updated = await withTransaction(pool, async client => {
        const access = await accessOptions(client, req, 'write');
        const existing = await client.query(
          `SELECT id, status, row_version
             FROM peakos_protected_company_documents
            WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
          [access.workspaceId, id],
        );
        if (!existing.rows[0]) throw new CompanyResourceError(404, 'COMPANY_RESOURCE_DOCUMENT_NOT_FOUND', '회사 자료를 찾지 못했습니다.');
        if (existing.rows[0].status !== 'ACTIVE' || Number(existing.rows[0].row_version) !== input.expectedVersion) {
          throw new CompanyResourceError(409, 'COMPANY_RESOURCE_VERSION_CONFLICT', '회사 자료가 이미 변경되었습니다.');
        }
        const result = await client.query(
          `UPDATE peakos_protected_company_documents
              SET status = 'ARCHIVED', archive_reason = $3, row_version = row_version + 1,
                  last_changed_by_uid = $4, last_changed_by_name = $5,
                  updated_at = GREATEST($6::timestamptz, updated_at + INTERVAL '1 microsecond')
            WHERE workspace_id = $1 AND id = $2 AND status = 'ACTIVE' AND row_version = $7
           RETURNING id, logical_document_id, revision, supersedes_document_id, category,
                     title, original_filename, mime_type, size_bytes, sha256, status,
                     archive_reason, row_version, uploaded_by_name, created_at, updated_at`,
          [access.workspaceId, id, input.reason, access.uid, cleanActorName(getName(req)), clock(), input.expectedVersion],
        );
        if (!result.rows[0]) throw new CompanyResourceError(409, 'COMPANY_RESOURCE_VERSION_CONFLICT', '회사 자료가 이미 변경되었습니다.');
        return result.rows[0];
      });
      return res.json({ document: serializeDocument(updated) });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }

  async function documentContent(req, res) {
    try {
      const access = await accessOptions(pool, req, 'read');
      const id = normalizeUuid(req.params?.id);
      const result = await pool.query(
        `SELECT id, stored_key, original_filename, mime_type, size_bytes, sha256
           FROM peakos_protected_company_documents
          WHERE workspace_id = $1 AND id = $2`,
        [access.workspaceId, id],
      );
      const document = result.rows[0];
      if (!document) throw new CompanyResourceError(404, 'COMPANY_RESOURCE_DOCUMENT_NOT_FOUND', '회사 자료를 찾지 못했습니다.');
      const bytes = await storage.read(access.workspaceId, document);
      const encoded = encodeURIComponent(String(document.original_filename)).replace(/[!'()*]/g, character => (
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      ));
      res.set?.('Cache-Control', 'private, no-store');
      res.set?.('Content-Type', String(document.mime_type));
      res.set?.('Content-Length', String(bytes.length));
      res.set?.('X-Content-Type-Options', 'nosniff');
      res.set?.('Content-Disposition', `attachment; filename="company-resource"; filename*=UTF-8''${encoded}`);
      return res.status(200).send(bytes);
    } catch (error) {
      return sendError(res, error, logger);
    }
  }

  async function auditList(req, res) {
    try {
      const access = await accessOptions(pool, req, 'read');
      const entityType = String(req.query?.entityType || '').trim().toUpperCase();
      if (!['EQUIPMENT_USAGE', 'DEVELOPMENT_COST', 'PROTECTED_DOCUMENT'].includes(entityType)) {
        throw new CompanyResourceError(400, 'COMPANY_RESOURCE_AUDIT_TYPE_INVALID', '감사 이력 구분이 올바르지 않습니다.');
      }
      const entityId = normalizeUuid(req.query?.entityId);
      const result = await pool.query(
        `SELECT id, entity_type, entity_id, action, row_version, actor_name,
                before_state, after_state, created_at
           FROM peakos_company_resource_audit
          WHERE workspace_id = $1 AND entity_type = $2 AND entity_id = $3
          ORDER BY id DESC LIMIT 100`,
        [access.workspaceId, entityType, entityId],
      );
      res.set?.('Cache-Control', 'private, no-store');
      return res.json({ audit: result.rows.map(serializeAudit) });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }

  return Object.freeze({
    auditList,
    developmentCostCreate,
    developmentCostList,
    developmentCostVoid,
    documentArchive,
    documentContent,
    documentList,
    documentUpload,
    documentWriteGate,
    equipmentCreate,
    equipmentList,
    equipmentVoid,
    storage,
  });
}

function registerPeakosCompanyResourceRoutes({
  app,
  authMiddleware,
  uploadMiddleware = createUploadMiddleware(),
  ...options
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('Express app이 필요합니다.');
  }
  if (typeof authMiddleware !== 'function') throw new TypeError('authMiddleware가 필요합니다.');
  const service = createPeakosCompanyResourceService(options);
  const base = '/api/peakos/company-resources';
  app.get(`${base}/equipment-usage`, authMiddleware, service.equipmentList);
  app.post(`${base}/equipment-usage`, authMiddleware, service.equipmentCreate);
  app.post(`${base}/equipment-usage/:id/void`, authMiddleware, service.equipmentVoid);
  app.get(`${base}/development-costs`, authMiddleware, service.developmentCostList);
  app.post(`${base}/development-costs`, authMiddleware, service.developmentCostCreate);
  app.post(`${base}/development-costs/:id/void`, authMiddleware, service.developmentCostVoid);
  app.get(`${base}/documents`, authMiddleware, service.documentList);
  app.post(
    `${base}/documents`,
    authMiddleware,
    service.documentWriteGate,
    uploadMiddleware,
    service.documentUpload,
  );
  app.get(`${base}/documents/:id/content`, authMiddleware, service.documentContent);
  app.post(`${base}/documents/:id/archive`, authMiddleware, service.documentArchive);
  app.get(`${base}/audit`, authMiddleware, service.auditList);
  return service;
}

module.exports = {
  DOCUMENT_CATEGORIES,
  cleanActorName,
  createPeakosCompanyResourceService,
  createUploadMiddleware,
  registerPeakosCompanyResourceRoutes,
  sendError,
  publicAuditState,
  serializeAudit,
  serializeCapabilities,
  serializeDevelopmentCost,
  serializeDocument,
  serializeEquipment,
  withTransaction,
};
