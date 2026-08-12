import { buildUpdateModeLinkTokenBody } from './plaid-update.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

Deno.test('update-mode body carries the access_token (in-place re-auth)', () => {
  const body = buildUpdateModeLinkTokenBody({
    userId: 'user-1',
    accessToken: 'access-prod-abc',
    countryCodes: ['US'],
  });
  assert(body['access_token'] === 'access-prod-abc', 'access_token must be present');
  assert(
    (body['user'] as { client_user_id: string }).client_user_id === 'user-1',
    'client_user_id passes through',
  );
});

Deno.test('update-mode body sends NO products nor product-specific params', () => {
  const body = buildUpdateModeLinkTokenBody({
    userId: 'user-1',
    accessToken: 'access-prod-abc',
    countryCodes: ['US'],
  });
  // Plaid forbids products AND product-specific request params (transactions,
  // statements, …) in update mode — sending transactions.days_requested made
  // Chase's Link flow throw "Internal error occurred".
  for (const forbidden of ['products', 'transactions', 'statements', 'income_verification', 'auth']) {
    assert(!(forbidden in body), `${forbidden} must be absent in update mode`);
  }
});

Deno.test('update-mode enables account selection so a reissued card can be added', () => {
  const body = buildUpdateModeLinkTokenBody({
    userId: 'user-1',
    accessToken: 'access-prod-abc',
    countryCodes: ['US'],
  });
  const update = body['update'] as { account_selection_enabled: boolean };
  assert(update.account_selection_enabled === true, 'account_selection_enabled defaults true');
});

Deno.test('update-mode requires an access_token', () => {
  let threw = false;
  try {
    buildUpdateModeLinkTokenBody({ userId: 'user-1', accessToken: '', countryCodes: ['US'] });
  } catch {
    threw = true;
  }
  assert(threw, 'empty access_token must throw');
});
