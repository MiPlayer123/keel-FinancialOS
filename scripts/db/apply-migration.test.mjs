// Run: node --test scripts/db/apply-migration.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateNames } from './apply-migration.mjs';

const present = new Set(['20260828010000_onboarding_bootstrap.sql']);
const exists = (n) => present.has(n);

test('a real migration file name passes', () => {
  assert.deepEqual(validateNames(['20260828010000_onboarding_bootstrap.sql'], exists), []);
});

test('nothing to apply is an error', () => {
  assert.equal(validateNames([], exists).length, 1);
});

test('paths and shell text are rejected before anything runs', () => {
  for (const bad of ['../secrets.sql', 'x.sql; rm -rf /', '20260828010000_onboarding_bootstrap', 'supabase/migrations/20260828010000_onboarding_bootstrap.sql']) {
    assert.ok(validateNames([bad], exists).length > 0, bad);
  }
});

test('a well-formed name that does not exist is rejected', () => {
  assert.match(validateNames(['20990101000000_nope.sql'], exists).join(), /not found/);
});

test('the same file twice is rejected', () => {
  const n = '20260828010000_onboarding_bootstrap.sql';
  assert.match(validateNames([n, n], exists).join(), /listed twice/);
});
