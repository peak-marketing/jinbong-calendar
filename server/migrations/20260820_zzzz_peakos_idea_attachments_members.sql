-- Idea attachments, plus a third visibility: a named list of people.
--
-- 'members' sits between private and shared. The reader list lives in its own
-- table so the filter is a plain join and a departed account cannot be left
-- dangling. A private idea has no readers at all; a shared one needs no list.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-idea-attachments-members-v1'));

ALTER TABLE peakos_ideas
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE peakos_ideas
  DROP CONSTRAINT IF EXISTS peakos_ideas_attachments_check;
ALTER TABLE peakos_ideas
  ADD CONSTRAINT peakos_ideas_attachments_check
  CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 20);

ALTER TABLE peakos_ideas
  DROP CONSTRAINT IF EXISTS peakos_ideas_visibility_check;
ALTER TABLE peakos_ideas
  ADD CONSTRAINT peakos_ideas_visibility_check
  CHECK (visibility = ANY (ARRAY['private', 'members', 'shared']));

CREATE TABLE IF NOT EXISTS peakos_idea_viewers (
  workspace_id TEXT NOT NULL,
  idea_id UUID NOT NULL,
  user_uid TEXT NOT NULL,
  user_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT peakos_idea_viewers_pkey PRIMARY KEY (workspace_id, idea_id, user_uid),
  CONSTRAINT peakos_idea_viewers_idea_fk
    FOREIGN KEY (workspace_id, idea_id) REFERENCES peakos_ideas(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT peakos_idea_viewers_user_fk
    FOREIGN KEY (user_uid) REFERENCES users(uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS peakos_idea_viewers_user_idx
  ON peakos_idea_viewers (workspace_id, user_uid);

REVOKE ALL ON peakos_idea_viewers FROM calendar_user;
GRANT SELECT, INSERT, DELETE ON peakos_idea_viewers TO calendar_user;

COMMIT;
