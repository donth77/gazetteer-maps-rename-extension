/**
 * MAIN-world content script, document_start.
 *
 * Installs the worker hook before Google's bundle runs. It cannot use chrome.*
 * APIs, so rules arrive from the ISOLATED content script by postMessage and are
 * relayed into the workers over a BroadcastChannel.
 */
import { installWorkerHook } from '../hooks/worker-inject.ts';
import { compile, validateRules } from '../core/rules.ts';
import { createLineMatcher, createRepairGovernor, createResolutionStore, type LineMatcher } from '../core/lines.ts';
import shipped from '../../data/names.json' with { type: 'json' };
import { LOADING_TILE_DARK, LOADING_TILE_LIGHT } from './loading-tile.ts';
import type { CompiledSubstitution } from '../core/types.ts';

declare const __WORKER_RUNTIME__: string;

// A BroadcastChannel is shared by every page on the origin, so a fixed name
// would have one Maps tab's workers answering another's. Each page load gets
// its own; the workers learn it from their preamble.
const CHANNEL = 'gazetteer-' + Math.random().toString(36).slice(2, 10);

try {
  // Starts with no substitutions: until the user's config arrives the hook is
  // installed but inert, so a slow read can never apply the wrong rules.
  /**
   * Storage is read asynchronously, but workers are constructed within
   * milliseconds of document_start — and a label already painted does not
   * redraw on its own. So start from the shipped table, which is what almost
   * everyone is running, and let the user's real config replace it a moment
   * later. The window where a disabled rule could still apply is a few
   * milliseconds, and it corrects itself on the next redraw.
   */
  function seedSubs(): CompiledSubstitution[] {
    try {
      const parsed = validateRules(shipped);
      if (!parsed.ok) return [];
      return compile(parsed.rules, navigator.language || 'en');
    } catch {
      return [];
    }
  }

  let currentSubs: CompiledSubstitution[] = seedSubs();

  /**
   * Maps does not always label inside the workers. On slower machines (and
   * under CPU throttling) it spawns a different worker set and rasterizes some
   * labels — pin titles, at least — on the main thread, through the page's own
   * TextDecoder. So the same decode hook the workers get is installed here too,
   * sharing the one resolution store over the same channel.
   */
  const mainId = 'main-' + Math.random().toString(36).slice(2, 8);
  let mainMatcher: LineMatcher | null = currentSubs.length ? createLineMatcher(currentSubs) : null;
  const mainStore = createResolutionStore();
  const mainCounters = { decodes: 0, substitutions: 0, whole: 0, lines: 0, shared: 0 };
  const lastAnnouncedMain = new Map<string, string>();

  function setMainRules(subs: CompiledSubstitution[]): void {
    mainMatcher = subs.length ? createLineMatcher(subs) : null;
    mainStore.clear();
    lastAnnouncedMain.clear();
  }
  const handle = installWorkerHook({
    runtime: __WORKER_RUNTIME__,
    channel: CHANNEL,
    // Read at construction time, so a worker created after the config arrives
    // is born with the right table instead of waiting for a broadcast.
    getSubs: () => currentSubs,
  });

  let channel: BroadcastChannel | null = null;
  try { channel = new BroadcastChannel(CHANNEL); } catch { /* ignore */ }

  const counters = { decodes: 0, substitutions: 0, whole: 0, lines: 0, shared: 0 };
  let contested = false;
  const perWorker = new Map<string, typeof counters>();
  function postCounters(): void {
    window.postMessage({ source: 'gazetteer-main', type: 'counters', counters, contested }, '*');
  }

  /**
   * Every resolution any worker announces passes through here. When a
   * different name claims a word already resolved the other way, anything
   * drawn from the old value is beyond the reach of any decode, but cycling
   * the WebGL contexts makes Maps rebuild its renderer, which redraws every
   * label under the now-current resolution. The governor stops that from
   * thrashing in the genuinely ambiguous case (both places on screen,
   * resolutions flip-flopping) and caps it per page. It lives here, not in
   * the workers, because a rebuild replaces the workers and would hand a
   * fresh budget to each repair.
   */
  const governor = createRepairGovernor();
  let repairs = 0;
  function onResolution(text: string, to: string): void {
    const now = Date.now();
    const prevAt = governor.touch(text, now);
    if (!mainStore.publish(text, to)) return;
    if (governor.allow(prevAt, now)) {
      contested = false;
      repairs++;
      try { channel?.postMessage({ type: 'gazetteer:repair' }); } catch { /* ignore */ }
    } else {
      // Repair is guarded off (ambiguous flip-flop, cooldown, or cap): the
      // only case the user needs to be told about.
      contested = true;
    }
    postCounters();
  }

  if (channel) {
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; id?: string; counters?: typeof counters } | null;
      if (data?.type === 'gazetteer:counters' && data.counters) {
        perWorker.set(data.id ?? '?', data.counters);
        for (const key of Object.keys(counters) as (keyof typeof counters)[]) {
          counters[key] = 0;
          for (const c of perWorker.values()) counters[key] += c[key] ?? 0;
        }
        postCounters();
      } else if (data?.type === 'gazetteer:resolved') {
        const r = data as { text?: string; to?: string; from?: string };
        if (typeof r.text === 'string' && typeof r.to === 'string' && r.from !== mainId) onResolution(r.text, r.to);
      } else if (data?.type === 'gazetteer:gl') {
        vectorIsAlive();
      } else if (data?.type === 'gazetteer:hello' && currentSubs.length > 0) {
        // A worker started before the config landed; hand it the table.
        try { channel?.postMessage({ type: 'gazetteer:rules', subs: currentSubs }); } catch { /* ignore */ }
      }
    };
  }

  /**
   * Raster preview suppression. During boot Maps loads pre-rendered PNG tiles
   * (`/maps/vt/pb=…!2sm!…`) with the served names baked into the pixels — they
   * paint a quarter second before the first vector label is even decoded, which
   * is the flash. There is no label-less variant of these tiles to swap in
   * (measured: style and layer parameters are ignored), so matching loads get
   * a placeholder instead; the vector renderer, whose text this extension
   * rewrites, fills the map moments later. Gated on WebGL, because without it
   * the raster tiles are the only map Maps will ever draw.
   */
  let suppressRaster = true; // safe boot default; real config arrives in ms
  let rasterBlocked = 0;
  let webglOk: boolean | null = null;
  const nativeGetContext = HTMLCanvasElement.prototype.getContext;
  function vectorModeAvailable(): boolean {
    if (webglOk === null) {
      try {
        const probe = document.createElement('canvas');
        const ctx = (nativeGetContext.call(probe, 'webgl2') ?? nativeGetContext.call(probe, 'webgl')) as WebGLRenderingContext | null;
        webglOk = !!ctx;
        // Release the probe context: browsers cap live contexts per page.
        try { ctx?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ignore */ }
      } catch { webglOk = false; }
    }
    return webglOk;
  }
  const RASTER_TILE = /\/maps\/vt\/pb=.*!2sm!/;
  function isSuppressedTileUrl(url: string): boolean {
    return suppressRaster && !rasterAbandoned && RASTER_TILE.test(url) && vectorModeAvailable();
  }

  /**
   * WebGL being available is not the same as Maps using it: it can still pick
   * the raster map (lite mode, its own performance fallback), and then these
   * placeholders would be the only map the user ever sees. So the real URL of
   * every replaced tile is kept, and unless the vector renderer proves it is
   * alive within a grace period (a worker, or the page itself, creating a
   * WebGL context), the previews are put back and suppression stops for the
   * rest of the page's life.
   */
  const RASTER_GRACE_MS = 12000;
  const realTileSrc = new WeakMap<HTMLImageElement, string>();
  let held: HTMLImageElement[] = [];
  let vectorAlive = false;
  let rasterAbandoned = false;
  let graceTimer: number | null = null;
  function vectorIsAlive(): void {
    vectorAlive = true;
    if (graceTimer !== null) { clearTimeout(graceTimer); graceTimer = null; }
    held = [];
  }
  function abandonSuppression(): void {
    graceTimer = null;
    if (vectorAlive) return;
    rasterAbandoned = true;
    for (const img of held) {
      const real = realTileSrc.get(img);
      if (real !== undefined) { try { nativeSetImageSrc?.call(img, real); } catch { /* ignore */ } }
    }
    held = [];
  }
  function holdForRestore(img: Element, real: string): void {
    if (vectorAlive || !(img instanceof HTMLImageElement)) return;
    realTileSrc.set(img, real);
    if (held.length < 600) held.push(img);
    if (graceTimer === null) graceTimer = window.setTimeout(abandonSuppression, RASTER_GRACE_MS);
  }
  try {
    // A WebGL context on a canvas in the document is the page-side proof.
    // (Capability probes, ours included, use detached canvases.)
    (HTMLCanvasElement.prototype as unknown as { getContext: (...a: unknown[]) => unknown }).getContext =
      function (this: HTMLCanvasElement, ...args: unknown[]): unknown {
        const ctx = (nativeGetContext as unknown as (...a: unknown[]) => unknown).apply(this, args);
        try {
          if (ctx && (args[0] === 'webgl' || args[0] === 'webgl2') && this.isConnected) vectorIsAlive();
        } catch { /* ignore */ }
        return ctx;
      };
  } catch { /* the worker-side signal still stands */ }
  // The replacement is an opaque loading grid rather than a transparent pixel:
  // the vector canvas goes through ugly boot phases (bare grid on black, then
  // unlabeled fills) that Google's own preview tiles normally cover, and an
  // opaque placeholder covers them the same way while looking like a normal
  // slow load. Maps drops this layer when the vector map is ready, exactly as
  // it drops the real previews.
  //
  // The grid comes in light and dark, matched to the theme Maps itself is
  // loading in. The signal is the map pane's own background color, read by
  // walking up from the intercepted tile image: Maps' dark appearance darkens
  // that pane, while the OS color scheme alone is not the answer (measured: a
  // dark-OS signed-out session still paints a light map, pane rgb(242,242,242))
  // and body/documentElement are transparent. The canvas layers are black in
  // every theme, so pure black and transparent backgrounds are skipped. Until
  // a pane color exists, the OS scheme is the provisional guess.
  let lockedTheme: 'light' | 'dark' | null = null;
  function themeFromPane(start: Element | null): 'light' | 'dark' | null {
    try {
      let el: Element | null = start;
      for (let depth = 0; el && depth < 12; depth++, el = el.parentElement) {
        const bg = getComputedStyle(el).backgroundColor;
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(bg ?? '');
        if (!m) continue;
        if (m[4] !== undefined && parseFloat(m[4]) === 0) continue; // transparent
        const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
        if (r === 0 && g === 0 && b === 0) continue; // canvas scaffold, any theme
        return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? 'dark' : 'light';
      }
    } catch { /* fall through */ }
    return null;
  }
  /**
   * The whole preview burst is intercepted at ~270ms, before the map pane is
   * styled, so the theme cannot be known at serve time. Strategy: serve light
   * immediately (measured: signed-out Maps paints a light map even on a dark
   * OS, so light is the safe majority guess), remember every placeholder
   * image served, and poll briefly; the moment the pane's real theme is
   * readable, re-point the already-served images at the right tile. The swap
   * is a data-URI assignment at ~400ms, invisible in practice.
   */
  const servedPlaceholders: HTMLImageElement[] = [];
  let themePollStarted = false;
  function resolveThemeSoon(): void {
    if (themePollStarted) return;
    themePollStarted = true;
    const startedAt = Date.now();
    const tick = () => {
      if (lockedTheme === null) {
        lockedTheme = themeFromPane(document.querySelector('canvas'));
      }
      if (lockedTheme !== null) {
        if (lockedTheme === 'dark') {
          for (const img of servedPlaceholders.splice(0)) {
            try { nativeSetImageSrc?.call(img, LOADING_TILE_DARK); } catch { /* ignore */ }
          }
        } else {
          servedPlaceholders.length = 0;
        }
        return;
      }
      if (Date.now() - startedAt < 6000) setTimeout(tick, 120);
      else servedPlaceholders.length = 0;
    };
    setTimeout(tick, 120);
  }
  function loadingTile(img: Element): string {
    if (lockedTheme === null) {
      lockedTheme = themeFromPane(img) ?? themeFromPane(document.querySelector('canvas'));
    }
    if (lockedTheme === null && img instanceof HTMLImageElement && servedPlaceholders.length < 400) {
      servedPlaceholders.push(img);
      resolveThemeSoon();
    }
    return lockedTheme === 'dark' ? LOADING_TILE_DARK : LOADING_TILE_LIGHT;
  }
  let nativeSetImageSrc: ((this: HTMLImageElement, value: string) => void) | null = null;
  try {
    const proto = HTMLImageElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'src');
    if (descriptor?.set && descriptor.get) {
      const nativeSet = descriptor.set;
      nativeSetImageSrc = nativeSet;
      const nativeGet = descriptor.get;
      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get(this: HTMLImageElement) { return nativeGet.call(this); },
        set(this: HTMLImageElement, value: string) {
          try {
            if (typeof value === 'string' && isSuppressedTileUrl(value)) {
              rasterBlocked++;
              nativeSet.call(this, loadingTile(this));
              holdForRestore(this, value);
              return;
            }
          } catch { /* fall through to the native setter */ }
          nativeSet.call(this, value);
        },
      });
    }
  } catch { /* previews load as before; the decode hooks still stand */ }

  try {
    // Maps sets some tile sources through setAttribute rather than the property.
    const nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      try {
        if (name === 'src' && typeof value === 'string'
          && this instanceof HTMLImageElement && isSuppressedTileUrl(value)) {
          rasterBlocked++;
          const result = nativeSetAttribute.call(this, 'src', loadingTile(this));
          holdForRestore(this, value);
          return result;
        }
      } catch { /* fall through to the native call */ }
      return nativeSetAttribute.call(this, name, value);
    };
  } catch { /* ignore */ }

  /** Only well-formed entries reach the workers, whatever posted the message. */
  function sanitizeSubs(input: unknown): CompiledSubstitution[] {
    if (!Array.isArray(input)) return [];
    const out: CompiledSubstitution[] = [];
    for (const entry of input) {
      const s = entry as Partial<CompiledSubstitution> | null;
      if (!s || typeof s !== 'object' || typeof s.from !== 'string' || typeof s.to !== 'string' || s.from === '') continue;
      out.push({
        from: s.from,
        to: s.to,
        locale: typeof s.locale === 'string' ? s.locale : '*',
        ruleId: typeof s.ruleId === 'string' ? s.ruleId : '',
      });
    }
    return out;
  }

  /**
   * A label already drawn does not notice a rules change; only a redraw
   * applies it. The same context cycle that heals collisions makes Maps
   * rebuild its renderer, so a saved change shows on the map within a second
   * instead of at the next pan. Debounced, because the settings page saves as
   * the user types, and capped, since each cycle is real work.
   *
   * This runs during boot too. Workers start from the shipped rules so nothing
   * flashes, and when the stored config turns out to differ — the user renamed
   * something else, or switched the extension off — whatever those rules
   * already drew has to be redrawn under the real ones. A config that matches
   * the shipped rules, which is most of them, never reaches here at all: the
   * table is unchanged.
   */
  const REDRAW_DEBOUNCE_MS = 1000;
  const MAX_CONFIG_REDRAWS = 12;
  let tableKey = JSON.stringify(currentSubs);
  let redraws = 0;
  let redrawTimer: number | null = null;
  function redrawForNewRules(): void {
    if (redrawTimer !== null) clearTimeout(redrawTimer);
    redrawTimer = window.setTimeout(() => {
      redrawTimer = null;
      if (redraws >= MAX_CONFIG_REDRAWS) return;
      redraws++;
      contested = false; // everything is being redrawn under one table
      try { channel?.postMessage({ type: 'gazetteer:repair' }); } catch { /* ignore */ }
      postCounters();
    }, REDRAW_DEBOUNCE_MS);
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as { source?: string; type?: string; subs?: unknown; suppressRaster?: boolean } | null;
    if (data?.source !== 'gazetteer-isolated' || data.type !== 'rules') return;
    if (typeof data.suppressRaster === 'boolean') suppressRaster = data.suppressRaster;
    const subs = sanitizeSubs(data.subs);
    try { setMainRules(subs); } catch { return; }
    currentSubs = subs;
    try { channel?.postMessage({ type: 'gazetteer:rules', subs: currentSubs }); } catch { /* ignore */ }
    const key = JSON.stringify(subs);
    if (key !== tableKey) {
      tableKey = key;
      redrawForNewRules();
    }
  });

  function reportMain(): void {
    perWorker.set(mainId, { ...mainCounters });
    for (const key of Object.keys(counters) as (keyof typeof counters)[]) {
      counters[key] = 0;
      for (const c of perWorker.values()) counters[key] += c[key] ?? 0;
    }
    postCounters();
  }

  function announceMain(text: string, to: string): void {
    if (lastAnnouncedMain.get(text) === to) return;
    lastAnnouncedMain.set(text, to);
    try { channel?.postMessage({ type: 'gazetteer:resolved', text, to, from: mainId }); } catch { /* ignore */ }
    onResolution(text, to); // a channel never echoes to its sender
  }

  try {
    const decode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = function (this: TextDecoder, ...args: unknown[]): string {
      const out = decode.apply(this, args as Parameters<typeof decode>);
      if (mainMatcher === null || typeof out !== 'string' || out.length === 0 || out.length > 120) return out;
      try {
        mainCounters.decodes++;
        if (mainCounters.decodes % 500 === 1) reportMain();
        const before = mainMatcher.lines;
        const next = mainMatcher.substitute(out);
        if (next !== out) {
          mainCounters.substitutions++;
          mainCounters.whole = mainMatcher.whole;
          mainCounters.lines = mainMatcher.lines;
          if (mainMatcher.lines > before) announceMain(out, next);
          reportMain();
          return next;
        }
        const known = mainStore.apply(out);
        if (known !== out) {
          mainCounters.substitutions++;
          mainCounters.shared++;
          reportMain();
          return known;
        }
      } catch { /* never break the page's decode path */ }
      return out;
    };
  } catch { /* the worker hooks still stand */ }

  Object.defineProperty(window, '__GAZETTEER_MAIN__', {
    value: {
      get workersWrapped() { return handle.wrapped; },
      get workersFailed() { return handle.failed; },
      get rasterBlocked() { return rasterBlocked; },
      get rasterAbandoned() { return rasterAbandoned; },
      get vectorAlive() { return vectorAlive; },
      get loadingTheme() { return lockedTheme; },
      get contested() { return contested; },
      get repairs() { return repairs; },
      get redraws() { return redraws; },
      counters,
    },
    configurable: true,
  });
} catch {
  // A failure here must never stop the DOM hook or the page.
}
