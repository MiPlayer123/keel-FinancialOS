/**
 * MCP connector end-to-end check against a LOCAL stack: a fake AI app
 * connects through the real Supabase OAuth 2.1 server (discovery → DCR →
 * PKCE authorize → KEEL consent → token) and then drives the `mcp` function
 * like Claude would, including the security guards.
 *
 * Usage (see supabase/functions/mcp/README.md "Local development"):
 *   eval "$(supabase status -o env)"
 *   node scripts/dev/mcp-e2e.mjs write   # or: read
 *
 * Uses the fictional seed user alex@keel.local and its Alpha household; it
 * writes test rows there, so run `supabase db reset` afterwards for a clean
 * database.
 */
import { createHash, randomBytes } from 'node:crypto';

const API = process.env.API_URL ?? 'http://127.0.0.1:55321';
const ANON = process.env.PUBLISHABLE_KEY ?? process.env.ANON_KEY;
const MCP = process.env.KEEL_MCP_E2E_URL ?? `${API}/functions/v1/mcp`;
const APP_API = process.env.KEEL_API_E2E_URL ?? `${API}/functions/v1/api`;
const REDIRECT = 'http://localhost:9999/callback';
const ACCESS = process.argv[2] ?? 'write';
if (!ANON) {
  console.error('Run eval "$(supabase status -o env)" first.');
  process.exit(2);
}

let failures = 0;
const check = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
};
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };

// 1. Discovery from the 401 challenge
const challenge = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const www = challenge.headers.get('www-authenticate') ?? '';
check(challenge.status === 401 && www.includes('resource_metadata='), 'no token → 401 with resource_metadata');
const prm = await json(await fetch(www.match(/resource_metadata="([^"]+)"/)[1]));
check(prm.authorization_servers?.[0] === `${API}/auth/v1`, 'PRM points at Supabase Auth');
const as = await json(await fetch(`${API}/auth/v1/.well-known/oauth-authorization-server`));
check(as.code_challenge_methods_supported?.includes('S256') && as.registration_endpoint, 'AS supports PKCE S256 + DCR');

// 2. Dynamic client registration (what Claude/Codex do; the name is self-asserted)
const reg = await json(await fetch(as.registration_endpoint, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'E2E Test App', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
}));
check(typeof reg.client_id === 'string', 'DCR returns a client_id', JSON.stringify(reg).slice(0, 200));

// 3. Authorize with PKCE → KEEL consent path
const verifier = b64url(randomBytes(32));
const challengeS256 = b64url(createHash('sha256').update(verifier).digest());
const authUrl = `${as.authorization_endpoint}?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challengeS256, code_challenge_method: 'S256', state: 'st-1', scope: 'openid email' })}`;
const authRes = await fetch(authUrl, { redirect: 'manual' });
const consentUrl = new URL(authRes.headers.get('location') ?? 'http://x/');
const authorizationId = consentUrl.searchParams.get('authorization_id');
check(consentUrl.pathname === '/oauth/consent' && authorizationId, 'authorize redirects to KEEL /oauth/consent', authRes.headers.get('location'));

