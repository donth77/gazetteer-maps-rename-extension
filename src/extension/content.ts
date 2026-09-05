import { createMatcher, type Matcher } from '../core/engine.ts';
import { compile } from '../core/rules.ts';
import { createCounters } from '../core/counters.ts';
import { installDomHook, type DomHookHandle } from '../hooks/dom.ts';
import { defaultConfig, loadConfig, onConfigChanged, type GazetteerConfig } from './config.ts';

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

function pageLocale(): string {
  return document.documentElement.getAttribute('lang') || navigator.language || 'en';
}

let handle: DomHookHandle | null = null;
let searchField = false;

/** Counters reported back by the in-worker hook, for the popup. */
const mapCounters = { decodes: 0, substitutions: 0, whole: 0, lines: 0, shared: 0 };
let mapContested = false;

function applyConfig(config: GazetteerConfig): void {
  const subs = config.enabled ? compile(config.rules, pageLocale()) : [];
  active = createMatcher(subs);
  searchField = config.searchField === true;
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
    handle = installDomHook({ matcher: live, counters, searchField });
  } catch {
    counters.hookInstalled = false;
  }
}

function reconcile(config: GazetteerConfig): void {
  const wasSearchField = searchField;
  applyConfig(config);
  // The search-field guard is fixed at install time; re-install if it flipped.
  if (wasSearchField !== searchField) {
    try { handle?.disconnect(); } catch { /* ignore */ }
    install();
    return;
  }
  handle?.rescan();
}

function boot(): void {
  // Install immediately with the shipped defaults so text streamed in with the
  // initial HTML (the <title>, most visibly) is rewritten before first paint.
  // The user's saved config replaces the defaults as soon as storage resolves —
  // the same startup trade the map-surface hook makes.
  applyConfig({ ...defaultConfig() });
  install();
  loadConfig().then(reconcile).catch(() => { /* defaults stay active */ });
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
