import { getSupabaseBrowserClient } from '@/lib/supabase';

/** Shared envelope for read queries; every query is scoped to one household. */
export type QueryDiagnostics = {
  query: string;
  rpcMs?: number;
  edgeMs?: number;
  clientMs?: number;
};

export type QueryResult<Row> = {
  scope: { householdId: string };
  asOf: string;
  formulaVersion?: string;
  rows: Row[];
  diagnostics?: QueryDiagnostics;
};

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = (await getSupabaseBrowserClient().functions.invoke<T>(fn, {
    body,
  })) as { data: T | null; error: (Error & { context?: Response }) | null };
  if (error) {
    // Surface the server's typed error body instead of the generic
    // "non-2xx status code" — every toast in the app relies on this.
    const ctx = error.context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const detail = (await ctx.clone().json()) as { message?: string; code?: string };
        if (detail.message) {
          throw new Error(detail.code ? `${detail.message} (${detail.code})` : detail.message);
        }
      } catch (parseErr) {
        if (
          parseErr instanceof Error &&
          parseErr.message !== error.message &&
          !(parseErr instanceof SyntaxError)
        ) {
          throw parseErr;
        }
      }
    }
    throw error;
  }
  if (data === null) throw new Error('Empty response from KEEL API.');
  return data;
}

function recordKeelQueryTiming(diagnostics: QueryDiagnostics): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new CustomEvent('keel:query-timing', { detail: diagnostics }));
  if (window.localStorage.getItem('keel:perf') === '1') {
    console.debug('[keel:query]', diagnostics);
  }
}

/** POST /api/queries — read-only, household-scoped. `extra` carries query-specific params. */
export async function keelQuery<Row>(
  query: string,
  householdId: string,
  extra: Record<string, unknown> = {},
): Promise<QueryResult<Row>> {
  const startedAt = performance.now();
  const result = await invoke<QueryResult<Row>>('api/queries', { query, householdId, ...extra });
  const diagnostics = {
    ...result.diagnostics,
    query,
    clientMs: Math.trunc(performance.now() - startedAt),
  };
  recordKeelQueryTiming(diagnostics);
  return { ...result, diagnostics };
}

export type CashFlowRow = {
  currency: string;
  inflowMinor: string;
  outflowMinor: string;
  netMinor: string;
};

/** A typed KEEL command envelope. */
export type CommandEnvelope = {
  commandId: string;
  command: string;
  economicEventKey: string;
  actor: { kind: 'user'; userId: string };
  householdId: string;
  payload: Record<string, unknown>;
};

export type CommandResult = {
  commandId: string;
  economicEventKey: string;
  idempotentReplay: boolean;
  effects: Record<string, unknown>;
  asOf: string;
};

/** POST /api/commands — every write goes through here. */
export function keelCommand(envelope: CommandEnvelope): Promise<CommandResult> {
  return invoke<CommandResult>('api/commands', envelope);
}

/** Households the signed-in user belongs to (RLS-scoped direct read). */
export type HouseholdMembership = {
  householdId: string;
  name: string;
  role: string;
};

export async function fetchHouseholds(): Promise<HouseholdMembership[]> {
  const { data, error } = await getSupabaseBrowserClient()
    .from('household_memberships')
    .select('role, household_id, households(id, name)');
  if (error) throw error;

  type Row = {
    role: string;
    household_id: string;
    households: { id: string; name: string } | { id: string; name: string }[] | null;
  };

  return ((data as Row[] | null) ?? []).map((r) => {
    const h = Array.isArray(r.households) ? r.households[0] : r.households;
    return { householdId: r.household_id, name: h?.name ?? 'Household', role: r.role };
  });
}

/** Accounts for a household (RLS-scoped direct read). */
export type AccountRow = {
  id: string;
  name: string;
  subtype: string;
  ledgerAccountId: string;
  currency: string;
  entityId: string;
  /** Owning provider connection; null for manual accounts. Joined client-side
   *  against fetchConnections for per-row freshness/reauth (teardown C8). */
  connectionId: string | null;
  /** Set when the account is closed/archived (present so historical scope
   *  resolution can include closed accounts and pickers can label them). */
  archivedAt?: string | null;
};

export async function fetchAccounts(
  householdId: string,
  opts?: { includeArchived?: boolean },
): Promise<AccountRow[]> {
  let query = getSupabaseBrowserClient()
    .from('accounts')
    .select('id, name, subtype, ledger_account_id, currency, entity_id, connection_id, archived_at')
    .eq('household_id', householdId);
  // Scope resolution over HISTORY must see closed accounts too (review
  // r3603410820) — pickers default to active only.
  if (!opts?.includeArchived) query = query.is('archived_at', null);
  const { data, error } = await query.order('name');
  if (error) throw error;

  type Row = {
    id: string;
    name: string;
    subtype: string;
    ledger_account_id: string;
    currency: string;
    entity_id: string;
    connection_id: string | null;
    archived_at: string | null;
  };

  return ((data as Row[] | null) ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    subtype: r.subtype,
    ledgerAccountId: r.ledger_account_id,
    currency: r.currency,
    entityId: r.entity_id,
    connectionId: r.connection_id,
    archivedAt: r.archived_at,
  }));
}

/** Rename a real-world account (checking, card, …). Plain metadata edit. */
export async function renameAccount(input: {
  householdId: string;
  accountId: string;
  name: string;
}): Promise<unknown> {
  return invoke('api/accounts/rename', {
    householdId: input.householdId,
    accountId: input.accountId,
    name: input.name,
  });
}

/** Move an already-connected or manual account to a different entity. */
export async function reassignAccountEntity(input: {
  householdId: string;
  accountId: string;
  entityId: string;
}): Promise<unknown> {
  return invoke('api/accounts/reassign-entity', {
    householdId: input.householdId,
    accountId: input.accountId,
    entityId: input.entityId,
  });
}

/**
 * One current position in an account (S-inv-1a,
 * docs/harness/plans/investments-v1.md) — at most one row per
 * (account, symbol, source), upserted in place, not a dated history.
 * Descriptive only — never derived from or fed into the ledger. `qty` is
 * a decimal string (fractional shares are real; Law 4 keeps money BIGINT
 * but quantities are not money). `asOf` reflects when the row was last
 * touched, not a shared snapshot date across an account's positions.
 */
export type HoldingRow = {
  holdingId: string;
  accountId: string;
  asOf: string;
  symbol: string;
  name: string | null;
  qty: string;
  priceMinor: string;
  valueMinor: string;
  costBasisMinor: string | null;
  currency: string;
  source: 'manual' | 'plaid';
  /** Plaid's raw security type (equity, etf, fixed income, …) when synced;
   *  always null for manual entries. Coarse-bucketed at read time for the
   *  allocation view (S-inv-1c, lib/holdings-allocation.ts). */
  securityType: string | null;
  updatedAt: string;
};

/** Every current holding in scope, optionally limited to one account. */
export async function fetchHoldings(householdId: string, accountId?: string): Promise<HoldingRow[]> {
  const data = await invoke<{ rows?: HoldingRow[] }>('api/queries', {
    query: 'holdings.list',
    householdId,
    ...(accountId ? { accountId } : {}),
  });
  return Array.isArray(data.rows) ? data.rows : [];
}

export type InvestmentAccountRow = {
  accountId: string;
  name: string;
  subtype: string;
  currency: string;
  isManual: boolean;
  connectionId: string | null;
  currentMinor: string;
  availableMinor: string | null;
  balanceAsOf: string | null;
  /** Holdings-sync stats (investments-overview-v3): how many holdings the
   *  provider reported for this account at the last holdings sync (BEFORE the
   *  mapper's skips) and how many of those were skipped as cash-equivalent
   *  (money market sweep). All null until a sync has captured them — null
   *  means "unknown", never a fabricated 0 (Law 9). Lets the UI distinguish
   *  an all-cash account from one whose institution hasn't published
   *  positions yet. */
  holdingsProviderCount: number | null;
  holdingsCashEquivalentCount: number | null;
  holdingsSyncedAt: string | null;
};

export type InvestmentHoldingRow = {
  holdingId: string;
  accountId: string;
  accountName: string;
  asOf: string;
  symbol: string;
  name: string | null;
  qty: string;
  priceMinor: string;
  valueMinor: string;
  costBasisMinor: string | null;
  /** value − cost basis (signed minor units), or null when basis is unknown —
   *  never fabricated to 0 (Law 9: an unreported basis is a real distinction). */
  unrealizedGainMinor: string | null;
  /** Unrealized return in integer basis points, or null when basis is null or 0. */
  unrealizedGainBps: string | null;
  currency: string;
  source: 'manual' | 'plaid';
};

export type InvestmentAllocationRow = { symbol: string; name: string | null; valueMinor: string };

export type HoldingsErrorRow = {
  connectionId: string;
  displayName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorAt: string | null;
};

export type CurrencyTotalRow = { currency: string; totalMinor: string };
export type CurrencyValueRow = { currency: string; valueMinor: string };

export type InvestmentsOverview = {
  accounts: InvestmentAccountRow[];
  holdings: InvestmentHoldingRow[];
  allocation: InvestmentAllocationRow[];
  holdingsErrors: HoldingsErrorRow[];
  /** USD-only headline figures. Non-USD amounts live in the *ByCurrency arrays;
   *  they are never folded into these (no FX conversion happens server-side). */
  totalHoldingsValueMinor: string;
  totalBalanceMinor: string;
  /** USD cost basis / unrealized gain over the WITH-BASIS subset only. When
   *  holdingsWithBasisCount < holdingsCount, the excluded rows must be surfaced
   *  (Law 9): the gain total never mixes a full-value total against a partial cost. */
  totalCostBasisMinor: string;
  totalUnrealizedGainMinor: string;
  holdingsWithBasisCount: number;
  holdingsCount: number;
  balancesByCurrency: CurrencyTotalRow[];
  holdingsValueByCurrency: CurrencyValueRow[];
  currency: string;
};

/** Household-wide investments read model (accounts, holdings, allocation,
 *  totals, and any per-connection holdings sync errors to surface). */
export async function fetchInvestmentsOverview(householdId: string): Promise<InvestmentsOverview> {
  const data = await invoke<Partial<InvestmentsOverview>>('api/queries', {
    query: 'investments.overview',
    householdId,
  });
  return {
    // Normalize the v3 stat fields (an older server payload omits them):
    // undefined → null so the UI's "unknown" branch is deterministic.
    accounts: Array.isArray(data.accounts)
      ? data.accounts.map((a) => ({
          ...a,
          holdingsProviderCount: a.holdingsProviderCount ?? null,
          holdingsCashEquivalentCount: a.holdingsCashEquivalentCount ?? null,
          holdingsSyncedAt: a.holdingsSyncedAt ?? null,
        }))
      : [],
    holdings: Array.isArray(data.holdings) ? data.holdings : [],
    allocation: Array.isArray(data.allocation) ? data.allocation : [],
    holdingsErrors: Array.isArray(data.holdingsErrors) ? data.holdingsErrors : [],
    totalHoldingsValueMinor: data.totalHoldingsValueMinor ?? '0',
    totalBalanceMinor: data.totalBalanceMinor ?? '0',
    totalCostBasisMinor: data.totalCostBasisMinor ?? '0',
    totalUnrealizedGainMinor: data.totalUnrealizedGainMinor ?? '0',
    holdingsWithBasisCount:
      typeof data.holdingsWithBasisCount === 'number' ? data.holdingsWithBasisCount : 0,
    holdingsCount: typeof data.holdingsCount === 'number' ? data.holdingsCount : 0,
    balancesByCurrency: Array.isArray(data.balancesByCurrency) ? data.balancesByCurrency : [],
    holdingsValueByCurrency: Array.isArray(data.holdingsValueByCurrency)
      ? data.holdingsValueByCurrency
      : [],
    currency: data.currency ?? 'USD',
  };
}

