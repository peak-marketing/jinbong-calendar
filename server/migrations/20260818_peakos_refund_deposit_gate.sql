-- Refund completion must be backed by a canonical incoming bank transaction.
-- Apply after 20260817_peakos_bank_workspace_merge.sql. This migration is
-- intentionally operator-owned; the runtime role receives only the table
-- privileges used by the finance-request routes.

BEGIN;
SET LOCAL search_path = pg_catalog, public;

SELECT pg_advisory_xact_lock(hashtext('peakos-refund-deposit-gate-v1'));

DO $refund_gate_prerequisites$
BEGIN
  IF to_regclass('public.peakos_finance_requests') IS NULL
     OR to_regclass('public.peakos_finance_request_events') IS NULL
     OR to_regclass('public.peakos_bank_transactions') IS NULL
     OR to_regclass('public.peakos_bank_accounts') IS NULL
     OR to_regclass('public.peakos_workspaces') IS NULL THEN
    RAISE EXCEPTION 'refund deposit gate prerequisites are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class index_relation
      JOIN pg_namespace namespace ON namespace.oid = index_relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND index_relation.relname = 'peakos_bank_transactions_workspace_id_unique'
       AND index_relation.relkind = 'i'
  ) THEN
    RAISE EXCEPTION '20260817_peakos_bank_workspace_merge.sql must be applied first';
  END IF;
END
$refund_gate_prerequisites$;

ALTER TABLE public.peakos_finance_requests
  ADD COLUMN IF NOT EXISTS workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS refund_deposit_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_deposit_confirmed_by_uid TEXT,
  ADD COLUMN IF NOT EXISTS refund_deposit_confirmed_by_name TEXT;

ALTER TABLE public.peakos_finance_request_events
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;

UPDATE public.peakos_finance_requests
   SET workspace_id = 'ws_peak'
 WHERE workspace_id IS NULL;

UPDATE public.peakos_finance_request_events event
   SET workspace_id = request.workspace_id
  FROM public.peakos_finance_requests request
 WHERE event.request_id = request.id
   AND event.workspace_id IS NULL;

ALTER TABLE public.peakos_finance_requests
  ALTER COLUMN workspace_id DROP DEFAULT,
  ALTER COLUMN workspace_id SET NOT NULL,
  ALTER COLUMN version SET DEFAULT 1,
  ALTER COLUMN version SET NOT NULL;

ALTER TABLE public.peakos_finance_request_events
  ALTER COLUMN workspace_id DROP DEFAULT,
  ALTER COLUMN workspace_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS peakos_finance_requests_workspace_id_unique
  ON public.peakos_finance_requests(workspace_id, id);

