'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');

const {
  createContext,
  ensurePeakosNewProjectInfrastructure,
  mapTask,
  registerPeakosNewProjectRoutes,
} = require('./peakos-new-project-routes');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const MEDIUM_ID = '33333333-3333-4333-8333-333333333333';

function req({
  uid = 'ordinary-uid',
  name = '김대호',
  workspaceId = 'ws_peak',
  workspaceRole = 'member',
  oversight = false,
  preview = false,
} = {}) {
  return {
    uid,
    userName: name,
    userDoc: { name, approved: true, is_active: true, role: 'admin' },
    workspace: {
      id: workspaceId,
      role: workspaceRole,
      headquartersOversight: oversight,
    },
    headers: preview ? { 'x-peakos-preview': '1' } : {},
    get(header) { return this.headers[String(header).toLowerCase()]; },
  };
}

function makePool({ query, connect } = {}) {
  return {
    query: query || (async () => ({ rows: [] })),
    connect: connect || (async () => ({ query: async () => ({ rows: [] }), release() {} })),
  };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function call(server, pathname, { method = 'GET', body, headers = {} } = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function appWithActor(
  pool,
  actor,
  isPortfolioViewer = () => false,
  isPortfolioCreator = isPortfolioViewer,
) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    Object.assign(request, actor);
    next();
  });
  registerPeakosNewProjectRoutes({
    app,
    pool,
    peakWorkspaceId: 'ws_peak',
    isPortfolioViewer,
    isPortfolioCreator,
  });
  return app;
}

test('immutable UID creates portfolio capability even after display-name changes, while name spoofing cannot', () => {
  const portfolio = new Set(['exact-fashion-uid', 'exact-park-uid', 'exact-kim-uid']);
  const renamed = createContext(req({ uid: 'exact-kim-uid', name: '변경된 표시이름' }), {
    peakWorkspaceId: 'ws_peak',
    isPortfolioViewer: request => portfolio.has(String(request.uid)),
    isPortfolioCreator: request => portfolio.has(String(request.uid)),
  });
  assert.equal(renamed.viewPortfolio, true);
  assert.equal(renamed.canCreateProject, true);

  const spoofed = createContext(req({ uid: 'ordinary-uid', name: '패션TV봉이' }), {
    peakWorkspaceId: 'ws_peak',
    isPortfolioViewer: request => portfolio.has(String(request.uid)),
    isPortfolioCreator: request => portfolio.has(String(request.uid)),
  });
  assert.equal(spoofed.viewPortfolio, false);
  assert.equal(spoofed.canCreateProject, false);

  const branchManager = createContext(req({
    uid: 'branch-manager', workspaceId: 'ws_daegu', workspaceRole: 'manager',
  }), {
    peakWorkspaceId: 'ws_peak',
    isPortfolioViewer: request => portfolio.has(String(request.uid)),
    isPortfolioCreator: request => portfolio.has(String(request.uid)),
  });
  assert.equal(branchManager.viewPortfolio, true);
  assert.equal(branchManager.canCreateProject, true);

  const oversight = createContext(req({
    uid: 'exact-kim-uid', workspaceId: 'ws_daegu', workspaceRole: 'oversight', oversight: true,
  }), {
    peakWorkspaceId: 'ws_peak',
    isPortfolioViewer: request => portfolio.has(String(request.uid)),
    isPortfolioCreator: request => portfolio.has(String(request.uid)),
  });
  assert.equal(oversight.readOnly, true);
  assert.equal(oversight.canCreateProject, false);
});

test('task DTO grants decisions only to the persisted reviewer, not an unrelated project lead', () => {
  const row = {
    id: TASK_ID,
    title: '검토 경계',
    status: 'review',
    version: 3,
    assignee_uid: 'worker-uid',
    assignee_name_snapshot: '담당자',
    assigned_by_uid: 'assigner-uid',
    assigned_by_name_snapshot: '지시자',
    reviewer_uid: 'assigner-uid',
    reviewer_name_snapshot: '지시자',
    reviewer_source: 'assigned_by',
  };
  const leadView = mapTask(row, {
    uid: 'lead-uid', readOnly: false, canManage: true, isLead: true,
  });
  assert.equal(leadView.capabilities.approve, false);
  assert.equal(leadView.capabilities.requestRevision, false);

  const reviewerView = mapTask(row, {
    uid: 'assigner-uid', readOnly: false, canManage: true, isLead: false,
  });
  assert.equal(reviewerView.capabilities.approve, true);
  assert.equal(reviewerView.capabilities.requestRevision, true);
});

