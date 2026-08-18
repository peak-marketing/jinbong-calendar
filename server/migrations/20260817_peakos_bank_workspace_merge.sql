-- Canonical PEAK OS bank-ledger hardening and legacy import identity.
-- All existing bank accounts are headquarters-only. Non-Peak bank routes stay
-- blocked in the application until account identifiers become tenant-local.

SELECT pg_advisory_xact_lock(hashtext('peakos-bank-workspace-merge-v1'));

ALTER TABLE peakos_bank_accounts
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE peakos_bank_transactions
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE peakos_bank_sync_runs
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE peakos_bank_allocations
  ADD COLUMN IF NOT EXISTS workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS legacy_source_key TEXT;
ALTER TABLE peakos_bank_audit_log
  ADD COLUMN IF NOT EXISTS workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS legacy_source_key TEXT;

UPDATE peakos_bank_accounts SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL;
UPDATE peakos_bank_transactions SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL;
UPDATE peakos_bank_sync_runs SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL;
UPDATE peakos_bank_allocations SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL;
UPDATE peakos_bank_audit_log SET workspace_id = 'ws_peak' WHERE workspace_id IS NULL;

ALTER TABLE peakos_bank_accounts
  ALTER COLUMN workspace_id SET DEFAULT 'ws_peak',
  ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE peakos_bank_transactions
  ALTER COLUMN workspace_id SET DEFAULT 'ws_peak',
  ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE peakos_bank_sync_runs
  ALTER COLUMN workspace_id SET DEFAULT 'ws_peak',
  ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE peakos_bank_allocations
  ALTER COLUMN workspace_id SET DEFAULT 'ws_peak',
  ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE peakos_bank_audit_log
  ALTER COLUMN workspace_id SET DEFAULT 'ws_peak',
  ALTER COLUMN workspace_id SET NOT NULL;

DO $bank_workspace_foreign_keys$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peakos_bank_accounts_workspace_fk') THEN
    ALTER TABLE peakos_bank_accounts
      ADD CONSTRAINT peakos_bank_accounts_workspace_fk
      FOREIGN KEY (workspace_id) REFERENCES peakos_workspaces(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peakos_bank_transactions_workspace_fk') THEN
    ALTER TABLE peakos_bank_transactions
      ADD CONSTRAINT peakos_bank_transactions_workspace_fk
      FOREIGN KEY (workspace_id) REFERENCES peakos_workspaces(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peakos_bank_sync_runs_workspace_fk') THEN
    ALTER TABLE peakos_bank_sync_runs
      ADD CONSTRAINT peakos_bank_sync_runs_workspace_fk
      FOREIGN KEY (workspace_id) REFERENCES peakos_workspaces(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peakos_bank_allocations_workspace_fk') THEN
    ALTER TABLE peakos_bank_allocations
      ADD CONSTRAINT peakos_bank_allocations_workspace_fk
      FOREIGN KEY (workspace_id) REFERENCES peakos_workspaces(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peakos_bank_audit_log_workspace_fk') THEN
    ALTER TABLE peakos_bank_audit_log
      ADD CONSTRAINT peakos_bank_audit_log_workspace_fk
      FOREIGN KEY (workspace_id) REFERENCES peakos_workspaces(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END
$bank_workspace_foreign_keys$;

CREATE UNIQUE INDEX IF NOT EXISTS peakos_bank_accounts_workspace_id_unique
  ON peakos_bank_accounts(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS peakos_bank_transactions_workspace_id_unique
  ON peakos_bank_transactions(workspace_id, id);
CREATE INDEX IF NOT EXISTS peakos_bank_transactions_workspace_time_idx
  ON peakos_bank_transactions(workspace_id, transaction_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS peakos_bank_sync_runs_workspace_started_idx
  ON peakos_bank_sync_runs(workspace_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS peakos_bank_allocations_workspace_transaction_idx
  ON peakos_bank_allocations(workspace_id, transaction_id, status);
CREATE INDEX IF NOT EXISTS peakos_bank_audit_workspace_created_idx
  ON peakos_bank_audit_log(workspace_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS peakos_bank_allocations_legacy_source_unique
  ON peakos_bank_allocations(workspace_id, legacy_source_key)
  WHERE legacy_source_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS peakos_bank_audit_legacy_source_unique
  ON peakos_bank_audit_log(workspace_id, legacy_source_key)
  WHERE legacy_source_key IS NOT NULL;

DO $bank_workspace_child_foreign_keys$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peakos_bank_transactions_workspace_account_fk') THEN
    ALTER TABLE peakos_bank_transactions
      ADD CONSTRAINT peakos_bank_transactions_workspace_account_fk
      FOREIGN KEY (workspace_id, account_id)
      REFERENCES peakos_bank_accounts(workspace_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peakos_bank_sync_runs_workspace_account_fk') THEN
    ALTER TABLE peakos_bank_sync_runs
      ADD CONSTRAINT peakos_bank_sync_runs_workspace_account_fk
      FOREIGN KEY (workspace_id, account_id)
      REFERENCES peakos_bank_accounts(workspace_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peakos_bank_allocations_workspace_transaction_fk') THEN
    ALTER TABLE peakos_bank_allocations
      ADD CONSTRAINT peakos_bank_allocations_workspace_transaction_fk
      FOREIGN KEY (workspace_id, transaction_id)
      REFERENCES peakos_bank_transactions(workspace_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END
$bank_workspace_child_foreign_keys$;
