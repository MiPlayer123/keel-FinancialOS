'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from 'react-plaid-link';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { createUpdateLinkToken, finishConnectionUpdate } from '@/lib/keel-api';
import { Button } from '@/components/ui/button';

function PlaidUpdateLauncher({
  token,
  onSuccess,
  onExit,
}: {
  token: string;
  onSuccess: PlaidLinkOnSuccess;
  onExit: PlaidLinkOnExit;
}) {
  const opened = useRef(false);
  const { open, ready } = usePlaidLink({ token, onSuccess, onExit });

  useEffect(() => {
    if (!ready || opened.current) return;
    opened.current = true;
    (open as () => void)();
  }, [open, ready]);

  return null;
}

/**
 * Re-authorize an existing connection in Plaid UPDATE MODE (same item, in
 * place). Flow: click → mint an update-mode link_token for this connection →
 * open Plaid Link → the user re-auths + selects accounts → on success we do NOT
 * exchange a public_token (the item/access_token is unchanged); instead we
 * reconcile the item's accounts so a reissued card is discovered, then sync.
 *
 * Distinct from the reauth-only "Reconnect" affordance: this is available even
 * when the connection reads `active`, which is exactly the state a silently
 * dropped card leaves it in.
 */
export function PlaidUpdateButton({
  householdId,
  connectionId,
  onUpdated,
}: {
  householdId: string;
  connectionId: string;
  onUpdated?: () => void;
}) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(() => {
    void (async () => {
      try {
        const { addedAccountIds } = await finishConnectionUpdate({ householdId, connectionId });
        toast.success(
          addedAccountIds.length > 0
            ? `Connection updated — ${String(addedAccountIds.length)} account${addedAccountIds.length === 1 ? '' : 's'} restored.`
            : 'Connection re-authorized. No new accounts to add.',
        );
        void queryClient.invalidateQueries({ queryKey: ['keel-query'] });
        onUpdated?.();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not finish updating the connection.');
      } finally {
        setBusy(false);
        setToken(null);
      }
    })();
  }, [householdId, connectionId, onUpdated, queryClient]);

  const onExit = useCallback<PlaidLinkOnExit>((error) => {
    if (error) {
      const detail = error.display_message || error.error_code || 'unknown error';
      toast.error(`Plaid couldn't re-authorize: ${detail}`);
    }
    setBusy(false);
    setToken(null);
  }, []);

  async function begin() {
    setBusy(true);
    try {
      const t = await createUpdateLinkToken(householdId, connectionId);
      setToken(t);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start re-authorization.');
      setBusy(false);
    }
  }

  return (
    <>
      {token ? (
        <PlaidUpdateLauncher key={token} token={token} onSuccess={onSuccess} onExit={onExit} />
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => {
          void begin();
        }}
        aria-label="Fix connection — re-authorize in Plaid to restore a missing or reissued account"
        title="Fix connection — re-authorize to restore a missing or reissued account"
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <RefreshCw className="size-4" />
        )}
        Fix connection
      </Button>
    </>
  );
}
