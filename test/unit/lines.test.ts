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

// The renderer reads each label bottom-up, with a font and a weight decoded
// after every line: "Okeechobee", "Lake" (Lake Okeechobee), then "America",
// "Gulf of". Its "Lake" belongs to the label before.
const BOTTOM_UP = ['Okeechobee', 'Roboto, Arial, sans-serif', 'normal', 'Lake', 'Roboto, Arial, sans-serif', 'normal'];
const SHIPPED_PAIR = [
  sub('Gulf of America', 'Gulf of Mexico', 'gulf'),
  sub('Lake America', 'Lake Ontario', 'lake'),
];

test('bottom-up, the line before is another label, which context would misread', () => {
  const m = createLineMatcher(SHIPPED_PAIR);
  for (const text of BOTTOM_UP) m.substitute(text);
  assert.equal(m.substitute('America'), 'Ontario', 'this is the "Gulf of Ontario" the renderer used to draw');
});

test('without context, a shared word is left for the labeler to decide', () => {
  const m = createLineMatcher(SHIPPED_PAIR);
  for (const text of BOTTOM_UP) m.substitute(text, false);
  assert.equal(m.substitute('America', false), 'America');
  assert.equal(m.lines, 0);
});

test('without context, a whole label still matches', () => {
  const m = createLineMatcher(SHIPPED_PAIR);
  assert.equal(m.substitute('Gulf of America', false), 'Gulf of Mexico');
  assert.equal(m.whole, 1);
});

