'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const {
  TODO_MIGRATION_PATH,
  TODO_REQUIRED_COLUMNS,
  TODO_REQUIRED_CONSTRAINTS,
  TODO_REQUIRED_FUNCTIONS,
  TODO_REQUIRED_INDEXES,
  TODO_REQUIRED_TRIGGERS,
  TODO_SCHEMA_READINESS_SQL,
  TODO_TABLES,
  ensurePeakosTodoInfrastructure,
} = require('./peakos-todo-infrastructure');

test('operator migration is schema-only, idempotent-shaped, isolated, audited, and least-privilege', () => {
  const sql = fs.readFileSync(TODO_MIGRATION_PATH, 'utf8');
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.peakos_todos/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.peakos_todo_audit/);
  assert.match(sql, /peakos_todo_audit_no_mutation/);
  assert.match(sql, /peakos_todos_no_delete/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.peakos_todos/);
  assert.match(sql, /GRANT SELECT ON TABLE public\.peakos_todo_audit/);
  assert.doesNotMatch(sql, /\b(?:events|projects|peakos_structured_projects)\b/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+public\.peakos_todos/i);
  assert.doesNotMatch(sql, /GRANT[^;]*(?:DELETE|TRUNCATE|REFERENCES|TRIGGER)[^;]*peakos_todos/i);
});

test('readiness executes one SELECT-only catalog query and returns exact counts', async () => {
  const calls = [];
  const result = await ensurePeakosTodoInfrastructure({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ ready: true, missing_requirements: [] }] };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, TODO_SCHEMA_READINESS_SQL);
  assert.match(TODO_SCHEMA_READINESS_SQL.trim(), /^WITH\s/);
  assert.equal(TODO_SCHEMA_READINESS_SQL.includes(';'), false);
  assert.deepEqual(result, {
    checkedTables: TODO_TABLES.length,
    checkedColumns: TODO_REQUIRED_COLUMNS.length,
    checkedConstraints: TODO_REQUIRED_CONSTRAINTS.length,
    checkedIndexes: TODO_REQUIRED_INDEXES.length,
    checkedTriggers: TODO_REQUIRED_TRIGGERS.length,
    checkedFunctions: TODO_REQUIRED_FUNCTIONS.length,
  });
});

test('readiness fails closed without attempting runtime repair', async () => {
  let calls = 0;
  await assert.rejects(
    ensurePeakosTodoInfrastructure({
      async query() {
        calls += 1;
        return {
          rows: [{
            ready: false,
            missing_requirements: ['trigger-definition:peakos_todos.peakos_todos_guard_update'],
          }],
        };
      },
    }),
    error => error.code === 'TODO_SCHEMA_NOT_READY'
      && error.missing[0].startsWith('trigger-definition:'),
  );
  assert.equal(calls, 1);
});

const postgresUrl = process.env.PEAKOS_TODO_TEST_DATABASE_URL || '';

