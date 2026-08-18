'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  APPEND_ONLY_FUNCTION_SOURCE,
  PLATFORM_PROVIDERS,
  REQUIRED_COLUMN_DEFINITIONS,
  REQUIRED_CONSTRAINT_DEFINITIONS,
  REQUIRED_INDEX_DEFINITIONS,
  calculatePlatformMonthlyAggregateDigest,
  coverageState,
  correctPlatformSalespersonMapping,
  ensurePeakosPlatformSettlementInfrastructure,
  importPlatformMonthlyAggregateSnapshot,
  importPlatformTransactionBatch,
  inspectLatestPlatformMonthlyAggregateRun,
  monthBounds,
  normalizeExactName,
  quarantinePlatformMonthlyAggregateRun,
  registerPeakosPlatformMonthlySettlementRoutes,
} = require('./peakos-platform-monthly-settlement');

const MIGRATION = fs.readFileSync(path.resolve(
  __dirname,
  '../migrations/20260817_peakos_platform_monthly_settlement.sql',
), 'utf8');
const QUARANTINE_MIGRATION = fs.readFileSync(path.resolve(
  __dirname,
  '../migrations/20260818_peakos_platform_aggregate_quarantine.sql',
), 'utf8');
const INDEX_SOURCE = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');

function responseCapture() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    vary() { return this; },
  };
}

function captureRoute(pool, options = {}) {
  let handler;
  const routedPool = typeof pool.connect === 'function' ? pool : {
    ...pool,
    async connect() {
      return {
        async query(sql, values) {
          const normalized = String(sql).replace(/\s+/g, ' ').trim();
          if (normalized.startsWith('BEGIN TRANSACTION') || ['COMMIT', 'ROLLBACK'].includes(normalized)) {
            return { rows: [] };
          }
          if (normalized.includes('peakos_platform_aggregate_') && pool.__aggregateAware !== true) {
            return { rows: [] };
          }
          return pool.query(sql, values);
        },
        release() {},
      };
    },
  };
  const app = {
    get(routePath, ...callbacks) {
      assert.equal(routePath, '/api/peakos/monthly-settlement/self');
      handler = callbacks.at(-1);
    },
  };
  registerPeakosPlatformMonthlySettlementRoutes({
    app,
    pool: routedPool,
    now: () => new Date('2026-08-17T03:00:00.000Z'),
    ...options,
  });
  return handler;
}

function selfRequest(query = {}, overrides = {}) {
  return {
    uid: 'uid-kim',
    userName: '김대호',
    userDoc: { approved: true, is_active: true, name: '김대호' },
    workspace: {
      id: 'ws_peak', role: 'member', headquartersOversight: false,
      permissions: { settlements: 'none', sales: 'none' },
    },
    headers: {},
    query,
    ...overrides,
  };
}

test('고정 플랫폼 키와 한글 이름은 요청한 5개만 안정된 순서로 제공한다', () => {
  assert.deepEqual(PLATFORM_PROVIDERS, [
    { key: 'rewardspace', label: '리워드스페이스' },
    { key: 'reviewspace', label: '리뷰스페이스' },
    { key: 'keywordmaster', label: '키워드마스터' },
    { key: 'brandautospace', label: '브랜드오토스페이스' },
    { key: 'reviewflow', label: '리뷰플로우' },
  ]);
});

test('월 경계와 현재 월 coverage 기준일은 KST로 계산한다', () => {
  assert.deepEqual(monthBounds('2026-08', new Date('2026-08-16T15:30:00Z')), {
    month: '2026-08', from: '2026-08-01', to: '2026-08-31', next: '2026-09-01',
    coverageRequiredThrough: '2026-08-17',
  });
  assert.equal(monthBounds('', new Date('2026-07-31T15:01:00Z')).month, '2026-08');
  assert.throws(() => monthBounds('2026-13'), error => error.code === 'MONTHLY_SETTLEMENT_MONTH_INVALID');
});

test('exact-name 정규화는 NFC·바깥/중복 공백만 보수적으로 통일한다', () => {
  assert.equal(normalizeExactName('  김  대호  '), '김 대호');
  assert.equal(normalizeExactName('\u1100\u1161'), '\uAC00');
  assert.notEqual(normalizeExactName('김대호'), normalizeExactName('김 대호'));
});

test('coverage 병합은 공백 없는 전 구간만 complete로 본다', () => {
  assert.deepEqual(coverageState([
    { covered_from: '2026-08-01', covered_to: '2026-08-10' },
    { covered_from: '2026-08-11', covered_to: '2026-08-17' },
  ], '2026-08-01', '2026-08-17'), {
    state: 'complete', from: '2026-08-01', to: '2026-08-17',
  });
  assert.equal(coverageState([
    { covered_from: '2026-08-01', covered_to: '2026-08-10' },
    { covered_from: '2026-08-12', covered_to: '2026-08-17' },
  ], '2026-08-01', '2026-08-17').state, 'partial');
  assert.equal(coverageState([], '2026-08-01', '2026-08-17').state, 'none');
});

test('self route는 승인된 direct 계정이면 settlements 권한 none이어도 자기 UID만 조회한다', async () => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, values });
      if (normalized.includes('peakos_intake')) {
        return { rows: [{ transaction_count: 4, sales: '170000', profit: '65000' }] };
      }
      if (normalized.includes('peakos_platform_connections')) {
        return { rows: [{
          provider: 'rewardspace', connection_state: 'ready',
          last_successful_import_at: '2026-08-17T02:00:00Z', last_error_code: null,
        }] };
      }
      if (normalized.includes('peakos_platform_import_runs run')) {
        return { rows: [{
          provider: 'rewardspace', covered_from: '2026-08-01', covered_to: '2026-08-17',
          completed_at: '2026-08-17T02:00:00Z',
        }] };
      }
      if (normalized.includes('SELECT users.uid, users.name') && normalized.includes('peakos_workspace_memberships')) {
        return { rows: [{ uid: 'uid-kim', name: '김대호' }] };
      }
      if (normalized.includes('FROM ranked')) {
        return { rows: [{
          provider: 'rewardspace', transaction_count: 2,
          missing_sales_count: 0, missing_profit_count: 0,
          observed_sales: '90000', observed_profit: '30000',
        }] };
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  };
  const res = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-08' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.provisional, true);
  assert.equal(res.payload.sourceAsOf, '2026-08-17T03:00:00.000Z');
  assert.match(res.payload.provisionalNotice, /잠정/);
  assert.deepEqual(res.payload.owner, { uid: 'uid-kim', name: '김대호' });
  assert.deepEqual(res.payload.personal, {
    sales: 170000,
    profit: 65000,
    transactionCount: 4,
    coverage: { state: 'complete', source: 'peakos_intake', attribution: 'authenticated_uid' },
  });
  assert.equal(res.payload.platforms.length, 5);
  assert.equal(res.payload.platforms[0].status, 'available');
  assert.equal(res.payload.platforms[0].sales, 90000);
  assert.equal(res.payload.platforms[0].coverage.attribution, 'latest_versioned_mapping');
  assert.equal(res.payload.platforms[0].coverage.eventOwnerSnapshot, 'import_audit_only');
  assert.equal(res.payload.platforms[1].status, 'not_connected');
  assert.equal(res.payload.platforms[1].sales, null);
  assert.equal(res.payload.platformTotal.sales, 90000);
  assert.equal(res.payload.platformTotal.transactionCount, 2);
  assert.equal(res.payload.platformTotal.complete, false);
  assert.match(res.payload.platformTotal.note, /더하지 않습니다/);
  const personalCall = calls.find(call => call.sql.includes('peakos_intake'));
  assert.deepEqual(personalCall.values, ['ws_peak', 'uid-kim', '2026-08-01', '2026-09-01', 'ws_peak']);
  assert.match(personalCall.sql, /kind <> 'reserve'/);
  assert.match(personalCall.sql, /CASE WHEN kind = 'refund' THEN -1 ELSE 1 END/);
  assert.doesNotMatch(personalCall.sql, /abs\s*\(/i);
  const platformCall = calls.find(call => call.sql.includes('FROM ranked')
    && call.sql.includes('business_date >= $3'));
  assert.deepEqual(platformCall.values, [
    'ws_peak', 'uid-kim', '2026-08-01', '2026-09-01', ['김대호'], ['uid-kim'],
  ]);
  assert.match(platformCall.sql, /peakos_platform_salesperson_mappings/);
  assert.match(platformCall.sql, /mapping\.owner_uid = \$2/);
  assert.match(platformCall.sql, /eligible_owner/);
  assert.doesNotMatch(platformCall.sql, /ranked\.owner_uid/);
  const issueCall = calls.find(call => call.sql.includes('attribution_issue_count')
    && call.sql.includes('business_date >= $3'));
  assert.deepEqual(issueCall.values, [
    'ws_peak', '김대호', '2026-08-01', '2026-09-01', ['김대호'], ['uid-kim'], 'uid-kim',
  ]);
  assert.match(issueCall.sql, /LEFT JOIN eligible_mapping/);
  assert.match(issueCall.sql, /mapping\.external_name_normalized IS NULL/);
  assert.match(issueCall.sql, /current_mapping\.owner_uid = \$7/);
  assert.match(issueCall.sql, /current_mapping\.match_method = 'exact_name'/);
  assert.match(platformCall.sql, /mapping\.match_method = 'manual_correction'/);
  assert.match(platformCall.sql, /LEFT JOIN unique_exact exact_mapping/);
});

test('platform metric 또는 월 coverage가 빠지면 부분합을 정식 금액으로 표시하지 않는다', async () => {
  const pool = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('peakos_intake')) {
        return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
      }
      if (normalized.includes('peakos_platform_connections')) {
        return { rows: [{ provider: 'reviewspace', connection_state: 'ready' }] };
      }
      if (normalized.includes('peakos_platform_import_runs run')) {
        return { rows: [{
          provider: 'reviewspace', covered_from: '2026-08-01', covered_to: '2026-08-10',
          completed_at: '2026-08-10T03:00:00Z',
        }] };
      }
      return { rows: [{
        provider: 'reviewspace', transaction_count: 3,
        missing_sales_count: 0, missing_profit_count: 1,
        observed_sales: '120000', observed_profit: '22000',
      }] };
    },
  };
  const res = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-08' }), res);
  const row = res.payload.platforms.find(platform => platform.key === 'reviewspace');
  assert.equal(row.dataState, 'partial');
  assert.equal(row.sales, null);
  assert.equal(row.profit, null);
  assert.equal(Object.hasOwn(row, 'observedSales'), false);
  assert.equal(Object.hasOwn(row, 'observedProfit'), false);
  assert.equal(row.missingProfitCount, 1);
});

