# KEEL Stage 1C Plan — Real Ingestion (Plaid Sandbox) + Visible & Exportable

**Status:** draft for dual audit (2026-07-11)
**Builds on:** Stage 1A (tagged `stage-1a`, deployed to FinancialOS). The simulator-proven spine, command procs, worker planner, and hostile-replay gate are the foundation this stage plugs real data into.
**Controlling specs:** INFRA.md §4/§8/§10 → docs/BC-v2.1.md §3 (connections/imports/lineage) → docs/17 §3 (Plaid boundary) → CLAUDE.md Laws 1,2,5,6,12.

## 0. Thesis and success criterion

Stage 1A proved the ledger is correct against a hostile *simulator*. Stage 1C proves it survives *real provider behavior* and becomes the first slice a human can actually use:

> A signed-in user links a Plaid **Sandbox** item, KEEL syncs real sandbox transactions through the exact same ingestion path the simulator exercised, the user sees accounts + transactions + postings + provenance in a thin UI, and can export everything (Law 6). No new trust claims beyond Sandbox.

**Done when:** the end-to-end demo runs locally and on FinancialOS — link → sync → view → export — with the Plaid adapter passing the same replay/idempotency/isolation gates the simulator did, and full export reproducing every cited record.

## 1. Standing constraints (unchanged laws)

- **Plaid Sandbox only.** Production linking is a separate ⚑ (docs/17 §3). The shared planning secret must be rotated before the first real call (⚑, still open).
- LLMs do no ledger arithmetic (Law 1). Categorization in this stage is deterministic rules only; AI categorization is 1D+.
- All ingested provider text stays data-tier (Law 5) — the red-team gate already covers this and must keep passing against Plaid-shaped payloads.
- Secret boundary (Law 12): Plaid client_id/secret and access_tokens live only in ignored local env + Supabase secrets, envelope-encrypted at rest; never in the browser, logs, or repo.
- Every provider access token is stored encrypted (`connection_credentials`), never returned to the client.

## 2. Scope

### In scope
1. **Plaid adapter** (`packages/providers/plaid` — pure-ish adapter behind the existing `BankProviderAdapter`): link-token create, public-token exchange, `/transactions/sync` (cursor + `has_more` + mutation-restart rule), `/accounts/get`, `/institutions`, `/webhook_verification_key/get`. Adapter is thin and typed; the domain packages stay provider-neutral.
2. **Real webhook verification** replacing the fixture JWK: fetch + cache Plaid's ES256 JWK by `kid`, verify `Plaid-Verification` + body-hash, dedupe by `request_id`, enqueue a sync — the verify-before-store ordering already built stays.
3. **Connection lifecycle & credentials**: `connection_items`, `connection_credentials` (envelope-encrypted access_token), `connection_health_events`; state machine `linking → active → reauth_required → disconnected` (Addendum §C) with the guard "no sync writes while reauth_required".
4. **Sync pull worker path**: the `sync_notification` job (stubbed in 1A) becomes a real `/transactions/sync` pull that feeds the *existing* `ingest.record_raw_event` → planner → `apply_promotion` pipeline. Cursor persisted in `sync_checkpoints`; mutation-during-pagination restarts from the stored cursor.
5. **Account lineage (minimal)**: reconnect/relink maps a returned account to its existing KEEL account by `(institution, mask, type)`; new accounts created; `account_lineage` records the link. (Merge/split stays support-ops, 1D+.)
6. **CSV import path** (deterministic, no Plaid): `imports.stage_file` → dry-run diff → `imports.commit` / `imports.rollback`, reusing `import_batches`/`import_rows` and the same balanced-posting command path. Dedupe on `(amount, date±3, account, fuzzy desc)` per doc 10 §5.
7. **Deterministic categorization v0**: a small rules table (`rules`, `rule_versions`) + apply-on-ingest that sets a category ledger account instead of the Uncategorized offset when a rule matches. Retroactive apply requires a preview (simulation) first.
8. **Export (Law 6, `admin.export_all`)**: CSV + JSON for accounts, transactions, postings, audit — with provenance (as-of, scope, formula version). QIF/beancount stubs acceptable this stage if CSV/JSON are complete and tested. Restore-read test proves cited records reproduce.
9. **Thin UI (pull 1E forward)**: connections page (link a Plaid Sandbox item via Plaid Link, list items + health), accounts list, transactions list with posting detail + provenance drawer, a "sync now" button, an export button, and the audit view. Desktop-first, usable at 390px (Law 8); no polish pass yet.
10. **pg_cron** wiring: scheduled function pulls active connections and enqueues sync jobs on a cadence (INFRA §8); cron holds no business logic.
11. **Folded-in deferred items**: `periods.reopen` with step-up auth (D-011); transfer-link confirm flow + income/spend exclusion property test (D-012); `professional_access_grants` surface (D-014, read-only professional).

