'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { KeelLogo } from '@/components/keel/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getSupabaseBrowserClient } from '@/lib/supabase';

export default function ResetPasswordPage() {
  const router = useRouter();
  const [recoveryState, setRecoveryState] = useState<'checking' | 'valid' | 'invalid'>(
    'checking',
  );
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [linkSent, setLinkSent] = useState(false);

  useEffect(() => {
    const client = getSupabaseBrowserClient();
    const markerKey = 'keel-password-recovery';
    const hashType = new URLSearchParams(window.location.hash.slice(1)).get('type');
    if (hashType === 'recovery') {
      window.sessionStorage.setItem(markerKey, String(Date.now()));
    }

    const hasFreshMarker = () => {
      const markedAt = Number(window.sessionStorage.getItem(markerKey));
      const fresh = Number.isFinite(markedAt) && Date.now() - markedAt < 60 * 60 * 1000;
      if (!fresh) window.sessionStorage.removeItem(markerKey);
      return fresh;
    };
    let active = true;
    const { data: subscription } = client.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === 'PASSWORD_RECOVERY') {
        window.sessionStorage.setItem(markerKey, String(Date.now()));
        setRecoveryState(session ? 'valid' : 'invalid');
      } else if (event === 'SIGNED_OUT') {
        setRecoveryState('invalid');
      }
    });
    void client.auth.getSession().then(({ data }) => {
      if (active) setRecoveryState(data.session && hasFreshMarker() ? 'valid' : 'invalid');
    });
    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  async function submit(event: React.SyntheticEvent) {
    event.preventDefault();
    if (password !== confirmation) {
      toast.error('Passwords do not match.');
      return;
    }
    setIsSubmitting(true);
    try {
      const { error } = await getSupabaseBrowserClient().auth.updateUser({ password });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success('Password updated.');
      window.sessionStorage.removeItem('keel-password-recovery');
      router.replace('/dashboard');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update your password.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function requestAnotherLink(event: React.SyntheticEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    try {
      const { error } = await getSupabaseBrowserClient().auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      setLinkSent(true);
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
          {recoveryState === 'checking' ? (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Checking your reset link…
            </div>
          ) : recoveryState === 'invalid' ? (
            <>
              <div className="mb-8 flex flex-col gap-1.5">
                <h1 className="text-2xl font-semibold tracking-tight">
                  This reset link is invalid or expired
                </h1>
                <p className="text-sm text-muted-foreground">
                  Enter your email to request a new password reset link.
                </p>
              </div>
              {linkSent ? (
                <p role="status" className="rounded-lg border bg-card p-4 text-sm">
                  Check your email for a new reset link.
                </p>
              ) : (
                <form
                  className="flex flex-col gap-4"
                  onSubmit={(event) => {
                    void requestAnotherLink(event);
                  }}
                >
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="recovery-email">Email</Label>
                    <Input
                      id="recovery-email"
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value);
                      }}
                    />
                  </div>
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting ? (
                      <Loader2 data-icon="inline-start" className="animate-spin" />
                    ) : null}
                    Send a new reset link
                  </Button>
                </form>
              )}
              <Button variant="link" className="mt-4 w-full" render={<Link href="/login" />}>
                Back to sign in
              </Button>
            </>
          ) : (
            <>
          <div className="mb-8 flex flex-col gap-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
            <p className="text-sm text-muted-foreground">
              Use at least eight characters.
            </p>
          </div>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmation">Confirm password</Label>
              <Input
                id="confirmation"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={confirmation}
                onChange={(event) => {
                  setConfirmation(event.target.value);
                }}
              />
            </div>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
              Update password
            </Button>
          </form>
          <Button variant="link" className="mt-4 w-full" render={<Link href="/login" />}>
            Back to sign in
          </Button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
