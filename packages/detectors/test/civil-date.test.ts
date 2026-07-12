import { describe, expect, it } from 'vitest';
import {
  addCivilDays,
  addGregorianMonths,
  civilDateToEpochDay,
  daysInMonth,
  epochDayToCivilDate,
  parseCivilDate,
} from '../src/index.js';

describe('civil dates', () => {
  it.each([
    ['1970-01-01', 0],
    ['1969-12-31', -1],
    ['2000-02-29', 11016],
    ['2024-03-10', 19792],
  ] as const)('round-trips %s without Date millisecond arithmetic', (date, epochDay) => {
    expect(civilDateToEpochDay(date)).toBe(epochDay);
    expect(epochDayToCivilDate(epochDay)).toBe(date);
  });

  it.each(['', '2026-1-01', '2026-02-29', '1900-02-29', '2026-13-01', '2026-01-00']) (
    'rejects invalid civil date %j',
    (date) => {
      expect(() => parseCivilDate(date)).toThrow(RangeError);
    },
  );

  it('recognizes Gregorian leap-year rules', () => {
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2025, 2)).toBe(28);
  });

  it.each([
    ['2024-01-31', 1, '2024-02-29'],
    ['2023-01-31', 1, '2023-02-28'],
    ['2024-02-29', 12, '2025-02-28'],
    ['2024-01-30', 1, '2024-02-29'],
    ['2024-01-29', 1, '2024-02-29'],
    ['2024-03-31', -1, '2024-02-29'],
  ] as const)('adds %i Gregorian month(s) to %s with end-of-month clamp', (date, months, expected) => {
    expect(addGregorianMonths(date, months)).toBe(expected);
  });

  it('adds integer civil days across leap day and rejects non-integers', () => {
    expect(addCivilDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addCivilDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(() => addCivilDays('2024-01-01', 1.5)).toThrow(RangeError);
  });
});
