# Recurring Detection: False Positives — Findings & Recommendation

Read-only research, 2026-07-19. Trigger: cashback, paychecks, and irregular Venmo inflows
all surface as "recurring" though they aren't genuinely periodic. Owner wants "recurring" to
mean genuine subscriptions/bills. No code changed — this is a decision input.

## Part 1 — What KEEL does today

Pipeline: `keel_recurring_read_txns` → `detectRecurringSeries` (`packages/detectors/src/detect.ts`,
`DETECTOR_VERSION='recurring-grid-v1'`, deterministic/replayable) → suggest-only candidates →
post-hoc `keel_recurring_classification` buckets (income/bill/utility/subscription) → one Recurring page.

Candidate rule: group by `counterpartyKey | account | ledger | sign | currency`; a group with
**≥3** occurrences that can be draped over *some* cadence grid (weekly…annual) within a loose
per-cadence date tolerance (±1 to ±7 days) is surfaced. Scoring rewards coverage + fixed amounts
and penalizes residual, **but nothing filters on score**.

**Root cause of the false positives — four gaps:**
1. **No interval-regularity test.** Each transaction only needs *a* nearby grid slot; 3 points draped
   over 12 empty monthly slots still passes. Irregular spacing is not rejected.
2. **No minimum score/coverage floor.** Every ≥3 fit is emitted regardless of how sparse/low-quality.
3. **No income/subscription split at detection.** Inflows and outflows are detected identically;
   the income/subscription bucket is only a cosmetic post-hoc label on one shared page.
4. **No P2P/cashback/refund exclusion.** The normalizer doesn't strip Venmo payer names, "CASHBACK",
   "REWARD", "REFUND"; no counterparty deny-list or category exclusion.

| Symptom | Why it slips through |
|---|---|
| Cashback/rewards | Stable counterparty, inflow, ≥3×; irregular but snaps to nearby monthly slots; low score, no floor |
| Paychecks | Genuinely regular → correctly detected, but it's an **inflow** shown alongside subscriptions (taxonomy) |
| Random Venmo | Same payer counterparty, inflow, ≥3×, irregular dates; no spacing test, no P2P exclusion |

## Part 2 — Industry standard

Consistent pattern across Plaid Recurring Transactions API, Monarch, Copilot, Rocket Money, Mint, Emburse:
1. **Income is separated from subscriptions/bills — universally.** Plaid splits `inflow_streams`/`outflow_streams`;
   Copilot excludes income from "recurrings" entirely; nobody mixes paychecks into the subscription list.
2. **Regularity is a first-class test; non-fitting streams are labeled, not hidden as recurring.** Plaid
   assigns `frequency: UNKNOWN` rather than pretending. This is KEEL's biggest divergence.
3. **≥3 ("mature") is the shared threshold** — KEEL already matches.
4. **Amount tolerance is a band** (Plaid `average`+`last`; Copilot amount range) — KEEL only has fixed-vs-variable.
5. **Habitual spend + P2P + one-offs are actively excluded** (Plaid drops gas/groceries/coffee; P2P categorized).
6. **Suggest→approve everywhere** — KEEL already has this (Law 10 class B).

**Should KEEL just use Plaid's Recurring API?** No, not as source-of-truth: it's a paid black box that
isn't deterministic/replayable (violates Laws 1/9) and doesn't cover CSV/QIF/manual imports (Law 6).
Best used only as a calibration oracle to tune thresholds. Sources: plaid.com/blog/recurring-transactions,
plaid.com/docs/api/products/transactions, Monarch/Copilot/Rocket Money/Emburse help docs.

## Part 3 — Recommendation (prioritized)

Keep KEEL's deterministic grid detector (a Law); add the two things every competitor has and KEEL lacks —
an interval-regularity gate and an income/subscription split — plus targeted exclusions. All deterministic, suggest-only.

- **B (do first, fast, no migration):** Separate income/inflow series to the Paychecks page / a "Recurring Income"
  section; reserve "Subscriptions & Bills" for outflows. Presentation-layer only. Removes the most jarring symptom.
- **A (the real fix):** Add an interval-regularity + minimum-coverage/score gate in `packages/detectors`; bump
  `DETECTOR_VERSION` → `v2`; property tests (irregular Venmo/cashback must NOT fire; clean monthly Spotify must still fire).
  Kills random-Venmo and irregular cashback deterministically. Small-medium.
- **C (with A):** Deny-list personal P2P rails (Venmo/Zelle/Cash App/PayPal-personal) and exclude reward/refund/transfer
  PFC categories from the subscription path — as suggestion suppression, not deletion (Law 6). Small-medium.
- **D (later):** Feed amount-variance into confidence (not a hard gate — utilities vary). Small.
- **E (not recommended as primary):** Plaid Recurring API only as a calibration oracle / secondary signal, never
  source-of-truth (conflicts with deterministic/replayable Laws; ⚑ cost checkpoint).

**Recommended path: B → A → C → D**, with E as an optional oracle. Eliminates all three reported false positives.
