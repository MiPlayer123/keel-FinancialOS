import { describe, expect, it } from 'vitest';

import { cardBreakEven, isCardFeeRow, isCardRewardRow } from './card-breakeven';
import type { RichTransactionRow } from '@/lib/keel-api';

/** Minimal row factory — only the fields cardBreakEven reads. */
function row(partial: Partial<RichTransactionRow>): RichTransactionRow {
  return {
    transactionId: partial.transactionId ?? crypto.randomUUID(),
    effectiveDate: partial.effectiveDate ?? '2026-06-01',
    description: partial.description ?? '',
    status: 'posted',
    accountId: partial.accountId ?? 'card-1',
    accountName: partial.accountName ?? 'Sapphire Reserve',
    amountMinor: partial.amountMinor ?? '0',
    currency: partial.currency ?? 'USD',
    categoryLedgerAccountId: partial.categoryLedgerAccountId ?? null,
    categoryName: partial.categoryName ?? null,
    categoryKind: partial.categoryKind ?? null,
    categoryPfcKey: partial.categoryPfcKey ?? null,
    splits: partial.splits ?? null,
  };
}

const CARDS = new Set(['card-1']);

describe('isCardRewardRow / isCardFeeRow', () => {
  it('a reward is income filed under the rewards category (pfc or reward-like name)', () => {
    expect(
      isCardRewardRow(row({ categoryKind: 'income', categoryPfcKey: 'income_card_rewards' })),
    ).toBe(true);
    expect(
      isCardRewardRow(row({ categoryKind: 'income', categoryName: 'Credit card rewards' })),
    ).toBe(true);
    expect(isCardRewardRow(row({ categoryKind: 'income', categoryName: 'Cashback' }))).toBe(true);
    // NOT a reward: an unconfirmed card payment lands as Uncategorized Income —
    // money movement, never fabricated into rewards (Law 9).
    expect(
      isCardRewardRow(
        row({ categoryKind: 'income', categoryPfcKey: 'uncategorized_income', categoryName: 'Uncategorized Income' }),
      ),
    ).toBe(false);
    // NOT a reward: a transfer-in inflow.
    expect(
      isCardRewardRow(row({ categoryKind: 'income', categoryPfcKey: 'transfers_in', categoryName: 'Transfers In' })),
    ).toBe(false);
    expect(isCardRewardRow(row({ categoryKind: 'expense', amountMinor: '-100' }))).toBe(false);
  });

  it('a fee is an expense row in the seeded fees pfc-key family', () => {
    expect(isCardFeeRow(row({ categoryKind: 'expense', categoryPfcKey: 'fees' }))).toBe(true);
    expect(isCardFeeRow(row({ categoryKind: 'expense', categoryPfcKey: 'fees_bank' }))).toBe(true);
    expect(isCardFeeRow(row({ categoryKind: 'expense', categoryPfcKey: 'fees_late' }))).toBe(true);
    // Ordinary card spend is NOT a fee.
    expect(isCardFeeRow(row({ categoryKind: 'expense', categoryPfcKey: 'travel' }))).toBe(false);
    // An income row is never a fee.
    expect(isCardFeeRow(row({ categoryKind: 'income', categoryPfcKey: null }))).toBe(false);
  });

  it('an unkeyed user fee category is recognized by name (fallback only)', () => {
    expect(
      isCardFeeRow(row({ categoryKind: 'expense', categoryPfcKey: null, categoryName: 'Bank Charges' })),
    ).toBe(true);
    expect(
      isCardFeeRow(row({ categoryKind: 'expense', categoryPfcKey: null, categoryName: 'Groceries' })),
    ).toBe(false);
  });
});

describe('cardBreakEven — founder Sapphire Reserve scenario', () => {
  it('nets a $795 annual fee against a $150 credit + cashback', () => {
    const rows = [
      // ANNUAL MEMBERSHIP FEE — expense on the card, cash out (negative). $795.00
      row({
        amountMinor: '-79500',
        categoryKind: 'expense',
        categoryPfcKey: 'fees',
        categoryName: 'Fees',
      }),
      // $150 travel/dining statement credit — income received (positive cash).
      row({
        amountMinor: '15000',
        categoryKind: 'income',
        categoryName: 'Credit card rewards',
      }),
      // Cashback redemption — income received. $24.58
      row({
        amountMinor: '2458',
        categoryKind: 'income',
        categoryName: 'Credit card rewards',
      }),
      // Ordinary $60 dinner charge — expense, but NOT a fee, so out of scope.
      row({ amountMinor: '-6000', categoryKind: 'expense', categoryPfcKey: 'food_drink' }),
    ];
    const [card] = cardBreakEven(rows, CARDS);
    expect(card).toBeDefined();
    expect(card?.rewardsMinor).toBe(17458n); // 15000 + 2458
    expect(card?.feesMinor).toBe(79500n);
    expect(card?.netMinor).toBe(-62042n); // still in the hole this scope
    expect(card?.rewardCount).toBe(2);
    expect(card?.feeCount).toBe(1);
  });

  it('reports a positive net once rewards exceed the fee ("the card paid for itself")', () => {
    const rows = [
      row({ amountMinor: '-79500', categoryKind: 'expense', categoryPfcKey: 'fees' }),
      row({ amountMinor: '90000', categoryKind: 'income', categoryName: 'Credit card rewards' }),
    ];
    const [card] = cardBreakEven(rows, CARDS);
    expect(card?.netMinor).toBe(10500n);
    expect(card?.netMinor).toBeGreaterThan(0n);
  });
});

