# PeakOS company resources foundation

This module provides workspace-scoped empty ledgers and protected uploads for:

- equipment usage;
- development costs with a required evidence document;
- bank-copy documents;
- other company-material documents.

It does not seed company policies or document contents. It also does not write
to a bank or initiate any transfer.

## Operator prerequisites

1. Provision `PEAKOS_COMPANY_RESOURCE_ROOT` outside the repository and public
   `uploads` tree. The root must already exist, be a real directory (not a
   symlink), and have mode `0700`.
2. Apply `server/migrations/20260818_peakos_company_resources.sql` as an
   operator role, with `peakos.app_role` set to the application runtime role.
   Do not apply it as the runtime role.
3. Run `ensurePeakosCompanyResourceInfrastructure(pool)` at startup before
   registering the routes. Readiness is intentionally exact and fails closed
   on unexpected columns/triggers, altered constraints/functions, RLS/owner
   drift, or broader runtime ACLs.
4. Register `registerPeakosCompanyResourceRoutes` behind the normal PeakOS
   authentication/workspace middleware and inject the existing exact-UID
   `canSeeFinanceOperations`, `canReviewFinance`, and server display-name
   helpers. Client persona/display-name constants are not authorization.

The runtime can select/insert/update the three root tables only. Database
triggers restrict updates to void/archive transitions and write append-only
audit rows. Runtime users cannot insert/update/delete audit rows or execute the
trigger functions directly.

## Protected-file contract

Uploads are held in memory up to 20 MB, then validated from their bytes as a
conservative PDF, PNG, or JPEG. The declared MIME type must match. Files are
published under a server-generated UUID filename with mode `0600` inside a
workspace `0700` directory. Reads re-check path, owner, mode, size, MIME, and
SHA-256. Stored keys and checksums are not returned in browser list/audit
responses.
