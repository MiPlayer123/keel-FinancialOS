---
name: harness-census
description: Run the evidence census over a drop in docs/harness/evidence/<drop-id>/ — fan out one agent per manifest unit to produce structured census records. Use when a new evidence drop (screenshots, docs corpus, spec delta) lands. Args: <drop-id>.
---

# Harness census

Turn a raw evidence drop into structured census records — one per manifest
unit. Read `docs/harness/README.md` first; the conservation rule governs
everything here.

## Steps

1. **Manifest.** Read `docs/harness/evidence/<drop-id>/manifest.md`. If it
   does not exist, build it from the drop's files using
   `docs/harness/templates/evidence-manifest.md` (group flow sequences into
   single units), then STOP and surface the manifest for a quick human skim
   before walking it — manifest review is cheap, census rework is not.
2. **Fan out — one agent per unit.** Use the Workflow tool (this is a
   coverage-critical fan-out; never process a 100+-unit drop serially in one
   context, and never sample). Each subagent:
   - reads ONLY its unit's evidence files (screenshots via Read — they are
     images) plus `docs/harness/templates/census-record.md`;
   - writes `docs/harness/census/<drop-id>/<unit-id>.md` following the
     template exactly;
   - records only what is observable. No invention, no judgment about what
     KEEL should do — that is synthesis's job.
3. **Conservation check.** Units in manifest == record files on disk, and
   every record file maps to a manifest row. Fix gaps by re-running only the
   missing units.
4. **Update the manifest** — fill the "Census record" column.
5. **Result.** Report: units processed, records written, units that had
   unreadable/ambiguous evidence (list them — do not guess). Unresolved
   problems go to NOTES.md as I-numbered entries.

## Rules

- Raw evidence is immutable. Never rename, edit, or delete files in
  `evidence/`.
- A record you cannot ground in the evidence is a defect. "Open questions" is
  the correct place for uncertainty.
- Exhaustive coverage is mandatory: N units in, N records out. A partial
  census is a FAIL, not a draft.
