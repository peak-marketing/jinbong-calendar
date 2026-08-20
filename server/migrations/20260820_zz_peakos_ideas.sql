-- PEAK OS idea box.
--
-- The tab used to be a read-only mirror of the legacy Paragon ideas table, so
-- nobody could post anything. This gives PEAK OS its own store and copies the
-- 36 ideas that already existed across, once. After this the tab no longer
-- reads Paragon at all -- but nothing that was written is lost.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-ideas-v1'));

CREATE TABLE IF NOT EXISTS peakos_ideas (
  workspace_id TEXT NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  author_uid TEXT NOT NULL,
  author_name_snapshot TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT peakos_ideas_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_ideas_author_fk
    FOREIGN KEY (author_uid) REFERENCES users(uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_ideas_title_check
    CHECK (btrim(title) <> '' AND length(title) <= 180),
  CONSTRAINT peakos_ideas_category_check CHECK (length(category) <= 60),
  CONSTRAINT peakos_ideas_summary_check CHECK (length(summary) <= 2000),
  CONSTRAINT peakos_ideas_detail_check CHECK (length(detail) <= 20000),
  CONSTRAINT peakos_ideas_status_check
    CHECK (status = ANY (ARRAY['open', 'reviewing', 'adopted', 'dropped'])),
  CONSTRAINT peakos_ideas_version_check CHECK (version >= 1 AND version <= 2147483647)
);

CREATE INDEX IF NOT EXISTS peakos_ideas_recent_idx
  ON peakos_ideas (workspace_id, created_at DESC)
  WHERE active = TRUE;

-- 기존 파라곤 아이디어를 한 번만 옮긴다. 작성자 계정이 살아 있는 것만 옮기고,
-- 두 번 실행해도 같은 제목·작성자·작성시각이면 다시 만들지 않는다.
INSERT INTO peakos_ideas
  (workspace_id, title, category, summary, detail, author_uid, author_name_snapshot, created_at)
SELECT 'ws_peak',
       left(btrim(COALESCE(NULLIF(btrim(i.title), ''), '제목 없음')), 180),
       left(COALESCE(i.category, ''), 60),
       left(COALESCE(i.summary, ''), 2000),
       left(COALESCE(i.detail, ''), 20000),
       i.owner_id,
       COALESCE(NULLIF(btrim(i.owner_name), ''), '작성자'),
       i.created_at
  FROM ideas i
  JOIN users u ON u.uid = i.owner_id
 WHERE NOT EXISTS (
   SELECT 1 FROM peakos_ideas p
    WHERE p.workspace_id = 'ws_peak'
      AND p.author_uid = i.owner_id
      AND p.created_at = i.created_at
      AND p.title = left(btrim(COALESCE(NULLIF(btrim(i.title), ''), '제목 없음')), 180)
 );

REVOKE ALL ON peakos_ideas FROM calendar_user;
GRANT SELECT, INSERT, UPDATE ON peakos_ideas TO calendar_user;

COMMIT;
