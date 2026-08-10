BEGIN;

ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS role_label TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS assigned_by_uid TEXT,
  ADD COLUMN IF NOT EXISTS assigned_by_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reviewer_uid TEXT,
  ADD COLUMN IF NOT EXISTS reviewer_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_note TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS workflow_version INTEGER NOT NULL DEFAULT 1;

UPDATE project_tasks pt
SET assigned_by_uid = COALESCE(pt.assigned_by_uid, pt.created_by, p.owner_id),
    assigned_by_name = CASE
      WHEN pt.assigned_by_name <> '' THEN pt.assigned_by_name
      ELSE COALESCE((SELECT name FROM users WHERE uid = COALESCE(pt.created_by, p.owner_id)), '')
    END,
    reviewer_uid = COALESCE(pt.reviewer_uid, p.owner_id),
    reviewer_name = CASE
      WHEN pt.reviewer_name <> '' THEN pt.reviewer_name
      ELSE COALESCE((SELECT name FROM users WHERE uid = p.owner_id), '')
    END,
    review_requested_at = CASE
      WHEN pt.status = 'review' THEN COALESCE(pt.review_requested_at, pt.updated_at)
      ELSE pt.review_requested_at
    END,
    reviewed_at = CASE
      WHEN pt.status = 'done' THEN COALESCE(pt.reviewed_at, pt.updated_at)
      ELSE pt.reviewed_at
    END
FROM projects p
WHERE p.id = pt.project_id
  AND (
    pt.assigned_by_uid IS NULL
    OR pt.assigned_by_name = ''
    OR pt.reviewer_uid IS NULL
    OR pt.reviewer_name = ''
    OR (pt.status = 'review' AND pt.review_requested_at IS NULL)
    OR (pt.status = 'done' AND pt.reviewed_at IS NULL)
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_tasks'::regclass
      AND conname = 'project_tasks_workflow_version_positive'
  ) THEN
    ALTER TABLE project_tasks
      ADD CONSTRAINT project_tasks_workflow_version_positive CHECK (workflow_version > 0);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS project_task_workflow_events (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL DEFAULT '',
  due_date_snapshot TEXT NOT NULL DEFAULT '',
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_task_workflow_events_task
  ON project_task_workflow_events (project_id, task_id, created_at DESC);

COMMIT;
