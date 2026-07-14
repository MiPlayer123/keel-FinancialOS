import { getSupabaseBrowserClient } from '@/lib/supabase';

/** Shared envelope for read queries; every query is scoped to one household. */
export type QueryResult<Row> = {
  scope: { householdId: string };
  asOf: string;
  formulaVersion?: string;
  rows: Row[];
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
        if (parseErr instanceof Error && parseErr.message !== error.message && !(parseErr instanceof SyntaxError)) {
          throw parseErr;
        }
      }
    }
    throw error;
  }
  if (data === null) throw new Error('Empty response from KEEL API.');
  return data;
}

/** POST /api/queries — read-only, household-scoped. `extra` carries query-specific params. */
export function keelQuery<Row>(
  query: string,
  householdId: string,
  extra: Record<string, unknown> = {},
): Promise<QueryResult<Row>> {
  return invoke<QueryResult<Row>>('api/queries', { query, householdId, ...extra });
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
};

export async function fetchAccounts(householdId: string): Promise<AccountRow[]> {
  const { data, error } = await getSupabaseBrowserClient()
    .from('accounts')
    .select('id, name, subtype, ledger_account_id, currency, entity_id')
    .eq('household_id', householdId)
    .is('archived_at', null)
    .order('name');
  if (error) throw error;

  type Row = {
    id: string;
    name: string;
    subtype: string;
    ledger_account_id: string;
    currency: string;
    entity_id: string;
  };

  return ((data as Row[] | null) ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    subtype: r.subtype,
    ledgerAccountId: r.ledger_account_id,
    currency: r.currency,
    entityId: r.entity_id,
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

/** Connections for a household (RLS-scoped direct read; credentials never exposed). */
export type ConnectionRow = {
  id: string;
  provider: string;
  status: string;
  displayName: string | null;
  institutionId: string | null;
  lastSuccessfulSyncAt: string | null;
};

export async function fetchConnections(householdId: string): Promise<ConnectionRow[]> {
  const { data, error } = await getSupabaseBrowserClient()
    .from('connections')
    .select('id, provider, status, display_name, institution_id, last_successful_sync_at')
    .eq('household_id', householdId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  type Row = {
    id: string;
    provider: string;
    status: string;
    display_name: string | null;
    institution_id: string | null;
    last_successful_sync_at: string | null;
  };
  return ((data as Row[] | null) ?? []).map((r) => ({
    id: r.id,
    provider: r.provider,
    status: r.status,
    displayName: r.display_name,
    institutionId: r.institution_id,
    lastSuccessfulSyncAt: r.last_successful_sync_at,
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

/** First entity of a household (needed to scope a new connection). */
export async function fetchFirstEntityId(householdId: string): Promise<string | null> {
  const { data, error } = await getSupabaseBrowserClient()
    .from('entities')
    .select('id')
    .eq('household_id', householdId)
    .order('created_at')
    .limit(1);
  if (error) throw error;
  return (data as { id: string }[] | null)?.[0]?.id ?? null;
}

/** A financial entity (personal books, an LLC, a trust, …) within a household. */
export type EntityKind =
  | 'personal'
  | 'sole_prop'
  | 'llc_single'
  | 'llc_multi'
  | 's_corp'
  | 'trust'
  | 'other';

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
  amountMinor: string;
  currency: string;
  categoryLedgerAccountId: string | null;
  categoryName: string | null;
  categoryKind: 'income' | 'expense' | null;
  /** Stable key for system categories (rename-proof "Uncategorized" checks). */
  categoryPfcKey?: string | null;
  /** Present (non-null) only for multi-split transactions. */
  splits?: TransactionSplit[] | null;
  /** User labels, orthogonal to categories (absent pre-tags-migration). */
  tags?: { tagId: string; name: string }[];
  /** Present when this transaction is one side of a suggested/confirmed transfer pair. */
  transferStatus?: 'suggested' | 'confirmed' | null;
  /** Other leg's account, present only once the pairing is CONFIRMED (absent pre-migration). */
  counterpartyAccountId?: string | null;
  counterpartyAccountName?: string | null;
  /** Other leg's transaction id, for a future "jump to" affordance. */
  counterpartyTransactionId?: string | null;
};

export type CategoryRow = {
  ledgerAccountId: string;
  name: string;
  kind: 'income' | 'expense';
  entityId: string;
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
  outAccountName: string;
  inTxnId: string;
  inDescription: string;
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
    const res = await invoke<{ rows?: DailyBalanceRow[]; bills?: ForecastBill[] }>(
      'api/queries',
      { query: 'dashboard.cash_flow_forecast', householdId, days },
    );
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
}): Promise<{ ruleId?: string }> {
  return invoke('api/rules/save', {
    householdId: input.householdId,
    ...(input.ruleId ? { ruleId: input.ruleId } : {}),
    pattern: input.pattern,
    categoryLedgerAccountId: input.categoryLedgerAccountId ?? null,
    renameTo: input.renameTo ?? null,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.active !== undefined ? { active: input.active } : {}),
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

export type ReconciliationSession = {
  sessionId: string;
  ledgerEndingMinor: string;
  differenceMinor: string;
  status: string;
  closedAt: string | null;
  reopenedAt: string | null;
  items: { lineId: string; resolution: string; transactionId: string | null; explanation: string }[];
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
  csv: Record<string, string>;
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

/** Generate a browser-side UUID for command ids. */
export function newId(): string {
  return crypto.randomUUID();
}
