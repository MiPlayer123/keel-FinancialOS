/**
 * Balanced mixed-direction splits (migration 20260720230000) — the paycheck
 * decomposition case: a money-in transaction split into an income leg (gross,
 * negative offset) + an expense leg (taxes, positive offset) that balance to the
 * net cash.
 *
 * 20260802140000 then DROPPED the per-leg direction rule so contra legs
 * (a refund/reimbursement: a negative amount on an expense category) are
 * accepted — the sign<->kind heuristic rejected real refunds. Balance
 * (Σ = −cash) remains the invariant; an unbalanced split still rejects.
 */
import { describe, expect, it } from 'vitest';
import { SEED, signIn } from './helpers.js';

const HOUSEHOLD = SEED.households.alpha;
const ACTOR = { kind: 'user' as const, userId: SEED.users.alex.id };

describe('set_splits — balanced mixed-direction splits (regression 20260720230000)', () => {
  it('accepts a balanced income+expense split and a contra leg, rejects an unbalanced one', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const suffix = Date.now().toString(36);

    // Two custom categories in the alpha entity: one income, one expense.
    const mk = async (name: string, kind: 'income' | 'expense') => {
      const { data, error } = await alex.rpc('keel_create_category', {
        p_household_id: HOUSEHOLD, p_name: name, p_kind: kind,
        p_parent_ledger_account_id: null, p_entity_id: SEED.entities.alphaPersonal,
      });
      if (error) throw new Error(`create category ${name} failed: ${error.message}`);
      return data as string;
    };
    const incomeCat = await mk(`Gross ${suffix}`, 'income');
    const expenseCat = await mk(`Withholding ${suffix}`, 'expense');

    // A money-IN transaction (+2,547.87) on the income landing pad.
    const { data: mt, error: mtErr } = await alex.rpc('keel_cmd_manual_transaction', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:mixed:${crypto.randomUUID()}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        account_id: SEED.accounts.alphaChecking,
        description: `PAYCHECK ${suffix}`,
        effective_date: new Date().toISOString().slice(0, 10),
        status: 'posted',
        amount_minor: '254787',
        splits: [{ category_ledger_account_id: incomeCat, amount_minor: '-254787' }],
      },
    });
    if (mtErr) throw new Error(`manual txn failed: ${mtErr.message}`);
    const txnId = (mt as { effects: { canonicalTransactionId: string } }).effects.canonicalTransactionId;

    // Balanced mixed split: gross income −354167 + taxes +99380 = −254787 (= −cash). Passes.
    const okEnvelope = {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:mixed:ok:${txnId}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        transaction_id: txnId,
        amount_minor: '254787',
        splits: [
          { category_ledger_account_id: incomeCat, amount_minor: '-354167' },
          { category_ledger_account_id: expenseCat, amount_minor: '99380' },
        ],
      },
    };
    const { error: okErr } = await alex.rpc('keel_cmd_set_splits', okEnvelope);
    expect(okErr).toBeNull();

    // Contra legs (20260802140000): a NEGATIVE amount on an expense category (a
    // refund/reimbursement) + a positive income offset that still balance to
    // −cash. Rejected by the old direction rule; now accepted.
    const { error: contraErr } = await alex.rpc('keel_cmd_set_splits', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:mixed:contra:${txnId}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        transaction_id: txnId,
        amount_minor: '254787',
        splits: [
          { category_ledger_account_id: incomeCat, amount_minor: '254787' },
          { category_ledger_account_id: expenseCat, amount_minor: '-509574' },
        ],
      },
    });
    expect(contraErr).toBeNull();

    // Balance is still the invariant: legs that do NOT sum to −cash reject.
    const { error: unbalancedErr } = await alex.rpc('keel_cmd_set_splits', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:mixed:unbalanced:${txnId}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        transaction_id: txnId,
        amount_minor: '254787',
        splits: [
          { category_ledger_account_id: incomeCat, amount_minor: '-354167' },
          { category_ledger_account_id: expenseCat, amount_minor: '1' },
        ],
      },
    });
    expect(unbalancedErr?.code).toBe('P0002');
  });
});
