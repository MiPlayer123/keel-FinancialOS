# KEEL build journal

Record every decision, deviation, failed approach, command run, test result, migration, and human checkpoint here. Never record credential values. Refer to secrets only by environment-variable name.

## 2026-08-31 Balance snapshot compaction, phase 2 (built and tested; live apply is a ⚑)

`docs/BALANCE-SNAPSHOT-COMPACTION.md` §3 phase 2 + §4, shipped as
`supabase/migrations/20260831200000_balance_snapshot_compaction.sql`.
**Not applied to the live project.** It removes 186,810 production rows, and CLAUDE.md's
soft-delete directive requires a human say-so before any hard delete, so the apply waits
on the ⚑. Everything up to it is done and evidenced.

Shape: one `do` block, therefore one statement, therefore atomic however the caller wraps
it. Sequence is **archive → verify the archive → gate → remove → prove against the
before-image**, and every check is a `raise exception`, so any failure rolls back the
archive and the removal together.

The archive is the WHOLE table, into a new `keel_archive` schema with no grants — not the
survivor set. v1 of the proposal had it backwards (audit P0-1): the survivors are exactly
the rows that are *not* removed, so archiving them would have left the 186k rows being
destroyed with no copy anywhere. That is the `connection_credentials` shape that cost two
live Plaid Items, on the same Free-tier project with the same absence of PITR. It is
verified by row count and by an order-independent md5 over every column of every row
before anything is removed.

`keel_archive` rather than `public` because `supabase/tests/008_export.sql` requires every
`public` base table to be explicitly classified INCLUDE or EXCLUDE, and an operator
recovery artifact is neither household data nor an export omission to justify.

The last check is the one that actually protects the data, because it does not reference
the survivor predicate at all: for every row in the archived before-image, ask the
COMPACTED table what the value was at that row's instant and require the archived answer.
If the migration's predicate ever drifts from
`scripts/audit/balance-snapshot-compaction-gate.sql`, that check still fails closed.

Law 6 ruling recorded in the doc §5 (the audit flagged that v1 never gave one): the export
keeps every distinct observation and its first instant; `balance_last_observed_at` is
exported; the before-image is retained until a human says otherwise; and an `audit_log`
row per household records actor, both counts, archive relation and predicate in the same
transaction. What a user loses is the count of times a provider repeated a value it had
already reported — a property of our polling interval, not of their money.

Deviation from CLAUDE.md's soft-delete default, stated per the "deviations must cite the
spec line and why" rule: a status flag cannot work here. The whole cost being removed is
that `order by as_of desc` walks 186k rows; a soft-deleted row is still a row the index
walks, so a flag keeps 100% of the latency and 100% of the storage and adds a filter to
every consumer. The archive supplies the recoverability the directive exists to protect.

Verification, all run:

- The gate (`scripts/audit/balance-snapshot-compaction-gate.sql`, read-only) was validated
  BEFORE being pointed at production, by `scripts/run-balance-snapshot-gate-check.sh`: it
  is all-clear on a 25-row fixture built to hit every branch (plain runs, two sources on
  one account, a series of one, nulls, snapshot_metadata, a length-1 final run, an
  all-duplicate two-row series, and a run boundary only a NULL-safe comparison can see),
  and it trips on four deliberately broken predicates. A gate that cannot fail is worth
  nothing, and this one is what authorises removing the rows.
- Run against the live table: all seven checks 0. 186,943 rows, 133 survivors,
  186,810 removable, one household, one source.
- `scripts/run-balance-snapshot-compaction-pgtap.sh --mutate` loads the migration verbatim
  and proves: correct on good data (25 → 18, archive hash matches the pre-run hash, audit
  row says 25→18, step function preserved at all 25 original instants); re-runnable (a
  second apply is a notice, not a second archive); **atomic on abort** (an injected `as_of`
  tie leaves all 26 rows and no archive); and refuses all five broken predicates —
  newest-row rule dropped, snapshot_metadata dropped, `=` instead of `is not distinct
  from`, endpoints-only, and partitioning by account instead of by series — each rolling
  back to 25 rows with no archive.

