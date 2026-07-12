'use client';

import { useState } from 'react';
import { Download, Loader2, KeyRound } from 'lucide-react';
import { toast } from 'sonner';

import { AppShell } from '@/components/keel/app-shell';
import { PageHeader } from '@/components/keel/page-header';
import { useHousehold } from '@/components/keel/household-context';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { exportHousehold, type ExportBundle } from '@/lib/keel-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Format = 'json' | 'qif' | 'beancount';

const FORMATS: { key: Format; label: string; ext: string; mime: string }[] = [
  { key: 'json', label: 'JSON', ext: 'json', mime: 'application/json' },
  { key: 'qif', label: 'QIF', ext: 'qif', mime: 'application/qif' },
  { key: 'beancount', label: 'Beancount', ext: 'beancount', mime: 'text/plain' },
];

function download(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function SettingsPage() {
  return (
    <AppShell>
      <PageHeader title="Settings" description="Account, household and data export." />
      <div className="max-w-2xl space-y-6 p-6">
        <HouseholdCard />
        <PasswordCard />
        <ExportCard />
      </div>
    </AppShell>
  );
}

function HouseholdCard() {
  const { households, householdId } = useHousehold();
  const current = households.find((h) => h.householdId === householdId);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Household</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Name</span>
          <span className="font-medium">{current?.name ?? '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Your role</span>
          <span className="font-medium capitalize">{current?.role ?? '—'}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(event: React.SyntheticEvent) {
    event.preventDefault();
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      const { error } = await getSupabaseBrowserClient().auth.updateUser({ password });
      if (error) toast.error(error.message);
      else {
        toast.success('Password updated. You can now sign in with it.');
        setPassword('');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4" />
          Set a password
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-muted-foreground">
          Set or change your password to sign in without a magic link.
        </p>
        <form
          onSubmit={(e) => {
            void save(e);
          }}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <div className="flex-1 space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
              minLength={8}
            />
          </div>
          <Button type="submit" disabled={busy || password.length < 8}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Save password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ExportCard() {
  const { householdId } = useHousehold();
  const [busy, setBusy] = useState<Format | null>(null);

  async function run(fmt: Format) {
    if (!householdId) return;
    setBusy(fmt);
    try {
      const bundle: ExportBundle = await exportHousehold(householdId);
      const spec = FORMATS.find((f) => f.key === fmt);
      if (!spec) return;
      const content = fmt === 'json' ? bundle.json : bundle[fmt];
      download(`keel-export.${spec.ext}`, spec.mime, content);
      toast.success(`Exported ${spec.label}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Export all data</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Your full financial record, any time — the exit door is a feature. Choose a format:
        </p>
        <div className="flex flex-wrap gap-2">
          {FORMATS.map((f) => (
            <Button
              key={f.key}
              variant="outline"
              size="sm"
              disabled={busy !== null || !householdId}
              onClick={() => {
                void run(f.key);
              }}
            >
              {busy === f.key ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              {f.label}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