test('knows which lines only context can rename', () => {
  const m = createLineMatcher(SHIPPED_PAIR);
  assert.equal(m.needsContext('America'), true);
  assert.equal(m.needsContext('Gulf of'), false, 'an anchor is not itself renamed');
  assert.equal(m.needsContext('Gulf of America'), false, 'a whole label needs no context');
  assert.equal(m.needsContext('Toronto'), false);
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

test('resolution store keeps the last value published', () => {
  const store = createResolutionStore();
  store.publish('America', 'Mexico');
  store.publish('America', 'Ontario');
  assert.equal(store.apply('America'), 'Ontario');
});

test('resolution store lists its entries, for seeding a new worker', () => {
  const store = createResolutionStore();
  store.publish('America', 'Mexico');
  store.publish('AMERICA', 'MEXICO');
  assert.deepEqual(store.entries(), [['America', 'Mexico'], ['AMERICA', 'MEXICO']]);
});

import { createRepairPlanner } from '../../src/core/lines.ts';

const GULF = '@25,-90,6z';
const LAKE = '@43.7,-77.9,7z';

test('repair planner: nothing to do while the drawn word matches', () => {
  const p = createRepairPlanner();
  p.resolved('America', 'Mexico');
  p.drawn('mc0', 'America', 'Mexico');
  assert.deepEqual(p.decide(10000, GULF), { action: 'none' });
});

test('repair planner: rebuilds when the user moves to the other place', () => {
  const p = createRepairPlanner();
  p.resolved('America', 'Ontario');
  p.drawn('mc0', 'America', 'Ontario');
  p.resolved('America', 'Mexico');
  assert.deepEqual(p.decide(10000, GULF), { action: 'repair' });
});

test('repair planner: no rebuild when the renderer redrew the word itself', () => {
  const p = createRepairPlanner();
  p.drawn('mc0', 'America', 'Ontario');
  p.resolved('America', 'Mexico');
  p.drawn('mc0', 'America', 'Mexico');
  assert.deepEqual(p.decide(10000, GULF), { action: 'none' });
});

test('repair planner: a renderer that drew before the labeler spoke is rebuilt', () => {
  const p = createRepairPlanner();
  p.drawn('mc0', 'America', 'America');
  assert.deepEqual(p.decide(10000, GULF), { action: 'none' }, 'nothing is known to be wrong yet');
  p.resolved('America', 'Mexico');
  assert.deepEqual(p.decide(10100, GULF), { action: 'repair' });
});

// The reported sequence: Gulf, Lake, and back to the Gulf ten seconds later.
// The old governor refused the second rebuild (45s cooldown) and left
// "Gulf of Ontario" on the map.
test('repair planner: going back and forth rebuilds each time, only waiting between', () => {
  const p = createRepairPlanner({ minGapMs: 2500 });
  p.resolved('America', 'Mexico');
  p.drawn('mc0', 'America', 'Mexico');
  p.resolved('America', 'Ontario');
  assert.deepEqual(p.decide(20000, LAKE), { action: 'repair' });
  p.repaired(20000, LAKE);
  p.drawn('mc1', 'America', 'Ontario');
  assert.deepEqual(p.decide(20800, LAKE), { action: 'none' });

  p.resolved('America', 'Mexico');
  assert.deepEqual(p.decide(21500, GULF), { action: 'wait', ms: 1000 }, 'too soon after the last rebuild');
  assert.deepEqual(p.decide(22500, GULF), { action: 'repair' }, 'deferred, not dropped');
  p.repaired(22500, GULF);
  p.drawn('mc2', 'America', 'Mexico');
  assert.deepEqual(p.decide(23300, GULF), { action: 'none' });
});

test('repair planner: a rebuild that did not help is not repeated for the same view', () => {
  // Both places on screen: whichever way "America" is drawn, one label is wrong.
  const p = createRepairPlanner({ minGapMs: 100 });
  p.drawn('mc0', 'America', 'Mexico');
  p.resolved('America', 'Ontario');
  assert.deepEqual(p.decide(10000, GULF), { action: 'repair' });
  p.repaired(10000, GULF);
  p.drawn('mc1', 'America', 'Mexico');
  assert.deepEqual(p.decide(11000, GULF), { action: 'contested', recheck: true });
  assert.deepEqual(p.decide(12000, '@30,-85,6z'), { action: 'repair' }, 'the view moved, so try again');
});

test('repair planner: a view where the map was put right can be rebuilt again later', () => {
  const p = createRepairPlanner({ minGapMs: 100 });
  p.drawn('mc0', 'America', 'Ontario');
  p.resolved('America', 'Mexico');
  p.repaired(10000, GULF);
  p.drawn('mc1', 'America', 'Mexico');
  assert.deepEqual(p.decide(11000, GULF), { action: 'none' });
  // Off to the Lake, where the renderer redraws the word itself, then back.
  p.resolved('America', 'Ontario');
  p.drawn('mc1', 'America', 'Ontario');
  assert.deepEqual(p.decide(20000, LAKE), { action: 'none' });
  p.resolved('America', 'Mexico');
  assert.deepEqual(p.decide(30000, GULF), { action: 'repair' });
});

test('repair planner: an unknown view counts as unchanged', () => {
  const p = createRepairPlanner({ minGapMs: 100 });
  p.drawn('mc0', 'America', 'Mexico');
  p.resolved('America', 'Ontario');
  p.repaired(10000, null);
  p.drawn('mc1', 'America', 'Mexico');
  assert.deepEqual(p.decide(11000, null), { action: 'contested', recheck: true });
});

test('repair planner: ignores late reports from a renderer a rebuild replaced', () => {
  const p = createRepairPlanner({ minGapMs: 100 });
  p.drawn('mc0', 'America', 'Ontario');
  p.resolved('America', 'Mexico');
  p.repaired(10000, GULF);
  p.drawn('mc0', 'America', 'Ontario');
  p.drawn('mc1', 'America', 'Mexico');
  assert.deepEqual(p.decide(11000, GULF), { action: 'none' });
});

test('repair planner: stops at the cap', () => {
  const p = createRepairPlanner({ minGapMs: 0, maxRepairs: 2 });
  p.resolved('America', 'Mexico');
  for (const [at, view] of [[1000, 'a'], [2000, 'b']] as const) {
    p.drawn(`r${at}`, 'America', 'Ontario');
    assert.deepEqual(p.decide(at, view), { action: 'repair' });
    p.repaired(at, view);
  }
  p.drawn('r3', 'America', 'Ontario');
  assert.deepEqual(p.decide(3000, 'c'), { action: 'contested', recheck: false }, 'nothing left to try');
});

test('repair planner: a rules change forgets everything resolved and drawn', () => {
  const p = createRepairPlanner({ minGapMs: 100 });
  p.drawn('mc0', 'America', 'Mexico');
  p.resolved('America', 'Ontario');
  p.reset();
  assert.deepEqual(p.decide(10000, GULF), { action: 'none' });
});

test('repair planner: a redraw for new rules retires renderers without counting as a repair', () => {
  const p = createRepairPlanner({ minGapMs: 2500, maxRepairs: 1 });
  p.drawn('mc0', 'America', 'Ontario');
  p.replaced(10000);
  p.resolved('America', 'Mexico');
  p.drawn('mc0', 'America', 'Ontario');
  assert.deepEqual(p.decide(11000, GULF), { action: 'none' }, 'mc0 was replaced');
  p.drawn('mc1', 'America', 'Ontario');
  assert.deepEqual(p.decide(11000, GULF), { action: 'wait', ms: 1500 }, 'spaced from the redraw');
  assert.deepEqual(p.decide(12500, GULF), { action: 'repair' }, 'the redraw did not use up the cap');
});
