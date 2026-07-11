import type { PeriodLockId } from '@keel/contracts';
import { KeelError } from '@keel/contracts';

export interface PeriodLock {
  readonly lockId: PeriodLockId;
  readonly startDate: string;
  readonly endDate: string;
}

export const assertPostable = (effectiveDate: string, locks: readonly PeriodLock[]): void => {
  for (const lock of locks) {
    if (effectiveDate >= lock.startDate && effectiveDate <= lock.endDate) {
      throw new KeelError('period_locked', 'effective date falls within a locked period', {
        lockId: lock.lockId,
      });
    }
  }
};
