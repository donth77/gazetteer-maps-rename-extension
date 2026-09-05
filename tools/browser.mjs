/**
 * Shared browser launch for the local tools. Not part of the extension.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

/** Playwright is not a dependency of this project; find whichever copy exists. */
export function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_PATH, 'playwright'].filter(Boolean);
  const npx = path.join(homedir(), '.npm/_npx');
  if (existsSync(npx)) {
    for (const dir of readdirSync(npx)) candidates.push(path.join(npx, dir, 'node_modules/playwright'));
  }
  for (const candidate of candidates) {
    try { return require(candidate); } catch { /* try the next one */ }
  }
  throw new Error('Playwright not found. Install it, or set PLAYWRIGHT_PATH.');
}

/**
 * Stable Chrome 137+ ignores the --load-extension switch, so automation needs a
 * "Chrome for Testing" build. (Loading unpacked by hand from chrome://extensions
 * is unaffected — that path works in normal Chrome.)
 */
export function findChromeForTesting() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return null;
  const builds = readdirSync(cache)
    .filter((d) => d.startsWith('chromium-') && !d.includes('headless'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    for (const rel of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-linux/chrome',
    ]) {
      const exe = path.join(cache, build, rel);
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

export async function launchWithExtension({ headless = true, viewport, extraArgs = [], locale } = {}) {
  const { chromium } = loadPlaywright();
  const ext = path.resolve(process.env.GZ_DIST ?? 'dist');
  if (!existsSync(path.join(ext, 'manifest.json'))) {
    throw new Error('dist/manifest.json not found — run `pnpm run build` first.');
  }
  // Playwright's own Chromium (the full build, not the headless shell) loads
  // extensions on every platform; it is what `playwright install chromium`
  // puts on a CI runner, where the cache paths above do not apply.
  const playwrightChromium = (() => { try { return chromium.executablePath(); } catch { return null; } })();
  const exe = findChromeForTesting() ?? (playwrightChromium && existsSync(playwrightChromium) ? playwrightChromium : null);
  const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'gazetteer-')), {
    ...(exe ? { executablePath: exe } : { channel: process.env.CHANNEL ?? 'chrome' }),
    headless,
    ...(viewport ? { viewport } : {}),
    // Playwright turns this into the browser's own --lang; passing the switch
    // directly loses to the one Playwright appends.
    ...(locale ? { locale } : {}),
    args: [
      '--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      ...extraArgs,
    ],
  });
  return context;
}

/**
 * The id Chrome gives an unpacked extension: the first 128 bits of the SHA-256
 * of its absolute path, written in the letters a-p. Computed rather than read
 * off the service worker, which is lazy and may already be asleep.
 */
export function unpackedExtensionId(dir = path.resolve(process.env.GZ_DIST ?? 'dist')) {
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 32);
  return [...hash].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('');
}

/** Prefer the live worker's id when one is awake; fall back to computing it. */
export async function extensionId(context, timeout = 3000) {
  const worker = context.serviceWorkers()[0]
    ?? await context.waitForEvent('serviceworker', { timeout }).catch(() => null);
  return worker ? worker.url().split('/')[2] : unpackedExtensionId();
}
