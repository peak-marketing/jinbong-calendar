CREATE TABLE IF NOT EXISTS peakos_bank_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  branch_id TEXT NOT NULL DEFAULT 'hq',
  account_number_masked TEXT,
  account_fingerprint TEXT UNIQUE,
  currency TEXT NOT NULL DEFAULT 'KRW',
  purpose TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  latest_balance BIGINT,
  latest_balance_at TIMESTAMPTZ,
  last_sync_started_at TIMESTAMPTZ,
  last_sync_succeeded_at TIMESTAMPTZ,
  last_sync_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_bank_accounts_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT peakos_bank_accounts_masked_number_check CHECK (
    account_number_masked IS NULL OR (
      length(account_number_masked) <= 80
      AND account_number_masked ~ '^[0-9*-]+$'
      AND position('*' IN account_number_masked) > 0
      AND length(regexp_replace(account_number_masked, '[^0-9]', '', 'g')) <= 6
    )
  )
);

-- 실제 조회 자격정보는 절대 DB·소스에 넣지 않는다. 여기에는 화면에
-- 표시할 마스킹 번호와 업무 용도만 저장하고, 안전한 수집기 연결 전까지
-- 비활성으로 둔다. 재실행해도 운영자가 바꾼 정보를 덮어쓰지 않는다.
INSERT INTO peakos_bank_accounts
  (id, provider, bank_name, display_name, branch_id, account_number_masked, currency, purpose, is_active)
VALUES
  ('ibk-hq-sales', 'IBK_QUICK', 'IBK기업은행', '본사 매출통장', 'hq', '56-********-4017', 'KRW', '매출 입금', FALSE),
  ('ibk-hq-supplier', 'IBK_QUICK', 'IBK기업은행', '공급처 통장', 'hq', '56-********-1042', 'KRW', '공급처 지급', FALSE),
  ('ibk-hq-fixed', 'IBK_QUICK', 'IBK기업은행', '고정비용통장', 'hq', '56-********-1035', 'KRW', '광고비 지급', FALSE),
  ('ibk-review-space', 'IBK_QUICK', 'IBK기업은행', '리뷰스페이스통장', 'hq', '07-********-4015', 'KRW', '리뷰스페이스 운영', FALSE),
  ('ibk-reward-space', 'IBK_QUICK', 'IBK기업은행', '리워드스페이스통장', 'hq', '07-********-4022', 'KRW', '리워드스페이스 운영', FALSE)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS peakos_bank_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES peakos_bank_accounts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  trigger_type TEXT NOT NULL DEFAULT 'MANUAL',
  requested_by_uid TEXT,
  requested_by_name TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  range_from TIMESTAMPTZ,
  range_to TIMESTAMPTZ,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  request_id TEXT,
  CONSTRAINT peakos_bank_sync_runs_status_check
    CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED')),
  CONSTRAINT peakos_bank_sync_runs_trigger_check
    CHECK (trigger_type IN ('MANUAL', 'SCHEDULED', 'IMPORT', 'COLLECTOR'))
);

CREATE TABLE IF NOT EXISTS peakos_bank_transactions (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES peakos_bank_accounts(id) ON DELETE RESTRICT,
  provider_transaction_key TEXT NOT NULL,
  provider_key_stable BOOLEAN NOT NULL DEFAULT FALSE,
  transaction_at TIMESTAMPTZ NOT NULL,
  direction TEXT NOT NULL,
  amount BIGINT NOT NULL,
  balance BIGINT,
  summary TEXT,
  counterparty_name TEXT,
  counterparty_account_masked TEXT,
  branch_text TEXT,
  reconciliation_status TEXT NOT NULL DEFAULT 'UNMATCHED',
  source TEXT NOT NULL DEFAULT 'BANK_SYNC',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_bank_transactions_direction_check
    CHECK (direction IN ('DEPOSIT', 'WITHDRAWAL')),
  CONSTRAINT peakos_bank_transactions_amount_check CHECK (amount > 0),
  CONSTRAINT peakos_bank_transactions_reconcile_check
    CHECK (reconciliation_status IN ('UNMATCHED', 'PROPOSED', 'MATCHED', 'IGNORED', 'REVERSED')),
  CONSTRAINT peakos_bank_transactions_source_check
    CHECK (source IN ('BANK_SYNC', 'CSV_IMPORT', 'COLLECTOR')),
  UNIQUE (account_id, provider_transaction_key)
);

ALTER TABLE peakos_bank_transactions
  ADD COLUMN IF NOT EXISTS provider_key_stable BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS peakos_bank_allocations (
  id BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES peakos_bank_transactions(id) ON DELETE RESTRICT,
  intake_id TEXT NOT NULL,
  allocated_amount BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  match_method TEXT NOT NULL DEFAULT 'MANUAL',
  confidence NUMERIC(5, 4),
  reason TEXT NOT NULL DEFAULT '',
  created_by_uid TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_by_uid TEXT,
  reversed_by_name TEXT,
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,
  CONSTRAINT peakos_bank_allocations_amount_check CHECK (allocated_amount > 0),
  CONSTRAINT peakos_bank_allocations_status_check CHECK (status IN ('ACTIVE', 'REVERSED')),
  CONSTRAINT peakos_bank_allocations_match_method_check
    CHECK (match_method IN ('MANUAL', 'EXACT', 'REFERENCE', 'IMPORT'))
);

CREATE TABLE IF NOT EXISTS peakos_bank_audit_log (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_uid TEXT,
  actor_name TEXT,
  request_id TEXT,
  ip_address TEXT,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS peakos_bank_transactions_account_time_idx
  ON peakos_bank_transactions(account_id, transaction_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS peakos_bank_transactions_status_time_idx
  ON peakos_bank_transactions(reconciliation_status, transaction_at DESC);
CREATE INDEX IF NOT EXISTS peakos_bank_transactions_direction_time_idx
  ON peakos_bank_transactions(direction, transaction_at DESC);
CREATE INDEX IF NOT EXISTS peakos_bank_sync_runs_account_started_idx
  ON peakos_bank_sync_runs(account_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS peakos_bank_sync_runs_one_running_idx
  ON peakos_bank_sync_runs(account_id) WHERE status = 'RUNNING';
CREATE UNIQUE INDEX IF NOT EXISTS peakos_bank_sync_runs_request_id_idx
  ON peakos_bank_sync_runs(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS peakos_bank_allocations_transaction_idx
  ON peakos_bank_allocations(transaction_id, status);
CREATE INDEX IF NOT EXISTS peakos_bank_allocations_intake_idx
  ON peakos_bank_allocations(intake_id, status);
CREATE INDEX IF NOT EXISTS peakos_bank_audit_created_idx
  ON peakos_bank_audit_log(created_at DESC);
