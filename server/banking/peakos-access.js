'use strict';

const FINANCE_OPERATOR_NAMES = Object.freeze(['패션TV봉이', '박종원', '김대호', '손명아']);
const FINANCE_OPERATION_VIEWER_NAMES = Object.freeze([
  '패션TV봉이', '박종원', '김대호', '손명아', '전현우',
]);
const TAX_PURCHASE_VIEWER_NAMES = FINANCE_OPERATION_VIEWER_NAMES;

const POLICY = Object.freeze({
  finalViewers: Object.freeze(['김진봉', '패션TV봉이', '손명아', '김대호', '박종원', '전현우']),
  teamViewers: Object.freeze(['김진봉', '패션TV봉이', '김대호', '박종원']),
  previewViewers: Object.freeze(['패션TV봉이', '박종원', '김대호']),
  // 신규 구조화 프로젝트와 계정 미리보기는 현재 동일한 세
  // 계정을 사용하지만 권한 의미와 수명주기는 분리한다.
  structuredProjectPortfolioViewers: Object.freeze(['패션TV봉이', '박종원', '김대호']),
  masters: Object.freeze(['패션TV봉이']),
  protectedOwners: Object.freeze(['김진봉', '패션TV봉이', '손명아']),
  monthlyOwners: Object.freeze({
    'monthly-guarantee': '김지홍',
    'monthly-manage': '박우진',
    'direct-execution': '김대호',
  }),
  finalExecutionViewers: FINANCE_OPERATOR_NAMES,
  financeOperationViewers: FINANCE_OPERATION_VIEWER_NAMES,
  financeOperators: FINANCE_OPERATOR_NAMES,
  bankBalanceViewers: FINANCE_OPERATOR_NAMES,
  taxPurchaseViewers: TAX_PURCHASE_VIEWER_NAMES,
});

const ACCESS_NAMES = Object.freeze([...new Set([
  ...POLICY.finalViewers,
  ...POLICY.teamViewers,
  ...POLICY.previewViewers,
  ...POLICY.structuredProjectPortfolioViewers,
  ...POLICY.masters,
  ...Object.values(POLICY.monthlyOwners),
  ...POLICY.finalExecutionViewers,
  ...POLICY.financeOperationViewers,
  ...POLICY.financeOperators,
  ...POLICY.bankBalanceViewers,
  ...POLICY.taxPurchaseViewers,
])]);

function approvedActive(req) {
  return Boolean(req?.uid && req.userDoc?.approved === true && req.userDoc?.is_active !== false);
}

