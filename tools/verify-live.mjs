/**
 * End-to-end check: load the built extension into Chrome, open real Google Maps
 * pages, and assert the names were rewritten.
 *
 * This is MONITORING, not a gating test. It talks to Google, it is
 * non-deterministic, and it must never run in a blocking CI path.
 *
 * The run fails only when the extension's injection is broken. That is what
 * the canary is for: a rule renaming an ordinary city, which nobody is going
 * to rename for political reasons. The shipped Gulf and Lake rules are checked
 * too, but a miss there means the served name changed and `data/names.json`
 * needs updating, not that the extension stopped working, so it only warns.
 *
 * Exit codes: 0 healthy, 1 injection broken, 2 infrastructure (Google
 * challenge), which the caller should retry rather than alert on.
 */
import { launchWithExtension, extensionId } from './browser.mjs';

const CANARY = {
  url: 'https://www.google.com/maps/place/Toronto/@43.65,-79.38,10z?hl=en&gl=US',
  rule: { id: 'canary', enabled: true, description: 'health check',
    substitutions: [{ locale: '*', from: 'Toronto', to: 'Zephyr City' }] },
  expect: 'Zephyr City',
};

const SHIPPED = process.env.MAPS_URL
  ? [{ url: process.env.MAPS_URL, expect: process.env.EXPECT, stale: process.env.STALE }]
  : [
      {
        url: 'https://www.google.com/maps/search/Gulf+of+Mexico/@25,-90,6z?hl=en&gl=US',
        expect: 'Gulf of Mexico',
        stale: 'Gulf of America',
      },
      {
        url: 'https://www.google.com/maps/search/Lake+Ontario/@43.7,-77.9,7z?hl=en&gl=US',
        expect: 'Lake Ontario',
        stale: 'Lake America',
      },
    ];

let context;
let exitCode = 0;
const broken = [];   // injection is not working: the run fails
const stale = [];    // served names moved on: worth saying, not worth failing

