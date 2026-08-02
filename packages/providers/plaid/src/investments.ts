import { plaidAmountToKeelMinor } from './sign.js';

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
  /** Plaid's raw security type (equity, etf, fixed income, mutual fund,
   *  cryptocurrency, derivative, other -- 'cash' never reaches here, see
   *  below). Stored as-is; coarse-bucketing into an allocation view
   *  (S-inv-1c) happens at read time, not here. */
  readonly securityType: string | null;
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
// /investments/holdings/get exposes only a parsed JSON number, so there is no
// raw lexeme to parse exactly. This is the float→minor ENTRY POINT, not ledger
// arithmetic; everything downstream is BIGINT minor units (Law 4).
// eslint-disable-next-line no-restricted-syntax -- documented provider boundary
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
// ---------------------------------------------------------------------------
// Investment transactions (F-013). Plaid's /investments/transactions/get is
// the ONLY endpoint that returns brokerage cash-flow + trade activity;
// /transactions/sync never carries it, so investment accounts otherwise show
// zero register rows. This mapper turns one page of that response into KEEL
// canonical-transaction inputs. Trades (buy/sell) are ingested as plain
// cash-affecting transactions too (the cash side of the trade), but NO lot /
// position accounting is done here (out of scope, docs/harness plans + F-013).
//
// Sign convention (mirrors mapAccountsGetToKeel / the /transactions/sync
// adapter): KEEL stores the effect on the ACCOUNT balance. Plaid's investment
// `amount` is POSITIVE for cash LEAVING the account (a buy, a fee, a
// withdrawal/transfer out) and NEGATIVE for cash ENTERING (a sell, a deposit,
// a dividend, a transfer in). So the account-effect minor amount is the
// NEGATION of Plaid's amount. Non-USD and zero-amount rows are skipped.
// ---------------------------------------------------------------------------

/** One investment transaction mapped to a KEEL canonical-transaction input.
 *  `amountMinor` is already the account-balance effect (BIGINT minor units,
 *  as a decimal string): negative = money out, positive = money in. */
export interface KeelPlaidInvestmentTxn {
  readonly accountExternalRef: string;
  /** Stable Plaid id — the idempotency anchor. */
  readonly providerTransactionId: string;
  readonly amountMinor: string;
  readonly currency: 'USD';
  /** ISO yyyy-mm-dd. */
  readonly date: string;
  readonly description: string;
  /** Coarse KEEL classification of the cash-flow (never trusted for math,
   *  only for narration / whether this is a cash-flow vs. a pure trade). */
  readonly flow: KeelInvestmentFlow;
  /** Plaid's raw `type` (buy, sell, cash, fee, transfer, cancel), preserved
   *  for source fidelity. */
  readonly plaidType: string;
  readonly plaidSubtype: string | null;
  /** True when the transacted security is a cash-equivalent (Plaid security
   *  `type === 'cash'`, e.g. the SPAXX core money-market sweep). In a
   *  cash-management account the core money market IS the account's own cash,
   *  so a buy/sell of it is a "core sweep": the paired real EFT/transfer is
   *  ingested separately, and booking the sweep too would phantom-swing the
   *  per-line running balance and mis-detect as a same-account self-transfer.
   *  The RPC uses this flag (with a CORE ACCOUNT description fallback) to
   *  SUPPRESS such sweeps. Descriptive only — never used for math. */
  readonly isCashEquivalent: boolean;
}

export type KeelInvestmentFlow =
  | 'deposit'
  | 'withdrawal'
  | 'transfer_in'
  | 'transfer_out'
  | 'dividend_interest'
  | 'fee'
  | 'buy'
  | 'sell'
  | 'other';

export interface SkippedPlaidInvestmentTxn {
  readonly providerTransactionId: string;
  readonly reason: 'non_usd' | 'invalid_amount' | 'zero_amount' | 'cancelled';
}

export interface MappedPlaidInvestmentTxns {
  readonly transactions: KeelPlaidInvestmentTxn[];
  readonly skipped: SkippedPlaidInvestmentTxn[];
}

const optionalString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

/** Classify a Plaid investment (type, subtype) pair into a coarse KEEL flow.
 *  Purely descriptive — the economic amount is authoritative regardless. */
const classifyFlow = (type: string, subtype: string | null): KeelInvestmentFlow => {
  const t = type.toLowerCase();
  const s = (subtype ?? '').toLowerCase();
  if (t === 'buy') return 'buy';
  if (t === 'sell') return 'sell';
  if (t === 'fee') return 'fee';
  if (t === 'cash') {
    if (s === 'deposit' || s === 'contribution') return 'deposit';
    if (s === 'withdrawal' || s === 'distribution') return 'withdrawal';
    if (s === 'dividend' || s === 'interest' || s === 'non-qualified dividend' || s === 'qualified dividend' || s === 'interest receivable') {
      return 'dividend_interest';
    }
    if (s === 'management fee' || s === 'miscellaneous fee' || s === 'account fee' || s === 'legal fee') {
      return 'fee';
    }
    return 'other';
  }
  if (t === 'transfer') {
    // Sign disambiguates direction; the label just narrates it.
    return s === 'transfer fee' ? 'fee' : 'other';
  }
  return 'other';
};

