'use client';

/**
 * Fused net-worth hero (teardown C11): the current number, its signed Δ and %
 * for the selected window, the window label, and the trend chart are ONE
 * unit — status adjacent to the number it qualifies (Law 8), never three
 * sibling cards that can disagree. Range pills (C10) drive number, Δ, % and
 * chart together by subsetting ONE fetched daily series client-side; a pill
 * whose window exceeds the household's real history is disabled with the
 * reason — KEEL never invents data. The as-of stamp of the underlying read
 * model sits under the number (Law 9: reproducible numbers).
 *
 * Money math is BigInt on minor units end-to-end (`lib/net-worth-window`);
 * red appears ONLY when the money delta is negative (Law 8).
 */

import { useMemo, useState } from 'react';

import { BalanceTrendChart } from '@/components/keel/charts';
import { Money } from '@/components/keel/money';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { isNegativeMinor } from '@/lib/money';
import {
  availableHistoryDays,
  computeWindowDelta,
  sliceWindow,
  TREND_FETCH_DAYS,
  TREND_RANGES,
} from '@/lib/net-worth-window';
import { useKeelQueryEnvelope } from '@/lib/use-keel-query';
import type { DailyBalanceRow } from '@/lib/keel-api';

/** "2026-07-17T12:34:56Z" → "2026-07-17 12:34 UTC" (display only). */
function asOfLabel(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function NetWorthHero({
  householdId,
  fallbackNetMinor,
  fallbackCurrency,
  fallbackMultiCurrency = false,
  fallbackAsOf,
  actions,
  entityScoped = false,
  scopeLabel,
}: {
  householdId: string | null;
  /** Trial-balance net worth in the selected primary currency. */
  fallbackNetMinor: string;
  fallbackCurrency: string;
  fallbackMultiCurrency?: boolean;
  /** asOf of the trial-balance envelope, stamped when the trend is absent. */
  fallbackAsOf?: string | null;
  /** Optional page actions rendered in the hero's top-right corner. */
  actions?: React.ReactNode;
  /** Entity-lens mode (persona theme #2): the passed `fallbackNetMinor` is one
   *  entity's net worth, not the household's. The daily trend read model
   *  (`dashboard.net_worth_daily`) is household-wide and can't be decomposed
   *  per entity client-side without a backend param, so in this mode the hero
   *  suppresses the trend/Δ entirely and shows just the scoped number — never
   *  a household trend next to an entity total, which would contradict each
   *  other (Law 9). */
  entityScoped?: boolean;
  /** Short scope note under the number when entity-scoped, e.g. "Acme LLC only". */
  scopeLabel?: string;
}) {
  // Stable for the whole mount so the query key never churns mid-session.
  const [from] = useState(() => isoDaysAgo(TREND_FETCH_DAYS));
  // Skip the household-wide trend fetch when entity-scoped — passing a null
  // householdId disables the query, so we never fetch a series we won't show.
  const trend = useKeelQueryEnvelope<DailyBalanceRow>(
    'dashboard.net_worth_daily',
    entityScoped ? null : householdId,
    { from },
  );
  const [selectedKey, setSelectedKey] = useState('90d');

  // The daily series is per-currency; the hero plots the same explicit
  // presentation currency as its fallback headline.
  const { points, multiCurrency } = useMemo(() => {
    const rows = trend?.rows ?? [];
    const currencies = new Set(rows.map((row) => row.currency));
    return {
      points: rows.filter((row) => row.currency === fallbackCurrency),
      multiCurrency: currencies.size > 1,
    };
  }, [fallbackCurrency, trend]);

  const historyDays = availableHistoryDays(points);
  // Shortest range is always offered (there is nothing shorter to fall back
  // to); longer pills need the history to actually cover them.
  const enabledRanges = TREND_RANGES.filter((r, i) => i === 0 || r.days <= historyDays);
  const shortest =
    TREND_RANGES[0] ?? { key: '30d', label: '30d', windowLabel: 'past 30 days', days: 30 };
  const active =
    enabledRanges.find((r) => r.key === selectedKey) ??
    enabledRanges[enabledRanges.length - 1] ??
    shortest;

  const windowPoints = sliceWindow(points, active.days);
  const delta = computeWindowDelta(windowPoints);
  const hasTrend = trend !== null && delta !== null;

  const currentMinor = delta?.lastMinor ?? fallbackNetMinor;
  const currency = windowPoints[windowPoints.length - 1]?.currency ?? fallbackCurrency;
  const asOf = hasTrend ? trend.asOf : (fallbackAsOf ?? null);
  const deltaNegative = delta !== null && isNegativeMinor(delta.deltaMinor);

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm text-muted-foreground">Net worth</p>
            {/* Number and Δ stack at 390px, sit on one baseline from sm up. */}
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
              <Money
                amountMinor={currentMinor}
                currency={currency}
                className="text-3xl font-semibold"
                muteZero={false}
              />
              {delta !== null ? (
                <span className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
                  <Money
                    amountMinor={delta.deltaMinor}
                    currency={currency}
                    signed
                    muteZero={false}
                  />
                  {delta.pctLabel !== null ? (
                    <span
                      className={`tabular-nums ${deltaNegative ? 'text-keel-negative' : 'text-muted-foreground'}`}
                    >
                      ({delta.pctLabel})
                    </span>
                  ) : null}
                  <span className="text-muted-foreground">{active.windowLabel}</span>
                </span>
              ) : null}
            </div>
            {asOf !== null ? (
              <p className="text-xs text-muted-foreground">
                As of {asOfLabel(asOf)}
                {multiCurrency || fallbackMultiCurrency ? ' · shown in primary currency only' : ''}
                {entityScoped && scopeLabel != null && scopeLabel !== ''
                  ? ` · ${scopeLabel}`
                  : ''}
              </p>
            ) : entityScoped && scopeLabel != null && scopeLabel !== '' ? (
              <p className="text-xs text-muted-foreground">{scopeLabel}</p>
            ) : null}
          </div>
          {actions !== undefined ? (
            <div className="flex flex-wrap justify-end gap-2">{actions}</div>
          ) : null}
        </div>

        {trend === null ? (
          <Skeleton className="h-[180px] w-full" />
        ) : hasTrend ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {TREND_RANGES.map((r) => {
                const enabled = enabledRanges.some((e) => e.key === r.key);
                const button = (
                  <Button
                    key={r.key}
                    variant={active.key === r.key ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-7 text-xs"
                    disabled={!enabled}
                    onClick={() => {
                      setSelectedKey(r.key);
                    }}
                  >
                    {r.label}
                  </Button>
                );
                // Disabled buttons swallow hover on some browsers — the
                // explanation rides a wrapping span so it always shows.
                return enabled ? (
                  button
                ) : (
                  <span
                    key={r.key}
                    title={`Only ${String(historyDays)} day${historyDays === 1 ? '' : 's'} of history — KEEL never invents data beyond it.`}
                  >
                    {button}
                  </span>
                );
              })}
            </div>
            <BalanceTrendChart points={windowPoints} height={180} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
