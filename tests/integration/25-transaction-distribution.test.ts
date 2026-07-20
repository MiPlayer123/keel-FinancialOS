/**
 * Distribution legs (migration 20260721000000) — a split leg may target a real
 * ACCOUNT (an inter-account transfer that lives inside ONE ledger line), not
 * just a category. The paycheck case: a net deposit split into gross income
 * (credit), tax expense (debit), AND a 401k transfer into a retirement account
 * (debit), all balancing to the net cash — modelled as a single transaction
 * whose journal batch posts to two real accounts.
 *
 * Asserts: the command accepts the account leg; Σ=0 holds; the target account's
 * ledger balance (net worth / trial balance) picks up the transfer leg; the
 * rich read model renders ONE row with the account leg in its splits array
 * (legType='account'); a leg targeting the transaction's OWN account rejects;
 * and set_splits can add an account leg to an existing transaction.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SEED, signIn } from './helpers.js';

const HOUSEHOLD = SEED.households.alpha;
const ENTITY = SEED.entities.alphaPersonal;
const ACTOR = { kind: 'user' as const, userId: SEED.users.alex.id };
const suffix = Date.now().toString(36);

let retirementAccountId = '';
let retirementLedgerId = '';

const createAsset = async (name: string, subtype: string): Promise<{ accountId: string; ledgerAccountId: string }> => {
  const alex = await signIn(SEED.users.alex.email);
  const { data, error } = await alex.rpc('keel_cmd_create_account', {
    p_command_id: crypto.randomUUID(),
    p_economic_event_key: `itest:distrib:create:${name}:${suffix}`,
    p_actor: ACTOR,
    p_household_id: HOUSEHOLD,
    p_payload: { entity_id: ENTITY, name, kind: 'asset', subtype, currency: 'USD' },
  });
  if (error) throw new Error(`create account ${name} failed: ${error.message}`);
  const effects = (data as { effects: { accountId: string; ledgerAccountId: string } }).effects;
  return { accountId: effects.accountId, ledgerAccountId: effects.ledgerAccountId };
};

const mkCategory = async (name: string, kind: 'income' | 'expense'): Promise<string> => {
  const alex = await signIn(SEED.users.alex.email);
  const { data, error } = await alex.rpc('keel_create_category', {
    p_household_id: HOUSEHOLD, p_name: name, p_kind: kind,
    p_parent_ledger_account_id: null, p_entity_id: ENTITY,
  });
  if (error) throw new Error(`create category ${name} failed: ${error.message}`);
  return data as string;
};

const ledgerBalance = async (ledgerAccountId: string): Promise<bigint> => {
  const alex = await signIn(SEED.users.alex.email);
  const { data, error } = await alex.rpc('keel_trial_balance', { p_household_id: HOUSEHOLD });
  if (error) throw new Error(`trial_balance failed: ${error.message}`);
  const rows = ((data as { rows?: Array<{ ledgerAccountId: string; balanceMinor: string }> }).rows) ?? [];
  const row = rows.find((r) => r.ledgerAccountId === ledgerAccountId);
  return BigInt(row?.balanceMinor ?? '0');
};

let incomeCat = '';
let taxCat = '';

beforeAll(async () => {
  const ret = await createAsset(`Retirement ${suffix}`, 'retirement');
  retirementAccountId = ret.accountId;
  retirementLedgerId = ret.ledgerAccountId;
  incomeCat = await mkCategory(`Gross ${suffix}`, 'income');
  taxCat = await mkCategory(`Withholding ${suffix}`, 'expense');
});

describe('transaction distributions — account-target split legs', () => {
  it('manual_transaction posts a 401k-style transfer leg into a real account, balanced', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const before = await ledgerBalance(retirementLedgerId);

    // Net deposit +100. Splits: gross income −1000, tax +500, retirement +400.
    // Offsets sum to −100 = −cash. Retirement grows by +400; the other 100 stays
    // liquid in checking. (scaled model of gross − taxes − 401k = net)
    const { data: mt, error: mtErr } = await alex.rpc('keel_cmd_manual_transaction', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:distrib:paycheck:${suffix}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        account_id: SEED.accounts.alphaChecking,
        description: `PAYCHECK DISTRIB ${suffix}`,
        effective_date: new Date().toISOString().slice(0, 10),
        status: 'posted',
        amount_minor: '100',
        splits: [
          { category_ledger_account_id: incomeCat, amount_minor: '-1000' },
          { category_ledger_account_id: taxCat, amount_minor: '500' },
          { account_id: retirementAccountId, amount_minor: '400' },
        ],
      },
    });
    expect(mtErr).toBeNull();
    const txnId = (mt as { effects: { canonicalTransactionId: string } }).effects.canonicalTransactionId;

    // Net worth / trial balance picked up the transfer leg (posting aggregation
    // is by ledger_account_id, not by canonical_transactions.account_id).
    const after = await ledgerBalance(retirementLedgerId);
    expect(after - before).toBe(400n);

    // Read model: ONE row for the paycheck (pinned to its own account), rendered
    // as a Split, with the retirement transfer leg present as legType='account'.
    const { data: rich, error: richErr } = await alex.rpc('keel_list_transactions_rich', {
      p_household_id: HOUSEHOLD,
    });
    expect(richErr).toBeNull();
    const rows = (rich as { rows: Array<Record<string, unknown>> }).rows;
    const paycheckRows = rows.filter((r) => r.transactionId === txnId);
    expect(paycheckRows).toHaveLength(1); // NOT one row per real account
    const row = paycheckRows[0];
    expect(row.accountId).toBe(SEED.accounts.alphaChecking);
    expect(row.amountMinor).toBe('100');
    expect(row.categoryName).toBe('Split');
    const splits = row.splits as Array<Record<string, unknown>>;
    const accLeg = splits.find((s) => s.legType === 'account');
    expect(accLeg).toBeTruthy();
    expect(accLeg?.accountId).toBe(retirementAccountId);
    expect(accLeg?.amountMinor).toBe('400');
    // Category legs still present and correctly signed.
    expect(splits.some((s) => s.legType === 'category' && s.amountMinor === '-1000')).toBe(true);
    expect(splits.some((s) => s.legType === 'category' && s.amountMinor === '500')).toBe(true);
  });

  it('rejects a transfer leg targeting the transaction\'s own account', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const { error } = await alex.rpc('keel_cmd_manual_transaction', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:distrib:selfref:${suffix}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        account_id: SEED.accounts.alphaChecking,
        description: `SELF ${suffix}`,
        effective_date: new Date().toISOString().slice(0, 10),
        status: 'posted',
        amount_minor: '100',
        splits: [
          { category_ledger_account_id: incomeCat, amount_minor: '-500' },
          { account_id: SEED.accounts.alphaChecking, amount_minor: '400' },
        ],
      },
    });
    expect(error?.code).toBe('P0009');
  });

  it('set_splits can add an account transfer leg to an existing transaction', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const before = await ledgerBalance(retirementLedgerId);

    // A plain money-in transaction first (single income split).
    const { data: mt, error: mtErr } = await alex.rpc('keel_cmd_manual_transaction', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:distrib:resplit:${suffix}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        account_id: SEED.accounts.alphaChecking,
        description: `RESPLIT DISTRIB ${suffix}`,
        effective_date: new Date().toISOString().slice(0, 10),
        status: 'posted',
        amount_minor: '100',
        splits: [{ category_ledger_account_id: incomeCat, amount_minor: '-100' }],
      },
    });
    if (mtErr) throw new Error(`manual txn failed: ${mtErr.message}`);
    const txnId = (mt as { effects: { canonicalTransactionId: string } }).effects.canonicalTransactionId;

    // Re-split into income −600, tax +100, retirement +400 (offsets = −100).
    const { error: ssErr } = await alex.rpc('keel_cmd_set_splits', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:distrib:resplit:apply:${txnId}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        transaction_id: txnId,
        amount_minor: '100',
        splits: [
          { category_ledger_account_id: incomeCat, amount_minor: '-600' },
          { category_ledger_account_id: taxCat, amount_minor: '100' },
          { account_id: retirementAccountId, amount_minor: '400' },
        ],
      },
    });
    expect(ssErr).toBeNull();

    const after = await ledgerBalance(retirementLedgerId);
    expect(after - before).toBe(400n);
  });
});
