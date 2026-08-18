# KEEL build journal

Record every decision, deviation, failed approach, command run, test result, migration, and human checkpoint here. Never record credential values. Refer to secrets only by environment-variable name.

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