test('startup readiness is SELECT-only and fails closed with the operator migration name', async () => {
  let sql = '';
  const pool = makePool({
    query: async statement => {
      sql = statement;
      return { rows: [{ ready: false, missing_requirements: ['constraint:missing'] }] };
    },
  });
  await assert.rejects(
    ensurePeakosNewProjectInfrastructure(pool),
    error => error.code === 'NEW_PROJECT_SCHEMA_NOT_READY'
      && /20260811_peakos_structured_projects_medium_managers\.sql/.test(error.message),
  );
  assert.match(sql, /^WITH required_columns/);
  assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i);
});

test('preview list returns zero rows without touching the database and preview detail is denied', async () => {
  let dbCalls = 0;
  const pool = makePool({
    query: async () => { dbCalls += 1; return { rows: [{ id: PROJECT_ID, name: '노출 금지' }] }; },
  });
  const actor = req({ uid: 'exact-kim-uid', preview: true });
  const server = await listen(appWithActor(pool, actor, request => request.uid === 'exact-kim-uid'));
  try {
    const list = await call(server, '/api/new-projects', { headers: { 'x-peakos-preview': '1' } });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.projects, []);
    assert.equal(list.body.capabilities.viewPortfolio, false);
    assert.equal(list.body.capabilities.createProject, false);

    const detail = await call(server, `/api/new-projects/${PROJECT_ID}`, { headers: { 'x-peakos-preview': '1' } });
    assert.equal(detail.status, 403);
    assert.equal(detail.body.code, 'NEW_PROJECT_PREVIEW_DATA_HIDDEN');
    assert.equal(dbCalls, 0);
  } finally {
    await close(server);
  }
});

test('project detail IDOR resolves by authenticated workspace and returns indistinguishable 404', async () => {
  const seen = [];
  const pool = makePool({
    query: async (sql, values) => {
      seen.push({ sql, values });
      return { rows: [] };
    },
  });
  const actor = req({ uid: 'ordinary-uid', workspaceId: 'ws_daegu' });
  const server = await listen(appWithActor(pool, actor));
  try {
    const result = await call(server, `/api/new-projects/${PROJECT_ID}`);
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'NEW_PROJECT_NOT_FOUND');
    assert.equal(seen.length, 1);
    assert.match(seen[0].sql, /p\.workspace_id = \$1 AND p\.id = \$2/);
    assert.deepEqual(seen[0].values, ['ws_daegu', PROJECT_ID, 'ordinary-uid']);
  } finally {
    await close(server);
  }
});

