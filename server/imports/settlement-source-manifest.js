'use strict';

const crypto = require('node:crypto');

const REQUESTED_MONTHS = Object.freeze(['2026-06', '2026-07', '2026-08']);
const REQUIRED_PEOPLE = Object.freeze([
  '김대호',
  '전현우',
  '박종원',
  '김주현',
  '김지홍',
  '박우진',
  '김용일',
]);

// Public source control contains only the approved owner/tab topology. Actual
// Google document ids and Firebase UIDs are supplied from 0600 secrets or the
// process environment and are never written to stdout.
const SOURCE_DOCUMENTS = Object.freeze([
  Object.freeze({
    key: 'kim-daeho',
    ownerName: '김대호',
    fileName: '김대호.xlsx',
    special: Object.freeze({ sheetName: '직접 실행시트', view: 'direct-execution' }),
  }),
  Object.freeze({
    key: 'jeon-hyeonwoo',
    ownerName: '전현우',
    fileName: '회사일별_전현우.xlsx',
  }),
  Object.freeze({
    key: 'park-jongwon',
    ownerName: '박종원',
    fileName: '박종원.xlsx',
    approvedDateCorrections: Object.freeze({ '2062-07-13': '2026-07-13' }),
  }),
  Object.freeze({
    key: 'kim-juhyeon',
    ownerName: '김주현',
    fileName: '김주현.xlsx',
    excludedSheets: Object.freeze(['2026-08 (체크용)']),
  }),
  Object.freeze({
    key: 'kim-jihong',
    ownerName: '김지홍',
    fileName: '김지홍.xlsx',
    special: Object.freeze({ sheetName: '월보작업건', view: 'monthly-guarantee' }),
  }),
  Object.freeze({
    key: 'park-woojin',
    ownerName: '박우진',
    fileName: '박우진.xlsx',
    special: Object.freeze({ sheetName: '플레이스 관리형', view: 'monthly-manage' }),
  }),
  Object.freeze({
    key: 'kim-yongil',
    ownerName: '김용일',
    fileName: '김용일.xlsx',
  }),
]);

const BASELINE_EXPECTATIONS = Object.freeze({
  // Independent workbook verification confirmed that the former 62
  // "incomplete" rows are valid continuation rows under merged date/client
  // groups. Both fields must be filled down and all 1,706 rows imported.
  individual: Object.freeze({ candidateRows: 1706, acceptedRows: 1706, quarantinedRows: 0 }),
  special: Object.freeze({
    'direct-execution': Object.freeze({ saleAccepted: 5, runAccepted: 0, quarantined: 0 }),
    'monthly-guarantee': Object.freeze({
      saleAccepted: 23, runAccepted: 11, quarantined: 0, parentResolved: 2, parentOrphan: 9,
    }),
    'monthly-manage': Object.freeze({
      saleAccepted: 3, runAccepted: 12, runCandidates: 13, quarantined: 1,
      parentResolved: 12, parentOrphan: 0,
    }),
  }),
  reasonCounts: Object.freeze({ NON_POSITIVE_QUANTITY: 1 }),
  individualMoney: Object.freeze({
    '김대호': Object.freeze({
      '2026-08': Object.freeze({ count: 5, k: 377800, l: 127400, n: 415580 }),
      '2026-07': Object.freeze({ count: 14, k: 2207990, l: 337491, n: 2428789 }),
      '2026-06': Object.freeze({ count: 117, k: 19555487, l: 4662449, n: 21511036 }),
    }),
    '전현우': Object.freeze({
      '2026-08': Object.freeze({ count: 24, k: 3652450, l: -217050, n: 4017695 }),
      '2026-07': Object.freeze({ count: 124, k: 23480100, l: 268800, n: 25828110 }),
      '2026-06': Object.freeze({ count: 256, k: 27992790, l: 3769186, n: 30792069 }),
    }),
    '박종원': Object.freeze({
      '2026-08': Object.freeze({ count: 34, k: 26228750, l: 957614, n: 28851627 }),
      '2026-07': Object.freeze({ count: 128, k: 87813125, l: 1453967, n: 96594446 }),
      '2026-06': Object.freeze({ count: 306, k: 48998680, l: 5599780, n: 53851028 }),
    }),
    '김주현': Object.freeze({
      '2026-08': Object.freeze({ count: 0, k: 0, l: 0, n: 0 }),
      '2026-07': Object.freeze({ count: 12, k: 6650000, l: 3670000, n: 7315000 }),
      '2026-06': Object.freeze({ count: 101, k: 16162200, l: 6626700, n: 17778420 }),
    }),
    '김지홍': Object.freeze({
      '2026-08': Object.freeze({ count: 8, k: 434000, l: 271000, n: 477400 }),
      '2026-07': Object.freeze({ count: 37, k: 1853200, l: 791850, n: 2038520 }),
      '2026-06': Object.freeze({ count: 118, k: 21340590, l: 4972610, n: 23474649 }),
    }),
    '박우진': Object.freeze({
      '2026-08': Object.freeze({ count: 5, k: 40000, l: -310000, n: 44000 }),
      '2026-07': Object.freeze({ count: 24, k: 3282500, l: 1602773, n: 3610750 }),
      '2026-06': Object.freeze({ count: 250, k: 33706720, l: 6985280, n: 37077392 }),
    }),
    '김용일': Object.freeze({
      '2026-08': Object.freeze({ count: 15, k: -260000, l: 216500, n: -286000 }),
      '2026-07': Object.freeze({ count: 66, k: 9450100, l: 3549300, n: 10395110 }),
      '2026-06': Object.freeze({ count: 62, k: 8443200, l: 2377700, n: 9287520 }),
    }),
  }),
  monthlyMoney: Object.freeze({
    '2026-08': Object.freeze({ count: 91, k: 30473000, l: 1045464, n: 33520302 }),
    '2026-07': Object.freeze({ count: 405, k: 134737015, l: 11674181, n: 148210725 }),
    '2026-06': Object.freeze({ count: 1210, k: 176199667, l: 34993705, n: 193772114 }),
    total: Object.freeze({ count: 1706, k: 341409682, l: 47713350, n: 375503141 }),
  }),
  specialMoney: Object.freeze({
    'direct-execution': Object.freeze({ saleK: 960000, saleN: 1056000, runCost: 0, profit: 960000 }),
    'monthly-guarantee': Object.freeze({ saleK: 4330000, saleN: 2013000, runCost: 440000, profit: 3890000 }),
    'monthly-manage': Object.freeze({ saleK: 1500000, saleN: 1650000, runCost: 361800, profit: 1138200 }),
  }),
  approvedDateCorrections: Object.freeze({ 'park-jongwon': 4 }),
  paymentState: Object.freeze({
    rows: 1706,
    expected: 375503141,
    paid: 358787485,
    positiveDue: Object.freeze({ rows: 49, amount: 21158226 }),
    credit: Object.freeze({ rows: 18, amount: -4442570 }),
    negativeExpected: 89,
    zeroExpected: 108,
    buckets: Object.freeze({
      'normal:paid': Object.freeze({ count: 1514 }),
      'normal:none': Object.freeze({
        count: 65, expected: 20415506, positiveDue: 20459066, credit: -43560,
      }),
      'normal:wrong': Object.freeze({
        count: 17, expected: -3798850, positiveDue: 160160, credit: -3959010,
      }),
      'use:paid': Object.freeze({ count: 100 }),
      'use:none': Object.freeze({ count: 6, expected: 539000, positiveDue: 539000, credit: 0 }),
      'refund:paid': Object.freeze({ count: 3, expected: -799700, paid: -799700 }),
      'refund:none': Object.freeze({ count: 1, expected: -440000 }),
    }),
    legacyUnpaidUse: Object.freeze({ count: 6, expected: 539000, paid: 0, emptyRef: 6 }),
  }),
});

