# TASK-000 — Stage 1A: Supabase-first deterministic spine scaffold

## Read first

1. `CLAUDE.md`
2. `INFRA.md`
3. `PROJECT-SETUP.md`
4. `docs/BC-v2.1.md`
5. this task

## Objective

Create the smallest runnable monorepo that proves the KEEL financial spine locally on Supabase CLI/Docker and can deploy unchanged to the configured Supabase Free project.

## In scope

- `pnpm` workspace and TypeScript configuration
- `apps/web` minimal Next.js shell and Supabase Auth smoke flow
- pure packages: `contracts`, `ledger`, `authz`, `test-fixtures`
- `supabase/config.toml`, migrations, seed data, database tests
- Edge Functions: `api`, `worker`, `webhook-provider`, `scheduled`
- publishable-key/user-JWT function auth via `@supabase/server`
- named-secret auth for worker/scheduled functions
- money in integer minor units
- households, memberships, entities, accounts, owners, resource grants
- immutable raw provider event records
- canonical transaction + journal batch/posting/revision skeleton
- audit event, domain event, outbox/queue enqueue in one transaction
- idempotency/economic-event keys
- Plaid adapter interface plus simulator; no actual Plaid call until simulator tests pass
- local and CI commands

## Out of scope

- polished UI
- real Plaid production access
- real personal financial data
- hosted AI calls
- investments, receipts, budgets, card offers, payroll, money movement
- external MCP listener
- Fly.io, Render, Redis, Graphile Worker, separate Fastify API

## Required tests

1. Posting batches balance per currency.
2. Financial amounts reject floating-point storage/inputs.
3. Duplicate command/event keys produce one economic result.
4. A revision/reversal preserves the original record.
5. Cross-household access fails through API, SQL/RLS, and query services.
6. Canonical financial tables reject direct authenticated-client writes.
7. Mutation + audit + domain event + queue message commit or roll back together.
8. Duplicate, reordered, delayed, and changed simulator events replay deterministically.
9. User-facing Edge Function rejects missing/invalid user JWT.
10. Worker/scheduled function rejects publishable/user credentials and accepts only its named secret.
11. Plaid webhook fixture validates signature/body-hash contract before raw event promotion.
12. Secret scan proves no Plaid/Supabase privileged key is committed or bundled.

## Completion gate

Stop after the local stack starts from a clean checkout, all migrations are idempotent, all required tests pass, and `NOTES.md` records commands, decisions, deviations, and remaining human checkpoints. Do not advance to live Plaid Sandbox work automatically.
