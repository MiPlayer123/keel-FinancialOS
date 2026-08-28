'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { bootstrapHousehold, fetchHouseholds, type HouseholdMembership } from '@/lib/keel-api';

type HouseholdContextValue = {
  ready: boolean;
  userId: string | null;
  households: HouseholdMembership[];
  householdId: string | null;
  setHouseholdId: (id: string) => void;
  error: string | null;
  retry: () => void;
};

const HouseholdContext = createContext<HouseholdContextValue | null>(null);

const KEY = 'keel-household-id';

export function HouseholdProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [households, setHouseholds] = useState<HouseholdMembership[]>([]);
  const [householdId, setHouseholdIdState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    // Optimistically adopt the saved household id so every page can fire its
    // queries immediately instead of waiting a full round trip for the
    // membership list (cold-start waterfall). Reconciled below: RLS + the
    // procs' own membership checks make a stale id fail safe, and the
    // corrected id triggers a refetch.
    const saved = window.localStorage.getItem(KEY);
    if (saved) {
      setHouseholdIdState(saved);
      setReady(true);
    }
    // Never let a slow/unavailable backend hang the shell on a spinner.
    const guard = setTimeout(() => {
      if (active) setReady(true);
    }, 8000);
    void (async () => {
      try {
        setError(null);
        const { data } = await getSupabaseBrowserClient().auth.getSession();
        const uid = data.session?.user.id ?? null;
        let list = await fetchHouseholds();
        if (uid && list.length === 0) {
          await bootstrapHousehold();
          list = await fetchHouseholds();
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
        if (!active) return;
        setUserId(uid);
        setHouseholds(list);
        const chosen = list.find((h) => h.householdId === saved) ?? list[0];
        setHouseholdIdState(chosen?.householdId ?? null);
        if (chosen && chosen.householdId !== saved) {
          window.localStorage.setItem(KEY, chosen.householdId);
        }
      } catch (cause) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
        if (!active) return;
        setError(cause instanceof Error ? cause.message : 'Could not set up your household.');
      }
      setReady(true);
    })();
    return () => {
      active = false;
      clearTimeout(guard);
    };
  }, [reload]);

  function setHouseholdId(id: string) {
    window.localStorage.setItem(KEY, id);
    setHouseholdIdState(id);
  }

  function retry() {
    setReady(false);
    setReload((value) => value + 1);
  }

  return (
    <HouseholdContext.Provider
      value={{ ready, userId, households, householdId, setHouseholdId, error, retry }}
    >
      {children}
    </HouseholdContext.Provider>
  );
}

export function useHousehold(): HouseholdContextValue {
  const ctx = useContext(HouseholdContext);
  if (!ctx) throw new Error('useHousehold must be used within HouseholdProvider');
  return ctx;
}
