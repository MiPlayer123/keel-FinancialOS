'use client';

/**
 * KEEL chart primitives (recharts, shadcn-styled). Financial calm: one hue
 * for single-series trends, an emerald/indigo pair for inflow/outflow
 * (validated for CVD separation + contrast in both modes — see NOTES.md;
 * red stays reserved for negative money, Law 8). Geometry uses Number for
 * pixel scaling only — every LABEL formats from the original BIGINT minor
 * string (Law 4); no ledger arithmetic happens here (Law 1).
 */

import { useId } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Sankey,
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

/** Single-series balance/net-worth trend. One hue, crosshair tooltip.
 *  Segments below zero render red — negative money only (Law 8): the
 *  stroke/fill gradients flip color exactly at the zero crossing. */
export function BalanceTrendChart({ points, height = 200 }: { points: BalancePoint[]; height?: number }) {
  const data = points.map((p) => ({
    date: p.date,
    value: toGeometry(p.balanceMinor),
    minor: p.balanceMinor,
    currency: p.currency,
  }));
  // Gradient offset where the series crosses zero (0 = top of plot, 1 = bottom).
  const max = Math.max(...data.map((d) => d.value), 0);
  const min = Math.min(...data.map((d) => d.value), 0);
  const zeroOffset = max <= 0 ? 0 : min >= 0 ? 1 : max / (max - min);
  const NEGATIVE = 'var(--destructive)';
  // Unique per instance: two charts on one page must not share gradient ids.
  const gid = useId();
  const fillId = `keel-balance-fill-${gid}`;
  const strokeId = `keel-balance-stroke-${gid}`;

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset={0} stopColor="var(--chart-1)" stopOpacity={0.18} />
              <stop offset={zeroOffset} stopColor="var(--chart-1)" stopOpacity={0.02} />
              <stop offset={zeroOffset} stopColor={NEGATIVE} stopOpacity={0.06} />
              <stop offset={1} stopColor={NEGATIVE} stopOpacity={0.16} />
            </linearGradient>
            <linearGradient id={strokeId} x1="0" y1="0" x2="0" y2="1">
              <stop offset={zeroOffset} stopColor="var(--chart-1)" />
              <stop offset={zeroOffset} stopColor={NEGATIVE} />
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
            stroke={`url(#${strokeId})`}
            strokeWidth={2}
            fill={`url(#${fillId})`}
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

// ---------------------------------------------------------------------------
// Cash-flow Sankey: income categories → Income → spending categories, with a
// "Saved" (or "From savings") balancing node so both sides always sum equal.
// Two hues only (the validated inflow/outflow pair); links are recessive
// neutral ribbons; every label wears ink tokens, values live in the tooltip.
// ---------------------------------------------------------------------------

export type SankeyFlowNode = {
  name: string;
  /** Color job: money-in vs money-out (the validated hue pair). */
  side: 'in' | 'out' | 'hub';
  /** Layout column — explicit because recharts gives node shapes no
   * container geometry to infer it from. */
  column: 'left' | 'hub' | 'right';
  /** Exact display amount (minor units, BigInt-safe string). */
  totalMinor: string;
};
export type SankeyFlowLink = { source: number; target: number; valueMinor: string };

const NODE_W = 10;

type SankeyNodeShapeProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  payload: SankeyFlowNode & { value: number };
};

function FlowNode(props: SankeyNodeShapeProps) {
  const { x, y, width, height, payload } = props;
  const fill =
    payload.side === 'out' ? 'var(--keel-chart-outflow)' : 'var(--keel-chart-inflow)';
  const rect = (
    <rect x={x} y={y} width={width} height={Math.max(height, 2)} rx={2} fill={fill} />
  );
  // Hub carries no label (its totals live in the caption) so side-column
  // labels can sit OUTSIDE the plot and never collide with ribbons.
  if (payload.column === 'hub') return rect;
  const right = payload.column === 'right';
  return (
    <g>
      {rect}
      <text
        x={right ? x + width + 6 : x - 6}
        y={y + Math.max(height, 2) / 2}
        textAnchor={right ? 'start' : 'end'}
        dominantBaseline="middle"
        className="fill-[var(--foreground)]"
        fontSize={12}
      >
        {`${payload.name} · ${formatMoney(payload.totalMinor)}`}
      </text>
    </g>
  );
}

/**
 * @param nodes hub first is NOT required; links reference node indexes.
 * Geometry converts to Number for pixels only — labels format the minor
 * strings directly (Law 4).
 */
export function CashFlowSankey({
  nodes,
  links,
  height,
}: {
  nodes: SankeyFlowNode[];
  links: SankeyFlowLink[];
  height?: number;
}) {
  if (nodes.length < 3 || links.length === 0) return null;
  const data = {
    nodes: nodes.map((n) => ({ ...n })),
    links: links.map((l) => ({
      source: l.source,
      target: l.target,
      value: Math.max(toGeometry(l.valueMinor.replace('-', '')), 0.01),
    })),
  };
  const sideCount = Math.max(
    nodes.filter((n) => n.side === 'in').length,
    nodes.filter((n) => n.side === 'out').length,
  );
  const h = height ?? Math.max(220, sideCount * 44);
  return (
    // Flow labels need real width — on narrow screens the diagram scrolls in
    // its own container rather than colliding (never the page).
    <div className="overflow-x-auto">
      <div className="min-w-[560px]">
        <ResponsiveContainer width="100%" height={h}>
          <Sankey
        data={data}
        nodeWidth={NODE_W}
        nodePadding={14}
        margin={{ top: 8, right: 175, bottom: 8, left: 175 }}
        node={(p: unknown) => <FlowNode {...(p as SankeyNodeShapeProps)} />}
        link={{ stroke: 'var(--muted-foreground)', strokeOpacity: 0.18 }}
      >
        <Tooltip
          content={({ payload }) => {
            const item = payload[0]?.payload as
              | { payload?: { name?: string; totalMinor?: string } }
              | undefined;
            const inner = item?.payload;
            if (!inner?.name || !inner.totalMinor) return null;
            return (
              <TooltipShell>
                <p className="font-medium">{inner.name}</p>
                <p className="text-muted-foreground">{formatMoney(inner.totalMinor)}</p>
              </TooltipShell>
            );
          }}
        />
          </Sankey>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
