/**
 * Measure an underwater clip and show what a grade does to it.
 *
 * Decodes real frames from the file, applies the grade to the actual pixels,
 * and reports before/after statistics. Parameters are not evidence — this is.
 * The grade constant below is derived from the numbers this prints.
 *
 *   UNDERWATER_VIDEO=~/Movies/clip.mp4 node scripts/underwater-grade.mjs
 */
import { launchChrome } from './cdp-client.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentUrl, agentEnv } from './test-isolation.mjs';
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4201;
const FILE_PORT = 4202;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIDEO = process.env.UNDERWATER_VIDEO;

// ---------------------------------------------------------------------------
// The grade.
//
// Every number here is derived from a measurement of THIS clip, taken by
// decoding it — see the "before" column printed at the end:
//
//   mean R/G/B = 0.334 / 0.526 / 0.365     G/R = 1.55 (red heavily absorbed)
//   p10 = 0.275, p90 = 0.71                 (a milky veil, not a dark scene)
//   blackPct = 0                            (nothing is actually black)
//
// The look being asked for is clear water: red present, shadows cyan, no
// veil, real contrast. That means three specific corrections, not a global
// colour shift.
// ---------------------------------------------------------------------------
export const GRADE = {
  primary: {
    // 1. RED RECOVERY. Red is 55% down on green. A flat gain on red alone
    //    would brighten reds everywhere including the already-correct
    //    highlights, so the gain sets the midtone and the red curve does the
    //    shadow half.
    gain: [1.38, 0.95, 1.12],
    // 2. DE-HAZE. The veil sits in the shadows (p10 = 0.275), so it is a
    //    shadow problem, not an exposure problem. Pedestal, weighted so the
    //    red channel — the one that was NOT carrying the veil — moves least.
    offset: [-0.05, -0.09, -0.08],
    // 3. CONTRAST. 0.27..0.71 has to reach roughly 0.10..0.94.
    contrast: 1.5,
    pivot: 0.42,
    // 4. COLOUR. Slightly less green, a touch more vibrance so the recovered
    //    red does not read as a stain.
    saturation: 1.12,
    vibrance: 0.18,
    // Shadows toward cyan: the visual signature of looking into clear water.
    shadowBias: 0.06,
  },
  curves: {
    // The red recovery, applied only to red. A straight lift would tint every
    // shadow red; this keeps the toe neutral and lifts the midtones, which is
    // where the lost channel actually lived.
    // Deliberately gentle. The 1.5x gain already carries the red recovery; an
    // aggressive curve on top double-counted it and the first attempt came out
    // at G/R 0.68 — red-dominant, the opposite of underwater.
    red: [
      { x: 0, y: 0 },
      { x: 0.2, y: 0.235 },
      { x: 0.5, y: 0.55 },
      { x: 0.8, y: 0.83 },
      { x: 1, y: 1 },
    ],
    // The master curve finishes the contrast: pulls the toe down against the
    // residual veil, then rolls the shoulder so the highlights do not clip.
    master: [
      { x: 0, y: 0 },
      { x: 0.1, y: 0.07 },
      { x: 0.27, y: 0.235 },
      { x: 0.45, y: 0.47 },
      { x: 0.71, y: 0.83 },
      { x: 0.92, y: 0.98 },
      { x: 1, y: 1 },
    ],
    mode: 'custom',
  },
};

spawnSync('node', ['node_modules/vite/bin/vite.js', 'build'], { cwd: ROOT, stdio: 'ignore' });
const fileServer = createServer((req, res) => {
  try {
    const size = statSync(VIDEO).size;
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': size,
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
    });
    createReadStream(VIDEO).pipe(res);
  } catch (err) {
    res.writeHead(500); res.end(String(err));
  }
});
await new Promise((r) => fileServer.listen(FILE_PORT, '127.0.0.1', r));

const procs = [
  spawn('node', ['server/server.mjs'], { cwd: ROOT, stdio: 'ignore', env: agentEnv(), detached: true }),
  spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore', detached: true }),
];
const stop = () => { try { fileServer.close(); } catch { /* closed */ } for (const q of procs) { try { process.kill(-q.pid); } catch { /* gone */ } } };
for (let i = 0; i < 150; i++) { try { if ((await fetch(`${ORIGIN}/`)).ok) break; } catch { /* not up */ } await sleep(200); }

const b = await launchChrome(); const p = b;
await p.enableDomains();
await p.goto(agentUrl(PORT));
await p.eval(`for (let i=0;i<150 && !document.querySelector('[data-ready="1"]');i++) await new Promise(r=>setTimeout(r,100)); return 1;`);

