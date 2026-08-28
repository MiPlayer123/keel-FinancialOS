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
    const hashType = new URLSearchParams(window.location.hash.slice(1)).get('type');
    void client.auth.getSession().then(({ data }) => {
      if (hashType === 'recovery') router.replace('/reset-password');
      else if (data.session) router.replace('/dashboard');
    });
    const { data: sub } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') router.replace('/reset-password');
      else if (session) router.replace('/dashboard');
    });
    return () => {
      sub.subscription.unsubscribe();
    };
  }, [router]);
  return null;
}
