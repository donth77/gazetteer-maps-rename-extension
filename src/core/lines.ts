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

/**
 * Optional order-independent context check. The two lines of one label are
 * separate allocations a few hundred bytes apart in the same buffer, so when the
 * lines arrive in the wrong order — which happens — asking whether an anchor
 * sits near this decode recovers the pairing that the recency window misses.
 */
export type NearbyProbe = (needle: string) => boolean;

export interface LineMatcher {
  /** Feed every decoded string through this; returns the text to render. */
  substitute(text: string, nearby?: NearbyProbe): string;
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

  function substitute(text: string, nearby?: NearbyProbe): string {
    const direct = whole.get(text);
    if (direct !== undefined) {
      remember(text);
      substitutions++;
      wholeHits++;
      return direct;
    }

    const candidates = byToken.get(text);
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
      // Fall back to the buffer probe when recency found nothing — this is the
      // reverse-order case, where the anchor has not been decoded yet.
      if (best === undefined && nearby !== undefined) {
        for (const rule of candidates) {
          let matched = false;
          for (const anchor of rule.context) {
            try { matched = nearby(anchor); } catch { matched = false; }
            if (matched) break;
          }
          if (matched) { best = rule; break; }
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
  /**
   * Record that `text` was resolved to `to` (by a context-aware decode).
   * Returns true when this overwrote a different resolution for the same text —
   * the signal that two rules' labels are colliding on a shared word, at which
   * point anything already rendered from the old value is stale beyond reach.
   */
  publish(text: string, to: string): boolean;
  /** Apply a previously published resolution, or return the input unchanged. */
  apply(text: string): string;
  /** Whether a resolution exists (and actually changes the text). */
  has(text: string): boolean;
  clear(): void;
}

export function createResolutionStore(): ResolutionStore {
  const map = new Map<string, string>();
  return {
    publish(text, to) {
      if (!text || !to || text === to) return false;
      const previous = map.get(text);
      map.set(text, to);
      return previous !== undefined && previous !== to;
    },
    apply(text) { const to = map.get(text); return to !== undefined ? to : text; },
    has(text) { const to = map.get(text); return to !== undefined && to !== text; },
    clear() { map.clear(); },
  };
}


/**
 * Decides whether a label-collision repair (a renderer rebuild) may run.
 * Two guards keep it from thrashing:
 *  - the overwritten resolution must have stood a few seconds (a rapid
 *    flip-flop means both places are on screen at once, genuinely ambiguous,
 *    where a rebuild would just re-poison one of them);
 *  - repairs are rate-limited and capped per page.
 */
export interface RepairGovernor {
  /** Record that `text` resolved (to anything) at `now`; returns the previous time. */
  touch(text: string, now: number): number;
  /** May a repair run for a collision whose previous value was set at `prevAt`? */
  allow(prevAt: number, now: number): boolean;
}

export function createRepairGovernor(options?: {
  minStableMs?: number;
  cooldownMs?: number;
  maxRepairs?: number;
}): RepairGovernor {
  const minStableMs = options?.minStableMs ?? 4000;
  const cooldownMs = options?.cooldownMs ?? 45000;
  const maxRepairs = options?.maxRepairs ?? 3;
  const touched = new Map<string, number>();
  let lastRepairAt = -Infinity;
  let repairs = 0;
  return {
    touch(text, now) {
      const prev = touched.get(text) ?? 0;
      touched.set(text, now);
      return prev;
    },
    allow(prevAt, now) {
      if (repairs >= maxRepairs) return false;
      if (now - lastRepairAt < cooldownMs) return false;
      if (prevAt <= 0 || now - prevAt < minStableMs) return false;
      lastRepairAt = now;
      repairs++;
      return true;
    },
  };
}
