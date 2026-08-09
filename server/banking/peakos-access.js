'use strict';

const FINANCE_OPERATOR_NAMES = Object.freeze(['패션TV봉이', '박종원', '김대호', '손명아']);

const POLICY = Object.freeze({
  finalViewers: Object.freeze(['김진봉', '패션TV봉이', '손명아', '김대호', '박종원', '전현우']),
  teamViewers: Object.freeze(['김진봉', '패션TV봉이', '김대호', '박종원']),
  previewViewers: Object.freeze(['패션TV봉이', '박종원', '김대호']),
  masters: Object.freeze(['패션TV봉이']),
  protectedOwners: Object.freeze(['김진봉', '패션TV봉이', '손명아']),
  monthlyOwners: Object.freeze({
    'monthly-guarantee': '김지홍',
    'monthly-manage': '박우진',
    'direct-execution': '김대호',
  }),
  finalExecutionViewers: FINANCE_OPERATOR_NAMES,
  financeOperators: FINANCE_OPERATOR_NAMES,
  bankBalanceViewers: FINANCE_OPERATOR_NAMES,
});

const ACCESS_NAMES = Object.freeze([...new Set([
  ...POLICY.finalViewers,
  ...POLICY.teamViewers,
  ...POLICY.previewViewers,
  ...POLICY.masters,
  ...Object.values(POLICY.monthlyOwners),
  ...POLICY.finalExecutionViewers,
  ...POLICY.financeOperators,
  ...POLICY.bankBalanceViewers,
])]);

function approvedActive(req) {
  return Boolean(req?.uid && req.userDoc?.approved === true && req.userDoc?.is_active !== false);
}

function createPeakosAccess({ userPool, environment = process.env, logger = console } = {}) {
  if (!userPool || typeof userPool.query !== 'function') throw new TypeError('userPool.query가 필요합니다.');

  const finalViewerUids = new Set();
  const teamViewerUids = new Set();
  const previewViewerUids = new Set();
  const masterUids = new Set();
  const monthlyOwnerUids = new Map();
  const finalExecutionViewerUids = new Set();
  const financeOperatorUids = new Set();
  const bankBalanceViewerUids = new Set();
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
    fill(masterUids, POLICY.masters);
    fill(finalExecutionViewerUids, POLICY.finalExecutionViewers);
    fill(financeOperatorUids, POLICY.financeOperators);
    fill(bankBalanceViewerUids, POLICY.bankBalanceViewers);
    monthlyOwnerUids.clear();
    Object.entries(POLICY.monthlyOwners).forEach(([view, policyName]) => {
      monthlyOwnerUids.set(view, uidByName.get(policyName));
    });
    loaded = true;
    logger?.log?.(
      `[PEAK OS] UID 권한 로드 final=${finalViewerUids.size} finalExecution=${finalExecutionViewerUids.size} preview=${previewViewerUids.size} finance=${financeOperatorUids.size} balance=${bankBalanceViewerUids.size}`,
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
    isMaster: req => has(req, masterUids),
    canReadOwner: (req, ownerName) => {
      if (!loaded || !approvedActive(req)) return false;
      if (masterUids.has(String(req.uid || ''))) return true;
      if (!previewViewerUids.has(String(req.uid || ''))) return false;
      return !POLICY.protectedOwners.includes(String(ownerName || '').trim());
    },
    // 공개 세 통장의 조회는 승인된 활성 PEAK OS 직원 모두에게 연다. 서버
    // 권한 설정이 완전히 로드되기 전에는 false로 닫아 startup 경계를 지킨다.
    canReadBank: req => loaded && approvedActive(req),
    canViewBankBalances: req => has(req, bankBalanceViewerUids),
    canReviewFinance: req => has(req, financeOperatorUids),
    canSeeTaxPurchase: req => has(req, financeOperatorUids),
  });
}

module.exports = {
  ACCESS_NAMES,
  FINANCE_OPERATOR_NAMES,
  POLICY,
  approvedActive,
  createPeakosAccess,
};
