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

type Mode = 'signin' | 'signup';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (window.location.hash === '#signup') setMode('signup');
  }, []);

  const isSignup = mode === 'signup';

  async function submit(event: React.SyntheticEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    const client = getSupabaseBrowserClient();
    try {
      if (isSignup) {
        const { data, error } = await client.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/dashboard` },
        });
        if (error) {
          toast.error(error.message);
          return;
        }
        if (data.session) {
          router.replace('/dashboard');
        } else {
          toast.success('Account created. Check your email to confirm, then sign in.');
          setMode('signin');
        }
      } else {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) {
          toast.error(error.message);
          return;
        }
        router.replace('/dashboard');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Something went wrong.');
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
      const { error } = await getSupabaseBrowserClient().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/dashboard` },
      });
      if (error) toast.error(error.message);
      else toast.success('Magic link sent. Check your email.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to send a magic link.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handlePasswordReset() {
    if (!email) {
      toast.error('Enter your email first.');
      return;
    }
    setIsSubmitting(true);
    try {
      const { error } = await getSupabaseBrowserClient().auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) toast.error(error.message);
      else toast.success('Password reset link sent. Check your email.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to send a reset link.');
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
            <h1 className="text-2xl font-semibold tracking-tight">
              {isSignup ? 'Create your KEEL account' : 'Sign in to KEEL'}
            </h1>
            <p className="text-sm text-muted-foreground">
              {isSignup
                ? 'Start your financial system of record.'
                : 'Welcome back. Enter your details to continue.'}
            </p>
          </div>

          <form
            onSubmit={(e) => {
              void submit(e);
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
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                placeholder="••••••••"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                }}
                required
                minLength={8}
              />
            </div>

            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
              {isSignup ? 'Create account' : 'Sign in'}
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
            {!isSignup ? (
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={isSubmitting}
                onClick={() => {
                  void handlePasswordReset();
                }}
              >
                Forgot password?
              </Button>
            ) : null}
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {isSignup ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={() => {
                setMode(isSignup ? 'signin' : 'signup');
              }}
            >
              {isSignup ? 'Sign in' : 'Create one'}
            </button>
          </p>
        </div>
      </main>
    </div>
  );
}
