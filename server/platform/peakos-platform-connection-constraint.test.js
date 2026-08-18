'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PLATFORM_CONNECTION_SECRET_REF_CHECK_DEFINITION,
  REQUIRED_CONSTRAINT_DEFINITIONS,
} = require('./peakos-platform-monthly-settlement');

const BASE_MIGRATION_PATH = path.resolve(
  __dirname,
  '../migrations/20260817_peakos_platform_monthly_settlement.sql',
);
const RELEASE_MIGRATION_PATH = path.resolve(
  __dirname,
  '../migrations/20260818_z_peakos_platform_connection_secret_ref_constraint.sql',
);
const BASE_MIGRATION = fs.readFileSync(BASE_MIGRATION_PATH, 'utf8');
const RELEASE_MIGRATION = fs.readFileSync(RELEASE_MIGRATION_PATH, 'utf8');

test('connection secret ref contract separates bounded length from its safe alphabet', () => {
  for (const sql of [BASE_MIGRATION, RELEASE_MIGRATION]) {
    assert.doesNotMatch(sql, /\{0,511\}/);
    assert.match(sql, /char_length\(credential_secret_ref\) BETWEEN 1 AND 512/);
    assert.match(sql, /credential_secret_ref ~ '\^\[A-Za-z0-9\]\[A-Za-z0-9:\/\._-\]\*\$'/);
  }
  assert.equal(
    REQUIRED_CONSTRAINT_DEFINITIONS.peakos_platform_connections_secret_ref_check[1],
    PLATFORM_CONNECTION_SECRET_REF_CHECK_DEFINITION,
  );
  assert.match(PLATFORM_CONNECTION_SECRET_REF_CHECK_DEFINITION,
    /char_length\(credential_secret_ref\) >= 1/);
  assert.match(PLATFORM_CONNECTION_SECRET_REF_CHECK_DEFINITION,
    /char_length\(credential_secret_ref\) <= 512/);
  assert.doesNotMatch(PLATFORM_CONNECTION_SECRET_REF_CHECK_DEFINITION, /\{\d+,\d+\}/);
});

