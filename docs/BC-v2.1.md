# KEEL Backend Canonicalization v2.1

**Status:** Authoritative implementation patch  
**Date:** July 10, 2026  
**Supersedes:** Simplified schema, API, milestone, or "build-ready" language in earlier docs where this document is more specific.

## TL;DR

**YES:** the plan now covers the backend and API horizon needed for the intended Quicken + Monarch + Copilot + multi-entity + receipts + AI end state.

**NO:** that does not mean every module ships at once, and a screen or model demo is not a finished feature.

**WHY:** ownership, ingestion, ledger truth, categories/dimensions, recurring occurrences, paychecks, P2P settlements, statement reconciliation, documents, notifications, investments, cards, AI evidence/approval, support repair, export, and recovery are now explicit durable contracts.

Front ends are replaceable views. The canonical ledger, source evidence, ownership graph, reconciliation state, permissions, and audit history are the durable product.

---

## 1. End-state product scope

The architecture must support:

- Checking, savings, cash, cards, loans, mortgages, brokerage, 401(k)/IRA, crypto/manual assets, property, vehicles, receivables, payables, and equity.
- Personal, household, trust, LLC, property, client, project, and consolidated scopes.
- Joint ownership, private accounts, household sharing, expiring professional access, comments/requests, and resource-level permissions.
- Deep category/subcategory trees plus tags and orthogonal dimensions such as trip, property, project, client, person, tax context, and reimbursable party.
- Dollar/percentage splits, recurring split templates, amortization, mixed personal/business purchases, and cross-entity splits.
- Internal transfers, credit-card payments, owner contributions/draws, due-to/due-from, refunds, IOUs, friend payments, employer/client reimbursements, and settlements.
- Recurring bills, subscriptions, variable utilities, paydays, rent, mortgage, irregular insurance, transfer series, skips, pauses, cancellation, resumption, and price changes.
- Paycheck/paystub imports and gross-to-net splitting across taxes, benefits, 401(k), HSA/FSA, ESPP/RSU, employer match, multiple deposits, and reimbursements.
- Quicken-style statement reconciliation, continuous balance-drift diagnosis, period locks, entity close checklists, and proof of every material number.
- Receipts/documents via upload/photo/email/share sheet, OCR, field provenance, itemization, many-to-many matching, missing-evidence policy, and proof packets.
- Budgets, goals, safe-to-spend, cash-flow forecasts, reports, net worth, investments, planning, scenarios, and tax-preparation exports.
- AI categorization, matching, extraction, concise TLDR verdicts, grounded questions, confidence, evidence, proposed actions, approvals, undo, and evaluation.
- Notifications through in-app, email, web push, native push, and optional SMS with per-user/entity/account rules.
- Owned-card rewards recommendations and, later, partner-dependent card-linked offers.
- Full export, import rollback, audit history, deletion, backup/restore, and typed support repair.

Initial scope is read/organize/plan/prepare. Money movement, payroll execution, tax filing, trading/advice, card issuing, inventory, sales-tax engines, and ERP functions are separate later decisions.

---

## 2. Backend laws

1. Raw provider events, imports, statements, and original documents are immutable source evidence.
2. Versioned, balanced journal postings are financial truth; provider categories and LLM prose are not.
3. Household membership, account ownership, connection ownership, entity membership, and permissions are separate relationships.
4. User categories are separate from formal ledger accounts and map by entity/version.
5. Trips, projects, properties, clients, people, and reimbursement/tax context use dimensions instead of category explosion.
6. Transfers, refunds, reimbursements, and settlements are relationships, not unrelated income/expense rows.
7. Reconciliation uses independent statement evidence and protects closed periods.
8. Every material mutation has a tested revision, reversal, or compensating action.
9. Deterministic services calculate and authorize. AI proposes, extracts, ranks, explains, and compiles typed queries/actions.
10. Permissions apply identically to UI, reports, search, AI, notifications, API/MCP, exports, and support tools.
11. Aggregation failure is expected; health, replay, fallback, imports, lineage repair, and diagnostics are core.
12. Export and historical access survive downgrade or billing failure.

---

## 3. Canonical domain contracts

### Identity, households, entities, and sharing

```text
users
households
household_memberships
entities
entity_memberships
connections
accounts
account_owners
resource_permissions
professional_client_links
support_access_grants
```

One user may belong to multiple households. Accounts can have multiple owners. Credential owner, account owner, default entity, and view/edit/export permission are independent. Hidden resources cannot leak through aggregates or AI.

### Connections, imports, and account lineage

```text
providers
institutions
institution_capabilities
connection_items
connection_credentials
sync_checkpoints
raw_provider_events
normalized_source_records
balance_snapshots
account_lineage
connection_health_events
import_batches
import_rows
```

