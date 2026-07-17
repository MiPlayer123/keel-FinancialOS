'use client';

import { useEffect, useMemo, useState } from 'react';
import { Activity, X } from 'lucide-react';

import type { QueryDiagnostics } from '@/lib/keel-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

type TimingRow = QueryDiagnostics & {
  id: number;
  seenAt: string;
};

const PERF_KEY = 'keel:perf';
const MAX_ROWS = 12;

function enabledFromStorage(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(PERF_KEY) === '1';
}

function msLabel(value: number | undefined): string {
  return typeof value === 'number' ? `${String(value)}ms` : '—';
}

function tone(value: number | undefined): string {
  if (value === undefined) return 'text-muted-foreground';
  if (value >= 1000) return 'text-destructive';
  if (value >= 400) return 'text-amber-500';
  return 'text-emerald-500';
}

export function QueryTimingPanel() {
  const [enabled, setEnabled] = useState(false);
  const [rows, setRows] = useState<TimingRow[]>([]);

  useEffect(() => {
    setEnabled(enabledFromStorage());
  }, []);

  useEffect(() => {
    if (!enabled) return;

    function onTiming(event: Event) {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as QueryDiagnostics | undefined;
      if (!detail?.query) return;
      setRows((prev) =>
        [
          {
            ...detail,
            id: Date.now(),
            seenAt: new Date().toLocaleTimeString(),
          },
          ...prev,
        ].slice(0, MAX_ROWS),
      );
    }

    window.addEventListener('keel:query-timing', onTiming);
    return () => {
      window.removeEventListener('keel:query-timing', onTiming);
    };
  }, [enabled]);

  const slowest = useMemo(
    () =>
      rows.reduce<TimingRow | null>((best, row) => {
        if (best === null) return row;
        return (row.clientMs ?? 0) > (best.clientMs ?? 0) ? row : best;
      }, null),
    [rows],
  );

  if (!enabled) return null;

  return (
    <Card className="fixed bottom-4 right-4 z-50 hidden w-[28rem] max-w-[calc(100vw-2rem)] shadow-xl lg:block">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="size-4 text-muted-foreground" />
            Query timings
            <Badge variant="secondary">local</Badge>
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Showing `keel:query-timing` events because {PERF_KEY}=1.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Hide query timing panel"
          onClick={() => {
            window.localStorage.removeItem(PERF_KEY);
            setEnabled(false);
            setRows([]);
          }}
        >
          <X className="size-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {slowest ? (
          <div className="rounded-md border bg-secondary/25 px-3 py-2 text-xs">
            <span className="text-muted-foreground">Slowest this session</span>{' '}
            <span className="font-medium text-foreground">{slowest.query}</span>{' '}
            <span className={cn('font-mono', tone(slowest.clientMs))}>
              {msLabel(slowest.clientMs)} client
            </span>
          </div>
        ) : null}
        <div className="max-h-80 overflow-y-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr className="border-b">
                <th className="px-2 py-1.5 text-left font-medium">Query</th>
                <th className="px-2 py-1.5 text-right font-medium">Client</th>
                <th className="px-2 py-1.5 text-right font-medium">Edge</th>
                <th className="px-2 py-1.5 text-right font-medium">RPC</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-2 py-6 text-center text-muted-foreground">
                    Navigate or refresh a dashboard page to collect timings.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td
                      className="max-w-48 truncate px-2 py-1.5"
                      title={`${row.query} · ${row.seenAt}`}
                    >
                      {row.query}
                    </td>
                    <td className={cn('px-2 py-1.5 text-right font-mono', tone(row.clientMs))}>
                      {msLabel(row.clientMs)}
                    </td>
                    <td className={cn('px-2 py-1.5 text-right font-mono', tone(row.edgeMs))}>
                      {msLabel(row.edgeMs)}
                    </td>
                    <td className={cn('px-2 py-1.5 text-right font-mono', tone(row.rpcMs))}>
                      {msLabel(row.rpcMs)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
