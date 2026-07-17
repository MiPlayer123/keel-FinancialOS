/**
 * Purity gate — pure financial packages may not import Supabase, Next.js,
 * provider SDKs, or model SDKs (CLAUDE.md "Repo shape", INFRA boundary rule).
 *
 * Mechanical verifier in the build-harness style: deterministic, no LLM,
 * exits 0 silently on pass, prints one finding per line and exits 1 on fail.
 * Never edit this gate to make a build pass — it is the contract.
 *
 * Checks, per pure package:
 *   1. No source/test file imports a banned module (static, dynamic, or
 *      Deno `npm:` specifier).
 *   2. package.json declares no banned dependency.
 *
 * Usage: node scripts/harness/verify-purity.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

// packages/providers/* wrap provider SDKs by design and are excluded.
const PURE_PACKAGES = [
  'ai',
  'authz',
  'contracts',
  'detectors',
  'exports',
  'ingest',
  'ledger',
  'paychecks',
  'reconciliation',
  'reimbursements',
  'test-fixtures',
];

const BANNED = [
  { pattern: /^(npm:)?@supabase\//, label: 'Supabase SDK' },
  { pattern: /^(npm:)?next(\/|$)/, label: 'Next.js' },
  { pattern: /^(npm:)?react(-dom)?(\/|$)/, label: 'React (UI framework)' },
  { pattern: /^(npm:)?plaid(\/|$)/, label: 'Plaid SDK' },
  { pattern: /^(npm:)?@anthropic-ai\//, label: 'Anthropic SDK' },
  { pattern: /^(npm:)?openai(\/|$)/, label: 'OpenAI SDK' },
];

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.turbo') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) yield full;
  }
}

const findings = [];

for (const pkg of PURE_PACKAGES) {
  const root = join(REPO_ROOT, 'packages', pkg);
  if (!existsSync(root)) {
    findings.push(`packages/${pkg}: listed as pure but does not exist (update PURE_PACKAGES)`);
    continue;
  }

  const pkgJsonPath = join(root, 'package.json');
  if (existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    for (const depField of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const dep of Object.keys(pkgJson[depField] ?? {})) {
        const hit = BANNED.find((b) => b.pattern.test(dep));
        if (hit) {
          findings.push(`packages/${pkg}/package.json: ${depField} declares ${dep} (${hit.label})`);
        }
      }
    }
  }

  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec) continue;
      const hit = BANNED.find((b) => b.pattern.test(spec));
      if (hit) {
        const rel = file.slice(REPO_ROOT.length);
        findings.push(`${rel}: imports '${spec}' (${hit.label})`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error('verify-purity FAILED — pure packages must stay framework/SDK-free:');
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}
