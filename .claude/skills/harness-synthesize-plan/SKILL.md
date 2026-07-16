---
name: harness-synthesize-plan
description: Adjudicate census records against KEEL's current state and design laws into a plan with dispositions and a slice backlog. Use after harness-census completes. Args: <plan-id> <drop-id>[,<drop-id>…].
---

# Harness synthesize-plan

Turn census records into `docs/harness/plans/<plan-id>.md` (template:
`docs/harness/templates/ui-plan.md`) and slice docs (template:
`docs/harness/templates/slice-doc.md`).

## Steps

1. **Baseline.** Establish what KEEL already has: read `PLAN-FEATURE-PARITY.md`,
   walk `apps/web/src` routes/nav, and list api routes
   (`grep "path === '" supabase/functions/api/index.ts`). Record the baseline
   commit sha in the plan.
2. **Disposition every record** — `adopt | adapt | reject | already-have |
   defer`, each with a rationale. Judgment criteria, in order:
   - KEEL laws win: design tokens (financial calm, red = negative money only,
     status adjacent to its number, 390px), Law 1 determinism, Law 2
     suggest→approve, risk ladder. A pattern that violates a law is `reject`
     or `adapt`, never `adopt`.
   - Patterns seen across ≥2 sources outrank single-source patterns.
   - Patterns, never pixels: extract IA and interaction grammar, restate in
     KEEL's own design language. Never copy visual identity, copy text
     verbatim, or clone a competitor's look.
3. **Conservation.** The disposition table must account for every census
   record across all input drops; reconcile the counts line. Nothing dropped
   silently.
4. **Backend gaps.** Where UI evidence implies missing backend (a view that
   needs data no proc returns), record it in cross-cutting findings and put a
   backend delta line in the owning slice.
5. **Cut slices.** Group adopt/adapt rows into buildable slices (S/M — a
   slice should be one PR). Write each `docs/harness/slices/<slug>.md` with
   contract, scenarios (2N rule), and acceptance flows filled in. Every slice
   cites its evidence records and spec sections.
6. **STOP for the ⚑ taste pass.** Mark the plan "Approved by: pending" and
   surface it to the human. Do NOT start harness-build-slice until the plan
   is approved — plan review is cheap; slice rework is not.

## Self-verification (mandatory before finishing)

- Disposition count == census record count, per drop and total.
- Every adopt/adapt row names its slice; every slice's evidence refs resolve.
- No slice contract contains an endpoint in its user-visible-behavior section
  (behavioral language only).
- Every scenario list satisfies 2N: each state transition has a happy path
  and a named-guard violation.
