# KEEL v2.1 Adoption Note — Delta Audit and Rulings (July 10, 2026)

## What v2.1 adds over v2 (all in §16, "Canonical backend plan")
1. **Thirteen canonical domain contracts** (identity/sharing, connections/ingestion, ledger/classification, recurring, paychecks, transfers/settlements, reconciliation/close, documents/receipts, notifications, AI/agents, investments, cards/offers, support/recovery) — each with a mandatory contract, what it unlocks, and a gate. This is the contract-level completion of the backend-gap work; **adopted as controlling for backend design.**
2. **Genuinely new depth beyond both prior plans:**
   - *Reimbursements as first-class settlements*: a Venmo/Zelle payment from a friend settles a claim against a shared expense — it is not income, and the original expense stays historically accurate while economic share reports correctly. Stronger than v1.1's IOU entries (adds counterparties, claims, employer/client reimbursements). Adopted.
   - *Paychecks as typed components with many-to-many destination matching*: one pay event → multiple cash deposits + 401(k) + HSA + ESPP + employer match + withholding, reconciling to gross and net. Stronger than v1.1's `lines jsonb`. Adopted.
   - *Dimensions as independent axes* (trip, project, property, client, person, tax context, reimbursable party) orthogonal to nested categories and entities. Upgrade over tags; adopted into schema plan.
   - *Recurring as expected-vs-actual occurrence model* (skips, pauses, cancellation, resumption, price changes, backtesting) rather than next-due-date. Adopted.
   - *Notifications as a domain* (delivery history, dedupe, quiet hours, escalations) and *typed AI response contract* (verdict/tldr/confidence/as_of/scope/reason_codes/evidence_refs/proposed_actions/requires_approval). Both adopted; AI contract appended to CLAUDE.md.
3. **Ten final implementation gates** — adopted as the acceptance layer above milestone tests.

## Light adversarial pass on v2.1 (four findings)
1. **Quiet concession on investments.** v2.1's canonical domains now include lots, corporate actions, portfolio cash, and completeness flags as *mandatory backend contracts* (gated by "unsupported precision is disabled when data is incomplete") while Appendix A still lists lots as deferred. That is exactly the v3 reconciliation position — schema now, module on earn-in — so the prior disagreement is resolved by convergence. Noted, no change needed.
2. **Contract completeness must not become implementation scope creep.** §16.6's "core financial foundation" reads broader (receipts, notifications, governed AI) than the Stage-1 spine list. Ruling: contracts are *designed* now (they're cheap and prevent rewrites); implementation still follows the stage gates. "Freeze the backend contracts" is softened to "stabilize with versioned amendment through Stage 1" — freezing before a single line of spine code or design-partner contact would sanctify guesses.
3. **Contracts are not DDL.** §16 specifies domains and obligations, not tables, keys, and migrations. The translation — canonical contracts → Postgres DDL + state-machine guards + property-test skeletons — is the remaining engineering-spec work and is agent-executable immediately.
4. **The company frame is still assumed.** v2.1, like v2, presumes Path B (design partners, staffing, kill criteria). The Path A (personal instrument) vs Path B (company) decision remains open and remains the founder's, not the auditors'.

## Audit-loop termination ruling
Three full adversarial passes have now converged: v1.2's self-audit, v2's external audit, v2.1's canonicalization, and the v3 reconciliation. Remaining disagreements are zero; remaining unknowns (live provider behavior, user trust, habit formation) are **not discoverable by further document review.** Further auditing is procrastination with good posture. The next information gain comes only from Stage 0 (humans touching the prototype) and Stage 1 (the spine surviving hostile fixtures).

## File corpus note
The v2.1 corpus introduces its own `15-KEEL-BACKEND-CANONICALIZATION-v2.1.md` and `16-KEEL-v2.1-CHANGELOG.md`, colliding with this archive's numbering (`15-KEEL-v3-RECONCILIATION.md`). Resolution: this archive renumbers nothing; v2.1's backend canonicalization is included in this configured corpus as `BC-v2.1.md`, and this note remains doc 16. When the repo is created, specs move to `docs/` with the precedence order in CLAUDE.md and filenames stop mattering.

## Spec precedence (final)
BC-v2.1 §16 (backend contracts & gates) > v3 Reconciliation (doc 15) > v2.1 report (product/stages/policy) > Addendum v1.1 (doc 13) > TECH-SPEC (doc 10) > BUILD-PLAN (doc 09). Research docs 00–08 and 12 are evidence, not authority.
