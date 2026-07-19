# Statement Ingestion Plan v2 — Upload → Extract → Suggest → Approve → Reconcile

> v2 (2026-07-19), revised from statement-ingestion.md after Codex Review v1 (VERDICT: MUST CHANGE FIRST). Every one of the 12 amendments + 5 advisories is resolved below and tagged **[A#]**. v1 is retained for reference. Verified against live code before designing each fix; corrected v1/Codex factual errors are called out inline. Cites: CLAUDE.md Laws; BC-v2.1; file:line. Status: build-ready.

## 0. Verification ledger (each Codex claim confirmed against real code)
- **[A1]** `worker/receipt-extract.ts` holds `admin.from` (L84,92), `admin.storage.download` (L106-108), and 5 distinct `admin.rpc` calls (L111,142,175,199,242) directly — capability boundary too broad. CONFIRMED; must NOT mirror.
- **[A2]** `statement_lines.description text not null check(length between 1 and 500)` — reconciliation migration `20260712150000` L6. Canonical cap = 500 chars CONFIRMED. "byte-identical into statement_lines" is impossible → byte preservation lives only in immutable `document_versions` + `statement_extractions.raw_evidence`.
- **[A3]** `keel_documents_confirm_upload` (`20260717234500` L145) requires a target and always inserts one `document_attachments` row; never creates a draft today. v1's optional-`accountId` blurred attach vs ingest. CONFIRMED need for a discriminated contract.
- **[A4]** confirm-upload mints a fresh `document_id` per upload; `document_versions` unique is `(document_id, content_sha256)` (L47) — **document-local**, so re-uploads do NOT dedupe across documents. CONFIRMED.
- **[A5]** `ApprovalTokenSchema` + `AiResponseRecordSchema` **do exist** as Zod types (`packages/contracts/src/ai.ts` L23,44). Grep for `approval_token|redeem|issue_token` across `supabase/migrations/**` returns **nothing** → the SCHEMA exists but no SQL issue/redeem ENFORCEMENT primitive. Reconciles the two reviews. CONFIRMED as SLICE 0.
- **[A6]** In `keel_statement_create` the sum is `select sum(...) into v_sum` (L21) with **no coalesce**, checked by `v_open+v_sum<>v_end` (L22) → NULL-bypass if the array is ever empty (today blocked only by `jsonb_array_length<1` L17). `matched_transaction` server validation already EXISTS in `keel_reconciliation_close` (L37: account+period+status) — Codex's "only a UI heuristic" is **wrong for close**; the gap is the NEW payment-matcher. Page hardcodes `currency:'USD'` (`statements/page.tsx` L596). CONFIRMED.
- **[A7]** `keel_detect_transfers(uuid)`, `keel_decide_transfer(uuid,uuid,boolean)`, `keel_link_transfer(uuid,uuid,uuid)` exist. No payment-matcher exists. CONFIRMED.
- **[A8]** `holdings` unique is `(account_id, as_of, symbol, source)` **WITH as_of** (`20260718040000` L40) — Codex's "no as_of" is **wrong**; the real stale risk is `keel_list_holdings` rebuilding current from `max(as_of)` per account (L209-215), which cannot drop a symbol absent from a newer full statement. `holdings_snapshots` is a separate table whose `source` must ALSO widen. CONFIRMED (restated).
- **[A9]** `DOCUMENT_MIME_ALLOWLIST = {jpeg,png,webp,pdf}` (`api/index.ts` L57-62); `statements` bucket `allowed_mime_types` = images+pdf (`20260717234500` L127-128). No CSV/OFX. No quarantine bucket. CONFIRMED.
- **[A10]** `keel_recurring_account_access(household_id, account_id, write boolean)` (`20260712120000` L157) is the existing account-scoped gate; new tables must use it, not household-only. CONFIRMED.
- **[A11]** Exporter iterates an explicit `INCLUDE[]` list with an `ALL_PUBLIC_TABLES` completeness guard (`packages/exports/src/manifest.ts` L17,126). A SQL-only `keel_export_household` extension is **invisible** to it. CONFIRMED (v1 only extended SQL).
- **[A12]** confirm-upload enqueue is best-effort (`api/index.ts` L2289-2303); worker dispatch is a jobType if/else chain (`worker/index.ts` L1373-1389) with no `statement_extract` branch. No outbox exists. CONFIRMED.

## SLICE 0 (PREREQUISITE) — Approval-token primitive (Law 11) — [A5]
**Cross-cutting: the paycheck feature needs this too. Build once, first, before any statement slice.**

`20260720100000_approval_tokens.sql`:
- `approval_token_status` enum `('issued','redeemed','expired','revoked')`.
- `approval_tokens(token_id uuid pk, household_id not null → households, actor_user_id not null, command text not null, payload_sha256 text check ~64hex, normalized_payload jsonb not null, scope jsonb not null, account_id uuid, proposal_kind text not null, proposal_ref uuid, proposal_version int not null, policy_version text not null, status default 'issued', issued_at, expires_at not null, redeemed_at, redeemed_command_id, unique(household_id, token_id))`. Composite tenant FK `(household_id, account_id) → accounts`. Immutable-except-status trigger (only issued→redeemed|expired|revoked).
- `keel_approval_token_issue(...)` → binds `payload_sha256 = keel_payload_hash(normalized_payload)`; membership + `keel_recurring_account_access(...,true)` check; returns token_id + hash + expiry.
- `keel_approval_token_redeem(...)` → **one-use**: `select ... for update`; assert status='issued', not expired, actor matches, command matches, `keel_payload_hash(normalized_payload)=payload_sha256`, proposal_version matches; flip to 'redeemed' + set redeemed_command_id. Mismatch → KEEL_INVALID_COMMAND (tamper) / P0007 (replay) / P0009 (expired). **The payload hashed is the SERVER-normalized payload, never the client's raw body.**
- Grants issue/redeem to keel_api owner + authenticated; RLS member-read; export INCLUDE (exclude normalized_payload if it could carry secrets — statements never do).
- **ONE shared** `keel_statement_validate_and_materialize(household, payload, source_hash)` (Law 7): the current `keel_statement_create` validation+insert extracted into an internal SECURITY DEFINER helper, called by BOTH manual create AND draft approval. No copied logic.

Tests (frozen first): issue→redeem happy; tamper rejected; replay rejected P0007; expiry; wrong-actor; wrong-scope; wrong proposal_version. Contract: ApprovalTokenSchema round-trips.

**Slice 0 SHIPPED (PR #102, applied to live 2026-07-19).** Review = SHIP. Byte-identical `keel_statement_create` refactor independently verified. Two advisories to carry forward:
- **[GATE — advisory A] redeem↔command payload binding is caller-enforced, NOT primitive-enforced.** `keel_approval_token_redeem` verifies `hash(normalized_payload)==payload_sha256` but does not RETURN the payload. So the "exact bytes approved = exact bytes executed" guarantee holds ONLY IF the calling command (`keel_cmd_statements_approve_draft`, Slice 3; and the paycheck apply command) binds a SINGLE local `v_payload` and passes it to BOTH `keel_approval_token_redeem(...)` AND `keel_statement_validate_and_materialize(...)` inside one transaction. **This is a HARD GATE on every slice that wires a token-bound command**: its pgTAP must assert a redeem-payload-A / execute-payload-B attempt is impossible by construction.
- **[advisory B]** the exporter `ALL_PUBLIC_TABLES` completeness guard is a hardcoded count, not a live-schema diff (pre-existing [A11] limitation). Eventually add a real `information_schema.tables` diff guard.

## 1. Capability boundary — typed IO port — [A1]
`StatementJobIO` is the ONLY object touching Supabase/fetch/Storage/rpc: `resolveVersion` (one household-verified `.from` read), `download` (one Storage read), `extractPdf` (one fixed extractor endpoint), `persist` (exactly `keel_worker_persist_statement_extraction`). Parsers (`packages/documents/src/statement/*`) and extraction core receive **only Uint8Array bytes / typed data**. `worker/statement-extract.ts` composes resolve→download→route→parse→persist; no `.rpc` beyond persist.
**CI static check** `scripts/check-capability-boundary.mjs` (wired into build/CI): fail if any parser/core file references `supabase|createClient|\.rpc\(|\.from\(|\.storage|fetch\(|@supabase`. Golden-negative test asserts it fires on a planted violation.

## 2. Red-team matrix — [A2]
CI-blocking corpus, each asserting no network/tool/RPC-beyond-persist/no canonical write pre-approval: hostile filenames (`$(rm)`, `../../etc`, RTL, 300-char, `.csv` w/ PDF bytes); hostile CSV headers (`=cmd`, `@SUM`, formula-injection + RED_TEAM_STRINGS); debit/credit split columns w/ payloads; OFX NAME/MEMO/SECNAME/TICKER carrying RED_TEAM_STRINGS; a real injection-bearing PDF. Assertions: hostile text byte-identical **only** in `document_versions` + `statement_extractions.raw_evidence` (inert jsonb); canonical boundary = deterministic reject-or-truncate at 500-char cap (the "byte-identical into statement_lines" v1 claim is removed). Worker red-team spies the IO port → only persist invoked. e2e mirrors `06-redteam.test.ts`.

## 3. Discriminated attach-vs-ingest contract — [A3]
`UploadStatementPayloadSchema` = discriminated union on `mode`: `'attach'` → targetType/targetId required, **no draft** (unchanged path); `'ingest'` → **accountId required**, creates a draft, never an attachment. `statement_drafts.account_id` NON-NULL. confirm-upload branches on mode; the existing `AttachmentsSection targetType="statement"` always sends `mode:'attach'` → can never spawn a draft.

## 4. Tenant-scoped content identity — [A4]
- `document_hashes(household_id → households, content_sha256 ~64hex, first_document_id, first_version_id, byte_size, created_at, pk(household_id, content_sha256))` — concurrency-safe; `insert ... on conflict do nothing returning` in confirm-upload detects tenant re-upload → `duplicate:true` before minting a draft.
- `statement_drafts.source_hash` and (on approval) `statements.source_hash` bound from **server `document_versions.content_sha256` only** — never the approval payload.
- Add draft-level `unique(household_id, account_id, source_hash)` (one live ingest per file per account) alongside the existing statements unique.
- `statement_draft_status` enum `('pending','extracted','failed','approved','dismissed')`; status trigger forbids transition **out of** approved/dismissed.

## 5. Migrations
### `20260720110000_statement_extraction.sql`
- `statement_extract_kind` enum ('bank','card','investment','unknown').
- `statement_extractions(id, household_id not null, document_version_id not null, account_id not null, kind_hint, period_start/end, opening_minor bigint, ending_minor bigint, currency char(3), extractor, extractor_version, model_version, prompt_version, confidence, raw_evidence jsonb default '{}' check object, status, error_code, created_at, unique(household_id, document_version_id, extractor, extractor_version))` + composite tenant FK `(household_id, account_id)→accounts`; append-only trigger.
- `statement_extraction_lines(household_id, id, extraction_id, line_no int, line_date, amount_minor bigint, description_raw, currency, src_page/src_bbox/src_row/src_col/src_byte_offset/ofx_path/field_confidence/null_reason, unique(household_id, extraction_id, line_no))` — typed BIGINT (Law 4), immutable. Reject `line_no > 5000` BEFORE building the array [A9].
- `statement_extraction_holdings(household_id, id, extraction_id, symbol, cusip, isin, name, qty, price_minor, value_minor, cost_basis_minor, currency, src provenance, unique(household_id, extraction_id, symbol))` — CUSIP/ISIN carried, not symbol-alone [Adv].
- `statement_drafts(id, household_id, document_version_id unique, account_id NOT NULL, source_hash text not null (server-bound), status default 'pending', extraction_id, statement_id, decided_by/at, created_at, unique(household_id, account_id, source_hash))` + terminal-lock trigger + composite tenant FKs.
- Procs: `keel_worker_persist_statement_extraction` (definer owner keel_worker, service_role only, atomic parent+child, money strings ::bigint, on-conflict no-op replay, flips pending→extracted|failed); `keel_list_statement_drafts` (viewer; filters `keel_recurring_account_access(...,false)` — account scope [A10]; discrepancy preview); `keel_cmd_statements_approve_draft` (class-B; **requires redeemed approval token** [A5]; calls shared `keel_statement_validate_and_materialize`; source_hash from server; flips draft→approved; inserts document_attachments); `keel_cmd_statements_dismiss_draft`.
- Grants/RLS mirror receipts; export INCLUDE for all 4 tables [A11].

### `20260720120000_statement_anchor_mode.sql` — [A6]
- `statements.balance_check` enum ('strict','anchor') NOT NULL DEFAULT 'strict'; `anchor_reason`, `anchor_gap_explanation` (required when anchor; gate-8 provenance).
- Amend shared materialize: `coalesce(sum(...),0)` (empty≠NULL bypass); strict → enforce opening+Σ=ending; anchor → only when account subtype ∈ investment/valuation set + typed reason + stored gap; else reject.
- Relax CreateStatement lines min1→min0 and CloseReconciliation items min1→min0 only for anchor/zero-line. NOTES.md contract amendment citing BC-v2.1 179 + gate 8.

### `20260720130000_statement_payment_links.sql` — [A7]
- **V1 = exact-only**. `statement_payment_status` enum ('suggested','confirmed','rejected','detached').
- `statement_payment_links(household_id, id, statement_id, canonical_transaction_id, transfer_link_id, status, score int, matcher_version, reason_codes text[], created_at, decided_by/at, unique(household_id, statement_id, canonical_transaction_id))` + composite tenant FKs.
- `keel_statement_suggest_payments` (definer; fully specified: liability/card subtype; card-side inflow sign; same currency; status ∈ posted|reviewed non-void; window `[period_end, period_end+35d]` inclusive; exact `|ending_minor|` only in V1; score=100; tie-break prefer transfer_links pair → nearest date → lowest txn id; >1 exact → **abstain** reason `ambiguous`; never resurrect rejected; never auto-confirm; reuse keel_detect_transfers; never call keel_decide_transfer(true)).
- `keel_cmd_statements_decide_payment_link`/`_detach_payment_link` (partner; audited; confirm may raise a keel_link_transfer SUGGESTION only). API map: decide/detach commands + on-demand `statements.find_payment` query.
- Extend `keel_list_statements` with paymentLinks. Export INCLUDE [A11].

### `20260720140000_statement_holdings_apply.sql` — [A8]
- Widen BOTH `holdings.source` AND `holdings_snapshots.source` to include 'statement'.
- `statement_holding_applications(household_id, id, statement_id, extraction_id, applied_by, approval_token_id, period_end, revoked_at, revoked_by, created_at, unique(household_id, statement_id))`.
- `keel_cmd_statements_apply_holdings` (class-B; requires redeemed token; validates investment subtype + positions match extraction; records application; idempotent snapshot insert; **rebuild current holdings from newest non-revoked application, dropping symbols absent from a newer full statement**). `keel_cmd_statements_unapply_holdings` (revoke + rebuild from prior). `keel_statement_holdings_diff` (per-symbol/CUSIP delta; suggestions; account-scoped [A10]). Export INCLUDE.

## 6. Storage / quarantine / limits — [A9]
Widen `statements` bucket allowed_mime_types (+csv, ms-excel, x-ofx, octet-stream); add `quarantine` private bucket. Flow: upload→quarantine→confirm-upload content-sniffs (magic bytes, not extension)→validate limits→immutable-promote to statements. Per-kind DOCUMENT_MIME_ALLOWLIST. Serve hostile originals as `Content-Disposition: attachment`/sanitized (never inline). Limits: rows ≤5000 (reject before child arrays), fields/row ≤64, nesting ≤N, PDF pages ≤50, extractor tokens/timeout bounded. OFX rejects DTD/external-entities/entity-expansion.

## 7. Pure packages
`packages/documents/src/statement/`: `types.ts` (defensive, every field nullable + null_reason, hostile→inert null never throw-into-guess); `csv.ts` (RFC-4180, header-alias, debit/credit split, `$`/`,`/paren, decimal→minor by string math no floats, row/col/byte provenance); `ofx.ts` (tolerant 1.x SGML/2.x XML entity-free; STMTRS/CCSTMTRS→lines+LEDGERBAL; INVSTMTRS→INVPOSLIST+SECLIST→holdings w/ CUSIP; path provenance); `payment-matcher.ts` (pure mirror). **Bytes-only inputs [A1].** `packages/ai/src/statement.ts`: StatementExtractor iface, RecordedStatementExtractor (fixture by sha256), CloudStatementExtractor (fetch behind IO port; key server-only never logged Law 12; live = human ⚑); prompt fences data + refuses embedded instructions; per-field provenance + minor-unit integer strings.

## 8. Worker + durable delivery — [A12]
`worker/statement-extract.ts` via StatementJobIO only; routes csv/ofx/pdf; persist via single allowlisted proc; failures → status='failed'+short error_code (Law 12). `worker/index.ts`: add statement_extract branch. **Transactional outbox + sweeper**: confirm-upload writes outbox row in same txn as draft; `pg_cron` `keel_sweep_statement_outbox` re-enqueues pending drafts idempotently (dedupe on document_version_id). **Deploy order reversed**: worker (Slice 5) BEFORE API publishes jobType (Slice 6). Deploy: `node scripts/build-functions.mjs && supabase functions deploy api worker`.

## 9. Contracts / authz / API map
Contracts: `UploadStatementPayloadSchema` (discriminated [A3]), `ApproveStatementDraftPayloadSchema` (+draftId +balanceCheck +approvalTokenId, lines min0), Dismiss, DecidePaymentLink, DetachPaymentLink, ApplyHoldings (+approvalTokenId), UnapplyHoldings; amend CreateStatement lines min0 + optional balanceCheck, CloseReconciliation items min0. Reuse ApprovalTokenSchema. authz: commands approve_draft/dismiss_draft/decide_payment_link/detach_payment_link/apply_holdings/unapply_holdings at partner; queries drafts/find_payment/holdings_diff at viewer. api: COMMAND_TO_PROC +6; QUERY_TO_PROC +3; bespoke `/statements/drafts` (account-scope filtered, validated params). keel-api.ts fetchers/mutators; extend StatementRow.paymentLinks; new StatementDraftRow.

## 10. UI slices (390px — Law 8)
1. Upload dialog (required account, `.pdf,.csv,.ofx,.qfx`, mode:'ingest'); Drafts section (extractor badge+confidence, period/opening/ending, ledger-delta, hint-mismatch warning; Review&approve/Dismiss). Review opens CreateStatementDialog prefilled, **currency from account (not USD)** [A6], **supports zero lines** [A6], issues+redeems token, submits approve_draft.
2. Statement detail: card-payment block for liability accounts (links Confirm/Reject/detach; "Find payment" on demand).
3. Investment drafts: holdings table + diff (CUSIP/ISIN aware) + Apply/Revert.
4. accounts/[id] upload shortcut (optional). Explicit keyboard/focus/overflow/a11y tests [Adv].

## 11. Reconciliation hook
No change to close semantics (gate 8). Approved statements arrive with lines → existing auto-match; payment-link confirm raises a transfer suggestion (never auto-confirms); anchor statements reconcile on balances+adjustments (zero-line supported). Cadence F-029 auto-picks-up uploads.

## 12. Tests (per-slice, not deferred — [A12])
Each slice ships contract+authz+replay+red-team. Pure csv/ofx (header-alias, split cols, paren negatives, string-math identity, OFX 1.x/2.x bank/card/investment + DTD/entity-expansion rejection, malformed→failed never throw); fuzz+golden multi-dialect corpus [Adv]. Token tamper/replay/expiry/wrong-actor/scope (Slice 0). Capability-boundary CI + golden-negative [A1]. Red-team matrix [A2]. Worker: idempotent redelivery, household-mismatch refusal, download-fail→failed, mime routing, only-persist-RPC, outbox re-enqueue idempotent. Integration `26-statement-drafts.test.ts`: upload→extract→approve; re-upload dedupe no-op [A4]; approve twice idempotent; strict-sum-mismatch rejected; empty-array-no-bypass [A6]; dismissed/approved terminal-locked; payment suggest→confirm→detach + ambiguity abstain [A7]; holdings apply→revert + symbol-drop [A8]; tenant+account isolation [A10]; export includes every new table CSV/JSON/secret-scan/restore [A11]. Payment-matcher precision gate: labeled corpus, FP ceiling, abstention rate before Slice 8 [Adv]. `pnpm build` before every web push.

## 13. Staged delivery (one PR each, branch off main)
| # | Slice | Files |
|---|---|---|
| 0 | **Approval-token primitive + shared validate/materialize** (prereq; paycheck also needs) | `20260720100000`, contracts/ai.ts tests |
| 1 | Pure parsers + types + IO-port + capability CI check + red-team fixtures (tests first) | `packages/documents/src/statement/*`, `scripts/check-capability-boundary.mjs` |
| 2 | AI statement extractor (fixture + cloud stub + prompt tests) | `packages/ai/src/statement.ts` |
| 3 | Staging migration + anchor-mode + document_hashes + export INCLUDE | `…110000`, `…120000`; NOTES amendment |
| 4 | Storage widen + quarantine + per-kind sniff + limits | storage migration, api/index.ts |
| 5 | **Worker job + dispatch + outbox + sweeper + tests + deploy** (BEFORE API publishes) | worker/statement-extract.ts, worker/index.ts |
| 6 | Contracts + authz + discriminated confirm-upload + `/statements/drafts` | contracts, authz, api/index.ts |
| 7 | Web: upload dialog + drafts inbox + token-bound approve (account currency, zero lines) | keel-api.ts, statements/page.tsx |
| 8 | Payment links: migration + matcher + commands + "Find payment" + UI | `…130000`, api map, statements page |
| 9 | Investment holdings: migration + apply/revert + diff UI (CUSIP/ISIN) | `…140000`, investments/statements UI |
| 10 | Integration tests + accounts shortcut + a11y/polish | `tests/integration/26-statement-drafts.test.ts` |

Human ⚑: enabling cloud PDF extractor (`AI_PROVIDER=cloud`) — same gate as receipts.
