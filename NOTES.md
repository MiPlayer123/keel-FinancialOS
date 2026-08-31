# KEEL build journal

Record every decision, deviation, failed approach, command run, test result, migration, and human checkpoint here. Never record credential values. Refer to secrets only by environment-variable name.

## 2026-08-31 Landing copy, header density, business-expense research

- Removed the em dashes from every rendered string on the public surface (`/`, `/login`,
  `/reset-password`, `/privacy`, `/terms`, `/security`, layout metadata, opengraph image,
  landing components). Standing rule: no em dashes in user-visible copy on public pages.
  Remaining em dashes in `app/page.tsx` and `components/keel/landing` are source comments
  and JSX section banners, which never render.
- Dropped the `description` subtitle from `PageHeader` and from all 16 dashboard routes.
  On every route it restated the title and the content below it, costing above-the-fold
  height for no information. The prop is gone from the component so the pattern cannot
  return. Five descriptions carried a real rule rather than a restatement: goals do not
  move money, a reimbursement is not income, and the assistant's tools are read-only were
  already stated more fully in those pages' own empty/welcome states; statement period
  locking and receipt original immutability (Law 6) were moved into their empty states,
  adjacent to what they qualify per Addendum §D.
- Researched business-expense attribution (Quicken Business & Personal business tags,
  Monarch tag-and-filter, QuickBooks Solopreneur business/personal split) and wrote
  `docs/BUSINESS-EXPENSE-RESEARCH.md`. Ruling: an entity-bound tag, rendered as a single
  "Business expense" checkbox when the household has one business entity and a picker
  when it has more. Rejected a plain `is_business` boolean (needs migration at the second
  entity) and a per-transaction `entity_id` override (collides with `postings.entity_id`
  and the balanced-posting trigger). Classification (layer 1) is deliberately separated
  from economics (layer 2, owner contribution / due-to-owner settling through the existing
  reimbursements machinery). Not built yet; slices S1 to S5 are listed in the doc.

## 2026-08-28 P0/P1 trust and public-readiness pass

- Financial correctness: cross-currency account totals are now grouped by currency;
  the dashboard and account hero select one explicit primary currency instead of
  summing incompatible minor units. Core query failures render as errors rather than
  valid zero or empty states.
- Entity scope: the entity switcher now appears only on the three routes whose complete
  read models honor it (Home, Accounts, Ledger). Expanding the shared authorization
  compiler to every read model remains separate backend contract work.
- AI governance: the hosted Assistant's financial tools are read-only until every Class B
  action carries a payload-bound approval token. The previous direct command path violated
  BC-v2.1 §3/Law 11 and was removed rather than presented as safe. A deterministic local
  shortcut can still draft a household task and saves it only after explicit confirmation.
- Onboarding: added an idempotent, audited, service-only bootstrap for a first
  household, personal entity, and explicit A/B/C/D policies. Added password recovery.
- Public surface: rewrote unsupported claims, added Privacy/Security/Terms pages,
  configurable public URL metadata, noindex auth routes, and GitHub community files.
- Audit follow-up: reconciled the SQL and TypeScript export manifests at 99 portable
  tables and 19 explicit public exclusions. The inline endpoint still rejects bundles
  above its size ceiling, so the UI no longer promises an async path that does not exist.
- Audit follow-up: net-worth market-value read models now preserve each investment
  snapshot's currency and use deterministic `(as_of, id)` ordering. Per-account Assistant
  balance tools remain disabled until account identity and balance data share one read
  contract.
- CI follow-up: the integration job had already been failing on `main`. Corrected a
  mathematically unbalanced contra-leg fixture, scoped the live trial-balance comparison
  to exclude archived accounts while keeping the export complete, fixed a non-Promise
  PostgREST fallback, and aligned cross-tenant smuggling with the existing 404 concealment
  contract. Receipt
  reversal was a product defect: its generic immutable trigger blocked the command
  function itself. A narrow trigger now permits only `keel_api` to change an active
  receipt to reversed while preserving every original fact and continuing to reject
  direct updates and all deletes.
- CI follow-up: the account-tracking migration regressed three `keel_api`-owned goal
  functions to `auth.uid()`, but that least-privilege role intentionally has no access to
  the `auth` schema. Restored JWT-claim GUC extraction without widening privileges. The
  invalid tracked-goal regression now requires the intended 400 response instead of
  allowing any error status to pass.
- Full integration follow-up: account-balance goals now use a fresh zero-balance manual
  account instead of assuming the heavily exercised seed checking account remains zero.
  The paycheck suite now creates its retirement destination with the command's canonical
  snake-case payload, replays the exact approved payload, and uses the Beta-only persona
  for its cross-household denial. This removed three false fixture failures without
  weakening the balance, approval-token, idempotency, or tenant-isolation assertions.
