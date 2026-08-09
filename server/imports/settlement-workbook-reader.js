'use strict';

const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const MAX_WORKBOOK_BYTES = 40 * 1024 * 1024;
const MAX_WORKSHEET_ROWS = 20000;
const MAX_WORKSHEET_COLUMNS = 120;
const XLSX_IGNORE_NODES = Object.freeze([
  'dataValidations',
  'extLst',
  'hyperlinks',
  'legacyDrawing',
  'pageMargins',
  'pageSetup',
  'picture',
  'printOptions',
  'sheetPr',
  'sheetProtection',
]);
const MERGE_ONLY_IGNORE_NODES = Object.freeze([
  'sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData',
  'autoFilter', 'rowBreaks', 'hyperlinks', 'pageMargins', 'dataValidations',
  'pageSetup', 'headerFooter', 'printOptions', 'picture', 'drawing',
  'sheetProtection', 'tableParts', 'conditionalFormatting', 'extLst',
]);

function columnNumber(label) {
  let value = 0;
  for (const character of String(label || '')) {
    value = (value * 26) + character.charCodeAt(0) - 64;
  }
  return value;
}

function validateMergeRange(range, sheetName) {
  const match = String(range || '').match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!match) throw new Error(`${sheetName} 시트의 병합 범위가 올바르지 않습니다.`);
  const startColumn = columnNumber(match[1]);
  const startRow = Number(match[2]);
  const endColumn = columnNumber(match[3]);
  const endRow = Number(match[4]);
  if (startColumn < 1 || startRow < 1 || endColumn < startColumn || endRow < startRow
      || endColumn > MAX_WORKSHEET_COLUMNS || endRow > MAX_WORKSHEET_ROWS) {
    throw new Error(`${sheetName} 시트의 병합 범위가 안전 크기 제한을 넘었습니다.`);
  }
  return Object.freeze({ startColumn, startRow, endColumn, endRow });
}

function attachMergeRanges(matrix, ranges) {
  Object.defineProperty(matrix, 'mergeRanges', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze(ranges),
  });
  return matrix;
}

function worksheetMergeRanges(worksheet) {
  return (worksheet.model?.merges || []).map(range => validateMergeRange(range, worksheet.name));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text || '').replace(/^\ufeff/, '');
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('CSV 따옴표가 닫히지 않았습니다.');
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

function safeCellValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return null;
  if (typeof value !== 'object') return value;
  // ExcelJS exposes formulas as { formula, result }. Only the cached result is
  // read; formula text, macros, hyperlinks and external links are never run.
  if (Object.prototype.hasOwnProperty.call(value, 'formula')
      || Object.prototype.hasOwnProperty.call(value, 'sharedFormula')) {
    return safeCellValue(value.result);
  }
  if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('');
  if (typeof value.text === 'string') return value.text;
  if (typeof value.result !== 'undefined') return safeCellValue(value.result);
  if (value.error) return null;
  return null;
}

function worksheetMatrix(worksheet) {
  const rowCount = Math.min(worksheet.actualRowCount || worksheet.rowCount || 0, MAX_WORKSHEET_ROWS);
  const columnCount = Math.min(
    Math.max(worksheet.actualColumnCount || 0, worksheet.columnCount || 0),
    MAX_WORKSHEET_COLUMNS,
  );
  if ((worksheet.actualRowCount || worksheet.rowCount || 0) > MAX_WORKSHEET_ROWS
      || (worksheet.actualColumnCount || worksheet.columnCount || 0) > MAX_WORKSHEET_COLUMNS) {
    throw new Error(`${worksheet.name} 시트가 안전 크기 제한을 넘었습니다.`);
  }
  const matrix = [];
  for (let rowNumber = 1; rowNumber <= rowCount; rowNumber += 1) {
    const values = [];
    for (let columnNumber = 1; columnNumber <= columnCount; columnNumber += 1) {
      values.push(safeCellValue(worksheet.getCell(rowNumber, columnNumber).value));
    }
    matrix.push(values);
  }
  return attachMergeRanges(matrix, worksheetMergeRanges(worksheet));
}

async function readMergeMetadata(buffer, sheetNames) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer, { ignoreNodes: [...MERGE_ONLY_IGNORE_NODES] });
  const wanted = Array.isArray(sheetNames) ? new Set(sheetNames.map(String)) : null;
  const result = new Map();
  workbook.eachSheet(worksheet => {
    if (!wanted || wanted.has(String(worksheet.name))) {
      result.set(String(worksheet.name), worksheetMergeRanges(worksheet));
    }
  });
  return result;
}

async function readWorkbookBuffer(buffer, {
  format = 'xlsx', csvSheetName = 'Sheet1', sheetNames,
} = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('워본은 Buffer여야 합니다.');
  if (!buffer.length || buffer.length > MAX_WORKBOOK_BYTES) {
    throw new Error('시트 워본 크기가 올바르지 않습니다.');
  }
  const normalizedFormat = String(format || '').toLocaleLowerCase('en-US');
  if (normalizedFormat === 'csv') {
    return new Map([[csvSheetName, parseCsv(buffer.toString('utf8'))]]);
  }
  if (normalizedFormat !== 'xlsx') throw new Error('CSV와 XLSX만 읽을 수 있습니다.');
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error('XLSX ZIP 헤더가 없습니다.');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer, { ignoreNodes: [...XLSX_IGNORE_NODES] });
  const sheets = new Map();
  const wanted = Array.isArray(sheetNames) ? new Set(sheetNames.map(String)) : null;
  workbook.eachSheet(worksheet => {
    if (wanted && !wanted.has(String(worksheet.name))) return;
    sheets.set(String(worksheet.name), worksheetMatrix(worksheet));
  });
  if (!sheets.size && !wanted) throw new Error('XLSX에 읽을 시트가 없습니다.');
  return sheets;
}

