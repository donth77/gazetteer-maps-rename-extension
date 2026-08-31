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
 * ("X (Y)") being clobbered by the bare form and producing "X (X)" — see
 * design §6. `Array.sort` is stable, so equal-length entries keep config order.
 */
export function compile(rules: readonly Rule[], pageLocale: string): CompiledSubstitution[] {
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

/** Reject structurally invalid imported config before it reaches storage. */
export function validateRules(value: unknown): { ok: true; rules: Rule[] } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Not an object.' };
  const raw = (value as { rules?: unknown }).rules;
  if (!Array.isArray(raw)) return { ok: false, error: 'Missing a "rules" array.' };
  const rules: Rule[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Partial<Rule>;
    if (!r || typeof r !== 'object') return { ok: false, error: `rules[${i}] is not an object.` };
    if (typeof r.id !== 'string' || !r.id.trim()) return { ok: false, error: `rules[${i}] needs a non-empty string id.` };
    if (ids.has(r.id)) return { ok: false, error: `Duplicate rule id "${r.id}".` };
    ids.add(r.id);
    if (!Array.isArray(r.substitutions)) return { ok: false, error: `rules[${i}] ("${r.id}") needs a substitutions array.` };
    const subs = [];
    for (let j = 0; j < r.substitutions.length; j++) {
      const s = r.substitutions[j] as Partial<Substitution>;
      if (!s || typeof s !== 'object') return { ok: false, error: `${r.id}.substitutions[${j}] is not an object.` };
      if (typeof s.from !== 'string' || typeof s.to !== 'string') {
        return { ok: false, error: `${r.id}.substitutions[${j}] needs string "from" and "to".` };
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
