import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, localeMatches, mergeDefaults, reverseSubs, validateRules } from '../../src/core/rules.ts';
import { createCounters, healthOf, sumCounters } from '../../src/core/counters.ts';
import { createMatcher } from '../../src/core/engine.ts';
import type { Rule } from '../../src/core/types.ts';

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 'r', enabled: true, substitutions: [{ locale: 'en', from: 'A', to: 'B' }], ...over,
});

test('locale "*" matches anything, including an unknown page locale', () => {
  assert.equal(localeMatches('*', 'ja'), true);
  assert.equal(localeMatches('*', ''), true);
});

test('a bare language matches its regional variants but not its neighbours', () => {
  assert.equal(localeMatches('en', 'en'), true);
  assert.equal(localeMatches('en', 'en-US'), true);
  assert.equal(localeMatches('en', 'EN-gb'), true);
  assert.equal(localeMatches('en', 'es'), false);
  assert.equal(localeMatches('en', 'eng'), false);
});

test('compile drops substitutions from disabled rules', () => {
  assert.equal(compile([rule({ enabled: false })], 'en').length, 0);
});

test('compile drops substitutions for other locales', () => {
  assert.equal(compile([rule()], 'ja').length, 0);
  assert.equal(compile([rule({ substitutions: [{ locale: '*', from: 'A', to: 'B' }] })], 'ja').length, 1);
});

test('compile sorts by descending from-length', () => {
  const out = compile([rule({ substitutions: [
    { locale: '*', from: 'ab', to: 'x' },
    { locale: '*', from: 'abcd', to: 'x' },
    { locale: '*', from: 'abc', to: 'x' },
  ] })], 'en');
  assert.deepEqual(out.map((s) => s.from), ['abcd', 'abc', 'ab']);
});

test('compile keeps config order among equal-length entries', () => {
  const out = compile([rule({ substitutions: [
    { locale: '*', from: 'aa', to: 'first' },
    { locale: '*', from: 'bb', to: 'second' },
  ] })], 'en');
  assert.deepEqual(out.map((s) => s.to), ['first', 'second']);
});

test('compile skips junk without throwing', () => {
  const messy = [
    rule({ substitutions: [
      { locale: '*', from: '', to: 'x' },          // empty from would match everywhere
      { locale: '*', from: 'same', to: 'same' },   // no-op
      { locale: '*', from: 'ok', to: 'fine' },
    ] }),
    { id: 'empty', enabled: true, substitutions: [] } as Rule,
  ];
  const out = compile(messy, 'en');
  assert.deepEqual(out.map((s) => s.from), ['ok']);
});

test('compile tags each substitution with its rule id', () => {
  assert.equal(compile([rule({ id: 'gulf' })], 'en')[0]!.ruleId, 'gulf');
});

test('mergeDefaults adds new shipped rules but preserves user edits', () => {
  const user: Rule[] = [rule({ id: 'gulf', enabled: false })];
  const shipped: Rule[] = [rule({ id: 'gulf', enabled: true }), rule({ id: 'brand-new' })];
  const merged = mergeDefaults(user, shipped);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((r) => r.id === 'gulf')!.enabled, false, 'user disable must survive');
  assert.ok(merged.find((r) => r.id === 'brand-new'), 'new shipped rule must appear');
});

test('validateRules accepts a good payload and defaults a missing locale to "*"', () => {
  const res = validateRules({ rules: [{ id: 'a', substitutions: [{ from: 'x', to: 'y' }] }] });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.rules[0]!.substitutions[0]!.locale, '*');
    assert.equal(res.rules[0]!.enabled, true);
  }
});

