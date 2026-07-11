import type { AccountId, EntityId, HouseholdId } from '@keel/contracts';

/** The exact tenant-scoped resource named by an authorization request. */
export interface ResourceRef {
  householdId: HouseholdId;
  entityId?: EntityId;
  accountId?: AccountId;
}