export type InvestmentValuePoint = { date: string; valueMinor: string };

/** Daily total holdings value from snapshots, for the value-over-time chart. */
export async function fetchInvestmentsValueDaily(
  householdId: string,
): Promise<InvestmentValuePoint[]> {
  const data = await invoke<{ points?: InvestmentValuePoint[] }>('api/queries', {
    query: 'investments.value_daily',
    householdId,
  });
  return Array.isArray(data.points) ? data.points : [];
}

/** Create or edit a manual holding. Omit `holdingId` to create. */
export async function upsertHolding(input: {
  householdId: string;
  accountId: string;
  holdingId?: string;
  symbol: string;
  name?: string;
  qty: string;
  priceMinor: string;
  costBasisMinor?: string;
}): Promise<{ holdingId?: string }> {
  return invoke('api/holdings/upsert', {
    householdId: input.householdId,
    accountId: input.accountId,
    holdingId: input.holdingId ?? null,
    symbol: input.symbol,
    name: input.name ?? null,
    qty: input.qty,
    priceMinor: input.priceMinor,
    costBasisMinor: input.costBasisMinor ?? null,
  });
}

/** Delete a manual holding (Plaid-synced rows are never user-deletable here). */
export async function deleteHolding(input: { householdId: string; holdingId: string }): Promise<unknown> {
  return invoke('api/holdings/delete', {
    householdId: input.householdId,
    holdingId: input.holdingId,
  });
}

/** Connections for a household (RLS-scoped direct read; credentials never exposed). */
export type ConnectionRow = {
  id: string;
  provider: string;
  status: string;
  displayName: string | null;
  institutionId: string | null;
  lastSuccessfulSyncAt: string | null;
  /** True while the worker has an outstanding sync generation OR a partial
   * page's continuation hasn't landed yet for this connection — i.e. the
   * backfill isn't fully done, so ledger balances/totals are still a moving
   * target. Mirrors (a client-side, non-authoritative echo of) the guard in
   * keel_cmd_reanchor_balance. */
  isSyncing: boolean;
};

/** Mirrors keel_cmd_reanchor_balance's staleness cutoff (20260718101500) —
 * a continuation job that never got picked up (worker crash, permanent
 * reauth failure) shouldn't leave "Fix balance" permanently disabled. */
const CONTINUATION_STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * Pure decision for whether a connection is actively syncing, extracted so it
 * can be unit-tested without a Supabase round-trip.
 *
 * Only an ACTIVE connection can be mid-sync. A `disconnected` (or
 * `reauth_required` / `linking`) connection can still carry a leftover
 * generation mismatch — e.g. Fidelity was left at desired 57 vs committed 56
 * when a sync got interrupted by the disconnect — which must NOT read as
 * "syncing": with the connection no longer active nothing will ever advance
 * `sync_committed_generation`, so it would otherwise show "Syncing…" forever
 * and keep "Fix balance" / "Sync now" disabled on a dead connection.
 */
export function computeIsSyncing(input: {
  status: string;
  syncDesiredGeneration: number;
  syncCommittedGeneration: number;
  syncContinuationPending: boolean;
  syncContinuationMarkedAt: string | null;
  now?: number;
}): boolean {
  if (input.status !== 'active') return false;
  const now = input.now ?? Date.now();
  const continuationFresh =
    input.syncContinuationPending &&
    input.syncContinuationMarkedAt !== null &&
    now - new Date(input.syncContinuationMarkedAt).getTime() < CONTINUATION_STALE_AFTER_MS;
  return input.syncDesiredGeneration !== input.syncCommittedGeneration || continuationFresh;
}

export async function fetchConnections(householdId: string): Promise<ConnectionRow[]> {
  const { data, error } = await getSupabaseBrowserClient()
    .from('connections')
    .select(
      'id, provider, status, display_name, institution_id, last_successful_sync_at, sync_desired_generation, sync_committed_generation, sync_continuation_pending, sync_continuation_marked_at',
    )
    .eq('household_id', householdId)
    .is('archived_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  type Row = {
    id: string;
    provider: string;
    status: string;
    display_name: string | null;
    institution_id: string | null;
    last_successful_sync_at: string | null;
    sync_desired_generation: number;
    sync_committed_generation: number;
    sync_continuation_pending: boolean;
    sync_continuation_marked_at: string | null;
  };
  const now = Date.now();
  return ((data as Row[] | null) ?? []).map((r) => ({
    id: r.id,
    provider: r.provider,
    status: r.status,
    displayName: r.display_name,
    institutionId: r.institution_id,
    lastSuccessfulSyncAt: r.last_successful_sync_at,
    isSyncing: computeIsSyncing({
      status: r.status,
      syncDesiredGeneration: r.sync_desired_generation,
      syncCommittedGeneration: r.sync_committed_generation,
      syncContinuationPending: r.sync_continuation_pending,
      syncContinuationMarkedAt: r.sync_continuation_marked_at,
      now,
    }),
  }));
}

/** Trigger an immediate sync for one connection (also drained by the 3-min cron). */
export async function syncConnection(input: {
  householdId: string;
  connectionId: string;
}): Promise<unknown> {
  return invoke('api/connections/sync', {
    householdId: input.householdId,
    connectionId: input.connectionId,
  });
}

/** Rename a connection (empty string clears the custom name). */
export async function renameConnection(input: {
  householdId: string;
  connectionId: string;
  displayName: string;
}): Promise<unknown> {
  return invoke('api/connections/rename', {
    householdId: input.householdId,
    connectionId: input.connectionId,
    displayName: input.displayName,
  });
}

/**
 * A currently-active account that looks like the same real-world account as
 * an old, now-disconnected one at the same institution (matched by mask, or
 * by name+subtype when either side lacks a mask). Purely a suggestion —
 * nothing is merged until dedupeReconnectAccount is explicitly called.
 */
export type ReconnectMatchRow = {
  newAccountId: string;
  newAccountName: string;
  oldAccountId: string;
  oldAccountName: string;
  oldConnectionId: string;
  oldConnectionDisplayName: string | null;
  oldLastSyncedAt: string | null;
};

export async function fetchReconnectMatches(householdId: string): Promise<ReconnectMatchRow[]> {
  const result = await keelQuery<ReconnectMatchRow>('connections.list_reconnect_matches', householdId);
  return result.rows;
}

/**
 * Void the new account's transactions that duplicate ones already on the
 * old (disconnected) account for the overlapping window — the old account's
 * copies (with any existing categorization) stay authoritative. Does not
 * merge the two account rows; safe to call more than once.
 */
