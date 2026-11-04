'use client';

/**
 * Connected-app consent screen (MCP connector — supabase/functions/mcp/README.md).
 *
 * Supabase Auth's OAuth 2.1 server redirects here (its "authorization path")
 * with `?authorization_id=…` when an AI app (Claude, Codex, ChatGPT) asks to
 * connect. KEEL owns this screen: it shows who is asking and where access
 * would really go (app names are self-registered and unverified), lets the
 * user choose the household and read-only vs make-changes access, saves that
 * KEEL grant, and only then approves.
 *
 * Step-up (INFRA §7: issuing API/MCP tokens is high-risk): the KEEL sign-in
 * must be recent, otherwise the user signs in again first.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Ban, Eye, Loader2, PencilLine, ShieldCheck, TriangleAlert } from 'lucide-react';

import { getSupabaseBrowserClient } from '@/lib/supabase';
import { describeRedirectTarget, isRecentSignIn, type RedirectTarget } from '@/lib/oauth-consent';
import {
  fetchHouseholds,
  setConnectedAppAccess,
  type ConnectedAppAccess,
  type HouseholdMembership,
} from '@/lib/keel-api';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { KeelLogo } from '@/components/keel/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';

interface ConsentDetails {
  readonly authorizationId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly email: string;
  readonly target: RedirectTarget;
  readonly households: readonly HouseholdMembership[];
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

      const [{ data, error }, households] = await Promise.all([
        client.auth.oauth.getAuthorizationDetails(id),
        fetchHouseholds(),
      ]);
      if (cancelled) return;
      if (error) {
        setState({ kind: 'error', message: 'This sign-in request is invalid or has expired. Start again from your AI app.' });
        return;
      }
      if ('redirect_url' in data) {
        // Already approved earlier: Supabase hands back the code redirect.
        // The KEEL grant from that approval still applies (Settings → Connected apps).
        setState({ kind: 'redirecting' });
        window.location.assign(data.redirect_url);
        return;
      }
      if (households.length === 0) {
        setState({ kind: 'error', message: 'Finish setting up KEEL before connecting an app.' });
        return;
      }
      setState({
        kind: 'consent',
        details: {
          authorizationId: data.authorization_id,
          clientId: data.client.id,
          clientName: data.client.name || 'An unnamed app',
          email: data.user.email,
          target: describeRedirectTarget(data.redirect_uri, data.client.name || ''),
          households,
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
              onError={(message) => {
                setState({ kind: 'error', message });
              }}
              onRedirect={(url) => {
                setState({ kind: 'redirecting' });
                window.location.assign(url);
              }}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function ChoiceButton({
  selected,
  onSelect,
  title,
  detail,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'w-full rounded-lg border px-3 py-2 text-left transition-colors',
        selected ? 'border-primary bg-primary/5' : 'hover:bg-secondary/40',
      )}
    >
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-muted-foreground">{detail}</div>
    </button>
  );
}

function ConsentCard({
  details,
  onError,
  onRedirect,
}: {
  details: ConsentDetails;
  onError: (message: string) => void;
  onRedirect: (url: string) => void;
}) {
  const { target } = details;
  const blocked = target.kind === 'invalid';
  const [access, setAccess] = useState<ConnectedAppAccess>('read');
  // households is non-empty here: the loader shows an error instead of this card otherwise.
  const [householdId, setHouseholdId] = useState(details.households[0]?.householdId ?? '');
  const [deciding, setDeciding] = useState<'approve' | 'deny' | null>(null);

  async function decide(decision: 'approve' | 'deny') {
    setDeciding(decision);
    const client = getSupabaseBrowserClient();
    try {
      if (decision === 'approve') {
        // KEEL's grant first: an approved app with no grant would have no access.
        await setConnectedAppAccess({ clientId: details.clientId, householdId, access });
      }
      const { data, error } =
        decision === 'approve'
          ? await client.auth.oauth.approveAuthorization(details.authorizationId, { skipBrowserRedirect: true })
          : await client.auth.oauth.denyAuthorization(details.authorizationId, { skipBrowserRedirect: true });
      if (error) throw error;
      onRedirect(data.redirect_url);
    } catch {
      onError('Could not record your decision. Start again from your AI app.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Connect &ldquo;{details.clientName}&rdquo; to KEEL?</CardTitle>
        <CardDescription>
          Signed in as <span className="font-medium text-foreground">{details.email}</span>. Access goes to{' '}
          <span className="font-medium text-foreground">{target.label}</span>.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 text-sm">
        {target.warning ? (
          <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p>{target.warning}</p>
          </div>
        ) : null}

        {details.households.length > 1 ? (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Household</div>
            {details.households.map((h) => (
              <ChoiceButton
                key={h.householdId}
                selected={h.householdId === householdId}
                onSelect={() => {
                  setHouseholdId(h.householdId);
                }}
                title={h.name}
                detail={`You are ${h.role === 'owner' ? 'the owner' : `a ${h.role}`}`}
              />
            ))}
          </div>
        ) : null}

        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Access</div>
          <ChoiceButton
            selected={access === 'read'}
            onSelect={() => {
              setAccess('read');
            }}
            title="Read only"
            detail="See accounts, transactions, budgets, recurring bills, investments and more."
          />
          <ChoiceButton
            selected={access === 'write'}
            onSelect={() => {
              setAccess('write');
            }}
            title="Read and make changes"
            detail="Also categorize, split, add and edit transactions, accounts, budgets, rules, bills, goals, notes and tasks."
          />
        </div>

        <ul className="space-y-3">
          <li className="flex gap-3">
            <Eye className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>Everything it does runs as you, inside this household only.</span>
          </li>
          {access === 'write' ? (
            <li className="flex gap-3">
              <PencilLine className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>Every change is logged as made by this app and can be reversed.</span>
            </li>
          ) : null}
          <li className="flex gap-3">
            <Ban className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-medium">Never</span> moves money, connects or disconnects banks, or exports
              your data.
            </span>
          </li>
          <li className="flex gap-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>Change or remove its access any time in Settings → Connected apps.</span>
          </li>
        </ul>
      </CardContent>

      <CardFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          variant="outline"
          className="w-full sm:w-auto"
          disabled={deciding !== null}
          onClick={() => {
            void decide('deny');
          }}
        >
          {deciding === 'deny' ? <Loader2 className="size-4 animate-spin" /> : null}
          Deny
        </Button>
        <Button
          className="w-full sm:w-auto"
          disabled={deciding !== null || blocked}
          onClick={() => {
            void decide('approve');
          }}
        >
          {deciding === 'approve' ? <Loader2 className="size-4 animate-spin" /> : null}
          Allow access
        </Button>
      </CardFooter>
    </Card>
  );
}
