'use strict';

const crypto = require('node:crypto');

const {
  BASELINE_EXPECTATIONS,
  REQUESTED_MONTHS,
  sourceManifestSha256,
  sourceManifestSnapshot,
} = require('./settlement-source-manifest');
const { loadSourceWorkbook } = require('./settlement-workbook-reader');
const { normalizeIndividualSheet, normalizeSpecialSheet } = require('./settlement-normalizer');

function countReasons(quarantine) {
  const counts = {};
  quarantine.forEach(item => item.reasonCodes.forEach(code => {
    counts[code] = (counts[code] || 0) + 1;
  }));
  return counts;
}

function specialStats(records, quarantine) {
  const runs = records.filter(row => row.kind === 'run');
  const sales = records.filter(row => row.kind === 'sale');
  const saleK = sales.reduce((sum, row) => sum + (Number(row.source.salesAmount) || 0), 0);
  const saleN = sales.reduce((sum, row) => sum + (Number(row.source.grossAmount) || 0), 0);
  const runCost = runs.reduce(
    (sum, row) => sum + (Number(row.source.salespersonSupplyAmount) || 0), 0,
  );
  return {
    saleAccepted: sales.length,
    runAccepted: runs.length,
    runCandidates: runs.length + quarantine.filter(item => (
      item.reasonCodes.includes('NON_POSITIVE_QUANTITY')
    )).length,
    quarantined: quarantine.length,
    parentResolved: runs.filter(row => row.parentResolvedInImport === true).length,
    parentOrphan: runs.filter(row => row.parentResolvedInImport === false).length,
    money: { saleK, saleN, runCost, profit: saleK - runCost },
  };
}

function equalExpected(actual, expected) {
  if (typeof expected === 'number') {
    return typeof actual === 'number' && Number.isFinite(actual)
      && Math.abs(actual - expected) < 0.000001;
  }
  return actual === expected;
}

function compareExpected(actual = {}, expected, prefix, mismatches) {
  Object.entries(expected).forEach(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      compareExpected(actual?.[key] || {}, value, `${prefix}.${key}`, mismatches);
    } else if (!equalExpected(actual?.[key], value)) {
      mismatches.push({ field: `${prefix}.${key}`, expected: value, actual: actual?.[key] });
    }
  });
}

function baselineCheck({
  individual,
  special,
  reasonCounts,
  individualMoney,
  monthlyMoney,
  specialMoney,
  approvedDateCorrections,
  excludedChecks,
  uiInvariantFailures,
  sourceFiles,
  paymentState,
}) {
  const mismatches = [];
  compareExpected(individual, BASELINE_EXPECTATIONS.individual, 'individual', mismatches);
  Object.entries(BASELINE_EXPECTATIONS.special).forEach(([view, expected]) => {
    compareExpected(special[view] || {}, expected, `special.${view}`, mismatches);
  });
  Object.entries(BASELINE_EXPECTATIONS.reasonCounts).forEach(([code, expected]) => {
    const actual = reasonCounts[code] || 0;
    if (actual !== expected) mismatches.push({ field: `reasonCounts.${code}`, expected, actual });
  });
  Object.entries(reasonCounts).forEach(([code, actual]) => {
    if (!(code in BASELINE_EXPECTATIONS.reasonCounts) && actual > 0) {
      mismatches.push({ field: `reasonCounts.${code}`, expected: 0, actual });
    }
  });
  compareExpected(individualMoney, BASELINE_EXPECTATIONS.individualMoney, 'individualMoney', mismatches);
  compareExpected(monthlyMoney, BASELINE_EXPECTATIONS.monthlyMoney, 'monthlyMoney', mismatches);
  compareExpected(specialMoney, BASELINE_EXPECTATIONS.specialMoney, 'specialMoney', mismatches);
  compareExpected(
    approvedDateCorrections,
    BASELINE_EXPECTATIONS.approvedDateCorrections,
    'approvedDateCorrections',
    mismatches,
  );
  Object.entries(approvedDateCorrections || {}).forEach(([key, actual]) => {
    if (!(key in BASELINE_EXPECTATIONS.approvedDateCorrections) && actual > 0) {
      mismatches.push({ field: `approvedDateCorrections.${key}`, expected: 0, actual });
    }
  });
  compareExpected(paymentState, BASELINE_EXPECTATIONS.paymentState, 'paymentState', mismatches);
  Object.entries(paymentState?.buckets || {}).forEach(([key, bucket]) => {
    if (!(key in BASELINE_EXPECTATIONS.paymentState.buckets) && (bucket?.count || 0) > 0) {
      mismatches.push({ field: `paymentState.buckets.${key}.count`, expected: 0, actual: bucket.count });
    }
  });
  if (excludedChecks?.kimJuhyeonCheckOnlyObserved !== true) {
    mismatches.push({ field: 'excludedChecks.kimJuhyeonCheckOnlyObserved', expected: true, actual: false });
  }
  if (excludedChecks?.kimJuhyeonAugustMainIsZero !== true) {
    mismatches.push({ field: 'excludedChecks.kimJuhyeonAugustMainIsZero', expected: true, actual: false });
  }
  if (uiInvariantFailures !== 0) {
    mismatches.push({ field: 'uiInvariantFailures', expected: 0, actual: uiInvariantFailures });
  }
  const validSourceFiles = Array.isArray(sourceFiles) && sourceFiles.length === 7
    && sourceFiles.every(file => /^[0-9a-f]{64}$/.test(String(file.sha256 || ''))
      && Number.isSafeInteger(file.byteLength) && file.byteLength > 0);
  if (!validSourceFiles) {
    mismatches.push({ field: 'sourceFiles', expected: '7 hash-pinned files', actual: sourceFiles?.length || 0 });
  }
  return { ok: mismatches.length === 0, mismatches };
}

