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
    void (async () => {
      const { data } = await getSupabaseBrowserClient().auth.getSession();
      const uid = data.session?.user.id ?? null;
      let list: HouseholdMembership[] = [];
      try {
        list = await fetchHouseholds();
      } catch {
        list = [];
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
      if (!active) return;
      setUserId(uid);
      setHouseholds(list);
      const saved = window.localStorage.getItem(KEY);
      const chosen = list.find((h) => h.householdId === saved) ?? list[0];
      setHouseholdIdState(chosen?.householdId ?? null);
      setReady(true);
    })();
    return () => {
      active = false;
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
