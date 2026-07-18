'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from 'react-plaid-link';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { EntityPicker } from '@/components/keel/entity-picker';
import {
  createLinkToken,
  exchangePublicToken,
  fetchEntities,
  type EntityRow,
} from '@/lib/keel-api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

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
 * click → resolve which entity the connection belongs to (silently, when
 * there's only one; via a picker once a household has 2+) → create a
 * link_token from our backend → open Plaid Link → on success the browser
 * hands back a public_token → our backend exchanges it for a connection
 * under the chosen entity.
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

  const [entities, setEntities] = useState<EntityRow[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerEntityId, setPickerEntityId] = useState('');
  const [pickerCreatingEntity, setPickerCreatingEntity] = useState(false);

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
      // Always fetch fresh — a cached list could be stale (an entity
      // created since the last click, or reassignment work done elsewhere)
      // and silently pick the wrong entity or skip the picker it should show.
      const rows = await fetchEntities(householdId);
      setEntities(rows);
      if (rows.length === 0) {
        toast.error('No entity to attach the connection to. Add one from Accounts first.');
        setBusy(false);
        return;
      }
      const first = rows[0];
      if (rows.length === 1 && first) {
        await beginPlaidFlow(first.entityId);
        return;
      }
      // 2+ entities: which books this connection belongs to isn't obvious —
      // ask instead of silently guessing (BC-v2.1 §9.1 explicit ownership).
      setPickerCreatingEntity(false);
      setPickerEntityId(first?.entityId ?? '');
      setPickerOpen(true);
      setBusy(false);
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
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Which entity is this for?</DialogTitle>
            <DialogDescription>
              Choose the books this connection belongs to — you can&apos;t move it later without
              reassigning the account.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Entity</Label>
            {entities ? (
              <EntityPicker
                householdId={householdId}
                entities={entities}
                value={pickerEntityId}
                onChange={setPickerEntityId}
                onEntityCreated={(created) => {
                  setEntities((prev) => [...(prev ?? []), created]);
                }}
                onCreatingNewChange={setPickerCreatingEntity}
              />
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPickerOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!pickerEntityId || pickerCreatingEntity}
              onClick={() => {
                setPickerOpen(false);
                void beginPlaidFlow(pickerEntityId);
              }}
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
