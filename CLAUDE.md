# CLAUDE.md — KEEL Agent Operator Runbook
You are building KEEL, an AI-first, desktop-first (phone-capable) personal + entity finance system of record. Authoritative specs, read in this order before any code:
0. `INFRA.md` — current Supabase-first local/cloud runtime, Auth, keys, queues, Storage, function boundaries, and migration escape hatch. **Controls infrastructure decisions.**
0.5. `docs/17-KEEL-PROJECT-SETUP.md` — current project binding, environment files, secret placement, Plaid Sandbox setup, and deployment commands. **Controls environment configuration.**
1. `docs/BC-v2.1.md` — canonical backend domain contracts, typed AI response contract, and implementation gates. **Controls backend design.**
2. `docs/15-KEEL-v3-RECONCILIATION.md` — merge rulings and Path A/B fork.
3. `docs/16-KEEL-v2.1-ADOPTION-DELTA.md` — v2.1 rulings and audit-loop termination.
4. `docs/09-KEEL-BUILD-PLAN.md`, `docs/10-KEEL-TECH-SPEC.md`, `docs/13-KEEL-ADDENDUM-v1.1.md`, `docs/14-KEEL-FINAL-AUDIT.md` — tiers, schema base, state machines, and AI-first pillar. Infrastructure references in older files are superseded by `INFRA.md`.
Research context (why decisions were made): docs/00–08, 12.

