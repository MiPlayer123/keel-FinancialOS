# KEEL slice pipeline (build harness)

Automated plan → build → test → validate → deploy loop for closing KEEL's
feature/UI gap, adapted from a proven agent-build-harness methodology. The
spine is source-agnostic:

```
evidence source → structured records → adjudicated plan → slice docs → build loop → PR ⚑ → deploy → probe
```

Screenshots, competitor docs, spec deltas (BC-v2.1 vs built), and usage
feedback are all just **evidence adapters** feeding the same pipeline. The
build loop only ever consumes slice docs and never cares where they came from.

## Non-negotiable rules (inherited + KEEL laws)

1. **Conservation.** Every evidence record exits with an explicit disposition
   (`adopt | adapt | reject | already-have | defer`). Nothing is dropped
   silently. Mechanical checks verify counts.
2. **The model never grades itself.** Work is checked by (a) mechanical
   verifiers, (b) an independent verify agent with no build context, and
   (c) the human PR merge (⚑ — this is Law 2 suggest→approve applied to the
   build itself).
3. **Frozen tests.** Slice tests are authored and committed before
   implementation; `scripts/harness/verify-frozen-tests.mjs --baseline <sha>`
   proves the implementer never touched them. Wrong tests cascade back to the
   test phase (new baseline recorded in the slice doc), never edited in place.
4. **Never edit a verifier to make a build pass.** Verifiers are the contract.
5. **Structured results, not prose.** Every phase ends by writing its result
   block into the slice doc (status, issues, evidence refs), and unresolved
   findings go to NOTES.md with an ID — the cross-phase issues ledger.
6. **Patterns, never pixels.** Competitor evidence is synthesized into
   information architecture and interaction grammar, expressed in KEEL's own
   design tokens (financial calm; red = negative money only; status adjacent
   to the number it qualifies; usable at 390px). Never clone a competitor's
   visual identity.

## Phases

| Phase | Skill / tool | Output | Gate |
|---|---|---|---|
| 0a. Census | `harness-census` | one census record per evidence unit | manifest count == record count |
| 0b. Synthesize | `harness-synthesize-plan` | `docs/harness/plans/<plan>.md` | every record dispositioned; ⚑ human taste pass |
| 1. Slice | (part of synthesize) | `docs/harness/slices/<slug>.md` | slice-doc template complete |
| 2. Freeze tests | `harness-build-slice` step 1 | committed red/green tests, baseline sha in slice doc | tests cite scenarios; committed before impl |
| 3. Implement | `harness-build-slice` step 2 | backend/UI code | suite green + `verify-frozen-tests` + CI gates |
| 4. Verify | `harness-verify-slice` (fresh session) | verdict block in slice doc | independent pass required |
| 5. PR ⚑ | PR + CI babysit | PR with evidence (tests, screenshots) | human merge |
| 6. Deploy | existing workflows | live functions/migrations | `deploy-functions.yml` gated on green CI |
| 7. Probe | post-deploy check | status report | `/health` + smoke against real project |

## Mechanical verifiers (`scripts/harness/`)

- `verify-purity.mjs` — pure financial packages import no Supabase/Next/
  provider/model SDKs (CLAUDE.md repo-shape law). Runs in CI.
- `verify-reachability.mjs` — every `api` Edge Function route is invoked from
  `apps/web`, and every web invocation hits a real route. Intentionally
  UI-invisible routes live in `reachability-allowlist.json` with a reason.
  Runs in CI. This is the conservation gate that makes "backend live but
  unreachable from the UI" impossible to ship silently.
- `verify-frozen-tests.mjs --baseline <sha>` — no test file changed since the
  slice's frozen baseline. Run per-slice during implementation and in the
  verify phase (baseline comes from the slice doc, so it is not a global CI
  step).

## Directory map

```
docs/harness/
  README.md            ← this file
  templates/           ← contracts for every artifact
  evidence/<drop>/     ← raw evidence + manifest.md (append-only; never edit raw evidence)
  census/<drop>/       ← census records (one file per record)
  plans/               ← adjudicated plans with dispositions
  slices/              ← slice docs (the build loop's only input)
.claude/skills/        ← phase skills (harness-census, harness-synthesize-plan,
                         harness-build-slice, harness-verify-slice)
scripts/harness/       ← mechanical verifiers
```

## Human checkpoints (⚑)

Kept deliberately at the two cheapest-leverage points:

1. **Plan taste pass** — review `plans/<plan>.md` dispositions before slices
   build against it ("scope review is cheap; spec rework is not").
2. **PR merge** — the deploy gate. Merging to `main` auto-applies migrations
   (Supabase GitHub integration) and deploys functions (`deploy-functions.yml`
   after green CI).

Everything else — census fan-out, synthesis, test freezing, implementation,
independent verify, CI babysitting, post-deploy probe — runs without a human.
