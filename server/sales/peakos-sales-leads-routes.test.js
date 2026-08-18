'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const { createSalesPiiCrypto } = require('./peakos-sales-leads-crypto');
const { registerPeakosSalesLeadRoutes } = require('./peakos-sales-leads-routes');

const SECRET = 'sales-route-test-secret-32-bytes-minimum';
const LEAD_ID = '11111111-1111-4111-8111-111111111111';

function actor({
  uid = 'sales-uid', groupType = 'sales', role = 'member', oversight = false,
  workspaceId = 'ws_daegu', preview = false,
} = {}) {
  return {
    uid,
    userName: uid,
    userDoc: { name: uid, approved: true, is_active: true, group_type: groupType },
    workspace: { id: workspaceId, role, headquartersOversight: oversight },
    headers: preview ? { 'x-peakos-preview': '1' } : {},
  };
}

function makeLeadRow({
  pii = createSalesPiiCrypto(SECRET), workspaceId = 'ws_daegu', id = LEAD_ID,
  ownerUid = 'sales-uid', version = 1, archived = false,
  companyName = '안전한 업체', contact,
} = {}) {
  const value = contact || {
    contactName: '담당자', phone: '01012345678', address: '대구', memo: '메모',
  };
  const encrypted = pii.encryptContact(value, { workspaceId, leadId: id });
  return {
    workspace_id: workspaceId, id, owner_uid: ownerUid, owner_name_snapshot: ownerUid,
    company_name: companyName, contact_ciphertext: encrypted.ciphertext,
    contact_nonce: encrypted.nonce, contact_auth_tag: encrypted.authTag,
    contact_encryption_version: 1, phone_fingerprint: pii.phoneFingerprint(value.phone, workspaceId),
    phone_last4: value.phone.slice(-4), channel: 'phone', source: 'manual', status: 'new',
    next_followup_at: null, last_contact_at: null, version,
    created_by_uid: ownerUid, created_by_name_snapshot: ownerUid,
    archived_at: archived ? new Date().toISOString() : null,
    archived_by_uid: archived ? ownerUid : null,
    archived_by_name_snapshot: archived ? ownerUid : null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
}

function makePool({ query, clientQuery } = {}) {
  const client = {
    query: clientQuery || (async () => ({ rows: [] })),
    release() {},
  };
  return {
    query: query || (async () => ({ rows: [] })),
    async connect() { return client; },
    client,
  };
}

function buildApp(pool, requestActor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, requestActor);
    req.headers = { ...req.headers, ...requestActor.headers };
    next();
  });
  registerPeakosSalesLeadRoutes({ app, pool, encryptionSecret: SECRET });
  return app;
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

