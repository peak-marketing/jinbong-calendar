-- Protected, append-only tax-invoice evidence for finance requests.
--
-- This migration records evidence supplied after an invoice was issued by an
-- external system. It never issues, corrects, sends, or pays a tax invoice.
-- Apply as an operator after the workspace and finance-request migrations.

BEGIN;
SET LOCAL search_path = public, pg_catalog;

SELECT pg_advisory_xact_lock(hashtext('peakos-tax-invoice-evidence-v1'));

DO $tax_invoice_evidence_prerequisites$
BEGIN
  IF to_regclass('public.peakos_workspaces') IS NULL
     OR to_regclass('public.peakos_finance_requests') IS NULL
     OR to_regclass('public.peakos_finance_request_events') IS NULL THEN
    RAISE EXCEPTION
      'workspace and finance-request migrations must be applied before tax-invoice evidence'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.peakos_finance_requests'::regclass
       AND attname = 'workspace_id' AND atttypid = 'text'::regtype
       AND attnotnull AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.peakos_finance_requests'::regclass
       AND attname = 'version' AND atttypid = 'integer'::regtype
       AND attnotnull AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_index index_row
      JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
     WHERE index_row.indrelid = 'public.peakos_finance_requests'::regclass
       AND index_relation.relname = 'peakos_finance_requests_workspace_id_unique'
       AND index_row.indisunique AND index_row.indisvalid AND index_row.indisready
  ) THEN
    RAISE EXCEPTION
      'workspace-scoped finance-request schema is required before tax-invoice evidence'
      USING ERRCODE = '55000';
  END IF;
END
$tax_invoice_evidence_prerequisites$;

