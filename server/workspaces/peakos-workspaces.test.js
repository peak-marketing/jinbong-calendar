'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  DIRECT_PERMISSIONS,
  MIGRATION_PATH,
  OVERSIGHT_PERMISSIONS,
  PEAK_WORKSPACE_ID,
  REQUIRED_COMPOSITE_PRIMARY_KEYS,
  REQUIRED_WORKSPACE_COLUMNS,
  WORKSPACES,
  createPeakosWorkspaceService,
  ensurePeakosWorkspaceInfrastructure,
  normalizeWorkspaceSlug,
  parseAccessUidMap,
  permissionAllows,
  readWorkspaceSlugHeader,
  workspacePublicAttachmentMutation,
  workspaceSlugForGroup,
} = require('./peakos-workspaces');

const ACCESS = Object.freeze({
  패션TV봉이: 'uid-fashion-tv',
  박종원: 'uid-park-jongwon',
  김대호: 'uid-kim-daeho',
  손명아: 'uid-son-myeonga',
});

test('워크스페이스 slug와 헤더는 엄격한 소문자 slug만 받는다', () => {
  assert.equal(normalizeWorkspaceSlug(' Daegu '), 'daegu');
  assert.equal(normalizeWorkspaceSlug('../peak'), null);
  assert.equal(normalizeWorkspaceSlug('peak/other'), null);
  assert.equal(readWorkspaceSlugHeader({ headers: { 'x-peakos-workspace': 'jeonju' } }), 'jeonju');
});

test('본사 열람 권한은 프로젝트·정산·자료·마스킹 영업 읽기만 허용한다', () => {
  assert.deepEqual(OVERSIGHT_PERMISSIONS, {
    calendar: 'none', chat: 'none', projects: 'read', settlements: 'read', documents: 'read', sales: 'read',
  });
  assert.equal(permissionAllows(OVERSIGHT_PERMISSIONS.projects, 'read'), true);
  assert.equal(permissionAllows(OVERSIGHT_PERMISSIONS.projects, 'write'), false);
  assert.equal(permissionAllows(OVERSIGHT_PERMISSIONS.chat, 'read'), false);
  assert.equal(permissionAllows(OVERSIGHT_PERMISSIONS.sales, 'write'), false);
  assert.equal(DIRECT_PERMISSIONS.documents, 'read');
});

test('exact4 UID는 환경의 검증된 UID만 사용하고 표시이름을 권한으로 쓰지 않는다', () => {
  const map = parseAccessUidMap({ PEAKOS_ACCESS_UIDS_JSON: JSON.stringify(ACCESS) });
  assert.deepEqual([...map.values()], Object.values(ACCESS));
  assert.throws(
    () => parseAccessUidMap({ PEAKOS_ACCESS_UIDS_JSON: JSON.stringify({ ...ACCESS, 손명아: ACCESS.김대호 }) }),
    /누락·중복/,
  );
});