test('완전히 수집된 월에 내 거래가 없으면 unavailable이 아니라 no_data와 0을 돌려준다', async () => {
  const pool = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('peakos_intake')) return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
      if (normalized.includes('peakos_platform_connections')) return { rows: [{ provider: 'keywordmaster', connection_state: 'ready' }] };
      if (normalized.includes('peakos_platform_import_runs run')) return { rows: [{
        provider: 'keywordmaster', covered_from: '2026-08-01', covered_to: '2026-08-31', completed_at: '2026-08-17T02:00:00Z',
      }] };
      return { rows: [] };
    },
  };
  const res = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-08' }), res);
  const row = res.payload.platforms.find(platform => platform.key === 'keywordmaster');
  assert.equal(row.dataState, 'no_data');
  assert.equal(row.sales, 0);
  assert.equal(row.profit, 0);
  assert.equal(row.transactionCount, 0);
});

test('내 exact 이름의 동명이인·미매핑 거래가 있으면 no_data 0원 대신 확인 필요로 둔다', async () => {
  const pool = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('peakos_intake')) return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
      if (normalized.includes('peakos_platform_connections')) return { rows: [{ provider: 'keywordmaster', connection_state: 'ready' }] };
      if (normalized.includes('peakos_platform_import_runs run')) return { rows: [{
        provider: 'keywordmaster', covered_from: '2026-08-01', covered_to: '2026-08-31', completed_at: '2026-08-17T02:00:00Z',
      }] };
      if (normalized.includes('attribution_issue_count')) return { rows: [{ provider: 'keywordmaster', attribution_issue_count: 2 }] };
      return { rows: [] };
    },
  };
  const res = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-08' }), res);
  const row = res.payload.platforms.find(platform => platform.key === 'keywordmaster');
  assert.equal(row.dataState, 'partial');
  assert.equal(row.attributionIssueCount, 2);
  assert.equal(row.sales, null);
  assert.equal(row.profit, null);
  assert.equal(row.transactionCount, null);
  assert.equal(res.payload.platformTotal.sales, null);

  const otherNamePool = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('peakos_intake')) return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
      if (normalized.includes('peakos_platform_connections')) return { rows: [{ provider: 'keywordmaster', connection_state: 'ready' }] };
      if (normalized.includes('peakos_platform_import_runs run')) return { rows: [{
        provider: 'keywordmaster', covered_from: '2026-08-01', covered_to: '2026-08-31', completed_at: '2026-08-17T02:00:00Z',
      }] };
      return { rows: [] };
    },
  };
  const otherRes = responseCapture();
  await captureRoute(otherNamePool)(selfRequest({ month: '2026-08' }), otherRes);
  const otherRow = otherRes.payload.platforms.find(platform => platform.key === 'keywordmaster');
  assert.equal(otherRow.dataState, 'no_data');
  assert.equal(otherRow.sales, 0);
});

test('read-time exact pin은 현재 eligible 후보가 단 한 UID일 때만 유효하다', async () => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, values });
      if (normalized.includes('SELECT users.uid, users.name')) return { rows: [
        { uid: 'uid-kim', name: '김대호' }, { uid: 'uid-other', name: '김대호' },
      ] };
      if (normalized.includes('peakos_intake')) return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
      if (normalized.includes('peakos_platform_connections')) return { rows: [{ provider: 'rewardspace', connection_state: 'ready' }] };
      if (normalized.includes('peakos_platform_import_runs run')) return { rows: [{
        provider: 'rewardspace', covered_from: '2026-08-01', covered_to: '2026-08-17', completed_at: '2026-08-17T02:00:00Z',
      }] };
      if (normalized.includes('attribution_issue_count')) return { rows: [{ provider: 'rewardspace', attribution_issue_count: 1 }] };
      return { rows: [] };
    },
  };
  const res = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-08' }), res);
  const metricsCall = calls.find(call => call.sql.includes('missing_sales_count')
    && call.sql.includes('FROM ranked'));
  assert.deepEqual(metricsCall.values.slice(4), [[], []]);
  const row = res.payload.platforms.find(platform => platform.key === 'rewardspace');
  assert.equal(row.dataState, 'partial');
  assert.equal(row.sales, null);
});

test('self 월 정산의 모든 원천은 같은 repeatable-read snapshot에서 읽는다', async () => {
  const calls = [];
  let released = false;
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      calls.push(normalized);
      if (normalized.startsWith('BEGIN TRANSACTION') || normalized === 'COMMIT') return { rows: [] };
      if (normalized.includes('peakos_intake')) return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
      return { rows: [] };
    },
    release() { released = true; },
  };
  const pool = {
    async query() { throw new Error('route must not use pool.query snapshots'); },
    async connect() { return client; },
  };
  const res = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-08' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(calls.at(-1), 'COMMIT');
  assert.equal(calls.filter(sql => sql.startsWith('SELECT') || sql.startsWith('WITH')).length, 10);
  assert.equal(released, true);
});

test('모든 플랫폼이 미연동이면 플랫폼 합계를 0원으로 위장하지 않고 null로 둔다', async () => {
  const pool = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('peakos_intake')) return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
      return { rows: [] };
    },
  };
  const res = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-08' }), res);
  assert.equal(res.payload.platformTotal.sales, null);
  assert.equal(res.payload.platformTotal.profit, null);
  assert.equal(res.payload.platformTotal.transactionCount, null);
  assert.equal(res.payload.platformTotal.complete, false);
});

test('legacy 수집 이력이 남아 있어도 disabled 연결은 과거 금액과 관측값을 노출하지 않는다', async () => {
  const pool = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('SELECT users.uid, users.name')) {
        return { rows: [{ uid: 'uid-kim', name: '김대호' }] };
      }
      if (normalized.includes('peakos_intake')) {
        return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
      }
      if (normalized.includes('peakos_platform_connections')) {
        return { rows: [{ provider: 'rewardspace', connection_state: 'disabled' }] };
      }
      if (normalized.includes('peakos_platform_import_runs run')) return { rows: [{
        provider: 'rewardspace', covered_from: '2026-08-01', covered_to: '2026-08-17',
        completed_at: '2026-08-17T02:00:00Z',
      }] };
      if (normalized.includes('FROM ranked') && normalized.includes('missing_sales_count')) {
        return { rows: [{
          provider: 'rewardspace', transaction_count: 2,
          missing_sales_count: 0, missing_profit_count: 0,
          observed_sales: '90000', observed_profit: '30000',
        }] };
      }
      return { rows: [] };
    },
  };
  const res = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-08' }), res);
  const reward = res.payload.platforms.find(row => row.key === 'rewardspace');
  assert.equal(reward.status, 'not_connected');
  assert.equal(reward.sales, null);
  assert.equal(reward.profit, null);
  assert.equal(reward.transactionCount, null);
  assert.equal(Object.hasOwn(reward, 'observedSales'), false);
  assert.equal(Object.hasOwn(reward, 'observedProfit'), false);
  assert.equal(Object.hasOwn(reward, 'observedTransactionCount'), false);
  assert.equal(res.payload.platformTotal.sales, null);
});

test('self read는 최신 aggregate snapshot 전체를 사용하고 이전 transaction event와 합산하지 않는다', async () => {
  const pool = {
    __aggregateAware: true,
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('SELECT users.uid, users.name')) {
        return { rows: [{ uid: 'uid-kim', name: '김대호' }] };
      }
      if (normalized.includes('peakos_intake')) {
        return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
      }
      if (normalized.includes('peakos_platform_connections')) {
        return { rows: [{ provider: 'rewardspace', connection_state: 'ready' }] };
      }
      if (normalized.includes('peakos_platform_import_runs run')) {
        return { rows: [{
          provider: 'rewardspace', covered_from: '2026-08-01', covered_to: '2026-08-17',
          completed_at: '2026-08-17T01:00:00Z',
        }] };
      }
      if (normalized.startsWith('SELECT DISTINCT ON (provider)')
          && normalized.includes('peakos_platform_aggregate_runs')) {
        return { rows: [{
          provider: 'rewardspace', id: '11111111-1111-4111-8111-111111111111',
          settlement_month: '2026-08', covered_from: '2026-08-01', covered_to: '2026-08-17',
          source_total_count: 10, row_count: 3, mapped_count: 3, ambiguous_count: 0,
          global_unmatched_count: 0, source_excluded_count: 7,
          source_state: 'paid', source_drift: '-50',
          observed_at: '2026-08-17T00:30:00Z', completed_at: '2026-08-17T02:00:00Z',
        }] };
      }
      if (normalized.includes('AS aggregate_run_count')
          && normalized.includes('peakos_platform_aggregate_quarantines')) {
        return { rows: [{
          provider: 'rewardspace', aggregate_run_count: 2, quarantined_run_count: 1,
        }] };
      }
      if (normalized.includes('missing_source_record_count')) {
        return { rows: [{
          provider: 'rewardspace', aggregate_row_count: 1,
          missing_sales_count: 0, missing_profit_count: 0, missing_source_record_count: 0,
          observed_sales: '90000', observed_profit: '30000', observed_source_record_count: '4',
          profit_basis_count: 1, profit_basis: 'reward_distributor_margin',
        }] };
      }
      if (normalized.includes('peakos_platform_aggregate_rows')
          && normalized.includes('attribution_issue_count')) return { rows: [] };
      if (normalized.includes('FROM ranked') && normalized.includes('missing_sales_count')) {
        return { rows: [{
          provider: 'rewardspace', transaction_count: 99,
          missing_sales_count: 0, missing_profit_count: 0,
          observed_sales: '999999', observed_profit: '888888',
        }] };
      }
      if (normalized.includes('FROM ranked') && normalized.includes('attribution_issue_count')) {
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  };
  const res = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-08' }), res);
  assert.equal(res.statusCode, 200);
  const reward = res.payload.platforms.find(row => row.key === 'rewardspace');
  assert.equal(reward.snapshotKind, 'monthly_aggregate');
  assert.equal(reward.rollbackApplied, true);
  assert.equal(reward.coverage.state, 'provisional');
  assert.equal(reward.sales, 90000);
  assert.equal(reward.profit, 30000);
  assert.equal(reward.transactionCount, 4);
  assert.equal(reward.sourceState, 'paid');
  assert.equal(reward.sourceChangedAfterSettlement, true);
  assert.equal(Object.hasOwn(reward, 'sourceDrift'), false);
  assert.equal(reward.profitBasis, 'reward_distributor_margin');
  assert.equal(Object.hasOwn(reward, 'sourceTotalCount'), false);
  assert.equal(Object.hasOwn(reward, 'globalUnmatchedCount'), false);
  assert.equal(Object.hasOwn(reward, 'sourceExcludedCount'), false);
  assert.equal(reward.coverage.eventOwnerSnapshot, 'aggregate_import_audit_only');
});

