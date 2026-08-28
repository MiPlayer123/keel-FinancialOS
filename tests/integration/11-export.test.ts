/** Stage 1D Law 6 export, Law 9 tenant scope, Law 12 secret boundary. */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EXCLUDE,
  fromJson,
  parseDecimalToMinor,
  reconstructTrialBalance,
  toJson,
} from '../../packages/exports/src/index.js';
import {
  authedHeaders,
  callFunction,
  SEED,
  signIn,
  userToken,
} from './helpers.js';

const ROOT = join(import.meta.dirname, '..', '..');
const PSQL = existsSync('/Library/PostgreSQL/17/bin/psql')
  ? '/Library/PostgreSQL/17/bin/psql'
  : 'psql'; // CI/Linux: client on PATH
const ACCOUNT_ID = '00000000-0000-4000-8000-00000000a401';
const BETA_POSTING_ID = '99000000-0000-4000-8000-0000000000b1';
const CREDENTIAL_CANARY = 'EXPORT-CREDENTIAL-CANARY';
const CREDENTIAL_CANARY_HEX = '4558504f52542d43524544454e5449414c2d43414e415259';

let alexHeaders: Record<string, string>;
let blakeHeaders: Record<string, string>;
let caseyHeaders: Record<string, string>;
let promotedTransactionId: string;

interface ExportManifest {
  include: Array<{ table: string }>;
  exclude: Array<{ schema: string; table: string; reason: string }>;
}

const dbCommand = (sql: string): string => {
  const status = execSync('supabase status -o env', { cwd: ROOT, encoding: 'utf8' });
  const raw = status.match(/^DB_URL="?([^"\n]+)"?$/m)?.[1];
  if (!raw) throw new Error('local database URL unavailable');
  const url = new URL(raw);
  return execFileSync(PSQL, [
    '-h', url.hostname,
    '-p', url.port,
    '-U', decodeURIComponent(url.username),
    '-d', url.pathname.slice(1),
    '-v', 'ON_ERROR_STOP=1',
    '-At',
    '-c', sql,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
  }).trim();
};

const sortedTrial = (rows: Array<{
  ledgerAccountId: string;
  currency: string;
  balanceMinor: string;
}>): typeof rows => [...rows].sort((left, right) =>
  left.ledgerAccountId.localeCompare(right.ledgerAccountId) ||
  left.currency.localeCompare(right.currency));

