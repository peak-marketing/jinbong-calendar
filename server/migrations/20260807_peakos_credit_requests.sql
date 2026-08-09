-- Pending credit-charge requests and their exact bank-transaction approval.
-- Run after 20260806_peakos_banking.sql and after peakos_credit exists.

-- The server sends this file as one PostgreSQL query message, so the
-- transaction-scoped lock serializes concurrent first boots and is released on
-- either success or failure.
SELECT pg_advisory_xact_lock(hashtext('peakos-credit-requests-migration'));

CREATE TABLE IF NOT EXISTS peakos_credit_requests (
  id TEXT PRIMARY KEY,
  requester_uid TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  target_account_id TEXT NOT NULL
    REFERENCES peakos_bank_accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  request_date DATE NOT NULL,
  client TEXT NOT NULL,
  depositor_name TEXT NOT NULL,
  product TEXT NOT NULL,
  vendor TEXT NOT NULL,
  expected_amount BIGINT NOT NULL,
  point_amount BIGINT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  bank_transaction_id BIGINT UNIQUE
    REFERENCES peakos_bank_transactions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  idempotency_key TEXT,
  approved_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_credit_requests_id_length_check
    CHECK (char_length(id) BETWEEN 1 AND 80),
  CONSTRAINT peakos_credit_requests_requester_uid_length_check
    CHECK (char_length(requester_uid) BETWEEN 1 AND 256),
  CONSTRAINT peakos_credit_requests_requester_name_length_check
    CHECK (char_length(requester_name) BETWEEN 1 AND 120),
  CONSTRAINT peakos_credit_requests_account_check
    CHECK (target_account_id IN ('ibk-review-space', 'ibk-reward-space')),
  CONSTRAINT peakos_credit_requests_client_length_check
    CHECK (char_length(client) BETWEEN 1 AND 200),
  CONSTRAINT peakos_credit_requests_depositor_length_check
    CHECK (char_length(depositor_name) BETWEEN 1 AND 160),
  CONSTRAINT peakos_credit_requests_product_length_check
    CHECK (char_length(product) BETWEEN 1 AND 120),
  CONSTRAINT peakos_credit_requests_vendor_length_check
    CHECK (char_length(vendor) BETWEEN 1 AND 120),
  CONSTRAINT peakos_credit_requests_memo_length_check
    CHECK (char_length(memo) <= 500),
  CONSTRAINT peakos_credit_requests_expected_amount_check
    CHECK (expected_amount > 0),
  CONSTRAINT peakos_credit_requests_point_amount_check
    CHECK (point_amount > 0),
  CONSTRAINT peakos_credit_requests_status_check
    CHECK (status IN ('PENDING', 'APPROVED', 'CANCELLED')),
  CONSTRAINT peakos_credit_requests_idempotency_key_length_check
    CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 120),
  CONSTRAINT peakos_credit_requests_state_check CHECK (
    (status = 'PENDING'
      AND bank_transaction_id IS NULL
      AND approved_at IS NULL
      AND cancelled_at IS NULL)
    OR
    (status = 'APPROVED'
      AND bank_transaction_id IS NOT NULL
      AND approved_at IS NOT NULL
      AND cancelled_at IS NULL)
    OR
    (status = 'CANCELLED'
      AND bank_transaction_id IS NULL
      AND approved_at IS NULL
      AND cancelled_at IS NOT NULL)
  )
);

