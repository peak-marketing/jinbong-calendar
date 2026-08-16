'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WORKSPACE_MODULE_PATH = path.resolve(__dirname, 'peakos-workspaces.js');
const WORKSPACE_MIGRATION_PATH = path.resolve(__dirname, '../migrations/20260809_peakos_workspaces.sql');
const INDEX_SOURCE = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
const SETTLEMENT_SOURCE = fs.readFileSync(path.resolve(__dirname, '../banking/peakos-settlement-routes.js'), 'utf8');

const EXPECTED_SLUGS = Object.freeze(['peak', 'build-solution', 'jeonju', 'daegu']);
const OVERSIGHT_AREAS = Object.freeze(['projects', 'settlements', 'documents']);
const DENIED_OVERSIGHT_AREAS = Object.freeze(['calendar', 'chat']);

function loadWorkspaceModule() {
  assert.equal(fs.existsSync(WORKSPACE_MODULE_PATH), true, 'workspace policy module is required');
  delete require.cache[require.resolve(WORKSPACE_MODULE_PATH)];
  return require(WORKSPACE_MODULE_PATH);
}

function responseCapture() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

async function runMiddleware(middleware, req) {
  const res = responseCapture();
  let nextCalls = 0;
  await middleware(req, res, () => { nextCalls += 1; });
  return { res, nextCalls };
}

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source start: ${start}`);
  assert.notEqual(endIndex, -1, `missing source end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertWorkspaceScoped(source, label) {
  assert.match(source, /workspace/i, `${label} must bind or validate the active workspace`);
}

test('workspace contract uses four canonical slugs and rejects ambiguous header values', () => {
  const {
    normalizeWorkspaceSlug,
    readWorkspaceSlugHeader,
    WORKSPACES,
  } = loadWorkspaceModule();

  assert.deepEqual(WORKSPACES.map(item => item.slug).sort(), [...EXPECTED_SLUGS].sort());
  for (const slug of EXPECTED_SLUGS) assert.equal(normalizeWorkspaceSlug(slug), slug);
  assert.equal(normalizeWorkspaceSlug('PEAK'), 'peak');
  assert.equal(normalizeWorkspaceSlug('unknown'), 'unknown');
  for (const value of ['', 'dague/../../peak', '../peak', 'peak,daegu']) {
    assert.equal(normalizeWorkspaceSlug(value), null, value);
  }

  assert.equal(readWorkspaceSlugHeader({ headers: { 'x-peakos-workspace': 'daegu' } }), 'daegu');
  assert.equal(readWorkspaceSlugHeader({ headers: { 'x-peakos-workspace': ['peak', 'daegu'] } }), null);
  assert.equal(readWorkspaceSlugHeader({ headers: {} }), null);
});

