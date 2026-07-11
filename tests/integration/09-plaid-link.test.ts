/**
 * C3: Plaid link/disconnect lifecycle through the real API and worker.
 * Provider responses are token-free; test access/public tokens are synthesized
 * only inside Edge memory from the server-minted attempt id.
 */
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { encryptToken, type EncryptedRecord } from '../../supabase/functions/_shared/credential-crypto.ts';
import {
  authedHeaders,
  callFunction,
  drainQueue,
  serviceClient,
  SEED,
  signIn,
  stackEnv,
  userToken,
} from './helpers.js';

const ROOT = join(import.meta.dirname, '..', '..');
const PLAID_ITEM = 'plaid-item-c3';
const PSQL = '/Library/PostgreSQL/17/bin/psql';

let alexToken: string;
let cachedLocalDb: { args: string[]; password: string } | null = null;

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const localDb = (): { args: string[]; password: string } => {
  if (cachedLocalDb) return cachedLocalDb;
  const status = execSync('supabase status -o env', {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const raw = status.match(/^DB_URL="?([^"\n]+)"?$/m)?.[1];
  if (!raw) throw new Error('local database URL unavailable');
  const url = new URL(raw);
  cachedLocalDb = {
    args: [
      '-h',
      url.hostname,
      '-p',
      url.port,
      '-U',
      decodeURIComponent(url.username),
      '-d',
      url.pathname.slice(1),
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
    ],
    password: decodeURIComponent(url.password),
  };
  return cachedLocalDb;
};

const dbCommand = (sql: string): string => {
  const db = localDb();
  try {
    return execFileSync(PSQL, [...db.args, '-c', sql], {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: db.password },
    }).trim();
  } catch {
    throw new Error('local diagnostic SQL failed');
  }
};

const dbRows = <T>(query: string): T[] => {
  const raw = dbCommand(
    `select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) from (${query}) as q`,
  );
  return JSON.parse(raw || '[]') as T[];
};

const inject = async (
  scopeKey: string,
  kind: string,
  body: unknown,
  ordinal = 0,
): Promise<void> => {
  const { error } = await serviceClient().from('plaid_test_responses').insert({
    scope_key: scopeKey,
    kind,
    ordinal,
    body_text: JSON.stringify(body),
  });
  if (error) throw new Error(`Plaid injection failed: ${error.message}`);
};

interface PlaidAccountInput {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string;
  type: string;
  subtype: string;
  balances: { iso_currency_code?: string | null };
}

const plaidAccount = (
  accountId: string,
  type = 'depository',
  currency: string | null = 'USD',
): PlaidAccountInput => ({
  account_id: accountId,
  name: `C3 ${accountId}`,
  official_name: null,
  mask: '0000',
  type,
  subtype: type === 'credit' ? 'credit card' : 'checking',
  balances: { iso_currency_code: currency },
});

interface PreparedLink {
  attemptId: string;
  credentialId: string;
  commandId: string;
  accounts: PlaidAccountInput[];
}

const prepareLink = async (
  itemId: string,
  accounts: PlaidAccountInput[],
  commandId = crypto.randomUUID(),
): Promise<PreparedLink> => {
  const alex = await signIn(SEED.users.alex.email);
  const { data, error } = await alex.rpc('keel_begin_link', {
    p_command_id: commandId,
    p_household_id: SEED.households.alpha,
    p_entity_id: SEED.entities.alphaPersonal,
    p_provider: 'plaid',
    p_institution_id: 'ins-c3',
  });
  if (error || !data) throw new Error(`begin link failed: ${error?.message ?? 'no result'}`);

  const attemptId = String(data.attemptId);
  await inject(attemptId, 'sandbox_public_token_create', {});
  await inject(attemptId, 'item_public_token_exchange', { item_id: itemId });
  await inject(attemptId, 'accounts_get', { accounts, item: { item_id: itemId }, request_id: 'accounts-ok' });
  return {
    attemptId,
    credentialId: String(data.credentialId),
    commandId,
    accounts,
  };
};

