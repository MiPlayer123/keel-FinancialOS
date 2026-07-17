'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccess } from 'react-plaid-link';
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
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shouldOpen, setShouldOpen] = useState(false);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);

  const [entities, setEntities] = useState<EntityRow[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerEntityId, setPickerEntityId] = useState('');

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
          onLinked();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Could not finish linking.');
        } finally {
          setBusy(false);
          setToken(null);
        }
      })();
    },
    [householdId, onLinked, selectedEntityId],
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

  async function beginPlaidFlow(entityId: string) {
    setSelectedEntityId(entityId);
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

  async function connect() {
    setBusy(true);
    try {
      const rows = entities ?? (await fetchEntities(householdId));
      if (entities === null) setEntities(rows);
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
      setPickerEntityId((current) =>
        rows.some((r) => r.entityId === current) ? current : (first?.entityId ?? ''),
      );
      setPickerOpen(true);
      setBusy(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load entities.');
      setBusy(false);
    }
  }

  return (
    <>
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
              disabled={!pickerEntityId}
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
