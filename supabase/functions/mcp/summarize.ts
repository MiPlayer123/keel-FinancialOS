/**
 * Deterministic totals over transaction rows (Law 1: the model never adds
 * rows itself — it asks KEEL). Pure BigInt arithmetic on the rows the rich
 * transaction read returns, so a summary always agrees with the list.
 *
 * Sign convention (same as every KEEL transaction): amountMinor is signed
 * from the account's side — negative = money out. A split transaction
 * contributes each category leg's share (the leg is debit-positive, so the
 * cash-side share is its negation).
 */

export type GroupBy = 'category' | 'merchant' | 'account' | 'month' | 'tag' | 'entity';

export interface TxnRow {
  readonly transactionId?: string;
  readonly effectiveDate?: string;
  readonly description?: string;
  readonly amountMinor?: string;
  readonly currency?: string;
  readonly accountId?: string;
  readonly accountName?: string;
  readonly entityId?: string | null;
  readonly categoryLedgerAccountId?: string | null;
  readonly categoryName?: string | null;
  readonly categoryKind?: string | null;
  readonly splits?: readonly { categoryLedgerAccountId?: string | null; name?: string; kind?: string; amountMinor?: string; legType?: string; accountId?: string | null }[] | null;
  readonly tags?: readonly { tagId?: string; name?: string }[] | null;
  readonly transferStatus?: string | null;
  readonly distributionTransfer?: boolean | null;
  /** Set by keel_query_transactions: KEEL's cash flow leaves this row out. */
  readonly cashFlowExcluded?: boolean | null;
}

export interface GroupTotal {
  readonly key: string;
  readonly label: string;
  readonly currency: string;
  readonly inflowMinor: bigint;
  readonly outflowMinor: bigint;
  readonly netMinor: bigint;
  readonly count: number;
}

/**
 * Rows that are not income or spending: transfers between the user's own
 * accounts, plus everything KEEL's cash flow excludes (Transfers-category and
 * reimbursement-settlement rows, flagged server-side) — so a summary agrees
 * with overview_get / history_get cash flow.
 */
export const isTransfer = (row: TxnRow): boolean =>
  row.cashFlowExcluded === true ||
  row.distributionTransfer === true ||
  row.transferStatus === 'confirmed' ||
  row.categoryKind === 'transfer';

/** (key, label, signed cash amount) contributions of one row to the groups. */
const contributions = (
  row: TxnRow,
  groupBy: GroupBy,
): { key: string; label: string; amount: bigint; transfer?: boolean }[] => {
  const amount = BigInt(row.amountMinor ?? '0');
  switch (groupBy) {
    case 'category': {
      // A split row (several categories, or a category plus a leg to another
      // of the user's accounts, e.g. a paycheck's 401k share) contributes each
      // leg from the cash side. Legs into own accounts are transfers.
      if (row.splits && row.splits.length > 0) {
        return row.splits.map((s) =>
          s.legType === 'account'
            ? { key: `account:${s.accountId ?? s.name ?? ''}`, label: `Transfer: ${s.name ?? 'account'}`, amount: -BigInt(s.amountMinor ?? '0'), transfer: true }
            : { key: s.categoryLedgerAccountId ?? 'uncategorized', label: s.name ?? 'Uncategorized', amount: -BigInt(s.amountMinor ?? '0') });
      }
      return [{
        key: row.categoryLedgerAccountId ?? 'uncategorized',
        label: row.categoryName ?? 'Uncategorized',
        amount,
      }];
    }
    case 'merchant': {
      const label = (row.description ?? '').trim() || 'Unknown';
      return [{ key: label.toLowerCase(), label, amount }];
    }
    case 'account':
      return [{ key: row.accountId ?? 'unknown', label: row.accountName ?? 'Unknown account', amount }];
    case 'month': {
      const month = (row.effectiveDate ?? '').slice(0, 7) || 'unknown';
      return [{ key: month, label: month, amount }];
    }
    case 'tag': {
      const tags = row.tags ?? [];
      if (tags.length === 0) return [{ key: 'untagged', label: 'Untagged', amount }];
      return tags.map((t) => ({ key: t.tagId ?? t.name ?? 'tag', label: t.name ?? 'Tag', amount }));
    }
    case 'entity':
      return [{ key: row.entityId ?? 'none', label: row.entityId ?? 'None', amount }];
  }
};

export interface SummaryResult {
  readonly groups: readonly GroupTotal[];
  readonly totals: readonly Omit<GroupTotal, 'key' | 'label'>[];
  readonly transactionCount: number;
  readonly transfersExcluded: number;
}