/**
 * Map one page of `/investments/transactions/get` into KEEL canonical
 * transaction inputs. `investment_transactions` (array) + `securities` (array,
 * for enriching the description) are the two arrays consumed. Cancelled
 * transactions (Plaid `type: 'cancel'`) are skipped — they represent Plaid's
 * own reversal bookkeeping and would double-count against the original.
 */
export const mapInvestmentsTransactionsToKeel = (body: unknown): MappedPlaidInvestmentTxns => {
  if (!isRecord(body) || !Array.isArray(body['investment_transactions'])) {
    throw new Error('Plaid investments transactions response must contain investment_transactions');
  }
  const securities = Array.isArray(body['securities']) ? body['securities'] : [];
  const securitiesById = new Map<string, Record<string, unknown>>();
  for (const value of securities) {
    if (isRecord(value) && typeof value['security_id'] === 'string') {
      securitiesById.set(value['security_id'], value);
    }
  }

  const result: MappedPlaidInvestmentTxns = { transactions: [], skipped: [] };
  for (const value of body['investment_transactions']) {
    if (!isRecord(value)) throw new Error('Plaid investment transaction must be an object');
    const providerTransactionId = stringField(value, 'investment_transaction_id');
    const type = stringField(value, 'type');

    if (type.toLowerCase() === 'cancel') {
      result.skipped.push({ providerTransactionId, reason: 'cancelled' });
      continue;
    }

    const currency =
      typeof value['iso_currency_code'] === 'string' ? value['iso_currency_code'] : null;
    if (currency !== 'USD') {
      result.skipped.push({ providerTransactionId, reason: 'non_usd' });
      continue;
    }

    // Lossless money (Law 4): the worker feeds this mapper a response parsed
    // with parsePlaidJsonPreservingAmountLexemes, so `amount` is an exact
    // decimal STRING lexeme (never a JS float). A raw JS number is still
    // accepted (unit tests / any non-lossless caller) by rendering it to its
    // exact 2-decimal USD lexeme first. plaidAmountToKeelMinor negates Plaid's
    // cash-out-positive sign, yielding the account-balance effect in BigInt
    // minor units — the same conversion /transactions/sync uses.
    const rawAmount = value['amount'];
    let amountLexeme: string;
    if (typeof rawAmount === 'string') {
      amountLexeme = rawAmount;
    } else if (typeof rawAmount === 'number' && Number.isFinite(rawAmount)) {
      amountLexeme = rawAmount.toFixed(2);
    } else {
      result.skipped.push({ providerTransactionId, reason: 'invalid_amount' });
      continue;
    }
    let accountEffect: bigint;
    try {
      accountEffect = plaidAmountToKeelMinor(amountLexeme, 'USD');
    } catch {
      result.skipped.push({ providerTransactionId, reason: 'invalid_amount' });
      continue;
    }
    if (accountEffect === 0n) {
      result.skipped.push({ providerTransactionId, reason: 'zero_amount' });
      continue;
    }

    const subtype = optionalString(value, 'subtype');
    const accountExternalRef = stringField(value, 'account_id');
    const securityId = optionalString(value, 'security_id');
    const security = securityId ? securitiesById.get(securityId) : undefined;
    const providerName = optionalString(value, 'name');
    const securityName = security ? optionalString(security, 'name') : null;
    const description = (providerName ?? securityName ?? `${type} transaction`).slice(0, 500);
    // Cash-equivalent flag: the transacted security is a money-market / core
    // sweep (Plaid security `type: 'cash'`). Mirrors the holdings mapper's
    // cash-equivalent skip. When there is no joined security (a pure cash
    // deposit/withdrawal/fee has no security_id) this is false — only a
    // buy/sell CAN be a core sweep, and those always carry a security.
    const isCashEquivalent = security ? security['type'] === 'cash' : false;

    result.transactions.push({
      accountExternalRef,
      providerTransactionId,
      amountMinor: accountEffect.toString(),
      currency: 'USD',
      // (amountMinor is a canonical integer string; the worker passes it
      // straight to the RPC bigint param — never through Number()).
      date: stringField(value, 'date'),
      description,
      flow: classifyFlow(type, subtype),
      plaidType: type,
      plaidSubtype: subtype,
      isCashEquivalent,
    });
  }
  return result;
};

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
    const typeValue = security['type'];

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
      securityType: typeof typeValue === 'string' && typeValue.trim().length > 0 ? typeValue : null,
    });
  }
  return result;
};
