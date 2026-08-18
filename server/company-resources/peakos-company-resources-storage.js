'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseJpegStructure,
  resolveDocumentRoot,
  validateConservativePdf,
} = require('../auth/peakos-company-documents');
const {
  CompanyResourceError,
  WORKSPACE_ID_PATTERN,
} = require('./peakos-company-resources-policy');

const DEFAULT_ROOT = '/var/lib/peakos/company-resources';
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MIN_DOCUMENT_BYTES = 32;
const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STORED_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:pdf|png|jpg)$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function storageFail(code, message, status = 503) {
  throw new CompanyResourceError(status, code, message);
}

function extensionForMime(mimeType) {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  storageFail('COMPANY_RESOURCE_MIME_INVALID', 'PDF, PNG, JPEG 파일만 등록할 수 있습니다.', 400);
}

function validatePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < MIN_DOCUMENT_BYTES
      || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8;
  let sawHeader = false;
  let sawData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > MAX_DOCUMENT_BYTES || offset + 12 + length > bytes.length) return false;
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return false;
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      const bitDepth = bytes[offset + 16];
      const colorType = bytes[offset + 17];
      if (!width || !height || width * height > 40_000_000
          || ![1, 2, 4, 8, 16].includes(bitDepth)
          || ![0, 2, 3, 4, 6].includes(colorType)) return false;
      sawHeader = true;
    }
    if (type === 'IDAT') sawData = true;
    offset += 12 + length;
    if (type === 'IEND') return length === 0 && sawHeader && sawData && offset === bytes.length;
  }
  return false;
}

function detectedMimeType(bytes) {
  if (validateConservativePdf(bytes)) return 'application/pdf';
  if (validatePng(bytes)) return 'image/png';
  const jpeg = parseJpegStructure(bytes);
  if (jpeg?.eoiOffset === bytes.length && jpeg.width > 0 && jpeg.height > 0
      && jpeg.width * jpeg.height <= 40_000_000) return 'image/jpeg';
  return null;
}

function validateDocumentFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    storageFail('COMPANY_RESOURCE_FILE_REQUIRED', '업로드할 원본 파일이 필요합니다.', 400);
  }
  if (file.buffer.length < MIN_DOCUMENT_BYTES || file.buffer.length > MAX_DOCUMENT_BYTES) {
    storageFail('COMPANY_RESOURCE_FILE_SIZE_INVALID', '회사 자료는 32바이트 이상 20MB 이하여야 합니다.', 400);
  }
  const declared = String(file.mimetype || '').trim().toLowerCase();
  const detected = detectedMimeType(file.buffer);
  if (!ALLOWED_MIME_TYPES.has(declared) || !detected || declared !== detected) {
    storageFail('COMPANY_RESOURCE_FILE_CONTENT_INVALID', '파일 내용과 PDF·PNG·JPEG 형식이 일치하지 않습니다.', 400);
  }
  return Object.freeze({
    mimeType: detected,
    sizeBytes: file.buffer.length,
    sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    extension: extensionForMime(detected),
  });
}

function safeOriginalFilename(value, extension) {
  const raw = String(value || '')
    .normalize('NFKC')
    .replace(/[\\/\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[.\s]+/u, '')
    .trim();
  const suffix = `.${extension}`;
  const cleaned = (raw || `company-resource${suffix}`)
    .replace(/\.(?:exe|com|bat|cmd|js|html?|svg|xml|php|sh)$/iu, '');
  const truncated = [...cleaned].slice(0, Math.max(1, 180 - suffix.length)).join('').trim();
  return (truncated.toLowerCase().endsWith(suffix) ? truncated : `${truncated}${suffix}`).slice(0, 180);
}

function targetPath(root, workspaceId, storedKey) {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId) || !STORED_KEY_PATTERN.test(storedKey)) {
    storageFail('COMPANY_RESOURCE_STORAGE_INVALID', '보호 자료 저장 경로를 확인하지 못했습니다.');
  }
  const workspaceRoot = path.resolve(root, workspaceId);
  const target = path.resolve(workspaceRoot, storedKey);
  const relative = path.relative(workspaceRoot, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative) || path.dirname(target) !== workspaceRoot) {
    storageFail('COMPANY_RESOURCE_STORAGE_INVALID', '보호 자료 저장 경로를 확인하지 못했습니다.');
  }
  return target;
}

