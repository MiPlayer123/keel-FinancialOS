'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link2, RefreshCw, Pencil, Check, X, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState, QueryErrorState } from '@/components/keel/page-header';
import { useHousehold } from '@/components/keel/household-context';
import {
  fetchConnections,
  disconnectConnection,
  syncConnection,
  renameConnection,
  fetchReconnectMatches,
  dedupeReconnectAccount,
  type ConnectionRow,
  type ReconnectMatchRow,
} from '@/lib/keel-api';
import { PlaidLinkButton } from '@/components/keel/plaid-link-button';
import { PlaidUpdateButton } from '@/components/keel/plaid-update-button';
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
  const { householdId, userId, ready } = useHousehold();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<ConnectionRow[] | null>(null);
  const [matches, setMatches] = useState<ReconnectMatchRow[]>([]);
  const [dedupingId, setDedupingId] = useState<string | null>(null);
  const [showDisconnected, setShowDisconnected] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!householdId) {
      setRows([]);
      setMatches([]);
      setLoadError(null);
      return;
    }
    setLoadError(null);
    try {
      setRows(await fetchConnections(householdId));
    } catch (error) {
      setRows([]);
      setLoadError(error instanceof Error ? error.message : 'Could not load connections.');
    }
    try {
      setMatches(await fetchReconnectMatches(householdId));
    } catch {
      setMatches([]);
    }
  }, [householdId]);

  useEffect(() => {
    void load();
  }, [load]);

  const anyConnectionSyncing = rows?.some((connection) => connection.isSyncing) ?? false;
  useEffect(() => {
    if (!householdId || !anyConnectionSyncing) return;
    let active = true;
    const interval = setInterval(() => {
      void fetchConnections(householdId)
        .then((connections) => {
          if (active) setRows(connections);
        })
        .catch(() => {});
    }, 7_500);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [householdId, anyConnectionSyncing]);

  async function dedupe(match: ReconnectMatchRow) {
    if (!householdId || !userId) return;
    setDedupingId(match.newAccountId);
    try {
      const result = await dedupeReconnectAccount({
        householdId,
        userId,
        newAccountId: match.newAccountId,
        oldAccountId: match.oldAccountId,
      });
      const voided = Number(result.effects['voidedCount'] ?? 0);
      toast.success(
        voided > 0
          ? `Removed ${String(voided)} duplicate transaction${voided === 1 ? '' : 's'} — ${
              match.oldAccountName
            }'s history stays authoritative for that window.`
          : 'No duplicates found yet — the sync may still be in progress. Safe to check again later.',
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not check for duplicates.');
    } finally {
      setDedupingId(null);
    }
  }

  async function disconnect(connectionId: string) {
    if (!householdId) return;
    try {
      await disconnectConnection({ householdId, connectionId });
      toast.success('Disconnected.');
      await Promise.all([load(), queryClient.invalidateQueries({ queryKey: ['keel-query'] })]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect.');
    }
  }

  async function sync(connection: ConnectionRow) {
    if (!householdId) return;
    if (connection.isSyncing) {
      toast.info('Sync already in progress');
      return;
    }
    setSyncingId(connection.id);
    try {
      await syncConnection({ householdId, connectionId: connection.id });
      setRows(
        (current) =>
          current?.map((row) => (row.id === connection.id ? { ...row, isSyncing: true } : row)) ??
          current,
      );
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
      await Promise.all([load(), queryClient.invalidateQueries({ queryKey: ['keel-query'] })]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not rename.');
    }
  }

  const loading = !ready || rows === null;
  const activeRows = rows?.filter((c) => c.status !== 'disconnected') ?? [];
  const disconnectedRows = rows?.filter((c) => c.status === 'disconnected') ?? [];
  const visibleRows = showDisconnected ? [...activeRows, ...disconnectedRows] : activeRows;

  return (
    <>
      <PageHeader
        title="Connections"
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
      <div className="space-y-4 p-6">
        {matches.length > 0 ? (
          <div className="space-y-2">
            {matches.map((m) => (
              <div
                key={m.newAccountId}
                className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 text-sm"
              >
                <p className="min-w-0 text-muted-foreground">
                  <span className="font-medium text-foreground">{m.newAccountName}</span> looks
                  like it replaces your previously disconnected{' '}
                  <span className="font-medium text-foreground">{m.oldAccountName}</span>
                  {m.oldConnectionDisplayName ? ` (${m.oldConnectionDisplayName})` : ''}. Want me
                  to check for duplicate transactions?
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={dedupingId === m.newAccountId}
                  onClick={() => {
                    void dedupe(m);
                  }}
                >
                  {dedupingId === m.newAccountId ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  Check for duplicates
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : loadError ? (
          <QueryErrorState
            onRetry={() => {
              void load();
            }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Link2 className="size-6" />}
            title="No connections yet"
            description="Connect a Sandbox institution to sync accounts and transactions. Credentials are encrypted and never touch the browser."
          />
        ) : visibleRows.length === 0 ? (
          <EmptyState
            icon={<Link2 className="size-6" />}
            title="No active connections"
            description={`All ${String(disconnectedRows.length)} of your connections are disconnected. Reconnect to resume syncing, or show them below.`}
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {visibleRows.map((c, i) => (
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
                    {c.isSyncing ? (
                      <>
                        <Loader2 className="size-3 animate-spin" />
                        {c.lastSuccessfulSyncAt ? 'Syncing…' : 'Initial sync in progress…'}
                      </>
                    ) : (
                      <>
                        <RefreshCw className="size-3" />
                        {c.lastSuccessfulSyncAt
                          ? `Synced ${new Date(c.lastSuccessfulSyncAt).toLocaleString()}`
                          : 'Not synced yet'}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Badge variant="secondary" className={STATUS_TONE[c.status] ?? ''}>
                    {c.status.replaceAll('_', ' ')}
                  </Badge>
                  {c.status === 'disconnected' ? null : (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={c.isSyncing || syncingId === c.id}
                        onClick={() => {
                          void sync(c);
                        }}
                      >
                        {c.isSyncing || syncingId === c.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <RefreshCw className="size-4" />
                        )}
                        {c.isSyncing ? 'Syncing…' : syncingId === c.id ? 'Starting…' : 'Sync now'}
                      </Button>
                      {householdId ? (
                        <PlaidUpdateButton
                          householdId={householdId}
                          connectionId={c.id}
                          onUpdated={() => {
                            void load();
                          }}
                        />
                      ) : null}
                      <DisconnectDialog
                        label={c.displayName ?? c.institutionId ?? c.provider}
                        onConfirm={() => disconnect(c.id)}
                      />
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading && disconnectedRows.length > 0 ? (
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => {
              setShowDisconnected((v) => !v);
            }}
          >
            {showDisconnected ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {showDisconnected ? 'Hide' : 'Show'} disconnected ({disconnectedRows.length})
          </button>
        ) : null}
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
