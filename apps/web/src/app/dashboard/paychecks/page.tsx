'use client';

import { Banknote } from 'lucide-react';
import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import type { PaycheckRow } from '@/lib/keel-api';
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

export default function PaychecksPage() {
  return (
    <AppShell>
      <PageHeader title="Paychecks" description="Gross-to-net pay, reconciled to deposits." />
      <div className="p-6">
        <PaychecksBody />
      </div>
    </AppShell>
  );
}

function PaychecksBody() {
  const { householdId, ready } = useHousehold();
  const { rows, loading, error } = useKeelQuery<PaycheckRow>('paychecks.list', householdId);

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
        icon={<Banknote className="size-6" />}
        title={error ? "Couldn't load paychecks" : 'No paychecks yet'}
        description={
          error ??
          'Payroll deposits will appear here once detected — gross, taxes, and net, reconciled to the deposit.'
        }
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-32">Pay date</TableHead>
            <TableHead>Employer</TableHead>
            <TableHead className="w-32 text-right">Gross</TableHead>
            <TableHead className="w-32 text-right">Net</TableHead>
            <TableHead className="w-28 text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((p) => (
            <TableRow key={p.paycheckId}>
              <TableCell className="font-mono text-xs text-muted-foreground">{p.payDate}</TableCell>
              <TableCell className="font-medium">{p.employerName}</TableCell>
              <TableCell className="text-right">
                <Money amountMinor={p.grossMinor} currency={p.currency} className="text-sm" />
              </TableCell>
              <TableCell className="text-right">
                <Money amountMinor={p.netMinor} currency={p.currency} className="text-sm" />
              </TableCell>
              <TableCell className="text-right">
                <Badge variant="secondary" className="capitalize">
                  {p.status.replaceAll('_', ' ')}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
