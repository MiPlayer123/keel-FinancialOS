'use client';

import { Link2 } from 'lucide-react';
import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';

export default function ConnectionsPage() {
  return (
    <AppShell>
      <PageHeader title="Connections" description="Linked institutions and sync status." />
      <div className="p-6">
        <EmptyState
          icon={<Link2 className="size-6" />}
          title="No connections yet"
          description="Link a bank via Plaid to sync accounts and transactions. Credentials are encrypted and never touch the browser."
        />
      </div>
    </AppShell>
  );
}
