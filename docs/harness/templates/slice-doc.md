# Slice — `<slug>`

<!--
The build loop's ONLY input. A slice is buildable when every section below is
filled. Phases append their result blocks at the bottom — this file is the
slice's structured state, its audit trail, and the verify agent's contract.
-->

- **Slice:** `S-<slug>` · **Plan:** `<plan-id>` · **Evidence:** E-…, E-…
- **Spec cites:** (BC-v2.1 §…, docs/09 T…, CLAUDE.md law …)
- **Branch:** `claude/slice-<slug>`

## Contract

**User-visible behavior** (domain language, no endpoints): what a member can
do after this ships that they couldn't before.

**Backend delta:** migrations, procs, api routes (each new route must be
UI-reachable or allowlisted — verify-reachability). Note audit_log +
undo/reversal path for every mutation (Law 2), postings invariant impact
(Law 3), bigint minor units (Law 4).

**UI delta:** pages/components, nav placement (organize by workflow, not by
table), states (empty/loading/error — error text shown verbatim from
backend), 390px behavior, design-token notes (red = negative money only;
status adjacent to its number).

## Scenarios (test backlog — 2N rule)

One line per testable behavior, `snake_case`. Every state transition gets a
happy path AND at least one guard-violation naming the guard. Edge cases one
per line, each with a behavioral outcome (rejected/blocked/yields-nothing).

- [ ] `…_happy_path`
- [ ] `…_rejected_when_<guard>`

## Acceptance flows (Playwright)

Numbered do → expect steps per flow; each produces a screenshot artifact
(desktop + 390px) for the PR.

---

## Phase results (appended by the loop)

### tests-frozen
- baseline: `<sha>` · suites: `<files>` · red-by-design: `<n>` · date:

### implemented
- suite: green · `verify-frozen-tests --baseline <sha>`: pass ·
  `verify-purity` / `verify-reachability`: pass · issues → NOTES.md I-…

### verified (independent session)
- verdict: pass/fail · checklist findings · fix rounds used:

### shipped
- PR: #… · merged: `<date>` · deploy: functions `<run>` / migrations applied ·
  post-deploy probe: `/health` ok, flows ok · follow-ups → NOTES.md I-…
