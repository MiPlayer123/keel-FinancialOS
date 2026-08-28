'use client';

import { useEffect, useState } from 'react';
import { Download, Loader2, KeyRound } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/keel/page-header';
import { useHousehold } from '@/components/keel/household-context';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import {
  exportHousehold,
  fetchAuditLog,
  keelCommand,
  newId,
  type AuditLogRow,
  type ExportBundle,
} from '@/lib/keel-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RulesCard } from '@/components/keel/rules-card';
import { CategoriesCard } from '@/components/keel/categories-card';

type Format = 'csv' | 'json' | 'qif' | 'beancount';

// Law 6 names CSV first among the guaranteed export formats (CSV/JSON/QIF/beancount).
const FORMATS: { key: Format; label: string; ext: string; mime: string }[] = [
  { key: 'csv', label: 'CSV', ext: 'csv', mime: 'text/csv' },
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
    <>
      <PageHeader title="Settings" description="Account, household and data export." />
      <div className="max-w-2xl space-y-6 p-6">
        <HouseholdCard />
        <CategoriesCard />
        <RulesCard />
        <PasswordCard />
        <ExportCard />
        <ActivityCard />
      </div>
    </>
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
      // CSV is one file per table (CsvFile[] from toCsvFiles); concatenate
      // into a single download with a section marker per table, matching the
      // one-click behavior of the other formats.
      const content =
        fmt === 'json'
          ? bundle.json
          : fmt === 'csv'
            ? bundle.csv.map((f) => `# ${f.name}\r\n${f.csv}`).join('\r\n')
            : bundle[fmt];
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
          Download the structured financial records supported by the current export endpoint:
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
        <p className="text-xs text-muted-foreground">
          CSV for spreadsheets · JSON for the complete structured bundle · QIF and Beancount
          for other finance tools. Uploaded source files remain separate stored objects.
        </p>
      </CardContent>
    </Card>
  );
}

/** Human labels for audit actions; unknown actions fall back to the raw name. */
const ACTION_LABELS: Record<string, string> = {
  'transaction.categorize': 'Changed a category',
  'transaction.override': 'Renamed a transaction / edited a note',
  'transactions.autocategorize': 'Auto-categorized new transactions',
  'transfers.detect': 'Suggested transfer matches',
  'transfers.decide': 'Decided a transfer match',
  'accounts.created': 'Created an account',
  'journal.batch_posted': 'Posted a journal entry',
};

function actorLabel(actor: AuditLogRow['actor']): string {
  if (!actor) return '';
  if (actor.kind === 'system') return 'KEEL (automatic)';
  if (actor.kind === 'user') return 'You';
  return actor.kind ?? '';
}

/**
 * Recent audit-log entries — every mutation, human or automatic, is in the
 * append-only trail (Law 2). This is the visible slice of that trust surface.
 */
function ActivityCard() {
  const { householdId, userId } = useHousehold();
  const [rows, setRows] = useState<AuditLogRow[] | null>(null);
  const [reversing, setReversing] = useState<string | null>(null);

  useEffect(() => {
    if (!householdId) return;
    let active = true;
    fetchAuditLog(householdId, 20)
      .then((r) => {
        if (active) setRows(r);
      })
      .catch(() => {
        if (active) setRows([]);
      });
    return () => {
      active = false;
    };
  }, [householdId]);

  if (rows === null || rows.length === 0) return null;

  async function reverseBatch(row: AuditLogRow) {
    if (!householdId || !userId || !row.objectId) return;
    const commandId = newId();
    setReversing(row.id.toString());
    try {
      await keelCommand({
        commandId,
        command: 'journal.reverse_batch',
        economicEventKey: `journal.reverse_batch:${row.objectId}`,
        actor: { kind: 'user', userId },
        householdId,
        payload: {
          batchId: row.objectId,
          reason: 'User undo from activity log',
        },
      });
      toast.success('Journal batch reversed.');
      setRows(await fetchAuditLog(householdId, 20));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reverse this journal batch.');
    } finally {
      setReversing(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent activity</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">
          Every change — yours or KEEL&apos;s — is recorded in an append-only audit trail. The most
          recent entries:
        </p>
        <div className="space-y-2">
          {rows.map((r) => {
            const canUndo =
              r.action === 'journal.batch_posted' && r.objectType === 'journal_batch' && r.objectId;
            return (
              <div key={r.id} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  {ACTION_LABELS[r.action] ?? r.action}
                  <span className="text-muted-foreground"> · {actorLabel(r.actor)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {canUndo ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={reversing === r.id.toString()}
                      onClick={() => {
                        void reverseBatch(r);
                      }}
                    >
                      {reversing === r.id.toString() ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : null}
                      Undo
                    </Button>
                  ) : null}
                  <span className="font-mono text-xs text-muted-foreground">
                    {r.at.slice(0, 16).replace('T', ' ')}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
