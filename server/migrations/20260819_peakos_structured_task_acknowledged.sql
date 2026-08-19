-- Adds the "확인완료(acknowledged)" step between 지시 받음 and 진행중.
--
-- The assignee now picks their own state: 확인완료 → 진행중 → 진행완료.
-- Only the allowed-value list widens; no row is rewritten and every existing
-- status stays valid, so this is safe to apply while the app is running.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-structured-task-acknowledged-v1'));

DO $structured_task_acknowledged_prerequisites$
BEGIN
  IF to_regclass('public.peakos_structured_project_tasks') IS NULL THEN
    RAISE EXCEPTION 'structured project migration must be applied before the acknowledged status'
      USING ERRCODE = '55000';
  END IF;
END
$structured_task_acknowledged_prerequisites$;

ALTER TABLE peakos_structured_project_tasks
  DROP CONSTRAINT IF EXISTS peakos_structured_project_tasks_status_check;

ALTER TABLE peakos_structured_project_tasks
  ADD CONSTRAINT peakos_structured_project_tasks_status_check
  CHECK (status = ANY (ARRAY['todo', 'acknowledged', 'doing', 'review', 'revision', 'done']));

COMMIT;
