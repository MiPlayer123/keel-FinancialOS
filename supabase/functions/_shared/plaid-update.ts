/**
 * Plaid update-mode link-token request body.
 *
 * Passing an existing item's `access_token` to /link/token/create puts Plaid
 * Link into UPDATE MODE — re-authorizing the SAME item in place (no new item,
 * no duplicate accounts). This is the correct recovery for a reissued card
 * whose account dropped out of an otherwise-active item.
 *
 * Two hard Plaid rules this builder enforces by construction:
 *   1. NEVER send `products` alongside `access_token` — Plaid rejects it.
 *   2. `update.account_selection_enabled` presents the account-selection pane so
 *      a newly-surfaced (reissued) account can be included.
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
  daysRequested?: number;
  /** Show the account-selection pane in update mode. Defaults to true. */
  accountSelectionEnabled?: boolean;
}

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

  if (
    typeof opts.daysRequested === 'number' &&
    Number.isSafeInteger(opts.daysRequested) &&
    opts.daysRequested > 0
  ) {
    body.transactions = { days_requested: opts.daysRequested };
  }

  // Invariant: products must never accompany access_token.
  if ('products' in body) {
    throw new Error('update-mode link token must not carry products');
  }

  return body;
}