function createCompanyResourceStorage({
  root = process.env.PEAKOS_COMPANY_RESOURCE_ROOT || DEFAULT_ROOT,
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  const documentRoot = resolveDocumentRoot(root);

  async function verifiedWorkspaceRoot(workspaceId, { create = false } = {}) {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
      storageFail('COMPANY_RESOURCE_STORAGE_INVALID', '보호 자료 워크스페이스를 확인하지 못했습니다.');
    }
    try {
      const rootStat = await fs.promises.lstat(documentRoot);
      const realRoot = await fs.promises.realpath(documentRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
          || (rootStat.mode & 0o777) !== 0o700 || path.resolve(realRoot) !== documentRoot) {
        storageFail('COMPANY_RESOURCE_STORAGE_INVALID', '보호 자료 저장소 권한을 확인하지 못했습니다.');
      }
      const workspaceRoot = path.join(documentRoot, workspaceId);
      if (create) {
        await fs.promises.mkdir(workspaceRoot, { mode: 0o700 }).catch(error => {
          if (error?.code !== 'EEXIST') throw error;
        });
      }
      const workspaceStat = await fs.promises.lstat(workspaceRoot);
      const realWorkspaceRoot = await fs.promises.realpath(workspaceRoot);
      if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()
          || (workspaceStat.mode & 0o777) !== 0o700
          || workspaceStat.uid !== rootStat.uid
          || path.resolve(realWorkspaceRoot) !== workspaceRoot) {
        storageFail('COMPANY_RESOURCE_STORAGE_INVALID', '워크스페이스 보호 저장소 권한을 확인하지 못했습니다.');
      }
      return Object.freeze({ rootStat, workspaceRoot });
    } catch (error) {
      if (error instanceof CompanyResourceError) throw error;
      storageFail('COMPANY_RESOURCE_STORAGE_INVALID', '보호 자료 저장소를 사용할 수 없습니다.');
    }
  }

  async function store(workspaceId, file) {
    const metadata = validateDocumentFile(file);
    const originalFilename = safeOriginalFilename(file.originalname, metadata.extension);
    const { workspaceRoot } = await verifiedWorkspaceRoot(workspaceId, { create: true });
    const storedKey = `${randomUUID()}.${metadata.extension}`;
    if (!STORED_KEY_PATTERN.test(storedKey)) {
      storageFail('COMPANY_RESOURCE_STORAGE_INVALID', '무작위 저장 식별자를 만들지 못했습니다.');
    }
    const finalPath = targetPath(documentRoot, workspaceId, storedKey);
    const temporaryId = randomUUID();
    if (!UUID_PATTERN.test(temporaryId)) {
      storageFail('COMPANY_RESOURCE_STORAGE_INVALID', '무작위 임시 저장 식별자를 만들지 못했습니다.');
    }
    const temporaryPath = path.join(workspaceRoot, `.pending-${temporaryId}`);
    let handle;
    let publishedByThisCall = false;
    try {
      handle = await fs.promises.open(
        temporaryPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      await handle.writeFile(file.buffer);
      await handle.sync();
      await handle.chmod(0o600);
      await handle.close();
      handle = null;
      // Hard-link publication is atomic and, unlike rename(), cannot replace a
      // pre-existing immutable document when an UUID collision is detected.
      await fs.promises.link(temporaryPath, finalPath);
      publishedByThisCall = true;
      await fs.promises.unlink(temporaryPath);
      const directoryHandle = await fs.promises.open(workspaceRoot, fs.constants.O_RDONLY);
      await directoryHandle.sync().catch(() => {});
      await directoryHandle.close();
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.promises.unlink(temporaryPath).catch(() => {});
      if (publishedByThisCall) await fs.promises.unlink(finalPath).catch(() => {});
      if (error instanceof CompanyResourceError) throw error;
      storageFail('COMPANY_RESOURCE_STORAGE_WRITE_FAILED', '보호 저장소에 회사 자료를 저장하지 못했습니다.');
    }
    return Object.freeze({ storedKey, originalFilename, ...metadata });
  }

  async function remove(workspaceId, storedKey) {
    const finalPath = targetPath(documentRoot, workspaceId, storedKey);
    await fs.promises.unlink(finalPath).catch(error => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }

  async function read(workspaceId, record) {
    const { rootStat, workspaceRoot } = await verifiedWorkspaceRoot(workspaceId);
    const storedKey = String(record?.stored_key || '');
    const finalPath = targetPath(documentRoot, workspaceId, storedKey);
    if (path.dirname(finalPath) !== workspaceRoot) {
      storageFail('COMPANY_RESOURCE_STORAGE_INVALID', '보호 자료 저장 경로를 확인하지 못했습니다.');
    }
    let handle;
    try {
      handle = await fs.promises.open(finalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== rootStat.uid
          || stat.size !== Number(record.size_bytes)
          || stat.size < MIN_DOCUMENT_BYTES || stat.size > MAX_DOCUMENT_BYTES) {
        storageFail('COMPANY_RESOURCE_STORAGE_TAMPERED', '회사 자료 원본 무결성을 확인하지 못했습니다.');
      }
      const bytes = await handle.readFile();
      const metadata = validateDocumentFile({ buffer: bytes, mimetype: record.mime_type });
      if (metadata.sha256 !== String(record.sha256)
          || metadata.sizeBytes !== Number(record.size_bytes)
          || metadata.mimeType !== String(record.mime_type)) {
        storageFail('COMPANY_RESOURCE_STORAGE_TAMPERED', '회사 자료 원본 무결성을 확인하지 못했습니다.');
      }
      return bytes;
    } catch (error) {
      if (error instanceof CompanyResourceError) throw error;
      storageFail('COMPANY_RESOURCE_STORAGE_UNAVAILABLE', '보호 저장소에서 회사 자료를 불러오지 못했습니다.');
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  return Object.freeze({ documentRoot, read, remove, store, verifiedWorkspaceRoot });
}

module.exports = {
  ALLOWED_MIME_TYPES,
  DEFAULT_ROOT,
  MAX_DOCUMENT_BYTES,
  MIN_DOCUMENT_BYTES,
  STORED_KEY_PATTERN,
  createCompanyResourceStorage,
  detectedMimeType,
  extensionForMime,
  safeOriginalFilename,
  targetPath,
  validateDocumentFile,
  validatePng,
};
