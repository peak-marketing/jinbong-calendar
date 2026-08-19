-- Meetings scheduled against a project category.
--
-- A meeting hangs off a 중분류 (and optionally a 소분류) so it sits with the work
-- it is about. Attendees live in their own table because we need one row per
-- person to drive calendar sharing and, later, attendance.
--
-- The calendar link is deliberately loose: events.project_id has a foreign key
-- to the legacy projects table and cannot hold a structured project id, so the
-- meeting keeps the event id instead of the event keeping the meeting id.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-structured-meetings-v1'));

DO $structured_meeting_prerequisites$
BEGIN
  IF to_regclass('public.peakos_structured_project_small_categories') IS NULL THEN
    RAISE EXCEPTION 'structured project migration must be applied before meetings'
      USING ERRCODE = '55000';
  END IF;
END
$structured_meeting_prerequisites$;

CREATE TABLE IF NOT EXISTS peakos_structured_project_meetings (
  workspace_id TEXT NOT NULL,
  project_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  medium_category_id UUID NOT NULL,
  small_category_id UUID,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  organizer_uid TEXT NOT NULL,
  organizer_name_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  event_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_uid TEXT NOT NULL,
  created_by_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT peakos_structured_project_meetings_pkey
    PRIMARY KEY (workspace_id, project_id, id),
  CONSTRAINT peakos_structured_project_meetings_project_fk
    FOREIGN KEY (workspace_id, project_id)
    REFERENCES peakos_structured_projects(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_meetings_medium_fk
    FOREIGN KEY (workspace_id, project_id, medium_category_id)
    REFERENCES peakos_structured_project_medium_categories(workspace_id, project_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_meetings_small_hierarchy_fk
    FOREIGN KEY (workspace_id, project_id, medium_category_id, small_category_id)
    REFERENCES peakos_structured_project_small_categories(workspace_id, project_id, medium_category_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_meetings_organizer_fk
    FOREIGN KEY (workspace_id, project_id, organizer_uid)
    REFERENCES peakos_structured_project_members(workspace_id, project_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_meetings_creator_membership_fk
    FOREIGN KEY (workspace_id, created_by_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_structured_project_meetings_status_check
    CHECK (status = ANY (ARRAY['scheduled', 'done', 'cancelled'])),
  CONSTRAINT peakos_structured_project_meetings_title_check
    CHECK (btrim(title) <> '' AND length(title) <= 180),
  CONSTRAINT peakos_structured_project_meetings_span_check
    CHECK (end_date >= start_date),
  CONSTRAINT peakos_structured_project_meetings_start_time_check
    CHECK (start_time = '' OR start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT peakos_structured_project_meetings_end_time_check
    CHECK (end_time = '' OR (start_time <> '' AND end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')),
  -- 하루짜리 회의는 끝나는 시각이 시작보다 뒤여야 한다. 여러 날에 걸치면 시각 비교가 의미 없다.
  CONSTRAINT peakos_structured_project_meetings_time_order_check
    CHECK (end_time = '' OR end_date > start_date OR end_time > start_time),
  CONSTRAINT peakos_structured_project_meetings_version_check
    CHECK (version >= 1 AND version <= 2147483647)
);

CREATE INDEX IF NOT EXISTS peakos_structured_project_meetings_medium_idx
  ON peakos_structured_project_meetings (workspace_id, project_id, medium_category_id, start_date);

CREATE TABLE IF NOT EXISTS peakos_structured_project_meeting_attendees (
  workspace_id TEXT NOT NULL,
  project_id UUID NOT NULL,
  meeting_id UUID NOT NULL,
  user_uid TEXT NOT NULL,
  user_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT peakos_structured_project_meeting_attendees_pkey
    PRIMARY KEY (workspace_id, project_id, meeting_id, user_uid),
  CONSTRAINT peakos_structured_project_meeting_attendees_meeting_fk
    FOREIGN KEY (workspace_id, project_id, meeting_id)
    REFERENCES peakos_structured_project_meetings(workspace_id, project_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT peakos_structured_project_meeting_attendees_member_fk
    FOREIGN KEY (workspace_id, project_id, user_uid)
    REFERENCES peakos_structured_project_members(workspace_id, project_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

COMMIT;