Deferred deliberately: `VACUUM (FULL)` and `REINDEX` cannot run inside a transaction, so
they are documented at the top of the migration to run immediately after it commits. A
plain removal returns none of the 50 MB and the 27 MB of index bloats worst.

## 2026-08-31 Balance snapshot write amplification, phase 1 (stop writing repeats)

`docs/BALANCE-SNAPSHOT-COMPACTION.md` §3 phase 1, shipped as
`supabase/migrations/20260831190000_balance_snapshot_dedupe.sql` and applied to the live
project.

Measured problem: `keel-drain-sync` runs every 3 minutes and
`keel_apply_account_balance` wrote a `balance_snapshots` row per account per cycle
whether or not the balance moved. 186,943 rows across 16 snapshot-bearing accounts,
~50 MB, 26% of the database, +4,320 rows/day, 99.94% of them exact repeats of their
predecessor. `keel_latest_balances` and `keel_investments_overview` both do
`distinct on (account_id) ... order by as_of desc`, which has no index-skip scan, so
their cost is linear in snapshot count: EXPLAIN showed 186,889 rows and 87,233 buffers
scanned to return 10 rows in 2.06 s.

What shipped: the INSERT is now wrapped in a NULL-safe comparison against the newest row
of that account's `source='plaid'` series (`current_minor`, `available_minor`,
`limit_minor`, `currency`, `snapshot_metadata`), plus a new
`accounts.balance_last_observed_at` written every cycle regardless.

Three things the adversarial audit of the proposal changed, all of which would have been
defects if the obvious version had shipped:

1. **The guard wraps only the INSERT, not the function.** `keel_apply_account_balance`
   runs mask backfill -> snapshot insert -> `last_successful_sync_at` gate (returns) ->
   opening-balance-exists check (returns) -> book the anchor. An early `return` on
   "nothing changed" would strand the anchor permanently for any account linked while its
   balance is static: insert once, return early because the first sync had not completed,
   then return early forever because the value never moved. Two live accounts have gone
   43+ days without a value change, so this was reachable. pgTAP test 26 is exactly this
   sequence, and the `early_return` mutation proves the test catches it.
2. **Comparison is `is distinct from`, not `=`.** 149,481 of the live rows have a null
   `limit_minor` and 43,609 a null `available_minor`. Over the real table `=` identifies
   20.0% of rows as duplicates and `is not distinct from` identifies 99.94%; written with
   `=` this migration would have kept four fifths of the amplification.
3. **Freshness is preserved, not lost.** Once repeats stop being written, a snapshot's
   `as_of` means "when the value last CHANGED", so "unchanged since 18 July" and "not
   checked since 18 July" become indistinguishable. `balance_last_observed_at` carries the
   confirmation instant instead, backfilled from `max(as_of)` per account, so phase 1
   loses no information. It advances monotonically (`greatest(...)`) because the sync
   simulator emits delayed and out-of-order events by design.

Law 6: `balance_last_observed_at` was added to `packages/exports/src/manifest.ts` AND to
the column mirror in `supabase/tests/008_export.sql` in the same change. That mirror is
the drift test that broke #179's CI when only the TypeScript side was updated.

Testing: `tests/pgtap/balance_snapshot_dedupe.sql`, 39 assertions, run by
`scripts/run-balance-snapshot-dedupe-pgtap.sh` against a throwaway Postgres 16 cluster.
The runner loads the REAL prior function body sliced out of
`20260717220000_account_mask.sql` (verified byte-identical to the live `prosrc` modulo one
comment block: same 4,044 chars, same normalized md5), exercises the old
row-per-cycle behaviour and asserts it, then loads the whole migration verbatim and
asserts the new behaviour. `--mutate` breaks each of 12 guards in turn and requires the
suite to go red; all 12 are killed.

Two predicates are deliberately NOT mutation-tested because they are unkillable rather
than untested, and both are documented in the runner: the guard's
`bs.household_id = p_household_id` (accounts.id is a PK and balance_snapshots has a
composite FK on (household_id, account_id), so no snapshot can disagree with its account)
and `not v_found` (v_effective_currency is never null, so the first-ever observation
already inserts via the currency comparison). Both are kept for readability and
tenant-scoping convention.

