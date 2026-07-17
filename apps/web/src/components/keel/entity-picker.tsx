'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { createEntity, type EntityKind, type EntityRow } from '@/lib/keel-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export const ENTITY_KINDS: { value: EntityKind; label: string }[] = [
  { value: 'personal', label: 'Personal' },
  { value: 'sole_prop', label: 'Sole proprietorship' },
  { value: 'llc_single', label: 'LLC (single-member)' },
  { value: 'llc_multi', label: 'LLC (multi-member)' },
  { value: 's_corp', label: 'S-corp' },
  { value: 'trust', label: 'Trust' },
  { value: 'other', label: 'Other' },
];

const NEW_ENTITY_VALUE = '__new_entity__';

/**
 * Entity select + inline "create a new entity" flow, shared by every place
 * an account gets scoped to an entity (add-account, Plaid connect,
 * reassign-entity). Hidden as a real choice when there's only one entity to
 * pick from ("never force a choice when there's nothing to decide between")
 * — but the create-new escape hatch always stays, so a household can grow
 * from one entity to several from any of these entry points.
 */
export function EntityPicker({
  householdId,
  entities,
  value,
  onChange,
  onEntityCreated,
}: {
  householdId: string;
  entities: EntityRow[];
  value: string;
  onChange: (entityId: string) => void;
  onEntityCreated: (entity: EntityRow) => void;
}) {
  const [showNewEntity, setShowNewEntity] = useState(false);
  const [newEntityName, setNewEntityName] = useState('');
  const [newEntityKind, setNewEntityKind] = useState<EntityKind>('personal');
  const [creating, setCreating] = useState(false);

  async function createNewEntity() {
    if (newEntityName.trim().length === 0) return;
    setCreating(true);
    try {
      const result = await createEntity({
        householdId,
        name: newEntityName.trim(),
        kind: newEntityKind,
      });
      if (!result.entityId) throw new Error('Could not create entity.');
      const created: EntityRow = {
        entityId: result.entityId,
        name: newEntityName.trim(),
        kind: newEntityKind,
      };
      onEntityCreated(created);
      onChange(created.entityId);
      setShowNewEntity(false);
      setNewEntityName('');
      setNewEntityKind('personal');
      toast.success(`Added entity "${created.name}".`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create entity.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-1.5">
      {entities.length > 1 ? (
        <Select
          value={showNewEntity ? NEW_ENTITY_VALUE : value}
          items={{
            ...Object.fromEntries(entities.map((e) => [e.entityId, e.name])),
            [NEW_ENTITY_VALUE]: '+ Add a new entity…',
          }}
          onValueChange={(v) => {
            if (v === NEW_ENTITY_VALUE) {
              setShowNewEntity(true);
            } else if (v) {
              onChange(v);
              setShowNewEntity(false);
            }
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {entities.map((e) => (
              <SelectItem key={e.entityId} value={e.entityId}>
                {e.name}
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value={NEW_ENTITY_VALUE}>+ Add a new entity…</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">{entities[0]?.name ?? 'Loading…'}</p>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => {
              setShowNewEntity((s) => !s);
            }}
          >
            + Add a new entity
          </Button>
        </div>
      )}
      {showNewEntity ? (
        <div className="mt-2 space-y-2 rounded-lg border p-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-entity-name">New entity name</Label>
            <Input
              id="new-entity-name"
              value={newEntityName}
              maxLength={200}
              placeholder="e.g. Acme Consulting LLC"
              onChange={(e) => {
                setNewEntityName(e.target.value);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Entity type</Label>
            <Select
              value={newEntityKind}
              items={Object.fromEntries(ENTITY_KINDS.map((k) => [k.value, k.label]))}
              onValueChange={(v) => {
                if (v) setNewEntityKind(v);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENTITY_KINDS.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={creating}
              onClick={() => {
                setShowNewEntity(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={creating || newEntityName.trim().length === 0}
              onClick={() => {
                void createNewEntity();
              }}
            >
              {creating ? <Loader2 className="size-4 animate-spin" /> : null}
              Create entity
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
