# Business expense attribution: research and proposed design

Status: S1 and S2 built (migration 20260831120000 + the Business control, the
ledger badge and facet). S3 to S5 remain proposals. Written 2026-08-31 in
response to "I want to track a personal expense that I should count as business,
maybe a check mark."

Related: `docs/PERSONA-FEEDBACK.md` §1 items 1, 3, 4; `docs/BACKEND-SURFACING-AUDIT.md`
tier 2 item 10 and tier 3 item 14; `docs/09-KEEL-BUILD-PLAN.md` T2.1, T2.3.

## 1. How the incumbents do it

**Quicken Business & Personal** is the closest match to KEEL's model and has the
cleanest answer. You add a business, and when you do you nominate a **tag** for it.
That tag becomes a *business tag*. Putting the business tag on a transaction tells
Quicken the transaction belongs to that business "even if the transaction is recorded
in a personal account instead of a business account." Reports (P&L, balance sheet, tax
schedule, cash flow) then roll up by business. Two rules worth stealing:

- A transaction carrying **two** business tags is ambiguous, and Quicken cannot tell
  how much belongs to each, so it reports it as "Unknown Business." Their guidance is
  to split the transaction and tag each leg.
- Single-business users can opt into "untagged business transactions belong to this
  business," which collapses the whole thing to a default.

**Monarch Money** has no entity model at all. Their own help article's answer is: make
a tag called "Business," apply it to every business transaction, filter by the tag. They
are explicit that Monarch is not a business accounting tool and that a mixed account
means manually reviewing every transaction.

**QuickBooks Solopreneur / Self-Employed** uses a hard binary per transaction:
Business or Personal, with a Schedule C category required on the business side. A mixed
receipt is handled by splitting, and **each split leg independently carries its own
Business/Personal choice**.

The common shape across all three: a **transaction-level marker that is orthogonal to
which account paid**, **splits** for mixed receipts, and a **report that filters on the
marker**. Nobody tries to move the money.

## 2. What KEEL already has

| Primitive | Where | Note |
|---|---|---|
| Entities | `entities` table, `entity_kind` enum (`personal`, `sole_prop`, `llc_single`, `llc_multi`, `s_corp`, `trust`, `other`) | The right noun already exists |
| Entity attribution | `ledger_accounts.entity_id`, `postings.entity_id` | Structural, derived from the **account** |
| Entity lens | `entity-lens-context.tsx` | Household-wide view filter, Home / Accounts / Ledger |
| Tags | `tags`, `transaction_tags` (20260713120000) | Overlay pattern, audited, exported. The migration's own comment names the motivating ask: "tax-deductible across many categories" |
| Tag UI | `txn-edit-dialog.tsx` | Already present on the row edit dialog |
| Tax lines | `ledger_accounts.tax_line` incl. `business_expense` (Schedule C) | Category-level, user-set, never inferred |
| Splits | `keel_set_splits*`, contra legs | Mixed receipts already possible |
| Reimbursements | 20260712140000 | "Money someone owes you back, tracked against the original expense, never fake income" |

**The gap.** Entity attribution is structural and comes from the account. There is no
way to say "this personal-card purchase belongs to the LLC's books." A single-entity
household never notices; the moment there is a business entity it is the first thing
that breaks.

## 3. The distinction that shapes the design

Paying a business cost with a personal card is **two separate facts**:

1. **Classification.** It is a business expense. It belongs on the Schedule C and in
   the entity's P&L.
2. **Economics.** The business did not pay for it. You did. The business now owes you,
   or your capital account in it went up.

A checkbox answers (1) and says nothing about (2). That is fine, and it is what Quicken
and Monarch actually ship. But conflating them is how you end up with an LLC P&L that
does not tie to any bank account. So the design is explicitly two layers, and **layer 1
has to be shaped so layer 2 lands on top of it without a migration**.

## 4. Recommendation: entity-bound tag (layer 1)

Adopt Quicken's mechanism, using primitives KEEL already has.

**Model.** Bind one tag to one entity (`entities.business_tag_id`, or symmetrically
`tags.entity_id`). A transaction carrying that tag belongs to that entity's books
regardless of which account paid for it.

