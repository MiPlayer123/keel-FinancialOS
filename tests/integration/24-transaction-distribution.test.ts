/**
 * Q5 transaction distributions: an account-target split compiles to KEEL's
 * existing two-canonical-transaction transfer primitive while the provider
 * transaction remains the source of truth for the raw bank amount.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { drainQueue, serviceClient, SEED, signIn } from './helpers.js';

const HOUSEHOLD = SEED.households.alpha;
const ENTITY = SEED.entities.alphaPersonal;
const ACTOR = { kind: 'user' as const, userId: SEED.users.alex.id };
const EFFECTIVE_DATE = '2027-06-30';

let destinationAccountId: string;
let sourceTransactionId: string;
let distributionId: string;
let generatedTransactionId: string;
let transferLinkId: string;
let providerTransactionId: string;

const liveCashAmount = async (transactionId: string): Promise<bigint> => {
  const svc = serviceClient();
  const { data: batches, error: batchError } = await svc
    .from('journal_batches')
    .select('id')
    .eq('canonical_transaction_id', transactionId)
    .is('reverses_batch_id', null);
  if (batchError) throw new Error(`batch lookup failed: ${batchError.message}`);
  const batchIds = (batches ?? []).map((row) => row.id);
  const { data: revisions, error: revisionError } = await svc
    .from('journal_revisions')
    .select('original_batch_id')
    .in('original_batch_id', batchIds);
  if (revisionError) throw new Error(`revision lookup failed: ${revisionError.message}`);
  const superseded = new Set((revisions ?? []).map((row) => row.original_batch_id));
  const liveBatch = batchIds.find((id) => !superseded.has(id));
  if (!liveBatch) throw new Error(`no live batch for ${transactionId}`);

  const { data: postings, error: postingError } = await svc
    .from('journal_postings')
    .select('ledger_account_id, amount_minor')
    .eq('batch_id', liveBatch);
  if (postingError) throw new Error(`posting lookup failed: ${postingError.message}`);
  const accountLedgerIds = new Set([
    SEED.ledgerAccounts.alphaChecking,
    ...(await svc.from('accounts').select('ledger_account_id').eq('id', destinationAccountId)).data?.map(
      (row) => row.ledger_account_id,
    ) ?? [],
  ]);
  const cash = (postings ?? []).filter((row) => accountLedgerIds.has(row.ledger_account_id));
  expect(cash).toHaveLength(1);
  return BigInt(cash[0]!.amount_minor);
};

beforeAll(async () => {
  const alex = await signIn(SEED.users.alex.email);
  const suffix = `${process.pid.toString(36)}-${Date.now().toString(36)}`;

  const { data: account, error: accountError } = await alex.rpc('keel_cmd_create_account', {
    p_command_id: crypto.randomUUID(),
    p_economic_event_key: `itest:distribution:account:${suffix}`,
    p_actor: ACTOR,
    p_household_id: HOUSEHOLD,
    p_payload: {
      entity_id: ENTITY,
      name: `Retirement ${suffix}`,
      kind: 'asset',
      subtype: 'retirement_401k',
      currency: 'USD',
    },
  });
  if (accountError) throw new Error(`destination account create failed: ${accountError.message}`);
  destinationAccountId = (account as { effects: { accountId: string } }).effects.accountId;

  providerTransactionId = `distribution-paycheck-${suffix}`;
  const eventId = `distribution-added-${suffix}`;
  const { error: rawError } = await serviceClient().rpc('keel_worker_record_raw_event', {
    p_provider: 'simulator',
    p_connection_external_ref: SEED.connections.simAlpha.ref,
    p_provider_event_id: eventId,
    p_account_external_ref: 'sim-acct-checking',
    p_received_at: `${EFFECTIVE_DATE}T12:00:00Z`,
    p_body: {
      kind: 'transaction_added',
      eventId,
      transaction: {
        providerTransactionId,
        accountExternalRef: 'sim-acct-checking',
        amountMinor: '70000',
        currency: 'USD',
        date: EFFECTIVE_DATE,
        description: `Distribution paycheck ${suffix}`,
        pending: false,
        pendingTransactionId: null,
      },
    },
  });
  if (rawError) throw new Error(`raw event create failed: ${rawError.message}`);
  expect(await drainQueue('sync_events')).toContain('done:create');

  const { data: source, error: sourceError } = await serviceClient()
    .from('canonical_transactions')
    .select('id')
    .eq('economic_event_key', `txn:simulator:${SEED.connections.simAlpha.ref}:${providerTransactionId}`)
    .single();
  if (sourceError) throw new Error(`source lookup failed: ${sourceError.message}`);
  sourceTransactionId = source.id;
});

describe('transaction distributions (Q5)', () => {
  it('materializes an account leg as a confirmed, balanced, cash-flow-excluded transfer', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const suffix = Date.now().toString(36);
    const createCategory = async (name: string, kind: 'income' | 'expense'): Promise<string> => {
      const { data, error } = await alex.rpc('keel_create_category', {
        p_household_id: HOUSEHOLD,
        p_name: `${name} ${suffix}`,
        p_kind: kind,
        p_parent_ledger_account_id: null,
        p_entity_id: ENTITY,
      });
      if (error) throw new Error(`category create failed: ${error.message}`);
      return data as string;
    };
    const grossIncome = await createCategory('Distribution gross', 'income');
    const withholding = await createCategory('Distribution withholding', 'expense');

    const { data, error } = await alex.rpc('keel_cmd_set_splits', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:distribution:set:${sourceTransactionId}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        transaction_id: sourceTransactionId,
        amount_minor: '70000',
        splits: [
          {
            leg_type: 'category',
            category_ledger_account_id: grossIncome,
            amount_minor: '-100000',
          },
          {
            leg_type: 'category',
            category_ledger_account_id: withholding,
            amount_minor: '20000',
          },
          { leg_type: 'account', account_id: destinationAccountId, amount_minor: '10000' },
        ],
      },
    });
    if (error) throw new Error(`account split failed: ${error.message}`);
    const effects = (data as {
      effects: { distributionId: string; distributionStatus: string };
    }).effects;
    distributionId = effects.distributionId;
    expect(effects.distributionStatus).toBe('active');

    const { data: distribution, error: distributionError } = await serviceClient()
      .from('transaction_distributions')
      .select('status, source_canonical_transaction_id')
      .eq('id', distributionId)
      .single();
    if (distributionError) throw new Error(distributionError.message);
    expect(distribution).toMatchObject({
      status: 'active',
      source_canonical_transaction_id: sourceTransactionId,
    });

    const { data: accountLeg, error: legError } = await serviceClient()
      .from('transaction_distribution_legs')
      .select('generated_transaction_id, transfer_link_id, status, signed_amount_minor')
      .eq('distribution_id', distributionId)
      .eq('leg_type', 'account')
      .single();
    if (legError) throw new Error(legError.message);
    generatedTransactionId = accountLeg.generated_transaction_id;
    transferLinkId = accountLeg.transfer_link_id;
    expect(accountLeg.status).toBe('active');
    expect(BigInt(accountLeg.signed_amount_minor)).toBe(10000n);

    const { data: link, error: linkError } = await serviceClient()
      .from('transfer_links')
      .select('txn_out, txn_in, status, booked_txn')
      .eq('id', transferLinkId)
      .single();
    if (linkError) throw new Error(linkError.message);
    expect(link.status).toBe('confirmed');
    expect(link.booked_txn).not.toBeNull();
    expect([link.txn_out, link.txn_in]).toContain(generatedTransactionId);

    expect(await liveCashAmount(sourceTransactionId)).toBe(80000n);
    expect(await liveCashAmount(generatedTransactionId)).toBe(-10000n);
    expect(await liveCashAmount(link.booked_txn)).toBe(10000n);

    const { data: batches, error: batchesError } = await serviceClient()
      .from('journal_batches')
      .select('id')
      .in('canonical_transaction_id', [generatedTransactionId, link.booked_txn]);
    if (batchesError) throw new Error(batchesError.message);
    for (const batch of batches) {
      const { data: postings, error: postingsError } = await serviceClient()
        .from('journal_postings')
        .select('amount_minor')
        .eq('batch_id', batch.id);
      if (postingsError) throw new Error(postingsError.message);
      expect((postings ?? []).reduce((sum, row) => sum + BigInt(row.amount_minor), 0n)).toBe(0n);
    }

    const { data: cashFlow, error: cashFlowError } = await alex.rpc('keel_cash_flow', {
      p_household_id: HOUSEHOLD,
      p_from: EFFECTIVE_DATE,
      p_to: EFFECTIVE_DATE,
    });
    if (cashFlowError) throw new Error(`cash flow failed: ${cashFlowError.message}`);
    expect(cashFlow.rows).toContainEqual({
      currency: 'USD',
      inflowMinor: '100000',
      outflowMinor: '20000',
      netMinor: '80000',
    });

    const { data: rich, error: richError } = await alex.rpc('keel_list_transactions_rich', {
      p_household_id: HOUSEHOLD,
    });
    if (richError) throw new Error(`rich read failed: ${richError.message}`);
    expect(rich.rows.find((row: { transactionId: string }) => row.transactionId === sourceTransactionId))
      .toMatchObject({
        distributionId,
        rawProviderAmountMinor: '70000',
        modeledAmountMinor: '80000',
        sourceTransactionId,
        derivedLegStatus: 'active',
      });
  });

  it('leaves the category-only set_splits correction path unchanged', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const { data: created, error: createError } = await alex.rpc('keel_cmd_manual_transaction', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:distribution:category-only:${crypto.randomUUID()}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        account_id: SEED.accounts.alphaChecking,
        description: 'Distribution category-only control',
        effective_date: EFFECTIVE_DATE,
        status: 'posted',
        amount_minor: '-4300',
        splits: [{ category_ledger_account_id: SEED.ledgerAccounts.alphaGroceries, amount_minor: '4300' }],
      },
    });
    if (createError) throw new Error(createError.message);
    const transactionId = (created as { effects: { canonicalTransactionId: string } }).effects
      .canonicalTransactionId;

    const { data: result, error } = await alex.rpc('keel_cmd_set_splits', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:distribution:category-only:set:${transactionId}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        transaction_id: transactionId,
        amount_minor: '-4300',
        splits: [{ category_ledger_account_id: SEED.ledgerAccounts.alphaGroceries, amount_minor: '4300' }],
      },
    });
    if (error) throw new Error(error.message);
    expect((result as { effects: { splitCount: number; newBatchId: string } }).effects).toMatchObject({
      splitCount: 1,
    });

    const { count, error: countError } = await serviceClient()
      .from('transaction_distributions')
      .select('*', { count: 'exact', head: true })
      .eq('source_canonical_transaction_id', transactionId);
    if (countError) throw new Error(countError.message);
    expect(count).toBe(0);
  });

  it('re-promotes the same provider net without duplicating distribution economics', async () => {
    const svc = serviceClient();
    const { count: generatedBefore, error: beforeError } = await svc
      .from('canonical_transactions')
      .select('*', { count: 'exact', head: true })
      .like('economic_event_key', `distribution:${distributionId}:%`);
    if (beforeError) throw new Error(beforeError.message);

    const eventId = `distribution-modified-${crypto.randomUUID()}`;
    const { error: rawError } = await svc.rpc('keel_worker_record_raw_event', {
      p_provider: 'simulator',
      p_connection_external_ref: SEED.connections.simAlpha.ref,
      p_provider_event_id: eventId,
      p_account_external_ref: 'sim-acct-checking',
      p_received_at: `${EFFECTIVE_DATE}T13:00:00Z`,
      p_body: {
        kind: 'transaction_modified',
        eventId,
        transaction: {
          providerTransactionId,
          accountExternalRef: 'sim-acct-checking',
          amountMinor: '70000',
          currency: 'USD',
          date: EFFECTIVE_DATE,
          description: 'Distribution paycheck same-net provider refresh',
          pending: false,
          pendingTransactionId: null,
        },
      },
    });
    if (rawError) throw new Error(rawError.message);
    expect(await drainQueue('sync_events')).toContain('done:revise');

    const { count: generatedAfter, error: afterError } = await svc
      .from('canonical_transactions')
      .select('*', { count: 'exact', head: true })
      .like('economic_event_key', `distribution:${distributionId}:%`);
    if (afterError) throw new Error(afterError.message);
    expect(generatedAfter).toBe(generatedBefore);

    const { data: leg, error: legError } = await svc
      .from('transaction_distribution_legs')
      .select('generated_transaction_id, transfer_link_id, status')
      .eq('distribution_id', distributionId)
      .eq('leg_type', 'account')
      .single();
    if (legError) throw new Error(legError.message);
    expect(leg).toMatchObject({
      generated_transaction_id: generatedTransactionId,
      transfer_link_id: transferLinkId,
      status: 'active',
    });
    expect(await liveCashAmount(sourceTransactionId)).toBe(80000n);
  });
});
