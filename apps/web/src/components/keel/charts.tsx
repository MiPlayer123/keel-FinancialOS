'use client';

/**
 * KEEL chart primitives (recharts, shadcn-styled). Financial calm: one hue
 * for single-series trends, an emerald/stone pair for inflow/outflow
 * (chromatic vs neutral — CVD-safe separation + contrast in both modes;
 * red stays reserved for negative money, Law 8). Geometry uses Number for
 * pixel scaling only — every LABEL formats from the original BIGINT minor
 * string (Law 4); no ledger arithmetic happens here (Law 1).
 */

import { useId, useMemo } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Pie,
  PieChart,
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

/**
 * Y-axis tick VALUES whose compact labels are guaranteed distinct. Even spacing
 * across [min, max], then drop any tick that formats to a label already taken —
 * so a flat or narrow series collapses to a single honest label instead of N
 * identical ones ("15.2K" ×4, DASHBOARD-7 / GOALSFORECAST-3).
 */
/**
 * Custom y-ticks ONLY for the degenerate case recharts mishandles — a series
 * so flat that its auto ticks all render the same compact label ("15.2K" ×4).
 * Returns undefined for healthy ranges so recharts keeps its nice-rounded
 * ticks (and the $0 gridline on zero-crossing series — review finding: an
 * unconditional override pinned labels to the plot edges on every chart).
 * In the degenerate case, ticks are deduped by label and always include 0
 * when the domain crosses it, anchoring the red/emerald boundary (Law 8).
 */
function distinctAxisTicks(min: number, max: number, count = 5): number[] | undefined {
  if (!(max > min)) return [min];
  // Healthy range heuristic: if the endpoints already render distinct compact
  // labels, recharts' own ticks will too — leave them alone.
  if (compactAxis(min) !== compactAxis(max)) return undefined;
  const seen = new Set<string>();
  const ticks: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = min + ((max - min) * i) / (count - 1);
    const label = compactAxis(v);
    if (seen.has(label)) continue;
    seen.add(label);
    ticks.push(v);
  }
  if (min < 0 && max > 0 && !ticks.includes(0)) ticks.push(0);
  return ticks.sort((a, b) => a - b);
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
  // Y-axis ticks from the real data extent, deduped so their compact labels are
  // always distinct — recharts' own auto ticks are what produce "15.2K" ×4 on a
  // flat/narrow series; supplying our own overrides that (domain stays 'auto').
  const values = data.map((d) => d.value);
  const dataMin = values.length > 0 ? Math.min(...values) : 0;
  const dataMax = values.length > 0 ? Math.max(...values) : 0;
  const yTicks = distinctAxisTicks(dataMin, dataMax);
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
            {...(yTicks !== undefined ? { ticks: yTicks } : {})}
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

/** Grouped monthly inflow/outflow bars (emerald/indigo, legend + tooltip).
 *  `onMonthClick` (optional) makes each month column a drill-through into the
 *  register — the caller supplies the navigation. */
