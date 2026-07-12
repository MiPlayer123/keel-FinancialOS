'use client';

import { ReceiptText } from 'lucide-react';
import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';

export default function LedgerPage() {
  return (
    <AppShell>
      <PageHeader title="Ledger" description="Every transaction, in one dense view." />
      <div className="p-6">
        <EmptyState
          icon={<ReceiptText className="size-6" />}
          title="Transactions coming next"
          description="This connects to transactions.list on the deterministic ledger — posting-level detail, filtering and bulk actions."
        />
      </div>
    </AppShell>
  );
}
