# KEEL — Technical Specification (v1.0)

**Infrastructure authority:** root `INFRA.md` and `17-KEEL-PROJECT-SETUP.md` supersede the original runtime/provider choices in this document.

## §1 Stack
- **Monorepo:** `pnpm` + Turborepo. `apps/web` (Next.js/React/TypeScript); pure packages for ledger/contracts/authz/imports/detectors/documents/reports/AI; `supabase/migrations`; and Edge Functions `api`, `worker`, `webhook-provider`, `scheduled`. No separate `apps/api` or externally exposed MCP process during Stage 0–2.
- **DB/data platform:** Supabase Postgres 16 locally through CLI/Docker and in one Supabase Free cloud project. All money = BIGINT minor units + currency; canonical writes go through KEEL commands, not browser table mutations. Supabase Storage holds documents; `pgmq` handles jobs; `pg_cron` schedules orchestration.
- **Compute:** Supabase Edge Functions for authenticated commands, verified provider webhooks, and short idempotent worker batches. Long work is checkpointed into resumable jobs. A persistent container is an evidence-triggered escape hatch, not a starting dependency.
- **Auth:** Supabase Auth initially. Email OTP/social + recovery first; MFA/step-up for dangerous actions. Passkeys later. Supabase identifies the user; KEEL membership/ownership/grant tables authorize financial resources.
- **Observability:** OpenTelemetry, per-user COGS metering table from day 1 (A2).

## §2 Data model — core DDL (forward-proofed)

> **Implementation warning:** the SQL below is the historical schema scaffold, not the final migration contract. Before writing migrations, reconcile every table with `BC-v2.1.md`, especially multi-household memberships, account owners, resource permissions, immutable raw events, canonical transaction lineage, journal revisions/reversals, statement evidence, recurring occurrences, structured paychecks, settlements, document versions, typed AI records, and support repair events. Where this DDL conflicts with BC-v2.1, BC-v2.1 wins.
Design rules: (1) postings are truth, transactions are grouping; (2) entity is a first-class dimension; (3) external rows (aggregator) are immutable staging, internal rows are user truth linked back; (4) soft-delete + audit everywhere; (5) multi-currency-ready day 1.

