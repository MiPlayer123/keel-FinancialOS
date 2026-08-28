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
  const [rows, setRows] = useState<CashFlowRow[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const to = new Date().toISOString().slice(0, 10);
    const from = isoDaysAgo(30);
    setError(null);
    void keelQuery<CashFlowRow>('dashboard.cash_flow', householdId, { from, to })
      .then((res) => {
        if (!active) return;
        setRows(res.rows.length > 0 ? res.rows : null);
      })
      .catch((cause: unknown) => {
        if (active) {
          setRows(null);
          setError(cause instanceof Error ? cause.message : 'Could not load cash flow.');
        }
      });
    return () => {
      active = false;
    };
  }, [householdId]);

  if (rows === undefined) {
    return <Skeleton className="h-40 w-full max-w-sm" />;
  }

  if (error) {
    return <QueryErrorState />;
  }

  if (rows === null) {
    return (
      <EmptyState
        title="No cash flow in the last 30 days"
        description="Income and spending will appear here when transactions fall inside this period."
      />
    );
  }

  return (
    <Card className="max-w-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Cash flow · last 30 days
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rows.map((row) => (
          <section key={row.currency} aria-label={`${row.currency} cash flow`} className="space-y-3">
            {rows.length > 1 ? (
              <p className="text-xs font-medium text-muted-foreground">{row.currency}</p>
            ) : null}
            <div className="flex items-center justify-between text-sm">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <ArrowUpRight className="size-4 text-primary" />
                In
              </span>
              <Money amountMinor={row.inflowMinor} currency={row.currency} />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <ArrowDownRight className="size-4" />
                Out
              </span>
              <Money amountMinor={row.outflowMinor} currency={row.currency} />
            </div>
            <div className="flex items-center justify-between border-t border-border pt-3 text-sm font-medium">
              <span>Net</span>
              <Money amountMinor={row.netMinor} currency={row.currency} muteZero={false} />
            </div>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
