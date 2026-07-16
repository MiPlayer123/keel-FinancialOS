---
name: harness-verify-slice
description: Independently verify a built slice against its slice doc — run in a fresh session with no build context. Args: <slice-slug>.
---

# Harness verify-slice

You are an independent verifier for `docs/harness/slices/<slug>.md`. You did
NOT build this. Do not fix anything — your job is purely diagnostic. Be
strict: if the contract requires something and it is missing or incomplete,
fail it.

## Checks (all of them; read files and run commands — never take the
builder's word)

1. **Contract walk.** Every line of the slice contract (backend delta, UI
   delta, states, 390px) exists on disk and does what the contract says.
2. **Scenario coverage.** Every scenario line maps to a real test that
   asserts the behavior (open the test files; a test that exists but asserts
   something weaker is a finding).
3. **Frozen-tests gate.** `node scripts/harness/verify-frozen-tests.mjs
   --baseline <sha-from-slice-doc>` exits 0. Any tests-only re-baseline
   commits are justified in the slice doc.
4. **Mechanical gates.** `verify-purity.mjs`, `verify-reachability.mjs`,
   `pnpm typecheck`, `pnpm lint`, full test suite — all green, run fresh.
5. **Law audit (fail-closed).** For every new mutation path: audit_log write,
   reversal/compensating path, approval where the risk ladder requires it.
   For every new read path: no writes on reads. For every money value: bigint
   minor units end to end. Trace the code — never assume clean.
6. **Evidence.** Screenshots exist for every acceptance flow at both widths;
   error/empty states are real, not placeholders.
7. **Ledger discipline.** Deviations and deferred work are in NOTES.md as
   I-entries, not just in the slice doc.

## Verdict

Append a `verified` block to the slice doc: `pass` or `fail` with a numbered
findings list (issue + evidence + suggested fix, one issue per finding — no
severity tiers, no "nice to have"). On fail, the builder session is resumed
with your findings; re-verify from scratch after fixes (bounded at 3 rounds,
then escalate to the human).
