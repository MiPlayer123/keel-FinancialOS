/**
 * Capability-boundary gate tests (Law 1/5). Asserts the real statement parser
 * sources are capability-clean AND that the gate FIRES on a planted violation
 * (golden-negative) — proving the check is not vacuous. Also a structural
 * no-IO-import assertion over the statement/*.ts sources.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText } from '../../../scripts/check-capability-boundary.mjs';

const STMT_DIR = fileURLToPath(new URL('../src/statement', import.meta.url));

const statementSources = readdirSync(STMT_DIR)
  .filter((f) => /\.ts$/.test(f))
  .map((f) => ({ name: f, text: readFileSync(join(STMT_DIR, f), 'utf8') }));

describe('capability boundary: real sources are clean', () => {
  it.each(statementSources.map((s) => s.name))('%s has no forbidden capability', (name) => {
    const src = statementSources.find((s) => s.name === name)!;
    expect(scanText(`statement/${name}`, src.text)).toEqual([]);
  });

  it('statement sources import no IO module (no supabase/fetch/rpc/from/storage)', () => {
    for (const { text } of statementSources) {
      // Import specifiers only reference sibling ./*.js modules or nothing.
      // Match only real import/export-from statements (line-anchored), not the
      // English word "from" inside a JSDoc sentence.
      const importSpecs = [
        ...text.matchAll(/^\s*(?:import|export)\b[^'"\n]*?\bfrom\s+['"]([^'"]+)['"]/gm),
      ].map((m) => m[1]!);
      for (const spec of importSpecs) {
        expect(spec.startsWith('./')).toBe(true);
      }
    }
  });
});

describe('capability boundary: golden-negative (the gate is not vacuous)', () => {
  it('fires on a planted .from( call', () => {
    const planted = 'const rows = await admin.from("statements").select();';
    const findings = scanText('planted.ts', planted);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join('\n')).toContain('.from(');
  });

  it('fires on a planted fetch( and createClient(', () => {
    expect(scanText('p.ts', 'fetch("https://x")').length).toBeGreaterThan(0);
    expect(scanText('p.ts', 'const c = createClient(url, key);').length).toBeGreaterThan(0);
    expect(scanText('p.ts', 'import { x } from "@supabase/supabase-js";').length).toBeGreaterThan(0);
    expect(scanText('p.ts', 'const s = supabase.storage.from("b");').length).toBeGreaterThan(0);
  });

  it('does NOT fire on a comment documenting the ban', () => {
    expect(scanText('p.ts', '// never call .rpc( or fetch( here')).toEqual([]);
  });
});
