/** One current position mapped from Plaid's /investments/holdings/get
 *  (holdings + securities arrays joined by security_id). Descriptive only
 *  — this package never touches the ledger; the worker layer decides what
 *  to do with these rows (S-inv-1b, docs/harness/plans/investments-v1.md). */
export interface KeelPlaidHolding {
  readonly accountExternalRef: string;
  readonly symbol: string;
  readonly name: string | null;
  /** Decimal string, up to 8 fractional digits — fractional shares are
   *  real; this is a quantity, not money (Law 4 governs money, not qty). */
  readonly qty: string;
  readonly priceMinor: string;
  readonly costBasisMinor: string | null;
  readonly currency: 'USD';
}

export interface SkippedPlaidHolding {
  readonly accountExternalRef: string;
  readonly securityId: string;
  readonly reason:
    | 'unresolved_security'
    | 'cash_equivalent'
    | 'non_usd'
    | 'invalid_quantity'
    | 'invalid_price';
}

export interface MappedPlaidHoldings {
  readonly holdings: KeelPlaidHolding[];
  readonly skipped: SkippedPlaidHolding[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringField = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Plaid holding ${key} must be a string`);
  return value;
};

// Price/value/cost fields arrive as already-JSON-parsed numbers (no raw
// lexeme available from /investments/holdings/get, unlike
// /transactions/sync) -- same accepted boundary pattern as
// supabase/functions/worker/index.ts's dollarsToMinor. Safe for realistic
// magnitudes (well within 2^53).
const dollarsToMinorString = (value: number): string => Math.round(value * 100).toString();

// Fractional-share quantities need more than 2 decimal places; capped at
// 8 to match the client preview parser's bound (apps/web/src/lib/holdings-math.ts).
const quantityToString = (value: number): string => {
  let s = value.toFixed(8);
  if (s.includes('.')) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s;
};

const symbolFor = (security: Record<string, unknown>): string => {
  const ticker = security['ticker_symbol'];
  if (typeof ticker === 'string' && ticker.trim().length > 0) {
    return ticker.trim().toUpperCase().slice(0, 20);
  }
  const name = security['name'];
  if (typeof name === 'string' && name.trim().length > 0) {
    return name.trim().toUpperCase().slice(0, 20);
  }
  return stringField(security, 'security_id').toUpperCase().slice(0, 20);
};

/**
 * Map `/investments/holdings/get` into KEEL holdings rows. Cash-equivalent
 * securities (Plaid `type: 'cash'`) are skipped -- the account's own
 * balance already covers cash; showing it again as a "holding" would be
 * confusing, not a double-count (holdings never post to the ledger either
 * way). Non-USD holdings are skipped, matching the USD-only convention
 * `mapAccountsGetToKeel` already uses.
 */
export const mapHoldingsGetToKeel = (body: unknown): MappedPlaidHoldings => {
  if (!isRecord(body) || !Array.isArray(body['holdings']) || !Array.isArray(body['securities'])) {
    throw new Error('Plaid holdings response must contain holdings and securities arrays');
  }

  const securitiesById = new Map<string, Record<string, unknown>>();
  for (const value of body['securities']) {
    if (!isRecord(value)) throw new Error('Plaid security must be an object');
    securitiesById.set(stringField(value, 'security_id'), value);
  }

  const result: MappedPlaidHoldings = { holdings: [], skipped: [] };
  for (const value of body['holdings']) {
    if (!isRecord(value)) throw new Error('Plaid holding must be an object');
    const accountExternalRef = stringField(value, 'account_id');
    const securityId = stringField(value, 'security_id');
    const security = securitiesById.get(securityId);

    if (!security) {
      result.skipped.push({ accountExternalRef, securityId, reason: 'unresolved_security' });
      continue;
    }
    if (security['type'] === 'cash') {
      result.skipped.push({ accountExternalRef, securityId, reason: 'cash_equivalent' });
      continue;
    }

    const currency =
      typeof value['iso_currency_code'] === 'string'
        ? value['iso_currency_code']
        : typeof security['iso_currency_code'] === 'string'
          ? security['iso_currency_code']
          : null;
    if (currency !== 'USD') {
      result.skipped.push({ accountExternalRef, securityId, reason: 'non_usd' });
      continue;
    }

    const quantity = value['quantity'];
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
      result.skipped.push({ accountExternalRef, securityId, reason: 'invalid_quantity' });
      continue;
    }

    // Prefer the institution's own reported price (fresher, tied to the
    // actual account) over Plaid's end-of-day close price.
    const institutionPrice = value['institution_price'];
    const closePrice = security['close_price'];
    const price =
      typeof institutionPrice === 'number' && Number.isFinite(institutionPrice) && institutionPrice > 0
        ? institutionPrice
        : typeof closePrice === 'number' && Number.isFinite(closePrice) && closePrice > 0
          ? closePrice
          : null;
    if (price === null) {
      result.skipped.push({ accountExternalRef, securityId, reason: 'invalid_price' });
      continue;
    }

    const costBasis = value['cost_basis'];
    const nameValue = security['name'];

    result.holdings.push({
      accountExternalRef,
      symbol: symbolFor(security),
      name:
        typeof nameValue === 'string' && nameValue.trim().length > 0
          ? nameValue.trim().slice(0, 200)
          : null,
      qty: quantityToString(quantity),
      priceMinor: dollarsToMinorString(price),
      costBasisMinor:
        typeof costBasis === 'number' && Number.isFinite(costBasis) && costBasis >= 0
          ? dollarsToMinorString(costBasis)
          : null,
      currency: 'USD',
    });
  }
  return result;
};
