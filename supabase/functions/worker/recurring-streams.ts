// ---------------------------------------------------------------------------
// Plaid-primary recurring detection, Phase 1: mirror Plaid's own streams for
// ALLOWLISTED connections only (/transactions/recurring/get is a billed
// add-on — see 20260814100000_plaid_recurring_streams.sql). This endpoint
// only stores; nothing here writes recurring_series or any read model. Every
// text field it forwards is data-tier (Law 5) and every amount goes through
// the lexeme path (Law 4) — never a JS float.
// ---------------------------------------------------------------------------
export interface PlaidStreamRow {
  streamId: string;
  accountId: string | null;
  externalAccountRef: string;
  direction: 'inflow' | 'outflow';
  status: string;
  frequency: string;
  isActive: boolean;
  description: string | null;
  merchantName: string | null;
  categoryPrimary: string | null;
  firstDate: string;
  lastDate: string;
  predictedNextDate: string | null;
  averageAmountMinor: string;
  lastAmountMinor: string;
  currency: string;
  raw: unknown;
}

// Stream amounts are EVIDENCE, not postings: `average_amount` is a mean Plaid
// computes over the stream's transactions, so it routinely carries more than
// two decimals (e.g. 34.996666666666666 for three payments). The exact-decimal
// ledger parser rejects those outright — which silently dropped 5 of the first
// 6 live streams — so this rounds to cents with BigInt string math (half away
// from zero, no float anywhere) and only then applies the KEEL sign flip.
// Nothing derived from this value may ever post to the ledger.
const STREAM_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

export const streamAmountMinor = (amount: unknown): string | null => {
  const record = amount as { amount?: unknown } | null | undefined;
  const raw = record?.amount;
  const lexeme =
    typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : null;
  if (lexeme === null) return null;

  const match = STREAM_DECIMAL.exec(lexeme.trim());
  if (!match) return null;
  const [, sign, whole, fractionRaw = ''] = match;
  const fraction = fractionRaw.padEnd(3, '0');
  let minor = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) minor += 1n;
  // KEEL sign convention: a positive Plaid amount is money OUT, so it is
  // negative here — the same flip plaidAmountToKeelMinor applies on the
  // exact-decimal ledger path.
  return (sign === '-' ? minor : -minor).toString();
};

export const mapRecurringStream = (
  stream: Record<string, unknown>,
  direction: 'inflow' | 'outflow',
  accountByRef: Map<string, string>,
): PlaidStreamRow | null => {
  const streamId = typeof stream.stream_id === 'string' ? stream.stream_id : null;
  const externalAccountRef = typeof stream.account_id === 'string' ? stream.account_id : null;
  const firstDate = typeof stream.first_date === 'string' ? stream.first_date : null;
  const lastDate = typeof stream.last_date === 'string' ? stream.last_date : null;
  if (!streamId || !externalAccountRef || !firstDate || !lastDate) return null;

  const averageAmountMinor = streamAmountMinor(stream.average_amount);
  const lastAmountMinor = streamAmountMinor(stream.last_amount) ?? averageAmountMinor;
  if (averageAmountMinor === null || lastAmountMinor === null) return null;

  const personalFinanceCategory = stream.personal_finance_category as
    | { primary?: unknown }
    | null
    | undefined;
  const currencyRaw = (stream.average_amount as { iso_currency_code?: unknown } | null | undefined)
    ?.iso_currency_code;

  return {
    streamId,
    accountId: accountByRef.get(externalAccountRef) ?? null,
    externalAccountRef,
    direction,
    status: typeof stream.status === 'string' ? stream.status : 'UNKNOWN',
    frequency: typeof stream.frequency === 'string' ? stream.frequency : 'UNKNOWN',
    isActive: stream.is_active === true,
    description: typeof stream.description === 'string' ? stream.description : null,
    merchantName: typeof stream.merchant_name === 'string' ? stream.merchant_name : null,
    categoryPrimary:
      typeof personalFinanceCategory?.primary === 'string'
        ? personalFinanceCategory.primary
        : null,
    firstDate,
    lastDate,
    predictedNextDate:
      typeof stream.predicted_next_date === 'string' ? stream.predicted_next_date : null,
    averageAmountMinor,
    lastAmountMinor,
    currency: typeof currencyRaw === 'string' ? currencyRaw : 'USD',
    raw: stream,
  };
};

