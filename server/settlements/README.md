# PEAK OS settlement completion

This module is the fail-closed eligibility and lifecycle boundary for the
special monthly settlement ledgers. It does not derive completion evidence
from legacy dates, notes, quantities, or imported rows.

## Rules

- `DIRECT_EXECUTION_8TH`: an explicit completed issue count of at least 8 and
  an explicit eighth-issue completion timestamp.
- `MONTHLY_GUARANTEE_25D`: explicit exposure start and completion timestamps
  spanning at least 25 full days.
- `PER_ITEM_24H`: explicit exposure start and completion timestamps spanning
  at least 24 full hours.
- `MONTHLY_MANAGEMENT_30D`: explicit service start and completion timestamps
  spanning at least 30 full days.

All timestamps must carry an offset. API and database policy evaluate them
against `Asia/Seoul`; missing or future evidence remains pending. Recording
eligible evidence never completes a settlement automatically.

## Operator rollout

1. Take and verify a fresh database backup.
2. Complete the approved settlement source refresh workflow first.
3. As the database owner/operator, set `peakos.app_role` to the non-owner
   runtime role and apply
   `server/migrations/20260818_peakos_settlement_completion.sql`.
4. Start the application. Startup calls
   `ensureSettlementCompletionInfrastructure`, which is SELECT-only and
   refuses to start on schema, definition-hash, ownership, or ACL drift.
5. Confirm that existing source rows return `tracked: false`, `rowVersion: 0`,
   and explicit pending-evidence reasons. Do not bulk-create cases or backfill
   evidence.

Do not run the migration as the runtime role. Do not drop the case/audit
tables as a rollback once operators have recorded evidence; the audit history
is intentionally append-only.

## API and permissions

- `GET /api/peakos/settlement-completion/:sourceId`
- `GET /api/peakos/settlement-completion/:sourceId/audit`
- `PUT /api/peakos/settlement-completion/:sourceId/evidence`
- `POST /api/peakos/settlement-completion/:sourceId/{complete|freeze|reopen}`

Reads are workspace-scoped. The source owner, direct workspace
manager/admin, headquarters oversight, and the existing exact final-execution
viewer capability can read. Only a direct manager/admin with
`settlements:write` can record evidence, complete, or freeze. Reopen is
admin-only. Account preview and oversight are always mutation-free.

Every mutation requires an eight-character-or-longer reason and the exact
current `expectedVersion`. Completed and frozen cases lock the source monthly
row at the database layer until an administrator explicitly reopens it.
