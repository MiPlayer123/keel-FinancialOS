# Stage 1D — Export build spec (Law 6 / BC-v2.1 gate 13)

The Data Access Guarantee: `admin.export_all` produces a complete, household-scoped,
reproducible export in **JSON + CSV + QIF + beancount**, with an **isolated-restore
proof**. Data portability is a feature, not a promise (CLAUDE.md Law 6).

Read first: CLAUDE.md (Law 6 export; Law 9 scope-safe; **Law 12 secret boundary**),
INFRA.md §16 (export placement in 1D), BC-v2.1 gate 13 (full export + isolated restore
reproduce cited records) + §9.1 (reproducible numbers). This spec = the EXPORT slice of
1D (the finance domains recurring/paycheck/statements are separate, later).

## Non-negotiable invariants
- **Law 9 (scope):** an export is ALWAYS scoped to ONE household and authorized (owner
  role). It reproduces exactly the caller's household data across API/reports/AI — never
  another tenant's row. Cross-household leakage = a blocker.
- **Law 12 (secret boundary):** the export **NEVER** includes `connection_credentials`
  (the encrypted token/DEK), KEK material, `plaid_webhook_keys`, or any secret. A user's
  own data is exported; their stored provider CREDENTIAL is not (it's re-linkable, not
  portable data). Red-team: the export bytes must contain no ciphertext/token/secret.
- **Completeness (gate 13 / prior 1C NOTES):** the manifest covers EVERY household-scoped
  domain table (the ledger + its lineage + provenance), plus the identity mapping
  (memberships → user ids, NOT auth secrets). A documented EXCLUDE list (with reason) for
  every non-exported table — silent omission is the bug the 1C audit flagged.
- **Reproducibility (§9.1):** the export carries `as_of`, scope (householdId), a manifest
  (table → row count + sha256), and format versions. Re-exporting the same as-of state
  yields byte-identical JSON (deterministic ordering).
- **Purity:** `packages/exports` imports NO Supabase/Next/provider/model SDK (like ledger).

## 1. Export manifest — which tables, and why (the audited contract)
INCLUDE (household-scoped domain data; every row filtered by `household_id = :hh`):
- Identity/structure: `households`, `entities`, `household_memberships`, `entity_memberships`,
  `accounts`, `account_owners`, `ledger_accounts`, `connections` (columns MINUS any secret;
  connections has none — safe), `resource_permissions`, `approval_policies`.
- Ledger (the money): `canonical_transactions`, `journal_batches`, `journal_postings`,
  `journal_revisions`, `period_locks`, `transaction_source_links`, `transfer_links`.
- Provenance/source proof (gate 13 "cited records"): `raw_provider_events` (body_text +
  sha256 — the verbatim source), `normalized_source_records`, `import_batches`, `import_rows`,
  `ingestion_skips`, `account_lineage`, `balance_snapshots`, `connection_health_events`.
- Audit trail: `audit_log`, `domain_events` (household-scoped rows).
EXCLUDE (with reason, in the manifest):
- `connection_credentials` — **Law 12: encrypted provider token, never exported.**
- `plaid_webhook_keys`, `webhook_rejections`, `webhook_rejection_counters`,
  `provider_call_budget`, `usage_events` (system telemetry, cross-tenant/global) — operational,
  not user data. (usage_events can carry null-household system rows → exclude wholesale.)
- `plaid_test_responses`, `plaid_webhook_key_test_responses`, `sync_test_pages` — test-only.
- `sync_attempts`, `sync_checkpoints`, `link_attempts`, `removal_attempts`, `command_executions` —
  transient operational state (cursors, attempts, idempotency keys); not portable finance data.
  (Document as intentionally excluded; the ledger + raw events fully reproduce the economic history.)
- `auth.users` — identity is exported as the membership mapping (user_id + email via a scoped
  view), NOT the auth secret rows.
The manifest is DATA (a const table list with include/exclude + reason), unit-tested so a
new table added later without a manifest decision FAILS a completeness test (a table in
`information_schema` not in the manifest → test error).

## 2. `packages/exports` (pure, 100% unit-tested)
Input: a typed `HouseholdExport` object (the pulled rows per included table, already
household-filtered) + `{ householdId, asOf }`. Outputs:
- `toJson(export): string` — canonical deterministic JSON (stable key order, rows sorted by
  id) = the portability/DR backup + the restore source. Includes the manifest + per-table
  sha256 + counts + format version.
- `toCsvFiles(export): {name, csv}[]` — one RFC-4180 CSV per included table (BIGINT minor as
  integer strings, no floats; proper quoting/escaping).
