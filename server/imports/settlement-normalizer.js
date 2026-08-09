'use strict';

const crypto = require('node:crypto');

const HEADER_ALIASES = Object.freeze({
  date: ['일자', '날짜'],
  owner: ['담당자', '영업자'],
  client: ['업체명', '상호명', '거래처명'],
  a: ['대분류', '상품카테고리'],
  b: ['중분류', '상품명'],
  c: ['소분류', '상품분류'],
  unit: ['영업자단가'],
  qty: ['총수량', '수량'],
  salespersonSupply: ['영업자공급가액'],
  sellUnit: ['판매단가', '판매가액'],
  salesAmount: ['판매액'],
  profit: ['영업이익'],
  memo: ['접수특이사항', '특이사항'],
  gross: ['총부포금액', '총부가세포함금액', '총부가포함금액'],
  reserveDate: ['예약최초건날짜'],
  intakeType: ['r열', '당일접수건예약건'],
  invoiceStatus: ['발행유무'],
  paymentStatus: ['입금현황', '입금'],
  payer: ['실제입금자명'],
  paymentLog: ['입금체킹로그값'],
  paymentMemo: ['입금특이사항'],
  runUnit: ['실행가'],
  runSupply: ['실행공급가액'],
  period: ['구동기간'],
  specialGross: ['판매금액'],
});

const HEADER_FIELDS = Object.freeze(Object.keys(HEADER_ALIASES));
const MAX_TEXT = Object.freeze({ client: 200, a: 80, b: 80, c: 120, memo: 500 });

function normalizeHeader(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ko-KR')
    .replace(/[\s_\-/:()[\]{}]+/gu, '')
    .replace(/[^0-9a-zㄱ-ㆎ가-힣]/giu, '');
}

const NORMALIZED_ALIASES = Object.freeze(Object.fromEntries(
  Object.entries(HEADER_ALIASES).map(([field, aliases]) => [
    field,
    new Set(aliases.map(normalizeHeader)),
  ]),
));

function cleanText(value, maxLength = 500) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value).normalize('NFKC').trim();
  if (!text || /^[-—–]$/.test(text)) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(text)) {
    sign = -1;
    text = text.slice(1, -1);
  }
  text = text.replace(/[,₩원\s]/gu, '').replace(/%$/, '');
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const number = Number(text) * sign;
  return Number.isFinite(number) ? number : null;
}

function roundWon(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Math.round(Number(value));
}

function datePartsToKey(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return '';
  const date = new Date(Date.UTC(y, m - 1, d));
  const key = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === key ? key : '';
}

function parseDateCell(value, { sheetMonth = '', approvedCorrections = {} } = {}) {
  let key = '';
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    key = datePartsToKey(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  } else if (typeof value === 'number' && Number.isFinite(value) && value >= 1 && value < 100000) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    epoch.setUTCDate(epoch.getUTCDate() + Math.trunc(value));
    key = datePartsToKey(epoch.getUTCFullYear(), epoch.getUTCMonth() + 1, epoch.getUTCDate());
  } else {
    const text = cleanText(value, 80)
      .replace(/[.년월]/gu, '-')
      .replace(/[일]/gu, '')
      .replace(/\//g, '-');
    let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) key = datePartsToKey(match[1], match[2], match[3]);
    if (!key) {
      match = text.match(/^(\d{2})-(\d{1,2})-(\d{1,2})$/);
      if (match) key = datePartsToKey(2000 + Number(match[1]), match[2], match[3]);
    }
    if (!key && /^\d{1,2}-\d{1,2}$/.test(text) && /^\d{4}-\d{2}$/.test(sheetMonth)) {
      const [month, day] = text.split('-');
      key = datePartsToKey(sheetMonth.slice(0, 4), month, day);
    }
  }
  return approvedCorrections[key] || key;
}

