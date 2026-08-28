# KEEL Project Setup — local + free personal cloud

**Status:** configured for Stage 0–2 development, Plaid Sandbox, and one-person cloud use.

## Security action required before the first Plaid call

The Plaid Sandbox secret was shared outside a secret manager during planning. Treat it as compromised and rotate it in the Plaid Dashboard. Do not put the old or replacement secret into this repository, any Markdown document, `NOTES.md`, screenshots, tickets, or frontend environment variables.

The Supabase publishable key is intentionally public and is safe to use in the browser only when all exposed data has correct RLS policies. Supabase secret keys and Plaid secrets are never browser values.

## Current public project configuration

```text
Supabase project ref: yrbteeownwjhcushwaga
Supabase URL: https://yrbteeownwjhcushwaga.supabase.co
Plaid environment: sandbox
Initial Plaid product: transactions
```

The checked-in `.env.example` contains the current public Supabase URL and publishable key.

## 1. Local setup

```bash
pnpm install
supabase start
cp apps/web/.env.example apps/web/.env.local
cp supabase/functions/.env.example supabase/functions/.env
```

Fill only the ignored server file `supabase/functions/.env` with the rotated Plaid values:

```text
PLAID_CLIENT_ID=...
PLAID_SECRET=...
```

Then run:

```bash
supabase db reset
supabase functions serve --env-file supabase/functions/.env
pnpm --filter @keel/web dev
```

The default local mode remains:

```text
BANK_PROVIDER=simulator
AI_PROVIDER=fixture
ALLOW_REAL_PII=false
```

Switch `BANK_PROVIDER=plaid` only when testing the Plaid Sandbox adapter.

## 2. Link and deploy the free cloud project

```bash
supabase login
supabase link --project-ref yrbteeownwjhcushwaga
supabase db push
```

Create an ignored file `supabase/.env.remote` containing the rotated server-only values, then upload them:

```bash
supabase secrets set --env-file supabase/.env.remote
```

Deploy:

```bash
supabase functions deploy api --no-verify-jwt
supabase functions deploy worker --no-verify-jwt
supabase functions deploy webhook-provider --no-verify-jwt
supabase functions deploy scheduled --no-verify-jwt
```

`--no-verify-jwt` is deliberate for Supabase's publishable/secret-key model. Each function must use `@supabase/server` and declare its own auth mode:

- `api`: `auth: 'user'`
- `worker` and `scheduled`: `auth: 'secret:automations'`
- `webhook-provider`: `auth: 'none'`, followed by Plaid webhook JWT/body-hash verification

Deploy the Next.js app to Vercel Hobby with the two `NEXT_PUBLIC_SUPABASE_*`
values from `.env.example` and `NEXT_PUBLIC_SITE_URL` set to the public
origin, without a trailing path. Add `<origin>/reset-password` to the Supabase
Auth redirect allow-list before enabling password recovery.

## 3. Plaid Sandbox integration boundary

Initial implementation should use:

```text
Plaid Link
/link/token/create
/item/public_token/exchange
/transactions/sync
SYNC_UPDATES_AVAILABLE webhooks
/webhook_verification_key/get
```

The webhook endpoint stores the raw body first, verifies the `Plaid-Verification` JWT and body hash, deduplicates the event, and only then enqueues a sync. Every request records Plaid's `request_id` for diagnostics.

Do not enable Production or real bank credentials until the Stage 1 ingestion, replay, tenant-isolation, export, and secret-handling gates pass. Sandbox Items cannot be promoted into Production; production linking is a separate checkpoint.

## 4. Additional values still needed from the human

These are intentionally not included in the plan:

- rotated Plaid Sandbox secret;
- Plaid client ID;
- Supabase database password for CLI linking/migration administration;
- one named Supabase secret key for internal automations;
- Vercel account/project binding;
- optional Google OAuth credentials;
- any cloud AI provider key.

## 5. Definition of “good for now”

The setup is good for now when all of these are true:

- Supabase runs locally through the CLI;
- migrations and seed data reset cleanly;
- the cloud project links and receives migrations;
- Auth works locally and in the cloud;
- Plaid Sandbox creates a Link token and syncs a test Item;
- webhook verification and duplicate/replay tests pass;
- no privileged key is present in Git or the frontend bundle;
- export and restore are tested before important personal history is imported.

It is not yet approved for production bank access, external users, or uptime claims.
