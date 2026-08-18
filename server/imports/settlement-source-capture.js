'use strict';

const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const { MAX_WORKBOOK_BYTES } = require('./settlement-workbook-reader');

const CAPTURE_MANIFEST_FILE = 'capture-manifest.json';
const CAPTURE_VERSION = 1;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sourceIdentitySha256(documents) {
  if (!Array.isArray(documents) || documents.length !== 7) {
    throw new Error('확정된 7개 원본 문서가 필요합니다.');
  }
  const rawIds = documents.map(document => String(document?.documentId || '').trim());
  if (rawIds.some(documentId => !/^[A-Za-z0-9_-]{20,100}$/.test(documentId))
      || new Set(rawIds).size !== rawIds.length) {
    throw new Error('원본 문서 식별자가 올바르지 않습니다.');
  }
  const references = rawIds.map((documentId, index) => ({
    slot: index + 1,
    documentRefSha256: sha256(documentId),
  }));
  if (references.some(item => !/^[0-9a-f]{64}$/.test(item.documentRefSha256))
      || new Set(references.map(item => item.documentRefSha256)).size !== references.length) {
    throw new Error('원본 문서 식별자가 올바르지 않습니다.');
  }
  return sha256(JSON.stringify(references));
}

function safeSourceFilePath(sourceDir, document) {
  const fileName = String(document?.fileName || '');
  if (!fileName || fileName !== path.basename(fileName)
      || fileName.includes('/') || fileName.includes('\\') || !fileName.endsWith('.xlsx')) {
    throw new Error('원본 파일 이름이 allowlist 규칙에 맞지 않습니다.');
  }
  const resolvedDir = path.resolve(sourceDir);
  const resolvedFile = path.resolve(resolvedDir, fileName);
  if (!resolvedFile.startsWith(`${resolvedDir}${path.sep}`)) {
    throw new Error('원본 파일 경로가 올바르지 않습니다.');
  }
  return resolvedFile;
}

function capturePayload({ createdAt, sourceIdentity, files }) {
  return {
    version: CAPTURE_VERSION,
    createdAt,
    sourceIdentitySha256: sourceIdentity,
    files: files.map(file => ({
      slot: file.slot,
      sha256: file.sha256,
      byteLength: file.byteLength,
    })),
  };
}

function captureManifestSha256(payload) {
  return sha256(JSON.stringify(capturePayload({
    createdAt: payload.createdAt,
    sourceIdentity: payload.sourceIdentitySha256,
    files: payload.files,
  })));
}

function validateCaptureManifest(manifest, documents) {
  if (!manifest || manifest.version !== CAPTURE_VERSION
      || !Number.isFinite(Date.parse(manifest.createdAt))
      || manifest.sourceIdentitySha256 !== sourceIdentitySha256(documents)
      || !Array.isArray(manifest.files) || manifest.files.length !== 7) {
    throw new Error('원본 capture manifest가 올바르지 않습니다.');
  }
  const slots = manifest.files.map(file => Number(file?.slot));
  if (new Set(slots).size !== 7 || slots.some((slot, index) => slot !== index + 1)
      || manifest.files.some(file => !/^[0-9a-f]{64}$/.test(String(file?.sha256 || ''))
        || !Number.isSafeInteger(file?.byteLength) || file.byteLength <= 0
        || file.byteLength > MAX_WORKBOOK_BYTES)
      || !/^[0-9a-f]{64}$/.test(String(manifest.manifestSha256 || ''))
      || captureManifestSha256(manifest) !== manifest.manifestSha256) {
    throw new Error('원본 capture manifest pin이 올바르지 않습니다.');
  }
  return manifest;
}

async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function fsyncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(filePath, buffer, mode = 0o600) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.capture-${crypto.randomUUID()}.tmp`,
  );
  const handle = await fs.open(temporary, 'wx', mode);
  let renamed = false;
  try {
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, filePath);
    renamed = true;
    await fsyncDirectory(directory);
  } finally {
    await handle.close().catch(() => {});
    if (!renamed) await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function downloadWorkbookBuffer(document, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 120000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch 구현이 필요합니다.');
  const url = `https://docs.google.com/spreadsheets/d/${document.documentId}/export?format=xlsx`;
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  });
  if (!response?.ok) throw new Error('원본 XLSX HTTP 다운로드가 실패했습니다.');
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WORKBOOK_BYTES) {
    throw new Error('원본 XLSX가 크기 제한을 넘었습니다.');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length <= 0 || buffer.length > MAX_WORKBOOK_BYTES
      || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('원본 XLSX 파일 형식·크기가 올바르지 않습니다.');
  }
  return buffer;
}

