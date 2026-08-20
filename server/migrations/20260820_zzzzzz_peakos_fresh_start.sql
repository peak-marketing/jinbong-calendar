-- Clears the ideas and requests that were carried over from Paragon.
--
-- PEAK OS starts these two tabs empty by choice. The Paragon tables are left
-- untouched, so this is reversible: re-running the two import migrations
-- brings everything back exactly as it was.
--
-- Only rows that match a Paragon original on (author, created_at, title) go.
-- Anything written in PEAK OS itself stays.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-fresh-start-v1'));

DELETE FROM peakos_ideas p
 WHERE EXISTS (
   SELECT 1 FROM ideas i
    WHERE i.owner_id = p.author_uid
      AND i.created_at = p.created_at
      AND left(btrim(COALESCE(NULLIF(btrim(i.title), ''), '제목 없음')), 180) = p.title
 );

DELETE FROM peakos_service_requests p
 WHERE EXISTS (
   SELECT 1 FROM service_requests r
    WHERE r.requester_uid = p.requester_uid
      AND r.created_at = p.created_at
      AND left(btrim(COALESCE(NULLIF(btrim(r.title), ''), '제목 없음')), 200) = p.title
 );

-- 원본이 사라졌으면 되돌릴 수 없다. 지우기 전에 반드시 확인한다.
DO $safety$
DECLARE
  paragon_ideas INTEGER;
  paragon_requests INTEGER;
BEGIN
  SELECT count(*) INTO paragon_ideas FROM ideas;
  SELECT count(*) INTO paragon_requests FROM service_requests;
  IF paragon_ideas = 0 OR paragon_requests = 0 THEN
    RAISE EXCEPTION '파라곤 원본이 비어 있어 되돌릴 수 없습니다 (ideas %, requests %)',
      paragon_ideas, paragon_requests USING ERRCODE = '55000';
  END IF;
END
$safety$;

COMMIT;
