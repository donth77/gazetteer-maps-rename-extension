import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, validateRules } from '../../src/core/rules.ts';
import { createMatcher } from '../../src/core/engine.ts';
import { createLineMatcher, deriveLineRule } from '../../src/core/lines.ts';

/**
 * The place-taxonomy fixture: one rule per category of thing on a map, all
 * exercised against live Maps on 2026-08-30 (country, territory, state, city,
 * town, street, landmark, store — every category rewrote on the map surface
 * and in page text). These tests keep the fixture compiling and matching.
 */
const load = async () =>
  (await import('../fixtures/taxonomy.json', { with: { type: 'json' } })).default;

test('taxonomy fixture is valid config', async () => {
  const res = validateRules({ rules: await load() });
  assert.equal(res.ok, true, res.ok ? '' : res.error);
});

test('every taxonomy rule substitutes through the engine', async () => {
  const res = validateRules({ rules: await load() });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const subs = compile(res.rules, 'en');
  const matcher = createMatcher(subs);
  for (const rule of res.rules) {
    for (const sub of rule.substitutions) {
      assert.equal(matcher.substitute(sub.from).text, sub.to, `${rule.id}: ${sub.from}`);
    }
  }
});

test('map-surface (exact) matching also covers every taxonomy rule unwrapped', async () => {
  const res = validateRules({ rules: await load() });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const lineMatcher = createLineMatcher(compile(res.rules, 'en'));
  for (const rule of res.rules) {
    for (const sub of rule.substitutions) {
      assert.equal(lineMatcher.substitute(sub.from), sub.to, `${rule.id}: ${sub.from}`);
    }
  }
});

test('the multi-word landmark yields a wrapped-label line rule', async () => {
  const res = validateRules({ rules: await load() });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const landmark = compile(res.rules, 'en').find((s) => s.from === 'Statue of Liberty')!;
  const line = deriveLineRule(landmark)!;
  assert.ok(line, 'Statue of Liberty must wrap-match');
  assert.deepEqual([line.token, line.to], ['Liberty', 'Freedom']);
});
