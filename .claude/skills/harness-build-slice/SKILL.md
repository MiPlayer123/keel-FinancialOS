---
name: harness-build-slice
description: Build one slice from an approved plan — freeze tests first, then implement until the frozen suite is green, then UI + Playwright evidence, then open a PR. Args: <slice-slug>.
---

# Harness build-slice

Build `docs/harness/slices/<slug>.md` end to end on branch
`claude/slice-<slug>`. Precondition: the owning plan's ⚑ taste pass is
approved. The slice doc is your contract and your log — append phase result
blocks as you go.

## Step 1 — Freeze tests (before ANY implementation)

Author the complete test surface for the slice's scenario list: pgTAP for
schema/RLS/proc guards, vitest for package logic, integration tests for api
routes. One test (or parametrized group) per scenario; check scenarios off as
covered. Tests for routes/procs that don't exist yet are authored to the
CONTRACT and will be red — that red is correct.

Commit the tests alone. Record the commit sha as `baseline` in the slice
doc's `tests-frozen` block. From this point the tests are the frozen
verifier.

Rules: never stub implementation to make a test pass; never `skip`/`todo` a
red; if the spec and existing code disagree, the test asserts the spec and
the divergence goes to NOTES.md.

## Step 2 — Implement (goal: green without touching tests)

Migrations → procs → api route → client (`apps/web/src/lib/keel-api.ts`) →
UI, section by section, foundational first. Success condition, all of:

- full suite green (`pnpm test`, `supabase test db`, integration);
- `node scripts/harness/verify-frozen-tests.mjs --baseline <sha>` exits 0;
- `node scripts/harness/verify-purity.mjs` and
  `node scripts/harness/verify-reachability.mjs` exit 0 (a new api route must
  be wired into the UI in this same slice — that is the point);
- `pnpm typecheck && pnpm lint` green.

If a frozen test is genuinely wrong: STOP implementation, fix it as a
separate tests-only commit with justification in the slice doc, record the
new baseline, resume. Never mix test edits into implementation commits.

KEEL laws bind everywhere: every mutation audited and reversible (Law 2),
postings balance (Law 3), bigint minor units (Law 4), no privileged side
doors (Law 7).

## Step 3 — UI evidence

Implement the acceptance flows as Playwright specs against the local stack.
Capture per-flow screenshots at desktop and 390px into the PR. Error states
must show backend messages verbatim; empty states must exist.

## Step 4 — Self-verify, then hand off

Re-read the slice doc top to bottom and check every contract line and
scenario against what exists on disk — run the commands, don't trust memory.
Append the `implemented` block (issues → NOTES.md as I-entries). Then request
independent review via the `harness-verify-slice` skill in a FRESH session —
never verify your own slice — and only open the PR (evidence: test summary,
verifier outputs, screenshots, slice doc link) after that verdict is `pass`.
Subscribe to PR activity and babysit CI until merge.
