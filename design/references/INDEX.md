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

## Delta — 2026-07-16 community/unofficial sweep (agent)
Added 110 visually-verified screenshots across three passes (all sources recorded in
per-folder `community-manifest.json` / `community-gaps-manifest.json`; gap-fill files
are prefixed `community-x`):
- Per-app logged-in UI from help centers, reviews, and blogs: Monarch web (15+5),
  Copilot Mac/web (11+11), Simplifi web (9+9), Quicken Classic desktop (12) incl.
  register w/ running balance + reconcile window, YNAB web (9+6), Rocket Money (10+4).
- New apps: `ramp/` (12) and `brex/` (11) — B2B approval chains, receipt
  auto-verification, coding queues, rule builders for KEEL's suggest→approve and
  entity surfaces.
- New `flows/` folder (21): full Plaid Link tour (plaid.com/docs), onboarding/empty
  states, settings pages, CSV/OFX/QIF import mapping (Lunch Money, YNAB), receipt attach.

Still genuinely unobtainable publicly (manual-capture WANTED remains): Quicken Classic
lot-selection dialog + budget annual view + rental module (sign-in-gated), Monarch
post-rebrand widget dashboard + anything from its Cloudflare-gated help center,
household/member-management UI from any app, YNAB current target-creation form.