export async function dedupeReconnectAccount(input: {
  householdId: string;
  userId: string;
  newAccountId: string;
  oldAccountId: string;
}): Promise<CommandResult> {
  return keelCommand({
    commandId: newId(),
    command: 'accounts.dedupe_reconnect',
    economicEventKey: `dedupe-reconnect:${input.newAccountId}:${input.oldAccountId}:${newId()}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: {
      newAccountId: input.newAccountId,
      oldAccountId: input.oldAccountId,
    },
  });
}

/** Map of ledger_account_id → kind (asset/liability/income/expense/equity), RLS-scoped. */
export async function fetchLedgerKinds(householdId: string): Promise<Map<string, string>> {
  const { data, error } = await getSupabaseBrowserClient()
    .from('ledger_accounts')
    .select('id, kind')
    .eq('household_id', householdId);
  if (error) throw error;
  const rows = (data as { id: string; kind: string }[] | null) ?? [];
  return new Map(rows.map((r) => [r.id, r.kind]));
}

/**
 * Tax-line map INCLUDING archived categories: history can permanently
 * reference an archived category ("leave in place" archive), and a tax
 * report that silently drops it is the worst failure mode.
 */
export async function fetchCategoryTaxLines(householdId: string): Promise<Map<string, string>> {
  const { data, error } = await getSupabaseBrowserClient()
    .from('ledger_accounts')
    .select('id, tax_line')
    .eq('household_id', householdId)
    .eq('is_category', true)
    .not('tax_line', 'is', null);
  if (error) throw error;
  const rows = (data as { id: string; tax_line: string }[] | null) ?? [];
  return new Map(rows.map((r) => [r.id, r.tax_line]));
}

/** A financial entity (personal books, an LLC, a trust, …) within a household. */
export type EntityKind =
  'personal' | 'sole_prop' | 'llc_single' | 'llc_multi' | 's_corp' | 'trust' | 'other';

export type EntityRow = {
  entityId: string;
  name: string;
  kind: EntityKind;
};

/** All (non-archived) entities for a household, for the entity picker. */
export async function fetchEntities(householdId: string): Promise<EntityRow[]> {
  const data = await invoke<EntityRow[]>('api/queries', { query: 'entities.list', householdId });
  return Array.isArray(data) ? data : [];
}

/** Create a second (or subsequent) entity — e.g. an LLC alongside personal books. */
export async function createEntity(input: {
  householdId: string;
  name: string;
  kind: EntityKind;
}): Promise<{ entityId?: string }> {
  return invoke('api/entities/create', {
    householdId: input.householdId,
    name: input.name,
    kind: input.kind,
  });
}

/** Link a (Sandbox) institution. Backend performs the full server-side link. */
export async function linkConnection(input: {
  householdId: string;
  entityId: string;
  institutionId?: string;
}): Promise<unknown> {
  return invoke('api/connections/link', {
    commandId: newId(),
    householdId: input.householdId,
    entityId: input.entityId,
    ...(input.institutionId ? { institutionId: input.institutionId } : {}),
  });
}

/** Create a Plaid Link token so the browser can open Plaid Link (real bank auth). */
export async function createLinkToken(householdId: string): Promise<string> {
  const res = await invoke<{ linkToken: string }>('api/connections/link-token', { householdId });
  return res.linkToken;
}

/** Exchange a real Plaid-Link public_token → a connection (production/real flow). */
export async function exchangePublicToken(input: {
  householdId: string;
  entityId: string;
  publicToken: string;
  institutionName?: string;
}): Promise<{ connectionId?: string; accountIds?: string[] }> {
  return invoke('api/connections/link', {
    commandId: newId(),
    householdId: input.householdId,
    entityId: input.entityId,
    publicToken: input.publicToken,
    ...(input.institutionName ? { institutionName: input.institutionName } : {}),
  });
}

export async function disconnectConnection(input: {
  householdId: string;
  connectionId: string;
}): Promise<unknown> {
  return invoke('api/connections/disconnect', {
    commandId: newId(),
    householdId: input.householdId,
    connectionId: input.connectionId,
  });
}

// ---- Row shapes for the read queries we render ----

export type TransactionRow = {
  transactionId: string;
  accountId: string;
  status: 'pending' | 'posted' | 'reviewed';
  description: string;
  effectiveDate: string;
  economicEventKey: string;
};

/** Rich ledger row: amount, account, and category for display + re-categorize. */
/** One split of a multi-category transaction (real offset posting). */
export type TransactionSplit = {
  categoryLedgerAccountId: string;
  name: string;
  kind: 'income' | 'expense';
  /** Debit-positive: positive = spend on that category. */
  amountMinor: string;
};

export type RichTransactionRow = {
  transactionId: string;
  effectiveDate: string;
  /** Display description: the user's override when set, else the provider's. */
  description: string;
  /** Immutable provider description (absent until the overlay migration lands). */
  originalDescription?: string;
  /** User note (absent until the overlay migration lands). */
  note?: string | null;
  status: 'pending' | 'posted' | 'reviewed';
  /** Where the row came from (absent until the manual-transactions migration lands). */
  source?: 'sync' | 'import' | 'manual';
  accountId: string;
  accountName: string;
  /**
   * The owning account's entity (absent pre-migration). Categories are scoped
   * per entity and the categorize / set-splits procs reject a cross-entity
   * category, so the row's category picker entity-scopes to THIS entity: a
   * Personal-account transaction only offers Personal categories.
   */
  entityId?: string | null;
  /**
   * Masked account-number suffix (e.g. "1234" for "••1234"), teardown C6.
   * Absent/null pre-migration and for accounts linked before the mask
   * migration shipped (see 20260717220000_account_mask.sql) — the account
   * name-only display is the correct fallback, never a guessed suffix.
   */
  accountMask?: string | null;
  amountMinor: string;
  currency: string;
  categoryLedgerAccountId: string | null;
  categoryName: string | null;
  categoryKind: 'income' | 'expense' | null;
  /** Stable key for system categories (rename-proof "Uncategorized" checks). */
  categoryPfcKey?: string | null;
  /**
   * Provenance of the CURRENT single-offset category (absent pre-migration;
   * null when the transaction has never had an overlay written — still on
   * the Uncategorized landing pad). 'user' = a human confirmed it (directly,
   * or a suggestion the user approved — the approval path writes source
   * 'user' too); 'rule' / 'plaid_pfc' = machine-filed, never individually
   * reviewed. See lib/review-state.ts for the derived "Auto" badge check.
   */
  categorySource?: 'user' | 'rule' | 'plaid_pfc' | 'transfer_confirm' | null;
  /** Present (non-null) only for multi-split transactions. */
  splits?: TransactionSplit[] | null;
  /** User labels, orthogonal to categories (absent pre-tags-migration). */
  tags?: { tagId: string; name: string }[];
  /** Present when this transaction is one side of a suggested/confirmed transfer pair. */
  transferStatus?: 'suggested' | 'confirmed' | null;
  /** The transfer_links row id, so the sidebar can undo/unlink it (F-012). */
  transferLinkId?: string | null;
  /** True when KEEL synthesized the counterparty leg (undo reverses it); false for match/detector pairs (undo just unlinks). */
  transferBooked?: boolean | null;
  /** Other leg's account, present only once the pairing is CONFIRMED (absent pre-migration). */
  counterpartyAccountId?: string | null;
  counterpartyAccountName?: string | null;
  /** Other leg's transaction id, for a future "jump to" affordance. */
  counterpartyTransactionId?: string | null;
  /**
   * True once a closed reconciliation session matched this transaction to a
   * bank statement line (reconciliation_items.resolution = 'matched_transaction',
   * D-047). Absent/false = not (yet) reconciled — the common case; the chip
   * only renders on true (Law 8 hides-at-absence, same as Needs-attention).
   */
  reconciled?: boolean;
};

/** Keyset cursor for the paginated rich read (WS-H F-005). */
export type RichPageCursor = { effectiveDate: string; transactionId: string };

/**
 * One page of the rich transaction read. `rows` uses the EXACT same DTO as the
 * unbounded `transactions.rich` (RichTransactionRow); `nextCursor` is null when
 * the last page has been reached. Deterministic order: effective_date desc, id.
 */
export type RichTransactionPage = {
  rows: RichTransactionRow[];
  nextCursor: RichPageCursor | null;
  asOf: string;
};

/** Server-side filters for a rich page fetch. All optional. */
export type RichPageFilters = {
  limit?: number;
  cursor?: RichPageCursor | null;
  accountId?: string;
  categoryId?: string;
  search?: string;
};

/**
 * Fetch ONE keyset page of the rich transaction read (WS-H F-005). Bounded and
 * server-filtered — replaces downloading the whole household then filtering
 * client-side. The envelope carries `nextCursor`; pass it back as `cursor` for
 * the next page (infinite scroll / load-more).
 */
export async function fetchRichPage(
  householdId: string,
  filters: RichPageFilters = {},
): Promise<RichTransactionPage> {
  const extra: Record<string, unknown> = {};
  if (filters.limit !== undefined) extra.limit = filters.limit;
  if (filters.cursor) {
    extra.cursorDate = filters.cursor.effectiveDate;
    extra.cursorId = filters.cursor.transactionId;
  }
  if (filters.accountId) extra.accountId = filters.accountId;
  if (filters.categoryId) extra.categoryId = filters.categoryId;
  if (filters.search) extra.search = filters.search;
  const result = await keelQuery<RichTransactionRow>('transactions.rich_page', householdId, extra);
  const withCursor = result as QueryResult<RichTransactionRow> & {
    nextCursor?: RichPageCursor | null;
  };
  return { rows: result.rows, nextCursor: withCursor.nextCursor ?? null, asOf: result.asOf };
}

/**
 * Fetch EVERY transaction for one account by walking the keyset pages
 * server-side (WS-H F-005). Replaces the account-detail page's old pattern of
 * downloading the WHOLE household's rich list then filtering client-side by
 * accountId — now the server filters, and only that account's rows cross the
 * wire. A single account is bounded (hundreds of rows), and the running-balance
 * + spending-mix computations on that page need the full account set, so we
 * page through to completion (max ~pages of 200) rather than lazily. Guarded by
 * a hard page cap so a pathological dataset can never loop forever.
 */
export async function fetchAllAccountTransactions(
  householdId: string,
  accountId: string,
): Promise<RichTransactionRow[]> {
  const all: RichTransactionRow[] = [];
  let cursor: RichPageCursor | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const page: RichTransactionPage = await fetchRichPage(householdId, {
      accountId,
      limit: 200,
      cursor,
    });
    all.push(...page.rows);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return all;
}

/** Slim command-palette search hit (WS-H F-021). */
export type TransactionSearchHit = {
  transactionId: string;
  effectiveDate: string;
  description: string;
  accountId: string;
  accountName: string;
  amountMinor: string;
  currency: string;
};

/**
 * Server-side transaction/payee search for the command palette (F-021). Backed
 * by `keel_search_transactions` — never a client-side scan over a full
 * download. Returns at most `limit` (default 8, server-clamped to 25) hits.
 */
export async function searchTransactions(
  householdId: string,
  search: string,
  limit = 8,
): Promise<TransactionSearchHit[]> {
  const result = await keelQuery<TransactionSearchHit>('transactions.search', householdId, {
    search,
    limit,
  });
  return result.rows;
}

export type CategoryRow = {
  ledgerAccountId: string;
  name: string;
  kind: 'income' | 'expense';
  entityId: string;
  /**
   * Human-readable owning-entity name ("Personal" / "Business (LLC)"). Absent
   * pre-migration. Categories are scoped per entity, so identically-named
   * categories exist once per entity — this label disambiguates them on
   * cross-entity views (Add-category budgeting picker) where entity-scoping
   * isn't possible. Data-tier string, only displayed (Law 5).
   */
  entityName?: string | null;
  /** Parent category for one-level nesting (absent pre-migration). */
  parentLedgerAccountId?: string | null;
  /** Seeded system category (renameable but key-stable). */
  isSystem?: boolean;
  pfcKey?: string | null;
  /** Optional IRS line for the tax schedule (absent pre-migration). */
  taxLine?: string | null;
};

/** Map a category to an IRS tax line (null clears). User-set only. */
export async function setCategoryTaxLine(input: {
  householdId: string;
  categoryLedgerAccountId: string;
  taxLine: string | null;
}): Promise<unknown> {
  return invoke('api/categories/set-tax-line', {
    householdId: input.householdId,
    categoryLedgerAccountId: input.categoryLedgerAccountId,
    taxLine: input.taxLine,
  });
}

/** Categories (ledger accounts flagged is_category) for the re-categorize picker. */
export async function fetchCategories(householdId: string): Promise<CategoryRow[]> {
  const data = await invoke<CategoryRow[]>('api/queries', {
    query: 'categories.list',
    householdId,
  });
  return Array.isArray(data) ? data : [];
}

/** Latest provider balance per account (current + available). */
export type LatestBalanceRow = {
  accountId: string;
  currentMinor: string;
  availableMinor: string | null;
  /** Provider-reported credit limit (absent/null until the limit migration
   *  lands or when the institution reports none) — teardown C9. */
  limitMinor?: string | null;
  currency: string;
  asOf: string;
};

export async function fetchLatestBalances(householdId: string): Promise<LatestBalanceRow[]> {
  const data = await invoke<LatestBalanceRow[]>('api/queries', {
    query: 'balances.latest',
    householdId,
  });
  return Array.isArray(data) ? data : [];
}

/** One point of a deterministic daily balance/net-worth series. */
export type DailyBalanceRow = {
  date: string;
  currency: string;
  balanceMinor: string;
};

/** One month of transfer-excluded cash flow. */
export type MonthlyCashFlowRow = {
  month: string;
  currency: string;
  inflowMinor: string;
  outflowMinor: string;
  netMinor: string;
};

/** One detected transfer pair (out side → in side). */
export type TransferLinkRow = {
  linkId: string;
  status: 'suggested' | 'confirmed';
  effectiveDate: string;
  amountMinor: string;
  currency: string;
  outTxnId: string;
  outDescription: string;
  outAccountId: string;
  outAccountName: string;
  inTxnId: string;
  inDescription: string;
  inAccountId: string;
  inAccountName: string;
  dayGap: number;
};

/** Run deterministic transfer detection; returns the number of new suggestions. */
export async function detectTransfers(householdId: string): Promise<number> {
  const res = await invoke<{ suggested?: number }>('api/transfers/detect', { householdId });
  return typeof res.suggested === 'number' ? res.suggested : 0;
}

/** Confirm (exclude from cash flow) or reject a suggested transfer pair. */
export async function decideTransfer(input: {
  householdId: string;
  linkId: string;
  confirm: boolean;
}): Promise<unknown> {
  return invoke('api/transfers/decide', {
    householdId: input.householdId,
    linkId: input.linkId,
    confirm: input.confirm,
  });
}

/**
 * Manually mark two transactions as a transfer pair — for near-misses (a
 * wire fee, a longer float) that keel_detect_transfers' exact-amount/±3-day
 * rule doesn't catch. Lands as 'suggested', same as auto-detection; still
 * needs a confirm on Review.
 */
export async function linkTransfer(input: {
  householdId: string;
  txnA: string;
  txnB: string;
}): Promise<{ linkId?: string }> {
  return invoke('api/transfers/link', {
    householdId: input.householdId,
    txnA: input.txnA,
    txnB: input.txnB,
  });
}

/**
 * F-012 MATCH path: link two existing opposite transactions AND confirm the
 * pairing in one round-trip. Used when the user picks the "Transfers" category
 * and KEEL found an existing opposite transaction on the counterparty account
 * — the counterparty pick is the approval, so the pair is confirmed
 * immediately and excluded from cash flow (no intermediate Review step).
 */
export async function linkAndConfirmTransfer(input: {
  householdId: string;
  txnA: string;
  txnB: string;
}): Promise<{ linkId?: string }> {
  return invoke('api/transfers/link-confirm', {
    householdId: input.householdId,
    txnA: input.txnA,
    txnB: input.txnB,
  });
}

/**
 * F-012 BOOK path: no opposite transaction exists on the chosen counterparty
 * account (typical for a manual/unconnected account — a cash jar, a 401k).
 * The server posts the balanced opposite cash leg there, creates its
 * canonical transaction, and confirms the pairing — atomically and idempotent
 * on the source transaction id (a retry replays to the same booked leg).
 */
export async function bookTransferCounterparty(input: {
  householdId: string;
  sourceTxnId: string;
  counterpartyAccountId: string;
  /**
   * Per-attempt idempotency nonce (P1-4). A retry of the SAME click replays to
   * the same booked leg; a book→undo→re-book uses a FRESH key and is a new
   * attempt, so undo no longer wedges re-booking.
   */
  attemptKey: string;
}): Promise<{ effects?: { linkId?: string; bookedTxnId?: string } }> {
  return invoke('api/transfers/book', {
    householdId: input.householdId,
    sourceTxnId: input.sourceTxnId,
    counterpartyAccountId: input.counterpartyAccountId,
    attemptKey: input.attemptKey,
  });
}

/**
 * F-012 UNDO path: reverse/unlink a confirmed transfer from the txn detail.
 * A booked transfer reverses the synthesized counterparty leg (compensating
 * reversal, never a delete); a match/detector pair is simply unlinked. Both
 * re-include the affected legs in cash flow.
 */
export async function undoTransfer(input: {
  householdId: string;
  linkId: string;
}): Promise<{ status?: string }> {
  return invoke('api/transfers/undo', {
    householdId: input.householdId,
    linkId: input.linkId,
  });
}

/**
 * One pending categorization suggestion (P0-B suggest→approve loop). Typed
 * evidence record (Law 11): reasonCode + evidence carry the proof; nothing is
 * applied until the user decides via `categorization.decide_suggestion`.
 */
export type CategorySuggestionRow = {
  suggestionId: string;
  status: 'suggested' | 'accepted' | 'dismissed';
  source: 'pfc' | 'rule';
  reasonCode: 'rule_match' | 'pfc_mapping';
  evidence: { ruleId?: string; pattern?: string; pfcPrimary?: string; pfcKey?: string };
  canonicalTransactionId: string;
  effectiveDate: string;
  description: string;
  originalDescription: string;
  accountName: string;
  amountMinor: string;
  currency: string;
  suggestedCategoryLedgerAccountId: string;
  suggestedCategoryName: string;
  suggestedCategoryKind: 'expense' | 'income';
  currentCategoryName: string;
  /** FROZEN as-detected rule pattern (from evidence) — drives the reason line. */
  rulePattern: string | null;
  /** The rule's pattern as it reads NOW (null if deleted) — Why panel only. */
  ruleLivePattern: string | null;
};

/** Run deterministic categorization detection; returns new suggestion count. */
export async function detectCategorySuggestions(householdId: string): Promise<number> {
  const res = await invoke<{ suggested?: number }>('api/categorization/detect', { householdId });
  return typeof res.suggested === 'number' ? res.suggested : 0;
}

/** Class-C cash projection (preview-only): daily series + upcoming bills. */
export type ForecastBill = {
  date: string;
  seriesId: string;
  name: string;
  sign: 'inflow' | 'outflow';
  amountMinor: string;
  currency: string;
};

export async function fetchCashFlowForecast(
  householdId: string,
  days = 30,
): Promise<{ rows: DailyBalanceRow[]; bills: ForecastBill[] } | null> {
  try {
    const res = await invoke<{ rows?: DailyBalanceRow[]; bills?: ForecastBill[] }>('api/queries', {
      query: 'dashboard.cash_flow_forecast',
      householdId,
      days,
    });
    return { rows: res.rows ?? [], bills: res.bills ?? [] };
  } catch {
    return null;
  }
}

/** One expense category's budget + pinned spent for a month. */
export type BudgetRow = {
  categoryLedgerAccountId: string;
  categoryName: string;
  currency: string;
  /**
   * Owning-entity name, when known (the Add-category picker carries it so a
   * cross-entity budgeting view can disambiguate identically-named categories).
   * Absent on the server budgets read model; populated client-side from the
   * category taxonomy where it matters.
   */
  entityName?: string | null;
  /** Parent category for one-level nesting (absent pre-migration). */
  parentLedgerAccountId?: string | null;
  budgetMinor: string | null;
  /** Carry-forward budgeting (absent pre-rollover-migration). */
  rollover?: boolean;
  /** Signed carry from prior rollover months; null unless rollover is on. */
  carryMinor?: string | null;
  /** budget + carry when rollover is on, else the budget itself. */
  availableMinor?: string | null;
  spentMinor: string;
};

export async function fetchBudgets(householdId: string, monthIso: string): Promise<BudgetRow[]> {
  const res = await invoke<QueryResult<BudgetRow>>('api/queries', {
    query: 'budgets.list',
    householdId,
    month: monthIso,
  });
  return res.rows;
}

export async function setBudget(input: {
  householdId: string;
  categoryLedgerAccountId: string;
  monthIso: string;
  /** Non-negative minor units, or null to clear. */
  amountMinor: string | null;
  /** Omit to leave the carry-forward flag unchanged. */
  rollover?: boolean;
}): Promise<unknown> {
  return invoke('api/budgets/set', {
    householdId: input.householdId,
    categoryLedgerAccountId: input.categoryLedgerAccountId,
    month: input.monthIso,
    amountMinor: input.amountMinor,
    ...(input.rollover !== undefined ? { rollover: input.rollover } : {}),
  });
}

export async function copyBudgets(householdId: string, monthIso: string): Promise<number> {
  const res = await invoke<{ copied?: number }>('api/budgets/copy', {
    householdId,
    month: monthIso,
  });
  return typeof res.copied === 'number' ? res.copied : 0;
}

// ---------------------------------------------------------------------------
// Budgeting v2 (SLICE B2) — planned total + opt-in category targets, resolved
// by keel_budget_month (formulaVersion budget-v4-plan). Money is minor-unit
// STRINGS; percents are integer basis points (0..10000). See migration
// 20260720170000_budgeting_v2_plan.sql.
// ---------------------------------------------------------------------------

export type BudgetTargetKind = 'amount' | 'percent_of_total';
export type BudgetTotalBasis = 'amount' | 'percent_of_income';

export type BudgetMonthRow = {
  categoryLedgerAccountId: string;
  categoryName: string;
  parentLedgerAccountId: string | null;
  currency: string;
  kind: BudgetTargetKind;
  /** Amount rows carry amountMinor; percent rows carry percentBp. */
  declared: { amountMinor?: string; percentBp?: number };
  /** Resolved target in minor units (amount as-is, or floor(total×bp/10000)). */
  resolvedMinor: string;
  spentMinor: string;
  rollover: boolean;
  /** Signed carry from prior rollover months; null unless rollover is on. */
  carryMinor: string | null;
  /** resolvedMinor + carry when rollover is on, else resolvedMinor. */
  availableMinor: string;
};

export type BudgetMonth = {
  scope: { householdId: string; month: string };
  asOf: string;
  formulaVersion: string;
  total: {
    /** 'amount' | 'percent_of_income' | 'implicit_sum' (no explicit total set). */
    basis: string;
    resolvedMinor: string;
    declaredAmountMinor: string | null;
    declaredPercentBp: number | null;
  };
  expectedIncomeMinor: string | null;
  /** total − Σ resolved category targets. Negative = over-allocated (flag). */
  leftToBudgetMinor: string;
  everythingElseSpentMinor: string;
  rows: BudgetMonthRow[];
};

/** The v4 plan read model for a month (opt-in categories + total + residual). */
export async function fetchBudgetMonth(householdId: string, monthIso: string): Promise<BudgetMonth> {
  return invoke<BudgetMonth>('api/queries', {
    query: 'budgets.month',
    householdId,
    month: monthIso,
  });
}

/** budgets.set_total — the plan total (dollar amount OR % of expected income). */
export async function setBudgetTotal(input: {
  householdId: string;
  userId: string;
  monthIso: string;
  basis: BudgetTotalBasis;
  /** minor-unit string; required iff basis === 'amount'. */
  amountMinor?: string;
  /** integer bp 0..10000; required iff basis === 'percent_of_income'. */
  percentBp?: number;
}): Promise<CommandResult> {
  return keelCommand({
    commandId: newId(),
    command: 'budgets.set_total',
    economicEventKey: `budgets.set_total:${input.householdId}:${input.monthIso}:${newId()}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload:
      input.basis === 'amount'
        ? { month: input.monthIso, basis: 'amount', amountMinor: input.amountMinor }
        : { month: input.monthIso, basis: 'percent_of_income', percentBp: input.percentBp },
  });
}

