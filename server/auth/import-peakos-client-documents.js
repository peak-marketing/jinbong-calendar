#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const sharp = require('sharp');

const {
  COMPANY_DOCUMENTS,
  MAX_DOCUMENT_BYTES,
  parseJpegStructure,
  parseClientManifest,
  resolveDocumentRoot,
  validateConservativePdf,
} = require('./peakos-company-documents');

const MANIFEST_FILENAME = 'client-manifest.json';
const MANIFEST_VERSION = 1;
const DEFAULT_MAX_BYTES = MAX_DOCUMENT_BYTES;
const DEFAULT_MAX_PIXELS = 25 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RETRIES = 2;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_PRODUCTION_ROOT = '/var/lib/peakos/company-documents';
const MAX_INVENTORY_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'application/pdf',
]);
const ERROR_CODES = Object.freeze([
  'DOWNLOAD_FAILED',
  'DOWNLOAD_TOO_LARGE',
  'DRIVE_METADATA_MISMATCH',
  'UNSUPPORTED_DOCUMENT_TYPE',
  'IMAGE_INVALID',
  'IMAGE_TOO_LARGE',
  'IMAGE_MULTIFRAME_FORBIDDEN',
  'PDF_INVALID',
  'PDF_ACTIVE_CONTENT_FORBIDDEN',
  'PRIVATE_STORAGE_WRITE_FAILED',
  'CLIENT_IMPORT_LOCKED',
]);
const GOOGLE_DRIVE_HOSTS = Object.freeze(new Set([
  'drive.usercontent.google.com',
  'drive.google.com',
  'www.googleapis.com',
]));

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const GIF87_SIGNATURE = Buffer.from('GIF87a', 'ascii');
const GIF89_SIGNATURE = Buffer.from('GIF89a', 'ascii');
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const MANIFEST_KEYS = Object.freeze([
  'version', 'generatedAt', 'documents',
]);
const MANIFEST_DOCUMENT_KEYS = Object.freeze([
  'id', 'clientName', 'filename', 'driveFileId', 'available', 'storedFilename',
  'mimeType', 'originalMimeType', 'size', 'sha256', 'width', 'height',
  'canPreview', 'errorCode', 'importedAt',
]);
const INVENTORY_KEYS = Object.freeze(['version', 'documents']);
const INVENTORY_DOCUMENT_KEYS = Object.freeze(['clientName', 'filename', 'driveFileId', 'mimeType', 'parent', 'size']);
const RAW_INVENTORY_KEYS = Object.freeze(['clientName', 'id', 'mime', 'name', 'parent', 'size']);
const RAW_MIME_TYPES = Object.freeze({
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'application/pdf': 'application/pdf',
  'application/vnd.google-apps.folder': null,
  'text/plain': null,
  'application/x-zip-compressed': null,
});

class ClientDocumentImportError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'ClientDocumentImportError';
    this.code = code;
    this.retryable = retryable;
  }
}