function discoverHeader(matrix, { special = false, maxRows = 500 } = {}) {
  let best = null;
  const scanLimit = Math.min(Array.isArray(matrix) ? matrix.length : 0, maxRows);
  for (let rowIndex = 0; rowIndex < scanLimit; rowIndex += 1) {
    const row = Array.isArray(matrix[rowIndex]) ? matrix[rowIndex] : [];
    const columns = {};
    row.forEach((value, columnIndex) => {
      const normalized = normalizeHeader(value);
      if (!normalized) return;
      for (const field of HEADER_FIELDS) {
        if (columns[field] === undefined && NORMALIZED_ALIASES[field].has(normalized)) {
          columns[field] = columnIndex;
        }
      }
    });

    // Google exports occasionally cache a formula result in a header cell
    // (e.g. "14.0" instead of 업체명, or "363.0" instead of 일자). Infer
    // only when the surrounding canonical columns prove the exact position.
    if (columns.client === undefined
        && columns.owner !== undefined && columns.a === columns.owner + 2) {
      columns.client = columns.owner + 1;
    }
    if (columns.date === undefined && columns.owner !== undefined && columns.owner > 0) {
      columns.date = columns.owner - 1;
    }

    const required = ['date', 'owner', 'client', 'a', 'b', 'c', 'qty'];
    const money = special
      ? ['runUnit', 'runSupply', 'sellUnit', 'salesAmount']
      : ['unit', 'salespersonSupply', 'sellUnit', 'salesAmount', 'gross'];
    const score = required.filter(field => columns[field] !== undefined).length * 3
      + money.filter(field => columns[field] !== undefined).length;
    const hasOrderedCore = columns.date < columns.owner
      && columns.owner < columns.client
      && columns.client < columns.a
      && columns.a < columns.b
      && columns.b < columns.c;
    if (hasOrderedCore && (!best || score > best.score)) best = { rowIndex, columns, score };
  }
  const minimumScore = special ? 23 : 25;
  if (!best || best.score < minimumScore) throw new Error('정산 데이터 헤더를 안전하게 찾지 못했습니다.');
  return best;
}

function rowValue(row, columns, field) {
  const index = columns[field];
  return index === undefined ? null : row[index];
}

function mergedCellValue(matrix, rowIndex, columnIndex) {
  const direct = matrix?.[rowIndex]?.[columnIndex];
  if (direct !== null && direct !== undefined && direct !== '') {
    return { value: direct, method: 'direct' };
  }
  const rowNumber = rowIndex + 1;
  const columnNumber = columnIndex + 1;
  const range = (matrix?.mergeRanges || []).find(item => (
    rowNumber >= item.startRow && rowNumber <= item.endRow
      && columnNumber >= item.startColumn && columnNumber <= item.endColumn
  ));
  if (!range) return { value: direct, method: 'group' };
  const value = matrix?.[range.startRow - 1]?.[range.startColumn - 1];
  return { value, method: 'merge' };
}

function hasRowPayload(row, columns, special) {
  // Template rows often contain dropdown/formula defaults in memo, R and
  // period columns. They are not records until a client/product or non-zero
  // business amount exists.
  const textFields = ['client', 'a', 'b', 'c'];
  if (textFields.some(field => cleanText(rowValue(row, columns, field), 20))) return true;
  const numberFields = special
    ? ['runUnit', 'qty', 'runSupply', 'sellUnit', 'salesAmount', 'specialGross']
    : ['unit', 'qty', 'salespersonSupply', 'sellUnit', 'salesAmount', 'gross'];
  return numberFields.some(field => {
    const number = finiteNumber(rowValue(row, columns, field));
    return number !== null && number !== 0;
  });
}

function deterministicSourceId(prefix, documentId, sheetName, rowNumber, recordType) {
  const hash = crypto.createHash('sha256')
    .update(`${documentId}\u0000${sheetName}\u0000${rowNumber}\u0000${recordType}`)
    .digest('hex');
  return `${prefix}_${hash.slice(0, 40)}`;
}

function canonicalFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function paymentState(rawStatus) {
  const normalized = normalizeHeader(rawStatus);
  if (!normalized || normalized.includes('미입금')) return { paid: 'none', completed: false, partial: false };
  if (normalized.includes('오입금') || normalized.includes('환불')) {
    return { paid: 'wrong', completed: false, partial: false };
  }
  if (normalized.includes('부분')) return { paid: 'partial', completed: false, partial: true };
  if (normalized.includes('선입금') || normalized.includes('입금완료') || normalized === '입금') {
    return { paid: 'paid', completed: true, partial: false };
  }
  return { paid: 'none', completed: false, partial: false };
}