Provider adapters are neutral. Ingestion is idempotent and out-of-order safe. Sync is replayable in an isolated diff environment. Pending-to-posted history, reconnects, replacement cards, account merge/split, dry-run imports, rollback, and reconciliation are explicit.

### Ledger, categories, dimensions, splits, and rules

```text
canonical_transactions
transaction_source_links
journal_batches
journal_postings
journal_revisions
category_groups
categories
category_mappings
ledger_accounts
dimensions
dimension_values
transaction_dimensions
split_templates
rules
rule_versions
rule_simulations
```

Every batch balances by currency. Categories may nest deeply, for example `Travel > Vacation > Japan 2027 > Lodging`. The same transaction may also carry `Trip: Japan 2027`, `Entity: Personal`, `Paid by: Alex`, and `Reimbursable by: Employer`. Rules are versioned, simulated, deterministic under conflict, retroactive only after preview, and reversible.

### Recurring obligations and income

```text
recurring_series
recurring_patterns
recurring_occurrences
recurring_candidates
recurring_predictions
recurring_overrides
recurring_status_events
```

The model handles weekly through annual and irregular patterns, fixed/variable amounts, expected date windows, skipped occurrences, pause/cancel/resume, merged/split series, price changes, duplicate subscriptions, and recurring split/entity rules. AI may propose a series; deterministic code generates occurrences and forecasts.

### Paychecks and income decomposition

```text
employers
paychecks
paycheck_components
paycheck_templates
paycheck_sources
paycheck_transaction_matches
payroll_provider_imports
```

Components include gross salary, bonus, commission, reimbursement, federal/state/local/FICA withholding, benefits, 401(k), employer match, HSA/FSA, ESPP, RSU withholding, garnishment, and direct deposits. One paycheck may match multiple bank, retirement, HSA, brokerage, and reimbursement transactions. Components reconcile to gross and net.

### Transfers, P2P, refunds, and reimbursements

```text
counterparties
transfer_links
expense_shares
reimbursement_claims
settlements
settlement_matches
refund_expectations
refund_matches
```

Internal transfers and card payments never affect income/spend. Friend payments through Venmo/Zelle/Cash App settle a claim rather than becoming income. Employer/client/insurance reimbursements, merchant refunds, shared rent, household IOUs, and cross-entity owner activity preserve the original economic event and settlement history.

### Statements, reconciliation, and close

```text
statements
statement_lines
reconciliation_sessions
reconciliation_items
reconciliation_adjustments
balance_snapshots
period_locks
close_checklists
```

Provider, available, ledger, statement opening/ending, cleared, and reconciled balances are distinct. Statement lines are independent evidence. Drift is classified as stale balance, missing event, duplicate, pending/posting lineage, opening balance, or adjustment. Closed periods reject mutation unless explicitly reopened with role and reason.

### Documents and receipts

```text
documents
document_versions
document_hashes
extracted_fields
document_line_items
document_transaction_matches
document_match_allocations
document_policies
```

Originals are immutable, hashed, scanned, and safely rendered. Extraction retains source spans/bounding boxes, confidence, and model version. One document may support multiple payments and multiple documents may support one transaction. Itemized splits validate totals, tax, tips, discounts, and allocations.

### Notifications

```text
domain_events
notification_rules
notification_preferences
notification_deliveries
notification_history
notification_snoozes
notification_escalations
push_subscriptions
```

Features publish domain events rather than sending notifications directly. Preferences vary by user, entity, account, event, threshold, channel, quiet hours, digest, and lock-screen privacy. Delivery is deduplicated, retried, audited, and deep-linked.

### AI and agent control

```text
ai_decisions
ai_evidence_refs
ai_proposals
ai_action_attempts
approval_tokens
ai_memories
ai_model_versions
ai_prompt_versions
ai_eval_runs
ai_policy_versions
```

Material responses use a typed contract:

```json
{
  "verdict": "yes | no | uncertain",
  "tldr": "One concise answer",
  "confidence": 0.94,
  "as_of": "2026-07-10T18:00:00Z",
  "scope": {
    "entities": ["Personal", "Condo Services LLC"],
    "accounts": ["Chase Checking", "Amex Gold"],
    "period": "2026-06-01/2026-06-30"
  },
  "reason_codes": ["RECURRING_PRICE_INCREASE"],
  "evidence_refs": ["transaction:123", "recurring_series:45"],
  "proposed_actions": [],
  "requires_approval": false
}
```

Approval tokens bind actor, exact payload hash, scope, policy version, and expiry. Model, prompt, feature inputs, evidence, confidence, and result hash are logged. Confidence is empirically calibrated per task. No uncited generated financial number is presented as fact.

### Investments

