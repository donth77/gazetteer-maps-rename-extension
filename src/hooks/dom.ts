import type { Matcher } from '../core/engine.ts';
import type { Counters } from '../core/types.ts';

/**
 * DOM hook — sidebar, search results, place cards, autocomplete, tab title.
 * Runs in the ISOLATED world. It installs defensively and must never throw
 * into Google's code.
 */

/** Never walk into these: their text is not user-visible prose. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'TEMPLATE']);

/**
 * Attributes worth rewriting. `value` is deliberately absent: the search box
 * holds the query, and rewriting it would make the user's next Enter search for
 * a string Google does not know.
 */
const ATTRS = ['aria-label', 'title', 'alt'] as const;

export interface DomHookOptions {
  matcher: Matcher;
  counters: Counters;
  doc?: Document;
  /** Also rewrite aria-label/title/alt. Default true. */
  attributes?: boolean;
  /**
   * Also rewrite the text sitting in the search box. Off by default: that value
   * is live form state, not a label, and Maps may own it through a framework.
   * Guarded three ways — never while focused, never more than MAX_INPUT_WRITES
   * times per element, and only for text inputs.
   */
  searchField?: boolean;
}

export interface DomHookHandle {
  /** Re-walk the whole document — used when config changes. */
  rescan(): void;
  disconnect(): void;
}

