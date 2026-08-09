-- Server-backed tax, refund, advertising and supplies requests.
-- Run after the PEAK OS core and banking migrations.

SELECT pg_advisory_xact_lock(hashtext('peakos-finance-requests-migration'));

CREATE TABLE IF NOT EXISTS peakos_finance_requests (
  id TEXT PRIMARY KEY,
  requester_uid TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  request_date DATE NOT NULL,
  client_name TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  amount_vat BIGINT NOT NULL,
  business_registration_url TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  payee_bank TEXT NOT NULL DEFAULT '',
  payee_account_ciphertext BYTEA,
  payee_account_iv BYTEA,
  payee_account_auth_tag BYTEA,
  payee_account_encryption_version SMALLINT,
  payee_name TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  invoice_requested BOOLEAN NOT NULL DEFAULT FALSE,
  invoice_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
  evidence_url TEXT NOT NULL DEFAULT '',
  invoice_evidence_url TEXT NOT NULL DEFAULT '',
  source_account_id TEXT
    REFERENCES peakos_bank_accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  processing_note TEXT NOT NULL DEFAULT '',
  processed_by_uid TEXT,
  processed_by_name TEXT,
  processed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  platform_key TEXT,
  external_document_id TEXT,
  bank_transaction_id BIGINT
    REFERENCES peakos_bank_transactions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_finance_requests_id_length_check
    CHECK (char_length(id) BETWEEN 1 AND 80),
  CONSTRAINT peakos_finance_requests_requester_uid_length_check
    CHECK (char_length(requester_uid) BETWEEN 1 AND 256),
  CONSTRAINT peakos_finance_requests_requester_name_length_check
    CHECK (char_length(requester_name) BETWEEN 1 AND 120),
  CONSTRAINT peakos_finance_requests_kind_check CHECK (
    kind IN (
      'TAX_ADVANCE', 'TAX_CORRECTION',
      'REFUND_CLIENT', 'REFUND_MISTAKEN',
      'EXPENSE_AD', 'EXPENSE_SUPPLIES'
    )
  ),
  CONSTRAINT peakos_finance_requests_client_length_check
    CHECK (char_length(client_name) BETWEEN 1 AND 200),
  CONSTRAINT peakos_finance_requests_detail_length_check
    CHECK (char_length(detail) <= 2000),
  CONSTRAINT peakos_finance_requests_amount_check CHECK (amount_vat > 0),
  CONSTRAINT peakos_finance_requests_business_url_length_check
    CHECK (char_length(business_registration_url) <= 2000),
  CONSTRAINT peakos_finance_requests_email_length_check
    CHECK (char_length(email) <= 320),
  CONSTRAINT peakos_finance_requests_payee_bank_length_check
    CHECK (char_length(payee_bank) <= 120),
  CONSTRAINT peakos_finance_requests_payee_name_length_check
    CHECK (char_length(payee_name) <= 160),
  CONSTRAINT peakos_finance_requests_reason_length_check
    CHECK (char_length(reason) <= 2000),
  CONSTRAINT peakos_finance_requests_evidence_url_length_check
    CHECK (char_length(evidence_url) <= 2000),
  CONSTRAINT peakos_finance_requests_invoice_evidence_url_length_check
    CHECK (char_length(invoice_evidence_url) <= 2000),
  CONSTRAINT peakos_finance_requests_processing_note_length_check
    CHECK (char_length(processing_note) <= 2000),
  CONSTRAINT peakos_finance_requests_processed_uid_length_check
    CHECK (processed_by_uid IS NULL OR char_length(processed_by_uid) BETWEEN 1 AND 256),
  CONSTRAINT peakos_finance_requests_processed_name_length_check
    CHECK (processed_by_name IS NULL OR char_length(processed_by_name) BETWEEN 1 AND 120),
  CONSTRAINT peakos_finance_requests_platform_key_length_check
    CHECK (platform_key IS NULL OR char_length(platform_key) BETWEEN 1 AND 80),
  CONSTRAINT peakos_finance_requests_external_document_length_check
    CHECK (external_document_id IS NULL OR char_length(external_document_id) BETWEEN 1 AND 240),
  CONSTRAINT peakos_finance_requests_idempotency_key_length_check
    CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 120),
  CONSTRAINT peakos_finance_requests_status_check CHECK (
    status IN ('PENDING', 'REVIEWING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'CANCELLED')
  ),
  CONSTRAINT peakos_finance_requests_invoice_status_check CHECK (
    invoice_status IN (
      'NOT_REQUESTED', 'REQUESTED', 'PROCESSING', 'ISSUED',
      'CORRECTION_REQUESTED', 'CORRECTED', 'FAILED', 'CANCELLED'
    )
  ),
  CONSTRAINT peakos_finance_requests_invoice_state_check CHECK (
    (invoice_requested = FALSE AND invoice_status = 'NOT_REQUESTED')
    OR
    (invoice_requested = TRUE AND invoice_status <> 'NOT_REQUESTED')
  ),
  CONSTRAINT peakos_finance_requests_refund_terminal_invoice_check CHECK (
    kind NOT IN ('REFUND_CLIENT', 'REFUND_MISTAKEN')
    OR status NOT IN ('REJECTED', 'CANCELLED')
    OR invoice_status IN ('NOT_REQUESTED', 'CANCELLED', 'ISSUED', 'CORRECTED')
  ),
  CONSTRAINT peakos_finance_requests_cancelled_state_check CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL)
    OR
    (status <> 'CANCELLED' AND cancelled_at IS NULL)
  ),
  CONSTRAINT peakos_finance_requests_payee_encryption_check CHECK (
    (
      payee_account_ciphertext IS NULL
      AND payee_account_iv IS NULL
      AND payee_account_auth_tag IS NULL
      AND payee_account_encryption_version IS NULL
    )
    OR
    (
      payee_account_ciphertext IS NOT NULL
      AND payee_account_iv IS NOT NULL
      AND octet_length(payee_account_iv) = 12
      AND payee_account_auth_tag IS NOT NULL
      AND octet_length(payee_account_auth_tag) = 16
      AND payee_account_encryption_version = 1
    )
  )
);