```text
securities
security_aliases
holdings
investment_transactions
portfolio_cash
lots
lot_allocations
corporate_actions
valuation_snapshots
investment_completeness
```

Balances and holdings ship first. Investment transactions and brokerage cash must reconcile before performance. Lots/cost basis/corporate actions ship only after completeness gates. Descriptive analytics may precede advice; personalized trade directives do not.

### Cards, rewards, and offers

```text
card_products
user_cards
reward_rules
reward_caps
card_benefits
merchant_categories
user_point_valuations
card_recommendations
offer_sources
card_offers
offer_eligibility
offer_activations
offer_redemptions
```

The product can answer which owned card is best for a category using caps, benefits, exclusions, merchant-category confidence, and the user's point valuations. Partner offers remain separate from unbiased ranking; affiliate economics never modify the recommendation.

### Support, repair, and recovery

```text
support.inspect_connection
support.replay_sync
support.compare_raw_canonical
support.merge_accounts
support.split_accounts
support.reverse_import
support.repair_pending_posted_lineage
support.recompute_report
support.correct_with_event
support.restore_document_link
support.inspect_permission_decision
```

Routine repair cannot depend on ad hoc production SQL. Every repair is typed, scoped, audited, reversible, and user-visible where appropriate. Support access is consented/JIT or break-glass. Backups cover database, documents, indexes, and formula/model versions needed to reproduce evidence.

---

## 4. Shared service/API surface

Web, mobile, public API, MCP, and support tooling call the same domain layer:

```text
accounts.*
connections.*
members.*
permissions.*
entities.*
transactions.*
categories.*
dimensions.*
rules.*
recurring.*
transfers.*
counterparties.*
reimbursements.*
refunds.*
statements.*
reconciliations.*
close.*
documents.*
receipts.*
paychecks.*
income.*
budgets.*
goals.*
forecasts.*
scenarios.*
reports.*
investments.*
securities.*
lots.*
cards.*
rewards.*
offers.*
notifications.*
preferences.*
ai.*
knowledge.*
proposals.*
approvals.*
provenance.*
imports.*
exports.*
audit.*
support.*
```

Material reads return scope, source freshness, completeness, as-of time, and formula version. Writes are idempotent, policy-checked, revision-aware, and audited.

---

## 5. Scope sequencing

### Core financial foundation

- Ownership, sharing, entities, and permissions.
- Connections, imports, manual accounts, health, lineage, and replay.
- Canonical transactions, postings, categories, dimensions, splits, rules, search, and undo.
- Transfers, card payments, owner movement, P2P reimbursements, refunds, and settlement.
- Recurring obligations/income and paycheck decomposition.
- Reconciliation, statements, period locks, close, and calculation proof.
- Budgets, goals, cash flow, safe-to-spend, net worth, reports, and basic investment visibility.
- Receipts/documents, notification platform, governed AI, export, deletion, recovery, and support repair.

### Additive later modules

- Advanced investment lots, corporate actions, equity compensation, options, and crypto tax depth.
- Card rewards and partner offers.
- Retailer itemization, subscription cancellation, and bill negotiation.
- Property/lease operations and formal A/R/A/P.
- Tax/retirement planning and advanced scenarios.
- QuickBooks/Xero and payroll-provider integrations.
- Native apps, widgets, watch, voice, and platform shortcuts.

### Explicitly deferred regulated scope

- Money movement and bill-pay execution.
- Payroll execution.
- Tax filing.
- Trading and personalized investment advice.
- Card issuing.
- Inventory, sales-tax engine, and enterprise ERP.

---

## 6. Mandatory gates

1. Ledger batches balance by currency; splits conserve; revisions and period locks work.
2. Duplicate/out-of-order events, imports, reconnects, and pending-to-posted changes replay deterministically.
3. Household/entity/account/document scope holds across API, reports, search, AI, notifications, exports, and support.
4. Internal transfers never affect income/spend; cross-entity treatment is explicit.
5. Recurring expected occurrences backtest across fixed, variable, skipped, paused, and cancelled series.
6. Paycheck components reconcile to gross, net, and destination transactions.
7. P2P and reimbursement settlements reduce claims without creating fake income.
8. Statements close with every difference explained and locked history protected.
9. Document extraction/matching retains source proof and exact amount validation.
10. AI exact-answer, evidence, calibration, injection, approval replay, and no-silent-write tests pass.
11. Notification preferences, dedupe, retries, privacy, and deep links work.
12. Common failures are repaired through typed audited tools, not SQL.
13. Full export and isolated restore reproduce cited records and documents.

---

## 7. Canonical answer

**Does the plan now cover the product the founder described?** Yes, as an architectural end state.

**Should it all ship immediately?** No. The durable spine ships first, and later modules are additive only after their data-completeness and trust gates pass.