**UI, and this is the checkmark that was asked for.** The affordance adapts to the
household:

- Exactly one business entity: a single checkbox, "Business expense," on the ledger row
  and in the transaction edit dialog. One click, done.
- Two or more: the checkbox becomes a small picker of which business.
- Zero: the checkbox offers to create the business entity first, once.

**Why not a plain `is_business` boolean.** Entities already exist and are the correct
noun. A boolean is the same amount of UI work and needs a data migration the day a
second entity appears. There is no saving here, only deferred cost.

**Why not a per-transaction `entity_id` override.** It collides with the structural
posting entity (`postings.entity_id`, and the balanced-posting trigger at
`supabase/migrations/20260710210300_ledger.sql:149`) and would force every scope
call site to reason about two different entity ids that disagree. The tag is an
*overlay*: it never touches postings, never changes a total that claims to include the
money, follows the same append-safe pattern as `transaction_categories`, and is already
covered by the export guarantee (Law 6).

**Ambiguity rule.** Quicken invents "Unknown Business" when two business tags land on
one transaction. KEEL should refuse instead: block the second business tag at the
command layer and offer split. Silent ambiguity in an attribution that feeds a tax
artifact is not acceptable under the explicit-ownership invariant.

**Mixed receipts.** Reuse splits. Correction found during S1 review: this does not
work yet. `keel_cmd_set_splits` adds postings to the *same* canonical transaction
rather than creating child rows, and `transaction_tags` is keyed on the canonical
transaction, so there is nothing per-leg to tag. Splitting a charge between two
businesses needs S4, and the refusal message no longer promises otherwise.

**Reporting.** This is the one genuinely careful part. The entity scope currently means
"accounts owned by this entity." It has to become "accounts owned by this entity, plus
transactions tagged with this entity's business tag." That belongs in the single
authorization compiler, not in each report, per the scope-safe-calculation invariant
(BC-v2.1 §9.1). Once it lands, the existing `tax_line = 'business_expense'` rollup
becomes a real Schedule C view, and a per-entity tax-year export becomes possible, which
`PERSONA-FEEDBACK.md` §1.4 already flags as a high-value quick add.

**AI.** Class B, suggest and approve, always. KEEL may propose "this looks like a
business expense" and may propose a rule ("everything from this merchant is business"),
but inference never silently becomes fact. Never class A here: a wrong business flag is
a wrong tax artifact.

## 5. Layer 2, sketched not built: owner-paid business expense

Once a transaction in a personal account is marked business, offer an optional second
step: *the business owes you this back*. That books an owner contribution / due-to-owner
against the entity and can settle through the existing reimbursements machinery, which
is structurally the identical shape ("money owed back, tracked against the original
expense, never fake income"). This is what makes the entity's P&L and balance sheet
actually true, and it is the missing owner-draw / capital-account semantics called out
in `PERSONA-FEEDBACK.md` §1.3 and `BACKEND-SURFACING-AUDIT.md` tier 2 item 10.

Layer 1 does not block it. The business tag identifies exactly the population of
transactions layer 2 needs to act on.

## 6. Proposed slices

| Slice | Content | Size |
|---|---|---|
| S1 | **Built.** Migration: bind tag to entity, `keel_transaction_set_business`, `keel_entity_business_tag_unbind`, the one-business and delete guards, audit, grants. 48 pgTAP assertions. | small |
| S2 | **Built.** UI: the Business control in the edit dialog, a business badge on ledger rows, a Business facet in the ledger, and the `/tags/set-business` route. | small |
| S3 | Scope compiler: entity scope includes tagged transactions. Reports, Schedule C view, per-entity tax-year export. | medium, the careful one |
| S4 | Mixed-receipt splits: tag a split leg from the split editor. | small |
| S5 | Layer 2: owner-paid / due-to-owner, capital account categories. | medium, separate decision |

No human checkpoint (⚑) is required for S1 to S4: no secrets, no Plaid, no production
approval. S3's accountant-facing export deserves a taste pass before it ships.
