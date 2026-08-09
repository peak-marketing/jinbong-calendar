-- Auditable one-time import support for the 2026-06/07/08 settlement sheets.
-- This migration does not import data by itself.

SELECT pg_advisory_xact_lock(hashtext('peakos-settlement-import-migration-v1'));

ALTER TABLE peakos_intake
  ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS expected_deposit_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS vendor_paid_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS source_document_id TEXT,
  ADD COLUMN IF NOT EXISTS source_sheet_name TEXT,
  ADD COLUMN IF NOT EXISTS source_row_number INTEGER,
  ADD COLUMN IF NOT EXISTS source_record_type TEXT,
  ADD COLUMN IF NOT EXISTS source_record_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS source_import_run_id UUID,
  ADD COLUMN IF NOT EXISTS source_gross_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS source_expected_deposit_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS source_sales_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS source_salesperson_supply_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS source_profit_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS source_payment_status TEXT,
  ADD COLUMN IF NOT EXISTS source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_imported_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'peakos_intake'::regclass
       AND conname = 'peakos_intake_row_version_positive_check'
  ) THEN
    ALTER TABLE peakos_intake ADD CONSTRAINT peakos_intake_row_version_positive_check
      CHECK (row_version > 0) NOT VALID;
  END IF;
END
$$;

ALTER TABLE peakos_monthly
  ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS source_document_id TEXT,
  ADD COLUMN IF NOT EXISTS source_sheet_name TEXT,
  ADD COLUMN IF NOT EXISTS source_row_number INTEGER,
  ADD COLUMN IF NOT EXISTS source_record_type TEXT,
  ADD COLUMN IF NOT EXISTS source_record_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS source_import_run_id UUID,
  ADD COLUMN IF NOT EXISTS source_gross_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS source_expected_deposit_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS source_sales_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS source_salesperson_supply_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS source_profit_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_imported_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'peakos_monthly'::regclass
       AND conname = 'peakos_monthly_row_version_positive_check'
  ) THEN
    ALTER TABLE peakos_monthly ADD CONSTRAINT peakos_monthly_row_version_positive_check
      CHECK (row_version > 0) NOT VALID;
  END IF;
END
$$;

-- Versioned API mutations use append-only audit rows. Deletes first persist a
-- tombstone so a deterministic source/API id cannot later be silently reused.
CREATE TABLE IF NOT EXISTS peakos_intake_tombstones (
  target_id TEXT PRIMARY KEY,
  row_version BIGINT NOT NULL,
  deleted_by_uid TEXT NOT NULL,
  deleted_by_name TEXT NOT NULL DEFAULT '',
  delete_reason TEXT NOT NULL,
  last_state JSONB NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_intake_tombstones_version_check CHECK (row_version > 0),
  CONSTRAINT peakos_intake_tombstones_reason_check CHECK (char_length(delete_reason) BETWEEN 8 AND 500)
);

