import type { CompiledSubstitution, Rule, Substitution } from './types.ts';

/**
 * Does a substitution's locale apply to the page's locale?
 * "*" matches anything; "en" matches "en" and "en-US" but not "eng" or "es".
 */
export function localeMatches(subLocale: string, pageLocale: string): boolean {
  if (subLocale === '*' || !subLocale) return true;
  if (!pageLocale) return false;
  const want = subLocale.toLowerCase();
  const have = pageLocale.toLowerCase();
  return have === want || have.startsWith(want + '-');
}

/**
 * Flatten enabled rules into a match list for the given page locale.
 *
 * Sorted by descending `from` length. This is what stops the compound form
 * ("X (Y)") being clobbered by the bare form and producing "X (X)".
 * `Array.sort` is stable, so equal-length entries keep config order.
 */
export interface CompileOptions {
  /**
   * Also match the all-capitals form of each name. Maps sets states, countries
   * and regions in capitals on the map itself ("FLORIDA"), so a rename written
   * the way the sidebar shows it would otherwise miss the label. On by
   * default; off for the reverse table, which wants one entry per name.
   */
  uppercaseVariants?: boolean;
}

export function compile(rules: readonly Rule[], pageLocale: string, options?: CompileOptions): CompiledSubstitution[] {
  const out: CompiledSubstitution[] = [];
  for (const rule of rules ?? []) {
    if (!rule || rule.enabled === false || !Array.isArray(rule.substitutions)) continue;
    for (const sub of rule.substitutions) {
      if (!sub || typeof sub.from !== 'string' || typeof sub.to !== 'string') continue;
      if (sub.from === '' || sub.from === sub.to) continue;
      if (!localeMatches(sub.locale, pageLocale)) continue;
      out.push({ from: sub.from, to: sub.to, locale: sub.locale, ruleId: rule.id });
    }
  }
  if (options?.uppercaseVariants !== false) {
    // Derived after everything the user wrote, so a capitals form they listed
    // themselves is never displaced by one made up from another entry.
    const listed = new Set(out.map((s) => `${s.locale}\u0000${s.from}`));
    for (const sub of [...out]) {
      const upper = sub.from.toUpperCase();
      // Only where capitals are a different spelling: scripts without case,
      // and names already in capitals, get nothing extra.
      if (upper === sub.from || upper.toLowerCase() !== sub.from.toLowerCase()) continue;
      const key = `${sub.locale}\u0000${upper}`;
      if (listed.has(key)) continue;
      listed.add(key);
      out.push({ from: upper, to: sub.to.toUpperCase(), locale: sub.locale, ruleId: sub.ruleId });
    }
  }
  return out.sort((a, b) => b.from.length - a.from.length);
}

/**
 * Merge shipped defaults into a user's saved rules without clobbering their
 * edits. `removedIds` are shipped rules the user deleted — without the
 * tombstones, deleting a shipped rule would only last until the next merge.
 */
export function mergeDefaults(
  userRules: readonly Rule[],
  defaultRules: readonly Rule[],
  removedIds: readonly string[] = [],
): Rule[] {
  const merged = userRules.map((r) => ({ ...r }));
  const seen = new Set(merged.map((r) => r.id));
  const removed = new Set(removedIds);
  for (const def of defaultRules) {
    if (!seen.has(def.id) && !removed.has(def.id)) merged.push({ ...def });
  }
  return merged;
}

/**
 * The renames turned around, for mapping what the user typed back to the name
 * Google knows. One entry per renamed text: where several originals share a
 * rename (the bare and compound forms of the shipped rules), the shortest
 * original is the one to search for. Longest-first, like `compile`.
 */
export function reverseSubs(subs: readonly CompiledSubstitution[]): CompiledSubstitution[] {
  const shortest = new Map<string, CompiledSubstitution>();
  for (const sub of subs) {
    if (sub.to === '' || sub.to === sub.from) continue;
    const held = shortest.get(sub.to);
    if (!held || sub.from.length < held.from.length) shortest.set(sub.to, sub);
  }
  return [...shortest.values()]
    .map((sub) => ({ from: sub.to, to: sub.from, locale: sub.locale, ruleId: sub.ruleId }))
    .sort((a, b) => b.from.length - a.from.length);
}

/**
 * Why a rules file was rejected. `code` and `params` let a UI phrase it in the
 * user's language; `error` is the same thing in English for logs and tests.
 */
export const RULE_ERROR_CODES = [
  'notObject', 'missingRules', 'ruleNotObject', 'ruleNeedsId', 'duplicateId',
  'ruleNeedsRenames', 'renameNotObject', 'renameNeedsText',
] as const;
export type RuleErrorCode = (typeof RULE_ERROR_CODES)[number];
export interface RuleError { ok: false; code: RuleErrorCode; params: string[]; error: string }

function reject(code: RuleErrorCode, params: string[], error: string): RuleError {
  return { ok: false, code, params, error };
}

/** Reject structurally invalid imported config before it reaches storage. */
export function validateRules(value: unknown): { ok: true; rules: Rule[] } | RuleError {
  if (!value || typeof value !== 'object') return reject('notObject', [], 'Not an object.');
  const raw = (value as { rules?: unknown }).rules;
  if (!Array.isArray(raw)) return reject('missingRules', [], 'Missing a "rules" array.');
  const rules: Rule[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Partial<Rule>;
    const nth = String(i + 1);
    if (!r || typeof r !== 'object') return reject('ruleNotObject', [nth], `Place ${nth} is not an object.`);
    if (typeof r.id !== 'string' || !r.id.trim()) return reject('ruleNeedsId', [nth], `Place ${nth} needs an id.`);
    if (ids.has(r.id)) return reject('duplicateId', [r.id], `Two places share the id "${r.id}".`);
    ids.add(r.id);
    if (!Array.isArray(r.substitutions)) {
      return reject('ruleNeedsRenames', [r.id], `Place "${r.id}" needs a "substitutions" list.`);
    }
    const subs = [];
    for (let j = 0; j < r.substitutions.length; j++) {
      const s = r.substitutions[j] as Partial<Substitution>;
      const jth = String(j + 1);
      if (!s || typeof s !== 'object') {
        return reject('renameNotObject', [r.id, jth], `Rename ${jth} in "${r.id}" is not an object.`);
      }
      if (typeof s.from !== 'string' || typeof s.to !== 'string') {
        return reject('renameNeedsText', [r.id, jth], `Rename ${jth} in "${r.id}" needs "from" and "to" text.`);
      }
      subs.push({ locale: typeof s.locale === 'string' && s.locale ? s.locale : '*', from: s.from, to: s.to });
    }
    rules.push({
      id: r.id,
      enabled: r.enabled !== false,
      description: typeof r.description === 'string' ? r.description : undefined,
      note: typeof r.note === 'string' ? r.note : undefined,
      substitutions: subs,
    });
  }
  return { ok: true, rules };
}
