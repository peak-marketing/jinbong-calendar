'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const {
  DIRECT_PERMISSIONS,
  OVERSIGHT_PERMISSIONS,
  createPeakosWorkspaceService,
  registerPeakosWorkspaceRoutes,
} = require('./peakos-workspaces');

const ACCESS = Object.freeze({
  패션TV봉이: 'uid-fashion-tv',
  박종원: 'uid-park-jongwon',
  김대호: 'uid-kim-daeho',
  손명아: 'uid-son-myeonga',
});

const workspaceRows = Object.freeze({
  peak: Object.freeze({ workspace_id: 'ws_peak', slug: 'peak', name: '피크마케팅 본사', kind: 'headquarters' }),
  'build-solution': Object.freeze({ workspace_id: 'ws_build_solution', slug: 'build-solution', name: '빌드솔루션', kind: 'company' }),
  jeonju: Object.freeze({ workspace_id: 'ws_jeonju', slug: 'jeonju', name: '피크마케팅 전주지사', kind: 'branch' }),
  daegu: Object.freeze({ workspace_id: 'ws_daegu', slug: 'daegu', name: '피크마케팅 대구지사', kind: 'branch' }),
});

function membership(slug, role, isDefault = false, createdAt = '2026-01-01T00:00:00Z') {
  return {
    ...workspaceRows[slug],
    membership_role: role,
    permissions: role === 'oversight' ? OVERSIGHT_PERMISSIONS : DIRECT_PERMISSIONS,
    is_default: isDefault,
    created_at: createdAt,
  };
}

const memberships = Object.freeze({
  // The immutable exact4 UID gets the whole portfolio. Branch memberships
  // retain the server-provided oversight role and therefore stay read-only.
  'uid-kim-daeho': Object.freeze([
    membership('peak', 'admin', true),
    membership('build-solution', 'oversight'),
    membership('jeonju', 'oversight'),
    membership('daegu', 'oversight'),
  ]),
  // A global admin role and even a leftover direct branch row must not grant
  // cross-workspace discovery. The default direct membership is canonical.
  'uid-ordinary-admin': Object.freeze([
    membership('peak', 'admin', true),
    membership('daegu', 'admin', false, '2026-01-02T00:00:00Z'),
  ]),
  // A branch employee keeps exactly their own direct/default workspace.
  'uid-branch-member': Object.freeze([
    membership('daegu', 'member', true),
    membership('peak', 'admin', false, '2026-01-02T00:00:00Z'),
  ]),
  // Display-name spoofing cannot substitute for the configured exact4 UID.
  'uid-name-spoof': Object.freeze([
    membership('peak', 'admin', true),
    membership('jeonju', 'admin', false, '2026-01-02T00:00:00Z'),
  ]),
});

function createPool() {
  return {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.includes('WHERE w.slug = $1')) {
        const [slug, uid] = params;
        return { rows: (memberships[uid] || []).filter(row => row.slug === slug) };
      }
      if (text.includes("m.role <> 'oversight'") && text.includes('LIMIT 1')) {
        const [uid] = params;
        const rows = (memberships[uid] || [])
          .filter(row => row.membership_role !== 'oversight')
          .sort((left, right) => Number(right.is_default) - Number(left.is_default)
            || String(left.created_at).localeCompare(String(right.created_at))
            || left.slug.localeCompare(right.slug));
        return { rows: rows.slice(0, 1) };
      }
      if (text.includes('ORDER BY m.is_default DESC') && text.includes('w.name')) {
        const [uid] = params;
        const rows = [...(memberships[uid] || [])].sort((left, right) => (
          Number(right.is_default) - Number(left.is_default)
          || Number(left.workspace_id !== 'ws_peak') - Number(right.workspace_id !== 'ws_peak')
          || left.name.localeCompare(right.name)
        ));
        return { rows };
      }
      throw new Error(`unexpected workspace query: ${text}`);
    },
  };
}

