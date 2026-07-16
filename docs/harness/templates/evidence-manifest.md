# Evidence manifest — `<drop-id>`

<!--
The manifest is the conservation spine of a drop: every evidence unit listed
here must end up with exactly one census record and, after synthesis, exactly
one disposition. Append-only — never delete rows; mark them instead.

Drop layout: docs/harness/evidence/<drop-id>/ holds this manifest plus the raw
evidence (screenshots, saved pages, notes). Raw evidence is immutable — it is
the audit trail. File naming for screenshots:
  <source-app>/<flow>/<NN>-<screen>.png   e.g. monarch/recurring/03-pause-confirm.png
-->

- **Drop id:** `<drop-id>` (e.g. `2026-07-screens-01`)
- **Adapter:** `screenshots | docs | spec-delta | feedback`
- **Captured by / date:**
- **Sources:** app + version/date observed (e.g. Copilot iOS 2026-07, Monarch web 2026-07)

## Units

| ID | Source app | Flow | File(s) / ref | Notes | Census record |
|----|-----------|------|---------------|-------|---------------|
| E-001 | monarch | recurring | monarch/recurring/01-list.png | | census/<drop-id>/E-001.md |
| E-002 | monarch | recurring | monarch/recurring/02..04 (sequence) | pause flow | |

<!--
Rules:
- A multi-screenshot flow SEQUENCE is one unit (one record) — sequences teach
  more than single screens.
- Capture empty states, error states, confirm dialogs, settings/admin pages,
  and mobile widths; these carry the business rules and edge cases.
- IDs are stable and never reused. Withdrawn units are struck through with a
  reason, not deleted.
-->
