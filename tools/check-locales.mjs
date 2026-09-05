/**
 * Which catalog does Chrome serve for each UI language? Launches the built
 * extension once per language with the UI forced to it and reads the
 * `uiLang` message, which every catalog sets to its own name. Offline and
 * deterministic.
 *
 * German is the sentinel: its catalog is shipped directly, so if a browser
 * will switch catalogs at all it must serve that one. Where it does not
 * (macOS takes the extension locale from the system, whatever --lang says)
 * the check reports that it cannot run rather than failing.
 */
import { launchWithExtension, extensionId } from './browser.mjs';

// UI language -> catalog that should serve it ('en' being default_locale).
const SENTINEL = ['de', 'de'];
const EXPECT = [
  SENTINEL,
  ['en-GB', 'en'],
  ['es', 'es'], ['es-419', 'es'],
  ['fr-CA', 'fr'],
  ['ja', 'ja'], ['ko', 'ko'],
  ['pt-BR', 'pt-BR'], ['pt-PT', 'pt-PT'], ['pt', 'pt-BR'],
  ['zh-CN', 'zh-CN'], ['zh-TW', 'zh-TW'], ['zh-HK', 'zh-TW'],
  ['it', 'en'], // no catalog of its own: default_locale
];

async function catalogFor(lang) {
  const context = await launchWithExtension({ headless: false, locale: lang });
  try {
    const page = await context.newPage();
    await page.goto('about:blank');
    const id = await extensionId(context);
    if (!id) throw new Error('extension did not load');
    await page.goto(`chrome-extension://${id}/options.html`);
    return await page.evaluate(() => ({ ui: chrome.i18n.getUILanguage(), catalog: chrome.i18n.getMessage('uiLang') || 'en' }));
  } finally {
    await context.close();
  }
}

const probe = await catalogFor(SENTINEL[0]);
if (probe.catalog !== SENTINEL[1]) {
  console.log(`This browser does not take its extension locale from the command line `
    + `(asked for ${SENTINEL[0]}, got the ${probe.catalog} catalog). Skipping; CI runs this on Linux.`);
  process.exit(0);
}

let failures = 0;
for (const [lang, expected] of EXPECT) {
  const { ui, catalog } = lang === SENTINEL[0] ? probe : await catalogFor(lang);
  const ok = catalog === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${lang.padEnd(6)} (UI ${ui.padEnd(6)}) -> ${catalog}${ok ? '' : ` (expected ${expected})`}`);
}
if (failures) { console.error(`\n${failures} locale(s) resolve to the wrong catalog`); process.exit(1); }
console.log('\nPASS: every UI language resolves to the intended catalog.');
