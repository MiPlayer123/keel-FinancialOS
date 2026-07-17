# Categorization & rules

Scope: category picker UX, category chips in rows, auto-categorization + review/approve loop, rules builder (condition→action, retroactive apply), category management (subcategories, groups, icons, archive), merchant normalization surfaces.

Ground truth for "KEEL today": `settings-desktop.png` (Categories + Rules cards), `ledger-desktop.png` / `ledger-mobile-390.png` (per-row category pill, raw memos), `review-desktop.png` / `review-mobile-390.png` (empty Review), census `keel-core-01.md`, `keel-money-02.md`, `keel-ops-03.md`, `keel-mobile-04.md`. Plan state: `PLAN-FEATURE-PARITY.md` W1.3/W1.4/W2.1/W2.3/W2.4.

## Convergent patterns
Things ≥3 competitors ALL do that KEEL does not:

1. **Every category carries an icon/emoji, in the picker AND in the transaction row.** Monarch (🏠 Mortgage, 🍎 Groceries — "every category is icon-prefixed, no bare-text category rows"), Copilot (colored category pill = emoji + all-caps label, reused across Dashboard/Recurrings/Accounts), YNAB (money-bag/house/light-bulb glyphs per row), Simplifi (colored initial-avatars), Quicken. KEEL categories are bare text pills everywhere (`settings-desktop.png` Categories card; `ledger-desktop.png` "Food & Drink ⌄" pill).

2. **Categories are a two-level tree (groups → subcategories) with parent roll-up + drill-down.** Copilot (Food & Drink → Restaurants/Groceries, parent aggregates children), Monarch (Income / Fixed / Flexible groups, collapsible, group subtotals), YNAB (category groups with roll-up arithmetic), Simplifi (up to 4-level tree), Quicken. KEEL is a flat alphabetical list of 16 expense + 3 income categories, no grouping anywhere (`budgets-desktop.png`, `settings-desktop.png`).

3. **Inline category picker is a typeahead with search + inline "create category" + shows the current (wrong) value.** Copilot (popover opens on the row, filtered typeahead, "New category" as last result row, previous pill shown crossed-out), Monarch (chip editor + dropdown), YNAB/Simplifi. KEEL's picker is a plain bordered dropdown pill with a chevron; no search, recents, or grouping is evidenced (`ledger-desktop.png`).

4. **Rules/policy builder supports multiple conditions AND multiple actions, with a dry-run preview count before save.** Monarch (If: Merchants/Amount/Categories/Accounts; Then: Rename/Update category/Add tags/Hide/Review status/Link to goal; "Preview changes" tab with live match count — `monarch-community-01.md` image 03), Brex (custom rule on NetSuite field multi-value; MCC if/then block — `brex-community-01.md` images 06/07), Ramp (if/then/else conditional coding — `ramp-community-01.md` image 07). KEEL's rule is one condition (`description contains`) → set category and/or friendly name (`settings-desktop.png` Rules card).

5. **A populated review/approve queue that shows the suggestion, its reasoning/evidence, and per-item + bulk approve.** Copilot ("Transactions To Review" with per-row category pill + checkbox + "Mark all as reviewed"; `To Review` status on detail), Ramp (AI verdict card with plain-language rationale + evidence + bulk auto-approve disclosure), Brex (Prepare/Review/Exported queue with counts). KEEL's Review page is empty and auto-categorization happens silently (`review-desktop.png`; audit row "Auto-categorized new transactions · KEEL (automatic)" in `settings-desktop.png`).

6. **Normalized merchant name is the primary label; the raw bank memo is secondary/preserved.** Copilot, Monarch, Ramp (merchant name bold + category subtext), Rocket Money (merchant logo + name), Simplifi. KEEL renders raw ACH/processor strings verbatim as the primary bold label ("ORIG CO NAME:ACMELABS CO ENTRY DESCR:PAYROLL…", "FID BKG SVC LLC MONEYLINE Z347266911HG4B8") with visibly inconsistent normalization row-to-row (`ledger-desktop.png`, `keel-core-01.md`).

## Findings

