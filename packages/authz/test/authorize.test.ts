import { describe, expect, it } from 'vitest';
import { KeelError } from '@keel/contracts';
import type { AccountId, EntityId, HouseholdId, HouseholdRole, UserId } from '@keel/contracts';
import { assertAuthorized, authorize, type AuthzContext, type Decision } from '../src/index.js';

const USER = 'user-1' as UserId;
const HOUSEHOLD = 'household-1' as HouseholdId;
const OTHER_HOUSEHOLD = 'household-2' as HouseholdId;
const ENTITY = 'entity-1' as EntityId;
const ACCOUNT = 'account-1' as AccountId;

const makeContext = (overrides: Partial<AuthzContext> = {}): AuthzContext => ({
  userId: USER,
  memberships: [{ householdId: HOUSEHOLD, role: 'owner' }],
  entityMemberships: [],
  accountOwnerships: [],
  accountPermissions: [],
  ...overrides,
});

const expectDenied = (
  decision: Decision,
  code: 'not_authorized' | 'household_scope_violation',
): void => {
  expect(decision.allowed).toBe(false);
  if (!decision.allowed) {
    expect(decision.code).toBe(code);
    expect(decision.reason.length).toBeGreaterThan(0);
  }
};

describe('authorize', () => {
  it('denies a resource household with no membership', () => {
    const decision = authorize(makeContext({ memberships: [] }), 'transactions.list', {
      householdId: HOUSEHOLD,
    });

    expectDenied(decision, 'household_scope_violation');
  });

  it.each([
    ['owner', true],
    ['partner', true],
    ['viewer', false],
    ['professional', false],
  ] satisfies readonly [HouseholdRole, boolean][])('%s write access is %s', (role, allowed) => {
    const decision = authorize(
      makeContext({ memberships: [{ householdId: HOUSEHOLD, role }] }),
      'journal.post_batch',
      { householdId: HOUSEHOLD },
    );

    expect(decision.allowed).toBe(allowed);
    if (!allowed) {
      expectDenied(decision, 'not_authorized');
    }
  });

  it('allows a resource entity positively linked to the same household', () => {
    const decision = authorize(
      makeContext({ entityMemberships: [{ entityId: ENTITY, householdId: HOUSEHOLD }] }),
      'transactions.list',
      { householdId: HOUSEHOLD, entityId: ENTITY },
    );

    expect(decision).toEqual({ allowed: true, householdId: HOUSEHOLD, role: 'owner' });
  });

  it('denies an unknown resource entity', () => {
    const decision = authorize(makeContext(), 'transactions.list', {
      householdId: HOUSEHOLD,
      entityId: ENTITY,
    });

    expectDenied(decision, 'household_scope_violation');
  });

  it('denies entity reference smuggling from another household', () => {
    const decision = authorize(
      makeContext({
        entityMemberships: [{ entityId: ENTITY, householdId: OTHER_HOUSEHOLD }],
      }),
      'accounts.create',
      { householdId: HOUSEHOLD, entityId: ENTITY },
    );

    expectDenied(decision, 'household_scope_violation');
  });

  it('allows a write account positively linked to the same household', () => {
    const decision = authorize(
      makeContext({ accountOwnerships: [{ accountId: ACCOUNT, householdId: HOUSEHOLD }] }),
      'ingest.promote_event',
      { householdId: HOUSEHOLD, accountId: ACCOUNT },
    );

    expect(decision.allowed).toBe(true);
  });

  it('denies a write targeting an unknown account', () => {
    const decision = authorize(makeContext(), 'ingest.promote_event', {
      householdId: HOUSEHOLD,
      accountId: ACCOUNT,
    });

    expectDenied(decision, 'household_scope_violation');
  });

  it('denies write account reference smuggling from another household', () => {
    const decision = authorize(
      makeContext({
        accountOwnerships: [{ accountId: ACCOUNT, householdId: OTHER_HOUSEHOLD }],
      }),
      'ingest.promote_event',
      { householdId: HOUSEHOLD, accountId: ACCOUNT },
    );

    expectDenied(decision, 'household_scope_violation');
  });

  it('allows a household read without account ownership', () => {
    const decision = authorize(makeContext(), 'transactions.list', {
      householdId: HOUSEHOLD,
      accountId: ACCOUNT,
    });

    expect(decision.allowed).toBe(true);
  });

  it('does not require a read account reference to have an ownership row', () => {
    const decision = authorize(
      makeContext({
        accountOwnerships: [{ accountId: ACCOUNT, householdId: OTHER_HOUSEHOLD }],
      }),
      'ledger.trial_balance',
      { householdId: HOUSEHOLD, accountId: ACCOUNT },
    );

    expect(decision.allowed).toBe(true);
  });

  it('requires positive account scope for recurring reads and writes', () => {
    const unscoped = makeContext();
    expectDenied(authorize(unscoped, 'recurring.list', {
      householdId: HOUSEHOLD,
      accountId: ACCOUNT,
      kind: 'recurring_series',
    }), 'household_scope_violation');
    expectDenied(authorize(unscoped, 'recurring.confirm', {
      householdId: HOUSEHOLD,
      accountId: ACCOUNT,
      kind: 'recurring_series',
    }), 'household_scope_violation');

    const ownerScoped = makeContext({
      accountOwnerships: [{ accountId: ACCOUNT, householdId: HOUSEHOLD }],
    });
    expect(authorize(ownerScoped, 'recurring.list', {
      householdId: HOUSEHOLD, accountId: ACCOUNT, kind: 'recurring_series',
    }).allowed).toBe(true);
    expect(authorize(ownerScoped, 'recurring.confirm', {
      householdId: HOUSEHOLD, accountId: ACCOUNT, kind: 'recurring_series',
    }).allowed).toBe(true);
  });

  it('allows recurring view/edit through explicit same-household resource permissions', () => {
    const ctx = makeContext({
      accountPermissions: [
        { accountId: ACCOUNT, householdId: HOUSEHOLD, permission: 'view' },
      ],
    });
    expect(authorize(ctx, 'recurring.list', {
      householdId: HOUSEHOLD, accountId: ACCOUNT, kind: 'recurring_series',
    }).allowed).toBe(true);
    expectDenied(authorize(ctx, 'recurring.pause', {
      householdId: HOUSEHOLD, accountId: ACCOUNT, kind: 'recurring_series',
    }), 'household_scope_violation');

    const editor = makeContext({
      accountPermissions: [
        { accountId: ACCOUNT, householdId: HOUSEHOLD, permission: 'edit' },
      ],
    });
    expect(authorize(editor, 'recurring.pause', {
      householdId: HOUSEHOLD, accountId: ACCOUNT, kind: 'recurring_series',
    }).allowed).toBe(true);
  });

  it.each([
    ['view then edit', ['view', 'edit']],
    ['edit then view', ['edit', 'view']],
  ] as const)('scans every recurring permission for writes: %s', (_label, permissions) => {
    const ctx = makeContext({
      accountPermissions: permissions.map((permission) => ({
        accountId: ACCOUNT,
        householdId: HOUSEHOLD,
        permission,
      })),
    });

    expect(authorize(ctx, 'recurring.pause', {
      householdId: HOUSEHOLD, accountId: ACCOUNT, kind: 'recurring_series',
    }).allowed).toBe(true);
  });

  it('allows a professional to read with household membership', () => {
    const decision = authorize(
      makeContext({
        memberships: [{ householdId: HOUSEHOLD, role: 'professional' }],
      }),
      'audit.read',
      { householdId: HOUSEHOLD },
    );

    expect(decision).toEqual({
      allowed: true,
      householdId: HOUSEHOLD,
      role: 'professional',
    });
  });

  it('denies a professional write', () => {
    const decision = authorize(
      makeContext({
        memberships: [{ householdId: HOUSEHOLD, role: 'professional' }],
      }),
      'accounts.create',
      { householdId: HOUSEHOLD },
    );

    expectDenied(decision, 'not_authorized');
  });

  it.each([
    ['owner', true],
    ['partner', false],
    ['viewer', false],
    ['professional', false],
  ] satisfies readonly [HouseholdRole, boolean][])('%s export access is %s', (role, allowed) => {
    const decision = authorize(
      makeContext({ memberships: [{ householdId: HOUSEHOLD, role }] }),
      'admin.export_all',
      { householdId: HOUSEHOLD, accountId: ACCOUNT },
    );
    expect(decision.allowed).toBe(allowed);
    if (!allowed) expectDenied(decision, 'not_authorized');
  });
});

describe('assertAuthorized', () => {
  it('returns the positive decision', () => {
    expect(
      assertAuthorized(makeContext(), 'transactions.list', { householdId: HOUSEHOLD }),
    ).toEqual({ allowed: true, householdId: HOUSEHOLD, role: 'owner' });
  });

  it('throws a KeelError carrying the denial code', () => {
    try {
      assertAuthorized(makeContext({ memberships: [] }), 'transactions.list', {
        householdId: HOUSEHOLD,
      });
      throw new Error('expected assertAuthorized to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(KeelError);
      expect((error as KeelError).code).toBe('household_scope_violation');
    }
  });
});
