// Run: node --test scripts/db/live-drift.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CATALOG_SQL, diffCatalogs, formatReport } from './live-drift.mjs';

const fn = (key, fp = 'a') => ({ kind: 'function', key, fp });

test('an identical catalog has no drift', () => {
  const objs = [fn('public.keel_x(uuid)'), { kind: 'table', key: 'public.households', fp: 'r' }];
  assert.deepEqual(diffCatalogs(objs, objs), { missing: [], differs: [] });
});

test('a function the migrations define but live lacks is missing (the PR #178 case)', () => {
  const expected = [fn('public.keel_bootstrap_household(p_user_id uuid, p_household_name text)')];
  const { missing, differs } = diffCatalogs(expected, []);
  assert.equal(missing.length, 1);
  assert.equal(differs.length, 0);
});

test('a function whose body changed is reported as different, not missing', () => {
  const { missing, differs } = diffCatalogs([fn('public.keel_goal_save(uuid)', 'new')], [fn('public.keel_goal_save(uuid)', 'old')]);
  assert.equal(missing.length, 0);
  assert.deepEqual(differs, [fn('public.keel_goal_save(uuid)', 'new')]);
});

test('objects that exist only on live are ignored', () => {
  const live = [fn('public.keel_x(uuid)'), fn('public.dashboard_helper()')];
  assert.deepEqual(diffCatalogs([fn('public.keel_x(uuid)')], live), { missing: [], differs: [] });
});

test('the same name under a different kind does not count as present', () => {
  const { missing } = diffCatalogs([{ kind: 'table', key: 'public.x', fp: 'r' }], [{ kind: 'enum', key: 'public.x', fp: 'r' }]);
  assert.equal(missing.length, 1);
});

test('the report names every missing object and says how to fix it', () => {
  const report = formatReport(
    { missing: [fn('public.keel_bootstrap_household(uuid, text)')], differs: [fn('public.keel_goal_save(uuid)')] },
    { expectedCount: 2, liveCount: 1 },
  );
  assert.match(report, /1 missing, 1 with a different definition/);
  assert.match(report, /keel_bootstrap_household/);
  assert.match(report, /keel_goal_save/);
  assert.match(report, /apply-migration/);
});

test('a clean report says production matches', () => {
  assert.match(formatReport({ missing: [], differs: [] }, { expectedCount: 5, liveCount: 9 }), /matches the migrations/);
});

test('the catalog query skips Supabase-managed schemas and extension objects', () => {
  for (const schema of ['auth', 'storage', 'extensions', 'supabase_migrations']) {
    assert.ok(CATALOG_SQL.includes(`'${schema}'`), schema);
  }
  assert.match(CATALOG_SQL, /deptype = 'e'/);
});
