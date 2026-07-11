/**
 * Idempotent local environment provisioner (PLAN §3.6.5). Creates the
 * git-ignored env files a clean checkout needs:
 *   - supabase/functions/.env       (server-only; simulator/fixture defaults)
 *   - .env.local-automations        (the generated named automations secret,
 *                                    for tests to authenticate to worker/scheduled)
 *
 * The automations secret is a LOCAL-ONLY random value — legitimate local
 * provisioning; the cloud named secret key remains a human checkpoint (⚑).
 * Never writes to tracked files; never prints secret values.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const functionsEnvPath = join(root, 'supabase', 'functions', '.env');
const examplePath = join(root, 'supabase', 'functions', '.env.example');
const secretRefPath = join(root, '.env.local-automations');

let functionsEnv = existsSync(functionsEnvPath)
  ? readFileSync(functionsEnvPath, 'utf8')
  : readFileSync(examplePath, 'utf8');

let secret;
const existing = functionsEnv.match(/^SUPABASE_SECRET_KEYS=\{"automations":"([^"]+)"\}$/m);
if (existing) {
  secret = existing[1];
} else {
  secret = `sb_secret_local_automations_${randomBytes(24).toString('hex')}`;
  functionsEnv = `${functionsEnv.trimEnd()}\nSUPABASE_SECRET_KEYS={"automations":"${secret}"}\n`;
  writeFileSync(functionsEnvPath, functionsEnv);
}

writeFileSync(secretRefPath, `KEEL_LOCAL_AUTOMATIONS_SECRET=${secret}\n`);

console.log(`provisioned: ${functionsEnvPath} (automations secret ${existing ? 'kept' : 'generated'})`);
console.log(`test reference written: ${secretRefPath}`);
