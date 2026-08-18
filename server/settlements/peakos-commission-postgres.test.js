'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { Client } = require('pg');
const {
  MIGRATION_PATH,
  ensurePeakosCommissionInfrastructure,
} = require('./peakos-commission-infrastructure');
const {
  CALCULATION_INSERT_SQL,
  RULE_INSERT_SQL,
  databaseCalculationValues,
  ruleInsertValues,
} = require('./peakos-commission-routes');
const {
  calculateCommission,
  calculationInputFingerprint,
} = require('./peakos-commission-policy');

const postgresUrl = process.env.PEAKOS_COMMISSION_TEST_DATABASE_URL || '';

function source(overrides = {}) {
  return {
    id: 'intake_a', workspace_id: 'ws_peak', owner_uid: 'sales_a', owner_name: 'Sales A',
    date: '2026-08-17', row_version: 1, kind: 'normal', a: '매출', b: '플랫폼', c: '리뷰',
    qty: '2', sell: '100000', unit: '70000', vendor_paid: false,
    source_metadata: { provider: 'reviewspace' },
    ...overrides,
  };
}

function draft(overrides = {}) {
  return {
    scopeOwnerUid: 'sales_a', scopePlatform: 'reviewspace', scopeProductA: '매출',
    scopeProductB: '플랫폼', scopeProductC: '리뷰', rateBasisPoints: 1250,
    effectiveFrom: '2026-08-01', effectiveTo: null,
    ...overrides,
  };
}

