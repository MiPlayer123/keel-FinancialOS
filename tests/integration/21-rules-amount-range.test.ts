/**
 * C18 residual: rules multi-condition→action (design/TEARDOWN-STATUS-2026-07-17.md
 * queue item C18) — the amount-range condition, proven end to end through
 * the REAL command surfaces (Law 7: no direct DML on financial tables):
 * `keel_rule_save` (now accepting p_amount_min_minor/p_amount_max_minor) +
 * `keel_apply_rules` (now AND-ing the range against the synced transaction's
 * cash-leg amount magnitude). Fixtures land through the sync/worker path
 * (keel_worker_record_raw_event + drainQueue), same idiom as
 * 20-transaction-review-state.test.ts's rule case — a rule can only ever
 * win against a transaction with NO existing overlay, and manualTxn always
 * pins one (20260713100000 §"Single-split").
 *
 * pgTAP coverage (supabase/tests/020_rules_amount_range.sql) proves the SQL
 * matching semantics and the CHECK-constraint edges directly; this file
 * proves the same behavior is reachable through the real `keel_rule_save`
 * envelope (validation, defaults, typed errors) and edge function.
 */
import { describe, expect, it } from 'vitest';
import { drainQueue, SEED, serviceClient, signIn } from './helpers.js';

const HOUSEHOLD = SEED.households.alpha;
const GROCERIES = SEED.ledgerAccounts.alphaGroceries;

type RichRow = {
  transactionId: string;
  categoryName: string | null;
};

const richRow = async (
  alex: Awaited<ReturnType<typeof signIn>>,
  txnId: string,
): Promise<RichRow | undefined> => {
  const { data, error } = await alex.rpc('keel_list_transactions_rich', {
    p_household_id: HOUSEHOLD,
  });
  if (error) throw new Error(`rich list failed: ${error.message}`);
  return (data as { rows: RichRow[] }).rows.find((r) => r.transactionId === txnId);
};