describe('cardBreakEven — sign, scope, and grouping', () => {
  it('only counts credit-card accounts (a checking-account reward is ignored)', () => {
    const rows = [
      row({ accountId: 'checking-9', amountMinor: '500000', categoryKind: 'income', categoryName: 'Credit card rewards' }),
      row({ amountMinor: '-79500', categoryKind: 'expense', categoryPfcKey: 'fees' }),
    ];
    const cards = cardBreakEven(rows, CARDS);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.rewardsMinor).toBe(0n); // the off-card reward is not on this card
    expect(cards[0]?.feesMinor).toBe(79500n);
  });

  it('does NOT count an unconfirmed card payment (Uncategorized Income) as a reward', () => {
    const rows = [
      // A $2,000 payment from checking that landed one-sided as income on the card.
      row({ amountMinor: '200000', categoryKind: 'income', categoryPfcKey: 'uncategorized_income', categoryName: 'Uncategorized Income' }),
      // A genuine $30 cashback the user categorized.
      row({ amountMinor: '3000', categoryKind: 'income', categoryPfcKey: 'income_card_rewards', categoryName: 'Credit card rewards' }),
      row({ amountMinor: '-79500', categoryKind: 'expense', categoryPfcKey: 'fees' }),
    ];
    const [card] = cardBreakEven(rows, CARDS);
    expect(card?.rewardsMinor).toBe(3000n); // ONLY the confirmed reward, not the payment
    expect(card?.feesMinor).toBe(79500n);
    expect(card?.netMinor).toBe(-76500n);
  });

  it('omits a card with neither rewards nor fees in scope', () => {
    const rows = [row({ amountMinor: '-6000', categoryKind: 'expense', categoryPfcKey: 'travel' })];
    expect(cardBreakEven(rows, CARDS)).toHaveLength(0);
  });

  it('groups per card and orders worst-net first', () => {
    const cards = new Set(['card-1', 'card-2']);
    const rows = [
      // card-1: fee 795, no rewards → net -795
      row({ accountId: 'card-1', accountName: 'Reserve', amountMinor: '-79500', categoryKind: 'expense', categoryPfcKey: 'fees' }),
      // card-2: rewards 300, fee 95 → net +205
      row({ accountId: 'card-2', accountName: 'Freedom', amountMinor: '30000', categoryKind: 'income', categoryPfcKey: 'income_card_rewards', categoryName: 'Credit card rewards' }),
      row({ accountId: 'card-2', accountName: 'Freedom', amountMinor: '-9500', categoryKind: 'expense', categoryPfcKey: 'fees' }),
    ];
    const out = cardBreakEven(rows, cards);
    expect(out.map((c) => c.accountId)).toEqual(['card-1', 'card-2']); // worst net first
    expect(out[0]?.netMinor).toBe(-79500n);
    expect(out[1]?.netMinor).toBe(20500n);
  });

  it('handles amounts beyond Number-safe precision exactly (BigInt, Law 4)', () => {
    const rows = [
      row({ amountMinor: '9007199254740993', categoryKind: 'income', categoryPfcKey: 'income_card_rewards' }),
      row({ amountMinor: '-9007199254740992', categoryKind: 'expense', categoryPfcKey: 'fees' }),
    ];
    const [card] = cardBreakEven(rows, CARDS);
    expect(card?.rewardsMinor).toBe(9007199254740993n);
    expect(card?.feesMinor).toBe(9007199254740992n);
    expect(card?.netMinor).toBe(1n);
  });

  it('is split-aware: a fee and a reward share inside one split transaction each count', () => {
    const rows = [
      row({
        amountMinor: '0',
        splits: [
          // fee share (expense, debit-positive) $95
          { legType: 'category', categoryLedgerAccountId: 'cat-fee', name: 'Annual fee', kind: 'expense', amountMinor: '9500' },
          // reward share (income, credit = negative posting) $30 received
          { legType: 'category', categoryLedgerAccountId: 'cat-rew', name: 'Credit card rewards', kind: 'income', amountMinor: '-3000' },
        ],
      }),
    ];
    const [card] = cardBreakEven(rows, CARDS);
    expect(card?.feesMinor).toBe(9500n);
    expect(card?.rewardsMinor).toBe(3000n);
    expect(card?.netMinor).toBe(-6500n);
  });

  it('ignores a spurious negative reward and a spurious negative fee (defensive, never inflates)', () => {
    const rows = [
      // a reward row whose cash somehow reads negative — not a real reward inflow
      row({ amountMinor: '-100', categoryKind: 'income', categoryPfcKey: 'income_card_rewards' }),
      // a fee row whose cash reads positive — not a real fee outflow
      row({ amountMinor: '100', categoryKind: 'expense', categoryPfcKey: 'fees' }),
    ];
    expect(cardBreakEven(rows, CARDS)).toHaveLength(0);
  });
});
