-- Server-authoritative supplier quantity/cost reconciliation.
--
-- This migration only creates an evidence ledger and guards settled intake
-- rows. It never calls a bank, initiates a transfer, or backfills a completed
-- supplier payment. Apply as an operator after the workspace and settlement
-- import migrations.

BEGIN;
SET LOCAL search_path = public, pg_catalog;

SELECT pg_advisory_xact_lock(hashtext('peakos-vendor-reconciliation-v1'));

DO $vendor_reconciliation_prerequisites$
BEGIN
  IF to_regclass('public.peakos_workspaces') IS NULL
     OR to_regclass('public.peakos_intake') IS NULL
     OR to_regclass('public.peakos_intake_audit_log') IS NULL
     OR to_regclass('public.peakos_workspace_memberships') IS NULL THEN
    RAISE EXCEPTION
      'workspace and settlement import migrations must be applied before vendor reconciliation'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.peakos_intake'::regclass
       AND attname = 'row_version' AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'peakos_intake.row_version is required before vendor reconciliation'
      USING ERRCODE = '55000';
  END IF;
END
$vendor_reconciliation_prerequisites$;

-- Workspace migrations already define a NULL workspace as legacy Peak data.
-- Materialize that meaning so every evidence FK is a strict tenant FK.
UPDATE public.peakos_intake SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL;
ALTER TABLE public.peakos_intake ALTER COLUMN workspace_id SET NOT NULL;

DO $vendor_reconciliation_source_key$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.peakos_intake'::regclass
       AND conname = 'peakos_intake_workspace_source_unique'
  ) THEN
    ALTER TABLE public.peakos_intake
      ADD CONSTRAINT peakos_intake_workspace_source_unique
      UNIQUE (workspace_id, id);
  END IF;
END
$vendor_reconciliation_source_key$;

CREATE TABLE IF NOT EXISTS public.peakos_vendor_settlement_batches (
  id UUID NOT NULL,
  workspace_id TEXT NOT NULL,
  idempotency_key UUID NOT NULL,
  request_digest TEXT NOT NULL,
  supplier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  row_version BIGINT NOT NULL DEFAULT 1,
  item_count INTEGER NOT NULL,
  delivered_qty NUMERIC(20,0) NOT NULL,
  settled_qty NUMERIC(20,0) NOT NULL,
  total_due NUMERIC(20,0) NOT NULL,
  bank_label TEXT NOT NULL,
  paid_date DATE NOT NULL,
  memo TEXT NOT NULL,
  completed_by_uid TEXT NOT NULL,
  completed_by_name TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT peakos_vendor_settlement_batches_pkey
    PRIMARY KEY (id),
  CONSTRAINT peakos_vendor_settlement_batches_workspace_id_unique
    UNIQUE (workspace_id, id),
  CONSTRAINT peakos_vendor_settlement_batches_idempotency_unique
    UNIQUE (workspace_id, completed_by_uid, idempotency_key),
  CONSTRAINT peakos_vendor_settlement_batches_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.peakos_workspaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_vendor_settlement_batches_status_check
    CHECK (status = 'COMPLETED'),
  CONSTRAINT peakos_vendor_settlement_batches_version_check
    CHECK (row_version = 1),
  CONSTRAINT peakos_vendor_settlement_batches_count_check
    CHECK (item_count BETWEEN 1 AND 500),
  CONSTRAINT peakos_vendor_settlement_batches_quantity_check
    CHECK (delivered_qty > 0 AND settled_qty > 0 AND delivered_qty = settled_qty),
  CONSTRAINT peakos_vendor_settlement_batches_due_check
    CHECK (total_due > 0),
  CONSTRAINT peakos_vendor_settlement_batches_digest_check
    CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_vendor_settlement_batches_text_check
    CHECK (
      char_length(btrim(supplier)) BETWEEN 1 AND 120
      AND char_length(btrim(bank_label)) BETWEEN 1 AND 80
      AND char_length(btrim(memo)) BETWEEN 8 AND 500
      AND char_length(btrim(completed_by_uid)) BETWEEN 1 AND 256
      AND char_length(btrim(completed_by_name)) BETWEEN 1 AND 160
    ),
  CONSTRAINT peakos_vendor_settlement_batches_time_check
    CHECK (created_at = completed_at)
);

