'use client';

import { BadgeCheck } from 'lucide-react';
import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';

export default function ReviewPage() {
  return (
    <AppShell>
      <PageHeader title="Review" description="Approve or dismiss what the AI suggests." />
      <div className="p-6">
        <EmptyState
          icon={<BadgeCheck className="size-6" />}
          title="Nothing to review yet"
          description="Recurring series, transfer matches and categorizations will surface here as suggestions — each waiting for your approval before anything changes."
        />
      </div>
    </AppShell>
  );
}
