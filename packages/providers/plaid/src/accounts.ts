export interface KeelPlaidAccount {
  readonly externalRef: string;
  readonly name: string;
  readonly subtype: string;
  readonly currency: 'USD';
  readonly kind: 'asset' | 'liability';
  /** Masked account-number suffix Plaid reports (e.g. last 4 digits). Some
   *  institutions/account types omit it — null, never fabricated (Law 9). */
  readonly mask: string | null;
}

export interface SkippedPlaidAccount {
  readonly externalRef: string;
  readonly currency: string | null;
}

export interface MappedPlaidAccounts {
  readonly accounts: KeelPlaidAccount[];
  readonly skipped: SkippedPlaidAccount[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringField = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Plaid account ${key} must be a string`);
  return value;
};

const accountKind = (type: string): 'asset' | 'liability' =>
  type === 'credit' || type === 'loan' ? 'liability' : 'asset';

/** Map `/accounts/get` without carrying balances into KEEL's deterministic spine. */
export const mapAccountsGetToKeel = (body: unknown): MappedPlaidAccounts => {
  if (!isRecord(body) || !Array.isArray(body['accounts'])) {
    throw new Error('Plaid accounts response must contain an accounts array');
  }

  const result: MappedPlaidAccounts = { accounts: [], skipped: [] };
  for (const value of body['accounts']) {
    if (!isRecord(value)) throw new Error('Plaid account must be an object');

    const externalRef = stringField(value, 'account_id');
    const balances = isRecord(value['balances']) ? value['balances'] : {};
    const nestedCurrency = balances['iso_currency_code'];
    const topLevelCurrency = value['iso_currency_code'];
    const currency =
      typeof nestedCurrency === 'string'
        ? nestedCurrency
        : typeof topLevelCurrency === 'string'
          ? topLevelCurrency
          : null;

    if (currency !== 'USD') {
      result.skipped.push({ externalRef, currency });
      continue;
    }

    const maskValue = value['mask'];

    result.accounts.push({
      externalRef,
      name: stringField(value, 'name'),
      subtype: stringField(value, 'subtype'),
      currency: 'USD',
      kind: accountKind(stringField(value, 'type')),
      mask: typeof maskValue === 'string' && maskValue.length > 0 ? maskValue : null,
    });
  }
  return result;
};