export function CashFlowMonthlyChart({
  rows,
  height = 220,
  onMonthClick,
}: {
  rows: MonthlyFlow[];
  height?: number;
  onMonthClick?: (month: string) => void;
}) {
  const data = rows.map((r) => ({
    month: r.month,
    inflow: toGeometry(r.inflowMinor),
    outflow: toGeometry(r.outflowMinor),
    row: r,
  }));
  // recharts hands the categorical chart state back on click; the active
  // label is the month key of the column under the cursor.
  const handleClick =
    onMonthClick === undefined
      ? undefined
      : (state: unknown) => {
          const label = (state as { activeLabel?: unknown } | null)?.activeLabel;
          if (typeof label === 'string' && label !== '') onMonthClick(label);
        };

  return (
    <div className="space-y-2">
      <div style={{ height }} className={`w-full${handleClick ? ' cursor-pointer' : ''}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
            barGap={2}
            {...(handleClick ? { onClick: handleClick } : {})}
          >
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
// Spending donut: top-N categories + an "Everything else" fold. Colors reuse
// the five existing --chart-N hues (KEEL has no dedicated 8-hue categorical
// theme yet) in fixed slot order; a 6th+ slot repeats a hue at a lower
// opacity step rather than inventing a new hue ("calm sequence", not
// rainbow). "Everything else" always wears a neutral ink tone — it is an
// aggregate, not an entity, so it never borrows a real category's color.
// Red is never used here (Law 8: red = negative money only).
// ---------------------------------------------------------------------------

export type CategoryDonutSlice = {
  name: string;
  amountMinor: string;
  /** Category ledger-account id for drill-through (null = uncategorized).
   *  Omit when the caller doesn't wire clicks. */
  id?: string | null;
};

const DONUT_HUES = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];
const DONUT_OTHER = 'var(--muted-foreground)';

/** Slot color for the Nth (0-based) real category slice: cycles the five
 * hues, stepping opacity down each time round so a 6th+ slice reads as a
 * calmer repeat rather than a fresh, potentially colliding, identity. */
function donutSliceStyle(index: number): { fill: string; fillOpacity: number } {
  const round = Math.floor(index / DONUT_HUES.length);
  const opacity = round === 0 ? 1 : Math.max(0.35, 1 - round * 0.35);
  const hue = DONUT_HUES[index % DONUT_HUES.length] ?? 'var(--chart-1)';
  return { fill: hue, fillOpacity: opacity };
}

/**
 * Donut chart for spending mix: top N categories by magnitude, remainder
 * folded into "Everything else". Center label shows the plotted total
 * (formatted from the BIGINT minor string, Law 4); legend lists each slice's
 * exact amount + percent share. Geometry (angles, radii) uses Number — no
 * ledger arithmetic happens here (Law 1). Wraps to a stacked layout <640px.
 */
export function CategoryDonut({
  items,
  currency = 'USD',
  height = 220,
  topN = 6,
  onSliceClick,
}: {
  items: CategoryDonutSlice[];
  currency?: string;
  height?: number;
  topN?: number;
  /** Drill-through for a REAL category slice. "Everything else" is an
   *  aggregate of the folded remainder — no single register view reproduces
   *  it, so it stays non-clickable rather than drilling somewhere wrong. */
  onSliceClick?: (slice: { id: string | null; name: string }) => void;
}) {
  const { slices, totalMinor } = useMemo(() => {
    const sorted = [...items]
      .filter((i) => BigInt(i.amountMinor || '0') > 0n)
      .sort((a, b) => {
        const av = BigInt(a.amountMinor);
        const bv = BigInt(b.amountMinor);
        return bv > av ? 1 : bv < av ? -1 : 0;
      });
    const top = sorted.slice(0, topN);
    const rest = sorted.slice(topN);
    const out: (CategoryDonutSlice & { isOther: boolean })[] = top.map((i) => ({
      ...i,
      isOther: false,
    }));
    if (rest.length > 0) {
      const restTotal = rest.reduce((acc, i) => acc + BigInt(i.amountMinor), 0n);
      out.push({ name: 'Everything else', amountMinor: restTotal.toString(), isOther: true });
    }
    const total = out.reduce((acc, i) => acc + BigInt(i.amountMinor), 0n);
    return { slices: out, totalMinor: total.toString() };
  }, [items, topN]);

  if (slices.length === 0 || BigInt(totalMinor) === 0n) return null;

  const total = BigInt(totalMinor);
  // Cell is deprecated in recharts 3.9 — per-slice color is set directly on
  // each datum instead (`fill`/`fillOpacity`), which Pie reads without it.
  const data = slices.map((s, index) => {
    const pct = Number((BigInt(s.amountMinor) * 1000n) / total) / 10;
    const style = s.isOther ? { fill: DONUT_OTHER, fillOpacity: 0.45 } : donutSliceStyle(index);
    return {
      name: s.name,
      amountMinor: s.amountMinor,
      value: toGeometry(s.amountMinor),
      pct,
      isOther: s.isOther,
      categoryId: s.id ?? null,
      fill: style.fill,
      fillOpacity: style.fillOpacity,
    };
  });

  // recharts spreads each datum onto the sector props AND nests it as
  // `payload`; read defensively from either shape.
  const handleSectorClick =
    onSliceClick === undefined
      ? undefined
      : (item: unknown) => {
          const raw = item as {
            payload?: { name?: unknown; categoryId?: unknown; isOther?: unknown };
            name?: unknown;
            categoryId?: unknown;
            isOther?: unknown;
          } | null;
          const p = raw?.payload ?? raw;
          if (!p || p.isOther === true) return;
          if (typeof p.name !== 'string') return;
          onSliceClick({ id: typeof p.categoryId === 'string' ? p.categoryId : null, name: p.name });
        };

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="relative mx-auto w-full max-w-[240px] shrink-0" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <Tooltip
              content={({ active, payload }) => {
                const p = payload[0]?.payload as (typeof data)[number] | undefined;
                if (!active || !p) return null;
                return (
                  <TooltipShell>
                    <p className="font-medium">{p.name}</p>
                    <p className="font-mono tabular-nums">
                      {formatMoney(p.amountMinor, { currency })} · {String(p.pct)}%
                    </p>
                  </TooltipShell>
                );
              }}
            />
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="60%"
              outerRadius="90%"
              paddingAngle={1}
              stroke="var(--card)"
              strokeWidth={2}
              isAnimationActive={false}
              {...(handleSectorClick
                ? { onClick: handleSectorClick, className: 'cursor-pointer' }
                : {})}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Total</span>
          <span className="font-mono text-lg font-semibold tabular-nums">
            {formatMoney(totalMinor, { currency })}
          </span>
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {data.map((d) => {
          const clickable = onSliceClick !== undefined && !d.isOther;
          const row = (
            <>
              <span
                className="size-2.5 shrink-0 rounded-[3px]"
                style={{ background: d.fill, opacity: d.fillOpacity }}
              />
              <span className={`min-w-0 flex-1 truncate text-left${clickable ? ' hover:underline' : ''}`}>
                {d.name}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {String(d.pct)}%
              </span>
              <span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums">
                {formatMoney(d.amountMinor, { currency })}
              </span>
            </>
          );
          return clickable ? (
            <button
              key={d.name}
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 text-sm"
              onClick={() => {
                onSliceClick({ id: d.categoryId, name: d.name });
              }}
            >
              {row}
            </button>
          ) : (
            <div key={d.name} className="flex items-center gap-2 text-sm">
              {row}
            </div>
          );
        })}
      </div>
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