const callLink = async (prepared: PreparedLink): Promise<{ status: number; body: unknown }> =>
  callFunction('/api/connections/link', {
    headers: authedHeaders(alexToken),
    body: {
      commandId: prepared.commandId,
      householdId: SEED.households.alpha,
      entityId: SEED.entities.alphaPersonal,
      institutionId: 'ins-c3',
    },
  });

const linkItem = async (
  itemId: string,
  accounts: PlaidAccountInput[],
): Promise<PreparedLink & { connectionId: string; accountIds: string[] }> => {
  const prepared = await prepareLink(itemId, accounts);
  const response = await callLink(prepared);
  expect(response.status).toBe(200);
  const body = response.body as { connectionId: string; accountIds: string[] };
  return { ...prepared, connectionId: body.connectionId, accountIds: body.accountIds };
};

const callDisconnect = async (connectionId: string, token = alexToken) =>
  callFunction('/api/connections/disconnect', {
    headers: authedHeaders(token),
    body: { householdId: SEED.households.alpha, connectionId },
  });

const currentKek = (): { value: string; version: number } => {
  const text = readFileSync(join(ROOT, 'supabase', 'functions', '.env'), 'utf8');
  const value = text.match(/^KEEL_CREDENTIAL_KEK=(.+)$/m)?.[1];
  const versionText = text.match(/^KEEL_CREDENTIAL_KEK_VERSION=(.+)$/m)?.[1];
  const version = Number(versionText);
  if (!value || !Number.isInteger(version) || version <= 0) {
    throw new Error('credential test configuration unavailable');
  }
  return { value, version };
};

const createStaleAttempt = async (
  itemId: string,
  token: string,
): Promise<{ attemptId: string; credentialId: string; envelope: EncryptedRecord }> => {
  const alex = await signIn(SEED.users.alex.email);
  const { data, error } = await alex.rpc('keel_begin_link', {
    p_command_id: crypto.randomUUID(),
    p_household_id: SEED.households.alpha,
    p_entity_id: SEED.entities.alphaPersonal,
    p_provider: 'plaid',
    p_institution_id: 'ins-reaper',
  });
  if (error || !data) throw new Error('reaper begin failed');
  const attemptId = String(data.attemptId);
  const credentialId = String(data.credentialId);
  const kek = currentKek();
  const envelope = await encryptToken(
    token,
    credentialId,
    SEED.households.alpha,
    'plaid',
    kek.value,
    kek.version,
  );
  const { error: recordError } = await serviceClient().rpc('keel_record_link_exchange', {
    p_attempt_id: attemptId,
    p_household_id: SEED.households.alpha,
    p_credential_id: credentialId,
    p_plaid_item_id: itemId,
    p_ciphertext_b64: envelope.ciphertext,
    p_iv_b64: envelope.iv,
    p_wrapped_dek_b64: envelope.wrappedDek,
    p_wrap_iv_b64: envelope.wrapIv,
    p_kek_version: envelope.kekVersion,
  });
  if (recordError) throw new Error(`reaper exchange failed: ${recordError.message}`);
  dbCommand(
    `update public.link_attempts set expires_at = now() - interval '1 hour' where id = ${sqlLiteral(attemptId)}::uuid`,
  );
  return { attemptId, credentialId, envelope };
};

beforeAll(async () => {
  alexToken = await userToken(SEED.users.alex.email);
  currentKek();
});

