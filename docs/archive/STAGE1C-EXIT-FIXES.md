# Stage 1C exit hardening — fixes required before tagging `stage-1c`

Reconciled from the whole-stage dual audit (Claude TAG-WITH-FIXES / Codex NOT-READY).
Apply these 7; the deferrals + deploy-⚑ are listed at the end (do NOT build those).
Do NOT regress any existing test (04/05/06/08/09/10) or the C5c hermetic fetch-spy (must stay 0).

## FIX 1 (BLOCKER, Gate 2) — cross-attempt pending→posted must be ONE economic history (deferred M4)
Today `keel_worker_create_normalized` (`20260711130000_c5b_sync_pull.sql`) hardcodes normalized
`pending=false` and `keel_worker_apply_action` hardcodes canonical `status='posted'`. So when a
pending txn P promotes in attempt 1 and posts via `removed(P)+added(Q, pending_transaction_id=P)`
in a LATER attempt 2, `keel_worker_lookup_state` reports P as `posted`, the reconciler's
`pending?.status==='pending'` is false, and Q becomes a fresh `create` (new economic key) while P
is standalone-`void`ed — two economic histories, violating Gate 2 / BC-v2.1 §9.1 idempotent
economics. (Masked because `reconcile.test.ts` hand-builds `priorState` with `status:'pending'`.)
**Fix:** carry the real `pending` boolean end-to-end — the worker parses it per page (the adapter
already exposes it), passes it to `create_normalized` (add a `p_pending boolean` param), which stores
it on the normalized row; `apply_action` sets canonical `status = <normalized.pending> ? 'pending'
: 'posted'` in BOTH the create and revise branches. Recreate the procs via the ownership block
(drop+recreate if the signature changes; update ALL callers + pgTAP). Preserve the C3/C5c
status/generation fences already in these procs.
**Test:** add an integration case (extend 08) — a real TWO-ATTEMPT sequence: attempt 1 delivers P
pending (canonical `pending`), attempt 2 delivers `removed(P)+added(Q,pending_transaction_id=P)` →
assert ONE canonical row keeps P's `economic_event_key`, ends `posted`, via a `revise`-supersession
(NOT a void+create), postings still Σ=0.

## FIX 2 (raw provenance, deferred B2) — normalized→raw pointer must be the exact page
`create_normalized` links every normalized row to `provider_event_id = attempt_id||':0'`, so rows
from pages 1+ mis-point their source lineage. **Fix:** thread the actual page's `raw_event_id`
(or attempt_id||':'||ordinal) into `create_normalized` per normalized row (the worker already
archives each page and has its id/ordinal). Source bytes are already preserved verbatim; this only
corrects the pointer. (Bundle with FIX 1 — same proc.)

