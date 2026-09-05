/**
 * Which catalog does Chrome pick for each UI language? Launches the built
 * extension once per language with the UI forced to it and reads the
 * `uiLang` message, which every catalog sets to its own name. Offline and
 * deterministic, but needs a browser that honours --lang (Linux and Windows;
 * macOS takes the language from the system, so the check skips there).
 */
import { launchWithExtension, extensionId } from './browser.mjs';

// UI language -> catalog that should serve it ('en' being default_locale).
const EXPECT = {
  'en-GB': 'en', 'es-419': 'es', 'es': 'es', 'fr-CA': 'fr', 'de': 'de', 'ja': 'ja', 'ko': 'ko',
  'pt-BR': 'pt-BR', 'pt-PT': 'pt-PT', 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', 'zh-HK': 'zh-TW',
  'it': 'en', // no catalog: default_locale
};

let failures = 0;
for (const [lang, expected] of Object.entries(EXPECT)) {
  const context = await launchWithExtension({ extraArgs: [`--lang=${lang}`] });
  try {
    const page = await context.newPage();
    await page.goto('about:blank');
    const id = await extensionId(context);
    if (!id) throw new Error('extension did not load');
    await page.goto(`chrome-extension://${id}/options.html`);
    const r = await page.evaluate(() => ({ ui: chrome.i18n.getUILanguage(), catalog: chrome.i18n.getMessage('uiLang') || 'en' }));
    if (r.ui.toLowerCase() !== lang.toLowerCase()) {
      console.log(`--lang=${lang} was ignored (UI is ${r.ui}); this platform cannot run the check.`);
      process.exit(0);
    }
    const ok = r.catalog === expected;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${lang.padEnd(6)} -> ${r.catalog}${ok ? '' : ` (expected ${expected})`}`);
  } finally {
    await context.close();
  }
}
if (failures) { console.error(`\n${failures} locale(s) resolve to the wrong catalog`); process.exit(1); }
console.log('\nPASS: every UI language resolves to the intended catalog.');