test('월 aggregate run이 모두 격리되면 legacy event 금액을 부활시키지 않고 fail-closed한다', async () => {
  const pool = {
    __aggregateAware: true,
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('SELECT users.uid, users.name')) {
        return { rows: [{ uid: 'uid-kim', name: '김대호' }] };
      }
      if (normalized.includes('peakos_intake')) {
        return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
      }
      if (normalized.includes('peakos_platform_connections')) {
        return { rows: [{ provider: 'rewardspace', connection_state: 'ready' }] };
      }
      if (normalized.startsWith('SELECT DISTINCT ON (provider)')
          && normalized.includes('peakos_platform_aggregate_runs')) {
        return { rows: [] };
      }
      if (normalized.includes('AS aggregate_run_count')
          && normalized.includes('peakos_platform_aggregate_quarantines')) {
        return { rows: [{
          provider: 'rewardspace', aggregate_run_count: 1, quarantined_run_count: 1,
        }] };
      }
      if (normalized.includes('peakos_platform_aggregate_rows')) return { rows: [] };
      if (normalized.includes('peakos_platform_import_runs run')) {
        return { rows: [{
          provider: 'rewardspace', covered_from: '2026-08-01', covered_to: '2026-08-17',
          completed_at: '2026-08-17T01:00:00Z',
        }] };
      }
      if (normalized.includes('FROM ranked') && normalized.includes('missing_sales_count')) {
        return { rows: [{
          provider: 'rewardspace', transaction_count: 99,
          missing_sales_count: 0, missing_profit_count: 0,
          observed_sales: '999999', observed_profit: '888888',
        }] };
      }
      if (normalized.includes('FROM ranked') && normalized.includes('attribution_issue_count')) {
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  };
  const res = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-08' }), res);
  assert.equal(res.statusCode, 200);
  const reward = res.payload.platforms.find(row => row.key === 'rewardspace');
  assert.equal(reward.snapshotKind, 'monthly_aggregate');
  assert.equal(reward.rollbackApplied, true);
  assert.equal(reward.status, 'not_covered');
  assert.equal(reward.dataState, 'not_covered');
  assert.equal(reward.coverage.state, 'none');
  assert.equal(reward.sales, null);
  assert.equal(reward.profit, null);
  assert.equal(reward.transactionCount, null);
  assert.equal(res.payload.platformTotal.sales, null);
});

test('현재 KST 월 complete coverage만 provisional이고 과거 월 complete/total은 유지한다', async () => {
  const providerIds = new Map(PLATFORM_PROVIDERS.map((provider, index) => [
    provider.key,
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  ]));
  const pool = {
    __aggregateAware: true,
    async query(sql, values) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('SELECT users.uid, users.name')) {
        return { rows: [{ uid: 'uid-kim', name: '김대호' }] };
      }
      if (normalized.includes('peakos_intake')) {
        return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
      }
      if (normalized.includes('peakos_platform_connections')) {
        return { rows: PLATFORM_PROVIDERS.map(provider => ({
          provider: provider.key, connection_state: 'ready',
        })) };
      }
      if (normalized.startsWith('SELECT DISTINCT ON (provider)')
          && normalized.includes('peakos_platform_aggregate_runs')) {
        const month = values[1];
        const current = month === '2026-08';
        return { rows: PLATFORM_PROVIDERS.map(provider => ({
          provider: provider.key,
          id: providerIds.get(provider.key),
          settlement_month: month,
          covered_from: `${month}-01`,
          covered_to: current ? '2026-08-17' : '2026-07-31',
          source_total_count: 1,
          row_count: 1,
          mapped_count: 1,
          ambiguous_count: 0,
          global_unmatched_count: 0,
          source_excluded_count: 0,
          source_state: provider.key === 'keywordmaster' ? 'unknown' : 'paid',
          source_drift: null,
          observed_at: current ? '2026-08-17T00:30:00Z' : '2026-08-01T00:30:00Z',
          completed_at: current ? '2026-08-17T02:00:00Z' : '2026-08-01T02:00:00Z',
        })) };
      }
      if (normalized.includes('AS aggregate_run_count')
          && normalized.includes('peakos_platform_aggregate_quarantines')) {
        return { rows: PLATFORM_PROVIDERS.map(provider => ({
          provider: provider.key, aggregate_run_count: 1, quarantined_run_count: 0,
        })) };
      }
      if (normalized.includes('missing_source_record_count')) {
        return { rows: PLATFORM_PROVIDERS.map(provider => ({
          provider: provider.key,
          aggregate_row_count: 1,
          missing_sales_count: 0,
          missing_profit_count: provider.key === 'keywordmaster' ? 1 : 0,
          missing_source_record_count: 0,
          observed_sales: '1000',
          observed_profit: provider.key === 'keywordmaster' ? '0' : '300',
          observed_source_record_count: '1',
          profit_basis_count: 1,
          profit_basis: provider.key === 'keywordmaster'
            ? 'unavailable' : `${provider.key}_documented_profit`,
        })) };
      }
      if (normalized.includes('peakos_platform_aggregate_rows')
          && normalized.includes('attribution_issue_count')) return { rows: [] };
      if (normalized.includes('peakos_platform_import_runs run')) return { rows: [] };
      if (normalized.includes('FROM ranked')) return { rows: [] };
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  };

  const currentRes = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-08' }), currentRes);
  assert.equal(currentRes.statusCode, 200);
  assert.ok(currentRes.payload.platforms.every(row => row.coverage.state === 'provisional'));
  assert.equal(currentRes.payload.platformTotal.complete, false);

  const pastRes = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-07' }), pastRes);
  assert.equal(pastRes.statusCode, 200);
  assert.ok(pastRes.payload.platforms.every(row => row.coverage.state === 'complete'));
  assert.equal(pastRes.payload.platformTotal.complete, true);
});

test('전사 미귀속 aggregate가 있으면 개인 0원으로 확정하거나 전사 건수를 노출하지 않는다', async () => {
  const pool = {
    __aggregateAware: true,
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('SELECT users.uid, users.name')) {
        return { rows: [{ uid: 'uid-kim', name: '김대호' }] };
      }
      if (normalized.includes('peakos_intake')) {
        return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
      }
      if (normalized.includes('peakos_platform_connections')) {
        return { rows: [{ provider: 'reviewspace', connection_state: 'ready' }] };
      }
      if (normalized.startsWith('SELECT DISTINCT ON (provider)')
          && normalized.includes('peakos_platform_aggregate_runs')) {
        return { rows: [{
          provider: 'reviewspace', id: '44444444-4444-4444-8444-444444444444',
          settlement_month: '2026-08', covered_from: '2026-08-01', covered_to: '2026-08-17',
          source_total_count: 1, row_count: 0, mapped_count: 0, ambiguous_count: 0,
          global_unmatched_count: 1, source_excluded_count: 0,
          source_state: 'live', source_drift: null,
          observed_at: '2026-08-17T00:30:00Z', completed_at: '2026-08-17T02:00:00Z',
        }] };
      }
      if (normalized.includes('peakos_platform_aggregate_')) return { rows: [] };
      if (normalized.includes('peakos_platform_import_runs run')) return { rows: [] };
      return { rows: [] };
    },
  };
  const res = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-08' }), res);
  const review = res.payload.platforms.find(row => row.key === 'reviewspace');
  assert.equal(review.dataState, 'partial');
  assert.equal(review.sales, null);
  assert.equal(review.profit, null);
  assert.equal(review.transactionCount, null);
  assert.equal(review.attributionIssueCount, 1);
  assert.equal(Object.hasOwn(review, 'sourceTotalCount'), false);
  assert.equal(Object.hasOwn(review, 'globalUnmatchedCount'), false);
  assert.equal(Object.hasOwn(review, 'sourceExcludedCount'), false);
  assert.equal(res.payload.platformTotal.sales, null);
});

test('키가 제거되어 disabled 된 연결은 과거 aggregate 금액을 다시 노출하지 않는다', async () => {
  const pool = {
    __aggregateAware: true,
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('SELECT users.uid, users.name')) {
        return { rows: [{ uid: 'uid-kim', name: '김대호' }] };
      }
      if (normalized.includes('peakos_intake')) {
        return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
      }
      if (normalized.includes('peakos_platform_connections')) {
        return { rows: [{ provider: 'rewardspace', connection_state: 'disabled' }] };
      }
      if (normalized.startsWith('SELECT DISTINCT ON (provider)')
          && normalized.includes('peakos_platform_aggregate_runs')) {
        return { rows: [{
          provider: 'rewardspace', id: '55555555-5555-4555-8555-555555555555',
          settlement_month: '2026-08', covered_from: '2026-08-01', covered_to: '2026-08-17',
          source_total_count: 1, row_count: 1, mapped_count: 1, ambiguous_count: 0,
          global_unmatched_count: 0, source_excluded_count: 0,
          source_state: 'paid', source_drift: 0,
          observed_at: '2026-08-17T00:30:00Z', completed_at: '2026-08-17T02:00:00Z',
        }] };
      }
      if (normalized.includes('missing_source_record_count')) return { rows: [{
        provider: 'rewardspace', aggregate_row_count: 1,
        missing_sales_count: 0, missing_profit_count: 0, missing_source_record_count: 0,
        observed_sales: '90000', observed_profit: '30000', observed_source_record_count: '4',
        profit_basis_count: 1, profit_basis: 'reward_distributor_margin',
      }] };
      if (normalized.includes('peakos_platform_aggregate_')) return { rows: [] };
      if (normalized.includes('peakos_platform_import_runs run')) return { rows: [] };
      return { rows: [] };
    },
  };
  const res = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-08' }), res);
  const reward = res.payload.platforms.find(row => row.key === 'rewardspace');
  assert.equal(reward.status, 'not_connected');
  assert.equal(reward.dataState, 'not_connected');
  assert.equal(reward.sales, null);
  assert.equal(reward.profit, null);
  assert.equal(reward.transactionCount, null);
  assert.equal(Object.hasOwn(reward, 'observedSales'), false);
  assert.equal(Object.hasOwn(reward, 'observedProfit'), false);
  assert.equal(Object.hasOwn(reward, 'observedTransactionCount'), false);
  assert.equal(Object.hasOwn(reward, 'sourceDrift'), false);
  assert.equal(res.payload.platformTotal.sales, null);
});

