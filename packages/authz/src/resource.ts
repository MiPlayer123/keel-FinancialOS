import type { AccountId, EntityId, HouseholdId } from '@keel/contracts';

/** The exact tenant-scoped resource named by an authorization request. */
export interface ResourceRef {
  kind?: 'household' | 'entity' | 'account' | 'recurring_series' | 'paycheck' | 'reimbursement_claim';
  householdId: HouseholdId;
  entityId?: EntityId;
  accountId?: AccountId;
}
