/**
 * Chrome Web Store screenshots, at the 1280x800 the store asks for.
 *
 * Drives real Google Maps, so this is a manual tool like `verify`, never CI.
 * The before/after shot loads the same view twice, once with renaming off and
 * once with it on, so the comparison is genuine rather than staged.
 */
import { launchWithExtension, extensionId } from './browser.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.env.SHOT_DIR ?? 'store/screenshots';
const W = 1280, H = 800;
const PLACE = 'https://www.google.com/maps/place/Gulf+of+Mexico/@25.5,-90,5z?hl=en';
// No place panel, so the before/after is the map surface alone, which is the
// part that is hard to rename and the part worth showing.
const BARE_MAP = 'https://www.google.com/maps/@25.5,-90,6z?hl=en';
const TEAL = '#0B6B5E';

mkdirSync(OUT, { recursive: true });
const context = await launchWithExtension({ headless: false, viewport: { width: W, height: H } });

async function setEnabled(id, enabled) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await page.evaluate(async (enabled) => {
    const key = 'gazetteer.config';
    const config = (await chrome.storage.local.get(key))[key];
    config.enabled = enabled;
    await chrome.storage.local.set({ [key]: config });
  }, enabled);
  await page.close();
}

/** Captures the map, waiting long enough for labels to settle. */
async function mapShot(page, url = PLACE) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  return (await page.screenshot()).toString('base64');
}

try {
  const warm = await context.newPage();
  await warm.goto('https://www.google.com/maps?hl=en', { waitUntil: 'domcontentloaded' });
  const id = await extensionId(context);

  await setEnabled(id, false);
  const before = await mapShot(warm, BARE_MAP);
  await setEnabled(id, true);
  const after = await mapShot(warm, BARE_MAP);
  const withPanel = await mapShot(warm, PLACE);

  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${id}/options.html`);
  await optionsPage.waitForTimeout(600);
  const options = (await optionsPage.screenshot()).toString('base64');

  // The popup reports on whichever tab is active. Opened on its own it says
  // "open Google Maps", which would be a lie next to a screenshot of Maps, so
  // it is loaded as a background tab while the Maps tab holds focus and shows
  // the status a user actually sees.
  const popupPage = await context.newPage();
  await popupPage.setViewportSize({ width: 300, height: 280 });
  await popupPage.goto(`chrome-extension://${id}/popup.html`);
  await warm.bringToFront();
  await popupPage.reload();
  await popupPage.waitForTimeout(1500);
  const status = await popupPage.textContent('#state-label').catch(() => '');
  if (!status) throw new Error('popup still shows no live status; the capture would misrepresent it');
  console.log('popup status:', status.trim(), '|', (await popupPage.textContent('#summary')).trim());
  const popup = (await popupPage.screenshot()).toString('base64');

  // Compose on a canvas: the store wants exactly 1280x800 images.
  const canvasPage = await context.newPage();
  const shots = await canvasPage.evaluate(async ({ before, after, withPanel, options, popup, W, H, TEAL }) => {
    const load = async (b64) => { const i = new Image(); i.src = 'data:image/png;base64,' + b64; await i.decode(); return i; };
    const [b, a, wp, o, p] = await Promise.all([before, after, withPanel, options, popup].map(load));

    const make = (draw) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = TEAL; ctx.fillRect(0, 0, W, H);
      draw(ctx, c);
      return c.toDataURL('image/png').split(',')[1];
    };
    const caption = (ctx, text, x, y) => {
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 22px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillText(text, x, y);
    };

    // 1. Before and after, cropped to the water where the label sits.
    const sideBySide = make((ctx) => {
      const BAND = 74, GAP = 16, PAD = 16;
      const cw = (W - PAD * 2 - GAP) / 2, ch = H - BAND - PAD;
      caption(ctx, 'Google Maps', PAD + 4, 34);
      caption(ctx, 'With Gazetteer', PAD + cw + GAP + 4, 34);
      ctx.font = '15px system-ui'; ctx.fillStyle = 'rgba(255,255,255,.75)';
      ctx.fillText('the name Google shows', PAD + 4, 58);
      ctx.fillText('the name you chose', PAD + cw + GAP + 4, 58);
      // Crop in on the water, so the label that changes is the subject, and
      // start below Maps' own search box so no stray chrome is in frame.
      const sx = 360, sy = 165, sw = 560, sh = 635;
      ctx.drawImage(b, sx, sy, sw, sh, PAD, BAND, cw, ch);
      ctx.drawImage(a, sx, sy, sw, sh, PAD + cw + GAP, BAND, cw, ch);
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 2;
      ctx.strokeRect(PAD, BAND, cw, ch);
      ctx.strokeRect(PAD + cw + GAP, BAND, cw, ch);
    });

    // 2. The settings page, whole.
    const settings = make((ctx) => {
      caption(ctx, 'Rename any place, in any language', 40, 44);
      const iw = W - 80, ih = Math.round((iw / o.width) * o.height);
      ctx.drawImage(o, 40, 68, iw, Math.min(ih, H - 100));
    });

    // 3. The popup, over the map.
    const inToolbar = make((ctx) => {
      caption(ctx, 'Switch a place on or off from the toolbar', 40, 44);
      const iw = W - 80, ih = H - 100;
      ctx.drawImage(wp, 0, 0, wp.width, Math.round(wp.width * (ih / iw)), 40, 68, iw, ih);
      const pw = 380, ph = Math.round((pw / p.width) * p.height);
      const px = W - 40 - pw - 24, py = 100;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 28; ctx.shadowOffsetY = 8;
      ctx.drawImage(p, px, py, pw, ph);
      ctx.restore();
    });
    return { '1-before-after': sideBySide, '2-settings': settings, '3-popup': inToolbar };
  }, { before, after, withPanel, options, popup, W, H, TEAL });

  for (const [name, b64] of Object.entries(shots)) {
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(b64, 'base64'));
    console.log(`${OUT}/${name}.png`);
  }
} finally {
  await context.close();
}
