-- Optional end clock for canonical events.
--
-- Existing `events.time` values remain the start clock. Keeping the new column
-- nullable makes every pre-existing single-time event backwards-compatible;
-- PEAK OS can progressively add an end clock without rewriting legacy rows.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-event-end-time-v1'));

DO $event_end_time_prerequisites$
BEGIN
  IF to_regclass('public.events') IS NULL THEN
    RAISE EXCEPTION 'events migration must be applied before event end time'
      USING ERRCODE = '55000';
  END IF;
END
$event_end_time_prerequisites$;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS end_time TEXT;

DO $event_end_time_column_type$
DECLARE
  actual_type TEXT;
BEGIN
  SELECT data_type
    INTO actual_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'events'
     AND column_name = 'end_time';
  IF actual_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'events.end_time must be text, found %', COALESCE(actual_type, 'missing')
      USING ERRCODE = '42804';
  END IF;
END
$event_end_time_column_type$;

-- Recreate the named check on every operator rerun. `IF NOT EXISTS` alone is
-- unsafe here: a same-named but weaker check would otherwise be accepted as
-- ready forever. The resulting schema state is idempotent and exact.
ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_end_time_range_check;

ALTER TABLE public.events
  ADD CONSTRAINT events_end_time_range_check
  CHECK (
    end_time IS NULL
    OR end_time = ''
    OR (
      end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND COALESCE(time, '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      AND end_time > substring(time FROM 1 FOR 5)
    )
  ) NOT VALID;

ALTER TABLE public.events
  VALIDATE CONSTRAINT events_end_time_range_check;

COMMENT ON COLUMN public.events.end_time IS
  'Optional local end clock (HH:MM); events.time remains the start clock.';

COMMIT;
