import { defaultConfig, defaultRules, loadConfig, onConfigChanged, saveConfig, type GazetteerConfig } from '../config.ts';
import { validateRules, type RuleError } from '../../core/rules.ts';
import type { Rule, Substitution } from '../../core/types.ts';

const $ = <T extends Element>(sel: string): T => document.querySelector<T>(sel)!;

let config: GazetteerConfig = { enabled: true, suppressRasterPreview: true, rules: [] };
let saveTimer: number | undefined;
/** What this page last wrote, so its own storage events can be told from others'. */
let lastSaved = '';

/** JSON with sorted keys: storage hands objects back in its own key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  });
}

/**
 * The pill is a live region, so it stays in the document and only its text
 * changes: a region that appears and disappears is not reliably announced.
 */
function markSaved(): void {
  notify(t('savedPill'));
}

async function write(): Promise<void> {
  lastSaved = canonical(config);
  await saveConfig(config);
  markSaved();
}

/** Debounced so typing in a text field does not hammer storage. */
function persist(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    write().catch(() => { /* ignore */ });
  }, 300);
}

/** A tab closed mid-debounce must not lose the last keystrokes. */
function flushPending(): void {
  if (saveTimer === undefined) return;
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  write().catch(() => { /* ignore */ });
}

/**
 * In-page confirm dialog. window.confirm is avoided because Chrome silently
 * auto-declines it when dialogs are suppressed, which reads as the button
 * doing nothing; a <dialog> cannot be suppressed.
 */
function confirmDialog(message: string, confirmLabel: string): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('#confirm-dialog');
  $<HTMLElement>('#confirm-message').textContent = message;
  const ok = $<HTMLButtonElement>('#confirm-ok');
  ok.textContent = confirmLabel;
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      if (dialog.open) dialog.close();
      resolve(value);
    };
    ok.onclick = () => finish(true);
    const cancel = $<HTMLButtonElement>('#confirm-cancel');
    cancel.onclick = () => finish(false);
    dialog.oncancel = () => resolve(false); // Esc
    dialog.showModal();
    cancel.focus();
  });
}

/**
 * Where focus goes after a delete re-renders the list: the dialog returns it
 * to the button that opened it, but that button is gone with its row.
 */
function focusAfterDelete(candidates: (Element | null | undefined)[]): void {
  for (const el of candidates) {
    if (el instanceof HTMLElement && el.isConnected) { el.focus(); return; }
  }
  $<HTMLButtonElement>('#add-rule').focus();
}

/** Ids still carrying their placeholder, which are safe to replace. */
const AUTO_ID = /^new-place(-\d+)?$/;

