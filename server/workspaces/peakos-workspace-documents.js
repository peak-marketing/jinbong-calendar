'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveDocumentRoot } = require('../auth/peakos-company-documents');

const DEFAULT_ROOT = '/var/lib/peakos/workspace-documents';
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_PAGE_SIZE = 100;
const SAFE_STORED_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SAFE_WORKSPACE_ID = /^ws_[a-z0-9_]{1,60}$/;
const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'application/pdf',
]);

class WorkspaceDocumentError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = 'WorkspaceDocumentError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function canonicalRoot(value = DEFAULT_ROOT) {
  return resolveDocumentRoot(String(value || DEFAULT_ROOT));
}

function requestWorkspaceId(req) {
  const id = String(req?.workspace?.id || '').trim();
  if (!SAFE_WORKSPACE_ID.test(id)) {
    throw new WorkspaceDocumentError(
      '워크스페이스를 확인할 수 없습니다.',
      'PEAKOS_WORKSPACE_REQUIRED',
      400,
    );
  }
  return id;
}

function cleanFolder(value) {
  const folder = String(value || 'branches').trim();
  if (!['branches', 'clients', 'manuals', 'bankbooks', 'other'].includes(folder)) {
    throw new WorkspaceDocumentError('올바르지 않은 자료 구분입니다.', 'WORKSPACE_DOCUMENT_FOLDER_INVALID', 400);
  }
  return folder;
}

function positiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return fallback;
  return Math.min(number, maximum);
}

function safeStoredPath(root, workspaceId, storedKey) {
  if (!SAFE_WORKSPACE_ID.test(workspaceId) || !SAFE_STORED_KEY.test(storedKey)) {
    throw new WorkspaceDocumentError('자료 저장 경로가 올바르지 않습니다.', 'WORKSPACE_DOCUMENT_STORAGE_INVALID', 503);
  }
  const workspaceRoot = path.resolve(root, workspaceId);
  const target = path.resolve(workspaceRoot, storedKey);
  const relative = path.relative(workspaceRoot, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new WorkspaceDocumentError('자료 저장 경로가 올바르지 않습니다.', 'WORKSPACE_DOCUMENT_STORAGE_INVALID', 503);
  }
  return target;
}