test('operator release is atomic, idempotent-shaped, role-bound, validated, and exact-readiness checked', () => {
  assert.match(RELEASE_MIGRATION, /BEGIN;[\s\S]*COMMIT;/);
  assert.match(RELEASE_MIGRATION, /SET LOCAL search_path = public, pg_temp/);
  assert.match(RELEASE_MIGRATION,
    /pg_advisory_xact_lock\([\s\S]*peakos-platform-connection-secret-ref-constraint-v2/);
  assert.match(RELEASE_MIGRATION, /current_setting\('peakos\.app_role', TRUE\)/);
  assert.match(RELEASE_MIGRATION,
    /DROP CONSTRAINT IF EXISTS peakos_platform_connections_secret_ref_check/);
  assert.match(RELEASE_MIGRATION,
    /ADD CONSTRAINT peakos_platform_connections_secret_ref_check[\s\S]*NOT VALID/);
  assert.match(RELEASE_MIGRATION,
    /VALIDATE CONSTRAINT peakos_platform_connections_secret_ref_check/);
  assert.match(RELEASE_MIGRATION, /pg_get_constraintdef\(constraint_catalog\.oid\)/);
  assert.match(RELEASE_MIGRATION, /actual_validated IS DISTINCT FROM TRUE/);
  assert.match(RELEASE_MIGRATION, /actual_definition IS DISTINCT FROM expected_definition/);
  assert.match(RELEASE_MIGRATION,
    /GRANT SELECT, INSERT ON TABLE public\.peakos_platform_connections TO %I/);
  assert.match(RELEASE_MIGRATION,
    /ARRAY\[[\s\S]*'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'[\s\S]*\]/);
});

const postgresUrl = process.env.PEAKOS_PLATFORM_TEST_DATABASE_URL || '';

test('disposable PostgreSQL releases valid env refs and rejects invalid, oversized, and invalid NULL states', {
  skip: !postgresUrl,
  timeout: 45_000,
}, async t => {
  const databaseName = decodeURIComponent(new URL(postgresUrl).pathname.replace(/^\//, ''));
  assert.match(databaseName, /test/i,
    'PEAKOS_PLATFORM_TEST_DATABASE_URL must name a dedicated test database');

  const { Client } = require('pg');
  const admin = new Client({ connectionString: postgresUrl });
  const runtimeRole = 'peakos_platform_constraint_runtime';
  await admin.connect();

  t.after(async () => {
    await admin.query('RESET ROLE').catch(() => {});
    await admin.query('DROP TABLE IF EXISTS public.peakos_platform_connections CASCADE').catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`).catch(() => {});
    await admin.end();
  });

  const existing = await admin.query(
    "SELECT to_regclass('public.peakos_platform_connections') AS relation",
  );
  assert.equal(existing.rows[0].relation, null,
    'platform constraint PostgreSQL test database must start without the managed table');

  await admin.query(`
    DROP ROLE IF EXISTS ${runtimeRole};
    CREATE ROLE ${runtimeRole} NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE TABLE public.peakos_platform_connections (
      workspace_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      version INTEGER NOT NULL,
      connection_state TEXT NOT NULL DEFAULT 'pending',
      credential_secret_ref TEXT,
      last_error_code TEXT,
      actor_uid TEXT NOT NULL,
      PRIMARY KEY (workspace_id, provider, version),
      CONSTRAINT peakos_platform_connections_state_check
        CHECK (connection_state IN ('pending', 'ready', 'error', 'disabled')),
      CONSTRAINT peakos_platform_connections_secret_ref_check
        CHECK (
          credential_secret_ref IS NULL
          OR credential_secret_ref ~ '^[A-Za-z0-9][A-Za-z0-9:/._-]{0,511}$'
        ),
      CONSTRAINT peakos_platform_connections_ready_secret_check
        CHECK (connection_state <> 'ready' OR credential_secret_ref IS NOT NULL),
      CONSTRAINT peakos_platform_connections_error_check
        CHECK (
          (connection_state = 'error' AND last_error_code IS NOT NULL
            AND last_error_code ~ '^[A-Z0-9_]{1,80}$')
          OR (connection_state <> 'error' AND last_error_code IS NULL)
        )
    );
  `);

  const insertSql = `INSERT INTO public.peakos_platform_connections
    (workspace_id, provider, version, connection_state, credential_secret_ref,
     last_error_code, actor_uid)
    VALUES ($1, 'rewardspace', $2, $3, $4, $5, 'constraint-test')`;

  await assert.rejects(
    admin.query(insertSql, ['before-release', 1, 'ready', 'env:PEAKOS_REWARDSPACE_API_KEY', null]),
    error => error.code === '2201B',
  );

  await admin.query("SELECT set_config('peakos.app_role', $1, false)", [runtimeRole]);
  await admin.query(RELEASE_MIGRATION);
  await admin.query(RELEASE_MIGRATION);

  const constraint = await admin.query(`
    SELECT constraint_catalog.contype,
           constraint_catalog.convalidated,
           pg_get_constraintdef(constraint_catalog.oid) AS definition
      FROM pg_constraint constraint_catalog
     WHERE constraint_catalog.conrelid = 'public.peakos_platform_connections'::regclass
       AND constraint_catalog.conname = 'peakos_platform_connections_secret_ref_check'
  `);
  assert.deepEqual(constraint.rows, [{
    contype: 'c',
    convalidated: true,
    definition: PLATFORM_CONNECTION_SECRET_REF_CHECK_DEFINITION,
  }]);

  await admin.query(`SET ROLE ${runtimeRole}`);
  await admin.query(insertSql,
    ['valid-env-ref', 1, 'ready', 'env:PEAKOS_REWARDSPACE_API_KEY', null]);
  await admin.query(insertSql,
    ['max-length-ref', 1, 'ready', `A${'.'.repeat(511)}`, null]);
  await admin.query(insertSql, ['pending-without-ref', 1, 'pending', null, null]);
  await admin.query(insertSql,
    ['error-without-ref', 1, 'error', null, 'PLATFORM_CONNECTOR_HTTP_ERROR']);

  await assert.rejects(
    admin.query(insertSql, ['invalid-alphabet', 1, 'ready', 'env:BAD KEY', null]),
    error => error.code === '23514'
      && error.constraint === 'peakos_platform_connections_secret_ref_check',
  );
  await assert.rejects(
    admin.query(insertSql, ['too-long', 1, 'ready', `A${'.'.repeat(512)}`, null]),
    error => error.code === '23514'
      && error.constraint === 'peakos_platform_connections_secret_ref_check',
  );
  await assert.rejects(
    admin.query(insertSql, ['ready-without-ref', 1, 'ready', null, null]),
    error => error.code === '23514'
      && error.constraint === 'peakos_platform_connections_ready_secret_check',
  );
  await assert.rejects(
    admin.query(insertSql, ['error-without-code', 1, 'error', null, null]),
    error => error.code === '23514'
      && error.constraint === 'peakos_platform_connections_error_check',
  );
  await assert.rejects(
    admin.query("UPDATE public.peakos_platform_connections SET connection_state = 'disabled'"),
    error => error.code === '42501',
  );
});