// 4. The user signs in to KEEL (fictional seeded user Alex, member of two households)
const session = await json(await fetch(`${API}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'alex@keel.local', password: 'keel-local-dev-password' }),
}));
const userHeaders = { apikey: ANON, authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' };
const details = await json(await fetch(`${API}/auth/v1/oauth/authorizations/${authorizationId}`, { headers: userHeaders }));
check(details.client?.id === reg.client_id && details.client?.name === 'E2E Test App', 'consent page gets the client id + name');

// 5. Consent page: save KEEL's grant through the app API, then approve
const HOUSEHOLD = '00000000-0000-4000-8000-00000000a001';
const setRes = await fetch(`${APP_API}/connected-apps/set`, { method: 'POST', headers: userHeaders, body: JSON.stringify({ clientId: reg.client_id, householdId: HOUSEHOLD, access: ACCESS }) });
check(setRes.status === 200, `KEEL grant saved via /connected-apps/set (${ACCESS})`, await setRes.clone().text());
const consent = await json(await fetch(`${API}/auth/v1/oauth/authorizations/${authorizationId}/consent`, { method: 'POST', headers: userHeaders, body: JSON.stringify({ action: 'approve' }) }));
const code = new URL(consent.redirect_url).searchParams.get('code');
check(!!code && new URL(consent.redirect_url).searchParams.get('state') === 'st-1', 'approve returns a code + state');

// 6. Token exchange (public client + PKCE)
const token = await json(await fetch(as.token_endpoint, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }),
}));
const claims = JSON.parse(Buffer.from(token.access_token.split('.')[1], 'base64url').toString());
check(claims.client_id === reg.client_id && claims.aud === 'authenticated', 'access token carries client_id (aud is still "authenticated")');

// 7. MCP session
let id = 0;
const mcp = async (method, params, tok = token.access_token) => {
  const res = await fetch(MCP, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  try { return { status: res.status, body: JSON.parse(line ? line.slice(6) : text) }; } catch { return { status: res.status, body: { _raw: text } }; }
};
const call = async (name, args = {}) => {
  const r = await mcp('tools/call', { name, arguments: args });
  return { ...r, data: r.body.result?.structuredContent, isError: r.body.result?.isError === true, text: r.body.result?.content?.[0]?.text ?? JSON.stringify(r.body) };
};

const init = await mcp('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
check(init.body.result?.serverInfo?.name === 'keel', 'initialize');
const tools = (await mcp('tools/list')).body.result?.tools ?? [];
console.log(`      tools listed: ${tools.length} (${tools.filter((t) => t.annotations.readOnlyHint).length} read)`);
if (ACCESS === 'read') {
  check(tools.every((t) => t.annotations.readOnlyHint), 'read grant lists only read tools');
  const blocked = await call('accounts_create', { name: 'Nope', type: 'cash' });
  check(blocked.isError || blocked.body.error, 'read grant cannot call a write tool');
} else {
  check(tools.some((t) => t.name === 'transactions_split'), 'write grant lists write tools');

  // Writes: a cash account with a starting balance, a manual purchase, a split, an edit.
  const cats = await call('categories_list');
  check(!cats.isError, 'categories_list', cats.text.slice(0, 300));
  const catByName = Object.fromEntries((cats.data?.categories ?? []).map((c) => [c.name, c.id]));
  const groceries = catByName['Groceries'];
  const coffee = catByName['Coffee Shops'] ?? Object.values(catByName).find((v) => v !== groceries);

  const acct = await call('accounts_create', { name: 'Wallet Cash', type: 'cash', starting_balance_minor: '20000', idempotency_key: 'e2e-wallet-1' });
  check(!acct.isError && acct.data?.account_id, 'accounts_create (cash, $200 start)', acct.text.slice(0, 300));
  const wallet = acct.data?.account_id;

  const buy = await call('transactions_create', { account_id: wallet, date: '2026-11-02', description: 'FARMERS MARKET', amount_minor: '-4500', category_id: groceries, note: 'Saturday market', idempotency_key: 'e2e-buy-1' });
  check(!buy.isError && buy.data?.transaction_id, 'transactions_create (-$45 groceries + note)', buy.text.slice(0, 300));
  const replay = await call('transactions_create', { account_id: wallet, date: '2026-11-02', description: 'FARMERS MARKET', amount_minor: '-4500', category_id: groceries, idempotency_key: 'e2e-buy-1' });
  check(!replay.isError && replay.data?.transaction_id === buy.data?.transaction_id, 'same idempotency_key replays, no duplicate', replay.text.slice(0, 200));
  const txn = buy.data?.transaction_id;

  const split = await call('transactions_split', { transaction_id: txn, mode: 'percent', splits: [{ category_id: groceries, basis_points: 6667 }, { category_id: coffee, basis_points: 3333 }] });
  check(!split.isError, 'transactions_split (percent, KEEL rounds)', split.text.slice(0, 300));
  const badSplit = await call('transactions_split', { transaction_id: txn, mode: 'amounts', splits: [{ category_id: groceries, amount_minor: '1000' }] });
  check(badSplit.isError && badSplit.text.includes('4500'), 'bad split explains the mismatch');

  const edit = await call('transactions_update', { transaction_id: txn, display_name: 'Farmers market', note: 'Split with a friend' });
  check(!edit.isError, 'transactions_update (name + note)', edit.text.slice(0, 300));

  const got = await call('transactions_get', { transaction_id: txn });
  const t = got.data?.transaction;
  check(t?.description === 'Farmers market' && t?.original_description === 'FARMERS MARKET' && t?.note === 'Split with a friend', 'transactions_get shows name, bank text, note', got.text.slice(0, 400));
  check(t?.splits?.length === 2 && t.splits.reduce((a, s) => a + BigInt(s.amount.amount_minor), 0n) === -4500n, 'splits add back to the amount');
  check((got.data?.history ?? []).some((h) => h.by === 'connected app'), 'history attributes changes to the connected app');

  const list = await call('transactions_list', { account_id: wallet, page_size: 1, detail: 'full' });
  check(!list.isError && list.data?.transactions?.length >= 1, 'transactions_list (account filter)', list.text.slice(0, 300));
  const page2 = await call('transactions_list', { account_id: wallet, page_size: 1, cursor: list.data?.next_cursor ?? undefined });
  check(!page2.isError, 'transactions_list next page via cursor', page2.text.slice(0, 200));

  const sum = await call('transactions_summarize', { group_by: 'category', account_id: wallet });
  const groups = Object.fromEntries((sum.data?.groups ?? []).map((g) => [g.label, g.money_out.amount_minor]));
  check(groups['Groceries'] === '3000' && Object.values(groups).includes('1500'), 'transactions_summarize splits 4500 into 3000 + 1500', JSON.stringify(groups));

  const accounts = await call('accounts_list');
  const w = (accounts.data?.accounts ?? []).find((a) => a.id === wallet);
  check(w?.balance?.amount_minor === '15500', 'accounts_list ledger balance = 20000 − 4500', JSON.stringify(w?.balance));

  const overview = await call('overview_get');
  check(!overview.isError && overview.data?.summary, 'overview_get', overview.text.slice(0, 300));
  const budget = await call('budgets_set', { month: '2026-11-01', category_id: groceries, target_minor: '60000' });
  check(!budget.isError, 'budgets_set (category target)', budget.text.slice(0, 200));
  const b = await call('budgets_get', { month: '2026-11-15' });
  check((b.data?.categories ?? []).some((c) => c.category_id === groceries && c.target?.amount_minor === '60000'), 'budgets_get shows the target', b.text.slice(0, 300));
  const rule = await call('rules_save', { pattern: 'FARMERS', category_id: groceries });
  check(!rule.isError, 'rules_save', rule.text.slice(0, 200));
  const preview = await call('rules_apply', { dry_run: true });
  check(!preview.isError, 'rules_apply dry run', preview.text.slice(0, 200));
  const note = await call('notes_save', { body: 'Check the insurance renewal' });
  check(!note.isError && note.data?.note_id, 'notes_save', note.text.slice(0, 200));
  const task = await call('tasks_save', { title: 'Call the bank', priority: 'high' });
  check(!task.isError, 'tasks_save', task.text.slice(0, 200));
  const voided = await call('transactions_void', { transaction_id: txn, reason: 'e2e cleanup' });
  check(!voided.isError, 'transactions_void (soft, reversed)', voided.text.slice(0, 200));
  const activity = await call('activity_list', { limit: 10 });
  check((activity.data?.activity ?? []).some((a) => a.by.kind === 'connected_app'), 'activity_list attributes to the connected app');
  const other = await call('accounts_get', { account_id: '00000000-0000-4000-8000-00000000b001' });
  check(other.isError, 'another household\'s id is not found');
}

// Every read tool answers without error on the seeded household.
for (const name of ['overview_get', 'accounts_list', 'transactions_list', 'transactions_summarize', 'categories_list', 'rules_list', 'budgets_get', 'recurring_list', 'goals_list', 'history_get', 'investments_get', 'paychecks_list', 'reimbursements_list', 'statements_list', 'notes_list', 'review_list', 'activity_list']) {
  const args = name === 'transactions_summarize' ? { group_by: 'month' } : name === 'history_get' ? { metric: 'net_worth' } : {};
  const r = await call(name, args);
  check(!r.isError, `read ${name}`, r.text.slice(0, 200));
}

// 8. Guards around the token
const rest = await fetch(`${API}/rest/v1/rpc/keel_list_categories`, { method: 'POST', headers: { apikey: ANON, authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ p_household_id: HOUSEHOLD }) });
check(rest.status === 403, 'app token straight to PostgREST (no gateway key) → refused', `${rest.status} ${(await rest.text()).slice(0, 120)}`);
const apiRes = await fetch(`${APP_API}/queries`, { method: 'POST', headers: { apikey: ANON, authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'categories.list', householdId: HOUSEHOLD }) });
check(apiRes.status === 403, 'app token on the app API → refused');
const sessionMcp = await mcp('tools/list', undefined, session.access_token);
check(sessionMcp.status === 401, 'a KEEL web-session token on /mcp → 401');
const webOk = await fetch(`${API}/rest/v1/rpc/keel_list_categories`, { method: 'POST', headers: userHeaders, body: JSON.stringify({ p_household_id: HOUSEHOLD }) });
check(webOk.status === 200, 'the user\'s own web session still reads PostgREST normally');

// 9. Refresh token works; revoke ends access
const refreshed = await json(await fetch(as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: reg.client_id }) }));
check(typeof refreshed.access_token === 'string', 'refresh token grants a new access token');
await fetch(`${APP_API}/connected-apps/revoke`, { method: 'POST', headers: userHeaders, body: JSON.stringify({ clientId: reg.client_id }) });
const afterRevoke = await mcp('tools/list', undefined, refreshed.access_token ?? token.access_token);
check(afterRevoke.status === 403, 'after KEEL revoke the app gets 403 at once (no 1 h wait)', JSON.stringify(afterRevoke.body).slice(0, 200));
const del = await fetch(`${API}/auth/v1/user/oauth/grants?client_id=${reg.client_id}`, { method: 'DELETE', headers: userHeaders });
const refreshAgain = await fetch(as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshed.refresh_token, client_id: reg.client_id }) });
check(del.status < 300 && refreshAgain.status >= 400, 'Supabase grant revoke kills the refresh token');

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