function assertExactKeys(value, allowedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label}은 객체여야 합니다.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...allowedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} 필드가 계약과 일치하지 않습니다.`);
  }
}

function isStrictIso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  return new Date(value).toISOString() === value;
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isStoredFilename(value) {
  return typeof value === 'string'
    && value.length <= 64
    && !/[\\/]/.test(value)
    && /^[0-9a-f-]+\.(?:png|jpe?g|pdf)$/i.test(value)
    && isUuid(value.slice(0, value.lastIndexOf('.')));
}

function validateManifest(manifest) {
  assertExactKeys(manifest, MANIFEST_KEYS, 'client-manifest.json');
  if (manifest.version !== MANIFEST_VERSION) throw new TypeError('지원하지 않는 manifest version입니다.');
  if (!isStrictIso(manifest.generatedAt)) throw new TypeError('manifest generatedAt이 올바르지 않습니다.');
  if (!Array.isArray(manifest.documents)) throw new TypeError('manifest documents는 배열이어야 합니다.');

  const ids = new Set();
  const driveIds = new Set();
  for (const [index, document] of manifest.documents.entries()) {
    const label = `manifest documents[${index}]`;
    assertExactKeys(document, MANIFEST_DOCUMENT_KEYS, label);
    if (!isUuid(document.id) || ids.has(document.id)) throw new TypeError(`${label}.id가 올바르지 않습니다.`);
    ids.add(document.id);
    if (!isSafeDisplayText(document.clientName, 160)) {
      throw new TypeError(`${label}.clientName이 올바르지 않습니다.`);
    }
    if (!isSafeDisplayFilename(document.filename)) throw new TypeError(`${label}.filename이 올바르지 않습니다.`);
    if (!isDriveFileId(document.driveFileId) || driveIds.has(document.driveFileId)) {
      throw new TypeError(`${label}.driveFileId가 올바르지 않습니다.`);
    }
    driveIds.add(document.driveFileId);
    if (!ALLOWED_MIME_TYPES.includes(document.originalMimeType)) {
      throw new TypeError(`${label}.originalMimeType이 올바르지 않습니다.`);
    }
    const filenameMimeType = document.available === true ? document.mimeType : document.originalMimeType;
    if (document.filename !== canonicalFilename(document.filename, filenameMimeType)) {
      throw new TypeError(`${label}.filename 확장자가 MIME과 일치하지 않습니다.`);
    }
    if (!isStrictIso(document.importedAt)) throw new TypeError(`${label}.importedAt이 올바르지 않습니다.`);

    if (document.available === true) {
      if (!isStoredFilename(document.storedFilename)) throw new TypeError(`${label}.storedFilename이 올바르지 않습니다.`);
      if (!ALLOWED_MIME_TYPES.includes(document.mimeType) || document.mimeType === 'image/gif') {
        throw new TypeError(`${label}.mimeType이 올바르지 않습니다.`);
      }
      if (!Number.isSafeInteger(document.size) || document.size <= 0) throw new TypeError(`${label}.size가 올바르지 않습니다.`);
      if (typeof document.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(document.sha256)) {
        throw new TypeError(`${label}.sha256이 올바르지 않습니다.`);
      }
      if (document.errorCode !== null) throw new TypeError(`${label}.errorCode는 null이어야 합니다.`);
      if (document.mimeType === 'application/pdf') {
        if (document.width !== null || document.height !== null || document.canPreview !== false) {
          throw new TypeError(`${label} PDF 미리보기 계약이 올바르지 않습니다.`);
        }
      } else if (!Number.isSafeInteger(document.width) || document.width <= 0
        || !Number.isSafeInteger(document.height) || document.height <= 0
        || document.canPreview !== true) {
        throw new TypeError(`${label} 이미지 미리보기 계약이 올바르지 않습니다.`);
      }
    } else if (document.available === false) {
      for (const field of ['storedFilename', 'mimeType', 'size', 'sha256', 'width', 'height']) {
        if (document[field] !== null) throw new TypeError(`${label}.${field}는 null이어야 합니다.`);
      }
      if (document.canPreview !== false || !ERROR_CODES.includes(document.errorCode)) {
        throw new TypeError(`${label} unavailable 계약이 올바르지 않습니다.`);
      }
    } else {
      throw new TypeError(`${label}.available은 boolean이어야 합니다.`);
    }
  }
  parseClientManifest(Buffer.from(JSON.stringify(manifest), 'utf8'));
  return manifest;
}

function isSafeDisplayText(value, maxLength) {
  return typeof value === 'string'
    && value === value.normalize('NFKC')
    && value.length > 0
    && value.length <= maxLength
    && !/[\\\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(value);
}

function isSafeDisplayFilename(value) {
  return isSafeDisplayText(value, 240);
}

function isDriveFileId(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9_-]{6,256}$/.test(value)
    && !value.includes('://');
}

function extensionMatchesMime(filename, mimeType) {
  const extension = path.extname(filename).toLowerCase();
  return (mimeType === 'image/png' && extension === '.png')
    || (mimeType === 'image/jpeg' && (extension === '.jpg' || extension === '.jpeg'))
    || (mimeType === 'image/gif' && extension === '.gif')
    || (mimeType === 'application/pdf' && extension === '.pdf');
}

function canonicalFilename(filename, mimeType) {
  const base = filename.slice(0, filename.length - path.extname(filename).length);
  const extension = mimeType === 'application/pdf' ? '.pdf'
    : mimeType === 'image/jpeg' ? '.jpg'
      : '.png';
  return `${base}${extension}`;
}

function validateInventory(inventory, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  assertExactKeys(inventory, INVENTORY_KEYS, 'inventory');
  if (inventory.version !== 1) throw new TypeError('지원하지 않는 inventory version입니다.');
  if (!Array.isArray(inventory.documents) || inventory.documents.length > 1000) {
    throw new TypeError('inventory documents가 올바르지 않습니다.');
  }
  const driveIds = new Set();
  inventory.documents.forEach((document, index) => {
    const label = `inventory documents[${index}]`;
    assertExactKeys(document, INVENTORY_DOCUMENT_KEYS, label);
    if (!isSafeDisplayText(document.clientName, 160)) {
      throw new TypeError(`${label}.clientName이 올바르지 않습니다.`);
    }
    if (!isSafeDisplayFilename(document.filename)) throw new TypeError(`${label}.filename이 올바르지 않습니다.`);
    if (!isDriveFileId(document.driveFileId) || driveIds.has(document.driveFileId)) {
      throw new TypeError(`${label}.driveFileId가 올바르지 않습니다.`);
    }
    driveIds.add(document.driveFileId);
    if (!isDriveFileId(document.parent)) throw new TypeError(`${label}.parent가 올바르지 않습니다.`);
    if (!ALLOWED_MIME_TYPES.includes(document.mimeType)) {
      throw new TypeError(`${label}.mimeType이 허용되지 않습니다.`);
    }
    if (!Number.isSafeInteger(document.size) || document.size <= 0 || document.size > maxBytes) {
      throw new TypeError(`${label}.size가 허용 범위를 벗어났습니다.`);
    }
  });
  return inventory;
}

function normalizeRawDisplay(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim();
  return isSafeDisplayText(normalized, maxLength) ? normalized : null;
}

function convertRawInventory(rows, { maxBytes = DEFAULT_MAX_BYTES, logger = console } = {}) {
  if (!Array.isArray(rows) || rows.length > 10_000) throw new TypeError('raw inventory는 최대 10,000행의 배열이어야 합니다.');
  const documents = [];
  const skipped = [];
  const driveIds = new Set();

  rows.forEach((row, index) => {
    assertExactKeys(row, RAW_INVENTORY_KEYS, `raw inventory[${index}]`);
    if (!Object.hasOwn(RAW_MIME_TYPES, row.mime)) throw new TypeError(`raw inventory[${index}].mime이 올바르지 않습니다.`);
    const mimeType = RAW_MIME_TYPES[row.mime];
    if (mimeType === null) return;

    let code = null;
    const clientName = normalizeRawDisplay(row.clientName, 160);
    const filename = normalizeRawDisplay(row.name, 240);
    if (!clientName) code = 'RAW_CLIENT_NAME_MISSING';
    else if (!row.parent || !isDriveFileId(row.parent)) code = 'RAW_PARENT_MISSING';
    else if (!filename || !isDriveFileId(row.id)) code = 'RAW_ROW_INVALID';
    else if (!Number.isSafeInteger(row.size) || row.size <= 0 || row.size > maxBytes) code = 'RAW_DOCUMENT_TOO_LARGE';
    else if (driveIds.has(row.id)) code = 'RAW_DUPLICATE_DRIVE_ID';

    if (code) {
      skipped.push(Object.freeze({ index, code }));
      logger?.error?.(`[client-document-import] raw-skip index=${index} code=${code}`);
      return;
    }
    driveIds.add(row.id);
    documents.push(Object.freeze({
      clientName,
      filename,
      driveFileId: row.id,
      mimeType,
      parent: row.parent,
      size: row.size,
    }));
  });

  return Object.freeze({
    inventory: Object.freeze({ version: 1, documents: Object.freeze(documents) }),
    skipped: Object.freeze(skipped),
  });
}

function parseCliArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--inventory' && flag !== '--root') throw new TypeError(`알 수 없는 CLI 인자: ${flag}`);
    if (values[flag]) throw new TypeError(`중복 CLI 인자: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new TypeError(`${flag} 값이 필요합니다.`);
    values[flag] = value;
    index += 1;
  }
  if (!values['--inventory'] || !values['--root']) {
    throw new TypeError('--inventory와 --root 절대 경로가 모두 필요합니다.');
  }
  if (!path.isAbsolute(values['--inventory']) || !path.isAbsolute(values['--root'])) {
    throw new TypeError('--inventory와 --root는 절대 경로여야 합니다.');
  }
  return Object.freeze({ inventoryPath: path.resolve(values['--inventory']), root: path.resolve(values['--root']) });
}

