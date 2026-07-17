import { describe, expect, it } from 'vitest';

import { relativeDueLabel } from './relative-date';

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
