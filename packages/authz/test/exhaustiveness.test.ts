import { describe, expect, it } from 'vitest';
import type { HouseholdId, UserId } from '@keel/contracts';
import { ACTIONS, authorize, type AuthzContext } from '../src/index.js';

describe('fail-closed action exhaustiveness', () => {
  it.each(ACTIONS)('denies %s against an empty context', (action) => {
    const ctx: AuthzContext = {
      userId: 'user-1' as UserId,
      memberships: [],
      entityMemberships: [],
      accountOwnerships: [],
      accountPermissions: [],
    };

    const decision = authorize(ctx, action, {
      householdId: 'household-1' as HouseholdId,
    });

    expect(decision.allowed).toBe(false);
  });
});