function explicitPaymentAmount(rawLog) {
  const text = String(rawLog ?? '').normalize('NFKC');
  const matches = [...text.matchAll(/(?:^|[^\d])((?:\d{1,3}(?:,\d{3})+)|\d+)\s*원/g)];
  if (!matches.length) return { amount: null, ambiguous: false };
  const amounts = matches.map(match => Number(match[1].replace(/,/g, '')));
  if (amounts.some(amount => !Number.isSafeInteger(amount) || amount < 0)) {
    return { amount: null, ambiguous: true };
  }
  if (amounts.length === 1) return { amount: amounts[0], ambiguous: false };
  const firstIndex = matches[0].index + matches[0][0].length;
  const last = matches[matches.length - 1];
  const sequence = text.slice(firstIndex, last.index);
  const plusCount = (sequence.match(/\+/g) || []).length;
  if (plusCount !== amounts.length - 1 || /[-=–—]/.test(sequence)) {
    return { amount: null, ambiguous: true };
  }
  const sum = amounts.reduce((total, amount) => total + amount, 0);
  return Number.isSafeInteger(sum) ? { amount: sum, ambiguous: false } : { amount: null, ambiguous: true };
}

function intakeKind(rawType) {
  const normalized = normalizeHeader(rawType);
  if (normalized.includes('환불')) return 'refund';
  if (normalized.includes('예약최초') || normalized.includes('선입금')) return 'reserve';
  if (normalized.includes('예약건')) return 'use';
  return 'normal';
}

function quarantineBase(document, sheetName, rowNumber, reasonCodes, privateSourceRow) {
  return {
    sourceDocumentKey: document.key,
    sourceDocumentId: document.documentId,
    ownerName: document.ownerName,
    sheetName,
    rowNumber,
    reasonCodes: [...new Set(reasonCodes)],
    privateSourceRow,
  };
}