/** budgets.set_target — one category target (dollar amount OR % of the total). */
export async function setBudgetTarget(input: {
  householdId: string;
  userId: string;
  monthIso: string;
  categoryLedgerAccountId: string;
  kind: BudgetTargetKind;
  amountMinor?: string;
  percentBp?: number;
  rollover?: boolean;
}): Promise<CommandResult> {
  return keelCommand({
    commandId: newId(),
    command: 'budgets.set_target',
    economicEventKey: `budgets.set_target:${input.categoryLedgerAccountId}:${input.monthIso}:${newId()}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload:
      input.kind === 'amount'
        ? {
            month: input.monthIso,
            categoryLedgerAccountId: input.categoryLedgerAccountId,
            kind: 'amount',
            amountMinor: input.amountMinor,
            ...(input.rollover !== undefined ? { rollover: input.rollover } : {}),
          }
        : {
            month: input.monthIso,
            categoryLedgerAccountId: input.categoryLedgerAccountId,
            kind: 'percent_of_total',
            percentBp: input.percentBp,
            ...(input.rollover !== undefined ? { rollover: input.rollover } : {}),
          },
  });
}

/** budgets.remove_target — soft removal (end-date); the category rejoins the residual. */
export async function removeBudgetTarget(input: {
  householdId: string;
  userId: string;
  monthIso: string;
  categoryLedgerAccountId: string;
}): Promise<CommandResult> {
  return keelCommand({
    commandId: newId(),
    command: 'budgets.remove_target',
    economicEventKey: `budgets.remove_target:${input.categoryLedgerAccountId}:${input.monthIso}:${newId()}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: { month: input.monthIso, categoryLedgerAccountId: input.categoryLedgerAccountId },
  });
}