Two bugs found in the harness itself while writing this:

- The re-runnability probe in both this runner and
  `scripts/run-business-entity-tag-pgtap.sh` rebuilt its prelude with `'\n'.join(...)`,
  which drops the trailing newline, so the last prelude line swallowed the first line of
  the next file. In the business-tag runner that silently degraded the "applies twice
  cleanly" check. Fixed in both.
- The first `freshness rewinds` mutation only rewrote the UPDATE's SET clause; the WHERE
  clause's own `greatest(...)` then blocked the rewind, so the mutation was DEFEATED
  rather than survived -- which reads identically to an untested guard in the output. The
  mutation now replaces both occurrences.

Nothing is deleted here. Compaction of the existing 186k rows is phase 2 and is
deliberately a separate change, sequenced archive-first per the audit.

## 2026-08-31 PR #179 merged, then broke in production: the deploy chain

The feature 404'd for the user immediately after merge. Not a code defect —
a deploy that silently did not happen.

Chain of events: #179 merged; `ci` ran on main and FAILED on
`tests/integration/02-commands.test.ts:49` (the first `/api/commands` call of
the suite, 404, 151/152 passing); `deploy-functions` is gated on
`workflow_run.conclusion == 'success'`, so it was SKIPPED; the api Edge Function
stayed on the pre-merge version with no `/tags/set-business` route. Meanwhile
the migration was already applied to the live project and Vercel had shipped the
new web app. Database and browser had moved; the API had not.

Recovered by re-running the failed job (the flake did not reproduce), which
re-fired `deploy-functions`; it deployed all four functions and `api` went
version 88 to 89 with a changed content hash. Verified against the functions
list rather than trusting the workflow.

Two fixes, because both failures were required for the outage:

1. **A skipped deploy is now a failed run, not a skipped one**
   (`deploy-functions.yml`). GitHub shows skipped runs quietly and nobody looks
   at them; main and production drifting apart is precisely the thing that must
   be loud. The new `guard` job fires when ci did not succeed and fails with the
   reason and the manual deploy command. It costs a red X on an already-red
   main, which is the point.

2. **CI warms the routes the suite actually calls** (`ci.yml`). There was
   already a warm-up for this exact flake, added after it hit main twice before
   (runs 29552336466 / 29553427394, both green on their PRs). It polls
   `/functions/v1/<fn>/health` for all four functions and treats any definitive
   non-404 as warm. That was not enough: run 33420152390 passed the /health
   warm-up and still 404'd on the first `/api/commands`. A liveness route can
   answer while the routing the tests use is still coming up, so the warm-up now
   also polls `api/commands` and `api/queries` with the same accept-set. Verified
   both directions against stub servers: 404s keep waiting and then fail the job,
   401s pass.

Process lessons, recorded because both were mine:
- Green CI on a PR is not green CI on main. They are separate runs, and on this
  repo the second one gates the function deploy. Merging on PR-green alone left
  a window where nothing had verified the merge commit.
- "Migration first, then frontend" is not the whole deploy ordering. The API
  layer deploys separately and was never checked; I asserted the ordering was
  fine while the middle tier had not shipped at all. Check every tier that
  deploys independently, not just the two that are easy to remember.

## 2026-08-31 Business attribution: second review round, and applied to the live project

Two more adversarial reviews (one re-reviewing the SQL with mutation testing, one
on the client and API). Both found real defects; all are fixed.

Blocking, from the SQL re-review:
- `keel_tag_assign` had no write-role gate. It has only ever checked MEMBERSHIP,
  which was defensible while it moved presentation labels around; this migration
  turned it into a business-attribution command and kept the weaker gate, so a
  read-only VIEWER could set and clear attribution through it while the front
  door refused them (Law 7, privileged side door). Now asserts write role on the
  business path; ordinary tagging is deliberately unchanged.
