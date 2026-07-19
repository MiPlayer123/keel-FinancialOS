import { describe, expect, it } from 'vitest';

import { isAutoCategorized, isReviewedCategory, type CategorySourceLike } from '@/lib/review-state';

const row = (
  categorySource: 'user' | 'rule' | 'plaid_pfc' | 'transfer_confirm' | null,
  splits: CategorySourceLike['splits'] = null,
): CategorySourceLike => ({ categorySource, splits });

describe('isAutoCategorized', () => {
  it('is true for a rule-filed category', () => {
    expect(isAutoCategorized(row('rule'))).toBe(true);
  });

  it('is true for a PFC-mapped category', () => {
    expect(isAutoCategorized(row('plaid_pfc'))).toBe(true);
  });

  it('is false for a user-confirmed category', () => {
    expect(isAutoCategorized(row('user'))).toBe(false);
  });

  it('is false for a still-uncategorized transaction (nothing was assigned)', () => {
    expect(isAutoCategorized(row(null))).toBe(false);
  });

  it('is false for a split, even with no overlay row (rule/pfc source absent)', () => {
    expect(
      isAutoCategorized(
        row(null, [
          { categoryLedgerAccountId: 'c1', name: 'Groceries', kind: 'expense', amountMinor: '500' },
        ]),
      ),
    ).toBe(false);
  });
});

describe('isReviewedCategory', () => {
  it('is true for a user-confirmed category', () => {
    expect(isReviewedCategory(row('user'))).toBe(true);
  });

  it('is true for a split (built only via the audited set-splits command)', () => {
    expect(
      isReviewedCategory(
        row('user', [
          { categoryLedgerAccountId: 'c1', name: 'Groceries', kind: 'expense', amountMinor: '500' },
        ]),
      ),
    ).toBe(true);
  });

  it('is false for a rule-filed category', () => {
    expect(isReviewedCategory(row('rule'))).toBe(false);
  });

  it('is false for a PFC-mapped category', () => {
    expect(isReviewedCategory(row('plaid_pfc'))).toBe(false);
  });

  it('is true for a transfer-confirm leg (audited human confirm decision)', () => {
    expect(isReviewedCategory(row('transfer_confirm'))).toBe(true);
    expect(isAutoCategorized(row('transfer_confirm'))).toBe(false);
  });

  it('is false for a still-uncategorized transaction', () => {
    expect(isReviewedCategory(row(null))).toBe(false);
  });
});
