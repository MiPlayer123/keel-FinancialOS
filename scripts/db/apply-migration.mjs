#!/usr/bin/env node
// Apply named migration files from supabase/migrations to the live project,
// in the order given, through the Supabase Management API.
//
// This is the one-step path for the gap live-drift.mjs reports: a migration
// that merged but never reached production. It is run by the manual
// `apply-migration` workflow, never automatically, because some older
// migrations are not safe to re-run (CREATE POLICY, renames).
//
// Usage:
//   node scripts/db/apply-migration.mjs --project-ref <ref> <file.sql> [<file.sql> ...]
// Env: SUPABASE_ACCESS_TOKEN.
//
// Each file is applied as one request and stops the run on the first error,
// so later files never land on top of a failed one.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIGRATIONS_DIR = 'supabase/migrations';
const NAME = /^\d{14}_[a-z0-9_]+\.sql$/;

/** Validate requested names: well formed, present, no duplicates. Pure. */
export function validateNames(names, exists) {
  const problems = [];
  if (names.length === 0) problems.push('no migration files given');
  const seen = new Set();
  for (const name of names) {
    if (!NAME.test(name)) problems.push(`${name}: not a migration file name (expected 20260828010000_name.sql)`);
    else if (!exists(name)) problems.push(`${name}: not found in ${MIGRATIONS_DIR}`);
    if (seen.has(name)) problems.push(`${name}: listed twice`);
    seen.add(name);
  }
  return problems;
}

async function apply(projectRef, token, name, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/migrations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.replace(/\.sql$/, ''), query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name}: Supabase returned ${String(res.status)}: ${text.slice(0, 500)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const refIndex = args.indexOf('--project-ref');
  const projectRef = refIndex === -1 ? undefined : args[refIndex + 1];
  const names = args.filter((_, i) => i !== refIndex && i !== refIndex + 1);
  const token = process.env.SUPABASE_ACCESS_TOKEN;

  if (!projectRef) throw new Error('--project-ref is required');
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is not set');
  const problems = validateNames(names, (n) => existsSync(join(MIGRATIONS_DIR, n)));
  if (problems.length > 0) throw new Error(problems.join('; '));

  for (const name of names) {
    await apply(projectRef, token, name, readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
    console.log(`applied ${name}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