/** budgets.set_expected_income — user-confirmed expected income for a month. */
export async function setBudgetExpectedIncome(input: {
  householdId: string;
  userId: string;
  monthIso: string;
  amountMinor: string;
}): Promise<CommandResult> {
  return keelCommand({
    commandId: newId(),
    command: 'budgets.set_expected_income',
    economicEventKey: `budgets.set_expected_income:${input.householdId}:${input.monthIso}:${newId()}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: { month: input.monthIso, amountMinor: input.amountMinor },
  });
}

/** Create a custom category, optionally nested one level under a parent. */
export async function createCategory(input: {
  householdId: string;
  name: string;
  kind: 'expense' | 'income';
  parentLedgerAccountId?: string | null;
  entityId?: string | null;
}): Promise<{ ledgerAccountId?: string }> {
  return invoke<{ ledgerAccountId?: string }>('api/categories/create', {
    householdId: input.householdId,
    name: input.name,
    kind: input.kind,
    parentLedgerAccountId: input.parentLedgerAccountId ?? null,
    entityId: input.entityId ?? null,
  });
}

/** Rename any live category (system names are display-only; keys are stable). */
export async function renameCategory(input: {
  householdId: string;
  categoryLedgerAccountId: string;
  name: string;
}): Promise<unknown> {
  return invoke('api/categories/rename', {
    householdId: input.householdId,
    categoryLedgerAccountId: input.categoryLedgerAccountId,
    name: input.name,
  });
}

/** Archive (soft-hide) a category; optionally reassign its overlays/rules/budgets. */
export async function archiveCategory(input: {
  householdId: string;
  categoryLedgerAccountId: string;
  reassignTo?: string | null;
}): Promise<unknown> {
  return invoke('api/categories/archive', {
    householdId: input.householdId,
    categoryLedgerAccountId: input.categoryLedgerAccountId,
    reassignTo: input.reassignTo ?? null,
  });
}

/** Nest a category under a parent (or null to promote to top level). */
export async function reparentCategory(input: {
  householdId: string;
  categoryLedgerAccountId: string;
  parentLedgerAccountId: string | null;
}): Promise<unknown> {
  return invoke('api/categories/reparent', {
    householdId: input.householdId,
    categoryLedgerAccountId: input.categoryLedgerAccountId,
    parentLedgerAccountId: input.parentLedgerAccountId,
  });
}

/** One user label (orthogonal to categories). */
export type TagRow = { tagId: string; name: string; usageCount: number };

export async function fetchTags(householdId: string): Promise<TagRow[]> {
  const data = await invoke<TagRow[]>('api/queries', { query: 'tags.list', householdId });
  return Array.isArray(data) ? data : [];
}

/** Create (no tagId) or rename a tag. */
export async function saveTag(input: {
  householdId: string;
  tagId?: string;
  name: string;
}): Promise<{ tagId?: string }> {
  return invoke('api/tags/save', {
    householdId: input.householdId,
    ...(input.tagId ? { tagId: input.tagId } : {}),
    name: input.name,
  });
}

export async function deleteTag(householdId: string, tagId: string): Promise<unknown> {
  return invoke('api/tags/delete', { householdId, tagId });
}

/** Add or remove one tag on one transaction (idempotent both ways). */
export async function assignTag(input: {
  householdId: string;
  transactionId: string;
  tagId: string;
  assigned: boolean;
}): Promise<unknown> {
  return invoke('api/tags/assign', {
    householdId: input.householdId,
    transactionId: input.transactionId,
    tagId: input.tagId,
    assigned: input.assigned,
  });
}

/** One user-authored categorization/rename rule. */
export type RuleRow = {
  ruleId: string;
  pattern: string;
  categoryLedgerAccountId: string | null;
  categoryName: string | null;
  renameTo: string | null;
  priority: number;
  active: boolean;
  /** C18 residual: optional AND condition — abs(amount_minor) >= this. Null = no lower bound. */
  amountMinMinor: string | null;
  /** C18 residual: optional AND condition — abs(amount_minor) <= this. Null = no upper bound. */
  amountMaxMinor: string | null;
};

export async function fetchRules(householdId: string): Promise<RuleRow[]> {
  const res = await keelQuery<RuleRow>('rules.list', householdId);
  return res.rows;
}

export async function saveRule(input: {
  householdId: string;
  ruleId?: string;
  pattern: string;
  categoryLedgerAccountId?: string | null;
  renameTo?: string | null;
  priority?: number;
  active?: boolean;
  /** BIGINT minor units as a string (Law 4). Both optional/independent; null clears the bound. */
  amountMinMinor?: string | null;
  amountMaxMinor?: string | null;
}): Promise<{ ruleId?: string }> {
  return invoke('api/rules/save', {
    householdId: input.householdId,
    ...(input.ruleId ? { ruleId: input.ruleId } : {}),
    pattern: input.pattern,
    categoryLedgerAccountId: input.categoryLedgerAccountId ?? null,
    renameTo: input.renameTo ?? null,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.active !== undefined ? { active: input.active } : {}),
    amountMinMinor: input.amountMinMinor ?? null,
    amountMaxMinor: input.amountMaxMinor ?? null,
  });
}

export async function deleteRule(householdId: string, ruleId: string): Promise<unknown> {
  return invoke('api/rules/delete', { householdId, ruleId });
}

/** Two-phase retroactive apply: dryRun previews counts, then confirm. */
export async function applyRules(
  householdId: string,
  dryRun: boolean,
): Promise<{ dryRun: boolean; categorized: number; renamed: number }> {
  return invoke('api/rules/apply', { householdId, dryRun });
}

/** Set/clear the user display name + note for a transaction (blank clears). */
export async function overrideTransaction(input: {
  householdId: string;
  transactionId: string;
  displayDescription: string;
  note: string;
}): Promise<unknown> {
  return invoke('api/transactions/override', {
    householdId: input.householdId,
    transactionId: input.transactionId,
    displayDescription: input.displayDescription,
    note: input.note,
  });
}

/** Re-categorize a transaction (mutable classification overlay). */
export async function categorizeTransaction(input: {
  householdId: string;
  transactionId: string;
  categoryLedgerAccountId: string;
}): Promise<unknown> {
  return invoke('api/transactions/categorize', {
    householdId: input.householdId,
    transactionId: input.transactionId,
    categoryLedgerAccountId: input.categoryLedgerAccountId,
  });
}

export type TrialBalanceRow = {
  ledgerAccountId: string;
  currency: string;
  balanceMinor: string;
};

export type GoalRow = {
  goalId: string;
  name: string;
  /** Positive minor units. */
  targetMinor: string;
  targetDate: string | null;
  accountId: string | null;
  currency: string;
  status: 'active' | 'reached' | 'archived';
  /** 'savings' (default) or 'debt'. */
  kind: 'savings' | 'debt';
  /** Σ contributions (earmarked, never posted — money doesn't move). Debt goals: always '0'. */
  savedMinor: string;
  /** Debt goals only: start_balance_minor - current balance magnitude, floored at 0 — derived from the ledger. */
  paidMinor?: string;
  /** Debt goals only: current liability balance magnitude, live from journal_postings. */
  currentBalanceMinor?: string;
};

export async function fetchGoals(householdId: string): Promise<GoalRow[]> {
  const data = await invoke<GoalRow[]>('api/queries', { query: 'goals.list', householdId });
  return Array.isArray(data) ? data : [];
}

/** Create (no goalId) or update a savings/debt goal. */
export async function saveGoal(input: {
  householdId: string;
  goalId?: string;
  name: string;
  targetMinor: string;
  targetDate: string | null;
  accountId: string | null;
  kind?: 'savings' | 'debt';
}): Promise<{ goalId?: string }> {
  return invoke('api/goals/save', {
    householdId: input.householdId,
    goalId: input.goalId ?? null,
    name: input.name,
    targetMinor: input.targetMinor,
    targetDate: input.targetDate,
    accountId: input.accountId,
    kind: input.kind ?? 'savings',
  });
}

/** Add (positive) or withdraw (negative) an earmark. */
export async function contributeGoal(input: {
  householdId: string;
  goalId: string;
  amountMinor: string;
  contributedOn: string;
}): Promise<{ savedMinor?: string; status?: string }> {
  return invoke('api/goals/contribute', {
    householdId: input.householdId,
    goalId: input.goalId,
    amountMinor: input.amountMinor,
    contributedOn: input.contributedOn,
  });
}

export async function setGoalStatus(input: {
  householdId: string;
  goalId: string;
  status: 'active' | 'archived';
}): Promise<unknown> {
  return invoke('api/goals/set-status', {
    householdId: input.householdId,
    goalId: input.goalId,
    status: input.status,
  });
}

export type ScheduleRow = {
  scheduleId: string;
  accountId: string;
  description: string;
  /** Signed minor units: negative = bill, positive = income. */
  amountMinor: string;
  currency: string;
  categoryLedgerAccountId: string | null;
  categoryName: string | null;
  frequency: 'once' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'semiannual' | 'annual';
  nextDueDate: string;
  autoEnterDays: number | null;
  anchorDay: number | null;
  status: 'active' | 'paused';
};

export async function fetchSchedules(householdId: string): Promise<ScheduleRow[]> {
  const data = await invoke<ScheduleRow[]>('api/queries', {
    query: 'schedules.list',
    householdId,
  });
  return Array.isArray(data) ? data : [];
}

/** Create (no scheduleId) or update a scheduled bill/income. */
export async function saveSchedule(input: {
  householdId: string;
  scheduleId?: string;
  accountId: string;
  description: string;
  amountMinor: string;
  categoryLedgerAccountId: string | null;
  frequency: ScheduleRow['frequency'];
  nextDueDate: string;
  autoEnterDays: number | null;
}): Promise<{ scheduleId?: string }> {
  return invoke('api/schedules/save', {
    householdId: input.householdId,
    scheduleId: input.scheduleId ?? null,
    accountId: input.accountId,
    description: input.description,
    amountMinor: input.amountMinor,
    categoryLedgerAccountId: input.categoryLedgerAccountId,
    frequency: input.frequency,
    nextDueDate: input.nextDueDate,
    autoEnterDays: input.autoEnterDays,
  });
}

export async function setScheduleStatus(input: {
  householdId: string;
  scheduleId: string;
  status: 'active' | 'paused' | 'ended';
}): Promise<unknown> {
  return invoke('api/schedules/set-status', {
    householdId: input.householdId,
    scheduleId: input.scheduleId,
    status: input.status,
  });
}

/**
 * Roll the due date past one occurrence. Fenced on the exact due date, so
 * double-clicks and retries no-op ({advanced: false}).
 */
export async function advanceSchedule(input: {
  householdId: string;
  scheduleId: string;
  fromDueDate: string;
  reason: 'entered' | 'skipped';
}): Promise<{ advanced?: boolean; nextDueDate?: string; status?: string }> {
  return invoke('api/schedules/advance', {
    householdId: input.householdId,
    scheduleId: input.scheduleId,
    fromDueDate: input.fromDueDate,
    reason: input.reason,
  });
}

/**
 * Atomically post the occurrence's manual transaction AND advance the due
 * date server-side (one commit, or neither) — replaces the old
 * createManualTransaction + advanceSchedule client-orchestrated pair.
 * A stale tab (fence mismatch) returns {entered:false, reason:'moved', ...}
 * rather than an error.
 */
export async function enterSchedule(input: {
  householdId: string;
  scheduleId: string;
  fromDueDate: string;
}): Promise<{
  entered: boolean;
  reason?: string;
  idempotentReplay?: boolean;
  nextDueDate?: string;
  status?: string;
}> {
  return invoke('api/schedules/enter', {
    householdId: input.householdId,
    scheduleId: input.scheduleId,
    fromDueDate: input.fromDueDate,
  });
}

export type RecurringOccurrence = {
  occurrenceId: string;
  expectedDate: string;
  expectedAmountMinor: string;
  currency: string;
  status: string;
  /** Set once this occurrence is matched to a real transaction — used to
   *  detect internal-transfer series (a confirmed transfer_links row on the
   *  matched txn) the same way keel_cash_flow_forecast excludes them. */
  matchedTxnId: string | null;
};

export type RecurringStatusEvent = {
  transition: string;
  effectiveDate: string;
};

export type RecurringSeriesRow = {
  seriesId: string;
  status: 'suggested' | 'confirmed' | 'paused' | 'cancelled' | 'rejected';
  candidateVersionHash: string;
  counterpartyKey: string;
  sign: 'inflow' | 'outflow';
  accountId: string;
  occurrences: RecurringOccurrence[];
  statusEvents: RecurringStatusEvent[];
};

// ---- F-028 recurring classification + manual-schedule linking --------------
// 'excluded' = a detected series that is NOT a subscription/bill/income and must
// not be offered as recurring (personal P2P transfers). C, docs/RECURRING-RESEARCH.md.
// 'paycheck' = a PAYROLL/WAGES inflow (deterministic classifier, 20260719090000):
// shown on the Recurring page marked as a paycheck AND the only inflow class the
// Paychecks page's "detected paychecks" section surfaces. Non-payroll inflows
// (dividends, interest, other) stay 'income'.
// 'recurring' = a generic recurring OUTFLOW (classifier v4, 20260719210000):
// the dominant PFC is a habitual-spend primary (rideshare, groceries, ...),
// OTHER, unknown, or null — a claim of cadence only, never of kind. Replaces
// the old fall-through to 'subscription' (GAP-2, e2e validation 2026-07-19).
export type RecurringBucket =
  | 'income'
  | 'paycheck'
  | 'subscription'
  | 'utility'
  | 'bill'
  | 'recurring'
  | 'excluded';
export type RecurringClassificationRow = {
  seriesId: string;
  bucket: RecurringBucket;
  dominantPfc: string | null;
  matchedCount: number;
};
export type RecurringScheduleLink = {
  linkId: string;
  seriesId: string;
  scheduleId: string;
};

export async function fetchRecurringClassification(
  householdId: string,
): Promise<RecurringClassificationRow[]> {
  const res = await keelQuery<RecurringClassificationRow>('recurring.classification', householdId);
  return res.rows;
}

export async function fetchRecurringScheduleLinks(
  householdId: string,
): Promise<RecurringScheduleLink[]> {
  const res = await keelQuery<RecurringScheduleLink>('recurring.schedule_links', householdId);
  return res.rows;
}

export async function linkRecurringSchedule(input: {
  householdId: string;
  userId: string;
  seriesId: string;
  scheduleId: string;
}): Promise<unknown> {
  return keelCommand({
    commandId: newId(),
    command: 'recurring.link_schedule',
    economicEventKey: `recurring.link_schedule:${input.seriesId}:${input.scheduleId}:${newId()}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: { seriesId: input.seriesId, scheduleId: input.scheduleId },
  });
}

