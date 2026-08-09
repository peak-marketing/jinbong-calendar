-- Minimal PEAK OS core tables required before bank reconciliation migrations.
-- Existing installations keep their current tables; a clean restore can boot
-- without relying on a manually-created schema.

CREATE TABLE IF NOT EXISTS peakos_intake (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  owner_name TEXT,
  date DATE NOT NULL,
  client TEXT DEFAULT '',
  a TEXT DEFAULT '',
  b TEXT DEFAULT '',
  c TEXT DEFAULT '',
  unit NUMERIC DEFAULT 0,
  qty NUMERIC DEFAULT 0,
  sell NUMERIC DEFAULT 0,
  cost NUMERIC,
  memo TEXT DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'normal',
  ref_of TEXT DEFAULT '',
  supplier TEXT DEFAULT '',
  manager TEXT DEFAULT '',
  final_only BOOLEAN NOT NULL DEFAULT FALSE,
  paid TEXT NOT NULL DEFAULT 'none',
  paid_amount NUMERIC NOT NULL DEFAULT 0,
  payer TEXT DEFAULT '',
  paid_date TEXT DEFAULT '',
  paid_memo TEXT DEFAULT '',
  paid_auto BOOLEAN NOT NULL DEFAULT FALSE,
  vendor_paid BOOLEAN NOT NULL DEFAULT FALSE,
  vendor_paid_date TEXT DEFAULT '',
  vendor_bank TEXT DEFAULT '',
  vendor_by TEXT DEFAULT '',
  vendor_memo TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_intake_kind_check
    CHECK (kind IN ('normal', 'reserve', 'use', 'refund')),
  CONSTRAINT peakos_intake_paid_check
    CHECK (paid IN ('none', 'paid', 'partial', 'wrong'))
);

CREATE TABLE IF NOT EXISTS peakos_credit (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  owner_name TEXT,
  date DATE NOT NULL,
  client TEXT DEFAULT '',
  product TEXT DEFAULT '',
  vendor TEXT DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'charge',
  paid NUMERIC NOT NULL DEFAULT 0,
  point NUMERIC NOT NULL DEFAULT 0,
  memo TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_credit_kind_check
    CHECK (kind IN ('charge', 'use', 'refund'))
);

-- Existing PEAK OS routes use these shared tables even when banking is the
-- first feature deployed into a clean/disaster-recovery database.
CREATE TABLE IF NOT EXISTS peakos_price (
  key TEXT PRIMARY KEY,
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  c TEXT NOT NULL,
  cost NUMERIC,
  unit NUMERIC,
  is_custom BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by TEXT DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS peakos_monthly (
  id TEXT PRIMARY KEY,
  view TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  owner_name TEXT,
  kind TEXT NOT NULL DEFAULT 'sale',
  parent_id TEXT DEFAULT '',
  date DATE NOT NULL,
  client TEXT DEFAULT '',
  a TEXT DEFAULT '',
  b TEXT DEFAULT '',
  c TEXT DEFAULT '',
  amount NUMERIC NOT NULL DEFAULT 0,
  qty NUMERIC NOT NULL DEFAULT 0,
  period TEXT DEFAULT '',
  memo TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS peakos_monthly_view_idx
  ON peakos_monthly(view, date DESC);

CREATE TABLE IF NOT EXISTS peakos_fund (
  id INTEGER PRIMARY KEY DEFAULT 1,
  board JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peakos_fund_single CHECK (id = 1)
);