async function readWorkbookFile(filePath, options = {}) {
  const extension = path.extname(filePath).slice(1).toLocaleLowerCase('en-US');
  if (extension === 'xlsx') return readXlsxFileStreaming(filePath, options);
  const buffer = await fs.readFile(filePath);
  return {
    bufferSha256: sha256(buffer),
    byteLength: buffer.length,
    sheets: await readWorkbookBuffer(buffer, {
      ...options,
      format: options.format || extension,
    }),
  };
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

async function readXlsxFileStreaming(filePath, { sheetNames } = {}) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_WORKBOOK_BYTES) {
    throw new Error('시트 원본 크기가 올바르지 않습니다.');
  }
  const wanted = Array.isArray(sheetNames) ? new Set(sheetNames.map(String)) : null;
  const sheets = new Map();
  // Values are streamed to keep a 4 MB workbook from expanding to hundreds
  // of MB. A separate ExcelJS pass ignores sheetData entirely and reads only
  // bounded merge metadata used by the safe fill-down rules.
  const fileBuffer = await fs.readFile(filePath);
  if (fileBuffer.length !== stat.size) throw new Error('시트 원본이 읽는 중 변경되었습니다.');
  const pinnedSha256 = sha256(fileBuffer);
  const mergeMetadata = await readMergeMetadata(fileBuffer, sheetNames);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
  });
  for await (const worksheet of reader) {
    const capture = !wanted || wanted.has(String(worksheet.name));
    const matrix = [];
    for await (const row of worksheet) {
      // Every emitted worksheet must be drained. Skipping the iterator early
      // can leave ExcelJS' temporary ZIP entry stream alive after its backing
      // file has been removed, producing an asynchronous ENOENT after a
      // seemingly successful import plan.
      if (!capture) continue;
      if (row.number > MAX_WORKSHEET_ROWS) {
        throw new Error(`${worksheet.name} 시트가 안전 크기 제한을 넘었습니다.`);
      }
      const raw = Array.isArray(row.values) ? row.values.slice(1) : [];
      if (raw.length > MAX_WORKSHEET_COLUMNS) {
        throw new Error(`${worksheet.name} 시트가 안전 크기 제한을 넘었습니다.`);
      }
      while (matrix.length < row.number - 1) matrix.push([]);
      matrix.push(raw.map(safeCellValue));
    }
    if (capture) {
      sheets.set(
        String(worksheet.name),
        attachMergeRanges(matrix, mergeMetadata.get(String(worksheet.name)) || []),
      );
    }
  }
  const finalStat = await fs.stat(filePath);
  const finalSha256 = await fileSha256(filePath);
  if (finalStat.size !== stat.size || finalSha256 !== pinnedSha256) {
    throw new Error('시트 원본이 읽는 중 변경되었습니다.');
  }
  return {
    bufferSha256: pinnedSha256,
    byteLength: fileBuffer.length,
    sheets,
  };
}

async function downloadGoogleWorkbook(document, {
  fetchImpl = globalThis.fetch, timeoutMs = 30000, sheetNames,
} = {}) {
  if (!document || !/^[A-Za-z0-9_-]{20,100}$/.test(String(document.documentId || ''))) {
    throw new Error('고정 Google Sheet 문서 ID가 올바르지 않습니다.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch 구현이 필요합니다.');
  const url = `https://docs.google.com/spreadsheets/d/${document.documentId}/export?format=xlsx`;
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  });
  if (!response.ok) throw new Error(`${document.ownerName} 시트 다운로드 실패(${response.status})`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WORKBOOK_BYTES) {
    throw new Error(`${document.ownerName} 시트가 크기 제한을 넘었습니다.`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_WORKBOOK_BYTES) throw new Error(`${document.ownerName} 시트가 크기 제한을 넘었습니다.`);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'peakos-settlement-'));
  await fs.chmod(temporaryDirectory, 0o700);
  const temporaryFile = path.join(temporaryDirectory, 'source.xlsx');
  try {
    await fs.writeFile(temporaryFile, buffer, { mode: 0o600, flag: 'wx' });
    return await readXlsxFileStreaming(temporaryFile, { sheetNames });
  } finally {
    await fs.rm(temporaryFile, { force: true }).catch(() => {});
    await fs.rmdir(temporaryDirectory).catch(() => {});
  }
}

async function loadSourceWorkbook(document, {
  sourceDir, fetchImpl, timeoutMs, sheetNames,
} = {}) {
  if (sourceDir) {
    const resolvedDir = path.resolve(sourceDir);
    const resolvedFile = path.resolve(resolvedDir, document.fileName);
    if (!resolvedFile.startsWith(`${resolvedDir}${path.sep}`)) throw new Error('워본 파일 경로가 올바르지 않습니다.');
    const stat = await fs.lstat(resolvedFile);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Error(`${document.ownerName} 워본은 mode 600 일반 파일이어야 합니다.`);
    }
    return readWorkbookFile(resolvedFile, { sheetNames });
  }
  return downloadGoogleWorkbook(document, { fetchImpl, timeoutMs, sheetNames });
}

module.exports = {
  MAX_WORKBOOK_BYTES,
  XLSX_IGNORE_NODES,
  MERGE_ONLY_IGNORE_NODES,
  attachMergeRanges,
  downloadGoogleWorkbook,
  loadSourceWorkbook,
  parseCsv,
  readWorkbookBuffer,
  readWorkbookFile,
  readMergeMetadata,
  readXlsxFileStreaming,
  safeCellValue,
  worksheetMatrix,
};
