'use client';

import { CreditCard } from 'lucide-react';

import { Money } from '@/components/keel/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { CardBreakEven } from '@/lib/card-breakeven';

/**
 * Credit-card rewards vs annual-fee break-even (F: card-rewards-breakeven).
 * "Did the card pay for itself?" — per card over the report scope, rewards /
 * statement credits earned against fees / annual charges paid, and the net.
 *
 * Reproducible (Law 9): the caller passes `scopeText` (accounts + [from, to] +
 * entity) and it is stated in the footnote; every number is BigInt minor units
 * derived from the same scoped rows the rest of the page uses. Red is reserved
 * for negative money only (Law 8): a negative NET (fees outweigh rewards this
 * scope) is money in the hole and reads red via <Money>; rewards and fees are
 * magnitudes and stay neutral.
 */
export function CardBreakEvenCard({
  cards,
  scopeText,
}: {
  cards: CardBreakEven[];
  scopeText: string;
}) {
  if (cards.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <CreditCard className="size-4" />
          Card rewards vs fees
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          {cards.map((c) => {
            const paidForItself = c.netMinor >= 0n;
            return (
              <div key={c.accountId} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-medium">{c.accountName}</span>
                  <span
                    className={
                      paidForItself
                        ? 'text-xs font-medium text-primary'
                        : 'text-xs text-muted-foreground'
                    }
                  >
                    {paidForItself ? 'Paid for itself' : 'Not yet even'}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Rewards</p>
                    <Money
                      amountMinor={c.rewardsMinor.toString()}
                      currency={c.currency}
                      className="font-medium"
                    />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Fees</p>
                    {/* Fees are money out — render as a negative so red flags the cost. */}
                    <Money
                      amountMinor={(-c.feesMinor).toString()}
                      currency={c.currency}
                      className="font-medium"
                    />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Net</p>
                    <Money
                      amountMinor={c.netMinor.toString()}
                      currency={c.currency}
                      signed
                      muteZero={false}
                      className="font-semibold"
                    />
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {c.rewardCount} reward{c.rewardCount === 1 ? '' : 's'} · {c.feeCount} fee
                  {c.feeCount === 1 ? '' : 's'}
                </p>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {scopeText}. Rewards = statement credits / cashback earned on the card (income
          categories); fees = annual &amp; bank charges (the Fees category family). Net = rewards −
          fees; ≥ 0 means the card paid for itself in this range.
        </p>
      </CardContent>
    </Card>
  );
}
