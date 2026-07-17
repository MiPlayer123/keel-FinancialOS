/**
 * Relative phrasing for NEAR dates (teardown C19: competitors phrase due
 * dates as "in 3 days" near-term and absolute beyond). Pure calendar string
 * math on ISO `YYYY-MM-DD` — UTC midnights divide exactly, no rounding, no
 * money involved.
 *
 * Returns null outside the ±7-day window: callers keep their absolute date
 * rendering, so far-away dates never lose precision (the teardown's rule —
 * relative near, absolute far).
 */
const DAY_MS = 86_400_000;

export function relativeDueLabel(dateIso: string, todayIso: string): string | null {
  const date = Date.parse(`${dateIso}T00:00:00Z`);
  const today = Date.parse(`${todayIso}T00:00:00Z`);
  if (!Number.isFinite(date) || !Number.isFinite(today)) return null;
  const days = (date - today) / DAY_MS;
  if (!Number.isInteger(days)) return null;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1 && days <= 7) return `in ${String(days)} days`;
  if (days === -1) return 'yesterday';
  if (days < -1 && days >= -7) return `${String(-days)} days ago`;
  return null;
}
