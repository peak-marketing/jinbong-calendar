'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const {
  calculatePlatformMonthlyAggregateDigest,
  importPlatformMonthlyAggregateSnapshot,
  importPlatformTransactionBatch,
  monthBounds,
} = require('./peakos-platform-monthly-settlement');

const MIGRATION = fs.readFileSync(path.resolve(
  __dirname,
  '../migrations/20260817_peakos_platform_monthly_settlement.sql',
), 'utf8');
const INDEX_SOURCE = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
const MODULE_SOURCE = fs.readFileSync(path.resolve(
  __dirname,
  './peakos-platform-monthly-settlement.js',
), 'utf8');

function namedFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must remain defined in server/index.js`);
  const openingParenthesis = source.indexOf('(', start);
  let parenthesisDepth = 0;
  let closingParenthesis = -1;
  for (let index = openingParenthesis; index < source.length; index += 1) {
    if (source[index] === '(') parenthesisDepth += 1;
    if (source[index] === ')') parenthesisDepth -= 1;
    if (parenthesisDepth === 0) {
      closingParenthesis = index;
      break;
    }
  }
  assert.notEqual(closingParenthesis, -1, `${name} must have a complete parameter list`);
  const openingBrace = source.indexOf('{', closingParenthesis);
  assert.notEqual(openingBrace, -1, `${name} must have a function body`);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} function body is incomplete`);
}

function mountedPathPolicies() {
  const names = [
    'requestPolicyPath',
    'collaborationAreaForPath',
    'isNonPeakWorkspaceSafePath',
    'isChatOnlyAllowedPath',
    'isExternalCalendarAllowedPath',
  ];
  const definitions = names.map(name => namedFunctionSource(INDEX_SOURCE, name)).join('\n');
  return Function(
    `'use strict';\n${definitions}\nreturn { ${names.join(', ')} };`,
  )();
}

async function listenMountedPolicyApp() {
  const policies = mountedPathPolicies();
  const seen = [];
  const app = express();
  app.use('/api/peakos', (req, res, next) => {
    const policyPath = policies.requestPolicyPath(req);
    seen.push({ baseUrl: req.baseUrl, path: req.path, originalUrl: req.originalUrl, policyPath });
    const persona = req.get('x-test-persona');
    if (persona === 'chat_only' && !policies.isChatOnlyAllowedPath(policyPath)) {
      return res.status(403).json({ code: 'CHAT_ONLY' });
    }
    if (persona === 'external_calendar_only' && !policies.isExternalCalendarAllowedPath(policyPath)) {
      return res.status(403).json({ code: 'EXTERNAL_CALENDAR_ONLY' });
    }
    if (!policies.isNonPeakWorkspaceSafePath(policyPath)) {
      return res.status(403).json({ code: 'PEAKOS_WORKSPACE_SURFACE_NOT_MIGRATED' });
    }
    return next();
  });
  app.get('/api/peakos/monthly-settlement/self', (_req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    policies,
    seen,
    server,
  };
}

function importerPool(queryHandler) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, values });
      return queryHandler(normalized, values);
    },
    release() {},
  };
  return { pool: { async connect() { return client; } }, calls };
}