CREATE INDEX IF NOT EXISTS peakos_finance_requests_workspace_date_idx
  ON public.peakos_finance_requests(workspace_id, request_date DESC, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS peakos_finance_request_events_workspace_request_idx
  ON public.peakos_finance_request_events(workspace_id, request_id, created_at, id);

DROP INDEX IF EXISTS public.peakos_finance_requests_requester_idempotency_idx;
CREATE UNIQUE INDEX IF NOT EXISTS peakos_finance_requests_workspace_requester_idempotency_idx
  ON public.peakos_finance_requests(workspace_id, requester_uid, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DROP INDEX IF EXISTS public.peakos_finance_requests_external_document_idx;
CREATE UNIQUE INDEX IF NOT EXISTS peakos_finance_requests_workspace_external_document_idx
  ON public.peakos_finance_requests(workspace_id, platform_key, external_document_id)
  WHERE platform_key IS NOT NULL AND external_document_id IS NOT NULL;

-- One canonical deposit can close one refund only. Supporting split deposits or
-- one deposit covering several refunds requires a separate allocation ledger;
-- silently reusing the same transaction would double-count received money.
CREATE UNIQUE INDEX IF NOT EXISTS peakos_finance_requests_refund_deposit_unique
  ON public.peakos_finance_requests(workspace_id, bank_transaction_id)
  WHERE kind IN ('REFUND_CLIENT', 'REFUND_MISTAKEN')
    AND status = 'COMPLETED'
    AND bank_transaction_id IS NOT NULL;

DO $refund_gate_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.peakos_finance_requests'::regclass
       AND conname = 'peakos_finance_requests_workspace_fk'
  ) THEN
    ALTER TABLE public.peakos_finance_requests
      ADD CONSTRAINT peakos_finance_requests_workspace_fk
      FOREIGN KEY (workspace_id) REFERENCES public.peakos_workspaces(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.peakos_finance_requests'::regclass
       AND conname = 'peakos_finance_requests_workspace_source_account_fk'
  ) THEN
    ALTER TABLE public.peakos_finance_requests
      ADD CONSTRAINT peakos_finance_requests_workspace_source_account_fk
      FOREIGN KEY (workspace_id, source_account_id)
      REFERENCES public.peakos_bank_accounts(workspace_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.peakos_finance_requests'::regclass
       AND conname = 'peakos_finance_requests_workspace_bank_transaction_fk'
  ) THEN
    ALTER TABLE public.peakos_finance_requests
      ADD CONSTRAINT peakos_finance_requests_workspace_bank_transaction_fk
      FOREIGN KEY (workspace_id, bank_transaction_id)
      REFERENCES public.peakos_bank_transactions(workspace_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.peakos_finance_request_events'::regclass
       AND conname = 'peakos_finance_request_events_workspace_request_fk'
  ) THEN
    ALTER TABLE public.peakos_finance_request_events
      ADD CONSTRAINT peakos_finance_request_events_workspace_request_fk
      FOREIGN KEY (workspace_id, request_id)
      REFERENCES public.peakos_finance_requests(workspace_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.peakos_finance_requests'::regclass
       AND conname = 'peakos_finance_requests_version_check'
  ) THEN
    ALTER TABLE public.peakos_finance_requests
      ADD CONSTRAINT peakos_finance_requests_version_check
      CHECK (version BETWEEN 1 AND 2147483647);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.peakos_finance_requests'::regclass
       AND conname = 'peakos_finance_requests_refund_deposit_confirmation_check'
  ) THEN
    ALTER TABLE public.peakos_finance_requests
      ADD CONSTRAINT peakos_finance_requests_refund_deposit_confirmation_check
      CHECK (
        (
          kind IN ('REFUND_CLIENT', 'REFUND_MISTAKEN')
          AND status = 'COMPLETED'
          AND bank_transaction_id IS NOT NULL
          AND refund_deposit_confirmed_at IS NOT NULL
          AND refund_deposit_confirmed_by_uid IS NOT NULL
          AND char_length(btrim(refund_deposit_confirmed_by_uid)) BETWEEN 1 AND 256
          AND refund_deposit_confirmed_by_name IS NOT NULL
          AND char_length(btrim(refund_deposit_confirmed_by_name)) BETWEEN 1 AND 120
        )
        OR
        (
          NOT (kind IN ('REFUND_CLIENT', 'REFUND_MISTAKEN') AND status = 'COMPLETED')
          AND refund_deposit_confirmed_at IS NULL
          AND refund_deposit_confirmed_by_uid IS NULL
          AND refund_deposit_confirmed_by_name IS NULL
        )
      );
  END IF;
END
$refund_gate_constraints$;

CREATE OR REPLACE FUNCTION public.peakos_finance_refund_deposit_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $refund_deposit_guard$
DECLARE
  linked_transaction public.peakos_bank_transactions%ROWTYPE;
BEGIN
  IF NEW.kind NOT IN ('REFUND_CLIENT', 'REFUND_MISTAKEN')
     OR NEW.status <> 'COMPLETED' THEN
    RETURN NEW;
  END IF;

  IF NEW.bank_transaction_id IS NULL
     OR NEW.refund_deposit_confirmed_at IS NULL
     OR NEW.refund_deposit_confirmed_by_uid IS NULL
     OR NEW.refund_deposit_confirmed_by_name IS NULL THEN
    RAISE EXCEPTION 'refund completion requires a confirmed deposit'
      USING ERRCODE = '23514';
  END IF;

  SELECT transaction.*
    INTO linked_transaction
    FROM public.peakos_bank_transactions transaction
   WHERE transaction.workspace_id = NEW.workspace_id
     AND transaction.id = NEW.bank_transaction_id
   FOR UPDATE;

  IF NOT FOUND
     OR linked_transaction.direction <> 'DEPOSIT'
     OR linked_transaction.source NOT IN ('BANK_SYNC', 'COLLECTOR')
     OR linked_transaction.reconciliation_status IN ('IGNORED', 'REVERSED')
     OR linked_transaction.amount < NEW.amount_vat
     OR (NEW.source_account_id IS NOT NULL
         AND linked_transaction.account_id <> NEW.source_account_id) THEN
    RAISE EXCEPTION 'linked bank transaction is not a verified refund deposit'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$refund_deposit_guard$;

