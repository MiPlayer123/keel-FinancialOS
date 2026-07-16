/**
 * Frozen-test gate — the anti-overfit contract for slice builds.
 *
 * A slice's test suite is authored and committed BEFORE implementation
 * (docs/harness/README.md, phase "freeze tests"). The implementer's goal is
 * "suite green with tests byte-identical to the frozen commit" — this script
 * checks the byte-identical half. A genuinely-wrong test is fixed by
 * cascading back to the test phase (new baseline commit recorded in the
 * slice doc), never by editing tests during implementation.
 *
 * Test surface = any file matching *.test.ts(x) plus everything under
 * supabase/tests/ and tests/.
 *
 * Exits 0 silently when no test file changed since the baseline; prints the
 * changed files and exits 1 otherwise.
 *
 * Usage: node scripts/harness/verify-frozen-tests.mjs --baseline <commit>
 */
import { execFileSync } from 'node:child_process';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

const args = process.argv.slice(2);
const baselineIdx = args.indexOf('--baseline');
if (baselineIdx === -1 || !args[baselineIdx + 1]) {
  console.error('usage: node scripts/harness/verify-frozen-tests.mjs --baseline <commit>');
  process.exit(2);
}
const baseline = args[baselineIdx + 1];

const TEST_FILE_RE = /(\.test\.tsx?$|^supabase\/tests\/|^tests\/)/;

let diff;
try {
  diff = execFileSync('git', ['diff', '--name-only', baseline, 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
} catch (err) {
  console.error(`verify-frozen-tests: git diff against '${baseline}' failed: ${err.message}`);
  process.exit(2);
}

const changed = diff
  .split('\n')
  .filter(Boolean)
  .filter((f) => TEST_FILE_RE.test(f));

if (changed.length > 0) {
  console.error(
    `verify-frozen-tests FAILED — ${changed.length} test file(s) changed since frozen baseline ${baseline}:`,
  );
  for (const f of changed) console.error(`  - ${f}`);
  console.error(
    'Tests are the contract. If a test is genuinely wrong, cascade the fix to the test phase and record a new baseline in the slice doc — do not edit tests to make implementation pass.',
  );
  process.exit(1);
}
