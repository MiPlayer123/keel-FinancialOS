# KEEL v3.2 — Infrastructure and environment configuration changelog

**Date:** 2026-07-10

## Adopted

- Supabase-first Stage 0–2 architecture: local Supabase CLI/Docker and one Supabase Free cloud project.
- Next.js frontend on Vercel Hobby for personal/non-commercial use.
- Supabase Postgres, Auth, Storage, Edge Functions, `pgmq`, and `pg_cron`; no Fly.io/Render layer now.
- Current public Supabase binding: project ref `yrbteeownwjhcushwaga` and its publishable browser key in `.env.example`.
- Plaid Sandbox integration contract and verified webhook handling.
- Supabase's current publishable/secret-key Edge Function auth model using `@supabase/server`.
- Secret placement, ignored environment templates, rotation requirement, and deployment commands.

## Security ruling

The Plaid Sandbox secret shared during planning is not included anywhere in this corpus and must be rotated before use. Plaid client IDs, secrets, access tokens, Supabase secret keys, database passwords, and AI keys remain outside source control.

## Conflict cleanup

- `INFRA.md` now explicitly supersedes old Cloud Run/Fastify/Better Auth/Graphile references for Stage 0–2.
- `CLAUDE.md`, build plan, and technical specification now align with the Supabase-first runtime.
- The previously missing canonical backend document is included as `BC-v2.1.md`.

## Status

Good for local development, Plaid Sandbox, and personal free cloud testing. Not approved yet for production bank access, external users, or uptime/backup claims.
