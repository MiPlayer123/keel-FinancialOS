'use client';

import { useEffect, useState } from 'react';
import { Lock, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { fetchHoldings, type HoldingRow } from '@/lib/keel-api';
import { HoldingFormDialog } from '@/components/keel/holding-form-dialog';
import { Money } from '@/components/keel/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Positions inside an investment account — descriptive only (S-inv-1a,
 * docs/harness/plans/investments-v1.md). Never posts to the ledger and
 * never asserts the total ties exactly to the account's own balance (the
 * balance is the authoritative number; this explains what's inside it).
 */
export function HoldingsCard({
  householdId,
  accountId,
  currency,
}: {
  householdId: string | null;
  accountId: string;
  currency: string;
}) {
  const [rows, setRows] = useState<HoldingRow[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<HoldingRow | null>(null);

  function load() {
    if (!householdId) return;
    fetchHoldings(householdId, accountId)
      .then(setRows)
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : 'Could not load holdings.');
        setRows([]);
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable per render intent; re-fires only on id/household change
  }, [householdId, accountId]);

  const total = (rows ?? []).reduce((acc, r) => acc + BigInt(r.valueMinor || '0'), 0n);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">Holdings</CardTitle>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="size-3.5" />
            Add holding
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows === null ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No holdings tracked yet. Add a position to see it here — it&apos;s a breakdown of this
            account&apos;s balance, not a separate total.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {rows.map((row) => (
                <button
                  key={row.holdingId}
                  type="button"
                  disabled={row.source === 'plaid'}
                  onClick={() => {
                    setEditing(row);
                    setDialogOpen(true);
                  }}
                  className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left disabled:cursor-default"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-sm font-medium">{row.symbol}</p>
                      {row.source === 'plaid' ? (
                        <Badge variant="secondary" className="gap-1 font-normal">
                          <Lock className="size-3" />
                          Synced
                        </Badge>
                      ) : (
                        <Pencil className="size-3 text-muted-foreground/50" />
                      )}
                    </div>
                    {row.name ? (
                      <p className="truncate text-xs text-muted-foreground">{row.name}</p>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <Money amountMinor={row.valueMinor} currency={row.currency} className="text-sm" />
                    <p className="text-xs text-muted-foreground">
                      {row.qty} sh · <Money amountMinor={row.priceMinor} currency={row.currency} className="text-xs" />
                    </p>
                  </div>
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between border-t pt-2 text-sm">
              <span className="text-muted-foreground">Total</span>
              <Money amountMinor={total.toString()} currency={currency} className="font-medium" />
            </div>
          </>
        )}
      </CardContent>
      <HoldingFormDialog
        open={dialogOpen}
        householdId={householdId}
        accountId={accountId}
        currency={currency}
        editing={editing}
        onClose={() => {
          setDialogOpen(false);
        }}
        onSaved={() => {
          setDialogOpen(false);
          load();
        }}
      />
    </Card>
  );
}
