import { describe, expect, it } from 'vitest';

import { RECURRING_BUCKET_BADGE_LABELS, outflowBucketForPfc } from './recurring-bucket';

// Executable spec of the outflow PFC->bucket mapping in
// keel_recurring_classification v4 (migration 20260719210000, formulaVersion
// 'recurring-classification-v4-outflow-buckets'). GAP-2 fixtures first: the
// old classifier fell through `else 'subscription'` for null/unmapped PFCs,
// so a recurring rideshare outflow wore a "Subscription" badge.
describe('outflowBucketForPfc (classifier v4 mirror)', () => {
  it('GAP-2: recurring rideshare (TRANSPORTATION) is a generic recurring expense, not a subscription', () => {
    expect(outflowBucketForPfc('TRANSPORTATION')).toBe('recurring');
  });

  it('GAP-2: null dominant PFC (no matched occurrences yet) claims cadence only — never "subscription"', () => {
    expect(outflowBucketForPfc(null)).toBe('recurring');
  });

  it('ENTERTAINMENT stays a subscription (streaming/gaming plans)', () => {
    expect(outflowBucketForPfc('ENTERTAINMENT')).toBe('subscription');
  });

  it('RENT_AND_UTILITIES stays utility', () => {
    expect(outflowBucketForPfc('RENT_AND_UTILITIES')).toBe('utility');
  });

  it('LOAN_PAYMENTS stays a bill', () => {
    expect(outflowBucketForPfc('LOAN_PAYMENTS')).toBe('bill');
  });

  it('maps every remaining Plaid PFC primary deterministically (full taxonomy)', () => {
    // Opt-in plans.
    expect(outflowBucketForPfc('GENERAL_SERVICES')).toBe('subscription');
    // Obligation-style charges.
    expect(outflowBucketForPfc('GOVERNMENT_AND_NON_PROFIT')).toBe('bill');
    expect(outflowBucketForPfc('INSURANCE')).toBe('bill');
    expect(outflowBucketForPfc('MEDICAL')).toBe('bill');
    expect(outflowBucketForPfc('BANK_FEES')).toBe('bill');
    // Habitual spend — cadence evidenced, kind not.
    expect(outflowBucketForPfc('FOOD_AND_DRINK')).toBe('recurring');
    expect(outflowBucketForPfc('GENERAL_MERCHANDISE')).toBe('recurring');
    expect(outflowBucketForPfc('PERSONAL_CARE')).toBe('recurring');
    expect(outflowBucketForPfc('TRAVEL')).toBe('recurring');
    expect(outflowBucketForPfc('HOME_IMPROVEMENT')).toBe('recurring');
    // Anomalous tags on an outflow and the catch-all.
    expect(outflowBucketForPfc('LOAN_DISBURSEMENTS')).toBe('recurring');
    expect(outflowBucketForPfc('INCOME')).toBe('recurring');
    expect(outflowBucketForPfc('OTHER')).toBe('recurring');
    // Internal transfers are not spend.
    expect(outflowBucketForPfc('TRANSFER_IN')).toBe('excluded');
    expect(outflowBucketForPfc('TRANSFER_OUT')).toBe('excluded');
  });

  it('a primary this taxonomy does not know degrades to the neutral generic, never to a kind claim', () => {
    expect(outflowBucketForPfc('SOME_FUTURE_PLAID_PRIMARY')).toBe('recurring');
    expect(outflowBucketForPfc('')).toBe('recurring');
  });
});

describe('RECURRING_BUCKET_BADGE_LABELS', () => {
  it('labels every bucket, including the new neutral "Recurring"', () => {
    expect(RECURRING_BUCKET_BADGE_LABELS.recurring).toBe('Recurring');
    // Record<RecurringBucket, string> is compile-time exhaustive; assert the
    // human wording stays singular badge-case (adjacent-status copy, Law 8).
    expect(Object.values(RECURRING_BUCKET_BADGE_LABELS)).toEqual(
      expect.arrayContaining(['Bill', 'Utility', 'Subscription', 'Recurring', 'Paycheck']),
    );
  });
});
