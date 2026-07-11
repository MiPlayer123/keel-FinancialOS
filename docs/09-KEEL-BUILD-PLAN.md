# KEEL — Master Build Plan (v1.0, July 2026)
*Working name "Keel": the deterministic spine the whole boat is built on. Rename later.*

**Infrastructure authority:** `INFRA.md` and `17-KEEL-PROJECT-SETUP.md` supersede historical hosting/auth/runtime references in this document.

**One-line thesis:** The system of record for entangled personal + entity finances — as functional as Quicken Classic, as nice as Copilot, protocol-native like Era — one data model spanning both worlds Quicken couldn't bridge.

**Primary user:** Founder-operators / owner-operators (personal accounts + 1–10 LLCs/entities + investments) currently duct-taping Quicken + QuickBooks + a tracker. **Secondary:** anyone-can-use-it personal mode (entities are opt-in; a normal user never sees them).

**Positioning laws (from research docs 00–08):**
1. Deterministic spine; agents only at fuzzy nodes (categorize, match, extract, narrate, plan). LLMs never do ledger arithmetic.
2. Suggest→approve on every AI write. Full audit log on everything.
3. Protocol-first: the MCP/API surface is a first-class product, not an afterthought. Assistants are distribution, not competition.
4. Data Access Guarantee (Quicken's trust pattern): full export always, one-click, every format; account deletion is real.
5. Aggregation is assumed broken: repair tooling (resync, relink, dedupe, manual, CSV) is core product, not support burden.

---

## 1. FEATURE TIERS (priority-ordered; every feature from taxonomy doc 07 placed)

### T0 — Foundation (MVP is not usable without these)
| # | Feature | Source/spec reference |
|---|---|---|
| T0.1 | Plaid link (transactions/sync, investments, liabilities), multi-item, per-institution health page | Plaid docs; Monarch institutions page |
| T0.2 | Manual accounts (any type) + CSV import w/ column mapping + dedupe on import | Era manual accts; universal demand |
| T0.3 | Double-entry ledger core w/ entity dimension (see TECH-SPEC §2) — personal is just the default entity | Quicken B&P data model, Firefly III |
| T0.4 | Transactions UX: list w/ infinite scroll, ⌘K search, inline edit (category/merchant/notes/tags), bulk select/edit, review status | Copilot Mac spec |
| T0.5 | Hierarchical categories (system defaults + custom, emoji, per-entity visibility), tags, notes | Monarch |
| T0.6 | Splits: by amount/% /category; split across months (amortize); un-split/restore | Copilot June-2026 flow |
| T0.7 | Transfer & CC-payment detection with confirm/reject queue (never double-count) | Era manage_transfer_links |
| T0.8 | Rules engine v1: compound criteria (merchant/amount/account/entity/description regex) → set category/rename/tag/entity/hide; retroactive apply; rule created inline from any edit | Monarch rules + Copilot inline |
| T0.9 | AI auto-categorization (Plaid Enrich v2 taxonomy as prior + per-user LLM correction memory) w/ confidence; low-confidence → review queue | Copilot Intelligence pattern |
| T0.10 | Recurring detection (subscriptions/bills, cadence+amount patterns), upcoming calendar, price-change alerts | all apps |
| T0.11 | Net worth (history, by type), cash-flow view (income/spend/net), Sankey | Monarch |
| T0.12 | Reconciliation mode: statement-balance check per account per period, lock reconciled periods | Quicken's reconcile-to-the-penny — the power-user retention feature |
| T0.13 | Quicken import (QIF full-file, QFX/OFX per-account, CSV, Mint CSV) + agentic mapping assistant (see TECH-SPEC §5) | user requirement |
| T0.14 | Full export (CSV/JSON/QIF/beancount) + Data Access Guarantee | trust law #4 |
| T0.15 | Supabase Auth initially (email OTP/social + recovery; MFA/step-up for dangerous actions), households w/ roles, joint ownership, professional access, per-resource permissions; passkeys earn in after the spine/account-recovery model | Monarch household + INFRA |
| T0.16 | Audit log of every mutation (who/what/agent-or-human/before/after) | Ramp reasoning-trace pattern |

### T1 — Planning core (what makes it a daily tool, not a database)
| # | Feature |
|---|---|
| T1.1 | Budgets: category mode + flex mode (fixed/non-monthly/flex buckets), rollovers, group budgets, mid-month move-money |
| T1.2 | Safe-to-Spend number (Simplifi Spending Plan math: income − bills − goals − planned = left; per-day figure) — the home-screen hero |
| T1.3 | Projected cash flow 12 months (deterministic: recurring + planned + trailing run-rate), overdraft warnings |
| T1.4 | Goals: save-up (allocations, on-track math, spend-from-goal, growth rate) + pay-down (payoff projection, extra-payment sim, snowball/avalanche) — Monarch Goals 3.0 spec + Simplifi's gap filled |
| T1.5 | Watchlists (payee/category/tag monitors without full budgets) |
| T1.6 | Refund expectation + matching |
| T1.7 | Reports builder: any dimension (category/merchant/tag/entity/account) × time, saved reports, tax-time report pack (Schedule A/B/C/E-oriented) |
| T1.8 | Notifications: budget-hot, unusual charge, upcoming bill, payday, connection-broken; per-channel settings |
| T1.9 | Investments v1: holdings, balances, allocation, performance (TWR + IRR — deterministic lib), benchmark vs index |
| T1.10 | Dashboard: customizable tiles, per-device layouts saved separately |

### T2 — The wedge (nobody else ships this combination)
| # | Feature |
|---|---|
| T2.1 | Entities UX: entity rail/switcher, per-entity P&L + balance sheet + cash-basis reports, consolidated view, inter-entity transfer handling (due to/from) |
| T2.2 | Receipt pipeline: capture (photo/email-forward inbox/share sheet) → OCR+LLM extract → match to transaction → itemize into splits → attach; exception queue | Ramp/Brex mechanics, consumer wrapper |
| T2.3 | Schedule C/E mapping per entity; deductible tagging; mileage log; 1099 vendor tracking; tax-pack export |
| T2.4 | Paycheck engine: parse paystubs (upload/forward) → gross/net/withholding/pre-tax decomposition; RSU/bonus events; "special paycheck" what-if calculator (deterministic tax tables) |
| T2.5 | Invoicing-lite per entity (Stripe integration): create/send/track, A/R aging |
| T2.6 | Professional access role (accountant view: reports + receipts + export, no edit) |
| T2.7 | Equity comp tracking (grants, vesting schedule, exercise modeling) |
| T2.8 | Property/asset modules: real estate (manual + valuation feed), vehicles (KBB-style valuation feed if licensable; else manual + depreciation curve) |

### T3 — Agent layer (built on T0–T2's deterministic endpoints)
| # | Feature |
|---|---|
| T3.1 | MCP server v1 (read + organize tools mirroring internal API; Era's namespace design; see TECH-SPEC §4) |
| T3.2 | In-app assistant: grounded Q&A, suggest→approve edits, personality setting | Copilot assistant spec |
| T3.3 | Daily/weekly briefing (anomalies, budgets hot, refunds matched, idle cash, upcoming) — deterministic detectors, LLM narration |
| T3.4 | Memory system: versioned facts, visible/editable knowledge page, inference confirm/reject, progressive onboarding question packs | Era knowledge.* spec |
| T3.5 | Autonomy policies: per-action-type autonomy level (off/suggest/auto-with-log), sandbox + audit |
| T3.6 | Monthly "State of You, Inc." report per household: narrative + statements across entities |

### T4 — Delight & expansion (post-traction)
| # | Feature |
|---|---|
| T4.1 | **Card intelligence + offers ("deals") — the requested endcap.** Reality check: Plaid has NO deals product. What Plaid gives: Liabilities (APR, limits, statement dates per card) + transactions. So build in two layers: (a) Card Intelligence (T4.1a, fully buildable): utilization per card, APR ranking, "which card for this category" from a maintained rewards-rules dataset (CardPointers-style, ~200 top US cards, quarterly-updated seed + community corrections), annual-fee ROI, credit-utilization alerts. (b) Offers feed (T4.1b, partner-dependent): card-linked offers require an issuer/affiliate network (e.g., Cardlytics-class partner or affiliate feeds); ship behind a partner integration flag; never let affiliate economics touch ranking (law: recommendations are computed from user data only; offers clearly labeled). |
| T4.2 | Round-ups/routines & money movement (requires Plaid Transfer/payment rails + compliance review — deliberately last) |
| T4.3 | Multi-currency accounts (schema supports day 1; UX later) |
| T4.4 | Benchmarking vs cohort (opt-in, anonymized) |
| T4.5 | Direct integrations: Amazon itemization, Venmo, Coinbase, Apple FinanceKit (iOS app phase) |
| T4.6 | Native iOS app (SwiftUI) after web/PWA proves retention; widgets/Siri/watch |
| T4.7 | Estate/vault: document hub (Simplifi Premium pattern) |

**Free/paid tiering (product):** Free = T0 read-only-ish (2 connections, manual/CSV unlimited, exports always). Plus ($99/yr) = full T0–T1. Pro ($249/yr) = T2 entities/receipts/paycheck/invoicing + T3 agent. This prices under the QuickBooks+Monarch stack it replaces.

---

## 2. MILESTONE PLAN — agent-executable, test-gated

Runtime assumption: Claude Code (architect+implement) with subagents; optional Codex on parallel leaf tasks. Repo = monorepo (see TECH-SPEC §1). Every milestone has acceptance tests the agent must make pass before proceeding; human checkpoints marked ⚑.

- **M0 Scaffold (agent-days ~1):** monorepo, CI, Supabase CLI local stack, Postgres migrations, Supabase Auth, Storage, Edge Function skeletons, queues/cron, seed data, and one linked Supabase Free cloud project + Vercel web deployment. ✔ tests: healthcheck, auth flow, migration idempotency. ⚑ human: cloud + domain + secrets consoles.
- **M1 Ledger core (~2):** entities, accounts, postings engine, invariants, categories/tags, audit log. ✔ property tests: every transaction's postings sum to zero per currency; immutable audit trail; reconciliation lock blocks edits. (Worked invariant example in TECH-SPEC §2.4, verified by script.)
- **M2 Ingest (~3):** simulator first, then Plaid Sandbox Link + `/transactions/sync` + verified webhooks, immutable raw events, dedupe, transfer-detect queue, manual accounts, and CSV import w/ mapping. ✔ tests: sandbox item lifecycle incl. forced re-auth; sync replay idempotent; transfer pairs never double-count in cash flow. ⚑ human: Plaid dashboard, OAuth registration, production approval.
- **M3 Transactions UX (~3):** list/search/inline edit/bulk/splits/rules/review queue; categorization service (Enrich prior + correction memory). ✔ tests: split conservation (Σ splits = parent), rule retroactivity, categorization accuracy harness ≥85% on labeled fixture set.
- **M4 Quicken import (~2):** QIF/QFX/CSV parsers, mapping assistant, verification report (counts, balance diffs per account vs source). ✔ tests: golden-file imports incl. 20-yr QIF fixture; balances reconcile to the penny. ⚑ human: run against your real Quicken export; sign off diffs.
- **M5 Planning (~3):** budgets both modes, safe-to-spend, projected cash flow, goals, watchlists, reports, notifications. ✔ tests: worked numeric examples (TECH-SPEC §6) computed exactly; forecast determinism.
- **M6 Wedge (~4):** entity reports (P&L/BS), receipt pipeline, Schedule C mapping, mileage, paycheck parser, invoicing (Stripe). ✔ tests: P&L ties to postings; receipt match precision ≥90% on fixture inbox; paystub decomposition sums to net. ⚑ human: Stripe account; review 1 real month of receipts end-to-end.
- **M7 Agent layer (~3):** MCP server, assistant w/ approve-gates, briefings, memory. ✔ tests: MCP conformance; no write path bypasses approval; red-team suite (prompt-injection via transaction memo/CSV cannot trigger writes or exfiltration). ⚑ human: security review of the whole write surface.
- **M8 Polish (~continuous):** design-system pass to concept spec, empty states, onboarding, perf (<100ms interactions), a11y. ⚑ human: taste. This is where you live.

Total: ~21 agent-days of build + your 3 lanes (consoles, real-data QA, taste). Card intelligence (T4.1) slots after M7 as an isolated module.

---

## 3. ADVERSARIAL AUDIT (attacks run against this plan; resolutions baked in)

| # | Attack | Verdict & resolution |
|---|---|---|
| A1 | "Double-entry will scare normal users" | UI never says debit/credit. Entities collapse to one 'Personal' by default; postings are an internal representation. Quicken proved the register UX; Firefly proved the model. Resolved by presentation layer, not schema compromise. |
| A2 | "Plaid costs blow up with your heaviest users" | Pricing is per-item + per-product. Mitigations: connection budget per plan tier; Enrich only on new txns; investments daily not intraday on Plus; Teller as secondary for supported banks; usage dashboard from day 1 (COGS per user is a first-class metric). Modeled in TECH-SPEC §8. |
| A3 | "Transfer detection wrong → trust dies" | Never auto-hide: detected pairs go to confirm queue (Era pattern); cash-flow excludes only confirmed pairs; per-pair undo; invariant tests. |
| A4 | "Quicken QIF import is lossy (investments, lots)" | True. Strategy: QIF for banking/categories/history; investments via brokerage re-link through Plaid (positions today matter more than 20-yr lot history); optional manual lot entry for taxable positions; import verification report makes loss explicit, never silent. ⚑ human sign-off gate exists (M4). |
| A5 | "LLM categorization drifts / hallucination edits data" | LLM proposes; rules and Enrich prior anchor; every auto-change is reversible + logged + surfaced in briefing; accuracy harness in CI; user corrections are strongest signal. No LLM write without provenance. |
| A6 | "Prompt injection via bank memo/receipt/CSV" | All ingested text is data-tier; agent tool layer enforces: no tool chains from ingested content, writes require UI approval token, MCP write tools require per-session user grant. Red-team suite in M7 gates release. |
| A7 | "Paycheck engine = tax advice liability" | Deterministic published tables (IRS Pub 15-T etc.), versioned by year, "estimate, not advice" framing, show-the-math UI. No filing. |
| A8 | "Card offers = affiliate incentive rot" | Law in T4.1: ranking computed only from user's own data + public card terms; paid placements (if ever) labeled and never re-ranked. Deals are an endcap, not the model. |
| A9 | "Scope demolishes the wedge (super-dashboard trap)" | Tier gates are the defense: T4 cannot start before M6 ships and one external user runs a full tax season on it. Written into the plan on purpose. |
| A10 | "Why won't Monarch just add entities?" | They might add more tagging; double-entry retrofit breaks their consumer data model and support load (their business tracking chose tagging deliberately). Window is real but not infinite → speed via agent build is the strategy. |
| A11 | "Solo founder + finance data = trust ceiling" | Mitigations: read-mostly launch (no money movement until T4.2), SOC2 path started early, open-sourced export formats, security page with real architecture, your own money on it publicly (founder-as-first-user credibility). |
| A12 | "PWA won't feel Copilot-nice" | Mockup spec targets 60fps list interactions, optimistic UI, keyboard-first; native iOS is T4.6 once retention proves. Taste checkpoint (M8) is human-owned. |

---

## 4. WHAT YOU (HUMAN) OWN — the full checkpoint list
1. Consoles & credentials: Plaid dashboard (+ production request — you're already on it), cloud project, domain, Stripe, email-inbound provider, Apple dev (later).
2. Real-data QA: M4 Quicken import sign-off; one live month of receipts (M6); ongoing weekly 30-min reconciliation review.
3. Taste: M8 design passes; copy voice; the mockup → product fidelity.
4. Security sign-off at M7; decision gates at each ⚑.
5. Legal-lite: ToS/privacy templates review, "not tax/financial advice" language.

Everything else is agent-executable against the acceptance tests.
