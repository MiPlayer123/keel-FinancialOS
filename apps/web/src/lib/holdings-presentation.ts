import { isCashManagementSubtype } from './investment-subtype';

/**
 * Per-account holdings presentation for the investments page (Item 2,
 * 2026-07-19 backlog): decides, deterministically and honestly, what to show
 * for an investment account's positions section.
 *
 *  - `positions`      — listed positions exist; `cashMinor` optionally carries
 *                       the cash/money-market remainder DERIVED from the
 *                       account balance (balance − listed positions value),
 *                       only when there is evidence the account actually holds
 *                       cash-equivalents (cash-management subtype or the last
 *                       sync skipped cash-equivalent rows) and the remainder
 *                       is positive in the account's own currency.
 *  - `cash_only`      — no listed positions, but the account is known to be
 *                       cash-equivalent (cash-management subtype, or every
 *                       provider-reported holding was skipped as
 *                       cash-equivalent — e.g. an all-SPAXX brokerage). The
 *                       balance IS the cash position.
 *  - `awaiting_provider` — connected account with no positions and no
 *                       cash-equivalent evidence: the institution has not
 *                       published investment data yet (OAuth brokerages
 *                       populate Investments asynchronously after linking).
 *  - `manual_empty`   — manual account with nothing added yet.
 *
 * Law 9: derived numbers are labeled derived; an unknown provider count is
 * treated as unknown (null), never as a fabricated zero.
 */
export type AccountHoldingsPresentation =
  | { kind: 'positions'; derivedCashMinor: string | null }
  | { kind: 'cash_only'; cashMinor: string }
  | { kind: 'awaiting_provider' }
  | { kind: 'manual_empty' };

export function presentAccountHoldings(input: {
  isManual: boolean;
  subtype: string;
  currency: string;
  /** Latest account balance in minor units (decimal string). */
  currentMinor: string;
  holdingsProviderCount: number | null;
  holdingsCashEquivalentCount: number | null;
  /** Sum of this account's LISTED positions in the account's currency
   *  (decimal string of minor units), or null when there are none. */
  positionsValueMinor: string | null;
}): AccountHoldingsPresentation {
  const cashSubtype = isCashManagementSubtype(input.subtype);
  const cashSkips = input.holdingsCashEquivalentCount ?? 0;
  const hasCashEvidence = cashSubtype || cashSkips > 0;

  if (input.positionsValueMinor !== null) {
    // Listed positions exist. Surface the cash remainder only with evidence
    // of cash-equivalents and a positive remainder (a stale balance snapshot
    // can lag the positions; never show negative "cash").
    if (!hasCashEvidence) return { kind: 'positions', derivedCashMinor: null };
    const remainder = BigInt(input.currentMinor || '0') - BigInt(input.positionsValueMinor || '0');
    return {
      kind: 'positions',
      derivedCashMinor: remainder > 0n ? remainder.toString() : null,
    };
  }

  if (hasCashEvidence) return { kind: 'cash_only', cashMinor: input.currentMinor || '0' };
  if (input.isManual) return { kind: 'manual_empty' };
  return { kind: 'awaiting_provider' };
}