-- A retried POST carrying the same per-user key returns the original request.
CREATE UNIQUE INDEX IF NOT EXISTS peakos_credit_requests_requester_idempotency_idx
  ON peakos_credit_requests(requester_uid, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS peakos_credit_requests_requester_created_idx
  ON peakos_credit_requests(requester_uid, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS peakos_credit_requests_exact_candidate_idx
  ON peakos_credit_requests(target_account_id, status, expected_amount, created_at, id)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS peakos_credit_requests_status_created_idx
  ON peakos_credit_requests(status, created_at DESC, id DESC);

-- Existing APPROVED rows must already satisfy the cross-table invariant. A
-- restore containing a mismatched historical approval stops here instead of
-- silently teaching the application that the bank transaction was matched.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM peakos_credit_requests request
      LEFT JOIN peakos_bank_transactions bank_tx
        ON bank_tx.id = request.bank_transaction_id
     WHERE request.status = 'APPROVED'
       AND (
         bank_tx.id IS NULL
         OR bank_tx.account_id IS DISTINCT FROM request.target_account_id
         OR bank_tx.direction IS DISTINCT FROM 'DEPOSIT'
         OR bank_tx.amount IS DISTINCT FROM request.expected_amount
       )
  ) THEN
    RAISE EXCEPTION 'Existing approved credit request does not match its bank transaction.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_credit_requests_bank_match_guard';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION peakos_validate_credit_request_bank_match()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  matched_account_id TEXT;
  matched_direction TEXT;
  matched_amount BIGINT;
BEGIN
  IF NEW.status <> 'APPROVED' THEN
    RETURN NEW;
  END IF;

  SELECT bank_tx.account_id, bank_tx.direction, bank_tx.amount
    INTO matched_account_id, matched_direction, matched_amount
    FROM peakos_bank_transactions bank_tx
   WHERE bank_tx.id = NEW.bank_transaction_id
   FOR SHARE;

  IF NOT FOUND
      OR matched_account_id IS DISTINCT FROM NEW.target_account_id
      OR matched_direction IS DISTINCT FROM 'DEPOSIT'
      OR matched_amount IS DISTINCT FROM NEW.expected_amount THEN
    RAISE EXCEPTION 'Approved credit request must match bank account, deposit direction, and amount.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_credit_requests_bank_match_guard';
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'peakos_credit_requests'::regclass
       AND tgname = 'peakos_credit_requests_bank_match_guard_trg'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER peakos_credit_requests_bank_match_guard_trg
      BEFORE INSERT OR UPDATE ON peakos_credit_requests
      FOR EACH ROW
      EXECUTE FUNCTION peakos_validate_credit_request_bank_match();
  END IF;
END
$$;

-- Keep the invariant true after approval as well. Normal bank ingestion never
-- updates these identity fields; this guard blocks direct SQL from rewriting a
-- linked deposit into a different account, direction, or amount.
CREATE OR REPLACE FUNCTION peakos_protect_approved_credit_bank_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  linked_request_id TEXT;
  linked_account_id TEXT;
  linked_expected_amount BIGINT;
BEGIN
  IF NEW.account_id IS NOT DISTINCT FROM OLD.account_id
      AND NEW.direction IS NOT DISTINCT FROM OLD.direction
      AND NEW.amount IS NOT DISTINCT FROM OLD.amount THEN
    RETURN NEW;
  END IF;

  SELECT request.id, request.target_account_id, request.expected_amount
    INTO linked_request_id, linked_account_id, linked_expected_amount
    FROM peakos_credit_requests request
   WHERE request.bank_transaction_id = OLD.id
     AND request.status = 'APPROVED'
   LIMIT 1
   FOR SHARE;

  IF FOUND AND (
    NEW.account_id IS DISTINCT FROM linked_account_id
    OR NEW.direction IS DISTINCT FROM 'DEPOSIT'
    OR NEW.amount IS DISTINCT FROM linked_expected_amount
  ) THEN
    RAISE EXCEPTION 'Bank transaction linked to an approved credit request is immutable.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_credit_requests_bank_match_guard';
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'peakos_bank_transactions'::regclass
       AND tgname = 'peakos_bank_transactions_credit_match_guard_trg'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER peakos_bank_transactions_credit_match_guard_trg
      BEFORE UPDATE OF account_id, direction, amount ON peakos_bank_transactions
      FOR EACH ROW
      EXECUTE FUNCTION peakos_protect_approved_credit_bank_transaction();
  END IF;
END
$$;
