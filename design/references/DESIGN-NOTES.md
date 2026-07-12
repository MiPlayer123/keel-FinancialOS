# Design notes — patterns worth stealing (translated to KEEL)

Distilled from Copilot Money (primary), Monarch, Quicken/Simplifi. KEEL stays Warm-Minimal
(Tailwind stone + deep emerald, red = negative money only, dense-but-calm). We adapt the
*structure and hierarchy*, not the neon.

## Copilot Money (primary reference)
- **Calm, content-first, generous type.** Big clear numbers, muted chrome, one accent.
- **Accounts grouped by type** (Cash, Credit, Investments, Loans) with a **group subtotal**,
  each row = institution/name + balance; tap → account detail.
- **Net worth as the anchor** (one number + trend line), not a wall of widgets.
- **Category spending** shown as compact bars with amount + budget remaining.
- **Rich transaction rows**: merchant (normalized) + category chip + account + amount right-aligned.
→ KEEL: net position hero, accounts grouped asset/liability with subtotals, dense transaction
  register with status/account, monospace right-aligned amounts.

## Monarch
- **Net worth over time** as a hero chart; accounts panel grouped with subtotals and a total.
- **Cash flow** (in vs out) summary; transactions register with bulk edit.
→ KEEL: reserve a Home "net worth trend" slot (needs a history read proc later); accounts page
  mirrors the grouped-with-subtotal pattern; ledger gets filters + account column.

## Quicken / Simplifi
- **Classic register**: date · payee · category · amount · **running balance**; dense rows.
- Reports/budgets as separate surfaces.
→ KEEL: account-detail register aims for a running balance once posting detail is exposed;
  Ledger is the household-wide register.

## KEEL surface plan
- **Home** — net position (hero) + accounts summary + recent activity. (Trend/cash-flow later.)
- **Accounts** — all accounts grouped Assets / Liabilities, subtotals + net; row → detail.
- **Account detail** — header (name · type · balance) + that account's transaction register.
- **Ledger** — household-wide register (dense table; filters later).
- **Review** — suggest→approve. **Connections** — institutions. **Settings** — household/export/password.

## Interaction/aesthetic rules (ours)
- One glance = one number (Safe-to-Spend/net position hero). Red only for negative money.
- Mono `tabular-nums` amounts, right-aligned; thin stone borders; lots of whitespace.
- Skeletons not spinners; empty states that explain the next action; ≥44px touch targets.
