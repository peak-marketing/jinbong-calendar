-- PEAK OS workspace/tenant foundation.
--
-- This migration is deliberately non-destructive. Large legacy tables receive
-- a nullable workspace_id first; application reads treat NULL as ws_peak only
-- for the legacy Peak workspace. Run the exported bounded backfill helper and
-- the separate CONCURRENTLY index migration during a maintenance window before
-- validating NOT NULL constraints. New application writes always provide an
-- explicit workspace_id.

SELECT pg_advisory_xact_lock(hashtext('peakos-workspaces-v1'));

CREATE TABLE IF NOT EXISTS peakos_workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_workspaces_slug_check
    CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND char_length(slug) <= 64),
  CONSTRAINT peakos_workspaces_kind_check
    CHECK (kind IN ('headquarters', 'branch', 'company'))
);

INSERT INTO peakos_workspaces (id, slug, name, kind)
VALUES
  ('ws_peak', 'peak', '피크마케팅 본사', 'headquarters'),
  ('ws_build_solution', 'build-solution', '빌드솔루션', 'company'),
  ('ws_jeonju', 'jeonju', '피크마케팅 전주지사', 'branch'),
  ('ws_daegu', 'daegu', '피크마케팅 대구지사', 'branch')
ON CONFLICT (id) DO UPDATE
SET slug = EXCLUDED.slug,
    name = EXCLUDED.name,
    kind = EXCLUDED.kind,
    active = TRUE,
    updated_at = NOW();

