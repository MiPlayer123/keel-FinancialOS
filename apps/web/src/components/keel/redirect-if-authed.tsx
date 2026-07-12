'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowserClient } from '@/lib/supabase';

/**
 * On public pages (landing), send already-signed-in users straight to the app.
 * Also handles magic-link/confirm redirects that land on `/` with a token in the URL
 * hash — supabase-js establishes the session, then we forward to the dashboard.
 */
export function RedirectIfAuthed() {
  const router = useRouter();
  useEffect(() => {
    const client = getSupabaseBrowserClient();
    void client.auth.getSession().then(({ data }) => {
      if (data.session) router.replace('/dashboard');
    });
    const { data: sub } = client.auth.onAuthStateChange((_event, session) => {
      if (session) router.replace('/dashboard');
    });
    return () => {
      sub.subscription.unsubscribe();
    };
  }, [router]);
  return null;
}
