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
  })) as { data: T | null; error: Error | null };
  if (error) throw error;
  if (data === null) throw new Error('Empty response from KEEL API.');
  return data;
}

/** POST /api/queries — read-only, household-scoped. */
export function keelQuery<Row>(query: string, householdId: string): Promise<QueryResult<Row>> {
  return invoke<QueryResult<Row>>('api/queries', { query, householdId });
}

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

// ---- Row shapes for the read queries we render ----

export type TransactionRow = {
  transactionId: string;
  accountId: string;
  status: 'pending' | 'posted' | 'reviewed';
  description: string;
  effectiveDate: string;
  economicEventKey: string;
};

export type TrialBalanceRow = {
  ledgerAccountId: string;
  currency: string;
  balanceMinor: string;
};

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

/** Generate a browser-side UUID for command ids. */
export function newId(): string {
  return crypto.randomUUID();
}