CREATE TABLE IF NOT EXISTS peakos_workspace_memberships (
  workspace_id TEXT NOT NULL REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_uid TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  permissions JSONB NOT NULL DEFAULT '{
    "calendar":"write",
    "chat":"write",
    "projects":"write",
    "settlements":"write",
    "documents":"read"
  }'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  membership_source TEXT NOT NULL DEFAULT 'admin',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_uid),
  CONSTRAINT peakos_workspace_memberships_role_check
    CHECK (role IN ('admin', 'manager', 'member', 'oversight')),
  CONSTRAINT peakos_workspace_memberships_permissions_check
    CHECK (jsonb_typeof(permissions) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS peakos_workspace_memberships_one_default
  ON peakos_workspace_memberships(user_uid)
  WHERE is_default = TRUE AND active = TRUE AND role <> 'oversight';

CREATE INDEX IF NOT EXISTS peakos_workspace_memberships_user_active
  ON peakos_workspace_memberships(user_uid, active, workspace_id);

CREATE TABLE IF NOT EXISTS peakos_workspace_membership_audit (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  target_uid TEXT NOT NULL,
  actor_uid TEXT NOT NULL,
  action TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_workspace_membership_audit_action_check
    CHECK (action IN ('assign', 'update', 'deactivate', 'reactivate', 'bootstrap'))
);

CREATE TABLE IF NOT EXISTS peakos_workspace_bootstrap_state (
  key TEXT PRIMARY KEY,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Existing approved users are assigned exactly once. The organizational group
-- is the authoritative source for the two existing branch memberships; no
-- display-name or client-supplied value is trusted. BuildSolution intentionally
-- starts without a member.
DO $workspace_bootstrap$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM peakos_workspace_bootstrap_state
    WHERE key = 'initial-direct-memberships-v1'
  ) THEN
    INSERT INTO peakos_workspace_memberships
      (workspace_id, user_uid, role, permissions, is_default, membership_source, created_by)
    SELECT
      CASE
        WHEN u.group_id::text = 'daegu' THEN 'ws_daegu'
        WHEN u.group_id::text = 'jeonju' THEN 'ws_jeonju'
        ELSE 'ws_peak'
      END,
      u.uid,
      CASE WHEN u.role IN ('admin', 'manager') THEN u.role ELSE 'member' END,
      '{"calendar":"write","chat":"write","projects":"write","settlements":"write","documents":"read"}'::jsonb,
      TRUE,
      'bootstrap_group',
      'system:workspace-bootstrap'
    FROM users u
    WHERE u.approved = TRUE
      AND COALESCE(u.is_active, TRUE) = TRUE
    ON CONFLICT (workspace_id, user_uid) DO NOTHING;

    INSERT INTO peakos_workspace_bootstrap_state (key, metadata)
    VALUES ('initial-direct-memberships-v1', '{"buildSolutionMembers":0,"source":"users.group_id"}'::jsonb);
  END IF;
END
$workspace_bootstrap$;

-- Collaboration roots. Child rows are always reached through one of these
-- roots, so they do not independently select a workspace.
ALTER TABLE IF EXISTS events ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS custom_event_types ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS custom_todo_cats ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS chat_rooms ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS chat_room_groups ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS projects ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS service_requests ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS ideas ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- Settlement, finance and storage roots. Routes that are not yet workspace
-- aware are denied for non-Peak workspaces by application middleware.
ALTER TABLE IF EXISTS peakos_intake ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS peakos_monthly ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS peakos_credit ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS peakos_credit_requests ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS peakos_finance_requests ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS peakos_bank_accounts ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS peakos_bank_transactions ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS peakos_bank_allocations ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS peakos_bank_audit_log ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS peakos_settlement_import_runs ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- Settlement deletion history and append-only audit rows must carry the same
-- workspace as their root. These tables are small compared with the live
-- ledgers, so their one-time Peak backfill is completed here. Tombstone IDs are
-- reusable in another workspace only after the primary key becomes composite.
ALTER TABLE IF EXISTS peakos_intake_tombstones ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS peakos_intake_audit_log ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS peakos_monthly_tombstones ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE IF EXISTS peakos_monthly_audit_log ADD COLUMN IF NOT EXISTS workspace_id TEXT;

DO $settlement_history_workspace_backfill$
BEGIN
  IF to_regclass('peakos_intake_tombstones') IS NOT NULL THEN
    UPDATE peakos_intake_tombstones SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL;
    ALTER TABLE peakos_intake_tombstones ALTER COLUMN workspace_id SET NOT NULL;
  END IF;
  IF to_regclass('peakos_intake_audit_log') IS NOT NULL THEN
    UPDATE peakos_intake_audit_log SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL;
    ALTER TABLE peakos_intake_audit_log ALTER COLUMN workspace_id SET NOT NULL;
  END IF;
  IF to_regclass('peakos_monthly_tombstones') IS NOT NULL THEN
    UPDATE peakos_monthly_tombstones SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL;
    ALTER TABLE peakos_monthly_tombstones ALTER COLUMN workspace_id SET NOT NULL;
  END IF;
  IF to_regclass('peakos_monthly_audit_log') IS NOT NULL THEN
    UPDATE peakos_monthly_audit_log SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL;
    ALTER TABLE peakos_monthly_audit_log ALTER COLUMN workspace_id SET NOT NULL;
  END IF;
  IF to_regclass('peakos_bank_audit_log') IS NOT NULL THEN
    UPDATE peakos_bank_audit_log SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL;
  END IF;
  IF to_regclass('peakos_settlement_import_runs') IS NOT NULL THEN
    UPDATE peakos_settlement_import_runs SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL;
    ALTER TABLE peakos_settlement_import_runs ALTER COLUMN workspace_id SET NOT NULL;
  END IF;
END
$settlement_history_workspace_backfill$;

DO $intake_tombstone_primary_key$
DECLARE
  current_definition TEXT;
BEGIN
  IF to_regclass('peakos_intake_tombstones') IS NULL THEN
    RETURN;
  END IF;
  SELECT pg_get_constraintdef(oid)
    INTO current_definition
    FROM pg_constraint
   WHERE conrelid = 'peakos_intake_tombstones'::regclass
     AND contype = 'p';
  IF current_definition IS DISTINCT FROM 'PRIMARY KEY (workspace_id, target_id)' THEN
    ALTER TABLE peakos_intake_tombstones
      DROP CONSTRAINT IF EXISTS peakos_intake_tombstones_pkey;
    ALTER TABLE peakos_intake_tombstones
      ADD CONSTRAINT peakos_intake_tombstones_pkey PRIMARY KEY (workspace_id, target_id);
  END IF;
END
$intake_tombstone_primary_key$;

DO $monthly_tombstone_primary_key$
DECLARE
  current_definition TEXT;
BEGIN
  IF to_regclass('peakos_monthly_tombstones') IS NULL THEN
    RETURN;
  END IF;
  SELECT pg_get_constraintdef(oid)
    INTO current_definition
    FROM pg_constraint
   WHERE conrelid = 'peakos_monthly_tombstones'::regclass
     AND contype = 'p';
  IF current_definition IS DISTINCT FROM 'PRIMARY KEY (workspace_id, target_id)' THEN
    ALTER TABLE peakos_monthly_tombstones
      DROP CONSTRAINT IF EXISTS peakos_monthly_tombstones_pkey;
    ALTER TABLE peakos_monthly_tombstones
      ADD CONSTRAINT peakos_monthly_tombstones_pkey PRIMARY KEY (workspace_id, target_id);
  END IF;
END
$monthly_tombstone_primary_key$;

DO $settlement_history_workspace_indexes$
BEGIN
  IF to_regclass('peakos_intake_audit_log') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS peakos_intake_audit_workspace_target_idx
      ON peakos_intake_audit_log(workspace_id, target_id, created_at DESC, id DESC);
  END IF;
  IF to_regclass('peakos_monthly_audit_log') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS peakos_monthly_audit_workspace_target_idx
      ON peakos_monthly_audit_log(workspace_id, target_id, created_at DESC, id DESC);
  END IF;
END
$settlement_history_workspace_indexes$;

CREATE TABLE IF NOT EXISTS peakos_workspace_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  stored_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_workspace_documents_size_check CHECK (size_bytes BETWEEN 0 AND 52428800),
  CONSTRAINT peakos_workspace_documents_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_workspace_documents_category_check
    CHECK (category IN ('branches', 'clients', 'manuals', 'bankbooks', 'other')),
  CONSTRAINT peakos_workspace_documents_mime_type_check
    CHECK (mime_type IN ('image/png', 'image/jpeg', 'application/pdf')),
  CONSTRAINT peakos_workspace_documents_stored_key_check
    CHECK (stored_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS peakos_workspace_documents_storage_key_unique
  ON peakos_workspace_documents(workspace_id, stored_key);

DO $workspace_document_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'peakos_workspace_documents'::regclass
       AND conname = 'peakos_workspace_documents_category_check'
  ) THEN
    ALTER TABLE peakos_workspace_documents
      ADD CONSTRAINT peakos_workspace_documents_category_check
      CHECK (category IN ('branches', 'clients', 'manuals', 'bankbooks', 'other')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'peakos_workspace_documents'::regclass
       AND conname = 'peakos_workspace_documents_mime_type_check'
  ) THEN
    ALTER TABLE peakos_workspace_documents
      ADD CONSTRAINT peakos_workspace_documents_mime_type_check
      CHECK (mime_type IN ('image/png', 'image/jpeg', 'application/pdf')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'peakos_workspace_documents'::regclass
       AND conname = 'peakos_workspace_documents_stored_key_check'
  ) THEN
    ALTER TABLE peakos_workspace_documents
      ADD CONSTRAINT peakos_workspace_documents_stored_key_check
      CHECK (stored_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$') NOT VALID;
  END IF;
END
$workspace_document_checks$;

CREATE INDEX IF NOT EXISTS peakos_workspace_documents_listing
  ON peakos_workspace_documents(workspace_id, category, created_at DESC)
  WHERE deleted = FALSE;

-- The price table is small. It is safe to backfill immediately and change the
-- natural primary key to (workspace_id,key), allowing four independent copies.
ALTER TABLE IF EXISTS peakos_price ADD COLUMN IF NOT EXISTS workspace_id TEXT;
UPDATE peakos_price SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL;
ALTER TABLE IF EXISTS peakos_price ALTER COLUMN workspace_id SET NOT NULL;

DO $price_primary_key$
DECLARE
  current_definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO current_definition
    FROM pg_constraint
   WHERE conrelid = 'peakos_price'::regclass
     AND contype = 'p';
  IF current_definition IS DISTINCT FROM 'PRIMARY KEY (workspace_id, key)' THEN
    ALTER TABLE peakos_price DROP CONSTRAINT IF EXISTS peakos_price_pkey;
    ALTER TABLE peakos_price
      ADD CONSTRAINT peakos_price_pkey PRIMARY KEY (workspace_id, key);
  END IF;
END
$price_primary_key$;

-- Fund used to be a singleton. It is now one singleton per workspace.
ALTER TABLE IF EXISTS peakos_fund ADD COLUMN IF NOT EXISTS workspace_id TEXT;
UPDATE peakos_fund SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL;
ALTER TABLE IF EXISTS peakos_fund ALTER COLUMN workspace_id SET NOT NULL;

DO $fund_primary_key$
DECLARE
  current_definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO current_definition
    FROM pg_constraint
   WHERE conrelid = 'peakos_fund'::regclass
     AND contype = 'p';
  IF current_definition IS DISTINCT FROM 'PRIMARY KEY (workspace_id, id)' THEN
    ALTER TABLE peakos_fund DROP CONSTRAINT IF EXISTS peakos_fund_pkey;
    ALTER TABLE peakos_fund
      ADD CONSTRAINT peakos_fund_pkey PRIMARY KEY (workspace_id, id);
  END IF;
END
$fund_primary_key$;

-- This migration is applied by an owner/DBA, while the server normally runs
-- as calendar_user. Existing table ownership is deliberately unchanged. For a
-- different application role, run `SET peakos.app_role = 'role_name'` in the
-- same operator session before this file.
DO $workspace_runtime_grants$
DECLARE
  configured_role TEXT := NULLIF(current_setting('peakos.app_role', TRUE), '');
  application_role TEXT;
BEGIN
  application_role := configured_role;
  IF application_role IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
      application_role := 'calendar_user';
    ELSE
      application_role := current_user;
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role) THEN
    RAISE EXCEPTION 'PEAK OS application role % does not exist', application_role;
  END IF;

  EXECUTE format('GRANT SELECT ON TABLE peakos_workspaces TO %I', application_role);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE ON TABLE peakos_workspace_memberships TO %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE peakos_workspace_membership_audit TO %I',
    application_role
  );
  EXECUTE format('GRANT SELECT ON TABLE peakos_workspace_bootstrap_state TO %I', application_role);
  EXECUTE format('GRANT SELECT ON TABLE peakos_workspace_documents TO %I', application_role);
  IF to_regclass('peakos_workspace_membership_audit_id_seq') IS NOT NULL THEN
    EXECUTE format(
      'GRANT USAGE, SELECT ON SEQUENCE peakos_workspace_membership_audit_id_seq TO %I',
      application_role
    );
  END IF;
END
$workspace_runtime_grants$;