beforeAll(async () => {
  [alexHeaders, blakeHeaders, caseyHeaders] = await Promise.all([
    userToken(SEED.users.alex.email).then(authedHeaders),
    userToken(SEED.users.blake.email).then(authedHeaders),
    userToken(SEED.users.casey.email).then(authedHeaders),
  ]);

  promotedTransactionId = '99000000-0000-4000-8000-0000000000a0';
  // Injected-sync fixture: direct canonical/batch/posting rows avoid leaving a
  // background queue message for an unrelated integration file to drain.
  dbCommand(`
    insert into public.canonical_transactions
      (id,household_id,entity_id,account_id,status,source,description,effective_date,
       economic_event_key,created_at)
    values
      ('${promotedTransactionId}','${SEED.households.alpha}',
       '${SEED.entities.alphaPersonal}','${ACCOUNT_ID}','posted','sync',
       'Stage 1D exact export transaction','2026-07-12','itest:export:canonical',now())
    on conflict do nothing;
    insert into public.journal_batches
      (id,household_id,canonical_transaction_id,description,effective_date,command_id,posted_at)
    values
      ('99000000-0000-4000-8000-0000000000a1','${SEED.households.alpha}',
       '${promotedTransactionId}','Stage 1D exact export batch','2026-07-12',
       '99000000-0000-4000-8000-0000000000a9',now())
    on conflict do nothing;
    insert into public.journal_postings
      (id,batch_id,ledger_account_id,entity_id,amount_minor,currency)
    values
      ('99000000-0000-4000-8000-0000000000a2','99000000-0000-4000-8000-0000000000a1',
       '${SEED.ledgerAccounts.alphaChecking}','${SEED.entities.alphaPersonal}',9007199254740993,'USD'),
      ('99000000-0000-4000-8000-0000000000a3','99000000-0000-4000-8000-0000000000a1',
       '${SEED.ledgerAccounts.alphaGroceries}','${SEED.entities.alphaPersonal}',-9007199254740993,'USD')
    on conflict do nothing;
  `);

  // A credential canary exists in the excluded table. If the SQL ACL/DTO
  // boundary regresses, its plaintext/hex representation reaches the bytes.
  dbCommand(`
    insert into public.connections
      (id,household_id,provider,external_ref,status,created_at,
       sync_desired_generation,sync_committed_generation)
    values
      ('99000000-0000-4000-8000-0000000000c1',
       '${SEED.households.alpha}','plaid','export-credential-canary-connection','active',now(),0,0)
    on conflict do nothing;
    insert into public.connection_credentials
      (id,household_id,connection_id,credential_owner_user_id,ciphertext,iv,
       wrapped_dek,wrap_iv,kek_version,created_at)
    values
      ('99000000-0000-4000-8000-0000000000c2','${SEED.households.alpha}',
       '99000000-0000-4000-8000-0000000000c1','${SEED.users.alex.id}',
       convert_to('${CREDENTIAL_CANARY}!!','UTF8'),decode(repeat('11',12),'hex'),
       decode(repeat('22',48),'hex'),decode(repeat('33',12),'hex'),1,now())
    on conflict do nothing;
  `);

  // A real beta posting makes cross-household child leakage observable.
  dbCommand(`
    insert into public.journal_batches
      (id,household_id,description,effective_date,command_id,posted_at)
    values
      ('99000000-0000-4000-8000-0000000000b0','${SEED.households.beta}',
       'beta export isolation fixture','2026-07-12',
       '99000000-0000-4000-8000-0000000000b9',now())
    on conflict do nothing;
    insert into public.journal_postings
      (id,batch_id,ledger_account_id,entity_id,amount_minor,currency)
    values
      ('${BETA_POSTING_ID}','99000000-0000-4000-8000-0000000000b0',
       '00000000-0000-4000-8000-00000000b301','00000000-0000-4000-8000-00000000b101',77,'USD'),
      ('99000000-0000-4000-8000-0000000000b2','99000000-0000-4000-8000-0000000000b0',
       '00000000-0000-4000-8000-00000000b311','00000000-0000-4000-8000-00000000b101',-77,'USD')
    on conflict do nothing;
  `);
});

