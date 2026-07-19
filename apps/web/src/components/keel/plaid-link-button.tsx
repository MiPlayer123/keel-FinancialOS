'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from 'react-plaid-link';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  createLinkToken,
  exchangePublicToken,
  fetchEntities,
} from '@/lib/keel-api';
import { Button } from '@/components/ui/button';

function PlaidLinkLauncher({
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
 * Opens the real Plaid Link modal (works in sandbox + production). Flow:
 * click → pick a DEFAULT entity for the connection silently (no prompt,
 * ever) → create a link_token from our backend → open Plaid Link → on
 * success the browser hands back a public_token → our backend exchanges it
 * for a connection.
 *
 * The chosen entity is only a DEFAULT fallback: keel_finalize_link resolves
 * each account's entity individually (keel_resolve_finalize_entity) — a
 * reconnected account keeps the entity it already had, an account with a
 * business name (LLC / "Business") auto-lands in the household's business
 * entity, and everything else falls to the household's PERSONAL entity. Since
 * the server re-derives the right entity per account, there's nothing to ask:
 * we pass the personal entity (or the first entity) as the default and go
 * straight into Plaid Link. Any account can be reassigned afterwards.
 */
export function PlaidLinkButton({
  householdId,
  onLinked,
}: {
  householdId: string;
  onLinked: () => void;
}) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    (publicToken, metadata) => {
      void (async () => {
        try {
          if (!selectedEntityId) {
            toast.error('No entity to attach the connection to.');
            return;
          }
          const institutionName = metadata.institution?.name;
          await exchangePublicToken({
            householdId,
            entityId: selectedEntityId,
            publicToken,
            ...(institutionName ? { institutionName } : {}),
          });
          toast.success(institutionName ? `${institutionName} connected.` : 'Bank connected.');
          void queryClient.invalidateQueries({ queryKey: ['keel-query'] });
          onLinked();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Could not finish linking.');
        } finally {
          setBusy(false);
          setToken(null);
        }
      })();
    },
    [householdId, onLinked, queryClient, selectedEntityId],
  );

  const onExit = useCallback<PlaidLinkOnExit>((error) => {
    if (error) {
      const detail = error.display_message || error.error_code || 'unknown error';
      toast.error(`Plaid couldn't connect: ${detail}`);
    }
    setBusy(false);
    setToken(null);
  }, []);

  async function beginPlaidFlow(entityId: string) {
    setSelectedEntityId(entityId);
    setBusy(true);
    try {
      const t = await createLinkToken(householdId);
      setToken(t);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start Plaid.');
      setBusy(false);
    }
  }

  async function connect() {
    setBusy(true);
    try {
      // Always fetch fresh — a cached list could be stale (an entity created
      // since the last click) and pick a since-removed entity as the default.
      const rows = await fetchEntities(householdId);
      const first = rows[0];
      if (!first) {
        toast.error('No entity to attach the connection to. Add one from Accounts first.');
        setBusy(false);
        return;
      }
      // No prompt, ever: the server resolves each account's entity per account
      // (keel_resolve_finalize_entity) — reconnect-inherit, business-name
      // heuristic, else the household's PERSONAL entity. The entityId we send
      // is only a fallback default, so prefer the personal entity when present
      // and otherwise fall back to the first row.
      const defaultEntityId = rows.find((r) => r.kind === 'personal')?.entityId ?? first.entityId;
      await beginPlaidFlow(defaultEntityId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load entities.');
      setBusy(false);
    }
  }

  return (
    <>
      {token ? (
        <PlaidLinkLauncher key={token} token={token} onSuccess={onSuccess} onExit={onExit} />
      ) : null}
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
    </>
  );
}
