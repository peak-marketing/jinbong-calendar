'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const DEFAULT_DOCUMENT_ROOT = '/var/lib/peakos/company-documents';
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const CLIENT_MANIFEST_FILENAME = 'client-manifest.json';
const CLIENT_MANIFEST_VERSION = 1;
const MAX_CLIENT_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_CLIENT_DOCUMENT_RECORDS = 10_000;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE_NUMBER = 10_000;
const MAX_SEARCH_LENGTH = 80;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DRIVE_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{6,256}$/;
const STORED_FILENAME_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(png|jpg|pdf)$/i;
const MANIFEST_KEYS = Object.freeze(['documents', 'generatedAt', 'version']);
const MANIFEST_DOCUMENT_KEYS = Object.freeze([
  'available', 'canPreview', 'clientName', 'driveFileId', 'errorCode', 'filename',
  'height', 'id', 'importedAt', 'mimeType', 'originalMimeType', 'sha256', 'size',
  'storedFilename', 'width',
]);
const ORIGINAL_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'application/pdf']);
const STORED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'application/pdf']);
const PDF_FORBIDDEN_NAMES = Object.freeze([
  'JavaScript', 'JS', 'OpenAction', 'AA', 'Launch', 'SubmitForm', 'ImportData',
  'GoToR', 'GoToE', 'URI', 'EmbeddedFile', 'EmbeddedFiles', 'Filespec', 'RichMedia',
  'Movie', 'Sound', '3D', 'XFA', 'AcroForm', 'Encrypt', 'ObjStm',
]);

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

class CompanyDocumentError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = 'CompanyDocumentError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

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

function parseJpegStructure(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  let dimensions = null;
  let sawScan = false;
  let inEntropy = false;

  while (offset < bytes.length) {
    const fromEntropy = inEntropy;
    if (inEntropy) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      if (offset >= bytes.length) return null;
    } else if (bytes[offset] !== 0xff) {
      return null;
    }

    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];

    if (fromEntropy) {
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      inEntropy = false;
    } else {
      if (marker === 0x01) continue;
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) return null;
    }

    if (marker === 0xd9) {
      if (!dimensions || !sawScan) return null;
      return Object.freeze({ ...dimensions, eoiOffset: offset });
    }
    if (marker === 0xd8 || marker < 0xc0 || marker === 0xff) return null;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (length < 11) return null;
      const componentCount = bytes[offset + 7];
      if (componentCount < 1 || componentCount > 4 || length !== 8 + (3 * componentCount)) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (!width || !height || (dimensions && (dimensions.width !== width || dimensions.height !== height))) return null;
      dimensions = { width, height };
    } else if (marker === 0xda) {
      if (length < 8) return null;
      const componentCount = bytes[offset + 2];
      if (!dimensions || componentCount < 1 || componentCount > 4
          || length !== 6 + (2 * componentCount)) return null;
      sawScan = true;
    } else if (marker === 0xdc && length !== 4) {
      return null;
    }

    offset += length;
    if (marker === 0xda || (fromEntropy && marker === 0xdc)) inEntropy = true;
  }
  return null;
}

function jpegDimensions(bytes) {
  const parsed = parseJpegStructure(bytes);
  return parsed?.eoiOffset === bytes.length ? { width: parsed.width, height: parsed.height } : null;
}

function validateConservativePdf(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || !/^%PDF-1\.[0-7][\r\n]/.test(bytes.subarray(0, 10).toString('latin1'))) {
    return false;
  }
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096)).toString('latin1');
  if (!/startxref\s+\d+\s+%%EOF\s*$/.test(tail)) return false;
  const decodedNames = bytes.toString('latin1').replace(/#([0-9A-Fa-f]{2})/g, (_match, hex) => (
    String.fromCharCode(Number.parseInt(hex, 16))
  ));
  return !PDF_FORBIDDEN_NAMES.some(name => new RegExp(`/${name}(?![A-Za-z0-9])`).test(decodedNames));
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function strictIsoDate(value, fieldName) {
  if (typeof value !== 'string' || value.length > 40) {
    throw new CompanyDocumentError(`${fieldName} 형식이 올바르지 않습니다.`, 'COMPANY_DOCUMENT_INDEX_INVALID', 503);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new CompanyDocumentError(`${fieldName} 형식이 올바르지 않습니다.`, 'COMPANY_DOCUMENT_INDEX_INVALID', 503);
  }
  return value;
}