function serializeDocument(row) {
  const folder = String(row.category || 'other');
  const title = String(row.title || '회사 자료');
  return {
    id: String(row.id),
    folder,
    ...(folder === 'clients' ? { clientName: title } : { branch: title }),
    filename: title,
    mimeType: String(row.mime_type),
    size: Number(row.size_bytes) || 0,
    available: true,
    canPreview: ['image/png', 'image/jpeg', 'application/pdf'].includes(String(row.mime_type)),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function sendError(res, error, logger = console) {
  if (error instanceof WorkspaceDocumentError) {
    return res.status(error.statusCode).json({ code: error.code, error: error.message });
  }
  logger.error?.('workspace company document error:', error?.message || error);
  return res.status(500).json({
    code: 'WORKSPACE_DOCUMENT_FAILED',
    error: '워크스페이스 자료를 불러오지 못했습니다.',
  });
}

function createPeakosWorkspaceDocumentService({ pool, root = DEFAULT_ROOT, logger = console } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  const documentRoot = canonicalRoot(root);

  async function verifiedWorkspaceRoot(workspaceId) {
    try {
      const rootStat = await fs.promises.lstat(documentRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700) {
        throw new WorkspaceDocumentError('자료 저장소를 확인하지 못했습니다.', 'WORKSPACE_DOCUMENT_STORAGE_INVALID', 503);
      }
      const realRoot = await fs.promises.realpath(documentRoot);
      if (path.resolve(realRoot) !== documentRoot) {
        throw new WorkspaceDocumentError('자료 저장소를 확인하지 못했습니다.', 'WORKSPACE_DOCUMENT_STORAGE_INVALID', 503);
      }
      const workspaceRoot = path.join(documentRoot, workspaceId);
      const workspaceStat = await fs.promises.lstat(workspaceRoot);
      if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()
          || (workspaceStat.mode & 0o777) !== 0o700 || workspaceStat.uid !== rootStat.uid) {
        throw new WorkspaceDocumentError('자료 저장소를 확인하지 못했습니다.', 'WORKSPACE_DOCUMENT_STORAGE_INVALID', 503);
      }
      const realWorkspaceRoot = await fs.promises.realpath(workspaceRoot);
      if (path.resolve(realWorkspaceRoot) !== workspaceRoot) {
        throw new WorkspaceDocumentError('자료 저장소를 확인하지 못했습니다.', 'WORKSPACE_DOCUMENT_STORAGE_INVALID', 503);
      }
      return { rootStat, workspaceRoot };
    } catch (error) {
      if (error instanceof WorkspaceDocumentError) throw error;
      throw new WorkspaceDocumentError('자료 저장소를 확인하지 못했습니다.', 'WORKSPACE_DOCUMENT_STORAGE_INVALID', 503);
    }
  }

  async function list(req, res) {
    try {
      const workspaceId = requestWorkspaceId(req);
      const folder = cleanFolder(req.query?.folder);
      const page = positiveInteger(req.query?.page, 1, 10_000);
      const limit = positiveInteger(req.query?.limit, 25, MAX_PAGE_SIZE);
      const query = String(req.query?.q || '').trim().normalize('NFKC').slice(0, 80);
      const offset = (page - 1) * limit;
      const result = await pool.query(
        `SELECT id, category, title, mime_type, size_bytes, sha256, created_at, updated_at,
                COUNT(*) OVER()::integer AS total_count
           FROM peakos_workspace_documents
          WHERE workspace_id = $1
            AND category = $2
            AND deleted = FALSE
            AND ($3::text = '' OR title ILIKE '%' || $3 || '%')
          ORDER BY created_at DESC, id
          LIMIT $4 OFFSET $5`,
        [workspaceId, folder, query, limit, offset],
      );
      const total = Number(result.rows[0]?.total_count) || 0;
      const documents = result.rows.map(serializeDocument);
      res.set?.('Cache-Control', 'private, no-store');
      res.vary?.('X-PeakOS-Workspace');
      if (folder === 'clients') {
        return res.json({
          folder,
          documents,
          pagination: { page, limit, total, totalPages: total ? Math.ceil(total / limit) : 0 },
        });
      }
      return res.json({ folder, documents });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }

  async function content(req, res) {
    let handle;
    try {
      const workspaceId = requestWorkspaceId(req);
      const id = String(req.params?.id || '').trim();
      if (!/^[A-Za-z0-9:_-]{1,160}$/.test(id)) {
        throw new WorkspaceDocumentError('자료를 찾지 못했습니다.', 'WORKSPACE_DOCUMENT_NOT_FOUND', 404);
      }
      const result = await pool.query(
        `SELECT id, stored_key, mime_type, size_bytes, sha256, title
           FROM peakos_workspace_documents
          WHERE workspace_id = $1 AND id = $2 AND deleted = FALSE`,
        [workspaceId, id],
      );
      const row = result.rows[0];
      if (!row) throw new WorkspaceDocumentError('자료를 찾지 못했습니다.', 'WORKSPACE_DOCUMENT_NOT_FOUND', 404);
      if (!ALLOWED_MIME_TYPES.has(String(row.mime_type))
          || !Number.isSafeInteger(Number(row.size_bytes))
          || Number(row.size_bytes) < 0
          || Number(row.size_bytes) > MAX_DOCUMENT_BYTES
          || !/^[0-9a-f]{64}$/.test(String(row.sha256 || ''))) {
        throw new WorkspaceDocumentError('자료 메타데이터가 올바르지 않습니다.', 'WORKSPACE_DOCUMENT_STORAGE_INVALID', 503);
      }
      const { rootStat, workspaceRoot } = await verifiedWorkspaceRoot(workspaceId);
      const target = safeStoredPath(documentRoot, workspaceId, String(row.stored_key || ''));
      if (path.dirname(target) !== workspaceRoot) {
        throw new WorkspaceDocumentError('자료 저장 경로가 올바르지 않습니다.', 'WORKSPACE_DOCUMENT_STORAGE_INVALID', 503);
      }
      handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== rootStat.uid
          || stat.size !== Number(row.size_bytes) || stat.size > MAX_DOCUMENT_BYTES) {
        throw new WorkspaceDocumentError('자료 원본을 확인하지 못했습니다.', 'WORKSPACE_DOCUMENT_STORAGE_INVALID', 503);
      }
      const bytes = await handle.readFile();
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (digest !== String(row.sha256)) {
        throw new WorkspaceDocumentError('자료 원본 무결성을 확인하지 못했습니다.', 'WORKSPACE_DOCUMENT_STORAGE_INVALID', 503);
      }
      res.set?.('Cache-Control', 'private, no-store');
      res.set?.('Content-Type', String(row.mime_type));
      res.set?.('Content-Length', String(bytes.length));
      res.set?.('X-Content-Type-Options', 'nosniff');
      return res.send(bytes);
    } catch (error) {
      return sendError(res, error, logger);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  return Object.freeze({ content, documentRoot, list });
}

module.exports = {
  ALLOWED_MIME_TYPES,
  DEFAULT_ROOT,
  MAX_DOCUMENT_BYTES,
  WorkspaceDocumentError,
  createPeakosWorkspaceDocumentService,
  requestWorkspaceId,
  safeStoredPath,
  serializeDocument,
};
