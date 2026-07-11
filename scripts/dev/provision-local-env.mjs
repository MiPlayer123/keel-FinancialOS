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
import { generateKeyPairSync, randomBytes } from 'node:crypto';
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
let automationsSecret;
const existingSecret = functionsEnv.match(/^SUPABASE_SECRET_KEYS=\{"automations":"([^"]+)"\}$/m);
if (existingSecret) {
  automationsSecret = existingSecret[1];
} else {
  automationsSecret = `sb_secret_local_automations_${randomBytes(24).toString('hex')}`;
  functionsEnv = upsertLine(
    functionsEnv,
    'SUPABASE_SECRET_KEYS',
    `{"automations":"${automationsSecret}"}`,
  );
}

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
