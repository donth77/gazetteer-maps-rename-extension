import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatcher, substitute } from '../../src/core/engine.ts';
import { compile } from '../../src/core/rules.ts';
import type { Rule } from '../../src/core/types.ts';

const sub = (from: string, to: string, locale = '*') => ({ from, to, locale, ruleId: 't' });
/** Compile through the real pipeline so ordering is exercised, not assumed. */
const from = (rules: Rule[], locale = 'en') => createMatcher(compile(rules, locale));

test('replaces a single occurrence', () => {
  const r = substitute('A', [sub('A', 'B')]);
  assert.equal(r.text, 'B');
  assert.equal(r.changed, true);
  assert.equal(r.matches, 1);
});

test('replaces every occurrence in the string', () => {
  const r = substitute('A and A and A', [sub('A', 'B')]);
  assert.equal(r.text, 'B and B and B');
  assert.equal(r.matches, 3);
});

test('leaves non-matching text untouched and reports no change', () => {
  const r = substitute('nothing here', [sub('A', 'B')]);
  assert.equal(r.text, 'nothing here');
  assert.equal(r.changed, false);
  assert.equal(r.matches, 0);
});

test('substitutes inside a longer sentence, preserving both sides', () => {
  const r = substitute('west of A, near the coast', [sub('A', 'B')]);
  assert.equal(r.text, 'west of B, near the coast');
});

// The compound form the shipped rules rely on.
test('compound form is matched before the bare form (no "X (X)")', () => {
  const rules: Rule[] = [{
    id: 'gulf', enabled: true, substitutions: [
      // Deliberately listed shortest-first: compile() must reorder these.
      { locale: 'en', from: 'Gulf of America', to: 'Gulf of Mexico' },
      { locale: 'en', from: 'Gulf of Mexico (Gulf of America)', to: 'Gulf of Mexico' },
    ],
  }];
  const m = from(rules);
  assert.equal(m.substitute('Gulf of Mexico (Gulf of America)').text, 'Gulf of Mexico');
  assert.equal(m.substitute('Gulf of America').text, 'Gulf of Mexico');
});

test('replacement output is never re-scanned, so rules cannot cascade', () => {
  // A -> B and B -> C must not turn "A" into "C".
  const r = substitute('A', [sub('A', 'B'), sub('B', 'C')]);
  assert.equal(r.text, 'B');
});

test('a replacement containing its own trigger is not reprocessed', () => {
  const r = substitute('X', [sub('X', 'XX')]);
  assert.equal(r.text, 'XX');
  assert.equal(r.matches, 1);
});

test('longest match wins at the same position regardless of list order', () => {
  const rules: Rule[] = [{
    id: 'r', enabled: true, substitutions: [
      { locale: '*', from: 'Lake', to: 'SHORT' },
      { locale: '*', from: 'Lake Superior', to: 'LONG' },
    ],
  }];
  assert.equal(from(rules).substitute('Lake Superior').text, 'LONG');
});

test('matching is case-sensitive', () => {
  assert.equal(substitute('gulf of america', [sub('Gulf of America', 'X')]).changed, false);
});

test('is idempotent — running twice changes nothing the second time', () => {
  const m = createMatcher([sub('A', 'B')]);
  const once = m.substitute('A and A');
  const twice = m.substitute(once.text);
  assert.equal(twice.text, once.text);
  assert.equal(twice.changed, false);
});

test('empty and absent input are safe', () => {
  assert.equal(substitute('', [sub('A', 'B')]).text, '');
  assert.equal(substitute('anything', []).changed, false);
  assert.equal(createMatcher([]).size, 0);
});

test('unicode replacements survive intact', () => {
  const r = substitute('Golfo de America', [sub('Golfo de America', 'Golfo de México')]);
  assert.equal(r.text, 'Golfo de México');
});

test('adjacent matches with no separator are both replaced', () => {
  assert.equal(substitute('(A)(A)', [sub('(A)', '(B)')]).matches, 2);
});

test('does not rewrite a name that is part of a longer word', () => {
  const gulf = [sub('Gulf of America', 'Gulf of Mexico')];
  assert.equal(substitute('Gulf of American Shrimp Co', gulf).changed, false);
  assert.equal(substitute('Lake Americas', [sub('Lake America', 'Lake Ontario')]).changed, false);
  assert.equal(substitute('TheGulf of America', gulf).changed, false);
  // Two letters make one word, not two names.
  assert.equal(substitute('AA', [sub('A', 'B')]).changed, false);
});

test('punctuation, spaces, and string edges count as word boundaries', () => {
  const gulf = [sub('Gulf of America', 'Gulf of Mexico')];
  assert.equal(substitute('Gulf of America', gulf).text, 'Gulf of Mexico');
  assert.equal(substitute('(Gulf of America)', gulf).text, '(Gulf of Mexico)');
  assert.equal(substitute("Gulf of America's coast", gulf).text, "Gulf of Mexico's coast");
  assert.equal(substitute('Gulf of America, USA', gulf).text, 'Gulf of Mexico, USA');
  assert.equal(substitute('Gulf of America\u00e9', gulf).changed, false); // accented letter is still a letter
});

test('scripts without word spacing are exempt from the boundary check', () => {
  assert.equal(substitute('アメリカ湾岸', [sub('アメリカ湾', 'メキシコ湾')]).text, 'メキシコ湾岸');
  assert.equal(substitute('墨西哥湾沿岸', [sub('墨西哥湾', '墨西哥灣')]).text, '墨西哥灣沿岸');
});

test('boundary check is code-point aware', () => {
  // An emoji next to the name is not a letter, so the name still matches.
  assert.equal(substitute('\u{1F30A}Gulf of America\u{1F30A}', [sub('Gulf of America', 'Gulf of Mexico')]).changed, true);
});

test('a match at the very end of the string is replaced', () => {
  assert.equal(substitute('go to A', [sub('A', 'B')]).text, 'go to B');
});
