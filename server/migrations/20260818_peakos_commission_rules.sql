-- Versioned commission rules and immutable commission calculation snapshots.
--
-- This migration intentionally does not create a default rate and does not
-- backfill calculations.  A calculation is only an estimate until the source
-- intake row has immutable supplier reconciliation evidence.

BEGIN;
SET LOCAL search_path = public, pg_catalog;

SELECT pg_advisory_xact_lock(hashtext('peakos-commission-rules-v1'));

DO $commission_prerequisites$
BEGIN
  IF to_regclass('public.peakos_workspaces') IS NULL
     OR to_regclass('public.peakos_workspace_memberships') IS NULL
     OR to_regclass('public.peakos_intake') IS NULL
     OR to_regclass('public.peakos_vendor_settlement_batches') IS NULL
     OR to_regclass('public.peakos_vendor_settlement_items') IS NULL THEN
    RAISE EXCEPTION
      'workspace, settlement import, and vendor reconciliation migrations are required before commission rules'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM unnest(ARRAY[
        'id','workspace_id','owner_uid','owner_name','date','row_version','kind',
        'a','b','c','qty','sell','unit','source_metadata','vendor_paid'
      ]) required_column
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.peakos_intake'::regclass
          AND attname = required_column AND attnum > 0 AND NOT attisdropped
     )
  ) OR EXISTS (
    SELECT 1
      FROM unnest(ARRAY['workspace_id','batch_id','source_intake_id','source_settled_row_version']) required_column
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.peakos_vendor_settlement_items'::regclass
          AND attname = required_column AND attnum > 0 AND NOT attisdropped
     )
  ) THEN
    RAISE EXCEPTION 'canonical intake and vendor evidence columns are required before commission rules'
      USING ERRCODE = '55000';
  END IF;
END
$commission_prerequisites$;