function slugify(text: string, taken: Set<string>): string {
  const base = text
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // "México" -> "Mexico"
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new-place';
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

/**
 * Ids already spoken for. Shipped ids and deleted-shipped ids count even when
 * no rule is using them: reusing one would make the next update's merge treat
 * this rule as the shipped one.
 */
function takenIds(except?: Rule): Set<string> {
  return new Set([
    ...config.rules.filter((r) => r !== except).map((r) => r.id),
    ...defaultRules().map((r) => r.id),
    ...(config.removedDefaults ?? []),
  ]);
}

import { LANGUAGES } from './languages.ts';
import { localizeDocument, t } from '../i18n.ts';

/** "All languages" first, then every language Maps offers, in Maps' order. */
const LANGUAGE_OPTIONS: readonly (readonly [string, string])[] = [
  ['*', t('allLanguages')],
  ...LANGUAGES,
];

/**
 * English alias for a language code ("Deutsch" is also findable as "German").
 * Computed at runtime; the shipped list carries only Maps' native names.
 */
const englishNameOf = (() => {
  let display: Intl.DisplayNames | null = null;
  // Alias names follow the extension UI language ("Deutsch" is also findable
  // as "German" in an English UI, as "allemand" in a French one).
  let uiLang = 'en';
  try { uiLang = chrome.i18n.getUILanguage() || 'en'; } catch { /* keep en */ }
  try { display = new Intl.DisplayNames([uiLang], { type: 'language' }); } catch { /* keep null */ }
  return (code: string): string => {
    if (code === '*' || display === null) return '';
    try { return display.of(code) ?? ''; } catch { return ''; }
  };
})();

interface LanguageEntry { code: string; native: string; english: string; haystack: string }

const LANGUAGE_ENTRIES: LanguageEntry[] = LANGUAGE_OPTIONS.map(([code, native]) => {
  const english = englishNameOf(code);
  return {
    code, native,
    english: english && english.toLowerCase() !== native.toLowerCase() ? english : '',
    haystack: `${code} ${native} ${english}`.toLowerCase(),
  };
});

function languageLabel(code: string): string {
  const known = LANGUAGE_ENTRIES.find((e) => e.code === code);
  if (known) return known.native;
  // A code Maps' own menu does not list, such as the base "pt" covering both
  // Brazil and Portugal. Name it rather than showing the user a bare code.
  const named = englishNameOf(code);
  return named || code;
}

/**
 * Searchable language picker: an input showing the current choice; focusing it
 * opens a filtered list. Typing matches the code, the native name, and the
 * English name. A code outside the list (from an imported config) is shown
 * verbatim and kept selectable.
 */
function createLanguagePicker(initial: string, onPick: (code: string) => void): HTMLElement {
  const root = document.createElement('div');
  root.className = 'lang-combo';
  const uid = 'lang' + Math.random().toString(36).slice(2, 8);
  const input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', uid + '-list');
  input.setAttribute('aria-label', t('ariaLanguage'));
  const panel = document.createElement('div');
  panel.className = 'lang-panel';
  panel.id = uid + '-list';
  panel.setAttribute('role', 'listbox');
  panel.setAttribute('aria-label', t('colLanguage'));
  panel.hidden = true;
  // Clicking the list (its scrollbar included) must not blur the input, which
  // would close the list under the pointer.
  panel.addEventListener('mousedown', (event) => event.preventDefault());
  root.append(input, panel);

  let current = initial && initial !== '' ? initial : '*';
  let activeIndex = -1;
  let shown: LanguageEntry[] = [];
  input.value = languageLabel(current);

  const entriesFor = (query: string): LanguageEntry[] => {
    const extra: LanguageEntry[] = LANGUAGE_ENTRIES.some((e) => e.code === current)
      ? []
      : [{ code: current, native: current, english: '', haystack: current.toLowerCase() }];
    const all = [...extra, ...LANGUAGE_ENTRIES];
    const q = query.trim().toLowerCase();
    return q === '' ? all : all.filter((e) => e.haystack.includes(q));
  };

  const renderPanel = (query: string): void => {
    shown = entriesFor(query);
    activeIndex = shown.length > 0 ? 0 : -1;
    panel.textContent = '';
    if (shown.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'lang-empty';
      empty.textContent = t('noMatchingLanguage');
      panel.append(empty);
      return;
    }
    shown.forEach((entry, index) => {
      const row = document.createElement('div');
      row.id = `${uid}-opt-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(entry.code === current));
      if (index === activeIndex) {
        row.classList.add('active');
        input.setAttribute('aria-activedescendant', row.id);
      }
      const name = document.createElement('span');
      name.textContent = entry.native;
      // Native names are in their own language; tell screen readers which.
      if (entry.code !== '*') name.setAttribute('lang', entry.code);
      row.append(name);
      if (entry.english) {
        const alias = document.createElement('span');
        alias.className = 'lang-alias';
        alias.textContent = entry.english;
        row.append(alias);
      }
      // mousedown, so the pick lands before the input's blur closes the panel.
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        pick(entry.code, true);
      });
      row.addEventListener('mousemove', () => {
        if (activeIndex !== index) {
          panel.querySelector('.active')?.classList.remove('active');
          row.classList.add('active');
          activeIndex = index;
        }
      });
      panel.append(row);
    });
  };

  const open = (): void => {
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    renderPanel('');
  };
  const close = (): void => {
    panel.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    input.value = languageLabel(current);
  };
  // Picking with the keyboard keeps focus in the field, where a keyboard user
  // expects it; a mouse pick releases it, as clicking elsewhere would.
  const pick = (code: string, viaPointer = false): void => {
    current = code;
    onPick(code);
    close();
    if (viaPointer) input.blur();
  };

  input.addEventListener('focus', () => {
    input.select();
    open();
  });
  input.addEventListener('input', () => {
    if (panel.hidden) open();
    renderPanel(input.value);
  });
  input.addEventListener('blur', () => close());
  input.addEventListener('keydown', (event) => {
    if (panel.hidden && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === 'ArrowUp')) {
      open();
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (shown.length === 0) return;
      activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      panel.querySelectorAll('[role="option"]').forEach((el, i) => el.classList.toggle('active', i === activeIndex));
      const active = panel.querySelector('.active');
      if (active) {
        input.setAttribute('aria-activedescendant', active.id);
        active.scrollIntoView({ block: 'nearest' });
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = activeIndex >= 0 ? shown[activeIndex] : undefined;
      if (chosen) pick(chosen.code);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  return root;
}

function renderSub(sub: Substitution, rule: Rule, onChange: () => void): HTMLTableRowElement {
  const row = ($<HTMLTemplateElement>('#sub-template').content.cloneNode(true) as DocumentFragment)
    .firstElementChild as HTMLTableRowElement;

  const bind = (sel: string, key: keyof Substitution) => {
    const input = row.querySelector<HTMLInputElement>(sel)!;
    input.value = sub[key];
    input.addEventListener('input', () => {
      sub[key] = input.value;
      persist();
    });
  };
  bind('.js-from', 'from');
  bind('.js-to', 'to');

  row.querySelector<HTMLElement>('.js-locale')!.append(
    createLanguagePicker(sub.locale, (code) => {
      sub.locale = code;
      persist();
    }),
  );

  row.querySelector<HTMLButtonElement>('.js-delete-sub')!.addEventListener('click', async () => {
    // Only ask when there is something to lose; a half-empty row goes quietly.
    const filled = sub.from.trim() !== '' && sub.to.trim() !== '';
    if (filled && !(await confirmDialog(t('confirmRemoveRename', [sub.from, sub.to]), t('dialogRemove')))) return;
    const index = rule.substitutions.indexOf(sub);
    const article = row.closest('article');
    rule.substitutions.splice(index, 1);
    persist();
    onChange();
    const rows = article?.querySelectorAll<HTMLElement>('.sub') ?? [];
    const next = rows[Math.min(index, rows.length - 1)];
    focusAfterDelete([next?.querySelector('.js-from'), article?.querySelector('.js-add-sub')]);
  });
  return row;
}

function renderRule(rule: Rule): HTMLElement {
  const node = ($<HTMLTemplateElement>('#rule-template').content.cloneNode(true) as DocumentFragment)
    .firstElementChild as HTMLElement;

  const count = node.querySelector<HTMLElement>('.js-count')!;
  const refreshSubs = () => {
    const body = node.querySelector<HTMLElement>('.js-subs')!;
    body.textContent = '';
    for (const sub of rule.substitutions) body.append(renderSub(sub, rule, refreshSubs));
    // Bare column headings over an empty table read as a rendering bug.
    node.querySelector<HTMLElement>('.subs')!.hidden = rule.substitutions.length === 0;
    const n = rule.substitutions.length;
    count.textContent = n === 1 ? t('popupRenameCountOne') : t('popupRenameCountMany', [String(n)]);
  };

  /**
   * Rules collapse, because a rule that has picked up a language or two runs
   * long and the page becomes a scroll. Which ones are open is a view
   * preference, so it lives in the browser rather than in the saved rules.
   */
  const toggle = node.querySelector<HTMLButtonElement>('.js-toggle')!;
  const body = node.querySelector<HTMLElement>('.js-body')!;
  body.id = `rule-body-${rule.id.replace(/[^a-z0-9-]/gi, '') || 'x'}`;
  toggle.setAttribute('aria-controls', body.id);
  const remembered = (() => {
    try { return localStorage.getItem(`gz.open.${rule.id}`); } catch { return null; }
  })();
  let open = remembered === null ? false : remembered === '1';
  const applyOpen = () => {
    node.classList.toggle('collapsed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    const label = t(open ? 'hideRenames' : 'showRenames');
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  };
  toggle.addEventListener('click', () => {
    open = !open;
    applyOpen();
    try { localStorage.setItem(`gz.open.${rule.id}`, open ? '1' : '0'); } catch { /* ignore */ }
  });
  applyOpen();

  const enabled = node.querySelector<HTMLInputElement>('.js-enabled')!;
  enabled.checked = rule.enabled;
  enabled.setAttribute('aria-label', t('ariaEnableRule', [rule.description?.trim() || rule.id]));
  node.classList.toggle('disabled', !rule.enabled);
  enabled.addEventListener('change', () => {
    rule.enabled = enabled.checked;
    node.classList.toggle('disabled', !rule.enabled);
    persist();
  });

  const description = node.querySelector<HTMLInputElement>('.js-description')!;
  description.value = rule.description ?? '';
  description.addEventListener('input', () => {
    rule.description = description.value;
    persist();
  });
  // Name the rule after itself once the user has named it, so the id in an
  // exported file means something. Only while the id is still the placeholder:
  // after that it is frozen, because exports and deletions are keyed on it.
  description.addEventListener('change', () => {
    const named = rule.description?.trim();
    if (!named || !AUTO_ID.test(rule.id)) return;
    const next = slugify(named, takenIds(rule));
    if (next === rule.id) return;
    rule.id = next;
    node.querySelector<HTMLElement>('.js-id')!.textContent = rule.id;
    enabled.setAttribute('aria-label', t('ariaEnableRule', [named]));
    persist();
  });

  node.querySelector<HTMLElement>('.js-id')!.textContent = rule.id;

  if (rule.note) {
    const note = node.querySelector<HTMLElement>('.js-note')!;
    note.textContent = rule.note;
    note.hidden = false;
  }

  node.querySelector<HTMLButtonElement>('.js-add-sub')!.addEventListener('click', () => {
    rule.substitutions.push({ locale: '*', from: '', to: '' });
    persist();
    refreshSubs();
    node.querySelector<HTMLInputElement>('.sub:last-child .js-from')?.focus();
  });

  node.querySelector<HTMLButtonElement>('.js-delete-rule')!.addEventListener('click', async () => {
    const label = rule.description?.trim() || rule.id;
    // Only ask when the place has at least one complete rename in it.
    const hasContent = rule.substitutions.some((s) => s.from.trim() !== '' && s.to.trim() !== '');
    if (hasContent && !(await confirmDialog(t('confirmDeleteRule', [label]), t('dialogDelete')))) return;
    if (defaultRules().some((d) => d.id === rule.id)) {
      // A deleted shipped rule must not come back at the next update merge.
      config.removedDefaults = [...new Set([...(config.removedDefaults ?? []), rule.id])];
    }
    const index = config.rules.indexOf(rule);
    config.rules.splice(index, 1);
    persist();
    render();
    const articles = $<HTMLElement>('#rules').querySelectorAll<HTMLElement>('.rule');
    const next = articles[Math.min(index, articles.length - 1)];
    focusAfterDelete([next?.querySelector('.js-description')]);
  });

  refreshSubs();
  return node;
}

function render(): void {
  const host = $<HTMLElement>('#rules');
  host.textContent = '';
  if (config.rules.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = t('emptyRules');
    host.append(empty);
  } else {
    for (const rule of config.rules) host.append(renderRule(rule));
  }
  const master = $<HTMLInputElement>('#master-toggle');
  master.checked = config.enabled;
  $<HTMLInputElement>('#raster-toggle').checked = config.suppressRasterPreview;
}

/** The File System Access API is not in TypeScript's DOM library yet. */
interface SaveFilePicker {
  (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }): Promise<FileSystemFileHandle>;
}

function notify(message: string): void {
  const pill = $<HTMLElement>('#saved');
  pill.textContent = message;
  window.clearTimeout(Number(pill.dataset.timer));
  pill.dataset.timer = String(window.setTimeout(() => { pill.textContent = ''; }, 1800));
}

/**
 * Export goes through the native save dialog where the browser has one, so
 * the user picks the folder and the name and sees it happen. Without it, a
 * download link drops the file in the downloads folder; the confirmation
 * pill is what tells the user that this was the export.
 */
async function exportRules(): Promise<void> {
  const payload = JSON.stringify({ version: 1, rules: config.rules }, null, 2);
  const suggestedName = 'gazetteer-names.json';
  const picker = (window as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker.call(window, {
        suggestedName,
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(payload);
      await writable.close();
      notify(t('exportedPill'));
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return; // user closed the dialog
      // Anything else (a policy blocking the API, an unwritable location): fall back.
    }
  }
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  notify(t('exportedPill'));
}

/** Far above any real rules file; stops a stray multi-megabyte pick cold. */
const IMPORT_LIMIT_BYTES = 1024 * 1024;

function ruleErrorMessage(error: RuleError): string {
  const key = 'importErr' + error.code[0]!.toUpperCase() + error.code.slice(1);
  return t(key, error.params);
}

async function importFile(file: File): Promise<void> {
  const error = $<HTMLElement>('#import-error');
  const fail = (message: string) => {
    error.textContent = t('importError', [message]);
    error.hidden = false;
  };
  error.hidden = true;
  if (file.size > IMPORT_LIMIT_BYTES) return fail(t('importErrTooLarge'));
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return fail(t('importErrNotJson'));
  }
  const parsed = validateRules(data);
  if (!parsed.ok) return fail(ruleErrorMessage(parsed));

  // Import replaces everything, so a shipped rule the file leaves out is a
  // deletion and must stay deleted across updates, while one the file brings
  // back is no longer deleted.
  const imported = new Set(parsed.rules.map((r) => r.id));
  const removedDefaults = defaultRules().map((d) => d.id).filter((id) => !imported.has(id));
  const next: GazetteerConfig = { ...config, rules: parsed.rules, removedDefaults };
  try {
    // Only adopt the new rules once they are safely stored; a failed save
    // (quota, say) must not leave the page editing something storage never got.
    lastSaved = canonical(next);
    await saveConfig(next);
  } catch {
    return fail(t('importErrNotSaved'));
  }
  config = next;
  markSaved();
  render();
}

async function init(): Promise<void> {
  // The page is in whichever language the catalogs could serve, which is not
  // always the browser's; assistive tech reads the attribute, so say which.
  document.documentElement.lang = t('uiLang');
  localizeDocument();
  config = await loadConfig();
  render();

  window.addEventListener('pagehide', flushPending);
  // Another surface (the popup, another settings tab) may rewrite the config
  // while this page is open. Take it, unless it is this page's own write.
  onConfigChanged((next, stored) => {
    if (canonical(stored) === lastSaved) return;
    config = next;
    render();
  });

  $<HTMLInputElement>('#master-toggle').addEventListener('change', (event) => {
    config.enabled = (event.target as HTMLInputElement).checked;
    persist();
  });

  $<HTMLButtonElement>('#add-rule').addEventListener('click', () => {
    const id = slugify('new place', takenIds());
    // A place you just added opens, since the next thing you want is its fields.
    try { localStorage.setItem(`gz.open.${id}`, '1'); } catch { /* ignore */ }
    config.rules.push({
      id,
      enabled: true,
      description: '',
      substitutions: [{ locale: '*', from: '', to: '' }],
    });
    persist();
    render();
    $<HTMLElement>('#rules').lastElementChild
      ?.querySelector<HTMLInputElement>('.js-description')?.focus();
  });

  $<HTMLInputElement>('#raster-toggle').addEventListener('change', (event) => {
    config.suppressRasterPreview = (event.target as HTMLInputElement).checked;
    persist();
  });

  $<HTMLButtonElement>('#export').addEventListener('click', () => { void exportRules(); });
  $<HTMLButtonElement>('#import').addEventListener('click', () => $<HTMLInputElement>('#import-file').click());
  $<HTMLInputElement>('#import-file').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void importFile(file);
    (event.target as HTMLInputElement).value = '';
  });

  $<HTMLButtonElement>('#reset').addEventListener('click', async () => {
    if (!(await confirmDialog(t('confirmRestore'), t('dialogRestore')))) return;
    // The button promises to restore the renames; the preferences are the
    // user's and stay as they are.
    const { enabled, suppressRasterPreview } = config;
    config = { ...defaultConfig(), enabled, suppressRasterPreview };
    await write().catch(() => { /* ignore */ });
    render();
  });
}

void init();
