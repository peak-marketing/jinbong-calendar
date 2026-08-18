'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  ATTENDANCE_SCHEMA_READINESS_SQL,
  AttendanceInfrastructureError,
  ensurePeakosAttendanceInfrastructure,
} = require('./peakos-attendance-infrastructure');

const MIGRATION = fs.readFileSync(path.join(
  __dirname,
  '..',
  'migrations',
  '20260818_peakos_attendance_workspace.sql',
), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('migration uses a frozen lineage plan and never guesses ws_peak for unmapped history', () => {
  assert.match(MIGRATION, /CREATE TEMPORARY TABLE peakos_attendance_backfill_plan/);
  assert.match(MIGRATION, /direct_lineage\.candidate_count = 1/);
  assert.match(MIGRATION, /direct_lineage\.candidate_count = 0 AND group_lineage\.candidate_count = 1/);
  assert.match(MIGRATION, /planned_rows <> source_rows/);
  assert.match(MIGRATION, /attendance workspace lineage is missing or ambiguous/);
  assert.doesNotMatch(MIGRATION, /ELSE\s+'ws_peak'/);
  assert.doesNotMatch(MIGRATION, /COALESCE\([^)]*workspace_id[^)]*'ws_peak'/s);
});

test('migration records aggregate mapping evidence without account PII', () => {
  assert.match(MIGRATION, /'directMembershipRows'/);
  assert.match(MIGRATION, /'groupLineageRows'/);
  assert.match(MIGRATION, /'unmappedOrAmbiguousRows', 0/);
  assert.match(MIGRATION, /'totalRows'/);
  assert.doesNotMatch(MIGRATION, /jsonb_build_object\([\s\S]{0,500}'userUid'/);
});

test('migration adds tenant uniqueness, canonical KST instants, immutable check-in and append-only audit', () => {
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS peakos_attendance_workspace_user_date_unique/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS peakos_attendance_workspace_id_unique/);
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS public\.peakos_attendance_events/);
  assert.match(MIGRATION, /DROP TRIGGER IF EXISTS peakos_attendance_events_no_mutation/);
  assert.match(MIGRATION, /check_in_at TIMESTAMPTZ/);
  assert.match(MIGRATION, /AT TIME ZONE 'Asia\/Seoul'/);
  assert.match(MIGRATION, /attendance identity\/check-in is immutable and check-out is write-once/);
  assert.match(MIGRATION, /peakos_attendance_events_no_mutation/);
  assert.match(MIGRATION, /REVOKE ALL PRIVILEGES ON TABLE public\.attendance/);
});

test('readiness is SELECT-only, exact and fails closed with migration name', async () => {
  assert.match(ATTENDANCE_SCHEMA_READINESS_SQL, /legacy-global-unique/);
  assert.match(ATTENDANCE_SCHEMA_READINESS_SQL, /trigger-definition/);
  assert.match(ATTENDANCE_SCHEMA_READINESS_SQL, /table-privilege/);
  assert.match(ATTENDANCE_SCHEMA_READINESS_SQL, /unmappedOrAmbiguousRows/);
  const executableSql = ATTENDANCE_SCHEMA_READINESS_SQL
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/--[^\n]*/g, '');
  assert.match(executableSql.trimStart(), /^WITH\b/i);
  assert.doesNotMatch(executableSql, /\b(?:ALTER|CREATE|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE)\b/i);

  await assert.rejects(
    ensurePeakosAttendanceInfrastructure({
      query: async () => ({ rows: [{ missing: ['column-definition:attendance.workspace_id'] }] }),
    }),
    error => error instanceof AttendanceInfrastructureError
      && error.code === 'ATTENDANCE_SCHEMA_NOT_READY'
      && error.statusCode === 503,
  );
  await assert.doesNotReject(ensurePeakosAttendanceInfrastructure({
    query: async () => ({ rows: [{ missing: [] }] }),
  }));
});

test('server checks attendance readiness immediately after workspace readiness and before startup writes', () => {
  const startup = SERVER.slice(SERVER.indexOf('async function startServer()'));
  const workspaceReady = startup.indexOf('await ensurePeakosWorkspaceInfrastructure(pool);');
  const attendanceReady = startup.indexOf('await ensurePeakosAttendanceInfrastructure(pool);');
  const firstLegacyEnsure = startup.indexOf('await ensureReminderInfrastructure();');
  assert.ok(workspaceReady >= 0);
  assert.ok(attendanceReady > workspaceReady);
  assert.ok(firstLegacyEnsure > attendanceReady);
  assert.equal(startup.indexOf('await ensurePeakosAttendanceInfrastructure(pool);', attendanceReady + 1), -1);
});
