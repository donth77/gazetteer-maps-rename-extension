/**
 * Runs INSIDE Google's map worker, injected ahead of their bundle.
 *
 * Map labels never reach a 2D text API, but they do pass
 * through `TextDecoder.prototype.decode` on their way out of WASM as ordinary
 * strings. That is a browser API rather than Google's minified code, so it is
 * the stable place to intervene — the same argument the design doc made for
 * `fillText`, at the only layer where it turns out to hold.
 *
 * Bundled separately and injected as source text, so it must not assume any
 * DOM or extension API.
 */
import { createLineMatcher, createResolutionStore, type LineMatcher, type NearbyProbe } from '../core/lines.ts';
import type { CompiledSubstitution } from '../core/types.ts';

declare const __GZ: {
  base: string;
  channel: string;
  subs: CompiledSubstitution[];
  name?: string;
};
/** Build-time switch; the shipped bundle has this false and the blocks removed. */
declare const __GZ_DEBUG__: boolean;

(function install(): void {
  const scope = self as unknown as Record<string, unknown>;
  const config = scope.__GAZETTEER__ as typeof __GZ | undefined;
  if (!config || scope.__GAZETTEER_INSTALLED__) return;
  scope.__GAZETTEER_INSTALLED__ = true;

  const counters = { decodes: 0, substitutions: 0, whole: 0, lines: 0, shared: 0 };
  const workerId = (config.name || 'w') + '-' + Math.random().toString(36).slice(2, 8);
  let matcher: LineMatcher | null = config.subs.length ? createLineMatcher(config.subs) : null;

  /**
   * Two workers see every label line. The labeler decodes them in label order
   * (so it can tell "America" under "Gulf of" from "America" under "North"),
   * but it is the renderer's decode that decides which glyphs get drawn — and
   * the renderer sees each unique line once, in hash order, with no context at
   * all. Fortunately the labeler runs first by tens of milliseconds, so what
   * it resolves is broadcast for the renderer to apply.
   */
  const resolved = createResolutionStore();
  const lastAnnounced = new Map<string, string>();
  let channel: BroadcastChannel | null = null;
  function announce(text: string, to: string): void {
    // Re-announce whenever the resolution differs from what this worker last
    // sent for the token. The same token resolves differently as the viewport
    // moves — "America" is Mexico's under the Gulf label and Ontario's under
    // the Lake label — and each change must overwrite the store, in both
    // directions, however often the user pans back and forth.
    if (lastAnnounced.get(text) === to) return;
    lastAnnounced.set(text, to);
    try { channel?.postMessage({ type: 'gazetteer:resolved', text, to, from: workerId }); } catch { /* ignore */ }
  }

  const debug: Record<string, unknown>[] = [];
  if (__GZ_DEBUG__) (scope as Record<string, unknown>).__GAZETTEER_EVT__ = debug;
  /**
   * The renderer keeps one glyph rendering per unique label-line string for the
   * whole session, so when two renamed places share a word ("America"), a label
   * drawn under the other place's context is wrong and no later decode can
   * correct it. The one lever that clears that cache: losing and restoring the
   * WebGL context, which Maps answers by rebuilding its renderer — fresh
   * workers, fresh caches, every label re-laid-out under the now-current
   * resolution. Contexts are captured here; the repair below cycles them. The
   * decision to repair lives in the page, which outlives the workers a repair
   * replaces, so its budget cannot be reset by the repair itself.
   *
   * The first context is also reported to the page: it is the proof that the
   * vector map is really being drawn, which the raster-preview suppression
   * waits for before committing to hide the preview tiles.
   */
  const glContexts: unknown[] = [];
  try {
    const OC = (self as unknown as { OffscreenCanvas?: { prototype: { getContext: (...a: unknown[]) => unknown } } }).OffscreenCanvas;
    if (OC) {
      const orig = OC.prototype.getContext;
      OC.prototype.getContext = function (...a: unknown[]) {
        const ctx = orig.apply(this, a);
        if (ctx && (a[0] === 'webgl' || a[0] === 'webgl2')) {
          if (glContexts.length === 0) {
            try { channel?.postMessage({ type: 'gazetteer:gl', from: workerId }); } catch { /* ignore */ }
          }
          if (glContexts.length < 8) glContexts.push(ctx);
        }
        return ctx;
      };
    }
  } catch { /* ignore */ }
  function repaintForRepair(): void {
    for (const ctx of glContexts) {
      try {
        const ext = (ctx as { getExtension: (n: string) => { loseContext: () => void; restoreContext: () => void } | null })
          .getExtension('WEBGL_lose_context');
        if (ext) {
          ext.loseContext();
          setTimeout(() => { try { ext.restoreContext(); } catch { /* ignore */ } }, 150);
        }
      } catch { /* ignore */ }
    }
  }

  try {
    channel = new BroadcastChannel(config.channel);
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; subs?: CompiledSubstitution[]; text?: string; to?: string; from?: string } | null;
      if (data?.type === 'gazetteer:repair') {
        repaintForRepair();
        if (__GZ_DEBUG__) debug.push({ ev: 'repair-run', w: workerId, n: glContexts.length, at: Date.now() });
        return;
      }
      if (data?.type === 'gazetteer:resolved' && typeof data.text === 'string' && typeof data.to === 'string') {
        // Take the other worker's resolution. Whether a changed value means a
        // label already drawn is now wrong, and whether that warrants a
        // renderer rebuild, is judged by the page, which sees every
        // resolution and keeps the repair budget across rebuilds.
        if (data.from !== workerId) resolved.publish(data.text, data.to);
        if (__GZ_DEBUG__) debug.push({ ev: 'resolved-in', w: workerId, text: data.text, to: data.to, at: Date.now(), from: data.from });
        return;
      }
      if (data?.type !== 'gazetteer:rules' || !Array.isArray(data.subs)) return;
      // Rebuild rather than mutate: the matcher owns its context window.
      matcher = data.subs.length ? createLineMatcher(data.subs) : null;
      resolved.clear();
      lastAnnounced.clear();
    };
    // We are usually constructed before the user's config has been read, and a
    // BroadcastChannel does not replay. Ask for the current table.
    channel.postMessage({ type: 'gazetteer:hello' });
  } catch { /* no channel: whatever came in the preamble still applies */ }

  /**
   * A blob: worker resolves relative URLs against the blob, which silently
   * breaks every relative request Google's worker makes — including its WASM
   * module. Re-base them on the URL the worker was really loaded from.
   */
  const rebase = (url: unknown): unknown => {
    if (typeof url !== 'string') return url;
    try { return new URL(url, config.base).href; } catch { return url; }
  };

  try {
    // Google's worker code parses its own URL to decide which modules to load.
    Object.defineProperty(self, 'location', { value: new URL(config.base), configurable: true });
  } catch { /* ignore */ }

  try {
    // Worker-only global; the DOM lib this file typechecks against lacks it.
    const workerScope = self as unknown as { importScripts: (...urls: string[]) => void };
    const original = workerScope.importScripts;
    workerScope.importScripts = function (...urls: string[]): void {
      return original.apply(self, urls.map(rebase) as string[]);
    };
  } catch { /* ignore */ }

  try {
    const original = self.fetch;
    self.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let target = input;
      try {
        if (typeof input === 'string') target = rebase(input) as string;
        else if (input instanceof Request && input.url.startsWith('blob:')) {
          target = new Request(rebase(input.url) as string, input);
        }
      } catch { /* fall through with the original */ }
      return original.call(self, target as RequestInfo, init);
    };
  } catch { /* ignore */ }

  try {
    const original = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string) {
      const args = Array.prototype.slice.call(arguments) as unknown[];
      args[1] = rebase(url);
      return original.apply(this, args as Parameters<typeof original>);
    };
  } catch { /* ignore */ }

  /**
   * How far either side of a decoded slice to look for a sibling label line.
   * Generous, because the two lines are separate heap allocations and are not
   * reliably adjacent; the scan only runs for the rare ambiguous token.
   */
  const PROBE_BYTES = 32768;
  const encoder = new TextEncoder();

  function findBytes(hay: Uint8Array, needle: Uint8Array): boolean {
    if (needle.length === 0 || needle.length > hay.length) return false;
    const last = hay.length - needle.length;
    const first = needle[0]!;
    outer: for (let i = 0; i <= last; i++) {
      if (hay[i] !== first) continue;
      for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  }

  function makeProbe(source: unknown): NearbyProbe | undefined {
    if (!ArrayBuffer.isView(source)) return undefined;
    const view = source as ArrayBufferView;
    const buffer = view.buffer;
    const lo = Math.max(0, view.byteOffset - PROBE_BYTES);
    const hi = Math.min(buffer.byteLength, view.byteOffset + view.byteLength + PROBE_BYTES);
    if (hi <= lo) return undefined;
    let window: Uint8Array | null = null;
    return (needle: string): boolean => {
      try {
        if (window === null) window = new Uint8Array(buffer, lo, hi - lo);
        return findBytes(window, encoder.encode(needle));
      } catch {
        return false;
      }
    };
  }

  let pending = false;
  function report(): void {
    if (pending || !channel) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      try { channel?.postMessage({ type: 'gazetteer:counters', id: workerId, counters: { ...counters } }); } catch { /* ignore */ }
    }, 500);
  }

  try {
    const decode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = function (this: TextDecoder, ...args: unknown[]): string {
      const out = decode.apply(this, args as Parameters<typeof decode>);
      if (matcher === null || typeof out !== 'string' || out.length === 0 || out.length > 120) return out;
      try {
        counters.decodes++;
        if (counters.decodes % 500 === 1) report();
        const before = matcher.lines;
        const next = matcher.substitute(out, makeProbe(args[0]));
        if (__GZ_DEBUG__ && (out === 'America' || out === 'Gulf of' || out === 'Mexico' || out === 'Lake' || out === 'Ontario' || out === 'Lake America' || out === 'Lake Ontario')) {
          debug.push({ ev: 'decode', w: workerId, text: out, at: Date.now(), matched: next !== out, known: resolved.has(out) });
        }
        if (next !== out) {
          counters.substitutions++;
          counters.whole = matcher.whole;
          counters.lines = matcher.lines;
          // A context-dependent (line) hit is worth sharing: the other worker
          // may decode the same token with no context available.
          if (matcher.lines > before) {
            announce(out, next);
            if (__GZ_DEBUG__) debug.push({ ev: 'announce', w: workerId, text: out, to: next, at: Date.now() });
          }
          report();
          return next;
        }
        // No local match — apply a resolution another worker worked out.
        const known = resolved.apply(out);
        if (known !== out) {
          counters.substitutions++;
          counters.shared++;
          if (__GZ_DEBUG__) debug.push({ ev: 'shared-apply', w: workerId, text: out, to: known, at: Date.now() });
          report();
          return known;
        }
      } catch { /* never break the decode path */ }
      return out;
    };
  } catch { /* ignore */ }
})();
