-- PEAK OS 영업 리드/콜 원장 v1.
-- 전화번호, 담당자명, 주소, 메모와 통화 메모는 애플리케이션에서
-- AES-256-GCM으로 암호화한 뒤 BYTEA로만 저장한다. 전화 중복 방지는
-- 별도 HMAC 지문으로 처리하며 원문 전화번호를 DB에 보관하지 않는다.
-- 이 파일은 운영자/DBA가 한 번 적용한다. API 시작 과정은 SELECT-only
-- readiness 검사만 수행하며 DDL을 자동 실행하지 않는다.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-sales-leads-v1'));

DO $prerequisites$
BEGIN
  IF to_regclass('public.peakos_workspaces') IS NULL
     OR to_regclass('public.peakos_workspace_memberships') IS NULL THEN
    RAISE EXCEPTION
      'peakos workspace migrations must be applied before sales leads'
      USING ERRCODE = '55000';
  END IF;
END
$prerequisites$;

-- 새 영역은 직접 소속 구성원에게 쓰기, 본사 oversight에게 읽기로
-- 명시적으로 backfill한다. 기존 키가 있다면 운영자가 지정한 값을 보존한다.
ALTER TABLE peakos_workspace_memberships
  ALTER COLUMN permissions SET DEFAULT '{
    "calendar":"write",
    "chat":"write",
    "projects":"write",
    "settlements":"write",
    "documents":"read",
    "sales":"write"
  }'::jsonb;

WITH before_rows AS (
  SELECT workspace_id, user_uid, permissions AS before_permissions,
         jsonb_set(
           permissions,
           '{sales}',
           to_jsonb(CASE WHEN role = 'oversight' THEN 'read'::text ELSE 'write'::text END),
           TRUE
         ) AS after_permissions
    FROM peakos_workspace_memberships
   WHERE NOT permissions ? 'sales'
), updated AS (
  UPDATE peakos_workspace_memberships membership
     SET permissions = before_rows.after_permissions,
         updated_at = NOW()
    FROM before_rows
   WHERE membership.workspace_id = before_rows.workspace_id
     AND membership.user_uid = before_rows.user_uid
  RETURNING membership.workspace_id, membership.user_uid
)
INSERT INTO peakos_workspace_membership_audit
  (workspace_id, target_uid, actor_uid, action, before_state, after_state)
SELECT before_rows.workspace_id,
       before_rows.user_uid,
       'system:sales-permission-v1',
       'update',
       jsonb_build_object('permissions', before_rows.before_permissions),
       jsonb_build_object('permissions', before_rows.after_permissions)
  FROM before_rows
  JOIN updated USING (workspace_id, user_uid);

