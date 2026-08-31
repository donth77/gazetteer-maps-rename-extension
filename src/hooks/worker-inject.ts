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

  // Blob-backed workers are handed to us as an opaque URL; remember the Blob so
  // we can rebuild it with our runtime in front.
  const blobsByUrl = new Map<string, Blob>();
  try {
    const original = URL.createObjectURL;
    URL.createObjectURL = function (object: Blob | MediaSource): string {
      const url = original.call(URL, object);
      try { if (object instanceof Blob) blobsByUrl.set(url, object); } catch { /* ignore */ }
      return url;
    };
  } catch { /* ignore */ }

  function patchedUrlFor(raw: string, name?: string): string | null {
    if (raw.startsWith(PREFIX)) {
      const source = blobsByUrl.get(raw);
      if (!source) return null;
      // blob -> blob keeps the URL shape the worker's own code expects.
      const blob = new Blob(
        [preamble(raw, name), options.runtime, '\n', source],
        { type: source.type || 'text/javascript' },
      );
      return nativeCreateObjectURL(blob);
    }
    const absolute = new URL(raw, location.href).href;
    const blob = new Blob(
      [preamble(absolute, name), options.runtime, `\nimportScripts(${JSON.stringify(absolute)});\n`],
      { type: 'text/javascript' },
    );
    return nativeCreateObjectURL(blob);
  }

  try {
    self.Worker = new Proxy(NativeWorker, {
      construct(target, args: [string | URL, WorkerOptions?]) {
        try {
          const patched = patchedUrlFor(String(args[0]), args[1]?.name);
          if (patched !== null) {
            state.wrapped++;
            return Reflect.construct(target, [patched, args[1]]);
          }
        } catch {
          state.failed++;
        }
        // Never prevent the page from creating its worker.
        return Reflect.construct(target, args);
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