test('branch HQ oversight sees the whole selected portfolio read-only while Peak 손명아 stays membership-scoped', async () => {
  const branchQueries = [];
  const branchPool = makePool({
    query: async (sql, values) => {
      branchQueries.push({ sql, values });
      if (/SELECT p\.\*/.test(sql)) {
        return { rows: [{
          id: PROJECT_ID,
          workspace_id: 'ws_daegu',
          name: '대구 전체 열람 프로젝트',
          description: '',
          status: 'active',
          version: 1,
          lead_uid: 'daegu-lead',
          lead_name_snapshot: '대구 담당자',
          created_by_uid: 'daegu-lead',
          created_by_name_snapshot: '대구 담당자',
          is_project_member: false,
          is_assignee: false,
        }] };
      }
      if (/FROM peakos_structured_projects p/.test(sql)) {
        return { rows: [{
          id: PROJECT_ID,
          name: '대구 전체 열람 프로젝트',
          description: '',
          status: 'active',
          version: 1,
          lead_uid: 'daegu-lead',
          lead_name_snapshot: '대구 담당자',
          created_by_uid: 'daegu-lead',
          created_by_name_snapshot: '대구 담당자',
          members: [],
        }] };
      }
      return { rows: [] };
    },
  });
  const oversightActor = req({
    uid: 'uid-son-myungah',
    name: '손명아',
    workspaceId: 'ws_daegu',
    workspaceRole: 'oversight',
    oversight: true,
  });
  const branchServer = await listen(appWithActor(branchPool, oversightActor));
  try {
    const list = await call(branchServer, '/api/new-projects');
    assert.equal(list.status, 200);
    assert.equal(list.body.readOnly, true);
    assert.equal(list.body.capabilities.viewPortfolio, true);
    assert.equal(list.body.capabilities.createProject, false);
    assert.deepEqual(list.body.projects.map(project => project.name), ['대구 전체 열람 프로젝트']);
    const listQuery = branchQueries.find(entry => /FROM peakos_structured_projects p/.test(entry.sql));
    assert.deepEqual(listQuery.values, ['ws_daegu', 'uid-son-myungah', true]);

    const detail = await call(branchServer, `/api/new-projects/${PROJECT_ID}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.readOnly, true);
    assert.equal(detail.body.capabilities.manageProject, false);
    assert.equal(detail.body.capabilities.editProjectSettings, false);

    const create = await call(branchServer, '/api/new-projects', {
      method: 'POST',
      body: { name: '차단', description: '', leadUid: 'daegu-lead', memberUids: [] },
    });
    assert.equal(create.status, 403);
    assert.equal(create.body.code, 'NEW_PROJECT_CREATE_FORBIDDEN');
  } finally {
    await close(branchServer);
  }

  const peakQueries = [];
  const peakPool = makePool({
    query: async (sql, values) => {
      peakQueries.push({ sql, values });
      return { rows: [] };
    },
  });
  const peakActor = req({ uid: 'uid-son-myungah', name: '손명아', workspaceId: 'ws_peak' });
  const peakServer = await listen(appWithActor(peakPool, peakActor));
  try {
    const list = await call(peakServer, '/api/new-projects');
    assert.equal(list.status, 200);
    assert.equal(list.body.readOnly, false);
    assert.equal(list.body.capabilities.viewPortfolio, false);
    assert.equal(list.body.capabilities.createProject, false);
    assert.deepEqual(peakQueries[0].values, ['ws_peak', 'uid-son-myungah', false]);
  } finally {
    await close(peakServer);
  }
});

test('exact-three portfolio viewer cannot edit a project without lead or manager membership', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (/SELECT p\.\*/.test(sql)) {
        return { rows: [{
          id: PROJECT_ID,
          workspace_id: 'ws_peak',
          name: '타 프로젝트',
          lead_uid: 'other-lead',
          created_by_uid: 'exact-kim-uid',
          created_by_name_snapshot: '김대호',
          is_project_member: false,
          is_assignee: false,
          status: 'active',
          version: 1,
        }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = makePool({ connect: async () => client });
  const actor = req({ uid: 'exact-kim-uid', name: '김대호' });
  const server = await listen(appWithActor(pool, actor, request => request.uid === 'exact-kim-uid'));
  try {
    const result = await call(server, `/api/new-projects/${PROJECT_ID}`, {
      method: 'PUT',
      body: { name: '권한 없는 변경', expectedVersion: 1 },
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'NEW_PROJECT_MUTATION_FORBIDDEN');
    assert.equal(statements.some(sql => /UPDATE peakos_structured_projects/.test(sql)), false);
    assert.equal(statements.includes('ROLLBACK'), true);
  } finally {
    await close(server);
  }
});

test('Peak exact-three creator who remains an active member may edit settings but cannot manage categories', async () => {
  const statements = [];
  const client = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (/SELECT p\.\*/.test(sql)) {
        return { rows: [{
          id: PROJECT_ID,
          workspace_id: 'ws_peak',
          name: '카카오맵 리뷰',
          description: '',
          lead_uid: 'lead-uid',
          lead_name_snapshot: '프로젝트 담당자',
          created_by_uid: 'exact-kim-uid',
          created_by_name_snapshot: '김대호',
          is_project_member: true,
          is_assignee: false,
          status: 'active',
          version: 1,
        }] };
      }
      if (/SELECT user_uid FROM peakos_structured_project_members/.test(sql)) {
        return { rows: [{ user_uid: 'lead-uid' }, { user_uid: 'exact-kim-uid' }] };
      }
      if (/SELECT u\.uid, u\.name/.test(sql)) {
        const names = new Map([
          ['lead-uid', '프로젝트 담당자'],
          ['exact-kim-uid', '김대호'],
        ]);
        return { rows: (values[1] || []).map(uid => ({ uid, name: names.get(uid) })) };
      }
      if (/UPDATE peakos_structured_projects/.test(sql)) {
        return { rows: [{
          id: PROJECT_ID,
          workspace_id: 'ws_peak',
          name: '카카오맵 리뷰',
          description: '설정 수정됨',
          lead_uid: 'lead-uid',
          lead_name_snapshot: '프로젝트 담당자',
          created_by_uid: 'exact-kim-uid',
          created_by_name_snapshot: '김대호',
          status: 'active',
          version: 2,
        }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = makePool({
    query: (...args) => client.query(...args),
    connect: async () => client,
  });
  const actor = req({ uid: 'exact-kim-uid', name: '김대호' });
  const exactThree = request => request.uid === 'exact-kim-uid';
  const server = await listen(appWithActor(pool, actor, exactThree));
  try {
    const detail = await call(server, `/api/new-projects/${PROJECT_ID}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.capabilities.editProjectSettings, true);
    assert.equal(detail.body.capabilities.manageProject, false);

    const update = await call(server, `/api/new-projects/${PROJECT_ID}`, {
      method: 'PUT',
      body: { description: '설정 수정됨', expectedVersion: 1 },
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.project.version, 2);
    assert.equal(statements.some(entry => /UPDATE peakos_structured_projects/.test(entry.sql)), true);

    const category = await call(server, `/api/new-projects/${PROJECT_ID}/mediums`, {
      method: 'POST',
      body: { name: '권한 없는 중분류', description: '', sortOrder: 0, managerUid: 'exact-kim-uid' },
    });
    assert.equal(category.status, 403);
    assert.equal(category.body.code, 'NEW_PROJECT_MUTATION_FORBIDDEN');
    assert.equal(statements.some(entry => /INSERT INTO peakos_structured_project_medium_categories/.test(entry.sql)), false);
  } finally {
    await close(server);
  }
});

test('실제 프로젝트 담당자만 팀원을 중분류 담당자로 생성하고 기존 미지정 행은 NULL로 유지한다', async () => {
  const statements = [];
  const managerNames = new Map([
    ['worker-uid', '업무담당자 이사원'],
    ['outside-uid', '프로젝트 외부 사용자'],
  ]);
  const client = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (/SELECT p\.\*/.test(sql)) {
        return { rows: [{
          id: PROJECT_ID,
          workspace_id: 'ws_peak',
          name: '중분류 담당자 프로젝트',
          lead_uid: 'lead-uid',
          lead_name_snapshot: '프로젝트 담당자',
          created_by_uid: 'lead-uid',
          is_project_member: true,
          is_assignee: false,
          status: 'active',
          version: 1,
        }] };
      }
      if (/SELECT u\.uid, u\.name/.test(sql)) {
        const uid = String(values[1]?.[0] || '');
        return { rows: managerNames.has(uid) ? [{ uid, name: managerNames.get(uid) }] : [] };
      }
      if (/SELECT 1 FROM peakos_structured_project_members/.test(sql)) {
        return { rows: values[2] === 'worker-uid' ? [{ '?column?': 1 }] : [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = makePool({ connect: async () => client });
  const server = await listen(appWithActor(pool, req({ uid: 'lead-uid', name: '프로젝트 담당자' })));
  try {
    const assigned = await call(server, `/api/new-projects/${PROJECT_ID}/mediums`, {
      method: 'POST',
      body: { name: '콘텐츠 제작', description: '', sortOrder: 0, managerUid: 'worker-uid' },
    });
    assert.equal(assigned.status, 201);
    assert.deepEqual(assigned.body.category.manager, { uid: 'worker-uid', name: '업무담당자 이사원' });
    const assignedInsert = statements.find(entry => /INSERT INTO peakos_structured_project_medium_categories/.test(entry.sql));
    assert.equal(assignedInsert.values[5], 'worker-uid');
    assert.equal(assignedInsert.values[6], '업무담당자 이사원');

    const insertCount = statements.filter(entry => /INSERT INTO peakos_structured_project_medium_categories/.test(entry.sql)).length;
    const outsider = await call(server, `/api/new-projects/${PROJECT_ID}/mediums`, {
      method: 'POST',
      body: { name: '차단 중분류', description: '', sortOrder: 0, managerUid: 'outside-uid' },
    });
    assert.equal(outsider.status, 400);
    assert.equal(outsider.body.code, 'NEW_PROJECT_MEDIUM_MANAGER_NOT_MEMBER');
    assert.equal(
      statements.filter(entry => /INSERT INTO peakos_structured_project_medium_categories/.test(entry.sql)).length,
      insertCount,
    );

    const empty = await call(server, `/api/new-projects/${PROJECT_ID}/mediums`, {
      method: 'POST',
      body: { name: '빈 담당자', description: '', sortOrder: 0, managerUid: '' },
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, 'NEW_PROJECT_UID_INVALID');

    const legacyCompatible = await call(server, `/api/new-projects/${PROJECT_ID}/mediums`, {
      method: 'POST',
      body: { name: '캐시된 구 UI 중분류', description: '', sortOrder: 0 },
    });
    assert.equal(legacyCompatible.status, 201);
    assert.equal(legacyCompatible.body.category.manager, null);
    const nullInsert = statements.filter(entry => /INSERT INTO peakos_structured_project_medium_categories/.test(entry.sql)).at(-1);
    assert.equal(nullInsert.values[5], null);
    assert.equal(nullInsert.values[6], null);
  } finally {
    await close(server);
  }
});

test('실제 프로젝트 담당자는 버전을 검증해 중분류 담당자를 수정하고 소분류에는 managerUid를 받지 않는다', async () => {
  const statements = [];
  const client = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (/SELECT p\.\*/.test(sql)) {
        return { rows: [{
          id: PROJECT_ID,
          workspace_id: 'ws_peak',
          name: '중분류 수정 프로젝트',
          lead_uid: 'lead-uid',
          lead_name_snapshot: '프로젝트 담당자',
          created_by_uid: 'lead-uid',
          is_project_member: true,
          is_assignee: false,
          status: 'active',
          version: 1,
        }] };
      }
      if (/SELECT \* FROM peakos_structured_project_medium_categories/.test(sql)) {
        return { rows: [{
          id: MEDIUM_ID,
          workspace_id: 'ws_peak',
          project_id: PROJECT_ID,
          name: '콘텐츠 제작',
          description: '',
          sort_order: 0,
          version: 3,
          manager_uid: 'worker-uid',
          manager_name_snapshot: '업무담당자 이사원',
        }] };
      }
      if (/SELECT u\.uid, u\.name/.test(sql)) {
        return { rows: [{ uid: 'viewer-uid', name: '공동구성원 박대리' }] };
      }
      if (/SELECT 1 FROM peakos_structured_project_members/.test(sql)) return { rows: [{ '?column?': 1 }] };
      if (/UPDATE peakos_structured_project_medium_categories/.test(sql)) {
        return { rows: [{
          id: MEDIUM_ID,
          name: '콘텐츠 제작',
          description: '',
          sort_order: 0,
          version: 4,
          manager_uid: 'viewer-uid',
          manager_name_snapshot: '공동구성원 박대리',
        }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = makePool({ connect: async () => client });
  const server = await listen(appWithActor(pool, req({ uid: 'lead-uid', name: '프로젝트 담당자' })));
  try {
    const updated = await call(server, `/api/new-projects/${PROJECT_ID}/mediums/${MEDIUM_ID}`, {
      method: 'PUT',
      body: { name: '콘텐츠 제작', managerUid: 'viewer-uid', expectedVersion: 3 },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.category.version, 4);
    assert.deepEqual(updated.body.category.manager, { uid: 'viewer-uid', name: '공동구성원 박대리' });
    const update = statements.find(entry => /UPDATE peakos_structured_project_medium_categories/.test(entry.sql));
    assert.equal(update.values[6], 'viewer-uid');
    assert.equal(update.values[7], '공동구성원 박대리');
    assert.equal(update.values.at(-1), 3);

    const small = await call(server, `/api/new-projects/${PROJECT_ID}/mediums/${MEDIUM_ID}/smalls`, {
      method: 'POST',
      body: { name: '소분류', description: '', sortOrder: 0, managerUid: 'viewer-uid' },
    });
    assert.equal(small.status, 400);
    assert.equal(small.body.code, 'NEW_PROJECT_BODY_FIELD_INVALID');
    assert.equal(statements.some(entry => /INSERT INTO peakos_structured_project_small_categories/.test(entry.sql)), false);
  } finally {
    await close(server);
  }
});

test('활성 중분류 담당자는 담당 해제 전에 프로젝트 팀원에서 제외할 수 없다', async () => {
  const statements = [];
  const client = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (/SELECT p\.\*/.test(sql)) {
        return { rows: [{
          id: PROJECT_ID,
          workspace_id: 'ws_peak',
          name: '팀원 제외 보호',
          description: '',
          lead_uid: 'lead-uid',
          lead_name_snapshot: '프로젝트 담당자',
          created_by_uid: 'lead-uid',
          created_by_name_snapshot: '프로젝트 담당자',
          is_project_member: true,
          is_assignee: false,
          status: 'active',
          version: 1,
        }] };
      }
      if (/SELECT user_uid FROM peakos_structured_project_members/.test(sql)) {
        return { rows: [{ user_uid: 'lead-uid' }, { user_uid: 'worker-uid' }] };
      }
      if (/SELECT u\.uid, u\.name/.test(sql)) {
        return { rows: [{ uid: 'lead-uid', name: '프로젝트 담당자' }] };
      }
      if (/SELECT manager_uid FROM peakos_structured_project_medium_categories/.test(sql)) {
        return { rows: [{ manager_uid: 'worker-uid' }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = makePool({ connect: async () => client });
  const server = await listen(appWithActor(pool, req({ uid: 'lead-uid', name: '프로젝트 담당자' })));
  try {
    const result = await call(server, `/api/new-projects/${PROJECT_ID}`, {
      method: 'PUT',
      body: { leadUid: 'lead-uid', memberUids: ['lead-uid'], expectedVersion: 1 },
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'NEW_PROJECT_MEMBER_MANAGES_MEDIUM');
    assert.equal(statements.some(entry => /SET active = FALSE/.test(entry.sql)), false);
    assert.equal(statements.some(entry => entry.sql === 'ROLLBACK'), true);
  } finally {
    await close(server);
  }
});

test('review update losing the version race returns 409 and writes no history or notification', async () => {
  const statements = [];
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (/SELECT p\.\*/.test(sql)) {
        return { rows: [{
          id: PROJECT_ID,
          workspace_id: 'ws_peak',
          name: '동시성 프로젝트',
          lead_uid: 'lead-uid',
          lead_name_snapshot: '프로젝트 담당자',
          is_project_member: true,
          is_assignee: true,
          status: 'active',
          version: 1,
        }] };
      }
      if (/SELECT \* FROM peakos_structured_project_tasks/.test(sql)) {
        return { rows: [{
          id: TASK_ID,
          workspace_id: 'ws_peak',
          project_id: PROJECT_ID,
          title: '경쟁 상태 업무',
          status: 'doing',
          version: 4,
          assignee_uid: 'worker-uid',
          assignee_name_snapshot: '담당자',
          assigned_by_uid: 'assigner-uid',
          assigned_by_name_snapshot: '지시자',
          reviewer_uid: 'assigner-uid',
          reviewer_name_snapshot: '지시자',
          reviewer_source: 'assigned_by',
        }] };
      }
      if (/UPDATE peakos_structured_project_tasks/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = makePool({ connect: async () => client });
  const actor = req({ uid: 'worker-uid', name: '담당자' });
  const server = await listen(appWithActor(pool, actor));
  try {
    const result = await call(server, `/api/new-projects/${PROJECT_ID}/tasks/${TASK_ID}/review`, {
      method: 'POST',
      body: { action: 'request', expectedVersion: 4, note: '' },
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'NEW_PROJECT_TASK_VERSION_CONFLICT');
    const update = statements.find(entry => /UPDATE peakos_structured_project_tasks/.test(entry.sql));
    assert.equal(update.values.at(-1), 4);
    assert.equal(statements.some(entry => /INSERT INTO peakos_structured_project_history/.test(entry.sql)), false);
    assert.equal(statements.some(entry => entry.sql === 'COMMIT'), false);
    assert.equal(statements.some(entry => entry.sql === 'ROLLBACK'), true);
  } finally {
    await close(server);
  }
});
