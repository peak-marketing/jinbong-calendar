-- Development spend log: server bills, hosting, AI subscriptions and the like.
--
-- Who may see it lives in its own table rather than in PEAKOS_ACCESS_UIDS_JSON.
-- That env var must list exactly the names the code knows, and it exists only
-- inside the pm2 dump, so adding a person there means a full restart of every
-- service on the box. A table lets the list change without that risk.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-dev-expenses-v1'));

CREATE TABLE IF NOT EXISTS peakos_dev_expense_viewers (
  workspace_id TEXT NOT NULL,
  user_uid TEXT NOT NULL,
  user_name_snapshot TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT peakos_dev_expense_viewers_pkey PRIMARY KEY (workspace_id, user_uid),
  CONSTRAINT peakos_dev_expense_viewers_user_fk
    FOREIGN KEY (user_uid) REFERENCES users(uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS peakos_dev_expenses (
  workspace_id TEXT NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  spent_on DATE NOT NULL,
  category TEXT NOT NULL,
  service_name TEXT NOT NULL,
  amount NUMERIC(14, 2) NOT NULL,
  card_name TEXT NOT NULL DEFAULT '',
  is_subscription BOOLEAN NOT NULL DEFAULT FALSE,
  renews_on DATE,
  paid BOOLEAN NOT NULL DEFAULT FALSE,
  paid_at TIMESTAMPTZ,
  memo TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_uid TEXT NOT NULL,
  created_by_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT peakos_dev_expenses_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_dev_expenses_creator_fk
    FOREIGN KEY (created_by_uid) REFERENCES users(uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_dev_expenses_category_check
    CHECK (category = ANY (ARRAY['server', 'hosting', 'ai', 'domain', 'tool', 'etc'])),
  CONSTRAINT peakos_dev_expenses_service_check
    CHECK (btrim(service_name) <> '' AND length(service_name) <= 180),
  CONSTRAINT peakos_dev_expenses_card_check CHECK (length(card_name) <= 80),
  CONSTRAINT peakos_dev_expenses_memo_check CHECK (length(memo) <= 2000),
  -- 금액은 0원 결제도 있을 수 있으나 음수는 지출이 아니다.
  CONSTRAINT peakos_dev_expenses_amount_check
    CHECK (amount >= 0 AND amount <= 999999999999),
  -- 구독이 아니면 갱신일이 있을 수 없다.
  CONSTRAINT peakos_dev_expenses_renewal_check
    CHECK (renews_on IS NULL OR is_subscription = TRUE),
  CONSTRAINT peakos_dev_expenses_paid_at_check
    CHECK ((paid_at IS NULL) OR paid = TRUE),
  CONSTRAINT peakos_dev_expenses_version_check
    CHECK (version >= 1 AND version <= 2147483647)
);

CREATE INDEX IF NOT EXISTS peakos_dev_expenses_spent_idx
  ON peakos_dev_expenses (workspace_id, spent_on DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS peakos_dev_expenses_renewal_idx
  ON peakos_dev_expenses (workspace_id, renews_on)
  WHERE active = TRUE AND is_subscription = TRUE;

-- 처음 볼 사람 다섯. 이름이 아니라 UID로 못 박아 두어 개명해도 권한이 따라오지 않는다.
INSERT INTO peakos_dev_expense_viewers (workspace_id, user_uid, user_name_snapshot)
SELECT 'ws_peak', u.uid, u.name
  FROM users u
 WHERE u.name IN ('김동우', '손명아', '전현우', '패션TV봉이', '김대호')
   AND u.approved = TRUE
   AND COALESCE(u.is_active, TRUE) = TRUE
ON CONFLICT (workspace_id, user_uid) DO NOTHING;

DO $seeded$
DECLARE
  seeded INTEGER;
BEGIN
  SELECT count(*) INTO seeded FROM peakos_dev_expense_viewers WHERE workspace_id = 'ws_peak';
  IF seeded <> 5 THEN
    RAISE EXCEPTION '개발비 열람자 5명을 등록하지 못했습니다 (등록됨: %)', seeded
      USING ERRCODE = '55000';
  END IF;
END
$seeded$;

REVOKE ALL ON peakos_dev_expenses FROM calendar_user;
REVOKE ALL ON peakos_dev_expense_viewers FROM calendar_user;
GRANT SELECT, INSERT, UPDATE ON peakos_dev_expenses TO calendar_user;
GRANT SELECT ON peakos_dev_expense_viewers TO calendar_user;

COMMIT;
