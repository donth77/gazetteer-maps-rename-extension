/**
 * Shared browser launch for the local tools. Not part of the extension.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
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

export async function launchWithExtension({ headless = true, viewport, extraArgs = [] } = {}) {
  const { chromium } = loadPlaywright();
  const ext = path.resolve(process.env.GZ_DIST ?? 'dist');
  if (!existsSync(path.join(ext, 'manifest.json'))) {
    throw new Error('dist/manifest.json not found — run `npm run build` first.');
  }
  const exe = findChromeForTesting();
  const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'gazetteer-')), {
    ...(exe ? { executablePath: exe } : { channel: process.env.CHANNEL ?? 'chrome' }),
    headless,
    ...(viewport ? { viewport } : {}),
    args: [
      '--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      ...extraArgs,
    ],
  });
  return context;
}

/** MV3 workers are lazy, so absence is not proof of failure — just informational. */
export async function extensionId(context, timeout = 10000) {
  const worker = context.serviceWorkers()[0]
    ?? await context.waitForEvent('serviceworker', { timeout }).catch(() => null);
  return worker ? worker.url().split('/')[2] : null;
}
