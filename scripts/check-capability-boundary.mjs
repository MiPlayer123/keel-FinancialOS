/**
 * Capability-boundary gate (CLAUDE.md Law 1/5; statement-ingestion-v2 §1 [A1]).
 *
 * The statement parsers and extraction-core are PURE: bytes in, typed records
 * out. They must never reference Supabase, a Supabase client, `.rpc(`, `.from(`,
 * `.storage`, `fetch(`, or `@supabase`. Only the typed IO port (a worker-side
 * file, not covered here) may touch those. This mechanical gate FAILS the build
 * if any covered file names a forbidden capability — closing the door on a
 * future edit that quietly hands a parser network or database reach.
 *
 * Deterministic, no LLM. Exits 0 silently on pass; prints one finding per line
 * and exits 1 on fail. Never edit this gate to make a build pass — it is the
 * contract. A golden-negative test (statement-capability-boundary.test.ts)
 * asserts it fires on a planted violation.
 *
 * Usage:
 *   node scripts/check-capability-boundary.mjs            # scan the repo
 *   node scripts/check-capability-boundary.mjs <file...>  # scan given files
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

/**
 * Directories/globs whose every source file must stay capability-clean. Add new
 * pure parser/extraction-core locations here as they land.
 */
const COVERED_DIRS = ['packages/documents/src/statement'];

/**
 * Additional single-file coverage by name pattern anywhere under packages/*:
 * matcher files and extraction-core carry the same purity contract.
 */
const COVERED_FILE_RE = /(?:matcher|extraction-core)\.[cm]?tsx?$/;
const COVERED_FILE_ROOTS = ['packages'];

/** Forbidden capability references (Law 1/5). Ordered for readable findings. */
const FORBIDDEN = [
  { re: /@supabase\b/, label: "imports '@supabase'" },
  { re: /\bcreateClient\s*\(/, label: 'calls createClient(' },
  { re: /\bsupabase\b/, label: "references 'supabase'" },
  { re: /\.rpc\s*\(/, label: 'calls .rpc(' },
  { re: /\.from\s*\(/, label: 'calls .from(' },
  { re: /\.storage\b/, label: 'references .storage' },
  { re: /\bfetch\s*\(/, label: 'calls fetch(' },
];

const SOURCE_RE = /\.[cm]?tsx?$/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.turbo') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SOURCE_RE.test(name)) yield full;
  }
}

/** Collect the set of files the gate covers. */
function coveredFiles() {
  const files = new Set();
  for (const d of COVERED_DIRS) {
    const abs = join(REPO_ROOT, d);
    if (existsSync(abs)) for (const f of walk(abs)) files.add(f);
  }
  for (const rootRel of COVERED_FILE_ROOTS) {
    const abs = join(REPO_ROOT, rootRel);
    if (!existsSync(abs)) continue;
    for (const f of walk(abs)) {
      if (COVERED_FILE_RE.test(f)) files.add(f);
    }
  }
  return files;
}

/** Scan a single file's text; return an array of finding strings. */
export function scanText(rel, text) {
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Skip line comments so documentation of the ban does not trip the gate.
    const codePart = line.replace(/\/\/.*$/, '');
    for (const f of FORBIDDEN) {
      if (f.re.test(codePart)) {
        findings.push(`${rel}:${i + 1}: ${f.label}`);
      }
    }
  }
  return findings;
}

function main() {
  const argv = process.argv.slice(2);
  const targets =
    argv.length > 0
      ? argv.map((a) => (isAbsolute(a) ? a : resolve(process.cwd(), a)))
      : [...coveredFiles()];

  const findings = [];
  for (const file of targets) {
    if (!existsSync(file)) {
      findings.push(`${file}: file not found`);
      continue;
    }
    const rel = relative(REPO_ROOT, file);
    findings.push(...scanText(rel, readFileSync(file, 'utf8')));
  }

  if (findings.length > 0) {
    console.error('check-capability-boundary FAILED — pure parsers must not reach IO:');
    for (const f of findings) console.error(`  - ${f}`);
    process.exit(1);
  }
}

// Only run when invoked directly, so the test can import `scanText`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