- Two business tags on one transaction were still reachable: `keel_tag_assign`
  read its guard on a snapshot and inserted without a lock, so two concurrent
  calls each saw "no business". It now takes the same row lock
  `keel_transaction_set_business` does, which also closes the mixed
  set_business-vs-tag_assign race and (separately) the adoption-vs-set_business
  race, by locking the rows adoption is about to re-attribute.
- The archived-entity door mismatch, same shape as the voided one fixed in the
  first round: `ensure` refuses an archived entity, `keel_tag_assign` did not.

Also: the adoption guard reported a false clash on VOIDED transactions, which was
unliftable because the front door refuses to clear a voided row; unbind now
records WHICH transactions it released, not just a count, because
unbind-then-delete is a two-call path around the delete guard and a count cannot
rebuild what the cascade destroyed.

**Test-suite honesty.** Mutation testing showed the previous round's claim that
"each fix has a test that fails without it" was wrong for three of six fixes:
reverting the lock, the concurrency early-return, and the coalesce'd before-image
all left 48/48 green. Worse, one assertion (G4) asserted the OPPOSITE of its own
comment and was a duplicate of G1, so nothing checked that adoption ever
SUCCEEDS — an over-broad guard refusing every adoption passed the suite. The
suite is now 62 assertions and every guard was mutation-tested individually: each
one, when removed, fails the suite. Two more assertions were found to be passing
for the wrong reason (the archived guard was firing the ambiguity guard; the
voided guard was firing the ambiguity guard) and were given isolated fixtures.
Still NOT covered, and single-session pgTAP cannot cover it: concurrency. The
locks were verified by the reviewing agent with two live sessions.

From the client review: two write lanes shared one pending-write slot, so closing
the dialog could refetch before a business write landed and leave the register
showing the row as personal; `businessBusy` was not reset on row switch and its
failure toast was not keyed to the transaction it was for; the tag manager still
offered Delete on business tags with the DB's helpful refusal swallowed by
`mapDbError` into "Invalid command."; a `tags.list` failure silently emptied
attribution while the facet kept claiming to filter on it; the badge was
`shrink-0` with no truncate and would take the whole row at 390px for a real
legal name (the earlier UI check used short fixture names and missed it); and the
account register did not pass `businessNames`, so the same transaction showed a
badge on one screen and a #chip on the other.

The tag manager now offers **Unbind** instead of Delete for a business tag, which
gives `keel_entity_business_tag_unbind` its first UI caller and makes the
reversible correction reachable without hand SQL (Law 2). The multi-business
picker is now a real `radiogroup` rather than a row of `aria-pressed` toggles,
and a business the entity list does not contain renders as "Other business"
rather than as an unselected chip — in the single-business shape that had read as
OFF, so one click would have silently re-attributed the row.

Known, deliberately not fixed here: `keel_tag_assign` still has only a membership
gate for ORDINARY tags (pre-existing since 20260713120000; tightening it is a
behaviour change outside this slice). `packages/exports` still has no
schema-to-manifest drift test, which is how the export gap survived. The entity
lens and the Business facet still intersect rather than compose — disclosed in
the UI, properly resolved by S3's authorization compiler.

**Applied to the live project** (`yrbteeownwjhcushwaga`) via the Supabase MCP, per
the CLAUDE.md directive that migrations go straight to the cloud project. Before
applying, the live definitions of the three recreated functions were diffed
against 20260713120000 to confirm no production drift. Behaviour was then verified
ON the live schema, roles and data by running the assertions inside a block that
ends in a deliberate RAISE, so the whole transaction aborts: 12 assertions on the
first pass (including multi-business paths, using a fictional second entity
created inside the aborting transaction) and 6 on the review fixes, all passing,
with tags/transaction_tags/audit counts confirmed unchanged afterward. The write
path is read-only through `execute_sql`, so this abort-on-purpose pattern is the
only way to exercise writes against production without leaving data behind.

## 2026-08-31 Business expense attribution, layer 1 (S1 + S2)

Built the entity-bound business tag from `docs/BUSINESS-EXPENSE-RESEARCH.md` §4
(build plan T2.3). A business entity owns one tag; putting that tag on a
transaction attributes it to that business no matter which account paid, so a
personal-card purchase can be counted in the LLC's books. Classification only:
no postings, no money moved. Whether the business owes the payer back stays
layer 2 (research doc §5).

