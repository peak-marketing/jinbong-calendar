'use strict';

const crypto = require('node:crypto');

const PLATFORM_CODES = Object.freeze([
  'rewardspace',
  'reviewspace',
  'keywordmaster',
  'brandautospace',
  'reviewflow',
]);
const PLATFORM_SET = new Set(PLATFORM_CODES);
const CALCULATION_STATUSES = Object.freeze([
  'CALCULATED',
  'UNCONFIGURED',
  'RULE_OVERLAP',
  'SOURCE_INELIGIBLE',
  'SOURCE_INCOMPLETE',
]);

class CommissionPolicyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'CommissionPolicyError';
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new CommissionPolicyError(status, code, message);
}

function cleanText(value, maximum = 500) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function requiredReason(value) {
  const reason = cleanText(value, 500);
  if (reason.length < 8) {
    fail(400, 'COMMISSION_REASON_REQUIRED', '수당 규칙 변경 사유를 8자 이상 입력해 주세요.');
  }
  return reason;
}

function dateKey(value, fieldName) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    fail(400, 'COMMISSION_DATE_INVALID', `${fieldName} 날짜를 확인해 주세요.`);
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    fail(400, 'COMMISSION_DATE_INVALID', `${fieldName} 날짜를 확인해 주세요.`);
  }
  return text;
}

function optionalScopeText(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const text = cleanText(value, 120);
  if (!text) fail(400, 'COMMISSION_SCOPE_INVALID', `${label} 범위를 확인해 주세요.`);
  return text;
}

function optionalOwnerUid(value) {
  if (value === null || value === undefined || value === '') return null;
  const uid = cleanText(value, 256);
  if (!uid) fail(400, 'COMMISSION_SCOPE_INVALID', '영업자 범위를 확인해 주세요.');
  return uid;
}

function normalizeRateBasisPoints(value) {
  const rate = Number(value);
  if (!Number.isSafeInteger(rate) || rate < 0 || rate > 10000) {
    fail(400, 'COMMISSION_RATE_INVALID', '수당률은 0~10,000bp 사이의 정수로 입력해 주세요.');
  }
  return rate;
}

function normalizeRuleDraft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(400, 'COMMISSION_RULE_BODY_INVALID', '수당 규칙 형식을 확인해 주세요.');
  }
  const allowed = new Set([
    'scopeOwnerUid', 'scopePlatform', 'scopeProductA', 'scopeProductB', 'scopeProductC',
    'rateBasisPoints', 'effectiveFrom', 'effectiveTo', 'reason',
  ]);
  if (Object.keys(input).some(key => !allowed.has(key))) {
    fail(400, 'COMMISSION_RULE_FIELDS_NOT_ALLOWED', '허용되지 않은 수당 규칙 값이 있습니다.');
  }
  const scopeOwnerUid = optionalOwnerUid(input.scopeOwnerUid);
  const scopePlatform = optionalScopeText(input.scopePlatform, '플랫폼');
  if (scopePlatform !== null && !PLATFORM_SET.has(scopePlatform)) {
    fail(400, 'COMMISSION_PLATFORM_INVALID', '지원하는 플랫폼 코드를 선택해 주세요.');
  }
  const scopeProductA = optionalScopeText(input.scopeProductA, '대분류');
  const scopeProductB = optionalScopeText(input.scopeProductB, '중분류');
  const scopeProductC = optionalScopeText(input.scopeProductC, '소분류');
  if (scopeProductB !== null && scopeProductA === null) {
    fail(400, 'COMMISSION_SCOPE_HIERARCHY_INVALID', '중분류 범위에는 대분류가 필요합니다.');
  }
  if (scopeProductC !== null && (scopeProductA === null || scopeProductB === null)) {
    fail(400, 'COMMISSION_SCOPE_HIERARCHY_INVALID', '소분류 범위에는 대분류와 중분류가 필요합니다.');
  }
  const effectiveFrom = dateKey(input.effectiveFrom, '적용 시작');
  const effectiveTo = input.effectiveTo === null || input.effectiveTo === undefined || input.effectiveTo === ''
    ? null : dateKey(input.effectiveTo, '적용 종료');
  if (effectiveTo !== null && effectiveTo <= effectiveFrom) {
    fail(400, 'COMMISSION_EFFECTIVE_RANGE_INVALID', '적용 종료일은 시작일보다 뒤여야 합니다.');
  }
  return Object.freeze({
    scopeOwnerUid,
    scopePlatform,
    scopeProductA,
    scopeProductB,
    scopeProductC,
    rateBasisPoints: normalizeRateBasisPoints(input.rateBasisPoints),
    effectiveFrom,
    effectiveTo,
    reason: requiredReason(input.reason),
  });
}