export async function unlinkRecurringSchedule(input: {
  householdId: string;
  userId: string;
  linkId: string;
}): Promise<unknown> {
  return keelCommand({
    commandId: newId(),
    command: 'recurring.unlink_schedule',
    economicEventKey: `recurring.unlink_schedule:${input.linkId}:${newId()}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: { linkId: input.linkId },
  });
}

// ---- Declined detected paychecks (20260719090000) --------------------------
// A dismissal hides ONE detected-paycheck occurrence (employer + date) from the
// Paychecks page while keeping the employer + latest detected deposit as the
// prefill template. Keyed by employerKey = lower(trim(counterpartyKey)).
export type DetectedPaycheckDismissal = {
  dismissalId: string;
  seriesId: string;
  employerKey: string;
  occurrenceDate: string;
};

export async function fetchDetectedPaycheckDismissals(
  householdId: string,
): Promise<DetectedPaycheckDismissal[]> {
  const res = await keelQuery<DetectedPaycheckDismissal>(
    'paychecks.detected_dismissals',
    householdId,
  );
  return res.rows;
}

export async function dismissDetectedPaycheck(input: {
  householdId: string;
  userId: string;
  seriesId: string;
  occurrenceDate: string;
}): Promise<unknown> {
  return keelCommand({
    commandId: newId(),
    command: 'paychecks.dismiss_detected',
    economicEventKey: `paychecks.dismiss_detected:${input.seriesId}:${input.occurrenceDate}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: { seriesId: input.seriesId, occurrenceDate: input.occurrenceDate },
  });
}

// ---- 1D domain read rows (shapes finalized against Codex's query procs) ----

export type PaycheckRow = {
  paycheckId: string;
  employerName: string;
  payDate: string;
  grossMinor: string;
  netMinor: string;
  currency: string;
  status: string;
};

export type ReimbursementRow = {
  claimId: string;
  counterpartyName: string;
  amountMinor: string;
  remainingMinor: string;
  currency: string;
  status: string;
  kind: string;
};

export type StatementLine = {
  lineId: string;
  lineKey: string;
  date: string;
  amountMinor: string;
  description: string;
};

// ---- F-029 statement cadence + due reminder --------------------------------
export type StatementCadenceRow = {
  accountId: string;
  closeDay: number | null;
  closeDaySource: 'manual' | 'derived' | 'unknown';
  lastPeriodEnd: string | null;
  nextExpectedClose: string | null;
  overdue: boolean;
  statementCount: number;
};

export async function fetchStatementCadence(
  householdId: string,
): Promise<StatementCadenceRow[]> {
  const res = await keelQuery<StatementCadenceRow>('statements.cadence', householdId);
  return res.rows;
}

export async function setStatementCadence(input: {
  householdId: string;
  userId: string;
  accountId: string;
  closeDay: number | null;
}): Promise<unknown> {
  return keelCommand({
    commandId: newId(),
    command: 'statements.set_cadence',
    economicEventKey: `statements.set_cadence:${input.accountId}:${newId()}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: { accountId: input.accountId, closeDay: input.closeDay },
  });
}

export type ReconciliationSession = {
  sessionId: string;
  ledgerEndingMinor: string;
  differenceMinor: string;
  status: string;
  closedAt: string | null;
  reopenedAt: string | null;
  items: {
    lineId: string;
    resolution: string;
    transactionId: string | null;
    explanation: string;
  }[];
  adjustments: { kind: string; amountMinor: string; explanation: string }[];
};

export type StatementRow = {
  statementId: string;
  accountId: string;
  periodStart: string;
  periodEnd: string;
  openingMinor: string;
  endingMinor: string;
  currency: string;
  status: 'open' | 'closed' | 'reopened';
  lines: StatementLine[];
  /** Present only after a close; differenceMinor lives HERE, not top-level. */
  session: ReconciliationSession | null;
};

/** Full household export (Law 6). Returns every format inline. */
export type ExportBundle = {
  manifest: unknown;
  json: string;
  /** One entry per table — the api function returns `toCsvFiles(snapshot)`
   *  verbatim, which is an ARRAY of named files, not a Record. */
  csv: { name: string; csv: string }[];
  qif: string;
  beancount: string;
};

export function exportHousehold(householdId: string): Promise<ExportBundle> {
  return invoke<ExportBundle>('api/admin/export', { householdId });
}

/** Create a manual (non-Plaid) account via the accounts.create command. */
export async function createManualAccount(input: {
  householdId: string;
  entityId: string;
  userId: string;
  name: string;
  kind: 'asset' | 'liability';
  subtype: string;
  currency?: string;
}): Promise<CommandResult> {
  const commandId = newId();
  return keelCommand({
    commandId,
    command: 'accounts.create',
    economicEventKey: `accounts.create:${commandId}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: {
      entityId: input.entityId,
      name: input.name,
      kind: input.kind,
      subtype: input.subtype,
      currency: input.currency ?? 'USD',
    },
  });
}

/** Create a manual transaction (splits are real balanced postings). */
export async function createManualTransaction(input: {
  householdId: string;
  userId: string;
  accountId: string;
  description: string;
  effectiveDate: string;
  /** Signed minor units on the account: negative = money out. */
  amountMinor: string;
  status?: 'pending' | 'posted';
  splits: { categoryLedgerAccountId: string; amountMinor: string }[];
  /**
   * Idempotency handle: mint ONE per user attempt (e.g. per dialog open) so
   * a retry after a timeout replays instead of double-posting (invariant 3).
   */
  attemptKey: string;
}): Promise<CommandResult> {
  const commandId = newId();
  return keelCommand({
    commandId,
    command: 'transactions.manual_create',
    economicEventKey: `manual:${input.attemptKey}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: {
      accountId: input.accountId,
      description: input.description,
      effectiveDate: input.effectiveDate,
      amountMinor: input.amountMinor,
      status: input.status ?? 'posted',
      splits: input.splits,
    },
  });
}

/** Void a manual transaction (reversal batch + revision record; undoable truth). */
export async function voidManualTransaction(input: {
  householdId: string;
  userId: string;
  transactionId: string;
  reason: string;
}): Promise<CommandResult> {
  const commandId = newId();
  return keelCommand({
    commandId,
    command: 'transactions.manual_void',
    economicEventKey: `manual-void:${input.transactionId}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: {
      transactionId: input.transactionId,
      reason: input.reason,
    },
  });
}

/**
 * Re-split an existing transaction across categories (teardown C7). The cash
 * side is untouched; the server replaces the category offsets through the
 * reversible correction model (reversal + replacement batch). amountMinor is
 * the signed cash amount THIS CLIENT is looking at — the server rejects the
 * command if the live batch disagrees, so a concurrent sync revision can
 * never be silently rebalanced.
 */
export async function setTransactionSplits(input: {
  householdId: string;
  userId: string;
  transactionId: string;
  /** Signed minor units of the cash posting as displayed to the user. */
  amountMinor: string;
  /** Debit-positive offsets; must sum to exactly -amountMinor (Law 3). */
  splits: { categoryLedgerAccountId: string; amountMinor: string }[];
  /**
   * Idempotency handle: mint ONE per edit session so a retry after a timeout
   * replays instead of double-revising (invariant 3).
   */
  attemptKey: string;
}): Promise<CommandResult> {
  return keelCommand({
    commandId: newId(),
    command: 'transactions.set_splits',
    economicEventKey: `set-splits:${input.transactionId}:${input.attemptKey}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: {
      transactionId: input.transactionId,
      amountMinor: input.amountMinor,
      splits: input.splits,
    },
  });
}

/**
 * Correct an existing transaction's effective date (Quicken-style date
 * edit). The server reverses the live batch as of its ORIGINAL date and
 * reposts the identical postings as of the NEW date (reversible correction,
 * same model as setTransactionSplits) — rejected if either date falls in a
 * locked period.
 */
export async function setTransactionDate(input: {
  householdId: string;
  userId: string;
  transactionId: string;
  effectiveDate: string;
  /** Idempotency handle: mint ONE per edit session. */
  attemptKey: string;
}): Promise<CommandResult> {
  return keelCommand({
    commandId: newId(),
    command: 'transactions.set_date',
    economicEventKey: `set-date:${input.transactionId}:${input.attemptKey}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: {
      transactionId: input.transactionId,
      effectiveDate: input.effectiveDate,
    },
  });
}