-- Preserve the invariant after a refund has completed. A bank sync or direct
-- SQL update must not later turn the linked row into a withdrawal, an
-- unverified source, a reversed/ignored entry, an insufficient amount, or a
-- different workspace/account. The UPDATE row lock serializes with the
-- finance-side SELECT ... FOR UPDATE above.
CREATE OR REPLACE FUNCTION public.peakos_bank_refund_link_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $bank_refund_link_guard$
DECLARE
  invalid_linked_refund_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT request.id
      INTO invalid_linked_refund_id
      FROM public.peakos_finance_requests request
     WHERE request.workspace_id = OLD.workspace_id
       AND request.bank_transaction_id = OLD.id
       AND request.kind IN ('REFUND_CLIENT', 'REFUND_MISTAKEN')
       AND request.status = 'COMPLETED'
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'bank transaction linked to a completed refund cannot be deleted'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_bank_transactions_refund_link_guard';
    END IF;
    RETURN OLD;
  END IF;

  SELECT request.id
    INTO invalid_linked_refund_id
    FROM public.peakos_finance_requests request
   WHERE request.workspace_id = OLD.workspace_id
     AND request.bank_transaction_id = OLD.id
     AND request.kind IN ('REFUND_CLIENT', 'REFUND_MISTAKEN')
     AND request.status = 'COMPLETED'
     AND (
       NEW.workspace_id IS DISTINCT FROM request.workspace_id
       OR NEW.id IS DISTINCT FROM request.bank_transaction_id
       OR NEW.direction IS DISTINCT FROM 'DEPOSIT'
       OR NEW.source IS NULL
       OR NEW.source NOT IN ('BANK_SYNC', 'COLLECTOR')
       OR NEW.reconciliation_status IS NULL
       OR NEW.reconciliation_status IN ('IGNORED', 'REVERSED')
       OR NEW.amount IS NULL
       OR NEW.amount < request.amount_vat
       OR (request.source_account_id IS NOT NULL
           AND NEW.account_id IS DISTINCT FROM request.source_account_id)
     )
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'bank transaction linked to a completed refund must remain a verified deposit'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_bank_transactions_refund_link_guard';
  END IF;
  RETURN NEW;
END
$bank_refund_link_guard$;

DROP TRIGGER IF EXISTS peakos_finance_requests_refund_deposit_guard
  ON public.peakos_finance_requests;
CREATE TRIGGER peakos_finance_requests_refund_deposit_guard
  BEFORE INSERT OR UPDATE ON public.peakos_finance_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.peakos_finance_refund_deposit_guard();

DROP TRIGGER IF EXISTS peakos_bank_transactions_refund_link_guard
  ON public.peakos_bank_transactions;
CREATE TRIGGER peakos_bank_transactions_refund_link_guard
  BEFORE UPDATE OR DELETE ON public.peakos_bank_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.peakos_bank_refund_link_guard();

DO $refund_gate_acl$
DECLARE
  configured_role TEXT := NULLIF(current_setting('peakos.app_role', TRUE), '');
  application_role TEXT;
  migration_owner TEXT := current_user;
BEGIN
  IF configured_role IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = configured_role) THEN
      RAISE EXCEPTION 'configured peakos.app_role does not exist';
    END IF;
    application_role := configured_role;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
    application_role := 'calendar_user';
  ELSE
    RAISE EXCEPTION 'set peakos.app_role before applying refund deposit gate migration';
  END IF;

  IF application_role = migration_owner THEN
    RAISE EXCEPTION 'refund deposit gate migration must run as an operator role, not the runtime role';
  END IF;

  EXECUTE format('ALTER TABLE public.peakos_finance_requests OWNER TO %I', migration_owner);
  EXECUTE format('ALTER TABLE public.peakos_finance_request_events OWNER TO %I', migration_owner);
  EXECUTE format('ALTER SEQUENCE public.peakos_finance_request_events_id_seq OWNER TO %I', migration_owner);
  EXECUTE format('ALTER FUNCTION public.peakos_finance_refund_deposit_guard() OWNER TO %I', migration_owner);
  EXECUTE format('ALTER FUNCTION public.peakos_bank_refund_link_guard() OWNER TO %I', migration_owner);

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE public.peakos_finance_requests FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE public.peakos_finance_request_events FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON SEQUENCE public.peakos_finance_request_events_id_seq FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON FUNCTION public.peakos_finance_refund_deposit_guard() FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON FUNCTION public.peakos_bank_refund_link_guard() FROM PUBLIC, %I',
    application_role
  );

  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE ON TABLE public.peakos_finance_requests TO %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE public.peakos_finance_request_events TO %I',
    application_role
  );
  EXECUTE format(
    'GRANT USAGE ON SEQUENCE public.peakos_finance_request_events_id_seq TO %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT ON TABLE public.peakos_bank_transactions, public.peakos_bank_accounts, public.peakos_workspaces TO %I',
    application_role
  );
END
$refund_gate_acl$;

COMMIT;
