'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_DOCUMENT_ROOT = '/var/lib/peakos/company-documents';
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const COMPANY_DOCUMENTS = Object.freeze([
  Object.freeze({
    id: 'head-office', folder: 'branches', branch: '본사',
    filename: '본사 사업자등록증.png', storedFilename: 'head-office.png',
    mimeType: 'image/png', width: 649, height: 902,
    sha256: '6938ecd134adb5f59447e334b4ba8de9d3352e8212d8176b515831c0ddb38b8d',
  }),
  Object.freeze({
    id: 'jeonju-office', folder: 'branches', branch: '전주 지사',
    filename: '전주 지사 사업자등록증.png', storedFilename: 'jeonju-office.png',
    mimeType: 'image/png', width: 795, height: 878,
    sha256: '8d086bea90ed6c4d2902523f1007c66994dd1175a0783143397bdb62fd7e31b0',
  }),
  Object.freeze({
    id: 'daegu-office', folder: 'branches', branch: '대구 지사',
    filename: '대구 지사 사업자등록증.png', storedFilename: 'daegu-office.png',
    mimeType: 'image/png', width: 360, height: 547,
    sha256: 'ffb37563bd580062960b6bcc262a1338f0aa42f4b3ab01917b32f80c37cab0be',
  }),
]);

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalPath(value) {
  let current = path.resolve(value);
  const missing = [];
  while (true) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(current) : fs.realpathSync(current);
      return path.join(real, ...missing.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function resolveDocumentRoot(value, { repositoryRoot = path.resolve(__dirname, '..', '..') } = {}) {
  const input = String(value || DEFAULT_DOCUMENT_ROOT).trim();
  if (!path.isAbsolute(input)) throw new Error('PEAKOS_COMPANY_DOCUMENT_ROOT는 절대 경로여야 합니다.');
  const root = canonicalPath(input);
  const repository = canonicalPath(repositoryRoot);
  const publicUploads = canonicalPath(path.join(repository, 'uploads'));
  if (isInside(root, repository) || isInside(root, publicUploads)) {
    throw new Error('사업자등록증 저장소는 공개 코드와 uploads 밖에 있어야 합니다.');
  }
  return root;
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function publicMetadata(document, verified = null) {
  return {
    id: document.id,
    folder: document.folder,
    branch: document.branch,
    filename: document.filename,
    mimeType: document.mimeType,
    width: document.width,
    height: document.height,
    size: verified?.stat?.size || 0,
    updatedAt: verified?.stat?.mtime?.toISOString?.() || null,
    available: Boolean(verified),
  };
}

function secureResponse(res) {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Vary', 'Authorization, Cookie');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
}

function audit(logger, req, { action, documentId = null, outcome }) {
  const entry = {
    event: 'peakos_company_document_access',
    uid: String(req?.uid || ''),
    action,
    documentId,
    outcome,
    at: new Date().toISOString(),
  };
  logger?.info?.(JSON.stringify(entry));
}

function createPeakosCompanyDocumentService({
  root,
  documents = COMPANY_DOCUMENTS,
  canRead,
  logger = console,
  repositoryRoot,
} = {}) {
  if (typeof canRead !== 'function') throw new TypeError('canRead 권한 함수가 필요합니다.');
  const documentRoot = resolveDocumentRoot(root, { repositoryRoot });
  const documentMap = new Map(documents.map(document => [document.id, Object.freeze({ ...document })]));
  if (documentMap.size !== documents.length) throw new Error('사업자등록증 ID가 중복되었습니다.');

  function authorizationError(req) {
    if (canRead(req) !== true) {
      return { status: 403, code: 'COMPANY_DOCUMENT_FORBIDDEN', error: '사업자등록증 열람 권한이 없습니다.' };
    }
    const second = req.osSecondAuth;
    if (second?.required !== true || second?.verified !== true || String(second.uid || '') !== String(req.uid || '')) {
      return {
        status: 403,
        code: 'COMPANY_DOCUMENT_SECOND_AUTH_REQUIRED',
        error: '사업자등록증은 추가 이메일 인증이 활성화된 계정만 볼 수 있습니다.',
      };
    }
    return null;
  }

  async function readVerified(document) {
    const rootStat = await fs.promises.lstat(documentRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('PRIVATE_ROOT_INVALID');
    if ((rootStat.mode & 0o077) !== 0) throw new Error('PRIVATE_ROOT_PERMISSIONS_INVALID');

    const filePath = path.join(documentRoot, document.storedFilename);
    if (!isInside(filePath, documentRoot)) throw new Error('PRIVATE_PATH_INVALID');

    let handle;
    try {
      handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 24 || stat.size > MAX_DOCUMENT_BYTES) throw new Error('PRIVATE_FILE_INVALID');
      if ((stat.mode & 0o077) !== 0 || stat.uid !== rootStat.uid) throw new Error('PRIVATE_FILE_PERMISSIONS_INVALID');
      const bytes = await handle.readFile();
      const dimensions = pngDimensions(bytes);
      if (!dimensions || dimensions.width !== document.width || dimensions.height !== document.height) {
        throw new Error('PRIVATE_IMAGE_INVALID');
      }
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (digest !== document.sha256) throw new Error('PRIVATE_FILE_HASH_MISMATCH');
      return { bytes, stat };
    } finally {
      await handle?.close();
    }
  }

  async function list(req, res) {
    secureResponse(res);
    const denied = authorizationError(req);
    if (denied) {
      audit(logger, req, { action: 'list', outcome: denied.code });
      return res.status(denied.status).json({ error: denied.error, code: denied.code });
    }

    let storageDegraded = false;
    const rows = await Promise.all(documents.map(async document => {
      try {
        return publicMetadata(document, await readVerified(document));
      } catch (error) {
        storageDegraded = true;
        logger?.error?.(`[company-documents] unavailable id=${document.id} reason=${String(error?.code || error?.message || 'unknown')}`);
        return publicMetadata(document);
      }
    }));
    audit(logger, req, { action: 'list', outcome: storageDegraded ? 'COMPANY_DOCUMENT_STORAGE_DEGRADED' : 'SUCCESS' });
    return res.json({ documents: rows });
  }

  async function content(req, res) {
    secureResponse(res);
    const denied = authorizationError(req);
    if (denied) {
      audit(logger, req, { action: 'content', documentId: null, outcome: denied.code });
      return res.status(denied.status).json({ error: denied.error, code: denied.code });
    }

    const document = documentMap.get(String(req.params?.id || ''));
    if (!document) {
      audit(logger, req, { action: 'content', documentId: null, outcome: 'COMPANY_DOCUMENT_NOT_FOUND' });
      return res.status(404).json({ error: '사업자등록증을 찾지 못했습니다.', code: 'COMPANY_DOCUMENT_NOT_FOUND' });
    }

    try {
      const verified = await readVerified(document);
      const fallback = `peakmarketing-${document.id}-business-registration.png`;
      const encoded = encodeURIComponent(document.filename);
      res.set('Content-Type', document.mimeType);
      res.set('Content-Length', String(verified.bytes.length));
      res.set('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
      audit(logger, req, { action: 'content', documentId: document.id, outcome: 'SUCCESS' });
      return res.status(200).send(verified.bytes);
    } catch (error) {
      audit(logger, req, { action: 'content', documentId: document.id, outcome: 'COMPANY_DOCUMENT_STORAGE_UNAVAILABLE' });
      logger?.error?.(`[company-documents] unavailable id=${document.id} reason=${String(error?.code || error?.message || 'unknown')}`);
      return res.status(503).json({
        error: '보호 저장소에서 사업자등록증을 불러오지 못했습니다.',
        code: 'COMPANY_DOCUMENT_STORAGE_UNAVAILABLE',
      });
    }
  }

  return Object.freeze({ list, content, documentRoot });
}

function registerPeakosCompanyDocuments({ app, ...options } = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('Express app.get()이 필요합니다.');
  const service = createPeakosCompanyDocumentService(options);
  app.get('/api/peakos/company-documents', service.list);
  app.get('/api/peakos/company-documents/:id/content', service.content);
  return service;
}

module.exports = {
  COMPANY_DOCUMENTS,
  DEFAULT_DOCUMENT_ROOT,
  MAX_DOCUMENT_BYTES,
  createPeakosCompanyDocumentService,
  registerPeakosCompanyDocuments,
  resolveDocumentRoot,
};