/** The entity's Opening Balances equity ledger account (for starting balances). */
export async function fetchOpeningBalancesLedgerId(
  householdId: string,
  entityId: string,
): Promise<string | null> {
  const client = getSupabaseBrowserClient();
  const { data, error } = await client
    .from('ledger_accounts')
    .select('id')
    .eq('household_id', householdId)
    .eq('entity_id', entityId)
    .eq('pfc_key', 'opening_balances')
    .is('archived_at', null)
    .limit(1);
  if (error) {
    // Deploy skew: web shipped before the subcategories migration added
    // pfc_key. Fall back to the seeded name until the column exists.
    const { data: byName, error: nameError } = await client
      .from('ledger_accounts')
      .select('id')
      .eq('household_id', householdId)
      .eq('entity_id', entityId)
      .eq('name', 'Opening Balances')
      .is('archived_at', null)
      .limit(1);
    if (nameError) throw error;
    return (byName as { id: string }[] | null)?.[0]?.id ?? null;
  }
  return (data as { id: string }[] | null)?.[0]?.id ?? null;
}

/**
 * Book a starting balance for a manual account: balanced batch against the
 * entity's Opening Balances equity account (debit-positive convention).
 */
export async function postOpeningBalance(input: {
  householdId: string;
  userId: string;
  accountLedgerId: string;
  openingLedgerId: string;
  /** Signed minor units: positive = asset value, negative = amount owed. */
  amountMinor: string;
  currency?: string;
  accountName: string;
}): Promise<CommandResult> {
  const commandId = newId();
  const currency = input.currency ?? 'USD';
  const negated = input.amountMinor.startsWith('-')
    ? input.amountMinor.slice(1)
    : `-${input.amountMinor}`;
  return keelCommand({
    commandId,
    command: 'journal.post_batch',
    economicEventKey: `journal.post_batch:opening:${commandId}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: {
      description: `Opening balance — ${input.accountName}`,
      effectiveDate: new Date().toISOString().slice(0, 10),
      postings: [
        { ledgerAccountId: input.accountLedgerId, amountMinor: input.amountMinor, currency },
        { ledgerAccountId: input.openingLedgerId, amountMinor: negated, currency },
      ],
    },
  });
}

/**
 * Set (or correct) a synced account's opening balance: "as of [date], this
 * account's balance was $X." Anchors the running balance for accounts whose
 * transaction history doesn't reach back that far (Plaid only backfills
 * ~30 days). balanceMinor is the REAL-WORLD magnitude — positive means money
 * in the account for an asset, or amount owed for a liability; the server
 * applies the debit-positive sign flip for liabilities. Re-submitting for the
 * same account corrects it server-side (reverse + repost) — no separate
 * "is this an edit" flag needed.
 */
export async function setAccountOpeningBalance(input: {
  householdId: string;
  userId: string;
  accountId: string;
  /** Non-negative real-world magnitude in minor units (see above). */
  balanceMinor: string;
  asOfDate: string;
}): Promise<CommandResult> {
  const commandId = newId();
  return keelCommand({
    commandId,
    command: 'accounts.set_opening_balance',
    economicEventKey: `accounts.set_opening_balance:${commandId}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: {
      accountId: input.accountId,
      balanceMinor: input.balanceMinor,
      asOfDate: input.asOfDate,
    },
  });
}

/**
 * Re-anchor (fix) a synced account's balance from provider truth. Use when a
 * connected account reads too high or too low because its opening balance was
 * anchored before the transaction backfill landed, or because history is
 * shallow. The client sends only the account — the server reads the latest
 * provider balance snapshot, reverses any prior opening entry, and books a
 * corrected delta (Law 1: no ledger arithmetic on the client; Law 2: audited +
 * reversible). No relinking required.
 */
export async function reanchorAccountBalance(input: {
  householdId: string;
  userId: string;
  accountId: string;
}): Promise<CommandResult> {
  const commandId = newId();
  return keelCommand({
    commandId,
    command: 'accounts.reanchor_balance',
    economicEventKey: `accounts.reanchor_balance:${commandId}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: {
      accountId: input.accountId,
    },
  });
}

/** Recent audit-log entries (RLS-scoped; append-only trail, Law 2). */
export type AuditLogRow = {
  id: number;
  action: string;
  objectType: string;
  objectId: string | null;
  actor: { kind?: string; userId?: string; source?: string } | null;
  at: string;
};

export async function fetchAuditLog(householdId: string, limit = 25): Promise<AuditLogRow[]> {
  const { data, error } = await getSupabaseBrowserClient()
    .from('audit_log')
    .select('id, action, object_type, object_id, actor, at')
    .eq('household_id', householdId)
    .order('at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  type Row = {
    id: number;
    action: string;
    object_type: string;
    object_id: string | null;
    actor: AuditLogRow['actor'];
    at: string;
  };
  return ((data as Row[] | null) ?? []).map((r) => ({
    id: r.id,
    action: r.action,
    objectType: r.object_type,
    objectId: r.object_id,
    actor: r.actor,
    at: r.at,
  }));
}

export type NoteTaskRow =
  | {
      type: 'note';
      id: string;
      body: string;
      pinned: boolean;
      createdAt: string;
      updatedAt: string;
    }
  | {
      type: 'task';
      id: string;
      title: string;
      description: string | null;
      status: 'open' | 'done' | 'dismissed';
      dueOn: string | null;
      priority: 'low' | 'normal' | 'high';
      createdAt: string;
      updatedAt: string;
    };

export async function saveNote(input: {
  householdId: string;
  noteId?: string | null;
  body: string;
  pinned?: boolean;
}): Promise<{ noteId: string }> {
  return invoke<{ noteId: string }>('api/notes/save', {
    householdId: input.householdId,
    noteId: input.noteId ?? null,
    body: input.body,
    pinned: input.pinned ?? false,
  });
}

export async function archiveNote(input: {
  householdId: string;
  noteId: string;
}): Promise<unknown> {
  return invoke('api/notes/archive', {
    householdId: input.householdId,
    noteId: input.noteId,
  });
}

export async function saveTask(input: {
  householdId: string;
  taskId?: string | null;
  title: string;
  description?: string | null;
  dueOn?: string | null;
  priority?: 'low' | 'normal' | 'high';
}): Promise<{ taskId: string }> {
  return invoke<{ taskId: string }>('api/tasks/save', {
    householdId: input.householdId,
    taskId: input.taskId ?? null,
    title: input.title,
    description: input.description ?? null,
    dueOn: input.dueOn ?? null,
    priority: input.priority ?? 'normal',
  });
}

export async function setTaskStatus(input: {
  householdId: string;
  taskId: string;
  status: 'open' | 'done' | 'dismissed';
}): Promise<unknown> {
  return invoke('api/tasks/set-status', {
    householdId: input.householdId,
    taskId: input.taskId,
    status: input.status,
  });
}

/**
 * Typed, display-only AI chat record (Law 11) returned by /api/ai/chat.
 * Class C preview: narration of server-computed numbers — never a write,
 * never a proposed action. `evidenceRefs` are snapshot SECTION ids (what the
 * model saw), not raw data.
 */
export type AiChatRecord = {
  tldr: string;
  body: string;
  asOf: string;
  scope: { householdId: string; entityIds: string[] };
  riskClass: 'C';
  displayOnly: true;
  modelVersion: string;
  promptVersion: string;
  evidenceRefs: string[];
};

/** Ask KEEL Assistant one read-only question (single-shot, no streaming). */
export async function askKeel(input: {
  householdId: string;
  question: string;
}): Promise<AiChatRecord> {
  return invoke<AiChatRecord>('api/ai/chat', {
    householdId: input.householdId,
    question: input.question,
  });
}

/** Generate a browser-side UUID for command ids. */
export function newId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Documents (attach-only receipts/statements — no auto-extract/match; see
// docs/research/RECEIPTS-2026-07-16.md for the deferred fuller pipeline).
// ---------------------------------------------------------------------------

export type DocumentTargetType = 'transaction' | 'paycheck' | 'reimbursement_claim' | 'statement';
export type DocumentKind = 'receipt' | 'statement';

export type DocumentRow = {
  attachmentId: string;
  documentId: string;
  kind: DocumentKind;
  originalFilename: string;
  storageBucket: string;
  storagePath: string;
  mimeType: string;
  byteSize: number;
  attachedAt: string;
  /** Short-lived signed read URL (5 min TTL) — re-fetch the list to refresh. */
  url: string | null;
};

export async function fetchDocumentsForTarget(
  householdId: string,
  targetType: DocumentTargetType,
  targetId: string,
): Promise<DocumentRow[]> {
  const res = await invoke<{ rows: DocumentRow[] }>('api/documents/list', {
    householdId,
    targetType,
    targetId,
  });
  return res.rows;
}

/**
 * Upload one file and (optionally) attach it to a target in the same flow:
 * mint a signed upload URL, PUT the bytes straight to Storage (never through
 * this edge function's request body), then confirm — the confirm step is
 * what actually verifies/hashes/records the object server-side. A file
 * picked with no target yet (e.g. before a transaction exists) can pass
 * `target: undefined` and be attached later via a separate confirm call is
 * NOT supported — target must be known at upload time in this slice.
 */
export async function uploadDocument(input: {
  householdId: string;
  entityId: string;
  kind: DocumentKind;
  file: File;
  target: { type: DocumentTargetType; id: string };
}): Promise<{ documentId: string; attachmentId: string }> {
  const { householdId, entityId, kind, file, target } = input;
  const upload = await invoke<{
    documentId: string;
    storageBucket: string;
    storagePath: string;
    uploadUrl: string;
    token: string;
  }>('api/documents/upload-url', {
    householdId,
    entityId,
    kind,
    originalFilename: file.name,
    mimeType: file.type,
  });

  const { error: uploadError } = await getSupabaseBrowserClient()
    .storage.from(upload.storageBucket)
    .uploadToSignedUrl(upload.storagePath, upload.token, file);
  if (uploadError) throw uploadError;

  const confirmed = await invoke<{ effects: { documentId: string; attachmentId: string } }>(
    'api/documents/confirm-upload',
    {
      // Explicit attach mode [A3]: this flow attaches to an existing target and
      // must NEVER create a statement-ingest draft. Sending mode:'attach' makes
      // the server reject any accountId and require the target pair.
      mode: 'attach',
      householdId,
      entityId,
      documentId: upload.documentId,
      kind,
      storageBucket: upload.storageBucket,
      storagePath: upload.storagePath,
      originalFilename: file.name,
      targetType: target.type,
      targetId: target.id,
    },
  );
  return confirmed.effects;
}

export async function detachDocument(input: {
  householdId: string;
  userId: string;
  attachmentId: string;
  reason: string;
}): Promise<CommandResult> {
  return keelCommand({
    commandId: newId(),
    command: 'documents.detach',
    economicEventKey: `documents.detach:${input.attachmentId}:${newId()}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: { attachmentId: input.attachmentId, reason: input.reason },
  });
}

