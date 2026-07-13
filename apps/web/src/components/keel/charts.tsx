'use client';

/**
 * KEEL chart primitives (recharts, shadcn-styled). Financial calm: one hue
 * for single-series trends, an emerald/indigo pair for inflow/outflow
 * (validated for CVD separation + contrast in both modes — see NOTES.md;
 * red stays reserved for negative money, Law 8). Geometry uses Number for
 * pixel scaling only — every LABEL formats from the original BIGINT minor
 * string (Law 4); no ledger arithmetic happens here (Law 1).
 */

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatMoney } from '@/lib/money';

/** Pixel-scale value for chart geometry only; labels never use this. */
function toGeometry(amountMinor: string): number {
  return Number(amountMinor) / 100;
}

function compactAxis(dollars: number): string {
  return Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(dollars);
}

function monthLabel(isoMonth: string): string {
  const [y = '', m = ''] = isoMonth.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const idx = Number(m) - 1;
  return `${names[idx] ?? m} ${y.slice(2)}`;
}

const GRID = 'var(--border)';
const INK_MUTED = 'var(--muted-foreground)';

function TooltipShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      {children}
    </div>
  );
}

export type BalancePoint = { date: string; balanceMinor: string; currency: string };

/** Single-series balance/net-worth trend. One hue, crosshair tooltip. */
export function BalanceTrendChart({ points, height = 200 }: { points: BalancePoint[]; height?: number }) {
  const data = points.map((p) => ({
    date: p.date,
    value: toGeometry(p.balanceMinor),
    minor: p.balanceMinor,
    currency: p.currency,
  }));

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="keel-balance-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} strokeDasharray="0" vertical={false} />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tick={{ fill: INK_MUTED, fontSize: 11 }}
            tickFormatter={(d: string) => d.slice(5)}
            minTickGap={48}
          />
          <YAxis
            width={52}
            tickLine={false}
            axisLine={false}
            tick={{ fill: INK_MUTED, fontSize: 11 }}
            tickFormatter={(v: number) => compactAxis(v)}
            domain={['auto', 'auto']}
          />
          <Tooltip
            cursor={{ stroke: INK_MUTED, strokeWidth: 1, strokeDasharray: '3 3' }}
            content={({ active, payload }) => {
              const p = payload[0]?.payload as (typeof data)[number] | undefined;
              if (!active || !p) return null;
              return (
                <TooltipShell>
                  <p className="text-muted-foreground">{p.date}</p>
                  <p className="font-mono font-medium tabular-nums">
                    {formatMoney(p.minor, { currency: p.currency })}
                  </p>
                </TooltipShell>
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="var(--chart-1)"
            strokeWidth={2}
            fill="url(#keel-balance-fill)"
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export type MonthlyFlow = {
  month: string;
  currency: string;
  inflowMinor: string;
  outflowMinor: string;
  netMinor: string;
};

/** Grouped monthly inflow/outflow bars (emerald/indigo, legend + tooltip). */
export function CashFlowMonthlyChart({ rows, height = 220 }: { rows: MonthlyFlow[]; height?: number }) {
  const data = rows.map((r) => ({
    month: r.month,
    inflow: toGeometry(r.inflowMinor),
    outflow: toGeometry(r.outflowMinor),
    row: r,
  }));

  return (
    <div className="space-y-2">
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barGap={2}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="month"
              tickLine={false}
              axisLine={false}
              tick={{ fill: INK_MUTED, fontSize: 11 }}
              tickFormatter={monthLabel}
            />
            <YAxis
              width={52}
              tickLine={false}
              axisLine={false}
              tick={{ fill: INK_MUTED, fontSize: 11 }}
              tickFormatter={(v: number) => compactAxis(v)}
            />
            <Tooltip
              cursor={{ fill: 'var(--secondary)', opacity: 0.5 }}
              content={({ active, payload }) => {
                const p = payload[0]?.payload as (typeof data)[number] | undefined;
                if (!active || !p) return null;
                return (
                  <TooltipShell>
                    <p className="text-muted-foreground">{monthLabel(p.month)}</p>
                    <p className="font-mono tabular-nums">
                      In {formatMoney(p.row.inflowMinor, { currency: p.row.currency })}
                    </p>
                    <p className="font-mono tabular-nums">
                      Out {formatMoney(p.row.outflowMinor, { currency: p.row.currency })}
                    </p>
                    <p className="font-mono font-medium tabular-nums">
                      Net {formatMoney(p.row.netMinor, { currency: p.row.currency, signed: true })}
                    </p>
                  </TooltipShell>
                );
              }}
            />
            <Bar
              dataKey="inflow"
              fill="var(--keel-chart-inflow)"
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
              isAnimationActive={false}
            />
            <Bar
              dataKey="outflow"
              fill="var(--keel-chart-outflow)"
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex items-center gap-4 px-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px]" style={{ background: 'var(--keel-chart-inflow)' }} />
          Money in
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px]" style={{ background: 'var(--keel-chart-outflow)' }} />
          Money out
        </span>
      </div>
    </div>
  );
}

export type CategorySpend = { name: string; totalMinor: string; currency: string };

/**
 * Horizontal magnitude bars for spending mix — plain HTML, one hue,
 * value labels in ink (never in the series color).
 */
export function CategoryBarList({ items }: { items: CategorySpend[] }) {
  const max = items.reduce((acc, i) => {
    const v = BigInt(i.totalMinor || '0');
    return v > acc ? v : acc;
  }, 0n);
  if (items.length === 0 || max === 0n) return null;

  return (
    <div className="space-y-2.5">
      {items.map((item) => {
        // Percent width for layout only; the label formats the exact string.
        const pct = Number((BigInt(item.totalMinor) * 1000n) / max) / 10;
        return (
          <div key={item.name} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate">{item.name}</span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {formatMoney(item.totalMinor, { currency: item.currency })}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full"
                style={{ width: `${String(Math.max(pct, 2))}%`, background: 'var(--chart-1)' }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
