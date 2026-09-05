/**
 * End-to-end check: load the built extension into Chrome, open real Google Maps
 * pages, and assert the served names were rewritten in the DOM.
 *
 * This is MONITORING, not a gating test. It talks to Google, it is
 * non-deterministic, and it must never run in a blocking CI path.
 */
import { launchWithExtension, extensionId } from './browser.mjs';

const CASES = process.env.MAPS_URL
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

try {
  // Prefer a "Chrome for Testing" build: stable Chrome 137+ refuses
  // --load-extension outside of a developer session.
  context = await launchWithExtension({ headless: process.env.HEADED !== '1' });
  console.log('extension service worker:', (await extensionId(context)) ?? '(not running)');

  const page = context.pages()[0] ?? (await context.newPage());
  const failures = [];

  for (const [index, testCase] of CASES.entries()) {
    const { url, expect: EXPECT, stale: STALE } = testCase;
    console.log(`\n— ${EXPECT} —`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (page.url().includes('consent.')) {
      await page.getByRole('button', { name: /accept|agree|reject/i }).first()
        .click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }

    // Give Maps time to render the sidebar, then the hook a frame to rewrite it.
    await page.waitForTimeout(15000);

    // A challenge page is INFRA_ERROR, never a hook failure. Google
    // challenges datacenter IPs aggressively; alerting on that noise is how
    // self-monitoring dies.
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

    const observed = await page.evaluate(() => ({
      title: document.title,
      text: document.body.innerText,
      main: window.__GAZETTEER_MAIN__
        ? { wrapped: window.__GAZETTEER_MAIN__.workersWrapped, failed: window.__GAZETTEER_MAIN__.workersFailed,
            rasterBlocked: window.__GAZETTEER_MAIN__.rasterBlocked, vectorAlive: window.__GAZETTEER_MAIN__.vectorAlive,
            rasterAbandoned: window.__GAZETTEER_MAIN__.rasterAbandoned, contested: window.__GAZETTEER_MAIN__.contested,
            counters: { ...window.__GAZETTEER_MAIN__.counters } }
        : null,
    }));

    const staleCount = observed.text.split(STALE).length - 1;
    const freshCount = observed.text.split(EXPECT).length - 1;
    console.log('  title:', observed.title);
    console.log('  map hook:', JSON.stringify(observed.main));
    console.log(`  "${STALE}" left in visible text:`, staleCount, `| "${EXPECT}" present:`, freshCount);

    // Assert against our own instrumentation, not against pixels.
    if (!observed.main) failures.push(`${EXPECT}: MAIN-world hook never installed`);
    else if (observed.main.wrapped === 0) failures.push(`${EXPECT}: no workers were wrapped`);
    else if (observed.main.failed > 0) failures.push(`${EXPECT}: ${observed.main.failed} worker(s) failed to wrap`);
    else if (observed.main.counters.substitutions === 0) {
      failures.push(`${EXPECT}: map-surface hook made no substitutions (${observed.main.counters.decodes} decodes seen)`);
    }
    if (observed.main) {
      const c = observed.main.counters;
      console.log(`  map counters: subs=${c.substitutions} whole=${c.whole} lines=${c.lines} shared=${c.shared} decodes=${c.decodes}`);
      // The preview suppression gives up if the vector map never proves it is
      // drawing. On a healthy run it must have proven it; giving up here means
      // the proof signal broke, and users would see the old names flash.
      if (observed.main.rasterBlocked > 0 && !observed.main.vectorAlive) {
        failures.push(`${EXPECT}: previews were suppressed but the vector renderer never reported in`);
      }
    }
    if (observed.title.includes(STALE)) failures.push(`${EXPECT}: document.title still contains "${STALE}"`);
    if (staleCount > 0) failures.push(`${EXPECT}: ${staleCount} occurrence(s) of "${STALE}" left in visible text`);
    if (freshCount === 0) failures.push(`${EXPECT}: restored name never appeared`);

    await page.screenshot({ path: (process.env.SHOT ?? 'verify.png').replace(/\.png$/, `-${index}.png`) });
  }

  if (failures.length) {
    console.error('\nFAIL');
    for (const f of failures) console.error('  - ' + f);
    exitCode = 1;
  } else {
    console.log('\nPASS — every visible occurrence was rewritten.');
  }
} catch (error) {
  // A page that would not load is INFRA_ERROR, not a hook failure.
  console.error('INFRA_ERROR:', error.message);
  exitCode = 2;
} finally {
  await context?.close().catch(() => {});
}
process.exit(exitCode);
