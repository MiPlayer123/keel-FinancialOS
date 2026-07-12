'use client';

import { FileCheck2 } from 'lucide-react';
import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import type { StatementRow } from '@/lib/keel-api';
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

export default function StatementsPage() {
  return (
    <AppShell>
      <PageHeader
        title="Statements"
        description="Statement closes — every difference explained, history locked."
      />
      <div className="p-6">
        <StatementsBody />
      </div>
    </AppShell>
  );
}

function StatementsBody() {
  const { householdId, ready } = useHousehold();
  const { rows, loading, error } = useKeelQuery<StatementRow>('statements.list', householdId);

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
        icon={<FileCheck2 className="size-6" />}
        title={error ? "Couldn't load statements" : 'No statement closes yet'}
        description={
          error ?? 'Closed statement periods will appear here, each reconciled with differences explained.'
        }
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-56">Period</TableHead>
            <TableHead className="text-right">Difference</TableHead>
            <TableHead className="w-28 text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => (
            <TableRow key={s.statementId}>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {s.periodStart} → {s.periodEnd}
              </TableCell>
              <TableCell className="text-right">
                <Money amountMinor={s.differenceMinor} className="text-sm" />
              </TableCell>
              <TableCell className="text-right">
                <Badge variant="secondary" className="capitalize">
                  {s.status.replaceAll('_', ' ')}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
