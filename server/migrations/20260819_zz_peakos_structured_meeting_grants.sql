-- Brings the meeting tables in line with the rest of the structured project store.
--
-- Two things were wrong after the first meeting migration:
--   1. The tables inherited DELETE/TRUNCATE/REFERENCES/TRIGGER for the runtime
--      role from a schema default. Every other structured table grants only
--      SELECT/INSERT/UPDATE, and the readiness check refuses to start the API
--      when a table is more permissive than that.
--   2. Removing an attendee needed a DELETE. Nothing else in this store hard
--      deletes, so attendees get an active flag and are retired instead.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-structured-meeting-grants-v1'));

ALTER TABLE peakos_structured_project_meeting_attendees
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

REVOKE ALL ON peakos_structured_project_meetings FROM calendar_user;
REVOKE ALL ON peakos_structured_project_meeting_attendees FROM calendar_user;

GRANT SELECT, INSERT, UPDATE ON peakos_structured_project_meetings TO calendar_user;
GRANT SELECT, INSERT, UPDATE ON peakos_structured_project_meeting_attendees TO calendar_user;

COMMIT;
