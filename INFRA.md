# INFRA.md — KEEL Infrastructure Decisions

**Status:** locked for Stage 0–2 unless changed at a human checkpoint (`⚑`)  
**Date:** 2026-07-10  
**Goal:** the simplest credible architecture that runs completely locally, deploys to a free personal cloud environment, and preserves a clean path to a serious production backend.

> **Supabase provides the platform. KEEL services decide financial meaning. The frontend asks.**
>
> The browser may authenticate, invoke server functions, and use explicitly permitted read/upload surfaces. It may never write canonical financial truth directly.


## Current development project binding

The current personal cloud test project is:

```text
Supabase project ref: yrbteeownwjhcushwaga
Supabase project URL: https://yrbteeownwjhcushwaga.supabase.co
Browser key type: publishable (`sb_publishable_…`)
Plaid environment: Sandbox only
```

The exact Supabase publishable key is stored in the repository's `.env.example` because it is intentionally client-visible. It grants no privileged access by itself; every exposed table and Storage path must still be protected by RLS and KEEL authorization.

**Plaid credentials are server-only and are not embedded in this plan, source control, examples, logs, or frontend configuration.** The Sandbox secret supplied during planning was shared outside a secret manager and must be rotated in the Plaid Dashboard before use. The rotated values belong only in an ignored local environment file and Supabase Edge Function Secrets.

---

## 0. Locked decision

**Do not add Fly.io, Render, Railway, Cloud Run, or another general-purpose compute layer during Stage 0–2.**

Use:

| Layer | Locked choice now |
|---|---|
| Language | TypeScript |
| Monorepo | `pnpm` workspaces; Turborepo optional |
| Frontend | Next.js |
| Frontend local | Next.js dev server |
| Frontend cloud | Vercel Hobby for personal/non-commercial use |
| Backend platform, local | Supabase CLI + Docker |
| Backend platform, cloud | One Supabase Free project |
| Database | Supabase Postgres |
| Identity | Supabase Auth |
| Authorization | KEEL-owned membership, ownership, grant, and policy tables + RLS |
| Object storage | Supabase Storage |
| Server API | Supabase Edge Functions |
| Durable queues | Supabase Queues / `pgmq` |
| Scheduling | Supabase Cron / `pg_cron` |
| Financial domain logic | Pure, runtime-neutral TypeScript packages |
| AI in tests | Recorded deterministic fixtures |
| AI locally | Optional Ollama adapter |
| AI in personal cloud | Disabled, fixture-backed, or bring-your-own provider key |
| Bank data initially | Simulator + CSV/QIF/QFX/OFX + Plaid Sandbox |
| CI | GitHub Actions |

### Why no Fly.io or Render now?

They do not simplify the personal free deployment enough to justify another provider, secret boundary, deployment target, logging surface, or failure mode.

- Fly.io is a paid compute option, not the locked free path.
- Render's free service can sleep, so it does not provide dependable always-on workers anyway.
- Supabase already gives KEEL a local stack, hosted Postgres, Auth, Storage, Edge Functions, queues, and scheduling.

A persistent container is an **escape hatch**, not a starting dependency. See Section 15.

---

## 1. Topology

### Local development

```text
[ apps/web — Next.js :3000 ]
              │
              │ Auth session + HTTPS/JSON locally
              ▼
[ local Supabase stack ]
  ├─ Auth
  ├─ Edge Functions
  │   ├─ api
  │   ├─ worker
  │   ├─ webhook-provider
  │   └─ scheduled
  ├─ Postgres
  ├─ Storage
  ├─ Queues / pgmq
  ├─ Cron / pg_cron
  └─ Studio
```

Supabase CLI runs the backend stack in Docker. The Next.js dev server runs on the host for fast HMR.

### Personal cloud deployment

```text
[ Next.js on Vercel Hobby ]
              │
              │ Supabase Auth + function calls
              ▼
[ Supabase Free project ]
  ├─ Postgres
  ├─ Auth
  ├─ Storage
  ├─ Edge Functions
  ├─ Queues
  └─ Cron
```

This is appropriate for:

- personal use;
- development;
- synthetic fixtures;
- demonstrations;
- a small, controlled founder test.

