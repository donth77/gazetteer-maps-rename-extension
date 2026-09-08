import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULE_ERROR_CODES } from '../../src/core/rules.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

type Catalog = Record<string, { message: string }>;
const LOCALES = readdirSync(path.join(ROOT, '_locales')).sort();
const catalogs: Record<string, Catalog> = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(read(`_locales/${l}/messages.json`)) as Catalog]),
);

function* tsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) yield* tsFiles(rel);
    else if (rel.endsWith('.ts')) yield rel;
  }
}

/** Every catalog key the UI can ask for: markup attributes, t() calls, and the computed import errors. */
function referencedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const html of ['src/extension/options/options.html', 'src/extension/popup/popup.html']) {
    for (const m of read(html).matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)) keys.add(m[1]!);
  }
  for (const file of tsFiles('src/extension')) {
    for (const m of read(file).matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) keys.add(m[1]!);
  }
  for (const code of RULE_ERROR_CODES) keys.add('importErr' + code[0]!.toUpperCase() + code.slice(1));
  return keys;
}

test('every key the UI references exists in every catalog', () => {
  const missing: string[] = [];
  for (const key of referencedKeys()) {
    for (const locale of LOCALES) if (!catalogs[locale]![key]) missing.push(`${locale}:${key}`);
  }
  assert.deepEqual(missing, []);
});

test('all catalogs carry exactly the English key set', () => {
  const en = Object.keys(catalogs.en!).sort();
  for (const locale of LOCALES) assert.deepEqual(Object.keys(catalogs[locale]!).sort(), en, locale);
});

test('translations never invent a placeholder English does not have', () => {
  const placeholders = (s: string) => new Set([...s.matchAll(/\$\d/g)].map((m) => m[0]));
  for (const [key, entry] of Object.entries(catalogs.en!)) {
    const allowed = placeholders(entry.message);
    for (const locale of LOCALES) {
      for (const p of placeholders(catalogs[locale]![key]!.message)) assert.ok(allowed.has(p), `${locale}:${key} uses ${p}`);
    }
  }
});

test('UI copy has no em-dashes, and English says rename and language', () => {
  for (const locale of LOCALES) {
    for (const [key, entry] of Object.entries(catalogs[locale]!)) {
      assert.ok(!entry.message.includes('—'), `${locale}:${key} has an em-dash`);
    }
  }
  for (const [key, entry] of Object.entries(catalogs.en!)) {
    // The JSON field is literally called "substitutions"; quoted, it is a field name, not copy.
    const prose = entry.message.replace(/"substitutions"/g, '');
    assert.ok(!/substitution|locale/i.test(prose), `en:${key} says substitution or locale`);
  }
});

test('uiLang names the language the catalog is written in', () => {
  for (const locale of LOCALES) assert.equal(catalogs[locale]!.uiLang!.message, locale.replace('_', '-'));
});

test('t() falls back to bundled English with placeholders filled, never to the raw key', async () => {
  (globalThis as { chrome?: unknown }).chrome = { i18n: { getMessage: () => '' } };
  const { t } = await import('../../src/extension/i18n.ts');
  assert.equal(t('summaryMany', ['3']), '3 names rewritten here');
  assert.equal(t('importErrRenameNeedsText', ['gulf', '2']), 'Rename 2 in "gulf" needs "from" and "to" text.');
  assert.equal(t('summaryOne'), '1 name rewritten here');
  assert.equal(t('noSuchKey'), 'noSuchKey');
  (globalThis as { chrome?: unknown }).chrome = { i18n: { getMessage: (key: string) => (key === 'savedPill' ? 'Gespeichert' : '') } };
  assert.equal(t('savedPill'), 'Gespeichert');
});

test('locale aliases point at real catalogs and never shadow one', () => {
  const { aliases } = JSON.parse(read('data/locale-aliases.json')) as { aliases: Record<string, string> };
  for (const [alias, source] of Object.entries(aliases)) {
    assert.match(alias, /^[a-z]{2,3}(_[A-Za-z0-9]{2,8})?$/, `alias ${alias} is not a Chrome locale directory name`);
    assert.ok(LOCALES.includes(source), `alias ${alias} points at missing catalog ${source}`);
    assert.ok(!LOCALES.includes(alias), `alias ${alias} would overwrite a real catalog`);
  }
  // The parents Chrome falls back to for the variants we do not ship directly.
  assert.equal(aliases.pt, 'pt_BR');
  assert.equal(aliases.zh, 'zh_CN');
  assert.equal(aliases.zh_HK, 'zh_TW');
});

/**
 * Chrome picks an extension's catalog by trying the UI locale, then its parent
 * language, then default_locale. This walks that algorithm over the directories
 * the build actually ships, so the aliases are checked without a browser.
 */
test('every UI locale resolves to the intended catalog', () => {
  const { aliases } = JSON.parse(read('data/locale-aliases.json')) as { aliases: Record<string, string> };
  const shipped = new Set([...LOCALES, ...Object.keys(aliases)]);
  const resolve = (ui: string): string => {
    const dir = ui.replace('-', '_');
    for (const candidate of [dir, dir.split('_')[0]!]) {
      if (shipped.has(candidate)) return (aliases[candidate] ?? candidate).replace('_', '-');
    }
    return 'en';
  };
  const expected: Record<string, string> = {
    'en': 'en', 'en-GB': 'en',
    'es': 'es', 'es-419': 'es', 'es-MX': 'es',
    'fr': 'fr', 'fr-CA': 'fr',
    'de': 'de', 'de-AT': 'de',
    'ja': 'ja', 'ko': 'ko', 'ko-KR': 'ko',
    'pt': 'pt-BR', 'pt-BR': 'pt-BR', 'pt-PT': 'pt-PT',
    'zh': 'zh-CN', 'zh-CN': 'zh-CN', 'zh-SG': 'zh-CN',
    'zh-TW': 'zh-TW', 'zh-HK': 'zh-TW',
    'it': 'en', 'ru': 'en', // no catalog: default_locale
  };
  for (const [ui, want] of Object.entries(expected)) assert.equal(resolve(ui), want, `${ui} should use ${want}`);
});

test('the store description fits the manifest limit in every language', () => {
  // Chrome rejects a manifest description over 132 characters, and the store
  // shows this text under the extension's name.
  for (const locale of LOCALES) {
    const description = catalogs[locale]!.extDescription!.message;
    assert.ok(description.length <= 132, `${locale}: ${description.length} characters`);
    assert.ok(description.length > 0, `${locale}: empty`);
  }
});

test('the store name fits the manifest limit', () => {
  const manifest = JSON.parse(read('src/extension/manifest.json')) as { name: string };
  // Chrome rejects a manifest name over 75 characters. The store indexes this
  // text for search, so it carries a description as well as the brand.
  assert.ok(manifest.name.length <= 75, `${manifest.name.length} characters`);
  assert.match(manifest.name, /^Gazetteer/);
});