async function readJsonFile(filePath, maxBytes, label) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new TypeError(`${label} 크기가 올바르지 않습니다.`);
    return JSON.parse((await handle.readFile()).toString('utf8'));
  } finally {
    await handle?.close();
  }
}

async function assertDedicatedPrivateRoot(directory) {
  const resolved = path.resolve(directory);
  const forbidden = new Set(['/', '/tmp', '/var', '/var/lib', '/usr', '/root', '/home', '/srv', '/opt']);
  if (forbidden.has(resolved)) throw new Error('PRIVATE_ROOT_TOO_BROAD');
  let stat;
  try {
    stat = await fs.promises.lstat(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const effectiveUid = process.geteuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || (Number.isSafeInteger(effectiveUid) && stat.uid !== effectiveUid)) {
    throw new Error('PRIVATE_ROOT_INVALID');
  }
  const allowedEntries = new Set([
    MANIFEST_FILENAME,
    'files',
    'quarantine',
    '.client-import.lock',
    ...COMPANY_DOCUMENTS.map(document => document.storedFilename),
  ]);
  const unexpected = (await fs.promises.readdir(resolved)).filter(name => !allowedEntries.has(name));
  if (unexpected.length) throw new Error('PRIVATE_ROOT_NOT_DEDICATED');
}

async function ensurePrivateDirectory(directory) {
  const createdPath = await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('PRIVATE_DIRECTORY_INVALID');
  if (createdPath !== undefined) await fs.promises.chmod(directory, 0o700);
  const secured = await fs.promises.lstat(directory);
  const effectiveUid = process.geteuid?.();
  if ((secured.mode & 0o777) !== 0o700
    || (Number.isSafeInteger(effectiveUid) && secured.uid !== effectiveUid)) {
    throw new Error('PRIVATE_DIRECTORY_PERMISSIONS_INVALID');
  }
}

async function writePrivateFile(filePath, bytes) {
  let handle;
  let createdByThisCall = false;
  try {
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600,
    );
    createdByThisCall = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    handle = null;
    if (createdByThisCall) await fs.promises.rm(filePath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeBlobAtomic(filesRoot, storedFilename, bytes, uuidFactory) {
  const finalPath = path.join(filesRoot, storedFilename);
  const temporaryPath = path.join(filesRoot, `.blob.${uuidFactory()}.tmp`);
  let temporaryCreated = false;
  let published = false;
  try {
    await writePrivateFile(temporaryPath, bytes);
    temporaryCreated = true;
    await fs.promises.link(temporaryPath, finalPath);
    published = true;
    await fs.promises.unlink(temporaryPath);
    temporaryCreated = false;
    await syncDirectory(filesRoot);
    return finalPath;
  } finally {
    if (temporaryCreated) await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function acquireImportLock(root) {
  const lockPath = path.join(root, '.client-import.lock');
  let handle;
  let createdByThisCall = false;
  try {
    handle = await fs.promises.open(
      lockPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600,
    );
    createdByThisCall = true;
    await handle.writeFile(`${process.pid}\n`);
    await handle.sync();
    await handle.chmod(0o600);
    const stat = await handle.stat();
    await syncDirectory(root);
    return { handle, lockPath, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (createdByThisCall) {
      await fs.promises.rm(lockPath, { force: true }).catch(() => {});
      await syncDirectory(root).catch(() => {});
    }
    if (error?.code === 'EEXIST') {
      throw new ClientDocumentImportError('CLIENT_IMPORT_LOCKED', '다른 거래처 문서 import가 실행 중입니다.', { retryable: false });
    }
    throw error;
  }
}

async function releaseImportLock(lock, root, logger) {
  await lock.handle.close().catch(() => {});
  try {
    const stat = await fs.promises.lstat(lock.lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== lock.dev || stat.ino !== lock.ino) {
      logger?.error?.('[client-document-import] import-lock-identity-mismatch');
      return;
    }
    await fs.promises.unlink(lock.lockPath);
    await syncDirectory(root);
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.error?.('[client-document-import] import-lock-release-failed');
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function writeManifestAtomic(root, manifest, uuidFactory = crypto.randomUUID) {
  validateManifest(manifest);
  const manifestPath = path.join(root, MANIFEST_FILENAME);
  const temporaryPath = path.join(root, `.${MANIFEST_FILENAME}.${uuidFactory()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('manifest가 허용 크기를 초과했습니다.');
  let published = false;
  try {
    await writePrivateFile(temporaryPath, bytes);
    await fs.promises.rename(temporaryPath, manifestPath);
    published = true;
    try {
      await fs.promises.chmod(manifestPath, 0o600);
      await syncDirectory(root);
    } catch (error) {
      error.manifestPublished = true;
      throw error;
    }
  } finally {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
  }
  return published;
}

function detectedMimeType(bytes) {
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).equals(GIF87_SIGNATURE) || bytes.subarray(0, 6).equals(GIF89_SIGNATURE))) {
    return 'image/gif';
  }
  if (bytes.length >= 8 && /^%PDF-1\.[0-9]/.test(bytes.subarray(0, 8).toString('ascii'))) return 'application/pdf';
  return null;
}

async function toLimitedBuffer(source, maxBytes) {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    const bytes = Buffer.from(source);
    if (bytes.length > maxBytes) throw new ClientDocumentImportError('DOWNLOAD_TOO_LARGE', '다운로드가 허용 크기를 초과했습니다.');
    return bytes;
  }
  if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
    throw new ClientDocumentImportError('DOWNLOAD_FAILED', 'downloader bytes가 Buffer 또는 stream이 아닙니다.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of source) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      source.destroy?.();
      throw new ClientDocumentImportError('DOWNLOAD_TOO_LARGE', '다운로드가 허용 크기를 초과했습니다.');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function normalizeDriveMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClientDocumentImportError('DRIVE_METADATA_MISMATCH', 'Drive metadata가 없습니다.');
  }
  return {
    id: String(value.id || ''),
    name: String(value.name || ''),
    mimeType: String(value.mimeType || ''),
    size: Number(value.size),
  };
}

function compareDriveMetadata(document, metadata, bytes) {
  if (metadata.id !== document.driveFileId
    || metadata.name !== document.filename
    || metadata.mimeType !== document.mimeType
    || metadata.size !== document.size
    || metadata.size !== bytes.length) {
    throw new ClientDocumentImportError('DRIVE_METADATA_MISMATCH', 'Drive metadata와 inventory 또는 파일이 일치하지 않습니다.');
  }
}

function assertAllowedDriveUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password
    || (url.port && url.port !== '443') || !GOOGLE_DRIVE_HOSTS.has(url.hostname)) {
    throw new ClientDocumentImportError('DOWNLOAD_FAILED', '허용되지 않은 Drive endpoint입니다.', { retryable: false });
  }
  return url;
}

function requestDriveResponse(url, { requestImpl, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error instanceof ClientDocumentImportError ? error
        : new ClientDocumentImportError('DOWNLOAD_FAILED', 'Drive HTTPS 요청이 실패했습니다.', { retryable: true }));
    };
    const request = requestImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'image/png, image/jpeg, image/gif, application/pdf',
        'User-Agent': 'peakos-private-document-import/1.0',
      },
      timeout: timeoutMs,
      rejectUnauthorized: true,
    }, response => {
      if (settled) {
        response.destroy?.();
        return;
      }
      settled = true;
      resolve(response);
    });
    request.once('error', fail);
    request.setTimeout?.(timeoutMs, () => {
      request.destroy(new ClientDocumentImportError('DOWNLOAD_FAILED', 'Drive HTTPS 요청 시간이 초과되었습니다.', { retryable: true }));
    });
    request.end();
  });
}

function singleHeader(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value.length === 1 ? String(value[0]) : null;
  return value == null ? null : String(value);
}

function responseHeader(response, name) {
  const distinct = response?.headersDistinct?.[name];
  if (distinct !== undefined) {
    if (!Array.isArray(distinct) || distinct.length !== 1) return null;
    return String(distinct[0]);
  }
  return singleHeader(response?.headers, name);
}

function contentDispositionFilename(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\r\n]/.test(value)) return null;
  const encoded = /(?:^|;)\s*filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(value);
  if (encoded) {
    const token = encoded[1].trim().replace(/^"|"$/g, '');
    try {
      return normalizeRawDisplay(decodeURIComponent(token), 240);
    } catch (_) {
      return null;
    }
  }
  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(value);
  if (!quoted) return null;
  try {
    const latin1Bytes = Buffer.from(quoted[1].replace(/\\(["\\])/g, '$1'), 'latin1');
    return normalizeRawDisplay(UTF8_DECODER.decode(latin1Bytes), 240);
  } catch (_) {
    return null;
  }
}

function createGoogleDriveDownloader({
  requestImpl = https.request,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
} = {}) {
  if (typeof requestImpl !== 'function') throw new TypeError('requestImpl이 필요합니다.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new TypeError('timeoutMs가 올바르지 않습니다.');
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5) throw new TypeError('maxRedirects가 올바르지 않습니다.');

  return async function googleDriveDownloader({ driveFileId, document }) {
    if (!isDriveFileId(driveFileId) || !document || document.driveFileId !== driveFileId) {
      throw new ClientDocumentImportError('DOWNLOAD_FAILED', 'Drive 요청 식별자가 올바르지 않습니다.', { retryable: false });
    }
    const initial = new URL('https://drive.usercontent.google.com/download');
    initial.searchParams.set('id', driveFileId);
    initial.searchParams.set('export', 'download');
    initial.searchParams.set('confirm', 't');

    async function follow(url, redirects) {
      const checkedUrl = assertAllowedDriveUrl(url);
      const response = await requestDriveResponse(checkedUrl, { requestImpl, timeoutMs });
      const statusCode = Number(response.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        const location = responseHeader(response, 'location');
        response.resume?.();
        if (!location || location.length > 2048 || redirects >= maxRedirects) {
          throw new ClientDocumentImportError('DOWNLOAD_FAILED', 'Drive redirect가 올바르지 않습니다.', { retryable: false });
        }
        let redirected;
        try {
          redirected = new URL(location, checkedUrl);
        } catch (_) {
          throw new ClientDocumentImportError('DOWNLOAD_FAILED', 'Drive redirect URL이 올바르지 않습니다.', { retryable: false });
        }
        return follow(assertAllowedDriveUrl(redirected), redirects + 1);
      }
      if (statusCode !== 200) {
        response.resume?.();
        const retryable = statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
        throw new ClientDocumentImportError('DOWNLOAD_FAILED', 'Drive 응답 상태가 올바르지 않습니다.', { retryable });
      }

      const lengthHeader = responseHeader(response, 'content-length');
      const typeHeader = responseHeader(response, 'content-type');
      const dispositionName = contentDispositionFilename(responseHeader(response, 'content-disposition'));
      if (!lengthHeader || !/^\d+$/.test(lengthHeader)) {
        response.destroy?.();
        throw new ClientDocumentImportError('DRIVE_METADATA_MISMATCH', 'Drive Content-Length가 없습니다.', { retryable: false });
      }
      const responseSize = Number(lengthHeader);
      const responseMime = String(typeHeader || '').split(';', 1)[0].trim().toLowerCase();
      const mimeMatches = responseMime === document.mimeType
        || (document.mimeType === 'application/pdf' && responseMime === 'application/octet-stream');
      const filenameMatches = dispositionName === document.filename
        || dispositionName === canonicalFilename(document.filename, document.mimeType);
      if (!Number.isSafeInteger(responseSize) || responseSize <= 0 || responseSize > maxBytes
        || responseSize !== document.size || !mimeMatches
        || !filenameMatches) {
        response.destroy?.();
        throw new ClientDocumentImportError('DRIVE_METADATA_MISMATCH', 'Drive 응답 metadata가 inventory와 일치하지 않습니다.', { retryable: false });
      }
      const bytes = await toLimitedBuffer(response, Math.min(maxBytes, document.size));
      if (bytes.length !== responseSize) {
        throw new ClientDocumentImportError('DRIVE_METADATA_MISMATCH', 'Drive 응답 본문 크기가 일치하지 않습니다.', { retryable: false });
      }
      return {
        bytes,
        metadata: {
          id: driveFileId,
          name: document.filename,
          mimeType: document.mimeType,
          size: responseSize,
        },
      };
    }

    return follow(initial, 0);
  };
}

async function downloadWithRetry(document, { downloader, retries, sleep }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await downloader({ driveFileId: document.driveFileId, document, attempt });
    } catch (error) {
      lastError = error;
      if (attempt === retries || error?.retryable === false) break;
      await sleep(Math.min(1000, 100 * (2 ** attempt)));
    }
  }
  if (lastError instanceof ClientDocumentImportError) throw lastError;
  throw new ClientDocumentImportError('DOWNLOAD_FAILED', 'Drive fixture/downloader가 문서를 반환하지 못했습니다.', {
    retryable: false,
    cause: lastError,
  });
}

function normalizePdfNames(text) {
  return text.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function validatePdf(bytes) {
  if (detectedMimeType(bytes) !== 'application/pdf') {
    throw new ClientDocumentImportError('PDF_INVALID', 'PDF signature가 올바르지 않습니다.');
  }
  const text = normalizePdfNames(bytes.toString('latin1'));
  const activeNames = [
    'JavaScript', 'JS', 'Launch', 'OpenAction', 'AA', 'RichMedia', 'EmbeddedFile',
    'EmbeddedFiles', 'Filespec', 'AcroForm', 'XFA', 'SubmitForm', 'ImportData',
    'GoToR', 'GoToE', 'URI', 'ObjStm', 'Movie', 'Sound', '3D', 'Encrypt',
  ];
  if (activeNames.some(name => new RegExp(`/${name}(?=[^A-Za-z0-9]|$)`, 'i').test(text))) {
    throw new ClientDocumentImportError('PDF_ACTIVE_CONTENT_FORBIDDEN', '능동 PDF token은 허용되지 않습니다.');
  }
  if (!validateConservativePdf(bytes)) {
    throw new ClientDocumentImportError('PDF_INVALID', 'PDF 구조 또는 EOF가 올바르지 않습니다.');
  }
  return {
    bytes,
    mimeType: 'application/pdf',
    extension: '.pdf',
    width: null,
    height: null,
    canPreview: false,
  };
}

async function validateImage(bytes, originalMimeType, { sharpImpl, maxPixels }) {
  if (detectedMimeType(bytes) !== originalMimeType) {
    throw new ClientDocumentImportError('IMAGE_INVALID', '이미지 signature와 MIME이 일치하지 않습니다.');
  }
  let canonicalBytes = bytes;
  let jpegStructure = null;
  if (originalMimeType === 'image/jpeg') {
    jpegStructure = parseJpegStructure(bytes);
    if (!jpegStructure) throw new ClientDocumentImportError('IMAGE_INVALID', 'JPEG marker 구조가 올바르지 않습니다.');
    canonicalBytes = bytes.subarray(0, jpegStructure.eoiOffset);
  }
  let metadata;
  try {
    metadata = await sharpImpl(canonicalBytes, { animated: true, failOn: 'error', limitInputPixels: maxPixels }).metadata();
  } catch (error) {
    if (/pixel limit|Input image exceeds/i.test(String(error?.message || ''))) {
      throw new ClientDocumentImportError('IMAGE_TOO_LARGE', '이미지 pixel 수가 허용 범위를 초과했습니다.');
    }
    throw new ClientDocumentImportError('IMAGE_INVALID', '이미지를 해석할 수 없습니다.');
  }
  const pages = Number(metadata.pages || 1);
  if (pages !== 1) throw new ClientDocumentImportError('IMAGE_MULTIFRAME_FORBIDDEN', '다중 frame 이미지는 허용되지 않습니다.');
  if (!Number.isSafeInteger(metadata.width) || metadata.width <= 0
    || !Number.isSafeInteger(metadata.height) || metadata.height <= 0
    || metadata.width * metadata.height > maxPixels) {
    throw new ClientDocumentImportError('IMAGE_TOO_LARGE', '이미지 크기가 허용 범위를 초과했습니다.');
  }
  const expectedFormat = originalMimeType === 'image/jpeg' ? 'jpeg' : originalMimeType.split('/')[1];
  if (metadata.format !== expectedFormat) throw new ClientDocumentImportError('IMAGE_INVALID', '이미지 decoder 형식이 일치하지 않습니다.');
  if (jpegStructure && (metadata.width !== jpegStructure.width || metadata.height !== jpegStructure.height)) {
    throw new ClientDocumentImportError('IMAGE_INVALID', 'JPEG marker와 decoder 크기가 일치하지 않습니다.');
  }

  try {
    await sharpImpl(canonicalBytes, { animated: true, failOn: 'error', limitInputPixels: maxPixels })
      .raw()
      .toBuffer();
  } catch (error) {
    throw new ClientDocumentImportError('IMAGE_INVALID', '이미지를 끝까지 decode하지 못했습니다.');
  }

  if (originalMimeType === 'image/gif') {
    let canonical;
    try {
      canonical = await sharpImpl(bytes, { animated: false, failOn: 'error', limitInputPixels: maxPixels })
        .png({ progressive: false })
        .toBuffer();
    } catch (error) {
      throw new ClientDocumentImportError('IMAGE_INVALID', 'GIF를 안전한 PNG로 변환하지 못했습니다.');
    }
    if (detectedMimeType(canonical) !== 'image/png') throw new ClientDocumentImportError('IMAGE_INVALID', 'PNG 변환 결과가 올바르지 않습니다.');
    return {
      bytes: canonical,
      mimeType: 'image/png',
      extension: '.png',
      width: metadata.width,
      height: metadata.height,
      canPreview: true,
    };
  }

  return {
    bytes: canonicalBytes,
    mimeType: originalMimeType,
    extension: originalMimeType === 'image/jpeg' ? '.jpg' : '.png',
    width: metadata.width,
    height: metadata.height,
    canPreview: true,
  };
}

async function validateDownloadedDocument(bytes, originalMimeType, options) {
  const detected = detectedMimeType(bytes);
  if (!ALLOWED_MIME_TYPES.includes(originalMimeType) || detected !== originalMimeType) {
    throw new ClientDocumentImportError('UNSUPPORTED_DOCUMENT_TYPE', '허용되지 않거나 위장된 문서 형식입니다.');
  }
  if (originalMimeType === 'application/pdf') return validatePdf(bytes);
  return validateImage(bytes, originalMimeType, options);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => worker()));
  return results;
}

function safeErrorCode(error) {
  return ERROR_CODES.includes(error?.code) ? error.code : 'PRIVATE_STORAGE_WRITE_FAILED';
}

async function quarantineFailure({ quarantineRoot, bytes, documentId, errorCode, importedAt, uuidFactory }) {
  const base = uuidFactory();
  if (!isUuid(base)) throw new TypeError('uuidFactory가 유효한 UUID를 반환해야 합니다.');
  const binaryPath = path.join(quarantineRoot, `${base}.bin`);
  const receiptPath = path.join(quarantineRoot, `${base}.json`);
  const receipt = Buffer.from(`${JSON.stringify({ id: documentId, errorCode, importedAt })}\n`, 'utf8');
  let binaryWritten = false;
  try {
    if (bytes?.length) {
      await writePrivateFile(binaryPath, bytes);
      binaryWritten = true;
    }
    await writePrivateFile(receiptPath, receipt);
  } catch (error) {
    if (binaryWritten) await fs.promises.rm(binaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readExistingManifest(root) {
  const manifestPath = path.join(root, MANIFEST_FILENAME);
  let handle;
  try {
    handle = await fs.promises.open(manifestPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const [manifestStat, rootStat] = await Promise.all([handle.stat(), fs.promises.lstat(root)]);
    if (!manifestStat.isFile() || (manifestStat.mode & 0o777) !== 0o600
      || manifestStat.uid !== rootStat.uid || manifestStat.size < 2 || manifestStat.size > MAX_MANIFEST_BYTES) {
      throw new Error('PRIVATE_MANIFEST_INVALID');
    }
    const manifest = validateManifest(JSON.parse((await handle.readFile()).toString('utf8')));
    return manifest;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function reusableStoredFile(record, filesRoot, rootUid) {
  if (!record?.available || !isStoredFilename(record.storedFilename)) return false;
  let handle;
  try {
    handle = await fs.promises.open(
      path.join(filesRoot, record.storedFilename),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== rootUid || stat.size !== record.size) return false;
    const bytes = await handle.readFile();
    return crypto.createHash('sha256').update(bytes).digest('hex') === record.sha256;
  } catch (_) {
    return false;
  } finally {
    await handle?.close();
  }
}

async function collectUnreferencedBlobs(filesRoot, referenced, rootUid, logger) {
  let removed = 0;
  for (const filename of await fs.promises.readdir(filesRoot)) {
    if (referenced.has(filename)) continue;
    const filePath = path.join(filesRoot, filename);
    let stat;
    try {
      stat = await fs.promises.lstat(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      logger?.error?.('[client-document-import] orphan-inspection-failed');
      continue;
    }
    if (!isStoredFilename(filename) || !stat.isFile() || stat.isSymbolicLink()
      || (stat.mode & 0o777) !== 0o600 || stat.uid !== rootUid) {
      logger?.error?.('[client-document-import] unknown-private-file-preserved');
      continue;
    }
    try {
      await fs.promises.unlink(filePath);
      removed += 1;
    } catch (_) {
      logger?.error?.('[client-document-import] orphan-cleanup-failed');
    }
  }
  if (removed) await syncDirectory(filesRoot);
  return removed;
}

function unavailableRecord(document, id, errorCode, importedAt) {
  return {
    id,
    clientName: document.clientName,
    filename: canonicalFilename(document.filename, document.mimeType),
    driveFileId: document.driveFileId,
    available: false,
    storedFilename: null,
    mimeType: null,
    originalMimeType: document.mimeType,
    size: null,
    sha256: null,
    width: null,
    height: null,
    canPreview: false,
    errorCode,
    importedAt,
  };
}

async function importClientDocuments({
  inventory,
  root,
  downloader,
  repositoryRoot = path.resolve(__dirname, '..', '..'),
  concurrency = DEFAULT_CONCURRENCY,
  retries = DEFAULT_RETRIES,
  maxBytes = DEFAULT_MAX_BYTES,
  maxPixels = DEFAULT_MAX_PIXELS,
  uuidFactory = crypto.randomUUID,
  now = () => new Date(),
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  sharpImpl = sharp,
  logger = console,
} = {}) {
  if (typeof downloader !== 'function') throw new TypeError('네트워크를 내장하지 않은 주입 downloader가 필요합니다.');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 3) {
    throw new TypeError('concurrency는 1~3이어야 합니다.');
  }
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 2) throw new TypeError('retries는 0~2여야 합니다.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 50 * 1024 * 1024) {
    throw new TypeError('maxBytes가 올바르지 않습니다.');
  }
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 100 * 1024 * 1024) {
    throw new TypeError('maxPixels가 올바르지 않습니다.');
  }
  validateInventory(inventory, { maxBytes });

  const requestedRoot = String(root || '');
  if (!path.isAbsolute(requestedRoot)) throw new TypeError('거래처 문서 root는 절대 경로여야 합니다.');
  const documentRoot = resolveDocumentRoot(requestedRoot, { repositoryRoot });
  if (documentRoot !== path.resolve(requestedRoot)) throw new Error('거래처 문서 root에 심볼릭 링크를 사용할 수 없습니다.');
  const filesRoot = path.join(documentRoot, 'files');
  const quarantineRoot = path.join(documentRoot, 'quarantine');
  await assertDedicatedPrivateRoot(documentRoot);
  await ensurePrivateDirectory(documentRoot);
  await ensurePrivateDirectory(filesRoot);
  await ensurePrivateDirectory(quarantineRoot);
  const importLock = await acquireImportLock(documentRoot);
  try {
  const previousManifest = await readExistingManifest(documentRoot);
  const previousRecords = new Map((previousManifest?.documents || []).map(document => [document.driveFileId, document]));
  const rootStat = await fs.promises.lstat(documentRoot);
  const createdFilenames = new Set();
  const generatedAt = now().toISOString();
  if (!isStrictIso(generatedAt)) throw new TypeError('now()는 유효한 Date를 반환해야 합니다.');

  let documents;
  let manifest;
  try {
  documents = await mapWithConcurrency(inventory.documents, concurrency, async document => {
    const previous = previousRecords.get(document.driveFileId) || null;
    const id = previous?.id || uuidFactory();
    if (!isUuid(id)) throw new TypeError('uuidFactory가 유효한 UUID를 반환해야 합니다.');
    let downloadedBytes = null;
    try {
      const response = await downloadWithRetry(document, { downloader, retries, sleep });
      downloadedBytes = await toLimitedBuffer(response?.bytes, maxBytes);
      const metadata = normalizeDriveMetadata(response?.metadata);
      compareDriveMetadata(document, metadata, downloadedBytes);
      const verified = await validateDownloadedDocument(downloadedBytes, document.mimeType, { sharpImpl, maxPixels });
      if (verified.bytes.length > maxBytes) {
        throw new ClientDocumentImportError('IMAGE_TOO_LARGE', '정규화된 이미지가 허용 크기를 초과했습니다.');
      }
      const digest = crypto.createHash('sha256').update(verified.bytes).digest('hex');
      const canReuse = previous?.available === true
        && previous.sha256 === digest
        && previous.mimeType === verified.mimeType
        && previous.size === verified.bytes.length
        && previous.width === verified.width
        && previous.height === verified.height
        && previous.canPreview === verified.canPreview
        && await reusableStoredFile(previous, filesRoot, rootStat.uid);
      const storedFilename = canReuse ? previous.storedFilename : `${uuidFactory()}${verified.extension}`;
      if (!isStoredFilename(storedFilename)) throw new TypeError('uuidFactory가 유효한 UUID를 반환해야 합니다.');
      if (!canReuse) {
        await writeBlobAtomic(filesRoot, storedFilename, verified.bytes, uuidFactory);
        createdFilenames.add(storedFilename);
      }
      return {
        id,
        clientName: document.clientName,
        filename: canonicalFilename(document.filename, verified.mimeType),
        driveFileId: document.driveFileId,
        available: true,
        storedFilename,
        mimeType: verified.mimeType,
        originalMimeType: document.mimeType,
        size: verified.bytes.length,
        sha256: digest,
        width: verified.width,
        height: verified.height,
        canPreview: verified.canPreview,
        errorCode: null,
        importedAt: generatedAt,
      };
    } catch (error) {
      const errorCode = safeErrorCode(error);
      logger?.error?.(`[client-document-import] unavailable id=${id} code=${errorCode}`);
      try {
        await quarantineFailure({
          quarantineRoot,
          bytes: downloadedBytes,
          documentId: id,
          errorCode,
          importedAt: generatedAt,
          uuidFactory,
        });
      } catch (quarantineError) {
        logger?.error?.(`[client-document-import] quarantine-failed id=${id}`);
      }
      return unavailableRecord(document, id, errorCode, generatedAt);
    }
  });

    manifest = validateManifest({ version: MANIFEST_VERSION, generatedAt, documents });
    await writeManifestAtomic(documentRoot, manifest, uuidFactory);
  } catch (error) {
    if (error?.manifestPublished !== true) {
      await Promise.all([...createdFilenames].map(filename => (
        fs.promises.rm(path.join(filesRoot, filename), { force: true }).catch(() => {})
      )));
      await syncDirectory(filesRoot).catch(() => {});
    }
    throw error;
  }

  const referenced = new Set(documents.filter(document => document.available).map(document => document.storedFilename));
  await collectUnreferencedBlobs(filesRoot, referenced, rootStat.uid, logger);
  return Object.freeze({ manifest, documentRoot });
  } finally {
    await releaseImportLock(importLock, documentRoot, logger);
  }
}

async function runCli(argv, {
  downloader,
  requestImpl,
  allowedRoot = DEFAULT_PRODUCTION_ROOT,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  logger = console,
  ...options
} = {}) {
  const args = parseCliArgs(argv);
  if (args.root !== path.resolve(allowedRoot)) {
    throw new TypeError(`CLI --root는 승인된 보호 경로 ${path.resolve(allowedRoot)}만 사용할 수 있습니다.`);
  }
  const rawRows = await readJsonFile(args.inventoryPath, MAX_INVENTORY_BYTES, 'inventory');
  const converted = convertRawInventory(rawRows, { maxBytes: options.maxBytes || DEFAULT_MAX_BYTES, logger });
  const inventory = validateInventory(converted.inventory, { maxBytes: options.maxBytes || DEFAULT_MAX_BYTES });
  const effectiveDownloader = downloader || createGoogleDriveDownloader({
    requestImpl: requestImpl || https.request,
    maxBytes: options.maxBytes || DEFAULT_MAX_BYTES,
    timeoutMs,
    maxRedirects,
  });
  const result = await importClientDocuments({
    inventory,
    root: args.root,
    downloader: effectiveDownloader,
    logger,
    ...options,
  });
  const available = result.manifest.documents.filter(document => document.available).length;
  const unavailable = result.manifest.documents.length - available;
  logger?.info?.(`거래처 문서 import 완료: available ${available} / unavailable ${unavailable} / raw 제외 ${converted.skipped.length}`);
  return Object.freeze({ ...result, skipped: converted.skipped });
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(`거래처 문서 import 실패: ${String(error?.message || error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWED_MIME_TYPES,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_PIXELS,
  DEFAULT_RETRIES,
  ERROR_CODES,
  MANIFEST_FILENAME,
  ClientDocumentImportError,
  convertRawInventory,
  createGoogleDriveDownloader,
  detectedMimeType,
  importClientDocuments,
  parseCliArgs,
  runCli,
  validateDownloadedDocument,
  validateInventory,
  validateManifest,
};
