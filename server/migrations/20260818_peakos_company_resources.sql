-- Workspace-scoped equipment/development ledgers and protected company files.
--
-- This migration is additive. It creates no company policy content and does
-- not copy or write any protected file. Apply only as an operator after the
-- workspace migration; the runtime role must be supplied with peakos.app_role.

BEGIN;
SET LOCAL search_path = public, pg_catalog;

SELECT pg_advisory_xact_lock(hashtext('peakos-company-resources-v1'));

DO $company_resource_prerequisites$
BEGIN
  IF to_regclass('public.peakos_workspaces') IS NULL
     OR to_regclass('public.peakos_workspace_memberships') IS NULL
     OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'workspace migrations must be applied before company resources'
      USING ERRCODE = '55000';
  END IF;
END
$company_resource_prerequisites$;

CREATE TABLE IF NOT EXISTS public.peakos_protected_company_documents (
  workspace_id TEXT NOT NULL,
  id UUID NOT NULL,
  logical_document_id UUID NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  supersedes_document_id UUID,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  stored_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  archive_reason TEXT NOT NULL DEFAULT '',
  row_version BIGINT NOT NULL DEFAULT 1,
  uploaded_by_uid TEXT NOT NULL,
  uploaded_by_name TEXT NOT NULL,
  last_changed_by_uid TEXT NOT NULL,
  last_changed_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT peakos_protected_company_documents_pkey
    PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_protected_company_documents_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.peakos_workspaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_protected_company_documents_uploader_fk
    FOREIGN KEY (workspace_id, uploaded_by_uid)
    REFERENCES public.peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_protected_company_documents_changer_fk
    FOREIGN KEY (workspace_id, last_changed_by_uid)
    REFERENCES public.peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_protected_company_documents_supersedes_fk
    FOREIGN KEY (workspace_id, supersedes_document_id)
    REFERENCES public.peakos_protected_company_documents(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_protected_company_documents_revision_unique
    UNIQUE (workspace_id, logical_document_id, revision),
  CONSTRAINT peakos_protected_company_documents_storage_unique
    UNIQUE (workspace_id, stored_key),
  CONSTRAINT peakos_protected_company_documents_category_check
    CHECK (category IN ('BANK_COPY', 'COMPANY_MATERIAL', 'DEVELOPMENT_COST_EVIDENCE')),
  CONSTRAINT peakos_protected_company_documents_status_check
    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  CONSTRAINT peakos_protected_company_documents_revision_check
    CHECK (
      (revision = 1 AND logical_document_id = id AND supersedes_document_id IS NULL)
      OR (revision BETWEEN 2 AND 1000000 AND supersedes_document_id IS NOT NULL)
    ),
  CONSTRAINT peakos_protected_company_documents_storage_check
    CHECK (
      stored_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](pdf|png|jpg)$'
      AND mime_type IN ('application/pdf', 'image/png', 'image/jpeg')
      AND size_bytes BETWEEN 32 AND 20971520
      AND sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT peakos_protected_company_documents_text_check
    CHECK (
      char_length(btrim(title)) BETWEEN 1 AND 180
      AND char_length(btrim(original_filename)) BETWEEN 1 AND 180
      AND char_length(btrim(uploaded_by_uid)) BETWEEN 1 AND 256
      AND char_length(btrim(uploaded_by_name)) BETWEEN 1 AND 160
      AND char_length(btrim(last_changed_by_uid)) BETWEEN 1 AND 256
      AND char_length(btrim(last_changed_by_name)) BETWEEN 1 AND 160
      AND char_length(archive_reason) <= 500
    ),
  CONSTRAINT peakos_protected_company_documents_version_check
    CHECK (row_version >= 1),
  CONSTRAINT peakos_protected_company_documents_time_check
    CHECK (created_at <= updated_at),
  CONSTRAINT peakos_protected_company_documents_archive_check
    CHECK (
      (status = 'ACTIVE' AND archive_reason = '')
      OR (status = 'ARCHIVED' AND char_length(btrim(archive_reason)) BETWEEN 2 AND 500)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS peakos_protected_company_documents_one_active_idx
  ON public.peakos_protected_company_documents(workspace_id, logical_document_id)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS peakos_protected_company_documents_category_idx
  ON public.peakos_protected_company_documents
    (workspace_id, category, status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.peakos_equipment_usage_entries (
  workspace_id TEXT NOT NULL,
  id UUID NOT NULL,
  used_on DATE NOT NULL,
  item_name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  used_by_uid TEXT NOT NULL,
  used_by_name TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  void_reason TEXT NOT NULL DEFAULT '',
  row_version BIGINT NOT NULL DEFAULT 1,
  recorded_by_uid TEXT NOT NULL,
  recorded_by_name TEXT NOT NULL,
  last_changed_by_uid TEXT NOT NULL,
  last_changed_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT peakos_equipment_usage_entries_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_equipment_usage_entries_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.peakos_workspaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_equipment_usage_entries_user_fk
    FOREIGN KEY (workspace_id, used_by_uid)
    REFERENCES public.peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_equipment_usage_entries_recorder_fk
    FOREIGN KEY (workspace_id, recorded_by_uid)
    REFERENCES public.peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_equipment_usage_entries_changer_fk
    FOREIGN KEY (workspace_id, last_changed_by_uid)
    REFERENCES public.peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_equipment_usage_entries_status_check
    CHECK (status IN ('ACTIVE', 'VOIDED')),
  CONSTRAINT peakos_equipment_usage_entries_quantity_check
    CHECK (quantity BETWEEN 1 AND 100000),
  CONSTRAINT peakos_equipment_usage_entries_text_check
    CHECK (
      char_length(btrim(item_name)) BETWEEN 1 AND 160
      AND char_length(btrim(purpose)) BETWEEN 2 AND 500
      AND char_length(btrim(used_by_uid)) BETWEEN 1 AND 256
      AND char_length(btrim(used_by_name)) BETWEEN 1 AND 160
      AND char_length(memo) <= 500
      AND char_length(btrim(recorded_by_uid)) BETWEEN 1 AND 256
      AND char_length(btrim(recorded_by_name)) BETWEEN 1 AND 160
      AND char_length(btrim(last_changed_by_uid)) BETWEEN 1 AND 256
      AND char_length(btrim(last_changed_by_name)) BETWEEN 1 AND 160
    ),
  CONSTRAINT peakos_equipment_usage_entries_void_check
    CHECK (
      (status = 'ACTIVE' AND void_reason = '')
      OR (status = 'VOIDED' AND char_length(btrim(void_reason)) BETWEEN 2 AND 500)
    ),
  CONSTRAINT peakos_equipment_usage_entries_version_check CHECK (row_version >= 1),
  CONSTRAINT peakos_equipment_usage_entries_time_check CHECK (created_at <= updated_at)
);

CREATE INDEX IF NOT EXISTS peakos_equipment_usage_entries_date_idx
  ON public.peakos_equipment_usage_entries
    (workspace_id, used_on DESC, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS peakos_equipment_usage_entries_user_idx
  ON public.peakos_equipment_usage_entries
    (workspace_id, used_by_uid, used_on DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.peakos_development_cost_entries (
  workspace_id TEXT NOT NULL,
  id UUID NOT NULL,
  spent_on DATE NOT NULL,
  title TEXT NOT NULL,
  vendor TEXT NOT NULL,
  amount_krw NUMERIC(20,0) NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  evidence_document_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  void_reason TEXT NOT NULL DEFAULT '',
  row_version BIGINT NOT NULL DEFAULT 1,
  recorded_by_uid TEXT NOT NULL,
  recorded_by_name TEXT NOT NULL,
  last_changed_by_uid TEXT NOT NULL,
  last_changed_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT peakos_development_cost_entries_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_development_cost_entries_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.peakos_workspaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_development_cost_entries_evidence_fk
    FOREIGN KEY (workspace_id, evidence_document_id)
    REFERENCES public.peakos_protected_company_documents(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_development_cost_entries_recorder_fk
    FOREIGN KEY (workspace_id, recorded_by_uid)
    REFERENCES public.peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_development_cost_entries_changer_fk
    FOREIGN KEY (workspace_id, last_changed_by_uid)
    REFERENCES public.peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_development_cost_entries_status_check
    CHECK (status IN ('ACTIVE', 'VOIDED')),
  CONSTRAINT peakos_development_cost_entries_amount_check
    CHECK (amount_krw BETWEEN 1 AND 1000000000000),
  CONSTRAINT peakos_development_cost_entries_text_check
    CHECK (
      char_length(btrim(title)) BETWEEN 2 AND 180
      AND char_length(btrim(vendor)) BETWEEN 1 AND 160
      AND char_length(memo) <= 1000
      AND char_length(btrim(recorded_by_uid)) BETWEEN 1 AND 256
      AND char_length(btrim(recorded_by_name)) BETWEEN 1 AND 160
      AND char_length(btrim(last_changed_by_uid)) BETWEEN 1 AND 256
      AND char_length(btrim(last_changed_by_name)) BETWEEN 1 AND 160
    ),
  CONSTRAINT peakos_development_cost_entries_void_check
    CHECK (
      (status = 'ACTIVE' AND void_reason = '')
      OR (status = 'VOIDED' AND char_length(btrim(void_reason)) BETWEEN 2 AND 500)
    ),
  CONSTRAINT peakos_development_cost_entries_version_check CHECK (row_version >= 1),
  CONSTRAINT peakos_development_cost_entries_time_check CHECK (created_at <= updated_at)
);

CREATE INDEX IF NOT EXISTS peakos_development_cost_entries_date_idx
  ON public.peakos_development_cost_entries
    (workspace_id, spent_on DESC, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS peakos_development_cost_entries_evidence_idx
  ON public.peakos_development_cost_entries
    (workspace_id, evidence_document_id);

CREATE TABLE IF NOT EXISTS public.peakos_company_resource_audit (
  id BIGSERIAL NOT NULL,
  workspace_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  action TEXT NOT NULL,
  row_version BIGINT NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT peakos_company_resource_audit_pkey PRIMARY KEY (id),
  CONSTRAINT peakos_company_resource_audit_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.peakos_workspaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_company_resource_audit_entity_check
    CHECK (entity_type IN ('EQUIPMENT_USAGE', 'DEVELOPMENT_COST', 'PROTECTED_DOCUMENT')),
  CONSTRAINT peakos_company_resource_audit_action_check
    CHECK (action IN ('CREATED', 'VOIDED', 'ARCHIVED')),
  CONSTRAINT peakos_company_resource_audit_shape_check
    CHECK (
      (action = 'CREATED' AND before_state IS NULL)
      OR (action IN ('VOIDED', 'ARCHIVED') AND before_state IS NOT NULL)
    ),
  CONSTRAINT peakos_company_resource_audit_actor_check
    CHECK (
      row_version >= 1
      AND char_length(btrim(actor_uid)) BETWEEN 1 AND 256
      AND char_length(btrim(actor_name)) BETWEEN 1 AND 160
    )
);

CREATE INDEX IF NOT EXISTS peakos_company_resource_audit_entity_idx
  ON public.peakos_company_resource_audit
    (workspace_id, entity_type, entity_id, id DESC);

CREATE OR REPLACE FUNCTION public.peakos_company_resource_reject_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $company_resource_reject_mutation$
BEGIN
  RAISE EXCEPTION '% does not allow this mutation', TG_TABLE_NAME
    USING ERRCODE = '55000', CONSTRAINT = 'peakos_company_resource_append_only';
END
$company_resource_reject_mutation$;

CREATE OR REPLACE FUNCTION public.peakos_company_resource_guard_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $company_resource_guard_update$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.row_version IS DISTINCT FROM OLD.row_version + 1
     OR NEW.updated_at <= OLD.updated_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'company resource identity/version is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'peakos_company_resource_version_guard';
  END IF;

  IF TG_TABLE_NAME = 'peakos_equipment_usage_entries' THEN
    IF NEW.used_on IS DISTINCT FROM OLD.used_on
       OR NEW.item_name IS DISTINCT FROM OLD.item_name
       OR NEW.purpose IS DISTINCT FROM OLD.purpose
       OR NEW.quantity IS DISTINCT FROM OLD.quantity
       OR NEW.used_by_uid IS DISTINCT FROM OLD.used_by_uid
       OR NEW.used_by_name IS DISTINCT FROM OLD.used_by_name
       OR NEW.memo IS DISTINCT FROM OLD.memo
       OR NEW.recorded_by_uid IS DISTINCT FROM OLD.recorded_by_uid
       OR NEW.recorded_by_name IS DISTINCT FROM OLD.recorded_by_name
       OR OLD.status <> 'ACTIVE' OR NEW.status <> 'VOIDED' THEN
      RAISE EXCEPTION 'equipment usage entries can only be voided'
        USING ERRCODE = '23514', CONSTRAINT = 'peakos_equipment_usage_void_guard';
    END IF;
  ELSIF TG_TABLE_NAME = 'peakos_development_cost_entries' THEN
    IF NEW.spent_on IS DISTINCT FROM OLD.spent_on
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.vendor IS DISTINCT FROM OLD.vendor
       OR NEW.amount_krw IS DISTINCT FROM OLD.amount_krw
       OR NEW.memo IS DISTINCT FROM OLD.memo
       OR NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id
       OR NEW.recorded_by_uid IS DISTINCT FROM OLD.recorded_by_uid
       OR NEW.recorded_by_name IS DISTINCT FROM OLD.recorded_by_name
       OR OLD.status <> 'ACTIVE' OR NEW.status <> 'VOIDED' THEN
      RAISE EXCEPTION 'development cost entries can only be voided'
        USING ERRCODE = '23514', CONSTRAINT = 'peakos_development_cost_void_guard';
    END IF;
  ELSE
    IF NEW.logical_document_id IS DISTINCT FROM OLD.logical_document_id
       OR NEW.revision IS DISTINCT FROM OLD.revision
       OR NEW.supersedes_document_id IS DISTINCT FROM OLD.supersedes_document_id
       OR NEW.category IS DISTINCT FROM OLD.category
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
       OR NEW.stored_key IS DISTINCT FROM OLD.stored_key
       OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
       OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
       OR NEW.sha256 IS DISTINCT FROM OLD.sha256
       OR NEW.uploaded_by_uid IS DISTINCT FROM OLD.uploaded_by_uid
       OR NEW.uploaded_by_name IS DISTINCT FROM OLD.uploaded_by_name
       OR OLD.status <> 'ACTIVE' OR NEW.status <> 'ARCHIVED' THEN
      RAISE EXCEPTION 'protected documents can only be archived'
        USING ERRCODE = '23514', CONSTRAINT = 'peakos_protected_document_archive_guard';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.peakos_development_cost_entries cost
       WHERE cost.workspace_id = OLD.workspace_id
         AND cost.evidence_document_id = OLD.id
         AND cost.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'active development cost evidence cannot be archived'
        USING ERRCODE = '23514', CONSTRAINT = 'peakos_development_cost_evidence_active_guard';
    END IF;
  END IF;
  RETURN NEW;
END
$company_resource_guard_update$;

CREATE OR REPLACE FUNCTION public.peakos_company_resource_validate_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $company_resource_validate_insert$
DECLARE
  parent_document public.peakos_protected_company_documents%ROWTYPE;
  evidence_document public.peakos_protected_company_documents%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'peakos_protected_company_documents' THEN
    IF NEW.revision > 1 THEN
      SELECT document.* INTO parent_document
        FROM public.peakos_protected_company_documents document
       WHERE document.workspace_id = NEW.workspace_id
         AND document.id = NEW.supersedes_document_id;
      IF NOT FOUND
         OR parent_document.logical_document_id IS DISTINCT FROM NEW.logical_document_id
         OR parent_document.category IS DISTINCT FROM NEW.category
         OR parent_document.revision + 1 <> NEW.revision
         OR parent_document.status <> 'ARCHIVED' THEN
        RAISE EXCEPTION 'protected document revision chain is invalid'
          USING ERRCODE = '23514', CONSTRAINT = 'peakos_protected_document_revision_guard';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'peakos_development_cost_entries' THEN
    SELECT document.* INTO evidence_document
      FROM public.peakos_protected_company_documents document
     WHERE document.workspace_id = NEW.workspace_id
       AND document.id = NEW.evidence_document_id;
    IF NOT FOUND OR evidence_document.status <> 'ACTIVE'
       OR evidence_document.category <> 'DEVELOPMENT_COST_EVIDENCE' THEN
      RAISE EXCEPTION 'development cost requires active same-workspace evidence'
        USING ERRCODE = '23514', CONSTRAINT = 'peakos_development_cost_evidence_guard';
    END IF;
  END IF;
  RETURN NEW;
END
$company_resource_validate_insert$;

CREATE OR REPLACE FUNCTION public.peakos_company_resource_write_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $company_resource_write_audit$
DECLARE
  entity_type_value TEXT;
  action_value TEXT;
  actor_uid_value TEXT;
  actor_name_value TEXT;
BEGIN
  IF TG_TABLE_NAME = 'peakos_equipment_usage_entries' THEN
    entity_type_value := 'EQUIPMENT_USAGE';
    actor_uid_value := CASE WHEN TG_OP = 'INSERT' THEN NEW.recorded_by_uid ELSE NEW.last_changed_by_uid END;
    actor_name_value := CASE WHEN TG_OP = 'INSERT' THEN NEW.recorded_by_name ELSE NEW.last_changed_by_name END;
    action_value := CASE WHEN TG_OP = 'INSERT' THEN 'CREATED' ELSE 'VOIDED' END;
  ELSIF TG_TABLE_NAME = 'peakos_development_cost_entries' THEN
    entity_type_value := 'DEVELOPMENT_COST';
    actor_uid_value := CASE WHEN TG_OP = 'INSERT' THEN NEW.recorded_by_uid ELSE NEW.last_changed_by_uid END;
    actor_name_value := CASE WHEN TG_OP = 'INSERT' THEN NEW.recorded_by_name ELSE NEW.last_changed_by_name END;
    action_value := CASE WHEN TG_OP = 'INSERT' THEN 'CREATED' ELSE 'VOIDED' END;
  ELSE
    entity_type_value := 'PROTECTED_DOCUMENT';
    actor_uid_value := CASE WHEN TG_OP = 'INSERT' THEN NEW.uploaded_by_uid ELSE NEW.last_changed_by_uid END;
    actor_name_value := CASE WHEN TG_OP = 'INSERT' THEN NEW.uploaded_by_name ELSE NEW.last_changed_by_name END;
    action_value := CASE WHEN TG_OP = 'INSERT' THEN 'CREATED' ELSE 'ARCHIVED' END;
  END IF;

  INSERT INTO public.peakos_company_resource_audit
    (workspace_id, entity_type, entity_id, action, row_version,
     actor_uid, actor_name, before_state, after_state, created_at)
  VALUES
    (NEW.workspace_id, entity_type_value, NEW.id, action_value, NEW.row_version,
     actor_uid_value, actor_name_value,
     CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
     to_jsonb(NEW), NEW.updated_at);
  RETURN NEW;
END
$company_resource_write_audit$;

DROP TRIGGER IF EXISTS peakos_equipment_usage_guard_update ON public.peakos_equipment_usage_entries;
CREATE TRIGGER peakos_equipment_usage_guard_update
  BEFORE UPDATE ON public.peakos_equipment_usage_entries
  FOR EACH ROW EXECUTE FUNCTION public.peakos_company_resource_guard_update();
DROP TRIGGER IF EXISTS peakos_development_cost_guard_update ON public.peakos_development_cost_entries;
CREATE TRIGGER peakos_development_cost_guard_update
  BEFORE UPDATE ON public.peakos_development_cost_entries
  FOR EACH ROW EXECUTE FUNCTION public.peakos_company_resource_guard_update();
DROP TRIGGER IF EXISTS peakos_protected_company_document_guard_update ON public.peakos_protected_company_documents;
CREATE TRIGGER peakos_protected_company_document_guard_update
  BEFORE UPDATE ON public.peakos_protected_company_documents
  FOR EACH ROW EXECUTE FUNCTION public.peakos_company_resource_guard_update();

DROP TRIGGER IF EXISTS peakos_development_cost_validate_insert ON public.peakos_development_cost_entries;
CREATE TRIGGER peakos_development_cost_validate_insert
  BEFORE INSERT ON public.peakos_development_cost_entries
  FOR EACH ROW EXECUTE FUNCTION public.peakos_company_resource_validate_insert();
DROP TRIGGER IF EXISTS peakos_protected_company_document_validate_insert ON public.peakos_protected_company_documents;
CREATE TRIGGER peakos_protected_company_document_validate_insert
  BEFORE INSERT ON public.peakos_protected_company_documents
  FOR EACH ROW EXECUTE FUNCTION public.peakos_company_resource_validate_insert();

DROP TRIGGER IF EXISTS peakos_equipment_usage_write_audit ON public.peakos_equipment_usage_entries;
CREATE TRIGGER peakos_equipment_usage_write_audit
  AFTER INSERT OR UPDATE ON public.peakos_equipment_usage_entries
  FOR EACH ROW EXECUTE FUNCTION public.peakos_company_resource_write_audit();
DROP TRIGGER IF EXISTS peakos_development_cost_write_audit ON public.peakos_development_cost_entries;
CREATE TRIGGER peakos_development_cost_write_audit
  AFTER INSERT OR UPDATE ON public.peakos_development_cost_entries
  FOR EACH ROW EXECUTE FUNCTION public.peakos_company_resource_write_audit();
DROP TRIGGER IF EXISTS peakos_protected_company_document_write_audit ON public.peakos_protected_company_documents;
CREATE TRIGGER peakos_protected_company_document_write_audit
  AFTER INSERT OR UPDATE ON public.peakos_protected_company_documents
  FOR EACH ROW EXECUTE FUNCTION public.peakos_company_resource_write_audit();

DO $company_resource_append_only_triggers$
DECLARE
  table_name_value TEXT;
BEGIN
  FOREACH table_name_value IN ARRAY ARRAY[
    'peakos_equipment_usage_entries',
    'peakos_development_cost_entries',
    'peakos_protected_company_documents'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', table_name_value || '_no_delete', table_name_value);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.peakos_company_resource_reject_mutation()',
      table_name_value || '_no_delete', table_name_value
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', table_name_value || '_no_truncate', table_name_value);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.peakos_company_resource_reject_mutation()',
      table_name_value || '_no_truncate', table_name_value
    );
  END LOOP;
END
$company_resource_append_only_triggers$;

DROP TRIGGER IF EXISTS peakos_company_resource_audit_no_mutation ON public.peakos_company_resource_audit;
CREATE TRIGGER peakos_company_resource_audit_no_mutation
  BEFORE UPDATE OR DELETE ON public.peakos_company_resource_audit
  FOR EACH ROW EXECUTE FUNCTION public.peakos_company_resource_reject_mutation();
DROP TRIGGER IF EXISTS peakos_company_resource_audit_no_truncate ON public.peakos_company_resource_audit;
CREATE TRIGGER peakos_company_resource_audit_no_truncate
  BEFORE TRUNCATE ON public.peakos_company_resource_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.peakos_company_resource_reject_mutation();

DO $company_resource_acl$
DECLARE
  configured_role TEXT := NULLIF(current_setting('peakos.app_role', TRUE), '');
  application_role TEXT;
  migration_owner TEXT := current_user;
  function_signature TEXT;
  privilege_name TEXT;
BEGIN
  IF configured_role IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = configured_role) THEN
      RAISE EXCEPTION 'configured peakos.app_role does not exist';
    END IF;
    application_role := configured_role;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
    application_role := 'calendar_user';
  ELSE
    RAISE EXCEPTION 'set peakos.app_role before applying company resource migration';
  END IF;
  IF application_role = migration_owner THEN
    RAISE EXCEPTION 'company resource migration must run as an operator role, not the runtime role';
  END IF;

  EXECUTE format('ALTER TABLE public.peakos_equipment_usage_entries OWNER TO %I', migration_owner);
  EXECUTE format('ALTER TABLE public.peakos_development_cost_entries OWNER TO %I', migration_owner);
  EXECUTE format('ALTER TABLE public.peakos_protected_company_documents OWNER TO %I', migration_owner);
  EXECUTE format('ALTER TABLE public.peakos_company_resource_audit OWNER TO %I', migration_owner);
  EXECUTE format('ALTER SEQUENCE public.peakos_company_resource_audit_id_seq OWNER TO %I', migration_owner);

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE public.peakos_equipment_usage_entries, public.peakos_development_cost_entries, public.peakos_protected_company_documents, public.peakos_company_resource_audit FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON SEQUENCE public.peakos_company_resource_audit_id_seq FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE ON TABLE public.peakos_equipment_usage_entries, public.peakos_development_cost_entries, public.peakos_protected_company_documents TO %I',
    application_role
  );
  EXECUTE format('GRANT SELECT ON TABLE public.peakos_company_resource_audit TO %I', application_role);

  FOREACH function_signature IN ARRAY ARRAY[
    'public.peakos_company_resource_reject_mutation()',
    'public.peakos_company_resource_guard_update()',
    'public.peakos_company_resource_validate_insert()',
    'public.peakos_company_resource_write_audit()'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', function_signature, migration_owner);
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, %I', function_signature, application_role);
  END LOOP;

  FOREACH privilege_name IN ARRAY ARRAY['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
  LOOP
    IF has_table_privilege(application_role, 'public.peakos_equipment_usage_entries', privilege_name)
       OR has_table_privilege(application_role, 'public.peakos_development_cost_entries', privilege_name)
       OR has_table_privilege(application_role, 'public.peakos_protected_company_documents', privilege_name)
       OR has_table_privilege(application_role, 'public.peakos_company_resource_audit', privilege_name) THEN
      RAISE EXCEPTION 'runtime role % has unsafe company resource % privilege', application_role, privilege_name
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF has_table_privilege(application_role, 'public.peakos_company_resource_audit', 'INSERT')
     OR has_table_privilege(application_role, 'public.peakos_company_resource_audit', 'UPDATE') THEN
    RAISE EXCEPTION 'runtime role % can forge company resource audit', application_role
      USING ERRCODE = '55000';
  END IF;
END
$company_resource_acl$;

COMMIT;
