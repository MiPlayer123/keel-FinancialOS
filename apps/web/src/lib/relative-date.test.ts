import { describe, expect, it } from 'vitest';

import { relativeDueLabel, relativeSyncLabel } from './relative-date';

const TODAY = '2026-07-17';

describe('relativeDueLabel', () => {
  it('phrases the near future relatively and leaves the far future absolute', () => {
    expect(relativeDueLabel('2026-07-17', TODAY)).toBe('today');
    expect(relativeDueLabel('2026-07-18', TODAY)).toBe('tomorrow');
    expect(relativeDueLabel('2026-07-19', TODAY)).toBe('in 2 days');
    expect(relativeDueLabel('2026-07-24', TODAY)).toBe('in 7 days');
    expect(relativeDueLabel('2026-07-25', TODAY)).toBeNull(); // 8 days: absolute
    expect(relativeDueLabel('2026-12-25', TODAY)).toBeNull();
  });

  it('phrases the near past (overdue) and leaves the far past absolute', () => {
    expect(relativeDueLabel('2026-07-16', TODAY)).toBe('yesterday');
    expect(relativeDueLabel('2026-07-10', TODAY)).toBe('7 days ago');
    expect(relativeDueLabel('2026-07-09', TODAY)).toBeNull();
  });

  it('crosses month boundaries by real calendar days', () => {
    expect(relativeDueLabel('2026-08-01', '2026-07-30')).toBe('in 2 days');
    expect(relativeDueLabel('2026-03-01', '2026-02-27')).toBe('in 2 days'); // non-leap
  });

  it('returns null for garbage rather than guessing', () => {
    expect(relativeDueLabel('not-a-date', TODAY)).toBeNull();
    expect(relativeDueLabel('2026-07-19', 'nope')).toBeNull();
  });
});

describe('relativeSyncLabel', () => {
  const NOW = '2026-07-17T12:00:00Z';

  it('phrases sub-minute ages as just now', () => {
    expect(relativeSyncLabel('2026-07-17T12:00:00Z', NOW)).toBe('just now');
    expect(relativeSyncLabel('2026-07-17T11:59:01Z', NOW)).toBe('just now');
  });

  it('uses minute granularity under an hour', () => {
    expect(relativeSyncLabel('2026-07-17T11:59:00Z', NOW)).toBe('1m ago');
    expect(relativeSyncLabel('2026-07-17T11:15:30Z', NOW)).toBe('44m ago');
    expect(relativeSyncLabel('2026-07-17T11:00:01Z', NOW)).toBe('59m ago');
  });

  it('uses hour granularity under a day (floor, never rounding up)', () => {
    expect(relativeSyncLabel('2026-07-17T11:00:00Z', NOW)).toBe('1h ago');
    expect(relativeSyncLabel('2026-07-17T09:30:00Z', NOW)).toBe('2h ago');
    expect(relativeSyncLabel('2026-07-16T12:00:01Z', NOW)).toBe('23h ago');
  });

  it('uses day granularity from 24h onward', () => {
    expect(relativeSyncLabel('2026-07-16T12:00:00Z', NOW)).toBe('1d ago');
    expect(relativeSyncLabel('2026-07-03T12:00:00Z', NOW)).toBe('14d ago');
    expect(relativeSyncLabel('2025-07-17T12:00:00Z', NOW)).toBe('365d ago');
  });

  it('handles timezone offsets by real instants, not lexical dates', () => {
    // 08:00-04:00 == 12:00Z — the same instant, so: just now.
    expect(relativeSyncLabel('2026-07-17T08:00:00-04:00', NOW)).toBe('just now');
  });

  it('returns null for the future and for garbage', () => {
    expect(relativeSyncLabel('2026-07-17T12:05:00Z', NOW)).toBeNull();
    expect(relativeSyncLabel('not-a-timestamp', NOW)).toBeNull();
    expect(relativeSyncLabel(NOW, 'nope')).toBeNull();
  });
});
