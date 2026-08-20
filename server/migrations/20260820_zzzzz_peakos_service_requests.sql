-- PEAK OS development change requests.
--
-- The tab mirrored the legacy Paragon table read-only, so no one could file a
-- request from PEAK OS. This gives it its own store, carries the live requests
-- across once, and keeps the assignee that already existed there.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-service-requests-v1'));

CREATE TABLE IF NOT EXISTS peakos_service_requests (
  workspace_id TEXT NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  product_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested',
  priority TEXT NOT NULL DEFAULT 'normal',
  requester_uid TEXT NOT NULL,
  requester_name_snapshot TEXT NOT NULL,
  assignee_uid TEXT,
  assignee_name_snapshot TEXT,
  manager_note TEXT NOT NULL DEFAULT '',
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT peakos_service_requests_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_service_requests_requester_fk
    FOREIGN KEY (requester_uid) REFERENCES users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_service_requests_assignee_fk
    FOREIGN KEY (assignee_uid) REFERENCES users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_service_requests_title_check
    CHECK (btrim(title) <> '' AND length(title) <= 200),
  CONSTRAINT peakos_service_requests_product_check CHECK (length(product_name) <= 120),
  CONSTRAINT peakos_service_requests_content_check CHECK (length(content) <= 20000),
  CONSTRAINT peakos_service_requests_note_check CHECK (length(manager_note) <= 5000),
  CONSTRAINT peakos_service_requests_status_check
    CHECK (status = ANY (ARRAY['requested', 'reviewing', 'working', 'done', 'rejected'])),
  CONSTRAINT peakos_service_requests_priority_check
    CHECK (priority = ANY (ARRAY['urgent', 'high', 'normal', 'low'])),
  CONSTRAINT peakos_service_requests_assignee_pair_check
    CHECK ((assignee_uid IS NULL) = (assignee_name_snapshot IS NULL)),
  CONSTRAINT peakos_service_requests_attachments_check
    CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 20),
  CONSTRAINT peakos_service_requests_version_check
    CHECK (version >= 1 AND version <= 2147483647)
);

CREATE INDEX IF NOT EXISTS peakos_service_requests_recent_idx
  ON peakos_service_requests (workspace_id, created_at DESC) WHERE active = TRUE;

-- 살아 있는 요청만 옮긴다. 지운 것까지 되살리지 않는다.
INSERT INTO peakos_service_requests
  (workspace_id, product_name, title, content, status, priority,
   requester_uid, requester_name_snapshot, assignee_uid, assignee_name_snapshot,
   manager_note, attachments, created_at, updated_at, completed_at)
SELECT 'ws_peak',
       left(COALESCE(r.product_name, ''), 120),
       left(btrim(COALESCE(NULLIF(btrim(r.title), ''), '제목 없음')), 200),
       left(COALESCE(r.content, ''), 20000),
       CASE WHEN r.status IN ('requested','reviewing','working','done','rejected')
            THEN r.status ELSE 'requested' END,
       CASE WHEN r.priority IN ('urgent','high','normal','low') THEN r.priority ELSE 'normal' END,
       r.requester_uid,
       COALESCE(NULLIF(btrim(r.requester_name), ''), '요청자'),
       assignee.uid,
       CASE WHEN assignee.uid IS NULL THEN NULL
            ELSE COALESCE(NULLIF(btrim(r.assignee_name), ''), assignee.name) END,
       left(COALESCE(r.manager_note, ''), 5000),
       CASE WHEN jsonb_typeof(r.attachments) = 'array' THEN r.attachments ELSE '[]'::jsonb END,
       r.created_at, COALESCE(r.updated_at, r.created_at), r.completed_at
  FROM service_requests r
  JOIN users u ON u.uid = r.requester_uid
  LEFT JOIN users assignee ON assignee.uid = r.assignee_uid
 WHERE COALESCE(r.deleted, false) = false
   AND NOT EXISTS (
     SELECT 1 FROM peakos_service_requests p
      WHERE p.workspace_id = 'ws_peak'
        AND p.requester_uid = r.requester_uid
        AND p.created_at = r.created_at
        AND p.title = left(btrim(COALESCE(NULLIF(btrim(r.title), ''), '제목 없음')), 200)
   );

REVOKE ALL ON peakos_service_requests FROM calendar_user;
GRANT SELECT, INSERT, UPDATE ON peakos_service_requests TO calendar_user;

COMMIT;
