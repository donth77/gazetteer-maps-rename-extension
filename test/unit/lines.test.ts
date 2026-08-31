import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineMatcher, deriveLineRule } from '../../src/core/lines.ts';
import { compile } from '../../src/core/rules.ts';
import type { Rule } from '../../src/core/types.ts';

const sub = (from: string, to: string, ruleId = 't') => ({ from, to, locale: '*', ruleId });

test('derives the single differing line and its anchors', () => {
  const r = deriveLineRule(sub('Gulf of America', 'Gulf of Mexico'))!;
  assert.equal(r.token, 'America');
  assert.equal(r.to, 'Mexico');
  assert.ok(r.context.includes('Gulf of'), 'the wrapped line itself must anchor');
  assert.ok(r.context.includes('Gulf'));
  assert.ok(!r.context.includes('of'), '"of" is too generic to anchor on');
});

test('derives a single-token prefix anchor', () => {
  const r = deriveLineRule(sub('Lake America', 'Lake Ontario'))!;
  assert.deepEqual([r.token, r.to], ['America', 'Ontario']);
  assert.deepEqual(r.context, ['Lake']);
});

test('refuses names where more than one line changes', () => {
  assert.equal(deriveLineRule(sub('Foo Bar', 'Baz Qux')), null);
});

test('refuses a single-word name — nothing is left to anchor on', () => {
  assert.equal(deriveLineRule(sub('America', 'Mexico')), null);
});

test('rewrites an unwrapped label in one call', () => {
  const m = createLineMatcher([sub('Gulf of America', 'Gulf of Mexico')]);
  assert.equal(m.substitute('Gulf of America'), 'Gulf of Mexico');
  assert.equal(m.whole, 1);
});

test('rewrites a wrapped label across separate decodes', () => {
  const m = createLineMatcher([sub('Gulf of America', 'Gulf of Mexico')]);
  assert.equal(m.substitute('Gulf of'), 'Gulf of');
  assert.equal(m.substitute('America'), 'Mexico');
  assert.equal(m.lines, 1);
});

test('tolerates unrelated decodes between the two lines', () => {
  const m = createLineMatcher([sub('Gulf of America', 'Gulf of Mexico')]);
  m.substitute('Gulf of');
  m.substitute('Tampa');
  m.substitute('Havana');
  assert.equal(m.substitute('America'), 'Mexico');
});

test('does not fire once the anchor has fallen out of the window', () => {
  const m = createLineMatcher([sub('Gulf of America', 'Gulf of Mexico')]);
  m.substitute('Gulf of');
  for (const filler of ['a', 'b', 'c', 'd', 'e', 'f']) m.substitute(filler);
  assert.equal(m.substitute('America'), 'America', 'stale context must not apply');
});

// The false positive that makes an ungated token rule unsafe.
test('leaves "North America" alone', () => {
  const m = createLineMatcher([sub('Gulf of America', 'Gulf of Mexico')]);
  assert.equal(m.substitute('North'), 'North');
  assert.equal(m.substitute('America'), 'America');
  assert.equal(m.substitutions, 0);
});

test('picks the right target when two names share a differing token', () => {
  const subs = [
    sub('Gulf of America', 'Gulf of Mexico', 'gulf'),
    sub('Lake America', 'Lake Ontario', 'lake'),
  ];
  const m = createLineMatcher(subs);
  m.substitute('Lake');
  assert.equal(m.substitute('America'), 'Ontario');

  const m2 = createLineMatcher(subs);
  m2.substitute('Gulf of');
  assert.equal(m2.substitute('America'), 'Mexico');
});

test('the most recent anchor wins when both are in the window', () => {
  const m = createLineMatcher([
    sub('Gulf of America', 'Gulf of Mexico', 'gulf'),
    sub('Lake America', 'Lake Ontario', 'lake'),
  ]);
  m.substitute('Gulf of');
  m.substitute('Lake');
  assert.equal(m.substitute('America'), 'Ontario');
});

test('an already-substituted line is not re-substituted', () => {
  const m = createLineMatcher([sub('Gulf of America', 'Gulf of Mexico')]);
  m.substitute('Gulf of');
  assert.equal(m.substitute('America'), 'Mexico');
  assert.equal(m.substitute('Mexico'), 'Mexico');
});

test('drives off the real compiled rule set', () => {
  const rules: Rule[] = [{
    id: 'gulf', enabled: true,
    substitutions: [{ locale: 'en', from: 'Gulf of America', to: 'Gulf of Mexico' }],
  }];
  const m = createLineMatcher(compile(rules, 'en'));
  m.substitute('Gulf of');
  assert.equal(m.substitute('America'), 'Mexico');
});

