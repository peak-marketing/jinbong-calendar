-- Splits ideas into private and shared.
--
-- The tab was showing every idea to everyone, including ones migrated from
-- Paragon that their author never chose to publish -- among them notes about
-- personal and corporate money. Every existing row therefore becomes private:
-- the only safe direction is the one that cannot leak. Authors can share a
-- note afterwards, deliberately, one at a time.
--
-- Private means private: a workspace manager does not see someone else's
-- private idea either.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-idea-visibility-v1'));

ALTER TABLE peakos_ideas
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';

ALTER TABLE peakos_ideas
  DROP CONSTRAINT IF EXISTS peakos_ideas_visibility_check;
ALTER TABLE peakos_ideas
  ADD CONSTRAINT peakos_ideas_visibility_check
  CHECK (visibility = ANY (ARRAY['private', 'shared']));

-- 이미 들어 있는 글은 전부 개인으로 되돌린다.
UPDATE peakos_ideas SET visibility = 'private' WHERE visibility <> 'private';

CREATE INDEX IF NOT EXISTS peakos_ideas_visible_idx
  ON peakos_ideas (workspace_id, visibility, created_at DESC)
  WHERE active = TRUE;

COMMIT;
