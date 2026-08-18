-- Structured project task attachments.
--
-- Files themselves live under /uploads (multer). This column only stores the
-- reference list so a task can show what was attached. Keeping it JSONB with a
-- '[]' default makes every existing row valid without a backfill.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-structured-task-attachments-v1'));

DO $structured_task_attachment_prerequisites$
BEGIN
  IF to_regclass('public.peakos_structured_project_tasks') IS NULL THEN
    RAISE EXCEPTION 'structured project migration must be applied before task attachments'
      USING ERRCODE = '55000';
  END IF;
END
$structured_task_attachment_prerequisites$;

ALTER TABLE peakos_structured_project_tasks
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN peakos_structured_project_tasks.attachments IS
  'Uploaded file references: [{url,name,size,mimeType}]. Files are stored under /uploads.';

COMMIT;
