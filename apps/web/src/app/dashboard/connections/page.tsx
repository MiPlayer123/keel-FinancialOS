'use client';

import { useCallback, useEffect, useState } from 'react';
import { Link2, RefreshCw, Pencil, Check, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { useHousehold } from '@/components/keel/household-context';
import {
  fetchConnections,
  disconnectConnection,
  syncConnection,
  renameConnection,
  type ConnectionRow,
} from '@/lib/keel-api';
import { PlaidLinkButton } from '@/components/keel/plaid-link-button';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

const STATUS_TONE: Record<string, string> = {
  active: 'text-primary',
  reauth_required: 'text-keel-negative',
  disconnecting: 'text-muted-foreground',
  disconnected: 'text-muted-foreground',
};

export default function ConnectionsPage() {
  return <ConnectionsBody />;
}

function ConnectionsBody() {
  const { householdId, ready } = useHousehold();
  const [rows, setRows] = useState<ConnectionRow[] | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

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

  async function sync(connectionId: string) {
    if (!householdId) return;
    setSyncingId(connectionId);
    try {
      await syncConnection({ householdId, connectionId });
      toast.success('Syncing — new transactions will appear shortly.');
      // Give the worker a moment, then refresh the row's sync time.
      setTimeout(() => {
        void load();
      }, 2500);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start a sync.');
    } finally {
      setSyncingId(null);
    }
  }

  async function saveRename(connectionId: string) {
    if (!householdId) return;
    try {
      await renameConnection({ householdId, connectionId, displayName: editName });
      setEditingId(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not rename.');
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
                  {editingId === c.id ? (
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={editName}
                        autoFocus
                        placeholder="Connection name"
                        className="h-7 w-44"
                        onChange={(e) => {
                          setEditName(e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveRename(c.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        onClick={() => {
                          void saveRename(c.id);
                        }}
                      >
                        <Check className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        onClick={() => {
                          setEditingId(null);
                        }}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="group flex items-center gap-1.5 text-sm font-medium"
                      onClick={() => {
                        setEditingId(c.id);
                        setEditName(c.displayName ?? '');
                      }}
                    >
                      <span className="truncate">
                        {c.displayName ?? c.institutionId ?? c.provider}
                      </span>
                      <Pencil className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </button>
                  )}
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
                    disabled={syncingId === c.id}
                    onClick={() => {
                      void sync(c.id);
                    }}
                  >
                    {syncingId === c.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    Sync now
                  </Button>
                  <DisconnectDialog
                    label={c.displayName ?? c.institutionId ?? c.provider}
                    onConfirm={() => disconnect(c.id)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * ONBOARDINGIMPORT-4: Disconnect crypto-shreds the encrypted provider token —
 * irreversible (the user must re-link and re-authorize). Gate it behind a
 * typed confirmation with a destructive-styled confirm button so it can't be
 * mis-clicked next to the routine "Sync now" control. The action itself is
 * unchanged.
 */
const CONFIRM_WORD = 'DISCONNECT';

function DisconnectDialog({
  label,
  onConfirm,
}: {
  label: string;
  onConfirm: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
      setTyped('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTyped('');
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            Disconnect
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect {label}?</DialogTitle>
          <DialogDescription>
            This permanently deletes the connection&apos;s credentials. Transactions are kept.
            You&apos;ll need to reconnect and re-authorize to resume syncing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="disconnect-confirm">
            Type <span className="font-medium text-foreground">{CONFIRM_WORD}</span> to confirm
          </Label>
          <Input
            id="disconnect-confirm"
            autoComplete="off"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && typed === CONFIRM_WORD && !busy) void confirm();
            }}
          />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            disabled={typed !== CONFIRM_WORD || busy}
            onClick={() => {
              void confirm();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