test('every shipped rule that can wrap yields a usable line rule', async () => {
  const shipped = (await import('../../data/names.json', { with: { type: 'json' } })).default;
  const compiled = compile(shipped.rules as Rule[], 'en');
  const primary = compiled.filter((s) => !s.from.includes('('));
  assert.ok(primary.length > 0);
  for (const s of primary) {
    assert.ok(deriveLineRule(s), `${s.ruleId}: "${s.from}" must reduce to a line rule`);
  }
});

test('the buffer probe recovers the reverse-order case', () => {
  const m = createLineMatcher([sub('Gulf of America', 'Gulf of Mexico')]);
  // "America" decoded before its anchor line — recency cannot help here.
  const nearby = (needle: string) => needle === 'Gulf of';
  assert.equal(m.substitute('America', nearby), 'Mexico');
  assert.equal(m.lines, 1);
});

test('the buffer probe does not fire when no anchor is nearby', () => {
  const m = createLineMatcher([sub('Gulf of America', 'Gulf of Mexico')]);
  assert.equal(m.substitute('America', () => false), 'America');
  assert.equal(m.substitutions, 0);
});

test('recency still wins over the probe when both are available', () => {
  const m = createLineMatcher([
    sub('Gulf of America', 'Gulf of Mexico', 'gulf'),
    sub('Lake America', 'Lake Ontario', 'lake'),
  ]);
  m.substitute('Lake');
  assert.equal(m.substitute('America', (n) => n === 'Gulf of'), 'Ontario');
});

test('a throwing probe is treated as no match, not a crash', () => {
  const m = createLineMatcher([sub('Gulf of America', 'Gulf of Mexico')]);
  assert.equal(m.substitute('America', () => { throw new Error('bad buffer'); }), 'America');
});

import { createResolutionStore } from '../../src/core/lines.ts';

test('resolution store applies a published mapping', () => {
  const store = createResolutionStore();
  store.publish('America', 'Mexico');
  assert.equal(store.apply('America'), 'Mexico');
  assert.equal(store.has('America'), true);
});

test('resolution store leaves unknown text unchanged', () => {
  const store = createResolutionStore();
  assert.equal(store.apply('America'), 'America');
  assert.equal(store.has('America'), false);
});

test('resolution store ignores no-op and empty mappings', () => {
  const store = createResolutionStore();
  store.publish('America', 'America');
  store.publish('', 'X');
  store.publish('Y', '');
  assert.equal(store.has('America'), false);
  assert.equal(store.has('Y'), false);
});

test('resolution store clears', () => {
  const store = createResolutionStore();
  store.publish('America', 'Mexico');
  store.clear();
  assert.equal(store.apply('America'), 'America');
});

test('resolution store reports when a different value is overwritten', () => {
  const store = createResolutionStore();
  assert.equal(store.publish('America', 'Mexico'), false, 'first publish is not a collision');
  assert.equal(store.publish('America', 'Mexico'), false, 'same value again is not a collision');
  assert.equal(store.publish('America', 'Ontario'), true, 'a different value is the collision');
  assert.equal(store.apply('America'), 'Ontario', 'last write still wins');
});

import { createRepairGovernor } from '../../src/core/lines.ts';

test('repair governor allows a repair after a stable previous value', () => {
  const g = createRepairGovernor({ minStableMs: 1000, cooldownMs: 5000, maxRepairs: 2 });
  const t0 = 100000;
  g.touch('America', t0);
  assert.equal(g.allow(t0, t0 + 2000), true, 'stood 2s > 1s stability');
});

test('repair governor refuses flip-flopping resolutions', () => {
  const g = createRepairGovernor({ minStableMs: 1000, cooldownMs: 5000, maxRepairs: 5 });
  const t0 = 100000;
  g.touch('America', t0);
  assert.equal(g.allow(t0, t0 + 200), false, 'previous value only stood 200ms');
});

test('repair governor enforces cooldown and cap', () => {
  const g = createRepairGovernor({ minStableMs: 100, cooldownMs: 5000, maxRepairs: 2 });
  assert.equal(g.allow(1000, 10000), true);
  assert.equal(g.allow(1000, 11000), false, 'inside cooldown');
  assert.equal(g.allow(1000, 20000), true, 'cooldown passed');
  assert.equal(g.allow(1000, 60000), false, 'cap of 2 reached');
});

test('repair governor refuses when there was no previous value', () => {
  const g = createRepairGovernor({ minStableMs: 100, cooldownMs: 100, maxRepairs: 5 });
  assert.equal(g.allow(0, 50000), false, 'first resolution is not a collision');
});
