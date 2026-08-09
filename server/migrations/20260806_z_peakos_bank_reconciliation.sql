-- Conservative, exact-only bank-to-intake reconciliation support.
-- Run after 20260806_peakos_banking.sql and after peakos_intake exists.

ALTER TABLE peakos_intake
  ADD COLUMN IF NOT EXISTS expected_payer TEXT,
  ADD COLUMN IF NOT EXISTS bank_match_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bank_match_approved_by_uid TEXT,
  ADD COLUMN IF NOT EXISTS bank_match_approved_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'peakos_intake'::regclass
       AND conname = 'peakos_intake_expected_payer_length_check'
  ) THEN
    ALTER TABLE peakos_intake
      ADD CONSTRAINT peakos_intake_expected_payer_length_check
      CHECK (expected_payer IS NULL OR char_length(expected_payer) <= 120)
      NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'peakos_intake'::regclass
       AND conname = 'peakos_intake_bank_match_approval_state_check'
  ) THEN
    ALTER TABLE peakos_intake
      ADD CONSTRAINT peakos_intake_bank_match_approval_state_check CHECK (
        (bank_match_eligible = FALSE
          AND bank_match_approved_by_uid IS NULL
          AND bank_match_approved_at IS NULL)
        OR
        (bank_match_eligible = TRUE
          AND bank_match_approved_by_uid IS NOT NULL
          AND bank_match_approved_at IS NOT NULL)
      ) NOT VALID;
  END IF;
END
$$;

-- NOT VALID preserves startup safety if an old/manual allocation references a
-- deleted intake. PostgreSQL still enforces the FK for every new allocation.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'peakos_bank_allocations'::regclass
       AND conname = 'peakos_bank_allocations_intake_fk'
  ) THEN
    ALTER TABLE peakos_bank_allocations
      ADD CONSTRAINT peakos_bank_allocations_intake_fk
      FOREIGN KEY (intake_id) REFERENCES peakos_intake(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE peakos_intake
  VALIDATE CONSTRAINT peakos_intake_expected_payer_length_check;

ALTER TABLE peakos_intake
  VALIDATE CONSTRAINT peakos_intake_bank_match_approval_state_check;

-- Orphan allocation이 있으면 조용히 자동매칭하지 않고 배포를 중단한다.
ALTER TABLE peakos_bank_allocations
  VALIDATE CONSTRAINT peakos_bank_allocations_intake_fk;

-- A transaction and an intake may each participate in at most one active
-- allocation. Reversals remain in the audit trail and do not block a later
-- corrected allocation.
CREATE UNIQUE INDEX IF NOT EXISTS peakos_bank_allocations_one_active_transaction_idx
  ON peakos_bank_allocations(transaction_id)
  WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS peakos_bank_allocations_one_active_intake_idx
  ON peakos_bank_allocations(intake_id)
  WHERE status = 'ACTIVE';

-- Narrow the candidate scan to unpaid normal/reserve intake rows. Party-name
-- normalization is deliberately performed in application code so this index
-- never embeds locale- or extension-dependent behavior.
CREATE INDEX IF NOT EXISTS peakos_intake_bank_match_candidate_idx
  ON peakos_intake (
    kind,
    ((COALESCE(sell, 0)::numeric * COALESCE(qty, 0)::numeric)
      - COALESCE(paid_amount, 0)::numeric),
    created_at
  )
  WHERE kind IN ('normal', 'reserve')
    AND bank_match_eligible = TRUE
    AND ((COALESCE(sell, 0)::numeric * COALESCE(qty, 0)::numeric)
      - COALESCE(paid_amount, 0)::numeric) > 0;

CREATE INDEX IF NOT EXISTS peakos_intake_expected_payer_idx
  ON peakos_intake(expected_payer)
  WHERE expected_payer IS NOT NULL AND btrim(expected_payer) <> '';
