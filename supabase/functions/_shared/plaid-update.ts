/**
 * Plaid update-mode link-token request body.
 *
 * Passing an existing item's `access_token` to /link/token/create puts Plaid
 * Link into UPDATE MODE — re-authorizing the SAME item in place (no new item,
 * no duplicate accounts). This is the correct recovery for a reissued card
 * whose account dropped out of an otherwise-active item.
 *
 * Two hard Plaid rules this builder enforces by construction (per
 * https://plaid.com/docs/link/update-mode/):
 *   1. NEVER send `products` NOR any product-specific request parameter (e.g.
 *      `transactions`, `statements`) alongside `access_token`. The docs are
 *      explicit: "no products should be added to the products array and no
 *      product-specific request parameters should be specified when creating a
 *      link_token for update mode." Sending `transactions: { days_requested }`
 *      here made Chase's Link flow fail with "Internal error occurred".
 *   2. `update.account_selection_enabled` presents the account-selection pane so
 *      a newly-surfaced (reissued) account can be re-added — the documented way
 *      to add new accounts to an existing Item; no dashboard config required.
 *
 * Pure + side-effect-free so it is unit-tested without a live Plaid client
 * (supabase/functions/_shared/plaid-update.test.ts).
 */
export interface UpdateLinkTokenOptions {
  userId: string;
  accessToken: string;
  countryCodes: string[];
  language?: string;
  clientName?: string;
  /** Show the account-selection pane in update mode. Defaults to true. */
  accountSelectionEnabled?: boolean;
}

// Product-specific request parameters that Plaid forbids in update mode.
const FORBIDDEN_UPDATE_MODE_KEYS = ['products', 'transactions', 'statements', 'income_verification', 'auth', 'identity_verification'];

export function buildUpdateModeLinkTokenBody(
  opts: UpdateLinkTokenOptions,
): Record<string, unknown> {
  if (!opts.accessToken) {
    throw new Error('update mode requires an existing item access_token');
  }
  if (!opts.userId) {
    throw new Error('update mode requires a client_user_id');
  }

  const body: Record<string, unknown> = {
    user: { client_user_id: opts.userId },
    client_name: opts.clientName ?? 'KEEL',
    country_codes: opts.countryCodes,
    language: opts.language ?? 'en',
    access_token: opts.accessToken,
    update: { account_selection_enabled: opts.accountSelectionEnabled ?? true },
  };

  // Invariant: no products or product-specific request parameters in update mode.
  for (const key of FORBIDDEN_UPDATE_MODE_KEYS) {
    if (key in body) {
      throw new Error(`update-mode link token must not carry "${key}" (product-specific param)`);
    }
  }

  return body;
}
