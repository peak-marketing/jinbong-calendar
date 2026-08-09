-- Durable defaults for the PEAK OS company product catalog.
-- Current cost/unit may be edited, while default_* remain the reset target.

SELECT pg_advisory_xact_lock(hashtext('peakos-price-catalog-v1'));

ALTER TABLE peakos_price
  ADD COLUMN IF NOT EXISTS is_base BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS default_cost NUMERIC,
  ADD COLUMN IF NOT EXISTS default_unit NUMERIC,
  ADD COLUMN IF NOT EXISTS catalog_version TEXT;

CREATE INDEX IF NOT EXISTS peakos_price_base_idx
  ON peakos_price(is_base, a, b, c);
