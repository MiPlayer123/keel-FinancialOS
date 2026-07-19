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

  it('excludes the transfer parent pfc_key', () => {
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'transfers' }))).toBe(true);
  });

  it('excludes the sign-split transfer categories (transfers_in / transfers_out)', () => {
    // 20260719020000 / 20260720140000: one-sided Venmo inflow / own-card payoff.
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'transfers_in' }))).toBe(true);
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'transfers_out' }))).toBe(true);
  });

  it('excludes seeded transfer subcategories by pfc_key prefix (WS-G review P2-1)', () => {
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'transfers_internal' }))).toBe(true);
  });

  it('does NOT exclude loan payments — a real debt payment IS spend (SLICE D)', () => {
    // Aligns client SPENDING with the server: keel_cash_flow counts genuine loan
    // payments; only own-card payoffs (now Transfers Out) are money-movement.
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'loan_payments' }))).toBe(false);
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'loan_payments_mortgage' }))).toBe(false);
    expect(isDebtOrTransferLike(row({ categoryName: 'Loan Payments' }))).toBe(false);
  });

  it('does not over-match keys that merely share leading characters', () => {
    // No separator after the parent stem — not part of the seeded family.
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'transfersx' }))).toBe(false);
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'transportation' }))).toBe(false);
    expect(isDebtOrTransferLike(row({ categoryPfcKey: 'food_and_drink' }))).toBe(false);
  });

  it('falls back to seeded display name when pfc_key is absent', () => {
    expect(isDebtOrTransferLike(row({ categoryName: 'Transfers' }))).toBe(true);
    expect(isDebtOrTransferLike(row({ categoryName: 'Transfers Out' }))).toBe(true);
    expect(isDebtOrTransferLike(row({ categoryName: 'Groceries' }))).toBe(false);
  });
});

describe('isMoneyMovementCategoryName', () => {
  it('matches the seeded transfer buckets case/whitespace-insensitively', () => {
    expect(isMoneyMovementCategoryName('transfers')).toBe(true);
    expect(isMoneyMovementCategoryName('  Transfers Out ')).toBe(true);
    // Loan payments is a real spend category, not money movement (SLICE D).
    expect(isMoneyMovementCategoryName('loan payments')).toBe(false);
    expect(isMoneyMovementCategoryName('Rent')).toBe(false);
  });
});