It is not a promise of commercial uptime, continuous background execution, or disaster-recovery guarantees.

---

## 2. Repository shape

```text
apps/
  web/                       # Next.js; no database or provider secrets

packages/
  contracts/                 # commands, queries, events, errors, typed AI records
  ledger/                    # pure money, journal, postings, reversals, locks
  authz/                     # central resource authorization compiler
  reconciliation/           # statements, sessions, differences, close
  recurring/                 # series, occurrences, predictions, overrides
  transfers/                 # transfer links and state machine
  reimbursements/            # counterparties, claims, shares, settlements
  imports/                   # CSV/QIF/QFX/OFX/paystub staging and dry runs
  documents/                 # receipts, immutable versions, matches, evidence
  reports/                   # deterministic calculations and provenance
  notifications/             # events, preferences, routing, delivery contracts
  ai/                        # provider adapters, policies, proposals, evaluations
  test-fixtures/             # hostile sync/import/accounting/security fixtures

supabase/
  config.toml
  migrations/
  seed.sql
  tests/
  functions/
    _shared/                  # service composition, DB helpers, auth context
    api/                      # authenticated command/query router
    worker/                   # queue consumer; small idempotent batches
    webhook-provider/         # immutable provider-event ingestion
    scheduled/                # cron-triggered orchestration only

scripts/
  backup/
  restore/
  fixtures/

docs/
CLAUDE.md
INFRA.md
NOTES.md
```

### Dependency law

```text
Edge Functions
    ↓
application services + packages/contracts
    ↓
pure domain packages
    ↓
Postgres / Storage / provider adapters
```

Pure financial packages may not import:

- `supabase-js`;
- Edge runtime globals;
- Next.js;
- an AI SDK;
- a bank SDK;
- Storage SDKs.

They accept typed inputs and return typed results. This preserves the option to move the API or workers into a container later without rewriting financial behavior.

---

## 3. Supabase is infrastructure, not financial meaning

Supabase provides:

- identity and sessions;
- Postgres;
- storage;
- function execution;
- durable queues;
- scheduled invocation;
- migration tooling;
- local/cloud parity.

KEEL owns:

- account and entity semantics;
- ownership and permissions;
- transaction state machines;
- balanced postings;
- splits and transfers;
- revisions and undo;
- recurring occurrence semantics;
- reconciliation and locks;
- calculation formulas and provenance;
- AI action policy and approvals;
- audit history;
- support repair behavior.

No provider response, LLM output, UI state, or Supabase row is automatically financial truth. It becomes canonical only through an authorized KEEL service operation.

---

## 4. Browser access policy

`apps/web` may use `supabase-js` only for:

- sign-in, sign-out, session refresh, and MFA flows;
- invoking KEEL Edge Functions;
- subscribing to explicitly approved presentation events;
- obtaining controlled signed upload URLs;
- reading explicitly approved RLS-protected presentation views where useful.

`apps/web` may not directly insert, update, or delete:

- accounts or account ownership;
- canonical transactions;
- journal batches or postings;
- transaction splits;
- transfer links;
- statement or reconciliation state;
- period locks;
- import commits;
- AI approvals;
- audit events;
- support corrections;
- professional access grants.

The Supabase secret/service key may never enter the browser bundle, logs, analytics, or repository.


### Supabase publishable/secret-key model

KEEL uses Supabase's current publishable-key model. The browser sends the publishable key as the `apikey` and the signed-in user's session JWT as `Authorization`.

For new Edge Functions, use `@supabase/server` and set `verify_jwt = false`; authorization is declared inside the handler:

```text
api / user-facing commands    → withSupabase({ auth: 'user' })
worker / cron / internal jobs → withSupabase({ auth: 'secret:automations' })
public health check           → withSupabase({ auth: 'none' })
Plaid webhook                 → auth: 'none', then verify Plaid-Verification JWT + body hash
```

The platform publishable key is not a user credential. A user-facing command is accepted only after the Supabase Auth session JWT is validated and KEEL's authorization compiler approves the exact household/entity/account action. Internal functions use a separately named Supabase secret key; that key bypasses RLS and therefore must never be exposed to the browser or stored in the repository.

---

## 5. Server command transaction