export function installDomHook(options: DomHookOptions): DomHookHandle {
  const doc = options.doc ?? document;
  const { matcher, counters } = options;
  const doAttributes = options.attributes !== false;
  const doSearchField = options.searchField === true;

  /**
   * The last value *we* wrote for a given node+key. Our own writes re-enter the
   * MutationObserver; without this, a rule whose output feeds another rule
   * would cascade across observer ticks, defeating the engine's single-pass
   * guarantee. It also skips redundant work on every re-render.
   */
  let written = new WeakMap<Node, Map<string, string>>();

  /**
   * If Maps keeps resetting a field, stop fighting it rather than loop forever.
   * The bound is on writes in quick succession: a write war is many per
   * second, while one search box legitimately gets a write per search for
   * the whole session.
   */
  const MAX_INPUT_WRITES = 3;
  const INPUT_WRITE_WINDOW_MS = 1000;
  let inputWrites = new WeakMap<Element, { count: number; at: number }>();
  /** Google's own text behind a rewritten field, for searching again. */
  const inputOriginal = new WeakMap<Element, string>();

  function alreadyOurs(node: Node, key: string, value: string): boolean {
    return written.get(node)?.get(key) === value;
  }

  function remember(node: Node, key: string, value: string): void {
    let m = written.get(node);
    if (!m) written.set(node, (m = new Map()));
    m.set(key, value);
  }

  function apply(node: Node, key: string, current: string, write: (next: string) => void): void {
    if (!current || alreadyOurs(node, key, current)) return;
    counters.callsObserved++;
    const result = matcher.substitute(current);
    if (result.matches > 0) counters.matchesFound += result.matches;
    if (!result.changed) return;
    write(result.text);
    remember(node, key, result.text);
    counters.substitutionsMade++;
    counters.lastSubstitutionAt = Date.now();
  }

  function processText(node: Text): void {
    const value = node.nodeValue;
    if (!value) return;
    // A characterData mutation can hand us the text inside a <script>.
    const parent = node.parentElement;
    if (parent && SKIP_TAGS.has(parent.tagName)) return;
    apply(node, '#text', value, (next) => { node.nodeValue = next; });
  }

  function processElement(el: Element): void {
    if (!doAttributes) return;
    for (const attr of ATTRS) {
      const value = el.getAttribute(attr);
      if (value) apply(el, attr, value, (next) => el.setAttribute(attr, next));
    }
  }

  /**
   * Search-box text. Skipped while focused so we never clobber typing, and
   * bounded so a framework that rewrites the value cannot start a write war.
   */
  function processInput(el: HTMLInputElement): void {
    if (!doSearchField) return;
    if (el.type && el.type !== 'text' && el.type !== 'search') return;
    if (doc.activeElement === el) return;
    const now = Date.now();
    const recent = inputWrites.get(el);
    const attempts = recent && now - recent.at < INPUT_WRITE_WINDOW_MS ? recent.count : 0;
    if (attempts >= MAX_INPUT_WRITES) return;
    const value = el.value;
    if (!value || alreadyOurs(el, '#value', value)) return;
    counters.callsObserved++;
    const result = matcher.substitute(value);
    if (result.matches > 0) counters.matchesFound += result.matches;
    if (!result.changed) return;
    el.value = result.text;
    remember(el, '#value', result.text);
    inputOriginal.set(el, value);
    inputWrites.set(el, { count: attempts + 1, at: now });
    counters.substitutionsMade++;
    counters.lastSubstitutionAt = now;
  }

  /**
   * Searching again. Maps reads the box while it handles the Enter key or the
   * search button, synchronously, and it only knows its own name for a place;
   * a renamed one, invented or not, would be searched for as typed. So for
   * that one dispatch the box holds Google's text again, and has the renamed
   * text back before anything paints. Only a value this hook wrote is
   * reversed; whatever the user typed is searched for as is.
   */
  function revealForSubmit(el: HTMLInputElement): void {
    const original = inputOriginal.get(el);
    if (original === undefined || !alreadyOurs(el, '#value', el.value)) return;
    const shown = el.value;
    el.value = original;
    setTimeout(() => { if (el.value === original) el.value = shown; }, 0);
  }

  function onSubmitKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    const target = event.target;
    if (target instanceof HTMLInputElement && inputs.has(target)) revealForSubmit(target);
  }

  function onSubmitClick(event: MouseEvent): void {
    const button = (event.target as Element | null)?.closest?.('button');
    if (!button) return;
    for (const el of inputs) {
      // The search button is not inside the box's form; it sits beside it.
      const scope = (el.form ?? el).parentElement;
      if (scope?.contains(button)) revealForSubmit(el);
    }
  }

  /**
   * Every input the walk has met. `input.value` changes fire no mutation
   * record, so these are swept on every flush; a registry keeps that sweep
   * from being a document-wide query each time Maps touches the DOM.
   */
  const inputs = new Set<HTMLInputElement>();

  function noteElement(el: Element): void {
    if (doSearchField && el.tagName === 'INPUT') inputs.add(el as HTMLInputElement);
    processElement(el);
  }

  function collectInputs(): void {
    if (!doSearchField) return;
    for (const el of inputs) {
      if (!el.isConnected) { inputs.delete(el); continue; }
      try { processInput(el); } catch { /* ignore */ }
    }
  }

  function skipped(node: Node): boolean {
    return node.nodeType === Node.ELEMENT_NODE && SKIP_TAGS.has((node as Element).tagName);
  }

  function walk(root: Node): void {
    if (skipped(root)) return;
    if (root.nodeType === Node.TEXT_NODE) return processText(root as Text);
    if (root.nodeType === Node.ELEMENT_NODE) noteElement(root as Element);
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE
      && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;

    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (skipped(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n: Node | null;
    while ((n = walker.nextNode()) !== null) {
      if (n.nodeType === Node.TEXT_NODE) processText(n as Text);
      else noteElement(n as Element);
    }
  }

  /**
   * Mutations are processed synchronously inside the observer callback. The
   * callback is a microtask, which runs before the browser paints and before
   * the tab title propagates — deferring to requestAnimationFrame (an earlier
   * design) let the served name flash for a frame on load. The observer itself
   * already coalesces all mutations from one task into one callback, so this
   * stays batched where it matters.
   */
  const pending = new Set<Node>();      // full subtree walk
  const pendingAttrs = new Set<Element>(); // attribute-only recheck

  function flush(): void {
    const batch = Array.from(pending);
    const attrBatch = Array.from(pendingAttrs);
    pending.clear();
    pendingAttrs.clear();
    for (const node of batch) {
      if (!node.isConnected) continue;
      try { walk(node); } catch { /* one bad subtree must not stop the rest */ }
    }
    for (const el of attrBatch) {
      if (!el.isConnected) continue;
      try { processElement(el); } catch { /* ignore */ }
    }
    // `input.value` changes fire no mutation record, so sweep on every flush.
    collectInputs();
  }

  let observer: MutationObserver | null = null;

  function start(): void {
    const root = doc.documentElement;
    if (!root) return;
    try { walk(root); } catch { /* keep going; the observer still gets a chance */ }
    collectInputs();
    // Re-check once a field loses focus, in case the user was mid-edit.
    try { doc.addEventListener('focusout', collectInputs, true); } catch { /* ignore */ }
    if (doSearchField) {
      try {
        doc.addEventListener('keydown', onSubmitKey, true);
        doc.addEventListener('click', onSubmitClick, true);
      } catch { /* ignore */ }
    }

    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList') {
          for (const added of record.addedNodes) pending.add(added);
        } else if (record.type === 'attributes') {
          pendingAttrs.add(record.target as Element);
        } else {
          pending.add(record.target);
        }
      }
      if (pending.size > 0 || pendingAttrs.size > 0) flush();
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      ...(doAttributes ? { attributes: true, attributeFilter: [...ATTRS] } : {}),
    });
    counters.hookInstalled = true;
  }

  try {
    start();
  } catch {
    counters.hookInstalled = false;
  }

  return {
    rescan() {
      // Fields first get Google's text back, so the new rules see the real
      // value rather than a rename made under the old ones.
      for (const el of inputs) {
        const original = inputOriginal.get(el);
        if (original !== undefined && doc.activeElement !== el && alreadyOurs(el, '#value', el.value)) el.value = original;
      }
      // The config changed, so what we wrote before is no longer authoritative.
      // A WeakMap cannot be cleared, so swap in a fresh one to force every node
      // to be re-examined against the new rules.
      written = new WeakMap();
      inputWrites = new WeakMap();
      pending.clear();
      pendingAttrs.clear();
      try { walk(doc.documentElement); } catch { /* ignore */ }
      collectInputs();
    },
    disconnect() {
      try { observer?.disconnect(); } catch { /* ignore */ }
      try { doc.removeEventListener('focusout', collectInputs, true); } catch { /* ignore */ }
      try {
        doc.removeEventListener('keydown', onSubmitKey, true);
        doc.removeEventListener('click', onSubmitClick, true);
      } catch { /* ignore */ }
      observer = null;
    },
  };
}
