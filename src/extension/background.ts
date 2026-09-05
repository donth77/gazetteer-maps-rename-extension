import { defaultConfig, defaultRules, loadConfig, saveConfig, STORAGE_KEY } from './config.ts';
import { mergeDefaults } from '../core/rules.ts';

/**
 * The extension works with no background activity at all; this exists only to
 * seed defaults on first install so a new user gets a working extension without
 * opening the options page.
 */
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    if (stored?.[STORAGE_KEY]) {
      // An update: merge any newly shipped rules into what the user already has.
      const config = await loadConfig();
      if ((config.v ?? 1) < 2) {
        // v2 flipped the search-box default on; stored v1 configs carry an
        // explicit false that only ever meant "the old default".
        config.searchField = true;
        config.v = 2;
      }
      config.rules = mergeDefaults(config.rules, defaultRules(), config.removedDefaults ?? []);
      await saveConfig(config);
      return;
    }
    await saveConfig(defaultConfig());
  } catch {
    /* storage unavailable — loadConfig falls back to defaults at read time */
  }
});