test('workspace permission middleware enforces membership and the exact oversight matrix', async () => {
  const { createPeakosWorkspaceService } = loadWorkspaceModule();
  const contexts = new Map([
    ['branch-user:daegu', {
      workspace: { id: 'workspace-daegu', slug: 'daegu', name: '대구지사 OS' },
      membership: { role: 'member' },
      permissions: {
        calendar: 'write', chat: 'write', projects: 'write', settlements: 'write', documents: 'write',
      },
    }],
    ['hq-oversight:daegu', {
      workspace: { id: 'workspace-daegu', slug: 'daegu', name: '대구지사 OS' },
      membership: { role: 'oversight' },
      permissions: {
        calendar: 'none', chat: 'none', projects: 'read', settlements: 'read', documents: 'read',
      },
    }],
  ]);
  const pool = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (!/peakos_workspace_memberships/.test(text)) throw new Error(`unexpected query: ${text}`);
      const context = text.includes("m.role <> 'oversight'") && text.includes('LIMIT 1')
        ? contexts.get(`${params[0]}:daegu`)
        : contexts.get(`${params[1]}:${params[0]}`);
      return { rows: context ? [{
        workspace_id: context.workspace.id,
        slug: context.workspace.slug,
        name: context.workspace.name,
        membership_role: context.membership.role,
        permissions: context.permissions,
      }] : [] };
    },
  };
  const service = createPeakosWorkspaceService({
    pool,
    environment: { PEAKOS_ACCESS_UIDS_JSON: JSON.stringify({
      '패션TV봉이': 'hq-oversight',
      '박종원': 'uid-oversight-park',
      '김대호': 'uid-oversight-kim',
      '손명아': 'uid-oversight-son',
    }) },
    logger: { error() {} },
  });
  const req = (uid, slug, method = 'GET') => ({ uid, method, headers: { 'x-peakos-workspace': slug } });

  for (const area of [...OVERSIGHT_AREAS, ...DENIED_OVERSIGHT_AREAS]) {
    const branchRead = await runMiddleware(service.requireWorkspace({ area, action: 'read' }), req('branch-user', 'daegu'));
    const branchWrite = await runMiddleware(service.requireWorkspace({ area, action: 'write' }), req('branch-user', 'daegu', 'POST'));
    assert.equal(branchRead.nextCalls, 1, `branch ${area} read`);
    assert.equal(branchWrite.nextCalls, 1, `branch ${area} write`);
  }

  for (const area of OVERSIGHT_AREAS) {
    const read = await runMiddleware(service.requireWorkspace({ area, action: 'read' }), req('hq-oversight', 'daegu'));
    const write = await runMiddleware(service.requireWorkspace({ area, action: 'write' }), req('hq-oversight', 'daegu', 'POST'));
    assert.equal(read.nextCalls, 1, `oversight ${area} read`);
    assert.equal(write.nextCalls, 0, `oversight ${area} write`);
    assert.equal(write.res.statusCode, 403);
  }

  for (const area of DENIED_OVERSIGHT_AREAS) {
    for (const action of ['read', 'write']) {
      const denied = await runMiddleware(
        service.requireWorkspace({ area, action }),
        req('hq-oversight', 'daegu', action === 'read' ? 'GET' : 'POST'),
      );
      assert.equal(denied.nextCalls, 0, `oversight ${area} ${action}`);
      assert.equal(denied.res.statusCode, 403);
    }
  }

  for (const [uid, slug] of [
    ['branch-user', 'peak'],
    ['unknown-user', 'daegu'],
    ['branch-user', 'unknown'],
  ]) {
    const denied = await runMiddleware(
      service.requireWorkspace({ area: 'projects', action: 'read' }),
      req(uid, slug),
    );
    assert.equal(denied.nextCalls, 0, `${uid}:${slug}`);
    assert.ok([400, 403, 404].includes(denied.res.statusCode));
  }
});

test('HQ oversight bootstrap grants only the configured exact four immutable UIDs', async () => {
  const { createPeakosWorkspaceService, parseAccessUidMap } = loadWorkspaceModule();
  const configured = {
    '패션TV봉이': 'uid-oversight-fashion',
    '박종원': 'uid-oversight-park',
    '김대호': 'uid-oversight-kim',
    '손명아': 'uid-oversight-son',
    '전현우': 'uid-must-not-receive-oversight',
  };
  const environment = { PEAKOS_ACCESS_UIDS_JSON: JSON.stringify(configured) };
  const expectedUids = Object.values(configured).slice(0, 4).sort();
  assert.deepEqual([...parseAccessUidMap(environment).values()].sort(), expectedUids);

  const grants = [];
  const statements = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ text, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] };
      if (/SELECT uid FROM users/.test(text)) {
        return { rows: expectedUids.map(uid => ({ uid })) };
      }
      if (/WITH deactivated AS/.test(text)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO peakos_workspace_memberships/.test(text)) {
        grants.push({ workspaceId: params[0], permissions: JSON.parse(params[1]), uids: [...params[2]] });
        return { rows: [], rowCount: params[2].length };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    release() {},
  };
  const pool = {
    query: (...args) => client.query(...args),
    async connect() { return client; },
  };
  const service = createPeakosWorkspaceService({ pool, environment, logger: { log() {}, error() {} } });
  assert.equal(await service.seedOversightMemberships(), 4);
  assert.deepEqual(grants.map(grant => grant.workspaceId).sort(), [
    'ws_build_solution', 'ws_daegu', 'ws_jeonju',
  ]);
  for (const grant of grants) {
    assert.deepEqual(grant.uids.sort(), expectedUids);
    assert.equal(grant.uids.includes(configured['전현우']), false);
    assert.deepEqual(grant.permissions, {
      calendar: 'none', chat: 'none', projects: 'read', settlements: 'read', documents: 'read',
    });
  }
  const revoke = statements.find(statement => /WITH deactivated AS/.test(statement.text));
  assert.ok(revoke, 'stale policy oversight grants must be reconciled');
  assert.deepEqual(revoke.params[0].sort(), ['ws_build_solution', 'ws_daegu', 'ws_jeonju']);
  assert.deepEqual([...revoke.params[1]].sort(), expectedUids);
  assert.match(revoke.text, /role = 'oversight'/);
  assert.match(revoke.text, /membership_source = 'hq_oversight_policy'/);
  assert.match(revoke.text, /NOT \(user_uid = ANY\(\$2::text\[\]\)\)/);
  assert.match(revoke.text, /INSERT INTO peakos_workspace_membership_audit/);
  assert.equal(statements.at(0).text, 'BEGIN');
  assert.equal(statements.at(-1).text, 'COMMIT');

  assert.throws(
    () => parseAccessUidMap({ PEAKOS_ACCESS_UIDS_JSON: JSON.stringify({
      ...configured,
      '손명아': configured['김대호'],
    }) }),
    /누락|중복|올바르지/,
  );
});

