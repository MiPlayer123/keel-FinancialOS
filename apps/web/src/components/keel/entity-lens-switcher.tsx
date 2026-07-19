'use client';

import { Building2 } from 'lucide-react';

import { useEntityLens } from '@/components/keel/entity-lens-context';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ALL_ENTITIES = '__all_entities__';

/**
 * The global entity lens control (persona theme #2). Renders ONLY for a
 * household with more than one entity — a single-entity household sees no
 * clutter, and the plumbing (context + localStorage) is already in place for
 * when they add an LLC. Selecting an entity sets a persistent "I'm working in
 * the LLC now" lens that the primary financial views honor; "All entities" is
 * the blended default (no filter). It's a VIEW control, styled financial-calm
 * (neutral tokens — this qualifies no money, so no color), and a real
 * <select> under the hood so it's keyboard- and screen-reader-accessible.
 */
export function EntityLensSwitcher({ className }: { className?: string }) {
  const { multiEntity, entities, entityId, setEntityId } = useEntityLens();

  // Single-entity (or not-yet-loaded) household: no lens to switch, no control.
  if (!multiEntity) return null;

  const items = {
    [ALL_ENTITIES]: 'All entities',
    ...Object.fromEntries(entities.map((e) => [e.entityId, e.name])),
  };

  return (
    <Select
      value={entityId ?? ALL_ENTITIES}
      items={items}
      onValueChange={(v) => {
        if (!v) return;
        setEntityId(v === ALL_ENTITIES ? null : v);
      }}
    >
      <SelectTrigger
        aria-label="Entity lens — filter every view to one entity's books"
        className={className}
      >
        <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_ENTITIES}>All entities</SelectItem>
        <SelectSeparator />
        {entities.map((e) => (
          <SelectItem key={e.entityId} value={e.entityId}>
            {e.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