test('빈 aggregate snapshot도 구형 event fallback 대신 no_data 0으로 확정한다', async () => {
  const pool = {
    __aggregateAware: true,
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('SELECT users.uid, users.name')) {
        return { rows: [{ uid: 'uid-kim', name: '김대호' }] };
      }
      if (normalized.includes('peakos_intake')) {
        return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
      }
      if (normalized.includes('peakos_platform_connections')) {
        return { rows: [{ provider: 'reviewspace', connection_state: 'ready' }] };
      }
      if (normalized.startsWith('SELECT DISTINCT ON (provider)')
          && normalized.includes('peakos_platform_aggregate_runs')) {
        return { rows: [{
          provider: 'reviewspace', id: '22222222-2222-4222-8222-222222222222',
          settlement_month: '2026-08', covered_from: '2026-08-01', covered_to: '2026-08-17',
          source_total_count: 0, row_count: 0, mapped_count: 0, ambiguous_count: 0,
          global_unmatched_count: 0, source_excluded_count: 0,
          source_state: 'live', source_drift: null,
          observed_at: '2026-08-17T00:30:00Z', completed_at: '2026-08-17T02:00:00Z',
        }] };
      }
      if (normalized.includes('peakos_platform_aggregate_')) return { rows: [] };
      if (normalized.includes('peakos_platform_import_runs run')) return { rows: [] };
      if (normalized.includes('FROM ranked') && normalized.includes('missing_sales_count')) {
        return { rows: [{
          provider: 'reviewspace', transaction_count: 1,
          missing_sales_count: 0, missing_profit_count: 0,
          observed_sales: '999999', observed_profit: '888888',
        }] };
      }
      return { rows: [] };
    },
  };
  const res = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-08' }), res);
  const review = res.payload.platforms.find(row => row.key === 'reviewspace');
  assert.equal(review.snapshotKind, 'monthly_aggregate');
  assert.equal(review.dataState, 'no_data');
  assert.equal(review.sales, 0);
  assert.equal(review.profit, 0);
  assert.equal(review.transactionCount, 0);
});

test('키워드 aggregate는 매출을 보여도 profit은 null이고 불완전 count는 합산하지 않는다', async () => {
  const pool = {
    __aggregateAware: true,
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('SELECT users.uid, users.name')) {
        return { rows: [{ uid: 'uid-kim', name: '김대호' }] };
      }
      if (normalized.includes('peakos_intake')) {
        return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
      }
      if (normalized.includes('peakos_platform_connections')) {
        return { rows: [{ provider: 'keywordmaster', connection_state: 'ready' }] };
      }
      if (normalized.startsWith('SELECT DISTINCT ON (provider)')
          && normalized.includes('peakos_platform_aggregate_runs')) {
        return { rows: [{
          provider: 'keywordmaster', id: '33333333-3333-4333-8333-333333333333',
          settlement_month: '2026-08', covered_from: '2026-08-01', covered_to: '2026-08-17',
          source_total_count: 1, row_count: 1, mapped_count: 1, ambiguous_count: 0,
          global_unmatched_count: 0, source_excluded_count: 0,
          source_state: 'draft', source_drift: null,
          observed_at: '2026-08-17T00:30:00Z', completed_at: '2026-08-17T02:00:00Z',
        }] };
      }
      if (normalized.includes('missing_source_record_count')) return { rows: [{
        provider: 'keywordmaster', aggregate_row_count: 1,
        missing_sales_count: 0, missing_profit_count: 1, missing_source_record_count: 1,
        observed_sales: '120000', observed_profit: '0', observed_source_record_count: '0',
        profit_basis_count: 1, profit_basis: 'unavailable',
      }] };
      if (normalized.includes('peakos_platform_aggregate_')) return { rows: [] };
      return { rows: [] };
    },
  };
  const res = responseCapture();
  await captureRoute(pool)(selfRequest({ month: '2026-08' }), res);
  const keyword = res.payload.platforms.find(row => row.key === 'keywordmaster');
  assert.equal(keyword.dataState, 'available');
  assert.equal(keyword.sales, 120000);
  assert.equal(keyword.profit, null);
  assert.equal(Object.hasOwn(keyword, 'observedProfit'), false);
  assert.equal(keyword.transactionCount, null);
  assert.equal(keyword.profitBasis, 'unavailable');
  assert.equal(keyword.sourceState, 'draft');
});

test('owner/scope/preview override와 oversight는 DB 조회 전에 fail-closed한다', async () => {
  let queryCount = 0;
  const handler = captureRoute({ async query() { queryCount += 1; return { rows: [] }; } });
  for (const request of [
    selfRequest({ month: '2026-08', ownerUid: 'other' }),
    selfRequest({ month: '2026-08', scope: 'all' }),
    selfRequest({ month: '2026-08' }, { headers: { 'x-peakos-preview-persona': 'other' } }),
    selfRequest({ month: '2026-08' }, { workspace: { id: 'ws_daegu', role: 'oversight', headquartersOversight: true } }),
    selfRequest({ month: '2026-08' }, { userDoc: { approved: true, is_active: true, chat_only: true } }),
    selfRequest({ month: '2026-08' }, { userDoc: { approved: true, is_active: true, external_calendar_only: true } }),
    selfRequest({ month: '2026-08' }, { workspace: { id: 'ws_peak', headquartersOversight: false } }),
    selfRequest({ month: '2026-08' }, { workspace: { id: 'ws_peak', role: 'custom', headquartersOversight: false } }),
  ]) {
    const res = responseCapture();
    await handler(request, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'MONTHLY_SETTLEMENT_SELF_FORBIDDEN');
  }
  assert.equal(queryCount, 0);
});

test('지사 direct 계정 경로는 migrated allowlist를 통과하고 선택 workspace로만 조회한다', async () => {
  assert.match(INDEX_SOURCE, /\^\\\/monthly-settlement\(\?:\\\/\|\$\)\//);
  const calls = [];
  const pool = { async query(sql, values) {
    calls.push({ sql: String(sql), values });
    if (String(sql).includes('peakos_intake')) return { rows: [{ transaction_count: 0, sales: '0', profit: '0' }] };
    return { rows: [] };
  } };
  const req = selfRequest({ month: '2026-08' }, {
    workspace: { id: 'ws_daegu', role: 'member', headquartersOversight: false, permissions: {} },
  });
  const res = responseCapture();
  await captureRoute(pool)(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(calls.every(call => !call.values?.length || call.values[0] === 'ws_daegu'));
});

function importerPool(queryHandler, {
  activeWorkspace = true,
  previousActiveIds = [],
  previousActiveRows = previousActiveIds.map(external_transaction_id => ({
    external_transaction_id,
    source_updated_at: '2026-08-16T01:00:00Z',
  })),
} = {}) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, values });
      if (normalized.startsWith('SELECT id FROM public.peakos_workspaces')) {
        return { rows: activeWorkspace ? [{ id: values[0] }] : [] };
      }
      if (normalized.includes('SELECT external_transaction_id, source_updated_at')
          && normalized.includes('FROM ranked')) {
        return { rows: previousActiveRows };
      }
      return queryHandler(normalized, values, calls);
    },
    release() { calls.push({ sql: 'RELEASE', values: [] }); },
  };
  return { pool: { async connect() { return client; } }, calls };
}

function importArgs(overrides = {}) {
  const args = {
    workspaceId: 'ws_peak',
    provider: 'rewardspace',
    idempotencyKey: 'rewardspace:2026-08:p1',
    adapterVersion: 'rewardspace:v1',
    coveredFrom: '2026-08-01',
    coveredTo: '2026-08-17',
    actor: { uid: 'system:rewardspace', name: '리워드스페이스 수집기' },
    now: new Date('2026-08-17T03:00:00Z'),
    transactions: [],
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, 'snapshotComplete')) args.snapshotComplete = true;
  if (!Object.prototype.hasOwnProperty.call(overrides, 'sourceTotalCount')) {
    args.sourceTotalCount = args.transactions.length;
  }
  return args;
}

function aggregateImportArgs(overrides = {}) {
  const args = {
    workspaceId: 'ws_peak',
    provider: 'rewardspace',
    month: '2026-08',
    coveredFrom: '2026-08-01',
    coveredTo: '2026-08-17',
    sourceTotalCount: 2,
    globalUnmatchedCount: 1,
    rows: [{
      externalRowKey: 'reward:user:kim',
      externalSalespersonName: '김대호',
      salesAmount: 90000,
      profitAmount: 30000,
      profitBasis: 'reward_distributor_margin',
      sourceRecordCount: 1,
    }],
    attributionIssues: [],
    sourceState: 'paid',
    sourceDrift: -100,
    idempotencyKey: 'rewardspace:2026-08:aggregate:1',
    adapterVersion: 'rewardspace-aggregate:v1',
    actor: { uid: 'system:rewardspace', name: '리워드스페이스 수집기' },
    observedAt: '2026-08-17T02:00:00+09:00',
    now: new Date('2026-08-17T03:00:00Z'),
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, 'sourceDigest')) {
    args.sourceDigest = calculatePlatformMonthlyAggregateDigest(args);
  }
  return args;
}

test('aggregate digest는 행 순서와 무관하고 월·coverage·상태·금액 변경을 구분한다', () => {
  const base = aggregateImportArgs({ sourceDigest: undefined, globalUnmatchedCount: 0, sourceTotalCount: 2, rows: [
    {
      externalRowKey: 'row:b', externalSalespersonName: '박영업', salesAmount: 200,
      profitAmount: 20, profitBasis: 'reward_distributor_margin', sourceRecordCount: 1,
    },
    {
      externalRowKey: 'row:a', externalSalespersonName: '김대호', salesAmount: 100,
      profitAmount: 10, profitBasis: 'reward_distributor_margin', sourceRecordCount: 1,
    },
  ] });
  const reversed = { ...base, rows: [...base.rows].reverse() };
  assert.equal(
    calculatePlatformMonthlyAggregateDigest(base),
    calculatePlatformMonthlyAggregateDigest(reversed),
  );
  assert.notEqual(
    calculatePlatformMonthlyAggregateDigest(base),
    calculatePlatformMonthlyAggregateDigest({ ...base, sourceState: 'draft' }),
  );
});

