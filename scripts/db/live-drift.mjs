#!/usr/bin/env node
// Live schema drift check: does production actually contain what
// supabase/migrations says it should?
//
// Why this exists: migrations reach the live project by hand (CLAUDE.md "Ops
// facts"), and the Supabase GitHub integration only runs branch previews; it
// never applies to production. So a merged migration that nobody applied is
// invisible. That is what happened to PR #178: its five migrations merged on
// 2026-08-28 and none reached production. keel_bootstrap_household was among
// them, so every account created afterwards got no household and no
// "Connect a bank" button, with nothing anywhere saying why.
//
// How it works: CI resets a local stack from the migrations, which gives the
// expected catalog. The live catalog comes from the Supabase Management API.
// Every function, table, column, trigger, RLS policy and enum the migrations
// define must exist on live with the same definition. Objects that exist only
// on live are ignored (dashboard-created helpers, extensions, archives).
//
// Usage:
//   node scripts/db/live-drift.mjs --local-db <postgres url> --project-ref <ref>
// Env: SUPABASE_ACCESS_TOKEN (a Supabase personal access token). Read-only:
// the script only runs the SELECT below on each side.

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Schemas that are not compared. Most are owned by Supabase or extensions.
// keel_archive holds one-off before-images and plans written by data
// migrations (e.g. the 2026-08-31 snapshot compaction); they are meant to be
// dropped once no longer needed, so their absence on live is not drift.
export const SKIPPED_SCHEMAS = [
  'keel_archive',
  'information_schema',
  'auth',
  'storage',
  'realtime',
  '_realtime',
  'extensions',
  'graphql',
  'graphql_public',
  'pgsodium',
  'pgsodium_masks',
  'vault',
  'supabase_functions',
  'supabase_migrations',
  'net',
  'cron',
  'pgmq',
  'pgbouncer',
  '_analytics',
  '_supavisor',
  'pgtle',
  'repack',
];

const OWNER_SQL = `case when pg_get_userbyid(p.proowner) in ('postgres', 'supabase_admin') then 'postgres'
                     else pg_get_userbyid(p.proowner) end`;

// One row, one column: a JSON array of {kind, key, fp}. `key` names the
// object; `fp` (fingerprint) changes when its definition changes.
//
// search_path is pinned first because trigger, policy and type text is printed
// relative to it; pinning makes both sides print fully qualified names. Owners
// postgres and supabase_admin are treated as one, since which of the two runs
// a migration depends on the tool, not the schema. keel_api and keel_worker
// ownership still counts: it decides what a SECURITY DEFINER function can do.
export const CATALOG_SQL = `
set search_path = pg_catalog;
with schemas as (
  select n.oid, n.nspname
    from pg_namespace n
   where n.nspname not like 'pg\\_%' escape '\\'
     and n.nspname not in (${SKIPPED_SCHEMAS.map((s) => `'${s}'`).join(', ')})
),
ext_objs as (
  select objid from pg_depend where deptype = 'e'
),
objs as (
  select 'function' as kind,
         s.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as key,
         md5(p.prosrc || '|' || p.prosecdef::text || '|' || ${OWNER_SQL}
             || '|' || coalesce(array_to_string(p.proconfig, ','), '')) as fp
    from pg_proc p
    join schemas s on s.oid = p.pronamespace
   where p.oid not in (select objid from ext_objs)
  union all
  select 'table',
         s.nspname || '.' || c.relname,
         c.relkind::text
    from pg_class c
    join schemas s on s.oid = c.relnamespace
   where c.relkind in ('r', 'p', 'v', 'm')
     and c.oid not in (select objid from ext_objs)
  union all
  select 'column',
         s.nspname || '.' || c.relname || '.' || a.attname,
         format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join schemas s on s.oid = c.relnamespace
   where c.relkind in ('r', 'p')
     and a.attnum > 0
     and not a.attisdropped
     and c.oid not in (select objid from ext_objs)
  union all
  select 'trigger',
         s.nspname || '.' || c.relname || '.' || t.tgname,
         md5(pg_get_triggerdef(t.oid))
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join schemas s on s.oid = c.relnamespace
   where not t.tgisinternal
  union all
  select 'policy',
         p.schemaname || '.' || p.tablename || '.' || p.policyname,
         md5(p.cmd || '|' || array_to_string(p.roles, ',') || '|'
             || coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''))
    from pg_policies p
   where p.schemaname in (select nspname from schemas)
  union all
  select 'enum',
         s.nspname || '.' || t.typname,
         string_agg(e.enumlabel, ',' order by e.enumsortorder)
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    join schemas s on s.oid = t.typnamespace
   group by s.nspname, t.typname
)
select coalesce(json_agg(json_build_object('kind', kind, 'key', key, 'fp', fp) order by kind, key), '[]'::json)
  from objs;
`;

/**
 * For functions that differ: the exact text their fingerprint is built from
 * (owner, SECURITY DEFINER, SET options, body), so the report can show a diff
 * of what is actually different instead of only a name.
 */
export function functionDefsSql(keys) {
  const list = keys.map((k) => `'${k.replaceAll("'", "''")}'`).join(', ');
  return `
set search_path = pg_catalog;
select coalesce(json_object_agg(key, def), '{}'::json)
  from (
    select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as key,
           '-- owner: ' || ${OWNER_SQL}
           || E'\n-- security definer: ' || p.prosecdef::text
           || E'\n-- set: ' || coalesce(array_to_string(p.proconfig, ', '), '(none)')
           || E'\n' || p.prosrc as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
  ) f
 where key in (${list});
`;
}

