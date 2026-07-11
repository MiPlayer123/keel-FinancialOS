'use client';

import { type FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

import { getSupabaseBrowserClient } from '../lib/supabase';

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setIsSubmitting(true);

    try {
      const { data, error } = await getSupabaseBrowserClient().auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setMessage(error.message);
        return;
      }

      if (!data.session) {
        setMessage('Sign-in completed without a session. Check your Supabase Auth configuration.');
        return;
      }

      router.replace('/dashboard');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to sign in.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleMagicLink() {
    setMessage(null);
    setIsSubmitting(true);

    try {
      const { error } = await getSupabaseBrowserClient().auth.signInWithOtp({ email });

      setMessage(error ? error.message : 'Magic link sent. Check your email.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to send a magic link.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="shell shell--centered">
      <section className="panel auth-panel" aria-labelledby="sign-in-heading">
        <div className="stage-label">KEEL · Stage 1A engineering shell</div>
        <div className="panel-body">
          <p className="eyebrow">Authentication smoke test</p>
          <h1 id="sign-in-heading">Sign in to KEEL</h1>
          <p className="lede">
            Use a local development account to verify Auth and Edge Function access.
          </p>

          <form
            onSubmit={(event) => {
              void handleSignIn(event);
            }}
          >
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />

            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />

            {message ? (
              <p className="message" role="status">
                {message}
              </p>
            ) : null}

            <div className="button-row">
              <button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Working…' : 'Sign in'}
              </button>
              <button
                className="button-secondary"
                type="button"
                onClick={() => {
                  void handleMagicLink();
                }}
                disabled={isSubmitting || !email}
              >
                Send magic link
              </button>
            </div>
          </form>

          <p className="dev-hint">
            Local example: <code>alex@keel.local</code> / <code>keel-local-dev-password</code>
          </p>
        </div>
      </section>
    </main>
  );
}