test('membership validator rejects mixed-workspace invite/share targets atomically', async () => {
  const { createPeakosWorkspaceService } = loadWorkspaceModule();
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ text, params });
      assert.match(text, /m\.workspace_id = \$1/);
      assert.match(text, /m\.role <> 'oversight'/);
      const requested = params[1] || [];
      return { rows: requested.filter(uid => uid === 'same-member').map(uid => ({ uid })) };
    },
  };
  const service = createPeakosWorkspaceService({ pool, environment: {}, logger: { error() {} } });

  assert.deepEqual(
    await service.assertUsersInWorkspace(['same-member', 'same-member'], 'workspace-daegu'),
    ['same-member'],
  );
  await assert.rejects(
    service.assertUsersInWorkspace(['same-member', 'foreign-member'], 'workspace-daegu'),
    error => error.code === 'PEAKOS_CROSS_WORKSPACE_MEMBER_FORBIDDEN' && error.statusCode === 400,
  );
  assert.equal(calls.every(call => call.params[0] === 'workspace-daegu'), true);
});

test('legacy backfill is bounded, resumable, and can only assign rows to Peak', async () => {
  const { backfillPeakWorkspaceBatches } = loadWorkspaceModule();
  const rowCounts = [2, 2, 1];
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return { rowCount: rowCounts.shift() };
    },
  };
  assert.equal(await backfillPeakWorkspaceBatches(pool, { table: 'events', batchSize: 2 }), 5);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call.sql, /^WITH batch AS/);
    assert.match(call.sql, /FROM events WHERE workspace_id IS NULL/);
    assert.match(call.sql, /UPDATE events target SET workspace_id = \$2/);
    assert.deepEqual(call.params, [2, 'ws_peak']);
    assert.doesNotMatch(call.sql, /INSERT|DELETE/);
  }
  await assert.rejects(
    backfillPeakWorkspaceBatches(pool, { table: 'users; DROP TABLE users' }),
    /허용되지 않은/,
  );
});

