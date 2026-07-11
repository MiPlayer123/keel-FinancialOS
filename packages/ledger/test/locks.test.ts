import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { PeriodLockId } from '@keel/contracts';
import { KeelError } from '@keel/contracts';
import { assertPostable, type PeriodLock } from '../src/locks.js';

const lockId = (value: string): PeriodLockId => value as PeriodLockId;

const isoDate = fc
  .tuple(
    fc.integer({ min: 2000, max: 2099 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(
    ([year, month, day]) =>
      `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
        .toString()
        .padStart(2, '0')}`,
  );

describe('assertPostable', () => {
  it('allows a date when there are no locks', () => {
    assertPostable('2026-07-11', []);
  });

  it.each(['2026-07-01', '2026-07-15', '2026-07-31'])(
    'blocks an inclusive locked date: %s',
    (effectiveDate) => {
      const lock: PeriodLock = {
        lockId: lockId('july-lock'),
        startDate: '2026-07-01',
        endDate: '2026-07-31',
      };

      try {
        assertPostable(effectiveDate, [lock]);
        throw new Error('expected operation to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(KeelError);
        expect((error as KeelError).code).toBe('period_locked');
        expect((error as KeelError).details).toEqual({ lockId: lock.lockId });
      }
    },
  );

  it('checks every lock and reports the matching lock', () => {
    const locks: PeriodLock[] = [
      { lockId: lockId('june'), startDate: '2026-06-01', endDate: '2026-06-30' },
      { lockId: lockId('july'), startDate: '2026-07-01', endDate: '2026-07-31' },
    ];

    expect(() => {
      assertPostable('2026-07-11', locks);
    }).toThrow(
      expect.objectContaining<Partial<KeelError>>({
        code: 'period_locked',
        details: { lockId: lockId('july') },
      }),
    );
  });

  it('never throws for dates strictly outside a lock', () => {
    fc.assert(
      fc.property(
        fc.tuple(isoDate, isoDate, isoDate).filter(
          ([first, second, third]) => first !== second && second !== third && first !== third,
        ),
        (dates) => {
          const [before, locked, after] = [...dates].sort();
          expect(before).toBeDefined();
          expect(locked).toBeDefined();
          expect(after).toBeDefined();
          const lock: PeriodLock = {
            lockId: lockId('property-lock'),
            startDate: locked as string,
            endDate: locked as string,
          };

          expect(() => {
            assertPostable(before as string, [lock]);
          }).not.toThrow();
          expect(() => {
            assertPostable(after as string, [lock]);
          }).not.toThrow();
        },
      ),
    );
  });

  it('always throws for a date inside a lock', () => {
    fc.assert(
      fc.property(
        fc.tuple(isoDate, isoDate, isoDate),
        (dates) => {
          const sorted = [...dates].sort();
          const startDate = sorted[0];
          const effectiveDate = sorted[1];
          const endDate = sorted[2];
          expect(startDate).toBeDefined();
          expect(effectiveDate).toBeDefined();
          expect(endDate).toBeDefined();

          expect(() => {
            assertPostable(effectiveDate as string, [
              {
                lockId: lockId('property-lock'),
                startDate: startDate as string,
                endDate: endDate as string,
              },
            ]);
          }).toThrow(expect.objectContaining<Partial<KeelError>>({ code: 'period_locked' }));
        },
      ),
    );
  });
});