function strictDisplayText(value, fieldName, maxLength) {
  if (typeof value !== 'string' || !value || value.length > maxLength
      || value !== value.normalize('NFKC')
      || /[\\\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(value)) {
    throw new CompanyDocumentError(`${fieldName} 형식이 올바르지 않습니다.`, 'COMPANY_DOCUMENT_INDEX_INVALID', 503);
  }
  return value;
}

function parseClientManifest(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_CLIENT_MANIFEST_BYTES) {
    throw new CompanyDocumentError('거래처 문서 인덱스 크기가 올바르지 않습니다.', 'COMPANY_DOCUMENT_INDEX_INVALID', 503);
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (_) {
    throw new CompanyDocumentError('거래처 문서 인덱스 형식이 올바르지 않습니다.', 'COMPANY_DOCUMENT_INDEX_INVALID', 503);
  }
  if (!exactKeys(parsed, MANIFEST_KEYS) || parsed.version !== CLIENT_MANIFEST_VERSION
      || !Array.isArray(parsed.documents) || parsed.documents.length > MAX_CLIENT_DOCUMENT_RECORDS) {
    throw new CompanyDocumentError('거래처 문서 인덱스 구조가 올바르지 않습니다.', 'COMPANY_DOCUMENT_INDEX_INVALID', 503);
  }
  strictIsoDate(parsed.generatedAt, 'generatedAt');

  const ids = new Set();
  const driveIds = new Set();
  const storedNames = new Set();
  const documents = parsed.documents.map(record => {
    if (!exactKeys(record, MANIFEST_DOCUMENT_KEYS) || !UUID_PATTERN.test(String(record.id || ''))
        || !DRIVE_FILE_ID_PATTERN.test(String(record.driveFileId || ''))
        || typeof record.available !== 'boolean' || typeof record.canPreview !== 'boolean') {
      throw new CompanyDocumentError('거래처 문서 항목 구조가 올바르지 않습니다.', 'COMPANY_DOCUMENT_INDEX_INVALID', 503);
    }
    if (ids.has(record.id) || driveIds.has(record.driveFileId)) {
      throw new CompanyDocumentError('거래처 문서 식별자가 중복되었습니다.', 'COMPANY_DOCUMENT_INDEX_INVALID', 503);
    }
    ids.add(record.id);
    driveIds.add(record.driveFileId);
    const clientName = strictDisplayText(record.clientName, 'clientName', 160);
    const filename = strictDisplayText(record.filename, 'filename', 240);
    const importedAt = strictIsoDate(record.importedAt, 'importedAt');
    if (!ORIGINAL_MIME_TYPES.has(record.originalMimeType)) {
      throw new CompanyDocumentError('거래처 문서 원본 형식이 올바르지 않습니다.', 'COMPANY_DOCUMENT_INDEX_INVALID', 503);
    }

    if (record.available) {
      const storedMatch = typeof record.storedFilename === 'string'
        ? STORED_FILENAME_PATTERN.exec(record.storedFilename) : null;
      if (!storedMatch || storedNames.has(record.storedFilename) || !STORED_MIME_TYPES.has(record.mimeType)
          || !Number.isSafeInteger(record.size) || record.size < 24 || record.size > MAX_DOCUMENT_BYTES
          || !SHA256_PATTERN.test(String(record.sha256 || '')) || record.errorCode !== null) {
        throw new CompanyDocumentError('거래처 문서 저장 정보가 올바르지 않습니다.', 'COMPANY_DOCUMENT_INDEX_INVALID', 503);
      }
      const expectedExtension = record.mimeType === 'image/png' ? 'png'
        : (record.mimeType === 'image/jpeg' ? 'jpg' : 'pdf');
      if (storedMatch[2].toLowerCase() !== expectedExtension) {
        throw new CompanyDocumentError('거래처 문서 확장자가 형식과 다릅니다.', 'COMPANY_DOCUMENT_INDEX_INVALID', 503);
      }
      const image = record.mimeType !== 'application/pdf';
      if (image !== record.canPreview
          || (image && (!Number.isSafeInteger(record.width) || !Number.isSafeInteger(record.height)
            || record.width <= 0 || record.height <= 0 || record.width * record.height > 40_000_000))
          || (!image && (record.width !== null || record.height !== null))) {
        throw new CompanyDocumentError('거래처 문서 미리보기 정보가 올바르지 않습니다.', 'COMPANY_DOCUMENT_INDEX_INVALID', 503);
      }
      storedNames.add(record.storedFilename);
    } else if (record.storedFilename !== null || record.mimeType !== null || record.size !== null
        || record.sha256 !== null || record.width !== null || record.height !== null
        || record.canPreview !== false || typeof record.errorCode !== 'string'
        || !/^[A-Z][A-Z0-9_]{2,63}$/.test(record.errorCode)) {
      throw new CompanyDocumentError('사용할 수 없는 거래처 문서 상태가 올바르지 않습니다.', 'COMPANY_DOCUMENT_INDEX_INVALID', 503);
    }

    return Object.freeze({
      ...record,
      folder: 'clients',
      clientName,
      filename,
      importedAt,
      searchKey: `${clientName}\u0000${filename}`.normalize('NFKC').toLocaleLowerCase('ko-KR'),
    });
  });
  return Object.freeze({
    version: parsed.version,
    generatedAt: parsed.generatedAt,
    documents: Object.freeze(documents),
  });
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
    canPreview: Boolean(verified),
  };
}

