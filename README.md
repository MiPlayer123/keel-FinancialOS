# KEEL

KEEL is an AI-first personal and entity finance system of record. One deterministic double-entry ledger holds everything you and your businesses own, owe, earn and spend; AI works only the fuzzy edges (categorizing, matching, narrating) and every material suggestion waits for explicit approval.

Live at [keel.mikulsaravanan.com](https://keel.mikulsaravanan.com) (Vercel, deployed from `main`).

## Non-negotiables

- Money is BIGINT minor units. No floats, no rounding, ever.
- Per transaction per currency, postings sum to exactly zero (enforced in the service layer and the database).
- History is append-only: corrections are reversals or revisions, never edits. Every mutation is audited and undoable.
- AI never does ledger arithmetic and never writes without approval (risk ladder A/B/C/D; see `CLAUDE.md`).
- Full export always works: CSV, JSON, QIF, Beancount. The Data Access Guarantee is a feature, not a promise.

The full law set and agent operating rules live in [`CLAUDE.md`](CLAUDE.md). Backend contracts live in [`docs/BC-v2.1.md`](docs/BC-v2.1.md). Infrastructure decisions live in [`INFRA.md`](INFRA.md).

## Stack

- **Web**: Next.js 15 (App Router), Tailwind v4, shadcn/ui, recharts. Deployed on Vercel.
- **Backend**: Supabase (Postgres, Auth, Storage, Edge Functions, `pgmq`, `pg_cron`). Cloud project ref `yrbteeownwjhcushwaga`.
- **Bank data**: Plaid.
- **Monorepo**: pnpm workspaces.

## Repository map

```
apps/web                  Next.js app (marketing landing + dashboard)
packages/ledger           Pure domain logic, 100% unit-tested, no I/O imports
packages/contracts        Shared typed contracts
packages/authz            Authorization compiler (one scope path for all surfaces)
packages/imports          CSV/QIF import parsing and staging
packages/detectors        Recurring/transfer/categorization detection
packages/documents        Receipts and documents
packages/reports          Report calculators
packages/ai               AI provider-agnostic core
supabase/migrations       SQL migrations (applied to the live project; see below)
supabase/functions        Edge Functions: api, worker, webhook-provider, scheduled
scripts                   Build and harness tooling
tests/integration         Cross-package integration tests
docs                      Specs (BC-v2.1, build plan, tech spec, status)
docs/harness              Evidence census > plan > slice build pipeline
docs/archive              Historical phase plans (superseded; kept for citations)
design                    Competitor teardown evidence, tokens, current-app captures
NOTES.md                  Running build journal (decisions, deviations, findings)
```

## Getting started

```sh
pnpm install
cd apps/web && pnpm dev        # web app against configured Supabase project
```

Environment setup, secret placement, and Plaid configuration are documented in `docs/17-KEEL-PROJECT-SETUP.md`. Secrets live only in gitignored local files or provider secret managers; `.env.example` lists the shape.

## Development workflow

- Work on a branch; open a PR to `main`. Vercel deploys `main` automatically.
- Before pushing web changes, run the real build (it includes ESLint, which Vercel enforces): `cd apps/web && pnpm build`. A clean typecheck is not sufficient.
- Migrations are applied directly to the live Supabase project with `psql --single-transaction` (see `supabase/.env.remote`, gitignored). There is no local Docker step and no migration-history table for manual applies; verify by object diff.
- Edge functions deploy: `node scripts/build-functions.mjs && supabase functions deploy api worker --project-ref yrbteeownwjhcushwaga`.
- Tests: `pnpm test` at the root (vitest workspaces); ledger package must stay at 100% line coverage.
- Demo and fixture data must be fictional. Never commit real merchant, employer, or payroll strings, and never commit screenshots of real data (`.screenshots/` is gitignored).