function emptyImportArgs(pool, overrides = {}) {
  return {
    pool,
    workspaceId: 'ws_peak',
    provider: 'rewardspace',
    idempotencyKey: 'rewardspace:2025-12:page-1',
    adapterVersion: 'rewardspace:v2',
    coveredFrom: '2025-12-01',
    coveredTo: '2025-12-31',
    sourceTotalCount: 0,
    snapshotComplete: true,
    actor: { uid: 'system:rewardspace', name: '리워드스페이스 수집기' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    transactions: [],
    ...overrides,
  };
}

test('KST 월 범위는 12월에서 다음 해 1월로 정확히 넘어간다', () => {
  assert.deepEqual(monthBounds('2025-12', new Date('2026-01-01T00:00:00.000Z')), {
    month: '2025-12',
    from: '2025-12-01',
    to: '2025-12-31',
    next: '2026-01-01',
    coverageRequiredThrough: '2025-12-31',
  });
  assert.deepEqual(monthBounds('2026-01', new Date('2026-01-01T00:00:00.000Z')), {
    month: '2026-01',
    from: '2026-01-01',
    to: '2026-01-31',
    next: '2026-02-01',
    coverageRequiredThrough: '2026-01-01',
  });
});

test('같은 멱등성 키의 adapter version 변경은 기존 run을 재사용하지 않고 fail-closed한다', async () => {
  const emptyDigest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const { pool, calls } = importerPool(sql => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql.startsWith('SELECT pg_advisory')) return { rows: [] };
    if (sql.includes('peakos_workspaces') && sql.includes('FOR SHARE')) {
      return { rows: [{ id: 'ws_peak' }] };
    }
    if (sql.includes('peakos_platform_import_runs') && sql.includes('idempotency_key')) {
      return { rows: [{
        id: '11111111-1111-4111-8111-111111111111',
        source_digest: emptyDigest,
        adapter_version: 'rewardspace:v1',
        source_total_count: 0,
        snapshot_complete: true,
        requested_count: 0,
        inserted_count: 0,
        mapped_count: 0,
        unmapped_count: 0,
        ambiguous_count: 0,
        covered_from: '2025-12-01',
        covered_to: '2025-12-31',
        completed_at: '2026-01-01T00:00:00.000Z',
      }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });

  await assert.rejects(
    importPlatformTransactionBatch(emptyImportArgs(pool, { sourceDigest: emptyDigest })),
    error => error?.code === 'PLATFORM_IMPORT_IDEMPOTENCY_CONFLICT' && error?.statusCode === 409,
  );
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(calls.some(call => call.sql.startsWith('INSERT INTO')), false);
});

test('credential 저장소는 비밀값 대신 opaque secret reference만 허용한다', () => {
  assert.match(MIGRATION, /credential_secret_ref\s+TEXT\b/i);
  assert.match(MIGRATION, /connection_state\s*<>\s*'ready'\s+OR\s+credential_secret_ref\s+IS\s+NOT\s+NULL/i);
  assert.doesNotMatch(MIGRATION, /\b(api_key|access_token|refresh_token|client_secret)\s+TEXT\b/i);
});

test('self read는 event 당시 owner snapshot이 아니라 최신 versioned mapping으로 재귀속한다', () => {
  const routeSource = namedFunctionSource(
    MODULE_SOURCE,
    'registerPeakosPlatformMonthlySettlementRoutes',
  ).replace(/\s+/g, ' ');

  assert.match(routeSource,
    /ROW_NUMBER\(\) OVER \( PARTITION BY workspace_id, provider, external_transaction_id ORDER BY source_updated_at DESC, imported_at DESC, id DESC \) AS revision_rank/);
  assert.match(routeSource,
    /SELECT DISTINCT ON \(provider, external_name_normalized\) provider, external_name_normalized, mapping_state, match_method, owner_uid FROM public\.peakos_platform_salesperson_mappings WHERE workspace_id = \$1 ORDER BY provider, external_name_normalized, version DESC, created_at DESC, id DESC/);
  assert.match(routeSource,
    /JOIN latest_mapping mapping ON mapping\.provider = ranked\.provider AND mapping\.external_name_normalized = ranked\.external_name_normalized/);
  assert.match(routeSource,
    /LEFT JOIN unique_exact exact_mapping ON exact_mapping\.external_name_normalized = mapping\.external_name_normalized AND exact_mapping\.owner_uid = mapping\.owner_uid/);
  assert.match(routeSource, /mapping\.mapping_state = 'active'/);
  assert.match(routeSource, /mapping\.owner_uid = \$2/);
  assert.match(routeSource,
    /mapping\.match_method = 'manual_correction' OR exact_mapping\.owner_uid IS NOT NULL/);
  assert.doesNotMatch(routeSource, /ranked\.owner_uid\s*=\s*\$2/);
  assert.doesNotMatch(routeSource, /ranked\.attribution_status\s*=\s*'mapped'/);
});

test('aggregate migration은 transaction event와 분리된 immutable run/row 원장을 고정한다', () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS peakos_platform_aggregate_runs/);
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS peakos_platform_aggregate_rows/);
  assert.match(MIGRATION, /source_excluded_count INTEGER NOT NULL/);
  assert.match(MIGRATION,
    /row_count \+ global_unmatched_count \+ source_excluded_count = source_total_count/);
  assert.match(MIGRATION,
    /profit_basis IN \('reward_distributor_margin', 'review_spread_profit', 'unavailable'\)/);
  assert.match(MIGRATION,
    /provider <> 'keywordmaster'[\s\S]*profit_amount IS NULL[\s\S]*profit_basis = 'unavailable'/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS peakos_platform_aggregate_runs_identity_uidx/);
  assert.match(MIGRATION, /CREATE INDEX IF NOT EXISTS peakos_platform_aggregate_runs_latest_idx/);
  assert.match(MIGRATION, /'peakos_platform_aggregate_runs',[\s\S]*'peakos_platform_aggregate_rows'/);
});

