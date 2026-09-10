import { createMatcher, type Matcher } from '../core/engine.ts';
import { compile, reverseSubs } from '../core/rules.ts';
import { createCounters } from '../core/counters.ts';
import { installDomHook, type DomHookHandle } from '../hooks/dom.ts';
import { defaultConfig, loadConfig, onConfigChanged, saveConfig, type GazetteerConfig } from './config.ts';
import localized from '../../data/localized-names.json' with { type: 'json' };

const counters = createCounters();

/**
 * The active matcher is swapped when config changes, so the hook is handed a
 * stable indirection rather than a snapshot.
 */
let active: Matcher = createMatcher([]);
const live: Matcher = {
  substitute: (text) => active.substitute(text),
  get size() { return active.size; },
};
/** The renames turned around, for what the user types into the search box. */
let activeReverse: Matcher = createMatcher([]);
const liveReverse: Matcher = {
  substitute: (text) => activeReverse.substitute(text),
  get size() { return activeReverse.size; },
};

function pageLocale(): string {
  return document.documentElement.getAttribute('lang') || navigator.language || 'en';
}

let handle: DomHookHandle | null = null;

/** Counters reported back by the in-worker hook, for the popup. */
const mapCounters = { decodes: 0, substitutions: 0, whole: 0, lines: 0, shared: 0 };
let mapContested = false;

function applyConfig(config: GazetteerConfig): void {
  const subs = config.enabled ? compile(config.rules, pageLocale()) : [];
  active = createMatcher(subs);
  // The reverse table matches regardless of case, so it wants one entry per
  // name rather than the capitals variants the forward table carries.
  const plain = config.enabled ? compile(config.rules, pageLocale(), { uppercaseVariants: false }) : [];
  activeReverse = createMatcher(reverseSubs(plain), { ignoreCase: true });
  // The MAIN-world hook cannot read storage; hand it the compiled table.
  try {
    window.postMessage({
      source: 'gazetteer-isolated',
      type: 'rules',
      subs,
      suppressRaster: config.enabled && config.suppressRasterPreview !== false,
    }, '*');
  } catch { /* the DOM hook still works without it */ }
}

function install(): void {
  // Every hook installs inside try/catch and degrades independently.
  try {
    handle = installDomHook({ matcher: live, reverse: liveReverse, counters });
  } catch {
    counters.hookInstalled = false;
  }
}

function reconcile(config: GazetteerConfig): void {
  applyConfig(config);
  handle?.rescan();
}

/** The table key that covers a page language, or null when none does. */
function localizedKeyFor(locale: string, keys: string[]): string | null {
  const want = locale.toLowerCase();
  const base = want.split('-')[0]!;
  return keys.find((k) => k.toLowerCase() === want)
    ?? keys.find((k) => k.toLowerCase() === base)
    ?? keys.find((k) => k.toLowerCase().split('-')[0] === base)
    ?? null;
}

/**
 * Google translates some of these names, so a map in French shows a French
 * name that the shipped English rules cannot match. Every translated form is
 * bundled, but putting all sixty-seven into the rules would leave everyone
 * scrolling past languages they will never see. So a language's forms are
 * added the first time a map in that language is opened, and the language is
 * then remembered: forms the user deletes afterwards stay deleted.
 */
async function addLocalizedDefaults(config: GazetteerConfig, locale: string): Promise<GazetteerConfig> {
  const table = localized.localized as unknown as Record<string, Record<string, string[]>>;
  try {
    const already = config.localesAdded ?? [];
    for (const [ruleId, byLocale] of Object.entries(table)) {
      const key = localizedKeyFor(locale, Object.keys(byLocale));
      if (!key || already.includes(`${ruleId}:${key}`)) continue;
      config.localesAdded = [...(config.localesAdded ?? []), `${ruleId}:${key}`];
      const rule = config.rules.find((r) => r.id === ruleId);
      const pair = byLocale[key];
      // A rule the user deleted stays deleted; the language is still recorded.
      if (!rule || !pair) continue;
      const [served, restored] = pair;
      if (!served || !restored) continue;
      const seen = new Set(rule.substitutions.map((sub) => `${sub.locale}\u0000${sub.from}`));
      for (const from of [`${restored} (${served})`, `${served} (${restored})`, served]) {
        if (!seen.has(`${key}\u0000${from}`)) rule.substitutions.push({ locale: key, from, to: restored });
      }
    }
    if ((config.localesAdded ?? []).length !== already.length) await saveConfig(config);
  } catch { /* the English rules still work */ }
  return config;
}

function boot(): void {
  // Install immediately with the shipped defaults so text streamed in with the
  // initial HTML (the <title>, most visibly) is rewritten before first paint.
  // The user's saved config replaces the defaults as soon as storage resolves —
  // the same startup trade the map-surface hook makes.
  applyConfig({ ...defaultConfig() });
  install();
  loadConfig()
    .then((config) => addLocalizedDefaults(config, pageLocale()))
    .then(reconcile)
    .catch(() => { /* defaults stay active */ });
  onConfigChanged(reconcile);
}

// Well-known global for the health check. ISOLATED world, so the
// page cannot see or tamper with it.
(globalThis as Record<string, unknown>).__GAZETTEER__ = {
  counters,
  get locale() { return pageLocale(); },
  get activeSubstitutions() { return active.size; },
};

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as { source?: string; type?: string; counters?: typeof mapCounters; contested?: boolean } | null;
  if (data?.source === 'gazetteer-main' && data.type === 'counters' && data.counters) {
    Object.assign(mapCounters, data.counters);
    if (typeof data.contested === 'boolean') mapContested = data.contested;
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'gazetteer:status') {
    sendResponse({
      counters,
      mapCounters,
      mapContested,
      locale: pageLocale(),
      activeSubstitutions: active.size,
    });
  }
  return true;
});

try { boot(); } catch { /* never throw into the page */ }
