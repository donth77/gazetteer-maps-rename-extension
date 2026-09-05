/**
 * Shared types. Pure data — no browser, no DOM, no I/O.
 */

/** One observed string and its replacement, scoped to a language. */
export interface Substitution {
  /** BCP-47 language subtag, or "*" to match any language. */
  locale: string;
  /** The string as Google renders it. Matched literally, case-sensitively. */
  from: string;
  /** What to render instead. */
  to: string;
}

/** A user-togglable group of substitutions covering one place. */
export interface Rule {
  id: string;
  enabled: boolean;
  description?: string;
  /** Maintainer note — shown in the options UI, never matched against. */
  note?: string;
  substitutions: Substitution[];
}

export interface RuleSet {
  version: number;
  rules: Rule[];
}

/** A substitution flattened out of its rule, ready for the matcher. */
export interface CompiledSubstitution {
  from: string;
  to: string;
  locale: string;
  ruleId: string;
}

/**
 * Per-hook instrumentation. The health check asserts against these
 * rather than against pixels.
 */
export interface Counters {
  hookInstalled: boolean;
  callsObserved: number;
  matchesFound: number;
  substitutionsMade: number;
  lastSubstitutionAt: number | null;
}
