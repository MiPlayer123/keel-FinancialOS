import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { AppShell } from '@/components/keel/app-shell';
import { HouseholdProvider } from '@/components/keel/household-context';
import { EntityLensProvider } from '@/components/keel/entity-lens-context';

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Private KEEL financial workspace.',
  robots: { index: false, follow: false },
  openGraph: {
    title: 'Dashboard · KEEL',
    description: 'Private KEEL financial workspace.',
    url: '/dashboard',
  },
  twitter: {
    card: 'summary',
    title: 'Dashboard · KEEL',
    description: 'Private KEEL financial workspace.',
  },
};

/**
 * Shared shell for every /dashboard/* route. Mounting AppShell and
 * HouseholdProvider once here (instead of per-page) lets Next.js preserve
 * them across sibling navigations — the sidebar, header, auth check, and
 * household fetch no longer remount (and the household list no longer
 * refetches) on every Home → Ledger → Accounts click.
 *
 * EntityLensProvider sits INSIDE HouseholdProvider (it reads the active
 * household to scope its entity list + saved lens) and OUTSIDE AppShell so the
 * lens is shared by the switcher in the shell and every page it filters.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <HouseholdProvider>
      <EntityLensProvider>
        <AppShell>{children}</AppShell>
      </EntityLensProvider>
    </HouseholdProvider>
  );
}
