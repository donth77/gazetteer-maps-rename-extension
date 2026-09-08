/**
 * Screenshots of the extension at work, sized 1280x800 for the Chrome Web
 * Store and used in the README.
 *
 * Drives real Google Maps, so this is a manual tool like `verify`, never CI.
 *
 * Everything is captured at twice the pixel density. The first screenshot is
 * the one the store shows smallest, so it magnifies the renamed label rather
 * than showing a whole map, and magnifying a 1x capture would be mush.
 */
import { launchWithExtension, extensionId } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = process.env.SHOT_DIR ?? 'assets/screenshots';
const W = 1280, H = 800, DPR = 2;
const PLACE = 'https://www.google.com/maps/place/Lake+Ontario/@43.7,-77.9,8z?hl=en';
// No place panel, so the map surface is alone in frame: the part that is hard
// to rename and the part worth showing.
const BARE_MAP = 'https://www.google.com/maps/@43.6,-77.9,8z?hl=en';
// The region the side-by-side crops to, in viewport pixels.
const CROP = { x: 360, y: 195, w: 560, h: 605 };
const TEAL = '#0B6B5E';
const LOGO = readFileSync('assets/icons/icon128.png').toString('base64');

mkdirSync(OUT, { recursive: true });
// Shoot a release build: a dev build stamps the popup with a build timestamp,
// and that has no business appearing in the store artwork.
execFileSync('node', ['build.mjs'], { stdio: 'inherit', env: { ...process.env, RELEASE: '1' } });

const context = await launchWithExtension({
  headless: false, viewport: { width: W, height: H }, deviceScaleFactor: DPR,
});

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
async function mapShot(page, url) {
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
  // Open any folded rule, so the picture does not depend on what the default
  // happens to be.
  await optionsPage.evaluate(() => {
    for (const el of document.querySelectorAll('.js-toggle')) {
      if (el.getAttribute('aria-expanded') === 'false') el.click();
    }
  });
  await optionsPage.waitForTimeout(700);
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
  const status = (await popupPage.textContent('#state-label').catch(() => '')).trim();
  if (!status) throw new Error('popup shows no live status; the capture would misrepresent it');
  console.log('popup status:', status, '|', (await popupPage.textContent('#summary')).trim());
  const popup = (await popupPage.screenshot()).toString('base64');

  const canvasPage = await context.newPage();
  const shots = await canvasPage.evaluate(async (args) => {
    const { W, H, DPR, CROP, TEAL } = args;
    const load = async (b64) => { const i = new Image(); i.src = 'data:image/png;base64,' + b64; await i.decode(); return i; };
    const [b, a, wp, o, p, logo] = await Promise.all(
      [args.before, args.after, args.withPanel, args.options, args.popup, args.LOGO].map(load));

    const make = (draw) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = TEAL; ctx.fillRect(0, 0, W, H);
      draw(ctx);
      return c.toDataURL('image/png').split(',')[1];
    };
    const heading = (ctx, text, y, size = 40) => {
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${size}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(text, W / 2, y);
      ctx.textAlign = 'left';
    };
    const rounded = (ctx, x, y, w, h, r) => {
      ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
    };

    // 1. Hero. The product doing its job, under the name and mark, since this
    //    is the image the store shows first.
    const productShot = (ctx, band) => {
      const PAD = band ? 34 : 0, TOP = band ? band : 0;
      const iw = W - PAD * 2, ih = H - TOP - PAD;
      ctx.save();
      if (band) { rounded(ctx, PAD, TOP, iw, ih, 14); ctx.clip(); }
      ctx.drawImage(wp, 0, 0, wp.width, wp.width * (ih / iw), PAD, TOP, iw, ih);
      const pw = band ? 360 : 400, ph = pw * (p.height / p.width);
      const px = W - PAD - pw - (band ? 26 : 40), py = TOP + (band ? 24 : 40);
      ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 10;
      ctx.drawImage(p, px, py, pw, ph);
      ctx.restore();
      if (band) {
        rounded(ctx, PAD, TOP, iw, ih, 14);
        ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.lineWidth = 2; ctx.stroke();
      }
    };

    const hero = make((ctx) => {
      const BAND = 128;
      // Mark and name, centred as one group.
      const size = 54, gap = 18;
      ctx.font = '700 44px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      const nameWidth = ctx.measureText('Gazetteer').width;
      const startX = (W - (size + gap + nameWidth)) / 2;
      ctx.drawImage(logo, startX, 24, size, size);
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText('Gazetteer', startX + size + gap, 24 + size / 2);
      ctx.textBaseline = 'alphabetic';
      ctx.font = '19px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,.8)';
      ctx.textAlign = 'center';
      ctx.fillText('Decide what Google Maps calls things', W / 2, 108);
      ctx.textAlign = 'left';
      productShot(ctx, BAND);
    });

    // The same shot with nothing added on top, for the README.
    const plain = make((ctx) => productShot(ctx, 0));

    // 2. The proof: same water, both names.
    const sideBySide = make((ctx) => {
      const BAND = 96, GAP = 16, PAD = 16;
      const cw = (W - PAD * 2 - GAP) / 2, ch = H - BAND - PAD;
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 22px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillText('Google Maps', PAD + 4, 40);
      ctx.fillText('With Gazetteer', PAD + cw + GAP + 4, 40);
      ctx.font = '15px system-ui'; ctx.fillStyle = 'rgba(255,255,255,.75)';
      ctx.fillText('the name Google shows', PAD + 4, 66);
      ctx.fillText('the name you chose', PAD + cw + GAP + 4, 66);
      const s = (img, dx) => ctx.drawImage(
        img, CROP.x * DPR, CROP.y * DPR, CROP.w * DPR, CROP.h * DPR, dx, BAND, cw, ch);
      s(b, PAD); s(a, PAD + cw + GAP);
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 2;
      ctx.strokeRect(PAD, BAND, cw, ch);
      ctx.strokeRect(PAD + cw + GAP, BAND, cw, ch);
    });

    // 3. The editor.
    const settings = make((ctx) => {
      heading(ctx, 'Rename any place, in any language', 62, 32);
      const PAD = 40, TOP = 88;
      const iw = W - PAD * 2;
      const ih = Math.min(iw * (o.height / o.width), H - TOP - PAD);
      ctx.save();
      rounded(ctx, PAD, TOP, iw, ih, 12); ctx.clip();
      ctx.drawImage(o, 0, 0, o.width, o.width * (ih / iw), PAD, TOP, iw, ih);
      ctx.restore();
    });

    return { hero, popup: plain, 'before-after': sideBySide, settings };
  }, { before, after, withPanel, options, popup, W, H, DPR, CROP, TEAL, LOGO });

  for (const [name, b64] of Object.entries(shots)) {
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(b64, 'base64'));
    console.log(`${OUT}/${name}.png`);
  }
} finally {
  await context.close();
}
