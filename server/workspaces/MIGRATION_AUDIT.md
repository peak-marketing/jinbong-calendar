# PEAK OS multi-workspace migration audit

This is a read-only design and release-gate review. It does not authorize applying
the migration, changing production data, or copying existing operational rows.

## Required isolation invariants

- The canonical workspaces are `peak`, `build-solution`, `jeonju`, and `daegu`.
- Every protected OS read and mutation resolves an active membership from the
  immutable UID and the required `X-PeakOS-Workspace` header. Canonical legacy
  collaboration routes resolve the UID's direct default membership; they never
  accept a display name or silently fall back to Peak.
- Existing rows are backfilled only to `peak`. The other three workspaces start with
  no calendar, chat, project, settlement, document, bank, credit, or finance rows.
- The four configured HQ oversight UIDs can read branch projects, settlements, and
  documents. They cannot read branch calendar/chat and cannot mutate any branch
  resource.
- Direct members can only list and invite direct members of the same workspace.
  Oversight membership is not an invitation target.
- Every resource lookup includes both its ID and active workspace ID. Knowing a
  cross-workspace ID must produce the same not-found/forbidden result as an unknown ID.
- Price catalogs are not a shared singleton. Each workspace receives exactly the 165
  versioned base defaults. Existing Peak overrides/custom rows stay in Peak and are
  not cloned into Build Solution, Jeonju, or Daegu.

## Migration and backfill hazards

1. `events` is the largest observed root (about 95k live rows and 57 MB at audit
   time). Adding a populated `NOT NULL` column, validating constraints, and building
   indexes in one boot query can hold locks long enough to interrupt production.
   Add nullable columns first, backfill in bounded batches, create supporting indexes
   in a separately operated phase, validate, and only then enforce `NOT NULL`.
2. `peakos_price` currently uses `key` as its global primary key. Workspace catalogs
   require `(workspace_id, key)` uniqueness (or a surrogate primary key plus that
   unique constraint). Every read, update, delete, and upsert must bind workspace ID.
3. `peakos_fund` currently enforces one global row with `id = 1`. It must become one
   row per workspace, for example a workspace primary key or
   `(workspace_id, board_id)`; the existing `ON CONFLICT (id)` path is unsafe.
   The read path must also bind workspace ID; `WHERE id = 1` alone becomes ambiguous.
4. Current settlement import lineage uniqueness is global. Intake/monthly lineage,
   requester idempotency, and external document uniqueness need an explicit decision:
   provider-global IDs may remain global, but workspace-local IDs must include
   `workspace_id` in their unique index.
5. Parent/child links must prove same-workspace ancestry. This includes intake
   `ref_of`, monthly `parent_id`, bank transaction/allocation/intake links, credit and
   finance bank links, import run/items/quarantine, chat room/group/member/message
   links, project children, and events linked to projects. A root column alone does
   not protect child tables queried directly.
6. Fixed bank account IDs and account fingerprints need a policy before branch bank
   support. If account definitions can repeat across workspaces, keys and provider
   transaction uniqueness must be workspace-aware; otherwise bank rows should remain
   Peak-only and branch APIs must return empty data.
7. File-backed company documents must keep the database scope and filesystem scope
   aligned. The branch read path now resolves only
   `<private-root>/<workspace_id>/<stored_key>`, verifies metadata and SHA-256, and
   constrains `(workspace_id, stored_key)`, category, MIME, and stored-key syntax.
   Branch document writes remain disabled until a private atomic uploader exists.
8. `chat_room_groups`, ideas, service requests, reminders, default share members, and
   background jobs can leak or mutate cross-workspace data even if only
   `events/chat_rooms/projects` receive a column. Each direct query and scheduled job
   needs a workspace source and predicate.
9. Migration order is a hard compatibility boundary. The workspace migration changes
   the `peakos_price` and `peakos_fund` primary keys. Legacy
   `ON CONFLICT (key)`/`ON CONFLICT (id)` statements stop matching a unique constraint
   immediately, and the workspace-aware price seeder needs `workspace_id` to exist.
   Deploy compatible queries and run workspace schema creation before catalog seeding;
   do not apply only one side of that change.
10. Settlement tombstones that retain a global `target_id` primary key make a deletion
    in Peak block the same opaque ID in every branch. The workspace migration converts
    both tombstone keys to `(workspace_id, target_id)` and writes workspace IDs into
    audit rows. Import run, apply, dependency validation, and rollback remain explicitly
    pinned to `ws_peak`; their manifest fingerprint intentionally stays unchanged.
11. The legacy public `/uploads` directory is not tenant storage. Non-Peak chat and
    project upload mutations are rejected before Multer runs, so a branch request
    cannot create a file or mint a new `/uploads/*` URL. Existing public attachments
    remain a Peak-only legacy surface.
12. The production application role does not own the legacy collaboration tables.
    Server startup therefore performs SELECT-only workspace schema readiness checks
    and never replays the owner migration. Apply the settlement-import migration,
    then the workspace migration as an owner/DBA before deploying the compatible
    server. For a runtime role other than `calendar_user`, set
    `peakos.app_role` in that operator session; the workspace migration grants only
    the SELECT/DML/sequence privileges used by the runtime service and never changes
    ownership of existing tables.

## Safe rollout gates

1. Take a restorable backup and record pre-migration counts/checksums by table.
2. As the owning DBA, apply settlement-import schema first and then the additive
   workspace/membership tables and nullable root columns. Do not rely on application
   startup to apply either owner migration.
3. Backfill legacy roots to `peak` in bounded, resumable batches; never use
   `INSERT ... SELECT` to clone operational data to the other workspaces.
4. Seed the 165 immutable base price definitions into each workspace. Preserve
   existing Peak custom/override values only in `peak`.
5. Add workspace-aware unique indexes and same-workspace foreign-key/trigger guards;
   validate them after the backfill.
6. Deploy server fail-closed scoping and verify list, IDOR, mutation, directory, and
   oversight tests before exposing the workspace selector. Confirm the application
   role passes the startup readiness probe without any `ALTER`/`CREATE` statement.
7. Compare post-migration Peak counts with pre-migration counts and verify zero
   operational rows in the three new workspaces.
8. Only after the checks pass, enforce `NOT NULL` and remove any temporary legacy Peak
   fallback. Keep the fallback unavailable for new workspace routes.

`CREATE INDEX CONCURRENTLY` must not be placed in a migration runner that wraps the
whole file in one transaction. Schedule those indexes as an explicit DBA phase or use
the repository's supported non-transactional migration mechanism.
