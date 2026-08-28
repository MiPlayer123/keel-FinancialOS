'use client';

import { useEffect, useState } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';

import { keelQuery, type CashFlowRow } from '@/lib/keel-api';
import { Money } from '@/components/keel/money';
import { EmptyState, QueryErrorState } from '@/components/keel/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Cash flow over the last 30 days (primary-currency row). Wired to dashboard.cash_flow. */
export function CashFlowCard({ householdId }: { householdId: string }) {
  const [row, setRow] = useState<CashFlowRow | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const to = new Date().toISOString().slice(0, 10);
    const from = isoDaysAgo(30);
    setError(null);
    void keelQuery<CashFlowRow>('dashboard.cash_flow', householdId, { from, to })
      .then((res) => {
        if (!active) return;
        setRow(res.rows[0] ?? null);
      })
      .catch((cause: unknown) => {
        if (active) {
          setRow(null);
          setError(cause instanceof Error ? cause.message : 'Could not load cash flow.');
        }
      });
    return () => {
      active = false;
    };
  }, [householdId]);

  if (row === undefined) {
    return <Skeleton className="h-40 w-full max-w-sm" />;
  }

  if (error) {
    return <QueryErrorState />;
  }

  if (row === null) {
    return (
      <EmptyState
        title="No cash flow in the last 30 days"
        description="Income and spending will appear here when transactions fall inside this period."
      />
    );
  }

  const inflow = row.inflowMinor;
  const outflow = row.outflowMinor;
  const net = row.netMinor;
  const currency = row.currency;

  return (
    <Card className="max-w-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Cash flow · last 30 days
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <ArrowUpRight className="size-4 text-primary" />
            In
          </span>
          <Money amountMinor={inflow} currency={currency} />
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <ArrowDownRight className="size-4" />
            Out
          </span>
          <Money amountMinor={outflow} currency={currency} />
        </div>
        <div className="flex items-center justify-between border-t border-border pt-3 text-sm font-medium">
          <span>Net</span>
          <Money amountMinor={net} currency={currency} muteZero={false} />
        </div>
      </CardContent>
    </Card>
  );
}
