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

  for (const rule of config.rules) {
    const li = document.createElement('li');
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

async function init(): Promise<void> {
  document.documentElement.lang = t('uiLang');
  localizeDocument();
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
