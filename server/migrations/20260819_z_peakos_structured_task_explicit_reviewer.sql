-- Lets a task carry an explicitly chosen reviewer.
--
-- Until now the reviewer was always derived: the 지시자, or the project lead as
-- a fallback. Widening reviewer_source keeps both derived values valid and adds
-- 'explicit' for a reviewer the assigner picked directly. No row is rewritten.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-structured-task-explicit-reviewer-v1'));

DO $structured_task_reviewer_prerequisites$
BEGIN
  IF to_regclass('public.peakos_structured_project_tasks') IS NULL THEN
    RAISE EXCEPTION 'structured project migration must be applied before explicit reviewers'
      USING ERRCODE = '55000';
  END IF;
END
$structured_task_reviewer_prerequisites$;

ALTER TABLE peakos_structured_project_tasks
  DROP CONSTRAINT IF EXISTS peakos_structured_project_tasks_reviewer_source_check;

ALTER TABLE peakos_structured_project_tasks
  ADD CONSTRAINT peakos_structured_project_tasks_reviewer_source_check
  CHECK (reviewer_source = ANY (ARRAY['assigned_by', 'lead_fallback', 'explicit']));

COMMIT;