- Removed third-party screenshots and capture manifests from the current tree.
  Human checkpoint remains: public git history still contains previously committed
  sensitive and nonredistributable artifacts. Cleaning it requires coordinated
  history replacement and force-push; this agent did not rewrite history.
- Human checkpoint remains: the Terms and Privacy copy needs qualified legal review
  before a production launch. Plaid remains Sandbox-only.
- Human checkpoint remains: GitHub private vulnerability reporting is disabled. Public
  copy now says so; enable the repository setting and restore a confidential reporting
  route before accepting external users.
- Independent completion review: exposed the active entity lens on Budgets, preserved
  dashboard transaction/recurring read failures instead of rendering false empty states,
  added recovery-link validity and replacement-link states, prevented dashboard indexing,
  supplied route-specific social metadata, corrected local setup environment-file guidance,
  and narrowed export-format claims to what each serializer contains.
- Independent backend review: moved onboarding bootstrap to the least-privilege API owner
  without granting access to the Auth schema; the membership foreign key remains the
  authoritative user-existence check. Agent confidence is now explicitly unavailable
  (`null` plus a reason code) instead of a fabricated calibrated zero. Daily net worth
  ignores snapshots beyond the requested window, controlled receipt reversal permits equal
  transaction timestamps, the goal caller-id repair is safe to reapply, and notes/tasks now
  follow the export chain's current full-history semantics when `asOf` is only provenance.
- Frontend re-review: password changes now require a recovery event from Supabase rather
  than a user-writable browser marker. Budgets no longer expose or silently consume the
  entity lens until its complete read model can be scoped. Forecast failures are explicit
  and retryable. Crawlers can read private-route noindex metadata, dashboard social metadata
  is no longer inherited from the landing page, policy pages retain the shared social image,
  and local setup warns that database reset is destructive rather than a startup step.
- Codex review follow-up: dashboard account/balance load failures and the 30-day cash-flow
  card now expose real retry actions that restart their requests without requiring a reload
  or route change. The dashboard retry invalidates only the trial-balance query rather than
  refreshing unrelated mounted reads.

## 2026-08-18 chore(repo): privacy + open-source prep pass (Law 12; user directive 2026-08-18)

User ruling: prepare the repo for eventual open sourcing (not announced yet), delete the
committed real-account data, delete the old journal and FEEDBACK.md, add a stripped-down
open source kit. Keep `design/references/` and keep git history as-is for now.

Removed (all recoverable from private git history):

- `design/current/2026-07-16/` captures. Logged-in screenshots of the live app with real
  account data; the folder README forbade publication. Dated capture folders are now
  gitignored so future captures stay local.
- The four `keel-*` census records in `docs/harness/census/2026-07-16/` and the whole
  `docs/harness/plans/fragments-2026-07-16/` directory (tombstone README left). Both
  quoted the captures verbatim: real balances, account names, transaction strings, and
  the owner's email. Competitor census records stay; they describe competitor demo data.
  Known dangling citations: `docs/research/RECEIPTS-2026-07-16.md` cites
  LEDGERTRANSACTIONS-8, and `docs/PERSONA-FEEDBACK.md` links FEEDBACK.md.
- `FEEDBACK.md` (personal triage tracker) and the prior journal content of this file.
  Deviation note: CLAUDE.md requires a running NOTES.md, so the journal restarts here
  rather than disappearing; prior entries live in private history.
- `.debug/` scratch files.
- Redacted (not deleted) the real amounts and account strings in
  `design/COMPETITIVE-TEARDOWN-2026-07-16.md`: it is the referent of the standing queue
  in `design/TEARDOWN-STATUS-2026-07-17.md`, so the findings stay and only the figures
  went generic (marked inline).

Added:

- `LICENSE`: AGPL-3.0 (canonical SPDX text), plus `"license": "AGPL-3.0-only"` in the
  root package.json. Chosen because it is the reversible option for a solo copyright
  holder who also runs the hosted instance: it can be relaxed to Apache-2.0/MIT any time
  before outside contributions arrive, while the opposite move is impossible. Swap it
  before any public announcement if a different license is preferred.
- `CONTRIBUTING.md` (local-first dev setup mirroring CI: build:functions, supabase
  start, db reset) and `SECURITY.md` (private disclosure, hosted-instance scope rules).
- README reworked for an outside reader: local quickstart, generic deploy section, no
  hardcoded personal project ref. Operator-specific migration/deploy facts remain in
  CLAUDE.md and docs/17.

Known remaining pre-announcement work (deliberately deferred): personal domain is still
hardcoded in `apps/web/src/app/{layout.tsx,robots.ts,sitemap.ts}` and the JSON-LD on the
landing page; CLAUDE.md still carries operator-specific directives; `design/references/`
(competitor screenshots, not redistributable) and full git history must be excluded from
any public release; no seeded demo household yet; docs/research/NET-WORTH doc summarizes
a private forum thread and needs a call before publishing.