/** Unified diff of two texts via diff(1); '' when identical. */
export function unifiedDiff(expected, live, label) {
  const dir = mkdtempSync(join(tmpdir(), 'keel-drift-'));
  const a = join(dir, 'expected');
  const b = join(dir, 'live');
  writeFileSync(a, `${expected}\n`);
  writeFileSync(b, `${live}\n`);
  try {
    execFileSync('diff', ['-u', '--label', `${label} (migrations)`, '--label', `${label} (production)`, a, b], {
      encoding: 'utf8',
    });
    return '';
  } catch (err) {
    // diff exits 1 when the files differ; its output is the diff.
    if (err && typeof err === 'object' && 'status' in err && err.status === 1) return String(err.stdout);
    throw err;
  }
}

/**
 * Compare the catalog the migrations produce (expected) with production
 * (actual). Pure, so it is unit-tested without a database.
 * Returns objects missing on live, and objects whose definition differs.
 */
export function diffCatalogs(expected, actual) {
  const live = new Map(actual.map((o) => [`${o.kind} ${o.key}`, o.fp]));
  const missing = [];
  const differs = [];
  for (const o of expected) {
    const id = `${o.kind} ${o.key}`;
    if (!live.has(id)) missing.push(o);
    else if (live.get(id) !== o.fp) differs.push(o);
  }
  return { missing, differs };
}

/**
 * Markdown report for the job summary. Missing objects are listed in full
 * because they are the actionable part; the fix is to apply the migration
 * that defines each one.
 */
export function formatReport({ missing, differs }, { expectedCount, liveCount, diffs = {} }) {
  const lines = ['## Live schema drift', ''];
  if (missing.length === 0 && differs.length === 0) {
    lines.push(
      `Production matches the migrations: all ${expectedCount} objects they define are live and identical (live has ${liveCount} in total).`,
    );
    return lines.join('\n');
  }
  lines.push(
    `Production does not match \`supabase/migrations\`: ${missing.length} missing, ${differs.length} with a different definition.`,
    '',
    'A merged migration has not been applied to the live project. Apply it (CLAUDE.md "Ops facts", or the `apply-migration` workflow), then re-run this check.',
    'Search `supabase/migrations` for an object name below to find the migration that defines it.',
    '',
  );
  const section = (title, list) => {
    if (list.length === 0) return;
    lines.push(`### ${title} (${list.length})`, '');
    for (const o of list.slice(0, 200)) lines.push(`- ${o.kind} \`${o.key}\``);
    if (list.length > 200) lines.push(`- ...and ${list.length - 200} more`);
    lines.push('');
  };
  section('Missing on live', missing);
  section('Different on live', differs);
  const shown = differs.filter((o) => diffs[o.key]);
  if (shown.length > 0) {
    lines.push('### What differs', '', 'Lines starting `-` are what the migrations define; `+` is what production runs.', '');
    for (const o of shown) {
      const body = diffs[o.key].split('\n');
      const clipped = body.length > 300 ? [...body.slice(0, 300), `... (${String(body.length - 300)} more lines)`] : body;
      lines.push(`<details><summary><code>${o.key}</code></summary>`, '', '```diff', ...clipped, '```', '', '</details>', '');
    }
  }
  return lines.join('\n');
}

function readLocal(dbUrl, sql = CATALOG_SQL) {
  const out = execFileSync('psql', [dbUrl, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(out);
}

async function readLive(projectRef, token, sql = CATALOG_SQL) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Supabase Management API returned ${String(res.status)} (${text.slice(0, 200)}). ` +
        'If it says "Invalid access token", the SUPABASE_ACCESS_TOKEN repository secret has expired or been revoked: create a new one under Supabase dashboard > Account > Access Tokens and update the secret. Function deploys use the same secret.',
    );
  }
  const rows = JSON.parse(text);
  const cell = rows[0] ? Object.values(rows[0])[0] : [];
  return typeof cell === 'string' ? JSON.parse(cell) : cell;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const localDb = arg('--local-db');
  const projectRef = arg('--project-ref');
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!localDb || !projectRef) {
    console.error('usage: live-drift.mjs --local-db <postgres url> --project-ref <ref>');
    process.exit(2);
  }
  if (!token) {
    console.error('::error::SUPABASE_ACCESS_TOKEN is not set, so production cannot be checked.');
    process.exit(1);
  }

  const expected = readLocal(localDb);
  const actual = await readLive(projectRef, token);
  // An empty side means the query failed, not that the schema is empty.
  // Reporting every object as missing would bury the real cause.
  if (expected.length === 0 || actual.length === 0) {
    throw new Error(
      `The catalog query returned nothing from ${expected.length === 0 ? 'the local database' : 'production'}; cannot compare.`,
    );
  }
  const result = diffCatalogs(expected, actual);

  const diffs = {};
  const changedFns = result.differs.filter((o) => o.kind === 'function').map((o) => o.key);
  if (changedFns.length > 0) {
    const sql = functionDefsSql(changedFns);
    const localDefs = readLocal(localDb, sql);
    const liveDefs = await readLive(projectRef, token, sql);
    for (const key of changedFns) {
      diffs[key] = unifiedDiff(localDefs[key] ?? '', liveDefs[key] ?? '', key);
    }
  }

  const report = formatReport(result, { expectedCount: expected.length, liveCount: actual.length, diffs });

  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

  if (result.missing.length > 0 || result.differs.length > 0) {
    console.error(
      `::error::Production is missing ${String(result.missing.length)} and differs on ${String(result.differs.length)} objects defined in supabase/migrations. See the job summary.`,
    );
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
