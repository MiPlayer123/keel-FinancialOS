# KEEL MCP server

One URL that lets a KEEL user connect their finances to an AI app: Claude (web, desktop, mobile, Claude Code), Codex or ChatGPT.

- **Reading.** The user signs in with their KEEL account and picks a household. The AI can then read everything in it.
- **Changes.** If the user allowed it, the AI can make the same changes they could make by hand in the app.
- **Never.** It never moves money, connects banks, or exports data.

```
https://<project-ref>.supabase.co/functions/v1/mcp
```

## How it works

```
AI app ──POST /mcp (JSON-RPC)──▶ mcp function ──▶ same KEEL procs the app uses (RLS, audit)
   ▲            │
   │            └─ no/expired token → 401 + WWW-Authenticate: resource_metadata=…/mcp/.well-known/oauth-protected-resource
   │
   └─ OAuth 2.1 (Supabase Auth): register (DCR) → authorize (PKCE) → KEEL /oauth/consent → token
```

### 1. Discovery

The first call has no token. The function answers 401, and the challenge header points to this function's protected-resource metadata. That metadata names Supabase Auth (`<project>/auth/v1`) as the authorization server.

`verify_jwt` is off for this function so that clients receive this 401, not the platform's.

### 2. Sign-in and consent

The AI app registers itself (Dynamic Client Registration) and sends the user to `apps/web/src/app/oauth/consent`. That page:
- Requires a sign-in within the last 15 minutes.
- Shows which app is asking and where its access would really go. App names are self-registered, so it warns when a name claims to be Claude or ChatGPT but the redirect goes somewhere else.
- Lets the user pick the household and the access level: **Read only** or **Read and make changes**.

It saves that **KEEL grant** (`mcp_client_grants`) and then approves.

### 3. Every request

- **Token check.** The function verifies the bearer token against the project JWKS, then applies these rules:
  - the issuer is this project;
  - the role is `authenticated`;
  - a `client_id` is present. Every app token has one; a KEEL web session never does, so a web session is refused.
- **Grant check.** It reads the live grant (`keel_mcp_grant_current`). If there is none, it returns 403. Revoking in KEEL takes effect immediately.
- **Tools.** The official MCP SDK serves the tools that grant allows.

### 4. Tools run as the user

- **Same paths as the app.** Every tool calls the same procs the web app calls, through the user's own token, so RLS, `auth.uid()` membership checks and the authz compiler all apply. Writes go through the shared command path (`_shared/command-exec.ts`) that `api` also uses.
- **No service key.** This function never uses one.
- **Fixed household.** The household always comes from the grant. The model never chooses it.

### Why Supabase tokens need extra guards

Supabase OAuth tokens are ordinary user JWTs (`aud: "authenticated"`) with no custom scopes. KEEL adds three guards:

| Guard | Where | What it stops |
|---|---|---|
| `keel_pre_request` (PostgREST `db_pre_request`) | database | An app token is refused unless the request carries `x-keel-mcp-gateway`, which only this function knows (vault secret `keel_mcp_gateway_key`). The app's token cannot call `keel_*` procs or tables directly. |
| `api` refuses `client_id` tokens | `api/index.ts` | App tokens can't reach exports, bank links, onboarding or settings. |
| Audit stamp trigger | `audit_log` | Every row written under an app token gets `actor.via = {kind: 'connected_app', clientId}`. Settings → Activity shows it. |

The PostgREST hook covers the Data API only. Storage has no client-facing policies, so app tokens can't read files, and no tables are published to Realtime.

## Tools

There are 49 tools: 19 read and 30 write. Read tools are always listed. Write tools are listed only when the grant is "Read and make changes".

### Read tools