function individualMoneyStats(records) {
  return {
    count: records.length,
    k: records.reduce((sum, row) => sum + Math.round(Number(row.source.salesAmount) || 0), 0),
    l: records.reduce((sum, row) => sum + Math.round(Number(row.source.profitAmount) || 0), 0),
    n: records.reduce((sum, row) => sum + Math.round(Number(row.source.grossAmount) || 0), 0),
  };
}

function signedTargetAmount(row, field) {
  const sign = row.kind === 'refund' ? -1 : 1;
  return (Number(row[field]) || 0) * sign;
}

function paymentStateStats(records) {
  const buckets = {};
  let expected = 0;
  let paid = 0;
  let positiveDue = 0;
  let positiveDueRows = 0;
  let credit = 0;
  let creditRows = 0;
  let negativeExpected = 0;
  let zeroExpected = 0;
  for (const row of records) {
    const rowExpected = signedTargetAmount(row, 'expectedDepositAmount');
    const rowPaid = signedTargetAmount(row, 'paidAmount');
    const delta = rowExpected - rowPaid;
    const key = `${row.kind}:${row.paid}`;
    const bucket = buckets[key] || {
      count: 0, expected: 0, paid: 0, positiveDue: 0, credit: 0,
    };
    bucket.count += 1;
    bucket.expected += rowExpected;
    bucket.paid += rowPaid;
    if (delta > 0) {
      positiveDue += delta;
      positiveDueRows += 1;
      bucket.positiveDue += delta;
    } else if (delta < 0) {
      credit += delta;
      creditRows += 1;
      bucket.credit += delta;
    }
    buckets[key] = bucket;
    expected += rowExpected;
    paid += rowPaid;
    if (rowExpected < 0) negativeExpected += 1;
    if (rowExpected === 0) zeroExpected += 1;
  }
  const unpaidUse = records.filter(row => row.kind === 'use' && row.paid === 'none');
  return {
    rows: records.length,
    expected,
    paid,
    positiveDue: { rows: positiveDueRows, amount: positiveDue },
    credit: { rows: creditRows, amount: credit },
    negativeExpected,
    zeroExpected,
    buckets,
    legacyUnpaidUse: {
      count: unpaidUse.length,
      expected: unpaidUse.reduce((sum, row) => sum + signedTargetAmount(row, 'expectedDepositAmount'), 0),
      paid: unpaidUse.reduce((sum, row) => sum + signedTargetAmount(row, 'paidAmount'), 0),
      emptyRef: unpaidUse.filter(row => !row.refOf).length,
    },
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function planSha256({ intakeRecords, monthlyRecords, quarantine }) {
  const payload = {
    intake: intakeRecords,
    monthly: monthlyRecords,
    quarantine: quarantine.map(item => ({
      sourceDocumentId: item.sourceDocumentId,
      sheetName: item.sheetName,
      rowNumber: item.rowNumber,
      reasonCodes: [...item.reasonCodes].sort(),
    })),
  };
  return crypto.createHash('sha256').update(stableJson(payload)).digest('hex');
}

function uiInvariantFailures(records) {
  return records.reduce((failures, row) => {
    const sign = row.kind === 'refund' ? -1 : 1;
    const targetK = (Number(row.sell) || 0) * (Number(row.qty) || 0) * sign;
    const targetL = targetK - ((Number(row.unit) || 0) * (Number(row.qty) || 0) * sign);
    const targetN = (Number(row.expectedDepositAmount) || 0) * sign;
    const mismatch = Math.abs(targetK - (Number(row.source.salesAmount) || 0)) >= 0.000001
      || Math.abs(targetL - (Number(row.source.profitAmount) || 0)) >= 0.000001
      || Math.abs(targetN - (Number(row.source.grossAmount) || 0)) >= 0.000001;
    return failures + (mismatch ? 1 : 0);
  }, 0);
}

function sanitizedQuarantine(items) {
  return items.map(item => ({
    sourceDocumentKey: item.sourceDocumentKey,
    ownerName: item.ownerName,
    sheetName: item.sheetName,
    rowNumber: item.rowNumber,
    reasonCodes: item.reasonCodes,
  }));
}

function assertNoDuplicateSources(records) {
  const ids = new Set();
  const lineage = new Set();
  for (const row of records) {
    if (ids.has(row.id)) throw new Error('결정적 이관 ID가 중복됩니다.');
    ids.add(row.id);
    const sourceKey = [
      row.source.documentId,
      row.source.sheetName,
      row.source.rowNumber,
      row.source.recordType,
    ].join('\u0000');
    if (lineage.has(sourceKey)) throw new Error('원본 lineage가 중복됩니다.');
    lineage.add(sourceKey);
  }
}

async function buildSettlementPlan({
  documents,
  uidMap,
  sourceDir,
  fetchImpl,
  timeoutMs,
  workbookLoader = loadSourceWorkbook,
  allowMissingSheets = false,
} = {}) {
  if (!Array.isArray(documents) || documents.length !== 7) throw new Error('확정된 7개 원본 문서가 필요합니다.');
  if (!(uidMap instanceof Map) || uidMap.size !== 7) throw new Error('확정된 7명 UID 매핑이 필요합니다.');

  const intakeRecords = [];
  const monthlyRecords = [];
  const quarantine = [];
  const sourceFiles = [];
  const documentSummaries = [];
  let individualCandidateRows = 0;

  // Sequential loading bounds memory: each multi-megabyte workbook can be
  // garbage-collected before the next one is opened.
  for (const document of documents) {
    const wantedSheets = [
      ...REQUESTED_MONTHS.map(month => `${month} 정산`),
      ...(document.special ? [document.special.sheetName] : []),
      ...(document.excludedSheets || []),
    ];
    const workbook = await workbookLoader(document, {
      sourceDir, fetchImpl, timeoutMs, sheetNames: wantedSheets,
    });
    sourceFiles.push({
      key: document.key,
      ownerName: document.ownerName,
      sha256: workbook.bufferSha256,
      byteLength: workbook.byteLength,
    });
    const ownerUid = uidMap.get(document.ownerName)?.uid;
    const monthlySummary = {};
    for (const month of REQUESTED_MONTHS) {
      const sheetName = `${month} 정산`;
      const matrix = workbook.sheets.get(sheetName);
      if (!matrix) {
        monthlySummary[month] = { missing: true, candidateRows: 0, acceptedRows: 0, quarantinedRows: 0 };
        if (!allowMissingSheets) throw new Error(`${document.ownerName} ${sheetName} 시트가 없습니다.`);
        continue;
      }
      const normalized = normalizeIndividualSheet({ document, sheetName, matrix, ownerUid });
      individualCandidateRows += normalized.candidateRows;
      intakeRecords.push(...normalized.records);
      quarantine.push(...normalized.quarantine);
      monthlySummary[month] = {
        missing: false,
        headerRowNumber: normalized.headerRowNumber,
        candidateRows: normalized.candidateRows,
        acceptedRows: normalized.records.length,
        quarantinedRows: normalized.quarantine.length,
        money: individualMoneyStats(normalized.records),
        approvedDateCorrectionRows: normalized.records
          .filter(row => row.source.metadata.approvedDateCorrection)
          .map(row => row.source.rowNumber),
      };
    }

    let specialSummary = null;
    if (document.special) {
      const matrix = workbook.sheets.get(document.special.sheetName);
      if (!matrix) {
        if (!allowMissingSheets) throw new Error(`${document.ownerName} ${document.special.sheetName} 시트가 없습니다.`);
        specialSummary = { missing: true };
      } else {
        const normalized = normalizeSpecialSheet({
          document,
          sheetName: document.special.sheetName,
          matrix,
          ownerUid,
          requestedMonths: REQUESTED_MONTHS,
        });
        monthlyRecords.push(...normalized.records);
        quarantine.push(...normalized.quarantine);
        specialSummary = {
          missing: false,
          headerRowNumber: normalized.headerRowNumber,
          ...specialStats(normalized.records, normalized.quarantine),
        };
      }
    }
    documentSummaries.push({
      key: document.key,
      ownerName: document.ownerName,
      monthly: monthlySummary,
      special: specialSummary,
      excludedSheetsObserved: (document.excludedSheets || []).filter(name => workbook.sheets.has(name)),
    });
  }

  assertNoDuplicateSources([...intakeRecords, ...monthlyRecords]);
  const reasonCounts = countReasons(quarantine);
  const special = Object.fromEntries(documentSummaries
    .filter(summary => summary.special && !summary.special.missing)
    .map(summary => [documents.find(document => document.key === summary.key).special.view, summary.special]));
  const individual = {
    candidateRows: individualCandidateRows,
    acceptedRows: intakeRecords.length,
    quarantinedRows: quarantine.filter(item => item.sourceDocumentId
      && /^2026-(06|07|08) 정산$/.test(item.sheetName)).length,
  };
  const individualMoney = Object.fromEntries(documentSummaries.map(summary => [
    summary.ownerName,
    Object.fromEntries(REQUESTED_MONTHS.map(month => [month, summary.monthly[month]?.money
      || { count: 0, k: 0, l: 0, n: 0 }])),
  ]));
  const monthlyMoney = Object.fromEntries(REQUESTED_MONTHS.map(month => {
    const rows = intakeRecords.filter(row => row.date.startsWith(`${month}-`));
    return [month, individualMoneyStats(rows)];
  }));
  monthlyMoney.total = individualMoneyStats(intakeRecords);
  const specialMoney = Object.fromEntries(Object.entries(special).map(([view, stats]) => [view, stats.money]));
  const approvedDateCorrections = Object.fromEntries(documents.map(document => {
    const summary = documentSummaries.find(item => item.key === document.key);
    const count = REQUESTED_MONTHS.reduce(
      (sum, month) => sum + (summary.monthly[month]?.approvedDateCorrectionRows?.length || 0), 0,
    );
    return [document.key, count];
  }).filter(([, count]) => count > 0));
  const juhyeon = documentSummaries.find(summary => summary.key === 'kim-juhyeon');
  const excludedChecks = {
    kimJuhyeonCheckOnlyObserved: juhyeon?.excludedSheetsObserved?.includes('2026-08 (체크용)') === true,
    kimJuhyeonAugustMainIsZero: juhyeon?.monthly?.['2026-08']?.missing === false
      && juhyeon.monthly['2026-08'].candidateRows === 0,
  };
  const paymentState = paymentStateStats(intakeRecords);
  const invariantFailureCount = uiInvariantFailures(intakeRecords);
  const baseline = baselineCheck({
    individual,
    special,
    reasonCounts,
    individualMoney,
    monthlyMoney,
    specialMoney,
    approvedDateCorrections,
    excludedChecks,
    uiInvariantFailures: invariantFailureCount,
    sourceFiles,
    paymentState,
  });
  const totals = {
    intake: {
      rows: intakeRecords.length,
      salesAmount: intakeRecords.reduce((sum, row) => sum + (Number(row.source.salesAmount) || 0), 0),
      profitAmount: intakeRecords.reduce((sum, row) => sum + (Number(row.source.profitAmount) || 0), 0),
      expectedDepositAmount: intakeRecords.reduce(
        (sum, row) => sum + (Number(row.source.grossAmount) || 0), 0,
      ),
      paidAmount: paymentState.paid,
    },
    monthly: {
      rows: monthlyRecords.length,
      sale: monthlyRecords.filter(row => row.kind === 'sale').length,
      run: monthlyRecords.filter(row => row.kind === 'run').length,
      parentResolved: monthlyRecords.filter(row => row.kind === 'run' && row.parentResolvedInImport).length,
      parentOrphan: monthlyRecords.filter(row => row.kind === 'run' && !row.parentResolvedInImport).length,
    },
    quarantine: quarantine.length,
  };

  const sourceSnapshot = sourceManifestSnapshot(documents, sourceFiles);
  const normalizedPlanSha256 = planSha256({ intakeRecords, monthlyRecords, quarantine });
  return {
    manifestSha256: sourceManifestSha256(documents, sourceFiles),
    planSha256: normalizedPlanSha256,
    sourceSnapshot,
    sourceFiles,
    records: { intake: intakeRecords, monthly: monthlyRecords },
    quarantine,
    report: {
      version: 1,
      requestedMonths: [...REQUESTED_MONTHS],
      documents: documentSummaries,
      totals,
      reasonCounts,
      individualMoney,
      monthlyMoney,
      specialMoney,
      approvedDateCorrections,
      approvedDateCorrectionRows: Object.fromEntries(documentSummaries
        .map(summary => [summary.key, REQUESTED_MONTHS.flatMap(
          month => summary.monthly[month]?.approvedDateCorrectionRows || [],
        )])
        .filter(([, rows]) => rows.length > 0)),
      excludedChecks,
      paymentState,
      uiInvariantFailures: invariantFailureCount,
      quarantine: sanitizedQuarantine(quarantine),
      baseline,
    },
  };
}

module.exports = {
  baselineCheck,
  buildSettlementPlan,
  countReasons,
  sanitizedQuarantine,
  specialStats,
  paymentStateStats,
  planSha256,
  stableJson,
};