- Migration `20260831120000_business_entity_tag.sql`: `tags.entity_id` with a
  partial unique index, `keel_entity_business_tag_ensure` (idempotent bind,
  adopting an existing unbound tag of the same name),
  `keel_entity_business_tag_unbind`, `keel_transaction_set_business`, guards on
  `keel_tag_assign` (one business per transaction, none on a voided row) and
  `keel_tag_delete` (a business tag must be unbound first), and `entityId` on
  `keel_list_tags`.
- Deliberately did NOT widen `keel_list_transactions_rich` / `_rich_page`: every
  row already carries its tags, so the client derives attribution from
  (row.tags x tags.list). Those two are the largest and most-recreated read
  models in the schema and recreating both was the main risk in the slice.
  Server-side entity scope (accounts owned by the entity UNION transactions
  carrying its business tag) belongs in the one authorization compiler and is
  slice S3, not this one.
- Deviation, recorded per CLAUDE.md: the two new definer procs are NOT handed to
  `keel_api` the way `keel_create_entity`/`keel_list_entities` are. `keel_api`
  holds no grant and no RLS policy on `public.tags` (20260713120000 predates the
  `definer_all` policy loop), so the handoff would break them. They stay owned by
  the migration role like every other proc in that file. A follow-up that adds
  the grants and policies first could move them.

Review found and fixed (adversarial subagent, reproduced against a throwaway
Postgres): `tags.entity_id` was dropped from `admin.export_all` because
`packages/exports` enumerates columns explicitly and projects strictly onto that
list (Law 6 — the migration's header comment had claimed the opposite, reasoning
from the SQL-side `keel_export_household`, which is not the surface that serves
the export); tag adoption was a bulk back door into the two-business ambiguity
the design refuses; `ensure` raised a false error when a concurrent call had
already bound the same entity; concurrent `set_business` left two tags; the clear
audit recorded only the first attribution removed; and a bound tag could be
neither unbound nor deleted, making a wrong bind repairable only by hand SQL.
Correction (CI caught it): the drift check the manifest's comment refers to DOES
exist, at the SQL layer — `supabase/tests/008_export.sql` test 13 keeps its own
allow/omit list per exported table and fails when any live column is on neither.
It failed on this branch because `tags.entity_id` was added to
`packages/exports/src/manifest.ts` but not to that mirror. So the earlier claim
here that "no drift test exists" was wrong. The real gap is narrower: nothing
verifies that the pgTAP mirror and `manifest.ts` agree with EACH OTHER, so
listing a column in one and forgetting the other still ships a silently
truncated export. A cross-check between the two is worth building; not built
here.

Testing, and its limits. No Docker daemon and no Supabase CLI in this
environment, so the local stack could not run.
- `tests/pgtap/business_entity_tag.sql`, 48 assertions, EXECUTED against a real
  Postgres 16 via `scripts/run-business-entity-tag-pgtap.sh`, which loads the
  whole migration file verbatim plus `keel_assert_member_write` sliced from
  20260710210600 — the shipped SQL, not a paraphrase. The runner also applies
  the migration twice against a scratch database and fails if the second apply
  errors, since migrations go to the live project by hand with no
  migration-history table.
- `apps/web/src/lib/business-tags.test.ts`, 22 unit tests, executed.
- `tests/integration/46-business-entity-tag.test.ts` written in house style but
  NOT executed (needs the stack).
- UI verified by server-rendering the real components with the built Tailwind
  CSS and screenshotting in Chromium: 0 elements overflowing a 390px box,
  scrollWidth exactly 390 (Law 8). The repo has no component-test tooling and
  `apps/web/vitest.config.ts` deliberately excludes jsdom tests, so this was a
  throwaway harness in the scratchpad rather than a committed suite.
- Concurrency fixes (the `for update` serialization and the bind race) are NOT
  covered by the suite: the pgTAP harness is single-session. They were verified
  by the reviewing agent with two concurrent sessions.

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
