# Accounts & account detail

## Convergent patterns
(≥3 competitors do these; KEEL does not)

1. **Accounts grouped by account TYPE — Cash / Credit / Investments / Loans — each with a subtotal**, not just Assets vs Liabilities. Copilot (`Credit cards` / `Depository` / `Investment` sidebar groups, each collapsible with a rollup), Monarch (`NET WORTH / CASH / CREDIT CARDS` segmented control + `Cash`/`Credit cards` sections with per-group subtotals and a "% of assets" figure), YNAB (`CASH / CREDIT / LOANS / TRACKING / CLOSED` groups with signed rollups), Simplifi (`Cash & Checking / Credit / Savings / Other Banking`), Quicken (`My Checking`/`My Savings`, then `OTHER ASSETS`, `INVESTMENTS` bands whose header row doubles as an inline subtotal). Five of five. KEEL shows only two buckets: Assets and Liabilities.

2. **Net worth presented as a hero with a trend chart + a period delta (amount + % + window) + time-range tabs, on the accounts/net-worth surface itself.** Monarch (`$748,606` + `↑ $32,483.59 (4.5%) 1 month` + line chart + `1M 3M 6M YTD 1Y ALL`), Copilot (Assets/Debt roll-up with delta pills + dual-line chart + `1W 1M 3M YTD 1Y ALL`), Rocket Money (`Net Worth $69,556` + `$437 in the last month` + chart + `1M 3M 6M 1Y All`). KEEL's Accounts page shows a bare `$14,763.85` with no chart, no delta, no time range, no as-of stamp.

3. **Per-account "last synced N ago" freshness stamp shown in each account row.** Monarch (`4 hours ago` / `9 hours ago` beneath each balance), Copilot (`Updated 5 hours ago`), Quicken (`Last synced from Quicken Desktop 1 day ago`). KEEL's Accounts page carries no freshness at all; the only "Updated 21m ago" + Sync lives on the Home condensed block, not here.

4. **Account detail = per-account register with a running-balance column + a balance-history chart with time tabs.** Quicken (register: date · payee · category · amount · running balance per row, plus swipeable `TODAY'S BALANCE` cards), Copilot (per-account detail pane: chart + `1W 1M 3M YTD 1Y ALL` tabs + utilization + balance/limit), Monarch (per-account chart + tabs). KEEL: not evidenced anywhere in the drop; planned only (W1.9).

## Findings

### ACCOUNTS-1 — Accounts grouped only by Assets/Liabilities, not by account type (Cash/Credit/Investments/Loans) [P1]
- **Evidence:** `design/current/2026-07-16/accounts-desktop.png`, `accounts-mobile-390.png`; census `keel-core-01` (§Layout: "Assets" and "Liabilities" the only two sections), `keel-mobile-04`. `design/references/DESIGN-NOTES.md` explicitly specs "Accounts grouped by type (Cash, Credit, Investments, Loans) with a group subtotal."
- **Competitors:** Copilot `Credit cards`/`Depository`/`Investment` collapsible groups; Monarch `Cash`/`Credit cards` sections each with subtotal + "% of assets"; YNAB `CASH/CREDIT/LOANS/TRACKING/CLOSED`; Simplifi `Cash & Checking/Credit/Savings/Other Banking`; Quicken `OTHER ASSETS`/`INVESTMENTS` bands with inline subtotals.
- **KEEL today:** exactly two bands — Assets ($15,178.90) and Liabilities (−$415.05). Every account, regardless of subtype, lands flat in one of the two. W1.11 already defines subtypes (cash / property / vehicle / other / loan) at account creation, so a manually-added house or car or loan would still collapse into the coarse Assets/Liabilities view with no finer grouping — the problem worsens as account variety grows.
- **Fix:** render type bands (Cash, Credit, Investments, Loans, Real Estate/Other Assets) with a per-band subtotal row, nested under the existing Assets/Liabilities net roll-up. Map the existing W1.11 subtype field to display groups; add an `investment` subtype path when holdings land.
- **Maps to:** extends W1.11 (manual-account subtypes) / NEW (accounts grouping)