function normalizeIndividualSheet({ document, sheetName, matrix, ownerUid }) {
  const sheetMonth = sheetName.slice(0, 7);
  const { rowIndex: headerRowIndex, columns } = discoverHeader(matrix);
  const records = [];
  const quarantine = [];
  let candidateRows = 0;
  let lastDate = '';
  let lastClient = '';
  let lastDateWasApprovedCorrection = false;

  for (let rowIndex = headerRowIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
    const row = Array.isArray(matrix[rowIndex]) ? matrix[rowIndex] : [];
    if (!hasRowPayload(row, columns, false)) {
      lastDate = '';
      lastClient = '';
      lastDateWasApprovedCorrection = false;
      continue;
    }
    candidateRows += 1;
    const dateCell = mergedCellValue(matrix, rowIndex, columns.date);
    const rawDate = dateCell.value;
    const uncorrectedDate = parseDateCell(rawDate, { sheetMonth });
    const parsedDate = parseDateCell(rawDate, {
      sheetMonth,
      approvedCorrections: document.approvedDateCorrections || {},
    });
    const dateWasApprovedCorrection = Boolean(
      uncorrectedDate && parsedDate && uncorrectedDate !== parsedDate,
    );
    if (parsedDate) {
      lastDate = parsedDate;
      lastDateWasApprovedCorrection = dateWasApprovedCorrection;
    }
    const clientCell = mergedCellValue(matrix, rowIndex, columns.client);
    const rawClient = cleanText(clientCell.value, MAX_TEXT.client);
    if (rawClient) lastClient = rawClient;
    const date = parsedDate || lastDate;
    const client = rawClient || lastClient;
    const a = cleanText(rowValue(row, columns, 'a'), MAX_TEXT.a);
    const b = cleanText(rowValue(row, columns, 'b'), MAX_TEXT.b);
    const c = cleanText(rowValue(row, columns, 'c'), MAX_TEXT.c);
    const rawUnit = finiteNumber(rowValue(row, columns, 'unit'));
    const rawQty = finiteNumber(rowValue(row, columns, 'qty'));
    const salespersonSupply = finiteNumber(rowValue(row, columns, 'salespersonSupply'));
    const rawSell = finiteNumber(rowValue(row, columns, 'sellUnit'));
    const rawSalesAmount = finiteNumber(rowValue(row, columns, 'salesAmount'));
    const rawProfitAmount = finiteNumber(rowValue(row, columns, 'profit'));
    const rawGrossAmount = finiteNumber(rowValue(row, columns, 'gross'));
    // K/N formula cells are occasionally blank when J is explicitly zero.
    // J×H and zero VAT are exact arithmetic, not an inferred business value.
    const unroundedSalesAmount = rawSalesAmount ?? (
      rawSell !== null && rawQty !== null ? rawSell * rawQty : null
    );
    const unroundedGrossAmount = rawGrossAmount ?? (unroundedSalesAmount === 0 ? 0 : null);
    const unroundedProfitAmount = rawProfitAmount ?? (
      unroundedSalesAmount !== null && salespersonSupply !== null
        ? unroundedSalesAmount - salespersonSupply : null
    );
    // The source sheets display KRW with no decimal places. Their verified
    // K/L/N totals are the sum of each displayed row, not the sum of hidden
    // cached formula fractions. Store the row-wise KRW values in PEAK OS and
    // retain every cached decimal below in immutable source metadata.
    const salesAmount = roundWon(unroundedSalesAmount);
    const grossAmount = roundWon(unroundedGrossAmount);
    const profitAmount = roundWon(unroundedProfitAmount);
    const rawPaymentStatus = cleanText(rowValue(row, columns, 'paymentStatus'), 120);
    const rawPaymentLog = cleanText(rowValue(row, columns, 'paymentLog'), 2000);
    const rawPaymentMemo = cleanText(rowValue(row, columns, 'paymentMemo'), 1000);
    const state = paymentState(rawPaymentStatus);
    const explicit = explicitPaymentAmount(`${rawPaymentLog}\n${rawPaymentMemo}`);
    const rawIntakeType = cleanText(rowValue(row, columns, 'intakeType'), 120);
    const kind = intakeKind(rawIntakeType);
    const semanticSign = kind === 'refund' ? -1 : 1;
    const qty = kind === 'refund' && rawQty !== null ? Math.abs(rawQty) : rawQty;
    const denominator = qty === null ? null : qty * semanticSign;
    const sell = denominator
      ? salesAmount / denominator
      : rawSell;
    // UI profit is K - supply. Derive the editable unit from signed K/L while
    // preserving the original G/I values in immutable source metadata.
    const uiSupplyAmount = salesAmount !== null && profitAmount !== null
      ? salesAmount - profitAmount
      : salespersonSupply;
    const unit = denominator
      ? uiSupplyAmount / denominator
      : rawUnit;
    const expectedDepositAmount = kind === 'refund' ? Math.abs(grossAmount) : grossAmount;
    const uiSalesAmount = (sell ?? 0) * (qty ?? 0) * semanticSign;
    const uiExpectedAmount = (expectedDepositAmount ?? 0) * semanticSign;
    const uiProfitAmount = uiSalesAmount - ((unit ?? 0) * (qty ?? 0) * semanticSign);
    const reasonCodes = [];
    if (!date || !date.startsWith(`${sheetMonth}-`)) reasonCodes.push('DATE_MISSING_OR_OUTSIDE_SHEET_MONTH');
    if (!client) reasonCodes.push('CLIENT_MISSING_AFTER_GROUP_FILL');
    // Historical rows may intentionally use an empty category or zero/negative
    // quantity for adjustments. Preserve K/L/N instead of dropping the row.
    if (qty === null) reasonCodes.push('QUANTITY_MISSING');
    if (rawUnit === null || rawSell === null || profitAmount === null
        || unit === null || sell === null || salesAmount === null || grossAmount === null) {
      reasonCodes.push('AMOUNT_MISSING_OR_INVALID');
    }
    if (Math.abs(uiSalesAmount - (salesAmount ?? 0)) > 0.000001
        || Math.abs(uiExpectedAmount - (grossAmount ?? 0)) > 0.000001
        || Math.abs(uiProfitAmount - (profitAmount ?? 0)) > 0.000001) {
      reasonCodes.push('TARGET_SIGN_INVARIANT_FAILED');
    }
    if (state.partial && explicit.amount === null) reasonCodes.push('PARTIAL_PAYMENT_AMOUNT_MISSING');

    const privateSourceRow = {
      rawValues: row,
      rawPaymentStatus,
      rawPaymentLog,
      rawPaymentMemo,
    };
    if (reasonCodes.length) {
      quarantine.push(quarantineBase(document, sheetName, rowIndex + 1, reasonCodes, privateSourceRow));
      continue;
    }

    const expectedMagnitude = Math.abs(expectedDepositAmount);
    const explicitAmountUsable = explicit.amount !== null
      && (state.partial
        ? explicit.amount <= expectedMagnitude
        : explicit.amount === expectedMagnitude);
    const targetPaymentSign = expectedDepositAmount < 0 ? -1 : 1;
    const explicitTargetAmount = explicit.amount === null ? null : explicit.amount * targetPaymentSign;
    const paymentWarnings = [
      ...(explicit.ambiguous ? ['AMBIGUOUS_PAYMENT_LOG_AMOUNTS'] : []),
      ...(explicit.amount !== null && !explicitAmountUsable ? ['PAYMENT_LOG_AMOUNT_NOT_ROW_EXACT'] : []),
    ];
    const paidAmount = state.completed
      ? (explicitAmountUsable ? explicitTargetAmount : expectedDepositAmount)
      : (state.partial || state.paid === 'wrong' ? (explicitAmountUsable ? explicitTargetAmount : 0) : 0);
    const rawInvoiceStatus = cleanText(rowValue(row, columns, 'invoiceStatus'), 120);
    const memoParts = [
      cleanText(rowValue(row, columns, 'memo'), 500),
      rawInvoiceStatus ? `계산서: ${rawInvoiceStatus}` : '',
    ].filter(Boolean);
    const source = {
      documentId: document.documentId,
      documentKey: document.key,
      sheetName,
      rowNumber: rowIndex + 1,
      recordType: 'individual',
      grossAmount,
      expectedDepositAmount: grossAmount,
      salesAmount,
      salespersonSupplyAmount: salespersonSupply,
      profitAmount,
      paymentStatus: rawPaymentStatus,
      metadata: {
        rawIntakeType,
        rawInvoiceStatus,
        rawPaymentStatus,
        rawPaymentLog,
        rawPaymentMemo,
        rawSalesAmount,
        rawGrossAmount,
        rawProfitAmount,
        unroundedSalesAmount,
        unroundedGrossAmount,
        unroundedProfitAmount,
        rawSalespersonSupplyAmount: salespersonSupply,
        rawUnit,
        rawQuantity: rawQty,
        rawSellUnit: rawSell,
        targetExpectedDepositAmount: expectedDepositAmount,
        approvedDateCorrection: parsedDate
          ? dateWasApprovedCorrection : lastDateWasApprovedCorrection,
        paymentWarnings,
        reserveDate: cleanText(rowValue(row, columns, 'reserveDate'), 120),
        dateFillMethod: dateCell.method,
        clientFillMethod: clientCell.method,
      },
    };
    const rowRecord = {
      id: deterministicSourceId('gsi', document.documentId, sheetName, rowIndex + 1, 'individual'),
      ownerUid,
      ownerName: document.ownerName,
      date,
      client,
      expectedPayer: cleanText(rowValue(row, columns, 'payer'), 120) || client,
      expectedDepositAmount,
      a,
      b,
      c,
      unit,
      qty,
      sell,
      cost: null,
      memo: memoParts.join(' / ').slice(0, 500),
      kind,
      refOf: '',
      supplier: '',
      manager: document.ownerName,
      finalOnly: false,
      paid: state.paid,
      paidAmount,
      payer: cleanText(rowValue(row, columns, 'payer'), 120),
      paidDate: '',
      paidMemo: [rawPaymentLog, rawPaymentMemo].filter(Boolean).join(' / ').slice(0, 500),
      paidAuto: false,
      bankMatchEligible: false,
      vendorPaid: false,
      vendorPaidDate: '',
      vendorBank: '',
      vendorBy: '',
      vendorMemo: '',
      source,
    };
    rowRecord.source.fingerprint = canonicalFingerprint({ ...rowRecord, source: { ...source, fingerprint: undefined } });
    records.push(rowRecord);
  }
  return { candidateRows, records, quarantine, headerRowNumber: headerRowIndex + 1 };
}