test('disposable PostgreSQL validates migration idempotency, tamper detection, ACLs, and append-only audit', {
  skip: !postgresUrl,
  timeout: 45_000,
}, async t => {
  const { Client } = require('pg');
  const migration = fs.readFileSync(TODO_MIGRATION_PATH, 'utf8');
  const admin = new Client({ connectionString: postgresUrl });
  await admin.connect();
  t.after(async () => admin.end());

  await admin.query(`
    DO $role$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
        CREATE ROLE calendar_user LOGIN;
      END IF;
    END
    $role$;
    CREATE TABLE public.peakos_workspaces (id TEXT PRIMARY KEY);
    CREATE TABLE public.peakos_workspace_memberships (
      workspace_id TEXT NOT NULL REFERENCES public.peakos_workspaces(id),
      user_uid TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      role TEXT NOT NULL DEFAULT 'member',
      permissions JSONB NOT NULL DEFAULT '{"calendar":"write"}'::jsonb,
      PRIMARY KEY (workspace_id, user_uid)
    );
  `);
  await admin.query(migration);
  await admin.query(migration);

  async function readiness() {
    await admin.query('SET ROLE calendar_user');
    try {
      return (await admin.query(TODO_SCHEMA_READINESS_SQL)).rows[0];
    } finally {
      await admin.query('RESET ROLE');
    }
  }
  function assertMissing(row, prefix) {
    assert.equal(row.ready, false);
    assert.ok(row.missing_requirements.some(value => String(value).startsWith(prefix)),
      `${prefix}: ${JSON.stringify(row.missing_requirements)}`);
  }

  assert.deepEqual(await readiness(), { ready: true, missing_requirements: [] });

  await admin.query('ALTER TABLE peakos_todos ALTER COLUMN version SET DEFAULT 2');
  assertMissing(await readiness(), 'column-definition:peakos_todos.version');
  await admin.query('ALTER TABLE peakos_todos ALTER COLUMN version SET DEFAULT 1');

  await admin.query(`
    ALTER TABLE peakos_todos DROP CONSTRAINT peakos_todos_version_check;
    ALTER TABLE peakos_todos ADD CONSTRAINT peakos_todos_version_check CHECK (version >= 0);
  `);
  assertMissing(await readiness(), 'constraint-definition:peakos_todos.peakos_todos_version_check');
  await admin.query(`
    ALTER TABLE peakos_todos DROP CONSTRAINT peakos_todos_version_check;
    ALTER TABLE peakos_todos ADD CONSTRAINT peakos_todos_version_check
      CHECK (version BETWEEN 1 AND 2147483647);
  `);

  await admin.query('ALTER TABLE peakos_todos DISABLE TRIGGER peakos_todos_guard_update');
  assertMissing(await readiness(), 'trigger-definition:peakos_todos.peakos_todos_guard_update');
  await admin.query('ALTER TABLE peakos_todos ENABLE TRIGGER peakos_todos_guard_update');

  await admin.query('GRANT DELETE ON peakos_todos TO calendar_user');
  assertMissing(await readiness(), 'table-privilege:peakos_todos.DELETE');
  await admin.query('REVOKE DELETE ON peakos_todos FROM calendar_user');

  await admin.query('GRANT INSERT ON peakos_todo_audit TO calendar_user');
  assertMissing(await readiness(), 'table-privilege:peakos_todo_audit.INSERT');
  await admin.query('REVOKE INSERT ON peakos_todo_audit FROM calendar_user');

  await admin.query(`GRANT EXECUTE ON FUNCTION public.peakos_todo_write_audit()
    TO calendar_user`);
  assertMissing(await readiness(), 'function-privilege:peakos_todo_write_audit.execute');
  await admin.query(`REVOKE EXECUTE ON FUNCTION public.peakos_todo_write_audit()
    FROM calendar_user`);
  assert.deepEqual(await readiness(), { ready: true, missing_requirements: [] });

  await admin.query(`
    INSERT INTO peakos_workspaces(id) VALUES ('ws_test');
    INSERT INTO peakos_workspace_memberships(workspace_id, user_uid)
      VALUES ('ws_test', 'owner-uid');
  `);
  await admin.query('SET ROLE calendar_user');
  await assert.rejects(
    admin.query(`
      INSERT INTO peakos_todos
        (workspace_id,id,owner_uid,owner_name_snapshot,title,todo_date,end_time,
         last_changed_by_uid,last_changed_by_name_snapshot)
      VALUES
        ('ws_test','22222222-2222-4222-8222-222222222222','owner-uid','Owner',
         'Invalid time','2026-08-18','10:00','owner-uid','Owner')
    `),
    error => error.code === '23514' && error.constraint === 'peakos_todos_time_check',
  );
  await admin.query(`
    INSERT INTO peakos_todos
      (workspace_id,id,owner_uid,owner_name_snapshot,title,todo_date,
       last_changed_by_uid,last_changed_by_name_snapshot)
    VALUES
      ('ws_test','11111111-1111-4111-8111-111111111111','owner-uid','Owner',
       'Standalone','2026-08-18','owner-uid','Owner')
  `);
  const audit = await admin.query(`
    SELECT action, entity_version, before_state IS NULL AS initial
      FROM peakos_todo_audit
     WHERE workspace_id = 'ws_test'
  `);
  assert.deepEqual(audit.rows, [{ action: 'CREATE', entity_version: 1, initial: true }]);
  await assert.rejects(
    admin.query(`UPDATE peakos_todo_audit SET action = 'UPDATE' WHERE workspace_id = 'ws_test'`),
    error => error.code === '42501' || error.code === '55000',
  );
  await assert.rejects(
    admin.query(`DELETE FROM peakos_todos WHERE workspace_id = 'ws_test'`),
    error => error.code === '42501' || error.code === '55000',
  );
  await admin.query('RESET ROLE');
});