// ---------------------------------------------------------------------------
// WS-J / F-030: Receipts hub — bulk upload (unattached), extraction + matching
// inbox, confirm/reject/detach of suggested matches. See
// docs/research/RECEIPTS-2026-07-16.md.
// ---------------------------------------------------------------------------

/**
 * Upload a receipt WITHOUT attaching it to a target. The worker extracts the
 * fields and (when a single high-confidence transaction lines up) suggests a
 * match the user confirms in the receipts inbox. Used by the bulk-upload flow.
 */
export async function uploadReceipt(input: {
  householdId: string;
  entityId: string;
  file: File;
}): Promise<{ documentId: string }> {
  const { householdId, entityId, file } = input;
  const upload = await invoke<{
    documentId: string;
    storageBucket: string;
    storagePath: string;
    uploadUrl: string;
    token: string;
  }>('api/documents/upload-url', {
    householdId,
    entityId,
    kind: 'receipt',
    originalFilename: file.name,
    mimeType: file.type,
  });

  const { error: uploadError } = await getSupabaseBrowserClient()
    .storage.from(upload.storageBucket)
    .uploadToSignedUrl(upload.storagePath, upload.token, file);
  if (uploadError) throw uploadError;

  const confirmed = await invoke<{ effects: { documentId: string } }>(
    'api/documents/confirm-upload',
    {
      householdId,
      entityId,
      documentId: upload.documentId,
      kind: 'receipt',
      storageBucket: upload.storageBucket,
      storagePath: upload.storagePath,
      originalFilename: file.name,
      // No targetType/targetId — matching decides the attachment later.
    },
  );
  return confirmed.effects;
}

export type ReceiptExtractionView = {
  status: 'pending' | 'extracted' | 'failed';
  merchant: string | null;
  amountMinor: string | null;
  currency: string | null;
  txnDate: string | null;
  confidence: number | null;
  errorCode: string | null;
} | null;

export type ReceiptMatchView = {
  matchId: string;
  status: 'suggested' | 'confirmed';
  score: number | null;
  reasonCodes: string[];
  transactionId: string;
  txnDescription: string;
  txnAmountMinor: string | null;
  txnDate: string;
  txnAccountName: string;
} | null;

export type ReceiptInboxRow = {
  documentId: string;
  documentVersionId: string;
  kind: DocumentKind;
  originalFilename: string;
  storageBucket: string;
  storagePath: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
  entityId: string;
  extraction: ReceiptExtractionView;
  match: ReceiptMatchView;
  /** Short-lived signed read URL (5 min TTL). */
  url: string | null;
};

export async function fetchReceiptsInbox(householdId: string): Promise<ReceiptInboxRow[]> {
  const res = await invoke<{ rows: ReceiptInboxRow[] }>('api/receipts/inbox', { householdId });
  return res.rows;
}

/** Confirm (attach) or reject a suggested receipt→transaction match. */
export async function decideReceiptMatch(input: {
  householdId: string;
  userId: string;
  matchId: string;
  confirm: boolean;
}): Promise<CommandResult> {
  return keelCommand({
    commandId: newId(),
    command: 'receipts.decide_match',
    economicEventKey: `receipts.decide:${input.matchId}:${newId()}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: { matchId: input.matchId, confirm: input.confirm },
  });
}

/** Undo a confirmed receipt match (detach — never delete). */
export async function detachReceiptMatch(input: {
  householdId: string;
  userId: string;
  matchId: string;
}): Promise<CommandResult> {
  return keelCommand({
    commandId: newId(),
    command: 'receipts.detach_match',
    economicEventKey: `receipts.detach:${input.matchId}:${newId()}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: { matchId: input.matchId },
  });
}

// ---------------------------------------------------------------------------
// SLICE 7 (statement-ingestion-v2.md §10 UI slice 1): statement upload (ingest
// mode → quarantine → draft) + drafts inbox + token-bound draft approval.
// ---------------------------------------------------------------------------

/** Accepted statement file types for the upload dialog (client pre-filter; the
 *  server re-sniffs the bytes and rejects anything that doesn't match). */
export const STATEMENT_UPLOAD_ACCEPT = '.pdf,.csv,.ofx,.qfx';

/** Best-effort MIME for a picked statement file. Browsers frequently report an
 *  empty type for .ofx/.qfx/.csv; the server sniffs magic bytes regardless, so
 *  we fall back to octet-stream (allowlisted) rather than block the upload. */
function statementMimeFor(file: File): string {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.ofx') || name.endsWith('.qfx')) return 'application/x-ofx';
  return 'application/octet-stream';
}

/**
 * Upload a bank/card/investment statement in INGEST mode [A3]: mint a signed
 * upload URL (quarantine bucket), PUT the bytes straight to Storage, then
 * confirm-upload with mode:'ingest' + the REQUIRED account. The server sniffs,
 * promotes, mints a draft + outbox row, and enqueues extraction. A re-upload of
 * the same bytes for this account returns `{ duplicate: true, draftId }` — the
 * UI links to the existing draft instead of erroring.
 */
export async function uploadStatement(input: {
  householdId: string;
  entityId: string;
  accountId: string;
  file: File;
}): Promise<{ duplicate: boolean; draftId: string | null; documentVersionId: string | null }> {
  const { householdId, entityId, accountId, file } = input;
  const mimeType = statementMimeFor(file);
  const upload = await invoke<{
    documentId: string;
    storageBucket: string;
    storagePath: string;
    uploadUrl: string;
    token: string;
  }>('api/documents/upload-url', {
    householdId,
    entityId,
    kind: 'statement',
    originalFilename: file.name,
    mimeType,
  });

  const { error: uploadError } = await getSupabaseBrowserClient()
    .storage.from(upload.storageBucket)
    .uploadToSignedUrl(upload.storagePath, upload.token, file);
  if (uploadError) throw uploadError;

  const confirmed = await invoke<{
    duplicate?: boolean;
    draftId?: string | null;
    documentVersionId?: string | null;
  }>('api/documents/confirm-upload', {
    mode: 'ingest',
    householdId,
    entityId,
    accountId,
    documentId: upload.documentId,
    kind: 'statement',
    storageBucket: upload.storageBucket,
    storagePath: upload.storagePath,
    originalFilename: file.name,
  });
  return {
    duplicate: confirmed.duplicate === true,
    draftId: confirmed.draftId ?? null,
    documentVersionId: confirmed.documentVersionId ?? null,
  };
}

export type StatementDraftExtractionView = {
  extractionId: string;
  kindHint: 'bank' | 'card' | 'investment' | 'unknown' | null;
  status: 'pending' | 'extracted' | 'failed';
  periodStart: string | null;
  periodEnd: string | null;
  openingMinor: string | null;
  endingMinor: string | null;
  currency: string | null;
  extractor: string | null;
  extractorVersion: string | null;
  confidence: number | null;
  errorCode: string | null;
  lineCount: number;
  holdingCount: number;
} | null;

export type StatementDraftRow = {
  draftId: string;
  documentVersionId: string;
  accountId: string;
  accountName: string;
  accountSubtype: string;
  accountCurrency: string;
  sourceHash: string;
  status: 'pending' | 'extracted' | 'failed' | 'approved' | 'dismissed';
  statementId: string | null;
  createdAt: string;
  originalFilename: string;
  extraction: StatementDraftExtractionView;
  /** Ledger balance at the extracted period end (same formula as close). */
  ledgerEndingMinor: string | null;
  /** ledger(period_end) − extracted ending. Red only when negative money. */
  discrepancyMinor: string | null;
  /** Short-lived signed read URL (5 min, forced download). */
  url: string | null;
};

export async function fetchStatementDrafts(householdId: string): Promise<StatementDraftRow[]> {
  const res = await invoke<{ rows: StatementDraftRow[] }>('api/statements/drafts', { householdId });
  return res.rows;
}

export type StatementDraftExtractionLine = {
  lineNo: number;
  date: string | null;
  amountMinor: string;
  description: string | null;
  currency: string | null;
};

export type StatementDraftHolding = {
  symbol: string | null;
  cusip: string | null;
  isin: string | null;
  name: string | null;
  qty: string | null;
  priceMinor: string | null;
  valueMinor: string | null;
  costBasisMinor: string | null;
  currency: string | null;
};

export type StatementDraftDetail = {
  draftId: string;
  accountId: string;
  status: string;
  extraction: {
    extractionId: string;
    kindHint: 'bank' | 'card' | 'investment' | 'unknown' | null;
    status: 'pending' | 'extracted' | 'failed';
    periodStart: string | null;
    periodEnd: string | null;
    openingMinor: string | null;
    endingMinor: string | null;
    currency: string | null;
    confidence: number | null;
  } | null;
  lines: StatementDraftExtractionLine[];
  holdings: StatementDraftHolding[];
};

/** The extraction detail (lines + holdings) for ONE draft — prefills review. */
export async function fetchStatementDraftDetail(
  householdId: string,
  draftId: string,
): Promise<StatementDraftDetail> {
  return invoke<StatementDraftDetail>('api/statements/draft-detail', { householdId, draftId });
}

/**
 * Issue an approval token bound to the EXACT normalized statement body (Law 11).
 * Bespoke route → keel_cmd_statements_issue_draft_approval, which reconstructs
 * the SAME server-normalized v_payload the approve command will redeem (forcing
 * the draft account + server source_hash + balanceCheck) and hashes it. The
 * `statement` object passed here MUST be the same one passed to
 * approveStatementDraft — see runIssueThenApprove (statement-approve.ts).
 */
export async function issueStatementDraftApproval(input: {
  householdId: string;
  draftId: string;
  balanceCheck: 'strict' | 'anchor';
  statement: import('@/lib/statement-approve').StatementBody;
}): Promise<{ tokenId: string; payloadSha256: string; expiresAt: string }> {
  return invoke<{ tokenId: string; payloadSha256: string; expiresAt: string }>(
    'api/statements/issue-draft-approval',
    {
      householdId: input.householdId,
      draftId: input.draftId,
      balanceCheck: input.balanceCheck,
      statement: input.statement,
    },
  );
}

/**
 * Approve a statement draft with a redeemed approval token (Class B, Law 11).
 * The server redeems the token against the SAME server-normalized body and
 * materializes it in one transaction — the exact bytes approved are written.
 */
export async function approveStatementDraft(input: {
  householdId: string;
  userId: string;
  draftId: string;
  approvalTokenId: string;
  balanceCheck: 'strict' | 'anchor';
  statement: import('@/lib/statement-approve').StatementBody;
}): Promise<CommandResult> {
  return keelCommand({
    commandId: newId(),
    command: 'statements.approve_draft',
    economicEventKey: `statements.approve_draft:${input.draftId}:${input.approvalTokenId}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: {
      draftId: input.draftId,
      approvalTokenId: input.approvalTokenId,
      balanceCheck: input.balanceCheck,
      statement: input.statement,
    },
  });
}

/** Dismiss a statement draft (reversible-to-terminal; never a hard delete). */
export async function dismissStatementDraft(input: {
  householdId: string;
  userId: string;
  draftId: string;
}): Promise<CommandResult> {
  return keelCommand({
    commandId: newId(),
    command: 'statements.dismiss_draft',
    economicEventKey: `statements.dismiss_draft:${input.draftId}:${newId()}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: { draftId: input.draftId },
  });
}