Every material financial command runs inside an Edge Function and one Postgres transaction.

```text
1. Verify the Supabase Auth JWT.
2. Resolve actor, active household, entity scope, permissions, and auth strength.
3. Validate the typed command.
4. BEGIN.
5. Set transaction-local KEEL authorization context.
6. Run deterministic domain logic.
7. Write canonical records and balanced postings.
8. Write revision/reversal state where applicable.
9. Write append-only audit and domain events.
10. Enqueue follow-up work atomically.
11. COMMIT.
12. Return a typed result with provenance.
```

The financial mutation, audit event, and queued follow-up must commit together or not at all.

Do not implement a command as a sequence of unrelated browser or REST inserts.

---

## 6. Database roles and authorization

Use separate Postgres roles created through migrations:

```text
keel_migrator     # schema changes only; never a runtime credential
keel_api          # authenticated API command/query transactions
keel_worker       # queue processing and approved background mutations
keel_readonly     # diagnostics/reporting where needed
```

Runtime roles:

- are not table owners;
- do not receive `BYPASSRLS`;
- receive only required table/function privileges;
- may not update or delete append-only audit/source records;
- are unavailable to the browser.

Supabase Auth answers **who the person is**. KEEL authorization answers **what financial resources and actions that person may access**.

Canonical authorization tables include:

```text
households
household_memberships
entities
entity_memberships
connections
accounts
account_owners
resource_permissions
professional_access_grants
approval_policies
```

The same authorization compiler governs:

- UI commands and queries;
- reports;
- search;
- AI questions;
- exports;
- notifications;
- future MCP operations;
- support tools.

RLS is defense in depth, not the only authorization layer.

---

## 7. Authentication

Use Supabase Auth during Stage 0–2.

Start with the smallest reliable methods:

- email OTP or magic link;
- optional Google sign-in;
- MFA for administrative/professional users when needed;
- recovery and session-revocation flows before external testing.

Passkeys are not a Stage 1 dependency. Add them later only after the financial spine and account-recovery model are proven.

Step-up authentication is required before high-risk operations such as:

- export all;
- delete account/data;
- change household owner, member, or professional access;
- issue future API/MCP tokens;
- change autonomy policies;
- reopen a locked period;
- reveal or rotate sensitive provider credentials.

---

## 8. Queues, jobs, and domain events

Use Supabase Queues / `pgmq`. Do not add Redis, SQS, Kafka, or Graphile Worker during Stage 0–2.

Initial queues:

```text
sync-events
import-batches
transaction-enrichment
recurring-detection
receipt-processing
notification-delivery
ai-proposals
report-recompute
export-jobs
repair-jobs
```

Rules:

- Every message has an idempotency/economic-event key.
- Jobs are processed in small batches.
- Retries must not duplicate an economic event.
- Poison messages move to an explicit failed/dead-letter state.
- Queue payloads contain references, not unnecessary raw PII.
- Queue records are execution instructions, not permanent business history.
- Permanent `domain_events` remain separate and append-only.

Use Supabase Cron / `pg_cron` to invoke small orchestration functions. Cron must not contain financial business logic itself.

---

## 9. Edge Function boundaries

Edge Functions are appropriate for:

- typed API commands and queries;
- webhooks;
- short queue-processing batches;
- notification delivery;
- small import batches;
- external AI/provider calls;
- orchestration.

Do not rely on one function invocation for:

- a massive Quicken migration;
- large OCR/PDF workloads;
- reconstruction of years of investments;
- a full-account historical backfill;
- CPU-heavy local models;
- indefinite workers.

Break large work into deterministic, resumable queue batches with checkpoints.

Example:

```text
50,000 imported rows
    ↓
create 100 batch records of 500
    ↓
worker claims one or a few batches
    ↓
validate, stage, record result, retry safely
    ↓
explicit commit after dry-run proof
```

---

## 10. Storage

Use Supabase Storage locally and in the cloud.

Buckets begin private:

```text
quarantine
receipts
statements
imports
exports
raw-provider-archive
```

Upload flow:

```text
1. Authenticated client requests an upload authorization.
2. File enters quarantine.
3. Worker validates type/size and malware-scan status when available.
4. Original receives a content hash and immutable document version.
5. OCR/extraction creates a separate versioned result.
6. Matching and posting changes remain proposals until policy permits approval.
```

