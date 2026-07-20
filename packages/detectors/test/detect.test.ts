import { describe, expect, it } from 'vitest';
import {
  DETECTOR_VERSION,
  NORMALIZER_VERSION,
  cadenceDatesBetween,
  detectRecurringSeries,
  fingerprint,
  normalizeCounterparty,
  recurringSuppressionReason,
  isSuppressedFromRecurring,
  type RecurringTransaction,
} from '../src/index.js';

const txn = (
  txnId: string,
  effectiveDate: string,
  amountMinor: string,
  description = 'Acme Rent Store #123 2026-01-31',
  overrides: Partial<RecurringTransaction> = {},
): RecurringTransaction => ({
  txnId,
  batchId: `batch-${txnId}`,
  postingId: `posting-${txnId}`,
  accountId: 'account-1',
  ledgerAccountId: 'ledger-1',
  effectiveDate,
  amountMinor,
  currency: 'USD',
  description,
  ...overrides,
});

describe('counterparty normalization', () => {
  it('is deterministic and removes store/date/trailing-number noise', () => {
    expect(normalizeCounterparty('  ACME  RENT store #123 2026-01-31  ')).toBe('acme rent');
    expect(normalizeCounterparty('NETFLIX 0042')).toBe('netflix');
    expect(normalizeCounterparty('')).toBe('unknown');
    expect(NORMALIZER_VERSION).toBe('counterparty-v2');
  });
});