async function call(server, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('member list is tenant- and owner-scoped, while a foreign detail is indistinguishable 404', async () => {
  const seen = [];
  const pool = makePool({
    query: async (sql, values) => {
      seen.push({ sql: String(sql), values });
      return { rows: [] };
    },
  });
  const server = await listen(buildApp(pool, actor()));
  try {
    const list = await call(server, '/api/peakos/sales-leads');
    assert.equal(list.status, 200);
    assert.match(seen[0].sql, /lead\.workspace_id = \$1/);
    assert.match(seen[0].sql, /lead\.owner_uid = \$3/);
    assert.deepEqual(seen[0].values.slice(0, 3), ['ws_daegu', false, 'sales-uid']);

    const detail = await call(server, `/api/peakos/sales-leads/${LEAD_ID}`);
    assert.equal(detail.status, 404);
    assert.deepEqual(seen[1].values, ['ws_daegu', LEAD_ID, false, 'sales-uid']);
  } finally {
    await close(server);
  }
});

test('collection projection uses phone_last4 without decrypting each ciphertext', async () => {
  const deliberatelyUndecryptable = {
    ...makeLeadRow(),
    contact_ciphertext: Buffer.from('not-a-valid-ciphertext'),
    contact_nonce: Buffer.alloc(12),
    contact_auth_tag: Buffer.alloc(16),
    total_count: 1,
  };
  const pool = makePool({ query: async () => ({ rows: [deliberatelyUndecryptable] }) });
  const server = await listen(buildApp(pool, actor()));
  try {
    const response = await call(server, '/api/peakos/sales-leads');
    assert.equal(response.status, 200);
    assert.equal(response.body.piiAccess, 'masked');
    assert.equal(response.body.detailPiiAccess, 'full');
    assert.equal(response.body.leads[0].contact.phoneMasked, '***-****-5678');
    assert.equal(response.body.leads[0].contact.memo, null);
  } finally {
    await close(server);
  }
});

test('oversight sees every selected-workspace row read-only with masked PII and no call note', async () => {
  const lead = makeLeadRow({ ownerUid: 'branch-sales' });
  const calls = [];
  const pool = makePool({
    query: async (sql, values) => {
      calls.push({ sql: String(sql), values });
      if (/COUNT\(\*\) OVER/.test(sql)) return { rows: [{ ...lead, total_count: 1 }] };
      if (/SELECT \* FROM peakos_sales_leads/.test(sql)) return { rows: [lead] };
      if (/SELECT \* FROM peakos_sales_call_logs/.test(sql)) return { rows: [{
        workspace_id: 'ws_daegu', id: '22222222-2222-4222-8222-222222222222',
        lead_id: LEAD_ID, actor_uid: 'branch-sales', actor_name_snapshot: '지사 영업자',
        disposition: 'connected', occurred_at: new Date().toISOString(), duration_seconds: 30,
        note_ciphertext: Buffer.from('not-decryptable'), note_nonce: Buffer.alloc(12),
        note_auth_tag: Buffer.alloc(16), note_encryption_version: 1,
        next_followup_at: null, created_at: new Date().toISOString(),
      }] };
      return { rows: [] };
    },
  });
  const oversightActor = actor({ uid: 'hq-uid', groupType: 'support', role: 'oversight', oversight: true });
  const server = await listen(buildApp(pool, oversightActor));
  try {
    const list = await call(server, '/api/peakos/sales-leads');
    assert.equal(list.status, 200);
    assert.equal(list.body.readOnly, true);
    assert.equal(list.body.piiAccess, 'masked');
    assert.equal(list.body.leads[0].contact.phone, null);
    assert.equal(list.body.leads[0].contact.phoneMasked, '***-****-5678');
    assert.equal(list.body.leads[0].contact.contactName, null);
    assert.equal(list.body.leads[0].contact.address, null);
    assert.equal(list.body.leads[0].contact.memo, null);
    assert.equal(calls[0].values[1], true, 'oversight uses selected-workspace scope');

    const detail = await call(server, `/api/peakos/sales-leads/${LEAD_ID}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.piiAccess, 'masked');
    assert.equal(detail.body.calls[0].note, null);
    assert.equal(detail.body.calls[0].noteRedacted, true);

    const denied = await call(server, '/api/peakos/sales-leads', {
      method: 'POST', body: { companyName: '금지', phone: '01012345678' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'SALES_OVERSIGHT_READ_ONLY');
  } finally {
    await close(server);
  }
});

test('same-workspace manager can read another owner with full detail PII', async () => {
  const lead = makeLeadRow({ ownerUid: 'another-sales' });
  const seen = [];
  const pool = makePool({
    query: async (sql, values) => {
      seen.push({ sql: String(sql), values });
      if (/SELECT \* FROM peakos_sales_leads/.test(sql)) return { rows: [lead] };
      return { rows: [] };
    },
  });
  const server = await listen(buildApp(pool, actor({
    uid: 'branch-manager', groupType: 'support', role: 'manager',
  })));
  try {
    const response = await call(server, `/api/peakos/sales-leads/${LEAD_ID}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.piiAccess, 'full');
    assert.equal(response.body.lead.owner.uid, 'another-sales');
    assert.equal(response.body.lead.contact.phone, '01012345678');
    assert.deepEqual(seen[0].values, ['ws_daegu', LEAD_ID, true, 'branch-manager']);
  } finally {
    await close(server);
  }
});

test('owners endpoint returns only self to a member and eligible canonical users to a manager', async () => {
  const memberSeen = [];
  const memberPool = makePool({
    query: async (sql, values) => {
      memberSeen.push({ sql: String(sql), values });
      return { rows: [{ uid: 'sales-uid', name: '영업 본인' }] };
    },
  });
  const memberServer = await listen(buildApp(memberPool, actor()));
  try {
    const response = await call(memberServer, '/api/peakos/sales-leads/owners');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.owners, [{ uid: 'sales-uid', name: '영업 본인' }]);
    assert.deepEqual(memberSeen[0].values, ['ws_daegu', null, false, 'sales-uid']);
    assert.match(memberSeen[0].sql, /membership\.role IN \('admin', 'manager'\) OR user_group\.group_type = 'sales'/);
    assert.match(memberSeen[0].sql, /COALESCE\(users\.chat_only, FALSE\) = FALSE/);
    assert.match(memberSeen[0].sql, /COALESCE\(users\.external_calendar_only, FALSE\) = FALSE/);
    assert.match(memberSeen[0].sql, /membership\.permissions->>'sales' = 'write'/);
    assert.match(memberSeen[0].sql, /JOIN peakos_workspaces workspace[\s\S]*workspace\.active = TRUE/);
    assert.doesNotMatch(memberSeen[0].sql, /FOR SHARE/);
  } finally {
    await close(memberServer);
  }

  const managerPool = makePool({
    query: async () => ({ rows: [
      { uid: 'branch-manager', name: '지사 관리자' },
      { uid: 'sales-two', name: '영업 2' },
    ] }),
  });
  const managerServer = await listen(buildApp(managerPool, actor({
    uid: 'branch-manager', groupType: 'support', role: 'manager',
  })));
  try {
    const response = await call(managerServer, '/api/peakos/sales-leads/owners');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.owners.map(owner => owner.uid), ['branch-manager', 'sales-two']);
  } finally {
    await close(managerServer);
  }

  const oversightPool = makePool({
    query: async () => ({ rows: [{ uid: 'sales-two', name: '영업 2' }] }),
  });
  const oversightServer = await listen(buildApp(oversightPool, actor({
    uid: 'hq-uid', groupType: 'support', role: 'oversight', oversight: true,
  })));
  try {
    const response = await call(oversightServer, '/api/peakos/sales-leads/owners');
    assert.equal(response.status, 200);
    assert.equal(response.body.readOnly, true);
    assert.deepEqual(response.body.owners, [{ uid: 'sales-two', name: '영업 2' }]);
  } finally {
    await close(oversightServer);
  }
});

