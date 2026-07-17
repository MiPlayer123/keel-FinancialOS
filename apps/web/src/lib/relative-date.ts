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
const MINUTE_MS = 60_000;

/**
 * Compact freshness phrasing for sync timestamps (teardown C8: "Updated 2h
 * ago" at the account row). Unlike relativeDueLabel this takes full ISO
 * TIMESTAMPS and never goes absolute — a sync time is always meaningful as an
 * age. Pure integer math on epoch milliseconds (this is time, not money;
 * floor division is exact enough by design): minutes under an hour, hours
 * under a day, days beyond.
 *
 * Returns null for garbage input and for timestamps in the future (clock skew
 * must never produce a claim like "updated in 5m").
 */
export function relativeSyncLabel(isoTimestamp: string, nowIso: string): string | null {
  const then = Date.parse(isoTimestamp);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  const elapsedMs = now - then;
  if (elapsedMs < 0) return null;
  const minutes = Math.floor(elapsedMs / MINUTE_MS);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

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

/**
 * Compact register date: `MM/DD/YY`, always with a year. A bare `MM-DD` (the
 * previous register format) is ambiguous the moment history spans more than
 * one calendar year — exactly what a deep Plaid backfill now routinely
 * produces — so the year is never dropped, not even for the current year.
 */
export function shortDateWithYear(dateIso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!match?.[1] || !match[2] || !match[3]) return dateIso;
  return `${match[2]}/${match[3]}/${match[1].slice(2)}`;
}