## FIX 3 (liveness) — terminal-status sync notifications must not retry forever (C3 #4)
`worker/index.ts` drain loop: `else if (outcome.retry)` runs BEFORE the `read_ct >= MAX_ATTEMPTS`
dead-letter, so a `disconnecting`/`disconnected`/`reauth_required` lease-refusal (`retry:true`)
loops forever. **Fix:** in `processSyncNotification`, when `acquire` refuses because the connection
is `disconnected` (obsolete) → return `{ok:true, detail:'connection disconnected; notification
dropped'}` so it ARCHIVES. For `reauth_required`/`disconnecting` → keep `retry` but make it
bounded: either fall through to the existing `read_ct >= MAX_ATTEMPTS` dead-letter (drop the
`retry:true` so the loop's max-attempts branch handles it) OR add a typed parked disposition.
Simplest: return `{ok:false, detail:...}` (no `retry` flag) for `reauth_required`/`disconnecting`
so the existing `read_ct>=MAX` branch dead-letters after MAX; a `LOGIN_REPAIRED`/reconnect already
re-enqueues a fresh notification. Keep T5 green (reauth guard still blocks writes — assert canonical
unchanged; the notification now bounded-retries then dead-letters instead of looping).

## FIX 4 (Law 12 Sandbox-only) — hard-pin the Plaid client to sandbox (audit #4)
`createPlaidClient` builds `https://${config.env}.plaid.com` for link/exchange/accounts/remove/
reaper — only sync + JWK fetch are hard-pinned. A misconfigured `PLAID_ENV` could send tokens to a
non-Sandbox environment (violates Law 12 Sandbox-until-⚑). **Fix:** in `createPlaidClient`, reject
any `env !== 'sandbox'` (throw at construction) and use the constant origin `https://sandbox.plaid.com`.
(Match the sync/JWK gate already present.)

## FIX 5 (PLAN §6 acceptance) — durably record per-transaction USD rejections (audit #10)
Non-USD transactions are skipped with only `console.warn` (`worker/index.ts`). PLAN-1C §6 requires
"per-transaction USD rejection recorded (not dead-lettered — normalize-time skip)." **Fix:** persist
an immutable tenant-scoped skip record via a narrow owned RPC — reuse `usage_events`
(event_type='ingestion_skip', kind... ) OR a small `ingestion_skips` note; record connection/
household (derived, not caller-supplied), the provider transaction id, currency, reason
('non_usd'), and the raw page reference. NO amount floats, NO token. Add a test asserting a skipped
CAD transaction leaves a durable skip row + zero canonical rows.

## FIX 6 (concurrency) — a concurrent same-command LOSER must not clobber the winner (C3 #2)
Two concurrent `/connections/link` with the same `commandId` share one attempt (begin's ON CONFLICT
DO NOTHING). Both may exchange different Plaid items; the first sets state `exchanged` (winner). The
loser's `record_link_exchange` RAISES (state no longer `initiated`), and the api catch then calls
`keel_fail_link_attempt` on the SHARED `exchanged` attempt — clobbering the winner's envelope →
winner's finalize fails, Item orphaned. **Fix (targeted, no full invocation-claim needed):** (a) in
the `/connections/link` catch, only call `keel_fail_link_attempt` when THIS request's own exchange
PERSISTED (i.e. the failure is a downstream accounts/finalize error), NOT when `record_link_exchange`
itself raised "state not initiated" (someone else won) — in that raise, return 409/best-effort
`/item/remove` the loser's own item WITHOUT failing the shared attempt; and (b) `keel_fail_link_attempt`
should only transition an attempt it is entitled to (guard: don't fail an `exchanged` attempt whose
persisted `plaid_item_id` differs from this request's item). Add a concurrent-same-command test
asserting exactly one connection + one credentials row + the winner not clobbered.

## FIX 7 (deterministic acceptance evidence) — de-flake the 05 safe-stale test
`05-webhook.test.ts` safe-stale case seeds a key expiring in 1500ms then waits 1800ms (wall-clock
race vs token `iat`). **Fix:** drive expiry/grace from fixed `iat`/clock inputs (e.g. key
`expired_at` well beyond the signed token `iat`, refresh_after in the past) so the safe-stale path
is exercised deterministically without a real-time sleep race.

## GATE
`pnpm -w typecheck && pnpm -w lint && pnpm -w test`, `supabase test db`, `scripts/dev/itest.sh`
(all existing + new cases; NO regression; C5c fetch-spy 0). Update NOTES.md + PROGRESS.md.

## DEFER (document in NOTES; do NOT build now) — genuinely safe for a server-only Sandbox read path
- C5b M6 (orphaned OPEN attempts accumulate — idempotency+lease prevent double economics).
- C5b m8/m9 (complete_attempt `state='open'` predicate — C5c already added the status+generation
  fence, T9 proves stale completion fenced; extra predicate is defense-in-depth).
- C3 #3 (`apply_promotion` unfenced — simulator-only path, never user-disconnected).
- C3 #5 (duplicate-item finalize replay 200-vs-409 — cosmetic after reaper cleanup).
- C3 F2 (`keel_get_connection_credential_envelope` household arg — gated by membership + AAD; no
  live exposure).
- C4 F1/F3 (redundant hashing; stale `PLAID_WEBHOOK_JWK` env scaffolding — cosmetic).
- Audit #6/#7 (meter/JWK DB-side scope+shape validation — defense-in-depth; only trusted
  service-role callers, which already validate in Edge). Worth a 1D hardening pass.
- Audit #8 (KEK-rotation operational RPC/route — `rewrapDek` helper + test exist; the operator
  routine is an OPS concern → a rotation ⚑ / 1D, not a read-path code gate).

## DEPLOY-TIME ⚑ (human checkpoints — NOT code gates; record in the tag notes) — audit #12
Real linked-Sandbox live pull; `/sandbox/item/reset_login` reauth run; live KEK rotation-then-sync
run; Plaid Dashboard webhook URL + first live delivery; vaulted-secret HTTP cron schedules for
/worker/drain, /worker/reap-links, /scheduled/tick; production (non-sandbox) linking. The
`stage-1c` tag certifies CODE-COMPLETE + HERMETICALLY-PROVEN; these live gates are the deploy ⚑.
