'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  EVENT_TIME_RANGE_CONSTRAINT_DEFINITION,
  ensureEventTimeRangeInfrastructure,
  normalizeEventClock,
  resolveEventTimeRangeUpdate,
  validateEventTimeRange,
} = require('./event-time-range');

const INDEX_SOURCE = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
const MIGRATION_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../migrations/20260816_peakos_event_end_time.sql'),
  'utf8',
);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source start: ${start}`);
  assert.notEqual(endIndex, -1, `missing source end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('event time range accepts a valid start and later end', () => {
  assert.deepEqual(validateEventTimeRange('17:30', '19:00'), {
    startTime: '17:30',
    endTime: '19:00',
  });
});

test('event time range keeps existing single-start records compatible', () => {
  assert.deepEqual(validateEventTimeRange('09:30:00', ''), {
    startTime: '09:30',
    endTime: '',
  });
  assert.equal(normalizeEventClock(null), '');
  assert.deepEqual(validateEventTimeRange('', ''), { startTime: '', endTime: '' });
});

test('event time range rejects an end without a start or a non-later end', () => {
  assert.throws(
    () => validateEventTimeRange('', '19:00'),
    error => error.statusCode === 400 && /시작 시간/.test(error.message),
  );
  assert.throws(
    () => validateEventTimeRange('17:30', '17:30'),
    error => error.statusCode === 400 && /뒤여야/.test(error.message),
  );
  assert.throws(
    () => validateEventTimeRange('19:00', '17:30'),
    error => error.statusCode === 400 && /뒤여야/.test(error.message),
  );
});

test('event time range rejects malformed clocks', () => {
  assert.throws(() => validateEventTimeRange('24:00', ''), /HH:MM/);
  assert.throws(() => validateEventTimeRange('09:00', '09:75'), /HH:MM/);
});

test('OS range updates merge only omitted fields and validate the resolved pair', () => {
  assert.deepEqual(resolveEventTimeRangeUpdate({
    existingStartTime: '09:00',
    existingEndTime: '10:00',
    requestedStartTime: '17:30',
    requestedEndTime: '19:00',
  }), { startTime: '17:30', endTime: '19:00' });

  assert.deepEqual(resolveEventTimeRangeUpdate({
    existingStartTime: '09:00:00',
    existingEndTime: '10:00',
    requestedEndTime: '11:30',
  }), { startTime: undefined, endTime: '11:30' });

  assert.deepEqual(resolveEventTimeRangeUpdate({
    existingStartTime: '09:00',
    existingEndTime: '10:00',
    requestedStartTime: '',
    requestedEndTime: '',
  }), { startTime: '', endTime: '' });

  assert.throws(() => resolveEventTimeRangeUpdate({
    existingStartTime: '09:00',
    existingEndTime: '10:00',
    requestedStartTime: '10:30',
  }), /뒤여야/);
});

test('legacy start-only updates preserve an unchanged range and clear it on a real change', () => {
  assert.deepEqual(resolveEventTimeRangeUpdate({
    existingStartTime: '09:00:00',
    existingEndTime: '10:00',
    requestedStartTime: '09:00',
    legacyRequest: true,
  }), { startTime: '09:00', endTime: undefined });

  assert.deepEqual(resolveEventTimeRangeUpdate({
    existingStartTime: '09:00',
    existingEndTime: '10:00',
    requestedStartTime: '11:00',
    legacyRequest: true,
  }), { startTime: '11:00', endTime: '' });

  assert.deepEqual(resolveEventTimeRangeUpdate({
    existingStartTime: '09:00',
    existingEndTime: '10:00',
    requestedStartTime: '',
    legacyRequest: true,
  }), { startTime: '', endTime: '' });

  assert.deepEqual(resolveEventTimeRangeUpdate({
    existingStartTime: '09:00',
    existingEndTime: '10:00',
    requestedEndTime: '10:30',
    legacyRequest: true,
  }), { startTime: undefined, endTime: '10:30' });
});

test('an unrelated partial update neither validates nor rewrites stored clocks', () => {
  assert.deepEqual(resolveEventTimeRangeUpdate({
    existingStartTime: 'historical-value',
    existingEndTime: 'also-historical',
    requestedStartTime: null,
    requestedEndTime: undefined,
    legacyRequest: true,
  }), { startTime: undefined, endTime: undefined });
});