describe('C3 Plaid link/disconnect saga', () => {
  let happy: PreparedLink & { connectionId: string; accountIds: string[] };

  it('T1 links two USD accounts, moves the credential envelope, and posts an initial sync', async () => {
    happy = await linkItem(PLAID_ITEM, [
      plaidAccount('acct-c3-checking'),
      plaidAccount('acct-c3-savings'),
    ]);
    expect(happy.accountIds).toHaveLength(2);

    const connections = dbRows<{ status: string }>(
      `select status::text from public.connections where id = ${sqlLiteral(happy.connectionId)}::uuid`,
    );
    expect(connections[0]?.status).toBe('active');
    expect(
      dbRows(`select id from public.accounts where connection_id = ${sqlLiteral(happy.connectionId)}::uuid`),
    ).toHaveLength(2);
    expect(
      dbRows(
        `select la.id from public.ledger_accounts la join public.accounts a on a.ledger_account_id = la.id where a.connection_id = ${sqlLiteral(happy.connectionId)}::uuid`,
      ),
    ).toHaveLength(2);
    expect(
      dbRows<{ id: string }>(
        `select id from public.connection_credentials where connection_id = ${sqlLiteral(happy.connectionId)}::uuid`,
      ),
    ).toEqual([{ id: happy.credentialId }]);
    const attempt = dbRows<Record<string, unknown>>(
      `select credential_ciphertext, credential_iv, credential_wrapped_dek, credential_wrap_iv, credential_kek_version from public.link_attempts where id = ${sqlLiteral(happy.attemptId)}::uuid`,
    )[0];
    expect(attempt).toMatchObject({
      credential_ciphertext: null,
      credential_iv: null,
      credential_wrapped_dek: null,
      credential_wrap_iv: null,
      credential_kek_version: null,
    });

    const { error: pageError } = await serviceClient().from('sync_test_pages').insert({
      connection_id: happy.connectionId,
      page_index: 0,
      body_text: JSON.stringify({
        added: [
          {
            transaction_id: 'txn-c3-one',
            account_id: 'acct-c3-checking',
            amount: '19.25',
            iso_currency_code: 'USD',
            date: '2026-07-11',
            name: 'C3 Market',
            pending: false,
            pending_transaction_id: null,
          },
        ],
        modified: [],
        removed: [],
        next_cursor: 'c3-initial-cursor',
        has_more: false,
        request_id: 'c3-sync-one',
      }),
    });
    if (pageError) throw new Error(pageError.message);
    // Correctness is asserted on the resulting LEDGER STATE below (canonical
    // posted + trial balance) — the authoritative truth — not on worker log
    // strings, which race with drain timing (C5b lesson; see NOTES/08-sync).
    const outcomes = await drainQueue('sync_events');
    expect(outcomes.every((value) => !value.startsWith('dead_letter:'))).toBe(true);

    const canonical = dbRows<{ status: string }>(
      `select status::text from public.canonical_transactions where economic_event_key = 'txn:plaid:${PLAID_ITEM}:txn-c3-one'`,
    );
    expect(canonical).toEqual([{ status: 'posted' }]);
    const alex = await signIn(SEED.users.alex.email);
    const { data: trial, error: trialError } = await alex.rpc('keel_trial_balance', {
      p_household_id: SEED.households.alpha,
    });
    if (trialError) throw new Error(trialError.message);
    expect(JSON.stringify(trial)).toContain('-1925');
  });

  it('T2 creates only the USD account from a mixed-currency response', async () => {
    const mixed = await linkItem('plaid-item-c3-mixed', [
      plaidAccount('acct-c3-usd'),
      plaidAccount('acct-c3-cad', 'depository', 'CAD'),
    ]);
    expect(mixed.accountIds).toHaveLength(1);
    expect(
      dbRows<{ external_ref: string }>(
        `select external_ref from public.accounts where connection_id = ${sqlLiteral(mixed.connectionId)}::uuid`,
      ),
    ).toEqual([{ external_ref: 'acct-c3-usd' }]);
    await drainQueue('sync_events');
  });

  it('T2b maps a USD credit account to a liability ledger account', async () => {
    const credit = await linkItem('plaid-item-c3-credit', [
      plaidAccount('acct-c3-credit', 'credit'),
    ]);
    expect(
      dbRows<{ kind: string }>(
        `select la.kind::text from public.ledger_accounts la join public.accounts a on a.ledger_account_id = la.id where a.connection_id = ${sqlLiteral(credit.connectionId)}::uuid`,
      ),
    ).toEqual([{ kind: 'liability' }]);
    await drainQueue('sync_events');
  });

  it('T3 removes the item before shredding credentials and disconnecting', async () => {
    const before = dbRows<{ sync_desired_generation: number }>(
      `select sync_desired_generation from public.connections where id = ${sqlLiteral(happy.connectionId)}::uuid`,
    )[0]!;
    await inject(happy.connectionId, 'item_remove', { request_id: 'ok' });
    const response = await callDisconnect(happy.connectionId);
    expect(response).toEqual({ status: 200, body: { status: 'disconnected' } });
    const connection = dbRows<Record<string, unknown>>(
      `select status::text, sync_desired_generation, sync_lease_owner, sync_leased_until from public.connections where id = ${sqlLiteral(happy.connectionId)}::uuid`,
    )[0]!;
    expect(connection).toMatchObject({
      status: 'disconnected',
      sync_desired_generation: before.sync_desired_generation + 1,
      sync_lease_owner: null,
      sync_leased_until: null,
    });
    expect(
      dbRows(
        `select id from public.connection_credentials where connection_id = ${sqlLiteral(happy.connectionId)}::uuid`,
      ),
    ).toHaveLength(0);
    expect(
      dbRows<{ state: string }>(
        `select state from public.removal_attempts where connection_id = ${sqlLiteral(happy.connectionId)}::uuid order by started_at desc limit 1`,
      ),
    ).toEqual([{ state: 'succeeded' }]);
  });

  it('T4 retains credentials and disconnecting state when Plaid removal fails', async () => {
    const target = await linkItem('plaid-item-c3-remove-fail', [plaidAccount('acct-c3-fail')]);
    await drainQueue('sync_events');
    await inject(target.connectionId, 'item_remove', {
      error_code: 'INTERNAL_SERVER_ERROR',
      error_type: 'API_ERROR',
      request_id: 'remove-failed',
    });
    const response = await callDisconnect(target.connectionId);
    expect(response).toEqual({ status: 200, body: { status: 'disconnecting' } });
    expect(
      dbRows<{ status: string }>(
        `select status::text from public.connections where id = ${sqlLiteral(target.connectionId)}::uuid`,
      ),
    ).toEqual([{ status: 'disconnecting' }]);
    expect(
      dbRows(
        `select id from public.connection_credentials where connection_id = ${sqlLiteral(target.connectionId)}::uuid`,
      ),
    ).toHaveLength(1);
    expect(
      dbRows<{ state: string; failure_code: string }>(
        `select state, failure_code from public.removal_attempts where connection_id = ${sqlLiteral(target.connectionId)}::uuid order by started_at desc limit 1`,
      ),
    ).toEqual([{ state: 'failed', failure_code: 'INTERNAL_SERVER_ERROR' }]);
  });

  it('T5 refuses sync acquisition while reauthentication is required', async () => {
    const target = await linkItem('plaid-item-c3-reauth', [plaidAccount('acct-c3-reauth')]);
    await drainQueue('sync_events');
    const { count: before } = await serviceClient()
      .from('canonical_transactions')
      .select('*', { count: 'exact', head: true })
      .eq('account_id', target.accountIds[0]!);
    const { error: reauthError } = await serviceClient().rpc('keel_set_connection_reauth', {
      p_connection_id: target.connectionId,
      p_event_type: 'ITEM_LOGIN_REQUIRED',
      p_required: true,
    });
    if (reauthError) throw new Error(reauthError.message);
    const { error: notificationError } = await serviceClient().rpc('keel_worker_record_raw_event', {
      p_provider: 'plaid',
      p_connection_external_ref: 'plaid-item-c3-reauth',
      p_provider_event_id: 'c3-reauth-notification',
      p_account_external_ref: 'item-notification',
      p_body: { webhook_code: 'SYNC_UPDATES_AVAILABLE' },
      p_received_at: new Date().toISOString(),
    });
    if (notificationError) throw new Error(notificationError.message);
    const drain = await callFunction('/worker/drain', {
      headers: { apikey: stackEnv().automationsSecret },
      body: { queue: 'sync_events', batchSize: 20 },
    });
    expect(drain.status).toBe(200);
    const processed = (drain.body as { processed: Array<{ msgId: number; status: string; detail: string }> })
      .processed;
    const refused = processed.find((row) => row.detail.includes('reauth_required'));
    expect(refused?.status).toBe('retry');
    if (refused) {
      await serviceClient().rpc('keel_worker_queue_archive', {
        p_queue: 'sync_events',
        p_msg_id: refused.msgId,
      });
    }
    const { count: after } = await serviceClient()
      .from('canonical_transactions')
      .select('*', { count: 'exact', head: true })
      .eq('account_id', target.accountIds[0]!);
    expect(after).toBe(before);
    await serviceClient().rpc('keel_set_connection_reauth', {
      p_connection_id: target.connectionId,
      p_event_type: 'LOGIN_REPAIRED',
      p_required: false,
    });
  });

  it('T6 decrypts, removes, and shreds a stale exchanged attempt', async () => {
    const stale = await createStaleAttempt('plaid-item-c3-reap', 'dummy-c3-reaper-token');
    await inject(stale.attemptId, 'item_remove', { request_id: 'reaped-ok' });
    const response = await callFunction('/worker/reap-links', {
      headers: { apikey: stackEnv().automationsSecret },
      body: {},
    });
    expect(response.status).toBe(200);
    const attempt = dbRows<Record<string, unknown>>(
      `select state, credential_ciphertext, credential_iv, credential_wrapped_dek, credential_wrap_iv, credential_kek_version from public.link_attempts where id = ${sqlLiteral(stale.attemptId)}::uuid`,
    )[0]!;
    expect(attempt).toMatchObject({
      state: 'reaped',
      credential_ciphertext: null,
      credential_iv: null,
      credential_wrapped_dek: null,
      credential_wrap_iv: null,
      credential_kek_version: null,
    });
    const { count } = await serviceClient()
      .from('plaid_test_responses')
      .select('*', { count: 'exact', head: true })
      .eq('scope_key', stale.attemptId)
      .eq('kind', 'item_remove');
    expect(count).toBe(0);
  });

  it('T7 hides an Alpha connection from a Beta-only user disconnect attempt', async () => {
    const betaToken = await userToken(SEED.users.casey.email);
    const before = dbRows<{ status: string }>(
      `select status::text from public.connections where id = ${sqlLiteral(happy.connectionId)}::uuid`,
    );
    const response = await callDisconnect(happy.connectionId, betaToken);
    expect([403, 404]).toContain(response.status);
    expect(
      dbRows<{ status: string }>(
        `select status::text from public.connections where id = ${sqlLiteral(happy.connectionId)}::uuid`,
      ),
    ).toEqual(before);
  });

  it('T8 keeps synthesized access/public token canaries out of every persistence sink', async () => {
    const canaries = [
      `access-sandbox-${happy.attemptId}`,
      `public-sandbox-${happy.attemptId}`,
    ];
    await inject(happy.attemptId, 'sandbox_public_token_create', {}, 90);
    await inject(happy.attemptId, 'item_public_token_exchange', { item_id: PLAID_ITEM }, 90);
    const scans = [
      dbRows('select * from public.connection_credentials'),
      dbRows('select * from public.link_attempts'),
      dbRows('select * from public.audit_log'),
      dbRows('select * from public.connection_health_events'),
      dbRows('select * from public.usage_events'),
      dbRows('select * from public.plaid_test_responses'),
    ];
    const persisted = JSON.stringify(scans);
    for (const canary of canaries) expect(persisted).not.toContain(canary);
    const { error } = await serviceClient()
      .from('plaid_test_responses')
      .delete()
      .eq('scope_key', happy.attemptId);
    if (error) throw new Error(error.message);
  });

  it('T9 fences apply and completion after disconnect invalidates an in-flight lease', async () => {
    const target = await linkItem('plaid-item-c3-fence', [plaidAccount('acct-c3-fence')]);
    await drainQueue('sync_events');
    const checkpointBefore = dbRows<{ cursor: string }>(
      `select cursor from public.sync_checkpoints where connection_id = ${sqlLiteral(target.connectionId)}::uuid`,
    );
    const generationsBefore = dbRows<{
      sync_desired_generation: number;
      sync_committed_generation: number;
    }>(
      `select sync_desired_generation, sync_committed_generation from public.connections where id = ${sqlLiteral(target.connectionId)}::uuid`,
    )[0]!;
    const owner = crypto.randomUUID();
    const svc = serviceClient();
    const { data: lease, error: leaseError } = await svc.rpc('keel_worker_acquire_sync_lease', {
      p_connection_id: target.connectionId,
      p_owner: owner,
      p_ttl_seconds: 30,
    });
    if (leaseError || !lease?.acquired) throw new Error('fence lease acquisition failed');
    const { data: attemptId, error: openError } = await svc.rpc('keel_worker_open_attempt', {
      p_connection_id: target.connectionId,
      p_owner: owner,
      p_base_cursor: '',
    });
    if (openError || !attemptId) throw new Error('fence attempt open failed');
    const { error: archiveError } = await svc.rpc('keel_worker_archive_page', {
      p_attempt_id: attemptId,
      p_owner: owner,
      p_page_ordinal: 0,
      p_body_text: JSON.stringify({
        added: [], modified: [], removed: [], next_cursor: 'fenced', has_more: false,
        request_id: 'fence-page',
      }),
    });
    if (archiveError) throw new Error(archiveError.message);
    const { data: normalizedId, error: normalizedError } = await svc.rpc(
      'keel_worker_create_normalized',
      {
        p_attempt_id: attemptId,
        p_owner: owner,
        p_account_id: target.accountIds[0],
        p_provider_transaction_id: 'txn-c3-fenced',
        p_kind: 'added',
        p_amount_minor: '-100',
        p_currency: 'USD',
        p_effective_date: '2026-07-11',
        p_description: 'must not post',
      },
    );
    if (normalizedError || !normalizedId) throw new Error('fence normalized row failed');

    const alex = await signIn(SEED.users.alex.email);
    const { data: removal, error: disconnectError } = await alex.rpc('keel_disconnect_begin', {
      p_household_id: SEED.households.alpha,
      p_connection_id: target.connectionId,
      p_reason: 'user_requested',
    });
    if (disconnectError || !removal) throw new Error('fence disconnect begin failed');

    const { error: applyError } = await svc.rpc('keel_worker_apply_action', {
      p_normalized_id: normalizedId,
      p_action_kind: 'create',
      p_economic_key: 'txn:plaid:plaid-item-c3-fence:txn-c3-fenced',
      p_apply_key: 'itest:c3:fence:apply',
    });
    expect(applyError?.code).toBe('P0007');
    const { error: completeError } = await svc.rpc('keel_worker_complete_attempt', {
      p_attempt_id: attemptId,
      p_owner: owner,
      p_next_cursor: 'must-not-commit',
    });
    expect(['P0007', 'P0011']).toContain(completeError?.code);
    expect(
      dbRows(
        `select id from public.canonical_transactions where economic_event_key = 'txn:plaid:plaid-item-c3-fence:txn-c3-fenced'`,
      ),
    ).toHaveLength(0);
    expect(
      dbRows<{ cursor: string }>(
        `select cursor from public.sync_checkpoints where connection_id = ${sqlLiteral(target.connectionId)}::uuid`,
      ),
    ).toEqual(checkpointBefore);
    const generations = dbRows<{ sync_desired_generation: number; sync_committed_generation: number }>(
      `select sync_desired_generation, sync_committed_generation from public.connections where id = ${sqlLiteral(target.connectionId)}::uuid`,
    )[0]!;
    expect(generations.sync_committed_generation).toBe(generationsBefore.sync_committed_generation);
    expect(generations.sync_desired_generation).toBe(
      generationsBefore.sync_desired_generation + 1,
    );

    await inject(target.connectionId, 'item_remove', { request_id: 'fence-cleanup' });
    expect(await callDisconnect(target.connectionId)).toMatchObject({
      status: 200,
      body: { status: 'disconnected' },
    });
  });

  it('T10 parks a stale attempt after five bounded reaper failures', async () => {
    const stale = await createStaleAttempt('plaid-item-c3-retry-cap', 'dummy-c3-retry-token');
    for (let ordinal = 0; ordinal < 5; ordinal += 1) {
      await inject(stale.attemptId, 'item_remove', {
        error_code: 'INTERNAL_SERVER_ERROR',
        error_type: 'API_ERROR',
        request_id: `retry-${ordinal}`,
      }, ordinal);
    }
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await callFunction('/worker/reap-links', {
        headers: { apikey: stackEnv().automationsSecret },
        body: {},
      });
      expect(response.status).toBe(200);
      const row = dbRows<{ state: string; reap_attempts: number }>(
        `select state, reap_attempts from public.link_attempts where id = ${sqlLiteral(stale.attemptId)}::uuid`,
      )[0]!;
      expect(row.reap_attempts).toBe(attempt);
    }
    expect(
      dbRows<{ state: string; reap_attempts: number }>(
        `select state, reap_attempts from public.link_attempts where id = ${sqlLiteral(stale.attemptId)}::uuid`,
      ),
    ).toEqual([{ state: 'failed', reap_attempts: 5 }]);
  });

  it('T11 finalizing the same succeeded attempt returns the same one-copy result', async () => {
    const target = await linkItem('plaid-item-c3-finalize-replay', [
      plaidAccount('acct-c3-finalize-replay'),
    ]);
    await drainQueue('sync_events');
    const accounts = target.accounts.map((account) => ({
      external_ref: account.account_id,
      name: account.name,
      subtype: account.subtype,
      currency: 'USD',
      kind: 'asset',
    }));
    const { data, error } = await serviceClient().rpc('keel_finalize_link', {
      p_attempt_id: target.attemptId,
      p_household_id: SEED.households.alpha,
      p_institution_id: 'ins-c3',
      p_consent_expires_at: null,
      p_accounts: accounts,
    });
    if (error) throw new Error(error.message);
    expect(data).toEqual({ connectionId: target.connectionId, accountIds: target.accountIds });
    expect(
      dbRows(
        `select id from public.connections where external_ref = 'plaid-item-c3-finalize-replay'`,
      ),
    ).toHaveLength(1);
    expect(
      dbRows(
        `select id from public.connection_credentials where connection_id = ${sqlLiteral(target.connectionId)}::uuid`,
      ),
    ).toHaveLength(1);
    expect(
      dbRows(
        `select id from public.accounts where connection_id = ${sqlLiteral(target.connectionId)}::uuid`,
      ),
    ).toHaveLength(1);
  });

  it('T12 denies authenticated users direct access to internal transition RPCs', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const calls = [
      alex.rpc('keel_finalize_link', {
        p_attempt_id: crypto.randomUUID(),
        p_household_id: SEED.households.alpha,
        p_institution_id: null,
        p_consent_expires_at: null,
        p_accounts: [],
      }),
      alex.rpc('keel_disconnect_complete', {
        p_household_id: SEED.households.alpha,
        p_connection_id: crypto.randomUUID(),
        p_removal_attempt_id: crypto.randomUUID(),
        p_removed: false,
        p_failure: 'test',
      }),
      alex.rpc('keel_record_link_exchange', {
        p_attempt_id: crypto.randomUUID(),
        p_household_id: SEED.households.alpha,
        p_credential_id: crypto.randomUUID(),
        p_plaid_item_id: 'forbidden',
        p_ciphertext_b64: '',
        p_iv_b64: '',
        p_wrapped_dek_b64: '',
        p_wrap_iv_b64: '',
        p_kek_version: 1,
      }),
    ];
    for (const result of await Promise.all(calls)) expect(result.error?.code).toBe('42501');
  });

  it('T13 compensates with item/remove when exchange-envelope persistence fails', async () => {
    const prepared = await prepareLink('plaid-item-c3-persist-fail', [
      plaidAccount('acct-c3-persist-fail'),
    ]);
    await inject(prepared.attemptId, 'item_remove', { request_id: 'compensated' });
    dbCommand(`
      create or replace function public.c3_force_exchange_persist_failure() returns trigger
      language plpgsql as $fn$
      begin
        if old.scope_key = ${sqlLiteral(prepared.attemptId)}
           and old.kind = 'sandbox_public_token_create' then
          update public.link_attempts set state = 'failed', failure_code = 'forced_test_failure'
           where id = ${sqlLiteral(prepared.attemptId)}::uuid;
        end if;
        return old;
      end
      $fn$;
      create trigger c3_force_exchange_persist_failure
        after delete on public.plaid_test_responses
        for each row execute function public.c3_force_exchange_persist_failure();
    `);
    try {
      const response = await callLink(prepared);
      expect(response.status).toBe(500);
    } finally {
      dbCommand(`
        drop trigger if exists c3_force_exchange_persist_failure on public.plaid_test_responses;
        drop function if exists public.c3_force_exchange_persist_failure();
      `);
    }
    expect(
      dbRows<{ state: string; credential_ciphertext: string | null }>(
        `select state, encode(credential_ciphertext, 'base64') as credential_ciphertext from public.link_attempts where id = ${sqlLiteral(prepared.attemptId)}::uuid`,
      ),
    ).toEqual([{ state: 'failed', credential_ciphertext: null }]);
    const { count } = await serviceClient()
      .from('plaid_test_responses')
      .select('*', { count: 'exact', head: true })
      .eq('scope_key', prepared.attemptId)
      .eq('kind', 'item_remove');
    expect(count).toBe(0);
  });

  it('T14 concurrent reapers claim each stale attempt at most once', async () => {
    const stale = await Promise.all([
      createStaleAttempt('plaid-item-c3-dual-a', 'dummy-c3-dual-a'),
      createStaleAttempt('plaid-item-c3-dual-b', 'dummy-c3-dual-b'),
    ]);
    for (const attempt of stale) {
      await inject(attempt.attemptId, 'item_remove', { request_id: `removed-${attempt.attemptId}` });
    }
    const responses = await Promise.all([
      callFunction('/worker/reap-links', {
        headers: { apikey: stackEnv().automationsSecret },
        body: {},
      }),
      callFunction('/worker/reap-links', {
        headers: { apikey: stackEnv().automationsSecret },
        body: {},
      }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    for (const attempt of stale) {
      expect(
        dbRows<{ state: string }>(
          `select state from public.link_attempts where id = ${sqlLiteral(attempt.attemptId)}::uuid`,
        ),
      ).toEqual([{ state: 'reaped' }]);
      expect(
        dbRows(
          `select id from public.audit_log where action = 'connection.link_reap_claimed' and object_id = ${sqlLiteral(attempt.attemptId)}::uuid`,
        ),
      ).toHaveLength(1);
      const { count } = await serviceClient()
        .from('plaid_test_responses')
        .select('*', { count: 'exact', head: true })
        .eq('scope_key', attempt.attemptId)
        .eq('kind', 'item_remove');
      expect(count).toBe(0);
    }
  });
});
