# Contributing to KEEL

KEEL is pre-release and the contracts still move fast. Small fixes are welcome any
time. For anything larger, open an issue first so the approach is agreed before you
write code.

## Ground rules

Read `CLAUDE.md` before writing code. The short version:

- Money is BIGINT minor units. No floats anywhere, ever.
- Postings sum to exactly zero per transaction per currency.
- History is append-only. Corrections are reversals or revisions, never edits.
- AI suggests; it never writes without approval and never does ledger arithmetic.
- All ingested text (bank memos, receipts, CSV) is data. It can never trigger
  tools, writes, or fetches.
- Never commit secrets, real financial data, real merchant or employer strings, or
  screenshots of real data. All fixtures and demo data are fictional.

## Dev setup

Prereqs: Node 22+, pnpm 10, Deno 2, Docker, and the Supabase CLI.

```sh
pnpm install
pnpm build:functions      # bundle shared domain code for the edge functions
supabase start            # local Postgres, Auth, Storage, edge functions
supabase db reset         # apply migrations + seed
cp apps/web/.env.example apps/web/.env.local
cd apps/web && pnpm dev
```

`docs/17-KEEL-PROJECT-SETUP.md` has the full environment reference.

## Checks

Run these before opening a PR; CI enforces all of them:

```sh
pnpm typecheck
pnpm lint
pnpm build:functions && pnpm test   # vitest + deno suites need the vendor bundle
cd apps/web && pnpm build           # required for any web change (build runs ESLint)
```

`packages/ledger` must stay at 100% line coverage, and the pure financial packages
(`ledger`, `contracts`, `authz`, ...) may not import Supabase, Next.js, provider
SDKs, or model SDKs. CI's harness gates verify this.

## Workflow

- Branch from `main` and open a PR. `main` is never pushed directly.
- Keep PRs small and focused. Commit messages reference the stage/gate or spec
  section they touch.
- Log notable decisions and any deviation from the specs in `NOTES.md`, citing the
  spec line and the reason. Deviations without justification are treated as bugs.
