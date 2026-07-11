/**
 * Idempotent local environment provisioner (PLAN §3.6.5). Creates the
 * git-ignored env files a clean checkout needs:
 *   - supabase/functions/.env   server-only function env: simulator/fixture
 *                               defaults + generated named automations secret
 *                               + generated webhook-verification PUBLIC JWK
 *   - .env.local-automations    test-side references: the automations secret
 *                               and the webhook-verification PRIVATE JWK
 *
 * All generated values are LOCAL-ONLY randoms — legitimate local
 * provisioning; cloud secrets remain human checkpoints (⚑). Never writes
 * tracked files; never prints secret values.
 */
import { execSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const functionsEnvPath = join(root, 'supabase', 'functions', '.env');
const examplePath = join(root, 'supabase', 'functions', '.env.example');
const testRefPath = join(root, '.env.local-automations');

let functionsEnv = existsSync(functionsEnvPath)
  ? readFileSync(functionsEnvPath, 'utf8')
  : readFileSync(examplePath, 'utf8');

const upsertLine = (content, key, value) => {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(content) ? content.replace(re, line) : `${content.trimEnd()}\n${line}\n`;
};

// 1. Named automations secret (worker/scheduled `secret:automations`).
// Named secret keys must be PLATFORM-ISSUED keys (the admin client
// authenticates with the matched key), so locally we alias the running
// stack's own secret key under the 'automations' name. Cloud gets a real
// named key via the human checkpoint.
let automationsSecret;
try {
  const status = execSync('supabase status -o env', { cwd: root, encoding: 'utf8' });
  automationsSecret = status.match(/^SECRET_KEY="?(sb_secret_[^"\n]+)"?$/m)?.[1];
} catch {
  automationsSecret = undefined;
}
if (!automationsSecret) {
  console.error('supabase stack not running - run `supabase start` before provisioning.');
  process.exit(1);
}
functionsEnv = upsertLine(
  functionsEnv,
  'KEEL_SUPABASE_SECRET_KEYS',
  `{"automations":"${automationsSecret}"}`,
);

// 2. Webhook-verification ES256 keypair: PUBLIC JWK to the functions env
//    (verifier), PRIVATE JWK to the test reference file (signer).
let privateJwkJson;
const existingJwk = functionsEnv.match(/^PLAID_WEBHOOK_JWK=(\{.*\})$/m);
const testRef = existsSync(testRefPath) ? readFileSync(testRefPath, 'utf8') : '';
const existingPriv = testRef.match(/^KEEL_WEBHOOK_TEST_PRIVATE_JWK=(\{.*\})$/m);
if (existingJwk && existingPriv) {
  privateJwkJson = existingPriv[1];
} else {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  functionsEnv = upsertLine(functionsEnv, 'PLAID_WEBHOOK_JWK', JSON.stringify(pub));
  privateJwkJson = JSON.stringify(priv);
}

writeFileSync(functionsEnvPath, functionsEnv);
writeFileSync(
  testRefPath,
  `KEEL_LOCAL_AUTOMATIONS_SECRET=${automationsSecret}\n` +
    `KEEL_WEBHOOK_TEST_PRIVATE_JWK=${privateJwkJson}\n`,
);

console.log(`provisioned: ${functionsEnvPath}`);
console.log(`test reference written: ${testRefPath}`);
