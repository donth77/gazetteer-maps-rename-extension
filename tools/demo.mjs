/**
 * Opens a browser with the built extension loaded and leaves it open so you can
 * see the thing work and click around. Close the window to end it.
 *
 * This talks to Google. It is a local demo, not a test.
 */
import { launchWithExtension, extensionId } from './browser.mjs';

const START = process.env.MAPS_URL
  ?? 'https://www.google.com/maps/search/Gulf+of+Mexico/@25,-90,6z?hl=en&gl=US';

const context = await launchWithExtension({ headless: false, viewport: null });
const id = await extensionId(context);

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 60000 });

console.log(`
Gazetteer demo
──────────────
extension id : ${id ?? '(service worker asleep — this is normal)'}

Look at the LEFT sidebar, and at the browser tab title.
  Restored     sidebar heading, place card, search results, tab title
  NOT restored the label painted on the map itself (see docs/M0-spike.md)

Try these:
  · search "Lake Ontario"  — sidebar says Lake Ontario, the map pin says Lake America
  · open the toolbar popup — per-place toggles and status
  · popup → Settings       — add your own place, then reload the tab
${id ? `  · settings directly     — chrome-extension://${id}/options.html` : ''}

Close the browser window to exit.
`);

await context.waitForEvent('close', { timeout: 0 }).catch(() => {});
process.exit(0);