- `toQif(export): string` — ledger canonical_transactions → QIF (`!Type:Bank` etc.): date,
  amount (minor→decimal at the account currency scale, sign per KEEL holder perspective),
  payee (description), memo, category (offset ledger_account name). One QIF per asset account
  or a combined file with `!Account` headers. Amounts are the ONLY decimal formatting — from
  BIGINT minor, exact (Law 4).
- `toBeancount(export): string` — double-entry plain text: `open` directives per ledger
  account, one `txn` per journal_batch with its balanced postings (`Assets:... / Expenses:...`),
  amounts `minor/100` at scale, currency. Beancount must itself balance (Σ postings = 0) —
  a unit test runs the emitted beancount through a balance check.
- Property tests: round-trip JSON→parse→re-emit is byte-identical; every emitted format is
  parseable; QIF/beancount amounts reproduce the canonical minor totals; NO secret substring
  ever appears (fed a fixture with a fake ciphertext column, assert it's absent from all outputs).

## 3. Edge — `admin.export_all` command (api function)
- New authorized action `admin.export_all` (authz: household OWNER only — stricter than
  partner; add to the closed Action union + ACTION_MINIMUM_ROLES='owner' — extend MinimumRole
  with 'owner' if needed, or reuse the owner check). Fail-closed.
- A SECURITY DEFINER proc `keel_export_household(p_household_id uuid) returns jsonb` that,
  under the membership+owner check, SELECTs every INCLUDED table filtered by household_id and
  returns one JSON object `{asOf, householdId, tables:{name: rows[]}}`. It NEVER selects
  connection_credentials or the excluded tables (enforced in SQL, not just the app). Owned
  keel_api, execute→authenticated (self-service export). Deterministic ordering (order by id).
- The api route `POST /api/admin/export` (or a command) calls the proc, runs the pure
  exporters, and returns `{manifest, json, csv:[...], qif, beancount}` (inline for MVP; note
  Storage-upload + signed-URL as the scale path for large households → deferred).
- Reproducibility: the proc stamps `as_of = now()`; the response includes the manifest with
  per-table counts + sha256.

## 4. Restore proof (gate 13 "isolated restore reproduces cited records")
- **Pure reconstruction unit test:** take a JSON export fixture → parse → rebuild the ledger
  view (trial balance per ledger account from journal_postings) → assert it equals the
  exported canonical_transactions/trial-balance figures (cited records reproduce).
- **Integration test** (`tests/integration/11-export.test.ts`): seed/produce a household with
  real ledger data (reuse the sim or an injected sync); call `admin.export_all`; assert:
  (a) the JSON contains the household's accounts + canonical transactions + balanced journal
  postings; (b) trial_balance computed FROM the export equals `keel_trial_balance` from the
  live DB (reproducible numbers); (c) **NO connection_credentials / no excluded table / no
  token or ciphertext substring** anywhere in the export (Law 12 red-team); (d) a DIFFERENT
  household's rows are absent (Law 9 scope); (e) QIF + beancount parse and their amounts
  reconcile to the canonical minor totals; (f) the manifest lists every public table as
  include-or-exclude (completeness).
- **Isolated restore:** load the JSON into a fresh scratch schema (or a pure in-memory model)
  and assert the ledger reconstructs (trial balance matches). (Full cross-project DR restore
  → documented deploy step; the code-level proof is the reconstruction test.)

## 5. Gate
`pnpm -w typecheck && pnpm -w lint && pnpm -w test` (incl. packages/exports 100% + the
manifest-completeness + no-secret property tests), `supabase test db` (export proc ACL +
credential-exclusion pgTAP), `scripts/dev/itest.sh` (11-export + no regression). Update NOTES + PROGRESS.

## 6. Out of scope (later): Storage document bytes export (no documents table yet → Stage
with documents); full cross-Supabase-project DR restore (deploy runbook); the 1D finance
domains (recurring/paycheck/statements); incremental/streamed export for very large households.

---
## v2 (dual-audit rework — fold before building; both reviewers NEEDS REWORK/BUILD-WITH-FIXES)
Core scope stays JSON/CSV/QIF/beancount + reconstruction proof, but corrected on the
critical invariants; heavier infra explicitly deferred.

### BLOCKERS (must build correctly)
- **B1 Law 12 — role-enforced exclusion (not proc wording):** `keel_api` HAS select on
  connection_credentials (c3 saga:819). Create a dedicated `keel_export` NOLOGIN role with
  SELECT on ONLY the included tables (per §1), and NO grant on connection_credentials,
  plaid_webhook_keys, link_attempts, removal_attempts, sync_attempts, webhook_rejections*,
  provider_call_budget, usage_events, or the test tables. Own `keel_export_household` by
  `keel_export`. A `select ... from connection_credentials` inside it then FAILS at
  permission time. pgTAP: keel_export has zero SELECT on every EXCLUDE table.