test('manager cannot forge a restricted or non-write owner on create or update', async () => {
  const createStatements = [];
  const createPool = makePool({
    clientQuery: async sql => {
      createStatements.push(String(sql));
      return { rows: [] };
    },
  });
  const manager = actor({ uid: 'branch-manager', groupType: 'support', role: 'manager' });
  const createServer = await listen(buildApp(createPool, manager));
  try {
    for (const [ownerUid, phone] of [
      ['chat-only-sales', '01012345678'],
      ['sales-none', '01012345679'],
    ]) {
      const response = await call(createServer, '/api/peakos/sales-leads', {
        method: 'POST',
        body: {
          companyName: '제한 계정 배정 금지',
          phone,
          ownerUid,
        },
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'SALES_OWNER_INVALID');
    }
    const eligibilitySql = createStatements.find(sql => /SELECT users\.uid, users\.name/.test(sql)) || '';
    assert.match(eligibilitySql, /COALESCE\(users\.chat_only, FALSE\) = FALSE/);
    assert.match(eligibilitySql, /COALESCE\(users\.external_calendar_only, FALSE\) = FALSE/);
    assert.match(eligibilitySql, /membership\.permissions->>'sales' = 'write'/);
    assert.match(eligibilitySql, /JOIN peakos_workspaces workspace[\s\S]*workspace\.active = TRUE/);
    assert.match(createStatements.join('\n'), /SELECT uid FROM users WHERE uid = \$1 FOR SHARE/);
    assert.match(createStatements.join('\n'), /FROM peakos_workspace_memberships[\s\S]*FOR SHARE/);
    assert.match(createStatements.join('\n'), /SELECT id FROM peakos_workspaces WHERE id = \$1 FOR SHARE/);
    const createUserLock = createStatements.findIndex(sql => /SELECT uid FROM users[\s\S]*FOR SHARE/.test(sql));
    const createMembershipLock = createStatements.findIndex(sql => (
      /FROM peakos_workspace_memberships/.test(sql) && /FOR SHARE/.test(sql)
    ));
    const createWorkspaceLock = createStatements.findIndex(sql => /SELECT id FROM peakos_workspaces[\s\S]*FOR SHARE/.test(sql));
    const createEligibility = createStatements.findIndex(sql => /SELECT users\.uid, users\.name/.test(sql));
    assert.ok(createUserLock >= 0
      && createUserLock < createMembershipLock
      && createMembershipLock < createWorkspaceLock
      && createWorkspaceLock < createEligibility);
    assert.equal(createStatements.some(sql => /INSERT INTO peakos_sales_leads/.test(sql)), false);
    assert.equal(createStatements.at(-1), 'ROLLBACK');
  } finally {
    await close(createServer);
  }

  const updateStatements = [];
  const updatePool = makePool({
    clientQuery: async sql => {
      updateStatements.push(String(sql));
      if (/SELECT \* FROM peakos_sales_leads/.test(sql)) return { rows: [makeLeadRow()] };
      if (/SELECT users\.uid, users\.name/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  });
  const updateServer = await listen(buildApp(updatePool, manager));
  try {
    for (const ownerUid of ['external-calendar-sales', 'sales-read']) {
      const response = await call(updateServer, `/api/peakos/sales-leads/${LEAD_ID}`, {
        method: 'PATCH',
        body: { ownerUid, expectedVersion: 1 },
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'SALES_OWNER_INVALID');
    }
    const eligibilitySql = updateStatements.find(sql => /SELECT users\.uid, users\.name/.test(sql)) || '';
    assert.match(eligibilitySql, /COALESCE\(users\.chat_only, FALSE\) = FALSE/);
    assert.match(eligibilitySql, /COALESCE\(users\.external_calendar_only, FALSE\) = FALSE/);
    assert.match(eligibilitySql, /membership\.permissions->>'sales' = 'write'/);
    assert.match(eligibilitySql, /JOIN peakos_workspaces workspace[\s\S]*workspace\.active = TRUE/);
    assert.match(updateStatements.join('\n'), /SELECT uid FROM users WHERE uid = \$1 FOR SHARE/);
    assert.match(updateStatements.join('\n'), /FROM peakos_workspace_memberships[\s\S]*FOR SHARE/);
    assert.match(updateStatements.join('\n'), /SELECT id FROM peakos_workspaces WHERE id = \$1 FOR SHARE/);
    const updateUserLock = updateStatements.findIndex(sql => /SELECT uid FROM users[\s\S]*FOR SHARE/.test(sql));
    const updateMembershipLock = updateStatements.findIndex(sql => (
      /FROM peakos_workspace_memberships/.test(sql) && /FOR SHARE/.test(sql)
    ));
    const updateWorkspaceLock = updateStatements.findIndex(sql => /SELECT id FROM peakos_workspaces[\s\S]*FOR SHARE/.test(sql));
    const updateEligibility = updateStatements.findIndex(sql => /SELECT users\.uid, users\.name/.test(sql));
    assert.ok(updateUserLock >= 0
      && updateUserLock < updateMembershipLock
      && updateMembershipLock < updateWorkspaceLock
      && updateWorkspaceLock < updateEligibility);
    assert.equal(updateStatements.some(sql => /UPDATE peakos_sales_leads/.test(sql)), false);
    assert.equal(updateStatements.at(-1), 'ROLLBACK');
  } finally {
    await close(updateServer);
  }
});

test('manager cannot assign a lead to a same-workspace support member without a manager role', async () => {
  const statements = [];
  const pool = makePool({
    clientQuery: async sql => {
      statements.push(String(sql));
      if (/SELECT users\.uid, users\.name/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  });
  const server = await listen(buildApp(pool, actor({
    uid: 'branch-manager', groupType: 'support', role: 'manager',
  })));
  try {
    const response = await call(server, '/api/peakos/sales-leads', {
      method: 'POST',
      body: {
        companyName: '배정 금지', phone: '01012345678', ownerUid: 'support-member',
      },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'SALES_OWNER_INVALID');
    assert.equal(statements.some(sql => /INSERT INTO peakos_sales_leads/.test(sql)), false);
    assert.equal(statements.at(-1), 'ROLLBACK');
  } finally {
    await close(server);
  }
});

test('collection search is company-name-only and never derives a phone HMAC for any role', async () => {
  const seen = [];
  const pool = makePool({
    query: async (sql, values) => {
      seen.push({ sql: String(sql), values });
      return { rows: [] };
    },
  });
  const server = await listen(buildApp(pool, actor({
    uid: 'hq-uid', groupType: 'support', role: 'oversight', oversight: true,
  })));
  try {
    const response = await call(server, '/api/peakos/sales-leads?q=010-1234-5678');
    assert.equal(response.status, 200);
    assert.equal(seen[0].values[6], '010-1234-5678');
    assert.equal(seen[0].values.length, 9);
    assert.doesNotMatch(seen[0].sql, /phone_fingerprint\s*=\s*\$/);
  } finally {
    await close(server);
  }

  const directSeen = [];
  const directPool = makePool({
    query: async (sql, values) => {
      directSeen.push({ sql: String(sql), values });
      return { rows: [] };
    },
  });
  const directServer = await listen(buildApp(directPool, actor()));
  try {
    const response = await call(directServer, '/api/peakos/sales-leads?q=01012345678');
    assert.equal(response.status, 200);
    assert.equal(directSeen[0].values[6], '01012345678');
    assert.equal(directSeen[0].values.length, 9);
    assert.doesNotMatch(directSeen[0].sql, /phone_fingerprint\s*=\s*\$/);
  } finally {
    await close(directServer);
  }
});

test('duplicate phone maps the partial unique guard to 409 and rolls back', async () => {
  const statements = [];
  const duplicate = Object.assign(new Error('duplicate'), {
    code: '23505', constraint: 'peakos_sales_leads_active_phone_unique',
  });
  const pool = makePool({
    clientQuery: async sql => {
      statements.push(String(sql));
      if (/SELECT users\.uid, users\.name/.test(sql)) {
        return { rows: [{ uid: 'sales-uid', name: '영업 본인' }] };
      }
      if (/INSERT INTO peakos_sales_leads/.test(sql)) throw duplicate;
      return { rows: [] };
    },
  });
  const server = await listen(buildApp(pool, actor()));
  try {
    const response = await call(server, '/api/peakos/sales-leads', {
      method: 'POST', body: { companyName: '중복 업체', phone: '010-1234-5678' },
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'SALES_PHONE_DUPLICATE');
    assert.deepEqual(statements.filter(sql => /^(?:BEGIN|ROLLBACK)$/.test(sql)), ['BEGIN', 'ROLLBACK']);
  } finally {
    await close(server);
  }
});

test('member cannot forge another owner on create even inside the same workspace', async () => {
  const statements = [];
  const pool = makePool({
    clientQuery: async sql => {
      statements.push(String(sql));
      return { rows: [] };
    },
  });
  const server = await listen(buildApp(pool, actor()));
  try {
    const response = await call(server, '/api/peakos/sales-leads', {
      method: 'POST',
      body: { companyName: '소유자 위조', phone: '01012345678', ownerUid: 'other-sales' },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'SALES_OWNER_FORBIDDEN');
    assert.equal(statements.some(sql => /INSERT INTO peakos_sales_leads/.test(sql)), false);
    assert.equal(statements.at(-1), 'ROLLBACK');
  } finally {
    await close(server);
  }
});

test('stale expectedVersion fails before update and rolls back', async () => {
  const statements = [];
  const pool = makePool({
    clientQuery: async sql => {
      statements.push(String(sql));
      if (/SELECT \* FROM peakos_sales_leads/.test(sql)) return { rows: [makeLeadRow({ version: 2 })] };
      return { rows: [] };
    },
  });
  const server = await listen(buildApp(pool, actor()));
  try {
    const response = await call(server, `/api/peakos/sales-leads/${LEAD_ID}`, {
      method: 'PATCH', body: { companyName: '충돌', expectedVersion: 1 },
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'SALES_VERSION_CONFLICT');
    assert.equal(statements.some(sql => /UPDATE peakos_sales_leads/.test(sql)), false);
    assert.equal(statements.at(-1), 'ROLLBACK');
  } finally {
    await close(server);
  }
});

test('call insert and lead update are atomic: a failed versioned update rolls back the call', async () => {
  const statements = [];
  const pool = makePool({
    clientQuery: async sql => {
      statements.push(String(sql));
      if (/SELECT \* FROM peakos_sales_leads/.test(sql)) return { rows: [makeLeadRow()] };
      if (/INSERT INTO peakos_sales_call_logs/.test(sql)) return { rows: [{ id: 'call-would-roll-back' }] };
      if (/UPDATE peakos_sales_leads/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  });
  const server = await listen(buildApp(pool, actor()));
  try {
    const response = await call(server, `/api/peakos/sales-leads/${LEAD_ID}/calls`, {
      method: 'POST',
      body: { disposition: 'connected', note: '통화', expectedVersion: 1 },
    });
    assert.equal(response.status, 409);
    assert.equal(statements.some(sql => /INSERT INTO peakos_sales_call_logs/.test(sql)), true);
    assert.equal(statements.some(sql => /INSERT INTO peakos_sales_lead_history/.test(sql)), false);
    assert.match(
      statements.find(sql => /UPDATE peakos_sales_leads/.test(sql)) || '',
      /last_contact_at = CASE[\s\S]*\$6::timestamptz > last_contact_at[\s\S]*ELSE last_contact_at/,
      'older calls must not move the lead recent-contact timestamp backwards',
    );
    assert.equal(statements.includes('COMMIT'), false);
    assert.equal(statements.at(-1), 'ROLLBACK');
  } finally {
    await close(server);
  }
});

test('future occurredAt is rejected before a call transaction starts', async () => {
  const statements = [];
  const pool = makePool({
    clientQuery: async sql => {
      statements.push(String(sql));
      return { rows: [] };
    },
  });
  const server = await listen(buildApp(pool, actor()));
  try {
    const response = await call(server, `/api/peakos/sales-leads/${LEAD_ID}/calls`, {
      method: 'POST',
      body: {
        disposition: 'connected',
        occurredAt: '2999-01-01T00:00:00.000Z',
        note: '미래 통화',
        expectedVersion: 1,
      },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'SALES_CALL_TIME_FUTURE');
    assert.deepEqual(statements, []);
  } finally {
    await close(server);
  }
});

test('archive is a versioned UPDATE plus append-only history, never DELETE', async () => {
  const statements = [];
  const pool = makePool({
    clientQuery: async (sql, values) => {
      statements.push(String(sql));
      if (/SELECT \* FROM peakos_sales_leads/.test(sql)) return { rows: [makeLeadRow()] };
      if (/UPDATE peakos_sales_leads/.test(sql)) {
        return { rows: [{
          ...makeLeadRow({ archived: true, version: 2 }),
          archived_by_uid: values[2], archived_by_name_snapshot: values[3],
        }] };
      }
      return { rows: [] };
    },
  });
  const server = await listen(buildApp(pool, actor()));
  try {
    const response = await call(server, `/api/peakos/sales-leads/${LEAD_ID}/archive`, {
      method: 'POST', body: { expectedVersion: 1 },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.archived, true);
    assert.equal(response.body.lead.version, 2);
    assert.equal(statements.some(sql => /INSERT INTO peakos_sales_lead_history/.test(sql)), true);
    assert.equal(statements.some(sql => /\bDELETE\b/.test(sql)), false);
    assert.equal(statements.includes('COMMIT'), true);
  } finally {
    await close(server);
  }
});

test('raw XSS-shaped text round-trips unchanged while contact payload stored is ciphertext', async () => {
  let encryptedValue;
  const pool = makePool({
    clientQuery: async (sql, values) => {
      if (/SELECT users\.uid, users\.name/.test(sql)) {
        return { rows: [{ uid: 'sales-uid', name: 'sales-uid' }] };
      }
      if (/INSERT INTO peakos_sales_leads/.test(sql)) {
        encryptedValue = values[5];
        return { rows: [{
          workspace_id: values[0], id: values[1], owner_uid: values[2], owner_name_snapshot: values[3],
          company_name: values[4], contact_ciphertext: values[5], contact_nonce: values[6],
          contact_auth_tag: values[7], contact_encryption_version: values[8],
          phone_fingerprint: values[9], phone_last4: values[10], channel: values[11],
          source: values[12], status: values[13], next_followup_at: values[14],
          last_contact_at: null, version: 1, created_by_uid: values[15],
          created_by_name_snapshot: values[16], archived_at: null,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }] };
      }
      return { rows: [] };
    },
  });
  const server = await listen(buildApp(pool, actor()));
  const companyName = '<img src=x onerror=alert(1)>';
  const memo = '<script>alert("memo")</script>';
  try {
    const response = await call(server, '/api/peakos/sales-leads', {
      method: 'POST', body: { companyName, phone: '01012345678', memo },
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.lead.companyName, companyName);
    assert.equal(response.body.lead.contact.memo, memo);
    assert.ok(Buffer.isBuffer(encryptedValue));
    assert.equal(encryptedValue.includes(Buffer.from(memo)), false);
    // This assertion documents the contract: the API preserves text; the UI
    // must render with textContent/escaped templates, never innerHTML.
  } finally {
    await close(server);
  }
});

test('index composes Firebase, OS-email, selected-workspace header and sales-area gates', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const globalGate = source.indexOf("app.use(\n  '/api/peakos',\n  authMiddleware,\n  peakosOsEmailAuth.requireOsSession,\n  peakosWorkspaceService.requireSelectedWorkspace(),");
  const registration = source.indexOf('registerPeakosSalesLeadRoutes({');
  assert.ok(globalGate >= 0, 'Firebase + OTP + selected workspace gate is required');
  assert.ok(registration > globalGate, 'sales routes must be registered behind the global gate');
  const salesBlock = source.slice(registration, registration + 1200);
  assert.match(salesBlock, /area: 'sales', action: 'read', requireHeader: true/);
  assert.match(salesBlock, /area: 'sales', action: 'write', requireHeader: true/);
  assert.match(source, /\^\\\/sales-leads\(\?:\\\/\|\$\)/);
});
