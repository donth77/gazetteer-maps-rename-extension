import type { Counters } from './types.ts';

export function createCounters(): Counters {
  return {
    hookInstalled: false,
    callsObserved: 0,
    matchesFound: 0,
    substitutionsMade: 0,
    lastSubstitutionAt: null,
  };
}

/**
 * Collapse a set of hook counters into the four states the health check
 * distinguishes. INFRA_ERROR is decided by the caller, not here —
 * this function only sees what the hooks reported.
 */
export type HealthState = 'OK' | 'HOOK_NOT_INSTALLED' | 'INSTALLED_NO_MATCH';

export function healthOf(counters: Counters): HealthState {
  if (!counters.hookInstalled) return 'HOOK_NOT_INSTALLED';
  if (counters.substitutionsMade > 0) return 'OK';
  return 'INSTALLED_NO_MATCH';
}

export function sumCounters(all: Counters[]): Counters {
  return all.reduce<Counters>((acc, c) => ({
    hookInstalled: acc.hookInstalled || c.hookInstalled,
    callsObserved: acc.callsObserved + c.callsObserved,
    matchesFound: acc.matchesFound + c.matchesFound,
    substitutionsMade: acc.substitutionsMade + c.substitutionsMade,
    lastSubstitutionAt: Math.max(acc.lastSubstitutionAt ?? 0, c.lastSubstitutionAt ?? 0) || null,
  }), createCounters());
}
