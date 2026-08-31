import type { CompiledSubstitution } from './types.ts';

export interface SubstituteResult {
  text: string;
  changed: boolean;
  /** How many replacements were made in this string. */
  matches: number;
}

export interface Matcher {
  substitute(text: string): SubstituteResult;
  /** Number of active substitutions. Zero means the matcher is a no-op. */
  readonly size: number;
}

const NO_MATCH = (text: string): SubstituteResult => ({ text, changed: false, matches: 0 });

/**
 * Build a matcher over an already-compiled, longest-first substitution list.
 *
 * Matching is a single left-to-right pass that takes the longest substitution
 * matching at each position, then resumes *after* the replacement. Replaced
 * text is never re-examined, so a rule whose output contains another rule's
 * input cannot cascade, and the compound-form case from design §6 is handled
 * structurally rather than by hoping the config is ordered correctly.
 *
 * Matching is literal and case-sensitive: place names are proper nouns, and a
 * case-insensitive match risks rewriting unrelated prose.
 */
export function createMatcher(subs: readonly CompiledSubstitution[]): Matcher {
  // Bucket by first character so the common case (no match here) is one Map hit.
  const byFirstChar = new Map<string, CompiledSubstitution[]>();
  for (const sub of subs) {
    const head = sub.from[0]!;
    let bucket = byFirstChar.get(head);
    if (!bucket) byFirstChar.set(head, (bucket = []));
    bucket.push(sub); // inherits the caller's longest-first order
  }

  function substitute(text: string): SubstituteResult {
    if (!text || byFirstChar.size === 0) return NO_MATCH(text);

    let out: string | null = null;
    let cursor = 0; // start of the not-yet-copied tail
    let i = 0;
    let matches = 0;
    const n = text.length;

    while (i < n) {
      const bucket = byFirstChar.get(text[i]!);
      if (bucket !== undefined) {
        let hit: CompiledSubstitution | undefined;
        for (const sub of bucket) {
          if (text.startsWith(sub.from, i)) { hit = sub; break; }
        }
        if (hit !== undefined) {
          if (out === null) out = '';
          out += text.slice(cursor, i) + hit.to;
          i += hit.from.length;
          cursor = i;
          matches++;
          continue;
        }
      }
      i++;
    }

    if (out === null) return NO_MATCH(text);
    out += text.slice(cursor);
    return { text: out, changed: out !== text, matches };
  }

  return { substitute, size: subs.length };
}

/** Convenience wrapper for one-off use and tests. */
export function substitute(text: string, subs: readonly CompiledSubstitution[]): SubstituteResult {
  return createMatcher(subs).substitute(text);
}
