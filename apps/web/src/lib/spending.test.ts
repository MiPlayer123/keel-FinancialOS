import { describe, expect, it } from 'vitest';

import { isDebtOrTransferLike, isMoneyMovementCategoryName, type DebtOrTransferLike } from './spending';

function row(overrides: Partial<DebtOrTransferLike>): DebtOrTransferLike {
  return {
    transferStatus: null,
    categoryName: null,
    categoryPfcKey: null,
    ...overrides,
  };
}

describe('isDebtOrTransferLike', () => {
  it('excludes confirmed transfer legs', () => {
    expect(isDebtOrTransferLike(row({ transferStatus: 'confirmed' }))).toBe(true);
  });

  it('does NOT exclude suggested transfer legs (unapproved inference)', () => {
    expect(isDebtOrTransferLike(row({ transferStatus: 'suggested' }))).toBe(false);
  });

  it('excludes the exact parent pfc_keys', () => {
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'loan_payments' }))).toBe(true);
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'transfers' }))).toBe(true);
  });

  it('excludes seeded subcategories by pfc_key prefix (WS-G review P2-1)', () => {
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'loan_payments_mortgage' }))).toBe(true);
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'transfers_internal' }))).toBe(true);
  });

  it('does not over-match keys that merely share leading characters', () => {
    // No separator after the parent stem — not part of the seeded family.
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'loan_paymentsx' }))).toBe(false);
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'transfersx' }))).toBe(false);
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'transportation' }))).toBe(false);
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'food_and_drink' }))).toBe(false);
  });

  it('falls back to seeded display name when pfc_key is absent', () => {
    expect(isDebtOrTransferLike(row({ categoryName: 'Loan Payments' }))).toBe(true);
    expect(isDebtOrTransferLike(row({ categoryName: 'Transfers' }))).toBe(true);
    expect(isDebtOrTransferLike(row({ categoryName: 'Groceries' }))).toBe(false);
  });
});

describe('isMoneyMovementCategoryName', () => {
  it('matches the two seeded buckets case/whitespace-insensitively', () => {
    expect(isMoneyMovementCategoryName('loan payments')).toBe(true);
    expect(isMoneyMovementCategoryName('  Transfers ')).toBe(true);
    expect(isMoneyMovementCategoryName('Rent')).toBe(false);
  });
});