```sql
-- Tenancy & people
CREATE TABLE households (id uuid PK, name text, created_at timestamptz);
CREATE TABLE users (id uuid PK, household_id uuid FK, email citext UNIQUE, role text
  CHECK (role IN ('owner','partner','viewer','professional')), settings jsonb);

-- Entities: 'Personal' auto-created; LLCs etc. added by Pro users
CREATE TABLE entities (id uuid PK, household_id uuid FK, name text,
  kind text CHECK (kind IN ('personal','sole_prop','llc_single','llc_multi','s_corp','other')),
  tax_profile jsonb,          -- schedule mappings, EIN, fiscal year
  created_at timestamptz, archived_at timestamptz);

-- Chart of accounts: EVERYTHING is an account (asset/liability/income/expense/equity)
CREATE TABLE accounts (id uuid PK, household_id uuid FK, entity_id uuid FK,
  name text, type text CHECK (type IN ('asset','liability','income','expense','equity')),
  subtype text,               -- checking, credit_card, brokerage, mortgage, category_expense...
  is_category boolean DEFAULT false,  -- income/expense accounts double as "categories"
  parent_id uuid NULL,        -- category hierarchy
  icon text, currency char(3) DEFAULT 'USD',
  external_ref jsonb,         -- {provider:'plaid', item_id, account_id} when synced
  on_budget boolean, visibility text, sort int, archived_at timestamptz);

-- Immutable staging from providers (never edited; re-sync-safe)
CREATE TABLE external_transactions (id uuid PK, household_id uuid FK, account_id uuid FK,
  provider text, provider_txn_id text, posted_at date, amount_minor bigint, currency char(3),
  raw jsonb, enrich jsonb,    -- Plaid Enrich v2 output
  hash text, UNIQUE(provider, provider_txn_id));

-- User-truth transaction = header; postings = the double entry
CREATE TABLE transactions (id uuid PK, household_id uuid FK,
  date date, description text, merchant_id uuid NULL, status text
  CHECK (status IN ('pending','posted','reviewed')),
  source text CHECK (source IN ('sync','manual','import','split_child','system')),
  external_id uuid NULL REFERENCES external_transactions(id),
  parent_id uuid NULL,        -- split children point at parent
  memo text, deleted_at timestamptz, created_by text); -- 'user:<id>' | 'agent:<name>'

CREATE TABLE postings (id uuid PK, transaction_id uuid FK, account_id uuid FK,
  entity_id uuid FK, amount_minor bigint, currency char(3),
  tax_line text NULL,         -- e.g. 'sched_c:advertising'
  CONSTRAINT nonzero CHECK (amount_minor <> 0));
-- INVARIANT (enforced in service layer + deferred trigger):
--   For each transaction & currency: SUM(postings.amount_minor) = 0.

CREATE TABLE merchants (id uuid PK, household_id uuid FK, canonical_name text,
  aliases text[], icon_url text, default_category_id uuid NULL);

CREATE TABLE tags (id uuid PK, household_id uuid FK, name text, color text);
CREATE TABLE transaction_tags (transaction_id uuid, tag_id uuid, PK(transaction_id, tag_id));

-- Transfer pairing (Era confirm/reject pattern)
CREATE TABLE transfer_links (id uuid PK, household_id uuid FK,
  txn_out uuid FK, txn_in uuid FK, confidence numeric,
  status text CHECK (status IN ('suggested','confirmed','rejected')), decided_by text);

-- Rules
CREATE TABLE rules (id uuid PK, household_id uuid FK, priority int,
  criteria jsonb,   -- {merchant_regex, amount:{min,max}, account_ids[], entity_id, desc_regex}
  actions jsonb,    -- {set_category, rename, add_tags[], set_entity, hide, link_goal}
  apply_retroactive boolean, enabled boolean);

-- Recurring & bills
CREATE TABLE recurring_series (id uuid PK, household_id uuid FK, merchant_id uuid,
  cadence text, expected_amount_minor bigint, tolerance numeric, next_due date,
  kind text CHECK (kind IN ('subscription','bill','income')), status text);

-- Budgets (both modes share storage)
CREATE TABLE budgets (id uuid PK, household_id uuid FK, entity_id uuid, month date,
  mode text CHECK (mode IN ('category','flex')));
CREATE TABLE budget_lines (budget_id uuid FK, account_id uuid FK, -- category account
  bucket text CHECK (bucket IN ('fixed','non_monthly','flex', NULL)),
  amount_minor bigint, rollover boolean, PK(budget_id, account_id));

-- Goals (Monarch 3.0 spec)
CREATE TABLE goals (id uuid PK, household_id uuid FK, kind text CHECK (kind IN ('save','paydown')),
  name text, target_minor bigint, target_date date, monthly_minor bigint,
  growth_rate numeric NULL, linked_account_ids uuid[], status text);
CREATE TABLE goal_allocations (id uuid PK, goal_id uuid FK, amount_minor bigint,
  direction text CHECK (direction IN ('contribute','withdraw','spend')),
  transaction_id uuid NULL, created_at timestamptz);

-- Receipts & documents
CREATE TABLE documents (id uuid PK, household_id uuid FK, entity_id uuid,
  kind text CHECK (kind IN ('receipt','paystub','invoice_in','statement','other')),
  storage_url text, ocr jsonb, extraction jsonb, -- line items, totals, tax
  matched_transaction_id uuid NULL, match_status text, uploaded_via text);

-- Paychecks
CREATE TABLE paychecks (id uuid PK, household_id uuid FK, employer text, pay_date date,
  gross_minor bigint, net_minor bigint, lines jsonb, -- withholdings, pretax, rsu...
  document_id uuid NULL, transaction_id uuid NULL);

-- Investments (positions snapshot model; lots optional layer)
CREATE TABLE holdings (id uuid PK, account_id uuid FK, as_of date, symbol text,
  qty numeric, price_minor bigint, value_minor bigint, cost_basis_minor bigint NULL);
CREATE TABLE lots (id uuid PK, account_id uuid FK, symbol text, acquired date,
  qty numeric, cost_minor bigint, source text);  -- manual/import; future full lot engine

-- Valuation feeds (real estate, vehicles) — generic
CREATE TABLE asset_valuations (id uuid PK, account_id uuid FK, as_of date,
  value_minor bigint, source text); -- 'manual','zillow','kbb',...

-- Agent layer
CREATE TABLE facts (id uuid PK, household_id uuid FK, key text, value jsonb,
  status text CHECK (status IN ('user_stated','inferred_pending','inferred_confirmed','rejected')),
  version int, superseded_by uuid NULL, source text, created_at timestamptz); -- Era-style versioned memory
CREATE TABLE agent_actions (id uuid PK, household_id uuid FK, agent text, tool text,
  proposal jsonb, status text CHECK (status IN ('proposed','approved','rejected','auto_executed')),
  decided_by text, executed_at timestamptz);
CREATE TABLE audit_log (id bigserial PK, household_id uuid, actor text, action text,
  object_type text, object_id uuid, before jsonb, after jsonb, at timestamptz DEFAULT now());

-- Reconciliation
CREATE TABLE reconciliations (id uuid PK, account_id uuid FK, period_end date,
  statement_balance_minor bigint, status text CHECK (status IN ('open','balanced','locked')),
  locked_at timestamptz);

-- COGS metering (A2)
CREATE TABLE usage_events (id bigserial PK, household_id uuid, kind text, -- plaid_item, sync, enrich, llm_tokens
  qty numeric, cost_estimate_cents numeric, at timestamptz);
```

