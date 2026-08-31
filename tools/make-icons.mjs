/**
 * Generates the extension icons as PNGs with no image dependency.
 * A map pin whose head is a globe, drawn analytically and supersampled 4x.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const TEAL = [11, 107, 94];
const TEAL_DARK = [7, 78, 69];
const PAPER = [246, 247, 249];

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

/** Colour at a point in a 0..1 square, or null for transparent. */
function shade(x, y) {
  // rounded-square plate
  const r = 0.22, inset = 0.02;
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - inset - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - inset - r), 0);
  if (Math.hypot(dx, dy) > r) return null;

  // pin: circular head + tapering tail meeting at a point
  const cx = 0.5, cy = 0.4, headR = 0.2;
  const inHead = Math.hypot(x - cx, y - cy) <= headR;
  const tipY = 0.86;
  const t = (y - cy) / (tipY - cy);
  const inTail = t >= 0 && t <= 1 && Math.abs(x - cx) <= headR * (1 - t) * 0.98;
  if (!inHead && !inTail) return TEAL;

  // globe: a meridian and an equator carved out of the pin head
  if (inHead) {
    const nx = (x - cx) / headR, ny = (y - cy) / headR;
    const onEquator = Math.abs(ny) < 0.14;
    const onMeridian = Math.abs(nx) < 0.14;
    // an ellipse standing in for the far meridian
    const ell = Math.abs(Math.hypot(nx / 0.52, ny) - 1) < 0.17;
    if (onEquator || onMeridian || ell) return TEAL_DARK;
  }
  return PAPER;
}

async function render(size) {
  const SS = 4; // supersampling factor
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
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
