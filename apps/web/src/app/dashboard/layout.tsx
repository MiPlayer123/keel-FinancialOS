'use client';

import type { ReactNode } from 'react';

import { AppShell } from '@/components/keel/app-shell';
import { HouseholdProvider } from '@/components/keel/household-context';

/**
 * Shared shell for every /dashboard/* route. Mounting AppShell and
 * HouseholdProvider once here (instead of per-page) lets Next.js preserve
 * them across sibling navigations — the sidebar, header, auth check, and
 * household fetch no longer remount (and the household list no longer
 * refetches) on every Home → Ledger → Accounts click.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <HouseholdProvider>
      <AppShell>{children}</AppShell>
    </HouseholdProvider>
  );
}
