import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES } from '../../src/extension/options/languages.ts';
import { localeMatches } from '../../src/core/rules.ts';

test('the language list is complete, unique, and every code is usable', () => {
  assert.ok(LANGUAGES.length >= 70, `only ${LANGUAGES.length} languages`);
  const codes = LANGUAGES.map(([code]) => code);
  assert.equal(new Set(codes).size, codes.length, 'duplicate codes');
  for (const [code, name] of LANGUAGES) {
    assert.match(code, /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, `malformed code ${JSON.stringify(code)}`);
    assert.doesNotThrow(() => Intl.getCanonicalLocales(code), `Intl rejects ${code}`);
    // A rule saved with this code must fire on a page in this language.
    assert.ok(localeMatches(code, code), `${code} does not match itself`);
    assert.ok(name.trim().length > 0, `${code} has no name`);
    assert.ok(!/[‎‏‪-‮⁦-⁩]/.test(name), `${code} name carries bidi marks`);
  }
});

test('codes with a region or script survive the scrape intact', () => {
  const codes = new Set(LANGUAGES.map(([code]) => code));
  for (const expected of ['en', 'es-419', 'pt-BR', 'pt-PT', 'zh-CN', 'zh-TW']) assert.ok(codes.has(expected), expected);
  assert.ok(!codes.has('es-'), 'es-419 was truncated');
});
