-- The task status list gained "acknowledged" (확인완료), but the history table
-- still rejected it. Every 확인완료 click updated the task and then failed while
-- writing history, so the whole transaction rolled back and nothing changed.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-structured-history-acknowledged-v1'));

DO $structured_history_acknowledged_prerequisites$
BEGIN
  IF to_regclass('public.peakos_structured_project_history') IS NULL THEN
    RAISE EXCEPTION 'structured project history migration must be applied first'
      USING ERRCODE = '55000';
  END IF;
END
$structured_history_acknowledged_prerequisites$;

ALTER TABLE peakos_structured_project_history
  DROP CONSTRAINT IF EXISTS peakos_structured_project_history_from_status_check;
ALTER TABLE peakos_structured_project_history
  ADD CONSTRAINT peakos_structured_project_history_from_status_check
  CHECK (from_status = '' OR from_status = ANY (ARRAY[
    'active', 'completed', 'archived',
    'todo', 'acknowledged', 'doing', 'review', 'revision', 'done']));

ALTER TABLE peakos_structured_project_history
  DROP CONSTRAINT IF EXISTS peakos_structured_project_history_to_status_check;
ALTER TABLE peakos_structured_project_history
  ADD CONSTRAINT peakos_structured_project_history_to_status_check
  CHECK (to_status = '' OR to_status = ANY (ARRAY[
    'active', 'completed', 'archived',
    'todo', 'acknowledged', 'doing', 'review', 'revision', 'done']));

COMMIT;
