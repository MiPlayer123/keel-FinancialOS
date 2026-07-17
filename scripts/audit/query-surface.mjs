#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const includeRoots = ['apps/web/src', 'supabase/functions'];
const ignoredDirs = new Set(['node_modules', '.next', 'dist', 'coverage', '.turbo']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(tsx?|mts|cts|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

function lineNumber(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function findAll(source, regex) {
  const rows = [];
  for (const match of source.matchAll(regex)) {
    rows.push({ value: match[1] ?? match[0], line: lineNumber(source, match.index ?? 0) });
  }
  return rows;
}

const files = includeRoots.flatMap((dir) => walk(join(root, dir)));
const inventory = [];

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const rel = relative(root, file);
  const hooks = [
    ...findAll(source, /useKeelQuery(?:Silent|Envelope)?(?:<[^>]+>)?\(\s*['"]([^'"]+)['"]/g),
  ];
  const directTables = findAll(source, /\.from\(\s*['"]([^'"]+)['"]\s*\)/g);
  const directRpcs = findAll(source, /\.rpc\(\s*['"]([^'"]+)['"]\s*(?:,|\))/g);
  const fetches = findAll(source, /\bfetch\(\s*`?['"]?([^'"`),]+)[^\n]*\)/g);

  for (const item of hooks)
    inventory.push({ kind: 'hook', name: item.value, file: rel, line: item.line });
  for (const item of directTables)
    inventory.push({ kind: 'table', name: item.value, file: rel, line: item.line });
  for (const item of directRpcs)
    inventory.push({ kind: 'rpc', name: item.value, file: rel, line: item.line });
  for (const item of fetches)
    inventory.push({ kind: 'fetch', name: item.value, file: rel, line: item.line });
}

const byKind = new Map();
for (const row of inventory) {
  const list = byKind.get(row.kind) ?? [];
  list.push(row);
  byKind.set(row.kind, list);
}

console.log('# KEEL query surface inventory');
console.log('');
console.log(`Scanned ${files.length} source files under ${includeRoots.join(', ')}.`);
console.log('');
for (const kind of ['hook', 'rpc', 'table', 'fetch']) {
  const rows = byKind.get(kind) ?? [];
  console.log(`## ${kind} (${rows.length})`);
  console.log('');
  const grouped = Map.groupBy(rows, (row) => row.name);
  for (const [name, hits] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const refs = hits
      .map((hit) => `${hit.file}:${hit.line}`)
      .sort((a, b) => a.localeCompare(b))
      .join(', ');
    console.log(`- ${name} — ${hits.length} hit${hits.length === 1 ? '' : 's'} (${refs})`);
  }
  console.log('');
}
