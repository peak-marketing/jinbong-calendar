'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createSalesPiiCrypto } = require('./peakos-sales-leads-crypto');
const {
  SALES_REQUIRED_COLUMN_DEFINITIONS,
  SALES_REQUIRED_CONSTRAINTS,
  SALES_REQUIRED_COLUMNS,
  SALES_REQUIRED_INDEXES,
  SALES_REQUIRED_TRIGGERS,
  SALES_SCHEMA_READINESS_SQL,
  ensurePeakosSalesLeadInfrastructure,
  salesSchemaReadiness,
} = require('./peakos-sales-leads-infrastructure');
const {
  assertSalesWrite,
  createSalesLeadContext,
  normalizePhone,
} = require('./peakos-sales-leads-policy');

const SECRET = 'sales-test-secret-32-bytes-minimum-value';
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '20260817_peakos_sales_leads.sql'),
  'utf8',
);

function stripSqlStringLiterals(sql) {
  return String(sql).replace(/'(?:''|[^'])*'/g, "''");
}

function actor({
  uid = 'sales-uid', groupType = 'sales', role = 'member', oversight = false,
  workspaceId = 'ws_daegu', preview = false, chatOnly = false, externalCalendarOnly = false,
} = {}) {
  return {
    uid,
    userName: uid,
    userDoc: {
      name: uid,
      approved: true,
      is_active: true,
      group_type: groupType,
      chat_only: chatOnly,
      external_calendar_only: externalCalendarOnly,
    },
    workspace: { id: workspaceId, role, headquartersOversight: oversight },
    headers: preview ? { 'x-peakos-preview': '1' } : {},
    get(name) { return this.headers[String(name).toLowerCase()]; },
  };
}

test('route policy is narrower than sales:write workspace defaults', () => {
  const member = createSalesLeadContext(actor());
  assert.equal(member.scope, 'own');
  assert.equal(member.readOnly, false);

  assert.throws(
    () => createSalesLeadContext(actor({ groupType: 'support' })),
    error => error.code === 'SALES_ROLE_FORBIDDEN' && error.status === 403,
  );

  const manager = createSalesLeadContext(actor({ groupType: 'support', role: 'manager' }));
  assert.equal(manager.scope, 'workspace');
  assert.equal(manager.isManager, true);

  const oversight = createSalesLeadContext(actor({
    groupType: 'support', role: 'oversight', oversight: true,
  }));
  assert.equal(oversight.scope, 'workspace');
  assert.equal(oversight.readOnly, true);
  assert.throws(
    () => assertSalesWrite(oversight),
    error => error.code === 'SALES_OVERSIGHT_READ_ONLY',
  );
});

test('restricted accounts cannot enter the sales policy while normal oversight remains read-only', () => {
  for (const restricted of [
    actor({ chatOnly: true }),
    actor({ externalCalendarOnly: true }),
  ]) {
    assert.throws(
      () => createSalesLeadContext(restricted),
      error => error.code === 'SALES_ACCOUNT_RESTRICTED' && error.status === 403,
    );
  }

  const oversight = createSalesLeadContext(actor({
    groupType: 'support', role: 'oversight', oversight: true,
  }));
  assert.equal(oversight.readOnly, true);
  assert.equal(oversight.scope, 'workspace');
});

test('PII uses row-bound AES-GCM and workspace-scoped phone HMAC', () => {
  const pii = createSalesPiiCrypto(SECRET);
  const contact = {
    contactName: '<script>name</script>', phone: '01012345678',
    address: '대구 주소', memo: '<img src=x onerror=alert(1)>',
  };
  const encrypted = pii.encryptContact(contact, { workspaceId: 'ws_daegu', leadId: 'lead-a' });
  assert.equal(encrypted.nonce.length, 12);
  assert.equal(encrypted.authTag.length, 16);
  assert.equal(encrypted.ciphertext.includes(Buffer.from('01012345678')), false);
  const row = {
    workspace_id: 'ws_daegu', id: 'lead-a',
    contact_ciphertext: encrypted.ciphertext, contact_nonce: encrypted.nonce,
    contact_auth_tag: encrypted.authTag, contact_encryption_version: 1,
  };
  assert.deepEqual(pii.decryptContact(row), contact);
  assert.throws(() => pii.decryptContact({ ...row, workspace_id: 'ws_peak' }));

  assert.notEqual(
    pii.phoneFingerprint(contact.phone, 'ws_daegu'),
    pii.phoneFingerprint(contact.phone, 'ws_peak'),
  );
  assert.equal(normalizePhone('+82 10-1234-5678'), '01012345678');
});

