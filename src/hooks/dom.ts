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
 * is live form state, handled separately below.
 */
const ATTRS = ['aria-label', 'title', 'alt'] as const;

export interface DomHookOptions {
  matcher: Matcher;
  counters: Counters;
  doc?: Document;
  /** Also rewrite aria-label/title/alt. Default true. */
  attributes?: boolean;
  /**
   * The renames turned around, applied to what the user typed when a search
   * is submitted, so "hotels near Gulf of Bananas" asks Google about the
   * place it knows by another name. Without it only the box's own rewritten
   * value is reversed.
   */
  reverse?: Matcher;
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
  const reverse = options.reverse ?? null;

  /**
   * What *we* wrote for a given node+key, and what Google had put there. Our
   * own writes re-enter the MutationObserver; without the memo, a rule whose
   * output feeds another rule would cascade across observer ticks, defeating
   * the engine's single-pass guarantee. The original is kept so a rules
   * change can start over from Google's text rather than from a rename made
   * under the old rules, and so a search can be sent the name Google knows.
   */
  interface Written { wrote: string; original: string }
  const written = new WeakMap<Node, Map<string, Written>>();
  /** While a rescan runs, rewritten text is re-derived from its original. */
  let rescanning = false;

  /**
   * If Maps keeps resetting a field, stop fighting it rather than loop forever.
   * The bound is on writes in quick succession: a write war is many per
   * second, while one search box legitimately gets a write per search for
   * the whole session.
   */
  const MAX_INPUT_WRITES = 3;
  const INPUT_WRITE_WINDOW_MS = 1000;
  let inputWrites = new WeakMap<Element, { count: number; at: number }>();

  function memoOf(node: Node, key: string): Written | undefined {
    return written.get(node)?.get(key);
  }

  function remember(node: Node, key: string, wrote: string, original: string): void {
    let m = written.get(node);
    if (!m) written.set(node, (m = new Map()));
    m.set(key, { wrote, original });
  }

  function forget(node: Node, key: string): void {
    written.get(node)?.delete(key);
  }

  /**
   * The text to run the rules over, or null when there is nothing to do.
   * Text we wrote ourselves is left alone, except during a rescan, when it
   * stands in for the original it was made from.
   */
  function source(node: Node, key: string, current: string): string | null {
    if (!current) return null;
    const memo = memoOf(node, key);
    if (memo === undefined || memo.wrote !== current) return current;
    return rescanning ? memo.original : null;
  }

  function apply(node: Node, key: string, current: string, write: (next: string) => void): void {
    const text = source(node, key, current);
    if (text === null) return;
    counters.callsObserved++;
    const result = matcher.substitute(text);
    if (result.matches > 0) counters.matchesFound += result.matches;
    if (!result.changed) {
      // The new rules leave this text alone; put Google's back if ours is showing.
      if (text !== current) { write(text); forget(node, key); }
      return;
    }
    if (result.text === current) return; // same rename under the new rules
    write(result.text);
    remember(node, key, result.text, text);
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
   * Search-box text. The value is live form state that Maps may own through
   * a framework, so it is handled with more care than a label: skipped while
   * focused so typing is never clobbered, bounded so a framework that resets
   * the value cannot start a write war, and only for text inputs.
   */
  function processInput(el: HTMLInputElement): void {
    if (el.type && el.type !== 'text' && el.type !== 'search') return;
    if (doc.activeElement === el) return;
    const now = Date.now();
    const recent = inputWrites.get(el);
    const attempts = recent && now - recent.at < INPUT_WRITE_WINDOW_MS ? recent.count : 0;
    if (attempts >= MAX_INPUT_WRITES) return;
    const value = el.value;
    const text = source(el, '#value', value);
    if (text === null) return;
    counters.callsObserved++;
    const result = matcher.substitute(text);
    if (result.matches > 0) counters.matchesFound += result.matches;
    if (!result.changed) {
      if (text !== value) { el.value = text; forget(el, '#value'); }
      return;
    }
    if (result.text === value) return;
    el.value = result.text;
    remember(el, '#value', result.text, text);
    inputWrites.set(el, { count: attempts + 1, at: now });
    counters.substitutionsMade++;
    counters.lastSubstitutionAt = now;
  }

  /**
   * Searching. Maps reads the box while it handles the Enter key or the search
   * button, synchronously, and it only knows its own name for a place; a
   * renamed one, invented or not, would be searched for as typed and find
   * nothing. So for that one dispatch the box holds the name Google knows,
   * and has the user's text back before anything paints. A value this hook
   * wrote goes back to exactly what Maps put there; anything typed is run
   * through the reversed renames.
   */
  function revealForSubmit(el: HTMLInputElement): void {
    const shown = el.value;
    let query: string | null = null;
    const memo = memoOf(el, '#value');
    if (memo !== undefined && memo.wrote === shown) {
      query = memo.original;
    } else if (reverse !== null) {
      const result = reverse.substitute(shown);
      if (result.changed) query = result.text;
    }
    if (query === null) return;
    el.value = query;
    setTimeout(() => { if (el.value === query) el.value = shown; }, 0);
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
    if (el.tagName === 'INPUT') inputs.add(el as HTMLInputElement);
    processElement(el);
  }

  function collectInputs(): void {
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
    try {
      doc.addEventListener('keydown', onSubmitKey, true);
      doc.addEventListener('click', onSubmitClick, true);
    } catch { /* ignore */ }

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
      // The config changed: every text we rewrote is re-derived from the
      // original Google gave us, so a rename made under the old rules
      // cannot survive, or hide the text from the new ones.
      inputWrites = new WeakMap();
      pending.clear();
      pendingAttrs.clear();
      rescanning = true;
      try { walk(doc.documentElement); } catch { /* ignore */ }
      try { collectInputs(); } catch { /* ignore */ }
      rescanning = false;
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
