'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccess } from 'react-plaid-link';
import { Plus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { createLinkToken, exchangePublicToken, fetchFirstEntityId } from '@/lib/keel-api';
import { Button } from '@/components/ui/button';

/**
 * Opens the real Plaid Link modal (works in sandbox + production). Flow:
 * click → create a link_token from our backend → open Plaid Link → on success the
 * browser hands back a public_token → our backend exchanges it for a connection.
 */
export function PlaidLinkButton({
  householdId,
  onLinked,
}: {
  householdId: string;
  onLinked: () => void;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shouldOpen, setShouldOpen] = useState(false);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    (publicToken, metadata) => {
      void (async () => {
        try {
          const entityId = await fetchFirstEntityId(householdId);
          if (!entityId) {
            toast.error('No entity to attach the connection to.');
            return;
          }
          const institutionName = metadata.institution?.name;
          await exchangePublicToken({
            householdId,
            entityId,
            publicToken,
            ...(institutionName ? { institutionName } : {}),
          });
          toast.success(institutionName ? `${institutionName} connected.` : 'Bank connected.');
          onLinked();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Could not finish linking.');
        } finally {
          setBusy(false);
          setToken(null);
        }
      })();
    },
    [householdId, onLinked],
  );

  const { open, ready } = usePlaidLink({
    token,
    onSuccess,
    onExit: () => {
      setBusy(false);
      setToken(null);
      setShouldOpen(false);
    },
  });

  useEffect(() => {
    if (shouldOpen && ready && token) {
      (open as () => void)();
      setShouldOpen(false);
    }
  }, [shouldOpen, ready, token, open]);

  async function connect() {
    setBusy(true);
    try {
      const t = await createLinkToken(householdId);
      setToken(t);
      setShouldOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start Plaid.');
      setBusy(false);
    }
  }

  return (
    <Button
      size="sm"
      disabled={busy}
      onClick={() => {
        void connect();
      }}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
      Connect a bank
    </Button>
  );
}
