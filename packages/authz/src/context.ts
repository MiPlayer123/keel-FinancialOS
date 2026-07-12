import type { AccountId, EntityId, HouseholdId, HouseholdRole, UserId } from '@keel/contracts';

/** The complete, pre-resolved authorization view used by the compiler. */
export interface AuthzContext {
  userId: UserId;
  memberships: readonly {
    householdId: HouseholdId;
    role: HouseholdRole;
  }[];
  entityMemberships: readonly {
    entityId: EntityId;
    householdId: HouseholdId;
  }[];
  accountOwnerships: readonly {
    accountId: AccountId;
    householdId: HouseholdId;
  }[];
  accountPermissions: readonly {
    accountId: AccountId;
    householdId: HouseholdId;
    permission: 'view' | 'edit' | 'export';
  }[];
}
