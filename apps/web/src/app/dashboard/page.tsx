'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';

import { getSupabaseBrowserClient } from '@/lib/supabase';
import { AppShell } from '@/components/keel/app-shell';
import { PageHeader } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type Health = 'checking' | 'ok' | 'error';

const metricPlaceholders = [
  { label: 'Net worth', value: '0' },
  { label: 'Assets', value: '0' },
  { label: 'Liabilities', value: '0' },
];

export default function HomePage() {
  const [health, setHealth] = useState<Health>('checking');

  useEffect(() => {
    void (async () => {
      try {
        const res: { error: unknown } = await getSupabaseBrowserClient().functions.invoke(
          'api/health',
          { method: 'GET' },
        );
        setHealth(res.error ? 'error' : 'ok');
      } catch {
        setHealth('error');
      }
    })();
  }, []);

  return (
    <AppShell>
      <PageHeader
        title="Home"
        description="Your financial position at a glance."
        actions={<HealthBadge health={health} />}
      />

      <div className="space-y-8 p-6">
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {metricPlaceholders.map((m) => (
            <Card key={m.label}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {m.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Money amountMinor={m.value} className="text-2xl font-semibold" muteZero={false} />
              </CardContent>
            </Card>
          ))}
        </section>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Welcome to KEEL</CardTitle>
          </CardHeader>
          <CardContent className="text-sm leading-relaxed text-muted-foreground">
            Your account is signed in and the backend is reachable. Balances, ledger and review
            surfaces are being wired to your live data next — each connects to the deterministic
            ledger, and every AI suggestion will wait for your approval.
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function HealthBadge({ health }: { health: Health }) {
  if (health === 'checking') {
    return (
      <Badge variant="secondary" className="gap-1.5">
        <Loader2 className="size-3 animate-spin" />
        Connecting
      </Badge>
    );
  }
  if (health === 'ok') {
    return (
      <Badge variant="secondary" className="gap-1.5 text-primary">
        <CheckCircle2 className="size-3" />
        Backend connected
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1.5 text-keel-negative">
      <XCircle className="size-3" />
      Backend unreachable
    </Badge>
  );
}