test('aggregate importer는 complete run 단위이며 transaction revision/tombstone을 합성하지 않는다', () => {
  const source = namedFunctionSource(
    MODULE_SOURCE,
    'importPlatformMonthlyAggregateSnapshot',
  ).replace(/\s+/g, ' ');
  assert.match(source, /peakos-platform-aggregate-v1:/);
  assert.match(source, /INSERT INTO public\.peakos_platform_aggregate_runs/);
  assert.match(source, /INSERT INTO public\.peakos_platform_aggregate_rows/);
  assert.match(source, /source_excluded_count/);
  assert.match(source, /PLATFORM_AGGREGATE_IDEMPOTENCY_CONFLICT/);
  assert.match(source, /PLATFORM_AGGREGATE_ATTRIBUTION_UNRESOLVED/);
  assert.doesNotMatch(source, /sourceUpdatedAt|source_updated_at|tombstone|voided/);
  assert.equal(typeof importPlatformMonthlyAggregateSnapshot, 'function');
  assert.equal(typeof calculatePlatformMonthlyAggregateDigest, 'function');
});

test('self read는 월별 최신 aggregate run이 있으면 그 run 전체를 event fallback보다 우선한다', () => {
  const source = namedFunctionSource(
    MODULE_SOURCE,
    'registerPeakosPlatformMonthlySettlementRoutes',
  ).replace(/\s+/g, ' ');
  assert.match(source,
    /SELECT DISTINCT ON \(provider\) provider, id, settlement_month,[\s\S]*FROM public\.peakos_platform_aggregate_runs/);
  assert.match(source, /const aggregateRun = aggregateRuns\.get\(provider\.key\);[\s\S]*if \(aggregateRun\)/);
  assert.match(source,
    /NOT EXISTS \( SELECT 1 FROM public\.peakos_platform_aggregate_quarantines quarantine/);
  assert.match(source, /if \(aggregateRunCount > 0\)[\s\S]*status: 'not_covered'/);
  assert.match(source, /snapshotKind: 'monthly_aggregate'/);
  assert.match(source, /sourceState: String\(aggregateRun\.source_state \|\| 'unknown'\)/);
  assert.match(source, /profitBasis/);
});

test('mounted /api/peakos의 stripped path는 지사 self 정산만 통과하고 제한 계정은 계속 거부한다', async t => {
  const { baseUrl, policies, seen, server } = await listenMountedPolicyApp();
  t.after(() => new Promise(resolve => server.close(resolve)));

  const authSource = namedFunctionSource(INDEX_SOURCE, 'authMiddleware');
  assert.match(authSource, /const policyPath = requestPolicyPath\(req\)/);
  const chatGate = authSource.indexOf('req.userDoc?.chat_only');
  const calendarGate = authSource.indexOf('req.userDoc?.external_calendar_only');
  const workspaceSafeGate = authSource.indexOf('isNonPeakWorkspaceSafePath(');
  assert.ok(chatGate >= 0 && chatGate < workspaceSafeGate);
  assert.ok(calendarGate >= 0 && calendarGate < workspaceSafeGate);

  assert.equal(policies.isChatOnlyAllowedPath('/monthly-settlement/self'), false);
  assert.equal(policies.isExternalCalendarAllowedPath('/monthly-settlement/self'), false);

  const direct = await fetch(`${baseUrl}/api/peakos/monthly-settlement/self`);
  assert.equal(direct.status, 200);
  assert.deepEqual(await direct.json(), { ok: true });
  assert.deepEqual(seen[0], {
    baseUrl: '/api/peakos',
    path: '/monthly-settlement/self',
    originalUrl: '/api/peakos/monthly-settlement/self',
    policyPath: '/api/peakos/monthly-settlement/self',
  });
  assert.equal(policies.isNonPeakWorkspaceSafePath(seen[0].policyPath), true);

  for (const persona of ['chat_only', 'external_calendar_only']) {
    const restricted = await fetch(`${baseUrl}/api/peakos/monthly-settlement/self`, {
      headers: { 'x-test-persona': persona },
    });
    assert.equal(restricted.status, 403);
  }
});