function publicClientMetadata(document, available) {
  return {
    id: document.id,
    folder: 'clients',
    clientName: document.clientName,
    filename: document.filename,
    mimeType: document.mimeType,
    width: document.width,
    height: document.height,
    size: document.size || 0,
    updatedAt: document.importedAt,
    available: document.available === true && available === true,
    canPreview: document.available === true && available === true && document.canPreview === true,
  };
}

function secureResponse(res) {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Vary', 'Authorization, Cookie');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
  res.set('Referrer-Policy', 'no-referrer');
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

function safeReason(error) {
  const reason = String(error?.code || error?.message || 'UNKNOWN');
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(reason) ? reason : 'UNKNOWN';
}

function parseListQuery(query = {}) {
  const scalar = (value, name) => {
    if (Array.isArray(value)) throw new CompanyDocumentError(`${name} 값이 올바르지 않습니다.`, 'COMPANY_DOCUMENT_QUERY_INVALID');
    return value === undefined || value === null ? '' : String(value);
  };
  const folder = scalar(query.folder, 'folder').trim() || 'branches';
  if (!['branches', 'clients'].includes(folder)) {
    throw new CompanyDocumentError('문서 폴더가 올바르지 않습니다.', 'COMPANY_DOCUMENT_QUERY_INVALID');
  }
  const pageText = scalar(query.page, 'page').trim();
  const limitText = scalar(query.limit, 'limit').trim();
  const page = pageText ? (/^\d{1,5}$/.test(pageText) ? Number(pageText) : NaN) : 1;
  const limit = limitText ? (/^\d{1,3}$/.test(limitText) ? Number(limitText) : NaN) : DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE_NUMBER
      || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new CompanyDocumentError('페이지 값이 올바르지 않습니다.', 'COMPANY_DOCUMENT_QUERY_INVALID');
  }
  const rawQuery = scalar(query.q, 'q');
  if (/[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(rawQuery)) {
    throw new CompanyDocumentError('검색어가 올바르지 않습니다.', 'COMPANY_DOCUMENT_QUERY_INVALID');
  }
  const q = rawQuery.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (q.length > MAX_SEARCH_LENGTH) {
    throw new CompanyDocumentError('검색어가 너무 깁니다.', 'COMPANY_DOCUMENT_QUERY_INVALID');
  }
  return { folder, page, limit, q: q.toLocaleLowerCase('ko-KR') };
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
  let cachedManifest = null;

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

  async function verifiedRoot() {
    const rootStat = await fs.promises.lstat(documentRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('PRIVATE_ROOT_INVALID');
    if ((rootStat.mode & 0o777) !== 0o700) throw new Error('PRIVATE_ROOT_PERMISSIONS_INVALID');
    return rootStat;
  }

  async function verifiedClientFilesRoot(rootStat) {
    const filesRoot = path.join(documentRoot, 'files');
    const filesStat = await fs.promises.lstat(filesRoot);
    if (!filesStat.isDirectory() || filesStat.isSymbolicLink()
        || (filesStat.mode & 0o777) !== 0o700 || filesStat.uid !== rootStat.uid) {
      throw new Error('PRIVATE_FILES_ROOT_INVALID');
    }
    const realFilesRoot = await fs.promises.realpath(filesRoot);
    if (path.resolve(realFilesRoot) !== path.resolve(filesRoot) || !isInside(realFilesRoot, documentRoot)) {
      throw new Error('PRIVATE_FILES_ROOT_INVALID');
    }
    return { path: realFilesRoot, stat: filesStat };
  }

  function resolvedStoredPath(storedFilename, storageRoot = documentRoot) {
    if (typeof storedFilename !== 'string' || storedFilename !== path.basename(storedFilename)) {
      throw new Error('PRIVATE_PATH_INVALID');
    }
    const filePath = path.join(storageRoot, storedFilename);
    if (!isInside(filePath, storageRoot)) throw new Error('PRIVATE_PATH_INVALID');
    return filePath;
  }

  async function loadClientManifest() {
    const rootStat = await verifiedRoot();
    const manifestPath = path.join(documentRoot, CLIENT_MANIFEST_FILENAME);
    let handle;
    try {
      handle = await fs.promises.open(manifestPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== rootStat.uid
          || stat.size < 2 || stat.size > MAX_CLIENT_MANIFEST_BYTES) {
        throw new Error('PRIVATE_MANIFEST_INVALID');
      }
      const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (cachedManifest?.identity === identity) return cachedManifest.snapshot;
      const snapshot = parseClientManifest(await handle.readFile());
      cachedManifest = Object.freeze({ identity, snapshot });
      return snapshot;
    } finally {
      await handle?.close();
    }
  }

  async function inspectClientFile(document, rootStat = null, filesRoot = null) {
    if (!document.available || !document.storedFilename) return false;
    const checkedRoot = rootStat || await verifiedRoot();
    const checkedFiles = filesRoot || await verifiedClientFilesRoot(checkedRoot);
    let handle;
    try {
      handle = await fs.promises.open(
        resolvedStoredPath(document.storedFilename, checkedFiles.path),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      return stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.uid === checkedRoot.uid
        && stat.size === document.size && stat.size >= 24 && stat.size <= MAX_DOCUMENT_BYTES;
    } catch (_) {
      return false;
    } finally {
      await handle?.close();
    }
  }

  async function readVerified(document) {
    const rootStat = await verifiedRoot();
    if (document.folder === 'clients' && document.available !== true) throw new Error('PRIVATE_FILE_UNAVAILABLE');
    const storageRoot = document.folder === 'clients'
      ? (await verifiedClientFilesRoot(rootStat)).path
      : documentRoot;
    const filePath = resolvedStoredPath(document.storedFilename, storageRoot);
    let handle;
    try {
      handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 24 || stat.size > MAX_DOCUMENT_BYTES) throw new Error('PRIVATE_FILE_INVALID');
      if ((stat.mode & 0o777) !== 0o600 || stat.uid !== rootStat.uid) throw new Error('PRIVATE_FILE_PERMISSIONS_INVALID');
      if (document.folder === 'clients' && stat.size !== document.size) throw new Error('PRIVATE_FILE_SIZE_MISMATCH');
      const bytes = await handle.readFile();
      let dimensions = null;
      if (document.mimeType === 'image/png') dimensions = pngDimensions(bytes);
      else if (document.mimeType === 'image/jpeg') dimensions = jpegDimensions(bytes);
      else if (document.mimeType === 'application/pdf' && !validateConservativePdf(bytes)) {
        throw new Error('PRIVATE_PDF_INVALID');
      }
      if (document.mimeType !== 'application/pdf'
          && (!dimensions || dimensions.width !== document.width || dimensions.height !== document.height)) {
        throw new Error('PRIVATE_IMAGE_INVALID');
      }
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (digest !== document.sha256) throw new Error('PRIVATE_FILE_HASH_MISMATCH');
      return { bytes, stat };
    } finally {
      await handle?.close();
    }
  }

  async function listBranches(req, res) {
    let storageDegraded = false;
    const rows = await Promise.all(documents.map(async document => {
      try {
        return publicMetadata(document, await readVerified(document));
      } catch (error) {
        storageDegraded = true;
        logger?.error?.(`[company-documents] unavailable id=${document.id} reason=${safeReason(error)}`);
        return publicMetadata(document);
      }
    }));
    audit(logger, req, { action: 'list', outcome: storageDegraded ? 'COMPANY_DOCUMENT_STORAGE_DEGRADED' : 'SUCCESS' });
    return res.json({ documents: rows });
  }

  async function listClients(req, res, query) {
    const snapshot = await loadClientManifest();
    const filtered = snapshot.documents
      .filter(document => !query.q || document.searchKey.includes(query.q))
      .sort((left, right) => (left.searchKey < right.searchKey ? -1
        : (left.searchKey > right.searchKey ? 1 : left.id.localeCompare(right.id))));
    const total = filtered.length;
    const start = (query.page - 1) * query.limit;
    const pageRows = filtered.slice(start, start + query.limit);
    const rootStat = await verifiedRoot();
    const filesRoot = await verifiedClientFilesRoot(rootStat);
    let storageDegraded = false;
    const rows = await Promise.all(pageRows.map(async document => {
      const available = await inspectClientFile(document, rootStat, filesRoot);
      if (document.available && !available) storageDegraded = true;
      return publicClientMetadata(document, available);
    }));
    audit(logger, req, {
      action: 'list',
      outcome: storageDegraded ? 'COMPANY_DOCUMENT_STORAGE_DEGRADED' : 'SUCCESS',
    });
    return res.json({
      folder: 'clients',
      documents: rows,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: total ? Math.ceil(total / query.limit) : 0,
      },
    });
  }

  async function list(req, res) {
    secureResponse(res);
    const denied = authorizationError(req);
    if (denied) {
      audit(logger, req, { action: 'list', outcome: denied.code });
      return res.status(denied.status).json({ error: denied.error, code: denied.code });
    }
    let query;
    try {
      query = parseListQuery(req.query || {});
      if (query.folder === 'branches') return await listBranches(req, res);
      return await listClients(req, res, query);
    } catch (error) {
      const known = error instanceof CompanyDocumentError;
      const code = known ? error.code : 'COMPANY_DOCUMENT_INDEX_UNAVAILABLE';
      const status = known ? error.statusCode : 503;
      audit(logger, req, { action: 'list', outcome: code });
      logger?.error?.(`[company-documents] client-index unavailable reason=${safeReason(error)}`);
      return res.status(status).json({
        error: status === 400 ? error.message : '거래처 사업자등록증 목록을 불러오지 못했습니다.',
        code,
      });
    }
  }

  async function findDocument(id) {
    const branch = documentMap.get(id);
    if (branch) return branch;
    if (!UUID_PATTERN.test(id)) return null;
    const snapshot = await loadClientManifest();
    return snapshot.documents.find(document => document.id === id) || null;
  }

  async function content(req, res) {
    secureResponse(res);
    const denied = authorizationError(req);
    if (denied) {
      audit(logger, req, { action: 'content', documentId: null, outcome: denied.code });
      return res.status(denied.status).json({ error: denied.error, code: denied.code });
    }

    const requestedId = String(req.params?.id || '');
    let document;
    try {
      document = await findDocument(requestedId);
    } catch (error) {
      audit(logger, req, { action: 'content', documentId: null, outcome: 'COMPANY_DOCUMENT_INDEX_UNAVAILABLE' });
      logger?.error?.(`[company-documents] client-index unavailable reason=${safeReason(error)}`);
      return res.status(503).json({
        error: '거래처 사업자등록증 인덱스를 불러오지 못했습니다.',
        code: 'COMPANY_DOCUMENT_INDEX_UNAVAILABLE',
      });
    }
    if (!document) {
      audit(logger, req, { action: 'content', documentId: null, outcome: 'COMPANY_DOCUMENT_NOT_FOUND' });
      return res.status(404).json({ error: '사업자등록증을 찾지 못했습니다.', code: 'COMPANY_DOCUMENT_NOT_FOUND' });
    }
    if (document.folder === 'clients' && !document.available) {
      audit(logger, req, { action: 'content', documentId: document.id, outcome: 'COMPANY_DOCUMENT_STORAGE_UNAVAILABLE' });
      return res.status(503).json({
        error: '이 거래처 사업자등록증은 원본 점검이 필요합니다.',
        code: 'COMPANY_DOCUMENT_STORAGE_UNAVAILABLE',
      });
    }

    try {
      const verified = await readVerified(document);
      const extension = document.mimeType === 'image/png' ? 'png'
        : (document.mimeType === 'image/jpeg' ? 'jpg' : 'pdf');
      const fallback = `peakmarketing-${document.id}-business-registration.${extension}`;
      const encoded = encodeURIComponent(document.filename).replace(/[!'()*]/g, character => (
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      ));
      res.set('Content-Type', document.mimeType);
      res.set('Content-Length', String(verified.bytes.length));
      res.set('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
      audit(logger, req, { action: 'content', documentId: document.id, outcome: 'SUCCESS' });
      return res.status(200).send(verified.bytes);
    } catch (error) {
      audit(logger, req, { action: 'content', documentId: document.id, outcome: 'COMPANY_DOCUMENT_STORAGE_UNAVAILABLE' });
      logger?.error?.(`[company-documents] unavailable id=${document.id} reason=${safeReason(error)}`);
      return res.status(503).json({
        error: '보호 저장소에서 사업자등록증을 불러오지 못했습니다.',
        code: 'COMPANY_DOCUMENT_STORAGE_UNAVAILABLE',
      });
    }
  }

  return Object.freeze({ list, content, documentRoot, loadClientManifest });
}

function registerPeakosCompanyDocuments({ app, ...options } = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('Express app.get()이 필요합니다.');
  const service = createPeakosCompanyDocumentService(options);
  app.get('/api/peakos/company-documents', service.list);
  app.get('/api/peakos/company-documents/:id/content', service.content);
  return service;
}

module.exports = {
  CLIENT_MANIFEST_FILENAME,
  CLIENT_MANIFEST_VERSION,
  COMPANY_DOCUMENTS,
  DEFAULT_DOCUMENT_ROOT,
  MAX_CLIENT_DOCUMENT_RECORDS,
  MAX_CLIENT_MANIFEST_BYTES,
  MAX_DOCUMENT_BYTES,
  createPeakosCompanyDocumentService,
  parseJpegStructure,
  parseClientManifest,
  registerPeakosCompanyDocuments,
  resolveDocumentRoot,
  validateConservativePdf,
};
