'use client';

import { ReceiptText } from 'lucide-react';
import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import type { TransactionRow } from '@/lib/keel-api';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const STATUS_LABEL: Record<TransactionRow['status'], string> = {
  pending: 'Pending',
  posted: 'Posted',
  reviewed: 'Reviewed',
};

export default function LedgerPage() {
  return (
    <AppShell>
      <PageHeader title="Ledger" description="Every transaction, in one dense view." />
      <div className="p-6">
        <LedgerTable />
      </div>
    </AppShell>
  );
}

function LedgerTable() {
  const { householdId, ready } = useHousehold();
  const { rows, loading, error } = useKeelQuery<TransactionRow>('transactions.list', householdId);

  if (!ready || loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={<ReceiptText className="size-6" />}
        title="Couldn't load transactions"
        description={error}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<ReceiptText className="size-6" />}
        title="No transactions yet"
        description="Link an account or import a statement and posted transactions will appear here."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-32">Date</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-28 text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((tx) => (
            <TableRow key={tx.transactionId}>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {tx.effectiveDate}
              </TableCell>
              <TableCell className="font-medium">{tx.description}</TableCell>
              <TableCell className="text-right">
                <Badge variant="secondary">{STATUS_LABEL[tx.status]}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
