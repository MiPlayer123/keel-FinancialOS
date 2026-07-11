import { KeelError } from '@keel/contracts';
import type { HouseholdId, HouseholdRole } from '@keel/contracts';
import { ACTION_MINIMUM_ROLES, isWriteAction, roleAtLeast, type Action } from './action.js';
import type { AuthzContext } from './context.js';
import type { ResourceRef } from './resource.js';

export type AllowedDecision = {
  allowed: true;
  householdId: HouseholdId;
  role: HouseholdRole;
};

export type DeniedDecision = {
  allowed: false;
  code: 'not_authorized' | 'household_scope_violation';
  reason: string;
};

export type Decision = AllowedDecision | DeniedDecision;

const scopeViolation = (reason: string): DeniedDecision => ({
  allowed: false,
  code: 'household_scope_violation',
  reason,
});

/** Compile one action/resource request into a fail-closed authorization decision. */
export const authorize = (ctx: AuthzContext, action: Action, resource: ResourceRef): Decision => {
  const membership = ctx.memberships.find(
    (candidate) => candidate.householdId === resource.householdId,
  );

  if (membership === undefined) {
    return scopeViolation('Actor is not a member of the resource household.');
  }

  if (!roleAtLeast(membership.role, ACTION_MINIMUM_ROLES[action])) {
    return {
      allowed: false,
      code: 'not_authorized',
      reason: 'Household role does not permit this action.',
    };
  }

  if (
    resource.entityId !== undefined &&
    !ctx.entityMemberships.some(
      (candidate) =>
        candidate.entityId === resource.entityId && candidate.householdId === resource.householdId,
    )
  ) {
    return scopeViolation('Entity is not linked to the resource household.');
  }

  if (
    resource.accountId !== undefined &&
    isWriteAction(action) &&
    !ctx.accountOwnerships.some(
      (candidate) =>
        candidate.accountId === resource.accountId &&
        candidate.householdId === resource.householdId,
    )
  ) {
    return scopeViolation('Account is not linked to the resource household.');
  }

  return {
    allowed: true,
    householdId: resource.householdId,
    role: membership.role,
  };
};

/** Return the positive decision or throw the shared KEEL authorization error. */
export const assertAuthorized = (
  ctx: AuthzContext,
  action: Action,
  resource: ResourceRef,
): AllowedDecision => {
  const decision = authorize(ctx, action, resource);

  if (!decision.allowed) {
    throw new KeelError(decision.code, decision.reason);
  }

  return decision;
};
