/**
 * Debt payoff simulator (teardown runner-up, Class C preview-only — Law 10:
 * look-but-never-act, exactly like `keel_cash_flow_forecast`). Pure amortization
 * projection against a debt's CURRENT ledger balance (already a derived fact
 * elsewhere — `GoalRow.currentBalanceMinor` from `keel_list_goals`). Rate,
 * minimum payment, and extra payment are ephemeral scenario inputs the user
 * types fresh each time: nothing here is persisted, nothing here creates a
 * command, and no server round-trip is involved at all (Law 2 doesn't even
 * apply — there is no write to be suggest→approve gated).
 *
 * Rounding convention (Law 4 — BigInt minor units, no floats near money):
 * monthly interest is FLOORED, never rounded up — the same convention
 * `utilizationPercent` (credit-utilization.ts) uses for the fractional-cent/
 * fractional-percent problem. Flooring means the simulator never overstates
 * interest owed on any single month; across a full schedule this can
 * under-count true interest by at most ~1 minor unit per month versus a
 * penny-precise bank statement, which is the honest direction to err in a
 * preview, not a promise (Law 11 — this is presented as an estimate, never
 * an authoritative figure).
 */

export type AmortizationInput = {
  /** Current balance owed, in minor units. Must be > 0. */
  balanceMinor: bigint;
  /** Annual percentage rate in basis points (1% = 100 bps, so 19.99% = 1999). 0 is valid. */
  aprBps: number;
  /** Minimum monthly payment, in minor units. Must be > 0. */
  minPaymentMinor: bigint;
  /** Additional monthly payment on top of the minimum. Must be >= 0. Defaults to 0. */
  extraMinor?: bigint;
};

export type AmortizationResult = {
  /** Whole months to reach a zero balance. */
  months: number;
  /** Sum of all interest charged across the schedule, in minor units. */
  totalInterestMinor: bigint;
};

/** Basis-point/annual-to-monthly divisor: bps/10000 (percent) / 12 (months) = bps/120000. */
const BPS_MONTHLY_DIVISOR = 120_000n;

/** Horizon cap (50 years) so a payment too small to ever cover interest can't
 *  loop forever — that state is reported as unpayable, not iterated forever. */
const MAX_MONTHS = 600;

/**
 * Projects a fixed-payment amortization schedule to payoff.
 *
 * Returns null when the inputs can't produce a real schedule: a non-positive
 * balance or minimum payment, a negative rate or extra payment, or a payment
 * that never exceeds a month's interest on the starting balance (negative
 * amortization — the balance would never shrink). Also returns null if the
 * schedule would still be open after `MAX_MONTHS` (50 years) — reported as
 * "not payoff-able under these terms" rather than a runaway loop.
 */
export function simulatePayoff(input: AmortizationInput): AmortizationResult | null {
  const { balanceMinor, minPaymentMinor } = input;
  const extraMinor = input.extraMinor ?? 0n;
  const aprBps = input.aprBps;

  if (balanceMinor <= 0n) return null;
  if (minPaymentMinor <= 0n) return null;
  if (extraMinor < 0n) return null;
  // aprBps must already be a whole basis-point integer (parseAprBps produces
  // one) — rounding a rate here would be one Math.round hop from rounding
  // money (Law 4's own lint rule bans Math.round in financial code for that
  // reason), so a fractional/negative rate is refused rather than coerced.
  if (!Number.isInteger(aprBps) || aprBps < 0) return null;

  const aprBpsBig = BigInt(aprBps);
  const paymentMinor = minPaymentMinor + extraMinor;

  // Negative-amortization guard: if the payment can't even cover interest on
  // the STARTING (largest) balance, it never will as the balance only grows.
  const firstMonthInterest = (balanceMinor * aprBpsBig) / BPS_MONTHLY_DIVISOR;
  if (aprBpsBig > 0n && paymentMinor <= firstMonthInterest) return null;

  let balance = balanceMinor;
  let totalInterest = 0n;
  let months = 0;

  while (balance > 0n && months < MAX_MONTHS) {
    const interest = (balance * aprBpsBig) / BPS_MONTHLY_DIVISOR; // floor division (Law 4)
    const owedThisMonth = balance + interest;
    const payment = paymentMinor >= owedThisMonth ? owedThisMonth : paymentMinor;
    totalInterest += interest;
    balance = owedThisMonth - payment;
    months += 1;
  }

  if (balance > 0n) return null; // hit the horizon cap without reaching zero

  return { months, totalInterestMinor: totalInterest };
}

/**
 * Parses a user-typed APR percent string (e.g. "19.99") into integer basis
 * points, using the same string-split convention as `parseSignedDollars`
 * (hash.ts) rather than `parseFloat` — no floats anywhere near a rate that
 * feeds money math. Up to 2 decimal places (0.01% granularity). Negative or
 * unparseable input returns null.
 */
export function parseAprBps(input: string): number | null {
  const cleaned = input.trim();
  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(cleaned)) return null;
  const [whole = '0', frac = ''] = cleaned.split('.');
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2) || '0');
  return Number.isFinite(bps) ? bps : null;
}
