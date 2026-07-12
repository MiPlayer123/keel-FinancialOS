'use client';

import { useCallback, useEffect, useState } from 'react';
import { Link2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { useHousehold } from '@/components/keel/household-context';
import { fetchConnections, disconnectConnection, type ConnectionRow } from '@/lib/keel-api';
import { PlaidLinkButton } from '@/components/keel/plaid-link-button';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

const STATUS_TONE: Record<string, string> = {
  active: 'text-primary',
  reauth_required: 'text-keel-negative',
  disconnecting: 'text-muted-foreground',
  disconnected: 'text-muted-foreground',
};

export default function ConnectionsPage() {
  return (
    <AppShell>
      <ConnectionsBody />
    </AppShell>
  );
}

function ConnectionsBody() {
  const { householdId, ready } = useHousehold();
  const [rows, setRows] = useState<ConnectionRow[] | null>(null);

  const load = useCallback(async () => {
    if (!householdId) {
      setRows([]);
      return;
    }
    try {
      setRows(await fetchConnections(householdId));
    } catch {
      setRows([]);
    }
  }, [householdId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function disconnect(connectionId: string) {
    if (!householdId) return;
    try {
      await disconnectConnection({ householdId, connectionId });
      toast.success('Disconnected.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect.');
    }
  }

  const loading = !ready || rows === null;

  return (
    <>
      <PageHeader
        title="Connections"
        description="Linked institutions and sync status."
        actions={
          householdId ? (
            <PlaidLinkButton
              householdId={householdId}
              onLinked={() => {
                void load();
              }}
            />
          ) : null
        }
      />
      <div className="p-6">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Link2 className="size-6" />}
            title="No connections yet"
            description="Connect a Sandbox institution to sync accounts and transactions. Credentials are encrypted and never touch the browser."
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {rows.map((c, i) => (
              <div
                key={c.id}
                className={`flex items-center justify-between gap-4 px-4 py-3 ${
                  i > 0 ? 'border-t border-border' : ''
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {c.institutionId ?? c.provider}
                  </p>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <RefreshCw className="size-3" />
                    {c.lastSuccessfulSyncAt
                      ? `Synced ${new Date(c.lastSuccessfulSyncAt).toLocaleString()}`
                      : 'Not synced yet'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Badge variant="secondary" className={STATUS_TONE[c.status] ?? ''}>
                    {c.status.replaceAll('_', ' ')}
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void disconnect(c.id);
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