Financial/document metadata remains in Postgres. Object access uses short-lived signed URLs and resource-level authorization.

Keep object storage behind a small `ObjectStore` contract so a later move to S3/R2 does not affect document logic.

---

## 11. AI

AI is optional infrastructure. KEEL must remain useful without it.

Implement providers behind one interface:

```text
RecordedFixtureAIProvider   # tests and CI; default
OllamaAIProvider            # optional local development
CloudAIProvider             # optional bring-your-own key
```

AI may:

- normalize merchants;
- suggest category/entity/transfer/refund/receipt matches;
- detect recurring candidates;
- extract receipt fields;
- compile natural language into typed query parameters;
- narrate deterministic metrics;
- return concise TLDRs.

AI may not:

- perform ledger arithmetic;
- silently create material financial writes;
- mark an account reconciled;
- bypass permissions;
- move money;
- execute payroll, filing, trading, or regulated advice.

Material AI output uses the canonical record:

```text
verdict
TLDR
confidence
as_of
scope
reason_codes
evidence_refs
proposed_actions
requires_approval
model/prompt/policy version
```

No real financial PII is sent to a cloud model during Stage 0–1 without a human checkpoint.

---

## 11.1 Environment and secret placement

Public browser configuration may live in `.env.example` and Vercel environment settings:

```text
NEXT_PUBLIC_SUPABASE_URL=https://yrbteeownwjhcushwaga.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<the checked-in publishable key>
```

Server-only local values live in `supabase/functions/.env` or a file passed to `supabase functions serve --env-file ...`; the file is ignored by Git:

```text
PLAID_ENV=sandbox
PLAID_CLIENT_ID=<set locally>
PLAID_SECRET=<rotated Sandbox secret; set locally>
PLAID_PRODUCTS=transactions
PLAID_COUNTRY_CODES=US
AI_PROVIDER=fixture
ALLOW_REAL_PII=false
```

Hosted secrets are set through Supabase Secrets, preferably from an ignored file:

```bash
supabase secrets set --env-file supabase/.env.remote
```

Never paste a Supabase secret key, Plaid secret, Plaid access token, database password, AI key, or production credential into a Markdown plan, commit, issue, chat log, analytics event, or `NOTES.md`.

## 12. Local workflow

Prerequisites:

- Node.js LTS;
- `pnpm`;
- Docker-compatible runtime;
- Supabase CLI.

Canonical commands:

```bash
pnpm install
supabase init                 # once
supabase start
supabase db reset
supabase functions serve --env-file supabase/.env.local
pnpm --filter @keel/web dev
pnpm test
```

Typical local endpoints are displayed by `supabase start`; do not hard-code ports outside `.env.example` and test configuration.

Local development defaults:

```text
AI_PROVIDER=fixture
BANK_PROVIDER=simulator
EMAIL_PROVIDER=local
PLAID_ENV=sandbox
ALLOW_REAL_PII=false
```

Every coding agent must be able to run the financial spine, tests, local Auth, Storage, queues, functions, and web app without a cloud account.

---

## 13. Cloud workflow

Use exactly one shared Supabase Free project initially.

```bash
supabase login
supabase link --project-ref yrbteeownwjhcushwaga
supabase db push
supabase functions deploy api
supabase functions deploy worker
supabase functions deploy webhook-provider
supabase functions deploy scheduled
```

Deploy `apps/web` to Vercel from GitHub.

Cloud environment rules:

- secrets live only in Supabase/Vercel environment management;
- the browser receives only the public Supabase URL, publishable key, and API/function configuration;
- provider tokens are encrypted at rest;
- no production bank access before the explicit Plaid/security checkpoint;
- no real user claims about uptime, backups, or continuous sync on free tiers;
- personal/non-commercial Vercel Hobby usage only.

---

## 14. Free-tier safety

The free deployment is allowed to pause, hit quotas, or delay scheduled work.

Required safeguards:

- circuit breakers for AI, provider, storage, and function usage;
- `usage_events` for every metered external call;
- explicit stale/freshness timestamps;
- manual database and document backups;
- a tested local restore procedure;
- export-all available before importing important history;
- no silent overage behavior;
- no claim that a scheduled job ran until its result is recorded.

