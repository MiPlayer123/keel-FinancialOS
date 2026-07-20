import { describe, expect, it } from 'vitest';

import {
  canApproveAuto,
  isAutoCategorized,
  isReviewedCategory,
  type ApprovableLike,
  type CategorySourceLike,
} from '@/lib/review-state';

const row = (
  categorySource: 'user' | 'rule' | 'plaid_pfc' | 'transfer_confirm' | null,
  splits: CategorySourceLike['splits'] = null,
): CategorySourceLike => ({ categorySource, splits });

const approvable = (
  categorySource: ApprovableLike['categorySource'],
  categoryLedgerAccountId: string | null,
  splits: ApprovableLike['splits'] = null,
): ApprovableLike => ({ categorySource, categoryLedgerAccountId, splits });

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

describe('canApproveAuto', () => {
  it('is true for a rule-filed row with a concrete category', () => {
    expect(canApproveAuto(approvable('rule', 'cat-1'))).toBe(true);
  });

  it('is true for a PFC-mapped row with a concrete category', () => {
    expect(canApproveAuto(approvable('plaid_pfc', 'cat-1'))).toBe(true);
  });

  it('is false when the auto row carries no category id (nothing to re-file)', () => {
    expect(canApproveAuto(approvable('plaid_pfc', null))).toBe(false);
  });

  it('is false for a user-confirmed row (already reviewed — nothing to approve)', () => {
    expect(canApproveAuto(approvable('user', 'cat-1'))).toBe(false);
  });

  it('is false for a still-uncategorized row', () => {
    expect(canApproveAuto(approvable(null, null))).toBe(false);
  });

  it('is false for a split, even with an overlay id present', () => {
    expect(
      canApproveAuto(
        approvable('rule', 'cat-1', [
          { categoryLedgerAccountId: 'c1', name: 'Groceries', kind: 'expense', amountMinor: '500' },
        ]),
      ),
    ).toBe(false);
  });
});
