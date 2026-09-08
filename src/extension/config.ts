import shipped from '../../data/names.json' with { type: 'json' };
import { validateRules } from '../core/rules.ts';
import type { Rule } from '../core/types.ts';

export const STORAGE_KEY = 'gazetteer.config';

export interface GazetteerConfig {
  /** Config-shape version, for one-time default migrations on update. */
  v?: number;
  /** Master switch. Off means every hook becomes a no-op. */
  enabled: boolean;
  /**
   * Rewrite the search box too. On by default: Maps fills it with the served
   * name, which otherwise sits at the top of the screen looking unfixed. The
   * trade: re-running a query Maps filled in searches for the renamed text.
   * Never touched while focused.
   */
  /**
   * While the vector map boots, Maps paints server-rendered raster tiles with
   * the served names baked into the pixels — nothing client-side can rewrite
   * them. When on (default), those preview tiles are suppressed so the first
   * label you see is the corrected one. Only applies when WebGL is available,
   * because without it the rasters are the only map there is.
   */
  suppressRasterPreview: boolean;
  /** Shipped rules the user deleted; update-time merging must not resurrect them. */
  removedDefaults?: string[];
  /** Page languages whose translated forms have already been offered. */
  localesAdded?: string[];
  rules: Rule[];
}

/**
 * Storage area is deliberately `local`, never `sync`: syncing config is a
 * non-goal, and `chrome.storage.sync` would upload the user's config to
 * Google. The privacy claim is "it talks to nothing" — keep it true.
 */
const area = () => chrome.storage.local;

export function defaultRules(): Rule[] {
  const parsed = validateRules(shipped);
  return parsed.ok ? parsed.rules : [];
}

export function defaultConfig(): GazetteerConfig {
  return { v: 2, enabled: true, suppressRasterPreview: true, removedDefaults: [], localesAdded: [], rules: defaultRules() };
}

export async function loadConfig(): Promise<GazetteerConfig> {
  try {
    const stored = await area().get(STORAGE_KEY);
    const raw = stored?.[STORAGE_KEY] as Partial<GazetteerConfig> | undefined;
    if (!raw) return defaultConfig();
    return {
      v: typeof raw.v === 'number' ? raw.v : 1,
      enabled: raw.enabled !== false,
      suppressRasterPreview: raw.suppressRasterPreview !== false,
      removedDefaults: Array.isArray(raw.removedDefaults)
        ? raw.removedDefaults.filter((x): x is string => typeof x === 'string')
        : [],
      localesAdded: Array.isArray(raw.localesAdded)
        ? raw.localesAdded.filter((x): x is string => typeof x === 'string')
        : [],
      // Deliberately no default-merging here: new shipped rules are merged once
      // per update by the background worker, so deleting a rule sticks.
      rules: salvageRules(raw.rules),
    };
  } catch {
    return defaultConfig();
  }
}

/**
 * Stored rules are read leniently: one damaged entry (a future schema change,
 * a rolled-back version) must not empty the table, because the next save from
 * any surface would then persist that emptiness.
 */
export function salvageRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) return [];
  const whole = validateRules({ rules: raw });
  if (whole.ok) return whole.rules;
  const rules: Rule[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    const one = validateRules({ rules: [entry] });
    if (!one.ok || ids.has(one.rules[0]!.id)) continue;
    ids.add(one.rules[0]!.id);
    rules.push(one.rules[0]!);
  }
  return rules;
}

export async function saveConfig(config: GazetteerConfig): Promise<void> {
  await area().set({ [STORAGE_KEY]: config });
}

/**
 * Fires whenever any surface (options, popup, another tab) rewrites the config.
 * `stored` is the value exactly as written, for callers that need to tell
 * their own writes from everyone else's.
 */
export function onConfigChanged(callback: (config: GazetteerConfig, stored: unknown) => void): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[STORAGE_KEY]) return;
    const stored = changes[STORAGE_KEY].newValue;
    loadConfig().then((config) => callback(config, stored)).catch(() => { /* ignore */ });
  });
}
