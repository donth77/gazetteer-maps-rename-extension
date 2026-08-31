/**
 * Thin wrapper over chrome.i18n for the extension's own pages. English lives
 * in _locales/en and is the fallback for everything (default_locale).
 */
export function t(key: string, substitutions?: string | string[]): string {
  try {
    const msg = chrome.i18n.getMessage(key, substitutions);
    if (msg) return msg;
  } catch { /* fall through */ }
  return key;
}

/**
 * Localize static markup: elements carrying data-i18n get their text replaced;
 * data-i18n-placeholder / -arialabel / -title localize those attributes.
 */
export function localizeDocument(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n!);
  }
  const attrs: [string, string][] = [
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-arialabel', 'aria-label'],
    ['data-i18n-title', 'title'],
  ];
  for (const [dataAttr, attr] of attrs) {
    for (const el of root.querySelectorAll<HTMLElement>(`[${dataAttr}]`)) {
      el.setAttribute(attr, t(el.getAttribute(dataAttr)!));
    }
  }
  // querySelectorAll does not descend into <template>; localize their content.
  for (const tpl of root.querySelectorAll<HTMLTemplateElement>('template')) {
    localizeDocument(tpl.content);
  }
}