- **B2 Law 12 — opaque-field secret scan (fail-closed):** included opaque columns
  (raw_provider_events.body_text/body, import_rows.raw, audit_log.before/after,
  domain_events.payload/actor, connection_health_events.details, account_lineage.*_state,
  balance_snapshots.snapshot_metadata) can in principle carry secrets (record_raw_event
  accepts arbitrary JSON). Pure exporter runs a RECURSIVE forbidden-key/value scan over
  every exported value: reject any object key in {access_token, public_token, link_token,
  secret, client_secret, wrapped_dek, ciphertext, private_key} or a JWK with a `d` member;
  on a hit → FAIL the export (or hash-redact that field with a logged marker). Canary test
  seeds each opaque field with a planted token and asserts the export fails/redacts.
- **B3 Law 9 — explicit per-table tenant scoping:** 6 included tables lack a direct
  household_id (households, entity_memberships, account_owners, import_rows, journal_postings,
  journal_revisions). The proc uses an EXPLICIT selector per table scoping through the parent
  AND requiring the parent's household to match: journal_postings→journal_batches.household_id;
  journal_revisions→(original/replacement batch).household_id; account_owners→accounts.household_id;
  entity_memberships→entities.household_id; import_rows→import_batches.household_id;
  households→id=hh. NO `select *`-across-all. Integration test: a second household's postings
  are ABSENT from the export.
- **B8 Law 4 — BIGINT as decimal STRING, never a JSON number:** jsonb/JS parsing corrupts
  BIGINT > 2^53 (amount_minor, available/current_minor, bigint ids like audit_log.id). The
  proc builds explicit JSON DTOs (jsonb_build_object per row) casting EVERY bigint to text;
  the exporter treats them as strings. Property test: a 9_000_000_000_000_000_000 amount
  round-trips exactly through JSON→CSV→QIF→beancount.

### MAJORS
- **Determinism (M1/M9):** proc runs single-snapshot (one statement / `set transaction
  isolation level repeatable read`, or STABLE + one query); caller-fixable `asOf` (default
  statement_timestamp) stamped once; per-table COMPOSITE sort key defined (id, or natural key
  for id-less tables); ALL timestamps emitted UTC RFC3339; the pure `toJson` RECURSIVELY
  canonicalizes object keys (sort) so re-export of one captured snapshot is byte-identical.
  Compute the live trial balance in the SAME snapshot for the reproducibility comparison.
- **Column allowlists (M2/M3):** the proc projects EXPLICIT columns per table (no `select *`);
  export `raw_provider_events.body_text`+`body_sha256` (drop parsed `body`). A pgTAP
  column-completeness check: every column of every included table is allowlisted-or-noted, so
  a new column fails CI until ruled on.
- **Currency scale (M4/M10):** pure ISO-4217 exponent registry (USD/EUR=2, JPY=0, KWD/BHD=3…);
  format bigint minor → decimal by STRING digit-shift (never JS number division). QIF/beancount
  amounts + sign derived from the ASSET-side posting (holder perspective); beancount txns must
  balance (Σ=0). Property-test JPY/KWD/USD.
- **CSV spreadsheet-safe (M11):** neutralize cells starting with = + - @ TAB CR (prefix `'`
  or quote per a defined policy); JSON-valued cells canonically stringified. JSON remains the
  lossless restore source. Test a memo `=cmd()` is neutralized.
- **command_executions INCLUDE (Codex M5):** it is the household-scoped idempotency registry
  (not transient) — include a projection (household_id, economic_event_key, command, hash,
  result, created_at). Its `result` is opaque → covered by B2's scan.

### DEFERRED (documented; not built now — record in NOTES + the tag)
- Storage/job-based chunked export + signed URL for large histories (INFRA §exports bucket):
  MVP returns inline BELOW a tested size threshold; above it → 413 + "use the async export
  job" (job path is the follow-up before a real large-tenant ships). "Full export always
  works" holds for the common case now; the async path is the scale completion.
- Step-up MFA (aal2) for the bulk-egress action (INFRA §358): owner-role check in TS+SQL now;
  the aal2 claim check lands when MFA/enrollment exists.
- Full cross-project scratch-schema DR restore + synthetic-user identity remapping: the
  code-level proof is the reconstruction test (JSON→trial balance == exported) + the
  privilege pgTAP; the operational fresh-DB restore is a deploy runbook.
- Import→canonical lineage: import_batches/import_rows are exported but no import→canonical
  link exists yet (imports aren't produced pre-1D-domains); gate-13-for-imports lands with the
  import domain. Document the current gap.

### Authz: add `admin.export_all` to CommandName + a dedicated `EXPORT_ACTIONS`/owner-min; extend
`MinimumRole` with `'owner'` + all four ROLE_LATTICE rows + roleAtLeast; classify export as a
read-family action (so account/entity scoping is deliberate). Owner check ALSO in the proc.