async function captureSourceDirectory({
  documents,
  sourceDir,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120000,
  now = new Date(),
} = {}) {
  if (!Array.isArray(documents) || documents.length !== 7) {
    throw new Error('확정된 7개 원본 문서가 필요합니다.');
  }
  if (!sourceDir) throw new Error('--source-dir이 필요합니다.');
  const resolvedDir = path.resolve(sourceDir);
  let created = false;
  try {
    await fs.mkdir(resolvedDir, { mode: 0o700, recursive: false });
    created = true;
    const directoryStat = await fs.lstat(resolvedDir);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()
        || (directoryStat.mode & 0o777) !== 0o700) {
      throw new Error('capture 디렉터리는 mode 700이어야 합니다.');
    }
    const files = [];
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      const finalPath = safeSourceFilePath(resolvedDir, document);
      let buffer;
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          buffer = await downloadWorkbookBuffer(document, { fetchImpl, timeoutMs });
          break;
        } catch (error) {
          lastError = error;
          if (attempt === 3) throw error;
        }
      }
      if (!buffer) throw lastError || new Error('원본 XLSX capture가 실패했습니다.');
      await atomicWrite(finalPath, buffer);
      files.push({ slot: index + 1, sha256: sha256(buffer), byteLength: buffer.length });
    }
    const payload = capturePayload({
      createdAt: now.toISOString(),
      sourceIdentity: sourceIdentitySha256(documents),
      files,
    });
    const manifest = { ...payload, manifestSha256: captureManifestSha256(payload) };
    await atomicWrite(
      path.join(resolvedDir, CAPTURE_MANIFEST_FILE),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    );
    return { directory: resolvedDir, manifest };
  } catch (error) {
    if (created) await fs.rm(resolvedDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function verifyCapturedSourceDirectory(sourceDir, documents) {
  if (!sourceDir) throw new Error('--source-dir은 필수입니다.');
  const resolvedDir = path.resolve(sourceDir);
  const stat = await fs.lstat(resolvedDir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('--source-dir은 mode 700인 비공개 디렉터리여야 합니다.');
  }
  const expectedPaths = documents.map(document => safeSourceFilePath(resolvedDir, document));
  if (new Set(expectedPaths).size !== 7) throw new Error('원본 파일 이름이 중복됩니다.');
  const expectedNames = [
    ...expectedPaths.map(filePath => path.basename(filePath)),
    CAPTURE_MANIFEST_FILE,
  ].sort();
  const actualNames = (await fs.readdir(resolvedDir)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error('capture 디렉터리 파일 구성이 exact 일치하지 않습니다.');
  }
  const manifestPath = path.join(resolvedDir, CAPTURE_MANIFEST_FILE);
  const manifestStat = await fs.lstat(manifestPath);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()
      || (manifestStat.mode & 0o777) !== 0o600) {
    throw new Error('capture manifest는 mode 600 일반 파일이어야 합니다.');
  }
  const manifest = validateCaptureManifest(
    JSON.parse(await fs.readFile(manifestPath, 'utf8')),
    documents,
  );
  for (let index = 0; index < expectedPaths.length; index += 1) {
    const filePath = expectedPaths[index];
    const fileStat = await fs.lstat(filePath);
    const pin = manifest.files[index];
    if (fileStat.isSymbolicLink() || !fileStat.isFile()
        || (fileStat.mode & 0o777) !== 0o600
        || fileStat.size !== pin.byteLength || fileStat.size > MAX_WORKBOOK_BYTES) {
      throw new Error('capture XLSX 파일 권한·크기 pin이 다릅니다.');
    }
    const header = Buffer.alloc(2);
    const handle = await fs.open(filePath, 'r');
    try {
      await handle.read(header, 0, 2, 0);
    } finally {
      await handle.close();
    }
    if (header[0] !== 0x50 || header[1] !== 0x4b
        || await fileSha256(filePath) !== pin.sha256) {
      throw new Error('capture XLSX 내용 hash가 다릅니다.');
    }
  }
  return {
    directory: resolvedDir,
    manifestSha256: manifest.manifestSha256,
    files: manifest.files.map(file => ({ ...file })),
  };
}

function assertPlanMatchesCapture(plan, capture) {
  if (!Array.isArray(plan?.sourceFiles) || plan.sourceFiles.length !== 7
      || !capture || !Array.isArray(capture.files) || capture.files.length !== 7
      || plan.sourceFiles.some((file, index) => (
        file.sha256 !== capture.files[index].sha256
          || file.byteLength !== capture.files[index].byteLength
      ))) {
    throw new Error('정규화 plan이 capture manifest의 exact XLSX pin과 다릅니다.');
  }
  return true;
}

module.exports = {
  CAPTURE_MANIFEST_FILE,
  CAPTURE_VERSION,
  assertPlanMatchesCapture,
  captureManifestSha256,
  captureSourceDirectory,
  downloadWorkbookBuffer,
  safeSourceFilePath,
  sourceIdentitySha256,
  validateCaptureManifest,
  verifyCapturedSourceDirectory,
};