test('migration owns three exact tables and resets the runtime role to archive-only least privilege', () => {
  assert.deepEqual(Object.keys(SALES_REQUIRED_COLUMNS).sort(), [
    'peakos_sales_call_logs', 'peakos_sales_lead_history', 'peakos_sales_leads',
  ]);
  for (const table of Object.keys(SALES_REQUIRED_COLUMNS)) {
    assert.match(MIGRATION, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}[\\s\\S]*?PRIMARY KEY \\(workspace_id, id\\)`, 'i'));
  }
  assert.match(MIGRATION, /phone_last4 TEXT NOT NULL/i);
  assert.match(MIGRATION, /peakos_sales_leads_active_phone_unique[\s\S]*workspace_id, phone_fingerprint[\s\S]*archived_at IS NULL/i);
  assert.match(MIGRATION, /role = 'oversight' THEN 'read'[\s\S]*ELSE 'write'/i);
  assert.match(MIGRATION, /GRANT SELECT, INSERT, UPDATE ON TABLE peakos_sales_leads/i);
  assert.match(MIGRATION, /GRANT SELECT, INSERT ON TABLE peakos_sales_call_logs/i);
  assert.match(MIGRATION, /REVOKE ALL PRIVILEGES ON TABLE peakos_sales_leads FROM PUBLIC, %I/i);
  assert.match(MIGRATION, /REVOKE ALL PRIVILEGES ON TABLE peakos_sales_call_logs FROM PUBLIC, %I/i);
  assert.match(MIGRATION, /REVOKE ALL PRIVILEGES ON SEQUENCE peakos_sales_lead_history_id_seq FROM PUBLIC, %I/i);
  assert.match(MIGRATION, /has_table_privilege\(application_role[\s\S]*'DELETE'/i);
  assert.match(MIGRATION, /has_table_privilege\(application_role[\s\S]*'TRUNCATE'/i);
  assert.doesNotMatch(MIGRATION, /application_role\s*:=\s*current_user/i);
  assert.doesNotMatch(MIGRATION, /GRANT[^;]*DELETE/i);
  assert.deepEqual(SALES_REQUIRED_TRIGGERS.map(([, name]) => name), [
    'peakos_sales_call_logs_no_mutation', 'peakos_sales_lead_history_no_mutation',
  ]);
  assert.ok(SALES_REQUIRED_TRIGGERS.every(([, , triggerType, enabled, definition]) => (
    triggerType === 27
      && enabled === 'O'
      && /^CREATE TRIGGER /.test(definition)
      && / BEFORE DELETE OR UPDATE ON public\.peakos_sales_/.test(definition)
      && / EXECUTE FUNCTION peakos_sales_append_only\(\)$/.test(definition)
  )));
  assert.deepEqual(SALES_REQUIRED_INDEXES[0], [
    'peakos_sales_leads', 'peakos_sales_leads_active_phone_unique',
    ['workspace_id', 'phone_fingerprint'], '(archived_at IS NULL)',
  ]);
  assert.deepEqual(SALES_REQUIRED_COLUMN_DEFINITIONS.peakos_sales_leads.contact_ciphertext, ['bytea', true]);
  assert.deepEqual(SALES_REQUIRED_COLUMN_DEFINITIONS.peakos_sales_leads.archived_at, ['timestamp with time zone', false]);
  assert.ok(SALES_REQUIRED_CONSTRAINTS.peakos_sales_leads.some(([name, type, definition]) => (
    name === 'peakos_sales_leads_creator_membership_fk'
      && type === 'f'
      && /created_by_uid/.test(definition)
  )));
});

test('startup readiness is SELECT-only, exact, and validates the independent secret', async () => {
  assert.match(SALES_SCHEMA_READINESS_SQL, /^WITH required_columns/i);
  assert.doesNotMatch(
    stripSqlStringLiterals(SALES_SCHEMA_READINESS_SQL),
    /\b(?:CREATE\s+(?:TABLE|INDEX|TRIGGER|FUNCTION)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|TRIGGER|FUNCTION)|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|GRANT\s+)/i,
  );
  assert.match(SALES_SCHEMA_READINESS_SQL, /format_type\(actual\.atttypid, actual\.atttypmod\)/);
  assert.match(SALES_SCHEMA_READINESS_SQL, /actual\.convalidated IS NOT TRUE/);
  assert.match(SALES_SCHEMA_READINESS_SQL, /actual\.tgenabled::text <> expected\.enabled_state/);
  assert.match(SALES_SCHEMA_READINESS_SQL, /actual\.tgtype::integer <> expected\.trigger_type/);
  assert.match(SALES_SCHEMA_READINESS_SQL, /actual\.tgqual IS NOT NULL/);
  assert.match(SALES_SCHEMA_READINESS_SQL, /actual\.tgattr::text <> ''/);
  assert.match(SALES_SCHEMA_READINESS_SQL, /actual\.tgnargs <> 0/);
  assert.match(SALES_SCHEMA_READINESS_SQL, /octet_length\(actual\.tgargs\) <> 0/);
  assert.match(SALES_SCHEMA_READINESS_SQL, /pg_get_triggerdef\(actual\.oid\)/);
  assert.match(SALES_SCHEMA_READINESS_SQL, /actual\.indisunique IS NOT TRUE/);
  assert.match(SALES_SCHEMA_READINESS_SQL, /pg_get_expr\(actual\.indpred, actual\.indrelid\)/);
  assert.match(SALES_SCHEMA_READINESS_SQL, /has_table_privilege/);
  assert.match(SALES_SCHEMA_READINESS_SQL, /has_sequence_privilege/);
  assert.match(SALES_SCHEMA_READINESS_SQL, /has_function_privilege/);
  assert.match(SALES_SCHEMA_READINESS_SQL, /SELECT current_user AS role_name/);
  assert.doesNotMatch(SALES_SCHEMA_READINESS_SQL, /current_setting\('peakos\.app_role'/);
  assert.deepEqual(salesSchemaReadiness({ ready: true, missing_requirements: [] }), { ready: true, missing: [] });
  assert.equal(salesSchemaReadiness({ ready: false, missing_requirements: ['column:x.y'] }).code, 'SALES_SCHEMA_NOT_READY');

  let calls = 0;
  await assert.rejects(
    ensurePeakosSalesLeadInfrastructure({ query: async () => { calls += 1; return { rows: [] }; } }, { encryptionSecret: '' }),
    error => error.code === 'SALES_PII_SECRET_INVALID',
  );
  assert.equal(calls, 0, 'missing secret must fail before touching data');

  let sql = '';
  await assert.rejects(
    ensurePeakosSalesLeadInfrastructure({
      query: async statement => {
        sql = statement;
        return { rows: [{ ready: false, missing_requirements: ['trigger:missing'] }] };
      },
    }, { encryptionSecret: SECRET }),
    error => error.code === 'SALES_SCHEMA_NOT_READY' && /20260817_peakos_sales_leads\.sql/.test(error.message),
  );
  assert.equal(sql, SALES_SCHEMA_READINESS_SQL);
});

const salesPostgresUrl = process.env.PEAKOS_SALES_TEST_DATABASE_URL || '';

test('disposable PostgreSQL detects inert and column-narrowed same-name sales triggers', {
  skip: !salesPostgresUrl,
  timeout: 30_000,
}, async t => {
  const databaseName = decodeURIComponent(new URL(salesPostgresUrl).pathname.replace(/^\//, ''));
  assert.match(databaseName, /test/i, 'PEAKOS_SALES_TEST_DATABASE_URL must name a dedicated test database');

  const { Client } = require('pg');
  const admin = new Client({ connectionString: salesPostgresUrl });
  await admin.connect();

  const managedRelations = [
    'peakos_sales_lead_history',
    'peakos_sales_call_logs',
    'peakos_sales_leads',
    'peakos_workspace_membership_audit',
    'peakos_workspace_memberships',
    'peakos_workspaces',
  ];
  const existing = await admin.query(
    `SELECT relation_name
       FROM unnest($1::text[]) relation_name
      WHERE to_regclass('public.' || relation_name) IS NOT NULL`,
    [managedRelations],
  );
  assert.deepEqual(existing.rows, [], 'sales PostgreSQL test database must start empty');

  const roleWasPresent = (await admin.query(
    "SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user'",
  )).rowCount > 0;

  t.after(async () => {
    await admin.query('RESET ROLE').catch(() => {});
    await admin.query(`
      DROP TABLE IF EXISTS public.peakos_sales_lead_history CASCADE;
      DROP TABLE IF EXISTS public.peakos_sales_call_logs CASCADE;
      DROP TABLE IF EXISTS public.peakos_sales_leads CASCADE;
      DROP FUNCTION IF EXISTS public.peakos_sales_append_only() CASCADE;
      DROP TABLE IF EXISTS public.peakos_workspace_membership_audit CASCADE;
      DROP TABLE IF EXISTS public.peakos_workspace_memberships CASCADE;
      DROP TABLE IF EXISTS public.peakos_workspaces CASCADE;
    `).catch(() => {});
    if (!roleWasPresent) {
      await admin.query('DROP ROLE IF EXISTS calendar_user').catch(() => {});
    }
    await admin.end();
  });

  await admin.query(`
    DO $role$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
        CREATE ROLE calendar_user NOLOGIN;
      END IF;
    END
    $role$;
    CREATE TABLE public.peakos_workspaces (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE public.peakos_workspace_memberships (
      workspace_id TEXT NOT NULL REFERENCES public.peakos_workspaces(id),
      user_uid TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (workspace_id, user_uid)
    );
    CREATE TABLE public.peakos_workspace_membership_audit (
      workspace_id TEXT NOT NULL,
      target_uid TEXT NOT NULL,
      actor_uid TEXT NOT NULL,
      action TEXT NOT NULL,
      before_state JSONB NOT NULL,
      after_state JSONB NOT NULL
    );
    GRANT USAGE ON SCHEMA public TO calendar_user;
    GRANT SELECT ON TABLE public.peakos_workspace_memberships TO calendar_user;
  `);

  async function readiness() {
    await admin.query('SET ROLE calendar_user');
    try {
      return (await admin.query(SALES_SCHEMA_READINESS_SQL)).rows[0];
    } finally {
      await admin.query('RESET ROLE');
    }
  }

  function assertMissingTrigger(row, table, trigger) {
    assert.equal(row.ready, false);
    assert.ok(
      row.missing_requirements.includes(`trigger-definition:${table}.${trigger}`),
      JSON.stringify(row.missing_requirements),
    );
  }

  await admin.query(MIGRATION);
  await admin.query(MIGRATION);
  assert.deepEqual(await readiness(), { ready: true, missing_requirements: [] });

  await admin.query(`
    DROP TRIGGER peakos_sales_call_logs_no_mutation ON public.peakos_sales_call_logs;
    CREATE TRIGGER peakos_sales_call_logs_no_mutation
      BEFORE UPDATE OR DELETE ON public.peakos_sales_call_logs
      FOR EACH ROW WHEN (FALSE)
      EXECUTE FUNCTION public.peakos_sales_append_only();
  `);
  assertMissingTrigger(
    await readiness(),
    'peakos_sales_call_logs',
    'peakos_sales_call_logs_no_mutation',
  );
  await admin.query(MIGRATION);
  assert.deepEqual(await readiness(), { ready: true, missing_requirements: [] });

  await admin.query(`
    DROP TRIGGER peakos_sales_lead_history_no_mutation ON public.peakos_sales_lead_history;
    CREATE TRIGGER peakos_sales_lead_history_no_mutation
      BEFORE UPDATE OF entity_version OR DELETE ON public.peakos_sales_lead_history
      FOR EACH ROW EXECUTE FUNCTION public.peakos_sales_append_only();
  `);
  assertMissingTrigger(
    await readiness(),
    'peakos_sales_lead_history',
    'peakos_sales_lead_history_no_mutation',
  );
  await admin.query(MIGRATION);
  assert.deepEqual(await readiness(), { ready: true, missing_requirements: [] });
});