function specialClientKey(value) {
  return cleanText(value, 200)
    .replace(/\(\s*\d+\s*회차\s*\)$/u, '')
    .replace(/\s+/gu, '')
    .toLocaleLowerCase('ko-KR');
}

function normalizeSpecialSheet({ document, sheetName, matrix, ownerUid, requestedMonths }) {
  const { rowIndex: headerRowIndex, columns } = discoverHeader(matrix, { special: true });
  const staged = [];
  const quarantine = [];
  let lastDate = '';
  let lastClient = '';

  for (let rowIndex = headerRowIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
    const row = Array.isArray(matrix[rowIndex]) ? matrix[rowIndex] : [];
    if (!hasRowPayload(row, columns, true)) {
      lastDate = '';
      lastClient = '';
      continue;
    }
    const dateCell = mergedCellValue(matrix, rowIndex, columns.date);
    const parsedDate = parseDateCell(dateCell.value, {
      approvedCorrections: document.approvedDateCorrections || {},
    });
    if (parsedDate) lastDate = parsedDate;
    const clientCell = mergedCellValue(matrix, rowIndex, columns.client);
    const rawClient = cleanText(clientCell.value, MAX_TEXT.client);
    if (rawClient) lastClient = rawClient;
    const date = parsedDate || lastDate;
    const client = rawClient || lastClient;
    const runUnit = finiteNumber(rowValue(row, columns, 'runUnit'));
    const qty = finiteNumber(rowValue(row, columns, 'qty'));
    const runSupply = finiteNumber(rowValue(row, columns, 'runSupply'));
    const sellUnit = finiteNumber(rowValue(row, columns, 'sellUnit'));
    const rawSalesAmount = finiteNumber(rowValue(row, columns, 'salesAmount'));
    const unroundedSalesAmount = rawSalesAmount ?? (
      sellUnit !== null && qty !== null ? sellUnit * qty : null
    );
    const rawGrossAmount = finiteNumber(rowValue(row, columns, 'specialGross'));
    const salesAmount = roundWon(unroundedSalesAmount);
    const grossAmount = roundWon(rawGrossAmount);
    const marker = cleanText(rowValue(row, columns, 'intakeType'), 120);
    const isSale = (salesAmount ?? 0) > 0 || (sellUnit ?? 0) > 0;
    const isRun = !isSale && ((runSupply ?? 0) !== 0 || (runUnit ?? 0) !== 0
      || /(실행건|실행재료)/u.test(marker));
    if (!isSale && !isRun) continue;
    const kind = isSale ? 'sale' : 'run';
    staged.push({
      row,
      rowNumber: rowIndex + 1,
      date,
      client,
      kind,
      a: cleanText(rowValue(row, columns, 'a'), MAX_TEXT.a),
      b: cleanText(rowValue(row, columns, 'b'), MAX_TEXT.b),
      c: cleanText(rowValue(row, columns, 'c'), MAX_TEXT.c),
      runUnit,
      qty,
      runSupply: roundWon(runSupply),
      rawRunSupply: runSupply,
      sellUnit,
      salesAmount,
      rawSalesAmount,
      unroundedSalesAmount,
      grossAmount,
      rawGrossAmount,
      period: cleanText(rowValue(row, columns, 'period'), 120),
      memo: cleanText(rowValue(row, columns, 'memo'), 500),
      marker,
      dateFillMethod: dateCell.method,
      clientFillMethod: clientCell.method,
    });
  }

  const latestSaleByClient = new Map();
  const saleByRow = new Map();
  for (const row of staged) {
    if (row.kind !== 'sale') continue;
    const id = deterministicSourceId('gsm', document.documentId, sheetName, row.rowNumber, 'sale');
    saleByRow.set(row.rowNumber, id);
    latestSaleByClient.set(specialClientKey(row.client), { id, date: row.date, rowNumber: row.rowNumber });
    row.parentId = '';
  }
  // Walk again in source order so each run binds to the latest *preceding*
  // sale for that client, never a future row.
  latestSaleByClient.clear();
  for (const row of staged) {
    if (row.kind === 'sale') {
      latestSaleByClient.set(specialClientKey(row.client), {
        id: saleByRow.get(row.rowNumber), date: row.date, rowNumber: row.rowNumber,
      });
    } else {
      row.parent = latestSaleByClient.get(specialClientKey(row.client)) || null;
      row.parentId = row.parent?.id || '';
    }
  }

  const requested = new Set(requestedMonths || []);
  const importedSaleIds = new Set(staged
    .filter(row => row.kind === 'sale' && requested.has(String(row.date).slice(0, 7)))
    .map(row => saleByRow.get(row.rowNumber)));
  const records = [];
  let candidateRows = 0;
  for (const stagedRow of staged) {
    if (!requested.has(String(stagedRow.date).slice(0, 7))) continue;
    candidateRows += 1;
    const reasonCodes = [];
    if (!stagedRow.date) reasonCodes.push('DATE_MISSING_OR_OUTSIDE_REQUESTED_MONTHS');
    if (!stagedRow.client) reasonCodes.push('CLIENT_MISSING_AFTER_GROUP_FILL');
    if (!stagedRow.a || !stagedRow.b || !stagedRow.c) reasonCodes.push('PRODUCT_CLASSIFICATION_MISSING');
    if (stagedRow.qty === null || stagedRow.qty === 0) reasonCodes.push('NON_POSITIVE_QUANTITY');
    if (stagedRow.kind === 'sale' && stagedRow.salesAmount === null) {
      reasonCodes.push('SALE_AMOUNT_MISSING_OR_INVALID');
    }
    if (stagedRow.kind === 'run' && stagedRow.runUnit === null) {
      reasonCodes.push('RUN_AMOUNT_MISSING_OR_INVALID');
    }
    if (stagedRow.kind === 'run' && !stagedRow.parentId) {
      reasonCodes.push('SPECIAL_PARENT_NOT_FOUND_IN_SOURCE');
    }
    const privateSourceRow = { rawValues: stagedRow.row, marker: stagedRow.marker };
    if (reasonCodes.length) {
      quarantine.push(quarantineBase(document, sheetName, stagedRow.rowNumber, reasonCodes, privateSourceRow));
      continue;
    }

    const amount = stagedRow.kind === 'sale' ? stagedRow.salesAmount : stagedRow.runUnit;
    const source = {
      documentId: document.documentId,
      documentKey: document.key,
      sheetName,
      rowNumber: stagedRow.rowNumber,
      recordType: stagedRow.kind,
      grossAmount: stagedRow.grossAmount,
      expectedDepositAmount: stagedRow.kind === 'sale' ? stagedRow.grossAmount : null,
      salesAmount: stagedRow.salesAmount,
      salespersonSupplyAmount: stagedRow.runSupply,
      profitAmount: finiteNumber(rowValue(stagedRow.row, columns, 'profit')),
      paymentStatus: '',
      metadata: {
        marker: stagedRow.marker,
        sellUnit: stagedRow.sellUnit,
        rawSalesAmount: stagedRow.rawSalesAmount,
        unroundedSalesAmount: stagedRow.unroundedSalesAmount,
        rawGrossAmount: stagedRow.rawGrossAmount,
        rawRunSupply: stagedRow.rawRunSupply,
        rawQuantity: stagedRow.qty,
        dateFillMethod: stagedRow.dateFillMethod,
        clientFillMethod: stagedRow.clientFillMethod,
      },
    };
    const rowRecord = {
      id: deterministicSourceId('gsm', document.documentId, sheetName, stagedRow.rowNumber, stagedRow.kind),
      view: document.special.view,
      ownerUid,
      ownerName: document.ownerName,
      kind: stagedRow.kind,
      parentId: stagedRow.parentId,
      parentResolvedInImport: stagedRow.kind === 'sale' || importedSaleIds.has(stagedRow.parentId),
      date: stagedRow.date,
      client: stagedRow.client,
      a: stagedRow.a,
      b: stagedRow.b,
      c: stagedRow.c,
      amount,
      qty: stagedRow.kind === 'sale' ? 1 : stagedRow.qty,
      period: stagedRow.period,
      memo: stagedRow.memo,
      source,
    };
    rowRecord.source.fingerprint = canonicalFingerprint({ ...rowRecord, source: { ...source, fingerprint: undefined } });
    records.push(rowRecord);
  }
  return { candidateRows, records, quarantine, headerRowNumber: headerRowIndex + 1 };
}

module.exports = {
  canonicalFingerprint,
  cleanText,
  deterministicSourceId,
  discoverHeader,
  explicitPaymentAmount,
  finiteNumber,
  normalizeHeader,
  mergedCellValue,
  normalizeIndividualSheet,
  normalizeSpecialSheet,
  parseDateCell,
  paymentState,
  roundWon,
  specialClientKey,
};