test('event time range readiness requires the exact validated check definition', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (queries.length === 1) return { rows: [{ data_type: 'text' }] };
      return {
        rows: [{
          convalidated: true,
          definition: `  ${EVENT_TIME_RANGE_CONSTRAINT_DEFINITION.replaceAll(' ', '  ')}  `,
        }],
      };
    },
  };
  assert.equal(await ensureEventTimeRangeInfrastructure(pool), true);
  assert.equal(queries.length, 2);
  assert.match(queries[1].sql, /pg_get_constraintdef\(oid, TRUE\)/);

  await assert.rejects(
    () => ensureEventTimeRangeInfrastructure({
      query: async sql => /information_schema/.test(sql)
        ? { rows: [{ data_type: 'integer' }] }
        : { rows: [] },
    }),
    error => error.code === 'PEAKOS_EVENT_TIME_RANGE_MIGRATION_REQUIRED'
      && error.statusCode === 503,
  );

  await assert.rejects(
    () => ensureEventTimeRangeInfrastructure({
      query: async sql => /information_schema/.test(sql)
        ? { rows: [{ data_type: 'text' }] }
        : { rows: [{ convalidated: true, definition: 'CHECK (true)' }] },
    }),
    /wrong definition/,
  );

  await assert.rejects(
    () => ensureEventTimeRangeInfrastructure({
      query: async sql => /information_schema/.test(sql)
        ? { rows: [{ data_type: 'text' }] }
        : { rows: [{ convalidated: false, definition: EVENT_TIME_RANGE_CONSTRAINT_DEFINITION }] },
    }),
    /missing or not validated/,
  );
});

test('canonical event create and update persist one validated range and keep repeat children aligned', () => {
  const create = sourceBetween(
    INDEX_SOURCE,
    "app.post('/api/events', authMiddleware",
    'async function syncProjectStatus',
  );
  assert.match(create, /validateEventTimeRange\(time, endTime\)/);
  assert.ok(
    create.indexOf('validateEventTimeRange(time, endTime)') < create.indexOf('pool.connect()'),
    'invalid creates must fail before a transaction or INSERT starts',
  );
  assert.match(create, /INSERT INTO events \(workspace_id, type, title, date, time, end_time,/);
  assert.match(create, /normalizedRange\.startTime, normalizedRange\.endTime/);
  assert.match(create, /\(workspace_id,type,title,date,time,end_time,/);

  const update = sourceBetween(
    INDEX_SOURCE,
    "app.put('/api/events/:id', authMiddleware",
    '// ── Ideas',
  );
  assert.ok(
    update.indexOf("throw Object.assign(new Error('Not owner')")
      < update.indexOf('resolveEventTimeRangeUpdate({'),
    'ownership must be checked before accepting or validating a range mutation',
  );
  assert.match(
    update,
    /resolveEventTimeRangeUpdate\(\{[\s\S]*existingStartTime: ev\.rows\[0\]\.time,[\s\S]*existingEndTime: ev\.rows\[0\]\.end_time,[\s\S]*requestedStartTime: time,[\s\S]*requestedEndTime: endTime,[\s\S]*legacyRequest: !isPeakosCollaborationAuthenticated\(req\)/,
  );
  assert.ok(
    update.indexOf('resolveEventTimeRangeUpdate({') < update.indexOf('UPDATE events SET'),
    'invalid updates must fail before the event UPDATE is issued',
  );
  assert.match(update, /time=COALESCE\(\$4,time\), end_time=COALESCE\(\$5,end_time\)/);
  assert.match(update, /\[type, title, date, normalizedTime, normalizedEndTime,/);
});

test('event list round-trips end_time while reminders remain anchored to the start clock', () => {
  const list = sourceBetween(
    INDEX_SOURCE,
    "app.get('/api/events', authMiddleware",
    'function buildRepeatDates',
  );
  assert.match(list, /SELECT e\.\*/);

  const reminderSweep = sourceBetween(
    INDEX_SOURCE,
    'async function processEventReminderSweep()',
    '// ── Firebase ID Token',
  );
  assert.match(reminderSweep, /SELECT id, workspace_id, title, type, date, time, reminder,/);
  assert.match(reminderSweep, /getEventStartAt\(event\.date, event\.time\)/);
  assert.doesNotMatch(reminderSweep, /getEventStartAt\(event\.date, event\.end_time\)/);

  assert.match(MIGRATION_SOURCE, /ADD COLUMN IF NOT EXISTS end_time TEXT/);
  assert.match(MIGRATION_SOURCE, /DROP CONSTRAINT IF EXISTS events_end_time_range_check/);
  assert.match(MIGRATION_SOURCE, /ADD CONSTRAINT events_end_time_range_check[\s\S]*NOT VALID/);
  assert.match(MIGRATION_SOURCE, /VALIDATE CONSTRAINT events_end_time_range_check/);
  assert.ok(
    MIGRATION_SOURCE.indexOf('DROP CONSTRAINT IF EXISTS events_end_time_range_check')
      < MIGRATION_SOURCE.indexOf('ADD CONSTRAINT events_end_time_range_check'),
    'a rerun must replace a same-named but incorrect constraint',
  );
  assert.doesNotMatch(MIGRATION_SOURCE, /UPDATE\s+events|DEFAULT\s+/i);
});