test('migration introduces nullable scopes and never copies operational data to new workspaces', () => {
  assert.equal(fs.existsSync(WORKSPACE_MIGRATION_PATH), true, 'workspace migration is required');
  const sql = fs.readFileSync(WORKSPACE_MIGRATION_PATH, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS peakos_workspaces/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS peakos_workspace_memberships/i);
  for (const slug of EXPECTED_SLUGS) assert.match(sql, new RegExp(`['"]${slug}['"]`));

  for (const table of [
    'events', 'custom_event_types', 'custom_todo_cats', 'chat_rooms', 'projects',
    'peakos_intake', 'peakos_monthly', 'peakos_price',
  ]) {
    assert.match(sql, new RegExp(`ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+${table}[\\s\\S]{0,500}workspace_id`, 'i'), table);
  }

  assert.match(sql, /bounded backfill helper/i);
  assert.match(sql, /UPDATE\s+peakos_price\s+SET\s+workspace_id\s*=\s*'ws_peak'/i);
  assert.match(sql, /PRIMARY KEY\s*\(workspace_id,\s*key\)/i);
  assert.match(sql, /PRIMARY KEY\s*\(workspace_id,\s*id\)/i);
  for (const table of [
    'peakos_intake_tombstones', 'peakos_intake_audit_log',
    'peakos_monthly_tombstones', 'peakos_monthly_audit_log',
  ]) {
    assert.match(
      sql,
      new RegExp(`ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+${table}[\\s\\S]{0,180}workspace_id`, 'i'),
      `${table} workspace column`,
    );
    assert.match(
      sql,
      new RegExp(`UPDATE\\s+${table}\\s+SET\\s+workspace_id\\s*=\\s*'ws_peak'`, 'i'),
      `${table} Peak backfill`,
    );
  }
  assert.match(sql, /PRIMARY KEY\s*\(workspace_id,\s*target_id\)/i);
  assert.match(sql, /UPDATE\s+peakos_settlement_import_runs\s+SET\s+workspace_id\s*=\s*'ws_peak'/i);
  assert.match(sql, /peakos_workspace_documents_storage_key_unique[\s\S]*\(workspace_id,\s*stored_key\)/i);
  assert.match(sql, /peakos_workspace_documents_category_check[\s\S]*branches[\s\S]*clients[\s\S]*manuals[\s\S]*bankbooks[\s\S]*other/i);
  assert.match(sql, /peakos_workspace_documents_mime_type_check[\s\S]*image\/png[\s\S]*image\/jpeg[\s\S]*application\/pdf/i);
  assert.match(sql, /current_setting\('peakos\.app_role',\s*TRUE\)/i);
  assert.match(sql, /GRANT SELECT ON TABLE peakos_workspaces/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE peakos_workspace_memberships/i);
  assert.match(sql, /GRANT SELECT, INSERT ON TABLE peakos_workspace_membership_audit/i);
  assert.match(sql, /GRANT SELECT ON TABLE peakos_workspace_documents/i);
  assert.doesNotMatch(sql, /ALTER\s+(?:TABLE|SEQUENCE)[\s\S]{0,120}\sOWNER\s+TO/i);
  assert.doesNotMatch(
    sql,
    /INSERT\s+INTO\s+(?:events|chat_rooms|projects|peakos_intake|peakos_monthly|peakos_credit|peakos_finance_requests)\b[\s\S]{0,120}\bSELECT\b/i,
    'operational rows must not be cloned into branch workspaces',
  );
  assert.doesNotMatch(sql, /패션TV봉이|박종원|김대호|손명아/, 'oversight grants must use configured immutable UIDs, not display names');
});