test('월별 aggregate importer는 exact-name 행과 모호 이슈를 한 immutable run으로 저장한다', async () => {
  const headerInserts = [];
  const rowInserts = [];
  const { pool, calls } = importerPool((sql, values) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('peakos_platform_aggregate_runs') && sql.includes('idempotency_key = $3')) return { rows: [] };
    if (sql.includes('peakos_platform_aggregate_runs') && sql.includes('source_digest = $4')) return { rows: [] };
    if (sql.includes('peakos_platform_salesperson_mappings') && sql.includes('DISTINCT ON')) return { rows: [] };
    if (sql.includes('peakos_workspace_memberships')) return { rows: [{ uid: 'uid-kim', name: '김대호' }] };
    if (sql.startsWith('INSERT INTO public.peakos_platform_salesperson_mappings')) {
      return { rows: [{
        owner_uid: 'uid-kim', owner_name_snapshot: '김대호',
        mapping_state: 'active', match_method: 'exact_name',
      }] };
    }
    if (sql.startsWith('INSERT INTO public.peakos_platform_aggregate_runs')) {
      headerInserts.push(values);
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO public.peakos_platform_aggregate_rows')) {
      rowInserts.push({ sql, values });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const result = await importPlatformMonthlyAggregateSnapshot(aggregateImportArgs({
    pool,
    sourceTotalCount: 4,
    globalUnmatchedCount: 2,
    attributionIssues: [{ externalRowKey: 'ambiguous:lee', externalSalespersonName: '이영업' }],
  }));

  assert.equal(result.duplicate, false);
  assert.equal(result.rowCount, 2);
  assert.equal(result.mappedCount, 1);
  assert.equal(result.ambiguousCount, 1);
  assert.equal(result.globalUnmatchedCount, 2);
  assert.equal(result.sourceState, 'paid');
  assert.equal(result.sourceDrift, -100);
  assert.deepEqual(headerInserts[0].slice(9, 16), [4, 2, 1, 1, 2, 'paid', '-100']);
  assert.equal(rowInserts.length, 2);
  assert.match(rowInserts[0].sql, /'mapped'/);
  assert.equal(rowInserts[0].values[7], 'uid-kim');
  assert.match(rowInserts[1].sql, /'ambiguous'/);
  assert.deepEqual(rowInserts[1].values.slice(7), [
    'EXACT_NAME_AMBIGUOUS',
    '동명이인 또는 원본 식별자 모호성으로 자동 귀속하지 않았습니다.',
  ]);
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
});

test('사전 귀속 행은 현재 유일한 exact-name UID와 일치할 때만 허용한다', async () => {
  function preassignedPool() {
    return importerPool((sql, values) => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
      if (sql.includes('peakos_platform_aggregate_runs')) return { rows: [] };
      if (sql.includes('peakos_platform_salesperson_mappings') && sql.includes('DISTINCT ON')) {
        return { rows: [{
          external_name_normalized: '김대호', mapping_state: 'active', match_method: 'exact_name',
          owner_uid: 'uid-kim', owner_name_snapshot: '김대호',
        }] };
      }
      if (sql.includes('peakos_workspace_memberships')) {
        return { rows: [{ uid: 'uid-kim', name: '김대호' }] };
      }
      if (sql.startsWith('INSERT INTO public.peakos_platform_aggregate_')) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
  }
  const assignedRow = {
    ...aggregateImportArgs().rows[0],
    attributionStatus: 'mapped', ownerUid: 'uid-kim', ownerNameSnapshot: '김대호',
  };
  const accepted = preassignedPool();
  const result = await importPlatformMonthlyAggregateSnapshot(aggregateImportArgs({
    pool: accepted.pool,
    rows: [assignedRow],
  }));
  assert.equal(result.duplicate, false);

  const conflicting = preassignedPool();
  await assert.rejects(importPlatformMonthlyAggregateSnapshot(aggregateImportArgs({
    pool: conflicting.pool,
    idempotencyKey: 'rewardspace:2026-08:aggregate:preassigned-conflict',
    rows: [{ ...assignedRow, ownerUid: 'uid-other', ownerNameSnapshot: '다른 계정' }],
  })), error => error.code === 'PLATFORM_AGGREGATE_PREASSIGNMENT_CONFLICT');
  assert.equal(conflicting.calls.some(call => call.sql.startsWith(
    'INSERT INTO public.peakos_platform_aggregate_runs',
  )), false);
});

test('동일 aggregate 원본은 새 idempotency key여도 duplicate이고 새 행을 만들지 않는다', async () => {
  const args = aggregateImportArgs();
  const { pool, calls } = importerPool((sql, values) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('idempotency_key = $3')) return { rows: [] };
    if (sql.includes('source_digest = $4')) return { rows: [{
      id: '11111111-1111-4111-8111-111111111111',
      settlement_month: '2026-08', covered_from: '2026-08-01', covered_to: '2026-08-17',
      source_digest: values[3], adapter_version: 'rewardspace-aggregate:v1',
      source_total_count: 2, row_count: 1, mapped_count: 1, ambiguous_count: 0,
      global_unmatched_count: 1, source_excluded_count: 0,
      source_state: 'paid', source_drift: '-100',
    }] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const result = await importPlatformMonthlyAggregateSnapshot({ ...args, pool });
  assert.equal(result.duplicate, true);
  assert.equal(result.runId, '11111111-1111-4111-8111-111111111111');
  assert.equal(calls.some(call => call.sql.startsWith('INSERT INTO')), false);
});

test('aggregate 일반 행이 exact-name으로 유일하게 귀속되지 않으면 전체 run을 rollback한다', async () => {
  const { pool, calls } = importerPool(sql => {
    if (['BEGIN', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('peakos_platform_aggregate_runs')) return { rows: [] };
    if (sql.includes('peakos_platform_salesperson_mappings') && sql.includes('DISTINCT ON')) return { rows: [] };
    if (sql.includes('peakos_workspace_memberships')) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  await assert.rejects(
    importPlatformMonthlyAggregateSnapshot(aggregateImportArgs({ pool })),
    error => error.code === 'PLATFORM_AGGREGATE_ATTRIBUTION_UNRESOLVED',
  );
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(calls.some(call => call.sql.startsWith('INSERT INTO public.peakos_platform_aggregate_runs')), false);
});

test('키워드마스터 aggregate에는 커미션을 영업이익으로 저장할 수 없다', () => {
  assert.throws(() => aggregateImportArgs({
    provider: 'keywordmaster',
    rows: [{
      externalRowKey: 'keyword:kim', externalSalespersonName: '김대호', salesAmount: 1000,
      profitAmount: 100, profitBasis: 'review_spread_profit', sourceRecordCount: 1,
    }],
  }), error => error.code === 'PLATFORM_AGGREGATE_INVALID');
});

test('operator quarantine는 importer와 같은 월 lock 아래 latest run CAS 후 audit만 append한다', async () => {
  const runId = '11111111-1111-4111-8111-111111111111';
  const reason = '공급처 원본 총액 대사 불일치 확인';
  const { pool, calls } = importerPool((sql, values) => {
    if (['BEGIN', 'COMMIT'].includes(sql) || sql.startsWith('SELECT pg_advisory_xact_lock')) {
      return { rows: [] };
    }
    if (sql.includes('FROM public.peakos_platform_aggregate_quarantines quarantine')
        && sql.includes('operation_key = $3')) return { rows: [] };
    if (sql.startsWith('SELECT id, settlement_month')
        && sql.includes('peakos_platform_aggregate_runs')) {
      return { rows: [{ id: runId, settlement_month: '2026-08' }] };
    }
    if (sql.startsWith('SELECT aggregate_run.id')) return { rows: [{ id: runId }] };
    if (sql.startsWith('INSERT INTO public.peakos_platform_aggregate_quarantines')) {
      assert.deepEqual(values.slice(0, 2), ['ws_peak', 'rewardspace']);
      assert.equal(values[3], runId);
      assert.equal(values[4], 'ops:ticket-20260818-1');
      assert.equal(values[5], runId);
      assert.equal(values[6], reason);
      assert.deepEqual(values.slice(7), ['operator-uid', '재무 운영자']);
      return { rows: [{ created_at: '2026-08-18T05:00:00.000Z' }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });

  const result = await quarantinePlatformMonthlyAggregateRun({
    pool,
    workspaceId: 'ws_peak',
    provider: 'rewardspace',
    month: '2026-08',
    runId,
    expectedLatestRunId: runId,
    operationKey: 'ops:ticket-20260818-1',
    reason,
    actor: { uid: 'operator-uid', name: '재무 운영자' },
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.runId, runId);
  assert.ok(calls.some(call => call.sql.startsWith('SELECT pg_advisory_xact_lock')
    && call.values[0] === 'peakos-platform-aggregate-v1:ws_peak:rewardspace:2026-08'));
  assert.equal(calls.filter(call => call.sql.startsWith('INSERT INTO')).length, 1);
  assert.equal(calls.some(call => /^(UPDATE|DELETE|TRUNCATE)\b/.test(call.sql)), false);
});

test('operator quarantine는 최신 run CAS가 바뀌면 rollback하고 쓰지 않는다', async () => {
  const targetRunId = '11111111-1111-4111-8111-111111111111';
  const currentRunId = '22222222-2222-4222-8222-222222222222';
  const { pool, calls } = importerPool(sql => {
    if (['BEGIN', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory_xact_lock')) {
      return { rows: [] };
    }
    if (sql.includes('operation_key = $3')) return { rows: [] };
    if (sql.startsWith('SELECT id, settlement_month')) {
      return { rows: [{ id: targetRunId, settlement_month: '2026-08' }] };
    }
    if (sql.startsWith('SELECT aggregate_run.id')) return { rows: [{ id: currentRunId }] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  await assert.rejects(quarantinePlatformMonthlyAggregateRun({
    pool,
    workspaceId: 'ws_peak',
    provider: 'rewardspace',
    month: '2026-08',
    runId: targetRunId,
    expectedLatestRunId: targetRunId,
    operationKey: 'ops:ticket-20260818-cas',
    reason: '새 수집 발생 여부를 확인하는 격리 요청',
    actor: { uid: 'operator-uid', name: '재무 운영자' },
  }), error => error.code === 'PLATFORM_AGGREGATE_QUARANTINE_LATEST_CHANGED'
    && error.statusCode === 409);
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(calls.some(call => call.sql.startsWith('INSERT INTO')), false);
});

test('operator quarantine operation replay는 같은 감사값에만 idempotent하다', async () => {
  const runId = '11111111-1111-4111-8111-111111111111';
  const reason = '공급처 원본 총액 대사 불일치 확인';
  const replayRow = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    aggregate_run_id: runId,
    expected_latest_run_id: runId,
    operation_key: 'ops:ticket-replay',
    reason,
    actor_uid: 'operator-uid',
    actor_name_snapshot: '재무 운영자',
    created_at: '2026-08-18T05:00:00.000Z',
    settlement_month: '2026-08',
  };
  const { pool, calls } = importerPool(sql => {
    if (['BEGIN', 'COMMIT'].includes(sql) || sql.startsWith('SELECT pg_advisory_xact_lock')) {
      return { rows: [] };
    }
    if (sql.includes('operation_key = $3')) return { rows: [replayRow] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const duplicate = await quarantinePlatformMonthlyAggregateRun({
    pool,
    workspaceId: 'ws_peak', provider: 'rewardspace', month: '2026-08',
    runId, expectedLatestRunId: runId, operationKey: 'ops:ticket-replay', reason,
    actor: { uid: 'operator-uid', name: '재무 운영자' },
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls.some(call => call.sql.startsWith('INSERT INTO')), false);

  const conflictPool = importerPool(sql => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql.startsWith('SELECT pg_advisory_xact_lock')) {
      return { rows: [] };
    }
    if (sql.includes('operation_key = $3')) return { rows: [replayRow] };
    throw new Error(`unexpected SQL: ${sql}`);
  }).pool;
  await assert.rejects(quarantinePlatformMonthlyAggregateRun({
    pool: conflictPool,
    workspaceId: 'ws_peak', provider: 'rewardspace', month: '2026-08',
    runId, expectedLatestRunId: runId, operationKey: 'ops:ticket-replay',
    reason: '같은 키에 다른 격리 사유를 넣은 요청',
    actor: { uid: 'operator-uid', name: '재무 운영자' },
  }), error => error.code === 'PLATFORM_AGGREGATE_QUARANTINE_IDEMPOTENCY_CONFLICT');
});

test('quarantine inspect는 read-only snapshot에서 금액 없이 최신 eligible run만 반환한다', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      calls.push(normalized);
      if (normalized.startsWith('BEGIN TRANSACTION')) return { rows: [] };
      if (normalized.startsWith('SELECT id FROM public.peakos_workspaces')) {
        return { rows: [{ id: 'ws_peak' }] };
      }
      if (normalized.includes('AS aggregate_run_count')) {
        return { rows: [{ aggregate_run_count: 2, quarantined_run_count: 1 }] };
      }
      if (normalized.startsWith('SELECT aggregate_run.id')) return { rows: [{
        id: '11111111-1111-4111-8111-111111111111',
        covered_from: '2026-08-01', covered_to: '2026-08-17', source_state: 'paid',
        observed_at: '2026-08-17T01:00:00Z', completed_at: '2026-08-17T02:00:00Z',
      }] };
      if (normalized === 'COMMIT') return { rows: [] };
      throw new Error(`unexpected SQL: ${normalized}`);
    },
    release() {},
  };
  const inspected = await inspectLatestPlatformMonthlyAggregateRun({
    pool: { async connect() { return client; } },
    workspaceId: 'ws_peak', provider: 'rewardspace', month: '2026-08',
  });
  assert.equal(inspected.latestEligibleRun.runId, '11111111-1111-4111-8111-111111111111');
  assert.equal(inspected.quarantinedRunCount, 1);
  assert.equal(Object.hasOwn(inspected.latestEligibleRun, 'sales'), false);
  assert.equal(calls[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(calls.some(sql => /\b(sales_amount|profit_amount)\b/.test(sql)), false);
});

test('importer는 정확히 한 direct 활성 계정과 일치한 이름만 UID에 고정한다', async () => {
  const insertedEvents = [];
  const { pool, calls } = importerPool((sql, values) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('peakos_platform_import_runs') && sql.includes('idempotency_key')) return { rows: [] };
    if (sql.includes('peakos_platform_transaction_events') && sql.includes('external_transaction_id = ANY')) return { rows: [] };
    if (sql.includes('peakos_platform_salesperson_mappings') && sql.includes('DISTINCT ON')) return { rows: [] };
    if (sql.includes('peakos_workspace_memberships')) return { rows: [
      { uid: 'uid-kim', name: '김대호' },
      { uid: 'uid-same-1', name: '동명이인' },
      { uid: 'uid-same-2', name: '동명이인' },
    ] };
    if (sql.startsWith('INSERT INTO public.peakos_platform_salesperson_mappings')) {
      assert.match(values[3], /^auto:[0-9a-f]{64}$/);
      assert.equal(values[4], '김대호');
      return { rows: [{
        owner_uid: 'uid-kim', owner_name_snapshot: '김대호',
        mapping_state: 'active', match_method: 'exact_name',
      }] };
    }
    if (sql.includes('SELECT event_fingerprint') && sql.includes('event_fingerprint = ANY')) return { rows: [] };
    if (sql.startsWith('INSERT INTO public.peakos_platform_import_runs')) return { rows: [] };
    if (sql.startsWith('INSERT INTO public.peakos_platform_transaction_events')) {
      insertedEvents.push(values);
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const result = await importPlatformTransactionBatch(importArgs({
    pool,
    transactions: [
      { externalTransactionId: 'a', sourceUpdatedAt: '2026-08-10T01:00:00Z', businessDate: '2026-08-10', externalSalespersonName: '김대호', salesAmount: 1000, profitAmount: 300 },
      { externalTransactionId: 'b', sourceUpdatedAt: '2026-08-10T01:00:00Z', businessDate: '2026-08-10', externalSalespersonName: '동명이인', salesAmount: 2000, profitAmount: null },
      { externalTransactionId: 'c', sourceUpdatedAt: '2026-08-10T01:00:00Z', businessDate: '2026-08-10', externalSalespersonName: '없는 사람', salesAmount: null, profitAmount: null },
    ],
  }));
  assert.deepEqual({
    requestedCount: result.requestedCount,
    insertedCount: result.insertedCount,
    mappedCount: result.mappedCount,
    unmappedCount: result.unmappedCount,
    ambiguousCount: result.ambiguousCount,
  }, { requestedCount: 3, insertedCount: 3, mappedCount: 1, unmappedCount: 1, ambiguousCount: 1 });
  assert.equal(insertedEvents.length, 3);
  const mapped = insertedEvents.find(values => values[4] === 'a');
  const ambiguous = insertedEvents.find(values => values[4] === 'b');
  const unmapped = insertedEvents.find(values => values[4] === 'c');
  assert.deepEqual(mapped.slice(10, 13), ['mapped', 'uid-kim', '김대호']);
  assert.deepEqual(ambiguous.slice(10, 13), ['ambiguous', null, null]);
  assert.deepEqual(unmapped.slice(10, 13), ['unmapped', null, null]);
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
});

test('같은 멱등성 키 재시도는 원본·coverage가 같을 때 쓰기 없이 기존 run을 반환한다', async () => {
  const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const { pool, calls } = importerPool(sql => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('peakos_platform_import_runs') && sql.includes('idempotency_key')) return { rows: [{
      id: '11111111-1111-1111-1111-111111111111', source_digest: digest,
      adapter_version: 'rewardspace:v1',
      source_total_count: 0, snapshot_complete: true,
      requested_count: 0, inserted_count: 0, mapped_count: 0, unmapped_count: 0, ambiguous_count: 0,
      covered_from: '2026-08-01', covered_to: '2026-08-17', completed_at: '2026-08-17T03:00:00Z',
    }] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const result = await importPlatformTransactionBatch(importArgs({ pool, sourceDigest: digest }));
  assert.equal(result.duplicate, true);
  assert.equal(calls.some(call => call.sql.startsWith('INSERT INTO')), false);
});

test('페이지 일부나 원본 건수가 맞지 않는 batch는 completed coverage로 기록하지 않는다', async () => {
  let connectCount = 0;
  const pool = { async connect() { connectCount += 1; throw new Error('should not connect'); } };
  await assert.rejects(importPlatformTransactionBatch(importArgs({
    pool, snapshotComplete: false,
  })), error => error.code === 'PLATFORM_IMPORT_SNAPSHOT_INCOMPLETE');
  await assert.rejects(importPlatformTransactionBatch(importArgs({
    pool, transactions: [], sourceTotalCount: 1,
  })), error => error.code === 'PLATFORM_IMPORT_SOURCE_COUNT_MISMATCH');
  const duplicateRow = {
    externalTransactionId: 'duplicate-source', sourceUpdatedAt: '2026-08-10T01:00:00Z',
    businessDate: '2026-08-10', externalSalespersonName: '김대호', salesAmount: 1000, profitAmount: 300,
  };
  await assert.rejects(importPlatformTransactionBatch(importArgs({
    pool, transactions: [duplicateRow, { ...duplicateRow }],
  })), error => error.code === 'PLATFORM_IMPORT_DUPLICATE_SOURCE_ROWS');
  assert.equal(connectCount, 0);
});

test('full snapshot에서 기존 active ID가 사라지면 explicit void 없이는 완료하지 않는다', async () => {
  const missing = importerPool(sql => {
    if (['BEGIN', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('peakos_platform_import_runs') && sql.includes('idempotency_key')) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  }, { previousActiveIds: ['must-be-voided'] });
  await assert.rejects(importPlatformTransactionBatch(importArgs({ pool: missing.pool })),
    error => error.code === 'PLATFORM_IMPORT_MISSING_TOMBSTONE' && error.statusCode === 409);
  assert.ok(missing.calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(missing.calls.some(call => call.sql.startsWith('INSERT INTO')), false);

  const inserted = [];
  const accepted = importerPool((sql, values) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('peakos_platform_import_runs') && sql.includes('idempotency_key')) return { rows: [] };
    if (sql.includes('peakos_platform_transaction_events') && sql.includes('external_transaction_id = ANY')) return { rows: [] };
    if (sql.includes('peakos_platform_salesperson_mappings') && sql.includes('DISTINCT ON')) return { rows: [] };
    if (sql.includes('peakos_workspace_memberships')) return { rows: [] };
    if (sql.includes('SELECT event_fingerprint') && sql.includes('event_fingerprint = ANY')) return { rows: [] };
    if (sql.startsWith('INSERT INTO public.peakos_platform_import_runs')) return { rows: [] };
    if (sql.startsWith('INSERT INTO public.peakos_platform_transaction_events')) {
      inserted.push(values);
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }, { previousActiveIds: ['must-be-voided'] });
  const result = await importPlatformTransactionBatch(importArgs({
    pool: accepted.pool,
    transactions: [{
      externalTransactionId: 'must-be-voided', sourceUpdatedAt: '2026-08-17T01:00:00Z',
      businessDate: '2026-08-10', externalSalespersonName: '김대호',
      recordState: 'voided', salesAmount: 999, profitAmount: 999,
    }],
  }));
  assert.equal(result.insertedCount, 1);
  assert.deepEqual(inserted[0].slice(13, 16), ['voided', null, null]);

  const staleVoid = importerPool((sql) => {
    if (['BEGIN', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('peakos_platform_import_runs') && sql.includes('idempotency_key')) return { rows: [] };
    if (sql.includes('peakos_platform_transaction_events') && sql.includes('external_transaction_id = ANY')) {
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }, {
    previousActiveRows: [{
      external_transaction_id: 'must-be-voided',
      source_updated_at: '2026-08-18T01:00:00Z',
    }],
  });
  await assert.rejects(importPlatformTransactionBatch(importArgs({
    pool: staleVoid.pool,
    transactions: [{
      externalTransactionId: 'must-be-voided', sourceUpdatedAt: '2026-08-17T01:00:00Z',
      businessDate: '2026-08-10', externalSalespersonName: '김대호',
      recordState: 'voided',
    }],
  })), error => error.code === 'PLATFORM_IMPORT_MISSING_TOMBSTONE' && error.statusCode === 409);
  assert.ok(staleVoid.calls.some(call => call.sql === 'ROLLBACK'));
});

test('source digest와 adapter version이 달라지면 조용히 기존 import로 재사용하지 않는다', async () => {
  let connectCount = 0;
  await assert.rejects(importPlatformTransactionBatch(importArgs({
    pool: { async connect() { connectCount += 1; throw new Error('should not connect'); } },
    sourceDigest: '0'.repeat(64),
  })), error => error.code === 'PLATFORM_IMPORT_DIGEST_MISMATCH');
  assert.equal(connectCount, 0);

  const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const { pool, calls } = importerPool(sql => {
    if (['BEGIN', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('peakos_platform_import_runs') && sql.includes('idempotency_key')) return { rows: [{
      id: '11111111-1111-1111-1111-111111111111', source_digest: digest,
      adapter_version: 'rewardspace:v2', source_total_count: 0, snapshot_complete: true,
      requested_count: 0, inserted_count: 0,
      mapped_count: 0, unmapped_count: 0, ambiguous_count: 0,
      covered_from: '2026-08-01', covered_to: '2026-08-17', completed_at: '2026-08-17T03:00:00Z',
    }] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  await assert.rejects(importPlatformTransactionBatch(importArgs({ pool, sourceDigest: digest })),
    error => error.code === 'PLATFORM_IMPORT_IDEMPOTENCY_CONFLICT');
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
});

test('기존 이름 pin이 더 이상 eligible하지 않으면 자동 재지정 없이 unmapped로 적재한다', async () => {
  const insertedEvents = [];
  const { pool, calls } = importerPool((sql, values) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('peakos_platform_import_runs') && sql.includes('idempotency_key')) return { rows: [] };
    if (sql.includes('peakos_platform_transaction_events') && sql.includes('external_transaction_id = ANY')) return { rows: [] };
    if (sql.includes('peakos_platform_salesperson_mappings') && sql.includes('DISTINCT ON')) return { rows: [{
      external_name_normalized: '김대호', mapping_state: 'active',
      owner_uid: 'uid-stale', owner_name_snapshot: '김대호',
    }] };
    if (sql.includes('peakos_workspace_memberships')) return { rows: [{ uid: 'uid-other', name: '김대호' }] };
    if (sql.includes('SELECT event_fingerprint') && sql.includes('event_fingerprint = ANY')) return { rows: [] };
    if (sql.startsWith('INSERT INTO public.peakos_platform_import_runs')) return { rows: [] };
    if (sql.startsWith('INSERT INTO public.peakos_platform_transaction_events')) {
      insertedEvents.push(values);
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const result = await importPlatformTransactionBatch(importArgs({
    pool,
    transactions: [{
      externalTransactionId: 'stale-pin', sourceUpdatedAt: '2026-08-10T01:00:00Z',
      businessDate: '2026-08-10', externalSalespersonName: '김대호', salesAmount: 1000, profitAmount: 300,
    }],
  }));
  assert.equal(result.unmappedCount, 1);
  assert.deepEqual(insertedEvents[0].slice(10, 13), ['unmapped', null, null]);
  assert.equal(calls.some(call => call.sql.startsWith('INSERT INTO public.peakos_platform_salesperson_mappings')), false);
});

test('exact pin 뒤 동명이인이 활성화되면 기존 pin도 ambiguous로 fail-closed한다', async () => {
  const insertedEvents = [];
  const { pool } = importerPool((sql, values) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('peakos_platform_import_runs') && sql.includes('idempotency_key')) return { rows: [] };
    if (sql.includes('peakos_platform_transaction_events') && sql.includes('external_transaction_id = ANY')) return { rows: [] };
    if (sql.includes('peakos_platform_salesperson_mappings') && sql.includes('DISTINCT ON')) return { rows: [{
      external_name_normalized: '동명이인', mapping_state: 'active', match_method: 'exact_name',
      owner_uid: 'uid-same-1', owner_name_snapshot: '동명이인',
    }] };
    if (sql.includes('peakos_workspace_memberships')) return { rows: [
      { uid: 'uid-same-1', name: '동명이인' }, { uid: 'uid-same-2', name: '동명이인' },
    ] };
    if (sql.includes('SELECT event_fingerprint') && sql.includes('event_fingerprint = ANY')) return { rows: [] };
    if (sql.startsWith('INSERT INTO public.peakos_platform_import_runs')) return { rows: [] };
    if (sql.startsWith('INSERT INTO public.peakos_platform_transaction_events')) {
      insertedEvents.push(values);
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const result = await importPlatformTransactionBatch(importArgs({
    pool,
    transactions: [{
      externalTransactionId: 'duplicate-after-pin', sourceUpdatedAt: '2026-08-10T01:00:00Z',
      businessDate: '2026-08-10', externalSalespersonName: '동명이인', salesAmount: 1000, profitAmount: 300,
    }],
  }));
  assert.equal(result.ambiguousCount, 1);
  assert.deepEqual(insertedEvents[0].slice(10, 13), ['ambiguous', null, null]);
});

test('ambiguous 이름은 최초 manual correction version 1로만 명시적으로 해소한다', async () => {
  const inserted = [];
  const { pool } = importerPool((sql, values) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('operation_key = $3')) return { rows: [] };
    if (sql.includes('ORDER BY version DESC') && sql.includes('FOR SHARE')) return { rows: [] };
    if (sql.includes('membership.user_uid = $2')) return { rows: [{ name: '동명이인' }] };
    if (sql.startsWith('INSERT INTO public.peakos_platform_salesperson_mappings')) {
      inserted.push(values);
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const result = await correctPlatformSalespersonMapping({
    pool, workspaceId: 'ws_peak', provider: 'rewardspace', externalSalespersonName: '동명이인',
    ownerUid: 'uid-same-2', idempotencyKey: 'ticket-ambiguous-1', reason: '동명이인 담당자 수동 확인',
    actor: { uid: 'uid-admin', name: '관리자' },
  });
  assert.equal(result.version, 1);
  assert.equal(inserted[0][4], null);
  assert.deepEqual(inserted[0].slice(8, 13), [
    'uid-same-2', '동명이인', 'active', 'manual_correction', '동명이인 담당자 수동 확인',
  ]);
});

test('manual mapping correction과 revoke는 version을 append하고 operation key replay를 중복 저장하지 않는다', async () => {
  const reason = '담당자 변경 승인 완료';
  const inserted = [];
  const correction = importerPool((sql, values) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('operation_key = $3')) return { rows: [] };
    if (sql.includes('ORDER BY version DESC') && sql.includes('FOR SHARE')) {
      return { rows: [{ id: '11111111-1111-4111-8111-111111111111', version: 1 }] };
    }
    if (sql.includes('membership.user_uid = $2')) return { rows: [{ name: '박영업' }] };
    if (sql.startsWith('INSERT INTO public.peakos_platform_salesperson_mappings')) {
      inserted.push(values);
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const corrected = await correctPlatformSalespersonMapping({
    pool: correction.pool,
    workspaceId: 'ws_peak', provider: 'rewardspace', externalSalespersonName: '김대호',
    ownerUid: 'uid-park', mappingState: 'active', idempotencyKey: 'ticket-20260817-1', reason,
    actor: { uid: 'uid-admin', name: '관리자' }, now: new Date('2026-08-17T03:00:00Z'),
  });
  assert.equal(corrected.version, 2);
  assert.deepEqual(inserted[0].slice(3, 13), [
    2,
    '11111111-1111-4111-8111-111111111111',
    'manual:ticket-20260817-1',
    '김대호',
    '김대호',
    'uid-park',
    '박영업',
    'active',
    'manual_correction',
    reason,
  ]);

  const replay = importerPool(sql => {
    if (['BEGIN', 'COMMIT'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('operation_key = $3')) return { rows: [{
      id: corrected.id, version: 2, external_name_normalized: '김대호',
      mapping_state: 'active', match_method: 'manual_correction', owner_uid: 'uid-park',
      owner_name_snapshot: '박영업', correction_reason: reason,
    }] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const replayed = await correctPlatformSalespersonMapping({
    pool: replay.pool,
    workspaceId: 'ws_peak', provider: 'rewardspace', externalSalespersonName: '김대호',
    ownerUid: 'uid-park', mappingState: 'active', idempotencyKey: 'ticket-20260817-1', reason,
    actor: { uid: 'uid-admin', name: '관리자' },
  });
  assert.equal(replayed.duplicate, true);
  assert.equal(replay.calls.some(call => call.sql.startsWith('INSERT INTO')), false);

  const revokedRows = [];
  const revoke = importerPool((sql, values) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('operation_key = $3')) return { rows: [] };
    if (sql.includes('ORDER BY version DESC') && sql.includes('FOR SHARE')) {
      return { rows: [{ id: corrected.id, version: 2 }] };
    }
    if (sql.startsWith('INSERT INTO public.peakos_platform_salesperson_mappings')) {
      revokedRows.push(values);
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const revoked = await correctPlatformSalespersonMapping({
    pool: revoke.pool,
    workspaceId: 'ws_peak', provider: 'rewardspace', externalSalespersonName: '김대호',
    mappingState: 'revoked', idempotencyKey: 'ticket-20260817-2', reason: '담당자 매핑 해제 승인',
    actor: { uid: 'uid-admin', name: '관리자' },
  });
  assert.equal(revoked.version, 3);
  assert.deepEqual(revokedRows[0].slice(8, 13), [null, null, 'revoked', 'manual_revoke', '담당자 매핑 해제 승인']);
});

test('과거 미매핑 raw event 재수집은 fingerprint를 중복 저장하지 않고 새 exact-name pin을 남긴다', async () => {
  let mappingInsertCount = 0;
  let eventInsertCount = 0;
  const { pool } = importerPool((sql, values) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('peakos_platform_import_runs') && sql.includes('idempotency_key')) return { rows: [] };
    if (sql.includes('peakos_platform_transaction_events') && sql.includes('external_transaction_id = ANY')) return { rows: [] };
    if (sql.includes('peakos_platform_salesperson_mappings') && sql.includes('DISTINCT ON')) return { rows: [] };
    if (sql.includes('peakos_workspace_memberships')) return { rows: [{ uid: 'uid-kim', name: '김대호' }] };
    if (sql.startsWith('INSERT INTO public.peakos_platform_salesperson_mappings')) {
      mappingInsertCount += 1;
      return { rows: [{ owner_uid: 'uid-kim', owner_name_snapshot: '김대호', mapping_state: 'active' }] };
    }
    if (sql.includes('SELECT event_fingerprint') && sql.includes('event_fingerprint = ANY')) {
      return { rows: [{ event_fingerprint: values[2][0] }] };
    }
    if (sql.startsWith('INSERT INTO public.peakos_platform_import_runs')) return { rows: [] };
    if (sql.startsWith('INSERT INTO public.peakos_platform_transaction_events')) {
      eventInsertCount += 1;
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const result = await importPlatformTransactionBatch(importArgs({
    pool,
    idempotencyKey: 'rewardspace:2026-08:retry-after-account',
    transactions: [{
      externalTransactionId: 'old-unmapped', sourceUpdatedAt: '2026-08-10T01:00:00Z',
      businessDate: '2026-08-10', externalSalespersonName: '김대호', salesAmount: 1000, profitAmount: 300,
    }],
  }));
  assert.equal(mappingInsertCount, 1);
  assert.equal(eventInsertCount, 0);
  assert.equal(result.insertedCount, 0);
  assert.equal(result.mappedCount, 1);
});

test('inactive workspace import는 거래가 없어도 DB 쓰기 전에 fail-closed한다', async () => {
  const { pool, calls } = importerPool(sql => {
    if (['BEGIN', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  }, { activeWorkspace: false });
  await assert.rejects(importPlatformTransactionBatch(importArgs({ pool })),
    error => error.code === 'PLATFORM_WORKSPACE_UNAVAILABLE');
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(calls.some(call => call.sql.startsWith('INSERT INTO')), false);
});

test('같은 external id/source timestamp의 다른 revision은 rollback하고 충돌로 끝난다', async () => {
  const { pool, calls } = importerPool(sql => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('peakos_platform_import_runs')) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  await assert.rejects(importPlatformTransactionBatch(importArgs({
    pool,
    transactions: [
      { externalTransactionId: 'same', sourceUpdatedAt: '2026-08-10T01:00:00Z', businessDate: '2026-08-10', externalSalespersonName: '김대호', salesAmount: 1000, profitAmount: 100 },
      { externalTransactionId: 'same', sourceUpdatedAt: '2026-08-10T01:00:00Z', businessDate: '2026-08-10', externalSalespersonName: '김대호', salesAmount: 2000, profitAmount: 100 },
    ],
  })), error => error.code === 'PLATFORM_TRANSACTION_REVISION_CONFLICT');
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
});

test('readiness는 columns·constraints·triggers·indexes·ACL을 exact 검사한다', async () => {
  let step = 0;
  const pool = { async query(sql, values) {
    step += 1;
    if (step === 1) {
      assert.match(sql, /pg_attribute/);
      assert.match(sql, /format_type/);
      return { rows: [] };
    }
    if (step === 2) {
      assert.match(sql, /pg_constraint/);
      return { rows: values[0].map(conname => ({
        conname,
        table_name: [
          'peakos_platform_connections',
          'peakos_platform_salesperson_mappings',
          'peakos_platform_import_runs',
          'peakos_platform_transaction_events',
          'peakos_platform_aggregate_runs',
          'peakos_platform_aggregate_rows',
          'peakos_platform_aggregate_quarantines',
        ].find(table => conname.startsWith(`${table}_`)),
        contype: REQUIRED_CONSTRAINT_DEFINITIONS[conname][0],
        convalidated: true,
        definition: REQUIRED_CONSTRAINT_DEFINITIONS[conname][1],
      })) };
    }
    if (step === 3) {
      assert.match(sql, /pg_trigger/);
      return { rows: values[0].map(tgname => ({
        table_name: tgname.replace(/_no_(?:mutation|truncate)$/, ''),
        tgname, tgtype: tgname.endsWith('_no_truncate') ? 34 : 27, tgenabled: 'O',
        tgdeferrable: false, tginitdeferred: false, tgconstraint: 0, tgqual: null,
        tgnargs: 0, args_length: 0, trigger_attributes: '',
        definition: tgname.endsWith('_no_truncate')
          ? `CREATE TRIGGER ${tgname} BEFORE TRUNCATE ON public.${tgname.replace(/_no_truncate$/, '')} FOR EACH STATEMENT EXECUTE FUNCTION peakos_platform_reject_mutation()`
          : `CREATE TRIGGER ${tgname} BEFORE DELETE OR UPDATE ON public.${tgname.replace(/_no_mutation$/, '')} FOR EACH ROW EXECUTE FUNCTION peakos_platform_reject_mutation()`,
        function_schema: 'public', function_name: 'peakos_platform_reject_mutation',
        function_args: 0, returns_trigger: true, prokind: 'f', provolatile: 'v',
        prosecdef: false, function_language: 'plpgsql', function_source: APPEND_ONLY_FUNCTION_SOURCE,
      })) };
    }
    if (step === 4) {
      assert.match(sql, /pg_index/);
      return { rows: values[0].map(index_name => ({
        index_name,
        table_name: REQUIRED_INDEX_DEFINITIONS[index_name].table,
        indisunique: REQUIRED_INDEX_DEFINITIONS[index_name].unique,
        indisprimary: false,
        indisexclusion: false,
        indisvalid: true,
        indisready: true,
        indislive: true,
        definition: REQUIRED_INDEX_DEFINITIONS[index_name].definition,
        predicate: REQUIRED_INDEX_DEFINITIONS[index_name].predicate,
      })) };
    }
    if (step === 5) {
      assert.match(sql, /grantee = 'PUBLIC'/);
      return { rows: [] };
    }
    assert.match(sql, /has_table_privilege/);
    return { rows: values[0].map(table_name => ({
      rolname: 'calendar_user', rolsuper: false, rolbypassrls: false, table_name,
      can_select: true, can_insert: true, can_update: false, can_delete: false,
      can_truncate: false, can_reference: false, can_trigger: false, can_execute_guard: false,
    })) };
  } };
  assert.equal(await ensurePeakosPlatformSettlementInfrastructure(pool), true);
  assert.equal(step, 6);
});

test('migration은 provider allowlist, nullable metric, coverage, versioned mapping, append-only/ACL을 고정한다', () => {
  assert.match(MIGRATION, /provider IN \('rewardspace', 'reviewspace', 'keywordmaster', 'brandautospace', 'reviewflow'\)/);
  assert.match(MIGRATION, /covered_from DATE NOT NULL/);
  assert.match(MIGRATION, /covered_to DATE NOT NULL/);
  assert.match(MIGRATION, /sales_amount NUMERIC\(20, 0\),/);
  assert.match(MIGRATION, /profit_amount NUMERIC\(20, 0\),/);
  assert.match(MIGRATION, /supersedes_id UUID/);
  assert.match(MIGRATION, /operation_key TEXT NOT NULL/);
  assert.match(MIGRATION, /source_total_count INTEGER NOT NULL/);
  assert.match(MIGRATION, /snapshot_complete BOOLEAN NOT NULL/);
  assert.match(MIGRATION, /CHECK \(snapshot_complete\)/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS peakos_platform_import_runs_idempotency_uidx/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS peakos_platform_transaction_events_fingerprint_uidx/);
  assert.match(MIGRATION, /CREATE INDEX IF NOT EXISTS peakos_platform_transaction_events_self_month_idx[\s\S]*WHERE attribution_status = 'mapped'/);
  assert.match(MIGRATION, /CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE/);
  assert.match(MIGRATION, /REVOKE ALL PRIVILEGES ON TABLE/);
  assert.match(MIGRATION, /SET LOCAL search_path = public, pg_temp/);
  assert.doesNotMatch(MIGRATION, /api[_ -]?key\s+TEXT/i);
});

test('quarantine migration은 기존 원장을 수정하지 않고 감사행과 SELECT+INSERT 최소권한만 추가한다', () => {
  assert.doesNotMatch(MIGRATION, /peakos_platform_aggregate_quarantines/);
  assert.match(QUARANTINE_MIGRATION,
    /CREATE TABLE IF NOT EXISTS peakos_platform_aggregate_quarantines/);
  assert.match(QUARANTINE_MIGRATION,
    /UNIQUE \(workspace_id, provider, aggregate_run_id\)/);
  assert.match(QUARANTINE_MIGRATION,
    /UNIQUE \(workspace_id, provider, operation_key\)/);
  assert.match(QUARANTINE_MIGRATION,
    /FOREIGN KEY \(workspace_id, provider, aggregate_run_id\)[\s\S]*ON UPDATE RESTRICT ON DELETE RESTRICT/);
  assert.match(QUARANTINE_MIGRATION,
    /CHECK \(expected_latest_run_id = aggregate_run_id\)/);
  assert.match(QUARANTINE_MIGRATION,
    /CHECK \(char_length\(btrim\(reason\)\) BETWEEN 8 AND 500\)/);
  assert.match(QUARANTINE_MIGRATION,
    /BEFORE UPDATE OR DELETE ON peakos_platform_aggregate_quarantines/);
  assert.match(QUARANTINE_MIGRATION,
    /BEFORE TRUNCATE ON peakos_platform_aggregate_quarantines/);
  assert.match(QUARANTINE_MIGRATION,
    /GRANT SELECT, INSERT ON TABLE peakos_platform_aggregate_quarantines TO %I/);
  assert.match(QUARANTINE_MIGRATION,
    /ARRAY\['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'\]/);
  assert.doesNotMatch(QUARANTINE_MIGRATION, /GRANT[\s\S]{0,80}\b(?:UPDATE|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(QUARANTINE_MIGRATION, /api[_ -]?key\s+TEXT/i);
});

test('nullable 감사 필드는 CHECK의 UNKNOWN 통과 없이 필수값 존재를 강제한다', () => {
  assert.match(MIGRATION, /connection_state = 'error' AND last_error_code IS NOT NULL/);
  assert.match(MIGRATION, /mapping_state = 'active' AND owner_uid IS NOT NULL\s+AND owner_name_snapshot IS NOT NULL/);
  assert.match(MIGRATION, /match_method = 'manual_correction'\s+AND correction_reason IS NOT NULL/);
  assert.match(MIGRATION, /match_method = 'manual_revoke' AND version > 1\s+AND correction_reason IS NOT NULL/);
  assert.match(MIGRATION, /status = 'failed' AND error_code IS NOT NULL/);
  assert.match(MIGRATION, /attribution_status = 'mapped' AND owner_uid IS NOT NULL\s+AND owner_name_snapshot IS NOT NULL/);

  for (const [constraint, nullableField] of [
    ['peakos_platform_connections_error_check', 'last_error_code'],
    ['peakos_platform_salesperson_mappings_owner_check', 'owner_name_snapshot'],
    ['peakos_platform_salesperson_mappings_correction_check', 'correction_reason'],
    ['peakos_platform_import_runs_error_check', 'error_code'],
    ['peakos_platform_transaction_events_attribution_check', 'owner_name_snapshot'],
  ]) {
    assert.match(
      REQUIRED_CONSTRAINT_DEFINITIONS[constraint][1],
      new RegExp(`\\(${nullableField} IS NOT NULL\\)`),
      `${constraint} must reject NULL ${nullableField}`,
    );
  }
});
