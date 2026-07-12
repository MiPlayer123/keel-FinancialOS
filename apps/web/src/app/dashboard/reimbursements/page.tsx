'use client';

import { ArrowLeftRight } from 'lucide-react';
import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import type { ReimbursementRow } from '@/lib/keel-api';
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

export default function ReimbursementsPage() {
  return (
    <AppShell>
      <PageHeader
        title="Reimbursements"
        description="Money owed to and by you — settled without inventing income."
      />
      <div className="p-6">
        <ReimbursementsBody />
      </div>
    </AppShell>
  );
}

function ReimbursementsBody() {
  const { householdId, ready } = useHousehold();
  const { rows, loading, error } = useKeelQuery<ReimbursementRow>(
    'reimbursements.list',
    householdId,
  );

  if (!ready || loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (error || rows.length === 0) {
    return (
      <EmptyState
        icon={<ArrowLeftRight className="size-6" />}
        title={error ? "Couldn't load reimbursements" : 'No claims yet'}
        description={
          error ?? 'Bill-splits and reimbursements will appear here as claims, tracked until settled.'
        }
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Counterparty</TableHead>
            <TableHead className="w-32">Kind</TableHead>
            <TableHead className="w-32 text-right">Amount</TableHead>
            <TableHead className="w-28 text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.claimId}>
              <TableCell className="font-medium">{r.counterpartyName}</TableCell>
              <TableCell className="text-xs capitalize text-muted-foreground">
                {r.kind.replaceAll('_', ' ')}
              </TableCell>
              <TableCell className="text-right">
                <Money amountMinor={r.amountMinor} currency={r.currency} className="text-sm" />
              </TableCell>
              <TableCell className="text-right">
                <Badge variant="secondary" className="capitalize">
                  {r.status.replaceAll('_', ' ')}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