export const summarize = (
  rows: readonly TxnRow[],
  groupBy: GroupBy,
  opts: { readonly includeTransfers: boolean },
): SummaryResult => {
  const groups = new Map<string, { key: string; label: string; currency: string; inflow: bigint; outflow: bigint; ids: Set<string> }>();
  const totals = new Map<string, { inflow: bigint; outflow: bigint; ids: Set<string> }>();
  let counted = 0;
  let transfersExcluded = 0;

  for (const row of rows) {
    if (!opts.includeTransfers && isTransfer(row)) {
      transfersExcluded++;
      continue;
    }
    counted++;
    const currency = row.currency ?? 'USD';
    const id = row.transactionId ?? String(counted);
    for (const c of contributions(row, groupBy)) {
      if (c.transfer && !opts.includeTransfers) continue;
      const gk = `${c.key}\u0000${currency}`;
      const g = groups.get(gk) ?? { key: c.key, label: c.label, currency, inflow: 0n, outflow: 0n, ids: new Set<string>() };
      if (c.amount >= 0n) g.inflow += c.amount;
      else g.outflow += -c.amount;
      g.ids.add(id);
      groups.set(gk, g);

      const t = totals.get(currency) ?? { inflow: 0n, outflow: 0n, ids: new Set<string>() };
      if (c.amount >= 0n) t.inflow += c.amount;
      else t.outflow += -c.amount;
      t.ids.add(id);
      totals.set(currency, t);
    }
  }

  const sorted = [...groups.values()]
    .map((g) => ({
      key: g.key,
      label: g.label,
      currency: g.currency,
      inflowMinor: g.inflow,
      outflowMinor: g.outflow,
      netMinor: g.inflow - g.outflow,
      count: g.ids.size,
    }))
    .sort((a, b) =>
      groupBy === 'month'
        ? a.key.localeCompare(b.key)
        : b.outflowMinor > a.outflowMinor ? 1 : b.outflowMinor < a.outflowMinor ? -1
        : b.inflowMinor > a.inflowMinor ? 1 : b.inflowMinor < a.inflowMinor ? -1
        : a.label.localeCompare(b.label));

  return {
    groups: sorted,
    totals: [...totals.entries()].map(([currency, t]) => ({
      currency,
      inflowMinor: t.inflow,
      outflowMinor: t.outflow,
      netMinor: t.inflow - t.outflow,
      count: t.ids.size,
    })),
    transactionCount: counted,
    transfersExcluded,
  };
};

/**
 * Turn "split this into these shares" into the contract's debit-positive
 * category legs (Law 1: KEEL does the division, never the model).
 *   amounts: positive shares that must add up to |amount|
 *   percent: basis points (1% = 100) adding up to 10000; largest-remainder rounding
 *   equal:   |amount| divided evenly; the first legs absorb the remainder
 * Returns legs whose amounts sum to exactly -amountMinor, or an error message.
 */
export const computeSplitLegs = (
  amountMinor: string,
  mode: 'amounts' | 'percent' | 'equal',
  parts: readonly { categoryId: string; amountMinor?: string; basisPoints?: number }[],
): { ok: true; legs: { categoryLedgerAccountId: string; amountMinor: string }[] } | { ok: false; message: string } => {
  const total = BigInt(amountMinor);
  if (total === 0n) return { ok: false, message: 'The transaction amount is zero.' };
  if (parts.length < 1 || parts.length > 30) return { ok: false, message: 'Give between 1 and 30 categories.' };
  const magnitude = total < 0n ? -total : total;
  // Category legs carry the opposite sign of the cash amount (debit-positive).
  const legSign = total < 0n ? 1n : -1n;

  let shares: bigint[];
  if (mode === 'amounts') {
    if (parts.some((p) => !/^[1-9][0-9]*$/.test(p.amountMinor ?? ''))) {
      return { ok: false, message: 'Each split needs a positive amount_minor (minor units).' };
    }
    shares = parts.map((p) => BigInt(p.amountMinor!));
    const sum = shares.reduce((a, b) => a + b, 0n);
    if (sum !== magnitude) {
      return { ok: false, message: `Split amounts add up to ${sum} but the transaction is ${magnitude} (minor units).` };
    }
  } else if (mode === 'percent') {
    if (parts.some((p) => !Number.isInteger(p.basisPoints) || (p.basisPoints ?? 0) <= 0)) {
      return { ok: false, message: 'Each split needs basis_points > 0 (1% = 100).' };
    }
    const bps = parts.map((p) => BigInt(p.basisPoints!));
    if (bps.reduce((a, b) => a + b, 0n) !== 10000n) {
      return { ok: false, message: 'Percentages must add up to 100% (10000 basis points).' };
    }
    const exact = bps.map((b) => magnitude * b);
    shares = exact.map((e) => e / 10000n);
    let remainder = magnitude - shares.reduce((a, b) => a + b, 0n);
    // Largest remainder first; ties keep input order.
    const order = exact.map((e, i) => ({ i, r: e % 10000n })).sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
    for (const { i } of order) {
      if (remainder === 0n) break;
      shares[i]! += 1n;
      remainder -= 1n;
    }
  } else {
    const n = BigInt(parts.length);
    const base = magnitude / n;
    let remainder = magnitude % n;
    shares = parts.map(() => {
      const extra = remainder > 0n ? 1n : 0n;
      remainder -= extra;
      return base + extra;
    });
  }

  if (shares.some((s) => s === 0n)) return { ok: false, message: 'A split would be zero; use fewer categories.' };
  return {
    ok: true,
    legs: parts.map((p, i) => ({ categoryLedgerAccountId: p.categoryId, amountMinor: (legSign * shares[i]!).toString() })),
  };
};
