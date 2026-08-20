-- Who may read every development request, and a thread to talk in.
--
-- Until now only the two people in service_request_managers saw everything and
-- everyone else saw their own. Five people need to read all of them, but only
-- the development owners should change status, so reading and triaging become
-- separate lists.
--
-- The thread is what turns a request into a conversation: the dev team marks it
-- checked or done, and the requester can say it is not actually fixed.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-request-viewers-comments-v1'));

CREATE TABLE IF NOT EXISTS peakos_service_request_viewers (
  workspace_id TEXT NOT NULL,
  user_uid TEXT NOT NULL,
  user_name_snapshot TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT peakos_service_request_viewers_pkey PRIMARY KEY (workspace_id, user_uid),
  CONSTRAINT peakos_service_request_viewers_user_fk
    FOREIGN KEY (user_uid) REFERENCES users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS peakos_service_request_comments (
  workspace_id TEXT NOT NULL,
  request_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  body TEXT NOT NULL,
  -- 상태를 바꾸면서 남긴 말이면 어떤 변화였는지 함께 적힌다.
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL DEFAULT '',
  author_uid TEXT NOT NULL,
  author_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT peakos_service_request_comments_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_service_request_comments_request_fk
    FOREIGN KEY (workspace_id, request_id)
    REFERENCES peakos_service_requests(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT peakos_service_request_comments_author_fk
    FOREIGN KEY (author_uid) REFERENCES users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_service_request_comments_body_check
    CHECK (btrim(body) <> '' AND length(body) <= 5000),
  CONSTRAINT peakos_service_request_comments_status_check
    CHECK ((from_status = '' OR from_status = ANY (ARRAY['requested','reviewing','working','done','rejected']))
       AND (to_status = '' OR to_status = ANY (ARRAY['requested','reviewing','working','done','rejected'])))
);

CREATE INDEX IF NOT EXISTS peakos_service_request_comments_thread_idx
  ON peakos_service_request_comments (workspace_id, request_id, created_at);

INSERT INTO peakos_service_request_viewers (workspace_id, user_uid, user_name_snapshot)
SELECT 'ws_peak', u.uid, u.name
  FROM users u
 WHERE u.name IN ('김동우', '이종혁', '패션TV봉이', '김대호', '전현우')
   AND u.approved = TRUE
   AND COALESCE(u.is_active, TRUE) = TRUE
ON CONFLICT (workspace_id, user_uid) DO UPDATE SET active = TRUE, updated_at = now();

DO $seeded$
DECLARE
  seeded INTEGER;
BEGIN
  SELECT count(*) INTO seeded FROM peakos_service_request_viewers
   WHERE workspace_id = 'ws_peak' AND active = TRUE;
  IF seeded <> 5 THEN
    RAISE EXCEPTION '개발수정요청 열람자 5명을 등록하지 못했습니다 (등록됨: %)', seeded
      USING ERRCODE = '55000';
  END IF;
END
$seeded$;

REVOKE ALL ON peakos_service_request_viewers FROM calendar_user;
REVOKE ALL ON peakos_service_request_comments FROM calendar_user;
GRANT SELECT ON peakos_service_request_viewers TO calendar_user;
GRANT SELECT, INSERT ON peakos_service_request_comments TO calendar_user;

COMMIT;
