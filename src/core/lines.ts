import type { CompiledSubstitution } from './types.ts';

/**
 * Map labels are wrapped into lines *before* they reach us, and each line is
 * decoded separately — "Gulf of America" arrives as "Gulf of" then "America",
 * a few unrelated decodes apart and in either order. So a whole-string match
 * only fires for labels that fit on one line; wrapped ones need the differing
 * line rewritten, gated on having recently seen one of the name's other lines.
 */
export interface LineRule {
  /** The decoded fragment to replace. */
  token: string;
  /** What to return instead. */
  to: string;
  /** At least one of these must have been decoded recently for this to apply. */
  context: string[];
  ruleId: string;
}

/** Tokens too generic to identify a name on their own. */
const WEAK = new Set(['of', 'the', 'de', 'la', 'du', 'des', 'del', 'di', 'da', 'el', 'y', 'a']);

function tokens(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Reduce a substitution to the single line that differs, when exactly one does.
 * Returns null when the change is not a one-line edit, in which case only the
 * whole-string form is usable.
 */
export function deriveLineRule(sub: CompiledSubstitution): LineRule | null {
  const from = tokens(sub.from);
  const to = tokens(sub.to);
  if (from.length === 0 || to.length === 0) return null;

  let prefix = 0;
  while (prefix < from.length && prefix < to.length && from[prefix] === to[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < from.length - prefix
    && suffix < to.length - prefix
    && from[from.length - 1 - suffix] === to[to.length - 1 - suffix]
  ) suffix++;

  // Exactly one token differs on each side, and something is left to anchor on.
  if (from.length - prefix - suffix !== 1 || to.length - prefix - suffix !== 1) return null;
  const head = from.slice(0, prefix);
  const tail = from.slice(from.length - suffix);
  const anchors = [...head, ...tail];
  if (anchors.length === 0) return null;

  // Accept either the joined run (how a wrapped line actually looks) or a
  // distinctive single token.
  const context = new Set<string>();
  if (head.length > 0) context.add(head.join(' '));
  if (tail.length > 0) context.add(tail.join(' '));
  for (const t of anchors) if (!WEAK.has(t.toLowerCase()) && t.length > 2) context.add(t);
  if (context.size === 0) return null;

  return {
    token: from[prefix]!,
    to: to[prefix]!,
    context: [...context],
    ruleId: sub.ruleId,
  };
}

export interface LineMatcher {
  /**
   * Feed every decoded string through this; returns the text to render.
   *
   * Pass `useContext: false` for a decoder that reads each label's lines
   * bottom-up, as the renderer does. The line before "America" there belongs
   * to some other label, often a lake's "Lake", so only whole-label matches
   * are safe.
   */
  substitute(text: string, useContext?: boolean): string;
  /** Whether `text` is a line that only its neighbouring line can rename. */
  needsContext(text: string): boolean;
  readonly substitutions: number;
  readonly whole: number;
  readonly lines: number;
}

/**
 * How many decodes back a context line still counts. Observed gaps between the
 * two lines of one label are ~3; keeping this tight limits the chance that an
 * unrelated label (say "Lake Charles") supplies a false anchor.
 */
export const CONTEXT_WINDOW = 5;

export function createLineMatcher(subs: readonly CompiledSubstitution[]): LineMatcher {
  const whole = new Map<string, string>();
  const byToken = new Map<string, LineRule[]>();

  for (const sub of subs) {
    if (!whole.has(sub.from)) whole.set(sub.from, sub.to);
    const line = deriveLineRule(sub);
    if (!line) continue;
    let bucket = byToken.get(line.token);
    if (!bucket) byToken.set(line.token, (bucket = []));
    bucket.push(line);
  }

  const recent: string[] = [];
  let substitutions = 0;
  let wholeHits = 0;
  let lineHits = 0;

  function remember(text: string): void {
    recent.push(text);
    if (recent.length > CONTEXT_WINDOW) recent.shift();
  }

  function substitute(text: string, useContext = true): string {
    const direct = whole.get(text);
    if (direct !== undefined) {
      remember(text);
      substitutions++;
      wholeHits++;
      return direct;
    }

    const candidates = useContext ? byToken.get(text) : undefined;
    if (candidates !== undefined) {
      // When several names share a differing token, the most recent anchor wins.
      let best: LineRule | undefined;
      let bestAt = -1;
      for (const rule of candidates) {
        for (let i = recent.length - 1; i > bestAt; i--) {
          if (rule.context.includes(recent[i]!)) {
            if (i > bestAt) { bestAt = i; best = rule; }
            break;
          }
        }
      }

      if (best !== undefined) {
        remember(text);
        substitutions++;
        lineHits++;
        return best.to;
      }
    }

    remember(text);
    return text;
  }

  return {
    substitute,
    needsContext: (text) => byToken.has(text),
    get substitutions() { return substitutions; },
    get whole() { return wholeHits; },
    get lines() { return lineHits; },
  };
}


/**
 * Cross-context resolution store. Two Maps workers both decode every label line,
 * but only one decodes them with the surrounding lines available; the other sees
 * a bare token like "America" and cannot tell "Gulf of America" from
 * "North America". The worker that resolves a token with context publishes the
 * result here for the other to apply. Pure and synchronous — the transport
 * (a BroadcastChannel) lives in the worker runtime.
 */
export interface ResolutionStore {
  /** Record that `text` was resolved to `to` (by a context-aware decode). Last write wins. */
  publish(text: string, to: string): void;
  /** Apply a previously published resolution, or return the input unchanged. */
  apply(text: string): string;
  /** Whether a resolution exists (and actually changes the text). */
  has(text: string): boolean;
  /** Every resolution, for handing to a worker that starts later. */
  entries(): [string, string][];
  clear(): void;
}

export function createResolutionStore(): ResolutionStore {
  const map = new Map<string, string>();
  return {
    publish(text, to) {
      if (!text || !to || text === to) return;
      map.set(text, to);
    },
    apply(text) { const to = map.get(text); return to !== undefined ? to : text; },
    has(text) { const to = map.get(text); return to !== undefined && to !== text; },
    entries() { return [...map.entries()]; },
    clear() { map.clear(); },
  };
}


/**
 * Decides when to rebuild the renderer, the only way to change a label it has
 * already drawn. The renderer draws a shared word ("America") as whatever the
 * labeler had resolved it to at the time, and keeps that drawing. So the
 * planner compares what each renderer drew with what the labeler resolves the
 * word to now. When they differ (the user has moved from one of the places
 * sharing the word to the other) it asks for a rebuild, and while a guard says
 * not yet, it waits rather than dropping the rebuild. The guards:
 *  - a rebuild that did not fix the map is not repeated until the view
 *    changes, because with both places on screen one label is wrong whichever
 *    way the word is drawn;
 *  - rebuilds are spaced out, so a new renderer has started before it is judged;
 *  - a page gets a generous but finite number of them.
 */
export interface RepairPlanner {
  /** A decoder that sees each label's lines in order resolved `text` to `to`. */
  resolved(text: string, to: string): void;
  /** Renderer `source` drew `text` as `value`. */
  drawn(source: string, text: string, value: string): void;
  /** What to do now, given the map's current view (null when it is not known). */
  decide(now: number, view: string | null): RepairDecision;
  /** A rebuild for a mismatch went out at `view`. */
  repaired(now: number, view: string | null): void;
  /** The renderers seen so far are being replaced (any rebuild, including one for new rules). */
  replaced(now: number): void;
  /** The rules changed: nothing resolved or drawn so far still counts. */
  reset(): void;
}

export type RepairDecision =
  /** Every drawn word matches its current resolution. */
  | { action: 'none' }
  | { action: 'repair' }
  | { action: 'wait'; ms: number }
  /**
   * A word is drawn wrong and a rebuild here would not fix it. `recheck` is
   * true while one might, once the view moves.
   */
  | { action: 'contested'; recheck: boolean };

export function createRepairPlanner(options?: { minGapMs?: number; maxRepairs?: number }): RepairPlanner {
  const minGapMs = options?.minGapMs ?? 2500;
  const maxRepairs = options?.maxRepairs ?? 20;
  const wanted = new Map<string, string>();
  const drawnBy = new Map<string, Map<string, string>>();
  // Renderers a rebuild replaced; a report they sent before dying may still arrive.
  const retired = new Set<string>();
  let lastRepairAt = -Infinity;
  // The view of the last rebuild, until the map is seen to match again.
  let unfixedView: string | null | undefined;
  let repairs = 0;

  function stale(): boolean {
    for (const drawn of drawnBy.values()) {
      for (const [text, value] of drawn) {
        const want = wanted.get(text);
        if (want !== undefined && want !== value) return true;
      }
    }
    return false;
  }

  function replaced(now: number): void {
    lastRepairAt = now;
    for (const source of drawnBy.keys()) retired.add(source);
    drawnBy.clear();
  }

  return {
    resolved(text, to) { wanted.set(text, to); },
    drawn(source, text, value) {
      if (retired.has(source)) return;
      let drawn = drawnBy.get(source);
      if (!drawn) drawnBy.set(source, (drawn = new Map()));
      drawn.set(text, value);
    },
    decide(now, view) {
      if (!stale()) {
        unfixedView = undefined;
        return { action: 'none' };
      }
      if (repairs >= maxRepairs) return { action: 'contested', recheck: false };
      if (view === unfixedView) return { action: 'contested', recheck: true };
      const since = now - lastRepairAt;
      if (since < minGapMs) return { action: 'wait', ms: minGapMs - since };
      return { action: 'repair' };
    },
    repaired(now, view) {
      replaced(now);
      unfixedView = view;
      repairs++;
    },
    replaced,
    reset() {
      wanted.clear();
      drawnBy.clear();
      unfixedView = undefined;
    },
  };
}