### ACCOUNTS-2 — Net worth on the Accounts page is a bare number: no trend, no delta, no time-range, no as-of [P1]
- **Evidence:** `accounts-desktop.png` (Net-worth card is label + `$14,763.85` + two action buttons only), census `keel-core-01` (§Layout, §Controls — no date-range/drill control on the card), `keel-mobile-04` (explicitly flags "no as-of stamp visible next to it, despite BC-v2.1 §9.1 reproducible-numbers requirement").
- **Competitors:** Monarch/Copilot/Rocket Money all pair the net-worth (or Assets/Debt) figure with a trend chart, a period delta (amount + % + window), and time-range tabs, right on the accounts surface; Monarch also shows per-group deltas and "% of assets."
- **KEEL today:** the 90-day net-worth chart exists only on Home (`dashboard-desktop.png`); the Accounts hero repeats the raw number with zero trend, delta, period control, or "as of" — a self-inflicted Law 9 gap on the single most material figure in the app.
- **Fix:** put a net-worth trend chart + period tabs + period delta (amount, %, window) + an "as of / updated" stamp on the Accounts hero, reusing the Home net-worth series read model (`keel_net_worth_as_of` + snapshots). Add per-band deltas and "% of net worth" à la Monarch.
- **Maps to:** FEATURE-GAP #13 / #14 (net-worth trend); NEW (surface it on Accounts, not just Home)

### ACCOUNTS-3 — No per-account sync freshness / staleness signal on the Accounts page [P1]
- **Evidence:** `accounts-desktop.png` (rows are name / type / balance / chevron only — no timestamp, no status), census `keel-core-01` (§IA: Home has "Updated 21m ago" + "↻ Sync"; the Accounts page does not).
- **Competitors:** Monarch per-account `4 hours ago`; Copilot `Updated 5 hours ago`; Quicken persistent `Last synced … 1 day ago`. All treat per-account freshness as first-class, same visual weight as the balance.
- **KEEL today:** a possibly-days-stale `$16,889.94` is visually identical to a fresh one; no per-account timestamp, no needs-reauth/stale badge, and no Sync control on this page. Connections (`connections-desktop.png`) has second-precision sync times but they're one nav away and not tied to the balance the user is reading.
- **Fix:** show a per-account "Updated Nm ago" line (from `balances.latest`) beneath each balance, plus a per-row stale / reauth-needed state (Connections already tracks `connection_health_events`); add a Sync button to the Accounts header.
- **Maps to:** extends W1.9 (balances.latest) / NEW

