'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { fetchHouseholds, type HouseholdMembership } from '@/lib/keel-api';

type HouseholdContextValue = {
  ready: boolean;
  userId: string | null;
  households: HouseholdMembership[];
  householdId: string | null;
  setHouseholdId: (id: string) => void;
};

const HouseholdContext = createContext<HouseholdContextValue | null>(null);

const KEY = 'keel-household-id';

export function HouseholdProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [households, setHouseholds] = useState<HouseholdMembership[]>([]);
  const [householdId, setHouseholdIdState] = useState<string | null>(null);

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
      const [{ data }, list] = await Promise.all([
        getSupabaseBrowserClient().auth.getSession(),
        fetchHouseholds().catch((): HouseholdMembership[] => []),
      ]);
      const uid = data.session?.user.id ?? null;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
      if (!active) return;
      setUserId(uid);
      setHouseholds(list);
      const chosen = list.find((h) => h.householdId === saved) ?? list[0];
      setHouseholdIdState(chosen?.householdId ?? null);
      setReady(true);
    })();
    return () => {
      active = false;
      clearTimeout(guard);
    };
  }, []);

  function setHouseholdId(id: string) {
    window.localStorage.setItem(KEY, id);
    setHouseholdIdState(id);
  }

  return (
    <HouseholdContext.Provider value={{ ready, userId, households, householdId, setHouseholdId }}>
      {children}
    </HouseholdContext.Provider>
  );
}

export function useHousehold(): HouseholdContextValue {
  const ctx = useContext(HouseholdContext);
  if (!ctx) throw new Error('useHousehold must be used within HouseholdProvider');
  return ctx;
}
