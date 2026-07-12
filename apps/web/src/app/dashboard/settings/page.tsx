'use client';

import { Settings as SettingsIcon } from 'lucide-react';
import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';

export default function SettingsPage() {
  return (
    <AppShell>
      <PageHeader title="Settings" description="Account, household and data export." />
      <div className="p-6">
        <EmptyState
          icon={<SettingsIcon className="size-6" />}
          title="Settings coming next"
          description="Profile, household members, autonomy policies, and full data export (CSV / JSON / QIF / beancount) will live here."
        />
      </div>
    </AppShell>
  );
}