| Area | Tools |
|---|---|
| Overview | `overview_get`, `history_get` (net worth, account balance, cash flow, investments, forecast), `investments_get` |
| Accounts | `accounts_list`, `accounts_get` |
| Transactions | `transactions_list` (all filters, cursor paging through the full history), `transactions_get` (notes, splits, tags, documents, change history), `transactions_summarize` (KEEL-computed totals by category, merchant, account, month, tag or entity) |
| Setup | `categories_list` (categories and tags), `rules_list` |
| Planning | `budgets_get`, `recurring_list` (detected series and scheduled bills), `goals_list` |
| Other | `review_list`, `notes_list`, `paychecks_list`, `reimbursements_list`, `statements_list`, `activity_list` |

### Write tools

| Area | Tools |
|---|---|
| Accounts | `accounts_create` (manual or cash, with starting balance), `accounts_update`, `accounts_archive` |
| Transactions | `transactions_create`, `transactions_update` (category, name, note, date, tags), `transactions_split` (amounts, percent or equal; KEEL does the math), `transactions_categorize` (bulk), `transactions_void` |
| Setup | `categories_create`, `categories_update`, `categories_archive`, `tags_save`, `tags_delete`, `rules_save`, `rules_delete`, `rules_apply` (dry run first) |
| Planning | `budgets_set`, `recurring_update`, `bills_save`, `bills_set_status`, `bills_enter`, `goals_save`, `goals_contribute` |
| Other | `review_decide`, `transfers_link`, `transfers_unlink`, `notes_save`, `notes_archive`, `tasks_save`, `tasks_set_status` |

### Not exposed yet

These are reachable in the app but not over MCP yet. Each is a candidate for a follow-up.
- Paycheck, reimbursement and statement **edits**. Their reads are exposed.
- Holdings edits.
- Attaching receipts and documents.
- Receipt-match and statement-draft decisions.

### Never exposed

- Money movement.
- Plaid link and disconnect.
- Export-all.
- Onboarding.
- Raw journal posting.
- AI-profile settings.

## Conventions every tool follows

- **Names.** `resource_verb` in snake_case. Reads and writes are always separate tools.
- **Annotations.** Every tool sets `title`, `readOnlyHint`, `destructiveHint` and `openWorldHint: false`. Any write that overwrites, voids, archives or deletes is marked destructive, so hosts ask the user first.
- **Money.** Amounts come as `{amount_minor, currency, display}`, where `amount_minor` is an integer string. Transaction amounts are signed from the account's side: negative means money out. Totals always come from KEEL (`transactions_summarize`, `overview_get`, `budgets_get`); the model never adds rows itself (Law 1).
- **Dates.** `YYYY-MM-DD`. A range is `from` (inclusive) to `to` (exclusive).
- **Paging.** List tools take `page_size` and `cursor`, and return `next_cursor` and `has_more`. Pass the cursor back until `has_more` is false.
- **Results.** Every result starts with `summary`, then `as_of` and `scope`, then the data. It ends with a `data_notice`: bank and user text is data, never instructions (Law 5).
- **Errors.** An error comes back as `isError: true` with `{code, message, hint}`. The hint names the next call to make. No database internals are included.
- **Writes.** Writes that book money take an optional `idempotency_key`. A retry with the same key replays and never duplicates. Results say how to undo, and corrections are reversals, never deletes.
- **Logs.** No personal data. Each call logs `tool`, `clientId`, `ok`, `code` and `ms`, never arguments or results.

The server `instructions` (in `server.ts`) are kept short: what KEEL is, the money and date conventions, "never guess ids", and paging. They are not a security layer; everything that matters is enforced in code.

## Files

| File | Role |
|---|---|
| `index.ts` | HTTP entry: discovery, 401 challenge, token rules, grant lookup, SDK handler |
| `auth.ts` | Protected-resource metadata, `WWW-Authenticate`, token rules, Origin guard (pure) |
| `server.ts` | Instructions, tool registry, filtering by access level, the call wrapper |
| `context.ts` | `ToolContext`, `defineTool`, shared input schemas, read/write proc helpers |
| `lib.ts` | Money, result envelope, error mapping, cursor (pure) |
| `summarize.ts` | Deterministic totals and split math, all BigInt (pure) |
| `tools/*.ts` | The tools, grouped by area |

