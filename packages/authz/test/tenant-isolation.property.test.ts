import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { AccountId, EntityId, HouseholdId, HouseholdRole, UserId } from '@keel/contracts';
import { ACTIONS, WRITE_ACTIONS, authorize, type AuthzContext } from '../src/index.js';

const householdIdArbitrary = fc.uuid().map((value) => value as HouseholdId);
const entityIdArbitrary = fc.uuid().map((value) => value as EntityId);
const accountIdArbitrary = fc.uuid().map((value) => value as AccountId);
const userIdArbitrary = fc.uuid().map((value) => value as UserId);
const householdRoleArbitrary = fc.constantFrom<HouseholdRole>(
  'owner',
  'partner',
  'viewer',
  'professional',
);

const contextArbitrary: fc.Arbitrary<AuthzContext> = fc.record({
  userId: userIdArbitrary,
  memberships: fc.array(
    fc.record({ householdId: householdIdArbitrary, role: householdRoleArbitrary }),
    { maxLength: 8 },
  ),
  entityMemberships: fc.array(
    fc.record({ entityId: entityIdArbitrary, householdId: householdIdArbitrary }),
    { maxLength: 8 },
  ),
  accountOwnerships: fc.array(
    fc.record({ accountId: accountIdArbitrary, householdId: householdIdArbitrary }),
    { maxLength: 8 },
  ),
  accountPermissions: fc.constant([]),
});

const distinctHouseholdsArbitrary = fc
  .tuple(householdIdArbitrary, householdIdArbitrary)
  .filter(([resourceHouseholdId, otherHouseholdId]) => resourceHouseholdId !== otherHouseholdId);

describe('tenant isolation properties', () => {
  it('never allows any action outside the actor household memberships', () => {
    fc.assert(
      fc.property(
        contextArbitrary,
        householdIdArbitrary,
        fc.constantFrom(...ACTIONS),
        (ctx, householdId, action) => {
          fc.pre(!ctx.memberships.some((membership) => membership.householdId === householdId));

          expect(authorize(ctx, action, { householdId }).allowed).toBe(false);
        },
      ),
    );
  });

  it('never allows an owner write with an entity linked only to another household', () => {
    fc.assert(
      fc.property(
        userIdArbitrary,
        distinctHouseholdsArbitrary,
        entityIdArbitrary,
        fc.constantFrom(...WRITE_ACTIONS),
        (userId, [householdId, otherHouseholdId], entityId, action) => {
          const ctx: AuthzContext = {
            userId,
            memberships: [{ householdId, role: 'owner' }],
            entityMemberships: [{ entityId, householdId: otherHouseholdId }],
            accountOwnerships: [],
            accountPermissions: [],
          };

          expect(authorize(ctx, action, { householdId, entityId }).allowed).toBe(false);
        },
      ),
    );
  });

  it('never allows an owner write with an account linked only to another household', () => {
    fc.assert(
      fc.property(
        userIdArbitrary,
        distinctHouseholdsArbitrary,
        accountIdArbitrary,
        fc.constantFrom(...WRITE_ACTIONS),
        (userId, [householdId, otherHouseholdId], accountId, action) => {
          const ctx: AuthzContext = {
            userId,
            memberships: [{ householdId, role: 'owner' }],
            entityMemberships: [],
            accountOwnerships: [{ accountId, householdId: otherHouseholdId }],
            accountPermissions: [],
          };

          expect(authorize(ctx, action, { householdId, accountId }).allowed).toBe(false);
        },
      ),
    );
  });
});
