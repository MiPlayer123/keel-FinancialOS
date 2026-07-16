# Competitor UI Reference Library — July 2026
Internal design reference for KEEL only. Sources: official Apple App Store listings (developer-published screenshots, fetched at 1600px via Apple's image CDN) and public marketing pages. Do not redistribute, publish, or ship any of these images; they are competitors' copyrighted marketing assets collected for private study of interaction patterns.

## Contents
- copilot/ — 22: iPhone (8), iPad (7), **macOS desktop (7)** ← primary desktop-canon reference: review loop, dashboard, categories, recurring
- monarch/ — 21: iPhone (20) covering reports, budgets, goals, accounts, sankey/cash flow + 1 web
- quicken-simplifi/ — 15: iPhone (14) — Spending Plan, watchlists, projected cash flow + 1 web
- quicken-classic/ — 18: iPhone companion (16) + 2 web (desktop UI). NOTE: desktop Classic registers/reconcile/investment-lot views are NOT publicly published at quality — capture from a licensed install (see WANTED).
- ynab/ — 26: iPhone (11), iPad (8), web (7) — envelope budgeting canon
- rocket-money/ — 7: iPhone — subscriptions/cancellation patterns

## WANTED (capture manually; agents cannot obtain these)
1. Quicken Classic desktop (from the licensed family install): account register, reconcile window mid-flow, investment lots/cap-gains screens, business P&L report, rental module.
2. Monarch web app logged-in: transactions w/ rules editor, budget (flex mode), Goals 3.0 allocation flow, Sankey report, business tracking settings.
3. Copilot Mac logged-in: review swipe states, split editor, Money Assistant suggestions.
4. Any Simplifi web logged-in views.
Place captures in the matching folder as `own-NN-description.png`.

## Usage rule
Reference for FLOWS and patterns (what states exist, what's adjacent to what, empty/error states), not pixels. KEEL's visual identity (financial calm / ledger canon) is already locked; copying competitor styling is off-canon and off-limits.

## Delta — 2026-07-16 merge (agent)
Added native-resolution App Store rips not in the curated set above (source URLs in
`appstore-manifest.json`): monarch iPad ×10, quicken-simplifi iPad ×5, quicken-classic
iPad ×7. Folder layout is now per-app: copilot/, monarch/, quicken-simplifi/,
quicken-classic/, ynab/, rocket-money/. Community/unofficial screenshot hunt (logged-in
web views from reviews/blogs) is the next pass; those land as `community-NN-*.jpg`.
