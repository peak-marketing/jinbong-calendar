'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  explicitPaymentAmount,
  normalizeIndividualSheet,
  normalizeSpecialSheet,
} = require('./settlement-normalizer');

const INDIVIDUAL_HEADER = [
  '일자', '담당자', '업체명', '대분류', '중분류', '소분류',
  '영업자단가', '총수량', '영업자공급가액', '판매단가', '판매액',
  '영업이익', '접수특이사항', '총부가세포함금액', '예약최초건날짜',
  'R열', '발행유무', '입금현황', '실제입금자명', '입금체킹로그값', '입금특이사항',
];

function individualRow({
  date = '', client = '', unit = 300, qty = 1, supply = 300, sell = 400,
  sales = 400, profit = 100, gross = 440, type = '', payment = '미입금', log = '',
} = {}) {
  return [
    date, '직원', client, '대', '중', '소', unit, qty, supply, sell, sales,
    profit, '', gross, '', type, '', payment, '', log, '',
  ];
}

function withMerges(matrix, mergeRanges) {
  Object.defineProperty(matrix, 'mergeRanges', { value: Object.freeze(mergeRanges) });
  return matrix;
}

const PARK_DOCUMENT = {
  key: 'park-jongwon',
  ownerName: '박종원',
  documentId: 'externaldocumentidentifierpark001',
  approvedDateCorrections: { '2062-07-13': '2026-07-13' },
};

test('병합 날짜·업체는 master에서 안전하게 채우고 승인 날짜보정을 후속 4행에 기록한다', () => {
  const matrix = withMerges([
    INDIVIDUAL_HEADER,
    individualRow({ date: '2062-07-13', client: '업체', sales: 999.9, profit: 100.5, gross: 1099.89 }),
    individualRow({ sales: 400, profit: 100, gross: 440 }),
    individualRow({ sales: 500, profit: 200, gross: 550 }),
    individualRow({ sales: 600, profit: 300, gross: 660 }),
  ], [
    { startColumn: 1, startRow: 2, endColumn: 1, endRow: 5 },
    { startColumn: 3, startRow: 2, endColumn: 3, endRow: 5 },
  ]);
  const result = normalizeIndividualSheet({
    document: PARK_DOCUMENT,
    sheetName: '2026-07 정산',
    matrix,
    ownerUid: 'firebase-user-1',
  });
  assert.equal(result.quarantine.length, 0);
  assert.equal(result.records.length, 4);
  assert.deepEqual(result.records.map(row => row.date), Array(4).fill('2026-07-13'));
  assert.deepEqual(result.records.map(row => row.client), Array(4).fill('업체'));
  assert.equal(result.records.every(row => row.source.metadata.approvedDateCorrection), true);
  assert.deepEqual(result.records.map(row => row.source.metadata.dateFillMethod), [
    'direct', 'merge', 'merge', 'merge',
  ]);
  assert.equal(result.records[0].source.salesAmount, 1000);
  assert.equal(result.records[0].source.profitAmount, 101);
  assert.equal(result.records[0].source.grossAmount, 1100);
  assert.equal(result.records[0].source.metadata.unroundedGrossAmount, 1099.89);
});

test('refund는 target magnitude로 정규화하고 일반 음수조정은 signed target을 유지한다', () => {
  const matrix = [
    INDIVIDUAL_HEADER,
    individualRow({
      date: '2026-06-01', client: '환불업체', unit: 800, qty: -1, supply: -800,
      sell: 1000, sales: -1000, profit: -200, gross: -1100, type: '환불', payment: '입금완료',
    }),
    individualRow({
      date: '2026-06-02', client: '조정업체', unit: 800, qty: -1, supply: -800,
      sell: 1000, sales: -1000, profit: -200, gross: -1100, type: '', payment: '미입금',
    }),
  ];
  const result = normalizeIndividualSheet({
    document: { ...PARK_DOCUMENT, approvedDateCorrections: {} },
    sheetName: '2026-06 정산',
    matrix,
    ownerUid: 'firebase-user-1',
  });
  assert.equal(result.quarantine.length, 0);
  const [refund, adjustment] = result.records;
  assert.deepEqual({
    kind: refund.kind, qty: refund.qty, sell: refund.sell,
    expected: refund.expectedDepositAmount, paid: refund.paidAmount,
  }, { kind: 'refund', qty: 1, sell: 1000, expected: 1100, paid: 1100 });
  assert.equal(-refund.sell * refund.qty, refund.source.salesAmount);
  assert.equal(-refund.expectedDepositAmount, refund.source.grossAmount);
  assert.equal(refund.source.expectedDepositAmount, -1100);
  assert.deepEqual({
    kind: adjustment.kind, qty: adjustment.qty, sell: adjustment.sell,
    expected: adjustment.expectedDepositAmount,
  }, { kind: 'normal', qty: -1, sell: 1000, expected: -1100 });
});

test('입금 로그는 단일액·명시적 덧셈만 사용하고 모호한 금액을 추측하지 않는다', () => {
  assert.deepEqual(explicitPaymentAmount('100,000원'), { amount: 100000, ambiguous: false });
  assert.deepEqual(explicitPaymentAmount('40,000원 + 60,000원'), { amount: 100000, ambiguous: false });
  assert.deepEqual(explicitPaymentAmount('40,000원 / 60,000원'), { amount: null, ambiguous: true });
});

const SPECIAL_HEADER = [
  '일자', '담당자', '업체명', '대분류', '중분류', '소분류', '실행가',
  '총수량', '실행공급가액', '판매단가', '판매액', '영업이익', '접수특이사항',
  '판매금액', 'R열', '구동기간',
];

function specialRow({ date, client, runUnit = 0, qty = 1, runSupply = 0,
  sellUnit = 0, sales = 0, gross = 0, marker = '' }) {
  return [
    date, '직원', client, '대', '중', '소', runUnit, qty, runSupply,
    sellUnit, sales, sales - runSupply, '', gross, marker, '',
  ];
}

test('특수 실행건은 범위 밖 선행 sale의 결정적 parent를 보존하고 qty0만 격리한다', () => {
  const matrix = [
    SPECIAL_HEADER,
    specialRow({ date: '2026-05-08', client: '업체', sellUnit: 1000, sales: 1000, gross: 1100 }),
    specialRow({ date: '2026-06-01', client: '업체', runUnit: 200, qty: 2, runSupply: 400, marker: '실행건' }),
    specialRow({ date: '2026-06-02', client: '업체', runUnit: 200, qty: 0, runSupply: 0, marker: '실행건' }),
  ];
  const result = normalizeSpecialSheet({
    document: {
      key: 'kim-jihong', ownerName: '김지홍', documentId: 'externaldocumentidentifierkim001',
      special: { sheetName: '월보작업건', view: 'monthly-guarantee' },
    },
    sheetName: '월보작업건', matrix, ownerUid: 'firebase-user-2',
    requestedMonths: ['2026-06', '2026-07', '2026-08'],
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].kind, 'run');
  assert.match(result.records[0].parentId, /^gsm_[0-9a-f]{40}$/);
  assert.equal(result.records[0].parentResolvedInImport, false);
  assert.equal(result.quarantine.length, 1);
  assert.deepEqual(result.quarantine[0].reasonCodes, ['NON_POSITIVE_QUANTITY']);
});