async function listen() {
  const app = express();
  const service = createPeakosWorkspaceService({
    pool: createPool(),
    environment: { PEAKOS_ACCESS_UIDS_JSON: JSON.stringify(ACCESS) },
  });
  const authMiddleware = (req, _res, next) => {
    req.uid = req.get('x-test-uid') || '';
    req.userDoc = {
      approved: true,
      is_active: true,
      // These untrusted presentation fields are intentionally controllable by
      // the test so name and role spoofing are exercised at the HTTP boundary.
      name: decodeURIComponent(req.get('x-test-name') || ''),
      role: req.get('x-test-role') || 'member',
    };
    next();
  };
  registerPeakosWorkspaceRoutes({
    app,
    authMiddleware,
    requireOsSession: (_req, _res, next) => next(),
    service,
  });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function getJson(baseUrl, pathname, { uid, name = '', role = 'member', workspaceHeader } = {}) {
  const headers = {
    'x-test-uid': uid,
    'x-test-name': encodeURIComponent(name),
    'x-test-role': role,
  };
  if (workspaceHeader !== undefined) headers['x-peakos-workspace'] = workspaceHeader;
  const response = await fetch(`${baseUrl}${pathname}`, { headers });
  return { status: response.status, body: await response.json() };
}

test('workspace directory and context enforce exact4 UID portfolio access at the HTTP boundary', async t => {
  const { server, baseUrl } = await listen();
  t.after(() => new Promise(resolve => server.close(resolve)));

  const exact4 = await getJson(baseUrl, '/api/os/workspaces', {
    uid: ACCESS.김대호,
    name: '김대호',
    role: 'admin',
  });
  assert.equal(exact4.status, 200);
  assert.deepEqual(exact4.body.workspaces.map(row => row.slug), [
    'peak', 'build-solution', 'daegu', 'jeonju',
  ]);

  const exact4Branch = await getJson(baseUrl, '/api/os/workspaces/daegu/context', {
    uid: ACCESS.김대호,
    name: '김대호',
    role: 'admin',
    workspaceHeader: 'daegu',
  });
  assert.equal(exact4Branch.status, 200);
  assert.equal(exact4Branch.body.workspace.slug, 'daegu');
  assert.equal(exact4Branch.body.membership.role, 'oversight');
  assert.equal(exact4Branch.body.permissions.projects, 'read');
  assert.equal(exact4Branch.body.permissions.chat, 'none');

  for (const actor of [
    { uid: 'uid-ordinary-admin', name: '본사 관리자', expected: 'peak', denied: 'daegu' },
    { uid: 'uid-branch-member', name: '대구 구성원', expected: 'daegu', denied: 'peak' },
    { uid: 'uid-name-spoof', name: '김대호', expected: 'peak', denied: 'jeonju' },
  ]) {
    const list = await getJson(baseUrl, '/api/os/workspaces', {
      uid: actor.uid,
      name: actor.name,
      role: 'admin',
      workspaceHeader: actor.denied,
    });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.workspaces.map(row => row.slug), [actor.expected]);
    assert.equal(list.body.default_slug, actor.expected);

    const denied = await getJson(baseUrl, `/api/os/workspaces/${actor.denied}/context`, {
      uid: actor.uid,
      name: actor.name,
      role: 'admin',
      workspaceHeader: actor.denied,
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'PEAKOS_WORKSPACE_FORBIDDEN');
  }
});

test('workspace context requires the canonical header and rejects mismatch or alternate headers', async t => {
  const { server, baseUrl } = await listen();
  t.after(() => new Promise(resolve => server.close(resolve)));

  const missing = await getJson(baseUrl, '/api/os/workspaces/daegu/context', {
    uid: ACCESS.김대호,
    name: '김대호',
    role: 'admin',
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'PEAKOS_WORKSPACE_REQUIRED');

  const mismatch = await getJson(baseUrl, '/api/os/workspaces/daegu/context', {
    uid: ACCESS.김대호,
    workspaceHeader: 'peak',
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.code, 'PEAKOS_WORKSPACE_REQUIRED');

  const alternateHeaderResponse = await fetch(`${baseUrl}/api/os/workspaces/daegu/context`, {
    headers: {
      'x-test-uid': ACCESS.김대호,
      'x-workspace': 'daegu',
    },
  });
  const alternateHeaderBody = await alternateHeaderResponse.json();
  assert.equal(alternateHeaderResponse.status, 400);
  assert.equal(alternateHeaderBody.code, 'PEAKOS_WORKSPACE_REQUIRED');
});
