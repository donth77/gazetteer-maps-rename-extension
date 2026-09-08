/**
 * Generates the extension icons as PNGs with no image dependency.
 *
 * A map pin whose head is a ring, with a text-editing I-beam caret overlapping
 * its upper right: the place name is an editable field. The caret carries a
 * knockout band in the plate colour, so it reads as sitting in front of the pin
 * rather than notched out of it.
 *
 * Drawn analytically rather than resampled from artwork. A 16px toolbar icon
 * needs the caret's stem, serifs and knockout band to be whole pixels; scaling
 * a large raster down turns all three into grey mush and the caret disappears.
 * Curves are supersampled 4x, while the caret's rectangles are snapped to the
 * pixel grid, so its edges stay hard at every size.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const TEAL = [11, 107, 94];    // brand accent #0B6B5E
const PAPER = [246, 247, 249]; // brand paper #F6F7F9

/**
 * Proportions of the mark, in fractions of the icon square, measured from the
 * approved artwork.
 */
const ART = {
  plateRadius: 0.206,
  headCx: 0.5, headCy: 0.4175, headR: 0.25, holeR: 0.146,
  tipY: 0.834,
  caretCx: 0.6973, caretTop: 0.1475, caretBottom: 0.5,
  stemW: 0.0254, serifW: 0.1338, serifH: 0.02, gap: 0.02,
};

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  // rows are prefixed with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The caret's pixel geometry at a given size. Every edge lands on a pixel
 * boundary and every part has a floor of one pixel, which is what keeps the
 * caret readable at 16px instead of dissolving into the pin.
 */
function caretAt(size) {
  const atLeast = (frac, min) => Math.max(Math.round(frac * size), min);
  const stemW = atLeast(ART.stemW, 1);
  const serifW = atLeast(ART.serifW, 3);
  const serifH = atLeast(ART.serifH, 1);
  const gap = atLeast(ART.gap, 1);
  const cx = ART.caretCx * size;
  const top = Math.round(ART.caretTop * size);
  const bottom = Math.round(ART.caretBottom * size);
  const stemX = Math.round(cx - stemW / 2);
  const serifX = Math.round(cx - serifW / 2);
  return {
    gap,
    stem: { x0: stemX, x1: stemX + stemW, y0: top, y1: bottom },
    topSerif: { x0: serifX, x1: serifX + serifW, y0: top, y1: top + serifH },
    bottomSerif: { x0: serifX, x1: serifX + serifW, y0: bottom - serifH, y1: bottom },
  };
}

const inRect = (x, y, r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
const inRectGrown = (x, y, r, g) =>
  x >= r.x0 - g && x <= r.x1 + g && y >= r.y0 - g && y <= r.y1 + g;

/**
 * Colour at a point, in pixels, or null for transparent. Painted back to front:
 * plate, pin, the caret's knockout band, then the caret.
 */
function shade(x, y, size, caret, holeR) {
  const u = x / size, v = y / size; // 0..1 for the shapes measured that way

  // Rounded-square plate, full bleed; outside it the icon is transparent.
  const r = ART.plateRadius;
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  if (Math.hypot(dx, dy) > r) return null;

  // Pin: a ring for the head, and a tail whose sides run from the point up to
  // where they touch the head, so the silhouette has no kink.
  const d = Math.hypot(u - ART.headCx, v - ART.headCy);
  const inRing = d <= ART.headR && d >= holeR;
  const reach = ART.tipY - ART.headCy;
  const slope = ART.headR / Math.sqrt(reach * reach - ART.headR * ART.headR);
  const touchY = ART.headCy + (ART.headR * ART.headR) / reach;
  const inTail = v >= touchY && v <= ART.tipY
    && Math.abs(u - ART.headCx) <= slope * (ART.tipY - v);
  let colour = inRing || inTail ? PAPER : TEAL;

  // Knockout band: plate colour around the caret, so it separates from the pin
  // where the two overlap and is invisible everywhere else.
  const { gap, stem, topSerif, bottomSerif } = caret;
  if (inRectGrown(x, y, stem, gap) || inRectGrown(x, y, topSerif, gap)
    || inRectGrown(x, y, bottomSerif, gap)) colour = TEAL;

  if (inRect(x, y, stem) || inRect(x, y, topSerif) || inRect(x, y, bottomSerif)) colour = PAPER;
  return colour;
}

async function render(size) {
  const SS = 4; // supersampling factor
  const caret = caretAt(size);
  // Hold the ring to two pixels: at 16px the artwork's proportions leave it
  // under two, and a ring that thin antialiases into a broken smudge. Widening
  // it inward costs a little of the hole and nothing at 32px and up.
  const holeR = Math.min(ART.holeR, ART.headR - 2 / size);
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size, caret, holeR);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      // un-premultiply so edges stay the right hue against any backdrop
      out[i] = a ? Math.round(r / (a / 255)) : 0;
      out[i + 1] = a ? Math.round(g / (a / 255)) : 0;
      out[i + 2] = a ? Math.round(b / (a / 255)) : 0;
      out[i + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, out);
}

await mkdir('assets/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(`assets/icons/icon${size}.png`, await render(size));
}
console.log('icons → assets/icons/');