test('price catalog is workspace-keyed: 165 defaults per workspace, Peak-only legacy overrides', async () => {
  const {
    BASE_PRICE_ROWS,
    PRICE_WORKSPACE_IDS,
    seedWorkspacePriceCatalog,
  } = require('../banking/peakos-price-catalog');
  assert.deepEqual(PRICE_WORKSPACE_IDS, ['ws_peak', 'ws_build_solution', 'ws_jeonju', 'ws_daegu']);
  const calls = [];
  const inserted = new Map();
  const pool = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: text, params });
      if (text.startsWith('INSERT INTO peakos_price')) {
        inserted.set(`${params[0]}:${params[1]}`, { a: params[2], b: params[3], c: params[4] });
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('SELECT a, b, c FROM peakos_price')) {
        return { rows: [inserted.get(`${params[0]}:${params[1]}`)] };
      }
      if (text.startsWith('UPDATE peakos_price')) return { rows: [], rowCount: 1 };
      if (text.startsWith('SELECT COUNT(*)::integer AS count')) {
        return { rows: [{ count: BASE_PRICE_ROWS.length }] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  for (const workspaceId of PRICE_WORKSPACE_IDS) {
    assert.equal(await seedWorkspacePriceCatalog(pool, workspaceId), 165);
  }

  for (const workspaceId of PRICE_WORKSPACE_IDS) {
    const keys = calls
      .filter(call => call.sql.startsWith('INSERT INTO peakos_price') && call.params[0] === workspaceId)
      .map(call => call.params[1]);
    assert.equal(keys.length, 165, `${workspaceId} base count`);
    assert.equal(new Set(keys).size, 165, `${workspaceId} base uniqueness`);
  }
  const keySets = PRICE_WORKSPACE_IDS.map(workspaceId => calls
    .filter(call => call.sql.startsWith('INSERT INTO peakos_price') && call.params[0] === workspaceId)
    .map(call => call.params[1]).sort());
  for (const keys of keySets.slice(1)) assert.deepEqual(keys, keySets[0]);

  const allSql = calls.map(call => call.sql).join('\n');
  assert.match(allSql, /workspace_id/i);
  assert.match(allSql, /is_base/i);
  assert.match(allSql, /ON CONFLICT \(workspace_id, key\) DO NOTHING/i);
  assert.doesNotMatch(allSql, /is_custom\s*=\s*TRUE/i, 'branch seed must not clone Peak custom rows');
  assert.doesNotMatch(allSql, /\bDELETE\s+FROM\s+peakos_price/i);
  for (const call of calls.filter(item => item.sql.startsWith('UPDATE peakos_price'))) {
    assert.doesNotMatch(call.sql, /\bcost\s*=/i, 'seeding must preserve current Peak overrides');
    assert.doesNotMatch(call.sql, /\bunit\s*=/i, 'seeding must preserve current Peak overrides');
  }
});

test('canonical list and ID lookup paths are workspace-scoped before returning data', () => {
  for (const [label, start, end] of [
    ['calendar list', "app.get('/api/events', authMiddleware", "function buildRepeatDates"],
    ['chat list', "app.get('/api/chat-rooms', authMiddleware", "app.get('/api/chat-room-groups'"],
    ['project list', "app.get('/api/projects', authMiddleware", "app.post('/api/projects', authMiddleware"],
    ['directory', "app.get('/api/users/all-approved', authMiddleware", '// ── 파일 첨부 (채팅)'],
  ]) {
    assertWorkspaceScoped(sourceBetween(INDEX_SOURCE, start, end), label);
  }

  for (const [label, start, end] of [
    ['event ID lookup', 'async function canAccessEvent(', '// PEAK OS collaboration requests'],
    ['chat room ID lookup', 'async function getChatRoomById(', 'async function isChatRoomMember('],
    ['project ID lookup', 'async function canAccessProject(', 'async function canManageProject('],
  ]) {
    assertWorkspaceScoped(sourceBetween(INDEX_SOURCE, start, end), label);
  }

  assertWorkspaceScoped(SETTLEMENT_SOURCE, 'settlement routes');
});

test('weekly report and adjacent event detail reads cannot mix workspaces in either direction', () => {
  const weeklyReport = sourceBetween(
    INDEX_SOURCE,
    "app.get('/api/weekly-report', authMiddleware",
    '// ══ 보고서 시스템',
  );
  for (const predicate of [
    /workspace_id = \$3 OR \(workspace_id IS NULL AND \$3 = \$4\)/,
    /e\.workspace_id = \$5 OR \(e\.workspace_id IS NULL AND \$5 = \$6\)/,
    /e\.workspace_id = \$4 OR \(e\.workspace_id IS NULL AND \$4 = \$5\)/,
  ]) assert.match(weeklyReport, predicate);
  assert.equal(
    [...weeklyReport.matchAll(/requestWorkspaceId\(req\)/g)].length,
    3,
    'admin, manager, and member branches must all bind the active workspace',
  );
  assert.equal(
    [...weeklyReport.matchAll(/PEAK_WORKSPACE_ID/g)].length,
    3,
    'legacy NULL rows may resolve only inside the selected Peak workspace',
  );

  const projectDetail = sourceBetween(
    INDEX_SOURCE,
    "app.get('/api/projects/:id', authMiddleware",
    "app.put('/api/projects/:id', authMiddleware",
  );
  assert.match(projectDetail, /SELECT \* FROM events[\s\S]*workspace_id = \$2/);
  const timetableEvents = sourceBetween(
    INDEX_SOURCE,
    "app.get('/api/timetable/available-events', authMiddleware",
    '// 일과표 항목 추가',
  );
  assert.match(timetableEvents, /FROM events e[\s\S]*e\.workspace_id = \$3/);
});

