'use client';

import { AlertCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useHousehold } from '@/components/keel/household-context';

/**
 * Shown on every dashboard page when first-login household setup failed.
 *
 * Without a household, every household-scoped control (Connect a bank, Add
 * account, entity pickers) hides itself, so a failed setup used to look like
 * the buttons were simply missing. That is how a new account sat with no way
 * to connect a bank while the bootstrap function was absent from production.
 * This says what is wrong and offers a retry.
 */
export function HouseholdSetupNotice() {
  const { ready, householdId, error, retry } = useHousehold();
  if (!ready || householdId || !error) return null;

  return (
    <div className="px-4 pt-4 sm:px-6">
      <div
        role="alert"
        className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex min-w-0 items-start gap-2">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="min-w-0 text-muted-foreground">
            <span className="font-medium text-foreground">Your account isn&apos;t fully set up.</span>{' '}
            Connecting a bank and adding accounts are unavailable until it is.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={retry}>
          Try again
        </Button>
      </div>
    </div>
  );
}