function createPeakosAccess({ userPool, environment = process.env, logger = console } = {}) {
  if (!userPool || typeof userPool.query !== 'function') throw new TypeError('userPool.query가 필요합니다.');

  const finalViewerUids = new Set();
  const teamViewerUids = new Set();
  const previewViewerUids = new Set();
  const structuredProjectPortfolioViewerUids = new Set();
  const masterUids = new Set();
  const protectedOwnerUids = new Set();
  const monthlyOwnerUids = new Map();
  const finalExecutionViewerUids = new Set();
  const financeOperationViewerUids = new Set();
  const financeOperatorUids = new Set();
  const bankBalanceViewerUids = new Set();
  const taxPurchaseViewerUids = new Set();
  let loaded = false;

  const has = (req, uidSet) => loaded && approvedActive(req) && uidSet.has(String(req.uid || ''));

  async function load() {
    let configured;
    try {
      configured = JSON.parse(String(environment.PEAKOS_ACCESS_UIDS_JSON || ''));
    } catch (_) {
      throw new Error('PEAKOS_ACCESS_UIDS_JSON 형식이 올바르지 않습니다.');
    }
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
      throw new Error('PEAKOS_ACCESS_UIDS_JSON 설정이 필요합니다.');
    }
    const expectedNames = new Set(ACCESS_NAMES);
    const configuredNames = Object.keys(configured);
    if (configuredNames.length !== expectedNames.size
        || configuredNames.some(name => !expectedNames.has(name))) {
      throw new Error('PEAKOS_ACCESS_UIDS_JSON 권한 대상이 코드의 승인 목록과 다릅니다.');
    }

    const uidByName = new Map();
    const uniqueUids = new Set();
    for (const policyName of ACCESS_NAMES) {
      const uid = String(configured[policyName] || '').trim();
      if (!/^[A-Za-z0-9:_-]{6,256}$/.test(uid) || uniqueUids.has(uid)) {
        throw new Error('PEAKOS_ACCESS_UIDS_JSON UID가 누락·중복되었거나 형식이 올바르지 않습니다.');
      }
      uidByName.set(policyName, uid);
      uniqueUids.add(uid);
    }

    const result = await userPool.query(
      `SELECT uid
         FROM users
        WHERE uid = ANY($1::text[])
          AND approved = true
          AND COALESCE(is_active, true) = true`,
      [[...uniqueUids]],
    );
    const activeUids = new Set(result.rows.map(row => String(row.uid || '')));
    if (activeUids.size !== uniqueUids.size || [...uniqueUids].some(uid => !activeUids.has(uid))) {
      throw new Error('PEAK OS 권한 대상 중 미승인·비활성·삭제 계정이 있습니다.');
    }

    const fill = (target, names) => {
      target.clear();
      names.forEach(policyName => target.add(uidByName.get(policyName)));
    };
    fill(finalViewerUids, POLICY.finalViewers);
    fill(teamViewerUids, POLICY.teamViewers);
    fill(previewViewerUids, POLICY.previewViewers);
    fill(structuredProjectPortfolioViewerUids, POLICY.structuredProjectPortfolioViewers);
    fill(masterUids, POLICY.masters);
    fill(protectedOwnerUids, POLICY.protectedOwners);
    fill(finalExecutionViewerUids, POLICY.finalExecutionViewers);
    fill(financeOperationViewerUids, POLICY.financeOperationViewers);
    fill(financeOperatorUids, POLICY.financeOperators);
    fill(bankBalanceViewerUids, POLICY.bankBalanceViewers);
    fill(taxPurchaseViewerUids, POLICY.taxPurchaseViewers);
    monthlyOwnerUids.clear();
    Object.entries(POLICY.monthlyOwners).forEach(([view, policyName]) => {
      monthlyOwnerUids.set(view, uidByName.get(policyName));
    });
    loaded = true;
    logger?.log?.(
      `[PEAK OS] UID 권한 로드 final=${finalViewerUids.size} finalExecution=${finalExecutionViewerUids.size} preview=${previewViewerUids.size} financeOperations=${financeOperationViewerUids.size} finance=${financeOperatorUids.size} taxPurchase=${taxPurchaseViewerUids.size} balance=${bankBalanceViewerUids.size}`,
    );
  }

  return Object.freeze({
    load,
    approvedActive,
    name: req => String(req?.userDoc?.name || '').trim(),
    canSeeAll: req => has(req, finalViewerUids),
    canSeeTeam: req => has(req, teamViewerUids),
    canSeeMonthly: (req, view) => (
      loaded && approvedActive(req) && monthlyOwnerUids.get(view) === String(req.uid || '')
    ),
    canManageMonthly: (req, view) => (
      loaded && approvedActive(req) && monthlyOwnerUids.get(view) === String(req.uid || '')
    ),
    canSeeFinalExecution: req => has(req, finalExecutionViewerUids),
    canSeeFinanceOperations: req => has(req, financeOperationViewerUids),
    // 최종정산서·결산은 재무 운영 메뉴와 같은 지정 5명만 접근한다.
    // canSeeAll은 회사자료 등 기존 상위 조회 권한에도 쓰이므로 별도로 유지한다.
    canSeeFinalSettlement: req => has(req, financeOperationViewerUids),
    canPreviewAccounts: req => has(req, previewViewerUids),
    canViewStructuredProjectPortfolio: req => has(req, structuredProjectPortfolioViewerUids),
    canCreateStructuredProject: req => has(req, structuredProjectPortfolioViewerUids),
    isMaster: req => has(req, masterUids),
    canReadOwnerUid: (req, targetUid) => {
      if (!loaded || !approvedActive(req)) return false;
      if (masterUids.has(String(req.uid || ''))) return true;
      if (!previewViewerUids.has(String(req.uid || ''))) return false;
      return !protectedOwnerUids.has(String(targetUid || ''));
    },
    // 공개 세 통장의 조회는 승인된 활성 PEAK OS 직원 모두에게 연다. 서버
    // 권한 설정이 완전히 로드되기 전에는 false로 닫아 startup 경계를 지킨다.
    canReadBank: req => loaded && approvedActive(req),
    canViewBankBalances: req => has(req, bankBalanceViewerUids),
    canReviewFinance: req => has(req, financeOperatorUids),
    canSeeTaxPurchase: req => has(req, taxPurchaseViewerUids),
  });
}

module.exports = {
  ACCESS_NAMES,
  FINANCE_OPERATOR_NAMES,
  FINANCE_OPERATION_VIEWER_NAMES,
  TAX_PURCHASE_VIEWER_NAMES,
  POLICY,
  approvedActive,
  createPeakosAccess,
};
