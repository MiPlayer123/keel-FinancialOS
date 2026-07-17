/**
 * TASK-000 test 12 (in-repo half; stage-exit Finding 6): no privileged secret
 * pattern appears in any git-tracked file. CI also runs gitleaks + a built-
 * bundle scan; this makes the guarantee runnable in the normal test gate too.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

// Value patterns for real secrets — NOT variable NAMES (env templates
// legitimately contain `PLAID_SECRET=` with an empty value).
const SECRET_VALUE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'supabase secret key', re: /sb_secret_[A-Za-z0-9_-]{10,}/ },
  { label: 'plaid secret value', re: /PLAID_SECRET=['"]?[A-Za-z0-9]{16,}/ },
  { label: 'plaid client id value', re: /PLAID_CLIENT_ID=['"]?[a-f0-9]{20,}/ },
  { label: 'supabase access token', re: /sbp_[a-f0-9]{40}/ },
  { label: 'private key block', re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
];

const trackedFiles = (): string[] =>
  execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

describe('secret boundary (Law 12) — no secret value in tracked files', () => {
  it('git is available and tracks files', () => {
    expect(trackedFiles().length).toBeGreaterThan(20);
  });

  // 30s: this walks every tracked file; the default 5s flaked repeatedly
  // under parallel CI/build load (it always passes alone — pure I/O breadth).
  it('scans every tracked text file and finds no secret value', { timeout: 30_000 }, () => {
    const offenders: string[] = [];
    for (const rel of trackedFiles()) {
      // This test file itself contains the patterns; skip it.
      if (rel.endsWith('secret-scan.test.ts')) continue;
      let content: string;
      try {
        content = readFileSync(join(REPO_ROOT, rel), 'utf8');
      } catch {
        continue; // deleted or binary
      }
      for (const { label, re } of SECRET_VALUE_PATTERNS) {
        if (re.test(content)) offenders.push(`${rel}: ${label}`);
      }
    }
    expect(offenders, `secret values in tracked files:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('ignored env files are not tracked', () => {
    const tracked = new Set(trackedFiles());
    for (const f of [
      'supabase/functions/.env',
      'supabase/.env.remote',
      'apps/web/.env.local',
      '.env.local-automations',
    ]) {
      expect(tracked.has(f), `${f} must not be tracked`).toBe(false);
    }
  });
});
