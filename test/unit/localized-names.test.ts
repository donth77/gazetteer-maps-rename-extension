import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatcher } from '../../src/core/engine.ts';
import { compile, validateRules } from '../../src/core/rules.ts';
import type { Rule } from '../../src/core/types.ts';

type Table = { localized: Record<string, Record<string, [string, string]>> };
const load = async () => ({
  table: (await import('../../data/localized-names.json', { with: { type: 'json' } })).default as unknown as Table,
  shipped: (await import('../../data/names.json', { with: { type: 'json' } })).default,
});

test('every translated name belongs to a shipped rule and is a real pair', async () => {
  const { table, shipped } = await load();
  const ids = new Set(shipped.rules.map((r) => r.id));
  for (const [ruleId, byLocale] of Object.entries(table.localized)) {
    assert.ok(ids.has(ruleId), `${ruleId} is not a shipped rule`);
    for (const [locale, pair] of Object.entries(byLocale)) {
      assert.match(locale, /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/, `${ruleId}: bad locale ${locale}`);
      assert.equal(pair.length, 2, `${ruleId}/${locale}: needs [served, restored]`);
      const [served, restored] = pair;
      assert.ok(served.trim() && restored.trim(), `${ruleId}/${locale}: empty text`);
      assert.notEqual(served, restored, `${ruleId}/${locale}: served and restored are the same`);
    }
  }
});

test('the forms added at runtime rename the served text in every language', async () => {
  const { table, shipped } = await load();
  const parsed = validateRules(shipped);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  for (const [ruleId, byLocale] of Object.entries(table.localized)) {
    for (const [locale, [served, restored]] of Object.entries(byLocale)) {
      // The same three forms content.ts appends when a map in this language opens.
      const rule: Rule = {
        ...parsed.rules.find((r) => r.id === ruleId)!,
        substitutions: [
          { locale, from: `${restored} (${served})`, to: restored },
          { locale, from: `${served} (${restored})`, to: restored },
          { locale, from: served, to: restored },
        ],
      };
      const matcher = createMatcher(compile([rule], locale));
      for (const text of [served, `${restored} (${served})`, `${served} (${restored})`]) {
        assert.equal(matcher.substitute(text).text, restored, `${ruleId}/${locale}: "${text}"`);
      }
      // And the result is stable: no "X (X)" on a second pass.
      assert.equal(matcher.substitute(restored).text, restored, `${ruleId}/${locale}: not stable`);
    }
  }
});
