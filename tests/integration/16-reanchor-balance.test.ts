/**
 * Historical backfill + opening-balance anchor (fixes inflated balances).
 *
 * Reproduces the founder-reported inflation: an account whose opening balance
 * was anchored BEFORE its transaction backfill landed reads too high, because
 * the synced window then piles on top of a full-balance opening. Proves:
 *   1. accounts.reanchor_balance reverses the stale opening and re-books a
 *      corrected delta so Σ(postings) ties back to the provider balance —
 *      audited (Law 2) and balanced (Law 3), no relinking.
 *   2. keel_apply_account_balance DEFERS its one-time anchor until the
 *      connection's first full sync completes, so a NEW account never inflates.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { serviceClient, SEED, signIn } from './helpers.js';

const HOUSEHOLD = SEED.households.alpha;
const ENTITY = SEED.entities.alphaPersonal;
const ACTOR = { kind: 'user' as const, userId: SEED.users.alex.id };

/** Debit-positive running total of a ledger account = its current balance. */
const ledgerSum = async (ledgerAccountId: string): Promise<bigint> => {
  const { data, error } = await serviceClient()
    .from('journal_postings')
    .select('amount_minor')
    .eq('ledger_account_id', ledgerAccountId);
  if (error) throw new Error(error.message);
  return data.reduce((sum, row) => sum + BigInt(row.amount_minor as string), 0n);
};

/** Sum of a single batch's postings (must be zero — Law 3). */
const batchSum = async (
  svc: ReturnType<typeof serviceClient>,
  batchId: string,
): Promise<bigint> => {
  const { data, error } = await svc
    .from('journal_postings')
    .select('amount_minor')
    .eq('batch_id', batchId);
  if (error) throw new Error(error.message);
  return data.reduce((sum, row) => sum + BigInt(row.amount_minor as string), 0n);
};

/** The reversal batch that compensates a given original opening batch. */
const firstReversalBatch = async (
  svc: ReturnType<typeof serviceClient>,
  originalBatchId: string,
): Promise<string> => {
  const { data, error } = await svc
    .from('journal_revisions')
    .select('reversal_batch_id')
    .eq('original_batch_id', originalBatchId)
    .limit(1)
    .single();
  if (error) throw new Error(error.message);
  return data.reversal_batch_id as string;
};

const createAccount = async (
  suffix: string,
  connectionId: string | null,
): Promise<{ accountId: string; ledgerAccountId: string }> => {
  const alex = await signIn(SEED.users.alex.email);
  const { data, error } = await alex.rpc('keel_cmd_create_account', {
    p_command_id: crypto.randomUUID(),
    p_economic_event_key: `itest:reanchor:create:${suffix}`,
    p_actor: ACTOR,
    p_household_id: HOUSEHOLD,
    p_payload: {
      entity_id: ENTITY,
      ...(connectionId ? { connection_id: connectionId } : {}),
      name: `Reanchor ${suffix}`,
      kind: 'asset',
      subtype: 'checking',
      currency: 'USD',
    },
  });
  if (error) throw new Error(`account create failed: ${error.message}`);
  const effects = (data as { effects: { accountId: string; ledgerAccountId: string } }).effects;
  return { accountId: effects.accountId, ledgerAccountId: effects.ledgerAccountId };
};

let categoryLedgerId: string;

beforeAll(async () => {
  const { data, error } = await serviceClient()
    .from('ledger_accounts')
    .select('id')
    .eq('household_id', HOUSEHOLD)
    .eq('entity_id', ENTITY)
    .eq('is_category', true)
    .is('archived_at', null)
    .limit(1)
    .single();
  if (error) throw new Error(`no category ledger for entity: ${error.message}`);
  categoryLedgerId = data.id as string;
});

