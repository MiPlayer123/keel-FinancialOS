import type { PeriodLockId } from '@keel/contracts';
import { KeelError } from '@keel/contracts';

export interface PeriodLock {
  lockId: PeriodLockId;
  startDate: string;
  endDate: string;
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
