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
 * A match must not sit inside a longer word: "Gulf of America" has to leave
 * "Gulf of American Shrimp Co" alone. Only scripts that separate words with
 * spaces get this check. In Chinese, Japanese, Korean or Thai the neighbouring
 * character is routinely a letter, and the rule would block every rename.
 */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && LETTER_OR_DIGIT.test(ch) && !UNSPACED.test(ch);
}

function charAt(text: string, index: number): string | undefined {
  const cp = text.codePointAt(index);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

function charBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const unit = text.charCodeAt(index - 1);
  const isLowSurrogate = unit >= 0xdc00 && unit <= 0xdfff;
  return charAt(text, isLowSurrogate && index >= 2 ? index - 2 : index - 1);
}

interface Candidate {
  sub: CompiledSubstitution;
  /** Whether the match's first/last character is itself a word character. */
  headWord: boolean;
  tailWord: boolean;
}

/**
 * Build a matcher over an already-compiled, longest-first substitution list.
 *
 * Matching is a single left-to-right pass that takes the longest substitution
 * matching at each position, then resumes *after* the replacement. Replaced
 * text is never re-examined, so a rule whose output contains another rule's
 * input cannot cascade, and the compound form ("Gulf of Mexico (Gulf of
 * America)") is handled structurally rather than by hoping the config is
 * ordered correctly.
 *
 * Matching is literal and case-sensitive: place names are proper nouns, and a
 * case-insensitive match risks rewriting unrelated prose.
 */
export function createMatcher(subs: readonly CompiledSubstitution[]): Matcher {
  // Bucket by first character so the common case (no match here) is one Map hit.
  const byFirstChar = new Map<string, Candidate[]>();
  for (const sub of subs) {
    const head = sub.from[0]!;
    let bucket = byFirstChar.get(head);
    if (!bucket) byFirstChar.set(head, (bucket = []));
    bucket.push({ // inherits the caller's longest-first order
      sub,
      headWord: isWordChar(charAt(sub.from, 0)),
      tailWord: isWordChar(charBefore(sub.from, sub.from.length)),
    });
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
        for (const { sub, headWord, tailWord } of bucket) {
          if (!text.startsWith(sub.from, i)) continue;
          const end = i + sub.from.length;
          if (headWord && isWordChar(charBefore(text, i))) continue;
          if (tailWord && end < n && isWordChar(charAt(text, end))) continue;
          hit = sub;
          break;
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
