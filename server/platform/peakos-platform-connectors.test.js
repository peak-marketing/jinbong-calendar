'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_TIMEOUT_MS,
  CONNECTOR_DEFINITIONS,
  PlatformConnectorError,
  appendPlatformConnectionState,
  configuredProviderKeys,
  createPlatformSettlementSyncService,
  fetchProviderMonthlySnapshot,
  filterRowsForWorkspaces,
  parseProviderResponse,
  reconcileUnconfiguredProviderStates,
} = require('./peakos-platform-connectors');

test('공급사 월 집계 기본 timeout은 느린 정상 응답을 허용하되 30초로 제한한다', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 30_000);
});
const {
  calculatePlatformMonthlyAggregateDigest,
} = require('./peakos-platform-monthly-settlement');

const API_KEY = 'test-api-key-not-a-production-secret';

function jsonResponse(payload, overrides = {}) {
  const bytes = Buffer.from(JSON.stringify(payload));
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    ...(overrides.headers || {}),
  });
  return {
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    redirected: overrides.redirected ?? false,
    url: overrides.url || '',
    headers,
    async arrayBuffer() { return bytes; },
  };
}

function rewardPayload(overrides = {}) {
  return {
    ok: true,
    ym: '2026-08',
    range: { from: '2026-08-01', to: '2026-08-31' },
    status: 'DRAFT',
    effective: {
      accounts: [{
        payTo: 'kim-account', name: '김대호', accounts: 2, lines: 3, qty: 4,
        sales: 120000, distCost: 80000, spread: 40000, avgBps: 100,
        commission: 12000, deduction: 0, supplyCost: 68000, companyMargin: 28000,
      }],
      managers: [],
      totals: {
        sales: 120000, spread: 40000, lines: 3,
        commission: 12000, incentive: 0, payoutTotal: 12000,
      },
    },
    drift: 0,
    periodEnded: false,
    note: '',
    ...overrides,
  };
}

function reviewPayload(overrides = {}) {
  return {
    ok: true,
    period: '2026-08',
    summary: {
      salesCommissionAmount: 10000, managerIncentiveAmount: 0,
      totalPayoutAmount: 10000, revenueAmount: 90000, spreadProfitAmount: 25000,
    },
    bySalesRep: [{
      salesRepName: '김대호', revenueAmount: 90000, salesCommissionAmount: 10000,
      spreadProfitAmount: 25000, netProfitAmount: 15000, revenueByProduct: {},
    }],
    payouts: [{
      recipientName: '김대호', recipientEmail: 'kim@example.invalid',
      salesCommissionAmount: 10000, managerIncentiveAmount: 0, totalAmount: 10000,
    }],
    settlement: null,
    ...overrides,
  };
}

function keywordPayload(overrides = {}) {
  return {
    ok: true,
    platform: 'keywordmaster',
    ym: '2026-08',
    total: {
      revenue: 70000, supplyAmount: 50000, commission: 7000,
      planRevenue: 40000, creditRevenue: 30000, distributorCount: 1, userCount: 2,
    },
    byDistributor: [{
      code: '', name: '김대호', revenue: 70000, supplyAmount: 50000,
      commissionRate: 10, commission: 7000, planRevenue: 40000,
      creditRevenue: 30000, userCount: 2, users: [],
    }],
    excludedCodes: [],
    basis: 'monthly',
    ...overrides,
  };
}