describe('accounts.reanchor_balance', () => {
  it('reverses a stale opening and re-anchors the balance to provider truth', async () => {
    const svc = serviceClient();
    const { accountId, ledgerAccountId } = await createAccount('correction', null);

    // (1) The bug: the one-time anchor fired while Σ(postings) was still 0, so
    // it booked an opening equal to the FULL provider balance (100000). With no
    // connection the deferral gate is skipped, matching the pre-backfill race.
    const provider = 100000n;
    const { error: anchorError } = await svc.rpc('keel_apply_account_balance', {
      p_household_id: HOUSEHOLD,
      p_account_id: accountId,
      p_current_minor: Number(provider),
      p_available_minor: Number(provider),
      p_currency: 'USD',
      p_as_of: new Date().toISOString(),
    });
    if (anchorError) throw new Error(`seed anchor failed: ${anchorError.message}`);
    expect(await ledgerSum(ledgerAccountId)).toBe(provider);

    // (2) The backfilled window then lands on top (net +30000 of activity),
    // inflating the displayed balance to 130000 while the bank still says
    // 100000. A category leg keeps the batch balanced (Law 3) and, because it
    // never touches Opening Balances, it is NOT an opening marker.
    const activity = 30000n;
    const { data: batch, error: batchError } = await svc
      .from('journal_batches')
      .insert({
        household_id: HOUSEHOLD,
        canonical_transaction_id: null,
        description: 'synced backfill activity (test)',
        effective_date: new Date().toISOString().slice(0, 10),
      })
      .select('id')
      .single();
    if (batchError) throw new Error(batchError.message);
    const { error: postError } = await svc.from('journal_postings').insert([
      {
        batch_id: batch.id,
        ledger_account_id: ledgerAccountId,
        entity_id: ENTITY,
        amount_minor: activity.toString(),
        currency: 'USD',
      },
      {
        batch_id: batch.id,
        ledger_account_id: categoryLedgerId,
        entity_id: ENTITY,
        amount_minor: (-activity).toString(),
        currency: 'USD',
      },
    ]);
    if (postError) throw new Error(postError.message);
    expect(await ledgerSum(ledgerAccountId)).toBe(provider + activity); // inflated

    // (3) Re-anchor: reads the latest provider snapshot (100000), reverses the
    // stale opening, and re-books the corrected delta so the ledger ties to the
    // bank regardless of how much history synced.
    const alex = await signIn(SEED.users.alex.email);
    const { data: result, error: reanchorError } = await alex.rpc('keel_cmd_reanchor_balance', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:reanchor:fix:${crypto.randomUUID()}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: { account_id: accountId },
    });
    if (reanchorError) throw new Error(`reanchor failed: ${reanchorError.message}`);

    const effects = (result as {
      effects: { reversedBatchIds: string[]; batchId: string | null; providerBalanceMinor: string };
    }).effects;
    expect(effects.reversedBatchIds.length).toBeGreaterThanOrEqual(1);
    expect(effects.providerBalanceMinor).toBe(provider.toString());

    // Displayed balance now ties to the bank.
    expect(await ledgerSum(ledgerAccountId)).toBe(provider);

    // Law 2: the correction is a compensating reversal (original preserved).
    const reversalBatchId = await firstReversalBatch(svc, effects.reversedBatchIds[0]!);
    expect(await batchSum(svc, reversalBatchId)).toBe(0n);

    // Law 3: the re-anchored opening batch is balanced.
    if (effects.batchId) {
      expect(await batchSum(svc, effects.batchId)).toBe(0n);
    }

    // Law 2 (audit): the mutation is on the append-only trail. keel_finish_command
    // writes audit_log.action = the COMMAND name (see command_procs.sql); the
    // domain-event name 'accounts.balance_reanchored' lands in domain_events,
    // not here (review finding — was asserting the wrong value, which also
    // short-circuited the idempotency block below).
    const { count: auditCount, error: auditError } = await svc
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
      .eq('action', 'accounts.reanchor_balance')
      .eq('object_id', accountId);
    if (auditError) throw new Error(auditError.message);
    expect(auditCount).toBeGreaterThanOrEqual(1);

    // Idempotent convergence: re-anchoring again keeps the balance at provider
    // truth (reverses + reposts an identical delta — never double-counts).
    const { error: secondError } = await alex.rpc('keel_cmd_reanchor_balance', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:reanchor:fix:${crypto.randomUUID()}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: { account_id: accountId },
    });
    if (secondError) throw new Error(`second reanchor failed: ${secondError.message}`);
    expect(await ledgerSum(ledgerAccountId)).toBe(provider);
  });
});

describe('keel_apply_account_balance deferral gate', () => {
  it('withholds the auto-anchor until the connection completes its first sync', async () => {
    const svc = serviceClient();
    const externalRef = `reanchor-gate-${crypto.randomUUID()}`;
    const { data: conn, error: connError } = await svc
      .from('connections')
      .insert({
        household_id: HOUSEHOLD,
        provider: 'plaid',
        external_ref: externalRef,
        status: 'active',
      })
      .select('id')
      .single();
    if (connError) throw new Error(connError.message);

    const { accountId, ledgerAccountId } = await createAccount('gate', conn.id as string);
    const provider = 250000n;

    // First refresh BEFORE the initial sync completes: snapshot only, no anchor.
    const { error: earlyError } = await svc.rpc('keel_apply_account_balance', {
      p_household_id: HOUSEHOLD,
      p_account_id: accountId,
      p_current_minor: Number(provider),
      p_available_minor: Number(provider),
      p_currency: 'USD',
      p_as_of: new Date().toISOString(),
    });
    if (earlyError) throw new Error(earlyError.message);
    expect(await ledgerSum(ledgerAccountId)).toBe(0n); // deferred — not inflated

    const { count: snapCount, error: snapError } = await svc
      .from('balance_snapshots')
      .select('*', { count: 'exact', head: true })
      .eq('account_id', accountId);
    if (snapError) throw new Error(snapError.message);
    expect(snapCount).toBeGreaterThanOrEqual(1); // snapshot still recorded

    // Backfill completes → the next refresh anchors correctly.
    const { error: syncError } = await svc
      .from('connections')
      .update({ last_successful_sync_at: new Date().toISOString() })
      .eq('id', conn.id);
    if (syncError) throw new Error(syncError.message);

    const { error: lateError } = await svc.rpc('keel_apply_account_balance', {
      p_household_id: HOUSEHOLD,
      p_account_id: accountId,
      p_current_minor: Number(provider),
      p_available_minor: Number(provider),
      p_currency: 'USD',
      p_as_of: new Date().toISOString(),
    });
    if (lateError) throw new Error(lateError.message);
    expect(await ledgerSum(ledgerAccountId)).toBe(provider);
  });
});