**Future-proofing notes:** invoices/AR = new tables writing postings (no schema change to core); multi-currency already in postings; card_products/offers tables (T4.1) are additive; money movement adds `payment_instructions` + state machine, postings unchanged; lots engine can grow without touching holdings.

## §2.4 Worked invariant example (verified by script in repo)
Buy $87.42 groceries on Chase card, personal entity, split $60 food / $27.42 household:
postings = [(liability:ChaseCard, +8742), (expense:Groceries, -6000→ sign convention: expense +6000, liability −8742... choose convention: **assets/expenses positive-in on debit**]. Convention adopted: debit-positive. Postings: Groceries +6000; Household +2742; ChaseCard −8742. Σ = 0 ✔. Paying the card $500 from checking: ChaseCard +50000? No — payment: Checking −50000, ChaseCard +50000 (reduces liability), Σ=0, and the confirmed transfer_link excludes both from income/expense reports. CI contains executable versions of these.

## §3 Integration inventory (all external APIs)
| Need | Provider (primary) | Product/endpoints | Fallback/notes |
|---|---|---|---|
| Bank/credit txns | **Plaid** | Link, `/transactions/sync` (cursor, restart-on-mutation rule), webhooks | Teller (personal free tier), SimpleFIN; CSV always |
| Investments | Plaid Investments | holdings + investments/transactions | manual holdings |
| Card/loan terms | Plaid **Liabilities** | APR, limits, statement dates → feeds T4.1a card intelligence | manual |
| Categorization prior | Plaid **Enrich** (v2 taxonomy, post-Dec-2025 default) | on external txns lacking enrichment; also enriches CSV/QIF imports (Enrich accepts client-provided txns, ≤100/req) | LLM-only path |
| Recurring | Plaid recurring_transactions OR own detector | start with own (cost control), validate against Plaid's | — |
| Statements | Plaid Statements | PDF pulls for reconciliation assist | manual upload |
| Invoicing/payments-in | Stripe | invoices, payment links | — |
| Receipt/paystub OCR | LLM vision (Claude) + fallback OCR lib | extraction schemas versioned | Textract if needed |
| Email-inbound (receipts@) | Postmark/SES inbound | per-household forwarding address | share-sheet upload |
| Equities prices | Polygon/Finnhub (cheap tier) | EOD + delayed quotes | — |
| Real estate value | manual v1; RentCast/ATTOM later (Zillow API not open) | asset_valuations | — |
| Vehicle value | manual + depreciation curve v1; KBB/BlackBook licensing later | — | Simplifi proves demand |
| Credit score | later; VantageScore via partner (Array/StitchCredit) | T4 | — |
| Card offers (T4.1b) | affiliate/issuer networks or Cardlytics-class partner — **not Plaid** | behind flag | rewards-rules dataset is self-maintained |
| Money movement (T4.2) | Plaid Transfer / Increase / Dwolla + compliance review | last, deliberately | — |

## §4 API + MCP surface
Internal REST/tRPC mirrors service layer; **MCP server exposes the same services** (one source of truth). Namespaces (Era-informed, entity-extended):
- `accounts.*` list/balances/manage/visibility ; `connections.*` link/resync/disconnect
- `transactions.*` list/search/update(batch)/split/categories.manage/tags.manage/rules.manage/recurring.list/transfers.manage/import_csv
- `entities.*` list/create/report_pnl/report_balance_sheet/tax_pack
- `budgets.*`, `goals.*`, `watchlists.*`
- `insights.*` spending_analyze/compare_periods/forecast/cash_flow/daily_summary/safe_to_spend — all deterministic endpoints
- `documents.*` upload/inbox/match/itemize ; `paychecks.*` parse/whatif
- `knowledge.*` remember/forget/recall_history/confirm_inference/pending_questions
- `admin.*` export_all/audit_query/usage
Write tools require approval tokens minted by UI (or explicit per-session autonomy grant per T3.5). Every MCP call → audit_log.

## §5 Quicken import pipeline (M4)
1. **Source paths:** Classic Windows: File→Export→QIF (full file: accounts, categories, txns, splits, memos — banking side is high-fidelity). Per-account QFX/OFX as cross-check. Mac Classic: CSV register export + QXF limits noted. Simplifi: CSV.
2. **Parser:** `packages/importers/qif` — tolerant parser (QIF is ragged: date formats, N/investment records, category `[Transfer]` syntax, splits `S/E/$`). Map: Quicken categories → category accounts (tree preserved); `[Account]` transfers → transfer_links pre-confirmed; classes/tags → entities-or-tags mapping step.
3. **Agentic mapping assistant:** LLM proposes category-tree merge (Quicken's tree → Keel defaults), entity assignment for business categories (Schedule C/E detection from Quicken tax-line data if present), merchant canonicalization. All proposals → review UI, then batch-apply.
4. **Verification report (gate):** per-account txn counts, date ranges, ending balances vs QIF `T` running totals / user-entered statement balances; unmatched transfers list; explicit "what didn't import" (investment lots → guided manual/relink path per A4).
5. **Re-link overlay:** connect same institutions via Plaid; overlap window de-duped by (amount, date±3, account, fuzzy desc) with import rows marked `source='import'` and reconciled against sync going forward.

## §6 Worked planning-math examples (CI-executable)
- **Safe-to-spend (T1.2):** income_expected(month)=Σ recurring income due + confirmed deposits = $14,200; bills_due_remaining=$3,180; goal_contribs=$2,000; planned_oneoffs=$650; spent_flex_so_far=$1,742 of flex; STS = 14200−3180−2000−650−flex_budget_used... implemented as: STS_today = plan_income − plan_fixed − plan_goals − plan_planned − actual_flex_spent = 14200−3180−2000−650−1742 = **$6,628**; per-day = 6628 / days_remaining(20) = **$331.40/day**. Deterministic, explainable, unit-tested.
- **Payoff sim (T1.4):** $18,000 @ 22.99% APR, $600/mo min vs +$400 extra: amortization table generated by ledger lib; computed: months($600/mo)=46, months($1,000/mo)=23 (verified by script; exact table in fixtures; recompute in CI).
- **TWR/IRR (T1.9):** standard formulas via tested lib against published examples.

## §7 Security model
RLS by household/resource scope plus explicit membership and grants; secrets in Supabase/Vercel secret management and ignored local env files; Plaid tokens envelope-encrypted; agent write-path threat model (A6) with red-team fixtures in CI; audit immutable (append-only, no UPDATE grant); export+delete self-serve; SOC2 controls checklist started at M2 (change mgmt, access logs already exist by design).

## §8 Cost model (order-of-magnitude, verify current pricing)
Per active household (10 items avg, heavy profile): Plaid txns+investments ≈ $3–6/mo + re-auth overhead; Enrich marginal (new txns only); LLM (categorization deltas + briefings + assistant) ≈ $1–3/mo at current Claude pricing with caching; infra <$1. COGS ≈ $5–10/mo vs Plus $8.25/mo → free tier must stay 2-connection-capped; Pro margin healthy. usage_events table makes this observable per user from day 1.
