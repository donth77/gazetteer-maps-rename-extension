import shipped from '../../data/names.json';
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
  searchField: boolean;
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
  rules: Rule[];
}

/**
 * Storage area is deliberately `local`, never `sync`: design §3 lists config
 * sync as a non-goal, and `chrome.storage.sync` would upload the user's config
 * to Google. The privacy claim is "it talks to nothing" — keep it true.
 */
const area = () => chrome.storage.local;

export function defaultRules(): Rule[] {
  const parsed = validateRules(shipped);
  return parsed.ok ? parsed.rules : [];
}

export function defaultConfig(): GazetteerConfig {
  return { v: 2, enabled: true, searchField: true, suppressRasterPreview: true, removedDefaults: [], rules: defaultRules() };
}

export async function loadConfig(): Promise<GazetteerConfig> {
  try {
    const stored = await area().get(STORAGE_KEY);
    const raw = stored?.[STORAGE_KEY] as Partial<GazetteerConfig> | undefined;
    if (!raw) return defaultConfig();
    const parsed = validateRules({ rules: raw.rules ?? [] });
    return {
      v: typeof raw.v === 'number' ? raw.v : 1,
      enabled: raw.enabled !== false,
      searchField: raw.searchField !== false,
      suppressRasterPreview: raw.suppressRasterPreview !== false,
      removedDefaults: Array.isArray(raw.removedDefaults)
        ? raw.removedDefaults.filter((x): x is string => typeof x === 'string')
        : [],
      // Deliberately no default-merging here: new shipped rules are merged once
      // per update by the background worker, so deleting a rule sticks.
      rules: parsed.ok ? parsed.rules : [],
    };
  } catch {
    return defaultConfig();
  }
}

export async function saveConfig(config: GazetteerConfig): Promise<void> {
  await area().set({ [STORAGE_KEY]: config });
}

/** Fires whenever any surface (options, popup, another tab) rewrites the config. */
export function onConfigChanged(callback: (config: GazetteerConfig) => void): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[STORAGE_KEY]) return;
    loadConfig().then(callback).catch(() => { /* ignore */ });
  });
}