CREATE TABLE IF NOT EXISTS public.peakos_tax_invoice_evidence (
  id UUID NOT NULL,
  workspace_id TEXT NOT NULL,
  finance_request_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  action_kind TEXT NOT NULL,
  target_invoice_status TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  supplier_registration_number TEXT NOT NULL,
  document_identifier TEXT NOT NULL,
  correction_reason TEXT NOT NULL DEFAULT '',
  stored_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  supersedes_evidence_id UUID,
  registered_by_uid TEXT NOT NULL,
  registered_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT peakos_tax_invoice_evidence_pkey PRIMARY KEY (id),
  CONSTRAINT peakos_tax_invoice_evidence_workspace_request_id_unique
    UNIQUE (workspace_id, finance_request_id, id),
  CONSTRAINT peakos_tax_invoice_evidence_workspace_request_revision_unique
    UNIQUE (workspace_id, finance_request_id, revision),
  CONSTRAINT peakos_tax_invoice_evidence_request_fk
    FOREIGN KEY (workspace_id, finance_request_id)
    REFERENCES public.peakos_finance_requests(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_tax_invoice_evidence_supersedes_fk
    FOREIGN KEY (workspace_id, finance_request_id, supersedes_evidence_id)
    REFERENCES public.peakos_tax_invoice_evidence(workspace_id, finance_request_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_tax_invoice_evidence_revision_check
    CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT peakos_tax_invoice_evidence_action_check
    CHECK (action_kind IN ('ISSUE', 'CORRECTION', 'REPLACEMENT')),
  CONSTRAINT peakos_tax_invoice_evidence_target_status_check
    CHECK (target_invoice_status IN ('ISSUED', 'CORRECTED')),
  CONSTRAINT peakos_tax_invoice_evidence_action_shape_check
    CHECK (
      (action_kind = 'ISSUE' AND target_invoice_status = 'ISSUED'
        AND supersedes_evidence_id IS NULL AND correction_reason = '')
      OR
      (action_kind = 'CORRECTION' AND target_invoice_status = 'CORRECTED'
        AND correction_reason <> '')
      OR
      (action_kind = 'REPLACEMENT' AND supersedes_evidence_id IS NOT NULL)
    ),
  CONSTRAINT peakos_tax_invoice_evidence_invoice_number_check
    CHECK (
      char_length(invoice_number) BETWEEN 8 AND 40
      AND invoice_number ~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$'
      AND char_length(replace(invoice_number, '-', '')) BETWEEN 8 AND 32
      AND invoice_number ~ '[0-9].*[0-9].*[0-9].*[0-9].*[0-9].*[0-9]'
    ),
  CONSTRAINT peakos_tax_invoice_evidence_supplier_number_check
    CHECK (supplier_registration_number ~ '^[0-9]{10}$'),
  CONSTRAINT peakos_tax_invoice_evidence_document_identifier_check
    CHECK (
      char_length(document_identifier) BETWEEN 4 AND 120
      AND document_identifier !~ '[[:cntrl:]/\\]'
    ),
  CONSTRAINT peakos_tax_invoice_evidence_correction_reason_check
    CHECK (char_length(correction_reason) <= 500),
  CONSTRAINT peakos_tax_invoice_evidence_stored_key_check
    CHECK (stored_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|png|jpg)$'),
  CONSTRAINT peakos_tax_invoice_evidence_filename_check
    CHECK (
      char_length(original_filename) BETWEEN 1 AND 180
      AND original_filename !~ '[[:cntrl:]/\\]'
    ),
  CONSTRAINT peakos_tax_invoice_evidence_mime_check
    CHECK (mime_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  CONSTRAINT peakos_tax_invoice_evidence_size_check
    CHECK (size_bytes BETWEEN 32 AND 10485760),
  CONSTRAINT peakos_tax_invoice_evidence_sha256_check
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_tax_invoice_evidence_actor_check
    CHECK (
      char_length(btrim(registered_by_uid)) BETWEEN 1 AND 256
      AND char_length(btrim(registered_by_name)) BETWEEN 1 AND 160
    ),
  CONSTRAINT peakos_tax_invoice_evidence_time_check
    CHECK (issued_at >= TIMESTAMPTZ '2000-01-01 00:00:00+00'
      AND created_at >= TIMESTAMPTZ '2000-01-01 00:00:00+00')
);

CREATE UNIQUE INDEX IF NOT EXISTS peakos_tax_invoice_evidence_document_identity_unique
  ON public.peakos_tax_invoice_evidence
    (workspace_id, supplier_registration_number, invoice_number)
  WHERE action_kind <> 'REPLACEMENT';
CREATE INDEX IF NOT EXISTS peakos_tax_invoice_evidence_request_created_idx
  ON public.peakos_tax_invoice_evidence
    (workspace_id, finance_request_id, revision DESC, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.peakos_tax_invoice_evidence_audit (
  id BIGSERIAL NOT NULL,
  workspace_id TEXT NOT NULL,
  finance_request_id TEXT NOT NULL,
  evidence_id UUID NOT NULL,
  action TEXT NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT peakos_tax_invoice_evidence_audit_pkey PRIMARY KEY (id),
  CONSTRAINT peakos_tax_invoice_evidence_audit_evidence_fk
    FOREIGN KEY (workspace_id, finance_request_id, evidence_id)
    REFERENCES public.peakos_tax_invoice_evidence(workspace_id, finance_request_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_tax_invoice_evidence_audit_action_check
    CHECK (action IN ('EVIDENCE_REGISTERED', 'EVIDENCE_CORRECTED', 'EVIDENCE_REPLACED')),
  CONSTRAINT peakos_tax_invoice_evidence_audit_actor_check
    CHECK (
      char_length(btrim(actor_uid)) BETWEEN 1 AND 256
      AND char_length(btrim(actor_name)) BETWEEN 1 AND 160
    )
);

CREATE INDEX IF NOT EXISTS peakos_tax_invoice_evidence_audit_request_idx
  ON public.peakos_tax_invoice_evidence_audit
    (workspace_id, finance_request_id, id);

ALTER TABLE public.peakos_finance_requests
  ADD COLUMN IF NOT EXISTS current_invoice_evidence_id UUID;

DO $tax_invoice_current_evidence_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.peakos_finance_requests'::regclass
       AND conname = 'peakos_finance_requests_current_invoice_evidence_fk'
  ) THEN
    ALTER TABLE public.peakos_finance_requests
      ADD CONSTRAINT peakos_finance_requests_current_invoice_evidence_fk
      FOREIGN KEY (workspace_id, id, current_invoice_evidence_id)
      REFERENCES public.peakos_tax_invoice_evidence(workspace_id, finance_request_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.peakos_finance_requests'::regclass
       AND conname = 'peakos_finance_requests_terminal_invoice_evidence_check'
  ) THEN
    -- Historical terminal rows may only contain the retired URL field. Keep
    -- them visible for remediation, while PostgreSQL enforces this check on
    -- every new or updated row immediately.
    ALTER TABLE public.peakos_finance_requests
      ADD CONSTRAINT peakos_finance_requests_terminal_invoice_evidence_check
      CHECK (
        invoice_status NOT IN ('ISSUED', 'CORRECTED')
        OR current_invoice_evidence_id IS NOT NULL
      ) NOT VALID;
  END IF;
END
$tax_invoice_current_evidence_constraints$;

CREATE OR REPLACE FUNCTION public.peakos_tax_invoice_evidence_reject_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $tax_invoice_evidence_reject_mutation$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000',
          CONSTRAINT = 'peakos_tax_invoice_evidence_append_only';
END
$tax_invoice_evidence_reject_mutation$;

CREATE OR REPLACE FUNCTION public.peakos_tax_invoice_evidence_validate_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $tax_invoice_evidence_validate_insert$
DECLARE
  request_row public.peakos_finance_requests%ROWTYPE;
  current_evidence public.peakos_tax_invoice_evidence%ROWTYPE;
  expected_revision INTEGER;
BEGIN
  SELECT request.* INTO STRICT request_row
    FROM public.peakos_finance_requests request
   WHERE request.workspace_id = NEW.workspace_id
     AND request.id = NEW.finance_request_id
   FOR UPDATE;

  IF request_row.invoice_requested IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'tax invoice evidence requires an invoice request'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_tax_invoice_evidence_request_state_check';
  END IF;

  IF request_row.current_invoice_evidence_id IS NULL THEN
    expected_revision := 1;
  ELSE
    SELECT evidence.* INTO STRICT current_evidence
      FROM public.peakos_tax_invoice_evidence evidence
     WHERE evidence.workspace_id = NEW.workspace_id
       AND evidence.finance_request_id = NEW.finance_request_id
       AND evidence.id = request_row.current_invoice_evidence_id;
    expected_revision := current_evidence.revision + 1;
  END IF;

  IF NEW.revision <> expected_revision THEN
    RAISE EXCEPTION 'tax invoice evidence revision is stale'
      USING ERRCODE = '40001',
            CONSTRAINT = 'peakos_tax_invoice_evidence_revision_stale';
  END IF;

  IF NEW.action_kind = 'ISSUE' THEN
    IF request_row.current_invoice_evidence_id IS NOT NULL
       OR request_row.invoice_status NOT IN ('REQUESTED', 'PROCESSING', 'ISSUED') THEN
      RAISE EXCEPTION 'invoice issue evidence does not match request state'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_tax_invoice_evidence_request_state_check';
    END IF;
  ELSIF NEW.action_kind = 'CORRECTION' THEN
    IF request_row.invoice_status NOT IN ('CORRECTION_REQUESTED', 'PROCESSING', 'CORRECTED')
       OR NEW.target_invoice_status <> 'CORRECTED'
       OR NEW.supersedes_evidence_id IS DISTINCT FROM request_row.current_invoice_evidence_id THEN
      RAISE EXCEPTION 'invoice correction evidence does not match request state'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_tax_invoice_evidence_request_state_check';
    END IF;
  ELSE
    IF request_row.invoice_status NOT IN ('ISSUED', 'CORRECTED')
       OR request_row.current_invoice_evidence_id IS NULL
       OR NEW.target_invoice_status IS DISTINCT FROM request_row.invoice_status
       OR NEW.supersedes_evidence_id IS DISTINCT FROM request_row.current_invoice_evidence_id THEN
      RAISE EXCEPTION 'replacement evidence does not match current invoice evidence'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_tax_invoice_evidence_request_state_check';
    END IF;
  END IF;

  RETURN NEW;
END
$tax_invoice_evidence_validate_insert$;

CREATE OR REPLACE FUNCTION public.peakos_tax_invoice_evidence_audit_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $tax_invoice_evidence_audit_insert$
BEGIN
  INSERT INTO public.peakos_tax_invoice_evidence_audit
    (workspace_id, finance_request_id, evidence_id, action, actor_uid,
     actor_name, state, created_at)
  VALUES
    (NEW.workspace_id, NEW.finance_request_id, NEW.id,
     CASE NEW.action_kind
       WHEN 'ISSUE' THEN 'EVIDENCE_REGISTERED'
       WHEN 'CORRECTION' THEN 'EVIDENCE_CORRECTED'
       ELSE 'EVIDENCE_REPLACED'
     END,
     NEW.registered_by_uid, NEW.registered_by_name,
     jsonb_build_object(
       'revision', NEW.revision,
       'targetInvoiceStatus', NEW.target_invoice_status,
       'mimeType', NEW.mime_type,
       'sizeBytes', NEW.size_bytes,
       'sha256', NEW.sha256,
       'supersedesEvidenceId', NEW.supersedes_evidence_id,
       'documentIdentifier', NEW.document_identifier
     ),
     NEW.created_at);
  RETURN NEW;
END
$tax_invoice_evidence_audit_insert$;

CREATE OR REPLACE FUNCTION public.peakos_tax_invoice_evidence_validate_commit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $tax_invoice_evidence_validate_commit$
DECLARE
  request_row public.peakos_finance_requests%ROWTYPE;
BEGIN
  SELECT request.* INTO STRICT request_row
    FROM public.peakos_finance_requests request
   WHERE request.workspace_id = NEW.workspace_id
     AND request.id = NEW.finance_request_id;
  IF request_row.current_invoice_evidence_id IS DISTINCT FROM NEW.id
     OR request_row.invoice_status IS DISTINCT FROM NEW.target_invoice_status THEN
    RAISE EXCEPTION 'new tax invoice evidence must become the request current evidence in the same transaction'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_tax_invoice_evidence_current_link_check';
  END IF;
  RETURN NEW;
END
$tax_invoice_evidence_validate_commit$;

CREATE OR REPLACE FUNCTION public.peakos_finance_request_invoice_evidence_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $peakos_finance_request_invoice_evidence_guard$
DECLARE
  linked_evidence public.peakos_tax_invoice_evidence%ROWTYPE;
  previous_evidence public.peakos_tax_invoice_evidence%ROWTYPE;
BEGIN
  IF NEW.invoice_status IN ('ISSUED', 'CORRECTED') THEN
    IF NEW.current_invoice_evidence_id IS NULL THEN
      RAISE EXCEPTION 'terminal invoice status requires protected evidence'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_finance_requests_terminal_invoice_evidence_check';
    END IF;
    SELECT evidence.* INTO STRICT linked_evidence
      FROM public.peakos_tax_invoice_evidence evidence
     WHERE evidence.workspace_id = NEW.workspace_id
       AND evidence.finance_request_id = NEW.id
       AND evidence.id = NEW.current_invoice_evidence_id;
    IF linked_evidence.target_invoice_status IS DISTINCT FROM NEW.invoice_status THEN
      RAISE EXCEPTION 'invoice status and protected evidence do not match'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_finance_requests_terminal_invoice_evidence_check';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.current_invoice_evidence_id IS NOT NULL
     AND NEW.current_invoice_evidence_id IS DISTINCT FROM OLD.current_invoice_evidence_id THEN
    IF NEW.invoice_status NOT IN ('ISSUED', 'CORRECTED') THEN
      RAISE EXCEPTION 'current evidence can only change with a terminal invoice status'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_finance_requests_invoice_evidence_chain_check';
    END IF;
    SELECT evidence.* INTO STRICT previous_evidence
      FROM public.peakos_tax_invoice_evidence evidence
     WHERE evidence.workspace_id = OLD.workspace_id
       AND evidence.finance_request_id = OLD.id
       AND evidence.id = OLD.current_invoice_evidence_id;
    IF linked_evidence.supersedes_evidence_id IS DISTINCT FROM previous_evidence.id
       OR linked_evidence.revision <> previous_evidence.revision + 1 THEN
      RAISE EXCEPTION 'replacement evidence must extend the current append-only chain'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_finance_requests_invoice_evidence_chain_check';
    END IF;
  END IF;
  RETURN NEW;
END
$peakos_finance_request_invoice_evidence_guard$;

DROP TRIGGER IF EXISTS peakos_tax_invoice_evidence_validate_insert
  ON public.peakos_tax_invoice_evidence;
CREATE TRIGGER peakos_tax_invoice_evidence_validate_insert
  BEFORE INSERT ON public.peakos_tax_invoice_evidence
  FOR EACH ROW EXECUTE FUNCTION public.peakos_tax_invoice_evidence_validate_insert();
DROP TRIGGER IF EXISTS peakos_tax_invoice_evidence_audit_insert
  ON public.peakos_tax_invoice_evidence;
CREATE TRIGGER peakos_tax_invoice_evidence_audit_insert
  AFTER INSERT ON public.peakos_tax_invoice_evidence
  FOR EACH ROW EXECUTE FUNCTION public.peakos_tax_invoice_evidence_audit_insert();
DROP TRIGGER IF EXISTS peakos_tax_invoice_evidence_validate_commit
  ON public.peakos_tax_invoice_evidence;
CREATE CONSTRAINT TRIGGER peakos_tax_invoice_evidence_validate_commit
  AFTER INSERT ON public.peakos_tax_invoice_evidence
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.peakos_tax_invoice_evidence_validate_commit();
DROP TRIGGER IF EXISTS peakos_tax_invoice_evidence_no_mutation
  ON public.peakos_tax_invoice_evidence;
CREATE TRIGGER peakos_tax_invoice_evidence_no_mutation
  BEFORE UPDATE OR DELETE ON public.peakos_tax_invoice_evidence
  FOR EACH ROW EXECUTE FUNCTION public.peakos_tax_invoice_evidence_reject_mutation();
DROP TRIGGER IF EXISTS peakos_tax_invoice_evidence_no_truncate
  ON public.peakos_tax_invoice_evidence;
CREATE TRIGGER peakos_tax_invoice_evidence_no_truncate
  BEFORE TRUNCATE ON public.peakos_tax_invoice_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION public.peakos_tax_invoice_evidence_reject_mutation();
DROP TRIGGER IF EXISTS peakos_tax_invoice_evidence_audit_no_mutation
  ON public.peakos_tax_invoice_evidence_audit;
CREATE TRIGGER peakos_tax_invoice_evidence_audit_no_mutation
  BEFORE UPDATE OR DELETE ON public.peakos_tax_invoice_evidence_audit
  FOR EACH ROW EXECUTE FUNCTION public.peakos_tax_invoice_evidence_reject_mutation();
DROP TRIGGER IF EXISTS peakos_tax_invoice_evidence_audit_no_truncate
  ON public.peakos_tax_invoice_evidence_audit;
CREATE TRIGGER peakos_tax_invoice_evidence_audit_no_truncate
  BEFORE TRUNCATE ON public.peakos_tax_invoice_evidence_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.peakos_tax_invoice_evidence_reject_mutation();
DROP TRIGGER IF EXISTS peakos_finance_requests_invoice_evidence_guard
  ON public.peakos_finance_requests;
CREATE TRIGGER peakos_finance_requests_invoice_evidence_guard
  BEFORE INSERT OR UPDATE ON public.peakos_finance_requests
  FOR EACH ROW EXECUTE FUNCTION public.peakos_finance_request_invoice_evidence_guard();

DO $tax_invoice_evidence_acl$
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
    RAISE EXCEPTION 'set peakos.app_role before applying tax-invoice evidence migration';
  END IF;
  IF application_role = migration_owner THEN
    RAISE EXCEPTION 'tax-invoice evidence migration must run as an operator role, not the runtime role';
  END IF;

  EXECUTE format('ALTER TABLE public.peakos_tax_invoice_evidence OWNER TO %I', migration_owner);
  EXECUTE format('ALTER TABLE public.peakos_tax_invoice_evidence_audit OWNER TO %I', migration_owner);
  EXECUTE format('ALTER SEQUENCE public.peakos_tax_invoice_evidence_audit_id_seq OWNER TO %I', migration_owner);
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE public.peakos_tax_invoice_evidence, public.peakos_tax_invoice_evidence_audit FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON SEQUENCE public.peakos_tax_invoice_evidence_audit_id_seq FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE public.peakos_tax_invoice_evidence TO %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT ON TABLE public.peakos_tax_invoice_evidence_audit TO %I',
    application_role
  );

  FOREACH function_signature IN ARRAY ARRAY[
    'public.peakos_tax_invoice_evidence_reject_mutation()',
    'public.peakos_tax_invoice_evidence_validate_insert()',
    'public.peakos_tax_invoice_evidence_audit_insert()',
    'public.peakos_tax_invoice_evidence_validate_commit()',
    'public.peakos_finance_request_invoice_evidence_guard()'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', function_signature, migration_owner);
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, %I', function_signature, application_role);
  END LOOP;

  FOREACH privilege_name IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
  LOOP
    IF has_table_privilege(application_role, 'public.peakos_tax_invoice_evidence', privilege_name)
       OR has_table_privilege(application_role, 'public.peakos_tax_invoice_evidence_audit', privilege_name) THEN
      RAISE EXCEPTION 'runtime role % has unsafe tax-invoice evidence % privilege',
        application_role, privilege_name USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF has_table_privilege(application_role, 'public.peakos_tax_invoice_evidence_audit', 'INSERT') THEN
    RAISE EXCEPTION 'runtime role % can forge tax-invoice evidence audit', application_role
      USING ERRCODE = '55000';
  END IF;
END
$tax_invoice_evidence_acl$;

COMMIT;
