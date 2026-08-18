'use strict';

// Imported settlement rows predate the explicit `supplier` column. The live
// UI has always resolved those rows from the product pair below. Keep the
// server's copy independent: a browser-supplied supplier is never trusted for
// reconciliation eligibility.
const DEFAULT_SUPPLIER_BY_PRODUCT = Object.freeze({
  'AI 파라곤|일반배포': '피크마케팅',
  'AI 파라곤|프리미엄 이미지 생성': '피크마케팅',
  'Alpha|트래픽': '엠플리파이',
  'Alpha +|BOOSTER': '파파컴퍼니',
  'Alpha +|영업자': '영업자',
  'Alpha +|히든': '파파컴퍼니',
  'BOOSTER|Alpha': '엠플리파이',
  'BOOSTER|히든': '파파컴퍼니',
  'BOOSTER Pro|리워드 파라곤': '에이치에스',
  'BOOSTER Pro|트래픽': '에이치에스',
  'HP|25.0': '하이프웍스',
  'P01|개별세팅옵션': '헬로우드림',
  'P01|사진 1장': '헬로우드림',
  'P01|사진 1장 247': '헬로우드림',
  'P01|사진 3장': '헬로우드림',
  'P01|사진 3장 247': '헬로우드림',
  'P01|유입형 사진 3장 247': '헬로우드림',
  'P02|일반~준최5 이미지 7장 700': '이스트나인',
  'P02|준최2~준최5 이미지 10장 1000': '이스트나인',
  'P02|준최2~준최5 이미지 5장 500': '이스트나인',
  'P02|준최2~준최5 이미지 7장 700': '이스트나인',
  'P0B|프리미엄 배포(원고 및 사진 지정)': '플랜b',
  'SA|페이백': '피크마케팅',
  'T맵|T맵리뷰': '헬로우드림',
  'T맵|개별옵션': '헬로우드림',
  '네이버 가구매|기자단': 'HM이노',
  '네이버 가구매|물품비': 'HM이노',
  '네이버 가구매|택배대행비': 'HM이노',
  '당근|단골맺기': '엠플리파이',
  '당근|단순배포': '엠플리파이',
  '당근|비즈후기': '엠플리파이',
  '당근|찜': '엠플리파이',
  '랭크업|트래픽': '에이치에스',
  '리뷰삭제|빠른삭제': '리브리',
  '리워드 파라곤|트래픽': '에이치에스',
  '맘카페|단순배포': '윙',
  '맘카페|댓글작업': '윙',
  '브랜드블로그|연장 스타터 입문형': '피크마케팅',
  '블로그|블로그': '플랜b',
  '블로그탭|월보장': '마케팅초이 (2)',
  '상세페이지|1000PX': '외주(다빈)',
  '샤오홍슈|스탠다드': '기발한마케팅',
  '샤오홍슈|프리미엄': '기발한마케팅',
  '스페이스|[올인원] 1장 일반': '피크마케팅',
  '스페이스|[올인원] 1장 프리미엄': '피크마케팅',
  '스페이스|[올인원] 3장 일반': '피크마케팅',
  '스페이스|[올인원] 3장 프리미엄': '피크마케팅',
  '스페이스|[올인원] 7장 일반': '피크마케팅',
  '스페이스|[올인원] 7장 프리미엄': '피크마케팅',
  '스페이스|[일반] 1장 일반': '피크마케팅',
  '스페이스|[일반] 3장 일반': '피크마케팅',
  '스페이스|[일반] 3장 프리미엄': '피크마케팅',
  '스페이스|[일반] 7장 일반': '피크마케팅',
  '올데이|리워드 파라곤': '엠플리파이',
  '올데이|트래픽': '엠플리파이',
  '올스비실계정|올스비실계정': '올스비실계정',
  '원고|개인대필': '영업자',
  '원고|대필프로그램': '피크마케팅',
  '원고|블로그대필프로그램': '피크마케팅',
  '원고|프리미엄원고대필': '키지애드 (50)',
  '유튜브상위노출|건바이': '윙',
  '카드결제|수수료 1.15%': '영업자',
  '카카오|카카오맵리뷰': '애드펌프',
  '카페|건바이': '키지애드 (50)',
  '캐치테이블|캐치테이블리뷰': '애드펌프',
  '쿠팡가구매2|기자단2': '바보들이만든회사',
  '쿠팡가구매2|물품비': '바보들이만든회사',
  '쿠팡가구매2|택배대행비2': '바보들이만든회사',
  '클립리뷰|10장 내 슬라이드형': '헬로우드림',
  '클립리뷰|25초내 영상형': '헬로우드림',
  '통합검색|건바이': '키지애드 (50)',
  '통합검색|월보장': '마케팅초이 (2)',
  '파라곤|트래픽': '에이치에스',
  '파라곤 (쇼핑)|트래픽': '인포플래닛',
  '프리저|Alpha': '엠플리파이',
  '프리저|올데이': '엠플리파이',
  '프리저|저장하기': '부스팅샾',
  '프리저|트래픽': '부스팅샾',
  '프리저 (쇼핑)|트래픽': '부스팅샾',
  '플레이스|월보장': '김지홍 ( 1 )',
  '피크마케팅 상품|DB 프로그램': '피크마케팅',
  '히든|트래픽': '파파컴퍼니',
});

class VendorReconciliationPolicyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'VendorReconciliationPolicyError';
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new VendorReconciliationPolicyError(status, code, message);
}

function cleanText(value, maximum) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function supplierForIntake(row) {
  const explicit = cleanText(row?.supplier, 120);
  if (explicit) return explicit;
  return DEFAULT_SUPPLIER_BY_PRODUCT[`${String(row?.b || '')}|${String(row?.c || '')}`] || '';
}

function positiveSafeInteger(value, code, message, maximum = Number.MAX_SAFE_INTEGER) {
  const text = typeof value === 'string' ? value.trim() : value;
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) fail(409, code, message);
  return number;
}

function settlementMath(row) {
  if (!['normal', 'use'].includes(String(row?.kind || ''))) {
    fail(409, 'VENDOR_RECONCILIATION_SOURCE_INELIGIBLE', '당일접수·예약 사용 양수 건만 공급사 대사에 포함할 수 있습니다.');
  }
  const semanticQty = positiveSafeInteger(
    row?.qty,
    'VENDOR_RECONCILIATION_QTY_INVALID',
    '공급사 대사 수량은 1 이상의 정수여야 합니다.',
    1_000_000,
  );
  if (row?.cost === null || row?.cost === undefined || row?.cost === '') {
    fail(409, 'VENDOR_RECONCILIATION_COST_REQUIRED', '확정 원가가 없는 접수가 있어 공급사 대사를 완료할 수 없습니다.');
  }
  const cost = positiveSafeInteger(
    row.cost,
    'VENDOR_RECONCILIATION_COST_INVALID',
    '공급사 원가는 1원 이상의 확정 정수여야 합니다.',
    1_000_000_000_000,
  );
  const due = semanticQty * cost;
  if (!Number.isSafeInteger(due) || due <= 0) {
    fail(409, 'VENDOR_RECONCILIATION_DUE_INVALID', '공급사 정산 금액이 안전한 원 단위 범위를 벗어났습니다.');
  }
  return Object.freeze({ semanticQty, cost, due });
}

function canWriteVendorReconciliation(req, { canReviewFinance = () => false } = {}) {
  return req?.userDoc?.approved === true
    && req?.userDoc?.is_active !== false
    && req?.workspace?.headquartersOversight !== true
    && req?.workspace?.role !== 'oversight'
    && req?.workspace?.permissions?.settlements === 'write'
    && Boolean(canReviewFinance(req));
}

module.exports = {
  DEFAULT_SUPPLIER_BY_PRODUCT,
  VendorReconciliationPolicyError,
  canWriteVendorReconciliation,
  cleanText,
  settlementMath,
  supplierForIntake,
};
