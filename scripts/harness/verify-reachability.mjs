/**
 * UI-reachability census — every route the `api` Edge Function serves must be
 * invoked from somewhere in apps/web, and every web invocation must hit a real
 * route. Conservation check in the build-harness style: backend capability
 * that no UI surface can reach is a silent gap (see NOTES.md: "the 1D command
 * procs are live but unreachable from the UI"), and a web call to a
 * nonexistent route is a latent 404.
 *
 * Routes that are intentionally UI-invisible (worker-, cron-, or MCP-only)
 * live in reachability-allowlist.json with a reason each. Additions to the
 * allowlist are reviewed like code — the gate exists to make "unreachable"
 * an explicit decision, never an accident.
 *
 * Exits 0 silently on pass; prints one finding per line and exits 1 on fail.
 *
 * Usage: node scripts/harness/verify-reachability.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

const API_SOURCE = join(REPO_ROOT, 'supabase/functions/api/index.ts');
const WEB_ROOT = join(REPO_ROOT, 'apps/web/src');
const ALLOWLIST_PATH = new URL('./reachability-allowlist.json', import.meta.url).pathname;

const ROUTE_RE = /path === '(\/[a-z0-9/_-]+)'/g;
// Matches invoke('api/x'), invoke<T>('api/x'), and functions.invoke variants.
const INVOKE_RE = /invoke(?:<[^>]*>)?\(\s*[`'"]api(\/[a-z0-9/_-]+)/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(name)) yield full;
  }
}

const apiText = readFileSync(API_SOURCE, 'utf8');
const routes = new Set([...apiText.matchAll(ROUTE_RE)].map((m) => m[1]));

const invocations = new Set();
for (const file of walk(WEB_ROOT)) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(INVOKE_RE)) invocations.add(match[1]);
}

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
const allowed = new Set(Object.keys(allowlist.routes ?? {}));

const findings = [];

for (const route of [...routes].sort()) {
  if (!invocations.has(route) && !allowed.has(route)) {
    findings.push(
      `unreachable: api route '${route}' is served but never invoked from apps/web ` +
        `(wire it into the UI, or allowlist it with a reason)`,
    );
  }
}

for (const call of [...invocations].sort()) {
  if (!routes.has(call)) {
    findings.push(`dangling: apps/web invokes 'api${call}' but the api function serves no such route`);
  }
}

for (const route of allowed) {
  if (!routes.has(route)) {
    findings.push(`stale allowlist: '${route}' no longer exists in the api function — remove it`);
  }
  if (invocations.has(route)) {
    findings.push(`stale allowlist: '${route}' is now invoked from apps/web — remove it from the allowlist`);
  }
}

if (routes.size === 0) {
  findings.push('parse failure: extracted 0 routes from the api function — route regex needs updating');
}

if (findings.length > 0) {
  console.error(
    `verify-reachability FAILED (${routes.size} routes, ${invocations.size} invocations):`,
  );
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}
