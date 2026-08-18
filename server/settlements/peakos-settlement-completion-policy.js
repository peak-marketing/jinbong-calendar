'use strict';

const KST_TIME_ZONE = 'Asia/Seoul';
const HOUR_MS = 60 * 60 * 1000;
const RULES = Object.freeze({
  DIRECT_EXECUTION_8TH: Object.freeze({
    code: 'DIRECT_EXECUTION_8TH',
    label: '직접실행 8회차 완료',
    completedIssues: 8,
  }),
  MONTHLY_GUARANTEE_25D: Object.freeze({
    code: 'MONTHLY_GUARANTEE_25D',
    label: '월보장 25일 노출 완료',
    durationHours: 25 * 24,
  }),
  PER_ITEM_24H: Object.freeze({
    code: 'PER_ITEM_24H',
    label: '건바이 24시간 노출 완료',
    durationHours: 24,
  }),
  MONTHLY_MANAGEMENT_30D: Object.freeze({
    code: 'MONTHLY_MANAGEMENT_30D',
    label: '월관리 30일 완료',
    durationHours: 30 * 24,
  }),
});

const RULE_CODES = Object.freeze(Object.keys(RULES));
const EVIDENCE_FIELDS = Object.freeze([
  'exposureStartedAt',
  'exposureCompletedAt',
  'serviceStartedAt',
  'serviceCompletedAt',
  'completedIssueCount',
  'eighthIssueCompletedAt',
]);

class SettlementCompletionPolicyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'SettlementCompletionPolicyError';
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new SettlementCompletionPolicyError(status, code, message);
}

function cleanText(value, maximum = 500) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function normalizeReason(value) {
  const reason = cleanText(value, 500);
  if (reason.length < 8) {
    fail(400, 'SETTLEMENT_COMPLETION_REASON_REQUIRED', '정산 상태 변경 사유를 8자 이상 입력해 주세요.');
  }
  return reason;
}

function parseTimestamp(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  // A timezone-less timestamp changes meaning with the server process timezone.
  // Reject it instead of silently treating it as UTC or KST.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    fail(400, 'SETTLEMENT_EVIDENCE_TIMESTAMP_INVALID', `${fieldName}에는 시간대가 포함된 ISO 시각이 필요합니다.`);
  }
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) {
    fail(400, 'SETTLEMENT_EVIDENCE_TIMESTAMP_INVALID', `${fieldName} 시각을 확인해 주세요.`);
  }
  return date;
}

function normalizeIssueCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) {
    fail(400, 'SETTLEMENT_EVIDENCE_ISSUE_COUNT_INVALID', '완료 회차는 0 이상의 안전한 정수여야 합니다.');
  }
  return count;
}

function normalizeEvidence(input, ruleCode) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(400, 'SETTLEMENT_EVIDENCE_REQUIRED', '정산 완료 근거를 입력해 주세요.');
  }
  const unknown = Object.keys(input).filter(key => !EVIDENCE_FIELDS.includes(key));
  if (unknown.length) {
    fail(400, 'SETTLEMENT_EVIDENCE_FIELD_NOT_ALLOWED', '허용되지 않은 정산 완료 근거 필드가 있습니다.');
  }
  if (!RULES[ruleCode]) fail(422, 'SETTLEMENT_RULE_UNSUPPORTED', '지원하지 않는 정산 완료 규칙입니다.');
  const evidence = {
    exposureStartedAt: parseTimestamp(input.exposureStartedAt, '노출 시작'),
    exposureCompletedAt: parseTimestamp(input.exposureCompletedAt, '노출 완료'),
    serviceStartedAt: parseTimestamp(input.serviceStartedAt, '서비스 시작'),
    serviceCompletedAt: parseTimestamp(input.serviceCompletedAt, '서비스 완료'),
    completedIssueCount: normalizeIssueCount(input.completedIssueCount),
    eighthIssueCompletedAt: parseTimestamp(input.eighthIssueCompletedAt, '8회차 완료'),
  };
  const present = key => evidence[key] !== null;
  const disallowed = ruleCode === 'DIRECT_EXECUTION_8TH'
    ? ['exposureStartedAt', 'exposureCompletedAt', 'serviceStartedAt', 'serviceCompletedAt']
    : ['completedIssueCount', 'eighthIssueCompletedAt'];
  if (disallowed.some(present)) {
    fail(400, 'SETTLEMENT_EVIDENCE_RULE_MISMATCH', '정산 규칙과 맞지 않는 완료 근거가 포함되어 있습니다.');
  }
  if (ruleCode === 'MONTHLY_MANAGEMENT_30D'
      && ['exposureStartedAt', 'exposureCompletedAt'].some(present)) {
    fail(400, 'SETTLEMENT_EVIDENCE_RULE_MISMATCH', '월관리에는 서비스 시작·완료 근거만 입력할 수 있습니다.');
  }
  if (['MONTHLY_GUARANTEE_25D', 'PER_ITEM_24H'].includes(ruleCode)
      && ['serviceStartedAt', 'serviceCompletedAt'].some(present)) {
    fail(400, 'SETTLEMENT_EVIDENCE_RULE_MISMATCH', '월보장·건바이에는 노출 시작·완료 근거만 입력할 수 있습니다.');
  }
  if (evidence.eighthIssueCompletedAt !== null
      && evidence.completedIssueCount !== null
      && evidence.completedIssueCount < RULES.DIRECT_EXECUTION_8TH.completedIssues) {
    fail(400, 'SETTLEMENT_EVIDENCE_DIRECT_INCONSISTENT', '8회차 완료 시각은 완료 회차가 8회 이상일 때만 기록할 수 있습니다.');
  }
  return evidence;
}

function timestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

function kstTimestamp(value) {
  const ms = timestampMs(value);
  if (ms === null) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: KST_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} KST`;
}

function reason(code, message, details = {}) {
  return Object.freeze({ code, message, ...details });
}

function evaluateDurationEvidence({ startedAt, completedAt, asOfMs, durationHours, labels }) {
  const reasons = [];
  const startMs = timestampMs(startedAt);
  const completionMs = timestampMs(completedAt);
  if (startMs === null) reasons.push(reason(labels.missingStart, `${labels.startName} 근거가 없습니다.`));
  if (completionMs === null) reasons.push(reason(labels.missingCompletion, `${labels.completionName} 근거가 없습니다.`));
  if (startMs !== null && startMs > asOfMs) {
    reasons.push(reason(labels.futureStart, `${labels.startName} 시각이 현재보다 미래입니다.`));
  }
  if (completionMs !== null && completionMs > asOfMs) {
    reasons.push(reason(labels.futureCompletion, `${labels.completionName} 시각이 현재보다 미래입니다.`));
  }
  let elapsedHours = null;
  if (startMs !== null && completionMs !== null) {
    elapsedHours = (completionMs - startMs) / HOUR_MS;
    if (completionMs < startMs) {
      reasons.push(reason('COMPLETION_BEFORE_START', `${labels.completionName} 시각이 ${labels.startName}보다 빠릅니다.`));
    } else if (elapsedHours < durationHours) {
      reasons.push(reason('REQUIRED_DURATION_NOT_MET', `완료 기간이 ${durationHours}시간에 미달합니다.`, {
        requiredDurationHours: durationHours,
        observedDurationHours: Math.floor(elapsedHours * 1000) / 1000,
      }));
    }
  }
  return { reasons, elapsedHours };
}

function evaluateEligibility(ruleCode, evidence = {}, { asOf = new Date() } = {}) {
  const rule = RULES[ruleCode];
  if (!rule) fail(422, 'SETTLEMENT_RULE_UNSUPPORTED', '지원하지 않는 정산 완료 규칙입니다.');
  const asOfMs = timestampMs(asOf);
  if (asOfMs === null) throw new TypeError('asOf는 유효한 시각이어야 합니다.');
  const reasons = [];
  let eligibleAtMs = null;
  let observedDurationHours = null;

  if (ruleCode === 'DIRECT_EXECUTION_8TH') {
    const count = evidence.completedIssueCount === null || evidence.completedIssueCount === undefined
      ? null : Number(evidence.completedIssueCount);
    const eighthMs = timestampMs(evidence.eighthIssueCompletedAt);
    if (count === null || !Number.isSafeInteger(count) || count < 0) {
      reasons.push(reason('MISSING_COMPLETED_ISSUE_COUNT', '완료 회차 근거가 없습니다.'));
    } else if (count < rule.completedIssues) {
      reasons.push(reason('EIGHTH_ISSUANCE_NOT_COMPLETED', '직접실행 완료 회차가 8회 미만입니다.', {
        requiredCompletedIssueCount: rule.completedIssues,
        observedCompletedIssueCount: count,
      }));
    }
    if (eighthMs === null) {
      reasons.push(reason('MISSING_EIGHTH_ISSUANCE_COMPLETED_AT', '8회차 완료 시각 근거가 없습니다.'));
    } else if (eighthMs > asOfMs) {
      reasons.push(reason('FUTURE_EIGHTH_ISSUANCE_COMPLETED_AT', '8회차 완료 시각이 현재보다 미래입니다.'));
    } else {
      eligibleAtMs = eighthMs;
    }
  } else {
    const exposureRule = ['MONTHLY_GUARANTEE_25D', 'PER_ITEM_24H'].includes(ruleCode);
    const result = evaluateDurationEvidence({
      startedAt: exposureRule ? evidence.exposureStartedAt : evidence.serviceStartedAt,
      completedAt: exposureRule ? evidence.exposureCompletedAt : evidence.serviceCompletedAt,
      asOfMs,
      durationHours: rule.durationHours,
      labels: exposureRule
        ? {
          startName: '노출 시작', completionName: '노출 완료',
          missingStart: 'MISSING_EXPOSURE_STARTED_AT',
          missingCompletion: 'MISSING_EXPOSURE_COMPLETED_AT',
          futureStart: 'FUTURE_EXPOSURE_STARTED_AT',
          futureCompletion: 'FUTURE_EXPOSURE_COMPLETED_AT',
        }
        : {
          startName: '서비스 시작', completionName: '서비스 완료',
          missingStart: 'MISSING_SERVICE_STARTED_AT',
          missingCompletion: 'MISSING_SERVICE_COMPLETED_AT',
          futureStart: 'FUTURE_SERVICE_STARTED_AT',
          futureCompletion: 'FUTURE_SERVICE_COMPLETED_AT',
        },
    });
    reasons.push(...result.reasons);
    observedDurationHours = result.elapsedHours;
    const completionValue = exposureRule ? evidence.exposureCompletedAt : evidence.serviceCompletedAt;
    eligibleAtMs = timestampMs(completionValue);
  }
  const eligible = reasons.length === 0;
  return Object.freeze({
    ruleCode,
    ruleLabel: rule.label,
    eligible,
    state: eligible ? 'ELIGIBLE' : 'PENDING_EVIDENCE',
    reasons: Object.freeze(reasons),
    requiredDurationHours: rule.durationHours || null,
    observedDurationHours: observedDurationHours === null
      ? null : Math.floor(observedDurationHours * 1000) / 1000,
    eligibleAt: eligible && eligibleAtMs !== null ? new Date(eligibleAtMs).toISOString() : null,
    eligibleAtKst: eligible && eligibleAtMs !== null ? kstTimestamp(eligibleAtMs) : null,
    evaluatedAt: new Date(asOfMs).toISOString(),
    evaluatedAtKst: kstTimestamp(asOfMs),
    timeZone: KST_TIME_ZONE,
  });
}

function deriveRuleFromMonthlySource(row = {}) {
  if (String(row.kind || '') !== 'sale') {
    fail(422, 'SETTLEMENT_SOURCE_NOT_SALE', '판매 행에만 정산 완료 규칙을 적용할 수 있습니다.');
  }
  const view = String(row.view || '');
  const category = cleanText(row.c, 120);
  if (view === 'direct-execution') return 'DIRECT_EXECUTION_8TH';
  if (view === 'monthly-manage') return 'MONTHLY_MANAGEMENT_30D';
  if (view === 'monthly-guarantee' && category === '월보장') return 'MONTHLY_GUARANTEE_25D';
  if (view === 'monthly-guarantee' && category === '건바이') return 'PER_ITEM_24H';
  fail(422, 'SETTLEMENT_SOURCE_RULE_UNMAPPED', '이 판매 행의 정산 완료 규칙이 정해지지 않았습니다.');
}

function workspacePermission(req) {
  return String(req?.workspace?.permissions?.settlements || 'none');
}

function isOversight(req) {
  return req?.workspace?.headquartersOversight === true || req?.workspace?.role === 'oversight';
}

function canReadCompletion(req, ownerUid, { canSeeAll = false } = {}) {
  const permission = workspacePermission(req);
  if (!['read', 'write'].includes(permission)) return false;
  if (String(req?.uid || '') === String(ownerUid || '')) return true;
  if (isOversight(req)) return true;
  if (canSeeAll) return true;
  return ['admin', 'manager'].includes(String(req?.workspace?.role || ''));
}

function canManageCompletion(req) {
  return !isOversight(req)
    && workspacePermission(req) === 'write'
    && ['admin', 'manager'].includes(String(req?.workspace?.role || ''));
}

function canReopenCompletion(req) {
  return !isOversight(req)
    && workspacePermission(req) === 'write'
    && String(req?.workspace?.role || '') === 'admin';
}

module.exports = {
  EVIDENCE_FIELDS,
  HOUR_MS,
  KST_TIME_ZONE,
  RULES,
  RULE_CODES,
  SettlementCompletionPolicyError,
  canManageCompletion,
  canReadCompletion,
  canReopenCompletion,
  cleanText,
  deriveRuleFromMonthlySource,
  evaluateEligibility,
  kstTimestamp,
  normalizeEvidence,
  normalizeReason,
  parseTimestamp,
};