### ACCOUNTS-4 — Account detail: no evidenced per-account register with running balance or balance-history chart [P2]
- **Evidence:** account rows carry a `>` chevron implying a detail route, but census `keel-core-01` open question notes it is unconfirmed what the chevron opens; no account-detail screenshot exists in the 2026-07-16 drop; W1.9 plans running-balance + available-vs-current but it is unbuilt/unshown.
- **Competitors:** Quicken register shows a running balance under every transaction's amount + swipeable `TODAY'S BALANCE` summary cards; Copilot per-account pane = balance-history chart + time tabs + utilization + balance/limit; Monarch per-account chart + tabs.
- **KEEL today:** at best a filtered ledger behind the chevron; the running-balance column that "ties to the header" (DESIGN-NOTES / W1.9) and a per-account balance chart are planned, not present.
- **Fix:** ship account detail = header (name · type · institution · current & available balance) + balance-history chart with time tabs + a register with a running-balance column computed newest→oldest from the account's current ledger balance so it reconciles to the header (the W1.9 pattern).
- **Maps to:** W1.9

### ACCOUNTS-5 — Available-vs-current, credit limit, and utilization not shown [P2]
- **Evidence:** `accounts-desktop.png` (Credit Card row shows only `−$415.05`; checking rows show a single balance); W1.9 notes `balances.latest` (available-vs-current) is "unused today."
- **Competitors:** Copilot credit card renders `$7,524.20 / $15,000.00` (current / limit) + a `50.16%` utilization pill; Rocket Money surfaces `Card Balance` and a derived `Net Cash`; depository accounts show available vs current when they differ.
- **KEEL today:** one balance per account — no available balance for checking (pending holds invisible), no limit / available-credit / utilization for the credit card.
- **Fix:** for depository, show available vs current when they differ; for credit, show current balance, statement balance, credit limit, available credit, and utilization %. The provider data is already in `balances.latest` (W1.9).
- **Maps to:** W1.9

### ACCOUNTS-6 — No per-account edit / rename / hide / close affordances [P2]
- **Evidence:** `accounts-desktop.png` / `accounts-mobile-390.png` (rows expose only a chevron; the page has only "Record transfer" + "Add account"); census `keel-core-01`, `keel-ops-03` controls inventories confirm no per-account menu.
- **Competitors:** YNAB has a dedicated `CLOSED` account group (close/hide); Copilot per-account `Manage connection` + `···` overflow; Monarch `···` overflow + `+` on the Accounts header.
- **KEEL today:** no rename, no hide-from-net-worth, no close/archive, no per-account overflow menu anywhere. `accounts.create` exists (W1.11) but there is no update/close command or UI, so a mis-typed or defunct account can't be corrected or retired from the list.
- **Fix:** add a per-row overflow menu — Rename (nickname), Hide (exclude from net worth, keep history), Close/Archive (move to a collapsed "Closed" band, YNAB-style), Edit type/subtype. Add `accounts.update` / `accounts.close` audited commands.
- **Maps to:** NEW (accounts.update / accounts.close)

### ACCOUNTS-7 — Account rows lack institution identity and account mask (last 4) [P2]
- **Evidence:** `accounts-desktop.png` (`CHASE COLLEGE / Checking`, `Personal Profile / Checking` — name + type only, no logo, no last-4). Contrast KEEL's own Plaid Link `Select accounts` step, which shows `Gingham Plus Checking • 0000` (census `flows-flow-01`, flow-05) — the mask exists at link time but is dropped on the Accounts list.
- **Competitors:** Monarch bank logo + nickname + type per row; Copilot last-4 (`2124`) beside the nickname; Quicken masked suffixes (`- 9136`).
- **KEEL today:** no institution logo/name and no last-4 on the row; two accounts at the same institution would be indistinguishable, and the linked institution (Connections shows Chase, Venmo) is not tied to the account row.
- **Fix:** add institution logo/name + masked last-4 to each account row (data already captured through Plaid Link); link the row to its Connections institution.
- **Maps to:** NEW

### ACCOUNTS-8 — Inconsistent account-name casing; raw provider strings surfaced as titles [P3]
- **Evidence:** `accounts-desktop.png` (`CHASE COLLEGE` and `CREDIT CARD` in all-caps next to title-cased `Personal Profile`).
- **Competitors:** all use friendly, consistent nicknames — Monarch `Melanie's Checking`, `Joint savings`; Copilot `Total Checking`; Quicken `Family Checking`.
- **KEEL today:** `CHASE COLLEGE` / `CREDIT CARD` read as raw uppercase provider account names, shouty and inconsistent beside a title-cased nickname — undermines the "financial calm, not fintech neon" voice.
- **Fix:** normalize display to a user-editable, title-cased nickname; keep the raw provider name available in account detail (source preservation). Pairs with rename (ACCOUNTS-6).
- **Maps to:** NEW / W1.9

### ACCOUNTS-9 — No reconciled / cleared status surfaced per account [P3]
- **Evidence:** `accounts-desktop.png` (no per-account status besides the balance); reconciliation exists but only on the Statements page (census `keel-ops-03`; W1.8), disconnected from Accounts.
- **Competitors:** YNAB shows a per-account reconciled checkmark; Quicken carries clearing status (Uncleared/Cleared/Reconciled) per transaction and an "As of <date>" net-worth snapshot.
- **KEEL today:** the Accounts list gives no "reconciled through" date or unreconciled-count signal per account, so the balance's trustworthiness (statement-verified vs raw-synced) is invisible where the user actually reads it.
- **Fix:** surface a small "reconciled through <date>" or unreconciled-count chip per account row, linking into the Statements/reconciliation flow (W1.8).
- **Maps to:** NEW (ties W1.8 statements to the Accounts surface)
