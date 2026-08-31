import { defaultConfig, defaultRules, loadConfig, saveConfig, type GazetteerConfig } from '../config.ts';
import { validateRules } from '../../core/rules.ts';
import type { Rule, Substitution } from '../../core/types.ts';

const $ = <T extends Element>(sel: string): T => document.querySelector<T>(sel)!;

let config: GazetteerConfig = { enabled: true, searchField: true, suppressRasterPreview: true, rules: [] };
let saveTimer: number | undefined;

function markSaved(): void {
  const pill = $<HTMLElement>('#saved');
  pill.hidden = false;
  window.clearTimeout(Number(pill.dataset.timer));
  pill.dataset.timer = String(window.setTimeout(() => { pill.hidden = true; }, 1200));
}

/** Debounced so typing in a text field does not hammer storage. */
function persist(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveConfig(config).then(markSaved).catch(() => { /* ignore */ });
  }, 300);
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

function slugify(text: string, taken: Set<string>): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new-place';
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
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
  return LANGUAGE_ENTRIES.find((e) => e.code === code)?.native ?? code;
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
  panel.hidden = true;
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
        pick(entry.code);
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
    input.value = languageLabel(current);
  };
  const pick = (code: string): void => {
    current = code;
    onPick(code);
    close();
    input.blur();
  };

  input.addEventListener('focus', () => {
    input.select();
    open();
  });
  input.addEventListener('input', () => renderPanel(input.value));
  input.addEventListener('blur', () => close());
  input.addEventListener('keydown', (event) => {
    if (panel.hidden && (event.key === 'ArrowDown' || event.key === 'Enter')) {
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
      input.blur();
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
    rule.substitutions.splice(rule.substitutions.indexOf(sub), 1);
    persist();
    onChange();
  });
  return row;
}

function renderRule(rule: Rule): HTMLElement {
  const node = ($<HTMLTemplateElement>('#rule-template').content.cloneNode(true) as DocumentFragment)
    .firstElementChild as HTMLElement;

  const refreshSubs = () => {
    const body = node.querySelector<HTMLElement>('.js-subs')!;
    body.textContent = '';
    for (const sub of rule.substitutions) body.append(renderSub(sub, rule, refreshSubs));
    // Bare column headings over an empty table read as a rendering bug.
    node.querySelector<HTMLElement>('.subs')!.hidden = rule.substitutions.length === 0;
  };

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
    config.rules.splice(config.rules.indexOf(rule), 1);
    persist();
    render();
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
  $<HTMLInputElement>('#search-field-toggle').checked = config.searchField;
  $<HTMLInputElement>('#raster-toggle').checked = config.suppressRasterPreview;
}

function download(): void {
  const payload = JSON.stringify({ version: 1, rules: config.rules }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'gazetteer-names.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function importFile(file: File): Promise<void> {
  const error = $<HTMLElement>('#import-error');
  error.hidden = true;
  try {
    const parsed = validateRules(JSON.parse(await file.text()));
    if (!parsed.ok) {
      error.textContent = t('importError', [parsed.error]);
      error.hidden = false;
      return;
    }
    config.rules = parsed.rules;
    await saveConfig(config);
    markSaved();
    render();
  } catch (e) {
    error.textContent = t('importError', [e instanceof Error ? e.message : 'unreadable file']);
    error.hidden = false;
  }
}

async function init(): Promise<void> {
  try { document.documentElement.lang = chrome.i18n.getUILanguage(); } catch { /* keep en */ }
  localizeDocument();
  config = await loadConfig();
  render();

  $<HTMLInputElement>('#master-toggle').addEventListener('change', (event) => {
    config.enabled = (event.target as HTMLInputElement).checked;
    persist();
  });

  $<HTMLButtonElement>('#add-rule').addEventListener('click', () => {
    const taken = new Set(config.rules.map((r) => r.id));
    config.rules.push({
      id: slugify('new place', taken),
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

  $<HTMLInputElement>('#search-field-toggle').addEventListener('change', (event) => {
    config.searchField = (event.target as HTMLInputElement).checked;
    persist();
  });

  $<HTMLButtonElement>('#export').addEventListener('click', download);
  $<HTMLButtonElement>('#import').addEventListener('click', () => $<HTMLInputElement>('#import-file').click());
  $<HTMLInputElement>('#import-file').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void importFile(file);
    (event.target as HTMLInputElement).value = '';
  });

  $<HTMLButtonElement>('#reset').addEventListener('click', async () => {
    if (!(await confirmDialog(t('confirmRestore'), t('dialogRestore')))) return;
    config = defaultConfig();
    await saveConfig(config);
    markSaved();
    render();
  });
}

void init();