function parseSourceMap(rawValue) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawValue || ''));
  } catch (_) {
    throw new Error('PEAKOS_SETTLEMENT_SOURCE_MAP_JSON 형식이 올바르지 않습니다.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PEAKOS_SETTLEMENT_SOURCE_MAP_JSON 설정이 필요합니다.');
  }
  const expectedKeys = new Set(SOURCE_DOCUMENTS.map(document => document.key));
  const actualKeys = Object.keys(parsed);
  if (actualKeys.length !== expectedKeys.size || actualKeys.some(key => !expectedKeys.has(key))) {
    throw new Error('시트 원본 매핑은 지정된 7개 문서만 정확히 포함해야 합니다.');
  }
  const ids = new Set();
  return SOURCE_DOCUMENTS.map(template => {
    const configured = parsed[template.key];
    const documentId = String(typeof configured === 'string' ? configured : configured?.documentId || '').trim();
    const initialGid = String(typeof configured === 'object' && configured ? configured.initialGid || '' : '').trim();
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(documentId) || ids.has(documentId)) {
      throw new Error(`${template.ownerName} 원본 문서 ID가 누락·중복되었거나 형식이 올바르지 않습니다.`);
    }
    if (initialGid && !/^\d{1,20}$/.test(initialGid)) {
      throw new Error(`${template.ownerName} 원본 gid 형식이 올바르지 않습니다.`);
    }
    ids.add(documentId);
    return Object.freeze({ ...template, documentId, initialGid });
  });
}

function sourceManifestSnapshot(documents = SOURCE_DOCUMENTS, sourceFiles = []) {
  return {
    version: 1,
    requestedMonths: [...REQUESTED_MONTHS],
    documents: documents.map(document => ({
      key: document.key,
      ownerName: document.ownerName,
      // A stable hash proves which external source was used without exposing
      // the Google id in a public repository, terminal, or run summary.
      documentRefSha256: document.documentId
        ? crypto.createHash('sha256').update(document.documentId).digest('hex')
        : null,
      monthlySheets: REQUESTED_MONTHS.map(month => `${month} 정산`),
      excludedSheets: [...(document.excludedSheets || [])],
      special: document.special ? { ...document.special } : null,
      approvedDateCorrections: { ...(document.approvedDateCorrections || {}) },
    })),
    sourceFiles: sourceFiles.map(file => ({
      key: file.key,
      sha256: file.sha256,
      byteLength: file.byteLength,
    })),
  };
}

function sourceManifestSha256(documents, sourceFiles = []) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(sourceManifestSnapshot(documents, sourceFiles)))
    .digest('hex');
}

module.exports = {
  BASELINE_EXPECTATIONS,
  REQUESTED_MONTHS,
  REQUIRED_PEOPLE,
  SOURCE_DOCUMENTS,
  parseSourceMap,
  sourceManifestSha256,
  sourceManifestSnapshot,
};