describe('POST /api/admin/export', () => {
  it('exports a deterministic, reconstructable, tenant-safe multi-format snapshot', async () => {
    const response = await callFunction('/api/admin/export', {
      headers: alexHeaders,
      body: { householdId: SEED.households.alpha },
    });
    expect(response.status).toBe(200);
    const body = response.body as {
      manifest: ExportManifest;
      json: string;
      csv: Array<{ name: string; csv: string }>;
      qif: string;
      beancount: string;
    };
    const restored = fromJson(body.json);
    const parsed = JSON.parse(body.json);

    expect(parsed.manifest).toEqual(body.manifest);
    expect(toJson(restored)).toBe(body.json);
    expect(restored.tables.accounts.some((row) => row['id'] === ACCOUNT_ID)).toBe(true);
    expect(restored.tables.canonical_transactions.some(
      (row) => row['id'] === promotedTransactionId,
    )).toBe(true);
    expect(restored.tables.journal_postings.some(
      (row) => row['amount_minor'] === '9007199254740993',
    )).toBe(true);

    const postingsByBatch = new Map<string, bigint>();
    for (const posting of restored.tables.journal_postings) {
      const key = `${posting['batch_id']}:${posting['currency']}`;
      postingsByBatch.set(
        key,
        (postingsByBatch.get(key) ?? 0n) + BigInt(posting['amount_minor'] as string),
      );
    }
    expect([...postingsByBatch.values()].every((sum) => sum === 0n)).toBe(true);

    const alex = await signIn(SEED.users.alex.email);
    const { data: bypassData, error: bypassError } = await alex.rpc('keel_export_household', {
      p_household_id: SEED.households.alpha,
    });
    expect(bypassData).toBeNull();
    expect(bypassError?.code).toBe('42501');

    const { data: liveTrial, error: trialError } = await alex.rpc('keel_trial_balance', {
      p_household_id: SEED.households.alpha,
    });
    expect(trialError).toBeNull();
    expect(sortedTrial(reconstructTrialBalance(restored))).toEqual(
      sortedTrial(restored.trialBalance ?? []),
    );
    expect(sortedTrial(restored.trialBalance ?? [])).toEqual(sortedTrial(liveTrial.rows));

    const publicDecisions = [
      ...body.manifest.include.map((entry) => entry.table),
      ...body.manifest.exclude
        .filter((entry) => entry.schema === 'public')
        .map((entry) => entry.table),
    ].sort();
    const livePublicTables = dbCommand(`
      select table_name
        from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by table_name;
    `).split('\n').filter(Boolean);
    expect(publicDecisions).toEqual(livePublicTables);
    expect(new Set(publicDecisions).size).toBe(publicDecisions.length);
    for (const excluded of EXCLUDE.filter((entry) => entry.schema === 'public')) {
      expect(restored.tables).not.toHaveProperty(excluded.table);
      expect(body.csv.map((file) => file.name)).not.toContain(`${excluded.table}.csv`);
    }

    const portableBytes = JSON.stringify({
      json: body.json,
      csv: body.csv,
      qif: body.qif,
      beancount: body.beancount,
    });
    expect(portableBytes).not.toContain(CREDENTIAL_CANARY);
    expect(portableBytes.toLowerCase()).not.toContain(CREDENTIAL_CANARY_HEX.toLowerCase());
    expect(portableBytes).not.toContain(BETA_POSTING_ID);

    const qifMinor = body.qif.split('\n')
      .filter((line) => /^T-?\d/u.test(line))
      .map((line) => BigInt(parseDecimalToMinor(line.slice(1), 'USD')))
      .reduce((sum, amount) => sum + amount, 0n);
    const accountLedgerIds = new Set(restored.tables.accounts.map(
      (row) => row['ledger_account_id'] as string,
    ));
    const supersededBatchIds = new Set(restored.tables.journal_revisions
      .map((row) => row['original_batch_id'] as string));
    const liveTransactionIds = new Set(restored.tables.canonical_transactions
      .filter((row) => row['status'] !== 'voided')
      .map((row) => row['id'] as string));
    const canonicalBatchIds = new Set(restored.tables.journal_batches
      .filter((row) =>
        typeof row['canonical_transaction_id'] === 'string' &&
        liveTransactionIds.has(row['canonical_transaction_id']) &&
        row['reverses_batch_id'] === null &&
        !supersededBatchIds.has(row['id'] as string))
      .map((row) => row['id'] as string));
    const livePostings = restored.tables.journal_postings
      .filter((row) => canonicalBatchIds.has(row['batch_id'] as string));
    const expectedQifMinor = livePostings
      .filter((row) =>
        accountLedgerIds.has(row['ledger_account_id'] as string) &&
        restored.tables.ledger_accounts.some((account) =>
          account['id'] === row['ledger_account_id'] && account['kind'] === 'asset'))
      .reduce((sum, row) => sum + BigInt(row['amount_minor'] as string), 0n);
    expect(qifMinor).toBe(expectedQifMinor);

    const beanMinor = body.beancount.split('\n').flatMap((line) => {
      const match = /^  \S+  (-?\d+(?:\.\d+)?) ([A-Z]{3})$/u.exec(line);
      return match ? [parseDecimalToMinor(match[1]!, match[2]!)] : [];
    }).sort();
    expect(beanMinor).toEqual(
      livePostings.map((row) => row['amount_minor'] as string).sort(),
    );
  });

  it('denies a partner through the TypeScript owner authorization gate', async () => {
    const response = await callFunction('/api/admin/export', {
      headers: blakeHeaders,
      body: { householdId: SEED.households.alpha },
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('not_authorized');
  });

  it('returns export_too_large above the tested inline threshold', async () => {
    dbCommand(`
      insert into public.raw_provider_events
        (id,household_id,connection_id,provider,provider_event_id,account_external_ref,
         body,received_at,recorded_at,body_text,body_sha256)
      values
        ('99000000-0000-4000-8000-0000000000f1','${SEED.households.beta}',
         '00000000-0000-4000-8000-00000000b201','simulator','export-large-beta',
         'sim-acct-beta-checking','{}',now(),now(),repeat('x',5000100),
         encode(sha256(convert_to(repeat('x',5000100),'UTF8')),'hex'))
      on conflict do nothing;
    `);
    const response = await callFunction('/api/admin/export', {
      headers: caseyHeaders,
      body: { householdId: SEED.households.beta },
    });
    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      code: 'export_too_large',
      message:
        'This household is too large for the current download endpoint. An async export is not available yet.',
      details: {},
    });
  });
});
