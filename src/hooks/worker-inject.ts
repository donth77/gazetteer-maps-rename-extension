import type { CompiledSubstitution } from '../core/types.ts';

/**
 * MAIN-world hook: wraps `Worker` construction so our runtime lands inside
 * Google's map worker before their bundle executes.
 *
 * Chrome extensions cannot inject into dedicated workers directly, so the only
 * route is to replace the worker's source at construction time. Two hazards,
 * both found the hard way and both handled by the runtime:
 *
 *   1. A blob: worker's `self.location` is the blob, and Google's code parses
 *      its own URL — hence the location shadow.
 *   2. A blob: worker resolves relative URLs against the blob, silently
 *      breaking its WASM fetch — hence the URL re-basing.
 */

export interface WorkerInjectOptions {
  /** Bundled source of the in-worker runtime. */
  runtime: string;
  channel: string;
  /** Read at each worker construction, so late workers start already configured. */
  getSubs: () => CompiledSubstitution[];
}

export interface WorkerInjectHandle {
  readonly wrapped: number;
  readonly failed: number;
}

const PREFIX = 'blob:';

export function installWorkerHook(options: WorkerInjectOptions): WorkerInjectHandle {
  const state = { wrapped: 0, failed: 0 };

  const preamble = (base: string, name?: string): string =>
    `self.__GAZETTEER__=${JSON.stringify({ base, channel: options.channel, subs: options.getSubs(), name })};\n`;

  const NativeWorker = self.Worker;
  const nativeCreateObjectURL = URL.createObjectURL.bind(URL);

  // The runtime must never take Google's worker down with it: a throw before
  // the trailing importScripts would leave a worker that loads nothing. Wrapped
  // here, at the one place every injected copy passes through.
  const runtime = `try {\n${options.runtime}\n} catch (e) {}\n`;

  // Blob-backed workers are handed to us as an opaque URL; remember the Blob so
  // we can rebuild it with our runtime in front, and forget it when the page
  // revokes the URL so a long session does not accumulate them.
  const blobsByUrl = new Map<string, Blob>();
  try {
    const original = URL.createObjectURL;
    URL.createObjectURL = function (object: Blob | MediaSource): string {
      const url = original.call(URL, object);
      try { if (object instanceof Blob) blobsByUrl.set(url, object); } catch { /* ignore */ }
      return url;
    };
    const originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = function (url: string): void {
      try { blobsByUrl.delete(url); } catch { /* ignore */ }
      return originalRevoke.call(URL, url);
    };
  } catch { /* ignore */ }

  function patchedUrlFor(raw: string, name?: string): string | null {
    if (raw.startsWith(PREFIX)) {
      const source = blobsByUrl.get(raw);
      if (!source) return null;
      // blob -> blob keeps the URL shape the worker's own code expects.
      const blob = new Blob(
        [preamble(raw, name), runtime, '\n', source],
        { type: source.type || 'text/javascript' },
      );
      return nativeCreateObjectURL(blob);
    }
    const absolute = new URL(raw, location.href).href;
    const blob = new Blob(
      [preamble(absolute, name), runtime, `\nimportScripts(${JSON.stringify(absolute)});\n`],
      { type: 'text/javascript' },
    );
    return nativeCreateObjectURL(blob);
  }

  try {
    self.Worker = new Proxy(NativeWorker, {
      construct(target, args: [string | URL, WorkerOptions?], newTarget) {
        try {
          // importScripts does not exist in module workers, so the rewrite
          // would never load Google's code, and it would fail asynchronously,
          // past the fallback below. Leave those workers untouched: the map
          // keeps working, labels just go unrenamed, and the health check
          // notices.
          const isModule = args[1]?.type === 'module';
          const patched = isModule ? null : patchedUrlFor(String(args[0]), args[1]?.name);
          if (patched !== null) {
            state.wrapped++;
            return Reflect.construct(target, [patched, args[1]], newTarget);
          }
        } catch {
          state.failed++;
        }
        // Never prevent the page from creating its worker.
        return Reflect.construct(target, args, newTarget);
      },
    });
  } catch {
    state.failed++;
  }

  return {
    get wrapped() { return state.wrapped; },
    get failed() { return state.failed; },
  };
}
