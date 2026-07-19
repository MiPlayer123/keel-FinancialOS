-- ---------------------------------------------------------------------------
-- Statement ingestion SLICE 4 — Storage widen + quarantine bucket.
--
-- Plan: docs/harness/plans/statement-ingestion-v2.md §6 [A9].
-- Cites: CLAUDE.md Law 5 (all ingested text is data-tier — a hostile
-- statement byte stream may never trigger tools/writes/fetches), Law 9
-- (source preservation — immutable originals), Law 12 (secret boundary);
-- INFRA.md §10 (private buckets; quarantine → validate → immutable version).
--
-- Two idempotent changes, guarded so a manual re-apply is a no-op (there is
-- no migration-history table for manual applies — CLAUDE.md ops facts):
--   1. Widen the `statements` bucket allowed_mime_types to accept the
--      statement machine formats (CSV / MS-Excel-exported CSV / OFX / QFX),
--      plus application/octet-stream. octet-stream is NEVER trusted here: the
--      edge function content-SNIFFS the downloaded bytes and only promotes a
--      file whose magic/structure positively identifies pdf|ofx|csv. The
--      widened allowlist only lets the bytes LAND in Storage; validation is
--      the confirm-upload boundary, not this list.
--   2. Create the private `quarantine` bucket (INFRA.md §10). Statement
--      uploads land here first; confirm-upload sniffs + validates and, on
--      pass, copies the exact bytes immutably into `statements`. An
--      unvalidated / hostile original never leaves quarantine and is never
--      served inline.
--
-- No storage.objects RLS policies for anon/authenticated on any bucket:
-- every read/write goes through signed URLs minted server-side by the edge
-- function's service-role client (same precedent as receipts/statements in
-- 20260717234500). The browser has no direct bucket access.
-- ---------------------------------------------------------------------------

-- 1. Widen the statements bucket. Idempotent: recompute the array in place
--    (an array literal, not an append) so a re-apply converges to one value.
update storage.buckets
set allowed_mime_types = array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'text/csv',
    'application/vnd.ms-excel',
    'application/x-ofx',
    'application/octet-stream'
  ]
where id = 'statements';

-- 2. Private quarantine bucket. Same size limit as receipts/statements; same
--    widened allowlist as statements (a statement upload targets the same set
--    of machine formats before it is sniffed + promoted). Private; no public
--    access. Guarded insert (INFRA.md §10). on-conflict converges an existing
--    quarantine bucket to the declared shape so re-apply is a no-op.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('quarantine', 'quarantine', false, 10485760,
   array[
     'image/jpeg',
     'image/png',
     'image/webp',
     'application/pdf',
     'text/csv',
     'application/vnd.ms-excel',
     'application/x-ofx',
     'application/octet-stream'
   ])
on conflict (id) do update
  set allowed_mime_types = excluded.allowed_mime_types,
      file_size_limit = excluded.file_size_limit,
      public = excluded.public;