Recommended personal backup cadence:

```text
Database dump: at least weekly and before migrations/imports
Document export: at least monthly and before storage changes
Restore drill: before using irreplaceable history
```

Backups must be encrypted and must never be committed to the repository.

---

## 15. Compute escape hatch: when Fly/Render/etc. become justified

Do not add a general-purpose compute provider merely because it may be useful later.

Add a persistent API or worker container only after one or more measured conditions occur:

1. Edge Function runtime limits block required work after reasonable batching.
2. Queue latency or scheduled sync cannot meet the product's target.
3. A continuously running provider connection or worker becomes necessary.
4. Heavy OCR, investment reconstruction, or import processing needs more CPU/RAM.
5. Commercial users require uptime and operational guarantees beyond the free profile.
6. Observability or incident response requires a persistent service process.

At that checkpoint:

```text
Supabase Postgres/Auth/Storage remain.
Pure TypeScript domain packages remain.
Edge API contracts remain.
A Fastify API and/or worker container is added as another adapter/runtime.
```

Provider selection is deferred to that checkpoint. Compare Render, Fly.io, Cloud Run, Railway, and others based on then-current pricing, sleep behavior, regions, networking, observability, and worker support.

The migration must be a deployment change, not a financial-domain rewrite.

---

## 16. Build order

### Stage 1A — pure deterministic spine

```text
Money
Accounts
Entities
Journal
Postings
Splits
Transfers
Revisions/reversals
Period locks
Calculation provenance
```

### Stage 1B — local Supabase integration

```text
Migrations
Auth identities
KEEL authorization
RLS tests
Edge API
Storage
Queues
Cron
Audit/domain events
```

### Stage 1C — hostile ingestion behavior

```text
Immutable raw events
Duplicate/reordered events
Pending→posted lineage
Reconnect/account lineage
Import staging and rollback
Replay and idempotency
```

### Stage 1D — core finance domains

```text
Categories/dimensions
Recurring occurrences
Paychecks
P2P/reimbursements
Statements/reconciliation
Receipts
Exports
```

### Stage 1E — thin engineering interface

Build only enough UI to:

- sign in;
- create/import accounts;
- inspect transactions and postings;
- split a transaction;
- confirm a transfer;
- reconcile a statement;
- approve/reject a proposal;
- reverse a change;
- inspect audit/provenance;
- run export/restore checks.

The polished product UI follows only after the financial spine works end to end.

---

## 17. CI-enforced rules

1. `apps/web` contains no Supabase secret/service key or direct database credential.
2. Canonical financial tables reject direct client writes through grants and RLS.
3. Material mutations are reachable only through typed KEEL commands.
4. Posting batches balance by currency.
5. Money uses integer minor units; no floating-point financial storage or arithmetic.
6. Mutation + audit/domain event + queue message commit atomically.
7. Every worker is idempotent and replay-tested.
8. Append-only raw-source and audit records cannot be updated/deleted by runtime roles.
9. Cross-household/entity/account/document authorization tests fail closed.
10. AI outputs cannot directly execute class-B-or-higher actions without a bound approval.
11. Large jobs use resumable batches and checkpoints.
12. Full export and local restore tests run before importing irreplaceable data.
13. Pure domain packages contain no Supabase, Next.js, provider, or model imports.
14. No Fly/Render/general-purpose compute dependency is introduced before the Section 15 checkpoint.

---

## 18. Final answer

**Current architecture:**

```text
Local:
Next.js + Supabase CLI/Docker

Personal free cloud:
Vercel Hobby + Supabase Free

Core backend:
Supabase Postgres/Auth/Storage/Edge Functions/Queues/Cron

Financial behavior:
Pure TypeScript KEEL packages called by authorized Edge Functions
```

**Fly.io or Render now? No.**

**Configured now:** one Supabase Free project for the personal cloud test environment and Plaid Sandbox for simulated account data. The public Supabase configuration may be committed; all privileged keys remain external secrets.

Use a separate compute layer later only if measured runtime or reliability requirements outgrow Edge Functions. Until that happens, it increases complexity more than capability.