CREATE TABLE IF NOT EXISTS public.peakos_commission_rule_versions (
  workspace_id TEXT NOT NULL,
  id UUID NOT NULL,
  rule_series_id UUID NOT NULL,
  version INTEGER NOT NULL,
  supersedes_id UUID,
  status TEXT NOT NULL,
  scope_owner_uid TEXT,
  scope_platform TEXT,
  scope_product_a TEXT,
  scope_product_b TEXT,
  scope_product_c TEXT,
  rate_basis_points INTEGER NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  reason TEXT NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT peakos_commission_rule_versions_pkey
    PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_commission_rule_versions_series_version_unique
    UNIQUE (workspace_id, rule_series_id, version),
  CONSTRAINT peakos_commission_rule_versions_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.peakos_workspaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_commission_rule_versions_owner_membership_fk
    FOREIGN KEY (workspace_id, scope_owner_uid)
    REFERENCES public.peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_commission_rule_versions_supersedes_fk
    FOREIGN KEY (workspace_id, supersedes_id)
    REFERENCES public.peakos_commission_rule_versions(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_commission_rule_versions_status_check
    CHECK (status IN ('DRAFT', 'APPROVED', 'ENDED')),
  CONSTRAINT peakos_commission_rule_versions_version_check
    CHECK (version >= 1),
  CONSTRAINT peakos_commission_rule_versions_transition_shape_check
    CHECK (
      (version = 1 AND supersedes_id IS NULL AND status = 'DRAFT')
      OR (version >= 2 AND supersedes_id IS NOT NULL AND status IN ('APPROVED', 'ENDED'))
    ),
  CONSTRAINT peakos_commission_rule_versions_rate_check
    CHECK (rate_basis_points BETWEEN 0 AND 10000),
  CONSTRAINT peakos_commission_rule_versions_effective_check
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT peakos_commission_rule_versions_scope_check
    CHECK (
      (scope_platform IS NULL OR scope_platform IN (
        'rewardspace', 'reviewspace', 'keywordmaster', 'brandautospace', 'reviewflow'
      ))
      AND (scope_product_a IS NULL OR char_length(btrim(scope_product_a)) BETWEEN 1 AND 120)
      AND (scope_product_b IS NULL OR char_length(btrim(scope_product_b)) BETWEEN 1 AND 120)
      AND (scope_product_c IS NULL OR char_length(btrim(scope_product_c)) BETWEEN 1 AND 120)
      AND (scope_product_b IS NULL OR scope_product_a IS NOT NULL)
      AND (scope_product_c IS NULL OR (scope_product_a IS NOT NULL AND scope_product_b IS NOT NULL))
    ),
  CONSTRAINT peakos_commission_rule_versions_text_check
    CHECK (
      (scope_owner_uid IS NULL OR char_length(btrim(scope_owner_uid)) BETWEEN 1 AND 256)
      AND char_length(btrim(reason)) BETWEEN 8 AND 500
      AND char_length(btrim(actor_uid)) BETWEEN 1 AND 256
      AND char_length(btrim(actor_name)) BETWEEN 1 AND 160
    )
);

CREATE TABLE IF NOT EXISTS public.peakos_commission_calculation_ledger (
  workspace_id TEXT NOT NULL,
  id UUID NOT NULL,
  input_fingerprint TEXT NOT NULL,
  source_intake_id TEXT NOT NULL,
  source_owner_uid TEXT NOT NULL,
  source_owner_name TEXT NOT NULL,
  source_business_date DATE NOT NULL,
  source_row_version BIGINT NOT NULL,
  source_snapshot_sha256 TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_platform TEXT,
  source_product_a TEXT NOT NULL,
  source_product_b TEXT NOT NULL,
  source_product_c TEXT NOT NULL,
  source_qty NUMERIC,
  source_sell_per_unit NUMERIC,
  source_salesperson_unit NUMERIC,
  sales_amount NUMERIC(20,0),
  salesperson_supply_amount NUMERIC(20,0),
  commission_base_amount NUMERIC(20,0),
  rule_version_id UUID,
  rule_series_id UUID,
  rule_version INTEGER,
  rate_basis_points INTEGER,
  calculation_status TEXT NOT NULL,
  estimated_commission_amount NUMERIC(20,0),
  payout_eligible BOOLEAN NOT NULL,
  payout_blockers JSONB NOT NULL,
  vendor_batch_id UUID,
  vendor_source_settled_row_version BIGINT,
  source_snapshot JSONB NOT NULL,
  rule_snapshot JSONB,
  calculated_by_uid TEXT NOT NULL,
  calculated_by_name TEXT NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT peakos_commission_calculation_ledger_pkey
    PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_commission_calculation_ledger_input_unique
    UNIQUE (workspace_id, input_fingerprint),
  CONSTRAINT peakos_commission_calculation_ledger_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.peakos_workspaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_commission_calculation_ledger_owner_membership_fk
    FOREIGN KEY (workspace_id, source_owner_uid)
    REFERENCES public.peakos_workspace_memberships(workspace_id, user_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_commission_calculation_ledger_rule_fk
    FOREIGN KEY (workspace_id, rule_version_id)
    REFERENCES public.peakos_commission_rule_versions(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_commission_calculation_ledger_vendor_batch_fk
    FOREIGN KEY (workspace_id, vendor_batch_id)
    REFERENCES public.peakos_vendor_settlement_batches(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_commission_calculation_ledger_hash_check
    CHECK (
      input_fingerprint ~ '^[0-9a-f]{64}$'
      AND source_snapshot_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT peakos_commission_calculation_ledger_source_check
    CHECK (
      char_length(btrim(source_intake_id)) BETWEEN 1 AND 200
      AND char_length(btrim(source_owner_uid)) BETWEEN 1 AND 256
      AND char_length(btrim(source_owner_name)) BETWEEN 1 AND 160
      AND source_row_version >= 1
      AND source_kind IN ('normal', 'reserve', 'use', 'refund')
      AND (source_platform IS NULL OR source_platform IN (
        'rewardspace', 'reviewspace', 'keywordmaster', 'brandautospace', 'reviewflow'
      ))
      AND char_length(btrim(source_product_a)) <= 120
      AND char_length(btrim(source_product_b)) <= 120
      AND char_length(btrim(source_product_c)) <= 120
      AND jsonb_typeof(source_snapshot) = 'object'
    ),
  CONSTRAINT peakos_commission_calculation_ledger_status_check
    CHECK (calculation_status IN (
      'CALCULATED', 'UNCONFIGURED', 'RULE_OVERLAP', 'SOURCE_INELIGIBLE', 'SOURCE_INCOMPLETE'
    )),
  CONSTRAINT peakos_commission_calculation_ledger_blockers_check
    CHECK (
      jsonb_typeof(payout_blockers) = 'array'
      AND ((payout_eligible AND jsonb_array_length(payout_blockers) = 0)
        OR (NOT payout_eligible AND jsonb_array_length(payout_blockers) > 0))
    ),
  CONSTRAINT peakos_commission_calculation_ledger_math_check
    CHECK (
      (calculation_status = 'CALCULATED'
        AND source_qty > 0
        AND source_qty = trunc(source_qty)
        AND source_sell_per_unit >= 0
        AND source_sell_per_unit = trunc(source_sell_per_unit)
        AND source_salesperson_unit >= 0
        AND source_salesperson_unit = trunc(source_salesperson_unit)
        AND sales_amount = source_sell_per_unit * source_qty
        AND salesperson_supply_amount = source_salesperson_unit * source_qty
        AND commission_base_amount = sales_amount - salesperson_supply_amount
        AND commission_base_amount > 0
        AND rate_basis_points BETWEEN 0 AND 10000
        AND estimated_commission_amount = round(commission_base_amount * rate_basis_points::numeric / 10000)
        AND rule_version_id IS NOT NULL
        AND rule_series_id IS NOT NULL
        AND rule_version >= 2
        AND rule_snapshot IS NOT NULL
        AND jsonb_typeof(rule_snapshot) = 'object')
      OR
      (calculation_status <> 'CALCULATED'
        AND sales_amount IS NULL
        AND salesperson_supply_amount IS NULL
        AND commission_base_amount IS NULL
        AND rate_basis_points IS NULL
        AND estimated_commission_amount IS NULL
        AND rule_version_id IS NULL
        AND rule_series_id IS NULL
        AND rule_version IS NULL
        AND rule_snapshot IS NULL
        AND payout_eligible = FALSE)
    ),
  CONSTRAINT peakos_commission_calculation_ledger_payout_check
    CHECK (
      payout_eligible = FALSE
      AND (calculation_status <> 'CALCULATED'
        OR payout_blockers @> '["SETTLEMENT_COMPLETION_UNCONFIRMED"]'::jsonb)
    ),
  CONSTRAINT peakos_commission_calculation_ledger_vendor_shape_check
    CHECK (
      (vendor_batch_id IS NULL AND vendor_source_settled_row_version IS NULL)
      OR (vendor_batch_id IS NOT NULL AND vendor_source_settled_row_version >= 1)
    ),
  CONSTRAINT peakos_commission_calculation_ledger_actor_check
    CHECK (
      char_length(btrim(calculated_by_uid)) BETWEEN 1 AND 256
      AND char_length(btrim(calculated_by_name)) BETWEEN 1 AND 160
    )
);

CREATE INDEX IF NOT EXISTS peakos_commission_rule_versions_current_idx
  ON public.peakos_commission_rule_versions
    (workspace_id, rule_series_id, version DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS peakos_commission_rule_versions_effective_idx
  ON public.peakos_commission_rule_versions
    (workspace_id, status, effective_from, effective_to, scope_owner_uid, scope_platform);
CREATE INDEX IF NOT EXISTS peakos_commission_calculation_owner_date_idx
  ON public.peakos_commission_calculation_ledger
    (workspace_id, source_owner_uid, source_business_date DESC, calculated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS peakos_commission_calculation_source_idx
  ON public.peakos_commission_calculation_ledger
    (workspace_id, source_intake_id, source_row_version DESC, calculated_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.peakos_commission_reject_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $commission_reject_mutation$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000',
          CONSTRAINT = 'peakos_commission_append_only';
END
$commission_reject_mutation$;

CREATE OR REPLACE FUNCTION public.peakos_commission_guard_rule_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $commission_guard_rule_version$
DECLARE
  predecessor public.peakos_commission_rule_versions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('peakos-commission-rule:' || NEW.workspace_id));

  IF NEW.version = 1 THEN
    IF EXISTS (
      SELECT 1 FROM public.peakos_commission_rule_versions rule
       WHERE rule.workspace_id = NEW.workspace_id
         AND rule.rule_series_id = NEW.rule_series_id
    ) THEN
      RAISE EXCEPTION 'commission rule series already exists'
        USING ERRCODE = '23505',
              CONSTRAINT = 'peakos_commission_rule_versions_series_version_unique';
    END IF;
  ELSE
    SELECT rule.* INTO predecessor
      FROM public.peakos_commission_rule_versions rule
     WHERE rule.workspace_id = NEW.workspace_id
       AND rule.id = NEW.supersedes_id
       AND rule.rule_series_id = NEW.rule_series_id
       AND rule.version = NEW.version - 1
     FOR KEY SHARE;
    IF NOT FOUND OR EXISTS (
      SELECT 1 FROM public.peakos_commission_rule_versions newer
       WHERE newer.workspace_id = NEW.workspace_id
         AND newer.rule_series_id = NEW.rule_series_id
         AND newer.version >= NEW.version
    ) THEN
      RAISE EXCEPTION 'commission rule predecessor is stale or invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_commission_rule_predecessor_check';
    END IF;

    IF NEW.status = 'APPROVED' AND predecessor.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only a draft commission rule can be approved'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_commission_rule_transition_check';
    ELSIF NEW.status = 'ENDED' AND predecessor.status <> 'APPROVED' THEN
      RAISE EXCEPTION 'only an approved commission rule can be ended'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_commission_rule_transition_check';
    END IF;

    IF NEW.scope_owner_uid IS DISTINCT FROM predecessor.scope_owner_uid
       OR NEW.scope_platform IS DISTINCT FROM predecessor.scope_platform
       OR NEW.scope_product_a IS DISTINCT FROM predecessor.scope_product_a
       OR NEW.scope_product_b IS DISTINCT FROM predecessor.scope_product_b
       OR NEW.scope_product_c IS DISTINCT FROM predecessor.scope_product_c
       OR NEW.rate_basis_points IS DISTINCT FROM predecessor.rate_basis_points
       OR NEW.effective_from IS DISTINCT FROM predecessor.effective_from
       OR (NEW.status = 'APPROVED' AND NEW.effective_to IS DISTINCT FROM predecessor.effective_to)
       OR (NEW.status = 'ENDED' AND NEW.effective_to IS NULL) THEN
      RAISE EXCEPTION 'commission rule scope/rate is immutable across lifecycle versions'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_commission_rule_snapshot_check';
    END IF;
  END IF;

  IF NEW.status = 'APPROVED' AND EXISTS (
    SELECT 1
      FROM public.peakos_commission_rule_versions other
     WHERE other.workspace_id = NEW.workspace_id
       AND other.rule_series_id <> NEW.rule_series_id
       AND other.status IN ('APPROVED', 'ENDED')
       AND NOT EXISTS (
         SELECT 1 FROM public.peakos_commission_rule_versions newer
          WHERE newer.workspace_id = other.workspace_id
            AND newer.rule_series_id = other.rule_series_id
            AND newer.version > other.version
       )
       AND daterange(other.effective_from, other.effective_to, '[)')
           && daterange(NEW.effective_from, NEW.effective_to, '[)')
       AND (other.scope_owner_uid IS NULL OR NEW.scope_owner_uid IS NULL
            OR other.scope_owner_uid = NEW.scope_owner_uid)
       AND (other.scope_platform IS NULL OR NEW.scope_platform IS NULL
            OR other.scope_platform = NEW.scope_platform)
       AND (other.scope_product_a IS NULL OR NEW.scope_product_a IS NULL
            OR other.scope_product_a = NEW.scope_product_a)
       AND (other.scope_product_b IS NULL OR NEW.scope_product_b IS NULL
            OR other.scope_product_b = NEW.scope_product_b)
       AND (other.scope_product_c IS NULL OR NEW.scope_product_c IS NULL
            OR other.scope_product_c = NEW.scope_product_c)
  ) THEN
    RAISE EXCEPTION 'approved commission rule scopes overlap'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_commission_rule_overlap_check';
  END IF;

  RETURN NEW;
END
$commission_guard_rule_version$;

CREATE OR REPLACE FUNCTION public.peakos_commission_guard_calculation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $commission_guard_calculation$
DECLARE
  source public.peakos_intake%ROWTYPE;
  selected_rule public.peakos_commission_rule_versions%ROWTYPE;
  matching_rule_count INTEGER;
  normalized_platform TEXT;
  expected_source_snapshot JSONB;
  expected_rule_snapshot JSONB;
  vendor_item public.peakos_vendor_settlement_items%ROWTYPE;
  vendor_evidence_complete BOOLEAN := FALSE;
BEGIN
  SELECT value.* INTO source
    FROM public.peakos_intake value
   WHERE value.workspace_id = NEW.workspace_id
     AND value.id = NEW.source_intake_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commission source does not exist in the selected workspace'
      USING ERRCODE = '23503',
            CONSTRAINT = 'peakos_commission_calculation_source_workspace_check';
  END IF;

  normalized_platform := CASE
    WHEN NULLIF(btrim(COALESCE(source.source_metadata->>'provider', '')), '') IN (
      'rewardspace', 'reviewspace', 'keywordmaster', 'brandautospace', 'reviewflow'
    ) THEN NULLIF(btrim(source.source_metadata->>'provider'), '')
    ELSE NULL
  END;

  expected_source_snapshot := jsonb_build_object(
    'id', source.id,
    'ownerUid', source.owner_uid,
    'ownerName', COALESCE(source.owner_name, ''),
    'businessDate', source.date,
    'rowVersion', source.row_version,
    'kind', source.kind,
    'platform', normalized_platform,
    'product', jsonb_build_object(
      'a', COALESCE(source.a, ''),
      'b', COALESCE(source.b, ''),
      'c', COALESCE(source.c, '')
    ),
    'qty', source.qty,
    'sellPerUnit', source.sell,
    'salespersonUnit', source.unit
  );

  IF NEW.source_owner_uid IS DISTINCT FROM source.owner_uid
     OR NEW.source_owner_name IS DISTINCT FROM COALESCE(source.owner_name, '')
     OR NEW.source_business_date IS DISTINCT FROM source.date
     OR NEW.source_row_version IS DISTINCT FROM source.row_version
     OR NEW.source_kind IS DISTINCT FROM source.kind
     OR NEW.source_platform IS DISTINCT FROM normalized_platform
     OR NEW.source_product_a IS DISTINCT FROM COALESCE(source.a, '')
     OR NEW.source_product_b IS DISTINCT FROM COALESCE(source.b, '')
     OR NEW.source_product_c IS DISTINCT FROM COALESCE(source.c, '')
     OR NEW.source_qty IS DISTINCT FROM source.qty
     OR NEW.source_sell_per_unit IS DISTINCT FROM source.sell
     OR NEW.source_salesperson_unit IS DISTINCT FROM source.unit
     OR NEW.source_snapshot IS DISTINCT FROM expected_source_snapshot THEN
    RAISE EXCEPTION 'commission source snapshot does not match the canonical intake row'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_commission_calculation_source_snapshot_check';
  END IF;

  SELECT COUNT(*) INTO matching_rule_count
    FROM public.peakos_commission_rule_versions rule
   WHERE rule.workspace_id = NEW.workspace_id
     AND rule.status IN ('APPROVED', 'ENDED')
     AND NOT EXISTS (
       SELECT 1 FROM public.peakos_commission_rule_versions newer
        WHERE newer.workspace_id = rule.workspace_id
          AND newer.rule_series_id = rule.rule_series_id
          AND newer.version > rule.version
     )
     AND rule.effective_from <= source.date
     AND (rule.effective_to IS NULL OR source.date < rule.effective_to)
     AND (rule.scope_owner_uid IS NULL OR rule.scope_owner_uid = source.owner_uid)
     AND (rule.scope_platform IS NULL OR rule.scope_platform = normalized_platform)
     AND (rule.scope_product_a IS NULL OR rule.scope_product_a = COALESCE(source.a, ''))
     AND (rule.scope_product_b IS NULL OR rule.scope_product_b = COALESCE(source.b, ''))
     AND (rule.scope_product_c IS NULL OR rule.scope_product_c = COALESCE(source.c, ''));

  IF NEW.calculation_status = 'CALCULATED' THEN
    IF matching_rule_count <> 1 THEN
      RAISE EXCEPTION 'calculated commission requires exactly one current approved rule'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_commission_calculation_rule_count_check';
    END IF;
    SELECT rule.* INTO STRICT selected_rule
      FROM public.peakos_commission_rule_versions rule
     WHERE rule.workspace_id = NEW.workspace_id
       AND rule.id = NEW.rule_version_id;
    IF selected_rule.status NOT IN ('APPROVED', 'ENDED')
       OR EXISTS (
         SELECT 1 FROM public.peakos_commission_rule_versions newer
          WHERE newer.workspace_id = selected_rule.workspace_id
            AND newer.rule_series_id = selected_rule.rule_series_id
            AND newer.version > selected_rule.version
       )
       OR selected_rule.effective_from > source.date
       OR (selected_rule.effective_to IS NOT NULL AND source.date >= selected_rule.effective_to)
       OR (selected_rule.scope_owner_uid IS NOT NULL AND selected_rule.scope_owner_uid <> source.owner_uid)
       OR (selected_rule.scope_platform IS NOT NULL AND selected_rule.scope_platform IS DISTINCT FROM normalized_platform)
       OR (selected_rule.scope_product_a IS NOT NULL AND selected_rule.scope_product_a <> COALESCE(source.a, ''))
       OR (selected_rule.scope_product_b IS NOT NULL AND selected_rule.scope_product_b <> COALESCE(source.b, ''))
       OR (selected_rule.scope_product_c IS NOT NULL AND selected_rule.scope_product_c <> COALESCE(source.c, ''))
       OR NEW.rule_series_id IS DISTINCT FROM selected_rule.rule_series_id
       OR NEW.rule_version IS DISTINCT FROM selected_rule.version
       OR NEW.rate_basis_points IS DISTINCT FROM selected_rule.rate_basis_points THEN
      RAISE EXCEPTION 'commission rule snapshot is stale or does not match its source'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_commission_calculation_rule_snapshot_check';
    END IF;

    expected_rule_snapshot := jsonb_build_object(
      'id', selected_rule.id,
      'seriesId', selected_rule.rule_series_id,
      'version', selected_rule.version,
      'status', selected_rule.status,
      'scope', jsonb_build_object(
        'ownerUid', selected_rule.scope_owner_uid,
        'platform', selected_rule.scope_platform,
        'productA', selected_rule.scope_product_a,
        'productB', selected_rule.scope_product_b,
        'productC', selected_rule.scope_product_c
      ),
      'rateBasisPoints', selected_rule.rate_basis_points,
      'effectiveFrom', selected_rule.effective_from,
      'effectiveTo', selected_rule.effective_to
    );
    IF NEW.rule_snapshot IS DISTINCT FROM expected_rule_snapshot THEN
      RAISE EXCEPTION 'commission rule JSON snapshot does not match its immutable version'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_commission_calculation_rule_snapshot_check';
    END IF;
  ELSIF NEW.calculation_status = 'UNCONFIGURED' AND matching_rule_count <> 0 THEN
    RAISE EXCEPTION 'unconfigured result has an applicable commission rule'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_commission_calculation_rule_count_check';
  ELSIF NEW.calculation_status = 'RULE_OVERLAP' AND matching_rule_count < 2 THEN
    RAISE EXCEPTION 'overlap result requires multiple applicable commission rules'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_commission_calculation_rule_count_check';
  END IF;

  IF NEW.calculation_status = 'SOURCE_INCOMPLETE'
     AND source.qty IS NOT NULL AND source.qty = trunc(source.qty)
     AND source.sell IS NOT NULL AND source.sell = trunc(source.sell)
     AND source.unit IS NOT NULL AND source.unit = trunc(source.unit) THEN
    RAISE EXCEPTION 'source incomplete result does not match the canonical amounts'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_commission_calculation_source_status_check';
  ELSIF NEW.calculation_status = 'SOURCE_INELIGIBLE'
     AND source.kind IN ('normal', 'use')
     AND source.qty IS NOT NULL AND source.qty > 0
     AND source.qty = trunc(source.qty)
     AND source.sell IS NOT NULL AND source.sell >= 0
     AND source.sell = trunc(source.sell)
     AND source.unit IS NOT NULL AND source.unit >= 0
     AND source.unit = trunc(source.unit)
     AND (source.sell - source.unit) * source.qty > 0 THEN
    RAISE EXCEPTION 'source ineligible result does not match the canonical amounts'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_commission_calculation_source_status_check';
  ELSIF NEW.calculation_status IN ('CALCULATED', 'UNCONFIGURED', 'RULE_OVERLAP')
     AND (source.kind NOT IN ('normal', 'use')
       OR source.qty IS NULL OR source.qty <= 0
       OR source.qty <> trunc(source.qty)
       OR source.sell IS NULL OR source.sell < 0
       OR source.sell <> trunc(source.sell)
       OR source.unit IS NULL OR source.unit < 0
       OR source.unit <> trunc(source.unit)
       OR (source.sell - source.unit) * source.qty <= 0) THEN
    RAISE EXCEPTION 'commission result requires an eligible positive-margin source'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_commission_calculation_source_status_check';
  END IF;

  SELECT item.* INTO vendor_item
    FROM public.peakos_vendor_settlement_items item
   WHERE item.workspace_id = NEW.workspace_id
     AND item.source_intake_id = NEW.source_intake_id;
  IF FOUND THEN
    IF NEW.vendor_batch_id IS DISTINCT FROM vendor_item.batch_id
       OR NEW.vendor_source_settled_row_version IS DISTINCT FROM vendor_item.source_settled_row_version THEN
      RAISE EXCEPTION 'commission vendor reconciliation snapshot is inconsistent'
        USING ERRCODE = '23514',
              CONSTRAINT = 'peakos_commission_calculation_vendor_snapshot_check';
    END IF;
    vendor_evidence_complete := source.vendor_paid IS TRUE
      AND source.row_version = vendor_item.source_settled_row_version;
  ELSIF NEW.vendor_batch_id IS NOT NULL OR NEW.vendor_source_settled_row_version IS NOT NULL THEN
    RAISE EXCEPTION 'commission references missing vendor reconciliation evidence'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_commission_calculation_vendor_snapshot_check';
  END IF;

  IF NEW.calculation_status = 'CALCULATED'
     AND (NEW.payout_blockers ? 'SUPPLIER_RECONCILIATION_INCOMPLETE')
       IS DISTINCT FROM (NOT vendor_evidence_complete) THEN
    RAISE EXCEPTION 'commission supplier reconciliation blocker is inconsistent'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_commission_calculation_payout_evidence_check';
  END IF;

  -- peakos_intake와 peakos_monthly 완료 원장은 canonical FK가 없다. 이름/날짜
  -- 기반 추측으로 지급 확정을 만들지 않고, 후속 completion link migration 전
  --까지 immutable ledger는 예상 수당만 허용한다.
  IF NEW.payout_eligible THEN
    RAISE EXCEPTION 'commission payout is unavailable until canonical intake completion evidence exists'
      USING ERRCODE = '23514',
            CONSTRAINT = 'peakos_commission_calculation_payout_evidence_check';
  END IF;

  RETURN NEW;
END
$commission_guard_calculation$;

DROP TRIGGER IF EXISTS peakos_commission_rule_versions_guard
  ON public.peakos_commission_rule_versions;
CREATE TRIGGER peakos_commission_rule_versions_guard
  BEFORE INSERT ON public.peakos_commission_rule_versions
  FOR EACH ROW EXECUTE FUNCTION public.peakos_commission_guard_rule_version();
DROP TRIGGER IF EXISTS peakos_commission_rule_versions_no_mutation
  ON public.peakos_commission_rule_versions;
CREATE TRIGGER peakos_commission_rule_versions_no_mutation
  BEFORE UPDATE OR DELETE ON public.peakos_commission_rule_versions
  FOR EACH ROW EXECUTE FUNCTION public.peakos_commission_reject_mutation();
DROP TRIGGER IF EXISTS peakos_commission_rule_versions_no_truncate
  ON public.peakos_commission_rule_versions;
CREATE TRIGGER peakos_commission_rule_versions_no_truncate
  BEFORE TRUNCATE ON public.peakos_commission_rule_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.peakos_commission_reject_mutation();
DROP TRIGGER IF EXISTS peakos_commission_calculation_ledger_guard
  ON public.peakos_commission_calculation_ledger;
CREATE TRIGGER peakos_commission_calculation_ledger_guard
  BEFORE INSERT ON public.peakos_commission_calculation_ledger
  FOR EACH ROW EXECUTE FUNCTION public.peakos_commission_guard_calculation();
DROP TRIGGER IF EXISTS peakos_commission_calculation_ledger_no_mutation
  ON public.peakos_commission_calculation_ledger;
CREATE TRIGGER peakos_commission_calculation_ledger_no_mutation
  BEFORE UPDATE OR DELETE ON public.peakos_commission_calculation_ledger
  FOR EACH ROW EXECUTE FUNCTION public.peakos_commission_reject_mutation();
DROP TRIGGER IF EXISTS peakos_commission_calculation_ledger_no_truncate
  ON public.peakos_commission_calculation_ledger;
CREATE TRIGGER peakos_commission_calculation_ledger_no_truncate
  BEFORE TRUNCATE ON public.peakos_commission_calculation_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION public.peakos_commission_reject_mutation();

DO $commission_acl$
DECLARE
  configured_role TEXT := NULLIF(current_setting('peakos.app_role', TRUE), '');
  application_role TEXT;
  migration_owner TEXT := current_user;
  function_signature TEXT;
BEGIN
  IF configured_role IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = configured_role) THEN
      RAISE EXCEPTION 'configured peakos.app_role does not exist';
    END IF;
    application_role := configured_role;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
    application_role := 'calendar_user';
  ELSE
    RAISE EXCEPTION 'set peakos.app_role before applying commission migration';
  END IF;
  IF application_role = migration_owner THEN
    RAISE EXCEPTION 'commission migration must run as an operator role, not the runtime role';
  END IF;

  EXECUTE format('ALTER TABLE public.peakos_commission_rule_versions OWNER TO %I', migration_owner);
  EXECUTE format('ALTER TABLE public.peakos_commission_calculation_ledger OWNER TO %I', migration_owner);
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE public.peakos_commission_rule_versions, public.peakos_commission_calculation_ledger FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE public.peakos_commission_rule_versions, public.peakos_commission_calculation_ledger TO %I',
    application_role
  );

  FOREACH function_signature IN ARRAY ARRAY[
    'public.peakos_commission_reject_mutation()',
    'public.peakos_commission_guard_rule_version()',
    'public.peakos_commission_guard_calculation()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', function_signature, migration_owner);
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, %I', function_signature, application_role);
  END LOOP;
END
$commission_acl$;

COMMIT;