function isOversight(req) {
  return req?.workspace?.headquartersOversight === true
    || String(req?.workspace?.role || '') === 'oversight';
}

function settlementPermission(req) {
  return String(req?.workspace?.permissions?.settlements || 'none');
}

function approvedActive(req) {
  return req?.userDoc?.approved === true && req?.userDoc?.is_active !== false;
}

function canReadRules(req) {
  return approvedActive(req)
    && ['read', 'write'].includes(settlementPermission(req))
    && (isOversight(req) || ['admin', 'manager'].includes(String(req?.workspace?.role || '')));
}

function canManageRules(req) {
  return approvedActive(req)
    && !isOversight(req)
    && settlementPermission(req) === 'write'
    && ['admin', 'manager'].includes(String(req?.workspace?.role || ''));
}

function canReadCalculation(req, ownerUid) {
  if (!approvedActive(req) || !['read', 'write'].includes(settlementPermission(req))) return false;
  if (String(req?.uid || '') === String(ownerUid || '')) return true;
  return isOversight(req) || ['admin', 'manager'].includes(String(req?.workspace?.role || ''));
}

function normalizedPlatform(source) {
  const candidate = cleanText(source?.source_metadata?.provider ?? source?.sourceMetadata?.provider, 80);
  return PLATFORM_SET.has(candidate) ? candidate : null;
}

function normalizedDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function sourceSnapshot(source) {
  const snapshot = {
    id: String(source?.id || ''),
    ownerUid: String(source?.owner_uid ?? source?.ownerUid ?? ''),
    ownerName: String(source?.owner_name ?? source?.ownerName ?? ''),
    businessDate: normalizedDate(source?.date),
    rowVersion: Number(source?.row_version ?? source?.rowVersion),
    kind: String(source?.kind || ''),
    platform: normalizedPlatform(source),
    product: {
      a: String(source?.a || ''),
      b: String(source?.b || ''),
      c: String(source?.c || ''),
    },
    qty: source?.qty === null || source?.qty === undefined ? null : Number(source.qty),
    sellPerUnit: source?.sell === null || source?.sell === undefined ? null : Number(source.sell),
    salespersonUnit: source?.unit === null || source?.unit === undefined ? null : Number(source.unit),
  };
  return Object.freeze({ ...snapshot, product: Object.freeze(snapshot.product) });
}

function currentRuleSnapshot(rule) {
  const snapshot = {
    id: String(rule.id),
    seriesId: String(rule.rule_series_id ?? rule.seriesId),
    version: Number(rule.version),
    status: String(rule.status),
    scope: {
      ownerUid: rule.scope_owner_uid ?? rule.scopeOwnerUid ?? null,
      platform: rule.scope_platform ?? rule.scopePlatform ?? null,
      productA: rule.scope_product_a ?? rule.scopeProductA ?? null,
      productB: rule.scope_product_b ?? rule.scopeProductB ?? null,
      productC: rule.scope_product_c ?? rule.scopeProductC ?? null,
    },
    rateBasisPoints: Number(rule.rate_basis_points ?? rule.rateBasisPoints),
    effectiveFrom: normalizedDate(rule.effective_from ?? rule.effectiveFrom),
    effectiveTo: (rule.effective_to ?? rule.effectiveTo) == null
      ? null : normalizedDate(rule.effective_to ?? rule.effectiveTo),
  };
  return Object.freeze({ ...snapshot, scope: Object.freeze(snapshot.scope) });
}

