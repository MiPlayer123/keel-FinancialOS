# KEEL MCP server

> **Status: planned, not built.** The scope, research and build plan are in
> [`docs/research/MCP-CONNECTOR-2026-11-04.md`](../../../docs/research/MCP-CONNECTOR-2026-11-04.md).
> A working auth/transport prototype is parked on branch `claude/mcp-prototype-reference`.

## What it is

One URL that lets a KEEL user plug their finances into an AI app: Claude (web, desktop, mobile, Claude Code), Codex or ChatGPT.

- The user signs in with their KEEL account and approves the app.
- The AI can then read everything in that user's household.
- With permission, it can make the same changes the user could make by hand in the KEEL app.
- It never moves money.

## How it works

```
AI app ──POST /mcp (JSON-RPC)──▶ mcp Edge Function ──▶ shared KEEL commands ──▶ Postgres procs (RLS, audit)
   ▲                                   │
   └── 401 + where to sign in ◀────────┘   sign-in: Supabase Auth OAuth 2.1 → KEEL /oauth/consent
```

1. **Discovery.** The first call has no token. The server answers `401` with `WWW-Authenticate: Bearer resource_metadata=".../mcp/.well-known/oauth-protected-resource"`. The AI app follows it to Supabase Auth.
2. **Sign-in and consent.** The app registers itself with Supabase Auth (DCR) and opens KEEL's consent page.
   - The page shows which app is asking and where its access goes.
   - The user picks a permission level: **Read**, **Read + suggest** or **Read + make changes**.
3. **Calls.** Every request carries the user's token. The server checks it:
   - the signature,
   - that it came from KEEL's issuer,
   - that it carries a `client_id` (web sessions are refused),
   - that the user's grant for that app is still active.

   It then pins the request to the user's household.
4. **Tools run as the user.** Each tool calls the **same command or query the web app uses**, so the same authorization checks, Postgres procs, RLS and audit log apply. There is no separate code path (Law 7).

## Tools

The full contracts are in the plan doc, §5.

**Read (≈18).** Read-only, never prompts.

| Area | Tools |
|---|---|
| Overview and accounts | `get_snapshot` · `list_accounts` · `get_account` · `get_history` |
| Transactions | `list_transactions` · `get_transaction` · `summarize_transactions` |
| Setup | `list_categories` · `list_rules` |
| Planning | `get_budget` · `list_recurring` · `list_goals` |
| Other ledgers | `get_investments` · `list_paychecks` · `list_reimbursements` · `list_statements` · `list_documents` · `list_notes_and_tasks` |
| Review and activity | `get_review_queue` · `get_activity` |

**Write (≈20).** Each one is logged, undoable, and gated by the app's permission level.

| Area | Tools |
|---|---|
| Accounts | `create_account` · `update_account` |
| Transactions | `create_transaction` · `update_transaction` · `split_transaction` · `categorize_transactions` · `void_transaction` |
| Setup | `manage_category` · `manage_tag` · `manage_rule` · `apply_rules` |
| Transfers and review | `link_transfer` · `resolve_review_item` |
| Planning | `set_budget` · `manage_recurring` · `manage_bill` · `manage_goal` |
| Other ledgers | `manage_paycheck` · `manage_reimbursement` · `manage_statement` · `manage_holding` · `manage_note_or_task` |
| Undo | `undo_change` |

**Never exposed:** moving money or paying bills, bank connect/disconnect (Plaid), export-all, onboarding, raw journal posting, and AI-profile settings.

## Conventions every tool follows

- **Names.** `snake_case`, verb first (`list_`, `get_`, `create_`, `update_`, `manage_`). Read tools and write tools are always separate.
- **Annotations.**
  - Every tool has a `title`.
  - Read tools set `readOnlyHint: true`.
  - Write tools set `destructiveHint`: `false` only if the tool purely adds; `true` if it overwrites, voids or archives.
  - `openWorldHint` is always `false`.
- **Money.**
  - `amount_minor` is an integer string in the stated `currency`. A `display` string such as `"$1,234.50"` sits next to it.
  - For any total, use KEEL's computed totals (`summarize_transactions`, `get_snapshot`); the model never adds rows itself (Law 1).
  - Split tools accept `equal` or `percent` modes, so KEEL does the division.
- **Dates.** ISO `YYYY-MM-DD`. Ranges are `from` (inclusive) to `to` (exclusive).
- **Paging.** List tools take `page_size` (default 50, max 200) and `page_token`. They return `next_page_token` and `has_more`. Pass the token back until `has_more` is false to walk the entire history.
- **Detail level.** List tools default to compact rows. `detail: "full"` adds splits, tags, notes and transfer info.
- **IDs.** IDs come from list and get tools and are never guessed. Rows also carry human labels, such as an account name next to `account_id`.
- **Every result** carries `as_of` and `scope` (Law 11).
- **Ingested text.** Bank memos, merchant names, receipt text and notes are marked as data, never instructions (Law 5).
- **Writes**
  - Each write takes an `idempotency_key`. A retry with the same key does nothing new (Law 9).
  - Each write returns `change_id`, a plain-language `summary` and how to undo it.
  - If the app's permission level requires approval, the result is `{"status": "approval_required", "approval_url": …}`. The user approves in KEEL, and the model retries with the same key.
- **Errors.**
  - Errors come back as `isError: true` with a `code`, a `message` and a `hint` for what to do next. Example: `"category not found: call list_categories"`.
  - Database internals never appear in errors.
  - Only a missing or expired login returns HTTP 401.

## Adding a tool

1. **The command or query exists in the shared registry** (`_shared/commands/`), along with:
   - its zod input schema,
   - its authz action,
   - its risk class (A, B or C; class D is never exposed),
   - its handler.

   The web `api` already dispatches through this registry. If the action isn't there yet, add it there first, never in `mcp/`.
2. **Add the tool definition** under `mcp/tools/{read,write}/`:
   - name, title, a description written as plain facts (no instructions to the model),
   - annotations,
   - the input schema, generated from the zod schema,
   - an output schema.
3. **Map the risk class** to the grant check: read, suggest, or change directly.
4. **Tests**, each under `mcp/test/`:
   - happy path,
   - authz denied,
   - another household's ID returns `not_found`,
   - a bad input returns a helpful hint,
   - an idempotent retry,
   - for writes, undo.
5. **Update the docs:**
   - the tool tables above,
   - the `tools/list` snapshot test,
   - the parity map (`mcp/parity.json`): every app action is either a tool or excluded with a reason, and CI fails on drift.

## Local development

```bash
supabase start                       # local stack with [auth.oauth_server] enabled in config.toml
node scripts/build-functions.mjs
supabase functions serve mcp --no-verify-jwt
npx @modelcontextprotocol/inspector  # point it at http://127.0.0.1:54321/functions/v1/mcp
```

Use the fictional demo household only. Never use real merchant, employer or account data in fixtures.