CREATE TABLE IF NOT EXISTS public.peakos_vendor_settlement_items (
  workspace_id TEXT NOT NULL,
  batch_id UUID NOT NULL,
  source_intake_id TEXT NOT NULL,
  item_ordinal INTEGER NOT NULL,
  source_expected_row_version BIGINT NOT NULL,
  source_settled_row_version BIGINT NOT NULL,
  source_kind TEXT NOT NULL,
  resolved_supplier TEXT NOT NULL,
  semantic_qty NUMERIC(20,0) NOT NULL,
  cost_per_unit NUMERIC(20,0) NOT NULL,
  due_amount NUMERIC(20,0) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT peakos_vendor_settlement_items_pkey
    PRIMARY KEY (workspace_id, batch_id, source_intake_id),
  CONSTRAINT peakos_vendor_settlement_items_source_unique
    UNIQUE (workspace_id, source_intake_id),
  CONSTRAINT peakos_vendor_settlement_items_ordinal_unique
    UNIQUE (workspace_id, batch_id, item_ordinal),
  CONSTRAINT peakos_vendor_settlement_items_batch_fk
    FOREIGN KEY (workspace_id, batch_id)
    REFERENCES public.peakos_vendor_settlement_batches(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_vendor_settlement_items_source_fk
    FOREIGN KEY (workspace_id, source_intake_id)
    REFERENCES public.peakos_intake(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_vendor_settlement_items_ordinal_check
    CHECK (item_ordinal BETWEEN 1 AND 500),
  CONSTRAINT peakos_vendor_settlement_items_version_check
    CHECK (
      source_expected_row_version >= 1
      AND source_settled_row_version = source_expected_row_version + 1
    ),
  CONSTRAINT peakos_vendor_settlement_items_source_kind_check
    CHECK (source_kind IN ('normal', 'use')),
  CONSTRAINT peakos_vendor_settlement_items_supplier_check
    CHECK (char_length(btrim(resolved_supplier)) BETWEEN 1 AND 120),
  CONSTRAINT peakos_vendor_settlement_items_math_check
    CHECK (
      semantic_qty > 0
      AND cost_per_unit > 0
      AND due_amount > 0
      AND due_amount = semantic_qty * cost_per_unit
    )
);

CREATE TABLE IF NOT EXISTS public.peakos_vendor_settlement_audit (
  id BIGSERIAL NOT NULL,
  workspace_id TEXT NOT NULL,
  batch_id UUID NOT NULL,
  source_intake_id TEXT,
  action TEXT NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT peakos_vendor_settlement_audit_pkey PRIMARY KEY (id),
  CONSTRAINT peakos_vendor_settlement_audit_batch_fk
    FOREIGN KEY (workspace_id, batch_id)
    REFERENCES public.peakos_vendor_settlement_batches(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_vendor_settlement_audit_action_check
    CHECK (action IN ('BATCH_COMPLETED', 'SOURCE_RECONCILED')),
  CONSTRAINT peakos_vendor_settlement_audit_source_shape_check
    CHECK (
      (action = 'BATCH_COMPLETED' AND source_intake_id IS NULL)
      OR (action = 'SOURCE_RECONCILED' AND source_intake_id IS NOT NULL)
    ),
  CONSTRAINT peakos_vendor_settlement_audit_actor_check
    CHECK (
      char_length(btrim(actor_uid)) BETWEEN 1 AND 256
      AND char_length(btrim(actor_name)) BETWEEN 1 AND 160
    )
);

CREATE INDEX IF NOT EXISTS peakos_vendor_settlement_batches_workspace_date_idx
  ON public.peakos_vendor_settlement_batches
    (workspace_id, paid_date DESC, completed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS peakos_vendor_settlement_batches_supplier_idx
  ON public.peakos_vendor_settlement_batches
    (workspace_id, supplier, completed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS peakos_vendor_settlement_items_batch_idx
  ON public.peakos_vendor_settlement_items
    (workspace_id, batch_id, item_ordinal);
CREATE INDEX IF NOT EXISTS peakos_vendor_settlement_audit_batch_idx
  ON public.peakos_vendor_settlement_audit
    (workspace_id, batch_id, id);

CREATE OR REPLACE FUNCTION public.peakos_vendor_reconciliation_reject_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $vendor_reconciliation_reject_mutation$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000',
          CONSTRAINT = 'peakos_vendor_reconciliation_append_only';
END
$vendor_reconciliation_reject_mutation$;

CREATE OR REPLACE FUNCTION public.peakos_vendor_reconciliation_audit_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $vendor_reconciliation_audit_insert$
DECLARE
  linked_batch public.peakos_vendor_settlement_batches%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'peakos_vendor_settlement_batches' THEN
    INSERT INTO public.peakos_vendor_settlement_audit
      (workspace_id, batch_id, source_intake_id, action, actor_uid, actor_name,
       state, created_at)
    VALUES
      (NEW.workspace_id, NEW.id, NULL, 'BATCH_COMPLETED', NEW.completed_by_uid,
       NEW.completed_by_name,
       jsonb_build_object(
         'supplier', NEW.supplier,
         'itemCount', NEW.item_count,
         'deliveredQty', NEW.delivered_qty,
         'settledQty', NEW.settled_qty,
         'totalDue', NEW.total_due,
         'bankLabel', NEW.bank_label,
         'paidDate', NEW.paid_date,
         'memo', NEW.memo,
         'rowVersion', NEW.row_version
       ),
       NEW.completed_at);
    RETURN NEW;
  END IF;

  SELECT batch.* INTO STRICT linked_batch
    FROM public.peakos_vendor_settlement_batches batch
   WHERE batch.workspace_id = NEW.workspace_id AND batch.id = NEW.batch_id;
  INSERT INTO public.peakos_vendor_settlement_audit
    (workspace_id, batch_id, source_intake_id, action, actor_uid, actor_name,
     state, created_at)
  VALUES
    (NEW.workspace_id, NEW.batch_id, NEW.source_intake_id, 'SOURCE_RECONCILED',
     linked_batch.completed_by_uid, linked_batch.completed_by_name,
     jsonb_build_object(
       'sourceExpectedRowVersion', NEW.source_expected_row_version,
       'sourceSettledRowVersion', NEW.source_settled_row_version,
       'sourceKind', NEW.source_kind,
       'resolvedSupplier', NEW.resolved_supplier,
       'semanticQty', NEW.semantic_qty,
       'costPerUnit', NEW.cost_per_unit,
       'dueAmount', NEW.due_amount
     ),
     NEW.created_at);
  RETURN NEW;
END
$vendor_reconciliation_audit_insert$;

CREATE OR REPLACE FUNCTION public.peakos_vendor_reconciliation_validate_batch()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $vendor_reconciliation_validate_batch$
DECLARE
  target_workspace TEXT;
  target_batch UUID;
  batch public.peakos_vendor_settlement_batches%ROWTYPE;
  actual_count BIGINT;
  actual_qty NUMERIC;
  actual_due NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'peakos_vendor_settlement_batches' THEN
    target_workspace := NEW.workspace_id;
    target_batch := NEW.id;
  ELSE
    target_workspace := NEW.workspace_id;
    target_batch := NEW.batch_id;
  END IF;

  SELECT value.* INTO STRICT batch
    FROM public.peakos_vendor_settlement_batches value
   WHERE value.workspace_id = target_workspace AND value.id = target_batch;

  SELECT COUNT(*), COALESCE(SUM(item.semantic_qty), 0),
         COALESCE(SUM(item.due_amount), 0)
    INTO actual_count, actual_qty, actual_due
    FROM public.peakos_vendor_settlement_items item
   WHERE item.workspace_id = target_workspace AND item.batch_id = target_batch;

  IF actual_count <> batch.item_count
     OR actual_qty <> batch.settled_qty
     OR actual_qty <> batch.delivered_qty
     OR actual_due <> batch.total_due THEN
    RAISE EXCEPTION 'vendor reconciliation batch totals do not match its items'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_vendor_reconciliation_batch_totals_check';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.peakos_vendor_settlement_items item
      JOIN public.peakos_intake source
        ON source.workspace_id = item.workspace_id
       AND source.id = item.source_intake_id
     WHERE item.workspace_id = target_workspace
       AND item.batch_id = target_batch
       AND (
         item.resolved_supplier IS DISTINCT FROM batch.supplier
         OR source.kind IS DISTINCT FROM item.source_kind
         OR source.kind NOT IN ('normal', 'use')
         OR source.qty IS DISTINCT FROM item.semantic_qty
         OR source.cost IS DISTINCT FROM item.cost_per_unit
         OR item.due_amount IS DISTINCT FROM item.semantic_qty * item.cost_per_unit
         OR source.vendor_paid IS DISTINCT FROM TRUE
         OR source.vendor_paid_amount IS DISTINCT FROM item.due_amount
         OR source.vendor_paid_date IS DISTINCT FROM batch.paid_date::TEXT
         OR source.vendor_bank IS DISTINCT FROM batch.bank_label
         OR source.vendor_by IS DISTINCT FROM batch.completed_by_name
         OR source.vendor_memo IS DISTINCT FROM batch.memo
         OR source.row_version IS DISTINCT FROM item.source_settled_row_version
       )
  ) THEN
    RAISE EXCEPTION 'vendor reconciliation source snapshot does not match the settled intake row'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_vendor_reconciliation_source_snapshot_check';
  END IF;

  RETURN NEW;
END
$vendor_reconciliation_validate_batch$;

CREATE OR REPLACE FUNCTION public.peakos_vendor_reconciliation_guard_intake()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $vendor_reconciliation_guard_intake$
DECLARE
  linked_item public.peakos_vendor_settlement_items%ROWTYPE;
  linked_batch public.peakos_vendor_settlement_batches%ROWTYPE;
BEGIN
  SELECT item.* INTO linked_item
    FROM public.peakos_vendor_settlement_items item
   WHERE item.workspace_id = OLD.workspace_id AND item.source_intake_id = OLD.id
   FOR KEY SHARE;

  IF NOT FOUND THEN
    IF TG_OP = 'UPDATE' AND (
      NEW.vendor_paid IS DISTINCT FROM OLD.vendor_paid
      OR NEW.vendor_paid_amount IS DISTINCT FROM OLD.vendor_paid_amount
      OR NEW.vendor_paid_date IS DISTINCT FROM OLD.vendor_paid_date
      OR NEW.vendor_bank IS DISTINCT FROM OLD.vendor_bank
      OR NEW.vendor_by IS DISTINCT FROM OLD.vendor_by
      OR NEW.vendor_memo IS DISTINCT FROM OLD.vendor_memo
    ) THEN
      RAISE EXCEPTION 'supplier payment requires a reconciliation batch'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_intake_vendor_batch_required';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT batch.* INTO STRICT linked_batch
    FROM public.peakos_vendor_settlement_batches batch
   WHERE batch.workspace_id = linked_item.workspace_id
     AND batch.id = linked_item.batch_id
   FOR KEY SHARE;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reconciled intake rows cannot be deleted'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_intake_vendor_reconciliation_lock';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.a IS DISTINCT FROM OLD.a
     OR NEW.b IS DISTINCT FROM OLD.b
     OR NEW.c IS DISTINCT FROM OLD.c
     OR NEW.supplier IS DISTINCT FROM OLD.supplier
     OR NEW.qty IS DISTINCT FROM OLD.qty
     OR NEW.cost IS DISTINCT FROM OLD.cost THEN
    RAISE EXCEPTION 'reconciled intake quantity/cost identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_intake_vendor_reconciliation_lock';
  END IF;

  IF OLD.vendor_paid IS DISTINCT FROM TRUE THEN
    IF NEW.vendor_paid IS DISTINCT FROM TRUE
       OR NEW.vendor_paid_amount IS DISTINCT FROM linked_item.due_amount
       OR NEW.vendor_paid_date IS DISTINCT FROM linked_batch.paid_date::TEXT
       OR NEW.vendor_bank IS DISTINCT FROM linked_batch.bank_label
       OR NEW.vendor_by IS DISTINCT FROM linked_batch.completed_by_name
       OR NEW.vendor_memo IS DISTINCT FROM linked_batch.memo
       OR NEW.row_version IS DISTINCT FROM OLD.row_version + 1
       OR NEW.row_version IS DISTINCT FROM linked_item.source_settled_row_version THEN
      RAISE EXCEPTION 'intake supplier evidence does not match its reconciliation batch'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_intake_vendor_reconciliation_evidence_check';
    END IF;
  ELSIF NEW.vendor_paid IS DISTINCT FROM OLD.vendor_paid
     OR NEW.vendor_paid_amount IS DISTINCT FROM OLD.vendor_paid_amount
     OR NEW.vendor_paid_date IS DISTINCT FROM OLD.vendor_paid_date
     OR NEW.vendor_bank IS DISTINCT FROM OLD.vendor_bank
     OR NEW.vendor_by IS DISTINCT FROM OLD.vendor_by
     OR NEW.vendor_memo IS DISTINCT FROM OLD.vendor_memo THEN
    RAISE EXCEPTION 'reconciled supplier evidence is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_intake_vendor_reconciliation_evidence_check';
  END IF;
  RETURN NEW;
END
$vendor_reconciliation_guard_intake$;

DROP TRIGGER IF EXISTS peakos_vendor_settlement_batches_no_mutation
  ON public.peakos_vendor_settlement_batches;
CREATE TRIGGER peakos_vendor_settlement_batches_no_mutation
  BEFORE UPDATE OR DELETE ON public.peakos_vendor_settlement_batches
  FOR EACH ROW EXECUTE FUNCTION public.peakos_vendor_reconciliation_reject_mutation();
DROP TRIGGER IF EXISTS peakos_vendor_settlement_batches_no_truncate
  ON public.peakos_vendor_settlement_batches;
CREATE TRIGGER peakos_vendor_settlement_batches_no_truncate
  BEFORE TRUNCATE ON public.peakos_vendor_settlement_batches
  FOR EACH STATEMENT EXECUTE FUNCTION public.peakos_vendor_reconciliation_reject_mutation();
DROP TRIGGER IF EXISTS peakos_vendor_settlement_items_no_mutation
  ON public.peakos_vendor_settlement_items;
CREATE TRIGGER peakos_vendor_settlement_items_no_mutation
  BEFORE UPDATE OR DELETE ON public.peakos_vendor_settlement_items
  FOR EACH ROW EXECUTE FUNCTION public.peakos_vendor_reconciliation_reject_mutation();
DROP TRIGGER IF EXISTS peakos_vendor_settlement_items_no_truncate
  ON public.peakos_vendor_settlement_items;
CREATE TRIGGER peakos_vendor_settlement_items_no_truncate
  BEFORE TRUNCATE ON public.peakos_vendor_settlement_items
  FOR EACH STATEMENT EXECUTE FUNCTION public.peakos_vendor_reconciliation_reject_mutation();
DROP TRIGGER IF EXISTS peakos_vendor_settlement_audit_no_mutation
  ON public.peakos_vendor_settlement_audit;
CREATE TRIGGER peakos_vendor_settlement_audit_no_mutation
  BEFORE UPDATE OR DELETE ON public.peakos_vendor_settlement_audit
  FOR EACH ROW EXECUTE FUNCTION public.peakos_vendor_reconciliation_reject_mutation();
DROP TRIGGER IF EXISTS peakos_vendor_settlement_audit_no_truncate
  ON public.peakos_vendor_settlement_audit;
CREATE TRIGGER peakos_vendor_settlement_audit_no_truncate
  BEFORE TRUNCATE ON public.peakos_vendor_settlement_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.peakos_vendor_reconciliation_reject_mutation();

DROP TRIGGER IF EXISTS peakos_vendor_settlement_batches_audit
  ON public.peakos_vendor_settlement_batches;
CREATE TRIGGER peakos_vendor_settlement_batches_audit
  AFTER INSERT ON public.peakos_vendor_settlement_batches
  FOR EACH ROW EXECUTE FUNCTION public.peakos_vendor_reconciliation_audit_insert();
DROP TRIGGER IF EXISTS peakos_vendor_settlement_items_audit
  ON public.peakos_vendor_settlement_items;
CREATE TRIGGER peakos_vendor_settlement_items_audit
  AFTER INSERT ON public.peakos_vendor_settlement_items
  FOR EACH ROW EXECUTE FUNCTION public.peakos_vendor_reconciliation_audit_insert();

DROP TRIGGER IF EXISTS peakos_vendor_settlement_batches_validate
  ON public.peakos_vendor_settlement_batches;
CREATE CONSTRAINT TRIGGER peakos_vendor_settlement_batches_validate
  AFTER INSERT ON public.peakos_vendor_settlement_batches
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.peakos_vendor_reconciliation_validate_batch();
DROP TRIGGER IF EXISTS peakos_vendor_settlement_items_validate
  ON public.peakos_vendor_settlement_items;
CREATE CONSTRAINT TRIGGER peakos_vendor_settlement_items_validate
  AFTER INSERT ON public.peakos_vendor_settlement_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.peakos_vendor_reconciliation_validate_batch();

DROP TRIGGER IF EXISTS peakos_intake_vendor_reconciliation_guard
  ON public.peakos_intake;
CREATE TRIGGER peakos_intake_vendor_reconciliation_guard
  BEFORE UPDATE OR DELETE ON public.peakos_intake
  FOR EACH ROW EXECUTE FUNCTION public.peakos_vendor_reconciliation_guard_intake();

DO $vendor_reconciliation_acl$
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
    RAISE EXCEPTION 'set peakos.app_role before applying vendor reconciliation migration';
  END IF;
  IF application_role = migration_owner THEN
    RAISE EXCEPTION 'vendor reconciliation migration must run as an operator role, not the runtime role';
  END IF;

  EXECUTE format('ALTER TABLE public.peakos_vendor_settlement_batches OWNER TO %I', migration_owner);
  EXECUTE format('ALTER TABLE public.peakos_vendor_settlement_items OWNER TO %I', migration_owner);
  EXECUTE format('ALTER TABLE public.peakos_vendor_settlement_audit OWNER TO %I', migration_owner);
  EXECUTE format('ALTER SEQUENCE public.peakos_vendor_settlement_audit_id_seq OWNER TO %I', migration_owner);

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE public.peakos_vendor_settlement_batches, public.peakos_vendor_settlement_items, public.peakos_vendor_settlement_audit FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON SEQUENCE public.peakos_vendor_settlement_audit_id_seq FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE public.peakos_vendor_settlement_batches, public.peakos_vendor_settlement_items TO %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT ON TABLE public.peakos_vendor_settlement_audit TO %I',
    application_role
  );

  FOREACH function_signature IN ARRAY ARRAY[
    'public.peakos_vendor_reconciliation_reject_mutation()',
    'public.peakos_vendor_reconciliation_audit_insert()',
    'public.peakos_vendor_reconciliation_validate_batch()',
    'public.peakos_vendor_reconciliation_guard_intake()'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', function_signature, migration_owner);
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, %I', function_signature, application_role);
  END LOOP;

  FOREACH privilege_name IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
  LOOP
    IF has_table_privilege(application_role, 'public.peakos_vendor_settlement_batches', privilege_name)
       OR has_table_privilege(application_role, 'public.peakos_vendor_settlement_items', privilege_name)
       OR has_table_privilege(application_role, 'public.peakos_vendor_settlement_audit', privilege_name) THEN
      RAISE EXCEPTION 'runtime role % has unsafe vendor reconciliation % privilege',
        application_role, privilege_name USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF has_table_privilege(application_role, 'public.peakos_vendor_settlement_audit', 'INSERT') THEN
    RAISE EXCEPTION 'runtime role % can forge vendor reconciliation audit', application_role
      USING ERRCODE = '55000';
  END IF;
END
$vendor_reconciliation_acl$;

COMMIT;
