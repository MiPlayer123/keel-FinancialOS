'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useHousehold } from '@/components/keel/household-context';
import { fetchEntities, type EntityRow } from '@/lib/keel-api';

/**
 * The "current entity lens" (persona theme #2): a persistent, household-wide
 * VIEW filter answering "which entity's books am I looking at right now?".
 *
 * `entityId === null` is the blended default — every entity's accounts, the
 * pre-lens behavior with no regression. A concrete id narrows the primary
 * financial views (Accounts, Dashboard, Transactions) to that entity's
 * accounts CLIENT-SIDE only. It never changes ledger math: it hides no money
 * from a total that claims to include it — a scoped net worth counts exactly
 * the scoped accounts and says so.
 *
 * Mirrors household-context.tsx: optimistic localStorage restore so pages can
 * apply the lens on first paint, reconciled against the real entity list (a
 * stale/foreign id falls back to blended rather than filtering to nothing).
 * The lens is scoped PER household — switching households clears a lens that
 * doesn't belong to the new one.
 */

type EntityLensContextValue = {
  ready: boolean;
  /** All entities in the active household (for the switcher + name lookups). */
  entities: EntityRow[];
  /** Active lens; null = "All entities" (blended, no filter). */
  entityId: string | null;
  /** The resolved lens entity row, or null when blended / unknown. */
  entity: EntityRow | null;
  setEntityId: (id: string | null) => void;
  /** True only when the household has >1 entity — gates rendering the switcher
   *  AND applying any filter (a single-entity household is always blended). */
  multiEntity: boolean;
};

const EntityLensContext = createContext<EntityLensContextValue | null>(null);

const KEY_PREFIX = 'keel-entity-lens:';

function storageKey(householdId: string): string {
  return `${KEY_PREFIX}${householdId}`;
}

export function EntityLensProvider({ children }: { children: ReactNode }) {
  const { householdId } = useHousehold();
  const [ready, setReady] = useState(false);
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [entityId, setEntityIdState] = useState<string | null>(null);
  const [entityLoadFailed, setEntityLoadFailed] = useState(false);

  useEffect(() => {
    if (!householdId) {
      setEntities([]);
      setEntityIdState(null);
      setEntityLoadFailed(false);
      setReady(false);
      return;
    }
    let active = true;
    setReady(false);
    setEntityLoadFailed(false);
    // Optimistically restore this household's saved lens so the first paint of
    // every page can already narrow. Reconciled below against the real list.
    const saved = window.localStorage.getItem(storageKey(householdId));
    if (saved) setEntityIdState(saved);
    else setEntityIdState(null);
    void fetchEntities(householdId)
      .then((list) => {
        if (!active) return;
        setEntityLoadFailed(false);
        setEntities(list);
        // Drop a saved lens that isn't a real entity of THIS household (foreign
        // id, deleted/archived entity) — fail safe to blended, never filter to
        // an empty view.
        if (saved && !list.some((e) => e.entityId === saved)) {
          setEntityIdState(null);
          window.localStorage.removeItem(storageKey(householdId));
        }
        setReady(true);
      })
      .catch(() => {
        if (!active) return;
        setEntities([]);
        setEntityLoadFailed(true);
        setReady(true);
      });
    return () => {
      active = false;
    };
  }, [householdId]);

  const value = useMemo<EntityLensContextValue>(() => {
    const multiEntity = entities.length > 1;
    // Preserve a saved scope when entity metadata is unavailable; widening to
    // blended would silently change the financial authorization context.
    const effectiveId = entityLoadFailed ? entityId : multiEntity ? entityId : null;
    const entity = effectiveId
      ? (entities.find((e) => e.entityId === effectiveId) ?? null)
      : null;
    return {
      ready,
      entities,
      entityId: effectiveId,
      entity,
      multiEntity,
      setEntityId: (id: string | null) => {
        setEntityIdState(id);
        if (!householdId) return;
        if (id === null) window.localStorage.removeItem(storageKey(householdId));
        else window.localStorage.setItem(storageKey(householdId), id);
      },
    };
  }, [ready, entities, entityId, entityLoadFailed, householdId]);

  return <EntityLensContext.Provider value={value}>{children}</EntityLensContext.Provider>;
}

export function useEntityLens(): EntityLensContextValue {
  const ctx = useContext(EntityLensContext);
  if (!ctx) throw new Error('useEntityLens must be used within EntityLensProvider');
  return ctx;
}

/**
 * Given the accounts of a household, the set of account ids inside the current
 * lens — or `null` when the lens is blended ("All entities"), meaning no
 * restriction. The single choke point every view uses so the filter semantics
 * (and the null = unrestricted convention) stay identical everywhere.
 */
export function lensAccountIdSet(
  entityId: string | null,
  accounts: { id: string; entityId: string }[],
): Set<string> | null {
  if (entityId === null) return null;
  return new Set(accounts.filter((a) => a.entityId === entityId).map((a) => a.id));
}
