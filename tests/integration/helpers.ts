/**
 * Integration-test plumbing. Resolves the local stack's URL/keys from
 * `supabase status`, creates clients, and wraps the Edge Function surfaces.
 * Requires: `supabase start` + `supabase db reset` + functions served with
 * `supabase functions serve --env-file supabase/functions/.env`.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const ROOT = join(import.meta.dirname, '..', '..');

interface StackEnv {
  apiUrl: string;
  anonKey: string;
  serviceKey: string;
  automationsSecret: string;
  webhookPrivateJwk: string;
}

let cached: StackEnv | null = null;

export const stackEnv = (): StackEnv => {
  if (cached) return cached;
  const status = execSync('supabase status -o env', { cwd: ROOT, encoding: 'utf8' });
  const get = (name: string): string => {
    const m = status.match(new RegExp(`^${name}="?([^"\n]+)"?$`, 'm'));
    if (!m) throw new Error(`supabase status missing ${name}`);
    return m[1]!;
  };
  const localRef = readFileSync(join(ROOT, '.env.local-automations'), 'utf8');
  const secret = localRef.match(/^KEEL_LOCAL_AUTOMATIONS_SECRET=(.+)$/m)?.[1];
  const privJwk = localRef.match(/^KEEL_WEBHOOK_TEST_PRIVATE_JWK=(.+)$/m)?.[1];
  if (!secret || !privJwk) {
    throw new Error('run `pnpm provision:local` first');
  }
  cached = {
    apiUrl: get('API_URL'),
    anonKey: get('ANON_KEY'),
    serviceKey: get('SERVICE_ROLE_KEY'),
    automationsSecret: secret,
    webhookPrivateJwk: privJwk,
  };
  return cached;
};

/** Functions are served by `supabase functions serve` on port 55321. */
export const functionsUrl = (path: string): string =>
  `${stackEnv().apiUrl}/functions/v1${path}`;

export const serviceClient = (): SupabaseClient =>
  createClient(stackEnv().apiUrl, stackEnv().serviceKey, {
    auth: { persistSession: false },
  });

export const anonClient = (): SupabaseClient =>
  createClient(stackEnv().apiUrl, stackEnv().anonKey, {
    auth: { persistSession: false },
  });

export const SEED = {
  password: 'keel-local-dev-password',
  users: {
    alex: { id: '00000000-0000-4000-8000-000000000001', email: 'alex@keel.local' },
    blake: { id: '00000000-0000-4000-8000-000000000002', email: 'blake@keel.local' },
    casey: { id: '00000000-0000-4000-8000-000000000003', email: 'casey@keel.local' },
    priya: { id: '00000000-0000-4000-8000-000000000004', email: 'priya@keel.local' },
  },
  households: {
    alpha: '00000000-0000-4000-8000-00000000a001',
    beta: '00000000-0000-4000-8000-00000000b001',
  },
  entities: {
    alphaPersonal: '00000000-0000-4000-8000-00000000a101',
  },
  ledgerAccounts: {
    alphaChecking: '00000000-0000-4000-8000-00000000a301',
    alphaGroceries: '00000000-0000-4000-8000-00000000a311',
  },
  connections: {
    simAlpha: { id: '00000000-0000-4000-8000-00000000a201', ref: 'sim-conn-alpha' },
    plaidAlpha: { id: '00000000-0000-4000-8000-00000000a202', ref: 'plaid-item-alpha' },
    plaidC5b: { id: '00000000-0000-4000-8000-00000000a203', ref: 'plaid-item-c5b' },
  },
} as const;

export const signIn = async (email: string): Promise<SupabaseClient> => {
  const client = createClient(stackEnv().apiUrl, stackEnv().anonKey, {
    auth: { persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: SEED.password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
};

export const userToken = async (email: string): Promise<string> => {
  const client = await signIn(email);
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('no session token');
  return token;
};

/** Raw fetch against a function with explicit headers — auth-boundary tests
 * need precise control over what credentials are (not) sent. */
export const callFunction = async (
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(functionsUrl(path), {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON responses are fine for failure cases */
  }
  return { status: res.status, body };
};

export const authedHeaders = (token: string): Record<string, string> => ({
  apikey: stackEnv().anonKey,
  authorization: `Bearer ${token}`,
});

let commandCounter = 0;

/** Fresh envelope with unique key/id per call (stable within one test run). */
export const envelope = (
  command: string,
  householdId: string,
  userId: string,
  payload: Record<string, unknown>,
  keySuffix?: string,
): Record<string, unknown> => {
  commandCounter += 1;
  return {
    commandId: crypto.randomUUID(),
    command,
    economicEventKey: `itest:${process.pid}:${commandCounter}${keySuffix ? `:${keySuffix}` : ''}`,
    actor: { kind: 'user', userId },
    householdId,
    payload,
  };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Drain a queue through the worker until its REAL depth is zero. Messages
 * mid-retry hide under the visibility timeout, so emptiness comes from the
 * depth probe, not from an empty read. */
export const drainQueue = async (queue: string): Promise<string[]> => {
  const details: string[] = [];
  for (let i = 0; i < 60; i += 1) {
    const res = await callFunction('/worker/drain', {
      headers: { apikey: stackEnv().automationsSecret },
      body: { queue, batchSize: 20 },
    });
    if (res.status !== 200) {
      throw new Error(`drain failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const body = res.body as {
      processed: Array<{ status: string; detail: string }>;
      depth: number;
    };
    details.push(...body.processed.map((p) => `${p.status}:${p.detail}`));
    if (body.depth === 0) return details;
    if (body.processed.length === 0) await sleep(2000); // wait out visibility window
  }
  throw new Error(`queue ${queue} did not drain in 60 rounds`);
};
