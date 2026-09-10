import { loadConfig, saveConfig, type GazetteerConfig } from '../config.ts';
import { localizeDocument, t } from '../i18n.ts';
import { healthOf } from '../../core/counters.ts';
import type { Counters } from '../../core/types.ts';

const $ = <T extends Element>(sel: string): T => document.querySelector<T>(sel)!;

interface MapCounters { decodes: number; substitutions: number; whole: number; lines: number; shared: number }

interface Status {
  counters: Counters;
  mapCounters?: MapCounters;
  mapContested?: boolean;
  locale: string;
  activeSubstitutions: number;
}

let config: GazetteerConfig = { enabled: true, suppressRasterPreview: true, rules: [] };

/** A list long enough that finding a place in it needs help. */
const FILTER_FROM = 8;

function renderRules(): void {
  const host = $<HTMLUListElement>('#rules');
  host.textContent = '';

  if (config.rules.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = t('popupNoRules');
    host.append(li);
    return;
  }

  // The ones doing something come first. Decided once, when the list is
  // drawn: a rule switched off here stays where it is until the popup is
  // next opened, rather than jumping away from the pointer.
  const ordered = [...config.rules].sort((a, b) => Number(b.enabled) - Number(a.enabled));

  $<HTMLElement>('#filter-row').hidden = config.rules.length < FILTER_FROM;

  for (const rule of ordered) {
    const li = document.createElement('li');
    li.dataset.haystack = `${rule.description ?? ''} ${rule.id}`.toLowerCase();
    const label = document.createElement('label');

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = rule.enabled;
    box.addEventListener('change', () => {
      rule.enabled = box.checked;
      void saveConfig(config);
    });

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = rule.description || rule.id;

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(rule.substitutions.length);
    count.title = rule.substitutions.length === 1 ? t('popupRenameCountOne') : t('popupRenameCountMany', [String(rule.substitutions.length)]);

    label.append(box, name, count);
    li.append(label);
    host.append(li);
  }
}

function renderStatus(status: Status | null): void {
  const statusEl = $<HTMLElement>('#status');
  const offsite = $<HTMLElement>('#offsite');

  if (!status) {
    statusEl.hidden = true;
    offsite.hidden = false;
    return;
  }
  statusEl.hidden = false;
  offsite.hidden = true;

  const total = status.counters.substitutionsMade + (status.mapCounters?.substitutions ?? 0);
  const summary = $<HTMLElement>('#summary');
  summary.hidden = total === 0;
  summary.textContent = total === 1 ? t('summaryOne') : t('summaryMany', [String(total)]);
  // A live region: keep it in the document and change its text, so the
  // warning is announced when it appears.
  $<HTMLElement>('#contested').textContent = status.mapContested ? t('contestedWarning') : '';
  if (status.mapContested) $<HTMLButtonElement>('#reload').hidden = false;

  const state = healthOf(status.counters);
  const dot = $<HTMLElement>('#state-dot');
  const label = $<HTMLElement>('#state-label');
  dot.className = 'dot';

  if (!config.enabled) {
    dot.classList.add('warn');
    label.textContent = t('statusOff');
  } else if (state === 'OK') {
    dot.classList.add('ok');
    const onMap = (status.mapCounters?.substitutions ?? 0) > 0;
    label.textContent = onMap
      ? t('statusRewritingPageMap', [status.locale])
      : t('statusRewritingPage', [status.locale]);
  } else if (state === 'HOOK_NOT_INSTALLED') {
    dot.classList.add('bad');
    label.textContent = t('statusNotInstalled');
  } else {
    dot.classList.add('warn');
    label.textContent = status.activeSubstitutions === 0
      ? t('statusNoLocaleRules')
      : t('statusNothingHere');
  }
}

/** The content script only lives on Maps pages; anywhere else this returns null. */
async function fetchStatus(): Promise<Status | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    const reply = await chrome.tabs.sendMessage(tab.id, { type: 'gazetteer:status' });
    return (reply as Status) ?? null;
  } catch {
    return null; // no content script in this tab
  }
}

function applyFilter(): void {
  const query = $<HTMLInputElement>('#filter').value.trim().toLowerCase();
  const host = $<HTMLUListElement>('#rules');
  let shown = 0;
  for (const li of host.querySelectorAll<HTMLLIElement>('li[data-haystack]')) {
    const hit = query === '' || li.dataset.haystack!.includes(query);
    li.hidden = !hit;
    if (hit) shown++;
  }
  let none = host.querySelector<HTMLLIElement>('li.empty');
  if (shown === 0 && query !== '') {
    if (!none) {
      none = document.createElement('li');
      none.className = 'empty';
      host.append(none);
    }
    none.textContent = t('noMatchingPlaces');
  } else {
    none?.remove();
  }
}

async function init(): Promise<void> {
  document.documentElement.lang = t('uiLang');
  localizeDocument();
  $<HTMLInputElement>('#filter').addEventListener('input', applyFilter);
  try {
    const manifest = chrome.runtime.getManifest();
    // Dev builds carry a per-build stamp in version_name; releases just the version.
    $<HTMLElement>('#version').textContent = 'v' + (manifest.version_name ?? manifest.version);
  } catch { /* ignore */ }
  config = await loadConfig();
  renderRules();

  const master = $<HTMLInputElement>('#master-toggle');
  master.checked = config.enabled;
  master.addEventListener('change', async () => {
    config.enabled = master.checked;
    await saveConfig(config);
    const status = await fetchStatus();
    renderStatus(status);
    // Only offer a reload where it would do something: on a Maps tab.
    if (status) $<HTMLButtonElement>('#reload').hidden = false;
  });

  // Closing the popup tears this page down, and any call still in flight with
  // it. Both of these are asynchronous, and on the first click of a session
  // the service worker is asleep, which is exactly when the round trip is
  // slowest. So wait for the call to land before closing.
  $<HTMLButtonElement>('#open-options').addEventListener('click', async () => {
    try { await chrome.runtime.openOptionsPage(); } catch { /* ignore */ }
    window.close();
  });

  $<HTMLButtonElement>('#reload').addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await chrome.tabs.reload(tab.id);
    } catch { /* ignore */ }
    window.close();
  });

  renderStatus(await fetchStatus());
}

void init();