### CATEGORIZATIONRULES-1 — AI auto-categorizes silently; the promised suggest→approve loop for categories does not exist in the UI [P1]
- **Evidence:** `review-desktop.png` / `review-mobile-390.png` (empty), `settings-desktop.png` (audit rows "Auto-categorized new transactions · KEEL (automatic)"), `keel-core-01.md`, `keel-mobile-04.md`; contrasts `copilot-community-01.md` (To-Review state, quick-edit), `ramp-community-01.md` (AI verdict + reasoning), `brex-community-01.md` (Prepare/Review queue).
- **Competitors:** Copilot surfaces every uncertain categorization in a "Transactions To Review" list with the suggested pill and a one-click fix; Ramp shows the AI verdict *with its evidence* ("related to an active business trip") and a thumbs up/down; both make the machine's category assignment visible and reversible before it's treated as fact.
- **KEEL today:** Review's own empty-state copy promises "categorizations will surface here as suggestions — each waiting for your approval" (`review-desktop.png`), but the audit log shows categories are already auto-applied by KEEL with no review surface, and Review stays empty. This is both a copy/behavior contradiction (trust) and a departure from Law 10 (category = Class B suggest+approve) and Law 11 (typed AI response with confidence/reason_codes/evidence_refs). No confidence, reason, or evidence is shown anywhere on a categorized row.
- **Fix:** Route auto-categorizations below a confidence threshold into the Review queue as typed suggestions (tldr + confidence + reason_codes + evidence_refs + approve/dismiss), auto-apply above threshold with a visible "auto" badge that is one-click reversible (Ramp/Copilot pattern). Reconcile the Review empty-state copy with actual behavior.
- **Maps to:** NEW (extends gap #10 AI categorization node; Review page W1.5 badge exists but no populated categorization view).

### CATEGORIZATIONRULES-2 — You cannot categorize a transaction on mobile at all [P1]
- **Evidence:** `ledger-mobile-390.png`, `keel-mobile-04.md` (no per-row category control / recategorize path captured), `PLAN-FEATURE-PARITY.md` W1.4 ("mobile has no recategorize path — inline picker is sm+ only").
- **Competitors:** Copilot, Monarch, Rocket Money, Simplifi all let you tap a transaction on a phone and change its category from a bottom sheet / detail. Categorizing on the phone is the single most common mobile finance action.
- **KEEL today:** The mobile ledger row shows "Account · Category" as static truncated subtitle text with no editable pill; the inline picker is desktop-only by KEEL's own plan. On a 390px screen (Law 8: "must remain usable at 390px") the core daily interaction is unavailable.
- **Fix:** Add a tap-to-open transaction detail sheet on mobile with a category picker (and the same edit affordances desktop has). Reuse the edit dialog; do not gate the picker behind `sm+`.
- **Maps to:** W1.4 (must drop the sm+ restriction).

### CATEGORIZATIONRULES-3 — Category picker is a bare dropdown: no search, no recents, no grouping [P1]
- **Evidence:** `ledger-desktop.png` (bordered "Food & Drink ⌄" pill), `settings-desktop.png` (flat 16-category list); contrasts `copilot-community-01.md` image 02 (typeahead popover with filtered results + inline "New category" + crossed-out current pill), `monarch-community-01.md` (chip editor).
- **Competitors:** Copilot's picker filters as you type ("g" → Groceries/Gym), lets you create a category without leaving the flow, and shows the value you're replacing. With 16 categories today (and growing once "Ideas" chips + New category are used), a flat unsorted dropdown is already slow.
- **KEEL today:** The row control is a native-style dropdown pill with a chevron; no typeahead, no recents-first ordering, no group headers evidenced. Users scan an alphabetical list every time.
- **Fix:** Replace the dropdown with a searchable command-menu picker: typeahead filter, recents/most-used surfaced first, grouped by parent once subcategories land (see CR-5), and an inline "Create category" row. Keep it keyboard-navigable on desktop.
- **Maps to:** W1.4 (upgrade the picker) + depends on W2.3 for grouping.

### CATEGORIZATIONRULES-4 — Rules engine is a single `description contains` → set category/name; no amount/account/merchant conditions, no multi-action, no dry-run [P1]
- **Evidence:** `settings-desktop.png` + `keel-ops-03.md` (Rules card copy: "When a bank description contains your pattern, KEEL sets the category and/or a friendly name"); `PLAN-FEATURE-PARITY.md` W2.1 (matcher kind `description_contains` v1). Contrasts `monarch-community-01.md` image 03, `brex-community-01.md` images 06/07, `ramp-community-01.md` image 07.
- **Competitors:** Monarch rules match on Merchants / Amount / Categories / Accounts and apply Rename / Recategorize / Add tags / Hide / Review status / Link-to-goal — each independently toggleable — with a "Preview changes" tab showing the live count of affected transactions before saving. Brex/Ramp add amount thresholds, MCC lists, and location/ERP-field conditions with if/then/else.
- **KEEL today:** Only one condition type (bank-description substring) and two possible actions (category, friendly name). No amount range, account, or merchant-normalized-name condition; no way to see how many existing transactions a rule would touch before committing.
- **Fix:** Extend the rule schema to multiple condition kinds (amount range, account, merchant, category) and multiple actions, and add a two-phase preview (Monarch's live-count dry run) that BC-v2.1 §3 already calls for. Keep it deterministic (Law 1).
- **Maps to:** W2.1 (expand beyond v1 `description_contains`).

### CATEGORIZATIONRULES-5 — No category groups / subcategories: flat taxonomy blocks roll-up, drill-down, and a scannable picker [P1]
- **Evidence:** `budgets-desktop.png` (16 flat rows), `settings-desktop.png` (flat pills), `keel-money-02.md`; `PLAN-FEATURE-PARITY.md` W2.3 (DEFERRED — PFC autocategorize joins by name). Contrasts `copilot-community-01.md` (Food & Drink → Restaurants/Groceries roll-up), `monarch-community-01.md` (Income/Fixed/Flexible groups), `ynab-community-01.md`, `quicken-simplifi-community-01.md` (nested tree).
- **Competitors:** Every serious competitor nests categories under groups; a child can be over budget while the parent group is under, spending mix rolls up to the parent with drill-down to children, and pickers are grouped so long lists stay navigable.
- **KEEL today:** One flat level. Reports already show a spending-mix list and 6-month table that would benefit from parent roll-up (`reports-desktop.png`), and the picker/budgets list have no structure. This is a known gap (#21/W2.3) but the concrete UI cost is: no grouped picker, no parent roll-up in reports, no drill-down.
- **Fix:** Ship the deferred `parent_ledger_account_id` (one level), grouped pickers, and parent roll-up with drill-down in Reports/Budgets. Requires the stable system-category key W2.3 already identifies as the blocker.
- **Maps to:** W2.3.

### CATEGORIZATIONRULES-6 — Raw ACH/processor memos are the primary transaction label; no clean merchant name with the original preserved beneath [P1]
- **Evidence:** `ledger-desktop.png` / `ledger-mobile-390.png` ("ORIG CO NAME:ACMELABS…", "FID BKG SVC LLC MONEYLINE Z347266911HG4B8", normalization "visibly inconsistent row-to-row"), `keel-core-01.md`, `keel-mobile-04.md`. Contrasts `copilot-community-01.md`, `monarch-community-01.md`, `ramp-community-01.md`, `rocket-money-community-01.md`.
- **Competitors:** Copilot/Monarch/Ramp/Rocket Money all show a normalized merchant name (often with a logo) as the bold primary label and keep the raw string as data behind the detail view — the register reads as merchants, not bank noise.
- **KEEL today:** The bold primary label is the raw memo verbatim (Law 5 source-preservation is satisfied, but display is not). Some rows are clean ("Panda Express", "Lyft") and adjacent rows are raw — inconsistent. There is no dedicated merchant-normalization surface; the only lever is the per-rule "friendly name."
- **Fix:** Show a normalized display name as the primary label with the immutable original one tap away (detail view / hover), keeping the raw text as data-tier (Law 5). Add a merchant-normalization layer (deterministic dictionary + rule-driven friendly names) distinct from the rule-rename layer W2.1 already separates (`rule_renames`).
- **Maps to:** NEW (merchant normalization surface; complements W2.1 friendly-name; gap #21).

### CATEGORIZATIONRULES-7 — No "create rule from this transaction" affordance; rules can only be authored blind in Settings [P2]
- **Evidence:** `settings-desktop.png` (Rules card + "New rule" is the only entry point), `keel-ops-03.md`; `PLAN-FEATURE-PARITY.md` W2.1 mentions the affordance but it is not in the shipped screens. Contrasts `monarch-community-01.md` ("Edit rules" from the transactions toolbar → New rule modal pre-scoped).
- **Competitors:** Monarch lets you open the rule builder from the transaction list, pre-filled from the row you're looking at, so a rule is created in context.
- **KEEL today:** Rules live only in Settings and start empty; a user categorizing a transaction in the Ledger has no path to "always do this" from that row.
- **Fix:** Add "Create rule from this transaction" in the ledger edit dialog / detail, pre-filling matcher (merchant/description) and action (the category just chosen), then the dry-run preview from CR-4.
- **Maps to:** W2.1 (the "create rule from this transaction" line).

### CATEGORIZATIONRULES-8 — No transaction splits: one transaction cannot be allocated across categories [P2]
- **Evidence:** `ledger-desktop.png` (single category pill per row, no split affordance), `keel-core-01.md`; `PLAN-FEATURE-PARITY.md` W2.4 (DEFERRED). Contrasts `copilot-community-01.md` images 04–06 (Equal/Custom split editor, per-leg category or EXCLUDED, live "Left to split", split summary on detail).
- **Competitors:** Copilot's split editor divides a transaction N ways (equal or custom %), each leg gets its own category (or Excluded), sums are validated live, and the detail view surfaces "$100 split 4 ways" as a first-class field. Essential for Costco/Amazon-style mixed baskets.
- **KEEL today:** One category per transaction; no split UI. A $200 Costco run is forced into a single category.
- **Fix:** Ship manual-transaction splits (W2.4): split rows summing to the parent (Σ=0 via the existing deferred trigger — Law 3), per-leg category, and an exclude-leg option. Surface a split summary on the transaction detail.
- **Maps to:** W2.4.

### CATEGORIZATIONRULES-9 — No exclude-from-spending / hide flag on a transaction [P2]
- **Evidence:** `ledger-desktop.png` (no exclude control), `reports-desktop.png` (footnotes exclude only *confirmed transfers* and refunds, nothing user-driven), `keel-core-01.md`. Contrasts `quicken-simplifi-community-01.md` ("Excluded this month", "Show excluded transactions" toggle), `monarch-community-01.md` ("Hide transaction" rule action), `copilot-community-01.md` ("Excluded" categories / split legs).
- **Competitors:** Simplifi/Monarch/Copilot all let a user exclude an individual transaction (or split leg, or a whole category) from spending totals without deleting it — critical for reimbursables, one-off anomalies, and business-vs-personal noise.
- **KEEL today:** Exclusion is system-only (confirmed transfers, refunds). A user cannot say "don't count this in my spending."
- **Fix:** Add a per-transaction (and per-split-leg) exclude flag, honored by the pinned spending formula (W2.2 formulaVersion), plus a rule action "exclude" and a reports toggle to show/hide excluded rows.
- **Maps to:** NEW (ties into W2.2 spending formula + W2.1 rule actions).

### CATEGORIZATIONRULES-10 — No tags dimension separate from category [P2]
- **Evidence:** `ledger-desktop.png` (only a single category pill per row), `keel-core-01.md`. Contrasts `copilot-community-01.md` (Tags field "+ Add tag"), `monarch-community-01.md` ("Add tags" rule action), `quicken-simplifi-community-01.md` (Tags column).
- **Competitors:** Tags let a transaction carry orthogonal labels (trip, project, reimbursable, tax-relevant) independent of its one category — Copilot, Monarch, and Simplifi all model tags as a first-class second dimension, and rules can add them.
- **KEEL today:** Only one category per transaction; no tag concept. This is especially costly for KEEL's multi-entity/LLC thesis (business-vs-personal, tax-line grouping) where a single category is insufficient.
- **Fix:** Add a tags table + per-transaction tags, a tag filter in the ledger, and an "add tag" rule action. Distinct from categories (many-to-one category, many-to-many tags).
- **Maps to:** NEW.

### CATEGORIZATIONRULES-11 — Category management is a dead-end: no visible archive / merge / rename / re-parent, and no system-vs-user distinction [P2]
- **Evidence:** `settings-desktop.png` (Categories card: pills + "Manage" link + "New category" + "Ideas" chips, but no per-pill edit/archive/merge affordance), `keel-ops-03.md` ("no evident distinction between system-default categories … and user-created ones"). Contrasts `monarch` (customize categories onboarding step), `copilot-community-01.md` ("Turn Off Budgeting", Excluded categories, Rebalance), lifecycle sections.
- **Competitors:** Competitors let you rename, merge, archive, and reorder categories, and visibly separate system defaults from user categories.
- **KEEL today:** "Manage" is the only affordance and its target isn't shown; pills have no inline edit/delete; "Uncategorized Expense/Income" render identically to user categories. Archiving with reassignment (W2.3 procs) has no surface. Merge (a common need after over-creating categories) is absent from the plan entirely.
- **Fix:** Build the Manage screen: rename / archive-with-reassign / merge / re-parent, with system categories flagged and protected. Surface "N transactions will move" on archive/merge (dry-run parity with CR-4).
- **Maps to:** W2.3 (adds merge, which W2.3 currently omits).

### CATEGORIZATIONRULES-12 — Retroactive rule apply is unproven and unsurfaced; the preview-count contract isn't visible [P2]
- **Evidence:** `settings-desktop.png` (Rules card: "No rules yet", no apply-to-existing control), `PLAN-FEATURE-PARITY.md` W2.1 ("retroactive apply reports affected count" — designed, not shown as shipped UI). Contrasts `monarch-community-01.md` ("Preview changes" tab, live "0" match badge).
- **Competitors:** Monarch shows, before you save a rule, exactly how many existing transactions it will change; applying retroactively is an explicit, counted, confirmable action.
- **KEEL today:** No rule exists yet, and the Rules card copy only describes forward application "on every sync." Whether a new rule touches history — and how the user confirms that — is invisible.
- **Fix:** Make retroactive apply a first-class, two-phase action on rule save/edit: "This rule matches N existing transactions — apply now?" with a confirm, plus a visible provenance (`source='rule'`, rule_id) on affected rows so "your own edits always win" (`keel-ops-03.md`) is demonstrable.
- **Maps to:** W2.1.

### CATEGORIZATIONRULES-13 — Bulk-categorize is unconfirmed and its action bar is undesigned [P2]
- **Evidence:** `ledger-desktop.png` / `ledger-mobile-390.png` ("Select" mode toggle present; bulk action bar NOT captured), `keel-core-01.md` open question ("what the bulk-action bar looks like … not captured"), `PLAN-FEATURE-PARITY.md` W1.3. Contrasts `monarch-community-01.md` (persistent "N selected / Edit N" bar), `copilot-community-01.md` (bulk Category/Review/Type bar), `brex`/`ramp` bulk bars.
- **Competitors:** Selecting rows surfaces a pinned bar ("Edit N") that applies one category to the whole selection in one action — a daily cleanup workflow.
- **KEEL today:** A "Select" toggle exists but no bulk-action bar is evidenced; it's unclear whether one category can be applied to N rows and what the bar offers.
- **Fix:** Ship the bulk-action bar: selection count + "Categorize N" (and later exclude/tag), applied through the audited categorize route. Mirror Monarch's count-in-the-button pattern.
- **Maps to:** W1.3.

### CATEGORIZATIONRULES-14 — Categorization audit rows leak the raw internal event name `ingest.apply_action` to users [P3]
- **Evidence:** `settings-desktop.png` Recent activity (humanized "Auto-categorized new transactions", "Decided a transfer match" sit next to raw "ingest.apply_action · KEEL (automatic)" repeated ~15×), `keel-ops-03.md`.
- **Competitors:** N/A (KEEL-specific polish); Ramp/Brex collapse bulk automated actions into one summarized, dismissible line rather than repeating identical rows.
- **KEEL today:** The categorization/ingestion audit trail — the trust surface for "what did the AI do" — mixes plain-language narration with a developer string and repeats the same minute-stamped row a dozen-plus times, degrading legibility of exactly the log that proves the suggest→approve loop.
- **Fix:** Map every event kind to user-facing copy (no raw `verb.noun` strings) and collapse runs of identical automated actions into one "Auto-categorized N transactions" row with a count (Ramp's collapse pattern).
- **Maps to:** W1.10 (Activity card copy).