test('고정 connector는 HTTPS origin/path와 env secret reference만 공개한다', () => {
  assert.deepEqual(Object.keys(CONNECTOR_DEFINITIONS), [
    'rewardspace', 'reviewspace', 'keywordmaster',
  ]);
  assert.deepEqual(Object.values(CONNECTOR_DEFINITIONS).map(item => item.origin), [
    'https://rewardspace.kr', 'https://review-space.kr', 'https://keywordmaster.kr',
  ]);
  for (const definition of Object.values(CONNECTOR_DEFINITIONS)) {
    assert.equal(definition.credentialSecretRef, `env:${definition.envName}`);
    assert.match(definition.pathname, /^\/api\/external\//);
  }
  const source = fs.readFileSync(path.resolve(__dirname, 'peakos-platform-connectors.js'), 'utf8');
  assert.doesNotMatch(source, /['"](?:sk_live|rk_live|eyJ)[A-Za-z0-9._-]{12,}/);
});

test('설정된 env key만 활성화하고, 빈 값이 명시되면 fail-closed한다', () => {
  assert.deepEqual(configuredProviderKeys({ PEAKOS_REWARDSPACE_API_KEY: API_KEY }), ['rewardspace']);
  assert.deepEqual(configuredProviderKeys({}), []);
  assert.throws(
    () => configuredProviderKeys({ PEAKOS_REWARDSPACE_API_KEY: '' }),
    error => error.code === 'PLATFORM_CONNECTOR_CONFIG_INVALID',
  );
});

test('RewardSpace는 월 집계를 매출·spread 이익으로 정규화한다', () => {
  const result = parseProviderResponse('rewardspace', rewardPayload(), '2026-08');
  assert.equal(result.sourceState, 'draft');
  assert.equal(result.sourceDrift, '0');
  assert.equal(result.sourceTotalCount, 1);
  assert.deepEqual(result.rows[0], {
    externalRowKey: result.rows[0].externalRowKey,
    externalSalespersonName: '김대호',
    salesAmount: '120000',
    profitAmount: '40000',
    profitBasis: 'reward_distributor_margin',
    sourceRecordCount: 3,
  });
  assert.match(result.rows[0].externalRowKey, /^monthly:v1:2026-08:[0-9a-f]{64}$/);
});

test('RewardSpace의 direct/빈 이름은 배정 전에 제외하되 원본 행 수에는 남는다', () => {
  const result = parseProviderResponse('rewardspace', rewardPayload({
    effective: {
      accounts: [
        {
          payTo: 'direct', name: '본사', lines: 1, qty: 1,
          sales: 1, distCost: 0, spread: 1, commission: 1,
        },
        {
          payTo: 'blank', name: null, lines: 1, qty: 1,
          sales: 1, distCost: 0, spread: 1, commission: 1,
        },
      ],
      managers: [],
      totals: {
        sales: 2, spread: 2, lines: 2,
        commission: 2, incentive: 0, payoutTotal: 2,
      },
    },
  }), '2026-08');
  assert.equal(result.rows.length, 0);
  assert.equal(result.skippedRowCount, 2);
  assert.equal(result.sourceTotalCount, 2);
});

test('RewardSpace는 계정 수당·담당자 인센티브·지급 총액의 문서상 합계를 교차검증한다', () => {
  const base = rewardPayload();
  const valid = rewardPayload({
    status: 'PAID',
    effective: {
      ...base.effective,
      managers: [{
        userId: 'manager-1', name: '담당자', products: ['상품'], amount: 3000,
      }],
      totals: {
        ...base.effective.totals,
        incentive: 3000,
        payoutTotal: 15000,
      },
    },
  });
  assert.equal(parseProviderResponse('rewardspace', valid, '2026-08').sourceState, 'paid');

  const accountMismatch = structuredClone(valid);
  accountMismatch.effective.accounts[0].commission = 11999;
  assert.throws(
    () => parseProviderResponse('rewardspace', accountMismatch, '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );

  const managerMismatch = structuredClone(valid);
  managerMismatch.effective.managers[0].amount = 2999;
  assert.throws(
    () => parseProviderResponse('rewardspace', managerMismatch, '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );

  const payoutMismatch = structuredClone(valid);
  payoutMismatch.effective.totals.payoutTotal = 14999;
  assert.throws(
    () => parseProviderResponse('rewardspace', payoutMismatch, '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );

  const spreadMismatch = structuredClone(valid);
  spreadMismatch.effective.accounts[0].distCost = 79999;
  assert.throws(
    () => parseProviderResponse('rewardspace', spreadMismatch, '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );
});

test('ReviewSpace는 settlement null을 live로, spreadProfitAmount를 이익으로 해석한다', () => {
  const live = parseProviderResponse('reviewspace', reviewPayload(), '2026-08');
  assert.equal(live.sourceState, 'live');
  assert.equal(live.rows[0].salesAmount, '90000');
  assert.equal(live.rows[0].profitAmount, '25000');
  assert.equal(live.rows[0].profitBasis, 'review_spread_profit');
  assert.equal(live.rows[0].sourceRecordCount, null);

  const paid = parseProviderResponse('reviewspace', reviewPayload({
    settlement: {
      periodKey: '2026-08', status: 'PAID', totalAmount: 10000,
      generatedAt: '2026-09-01T00:00:00+09:00', paidAt: '2026-09-02T00:00:00+09:00',
    },
  }), '2026-08');
  assert.equal(paid.sourceState, 'paid');
});

test('ReviewSpace는 요약·지급행 공식과 PAID 스냅샷 합계만 계약 범위에서 검증한다', () => {
  const base = reviewPayload();
  const valid = reviewPayload({
    summary: {
      ...base.summary,
      salesCommissionAmount: 10000,
      managerIncentiveAmount: 2000,
      totalPayoutAmount: 12000,
    },
    // 문서 예시는 payouts 중 한 행만 보여 합계가 summary와 일치하지 않는다.
    // 따라서 각 행 자체의 공식만 검증하고 배열 전체 합계는 추정하지 않는다.
    payouts: [{
      recipientName: '지급대상', recipientEmail: 'recipient@example.invalid',
      salesCommissionAmount: 2000, managerIncentiveAmount: 1000, totalAmount: 3000,
    }],
    settlement: {
      periodKey: '2026-08', status: 'PAID', totalAmount: 12000,
      generatedAt: '2026-09-01T00:00:00+09:00', paidAt: '2026-09-02T00:00:00+09:00',
    },
  });
  assert.equal(parseProviderResponse('reviewspace', valid, '2026-08').sourceState, 'paid');

  const summaryMismatch = structuredClone(valid);
  summaryMismatch.summary.totalPayoutAmount = 11999;
  assert.throws(
    () => parseProviderResponse('reviewspace', summaryMismatch, '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );

  const payoutMismatch = structuredClone(valid);
  payoutMismatch.payouts[0].totalAmount = 2999;
  assert.throws(
    () => parseProviderResponse('reviewspace', payoutMismatch, '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );

  const settlementMismatch = structuredClone(valid);
  settlementMismatch.settlement.totalAmount = 11999;
  assert.throws(
    () => parseProviderResponse('reviewspace', settlementMismatch, '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );
});

test('ReviewSpace bySalesRep 합계는 summary와 달라도 수용하되 행·지급행은 엄격히 검증한다', () => {
  const base = reviewPayload();
  const nonExhaustiveSalesReps = reviewPayload({
    summary: {
      ...base.summary,
      revenueAmount: base.summary.revenueAmount + 50000,
      spreadProfitAmount: base.summary.spreadProfitAmount + 7000,
    },
  });
  const parsed = parseProviderResponse('reviewspace', nonExhaustiveSalesReps, '2026-08');
  assert.equal(parsed.rows[0].salesAmount, String(base.bySalesRep[0].revenueAmount));
  assert.equal(parsed.rows[0].profitAmount, String(base.bySalesRep[0].spreadProfitAmount));

  const malformedRow = structuredClone(nonExhaustiveSalesReps);
  malformedRow.bySalesRep[0].spreadProfitAmount = Number.POSITIVE_INFINITY;
  assert.throws(
    () => parseProviderResponse('reviewspace', malformedRow, '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );

  const duplicateRow = structuredClone(nonExhaustiveSalesReps);
  duplicateRow.bySalesRep.push({ ...duplicateRow.bySalesRep[0] });
  assert.throws(
    () => parseProviderResponse('reviewspace', duplicateRow, '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_DUPLICATE_ROWS',
  );

  const malformedPayout = structuredClone(nonExhaustiveSalesReps);
  malformedPayout.payouts[0].salesCommissionAmount = 'not-an-integer';
  assert.throws(
    () => parseProviderResponse('reviewspace', malformedPayout, '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );
});

test('ReviewSpace DRAFT/PAID는 generatedAt·paidAt 상태 조합을 fail-closed한다', () => {
  const draft = reviewPayload({
    settlement: {
      periodKey: '2026-08', status: 'DRAFT', totalAmount: 10000,
      generatedAt: '2026-09-01T00:00:00+09:00', paidAt: null,
    },
  });
  assert.equal(parseProviderResponse('reviewspace', draft, '2026-08').sourceState, 'draft');

  for (const settlement of [
    { ...draft.settlement, paidAt: '2026-09-02T00:00:00+09:00' },
    { ...draft.settlement, generatedAt: null },
    {
      ...draft.settlement, status: 'PAID', paidAt: null,
    },
  ]) {
    assert.throws(
      () => parseProviderResponse('reviewspace', reviewPayload({ settlement }), '2026-08'),
      error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
    );
  }

  const missingPaidAt = { ...draft.settlement };
  delete missingPaidAt.paidAt;
  assert.throws(
    () => parseProviderResponse('reviewspace', reviewPayload({ settlement: missingPaidAt }), '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );
});

test('KeywordMaster는 commission을 영업이익으로 위장하지 않고 code+이름 키를 사용한다', () => {
  const first = parseProviderResponse('keywordmaster', keywordPayload(), '2026-08');
  const second = parseProviderResponse('keywordmaster', keywordPayload({
    byDistributor: [{
      ...keywordPayload().byDistributor[0], code: 'duplicated-code', name: '김대호',
    }],
  }), '2026-08');
  assert.equal(first.rows[0].profitAmount, null);
  assert.equal(first.rows[0].profitBasis, 'unavailable');
  assert.equal(first.rows[0].salesAmount, '70000');
  assert.equal(first.rows[0].sourceRecordCount, null);
  assert.notEqual(first.rows[0].externalRowKey, second.rows[0].externalRowKey);
});

test('월 echo, status, safe integer, duplicate row key를 엄격히 검증한다', () => {
  assert.throws(
    () => parseProviderResponse('rewardspace', rewardPayload({ ym: '2026-07' }), '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_ECHO_MISMATCH',
  );
  assert.throws(
    () => parseProviderResponse('rewardspace', rewardPayload({ status: 'FINAL' }), '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );
  assert.throws(
    () => parseProviderResponse('reviewspace', reviewPayload({
      bySalesRep: [{ ...reviewPayload().bySalesRep[0], revenueAmount: Number.MAX_SAFE_INTEGER + 1 }],
    }), '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );
  const duplicate = rewardPayload();
  duplicate.effective.accounts.push({ ...duplicate.effective.accounts[0] });
  duplicate.effective.totals = {
    sales: 240000, spread: 80000, lines: 6,
    commission: 24000, incentive: 0, payoutTotal: 24000,
  };
  assert.throws(
    () => parseProviderResponse('rewardspace', duplicate, '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_DUPLICATE_ROWS',
  );
  assert.throws(
    () => parseProviderResponse('reviewspace', reviewPayload({
      settlement: {
        periodKey: '2026-07', status: 'DRAFT', totalAmount: 10000,
        generatedAt: '2026-09-01T00:00:00+09:00', paidAt: null,
      },
    }), '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_ECHO_MISMATCH',
  );
});

test('응답 상태·drift와 문서로 보장된 행 합계·총계를 하나의 snapshot으로 검증한다', () => {
  assert.throws(
    () => parseProviderResponse('rewardspace', rewardPayload({ drift: 0.5 }), '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );
  assert.throws(
    () => parseProviderResponse('rewardspace', rewardPayload({
      range: { from: '2026-08-01', to: '2026-08-17' },
    }), '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_ECHO_MISMATCH',
  );
  assert.throws(
    () => parseProviderResponse('rewardspace', rewardPayload({
      status: 'PAID', drift: 1,
      effective: {
        ...rewardPayload().effective,
        totals: { ...rewardPayload().effective.totals, sales: 119999 },
      },
    }), '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );
  assert.throws(
    () => parseProviderResponse('reviewspace', reviewPayload({
      summary: { ...reviewPayload().summary, spreadProfitAmount: 'invalid' },
    }), '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );
  assert.throws(
    () => parseProviderResponse('keywordmaster', keywordPayload({
      total: { ...keywordPayload().total, distributorCount: 2 },
    }), '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );
});

test('fetch는 고정 URL, X-API-KEY, manual redirect, JSON 계약을 사용한다', async () => {
  let observed;
  const result = await fetchProviderMonthlySnapshot({
    provider: 'rewardspace',
    month: '2026-08',
    env: { PEAKOS_REWARDSPACE_API_KEY: API_KEY },
    now: () => new Date('2026-08-17T03:00:00.000Z'),
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return jsonResponse(rewardPayload(), { url });
    },
  });
  assert.equal(observed.url, 'https://rewardspace.kr/api/external/payouts?ym=2026-08');
  assert.equal(observed.init.method, 'GET');
  assert.equal(observed.init.redirect, 'manual');
  assert.equal(observed.init.headers['X-API-KEY'], API_KEY);
  assert.equal(result.observedAt, '2026-08-17T03:00:00.000Z');
});

test('ReviewSpace·KeywordMaster도 문서의 고정 endpoint와 월 parameter만 사용한다', async () => {
  const cases = [
    {
      provider: 'reviewspace', envName: 'PEAKOS_REVIEWSPACE_API_KEY',
      url: 'https://review-space.kr/api/external/v1/monthly-commission?period=2026-08',
      payload: reviewPayload(),
    },
    {
      provider: 'keywordmaster', envName: 'PEAKOS_KEYWORDMASTER_API_KEY',
      url: 'https://keywordmaster.kr/api/external/settlements?ym=2026-08',
      payload: keywordPayload(),
    },
  ];
  for (const item of cases) {
    let requestedUrl;
    await fetchProviderMonthlySnapshot({
      provider: item.provider,
      month: '2026-08',
      env: { [item.envName]: API_KEY },
      fetchImpl: async url => {
        requestedUrl = url;
        return jsonResponse(item.payload, { url });
      },
    });
    assert.equal(requestedUrl, item.url);
  }
});

test('redirect, HTTP error, content type, body cap을 fail-closed한다', async () => {
  const args = {
    provider: 'rewardspace', month: '2026-08',
    env: { PEAKOS_REWARDSPACE_API_KEY: API_KEY },
  };
  await assert.rejects(
    fetchProviderMonthlySnapshot({
      ...args,
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 302 }),
    }),
    error => error.code === 'PLATFORM_CONNECTOR_REDIRECT_BLOCKED',
  );
  await assert.rejects(
    fetchProviderMonthlySnapshot({
      ...args,
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 401 }),
    }),
    error => error.code === 'PLATFORM_CONNECTOR_HTTP_ERROR',
  );
  await assert.rejects(
    fetchProviderMonthlySnapshot({
      ...args,
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 429 }),
    }),
    error => error.code === 'PLATFORM_CONNECTOR_RATE_LIMITED',
  );
  await assert.rejects(
    fetchProviderMonthlySnapshot({
      ...args,
      fetchImpl: async () => jsonResponse(rewardPayload(), { headers: { 'content-type': 'text/html' } }),
    }),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_INVALID',
  );
  await assert.rejects(
    fetchProviderMonthlySnapshot({
      ...args,
      maxResponseBytes: 1024,
      fetchImpl: async () => jsonResponse(rewardPayload(), { headers: { 'content-length': '1025' } }),
    }),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_TOO_LARGE',
  );
  await assert.rejects(
    fetchProviderMonthlySnapshot({
      ...args,
      fetchImpl: async () => jsonResponse(rewardPayload(), {
        url: 'https://attacker.invalid/api/external/payouts?ym=2026-08',
      }),
    }),
    error => error.code === 'PLATFORM_CONNECTOR_REDIRECT_BLOCKED',
  );
  const oversized = Buffer.alloc(1025, 0x20);
  await assert.rejects(
    fetchProviderMonthlySnapshot({
      ...args,
      maxResponseBytes: 1024,
      fetchImpl: async () => ({
        ok: true, status: 200, redirected: false, url: '',
        headers: new Headers({ 'content-type': 'application/json', 'content-length': '10' }),
        async arrayBuffer() { return oversized; },
      }),
    }),
    error => error.code === 'PLATFORM_CONNECTOR_RESPONSE_TOO_LARGE',
  );
});

test('timeout과 network 오류에 API key를 노출하지 않는다', async () => {
  const secret = 'never-print-this-platform-key';
  await assert.rejects(
    fetchProviderMonthlySnapshot({
      provider: 'rewardspace', month: '2026-08', timeoutMs: 25,
      env: { PEAKOS_REWARDSPACE_API_KEY: secret },
      fetchImpl: async () => new Promise(() => {}),
    }),
    error => {
      assert.equal(error.code, 'PLATFORM_CONNECTOR_TIMEOUT');
      assert.doesNotMatch(`${error.message}\n${error.stack}`, new RegExp(secret));
      return true;
    },
  );
  await assert.rejects(
    fetchProviderMonthlySnapshot({
      provider: 'rewardspace', month: '2026-08',
      env: { PEAKOS_REWARDSPACE_API_KEY: secret },
      fetchImpl: async () => { throw new Error(`upstream rejected ${secret}`); },
    }),
    error => {
      assert.equal(error.code, 'PLATFORM_CONNECTOR_NETWORK_ERROR');
      assert.doesNotMatch(`${error.message}\n${error.stack}`, new RegExp(secret));
      return true;
    },
  );
});

test('글로벌 exact-name이 단 하나의 workspace+UID일 때만 금액을 배정한다', () => {
  const rows = [
    { externalRowKey: 'row-kim', externalSalespersonName: '김대호', salesAmount: '10' },
    { externalRowKey: 'row-park', externalSalespersonName: '박종원', salesAmount: '20' },
    { externalRowKey: 'row-none', externalSalespersonName: '없음', salesAmount: '30' },
  ];
  const assigned = filterRowsForWorkspaces(rows, [
    { workspaceId: 'ws-a', uid: null, name: null },
    { workspaceId: 'ws-b', uid: null, name: null },
    { workspaceId: 'ws-a', uid: 'uid-kim', name: '김대호' },
    { workspaceId: 'ws-a', uid: 'uid-park-a', name: '박종원' },
    { workspaceId: 'ws-b', uid: 'uid-park-b', name: '박종원' },
  ]);
  const workspaceA = assigned.workspaces.find(item => item.workspaceId === 'ws-a');
  const workspaceB = assigned.workspaces.find(item => item.workspaceId === 'ws-b');
  assert.deepEqual(workspaceA.rows.map(row => row.externalRowKey), ['row-kim']);
  assert.equal(workspaceA.rows[0].attributionStatus, 'mapped');
  assert.equal(workspaceA.rows[0].ownerUid, 'uid-kim');
  assert.equal(workspaceA.rows[0].ownerNameSnapshot, '김대호');
  assert.deepEqual(workspaceA.attributionIssues, [{
    externalRowKey: 'row-park', externalSalespersonName: '박종원',
  }]);
  assert.deepEqual(workspaceB.rows, []);
  assert.equal(workspaceB.attributionIssues[0].salesAmount, undefined);
  assert.equal(assigned.globalUnmatchedCount, 1);
  assert.equal(assigned.globalAmbiguousCount, 1);
});

test('connection state는 env reference만 append하고 이전 성공 시각을 error version에 계승한다', async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, values });
      if (normalized.includes('SELECT version, last_successful_import_at')) {
        return { rows: [{ version: 2, last_successful_import_at: '2026-08-16T00:00:00Z' }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const result = await appendPlatformConnectionState({
    pool, workspaceId: 'ws-a', provider: 'rewardspace', connectionState: 'error',
    credentialSecretRef: 'env:PEAKOS_REWARDSPACE_API_KEY',
    errorCode: 'PLATFORM_CONNECTOR_HTTP_ERROR',
    actor: { uid: 'system:rewardspace-monthly-sync', name: '수집기' },
    now: new Date('2026-08-17T00:00:00Z'),
  });
  assert.equal(result.version, 3);
  const insert = calls.find(call => call.sql.startsWith('INSERT INTO'));
  assert.equal(insert.values[4], 'env:PEAKOS_REWARDSPACE_API_KEY');
  assert.equal(insert.values[5], '2026-08-16T00:00:00Z');
  assert.equal(insert.values[6], 'PLATFORM_CONNECTOR_HTTP_ERROR');
  assert.equal(calls.some(call => JSON.stringify(call.values).includes(API_KEY)), false);
});

test('이전 ready provider의 env key가 사라지면 disabled 버전을 append한다', async () => {
  const disabled = [];
  const pool = {
    async query() {
      return { rows: [
        { workspace_id: 'ws-a', provider: 'reviewspace', connection_state: 'ready' },
        { workspace_id: 'ws-a', provider: 'keywordmaster', connection_state: 'disabled' },
      ] };
    },
  };
  const result = await reconcileUnconfiguredProviderStates({
    pool,
    workspaceIds: ['ws-a'],
    configuredProviders: ['rewardspace'],
    async appendConnectionState(payload) { disabled.push(payload); },
    now: new Date('2026-08-17T00:00:00Z'),
  });
  assert.deepEqual(result, [{ workspaceId: 'ws-a', provider: 'reviewspace' }]);
  assert.equal(disabled.length, 1);
  assert.equal(disabled[0].connectionState, 'disabled');
  assert.equal(disabled[0].credentialSecretRef, null);
});

function servicePool() {
  let connectionCount = 0;
  return {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('FROM public.peakos_workspaces') && !normalized.includes('memberships')) {
        return { rows: [{ workspace_id: 'ws-a' }, { workspace_id: 'ws-b' }] };
      }
      if (normalized.includes('peakos_workspace_memberships')) {
        return { rows: [
          { workspace_id: 'ws-a', uid: 'uid-kim', name: '김대호' },
          { workspace_id: 'ws-b', uid: 'uid-lee', name: '이영희' },
        ] };
      }
      if (normalized.includes('attempt_count')) return { rows: [{ attempt_count: 0 }] };
      if (normalized.includes('peakos_platform_connections')) return { rows: [] };
      throw new Error(`unexpected query: ${normalized}`);
    },
    async connect() {
      connectionCount += 1;
      return {
        async query(sql) {
          if (String(sql).includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
          return { rows: [{ pg_advisory_unlock: true }] };
        },
        release() {},
      };
    },
    get connectionCount() { return connectionCount; },
  };
}

test('sync service는 provider/month당 1회 fetch 후 모든 활성 workspace에 분리 snapshot을 저장한다', async () => {
  const pool = servicePool();
  const imports = [];
  const states = [];
  let fetchCount = 0;
  const service = createPlatformSettlementSyncService({
    pool,
    env: { PEAKOS_REWARDSPACE_API_KEY: API_KEY },
    now: () => new Date('2026-08-17T03:00:00Z'),
    logger: { error() {} },
    fetchImpl: async (url) => {
      fetchCount += 1;
      const payload = rewardPayload({
        effective: {
          accounts: [
            rewardPayload().effective.accounts[0],
            { ...rewardPayload().effective.accounts[0], payTo: 'lee', name: '이영희' },
            { ...rewardPayload().effective.accounts[0], payTo: 'unknown', name: '외부인' },
          ],
          managers: [],
          totals: {
            sales: 360000, spread: 120000, lines: 9,
            commission: 36000, incentive: 0, payoutTotal: 36000,
          },
        },
      });
      return jsonResponse(payload, { url });
    },
    calculateSnapshotDigest(payload) {
      assert.equal(payload.coveredFrom, '2026-08-01');
      assert.equal(payload.coveredTo, '2026-08-17');
      return calculatePlatformMonthlyAggregateDigest(payload);
    },
    async importMonthlySnapshot(payload) {
      imports.push(payload);
      return { duplicate: false };
    },
    async appendConnectionState(payload) { states.push(payload); },
  });
  assert.deepEqual(service.configuredProviders, ['rewardspace']);
  const result = await service.syncMonth('2026-08');
  assert.equal(fetchCount, 1);
  assert.equal(imports.length, 2);
  assert.deepEqual(imports.map(item => [item.workspaceId, item.rows[0]?.externalSalespersonName]), [
    ['ws-a', '김대호'], ['ws-b', '이영희'],
  ]);
  assert.equal(imports[0].sourceTotalCount, 3);
  assert.equal(imports[0].globalUnmatchedCount, 1);
  assert.equal(imports[0].sourceExcludedCount, 1);
  assert.equal(imports[1].sourceExcludedCount, 1);
  assert.match(imports[0].sourceDigest, /^[0-9a-f]{64}$/);
  assert.match(imports[1].sourceDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(imports[0].sourceDigest, imports[1].sourceDigest);
  assert.equal(
    imports[0].sourceDigest,
    calculatePlatformMonthlyAggregateDigest(imports[0]),
  );
  assert.equal(states.length, 2);
  assert.equal(states.every(item => item.connectionState === 'ready'), true);
  assert.equal(result.providers[0].sourceRowCount, 3);
  assert.equal(result.providers[0].globalUnmatchedCount, 1);
});

test('sync fetch 실패는 비밀값없는 error state를 모든 workspace에 append한다', async () => {
  const states = [];
  const logs = [];
  const service = createPlatformSettlementSyncService({
    pool: servicePool(),
    env: { PEAKOS_REWARDSPACE_API_KEY: API_KEY },
    now: () => new Date('2026-08-17T03:00:00Z'),
    fetchImpl: async () => jsonResponse({}, { status: 401, ok: false }),
    calculateSnapshotDigest: () => 'a'.repeat(64),
    async importMonthlySnapshot() { throw new Error('must not import'); },
    async appendConnectionState(payload) { states.push(payload); },
    logger: { error(message, metadata) { logs.push({ message, metadata }); } },
  });
  const result = await service.syncMonth('2026-08');
  assert.equal(result.providers[0].ok, false);
  assert.equal(states.length, 2);
  assert.equal(states.every(item => item.connectionState === 'error'), true);
  assert.equal(states.every(item => item.credentialSecretRef === 'env:PEAKOS_REWARDSPACE_API_KEY'), true);
  assert.doesNotMatch(JSON.stringify({ states, logs, result }), new RegExp(API_KEY));
});

test('workspace snapshot import 실패는 다른 workspace를 중단하지 않고 error version을 남긴다', async () => {
  const states = [];
  const imports = [];
  const service = createPlatformSettlementSyncService({
    pool: servicePool(),
    env: { PEAKOS_REWARDSPACE_API_KEY: API_KEY },
    now: () => new Date('2026-08-17T03:00:00Z'),
    fetchImpl: async url => jsonResponse(rewardPayload({
      effective: {
        accounts: [
          rewardPayload().effective.accounts[0],
          { ...rewardPayload().effective.accounts[0], payTo: 'lee', name: '이영희' },
        ],
        managers: [],
        totals: {
          sales: 240000, spread: 80000, lines: 6,
          commission: 24000, incentive: 0, payoutTotal: 24000,
        },
      },
    }), { url }),
    calculateSnapshotDigest: calculatePlatformMonthlyAggregateDigest,
    async importMonthlySnapshot(payload) {
      imports.push(payload.workspaceId);
      if (payload.workspaceId === 'ws-a') {
        const error = new Error('private database detail');
        error.code = 'PLATFORM_AGGREGATE_ATTRIBUTION_UNRESOLVED';
        throw error;
      }
      return { duplicate: false };
    },
    async appendConnectionState(payload) { states.push(payload); },
    logger: { error() {} },
  });
  const result = await service.syncMonth('2026-08');
  assert.deepEqual(imports, ['ws-a', 'ws-b']);
  assert.deepEqual(states.map(item => [item.workspaceId, item.connectionState]), [
    ['ws-a', 'error'], ['ws-b', 'ready'],
  ]);
  assert.equal(result.providers[0].ok, false);
  assert.equal(result.providers[0].workspaces[0].code, 'PLATFORM_AGGREGATE_ATTRIBUTION_UNRESOLVED');
});

test('aggregate import 성공 뒤 ready state 실패는 import를 재실행하지 않고 connection-state 오류를 한 번 append한다', async () => {
  const pool = servicePool();
  const baseQuery = pool.query.bind(pool);
  pool.query = async sql => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    if (normalized.includes('FROM public.peakos_workspaces')
        && !normalized.includes('memberships')) {
      return { rows: [{ workspace_id: 'ws-a' }] };
    }
    if (normalized.includes('peakos_workspace_memberships')) {
      return { rows: [{ workspace_id: 'ws-a', uid: 'uid-kim', name: '김대호' }] };
    }
    return baseQuery(sql);
  };
  let importCount = 0;
  const stateAttempts = [];
  const logs = [];
  const privateFailure = 'private db detail 영업자=김대호 amount=990001';
  const service = createPlatformSettlementSyncService({
    pool,
    env: { PEAKOS_REWARDSPACE_API_KEY: API_KEY },
    now: () => new Date('2026-08-17T03:00:00Z'),
    fetchImpl: async url => jsonResponse(rewardPayload(), { url }),
    calculateSnapshotDigest: calculatePlatformMonthlyAggregateDigest,
    async importMonthlySnapshot() {
      importCount += 1;
      return { duplicate: true };
    },
    async appendConnectionState(payload) {
      stateAttempts.push({
        connectionState: payload.connectionState,
        errorCode: payload.errorCode,
      });
      if (payload.connectionState === 'ready') throw new Error(privateFailure);
      return { connectionState: payload.connectionState };
    },
    logger: { error(message, metadata) { logs.push({ message, metadata }); } },
  });

  const result = await service.syncMonth('2026-08');

  assert.equal(importCount, 1);
  assert.deepEqual(stateAttempts, [
    { connectionState: 'ready', errorCode: undefined },
    {
      connectionState: 'error',
      errorCode: 'PLATFORM_CONNECTOR_CONNECTION_STATE_FAILED',
    },
  ]);
  assert.equal(result.providers[0].ok, false);
  assert.deepEqual(result.providers[0].workspaces[0], {
    workspaceId: 'ws-a',
    ok: false,
    connectionReady: false,
    rowCount: 1,
    attributionIssueCount: 0,
    duplicate: true,
    code: 'PLATFORM_CONNECTOR_CONNECTION_STATE_FAILED',
  });
  assert.deepEqual(logs, [{
    message: 'platform settlement connection state append failed',
    metadata: {
      provider: 'rewardspace',
      month: '2026-08',
      code: 'PLATFORM_CONNECTOR_CONNECTION_STATE_FAILED',
    },
  }]);
  const serialized = JSON.stringify({ result, logs, stateAttempts });
  assert.equal(serialized.includes(privateFailure), false);
  assert.equal(serialized.includes('PLATFORM_CONNECTOR_IMPORT_FAILED'), false);
});

test('ReviewSpace는 DB에 기록된 최근 1시간 시도가 10회면 외부 호출 전에 차단한다', async () => {
  const pool = servicePool();
  const originalQuery = pool.query.bind(pool);
  pool.query = async sql => {
    if (String(sql).includes('attempt_count')) return { rows: [{ attempt_count: 10 }] };
    return originalQuery(sql);
  };
  let fetchCount = 0;
  const states = [];
  const service = createPlatformSettlementSyncService({
    pool,
    env: { PEAKOS_REVIEWSPACE_API_KEY: API_KEY },
    now: () => new Date('2026-08-17T03:00:00Z'),
    fetchImpl: async () => { fetchCount += 1; return jsonResponse(reviewPayload()); },
    calculateSnapshotDigest: calculatePlatformMonthlyAggregateDigest,
    importMonthlySnapshot: async () => {},
    appendConnectionState: async payload => { states.push(payload); },
  });
  const result = await service.syncMonth('2026-08');
  assert.equal(fetchCount, 0);
  assert.equal(result.providers[0].code, 'PLATFORM_CONNECTOR_RATE_LIMITED');
  assert.equal(states.length, 2);
  assert.equal(states.every(item => item.connectionState === 'error'), true);
});

test('ReviewSpace 호출 시도는 fetch 전 pending, 저장 후 ready 버전으로 남는다', async () => {
  const states = [];
  let fetchCount = 0;
  const service = createPlatformSettlementSyncService({
    pool: servicePool(),
    env: { PEAKOS_REVIEWSPACE_API_KEY: API_KEY },
    now: () => new Date('2026-08-17T03:00:00Z'),
    fetchImpl: async url => {
      fetchCount += 1;
      assert.equal(states.filter(item => item.connectionState === 'pending').length, 2);
      return jsonResponse(reviewPayload(), { url });
    },
    calculateSnapshotDigest: calculatePlatformMonthlyAggregateDigest,
    importMonthlySnapshot: async () => ({ duplicate: false }),
    appendConnectionState: async payload => { states.push(payload); },
  });
  const result = await service.syncMonth('2026-08');
  assert.equal(fetchCount, 1);
  assert.equal(result.providers[0].ok, true);
  assert.deepEqual(states.map(item => item.connectionState), [
    'pending', 'pending', 'ready', 'ready',
  ]);
});

test('scheduler lock을 얻지 못하면 API나 importer를 호출하지 않는다', async () => {
  let fetchCount = 0;
  let importCount = 0;
  const pool = servicePool();
  pool.connect = async () => ({
    async query(sql) {
      if (String(sql).includes('pg_try_advisory_lock')) return { rows: [{ locked: false }] };
      throw new Error('unexpected unlock');
    },
    release() {},
  });
  const service = createPlatformSettlementSyncService({
    pool,
    env: { PEAKOS_REWARDSPACE_API_KEY: API_KEY },
    fetchImpl: async () => { fetchCount += 1; return jsonResponse(rewardPayload()); },
    calculateSnapshotDigest: () => 'a'.repeat(64),
    importMonthlySnapshot: async () => { importCount += 1; },
  });
  const result = await service.syncMonth('2026-08');
  assert.deepEqual(result, { month: '2026-08', skipped: true, reason: 'locked', providers: [] });
  assert.equal(fetchCount, 0);
  assert.equal(importCount, 0);
});

test('advisory unlock이 확인되지 않으면 pool client를 error release한다', async () => {
  let releasedWith;
  const pool = servicePool();
  pool.connect = async () => ({
    async query(sql) {
      if (String(sql).includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      return { rows: [{ pg_advisory_unlock: false }] };
    },
    release(error) { releasedWith = error; },
  });
  const service = createPlatformSettlementSyncService({
    pool,
    env: {},
    fetchImpl: async () => { throw new Error('must not fetch'); },
    calculateSnapshotDigest: calculatePlatformMonthlyAggregateDigest,
    importMonthlySnapshot: async () => {},
    logger: { error() {} },
  });
  await service.syncMonth('2026-08');
  assert.ok(releasedWith instanceof Error);
  assert.match(releasedWith.message, /unlock/);
});

test('미래 월은 API 호출 전에 거부하고 current+previous는 KST 월을 사용한다', async () => {
  const service = createPlatformSettlementSyncService({
    pool: servicePool(),
    env: {},
    now: () => new Date('2026-08-31T15:30:00Z'),
    fetchImpl: async () => { throw new Error('unconfigured provider must not fetch'); },
    calculateSnapshotDigest: () => 'a'.repeat(64),
    importMonthlySnapshot: async () => {},
  });
  await assert.rejects(
    service.syncMonth('2026-10'),
    error => error.code === 'PLATFORM_CONNECTOR_FUTURE_MONTH',
  );
  const results = await service.syncCurrentAndPrevious();
  assert.deepEqual(results.map(item => item.month), ['2026-08', '2026-09']);
});

test('provider-selective canary는 전체 configured set을 유지하고 선택 provider만 이전월부터 직렬 처리한다', async () => {
  const requests = [];
  const imports = [];
  const states = [];
  const service = createPlatformSettlementSyncService({
    pool: servicePool(),
    env: {
      PEAKOS_REWARDSPACE_API_KEY: 'reward-test-key',
      PEAKOS_REVIEWSPACE_API_KEY: 'review-test-key',
      PEAKOS_KEYWORDMASTER_API_KEY: 'keyword-test-key',
    },
    // 실행 시각과 canary 기준 월이 달라도 명시한 기준 월을 적재 대상으로 고정한다.
    now: () => new Date('2026-09-17T03:00:00Z'),
    fetchImpl: async url => {
      const parsed = new URL(url);
      const month = parsed.searchParams.get('ym');
      requests.push({ origin: parsed.origin, pathname: parsed.pathname, month });
      const lastDay = month === '2026-07' ? '31' : '31';
      return jsonResponse(rewardPayload({
        ym: month,
        range: { from: `${month}-01`, to: `${month}-${lastDay}` },
      }), { url });
    },
    calculateSnapshotDigest: calculatePlatformMonthlyAggregateDigest,
    async importMonthlySnapshot(payload) {
      imports.push({ provider: payload.provider, month: payload.month, workspaceId: payload.workspaceId });
      return { duplicate: false };
    },
    async appendConnectionState(payload) {
      states.push({ provider: payload.provider, workspaceId: payload.workspaceId, state: payload.connectionState });
    },
    logger: { error() {} },
  });

  assert.deepEqual(service.configuredProviders, [
    'rewardspace', 'reviewspace', 'keywordmaster',
  ]);
  const results = await service.syncProviderCurrentAndPrevious(
    'rewardspace',
    new Date('2026-08-17T03:00:00Z'),
  );

  assert.deepEqual(results.map(result => result.month), ['2026-07', '2026-08']);
  assert.deepEqual(requests, [
    {
      origin: 'https://rewardspace.kr',
      pathname: '/api/external/payouts',
      month: '2026-07',
    },
    {
      origin: 'https://rewardspace.kr',
      pathname: '/api/external/payouts',
      month: '2026-08',
    },
  ]);
  assert.equal(results.every(result => result.providers.length === 1), true);
  assert.equal(results.every(result => result.providers[0].provider === 'rewardspace'), true);
  assert.deepEqual([...new Set(imports.map(item => item.provider))], ['rewardspace']);
  assert.deepEqual(imports.map(item => item.month), [
    '2026-07', '2026-07', '2026-08', '2026-08',
  ]);
  assert.equal(states.length, 4);
  assert.equal(states.every(item => item.provider === 'rewardspace' && item.state === 'ready'), true);
});

test('provider-selective sync는 미설정 또는 알 수 없는 provider를 lock/fetch 전에 거부한다', async () => {
  const pool = servicePool();
  let fetchCount = 0;
  const service = createPlatformSettlementSyncService({
    pool,
    env: { PEAKOS_REWARDSPACE_API_KEY: API_KEY },
    fetchImpl: async () => { fetchCount += 1; return jsonResponse(rewardPayload()); },
    calculateSnapshotDigest: calculatePlatformMonthlyAggregateDigest,
    importMonthlySnapshot: async () => {},
  });
  await assert.rejects(
    service.syncProviderMonth('reviewspace', '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_NOT_CONFIGURED',
  );
  await assert.rejects(
    service.syncProviderMonth('unknown-provider', '2026-08'),
    error => error.code === 'PLATFORM_CONNECTOR_CONFIG_INVALID',
  );
  assert.equal(fetchCount, 0);
  assert.equal(pool.connectionCount, 0);
});

test('public connector error는 원본 upstream message/cause를 보존하지 않는다', () => {
  const error = new PlatformConnectorError('PLATFORM_CONNECTOR_NETWORK_ERROR');
  assert.equal(error.code, 'PLATFORM_CONNECTOR_NETWORK_ERROR');
  assert.equal(ownProperty(error, 'cause'), false);
  const stateError = new PlatformConnectorError('PLATFORM_CONNECTOR_CONNECTION_STATE_FAILED');
  assert.equal(stateError.code, 'PLATFORM_CONNECTOR_CONNECTION_STATE_FAILED');
  assert.match(stateError.message, /연결 상태/);
});

function ownProperty(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
