'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
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

test('본사 열람 권한은 프로젝트·정산·자료 읽기만 허용한다', () => {
  assert.deepEqual(OVERSIGHT_PERMISSIONS, {
    calendar: 'none', chat: 'none', projects: 'read', settlements: 'read', documents: 'read',
  });
  assert.equal(permissionAllows(OVERSIGHT_PERMISSIONS.projects, 'read'), true);
  assert.equal(permissionAllows(OVERSIGHT_PERMISSIONS.projects, 'write'), false);
  assert.equal(permissionAllows(OVERSIGHT_PERMISSIONS.chat, 'read'), false);
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
      if (String(sql).includes('WHERE w.slug = $1')) {
        if (params[0] !== 'daegu' || params[1] !== 'branch-user') return { rows: [] };
        return { rows: [{
          workspace_id: 'ws_daegu', slug: 'daegu', name: '대구지사', kind: 'branch',
          membership_role: 'member', permissions: DIRECT_PERMISSIONS, is_default: true,
        }] };
      }
      if (String(sql).includes("m.role <> 'oversight'")) return { rows: [] };
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