### Out of scope (later stages)
- Plaid Production, real bank credentials, money movement (Law 10 class D).
- AI categorization / receipt OCR / paycheck parsing (1D).
- Investments, recurring engine, reconciliation/statements depth (1D).
- Polished UI, Lighthouse targets (1E/M8).
- QuickBooks/Xero, native apps.

## 3. Work breakdown (each = one commit, tests green; Codex-implemented under Claude review)

- **C1 — Plaid adapter package** behind `BankProviderAdapter`; unit-tested against *recorded Plaid Sandbox fixtures* (no live calls in CI). Interface parity with `SimulatorBankProvider` so the planner is untouched.
- **C2 — Credentials + connection lifecycle migrations**: `connection_items`, `connection_credentials` (pgcrypto envelope encryption via a KEK from Supabase secret), `connection_health_events`, `account_lineage`; state-machine guards as triggers/procs; grants+RLS consistent with 1A posture.
- **C3 — Link + exchange commands**: `connections.create_link_token`, `connections.exchange_public_token` (stores encrypted token, creates item + accounts), `connections.resync`, `connections.disconnect`. All through the SECURITY DEFINER command path; access_token never leaves the server.
- **C4 — Real webhook verification** in `webhook-provider`: JWK fetch/cache, ES256 verify, body-hash, dedupe by request_id; negative tests (bad kid/sig/expiry/replay) assert zero ingestion + quarantine (reuse 1A test shape).
- **C5 — Sync pull worker**: implement the real `sync_notification` handler → paginated `/transactions/sync` → `record_raw_event` per event → existing planner. Cursor persistence + mutation-restart. Replay/idempotency gate re-run with Plaid-shaped fixtures.
- **C6 — CSV import**: staging, dry-run diff, commit/rollback, dedupe; golden-file tests.
- **C7 — Categorization v0**: rules schema + deterministic apply + retroactive-preview; ≥ a small fixture accuracy check (not the 85% harness yet — that gates 1D).
- **C8 — Export**: `admin.export_all` CSV/JSON with provenance; restore-read test.
- **C9 — Thin UI**: connections/accounts/transactions/audit/export pages; Plaid Link integration (Sandbox); "sync now"; provenance drawer. Playwright or component tests for the critical flows.
- **C10 — pg_cron + deferred governance** (periods.reopen step-up, transfer confirm+exclusion property test, professional read-only grant).

## 4. Test & gate mapping (acceptance)

- Plaid adapter ↔ simulator interface parity (same planner, same replay determinism) — reuse `04-replay` shape with Plaid fixtures.
- Sync idempotency: duplicate webhook / duplicate `/sync` page / re-pull after mutation ⇒ one economic history (Law 9).
- Tenant isolation holds across the new connection/credential/import tables (extend pgTAP `002` + integration).
- Access-token secrecy: property/integration test that no command or query response, log line, or export contains a decrypted access_token (Law 12).
- Webhook verify-before-store negative suite (C4).
- CSV import: golden files reconcile to the penny; rollback restores prior state exactly.
- Export completeness: exported CSV/JSON reproduces every canonical transaction + posting + audit row for a household; restore-read reproduces cited records (Law 6, BC-v2.1 gate 13).
- Red-team gate re-run against Plaid-shaped memo/description fields.
- ⚑ Human: rotate Plaid Sandbox secret; run one live Sandbox link/sync end-to-end; confirm the Data Access Guarantee export by inspection.

## 5. Sequencing & risk

- C1–C5 are the critical path (real data in). C6 (CSV) is parallelizable and de-risks "aggregation is broken" (works with zero Plaid). C8 (export) should land early — it's a Law and a trust primitive, cheap now, expensive to retrofit.
- Biggest risk: Plaid Sandbox quirks (pending→posted timing, `transactions/sync` mutation restart, re-auth). Mitigated by recording real Sandbox responses into fixtures and replaying them through the 1A hostile-stream gate.
- Credential encryption KEK management is the security-sensitive new surface — review it hardest.

## 6. Progress protocol

Same as Stage 1A: `PROGRESS.md` per-step checkboxes, `NOTES.md` decisions/deviations with spec cites, stage-exit dual review (Claude + Codex) before tagging `stage-1c`. Plaid live steps are ⚑ human checkpoints and never fake credentials to bypass a gate.
