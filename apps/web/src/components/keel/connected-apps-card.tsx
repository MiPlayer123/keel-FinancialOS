'use client';

/**
 * Settings → Connected apps: the connector URL to paste into Claude / Codex /
 * ChatGPT, and every AI app the user connected — with its household and
 * access (read only or read + changes), a switch between the two, and
 * Disconnect. Disconnect revokes both halves: Supabase's OAuth grant (its
 * sessions and refresh tokens) and KEEL's grant (soft-revoked, audited).
 *
 * When the deployment has not enabled the OAuth server, listGrants fails and
 * the card says so instead of showing a URL that would not work.
 */
import { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, Plug, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import type { OAuthGrant } from '@supabase/supabase-js';

import { getSupabaseBrowserClient } from '@/lib/supabase';
import {
  fetchConnectedAppGrants,
  fetchHouseholds,
  revokeConnectedAppAccess,
  setConnectedAppAccess,
  type ConnectedAppAccess,
  type ConnectedAppGrant,
  type HouseholdMembership,
} from '@/lib/keel-api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function connectorUrl(): string {
  const override = process.env.NEXT_PUBLIC_KEEL_MCP_URL;
  if (override) return override;
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '');
  return `${base}/functions/v1/mcp`;
}

interface AppRow {
  readonly oauth: OAuthGrant;
  readonly keel: ConnectedAppGrant | null;
}

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly apps: readonly AppRow[]; readonly households: readonly HouseholdMembership[] };

const ACCESS_LABEL: Record<ConnectedAppAccess, string> = {
  read: 'Read only',
  write: 'Read and make changes',
};

export function ConnectedAppsCard() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data, error } = await getSupabaseBrowserClient().auth.oauth.listGrants();
      if (error) {
        setState({ kind: 'unavailable' });
        return;
      }
      const [grants, households] = await Promise.all([fetchConnectedAppGrants(), fetchHouseholds()]);
      const byClient = new Map(grants.map((g) => [g.clientId, g]));
      setState({
        kind: 'ready',
        apps: data.map((oauth) => ({ oauth, keel: byClient.get(oauth.client.id) ?? null })),
        households,
      });
    } catch {
      setState({ kind: 'unavailable' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(clientId: string, action: () => Promise<unknown>, success: string) {
    setBusy(clientId);
    try {
      await action();
      toast.success(success);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  const url = connectorUrl();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Plug className="size-4 text-muted-foreground" />
          Connected apps
        </CardTitle>
        <CardDescription>
          Let Claude, Codex or ChatGPT read your KEEL data, and make changes if you allow it. They can never move
          money or connect banks.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {state.kind === 'loading' ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : null}

        {state.kind === 'unavailable' ? (
          <p className="text-muted-foreground">AI app connections aren&apos;t turned on for this KEEL yet.</p>
        ) : null}

        {state.kind === 'ready' ? (
          <>
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">Connector URL</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border bg-secondary/30 px-2 py-1.5 text-xs">
                  {url}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(url).then(
                      () => toast.success('Copied.'),
                      () => toast.error('Copy failed.'),
                    );
                  }}
                >
                  <Copy data-icon="inline-start" />
                  Copy
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Claude: Settings → Connectors → Add custom connector. Claude Code:{' '}
                <code>claude mcp add --transport http keel &lt;url&gt;</code>. Codex:{' '}
                <code>codex mcp add keel --url &lt;url&gt;</code>, then <code>codex mcp login keel</code>.
              </p>
            </div>

            {state.apps.length === 0 ? (
              <p className="text-muted-foreground">No apps connected.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {state.apps.map(({ oauth, keel }) => {
                  const clientId = oauth.client.id;
                  const name = oauth.client.name || 'Unnamed app';
                  const household = state.households.find((h) => h.householdId === keel?.householdId);
                  const nextAccess: ConnectedAppAccess = keel?.access === 'write' ? 'read' : 'write';
                  return (
                    <li key={clientId} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{name}</div>
                        <div className="text-xs text-muted-foreground">
                          {keel ? ACCESS_LABEL[keel.access] : 'No KEEL access chosen'}
                          {keel && state.households.length > 1 ? ` · ${household?.name ?? 'Household'}` : ''}
                          {' · '}since {new Date(oauth.granted_at).toLocaleDateString()}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => {
                            void run(
                              clientId,
                              () =>
                                setConnectedAppAccess({
                                  clientId,
                                  householdId: keel?.householdId ?? state.households[0]?.householdId ?? '',
                                  access: keel ? nextAccess : 'read',
                                }),
                              `${name} can now ${keel && nextAccess === 'write' ? 'make changes' : 'only read'}.`,
                            );
                          }}
                        >
                          {keel ? (nextAccess === 'write' ? 'Allow changes' : 'Make read only') : 'Allow read only'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => {
                            void run(
                              clientId,
                              async () => {
                                const { error } = await getSupabaseBrowserClient().auth.oauth.revokeGrant({ clientId });
                                if (error) throw new Error('Could not disconnect that app.');
                                await revokeConnectedAppAccess(clientId);
                              },
                              `Disconnected ${name}.`,
                            );
                          }}
                        >
                          {busy === clientId ? <Loader2 className="size-4 animate-spin" /> : <Unplug data-icon="inline-start" />}
                          Disconnect
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
