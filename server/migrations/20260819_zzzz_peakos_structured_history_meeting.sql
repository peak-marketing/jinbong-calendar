-- Lets the append-only history log record meeting events.
--
-- Meetings write history rows with entity_type 'meeting'. The original CHECK
-- listed only the five entity types that existed before meetings, so every
-- meeting write rolled its whole transaction back with a check violation --
-- the meeting looked like it simply did not save.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-structured-history-meeting-v1'));

ALTER TABLE peakos_structured_project_history
  DROP CONSTRAINT IF EXISTS peakos_structured_project_history_entity_type_check;

ALTER TABLE peakos_structured_project_history
  ADD CONSTRAINT peakos_structured_project_history_entity_type_check
  CHECK (entity_type = ANY (ARRAY['project', 'member', 'medium_category', 'small_category', 'task', 'meeting']));

COMMIT;