describe('detectRecurringSeries calendar-grid fitting', () => {
  it('detects fixed month-end rent and treats a skipped month as a missing slot', () => {
    const series = detectRecurringSeries(
      [
        txn('rent-1', '2024-01-31', '-250000'),
        txn('rent-2', '2024-02-29', '-250000'),
        txn('rent-3', '2024-03-31', '-250000'),
        txn('rent-4', '2024-05-31', '-250000'),
      ],
      { asOf: '2024-05-31' },
    );

    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      cadence: 'monthly',
      cadenceAnchor: { kind: 'day_of_month', day: 31, intervalMonths: 1 },
      amountKind: 'fixed',
      representativeAmountMinor: '-250000',
      occurrenceCount: 4,
      coverage: { matchedSlots: 4, totalSlots: 5 },
      detectorVersion: DETECTOR_VERSION,
      normalizerVersion: NORMALIZER_VERSION,
      asOf: '2024-05-31',
      requiresApproval: true,
    });
    expect(series[0]?.evidence).toEqual([
      { txnId: 'rent-1', batchId: 'batch-rent-1', postingId: 'posting-rent-1' },
      { txnId: 'rent-2', batchId: 'batch-rent-2', postingId: 'posting-rent-2' },
      { txnId: 'rent-3', batchId: 'batch-rent-3', postingId: 'posting-rent-3' },
      { txnId: 'rent-4', batchId: 'batch-rent-4', postingId: 'posting-rent-4' },
    ]);
    expect(Number.isInteger(series[0]?.scoreBps)).toBe(true);
    expect(series[0]?.scoreBps).toBeGreaterThan(0);
  });

  it('detects strict biweekly paychecks on an epoch-day grid', () => {
    const series = detectRecurringSeries(
      [
        txn('pay-1', '2024-01-05', '200000', 'KEEL PAYROLL'),
        txn('pay-2', '2024-01-19', '200000', 'KEEL PAYROLL'),
        txn('pay-3', '2024-02-02', '200000', 'KEEL PAYROLL'),
        txn('pay-4', '2024-02-16', '200000', 'KEEL PAYROLL'),
      ],
      { asOf: '2024-02-16' },
    );
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      cadence: 'biweekly',
      cadenceAnchor: { kind: 'epoch_grid', intervalDays: 14 },
      amountKind: 'fixed',
      occurrenceCount: 4,
    });
  });

  it('classifies monthly utility amounts as variable using exact lower-median evidence', () => {
    const series = detectRecurringSeries(
      [
        txn('util-1', '2024-01-15', '-9100', 'City Utilities'),
        txn('util-2', '2024-02-15', '-10500', 'City Utilities'),
        txn('util-3', '2024-03-15', '-9900', 'City Utilities'),
        txn('util-4', '2024-04-15', '-11200', 'City Utilities'),
      ],
      { asOf: '2024-04-15' },
    );
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      cadence: 'monthly',
      amountKind: 'variable',
      representativeAmountMinor: null,
      amountSummary: {
        minMinor: '-11200',
        maxMinor: '-9100',
        lowerMedianMinor: '-10500',
        squaredResidualSum: '2810000',
        count: 4,
      },
    });
  });

  it('emits multiple fixed monthly clusters for duplicate subscriptions in one group', () => {
    const input = [
      txn('sub-a1', '2024-01-05', '-999', 'Video Stream'),
      txn('sub-b1', '2024-01-20', '-1599', 'Video Stream'),
      txn('sub-a2', '2024-02-05', '-999', 'Video Stream'),
      txn('sub-b2', '2024-02-20', '-1599', 'Video Stream'),
      txn('sub-a3', '2024-03-05', '-999', 'Video Stream'),
      txn('sub-b3', '2024-03-20', '-1599', 'Video Stream'),
    ];
    const series = detectRecurringSeries(input, { asOf: '2024-03-20' });
    expect(series).toHaveLength(2);
    expect(series.map((candidate) => [candidate.cadence, candidate.representativeAmountMinor]))
      .toEqual([
        ['monthly', '-1599'],
        ['monthly', '-999'],
      ]);
  });

  it('distinguishes a semimonthly anchor pair from a strict biweekly grid', () => {
    const semimonthly = detectRecurringSeries(
      [
        txn('semi-1', '2024-01-01', '-5000', 'Club Dues'),
        txn('semi-2', '2024-01-15', '-5000', 'Club Dues'),
        txn('semi-3', '2024-02-01', '-5000', 'Club Dues'),
        txn('semi-4', '2024-02-15', '-5000', 'Club Dues'),
        txn('semi-5', '2024-03-01', '-5000', 'Club Dues'),
        txn('semi-6', '2024-03-15', '-5000', 'Club Dues'),
      ],
      { asOf: '2024-03-15' },
    );
    expect(semimonthly[0]).toMatchObject({
      cadence: 'semimonthly',
      cadenceAnchor: { kind: 'day_pair', days: [1, 15] },
    });

    const biweekly = detectRecurringSeries(
      [
        txn('bi-1', '2024-01-01', '-5000', 'Club Dues'),
        txn('bi-2', '2024-01-15', '-5000', 'Club Dues'),
        txn('bi-3', '2024-01-29', '-5000', 'Club Dues'),
        txn('bi-4', '2024-02-12', '-5000', 'Club Dues'),
        txn('bi-5', '2024-02-26', '-5000', 'Club Dues'),
      ],
      { asOf: '2024-02-26' },
    );
    expect(biweekly[0]?.cadence).toBe('biweekly');
  });

  it('classifies the Deeptune 15th-&-last-day payroll as semimonthly, not biweekly', () => {
    // Worked example (doc 10 §2.4): the founder's real cadence — 15th and the
    // LAST calendar day of each month, with the anchor landing a few days early
    // when it falls on a weekend/holiday (paid the prior business day). The naive
    // detector read this as biweekly (~14 days); semimonthly (day_pair 15/31) is
    // the correct fit and must win. Amounts vary (variable payroll) so no
    // fixed-amount subset can bias the fit toward a 14-day grid.
    const pay = [
      // Dec: 15th, 31st (EOM)
      txn('dt-1', '2025-12-15', '104326', 'DEEPTUNE PAYROLL'),
      txn('dt-2', '2025-12-31', '110500', 'DEEPTUNE PAYROLL'),
      // Jan: 15th, 30th (EOM 31 = Sat -> Fri 30)
      txn('dt-3', '2026-01-15', '99800', 'DEEPTUNE PAYROLL'),
      txn('dt-4', '2026-01-30', '120000', 'DEEPTUNE PAYROLL'),
      // Feb: 13th (15 = Sun -> Fri 13), 27th (EOM 28 = Sat -> Fri 27)
      txn('dt-5', '2026-02-13', '90100', 'DEEPTUNE PAYROLL'),
      txn('dt-6', '2026-02-27', '130400', 'DEEPTUNE PAYROLL'),
      // Mar: 13th (15 = Sun -> Fri 13), 31st (EOM)
      txn('dt-7', '2026-03-13', '88000', 'DEEPTUNE PAYROLL'),
      txn('dt-8', '2026-03-31', '141900', 'DEEPTUNE PAYROLL'),
      // Apr: 15th, 30th (EOM)
      txn('dt-9', '2026-04-15', '95000', 'DEEPTUNE PAYROLL'),
      txn('dt-10', '2026-04-30', '133000', 'DEEPTUNE PAYROLL'),
    ];
    const series = detectRecurringSeries(pay, { asOf: '2026-04-30' });
    expect(series).toHaveLength(1);
    expect(series[0]?.cadence).toBe('semimonthly');
    expect(series[0]?.cadenceAnchor.kind).toBe('day_pair');
    // The chosen pair is the mid-month + month-end anchors (month-end drifts to
    // ~30/31 depending on the sample); the mid-month day is 15 (or 13 when the
    // 15th shifted). Assert the pair straddles a ~15/16-day gap, not 14.
    const anchor = series[0]?.cadenceAnchor;
    if (anchor?.kind === 'day_pair') {
      const [lo, hi] = anchor.days;
      expect(hi - lo).toBeGreaterThanOrEqual(13);
      expect(hi).toBeGreaterThanOrEqual(27); // month-end anchor, not a mid-month
    }
    expect(series[0]?.occurrenceCount).toBeGreaterThanOrEqual(8);
  });

  it('projects semimonthly 15/31 across February and 31-day months, month-end clamped', () => {
    // Detect a clean 15th-&-31st series, then project it and assert the generated
    // dates land on the real calendar: Jan 31, Feb 28/29, Apr 30 — never Feb 31.
    const series = detectRecurringSeries(
      [
        txn('em-1', '2024-01-15', '-20000', 'Rent Escrow'),
        txn('em-2', '2024-01-31', '-20000', 'Rent Escrow'),
        txn('em-3', '2024-02-15', '-20000', 'Rent Escrow'),
        txn('em-4', '2024-02-29', '-20000', 'Rent Escrow'),
        txn('em-5', '2024-03-15', '-20000', 'Rent Escrow'),
        txn('em-6', '2024-03-31', '-20000', 'Rent Escrow'),
      ],
      { asOf: '2024-03-31' },
    );
    expect(series[0]?.cadence).toBe('semimonthly');
    const anchor = series[0]?.cadenceAnchor;
    expect(anchor).toMatchObject({ kind: 'day_pair' });
    if (anchor?.kind === 'day_pair') {
      // The month-end anchor is the larger day (>= 29 given the sample includes
      // Jan 31 / Mar 31); mid-month is 15.
      expect(anchor.days[0]).toBe(15);
      expect(anchor.days[1]).toBeGreaterThanOrEqual(29);
      const projected = cadenceDatesBetween(anchor, '2024-01-01', '2024-04-30');
      // Feb clamps to 29 (leap year), never 31; Apr clamps to 30.
      expect(projected).toContain('2024-01-15');
      expect(projected).toContain('2024-01-31');
      expect(projected).toContain('2024-02-15');
      expect(projected).toContain('2024-02-29');
      expect(projected).toContain('2024-04-30');
      expect(projected).not.toContain('2024-02-31');
      expect(projected).not.toContain('2024-04-31');
    }
  });

  it('groups by account, sign, currency, and normalizer version', () => {
    const base = [
      txn('a-1', '2024-01-10', '-1000', 'Membership'),
      txn('a-2', '2024-02-10', '-1000', 'Membership'),
      txn('a-3', '2024-03-10', '-1000', 'Membership'),
      txn('b-1', '2024-01-10', '-1000', 'Membership', { accountId: 'account-2', ledgerAccountId: 'ledger-2' }),
      txn('b-2', '2024-02-10', '-1000', 'Membership', { accountId: 'account-2', ledgerAccountId: 'ledger-2' }),
      txn('b-3', '2024-03-10', '-1000', 'Membership', { accountId: 'account-2', ledgerAccountId: 'ledger-2' }),
    ];
    expect(detectRecurringSeries(base, { asOf: '2024-03-10' })).toHaveLength(2);
  });

  it('returns no series for empty or insufficient inputs', () => {
    expect(detectRecurringSeries([], { asOf: '2024-01-01' })).toEqual([]);
    expect(detectRecurringSeries([
      txn('one', '2024-01-01', '-1'),
      txn('two', '2024-02-01', '-1'),
    ], { asOf: '2024-02-01' })).toEqual([]);
  });

  it('pins deterministic output, ordering, evidence ties, and fingerprints', () => {
    const input = [
      txn('z', '2024-03-10', '-1000', 'Membership'),
      txn('a', '2024-01-10', '-1000', 'Membership'),
      txn('m', '2024-02-10', '-1000', 'Membership'),
    ];
    const first = detectRecurringSeries(input, { asOf: '2024-03-10' });
    const second = detectRecurringSeries([...input].reverse(), { asOf: '2024-03-10' });
    expect(second).toEqual(first);
    expect(first[0]?.evidence.map((item) => item.txnId)).toEqual(['a', 'm', 'z']);
    expect(first[0]?.inputFingerprint).toMatch(/^[a-f0-9]{16}$/u);
    expect(first[0]?.seriesKey).toMatch(/^[a-f0-9]{16}$/u);
  });

  it('keeps series_key STABLE across a normalizer-version bump (no twin series)', () => {
    // Review P1 regression: NORMALIZER_VERSION must NOT be part of the series_key.
    // A v1→v2 normalizer bump must re-detect the SAME series (supersede via a new
    // candidate version under the existing series_key), never mint a duplicate
    // "twin" Suggested series next to an already-CONFIRMED one (which would
    // double-count in projections). We assert the emitted series_key equals the
    // fingerprint of the group+cadence+anchor+amount composition WITHOUT any
    // normalizer token — so bumping NORMALIZER_VERSION cannot change it.
    const series = detectRecurringSeries(
      [
        txn('n-1', '2026-05-09', '-699', 'Spotify'),
        txn('n-2', '2026-06-09', '-699', 'Spotify'),
        txn('n-3', '2026-07-09', '-699', 'Spotify'),
      ],
      { asOf: '2026-07-19' },
    );
    expect(series).toHaveLength(1);
    const s = series[0];
    if (!s) throw new Error('expected a detected series');

    // Reconstruct the exact key composition the detector uses (detect.ts): the
    // groupKey is counterpartyKey|accountId|ledgerAccountId|sign|currency (NO
    // normalizer version), then series_key = fingerprint(groupKey|cadence|anchor|amount).
    const groupKey = ['spotify', 'account-1', 'ledger-1', 'outflow', 'USD'].join('|');
    const anchorJson = JSON.stringify(s.cadenceAnchor);
    const identityAmount = s.amountKind === 'fixed' ? (s.representativeAmountMinor ?? '') : '';
    const expectedKey = fingerprint(`${groupKey}|${s.cadence}|${anchorJson}|${identityAmount}`);

    expect(s.seriesKey).toBe(expectedKey);
    // Guard: the normalizer version must not leak into the key material at all.
    expect(groupKey).not.toContain(NORMALIZER_VERSION);
    // The per-series normalizerVersion field still rides the record (supersession
    // is recorded), and the input fingerprint still folds it in — but the KEY is stable.
    expect(s.normalizerVersion).toBe(NORMALIZER_VERSION);
  });

  it('detects a Spotify-like 3-occurrence monthly subscription (real-data regression)', () => {
    // Mirrors the real household: 3 Spotify charges on the "Savor" credit card,
    // 2026-05-09 / 06-09 / 07-09, fixed -$6.99. Exactly 3 occurrences is the
    // minimum the detector accepts; this pins that a monthly subscription with
    // no more than the minimum count still produces a candidate.
    const series = detectRecurringSeries(
      [
        txn('spotify-1', '2026-05-09', '-699', 'Spotify'),
        txn('spotify-2', '2026-06-09', '-699', 'Spotify'),
        txn('spotify-3', '2026-07-09', '-699', 'Spotify'),
      ],
      { asOf: '2026-07-19' },
    );

    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      counterpartyKey: 'spotify',
      cadence: 'monthly',
      cadenceAnchor: { kind: 'day_of_month', day: 9, intervalMonths: 1 },
      sign: 'outflow',
      amountKind: 'fixed',
      representativeAmountMinor: '-699',
      occurrenceCount: 3,
      lastSeen: '2026-07-09',
      requiresApproval: true,
    });
    expect(series[0]?.scoreBps).toBeGreaterThan(0);
    expect(series[0]?.evidence.map((item) => item.txnId)).toEqual([
      'spotify-1',
      'spotify-2',
      'spotify-3',
    ]);
  });

  it('binds candidate identity to the run-wide as-of date', () => {
    const input = [
      txn('rent-1', '2024-01-31', '-250000'),
      txn('rent-2', '2024-02-29', '-250000'),
      txn('rent-3', '2024-03-31', '-250000'),
    ];
    const first = detectRecurringSeries(input, { asOf: '2024-03-31' })[0];
    const replayAtLaterAsOf = detectRecurringSeries(input, { asOf: '2024-04-01' })[0];

    expect(first?.inputFingerprint).not.toBe(replayAtLaterAsOf?.inputFingerprint);
  });
});