test('validateRules rejects malformed payloads with a usable message', () => {
  for (const bad of [null, 42, {}, { rules: {} }, { rules: [{}] }, { rules: [{ id: 'a' }] }]) {
    assert.equal(validateRules(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
  const dup = validateRules({ rules: [{ id: 'a', substitutions: [] }, { id: 'a', substitutions: [] }] });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.match(dup.error, /share the id "a"/);
});

test('the shipped names.json is valid and its default rule is enabled', async () => {
  const shipped = (await import('../../data/names.json', { with: { type: 'json' } })).default;
  const res = validateRules(shipped);
  assert.equal(res.ok, true, res.ok ? '' : res.error);
  if (!res.ok) return;
  for (const id of ['gulf-of-mexico', 'lake-ontario']) {
    const shippedRule: Rule | undefined = res.rules.find((r) => r.id === id);
    assert.ok(shippedRule, `${id} rule must ship`);
    assert.equal(shippedRule.enabled, true, 'it must work without visiting settings');
    assert.ok(shippedRule.substitutions.length > 0, `${id} must ship at least one substitution`);
  }
  assert.ok(compile(res.rules, 'en').length > 0, 'must compile to at least one active substitution');
});

test('health states map from counters', () => {
  const c = createCounters();
  assert.equal(healthOf(c), 'HOOK_NOT_INSTALLED');
  c.hookInstalled = true;
  assert.equal(healthOf(c), 'INSTALLED_NO_MATCH');
  c.substitutionsMade = 1;
  assert.equal(healthOf(c), 'OK');
});

test('sumCounters folds several hooks together', () => {
  const a = { ...createCounters(), hookInstalled: true, callsObserved: 2, substitutionsMade: 1 };
  const b = { ...createCounters(), callsObserved: 3, matchesFound: 4 };
  const total = sumCounters([a, b]);
  assert.equal(total.callsObserved, 5);
  assert.equal(total.matchesFound, 4);
  assert.equal(total.hookInstalled, true);
});

test('every shipped substitution survives a round trip through the engine', async () => {
  const shipped = (await import('../../data/names.json', { with: { type: 'json' } })).default;
  const res = validateRules(shipped);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const matcher = createMatcher(compile(res.rules, 'en'));
  for (const rule of res.rules) {
    for (const sub of rule.substitutions) {
      const out = matcher.substitute(sub.from);
      assert.equal(out.text, sub.to, `${rule.id}: "${sub.from}" should become "${sub.to}"`);
      // And the result must be stable — no "X (X)" on a second pass.
      assert.equal(matcher.substitute(out.text).text, out.text, `${rule.id}: "${sub.to}" is not stable`);
    }
  }
});

test('mergeDefaults honours tombstones for deleted shipped rules', () => {
  const merged = mergeDefaults([], [rule({ id: 'gulf' }), rule({ id: 'lake' })], ['gulf']);
  assert.deepEqual(merged.map((r) => r.id), ['lake']);
});

test('a tombstoned rule the user re-adds themselves is kept', () => {
  const merged = mergeDefaults([rule({ id: 'gulf' })], [rule({ id: 'gulf' })], ['gulf']);
  assert.equal(merged.length, 1);
});

test('validation failures carry a code and parameters a UI can phrase', () => {
  const fail = (value: unknown) => {
    const r = validateRules(value);
    assert.equal(r.ok, false);
    return r.ok ? null : r;
  };
  assert.equal(fail(null)?.code, 'notObject');
  assert.equal(fail({})?.code, 'missingRules');
  assert.deepEqual([fail({ rules: [null] })?.code, fail({ rules: [null] })?.params], ['ruleNotObject', ['1']]);
  assert.deepEqual(fail({ rules: [{ substitutions: [] }] })?.params, ['1']);
  assert.deepEqual([fail({ rules: [rule(), rule()] })?.code, fail({ rules: [rule(), rule()] })?.params], ['duplicateId', ['r']]);
  assert.equal(fail({ rules: [{ id: 'x' }] })?.code, 'ruleNeedsRenames');
  assert.deepEqual(fail({ rules: [{ id: 'x', substitutions: [{ from: 'A' }] }] })?.params, ['x', '1']);
  assert.equal(fail({ rules: [{ id: 'x', substitutions: [{ from: 'A' }] }] })?.code, 'renameNeedsText');
  assert.equal(fail({ rules: [{ id: 'x', substitutions: [{ from: 'A', to: 'B' }, 3] }] })?.code, 'renameNotObject');
});

test('reverseSubs turns the renames around, one per name, preferring the bare original', () => {
  const compiled = compile([{
    id: 'gulf', enabled: true, substitutions: [
      { locale: 'en', from: 'Gulf of Mexico (Gulf of America)', to: 'Gulf of Bananas' },
      { locale: 'en', from: 'Gulf of America', to: 'Gulf of Bananas' },
      { locale: 'en', from: 'Same', to: 'Same' },
      { locale: 'en', from: 'Erased', to: '' },
    ],
  }, {
    id: 'lake', enabled: true, substitutions: [{ locale: 'en', from: 'Lake America', to: 'Lake Ontario' }],
  }], 'en');
  const reversed = reverseSubs(compiled);
  assert.deepEqual(reversed.map((s) => [s.from, s.to]), [
    ['Gulf of Bananas', 'Gulf of America'],
    ['Lake Ontario', 'Lake America'],
  ]);
  // Longest first, so a query is matched leftmost-longest like page text.
  assert.ok(reversed[0]!.from.length >= reversed[1]!.from.length);
  const query = createMatcher(reversed, { ignoreCase: true });
  assert.equal(query.substitute('ferry from lake ontario to the gulf of bananas').text, 'ferry from Lake America to the Gulf of America');
});
