-- Adds 이종혁 to the development spend viewers.
--
-- Membership lives in a table precisely so this kind of change needs no restart
-- and no env edit. Matching on name once, at insert time, keeps the stored row
-- keyed by UID -- a later rename does not carry the permission with it.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-dev-expense-viewer-jonghyuk-v1'));

INSERT INTO peakos_dev_expense_viewers (workspace_id, user_uid, user_name_snapshot)
SELECT 'ws_peak', u.uid, u.name
  FROM users u
 WHERE u.name = '이종혁'
   AND u.approved = TRUE
   AND COALESCE(u.is_active, TRUE) = TRUE
   AND COALESCE(u.chat_only, FALSE) = FALSE
ON CONFLICT (workspace_id, user_uid)
  DO UPDATE SET active = TRUE, user_name_snapshot = EXCLUDED.user_name_snapshot, updated_at = now();

DO $check$
DECLARE
  viewers INTEGER;
BEGIN
  SELECT count(*) INTO viewers
    FROM peakos_dev_expense_viewers
   WHERE workspace_id = 'ws_peak' AND active = TRUE;
  IF viewers <> 6 THEN
    RAISE EXCEPTION '개발비 열람자는 6명이어야 합니다 (현재: %)', viewers USING ERRCODE = '55000';
  END IF;
END
$check$;

COMMIT;
