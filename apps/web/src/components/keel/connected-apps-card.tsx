'use client';

/**
 * Settings → Connected apps: the KEEL connector URL to paste into Claude /
 * Codex / ChatGPT, and every AI app the user has granted access, each with a
 * Disconnect. Revoking a grant in Supabase Auth deletes that client's sessions
 * and refresh tokens (prototype — docs/research/MCP-CONNECTOR-2026-11-04.md).
 *
 * When the deployment has not enabled the OAuth server, listGrants fails and
 * the card says so instead of showing a URL that would not work.
 */
import { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, Plug, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import type { OAuthGrant } from '@supabase/supabase-js';

import { getSupabaseBrowserClient } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function connectorUrl(): string {
  const override = process.env.NEXT_PUBLIC_KEEL_MCP_URL;
  if (override) return override;
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '');
  return `${base}/functions/v1/mcp`;
}

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly grants: readonly OAuthGrant[] };

export function ConnectedAppsCard() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data, error } = await getSupabaseBrowserClient().auth.oauth.listGrants();
      setState(error ? { kind: 'unavailable' } : { kind: 'ready', grants: data });
    } catch {
      setState({ kind: 'unavailable' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(clientId: string, name: string) {
    setRevoking(clientId);
    try {
      const { error } = await getSupabaseBrowserClient().auth.oauth.revokeGrant({ clientId });
      if (error) {
        toast.error('Could not disconnect that app.');
        return;
      }
      toast.success(`Disconnected ${name}.`);
      await load();
    } finally {
      setRevoking(null);
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
          Let Claude, Codex or ChatGPT read your KEEL data after you sign in and approve. They can never
          move money or change the ledger.
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
                <code>codex mcp add keel --url &lt;url&gt;</code> then <code>codex mcp login keel</code>.
              </p>
            </div>

            {state.grants.length === 0 ? (
              <p className="text-muted-foreground">No apps connected.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {state.grants.map((grant) => (
                  <li key={grant.client.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{grant.client.name || 'Unnamed app'}</div>
                      <div className="text-xs text-muted-foreground">
                        Connected {new Date(grant.granted_at).toLocaleDateString()}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={revoking !== null}
                      onClick={() => {
                        void revoke(grant.client.id, grant.client.name || 'the app');
                      }}
                    >
                      {revoking === grant.client.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Unplug data-icon="inline-start" />
                      )}
                      Disconnect
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