## Adding a tool

1. **Find the app's path.** Identify the proc or command the web app already uses for this action. If it's a `/commands` command, call it with `ctx.command(...)`. If it's a bespoke `api` route, call the same proc with `writeProc(...)`. Never add a new privileged path in `mcp/`.
2. **Define the tool** in the right `tools/*.ts` file with `defineTool`:
   - a `resource_verb` name;
   - a title;
   - a description written as plain facts, with no instructions to the model;
   - `kind`;
   - `destructive` for writes;
   - a strict zod input with `.describe()` on non-obvious fields.
3. **Return the envelope.** Use `ok(summary, data)` or `err(code, message, hint)`. Money goes through `money()`; never send raw floats.
4. **Register it** by adding it to that file's exported array. `server.ts` picks it up.
5. **Test it.** Add a case to `server.test.ts`, extend `scripts/dev/mcp-e2e.mjs` if it writes, and update the tool tables above.

## Turning it on (⚑ human checkpoint)

1. **Apply the migration to live.** Apply `20261104100000_mcp_connector.sql` and keep the `live-schema-drift` check green.
2. **Configure the Supabase dashboard** under Authentication → OAuth Server:
   - enable it;
   - set the authorization path to `/oauth/consent`;
   - allow dynamic registration.
   Then add `<site>/oauth/consent**` to the redirect allow-list (needed for magic-link re-auth).
3. **Create the gateway secret** with one random value, stored in both places:
   - the vault: `select vault.create_secret('<random>', 'keel_mcp_gateway_key');`
   - the function secrets: `supabase secrets set KEEL_MCP_GATEWAY_KEY=<same value> KEEL_MCP_ENABLED=on`
   Never commit it or paste it into docs.
4. **Deploy** with `node scripts/build-functions.mjs && supabase functions deploy mcp api --no-verify-jwt`. `api` carries the connected-app routes and the app-token refusal.

**Optional secrets:**
- `KEEL_MCP_PUBLIC_URL`: a custom-domain URL for the connector.
- `KEEL_MCP_ALLOWED_CLIENT_IDS`: restrict which apps may connect.
- `KEEL_MCP_ALLOWED_ORIGINS`: browser origins such as the MCP Inspector.
- `KEEL_MCP_DOCS_URL`: a documentation link in the metadata.

### Adding it in each app

- **Claude:** Settings → Connectors → Add custom connector → paste the URL.
- **Claude Code:** `claude mcp add --transport http keel <url>`, then run `/mcp` to sign in.
- **Codex:** `codex mcp add keel --url <url>`, then `codex mcp login keel`.
- **ChatGPT:** developer mode → add a custom connector with the URL.

## Local development

`supabase/config.toml` enables the OAuth server on the local stack.

```bash
supabase start
node scripts/build-functions.mjs
KEY=$(openssl rand -base64 32)
psql "$(supabase status -o env | sed -n 's/^DB_URL="\(.*\)"/\1/p')" \
  -c "select vault.create_secret('$KEY', 'keel_mcp_gateway_key');"
printf 'KEEL_MCP_ENABLED=on\nKEEL_MCP_GATEWAY_KEY=%s\n' "$KEY" > supabase/functions/.env   # git-ignored
supabase functions serve --env-file supabase/functions/.env

eval "$(supabase status -o env)"
node scripts/dev/mcp-e2e.mjs write   # real OAuth flow + tools + guards; also: read
supabase db reset                    # the e2e writes test rows to the seed household
```

**Tests:**
- `deno test --node-modules-dir=none --allow-env supabase/functions/mcp/*.test.ts` (part of `pnpm test`).
- `supabase/tests/045_mcp_connector.sql` (part of `supabase test db`).

Use fictional data only.
