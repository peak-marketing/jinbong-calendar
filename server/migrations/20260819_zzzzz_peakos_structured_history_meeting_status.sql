-- Lets history record a meeting's status transitions.
--
-- from_status/to_status already mixed project statuses with task statuses, but
-- meetings introduced 'scheduled' and 'cancelled'. Cancelling a meeting wrote
-- scheduled -> cancelled and the whole transaction rolled back, so the meeting
-- stayed on screen and nothing said why.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-structured-history-meeting-status-v1'));

ALTER TABLE peakos_structured_project_history
  DROP CONSTRAINT IF EXISTS peakos_structured_project_history_from_status_check;
ALTER TABLE peakos_structured_project_history
  DROP CONSTRAINT IF EXISTS peakos_structured_project_history_to_status_check;

ALTER TABLE peakos_structured_project_history
  ADD CONSTRAINT peakos_structured_project_history_from_status_check
  CHECK (from_status = '' OR from_status = ANY (ARRAY[
    'active', 'completed', 'archived',
    'todo', 'acknowledged', 'doing', 'review', 'revision', 'done',
    'scheduled', 'cancelled']));

ALTER TABLE peakos_structured_project_history
  ADD CONSTRAINT peakos_structured_project_history_to_status_check
  CHECK (to_status = '' OR to_status = ANY (ARRAY[
    'active', 'completed', 'archived',
    'todo', 'acknowledged', 'doing', 'review', 'revision', 'done',
    'scheduled', 'cancelled']));

COMMIT;