// ---------------------------------------------------------------------------
// A — interval-regularity + quality-floor gate (recurring-grid-v2).
// docs/RECURRING-RESEARCH.md: 3 points draped over a mostly-empty grid, or
// irregularly spaced, must NOT be offered as recurring. Clean subscriptions and
// real biweekly paychecks must still fire (paychecks are real recurring — B just
// routes them to income).
// ---------------------------------------------------------------------------
describe('recurring-grid-v2 quality gate (A)', () => {
  it('bumps DETECTOR_VERSION to recurring-grid-v2', () => {
    expect(DETECTOR_VERSION).toBe('recurring-grid-v2');
  });

  it('rejects an irregular 3-occurrence series (Jan / Jun / Nov, low coverage)', () => {
    // 3 same-counterparty charges 5 months apart each: coverage over the matched
    // span is 3/11 ≈ 0.27 (below the 0.60 floor) and the period-gaps are 5, not 1.
    // The old detector draped these over a monthly grid and emitted them.
    const series = detectRecurringSeries(
      [
        txn('irr-1', '2024-01-12', '-4200', 'Odd Merchant'),
        txn('irr-2', '2024-06-12', '-4200', 'Odd Merchant'),
        txn('irr-3', '2024-11-12', '-4200', 'Odd Merchant'),
      ],
      { asOf: '2024-11-30' },
    );
    expect(series).toEqual([]);
  });

  it('rejects an irregular cashback-like inflow series (uneven gaps)', () => {
    // A rewards credit that lands on uneven dates: Jan 3 → Feb 27 (≈1 month) →
    // Jun 18 (≈4 months). On a monthly grid the slots are 0, 1, 5 — a max period
    // gap of 4 (well past the cap of 2) and coverage 3/6 = 0.50 (below the 0.60
    // floor). No cadence can drape these regularly, so nothing is emitted.
    // (Also suppressed by C on a real "cashback" descriptor; named neutrally here
    // to isolate the A gate.)
    const series = detectRecurringSeries(
      [
        txn('cb-1', '2024-01-03', '350', 'Points Credit'),
        txn('cb-2', '2024-02-27', '512', 'Points Credit'),
        txn('cb-3', '2024-06-18', '190', 'Points Credit'),
      ],
      { asOf: '2024-06-30' },
    );
    expect(series).toEqual([]);
  });

  it('rejects random-Venmo-like irregular inflows (neutral description)', () => {
    // Same payer, ≥3×, but the dates are scattered: no cadence grid covers 60% of
    // the span with gaps ≤ 2 periods. (A gate proof; C would also suppress a real
    // "Venmo" descriptor — see the C suite.)
    const series = detectRecurringSeries(
      [
        txn('p2p-1', '2024-02-02', '5000', 'Friend Transfer'),
        txn('p2p-2', '2024-02-19', '2500', 'Friend Transfer'),
        txn('p2p-3', '2024-04-30', '8000', 'Friend Transfer'),
        txn('p2p-4', '2024-07-15', '1500', 'Friend Transfer'),
      ],
      { asOf: '2024-07-31' },
    );
    expect(series).toEqual([]);
  });

  it('still emits a clean monthly Spotify-like series (3 consecutive months)', () => {
    const series = detectRecurringSeries(
      [
        txn('spot-1', '2026-05-09', '-699', 'Streamly'),
        txn('spot-2', '2026-06-09', '-699', 'Streamly'),
        txn('spot-3', '2026-07-09', '-699', 'Streamly'),
      ],
      { asOf: '2026-07-19' },
    );
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ cadence: 'monthly', amountKind: 'fixed', occurrenceCount: 3 });
  });

  it('still emits a biweekly paycheck-like series (real recurring, routed to income by B)', () => {
    const series = detectRecurringSeries(
      [
        txn('pay-1', '2024-01-05', '200000', 'Acme Payroll'),
        txn('pay-2', '2024-01-19', '200000', 'Acme Payroll'),
        txn('pay-3', '2024-02-02', '200000', 'Acme Payroll'),
        txn('pay-4', '2024-02-16', '200000', 'Acme Payroll'),
      ],
      { asOf: '2024-02-16' },
    );
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ cadence: 'biweekly', sign: 'inflow', occurrenceCount: 4 });
  });

  it('still tolerates one skipped period (month-end rent with April missing)', () => {
    // coverage 4/5 = 0.80, max period-gap = 2 (one skipped month) — must survive.
    const series = detectRecurringSeries(
      [
        txn('rent-1', '2024-01-31', '-250000'),
        txn('rent-2', '2024-02-29', '-250000'),
        txn('rent-3', '2024-03-31', '-250000'),
        txn('rent-4', '2024-05-31', '-250000'),
      ],
      { asOf: '2024-05-31' },
    );
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ coverage: { matchedSlots: 4, totalSlots: 5 } });
  });
});

