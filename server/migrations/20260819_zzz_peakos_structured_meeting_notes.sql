-- Meeting notes and the action items that come out of a meeting.
--
-- The point of this table is the task_id column: an action item written down
-- during a meeting turns into a real project task, and the link stays so the
-- next meeting can show what actually happened to it.
--
-- Grants are spelled out because the schema default hands the runtime role
-- DELETE/TRUNCATE, which the readiness check refuses to start with.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-structured-meeting-notes-v1'));

DO $structured_meeting_notes_prerequisites$
BEGIN
  IF to_regclass('public.peakos_structured_project_meetings') IS NULL THEN
    RAISE EXCEPTION 'meeting migration must be applied before meeting notes'
      USING ERRCODE = '55000';
  END IF;
END
$structured_meeting_notes_prerequisites$;

ALTER TABLE peakos_structured_project_meetings
  ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS notes_written_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes_written_by_uid TEXT,
  ADD COLUMN IF NOT EXISTS notes_written_by_name_snapshot TEXT;

CREATE TABLE IF NOT EXISTS peakos_structured_project_meeting_action_items (
  workspace_id TEXT NOT NULL,
  project_id UUID NOT NULL,
  meeting_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  assignee_uid TEXT,
  assignee_name_snapshot TEXT,
  due_date DATE,
  task_id UUID,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_uid TEXT NOT NULL,
  created_by_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT peakos_structured_project_meeting_action_items_pkey
    PRIMARY KEY (workspace_id, project_id, id),
  CONSTRAINT peakos_structured_project_meeting_action_items_meeting_fk
    FOREIGN KEY (workspace_id, project_id, meeting_id)
    REFERENCES peakos_structured_project_meetings(workspace_id, project_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_meeting_action_items_assignee_fk
    FOREIGN KEY (workspace_id, project_id, assignee_uid)
    REFERENCES peakos_structured_project_members(workspace_id, project_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_meeting_action_items_task_fk
    FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES peakos_structured_project_tasks(workspace_id, project_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_meeting_action_items_title_check
    CHECK (btrim(title) <> '' AND length(title) <= 200),
  -- 담당자 없이 업무로 만들 수는 없다. 업무는 담당자가 반드시 있어야 한다.
  CONSTRAINT peakos_structured_project_meeting_action_items_task_assignee_ch
    CHECK (task_id IS NULL OR assignee_uid IS NOT NULL),
  CONSTRAINT peakos_structured_project_meeting_action_items_assignee_pair_ch
    CHECK ((assignee_uid IS NULL) = (assignee_name_snapshot IS NULL))
);

CREATE INDEX IF NOT EXISTS peakos_structured_project_meeting_action_items_meeting_idx
  ON peakos_structured_project_meeting_action_items (workspace_id, project_id, meeting_id, sort_order);

REVOKE ALL ON peakos_structured_project_meeting_action_items FROM calendar_user;
GRANT SELECT, INSERT, UPDATE ON peakos_structured_project_meeting_action_items TO calendar_user;

COMMIT;