const out = await p.eval(`
  return (async () => {
    const GRADE = ${JSON.stringify(GRADE)};
    const res = await fetch('http://127.0.0.1:' + ${FILE_PORT} + '/footage.mp4');
    const buf = new Uint8Array(await res.arrayBuffer());

    const curve = (pts, x) => {
      if (x <= pts[0].x) return pts[0].y;
      for (let i = 1; i < pts.length; i++) {
        if (x <= pts[i].x) {
          const a = pts[i-1], c = pts[i];
          const t = (x - a.x) / Math.max(c.x - a.x, 1e-6);
          return a.y + (c.y - a.y) * t;
        }
      }
      return pts[pts.length-1].y;
    };

    // The same order the GPU pipeline uses: channels -> wheels/tonemap ->
    // curves, all in display-referred space, which is what these measurements
    // are. Linear-light would need the measurements redone in scene-linear.
    const applyGrade = (rgb) => {
      const P = GRADE.primary;
      let [r, g, b] = rgb;
      r = Math.min(1, r * P.gain[0]);
      g = Math.min(1, g * P.gain[1]);
      b = Math.min(1, b * P.gain[2]);
      // contrast about the pivot, THEN the pedestal. Applying the offset first
      // dragged the whole image down before the contrast could lift it back,
      // and the first attempt measured darker than the original.
      [r, g, b] = [r, g, b].map((v) => P.pivot + (v - P.pivot) * P.contrast);
      r = Math.max(0, r + P.offset[0]);
      g = Math.max(0, g + P.offset[1]);
      b = Math.max(0, b + P.offset[2]);
      // curves
      r = curve(GRADE.curves.red, Math.max(0, Math.min(1, r)));
      const m = curve(GRADE.curves.master, Math.max(0, Math.min(1, (r + g + b) / 3)));
      // master is applied as a luma-preserving adjustment so the red recovery
      // survives; a straight per-channel curve would undo it.
      const lm = Math.max(r, g, b);
      const k = lm > 0 ? m / lm : 1;
      r = r * k; g = g * k; b = b * k;
      // saturation + vibrance, approximated on the mean
      const mean = (r + g + b) / 3;
      const sat = 1 + (P.saturation - 1) * (1 - Math.min(1, mean));
      r = mean + (r - mean) * sat;
      g = mean + (g - mean) * sat;
      b = mean + (b - mean) * sat;
      return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
    };

    const stats = (d) => {
      let R=0,G=0,B=0,n=0,black=0,white=0;
      const hist = new Array(256).fill(0);
      for (let i = 0; i < d.length; i += 4) {
        R+=d[i]; G+=d[i+1]; B+=d[i+2]; n++;
        if (d[i] < 12) black++;
        if (d[i] > 243) white++;
        hist[Math.round(0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2])]++;
      }
      const pct = (q) => { let acc=0; for (let i=0;i<256;i++){ acc+=hist[i]; if (acc >= n*q) return i; } return 255; };
      return {
        mean: [+(R/n).toFixed(1), +(G/n).toFixed(1), +(B/n).toFixed(1)],
        rOverB: +((R/n)/Math.max(B/n,1e-6)).toFixed(3),
        gOverR: +((G/n)/Math.max(R/n,1e-6)).toFixed(3),
        blackPct: +(100*black/n).toFixed(1),
        whitePct: +(100*white/n).toFixed(2),
        p10: pct(0.1), p90: pct(0.9),
      };
    };

    const report = [];
    for (const t of [0.5, 1.5, 2.5, 3.5]) {
      const c = document.createElement('canvas');
      c.width = 320; c.height = Math.round(320 * 2160 / 3840);
      const g = c.getContext('2d', { willReadFrequently: true });
      const v = document.createElement('video');
      v.muted = true; v.src = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
      await new Promise((r) => { v.onloadeddata = r; setTimeout(r, 4000); });
      v.currentTime = t;
      await new Promise((r) => { v.onseeked = r; setTimeout(r, 4000); });
      g.drawImage(v, 0, 0, c.width, c.height);
      const before = g.getImageData(0, 0, c.width, c.height);
      const outImg = g.createImageData(c.width, c.height);
      for (let i = 0; i < before.data.length; i += 4) {
        const [r2, g2, b2] = applyGrade([before.data[i]/255, before.data[i+1]/255, before.data[i+2]/255]);
        outImg.data[i] = Math.round(r2*255);
        outImg.data[i+1] = Math.round(g2*255);
        outImg.data[i+2] = Math.round(b2*255);
        outImg.data[i+3] = 255;
      }
      report.push({ t, before: stats(before.data), after: stats(outImg.data) });
    }
    return report;
  })()
`);

const pad = (s, n) => String(s).padEnd(n);
console.log('\n  MEASURED ON THE REAL CLIP, DECODED — not on parameters\n');
for (const r of out) {
  console.log(`  t = ${r.t}s`);
  console.log(`    before  mean ${pad(JSON.stringify(r.before.mean), 22)} G/R ${pad(r.before.gOverR, 7)} R/B ${pad(r.before.rOverB, 7)} p10 ${pad(r.before.p10, 5)} p90 ${pad(r.before.p90, 5)} black ${r.before.blackPct}%`);
  console.log(`    after   mean ${pad(JSON.stringify(r.after.mean), 22)} G/R ${pad(r.after.gOverR, 7)} R/B ${pad(r.after.rOverB, 7)} p10 ${pad(r.after.p10, 5)} p90 ${pad(r.after.p90, 5)} black ${r.after.blackPct}%`);
}
b.closeBrowser();
stop();