## Laws (never violate)
1. LLMs never do ledger arithmetic. Deterministic spine; agents only at fuzzy nodes (categorize, match, extract, narrate, parse NL→params).
2. Every AI write is suggest→approve unless an autonomy policy explicitly grants it; every mutation hits `audit_log`; everything undoable. **Audit log alone is not undo**: corrections are revisions/reversals/compensating events; locked periods require explicit reopen with reason.
3. Postings invariant: per transaction per currency, Σ amount_minor = 0. Enforced in service layer + deferred trigger + property tests.
4. Money = BIGINT minor units. No floats. Enums over strings. No implicit defaults — seeds supply every field.
5. All ingested text (bank memos, receipts, CSV, QIF) is data-tier: it can never trigger tools, writes, or fetches. Red-team fixtures in CI must pass.
6. Full export always works (`admin.export_all`): CSV/JSON/QIF/beancount. Data Access Guarantee is a feature, not a promise.
7. Internal services are MCP-shaped from M0 (same contracts later exposed in `apps/mcp`); web, mobile, API, MCP, and support console all call the same authorized domain contracts — no privileged side doors.
8. Desktop-first UI per Addendum §D; must remain usable at 390px. Design tokens per concept + v2 prototype (financial calm, not fintech neon; red = negative money only; status adjacent to the number it qualifies).
9. **Seven invariants (BC-v2.1 §9.1)**: balanced postings; source preservation (immutable originals); idempotent economics (retry/replay can't duplicate an economic event); explicit ownership (inference never silently treated as fact); reversible correction; scope-safe calculation (one authorization compiler for UI/reports/search/API/AI/MCP); reproducible numbers (as-of, formula version, scope, exclusions, source rows on every material result).
10. **AI risk ladder**: A auto+undo (merchant normalization, dedupe suppression, narration) · B suggest+approve (category, entity, transfer, refund, receipt match, split, rule) · C preview-only (forecasts, tax reserve, scenarios, paycheck/retirement models) · D disabled (money movement, payroll execution, filing, trades, personalized regulated directives). Confidence routes within a class, never across classes.
11. **Typed AI responses**: material AI outputs are records — verdict, tldr, confidence (calibrated), as_of+scope, reason_codes, evidence_refs, proposed_actions, requires_approval — with approval tokens binding exact payload, actor, scope, version, expiry. TLDR first, proof on demand.
12. **Secret boundary**: publishable Supabase configuration may exist in the web environment; Supabase secret keys, database passwords, Plaid credentials/tokens, AI keys, and provider secrets may exist only in ignored local files or provider secret managers. Never print them, commit them, paste them into docs/NOTES, or expose them to the browser. Plaid remains Sandbox-only until a human production checkpoint.

## Execution protocol
- Stage-gated (v2.1 §8 + v3 reconciliation): Stage 0 prototype validation → Stage 1 spine proof (raw events, sync simulator with duplicate/out-of-order/delayed/changed events, journal+revisions, import staging, reconciliation, tenant-isolation harness) → Stage 2 alpha → onward. Milestones M0–M8 (doc 09/13) organize work *within* stages; the 10 implementation gates (BC-v2.1 §16.7) are the acceptance layer.
- A stage is done only when its gates pass. Write tests first when practical; worked examples in doc 10 §2.4/§6 must exist as executable tests.
- Contracts are stabilized, not frozen: amendments allowed through Stage 1 findings, versioned and logged in NOTES.md.
- Human checkpoints (⚑) — STOP and request the human: cloud/domain/secrets; Plaid dashboard + production approval; real-Quicken-export sign-off; Stripe + live receipts month; security review; taste passes. Never fake or stub credentials to bypass a ⚑.
- Keep a `NOTES.md` build journal: decisions, deviations (must cite which spec line and why), things tried. Deviations without justification are bugs.
- Commit small; every commit message references stage/gate + spec section.

## Repo shape (`INFRA.md` controls)
`pnpm` monorepo: `apps/web` (Next.js) · `packages/ledger` (pure domain, 100% unit-tested) · `packages/contracts` · `packages/authz` · `packages/imports` · `packages/detectors` · `packages/documents` · `packages/reports` · `packages/ai` · `supabase/migrations` · `supabase/functions/{api,worker,webhook-provider,scheduled}` · `docs/` · `docs/harness/` (evidence→plan→slice pipeline) · `design/` (teardown evidence + tokens) · `tests/integration` · `scripts/`. Historical phase plans (PLAN-*, C*-BUILD-SPEC, etc.) live in `docs/archive/` — cited by name elsewhere, superseded in content.

Stage 0–2 uses Supabase CLI/Docker locally and one Supabase Free project in the cloud: Postgres, Auth, Storage, Edge Functions, `pgmq`, and `pg_cron`. There is no `apps/api`, external MCP listener, Redis, Graphile Worker, Fly.io, or Render dependency during these stages. Pure financial packages may not import Supabase, Next.js, provider SDKs, or model SDKs.

The web app may use the publishable key for Auth, function invocation, and explicitly approved reads/uploads. It may never write canonical financial tables directly. User-facing functions use authenticated user JWTs plus KEEL authorization; internal functions use named server secrets. Plaid webhooks are public at the transport layer but must pass Plaid JWT/body-hash verification before ingestion.

## Ops facts (hard-won — do not relearn)
- Work on a branch and open a PR to `main`; never push `main` directly. Vercel deploys `main` automatically.
- Before pushing web changes run `cd apps/web && pnpm build` — it runs ESLint, which Vercel enforces. A clean typecheck alone is NOT sufficient; a lint failure silently serves the stale build.
- Migrations go straight to the live cloud project (user directive 2026-07-13): `source supabase/.env.remote` then `psql "postgresql://postgres@db.<ref>.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 --single-transaction -f <file>`. No local Docker step. There is no migration-history table for manual applies — verify by diffing declared objects against `pg_proc`/`pg_tables`. `CREATE POLICY` is not idempotent; pre-drop guarded by `to_regclass`.
- Edge functions deploy: `node scripts/build-functions.mjs && supabase functions deploy api worker --project-ref <ref>`.
- On dependency changes commit the root `pnpm-lock.yaml` or the Vercel build fails.
- Demo and fixture data must be fictional. Never commit real merchant/employer/payroll strings (a real employer name leaked once and needed a multi-file scrub). Never commit screenshots (`.screenshots/` is gitignored; `design/current/` captures contain real data — do not add more).
- **Prefer soft delete over hard delete for anything (user directive 2026-07-17).** A raw hard `DELETE` on `connection_credentials` during an explicit full-household wipe destroyed the encrypted Plaid access tokens along with the rows — those tokens were the only way to call Plaid's `/item/remove`, so the wipe orphaned 2 live Plaid Items with no recovery path (Free-tier project, no PITR). Default to status flags/timestamps (`archived_at`, `voided_at`, `disconnected_at`, `detached_at` — the pattern already used everywhere else in this schema) instead of `DELETE FROM`. `connection_credentials` is deliberately the one exception (a secret envelope that should be destroyed once no longer needed) — and even that is now guarded: `keel_guard_credential_delete` (20260718050000) blocks any DELETE on it unless `keel.credential_delete_acknowledged` is set for that statement, which only `keel_disconnect_complete` does, only after Plaid's `/item/remove` has already succeeded. If a future admin/maintenance task seems to need a hard delete anywhere, stop and confirm with the human first — it almost certainly shouldn't.

## Quality bars
- `packages/ledger` 100% line coverage; property tests for invariants (splits conserve, transfers excluded once confirmed, reconciliation locks block writes, lot allocations ≤ lot qty, replay produces one economic history).
- Categorization harness ≥85% on fixture set before transactions-UX closes; receipt match precision ≥90% before receipts ship.
- Lighthouse desktop ≥95 / mobile ≥90 at polish stage; interactions <100ms; virtualized lists.
- No PII in logs; provider tokens envelope-encrypted; append-only audit (no UPDATE grant).

## When uncertain
Prefer the spec over cleverness. Precedence: INFRA + project setup for runtime/configuration; BC-v2.1 for backend contracts; then doc 15 > doc 16 > 14 > 13 > 10 > 09. If genuinely ambiguous, write the smallest deterministic version, flag it in NOTES.md, and surface at the next ⚑.