CREATE TABLE IF NOT EXISTS peakos_intake_audit_log (
  id BIGSERIAL PRIMARY KEY,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  row_version BIGINT NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  before_state JSONB,
  after_state JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_intake_audit_version_check CHECK (row_version > 0),
  CONSTRAINT peakos_intake_audit_action_check CHECK (char_length(action) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS peakos_intake_audit_target_idx
  ON peakos_intake_audit_log(target_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS peakos_monthly_tombstones (
  target_id TEXT PRIMARY KEY,
  row_version BIGINT NOT NULL,
  deleted_by_uid TEXT NOT NULL,
  deleted_by_name TEXT NOT NULL DEFAULT '',
  delete_reason TEXT NOT NULL,
  last_state JSONB NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_monthly_tombstones_version_check CHECK (row_version > 0),
  CONSTRAINT peakos_monthly_tombstones_reason_check CHECK (char_length(delete_reason) BETWEEN 8 AND 500)
);

CREATE TABLE IF NOT EXISTS peakos_monthly_audit_log (
  id BIGSERIAL PRIMARY KEY,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  row_version BIGINT NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  before_state JSONB,
  after_state JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_monthly_audit_version_check CHECK (row_version > 0),
  CONSTRAINT peakos_monthly_audit_action_check CHECK (char_length(action) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS peakos_monthly_audit_target_idx
  ON peakos_monthly_audit_log(target_id, created_at DESC, id DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'peakos_intake'::regclass
       AND conname = 'peakos_intake_source_lineage_check'
  ) THEN
    ALTER TABLE peakos_intake ADD CONSTRAINT peakos_intake_source_lineage_check CHECK (
      (source_document_id IS NULL
        AND source_sheet_name IS NULL
        AND source_row_number IS NULL
        AND source_record_type IS NULL
        AND source_record_fingerprint IS NULL
        AND source_import_run_id IS NULL
        AND source_imported_at IS NULL)
      OR
      (char_length(source_document_id) BETWEEN 20 AND 100
        AND char_length(source_sheet_name) BETWEEN 1 AND 100
        AND source_row_number > 0
        AND source_record_type = 'individual'
        AND source_record_fingerprint ~ '^[0-9a-f]{64}$'
        AND source_import_run_id IS NOT NULL
        AND source_imported_at IS NOT NULL)
    ) NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'peakos_monthly'::regclass
       AND conname = 'peakos_monthly_source_lineage_check'
  ) THEN
    ALTER TABLE peakos_monthly ADD CONSTRAINT peakos_monthly_source_lineage_check CHECK (
      (source_document_id IS NULL
        AND source_sheet_name IS NULL
        AND source_row_number IS NULL
        AND source_record_type IS NULL
        AND source_record_fingerprint IS NULL
        AND source_import_run_id IS NULL
        AND source_imported_at IS NULL)
      OR
      (char_length(source_document_id) BETWEEN 20 AND 100
        AND char_length(source_sheet_name) BETWEEN 1 AND 100
        AND source_row_number > 0
        AND source_record_type IN ('sale', 'run')
        AND source_record_fingerprint ~ '^[0-9a-f]{64}$'
        AND source_import_run_id IS NOT NULL
        AND source_imported_at IS NOT NULL)
    ) NOT VALID;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS peakos_intake_source_lineage_uidx
  ON peakos_intake(source_document_id, source_sheet_name, source_row_number, source_record_type)
  WHERE source_document_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS peakos_monthly_source_lineage_uidx
  ON peakos_monthly(source_document_id, source_sheet_name, source_row_number, source_record_type)
  WHERE source_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS peakos_intake_expected_deposit_idx
  ON peakos_intake(owner_uid, date DESC, expected_deposit_amount)
  WHERE expected_deposit_amount IS NOT NULL;

-- A separately named index avoids dropping/rebuilding the legacy index on
-- every idempotent startup migration. PostgreSQL can select this VAT-aware
-- partial index while old rows safely fall back to sell * qty.
CREATE INDEX IF NOT EXISTS peakos_intake_bank_match_expected_candidate_idx
  ON peakos_intake (
    kind,
    (COALESCE(expected_deposit_amount, COALESCE(sell, 0)::numeric * COALESCE(qty, 0)::numeric)
      - COALESCE(paid_amount, 0)::numeric),
    created_at
  )
  WHERE kind IN ('normal', 'reserve')
    AND bank_match_eligible = TRUE
    AND (COALESCE(expected_deposit_amount, COALESCE(sell, 0)::numeric * COALESCE(qty, 0)::numeric)
      - COALESCE(paid_amount, 0)::numeric) > 0;

CREATE TABLE IF NOT EXISTS peakos_settlement_import_runs (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL,
  source_manifest_sha256 TEXT NOT NULL,
  plan_sha256 TEXT NOT NULL,
  source_snapshot JSONB NOT NULL,
  totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  imported_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  quarantine_count INTEGER NOT NULL DEFAULT 0,
  actor_uid TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  rolled_back_by_uid TEXT,
  CONSTRAINT peakos_settlement_import_runs_status_check
    CHECK (status IN ('RUNNING', 'COMPLETED', 'ROLLED_BACK')),
  CONSTRAINT peakos_settlement_import_runs_manifest_hash_check
    CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_settlement_import_runs_plan_hash_check
    CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_settlement_import_runs_counts_check
    CHECK (imported_count >= 0 AND skipped_count >= 0 AND quarantine_count >= 0)
);

-- Keep startup migration idempotent if a pre-release version of this table
-- existed before normalized-plan pinning was added.
ALTER TABLE peakos_settlement_import_runs
  ADD COLUMN IF NOT EXISTS plan_sha256 TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'peakos_settlement_import_runs'::regclass
       AND conname = 'peakos_settlement_import_runs_plan_hash_check'
  ) THEN
    ALTER TABLE peakos_settlement_import_runs
      ADD CONSTRAINT peakos_settlement_import_runs_plan_hash_check
      CHECK (plan_sha256 ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS peakos_settlement_import_items (
  run_id UUID NOT NULL REFERENCES peakos_settlement_import_runs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  target_table TEXT NOT NULL,
  target_id TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'INSERT',
  after_fingerprint TEXT NOT NULL,
  after_state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rolled_back_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, target_table, target_id),
  CONSTRAINT peakos_settlement_import_items_table_check
    CHECK (target_table IN ('peakos_intake', 'peakos_monthly')),
  CONSTRAINT peakos_settlement_import_items_operation_check
    CHECK (operation = 'INSERT'),
  CONSTRAINT peakos_settlement_import_items_fingerprint_check
    CHECK (after_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS peakos_settlement_import_quarantine (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES peakos_settlement_import_runs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_document_id TEXT NOT NULL,
  source_sheet_name TEXT NOT NULL,
  source_row_number INTEGER NOT NULL,
  reason_codes TEXT[] NOT NULL,
  source_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_settlement_import_quarantine_row_check
    CHECK (source_row_number > 0),
  CONSTRAINT peakos_settlement_import_quarantine_reasons_check
    CHECK (cardinality(reason_codes) > 0)
);

CREATE INDEX IF NOT EXISTS peakos_settlement_import_quarantine_run_idx
  ON peakos_settlement_import_quarantine(run_id, source_sheet_name, source_row_number);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'peakos_intake'::regclass
       AND conname = 'peakos_intake_source_import_run_fk'
  ) THEN
    ALTER TABLE peakos_intake ADD CONSTRAINT peakos_intake_source_import_run_fk
      FOREIGN KEY (source_import_run_id) REFERENCES peakos_settlement_import_runs(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'peakos_monthly'::regclass
       AND conname = 'peakos_monthly_source_import_run_fk'
  ) THEN
    ALTER TABLE peakos_monthly ADD CONSTRAINT peakos_monthly_source_import_run_fk
      FOREIGN KEY (source_import_run_id) REFERENCES peakos_settlement_import_runs(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
  END IF;
END
$$;

ALTER TABLE peakos_intake VALIDATE CONSTRAINT peakos_intake_source_lineage_check;
ALTER TABLE peakos_intake VALIDATE CONSTRAINT peakos_intake_row_version_positive_check;
ALTER TABLE peakos_monthly VALIDATE CONSTRAINT peakos_monthly_source_lineage_check;
ALTER TABLE peakos_monthly VALIDATE CONSTRAINT peakos_monthly_row_version_positive_check;
ALTER TABLE peakos_intake VALIDATE CONSTRAINT peakos_intake_source_import_run_fk;
ALTER TABLE peakos_monthly VALIDATE CONSTRAINT peakos_monthly_source_import_run_fk;
