'use strict';

const EVENT_END_TIME_COLUMN = 'end_time';
const EVENT_TIME_RANGE_CONSTRAINT = 'events_end_time_range_check';
const EVENT_TIME_RANGE_CONSTRAINT_DEFINITION = [
  'CHECK (end_time IS NULL',
  "OR end_time = ''::text",
  "OR end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text",
  "AND COALESCE(\"time\", ''::text) ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'::text",
  'AND end_time > SUBSTRING("time" FROM 1 FOR 5))',
].join(' ');

function eventTimeInfrastructureError(message) {
  return Object.assign(new Error(message), {
    code: 'PEAKOS_EVENT_TIME_RANGE_MIGRATION_REQUIRED',
    statusCode: 503,
  });
}

function eventTimeError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function normalizeEventClock(value, label = '시간') {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) throw eventTimeError(`${label}을 HH:MM 형식으로 확인해 주세요.`);
  return `${match[1]}:${match[2]}`;
}

function clockMinutes(value) {
  const [hour, minute] = value.split(':').map(Number);
  return (hour * 60) + minute;
}

function validateEventTimeRange(startValue, endValue) {
  const startTime = normalizeEventClock(startValue, '시작 시간');
  const endTime = normalizeEventClock(endValue, '종료 시간');
  if (endTime && !startTime) throw eventTimeError('종료 시간을 정하려면 시작 시간을 먼저 입력해 주세요.');
  if (startTime && endTime && clockMinutes(endTime) <= clockMinutes(startTime)) {
    throw eventTimeError('종료 시간은 시작 시간보다 뒤여야 합니다.');
  }
  return { startTime, endTime };
}

// The canonical endpoint has PATCH-like semantics even though it uses PUT:
// null/undefined mean "leave unchanged", while an empty string explicitly
// clears a clock. Protected OS clients submit the two clocks as one pair. The
// legacy Paragon client only knows `time`, so an unchanged start preserves a
// hidden OS end clock, while changing or clearing that start also clears the
// end clock rather than leaving an invisible, invalid range behind.
function resolveEventTimeRangeUpdate({
  existingStartTime,
  existingEndTime,
  requestedStartTime,
  requestedEndTime,
  legacyRequest = false,
} = {}) {
  const startProvided = requestedStartTime != null;
  const endProvided = requestedEndTime != null;
  if (!startProvided && !endProvided) {
    return { startTime: undefined, endTime: undefined };
  }

  const existingStart = normalizeEventClock(existingStartTime, '기존 시작 시간');
  const existingEnd = normalizeEventClock(existingEndTime, '기존 종료 시간');
  let startUpdate = startProvided
    ? normalizeEventClock(requestedStartTime, '시작 시간')
    : undefined;
  let endUpdate = endProvided
    ? normalizeEventClock(requestedEndTime, '종료 시간')
    : undefined;

  if (legacyRequest && startProvided && !endProvided && startUpdate !== existingStart) {
    endUpdate = '';
  }
  if (startUpdate === '' && endUpdate === undefined) endUpdate = '';

  const resolved = validateEventTimeRange(
    startUpdate === undefined ? existingStart : startUpdate,
    endUpdate === undefined ? existingEnd : endUpdate,
  );
  return {
    startTime: startProvided ? resolved.startTime : undefined,
    endTime: endUpdate === undefined ? undefined : resolved.endTime,
  };
}

function normalizeConstraintDefinition(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function ensureEventTimeRangeInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('event time range readiness requires a database pool.');
  }
  const column = await pool.query(
    `SELECT data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'events'
        AND column_name = $1`,
    [EVENT_END_TIME_COLUMN],
  );
  if (column.rows[0]?.data_type !== 'text') {
    throw eventTimeInfrastructureError(
      'event end-time migration is missing or has the wrong column type.',
    );
  }
  const constraint = await pool.query(
    `SELECT convalidated,
            pg_get_constraintdef(oid, TRUE) AS definition
       FROM pg_constraint
      WHERE conrelid = 'public.events'::regclass
        AND conname = $1
        AND contype = 'c'`,
    [EVENT_TIME_RANGE_CONSTRAINT],
  );
  const constraintRow = constraint.rows[0];
  if (constraintRow?.convalidated !== true) {
    throw eventTimeInfrastructureError(
      'event end-time validation constraint is missing or not validated.',
    );
  }
  if (normalizeConstraintDefinition(constraintRow.definition)
      !== EVENT_TIME_RANGE_CONSTRAINT_DEFINITION) {
    throw eventTimeInfrastructureError(
      'event end-time validation constraint has the wrong definition.',
    );
  }
  return true;
}

module.exports = {
  EVENT_END_TIME_COLUMN,
  EVENT_TIME_RANGE_CONSTRAINT,
  EVENT_TIME_RANGE_CONSTRAINT_DEFINITION,
  ensureEventTimeRangeInfrastructure,
  normalizeEventClock,
  resolveEventTimeRangeUpdate,
  validateEventTimeRange,
};
