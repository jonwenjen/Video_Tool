/**
 * Generate committed test fixtures. No ffmpeg on this machine, so we build
 * video by hand: raw RGB frames -> a minimal Motion JPEG-in-MP4 is too much,
 * so instead we emit (a) a PNG still, and (b) an uncompressed AVI-style raw
 * clip is not browser-decodable — so for browser tests we synthesise frames
 * in-page from these reference images.
 *
 * The browser path uses WebCodecs + a real encode, so for a decodable video
 * fixture we use WebCodecs through headless Chrome (see make-video.mjs).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Fixtures are written twice on purpose: once where the tests read them, and
// once under public/ so `vite build` copies them into dist. The E2E tests
// import media over HTTP from the served origin; without the public copy the
// SPA fallback answers the fixture URL with index.html and a 200, and the whole
// suite silently grades a black frame.
const OUT = join(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_OUT = join(dirname(dirname(OUT)), 'public', 'test', 'fixtures');
mkdirSync(OUT, { recursive: true });
mkdirSync(PUBLIC_OUT, { recursive: true });

// --- minimal PNG encoder ----------------------------------------------------

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** rgb: Uint8Array w*h*3, top-down. Writes an 8-bit RGB PNG. */
function encodePNG(rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    rgb.subarray(y * w * 3, (y + 1) * w * 3)
      .forEach((v, i) => { raw[y * (w * 3 + 1) + 1 + i] = v; });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- test images -----------------------------------------------------------

const W = 480, H = 320;

/**
 * A synthetic "camera original" with KNOWN properties, so grading tests can
 * assert against ground truth instead of eyeballing:
 *  - a strong warm cast (the thing an auto-WB must remove)
 *  - an underexposed mid-grey patch at a known position
 *  - a clipped highlight patch
 *  - a neutral grey patch that MUST stay neutral after a correct grade
 *  - saturated primaries for qualifier tests
 */
function makeCastImage() {
  const d = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const u = x / W, v = y / H;
      let r, g, b;

      if (u < 0.25 && v < 0.5) {
        // 18% grey card, tungsten-lit => known warm cast.
        r = 0.62; g = 0.50; b = 0.34;
      } else if (u >= 0.25 && u < 0.5 && v < 0.5) {
        // Deep shadow detail.
        r = 0.08; g = 0.065; b = 0.05;
      } else if (u >= 0.5 && u < 0.75 && v < 0.5) {
        // Blown highlight.
        r = 1.0; g = 0.98; b = 0.95;
      } else if (u < 0.25 && v >= 0.5) {
        // Saturated primaries block: red, green, blue, yellow quadrants.
        const q = (u / 0.25), r2 = (v - 0.5) / 0.5;
        if (r2 < 0.5) { r = q < 0.5 ? 0.9 : 0.1; g = q < 0.5 ? 0.15 : 0.8; b = q < 0.5 ? 0.15 : 0.1; }
        else { r = 0.95; g = 0.85; b = q < 0.5 ? 0.1 : 0.9; }
      } else if (u >= 0.25 && u < 0.5 && v >= 0.5) {
        // Skin tone ramp.
        const t = (u - 0.25) / 0.25;
        r = 0.35 + t * 0.45; g = 0.22 + t * 0.28; b = 0.17 + t * 0.20;
      } else if (u >= 0.5 && u < 0.75 && v >= 0.5) {
        // 50% flat grey — the neutral anchor.
        r = g = b = 0.5;
      } else {
        // Smooth gradient, useful for banding checks.
        r = v; g = u; b = 0.5 - u * 0.5;
      }
      d[i] = Math.round(Math.min(1, Math.max(0, r)) * 255);
      d[i + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
      d[i + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255);
    }
  }
  return d;
}

/** Pure neutral ramp: any correct pipeline must pass this through unchanged. */
function makeNeutralRamp() {
  const d = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const t = x / (W - 1);
      const v = Math.round(t * 255);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  return d;
}

/** Step wedge: catches banding and quantisation bugs instantly. */
function makeStepWedge() {
  const d = new Uint8Array(W * H * 3);
  const steps = 16;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const s = Math.min(steps - 1, Math.floor((x / W) * steps));
      const v = Math.round((s / (steps - 1)) * 255);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  return d;
}

const files = [
  ['cast.png', makeCastImage()],
  ['neutral-ramp.png', makeNeutralRamp()],
  ['step-wedge.png', makeStepWedge()],
];

for (const [name, data] of files) {
  const p = join(OUT, name);
  const bytes = encodePNG(data, W, H);
  writeFileSync(p, bytes);
  writeFileSync(join(PUBLIC_OUT, name), bytes);
  console.log('wrote', p, W + 'x' + H);
}
