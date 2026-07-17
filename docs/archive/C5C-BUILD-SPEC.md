# C5c Build Spec v2 — Live Plaid `/transactions/sync` pull (Stage 1C)

Wire the real Plaid `/transactions/sync` HTTP call into the worker. **v1 assumed the
C5b page machinery was unchanged; a dual review proved that false** — the injected
path returns the *whole finite* page set (array == the world) while live cursor
pagination is a *windowed prefix*, so continuation, mutation-restart, and completion
semantics all differ for live. v2 redesigns around a **self-contained live fetcher +
explicit continuation + partial-completion**, with a hard opt-in so CI never networks.

> v2 fixes (Claude+Codex): has_more-at-maxPages force-completes with false success
> (both BLOCKER) → continuation + `complete_attempt(p_fully_synced)`; live mutation-400
> can't drive the worker's array-replay restart (Codex BLOCKER) → fetcher does its OWN
> bounded restart internally; live failure wedges the lease/attempt (Codex #3) → catch
> abandons the attempt (fenced); null-envelope vs RPC/KEK error conflation (Codex #4);
> non-airtight hermetic CI — 09 + itest .env would network (Codex #5) → `KEEL_LIVE_SYNC_ENABLED`
> opt-in off in CI + fetch-spy zero-call test; sandbox-only env gate (both #6); token
> `let`+finally, non-log/non-persist invariant (Codex #7); provider-AAD='plaid' roundtrip (Claude #3).

Read first: `CLAUDE.md` (Laws 1/4/12; Plaid Sandbox-only until ⚑), C5b worker
`processSyncNotification` (`worker/index.ts`), `_shared/plaid-sync.ts`, C3 crypto +
`keel_get_connection_credential_envelope`, `...c5b_sync_pull.sql` (attempt lifecycle
+ `keel_worker_complete_attempt`).

## Invariants
- **Law 12:** token decrypted in Edge memory only (`let`, best-effort clear in `finally`);
  never logged/stored/passed to a proc. Enforceable invariant = non-persist/non-log (JS
  strings can't be zeroized). **Sandbox-only:** require `PLAID_ENV==='sandbox'`; fixed
  hostname `https://sandbox.plaid.com`; any other env → live branch returns `[]` (no fetch).
- **Law 4/1:** verbatim body passthrough (no JSON.parse+re-stringify); the reviewed
  `@keel/plaid` adapter does string→minor + sign. C5c changes only page SOURCE.
- **Hermetic CI:** injected `sync_test_pages` ALWAYS win. The live branch runs only when
  ALL hold: injection empty AND `KEEL_LIVE_SYNC_ENABLED==='true'` AND creds present AND
  `PLAID_ENV==='sandbox'`. `itest.sh`/CI do NOT set `KEEL_LIVE_SYNC_ENABLED` → live code
  is unreachable in CI even with a real `.env` (closes Codex #5). A unit fetch-spy asserts
  zero network calls when the flag is unset.

## Confirmed `/transactions/sync` shape
`POST https://sandbox.plaid.com/transactions/sync {client_id, secret, access_token,
cursor?, count}` → `{added,modified,removed,next_cursor,has_more,request_id}`. Mid-pagination
mutation → HTTP 400 `error_code:'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'`.

## 1. Live fetcher — `_shared/plaid-sync.ts`
Add `fetchSyncPagesLive(admin, connectionId, opts) : Promise<LiveSyncResult>` where
`LiveSyncResult = { pages: InjectedSyncPage[]; hasMore: boolean; nextCursor: string }`
and `opts = { baseCursor, externalRef, maxPages, plaidPost }` (`plaidPost` injectable for
unit tests). `readSyncPages(admin, connectionId, {baseCursor, externalRef, maxPages})`
becomes the single dispatcher: injected rows → return them as before; else if the live
gate holds → delegate to `fetchSyncPagesLive`; else `[]`.
`fetchSyncPagesLive`:
1. env gate (sandbox + flag + creds) else return `{pages:[], hasMore:false, nextCursor:baseCursor}`.
2. `env = keel_get_connection_credential_envelope(connectionId)`:
   - **RPC error → throw** (transient; do NOT treat as empty — Codex #4).
   - `data === null` → return `{pages:[], hasMore:false, nextCursor:baseCursor}` (benign no-creds no-op).
3. `let token = decryptToken(env, env.credentialId, env.householdId, 'plaid', getKek(env.kekVersion))`
   (provider AAD literal `'plaid'` MUST equal the C3/C4 link-time encrypt provider — add a
   decrypt-roundtrip unit assertion). `try { ... } finally { token = ''; }`.
4. `cursor = baseCursor ?? ''`; `restarts = 0`; `pages = []`.
   loop while `pages.length < maxPages`:
   - `res = await plaidPost('/transactions/sync', {access_token: token, cursor: cursor || undefined, count: 100})`.
   - **mutation-400 (internal restart):** if `restarts < MAX_LIVE_RESTARTS` (e.g. 3) →
     `pages = []; cursor = baseCursor ?? ''; restarts++`; continue. Else throw (transient).
     (Live restart is fetcher-internal — the worker never sees a mutation marker; the
     archived pages are only the FINAL clean run's.)
   - **other non-2xx / network / timeout → throw** a typed transient error (bounded fetch
     timeout ~10s; never include the body/token in the message; normalize any error_code).
   - **2xx:** push `{pageIndex: pages.length, bodyText: <raw response text>}`;
     `cursor = next_cursor`; if `!has_more` → return `{pages, hasMore:false, nextCursor:cursor}`.
   - loop ended by `maxPages` with `has_more` still true → return `{pages, hasMore:true, nextCursor:cursor}`.

## 2. Worker wiring (`worker/index.ts` `processSyncNotification`)
Keep bump-gen → acquire lease → open attempt(base_cursor). Then branch on source:
- **Injected path (rows present):** UNCHANGED (existing array loop incl. mutation-marker replay).
- **Live path:** call `fetchSyncPagesLive` → process its `pages` through the SAME
  archive → reconcile → create_normalized → apply_action steps (unchanged). Then:
  - `keel_worker_complete_attempt(attemptId, owner, nextCursor, p_fully_synced := !result.hasMore)`.
  - **if `result.hasMore`:** re-enqueue a `sync_notification` for this connection
    (continuation) so the next invocation resumes from the advanced `nextCursor`. Do NOT
    mark fully-synced. (Bounded by the per-invocation page cap; the advanced committed
    cursor makes progress durable — promotion barrier already ensures we only advance past
    promoted pages.)
- **Failure (fetcher throws):** in the catch, `keel_worker_abandon_attempt(attemptId, owner)`
  (fenced release so the lease/attempt don't wedge — Codex #3), return `{ok:false, retry:true}`;
  cursor + `last_successful_sync_at` untouched → clean re-run.
KEK/creds/flag via `Deno.env` (same as C3/C4).

## 3. Migration `supabase/migrations/20260711155000_c5c_partial_complete.sql`
`create or replace function keel_worker_complete_attempt(p_attempt_id uuid, p_owner uuid,
p_next_cursor text, p_fully_synced boolean default true) returns ...` — copy the deployed
body verbatim (C5b/C3 amended version, incl. the C3 status/generation fence), add the param;
set `last_successful_sync_at = now()` ONLY when `p_fully_synced`; always advance
`sync_checkpoints.cursor` + `sync_committed_generation` + `promoted_at` as today. Preserve
owner via the ownership block. (This is the ONLY proc change — the promotion barrier and
fences are unchanged; a partial completion is a normal committed-cursor advance minus the
"fully synced" health signal.) pgTAP note in 004/006 or a small assertion: partial complete
advances cursor but not last_successful_sync_at.

## 4. Tests
- **Unit** (`plaid-sync.test.ts`, Deno, inject `plaidPost`): cursor pagination (has_more
  loop → all pages); `has_more` at maxPages → `{hasMore:true}` + correct nextCursor;
  internal mutation-restart (400 then clean) → only the clean run's pages, bounded restarts
  → throw; non-2xx/timeout → throw (typed, no token in message); RPC-error → throw;
  null-envelope → empty no-op; **fetch-spy: zero calls when `KEEL_LIVE_SYNC_ENABLED` unset**
  (even with creds); decrypt-roundtrip with provider `'plaid'`; token never returned/logged.
- **Integration** (extend 08): existing injected cases stay green (injection precedence).
  Add: a connection with NO injected rows + flag unset → sync completes empty no-op (no
  dead-letter, cursor unchanged) — proving the gate, not a live call. (Real live pull → deploy ⚑.)
- **Continuation** (unit or a worker-level test with a stub source): `hasMore:true` →
  `complete_attempt(p_fully_synced=false)` (last_successful_sync_at NOT set) + a continuation
  `sync_notification` enqueued; a second pass with `hasMore:false` finalizes.
- **Law 12 canary:** no decrypted token in raw_provider_events/audit/logs.

## 5. Gate (ALL green; do NOT commit until dual post-build review)
`pnpm -w typecheck && pnpm -w lint && pnpm -w test` (incl. Deno unit), `supabase test db`,
`scripts/dev/itest.sh` (08 injected + new gate case; NO regression on 04/05/06/09). Update
NOTES.md + PROGRESS.md. **Do not mark Stage 1C complete on a stub** — this closes that gap.

## 6. Out of scope: real live link→sync end-to-end (deploy ⚑, needs a linked Sandbox item);
metering/budget of the sync call → C6; prod (non-sandbox) → human ⚑.

---
## v3 fixes (from the Codex v2 confirmation — apply before building)
All concrete; fold into the sections above, then build.
1. **complete_attempt overload (confirm #1):** `CREATE OR REPLACE ... (uuid,uuid,text,boolean default true)`
   creates an AMBIGUOUS overload vs the existing 3-arg calls. Instead **DROP the 3-arg function and
   RECREATE as the 4-arg-with-default**, updating every caller (worker + pgTAP). Re-own via the block.
2. **Continuation must open a NEW attempt (confirm #2):** the worker's existing continuation
   (`worker/index.ts:424`) resumes the SAME open attempt/owner — unusable after a partial
   `complete_attempt`. On `partial`, enqueue a FRESH `sync_notification` (not the
   `keelSyncContinuation` same-attempt path) so bump_generation opens a new attempt from the
   committed cursor. Make the dispatcher return a TAGGED result `{source:'injected'|'live'|'disabled', pages, status, nextCursor}`.
3. **Failure lease release (confirm #3 + NEW#1):** hoist `owner`/`attemptId` to function scope (or an
   inner post-open try/catch). Add `keel_worker_abandon_and_release(p_attempt_id, p_owner)` — marks the
   attempt abandoned AND clears the lease, owner-fenced — for the LIVE catch. Do NOT change the plain
   `abandon_attempt` (injected mutation-restart relies on retaining the lease). **Renew the lease before
   EVERY page HTTP request** (pass an owner-aware renew callback into `fetchSyncPagesLive`; ≤maxPages×~10s
   can exceed the 30s lease otherwise).
4. **Hermetic CI airtight (confirm #4):** `itest.sh` must FORCE `KEEL_LIVE_SYNC_ENABLED=false` (strip it
   from the passed `.env`) so a dev `.env` with the flag on can't make 09's un-injected drains network.
   Add an integration-wide `fetch` deny/spy asserting zero Plaid calls, not only a fetcher unit spy.
5. **Explicit outcome status (NEW#2):** the fetcher returns `status ∈ {terminal, partial, noop}`.
   `noop` (flag-disabled / missing-config / null-envelope / no-creds) → `complete_attempt(p_fully_synced=false)`
   — a no-op must NOT set `last_successful_sync_at`. Only a real `terminal` Plaid response sets it.
6. **Enforce cursor progress (NEW#3):** every `has_more=true` page MUST yield a non-empty `next_cursor`
   that differs from the request cursor; otherwise throw + abandon-and-release (prevents infinite self-enqueue).
7. **Tests:** add SQL-signature-resolution regression (no ambiguous overload), catch-cleanup+immediate-retry,
   lease-renewal-across-pages, disabled/null-envelope no-op health semantics (last_successful_sync_at NOT set),
   stalled-cursor throw, injection-precedence WITH the live flag enabled (still no network), byte-for-byte
   archived response text.