function ruleMatchesSource(rule, source) {
  const snapshot = currentRuleSnapshot(rule);
  if (!['APPROVED', 'ENDED'].includes(snapshot.status)) return false;
  if (snapshot.effectiveFrom > source.businessDate) return false;
  if (snapshot.effectiveTo !== null && source.businessDate >= snapshot.effectiveTo) return false;
  if (snapshot.scope.ownerUid !== null && snapshot.scope.ownerUid !== source.ownerUid) return false;
  if (snapshot.scope.platform !== null && snapshot.scope.platform !== source.platform) return false;
  if (snapshot.scope.productA !== null && snapshot.scope.productA !== source.product.a) return false;
  if (snapshot.scope.productB !== null && snapshot.scope.productB !== source.product.b) return false;
  if (snapshot.scope.productC !== null && snapshot.scope.productC !== source.product.c) return false;
  return true;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function calculateCommission(sourceRow, ruleRows, vendorEvidence = null) {
  const source = sourceSnapshot(sourceRow);
  const qty = integerOrNull(source.qty);
  const sell = integerOrNull(source.sellPerUnit);
  const unit = integerOrNull(source.salespersonUnit);
  const sourceSha256 = sha256(source);
  const common = { source, sourceSha256, rule: null, status: null, rateBasisPoints: null,
    salesAmount: null, salespersonSupplyAmount: null, commissionBaseAmount: null,
    estimatedCommissionAmount: null, payoutEligible: false, payoutBlockers: [] };

  if (qty === null || sell === null || unit === null) {
    return Object.freeze({ ...common, status: 'SOURCE_INCOMPLETE',
      payoutBlockers: Object.freeze(['SOURCE_AMOUNT_INCOMPLETE']) });
  }
  if (!['normal', 'use'].includes(source.kind) || qty <= 0 || sell < 0 || unit < 0
      || !Number.isSafeInteger(sell * qty) || !Number.isSafeInteger(unit * qty)
      || (sell - unit) * qty <= 0) {
    return Object.freeze({ ...common, status: 'SOURCE_INELIGIBLE',
      payoutBlockers: Object.freeze(['SOURCE_NOT_POSITIVE_PAYABLE_SALE']) });
  }

  const matching = (Array.isArray(ruleRows) ? ruleRows : []).filter(rule => ruleMatchesSource(rule, source));
  if (matching.length === 0) {
    return Object.freeze({ ...common, status: 'UNCONFIGURED',
      payoutBlockers: Object.freeze(['COMMISSION_RULE_UNCONFIGURED']) });
  }
  if (matching.length > 1) {
    return Object.freeze({ ...common, status: 'RULE_OVERLAP',
      payoutBlockers: Object.freeze(['COMMISSION_RULE_OVERLAP']) });
  }

  const rule = currentRuleSnapshot(matching[0]);
  const salesAmount = sell * qty;
  const salespersonSupplyAmount = unit * qty;
  const commissionBaseAmount = salesAmount - salespersonSupplyAmount;
  const rateBasisPoints = normalizeRateBasisPoints(rule.rateBasisPoints);
  const numerator = BigInt(commissionBaseAmount) * BigInt(rateBasisPoints);
  const estimatedCommissionAmount = Number((numerator + 5000n) / 10000n);
  if (!Number.isSafeInteger(estimatedCommissionAmount)) {
    return Object.freeze({ ...common, status: 'SOURCE_INCOMPLETE',
      payoutBlockers: Object.freeze(['COMMISSION_AMOUNT_OUT_OF_RANGE']) });
  }

  const vendorEvidenceComplete = vendorEvidence?.batch_id != null
    && Number.isSafeInteger(Number(vendorEvidence?.source_settled_row_version))
    && Number(vendorEvidence.source_settled_row_version) === source.rowVersion
    && sourceRow?.vendor_paid === true;
  // intake 원본과 peakos_monthly 완료 근거는 서로 다른 원장이다. 이름/날짜로
  // 임의 연결하지 않으며, canonical intake completion FK가 생기기 전까지 이
  // 버전은 예상 수당만 제공하고 지급 확정은 항상 fail-closed 한다.
  const payoutBlockers = ['SETTLEMENT_COMPLETION_UNCONFIRMED'];
  if (!vendorEvidenceComplete) payoutBlockers.push('SUPPLIER_RECONCILIATION_INCOMPLETE');
  return Object.freeze({
    ...common,
    rule,
    status: 'CALCULATED',
    rateBasisPoints,
    salesAmount,
    salespersonSupplyAmount,
    commissionBaseAmount,
    estimatedCommissionAmount,
    payoutEligible: false,
    payoutBlockers: Object.freeze(payoutBlockers),
  });
}

function calculationInputFingerprint(result, vendorEvidence) {
  return sha256({
    schema: 'peakos-commission-calculation-v1',
    sourceSha256: result.sourceSha256,
    status: result.status,
    rule: result.rule,
    vendorBatchId: vendorEvidence?.batch_id == null ? null : String(vendorEvidence.batch_id),
    vendorSourceSettledRowVersion: vendorEvidence?.source_settled_row_version == null
      ? null : Number(vendorEvidence.source_settled_row_version),
    payoutEligible: result.payoutEligible,
    payoutBlockers: result.payoutBlockers,
  });
}

module.exports = {
  CALCULATION_STATUSES,
  CommissionPolicyError,
  PLATFORM_CODES,
  calculateCommission,
  calculationInputFingerprint,
  canManageRules,
  canReadCalculation,
  canReadRules,
  cleanText,
  currentRuleSnapshot,
  dateKey,
  isOversight,
  normalizeRateBasisPoints,
  normalizeRuleDraft,
  requiredReason,
  ruleMatchesSource,
  sha256,
  sourceSnapshot,
  stableStringify,
};
