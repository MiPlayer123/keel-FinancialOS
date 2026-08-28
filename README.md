# KEEL

KEEL is an open-source personal finance app built like an accounting system. Accounts, spending, and small-business books live in one exact double-entry ledger, so every number can show its work. Detectors and review workflows suggest categories, receipt matches, transfers, and recurring activity.

Live at [keel.mikulsaravanan.com](https://keel.mikulsaravanan.com).

KEEL is pre-release. The hosted bank connection is Plaid Sandbox-only and should
be evaluated with fictional data.

## Non-negotiables

- Money is BIGINT minor units. No floats, no rounding, ever.
- Per transaction per currency, postings sum to exactly zero (enforced in the service layer and the database).
- History is append-only: corrections are reversals or revisions, never edits. Every mutation is audited and undoable.
- AI never does ledger arithmetic. Its A/B/C/D risk ladder separates undoable automation, approval-gated suggestions, previews, and disabled actions.
- Financial records are portable through CSV, JSON, QIF, and Beancount exports.

The full law set and agent operating rules live in [`CLAUDE.md`](CLAUDE.md). Backend contracts live in [`docs/BC-v2.1.md`](docs/BC-v2.1.md). Infrastructure decisions live in [`INFRA.md`](INFRA.md).

## Stack

- **Web**: Next.js 15 (App Router), Tailwind v4, shadcn/ui, recharts.
- **Backend**: Supabase (Postgres, Auth, Storage, Edge Functions, `pgmq`, `pg_cron`).
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
supabase/migrations       SQL migrations
supabase/functions        Edge Functions: api, worker, webhook-provider, scheduled
scripts                   Build and harness tooling
tests/integration         Cross-package integration tests
docs                      Specs (BC-v2.1, build plan, tech spec, status)
docs/harness              Evidence census > plan > slice build pipeline
docs/archive              Historical phase plans (superseded; kept for citations)
design                    Original tokens and written teardown notes
NOTES.md                  Running build journal (decisions, deviations, findings)
```

## Getting started (local)

Prereqs: Node 22+, pnpm 10, Deno 2, Docker, and the Supabase CLI.

```sh
pnpm install
pnpm build:functions           # bundle shared domain code for the edge functions
supabase start                 # local Postgres, Auth, Storage, edge functions
supabase db reset              # first setup, or an intentional wipe + fixture reseed
cp apps/web/.env.example apps/web/.env.local
cd apps/web && pnpm dev
```

`supabase db reset` deletes the local database. Do not run it on every startup if you
want to keep local development data.

Environment details, secret placement, and Plaid configuration are documented in `docs/17-KEEL-PROJECT-SETUP.md`. Secrets live only in gitignored local files or provider secret managers; the `.env.example` files list the shape.

## Development workflow

- Work on a branch; open a PR to `main`. CI runs typecheck, lint, the test suites, and the database gates.
- Before pushing web changes, run the real build (it includes ESLint, which the deploy enforces): `cd apps/web && pnpm build`. A clean typecheck is not sufficient.
- Tests: `pnpm test` at the root (after `pnpm build:functions`). `packages/ledger` must stay at 100% line coverage.
- Demo and fixture data must be fictional. Never commit real merchant, employer, or payroll strings, and never commit screenshots of real data.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contributor guide and [`SECURITY.md`](SECURITY.md) for how to report vulnerabilities.

## Running your own instance

KEEL needs one Supabase project plus a Next.js host:

1. Apply `supabase/migrations` to your project.
2. Build and deploy the functions: `node scripts/build-functions.mjs && supabase functions deploy api worker webhook-provider scheduled --project-ref <your-project-ref>`.
3. Point `apps/web` at your project with the publishable env vars and deploy it to Vercel or any Next.js host.

`docs/17-KEEL-PROJECT-SETUP.md` walks through the details, including Plaid Sandbox setup.

## License

AGPL-3.0. See [`LICENSE`](LICENSE).