/** Sync in a single-offset transaction of the given magnitude via the simulator provider (never manualTxn — that always pins a source='user' overlay a rule cannot touch). */
const syncedTxn = async (
  svc: ReturnType<typeof serviceClient>,
  description: string,
  amountMinorMagnitude: string,
): Promise<string> => {
  const providerTxnId = `amtrange-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const { error: recordError } = await svc.rpc('keel_worker_record_raw_event', {
    p_provider: 'simulator',
    p_connection_external_ref: SEED.connections.simAlpha.ref,
    p_provider_event_id: `amtrange:${providerTxnId}`,
    p_account_external_ref: 'sim-acct-checking',
    p_body: {
      kind: 'transaction_added',
      eventId: `amtrange-evt-${providerTxnId}`,
      transaction: {
        providerTransactionId: providerTxnId,
        accountExternalRef: 'sim-acct-checking',
        amountMinor: `-${amountMinorMagnitude}`,
        currency: 'USD',
        date: new Date().toISOString().slice(0, 10),
        description,
        pending: false,
        pendingTransactionId: null,
      },
    },
    p_received_at: new Date().toISOString(),
  });
  if (recordError) throw new Error(`record raw event failed: ${recordError.message}`);

  const outcomes = await drainQueue('sync_events');
  expect(outcomes.every((o) => o.startsWith('done:'))).toBe(true);

  const economicEventKey = `txn:simulator:${SEED.connections.simAlpha.ref}:${providerTxnId}`;
  const { data: canonical, error: canonicalError } = await svc
    .from('canonical_transactions')
    .select('id')
    .eq('economic_event_key', economicEventKey)
    .single();
  if (canonicalError) throw new Error(`canonical lookup failed: ${canonicalError.message}`);
  return canonical.id;
};

describe('rules amount-range condition (C18 residual)', () => {
  it('a rule with amount_min_minor only matches at/above the floor, not below it', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const svc = serviceClient();
    const pattern = `AMOUNT FLOOR MERCHANT ${Date.now().toString(36)}`;

    const below = await syncedTxn(svc, `${pattern} BELOW`, '3000'); // $30
    const above = await syncedTxn(svc, `${pattern} ABOVE`, '6000'); // $60

    const { data: ruleId, error: ruleError } = await alex.rpc('keel_rule_save', {
      p_household_id: HOUSEHOLD,
      p_rule_id: null,
      p_pattern: pattern,
      p_category_ledger_account_id: GROCERIES,
      p_rename_to: null,
      p_priority: 100,
      p_active: true,
      p_amount_min_minor: '5000', // $50 floor
      p_amount_max_minor: null,
    });
    if (ruleError) throw new Error(`rule save failed: ${ruleError.message}`);
    expect(ruleId).toBeTruthy();

    const { data: dry, error: dryError } = await alex.rpc('keel_apply_rules', {
      p_household_id: HOUSEHOLD,
      p_dry_run: true,
    });
    if (dryError) throw new Error(`dry run failed: ${dryError.message}`);
    expect((dry as { categorized: number }).categorized).toBeGreaterThanOrEqual(1);

    const { data: applied, error: applyError } = await alex.rpc('keel_apply_rules', {
      p_household_id: HOUSEHOLD,
      p_dry_run: false,
    });
    if (applyError) throw new Error(`apply failed: ${applyError.message}`);
    expect((applied as { categorized: number }).categorized).toBeGreaterThanOrEqual(1);

    const belowRow = await richRow(alex, below);
    const aboveRow = await richRow(alex, above);
    expect(belowRow?.categoryName).not.toBe('Groceries');
    expect(aboveRow?.categoryName).toBe('Groceries');
  });

  it('a rule with both bounds matches only inside the closed range', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const svc = serviceClient();
    const pattern = `AMOUNT RANGE MERCHANT ${Date.now().toString(36)}`;

    const tooLow = await syncedTxn(svc, `${pattern} TOO LOW`, '1000'); // $10
    const inside = await syncedTxn(svc, `${pattern} INSIDE`, '5000'); // $50
    const tooHigh = await syncedTxn(svc, `${pattern} TOO HIGH`, '9000'); // $90

    const { error: ruleError } = await alex.rpc('keel_rule_save', {
      p_household_id: HOUSEHOLD,
      p_rule_id: null,
      p_pattern: pattern,
      p_category_ledger_account_id: GROCERIES,
      p_rename_to: null,
      p_priority: 100,
      p_active: true,
      p_amount_min_minor: '2000', // $20
      p_amount_max_minor: '8000', // $80
    });
    if (ruleError) throw new Error(`rule save failed: ${ruleError.message}`);

    const { error: applyError } = await alex.rpc('keel_apply_rules', {
      p_household_id: HOUSEHOLD,
      p_dry_run: false,
    });
    if (applyError) throw new Error(`apply failed: ${applyError.message}`);

    expect((await richRow(alex, tooLow))?.categoryName).not.toBe('Groceries');
    expect((await richRow(alex, inside))?.categoryName).toBe('Groceries');
    expect((await richRow(alex, tooHigh))?.categoryName).not.toBe('Groceries');
  });

  it('keel_rule_save rejects an inverted amount range with a typed error', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const { error } = await alex.rpc('keel_rule_save', {
      p_household_id: HOUSEHOLD,
      p_rule_id: null,
      p_pattern: `INVERTED RANGE ${Date.now().toString(36)}`,
      p_category_ledger_account_id: GROCERIES,
      p_rename_to: null,
      p_priority: 100,
      p_active: true,
      p_amount_min_minor: '9000',
      p_amount_max_minor: '1000',
    });
    expect(error).toBeTruthy();
    expect(error?.message ?? '').toMatch(/amount_min_minor must be <= amount_max_minor/);
  });

  it('a legacy null-range rule (both bounds unset) matches regardless of amount — backward compatible', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const svc = serviceClient();
    const pattern = `AMOUNT LEGACY MERCHANT ${Date.now().toString(36)}`;
    const txnId = await syncedTxn(svc, pattern, '123456'); // an arbitrary large amount

    const { error: ruleError } = await alex.rpc('keel_rule_save', {
      p_household_id: HOUSEHOLD,
      p_rule_id: null,
      p_pattern: pattern,
      p_category_ledger_account_id: GROCERIES,
      p_rename_to: null,
      p_priority: 100,
      p_active: true,
      // amount_min_minor/amount_max_minor omitted entirely — exercises the
      // function's own default null, the exact shape of a pre-C18 caller.
    });
    if (ruleError) throw new Error(`rule save failed: ${ruleError.message}`);

    const { error: applyError } = await alex.rpc('keel_apply_rules', {
      p_household_id: HOUSEHOLD,
      p_dry_run: false,
    });
    if (applyError) throw new Error(`apply failed: ${applyError.message}`);

    expect((await richRow(alex, txnId))?.categoryName).toBe('Groceries');
  });
});
