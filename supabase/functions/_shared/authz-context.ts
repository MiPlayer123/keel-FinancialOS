/**
 * Load the rows the fail-closed authorization compiler (@keel/authz) needs,
 * through the CALLER's client so RLS scopes every read to what that user can
 * see. Shared by the `api` and `mcp` functions (Law 7 / BC-v2.1 §9.1: one
 * authorization compiler and one context loader for every surface).
 *
 * Self-contained by the _shared convention (no vendored domain import): the
 * shape below is structurally the AuthzContext from @keel/authz; index files
 * that import the domain bundle narrow it to the branded type.
 */

// deno-lint-ignore no-explicit-any
type UserClient = any;

export interface AuthzContextRows {
  readonly userId: string;
  readonly memberships: readonly { readonly householdId: string; readonly role: string }[];
  readonly entityMemberships: readonly { readonly entityId: string; readonly householdId: string }[];
  readonly accountOwnerships: readonly { readonly accountId: string; readonly householdId: string }[];
  readonly accountPermissions: readonly {
    readonly accountId: string;
    readonly householdId: string;
    readonly permission: string;
  }[];
}

export const loadAuthzContextRows = async (
  supabase: UserClient,
  userId: string,
): Promise<AuthzContextRows> => {
  const [memberships, entityMemberships, accountOwnerships, accountPermissions] = await Promise.all(
    [
      supabase.from('household_memberships').select('household_id, role').eq('user_id', userId),
      supabase.from('entity_memberships').select('entity_id, entities(household_id)'),
      supabase.from('account_owners').select('account_id, accounts(household_id)'),
      supabase
        .from('resource_permissions')
        .select('household_id, resource_id, permission')
        .eq('user_id', userId)
        .eq('resource_kind', 'account'),
    ],
  );
  return {
    userId,
    memberships: (memberships.data ?? []).map((row: { household_id: string; role: string }) => ({
      householdId: row.household_id,
      role: row.role,
    })),
    entityMemberships: (entityMemberships.data ?? []).map(
      (row: { entity_id: string; entities: { household_id: string } | null }) => ({
        entityId: row.entity_id,
        householdId: row.entities?.household_id ?? '',
      }),
    ),
    accountOwnerships: (accountOwnerships.data ?? []).map(
      (row: { account_id: string; accounts: { household_id: string } | null }) => ({
        accountId: row.account_id,
        householdId: row.accounts?.household_id ?? '',
      }),
    ),
    accountPermissions: (accountPermissions.data ?? []).map(
      (row: { household_id: string; resource_id: string; permission: string }) => ({
        accountId: row.resource_id,
        householdId: row.household_id,
        permission: row.permission,
      }),
    ),
  };
};
