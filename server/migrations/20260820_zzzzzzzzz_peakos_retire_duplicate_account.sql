-- Retires the duplicate 김주현 account.
--
-- Two approved accounts carried the same name, rank and team, so pickers showed
-- them identically and either could be chosen by mistake. eptmqk123 is the one
-- in use; eptmqk218 held nothing but 784 auto-generated report reminders --
-- no manual events, tasks, todos or push tokens.
--
-- Deactivated rather than deleted: the row and its history stay, it simply
-- stops appearing anywhere and stops receiving generated reminders. Setting
-- is_active back to true restores it exactly.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-retire-duplicate-kimjuhyun-v1'));

-- 지우기 전에, 정말로 직접 만든 자료가 없는지 다시 확인한다.
DO $safety$
DECLARE
  manual INTEGER;
BEGIN
  SELECT count(*) INTO manual
    FROM events
   WHERE owner_id = 'VVq65mxUHyPOy7UbFvozpcKCbwc2'
     AND title NOT LIKE '📄%' AND title NOT LIKE '📝%' AND title NOT LIKE '📊%'
     AND title NOT LIKE '📈%' AND title NOT LIKE '📋%';
  IF manual > 0 THEN
    RAISE EXCEPTION '이 계정에 직접 만든 일정이 %건 있습니다. 확인 없이 정리하지 않습니다.', manual
      USING ERRCODE = '55000';
  END IF;
END
$safety$;

UPDATE users
   SET is_active = FALSE
 WHERE uid = 'VVq65mxUHyPOy7UbFvozpcKCbwc2'
   AND email = 'eptmqk218@gmail.com';

-- 남는 계정은 그대로 살아 있어야 한다.
DO $kept$
DECLARE
  ok BOOLEAN;
BEGIN
  SELECT approved AND COALESCE(is_active, TRUE) INTO ok
    FROM users WHERE email = 'eptmqk123@gmail.com';
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION '남겨야 할 계정(eptmqk123)이 활성 상태가 아닙니다.' USING ERRCODE = '55000';
  END IF;
END
$kept$;

COMMIT;