test('migration은 네 workspace를 seed하고 BuildSolution에 암묵적 member를 만들지 않는다', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  for (const workspace of WORKSPACES) {
    assert.match(sql, new RegExp(`'${workspace.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }
  assert.match(sql, /initial-direct-memberships-v1/);
  assert.match(sql, /buildSolutionMembers":0/);
  assert.doesNotMatch(sql, /WHEN COALESCE\(g\.name, ''\).*빌드/s);
  assert.match(sql, /UPDATE peakos_price SET workspace_id = 'ws_peak'/);
  assert.match(sql, /PRIMARY KEY \(workspace_id, key\)/);
});

test('본사와 지사 workspace 이름은 로그인 화면에서 명확히 구분된다', () => {
  assert.deepEqual(
    Object.fromEntries(WORKSPACES.map(workspace => [workspace.slug, workspace.name])),
    {
      peak: '피크마케팅 본사',
      'build-solution': '빌드솔루션',
      jeonju: '피크마케팅 전주지사',
      daegu: '피크마케팅 대구지사',
    },
  );
  const labelMigration = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '20260810_peakos_workspace_labels.sql'),
    'utf8',
  );
  assert.match(labelMigration, /WHEN 'daegu' THEN '피크마케팅 대구지사'/);
  assert.match(labelMigration, /WHEN 'jeonju' THEN '피크마케팅 전주지사'/);
});

test('서버 startup은 owner DDL을 재실행하지 않고 workspace schema readiness만 검사한다', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ text, params });
      if (text.startsWith('WITH required')) return { rows: [] };
      if (text.startsWith('SELECT id, slug FROM peakos_workspaces')) {
        return { rows: WORKSPACES.map(({ id, slug }) => ({ id, slug })) };
      }
      if (text.startsWith('SELECT relation.relname')) {
        return { rows: Object.entries(REQUIRED_COMPOSITE_PRIMARY_KEYS)
          .map(([table_name, definition]) => ({ table_name, definition })) };
      }
      throw new Error(`unexpected readiness query: ${text}`);
    },
  };
  assert.deepEqual(await ensurePeakosWorkspaceInfrastructure(pool), {
    checkedColumns: REQUIRED_WORKSPACE_COLUMNS.length,
    workspaces: WORKSPACES.length,
  });
  const sql = calls.map(call => call.text).join('\n');
  assert.doesNotMatch(sql, /\b(?:ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|GRANT)\b/i);
});

test('workspace schema가 덜 적용되면 startup readiness가 fail closed한다', async () => {
  const pool = {
    async query() {
      return { rows: [{ table_name: 'events', column_name: 'workspace_id' }] };
    },
  };
  await assert.rejects(
    ensurePeakosWorkspaceInfrastructure(pool),
    error => error.code === 'PEAKOS_WORKSPACE_MIGRATION_REQUIRED' && /events\.workspace_id/.test(error.message),
  );
});

test('membership resolver는 선택 UID+slug 조합만 허용하고 default는 oversight를 제외한다', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (String(sql).includes("m.role <> 'oversight'")) {
        if (params[0] !== 'branch-user') return { rows: [] };
        return { rows: [{
          workspace_id: 'ws_daegu', slug: 'daegu', name: '대구지사', kind: 'branch',
          membership_role: 'member', permissions: DIRECT_PERMISSIONS, is_default: true,
        }] };
      }
      throw new Error('unexpected query');
    },
  };
  const service = createPeakosWorkspaceService({ pool, environment: { PEAKOS_ACCESS_UIDS_JSON: JSON.stringify(ACCESS) } });
  const workspace = await service.resolveForUser('branch-user', 'daegu');
  assert.equal(workspace.id, 'ws_daegu');
  await assert.rejects(() => service.resolveForUser('branch-user', 'peak'), error => (
    error.code === 'PEAKOS_WORKSPACE_FORBIDDEN'
  ));
  assert.equal(await service.resolveDefaultForUser('oversight-only'), null);
  assert.ok(calls.every(call => !call.params?.includes('피크마케팅')));
});

test('exact4 UID만 전체 workspace를 보고 일반 계정은 canonical direct workspace 하나만 접근한다', async () => {
  const directPermissions = { ...DIRECT_PERMISSIONS };
  const membershipRows = Object.freeze({
    [ACCESS['패션TV봉이']]: [
      {
        workspace_id: 'ws_peak', slug: 'peak', name: '피크마케팅 본사', kind: 'headquarters',
        membership_role: 'admin', permissions: directPermissions, is_default: true,
        created_at: '2026-01-01',
      },
      ...WORKSPACES.filter(workspace => workspace.id !== PEAK_WORKSPACE_ID).map(workspace => ({
        workspace_id: workspace.id, slug: workspace.slug, name: workspace.name, kind: workspace.kind,
        membership_role: 'oversight', permissions: OVERSIGHT_PERMISSIONS, is_default: false,
        created_at: '2026-01-02',
      })),
    ],
    'ordinary-hq': [
      {
        workspace_id: 'ws_peak', slug: 'peak', name: '피크마케팅 본사', kind: 'headquarters',
        membership_role: 'admin', permissions: directPermissions, is_default: true,
        created_at: '2026-01-01',
      },
      {
        workspace_id: 'ws_daegu', slug: 'daegu', name: '피크마케팅 대구지사', kind: 'branch',
        membership_role: 'manager', permissions: directPermissions, is_default: false,
        created_at: '2026-01-02',
      },
      {
        workspace_id: 'ws_jeonju', slug: 'jeonju', name: '피크마케팅 전주지사', kind: 'branch',
        membership_role: 'oversight', permissions: OVERSIGHT_PERMISSIONS, is_default: false,
        created_at: '2026-01-03',
      },
    ],
    'ordinary-branch': [{
      workspace_id: 'ws_daegu', slug: 'daegu', name: '피크마케팅 대구지사', kind: 'branch',
      membership_role: 'member', permissions: directPermissions, is_default: true,
      created_at: '2026-01-01',
    }],
  });
  const calls = [];
  const pool = {
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ text, params });
      if (text.includes("m.role <> 'oversight'") && text.includes('LIMIT 1')) {
        const direct = (membershipRows[params[0]] || [])
          .filter(row => row.membership_role !== 'oversight')
          .sort((left, right) => Number(right.is_default) - Number(left.is_default)
            || String(left.created_at).localeCompare(String(right.created_at))
            || left.slug.localeCompare(right.slug));
        return { rows: direct.slice(0, 1) };
      }
      if (text.includes('CASE WHEN w.id = $2 THEN 0 ELSE 1 END')) {
        return { rows: [...(membershipRows[params[0]] || [])] };
      }
      if (text.includes('WHERE w.slug = $1')) {
        return { rows: (membershipRows[params[1]] || []).filter(row => row.slug === params[0]) };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const service = createPeakosWorkspaceService({
    pool,
    environment: { PEAKOS_ACCESS_UIDS_JSON: JSON.stringify(ACCESS) },
  });

  assert.equal(service.canAccessWorkspacePortfolio(ACCESS['패션TV봉이']), true);
  assert.equal(service.canAccessWorkspacePortfolio('ordinary-hq'), false);
  assert.deepEqual(
    (await service.listForUser(ACCESS['패션TV봉이'])).map(workspace => workspace.slug).sort(),
    WORKSPACES.map(workspace => workspace.slug).sort(),
  );
  assert.deepEqual((await service.listForUser('ordinary-hq')).map(workspace => workspace.slug), ['peak']);
  assert.deepEqual((await service.listForUser('ordinary-branch')).map(workspace => workspace.slug), ['daegu']);

  const oversight = await service.resolveForUser(ACCESS['패션TV봉이'], 'daegu');
  assert.equal(oversight.role, 'oversight');
  assert.equal((await service.resolveForUser('ordinary-hq', 'peak')).slug, 'peak');
  assert.equal((await service.resolveForUser('ordinary-branch', 'daegu')).slug, 'daegu');
  await assert.rejects(
    service.resolveForUser('ordinary-hq', 'daegu'),
    error => error.code === 'PEAKOS_WORKSPACE_FORBIDDEN' && error.statusCode === 403,
  );
  await assert.rejects(
    service.resolveForUser('ordinary-branch', 'peak'),
    error => error.code === 'PEAKOS_WORKSPACE_FORBIDDEN' && error.statusCode === 403,
  );
  assert.equal(calls.some(call => call.params?.includes('ordinary-hq') && call.params?.includes('daegu')), false);

  const runHeaderRequest = async req => {
    const capture = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
      set() { return this; },
      vary() { return this; },
    };
    let nextCalls = 0;
    await service.requireWorkspace({ area: 'projects', action: 'read', requireHeader: true })(
      req,
      capture,
      () => { nextCalls += 1; },
    );
    return { capture, nextCalls };
  };
  const spoofedName = await runHeaderRequest({
    uid: 'ordinary-hq',
    method: 'GET',
    headers: { 'x-peakos-workspace': 'daegu' },
    userDoc: { name: '패션TV봉이', role: 'admin', approved: true, is_active: true },
  });
  assert.equal(spoofedName.nextCalls, 0);
  assert.equal(spoofedName.capture.statusCode, 403);
  assert.equal(spoofedName.capture.payload.code, 'PEAKOS_WORKSPACE_FORBIDDEN');

  const exactUid = await runHeaderRequest({
    uid: ACCESS['패션TV봉이'],
    method: 'GET',
    headers: { 'x-peakos-workspace': 'daegu' },
    userDoc: { name: '표시이름 변경됨', role: 'member', approved: true, is_active: true },
  });
  assert.equal(exactUid.nextCalls, 1);
  assert.equal(exactUid.capture.statusCode, 200);

  const missingConfiguration = createPeakosWorkspaceService({ pool, environment: {} });
  assert.equal(missingConfiguration.canAccessWorkspacePortfolio(ACCESS['패션TV봉이']), false);
  assert.deepEqual(
    (await missingConfiguration.listForUser(ACCESS['패션TV봉이'])).map(workspace => workspace.slug),
    ['peak'],
  );
});

test('초대 대상은 같은 direct workspace membership 전체가 확인되어야 한다', async () => {
  const pool = {
    async query(sql, params) {
      assert.match(String(sql), /m\.workspace_id = \$1/);
      assert.match(String(sql), /m\.role <> 'oversight'/);
      return { rows: params[1].includes('outside') ? [{ uid: 'inside' }] : params[1].map(uid => ({ uid })) };
    },
  };
  const service = createPeakosWorkspaceService({ pool });
  assert.deepEqual(await service.assertUsersInWorkspace(['inside'], 'ws_daegu'), ['inside']);
  await assert.rejects(
    () => service.assertUsersInWorkspace(['inside', 'outside'], 'ws_daegu'),
    error => error.code === 'PEAKOS_CROSS_WORKSPACE_MEMBER_FORBIDDEN',
  );
});

test('workspaceId는 요청 context 없이는 peak로 자동 fallback하지 않는다', () => {
  const service = createPeakosWorkspaceService({ pool: { query: async () => ({ rows: [] }) } });
  assert.equal(service.workspaceId({ workspace: { id: PEAK_WORKSPACE_ID } }), PEAK_WORKSPACE_ID);
  assert.throws(() => service.workspaceId({}), error => error.code === 'PEAKOS_WORKSPACE_REQUIRED');
});

test('지사 public uploads로 이어지는 협업 첨부 mutation만 fail-closed 대상으로 식별한다', () => {
  assert.equal(workspacePublicAttachmentMutation({ method: 'POST', path: '/api/chat-rooms/room-1/upload' }), true);
  assert.equal(workspacePublicAttachmentMutation({ method: 'POST', path: '/api/chat-rooms/room-1/upload-file' }), true);
  assert.equal(workspacePublicAttachmentMutation({ method: 'POST', path: '/api/projects/upload' }), true);
  assert.equal(workspacePublicAttachmentMutation({ method: 'GET', path: '/api/chat-rooms/room-1/upload' }), false);
  assert.equal(workspacePublicAttachmentMutation({ method: 'POST', path: '/api/chat-rooms/room-1/messages' }), false);
});

test('지사 추론은 immutable group id 또는 명시적 slug만 사용한다', () => {
  assert.equal(workspaceSlugForGroup({ groupId: 'daegu' }), 'daegu');
  assert.equal(workspaceSlugForGroup({ groupId: 'jeonju' }), 'jeonju');
  assert.equal(workspaceSlugForGroup({ groupId: 'unknown', groupName: '대구지사' }), 'peak');
  assert.equal(workspaceSlugForGroup({ groupId: null, workspaceSlug: 'build-solution' }), 'build-solution');
});

test('role 변경은 supplied transaction 안에서 기존 BuildSolution default를 보존한다', async () => {
  let insertedWorkspace = null;
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes('SELECT u.uid, u.role, u.group_id')) {
        return { rows: [{ uid: 'build-user', role: 'member', group_id: null }] };
      }
      if (text.includes('SELECT w.slug')) return { rows: [{ slug: 'build-solution' }] };
      if (text.includes('SELECT workspace_id, role, permissions, is_default, active')) {
        return { rows: [{ workspace_id: 'ws_build_solution', role: 'member', permissions: {}, is_default: true, active: true }] };
      }
      if (text.includes('INSERT INTO peakos_workspace_memberships')) {
        insertedWorkspace = params[0];
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('UPDATE peakos_workspace_memberships')
          || text.includes('INSERT INTO peakos_workspace_membership_audit')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    },
  };
  const pool = {
    query: async () => { throw new Error('supplied transaction 밖 query 금지'); },
    connect: async () => { throw new Error('추가 connection 금지'); },
  };
  const service = createPeakosWorkspaceService({ pool });
  const result = await service.syncUserDefaultMembership({
    actorUid: 'admin-uid',
    targetUid: 'build-user',
    role: 'manager',
    client,
  });
  assert.equal(result.slug, 'build-solution');
  assert.equal(result.role, 'manager');
  assert.equal(insertedWorkspace, 'ws_build_solution');
});

test('소속 이동은 실제로 빠지는 workspace의 역할 없는 활성 프로젝트 팀원도 원자적으로 차단한다', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ text, params });
      if (text.includes('SELECT u.uid, u.role, u.group_id')) {
        return { rows: [{ uid: 'project-owner', role: 'member', group_id: 'daegu' }] };
      }
      if (text.includes('SELECT workspace_id, role, permissions, is_default, active')) {
        return { rows: [
          { workspace_id: 'ws_daegu', role: 'member', permissions: {}, is_default: true, active: true },
          { workspace_id: 'ws_peak', role: 'member', permissions: {}, is_default: false, active: true },
        ] };
      }
      if (text.includes('WITH active_responsibilities AS')) {
        assert.equal(params[0], 'project-owner');
        assert.deepEqual(params[1], ['ws_daegu']);
        return { rows: [{
          workspace_id: 'ws_daegu',
          project_id: '11111111-1111-4111-8111-111111111111',
          project_name: '매출',
          responsibility: 'project_member',
        }] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const service = createPeakosWorkspaceService({ pool: { query: async () => ({ rows: [] }) } });

  await assert.rejects(
    service.syncUserDefaultMembership({
      actorUid: 'admin-uid',
      targetUid: 'project-owner',
      workspaceSlug: 'peak',
      client,
    }),
    error => (
      error.code === 'PEAKOS_WORKSPACE_MEMBER_HAS_ACTIVE_PROJECT_RESPONSIBILITY'
      && error.statusCode === 409
      && /책임 역할/.test(error.message)
    ),
  );
  assert.equal(calls.some(call => call.text.startsWith('UPDATE peakos_workspace_memberships')), false);
  assert.equal(calls.some(call => call.text.startsWith('INSERT INTO peakos_workspace_membership_audit')), false);
});

test('같은 workspace 재할당은 프로젝트 책임 가드 없이 허용한다', async () => {
  let guardQueries = 0;
  const client = {
    async query(sql) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.includes('SELECT u.uid, u.role, u.group_id')) {
        return { rows: [{ uid: 'same-user', role: 'member', group_id: 'daegu' }] };
      }
      if (text.includes('SELECT workspace_id, role, permissions, is_default, active')) {
        return { rows: [{
          workspace_id: 'ws_daegu', role: 'member', permissions: {}, is_default: true, active: true,
        }] };
      }
      if (text.includes('WITH active_responsibilities AS')) guardQueries += 1;
      return { rows: [], rowCount: 1 };
    },
  };
  const service = createPeakosWorkspaceService({ pool: { query: async () => ({ rows: [] }) } });

  const result = await service.syncUserDefaultMembership({
    actorUid: 'admin-uid',
    targetUid: 'same-user',
    workspaceSlug: 'daegu',
    client,
  });
  assert.equal(result.workspace_id, 'ws_daegu');
  assert.equal(guardQueries, 0);
});

test('계정 비활성화는 활성 프로젝트의 중분류 책임자와 미완료 task 역할을 모두 검사한다', async () => {
  const calls = [];
  const client = {
    release() {},
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ text, params });
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('SELECT workspace_id, role, permissions, is_default, active')) {
        return { rows: [
          { workspace_id: 'ws_peak', role: 'member', permissions: {}, is_default: true, active: true },
          { workspace_id: 'ws_daegu', role: 'oversight', permissions: {}, is_default: false, active: true },
          { workspace_id: 'ws_jeonju', role: 'member', permissions: {}, is_default: false, active: false },
        ] };
      }
      if (text.includes('WITH active_responsibilities AS')) {
        assert.deepEqual(params, ['reviewer-user', ['ws_peak']]);
        return { rows: [{
          workspace_id: 'ws_peak',
          project_id: '22222222-2222-4222-8222-222222222222',
          project_name: '매출',
          responsibility: 'open_task',
        }] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const pool = { query: async () => ({ rows: [] }), connect: async () => client };
  const service = createPeakosWorkspaceService({ pool });

  await assert.rejects(
    service.setUserMembershipsActive({ actorUid: 'admin-uid', targetUid: 'reviewer-user', active: false }),
    error => error.code === 'PEAKOS_WORKSPACE_MEMBER_HAS_ACTIVE_PROJECT_RESPONSIBILITY',
  );
  const guard = calls.find(call => call.text.includes('WITH active_responsibilities AS'));
  assert.ok(guard);
  assert.match(guard.text, /project\.status = 'active'/);
  assert.match(guard.text, /FROM peakos_structured_project_members project_member/);
  assert.match(guard.text, /project_member\.active = TRUE/);
  assert.match(guard.text, /project_member\.user_uid = \$1/);
  assert.match(guard.text, /medium\.active = TRUE/);
  assert.match(guard.text, /medium\.manager_uid = \$1/);
  assert.match(guard.text, /task\.status <> 'done'/);
  assert.match(guard.text, /task\.assignee_uid, task\.assigned_by_uid, task\.reviewer_uid/);
  assert.equal(calls.some(call => call.text.startsWith('UPDATE peakos_workspace_memberships')), false);
  assert.equal(calls.at(-1).text, 'ROLLBACK');
});

test('활성 프로젝트·영업 책임이 없으면 기존 membership 비활성화와 감사 기록을 계속 수행한다', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ text, params });
      if (text.includes('SELECT workspace_id, role, permissions, is_default, active')) {
        return { rows: [{
          workspace_id: 'ws_peak', role: 'member', permissions: {}, is_default: true, active: true,
        }] };
      }
      if (text.includes('WITH active_responsibilities AS')) return { rows: [] };
      if (text.startsWith('UPDATE peakos_workspace_memberships')
          || text.startsWith('INSERT INTO peakos_workspace_membership_audit')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const service = createPeakosWorkspaceService({ pool: { query: async () => ({ rows: [] }) } });

  assert.equal(await service.setUserMembershipsActive({
    actorUid: 'admin-uid', targetUid: 'free-user', active: false, client,
  }), 1);
  assert.equal(calls.some(call => call.text.startsWith('UPDATE peakos_workspace_memberships')), true);
  assert.equal(calls.some(call => call.text.startsWith('INSERT INTO peakos_workspace_membership_audit')), true);
});

test('활성 영업 리드 담당자를 제한 계정으로 바꾸면 user·membership 잠금 뒤 409로 차단한다', async () => {
  const calls = [];
  const client = {
    release() {},
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ text, params });
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('FROM users') && text.includes('FOR UPDATE')) {
        return { rows: [{ uid: 'sales-owner', role: 'member' }] };
      }
      if (text.includes('FROM peakos_workspace_memberships') && text.includes('FOR UPDATE')) {
        return { rows: [{ workspace_id: 'ws_daegu', role: 'member', active: true }] };
      }
      if (text.includes('WITH active_responsibilities AS')) {
        assert.deepEqual(params, ['sales-owner', ['ws_daegu']]);
        assert.match(text, /FROM peakos_sales_leads sales_lead/);
        assert.match(text, /sales_lead\.archived_at IS NULL/);
        assert.match(text, /sales_lead\.owner_uid = \$1/);
        return { rows: [{
          workspace_id: 'ws_daegu',
          project_id: '55555555-5555-4555-8555-555555555555',
          project_name: '활성 리드',
          responsibility: 'active_sales_lead_owner',
        }] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const service = createPeakosWorkspaceService({
    pool: { query: async () => ({ rows: [] }), connect: async () => client },
  });

  await assert.rejects(
    service.setUserRestrictionMode({
      actorUid: 'admin-uid', targetUid: 'sales-owner', mode: 'external_calendar_only', enabled: true,
    }),
    error => (
      error.code === 'PEAKOS_WORKSPACE_MEMBER_HAS_ACTIVE_PROJECT_RESPONSIBILITY'
      && error.statusCode === 409
      && /영업 리드 담당/.test(error.message)
      && /이전/.test(error.message)
    ),
  );
  const userLock = calls.findIndex(call => /FROM users/.test(call.text) && /FOR UPDATE/.test(call.text));
  const membershipLock = calls.findIndex(call => (
    /FROM peakos_workspace_memberships/.test(call.text) && /FOR UPDATE/.test(call.text)
  ));
  const dependencyCheck = calls.findIndex(call => call.text.includes('WITH active_responsibilities AS'));
  assert.ok(userLock >= 0 && userLock < membershipLock && membershipLock < dependencyCheck);
  assert.equal(calls.some(call => call.text.startsWith('UPDATE users SET external_calendar_only')), false);
  assert.equal(calls.at(-1).text, 'ROLLBACK');
});

test('보관된 영업 리드만 남은 담당자는 membership 비활성화를 막지 않는다', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ text, params });
      if (text.includes('SELECT workspace_id, role, permissions, is_default, active')) {
        return { rows: [{
          workspace_id: 'ws_daegu', role: 'member', permissions: {}, is_default: true, active: true,
        }] };
      }
      if (text.includes('WITH active_responsibilities AS')) {
        assert.match(text, /sales_lead\.archived_at IS NULL/);
        return { rows: [] };
      }
      if (text.startsWith('UPDATE peakos_workspace_memberships')
          || text.startsWith('INSERT INTO peakos_workspace_membership_audit')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const service = createPeakosWorkspaceService({ pool: { query: async () => ({ rows: [] }) } });

  assert.equal(await service.setUserMembershipsActive({
    actorUid: 'admin-uid', targetUid: 'archived-lead-owner', active: false, client,
  }), 1);
  assert.equal(calls.some(call => call.text.startsWith('UPDATE peakos_workspace_memberships')), true);
  assert.equal(calls.some(call => call.text.startsWith('INSERT INTO peakos_workspace_membership_audit')), true);
});

test('기존 승인 프로젝트 팀원을 제한 계정으로 바꾸면 user·membership 잠금 뒤 409로 원자적 차단한다', async () => {
  const calls = [];
  const client = {
    release() {},
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ text, params });
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('FROM users') && text.includes('FOR UPDATE')) {
        return { rows: [{ uid: 'approved-member', role: 'member' }] };
      }
      if (text.includes('FROM peakos_workspace_memberships') && text.includes('FOR UPDATE')) {
        return { rows: [{ workspace_id: 'ws_peak', role: 'member', active: true }] };
      }
      if (text.includes('WITH active_responsibilities AS')) {
        return { rows: [{
          workspace_id: 'ws_peak', project_id: '11111111-1111-4111-8111-111111111111',
          project_name: '매출', responsibility: 'project_member',
        }] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const service = createPeakosWorkspaceService({
    pool: { query: async () => ({ rows: [] }), connect: async () => client },
  });

  await assert.rejects(
    service.setUserRestrictionMode({
      actorUid: 'admin-uid', targetUid: 'approved-member', mode: 'chat_only', enabled: true,
    }),
    error => (
      error.code === 'PEAKOS_WORKSPACE_MEMBER_HAS_ACTIVE_PROJECT_RESPONSIBILITY'
      && error.statusCode === 409
    ),
  );
  const userLock = calls.findIndex(call => /FROM users/.test(call.text) && /FOR UPDATE/.test(call.text));
  const membershipLock = calls.findIndex(call => (
    /FROM peakos_workspace_memberships/.test(call.text) && /FOR UPDATE/.test(call.text)
  ));
  const dependencyCheck = calls.findIndex(call => call.text.includes('WITH active_responsibilities AS'));
  assert.ok(userLock >= 0 && userLock < membershipLock && membershipLock < dependencyCheck);
  assert.equal(calls.some(call => call.text.startsWith('UPDATE users SET chat_only')), false);
  assert.equal(calls.at(-1).text, 'ROLLBACK');
});

test('제한 계정 해제는 기존 프로젝트 책임과 관계없이 허용하고 같은 transaction에서 커밋한다', async () => {
  const calls = [];
  const client = {
    release() {},
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ text, params });
      if (text === 'BEGIN' || text === 'COMMIT') return { rows: [] };
      if (text.includes('FROM users') && text.includes('FOR UPDATE')) {
        return { rows: [{ uid: 'restricted-admin', role: 'admin' }] };
      }
      if (text.includes('FROM peakos_workspace_memberships') && text.includes('FOR UPDATE')) {
        return { rows: [{ workspace_id: 'ws_peak', role: 'admin', active: true }] };
      }
      if (text.startsWith('UPDATE users SET external_calendar_only')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const service = createPeakosWorkspaceService({
    pool: { query: async () => ({ rows: [] }), connect: async () => client },
  });

  assert.deepEqual(await service.setUserRestrictionMode({
    actorUid: 'admin-uid',
    targetUid: 'restricted-admin',
    mode: 'external_calendar_only',
    enabled: false,
  }), {
    uid: 'restricted-admin', mode: 'external_calendar_only', enabled: false,
  });
  assert.equal(calls.some(call => call.text.includes('WITH active_responsibilities AS')), false);
  assert.equal(calls.at(-1).text, 'COMMIT');
});
