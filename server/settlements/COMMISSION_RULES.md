# Commission rule and estimate contract

This module deliberately keeps `영업이익` and `예상 수당` as different
values. It never renames or reuses the existing profit fields.

## Formula and source

For an eligible positive intake row, the server recomputes:

```text
sales amount             = sell per unit × quantity
salesperson supply amount = salesperson unit × quantity
commission base           = sales amount − salesperson supply amount
estimated commission      = round(commission base × rate basis points / 10,000)
```

The browser cannot submit any of these calculated amounts. The immutable
ledger stores the intake row version, a SHA-256 snapshot fingerprint, the
exact rule version/snapshot, supplier reconciliation evidence, formula
inputs, and formula output.

- No matching approved/effective rule: `UNCONFIGURED`, amount `null`.
- More than one matching rule: `RULE_OVERLAP`, amount `null`.
- Refund, reserve, non-positive quantity, negative price, or non-positive
  margin: `SOURCE_INELIGIBLE`, amount `null`.
- Missing/non-integer source values: `SOURCE_INCOMPLETE`, amount `null`.
- One matching rule: `CALCULATED`; this release still exposes an estimate only.
  Supplier reconciliation is recorded, but `peakos_intake` and the existing
  `peakos_monthly` completion cases have no canonical source FK. They are never
  joined by name/date. Therefore every calculated row remains
  `payoutEligible: false` with `SETTLEMENT_COMPLETION_UNCONFIRMED` until a
  dedicated intake-completion link migration is reviewed and applied.

No migration creates a default rate or backfills a calculation.

## Rule lifecycle

Rules are workspace-scoped, effective-dated, and append-only. A series is
created as `DRAFT`, approved by inserting an `APPROVED` version, and ended by
inserting an `ENDED` version with an exclusive `effectiveTo` date. An ended
rule still applies to historical sales before that date. A database trigger
rejects any two current rule series whose dates and wildcard/exact scopes
could match the same source row.

Scope dimensions are optional salesperson, one of the five platform codes,
and hierarchical product A/B/C. Rates are explicit integer basis points from
0 through 10,000.

## API contract

- `GET /api/peakos/commission-estimates`
  - read-only, current-source estimates; defaults to the current KST month;
    maximum range is 366 days.
  - ordinary users are forced to their own UID even if they submit another
    `ownerUid`.
- `GET /api/peakos/commission-calculations`
  - immutable calculation history; ordinary users only see their own.
- `POST /api/peakos/commission-calculations/:sourceId`
  - manager/admin with `settlements:write`; requires the exact source row
    version and persists the server result idempotently.
- `GET|POST /api/peakos/commission-rules`
- `POST /api/peakos/commission-rules/:seriesId/approve`
- `POST /api/peakos/commission-rules/:seriesId/end`
  - rule reads are manager/admin/oversight; rule mutations are direct
    manager/admin with `settlements:write` only.

Every endpoint rejects account-preview headers before a database request.
Headquarters oversight is read-only, selected-workspace scoped, and receives
masked calculation DTOs without source IDs, salesperson unit amounts, rule
IDs, or actor details.

## UI contract

The minimum UI adds a separate `예상 수당`/`규칙 미설정` area and labels all
amounts as `예상 · 지급확정 아님`. It must not
change any existing `영업이익` heading or total. Async responses must be
discarded when the active workspace, view, or view-generation token changed
after the request began. Preview mode must render a local read-only notice and
must make zero commission API requests.

## Operator rollout

After a verified backup and the vendor reconciliation migration, apply
`20260818_peakos_commission_rules.sql` as an operator with `peakos.app_role`
set to the non-owner runtime role. Startup readiness is SELECT-only and pins
all security-relevant columns, constraints, indexes, trigger definitions,
function bodies, ownership, and runtime/public ACLs. Do not apply this
migration automatically and do not insert guessed rates.
