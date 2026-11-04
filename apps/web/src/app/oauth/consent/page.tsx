'use client';

/**
 * AI-connector consent screen (prototype — docs/research/MCP-CONNECTOR-2026-11-04.md).
 *
 * Supabase Auth's OAuth 2.1 server redirects here (its "authorization path")
 * with `?authorization_id=…` when an MCP client — Claude, Codex, ChatGPT —
 * asks to connect to the user's KEEL. KEEL, not Supabase, owns this screen:
 * it shows who is asking, exactly where access would be sent, what the
 * connection can and cannot do, and only then approves or denies.
 *
 * Step-up (INFRA §7: issuing API/MCP tokens is high-risk): the KEEL sign-in
 * must be recent, otherwise the user signs in again first.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Ban, Eye, Loader2, NotebookPen, ShieldCheck, TriangleAlert } from 'lucide-react';

import { getSupabaseBrowserClient } from '@/lib/supabase';
import { describeRedirectTarget, isRecentSignIn, type RedirectTarget } from '@/lib/oauth-consent';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { KeelLogo } from '@/components/keel/logo';
import { ThemeToggle } from '@/components/theme-toggle';

interface ConsentDetails {
  readonly authorizationId: string;
  readonly clientName: string;
  readonly email: string;
  readonly target: RedirectTarget;
}

type ViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'consent'; readonly details: ConsentDetails }
  | { readonly kind: 'redirecting' };

const loginUrl = (authorizationId: string, reauth: boolean): string => {
  const next = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;
  return `/login?next=${encodeURIComponent(next)}${reauth ? '&reauth=1' : ''}`;
};

export default function OAuthConsentPage() {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [deciding, setDeciding] = useState<'approve' | 'deny' | null>(null);

  useEffect(() => {
    let cancelled = false;
    const authorizationId = new URLSearchParams(window.location.search).get('authorization_id');

    async function load(id: string) {
      const client = getSupabaseBrowserClient();
      const { data: sessionData } = await client.auth.getSession();
      const session = sessionData.session;
      if (!session) {
        window.location.replace(loginUrl(id, false));
        return;
      }
      if (!isRecentSignIn(session.user.last_sign_in_at, new Date())) {
        window.location.replace(loginUrl(id, true));
        return;
      }

      const { data, error } = await client.auth.oauth.getAuthorizationDetails(id);
      if (cancelled) return;
      if (error) {
        setState({ kind: 'error', message: 'This sign-in request is invalid or has expired. Start again from your AI app.' });
        return;
      }
      if ('redirect_url' in data) {
        // Already consented earlier: Supabase hands back the code redirect.
        setState({ kind: 'redirecting' });
        window.location.assign(data.redirect_url);
        return;
      }
      setState({
        kind: 'consent',
        details: {
          authorizationId: data.authorization_id,
          clientName: data.client.name || 'An unnamed app',
          email: data.user.email,
          target: describeRedirectTarget(data.redirect_uri, data.client.name || ''),
        },
      });
    }

    if (!authorizationId) {
      setState({ kind: 'error', message: 'Missing sign-in request. Start again from your AI app.' });
    } else {
      load(authorizationId).catch(() => {
        if (!cancelled) setState({ kind: 'error', message: 'Could not load this sign-in request.' });
      });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  async function decide(details: ConsentDetails, decision: 'approve' | 'deny') {
    setDeciding(decision);
    const client = getSupabaseBrowserClient();
    const { data, error } =
      decision === 'approve'
        ? await client.auth.oauth.approveAuthorization(details.authorizationId, { skipBrowserRedirect: true })
        : await client.auth.oauth.denyAuthorization(details.authorizationId, { skipBrowserRedirect: true });
    if (error) {
      setDeciding(null);
      setState({ kind: 'error', message: 'Could not record your decision. Start again from your AI app.' });
      return;
    }
    setState({ kind: 'redirecting' });
    window.location.assign(data.redirect_url);
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-5 sm:px-6">
        <Link href="/">
          <KeelLogo />
        </Link>
        <ThemeToggle />
      </header>

      <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:px-6">
        <div className="w-full max-w-md">
          {state.kind === 'loading' || state.kind === 'redirecting' ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {state.kind === 'loading' ? 'Checking the request…' : 'Returning you to your app…'}
            </div>
          ) : null}

          {state.kind === 'error' ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Can&apos;t connect</CardTitle>
                <CardDescription>{state.message}</CardDescription>
              </CardHeader>
              <CardFooter>
                <Link href="/dashboard" className={buttonVariants({ variant: 'outline' })}>
                  Go to KEEL
                </Link>
              </CardFooter>
            </Card>
          ) : null}

          {state.kind === 'consent' ? (
            <ConsentCard
              details={state.details}
              deciding={deciding}
              onDecide={(decision) => {
                void decide(state.details, decision);
              }}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function ConsentCard({
  details,
  deciding,
  onDecide,
}: {
  details: ConsentDetails;
  deciding: 'approve' | 'deny' | null;
  onDecide: (decision: 'approve' | 'deny') => void;
}) {
  const { target } = details;
  const blocked = target.kind === 'invalid';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Connect &ldquo;{details.clientName}&rdquo; to KEEL?</CardTitle>
        <CardDescription>
          Signed in as <span className="font-medium text-foreground">{details.email}</span>. Access goes to{' '}
          <span className="font-medium text-foreground">{target.label}</span>.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4 text-sm">
        {target.warning ? (
          <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p>{target.warning}</p>
          </div>
        ) : null}

        <ul className="space-y-3">
          <li className="flex gap-3">
            <Eye className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-medium">Read your household&apos;s finances</span> — accounts, balances,
              transactions, budgets, recurring bills, paychecks, investments and statements.
            </span>
          </li>
          <li className="flex gap-3">
            <NotebookPen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-medium">Notes and tasks</span> — if enabled for this connector, add and edit
              them. Every change is logged and can be undone.
            </span>
          </li>
          <li className="flex gap-3">
            <Ban className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-medium">Never</span> move money, change the ledger, approve suggestions,
              export everything, or touch your bank connections.
            </span>
          </li>
          <li className="flex gap-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>You can disconnect it any time in Settings → Connected apps.</span>
          </li>
        </ul>
      </CardContent>

      <CardFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          variant="outline"
          className="w-full sm:w-auto"
          disabled={deciding !== null}
          onClick={() => {
            onDecide('deny');
          }}
        >
          {deciding === 'deny' ? <Loader2 className="size-4 animate-spin" /> : null}
          Deny
        </Button>
        <Button
          className="w-full sm:w-auto"
          disabled={deciding !== null || blocked}
          onClick={() => {
            onDecide('approve');
          }}
        >
          {deciding === 'approve' ? <Loader2 className="size-4 animate-spin" /> : null}
          Allow access
        </Button>
      </CardFooter>
    </Card>
  );
}
