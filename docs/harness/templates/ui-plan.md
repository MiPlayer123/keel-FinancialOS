# Plan — `<plan-id>`

<!--
Synthesis output: census records adjudicated against KEEL's current state and
design laws, producing dispositions and a slice backlog. The conservation
check is mechanical: every census record in every input drop appears in
exactly one disposition row below.

⚑ HUMAN TASTE PASS REQUIRED before any slice from this plan is built.
-->

- **Plan id:** `<plan-id>` · **Date:**
- **Input drops:** `<drop-id>, …` (`N` census records total)
- **KEEL baseline:** commit `<sha>` — what "already-have" was judged against
- **Approved by (⚑):** _pending_

## Dispositions

<!-- one row per census record; counts must reconcile with the manifests -->

| Record | Pattern observed | Disposition | Rationale | Slice |
|--------|------------------|-------------|-----------|-------|
| E-001 | recurring list groups by merchant with next-due sort | adopt | closes T0.10 gap; KEEL has procs, no grouping | S-recurring-v2 |
| E-002 | pause requires until-date | adapt | KEEL pause is indefinite; add optional until | S-recurring-v2 |
| E-003 | neon category badges | reject | violates design tokens (financial calm) | — |

Disposition counts: adopt `N` · adapt `N` · reject `N` · already-have `N` · defer `N` · **total `N` = records `N`** ✓

## Cross-cutting findings
Patterns seen across ≥2 sources (strong signal): IA conventions, status
placement, empty-state copy tone. Backend gaps implied by UI evidence (each
becomes a backend line in a slice doc).

## Slice backlog

| Slice | Title | Evidence | Depends on | Size |
|-------|-------|----------|------------|------|
| S-… | | E-…, E-… | | S/M/L |

Ordering rationale (dependencies, user value, risk).

## Rejected / deferred log
Why each reject/defer was ruled — so future sessions don't re-litigate.
