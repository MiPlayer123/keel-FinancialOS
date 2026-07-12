'use client';

import { AppShell } from '@/components/keel/app-shell';
import { PageHeader } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const metricPlaceholders = [
  { label: 'Net worth', value: '0' },
  { label: 'Assets', value: '0' },
  { label: 'Liabilities', value: '0' },
];

export default function HomePage() {
  return (
    <AppShell>
      <PageHeader title="Home" description="Your financial position at a glance." />

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
            Balances, ledger and review surfaces are being wired to your live data — each
            connects to the deterministic ledger, and every AI suggestion waits for your approval.
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