-- Existing installations may contain historical rows that predate the linked
-- request/invoice terminal policy. NOT VALID protects all new writes without
-- making a deployment fail while those legacy rows are reviewed separately.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'peakos_finance_requests_refund_terminal_invoice_check'
       AND conrelid = 'peakos_finance_requests'::regclass
  ) THEN
    ALTER TABLE peakos_finance_requests
      ADD CONSTRAINT peakos_finance_requests_refund_terminal_invoice_check
      CHECK (
        kind NOT IN ('REFUND_CLIENT', 'REFUND_MISTAKEN')
        OR status NOT IN ('REJECTED', 'CANCELLED')
        OR invoice_status IN ('NOT_REQUESTED', 'CANCELLED', 'ISSUED', 'CORRECTED')
      ) NOT VALID;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS peakos_finance_requests_requester_idempotency_idx
  ON peakos_finance_requests(requester_uid, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS peakos_finance_requests_external_document_idx
  ON peakos_finance_requests(platform_key, external_document_id)
  WHERE platform_key IS NOT NULL AND external_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS peakos_finance_requests_requester_created_idx
  ON peakos_finance_requests(requester_uid, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS peakos_finance_requests_requester_date_idx
  ON peakos_finance_requests(requester_uid, request_date DESC, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS peakos_finance_requests_date_idx
  ON peakos_finance_requests(request_date DESC, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS peakos_finance_requests_kind_status_created_idx
  ON peakos_finance_requests(kind, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS peakos_finance_requests_source_account_created_idx
  ON peakos_finance_requests(source_account_id, created_at DESC, id DESC)
  WHERE source_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS peakos_finance_request_events (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT NOT NULL
    REFERENCES peakos_finance_requests(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  from_invoice_status TEXT,
  to_invoice_status TEXT,
  note TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_finance_request_events_type_length_check
    CHECK (char_length(event_type) BETWEEN 1 AND 80),
  CONSTRAINT peakos_finance_request_events_actor_uid_length_check
    CHECK (char_length(actor_uid) BETWEEN 1 AND 256),
  CONSTRAINT peakos_finance_request_events_actor_name_length_check
    CHECK (char_length(actor_name) BETWEEN 1 AND 120),
  CONSTRAINT peakos_finance_request_events_note_length_check
    CHECK (char_length(note) <= 2000)
);

CREATE INDEX IF NOT EXISTS peakos_finance_request_events_request_created_idx
  ON peakos_finance_request_events(request_id, created_at, id);