test('directory-backed invitations reject users outside the active workspace', () => {
  for (const [label, start, end] of [
    ['team event create shares', "app.post('/api/events', authMiddleware", 'async function syncProjectStatus'],
    ['team event update shares', "app.put('/api/events/:id', authMiddleware", '// ── Ideas'],
    ['chat room create members', "app.post('/api/chat-rooms', authMiddleware", "app.put('/api/chat-rooms/:roomId'"],
    ['chat room add member', "app.post('/api/chat-rooms/:roomId/members', authMiddleware", "app.delete('/api/chat-rooms/:roomId/members/:userId'"],
    ['project create members', "app.post('/api/projects', authMiddleware", "app.get('/api/projects/:id'"],
    ['project update members', "app.put('/api/projects/:id', authMiddleware", "app.delete('/api/projects/:id'"],
  ]) {
    const handler = sourceBetween(INDEX_SOURCE, start, end);
    assertWorkspaceScoped(handler, label);
    assert.match(
      handler,
      /peakos_workspace_memberships|workspace_membership|assertUsersInWorkspace|sameWorkspace|workspace_id/i,
      `${label} must validate every target UID against active-workspace membership`,
    );
  }
});

test('direct canonical collaboration routes pass the active workspace through the global permission gate', () => {
  const areaResolver = sourceBetween(
    INDEX_SOURCE,
    'function collaborationAreaForPath(',
    'function workspacePermissionAllowsRequest(',
  );
  assert.match(areaResolver, /events\|event-types\|todo-cats[\s\S]*return ['"]calendar['"]/);
  assert.match(areaResolver, /chat\|chat-rooms\|chat-room-groups[\s\S]*return ['"]chat['"]/);
  assert.match(areaResolver, /projects[\s\S]*users\/all-approved[\s\S]*return ['"]projects['"]/);

  const permissionGate = sourceBetween(
    INDEX_SOURCE,
    'function workspacePermissionAllowsRequest(',
    'function normalizeReportAmountValue(',
  );
  assert.match(permissionGate, /GET['"],\s*['"]HEAD['"],\s*['"]OPTIONS/);
  assert.match(permissionGate, /permission\s*===\s*['"]write['"]/);
  assert.match(permissionGate, /headquartersOversight\s*!==\s*true/);

  const authGate = sourceBetween(
    INDEX_SOURCE,
    'async function authMiddleware(',
    '// Whitelist of API paths a chat_only user is allowed to hit.',
  );
  assert.match(authGate, /attachRequestWorkspace\s*\(req/);
  assert.match(authGate, /collaborationAreaForPath\s*\(req\.path\)/);
  assert.match(authGate, /workspacePermissionAllowsRequest\s*\(req,\s*collaborationArea\)/);
  assert.match(authGate, /status\s*\(403\)/);

  for (const route of [
    "app.post('/api/events', authMiddleware",
    "app.post('/api/chat-rooms', authMiddleware",
    "app.post('/api/projects', authMiddleware",
    "app.post('/api/projects/:id/tasks', authMiddleware",
  ]) {
    assert.match(INDEX_SOURCE, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('project update child mutations authorize the scoped parent before child lookup', () => {
  for (const [label, start, end] of [
    [
      'project update edit',
      "app.put('/api/projects/:id/updates/:updateId', authMiddleware",
      "app.delete('/api/projects/:id/updates/:updateId', authMiddleware",
    ],
    [
      'project update delete',
      "app.delete('/api/projects/:id/updates/:updateId', authMiddleware",
      "app.post('/api/projects/:id/comments', authMiddleware",
    ],
  ]) {
    const handler = sourceBetween(INDEX_SOURCE, start, end);
    const scopedParentGuard = handler.indexOf('canAccessProject(req, req.params.id)');
    const childLookup = handler.indexOf('project_updates');
    assert.ok(scopedParentGuard >= 0, `${label} must authorize the selected-workspace project`);
    assert.ok(childLookup >= 0, `${label} must look up the update child`);
    assert.ok(scopedParentGuard < childLookup, `${label} must authorize before reading the child row`);
  }
});

test('non-Peak chat/project uploads fail before multer and cannot mint a new public uploads URL', () => {
  const rejectGuard = sourceBetween(
    INDEX_SOURCE,
    'function rejectWorkspacePublicAttachment(',
    'function isNonPeakWorkspaceSafePath(',
  );
  assert.match(rejectGuard, /req\.workspace\?\.id\s*===\s*PEAK_WORKSPACE_ID/);
  assert.match(rejectGuard, /workspacePublicAttachmentMutation\s*\(req\)/);
  assert.match(rejectGuard, /status\s*\(403\)/);
  assert.match(rejectGuard, /WORKSPACE_PRIVATE_STORAGE_REQUIRED/);

  const authGate = sourceBetween(
    INDEX_SOURCE,
    'async function authMiddleware(',
    '// Whitelist of API paths a chat_only user is allowed to hit.',
  );
  const guardCalls = [...authGate.matchAll(/rejectWorkspacePublicAttachment\s*\(req,\s*res\)/g)];
  assert.equal(guardCalls.length, 2, 'canonical and rewritten collaboration auth paths both fail closed');
  assert.ok(guardCalls.every(match => authGate.indexOf('return next()', match.index) > match.index
    || authGate.indexOf('next();', match.index) > match.index));

  for (const routePattern of [
    /app\.post\('\/api\/chat-rooms\/:roomId\/upload',\s*authMiddleware,\s*upload\.single\('image'\)/,
    /app\.post\('\/api\/chat-rooms\/:roomId\/upload-file',\s*authMiddleware,\s*uploadFile\.single\('file'\)/,
    /app\.post\('\/api\/projects\/upload',\s*authMiddleware,\s*uploadJpgPng\.array\('images',\s*10\)/,
  ]) {
    assert.match(INDEX_SOURCE, routePattern, 'auth rejection must execute before the filesystem middleware');
  }
});

test('workspace directory filtering also covers room members and scheduled todo notifications', () => {
  const roomMembers = sourceBetween(
    INDEX_SOURCE,
    "app.get('/api/chat-rooms/:roomId/members', authMiddleware",
    "app.post('/api/chat-rooms/:roomId/members', authMiddleware",
  );
  assert.match(roomMembers, /peakos_workspace_memberships/);
  assert.match(roomMembers, /pwm\.workspace_id\s*=\s*COALESCE\(cr\.workspace_id/);
  assert.match(roomMembers, /pwm\.active\s*=\s*TRUE/);
  assert.match(roomMembers, /pwm\.role\s*<>\s*'oversight'/);

  const scheduledTodos = sourceBetween(
    INDEX_SOURCE,
    "scheduleCron('0 10 * * *'",
    '// ══ FCM 토큰 관리',
  );
  assert.match(scheduledTodos, /pwm\.is_default\s*=\s*TRUE/);
  assert.match(scheduledTodos, /pwm\.role\s*<>\s*'oversight'/);
  assert.ok(
    [...scheduledTodos.matchAll(/workspace_id\s*=\s*\$3\s+OR\s+\(workspace_id\s+IS\s+NULL\s+AND\s+\$3\s*=\s*\$4\)/g)].length >= 4,
    'morning/evening count and title queries must all bind the default workspace',
  );
});

test('Peak report reminders cannot select branch users or mutate branch calendar rows', () => {
  const reminderSync = sourceBetween(
    INDEX_SOURCE,
    'async function softDeleteEventIds(',
    'async function ensureReportReminderInfrastructure(',
  );
  assert.match(reminderSync, /JOIN peakos_workspace_memberships pwm/);
  assert.match(reminderSync, /pwm\.workspace_id\s*=\s*\$1/);
  assert.match(reminderSync, /pwm\.is_default\s*=\s*TRUE/);
  assert.match(reminderSync, /pwm\.role\s*<>\s*'oversight'/);
  assert.ok(
    [...reminderSync.matchAll(/workspace_id\s*=\s*\$\d+/g)].length >= 2,
    'existing reminder reads and deletes must bind a workspace',
  );
  assert.match(reminderSync, /INSERT INTO events \(workspace_id,type,title,date/);
  assert.match(reminderSync, /params\.push\(PEAK_WORKSPACE_ID/);

  for (const [label, start, end] of [
    ['daily report submit', "app.post('/api/reports', authMiddleware", "app.put('/api/reports/:id', authMiddleware"],
    ['daily report edit', "app.put('/api/reports/:id', authMiddleware", "app.get('/api/reports/:id/entries', authMiddleware"],
    ['monthly report submit', "app.post('/api/monthly-reports', authMiddleware", '// ── 할 일 순서/카테고리 변경'],
    ['work report submit', "app.post('/api/work-reports', authMiddleware", '// ── 팀원 보고서 제출 현황'],
  ]) {
    const handler = sourceBetween(INDEX_SOURCE, start, end);
    assert.match(handler, /UPDATE events[\s\S]*workspace_id/, `${label} completion must stay in Peak`);
    if (/INSERT INTO events/.test(handler)) {
      assert.match(handler, /INSERT INTO events \(workspace_id/, `${label} notification must carry ws_peak`);
    }
  }
});

test('workspace readiness runs before any write-capable startup ensure helper', () => {
  const startup = sourceBetween(INDEX_SOURCE, 'async function startServer()', 'startServer();');
  const readiness = startup.indexOf('ensurePeakosWorkspaceInfrastructure(pool)');
  const firstWriteCapableEnsure = startup.indexOf('ensureReminderInfrastructure()');
  assert.ok(readiness >= 0, 'startup must perform workspace readiness');
  assert.ok(firstWriteCapableEnsure >= 0, 'startup must retain infrastructure initialization');
  assert.ok(readiness < firstWriteCapableEnsure, 'readiness must fail before startup writes');
  assert.equal(
    [...startup.matchAll(/ensurePeakosWorkspaceInfrastructure\(pool\)/g)].length,
    1,
    'readiness should run exactly once',
  );
});

test('non-Peak settlement manager capability is role-scoped and monthly owner routes stay fail-closed', () => {
  const policy = sourceBetween(
    INDEX_SOURCE,
    'const peakosIsNonPeakSettlementManager =',
    'const peakosCanSeeTeamFinance =',
  );
  assert.match(policy, /req\.workspace\.id\s*!==\s*PEAK_WORKSPACE_ID/);
  assert.match(policy, /headquartersOversight\s*!==\s*true/);
  assert.match(policy, /permissions\?\.settlements\s*===\s*'write'/);
  assert.match(policy, /\['admin', 'manager'\]\.includes\(req\.workspace\.role\)/);
  const settlementRegistration = sourceBetween(
    INDEX_SOURCE,
    'registerPeakosSettlementRoutes({',
    '// 단가표는 회사 공용.',
  );
  assert.match(settlementRegistration, /canSeeAll:\s*peakosCanSeeWorkspaceSettlementAll/);
  assert.match(settlementRegistration, /canSeeFinalExecution:\s*peakosCanSeeWorkspaceFinalExecution/);
  assert.match(SETTLEMENT_SOURCE, /PEAKOS_BRANCH_MONTHLY_OWNER_REQUIRED/);
});

test('restricted collaboration accounts can reach only their matching protected aliases', () => {
  const chatOnly = sourceBetween(
    INDEX_SOURCE,
    'function isChatOnlyAllowedPath(',
    'function isExternalCalendarAllowedPath(',
  );
  assert.match(chatOnly, /peakos\\?\/collaboration[\s\S]*chat-rooms/);
  assert.match(chatOnly, /users\\?\/all-approved/);
  assert.doesNotMatch(chatOnly, /projects/);
  assert.doesNotMatch(chatOnly, /events\|event-types/);

  const externalCalendar = sourceBetween(
    INDEX_SOURCE,
    'function isExternalCalendarAllowedPath(',
    'function isExternalCalendarUser(',
  );
  assert.match(externalCalendar, /events\|event-types\|todo-cats/);
  assert.doesNotMatch(externalCalendar, /projects/);
});