CREATE TABLE IF NOT EXISTS peakos_sales_leads (
  workspace_id TEXT NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  owner_uid TEXT NOT NULL,
  owner_name_snapshot TEXT NOT NULL,
  company_name TEXT NOT NULL,
  contact_ciphertext BYTEA NOT NULL,
  contact_nonce BYTEA NOT NULL,
  contact_auth_tag BYTEA NOT NULL,
  contact_encryption_version SMALLINT NOT NULL DEFAULT 1,
  phone_fingerprint TEXT NOT NULL,
  phone_last4 TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'phone',
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'new',
  next_followup_at TIMESTAMPTZ,
  last_contact_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_uid TEXT NOT NULL,
  created_by_name_snapshot TEXT NOT NULL,
  archived_at TIMESTAMPTZ,
  archived_by_uid TEXT,
  archived_by_name_snapshot TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_sales_leads_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_sales_leads_owner_membership_fk
    FOREIGN KEY (workspace_id, owner_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_sales_leads_creator_membership_fk
    FOREIGN KEY (workspace_id, created_by_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_sales_leads_archiver_membership_fk
    FOREIGN KEY (workspace_id, archived_by_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_sales_leads_owner_uid_check
    CHECK (char_length(btrim(owner_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_sales_leads_owner_name_check
    CHECK (char_length(btrim(owner_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_sales_leads_company_name_check
    CHECK (char_length(btrim(company_name)) BETWEEN 1 AND 240),
  CONSTRAINT peakos_sales_leads_contact_ciphertext_check
    CHECK (octet_length(contact_ciphertext) BETWEEN 1 AND 131072),
  CONSTRAINT peakos_sales_leads_contact_nonce_check
    CHECK (octet_length(contact_nonce) = 12),
  CONSTRAINT peakos_sales_leads_contact_auth_tag_check
    CHECK (octet_length(contact_auth_tag) = 16),
  CONSTRAINT peakos_sales_leads_contact_encryption_version_check
    CHECK (contact_encryption_version = 1),
  CONSTRAINT peakos_sales_leads_phone_fingerprint_check
    CHECK (phone_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_sales_leads_phone_last4_check
    CHECK (phone_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT peakos_sales_leads_channel_check
    CHECK (channel IN ('phone', 'field', 'online')),
  CONSTRAINT peakos_sales_leads_source_check
    CHECK (source IN ('manual', 'referral', 'inbound', 'other')),
  CONSTRAINT peakos_sales_leads_status_check
    CHECK (status IN ('new', 'contacted', 'follow_up', 'won', 'lost', 'do_not_call')),
  CONSTRAINT peakos_sales_leads_version_check
    CHECK (version BETWEEN 1 AND 2147483647),
  CONSTRAINT peakos_sales_leads_creator_uid_check
    CHECK (char_length(btrim(created_by_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_sales_leads_creator_name_check
    CHECK (char_length(btrim(created_by_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_sales_leads_archive_pair_check
    CHECK (
      (archived_at IS NULL AND archived_by_uid IS NULL AND archived_by_name_snapshot IS NULL)
      OR
      (archived_at IS NOT NULL AND archived_by_uid IS NOT NULL
       AND archived_by_name_snapshot IS NOT NULL
       AND char_length(btrim(archived_by_name_snapshot)) BETWEEN 1 AND 160)
    ),
  CONSTRAINT peakos_sales_leads_updated_check
    CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS peakos_sales_call_logs (
  workspace_id TEXT NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name_snapshot TEXT NOT NULL,
  disposition TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  duration_seconds INTEGER,
  note_ciphertext BYTEA NOT NULL,
  note_nonce BYTEA NOT NULL,
  note_auth_tag BYTEA NOT NULL,
  note_encryption_version SMALLINT NOT NULL DEFAULT 1,
  next_followup_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_sales_call_logs_lead_fk
    FOREIGN KEY (workspace_id, lead_id)
    REFERENCES peakos_sales_leads(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_sales_call_logs_actor_membership_fk
    FOREIGN KEY (workspace_id, actor_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_sales_call_logs_actor_uid_check
    CHECK (char_length(btrim(actor_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_sales_call_logs_actor_name_check
    CHECK (char_length(btrim(actor_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_sales_call_logs_disposition_check
    CHECK (disposition IN ('connected', 'no_answer', 'busy', 'callback', 'interested', 'won', 'lost', 'do_not_call')),
  CONSTRAINT peakos_sales_call_logs_duration_check
    CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 86400),
  CONSTRAINT peakos_sales_call_logs_note_ciphertext_check
    CHECK (octet_length(note_ciphertext) BETWEEN 1 AND 65536),
  CONSTRAINT peakos_sales_call_logs_note_nonce_check
    CHECK (octet_length(note_nonce) = 12),
  CONSTRAINT peakos_sales_call_logs_note_auth_tag_check
    CHECK (octet_length(note_auth_tag) = 16),
  CONSTRAINT peakos_sales_call_logs_note_encryption_version_check
    CHECK (note_encryption_version = 1)
);

CREATE TABLE IF NOT EXISTS peakos_sales_lead_history (
  workspace_id TEXT NOT NULL,
  id BIGSERIAL NOT NULL,
  lead_id UUID NOT NULL,
  action TEXT NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name_snapshot TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  before_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_sales_lead_history_lead_fk
    FOREIGN KEY (workspace_id, lead_id)
    REFERENCES peakos_sales_leads(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_sales_lead_history_actor_membership_fk
    FOREIGN KEY (workspace_id, actor_uid)
    REFERENCES peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_sales_lead_history_action_check
    CHECK (action IN ('created', 'updated', 'call_logged', 'archived')),
  CONSTRAINT peakos_sales_lead_history_actor_uid_check
    CHECK (char_length(btrim(actor_uid)) BETWEEN 1 AND 200),
  CONSTRAINT peakos_sales_lead_history_actor_name_check
    CHECK (char_length(btrim(actor_name_snapshot)) BETWEEN 1 AND 160),
  CONSTRAINT peakos_sales_lead_history_version_check
    CHECK (entity_version BETWEEN 1 AND 2147483647),
  CONSTRAINT peakos_sales_lead_history_state_check
    CHECK (jsonb_typeof(before_state) = 'object' AND jsonb_typeof(after_state) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS peakos_sales_leads_active_phone_unique
  ON peakos_sales_leads(workspace_id, phone_fingerprint)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS peakos_sales_leads_listing_idx
  ON peakos_sales_leads(workspace_id, archived_at, status, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS peakos_sales_leads_owner_idx
  ON peakos_sales_leads(workspace_id, owner_uid, archived_at, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS peakos_sales_leads_followup_idx
  ON peakos_sales_leads(workspace_id, owner_uid, next_followup_at, id)
  WHERE archived_at IS NULL AND next_followup_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS peakos_sales_call_logs_lead_idx
  ON peakos_sales_call_logs(workspace_id, lead_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS peakos_sales_call_logs_actor_idx
  ON peakos_sales_call_logs(workspace_id, actor_uid, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS peakos_sales_lead_history_lead_idx
  ON peakos_sales_lead_history(workspace_id, lead_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION peakos_sales_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $append_only$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$append_only$;

DROP TRIGGER IF EXISTS peakos_sales_call_logs_no_mutation
  ON peakos_sales_call_logs;
CREATE TRIGGER peakos_sales_call_logs_no_mutation
BEFORE UPDATE OR DELETE ON peakos_sales_call_logs
FOR EACH ROW EXECUTE FUNCTION peakos_sales_append_only();

DROP TRIGGER IF EXISTS peakos_sales_lead_history_no_mutation
  ON peakos_sales_lead_history;
CREATE TRIGGER peakos_sales_lead_history_no_mutation
BEFORE UPDATE OR DELETE ON peakos_sales_lead_history
FOR EACH ROW EXECUTE FUNCTION peakos_sales_append_only();

-- Runtime 역할은 기존/default ACL을 신뢰하지 않고 필요한 권한만
-- 다시 부여한다. 리드는 archive UPDATE만, 콜과 history는
-- INSERT-only다. 앱 역할이 테이블 owner이거나 다른 role을 통해
-- DELETE/TRUNCATE를 상속한 구성은 정확한 최소 권한을 보장할 수 없으므로
-- migration 자체가 fail-closed한다.
-- calendar_user가 아닌 runtime role은 같은 DBA session에서 미리
--   SET peakos.app_role = 'dedicated_runtime_role';
-- 를 지정한다. 역할이 없으면 DBA current_user로 fallback하지 않는다.
DO $sales_runtime_grants$
DECLARE
  configured_role TEXT := NULLIF(current_setting('peakos.app_role', TRUE), '');
  application_role TEXT;
  privilege_name TEXT;
BEGIN
  application_role := configured_role;
  IF application_role IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
      application_role := 'calendar_user';
    ELSE
      RAISE EXCEPTION
        'set peakos.app_role to the non-owner runtime role before applying PEAK OS sales migration'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role) THEN
    RAISE EXCEPTION 'PEAK OS application role % does not exist', application_role;
  END IF;

  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE peakos_sales_leads FROM PUBLIC, %I', application_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE peakos_sales_call_logs FROM PUBLIC, %I', application_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE peakos_sales_lead_history FROM PUBLIC, %I', application_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE peakos_sales_leads TO %I', application_role);
  EXECUTE format('GRANT SELECT, INSERT ON TABLE peakos_sales_call_logs TO %I', application_role);
  EXECUTE format('GRANT SELECT, INSERT ON TABLE peakos_sales_lead_history TO %I', application_role);
  IF to_regclass('public.peakos_sales_lead_history_id_seq') IS NOT NULL THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE peakos_sales_lead_history_id_seq FROM PUBLIC, %I',
      application_role
    );
    EXECUTE format('GRANT USAGE ON SEQUENCE peakos_sales_lead_history_id_seq TO %I', application_role);
  END IF;
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON FUNCTION peakos_sales_append_only() FROM PUBLIC, %I',
    application_role
  );

  IF NOT has_table_privilege(application_role, 'public.peakos_sales_leads', 'SELECT')
     OR NOT has_table_privilege(application_role, 'public.peakos_sales_leads', 'INSERT')
     OR NOT has_table_privilege(application_role, 'public.peakos_sales_leads', 'UPDATE')
     OR has_table_privilege(application_role, 'public.peakos_sales_leads', 'DELETE')
     OR has_table_privilege(application_role, 'public.peakos_sales_leads', 'TRUNCATE')
     OR has_table_privilege(application_role, 'public.peakos_sales_leads', 'REFERENCES')
     OR has_table_privilege(application_role, 'public.peakos_sales_leads', 'TRIGGER') THEN
    RAISE EXCEPTION 'runtime role % has unsafe effective privileges on peakos_sales_leads', application_role
      USING ERRCODE = '55000';
  END IF;

  FOREACH privilege_name IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
  LOOP
    IF has_table_privilege(application_role, 'public.peakos_sales_call_logs', privilege_name)
       OR has_table_privilege(application_role, 'public.peakos_sales_lead_history', privilege_name) THEN
      RAISE EXCEPTION 'runtime role % has unsafe effective % privilege on append-only sales tables',
        application_role, privilege_name
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF NOT has_table_privilege(application_role, 'public.peakos_sales_call_logs', 'SELECT')
     OR NOT has_table_privilege(application_role, 'public.peakos_sales_call_logs', 'INSERT')
     OR NOT has_table_privilege(application_role, 'public.peakos_sales_lead_history', 'SELECT')
     OR NOT has_table_privilege(application_role, 'public.peakos_sales_lead_history', 'INSERT') THEN
    RAISE EXCEPTION 'runtime role % is missing required append-only sales privileges', application_role
      USING ERRCODE = '55000';
  END IF;
  IF NOT has_sequence_privilege(application_role, 'public.peakos_sales_lead_history_id_seq', 'USAGE')
     OR has_sequence_privilege(application_role, 'public.peakos_sales_lead_history_id_seq', 'SELECT')
     OR has_sequence_privilege(application_role, 'public.peakos_sales_lead_history_id_seq', 'UPDATE') THEN
    RAISE EXCEPTION 'runtime role % has unsafe sales history sequence privileges', application_role
      USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege(application_role, 'public.peakos_sales_append_only()', 'EXECUTE') THEN
    RAISE EXCEPTION 'runtime role % must not execute the append-only trigger function directly', application_role
      USING ERRCODE = '55000';
  END IF;
END
$sales_runtime_grants$;

COMMIT;