/** Loads a Maps page and reports what the extension did to it. */
async function inspect(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (page.url().includes('consent.')) {
    await page.getByRole('button', { name: /accept|agree|reject/i }).first()
      .click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  // Give Maps time to render the sidebar, then the hook a frame to rewrite it.
  await page.waitForTimeout(15000);

  // A challenge page is INFRA_ERROR, never a hook failure. Google challenges
  // datacenter IPs aggressively; alerting on that noise is how self-monitoring
  // dies.
  const blocked = await page.evaluate(() => {
    const text = (document.body?.innerText ?? '').slice(0, 4000);
    return location.pathname.startsWith('/sorry')
      || location.hostname.startsWith('consent.')
      || /unusual traffic|not a robot|automated queries/i.test(text);
  }).catch(() => false);
  if (blocked) {
    console.error('INFRA_ERROR: Google served a challenge page instead of Maps. Do not alert; retry.');
    process.exit(2);
  }

  return page.evaluate(() => ({
    title: document.title,
    text: document.body.innerText,
    main: window.__GAZETTEER_MAIN__
      ? {
          wrapped: window.__GAZETTEER_MAIN__.workersWrapped,
          failed: window.__GAZETTEER_MAIN__.workersFailed,
          rasterBlocked: window.__GAZETTEER_MAIN__.rasterBlocked,
          vectorAlive: window.__GAZETTEER_MAIN__.vectorAlive,
          contested: window.__GAZETTEER_MAIN__.contested,
          counters: { ...window.__GAZETTEER_MAIN__.counters },
        }
      : null,
  }));
}

function reportHooks(label, main, into) {
  if (!main) return into.push(`${label}: MAIN-world hook never installed`), false;
  const c = main.counters;
  console.log(`  hooks: wrapped=${main.wrapped} failed=${main.failed} `
    + `subs=${c.substitutions} whole=${c.whole} lines=${c.lines} shared=${c.shared} decodes=${c.decodes}`);
  if (main.wrapped === 0) into.push(`${label}: no workers were wrapped`);
  else if (main.failed > 0) into.push(`${label}: ${main.failed} worker(s) failed to wrap`);
  else if (c.substitutions === 0) into.push(`${label}: map hook made no substitutions (${c.decodes} decodes seen)`);
  // The preview suppression gives up when the vector map never proves it is
  // drawing. On a healthy run it must have proven it.
  if (main.rasterBlocked > 0 && !main.vectorAlive) {
    into.push(`${label}: previews were suppressed but the vector renderer never reported in`);
  }
  if (main.contested) console.log('  ::warning:: a label collision could not be self-healed on this run');
  return into.length === 0;
}

try {
  // Prefer a "Chrome for Testing" build: stable Chrome 137+ refuses
  // --load-extension outside of a developer session.
  context = await launchWithExtension({ headless: process.env.HEADED !== '1' });
  const id = await extensionId(context);
  console.log('extension:', id ?? '(service worker not running)');

  // Add the canary alongside the shipped rules.
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${id}/options.html`);
  await setup.evaluate(async (rule) => {
    const key = 'gazetteer.config';
    const config = (await chrome.storage.local.get(key))[key];
    config.rules = [...config.rules.filter((r) => r.id !== rule.id), rule];
    await chrome.storage.local.set({ [key]: config });
  }, CANARY.rule);
  await setup.close();

  const page = context.pages()[0] ?? (await context.newPage());

  // 1. The canary. Everything here is a hard failure.
  console.log(`\n— canary: ${CANARY.expect} —`);
  const canary = await inspect(page, CANARY.url);
  console.log('  title:', canary.title);
  reportHooks('canary', canary.main, broken);
  if (!canary.title.includes(CANARY.expect)) {
    broken.push(`canary: the tab title still reads "${canary.title}"`);
  }
  if (!canary.text.includes(CANARY.expect)) {
    broken.push(`canary: "${CANARY.expect}" never appeared in the page`);
  }
  await page.screenshot({ path: (process.env.SHOT ?? 'verify.png').replace(/\.png$/, '-canary.png') });

  // 2. The shipped rules. These only warn: a miss means the served name moved.
  for (const [index, testCase] of SHIPPED.entries()) {
    const { url, expect: EXPECT, stale: STALE } = testCase;
    console.log(`\n— shipped: ${EXPECT} —`);
    const seen = await inspect(page, url);
    const staleCount = seen.text.split(STALE).length - 1;
    const freshCount = seen.text.split(EXPECT).length - 1;
    console.log('  title:', seen.title);
    console.log(`  "${STALE}" left in visible text:`, staleCount, `| "${EXPECT}" present:`, freshCount);
    reportHooks(EXPECT, seen.main, stale);
    if (seen.title.includes(STALE)) stale.push(`${EXPECT}: the tab title still contains "${STALE}"`);
    if (staleCount > 0) stale.push(`${EXPECT}: ${staleCount} occurrence(s) of "${STALE}" left in visible text`);
    if (freshCount === 0) stale.push(`${EXPECT}: the restored name never appeared`);
    await page.screenshot({ path: (process.env.SHOT ?? 'verify.png').replace(/\.png$/, `-${index}.png`) });
  }

  if (stale.length) {
    console.log('\nThe shipped names did not all match. The extension is working, so this');
    console.log('most likely means Google changed what it serves. Check data/names.json.');
    for (const s of stale) console.log('  ::warning:: ' + s);
  }
  if (broken.length) {
    console.error('\nFAIL: the extension is not rewriting Google Maps.');
    for (const b of broken) console.error('  - ' + b);
    exitCode = 1;
  } else {
    console.log('\nPASS: injection is working.');
  }
} catch (error) {
  console.error('INFRA_ERROR:', error.message);
  exitCode = 2;
} finally {
  await context?.close();
  process.exit(exitCode);
}