test('disposable PostgreSQL validates migration idempotency, overlap, formula, tenant and payout guards', {
  skip: !postgresUrl,
  timeout: 45_000,
}, async t => {
  const databaseName = decodeURIComponent(new URL(postgresUrl).pathname.replace(/^\//, ''));
  assert.match(databaseName, /test/i, 'PEAKOS_COMMISSION_TEST_DATABASE_URL must name a dedicated test database');
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const admin = new Client({ connectionString: postgresUrl });
  await admin.connect();
  const managed = [
    'peakos_commission_calculation_ledger', 'peakos_commission_rule_versions',
    'peakos_vendor_settlement_items', 'peakos_vendor_settlement_batches',
    'peakos_intake', 'peakos_workspace_memberships', 'peakos_workspaces',
  ];
  const existing = await admin.query(
    `SELECT name FROM unnest($1::text[]) name WHERE to_regclass('public.' || name) IS NOT NULL`,
    [managed],
  );
  assert.deepEqual(existing.rows, [], 'commission PostgreSQL test database must start empty');

  t.after(async () => {
    await admin.query('RESET ROLE').catch(() => {});
    await admin.query(`
      DROP TABLE IF EXISTS public.peakos_commission_calculation_ledger CASCADE;
      DROP TABLE IF EXISTS public.peakos_commission_rule_versions CASCADE;
      DROP FUNCTION IF EXISTS public.peakos_commission_guard_calculation() CASCADE;
      DROP FUNCTION IF EXISTS public.peakos_commission_guard_rule_version() CASCADE;
      DROP FUNCTION IF EXISTS public.peakos_commission_reject_mutation() CASCADE;
      DROP TABLE IF EXISTS public.peakos_vendor_settlement_items CASCADE;
      DROP TABLE IF EXISTS public.peakos_vendor_settlement_batches CASCADE;
      DROP TABLE IF EXISTS public.peakos_intake CASCADE;
      DROP TABLE IF EXISTS public.peakos_workspace_memberships CASCADE;
      DROP TABLE IF EXISTS public.peakos_workspaces CASCADE;
    `).catch(() => {});
    await admin.end();
  });

  await admin.query(`
    CREATE TABLE public.peakos_workspaces (id TEXT PRIMARY KEY);
    CREATE TABLE public.peakos_workspace_memberships (
      workspace_id TEXT NOT NULL REFERENCES public.peakos_workspaces(id),
      user_uid TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (workspace_id,user_uid)
    );
    CREATE TABLE public.peakos_intake (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES public.peakos_workspaces(id),
      owner_uid TEXT NOT NULL,
      owner_name TEXT,
      date DATE NOT NULL,
      row_version BIGINT NOT NULL DEFAULT 1,
      kind TEXT NOT NULL,
      a TEXT,
      b TEXT,
      c TEXT,
      qty NUMERIC,
      sell NUMERIC,
      unit NUMERIC,
      source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      vendor_paid BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY(workspace_id,id),
      FOREIGN KEY(workspace_id,owner_uid)
        REFERENCES public.peakos_workspace_memberships(workspace_id,user_uid)
    );
    CREATE TABLE public.peakos_vendor_settlement_batches (
      workspace_id TEXT NOT NULL,
      id UUID NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY(workspace_id,id)
    );
    CREATE TABLE public.peakos_vendor_settlement_items (
      workspace_id TEXT NOT NULL,
      batch_id UUID NOT NULL,
      source_intake_id TEXT NOT NULL,
      source_settled_row_version BIGINT NOT NULL,
      PRIMARY KEY(workspace_id,batch_id,source_intake_id),
      FOREIGN KEY(workspace_id,batch_id)
        REFERENCES public.peakos_vendor_settlement_batches(workspace_id,id)
    );
    GRANT USAGE ON SCHEMA public TO calendar_user;
    GRANT SELECT ON TABLE public.peakos_workspaces, public.peakos_workspace_memberships,
      public.peakos_intake, public.peakos_vendor_settlement_batches,
      public.peakos_vendor_settlement_items TO calendar_user;
  `);
  await admin.query("SELECT set_config('peakos.app_role','calendar_user',false)");
  await admin.query(migration);
  await admin.query(migration);

  await admin.query(`
    INSERT INTO public.peakos_workspaces(id) VALUES ('ws_peak'),('ws_branch');
    INSERT INTO public.peakos_workspace_memberships(workspace_id,user_uid)
      VALUES ('ws_peak','sales_a'),('ws_peak','manager'),('ws_branch','sales_b');
    INSERT INTO public.peakos_intake
      (id,workspace_id,owner_uid,owner_name,date,row_version,kind,a,b,c,qty,sell,unit,source_metadata,vendor_paid)
      VALUES
      ('intake_a','ws_peak','sales_a','Sales A','2026-08-17',1,'normal','매출','플랫폼','리뷰',2,100000,70000,
       '{"provider":"reviewspace"}',FALSE),
      ('intake_b','ws_branch','sales_b','Sales B','2026-08-17',1,'normal','매출','플랫폼','리뷰',2,100000,70000,
       '{"provider":"reviewspace"}',FALSE);
  `);

  await admin.query('SET ROLE calendar_user');
  assert.equal((await ensurePeakosCommissionInfrastructure(admin)).checkedColumns, 53);
  const who = { uid: 'manager', name: 'Manager' };
  const now = new Date('2026-08-17T12:00:00.000Z');
  const firstDraft = (await admin.query(RULE_INSERT_SQL, ruleInsertValues({
    workspace: 'ws_peak', id: '11111111-1111-4111-8111-111111111111',
    seriesId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 1,
    supersedesId: null, status: 'DRAFT', source: draft(), reason: 'initial contract draft', actor: who, now,
  }))).rows[0];
  const approved = (await admin.query(RULE_INSERT_SQL, ruleInsertValues({
    workspace: 'ws_peak', id: '22222222-2222-4222-8222-222222222222',
    seriesId: firstDraft.rule_series_id, version: 2, supersedesId: firstDraft.id,
    status: 'APPROVED', source: firstDraft, reason: 'manager approval reason', actor: who, now,
  }))).rows[0];

  const calculated = calculateCommission(source(), [approved], null);
  assert.equal(calculated.estimatedCommissionAmount, 7500);
  assert.equal(calculated.payoutEligible, false);
  const fingerprint = calculationInputFingerprint(calculated, null);
  const values = databaseCalculationValues({
    workspace: 'ws_peak', id: '33333333-3333-4333-8333-333333333333',
    inputFingerprint: fingerprint, result: calculated, vendorEvidence: null, who, now,
  });
  assert.equal((await admin.query(CALCULATION_INSERT_SQL, values)).rowCount, 1);
  assert.equal((await admin.query(CALCULATION_INSERT_SQL, values)).rowCount, 0, 'same input snapshot is idempotent');

  const forgedMath = [...values];
  forgedMath[1] = '44444444-4444-4444-8444-444444444444';
  forgedMath[2] = '4'.repeat(64);
  forgedMath[25] = 9999;
  await assert.rejects(admin.query(CALCULATION_INSERT_SQL, forgedMath), error =>
    error.constraint === 'peakos_commission_calculation_ledger_math_check');

  const crossWorkspace = [...values];
  crossWorkspace[1] = '55555555-5555-4555-8555-555555555555';
  crossWorkspace[2] = '5'.repeat(64);
  crossWorkspace[3] = 'intake_b';
  await assert.rejects(admin.query(CALCULATION_INSERT_SQL, crossWorkspace), error =>
    error.constraint === 'peakos_commission_calculation_source_workspace_check');

  await assert.rejects(
    admin.query("UPDATE public.peakos_commission_calculation_ledger SET estimated_commission_amount = 1 WHERE workspace_id = 'ws_peak'"),
    error => error.code === '42501',
  );

  const secondDraft = (await admin.query(RULE_INSERT_SQL, ruleInsertValues({
    workspace: 'ws_peak', id: '66666666-6666-4666-8666-666666666666',
    seriesId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', version: 1,
    supersedesId: null, status: 'DRAFT', source: draft({ rateBasisPoints: 1000 }),
    reason: 'overlap contract draft', actor: who, now,
  }))).rows[0];
  await assert.rejects(admin.query(RULE_INSERT_SQL, ruleInsertValues({
    workspace: 'ws_peak', id: '77777777-7777-4777-8777-777777777777',
    seriesId: secondDraft.rule_series_id, version: 2, supersedesId: secondDraft.id,
    status: 'APPROVED', source: secondDraft, reason: 'overlap approval blocked', actor: who, now,
  })), error => error.constraint === 'peakos_commission_rule_overlap_check');

  await admin.query('RESET ROLE');
  await admin.query(`
    INSERT INTO public.peakos_vendor_settlement_batches(workspace_id,id,status)
      VALUES ('ws_peak','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','COMPLETED');
    INSERT INTO public.peakos_vendor_settlement_items
      (workspace_id,batch_id,source_intake_id,source_settled_row_version)
      VALUES ('ws_peak','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','intake_a',2);
    UPDATE public.peakos_intake SET row_version=2,vendor_paid=TRUE
      WHERE workspace_id='ws_peak' AND id='intake_a';
  `);
  await admin.query('SET ROLE calendar_user');
  const vendor = {
    batch_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    source_settled_row_version: 2,
  };
  const reconciledEstimate = calculateCommission(source({ row_version: 2, vendor_paid: true }), [approved], vendor);
  assert.equal(reconciledEstimate.payoutEligible, false);
  assert.deepEqual(reconciledEstimate.payoutBlockers, ['SETTLEMENT_COMPLETION_UNCONFIRMED']);
  const payableValues = databaseCalculationValues({
    workspace: 'ws_peak', id: '88888888-8888-4888-8888-888888888888',
    inputFingerprint: calculationInputFingerprint(reconciledEstimate, vendor), result: reconciledEstimate,
    vendorEvidence: vendor, who, now,
  });
  assert.equal((await admin.query(CALCULATION_INSERT_SQL, payableValues)).rowCount, 1);

  const forgedPayable = [...payableValues];
  forgedPayable[1] = '99999999-9999-4999-8999-999999999999';
  forgedPayable[2] = '9'.repeat(64);
  forgedPayable[26] = true;
  forgedPayable[27] = JSON.stringify([]);
  await assert.rejects(admin.query(CALCULATION_INSERT_SQL, forgedPayable), error =>
    error.constraint === 'peakos_commission_calculation_ledger_blockers_check'
      || error.constraint === 'peakos_commission_calculation_ledger_payout_check'
      || error.constraint === 'peakos_commission_calculation_payout_evidence_check');

  await admin.query('RESET ROLE');
  await admin.query('ALTER TABLE public.peakos_commission_calculation_ledger DISABLE TRIGGER peakos_commission_calculation_ledger_guard');
  await admin.query('SET ROLE calendar_user');
  await assert.rejects(ensurePeakosCommissionInfrastructure(admin), error =>
    error.code === 'PEAKOS_COMMISSION_MIGRATION_REQUIRED');
  await admin.query('RESET ROLE');
  await admin.query(migration);
  await admin.query('SET ROLE calendar_user');
  assert.equal((await ensurePeakosCommissionInfrastructure(admin)).checkedTriggers, 6);
  await admin.query('RESET ROLE');
});
