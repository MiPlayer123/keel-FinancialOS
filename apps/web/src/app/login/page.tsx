'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { getSupabaseBrowserClient } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { KeelLogo } from '@/components/keel/logo';
import { ThemeToggle } from '@/components/theme-toggle';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLocalhost, setIsLocalhost] = useState(false);

  useEffect(() => {
    const host = window.location.hostname;
    setIsLocalhost(host === 'localhost' || host === '127.0.0.1');
  }, []);

  async function handleSignIn(event: React.SyntheticEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    try {
      const { error } = await getSupabaseBrowserClient().auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      router.replace('/dashboard');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to sign in.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleMagicLink() {
    if (!email) {
      toast.error('Enter your email first.');
      return;
    }
    setIsSubmitting(true);
    try {
      const { error } = await getSupabaseBrowserClient().auth.signInWithOtp({ email });
      if (error) toast.error(error.message);
      else toast.success('Magic link sent. Check your email.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to send a magic link.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
        <Link href="/">
          <KeelLogo />
        </Link>
        <ThemeToggle />
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">Sign in to KEEL</h1>
            <p className="text-sm text-muted-foreground">
              Welcome back. Enter your details to continue.
            </p>
          </div>

          <form
            onSubmit={(e) => {
              void handleSignIn(e);
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                }}
                required
              />
            </div>

            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
              Sign in
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={isSubmitting}
              onClick={() => {
                void handleMagicLink();
              }}
            >
              Email me a magic link
            </Button>
          </form>

          {isLocalhost ? (
            <p className="mt-8 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              Local dev:{' '}
              <code className="font-mono text-foreground">alex@keel.local</code> /{' '}
              <code className="font-mono text-foreground">keel-local-dev-password</code>
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