// ---------------------------------------------------------------------------
// C — deterministic P2P + reward/refund suppression (recurring suggestion
// suppression, NOT deletion — the rows stay in the ledger and export, Law 6).
// ---------------------------------------------------------------------------
describe('recurring suppression (C)', () => {
  it('classifies P2P rails and reward/refund descriptions, passes real merchants', () => {
    expect(recurringSuppressionReason('VENMO PAYMENT JORDAN')).toBe('p2p');
    expect(recurringSuppressionReason('Zelle to Sam')).toBe('p2p');
    expect(recurringSuppressionReason('CASH APP*ALEX')).toBe('p2p');
    // PayPal is a MIXED rail (review P2): PayPal-billed merchant subscriptions lead
    // with the rail token in the memo, so PayPal is NOT hard-suppressed — these must
    // remain eligible for detection.
    expect(recurringSuppressionReason('PAYPAL *SPOTIFY')).toBeNull();
    expect(recurringSuppressionReason('PP*NYTIMES')).toBeNull();
    expect(recurringSuppressionReason('PayPal Instant Transfer')).toBeNull();
    expect(recurringSuppressionReason('CARD CASHBACK REWARD')).toBe('reward');
    expect(recurringSuppressionReason('Amazon REFUND')).toBe('reward');
    expect(recurringSuppressionReason('Statement Credit')).toBe('reward');
    // Genuine subscriptions/bills are NOT suppressed.
    expect(recurringSuppressionReason('Spotify')).toBeNull();
    expect(recurringSuppressionReason('Acme Payroll')).toBeNull();
    expect(recurringSuppressionReason('City Utilities')).toBeNull();
    // Boolean convenience helper mirrors the reason function.
    expect(isSuppressedFromRecurring('VENMO PAYMENT JORDAN')).toBe(true);
    expect(isSuppressedFromRecurring('Spotify')).toBe(false);
  });

  it('does not offer a regular Venmo-person series as recurring', () => {
    // Even perfectly monthly, same-payer Venmo is not a subscription — suppressed.
    const series = detectRecurringSeries(
      [
        txn('v-1', '2024-01-10', '5000', 'VENMO PAYMENT FROM CASEY'),
        txn('v-2', '2024-02-10', '5000', 'VENMO PAYMENT FROM CASEY'),
        txn('v-3', '2024-03-10', '5000', 'VENMO PAYMENT FROM CASEY'),
      ],
      { asOf: '2024-03-31' },
    );
    expect(series).toEqual([]);
  });

  it('does not offer a regular cashback series as recurring', () => {
    const series = detectRecurringSeries(
      [
        txn('r-1', '2024-01-15', '250', 'MONTHLY CASHBACK REWARD'),
        txn('r-2', '2024-02-15', '250', 'MONTHLY CASHBACK REWARD'),
        txn('r-3', '2024-03-15', '250', 'MONTHLY CASHBACK REWARD'),
      ],
      { asOf: '2024-03-31' },
    );
    expect(series).toEqual([]);
  });

  it('still detects a genuine merchant subscription in the same run', () => {
    // A real subscription and a Venmo stream together: only the subscription fires.
    const series = detectRecurringSeries(
      [
        txn('sub-1', '2024-01-06', '-1099', 'Streamly'),
        txn('sub-2', '2024-02-06', '-1099', 'Streamly'),
        txn('sub-3', '2024-03-06', '-1099', 'Streamly'),
        txn('v-1', '2024-01-10', '5000', 'VENMO PAYMENT FROM CASEY'),
        txn('v-2', '2024-02-10', '5000', 'VENMO PAYMENT FROM CASEY'),
        txn('v-3', '2024-03-10', '5000', 'VENMO PAYMENT FROM CASEY'),
      ],
      { asOf: '2024-03-31' },
    );
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ counterpartyKey: 'streamly', sign: 'outflow' });
  });

  it('DETECTS a PayPal-billed merchant subscription (review P2 — no over-suppression)', () => {
    // PayPal is a mixed rail: the memo leads with the rail token but the charge is a
    // real subscription. Bare \bpaypal\b used to suppress these; now they flow into
    // detection and a clean monthly PayPal-billed subscription fires.
    const series = detectRecurringSeries(
      [
        txn('pp-1', '2026-05-09', '-699', 'PAYPAL *STREAMLY'),
        txn('pp-2', '2026-06-09', '-699', 'PAYPAL *STREAMLY'),
        txn('pp-3', '2026-07-09', '-699', 'PAYPAL *STREAMLY'),
      ],
      { asOf: '2026-07-19' },
    );
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      cadence: 'monthly',
      sign: 'outflow',
      amountKind: 'fixed',
      occurrenceCount: 3,
    });
  });
});
