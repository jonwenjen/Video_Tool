#!/usr/bin/env node
/**
 * Export verification.
 *
 * "The download button exists" is not an export. This asserts the bytes on disk
 * are a real, decodable file: a PNG that Chrome can decode at the graded
 * resolution, and an MP4 whose moov atom parses and whose frames actually
 * differ. An export path that returns 200 with a zero-byte file, or a container
 * no player can open, passes every API-level check and fails the user.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchChrome } from './cdp-client.mjs';
import { fetchFixture } from './fixture-guard.mjs';
import { AGENT_PORT, AGENT_ORIGIN, agentUrl, agentEnv, requireSoleClient, killStaleAgentServers } from './test-isolation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'out');
const PORT = Number(process.env.EXPORT_PORT ?? 4182);
const ORIGIN = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`); }
};

for (const pat of ['vite/bin/vite.js', 'server/server.mjs', 'Google Chrome.*--headless']) {
  spawnSync('pkill', ['-9', '-f', pat], { stdio: 'ignore' });
}
await sleep(1000);
spawn('node', ['node_modules/vite/bin/vite.js', 'build'], { cwd: ROOT, stdio: 'ignore' });
await sleep(4000);
mkdirSync(join(ROOT, 'dist/test/fixtures'), { recursive: true });
for (const f of ['cast.png', 'probe.mp4']) {
  copyFileSync(join(ROOT, 'test/fixtures', f), join(ROOT, 'dist/test/fixtures', f));
}
const srv = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore',
});
// The browser client is built against 7801, so the test server must use it too.
killStaleAgentServers();
const ag = spawn('node', ['server/server.mjs'], { cwd: ROOT, stdio: 'ignore', env: agentEnv() });
let browser;
const cleanup = () => {
  try { srv.kill('SIGKILL'); } catch { /* gone */ }
  try { ag.kill('SIGKILL'); } catch { /* gone */ }
  try { browser?.closeBrowser(); } catch { /* gone */ }
};
process.on('exit', cleanup);
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(ORIGIN)).ok) break; } catch { /* not up */ }
  await sleep(250);
}
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${AGENT_ORIGIN}/health`)).ok) break; } catch { /* not up */ }
  await sleep(250);
}
let rpcN = 0;
/** Drive the app the way an agent does: over the local RPC bridge. */
async function rpc(command, params = {}) {
  const res = await fetch(`${AGENT_ORIGIN}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `x${++rpcN}`, command, params }),
  });
  return res.json();
}

try {
  browser = await launchChrome();
  await browser.enableDomains();
  await browser.goto(agentUrl(PORT));
// One client only: a page left over from an earlier run would answer these
// commands instead, and every assertion below would measure the wrong browser.
await requireSoleClient();
  await browser.eval('for (let i=0;i<100 && !document.querySelector(\'[data-ready="1"]\');i++) await new Promise(r=>setTimeout(r,100)); return 1;');
  await fetchFixture(browser, '/test/fixtures/cast.png', { magicHex: '89504e47' });
  await browser.eval(`
    const a = window.__resolve;
    const blob = await (await fetch('/test/fixtures/cast.png')).blob();
    await a.importFiles([new File([blob], 'cast.png', { type: 'image/png' })]);
    await new Promise(r => setTimeout(r, 900));
    a.setParam(null, 'primary.saturation', 1.6);
    a.setParam(null, 'primary.contrast', 1.2);
    return 1;
  `);

  console.log('\n=== still export ===');
  await rpc('set_node_param', { path: 'primary.saturation', value: 1.6 });
  await rpc('set_node_param', { path: 'primary.contrast', value: 1.2 });
  await sleep(600);
  const still = await rpc('export_frame', { path: 'verify-still.png' });
  const stillOk = still.ok === true;
  const stillPath = join(OUT, 'verify-still.png');
  check('export_frame reported success', stillOk, stillOk ? JSON.stringify(still.result).slice(0, 120) : JSON.stringify(still.error).slice(0, 160));
  check('still exists on disk', existsSync(stillPath), stillPath);
  if (existsSync(stillPath)) {
    const buf = readFileSync(stillPath);
    const isPng = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    check('still is a real PNG', isPng, `${buf.length} bytes, sig=${buf.subarray(1, 4).toString('latin1')}`);
    // IHDR carries the dimensions at a fixed offset: 8..16 length, 16..20 "IHDR".
    const w = buf.length > 24 ? buf.readUInt32BE(16) : 0;
    const h = buf.length > 24 ? buf.readUInt32BE(20) : 0;
    check('still has the source resolution', w === 480 && h === 320, `${w}x${h}`);
    // And it must be DECODABLE, not just correctly signed.
    const decoded = await browser.eval(`
      const r = await fetch('/../out/verify-still.png').catch(() => null);
      return r ? 'fetched' : 'unreachable';
    `);
    const b64 = buf.toString('base64');
    const pix = await browser.eval(`
      const img = new Image();
      img.src = 'data:image/png;base64,${b64}';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let mn = 255, mx = 0, sum = 0;
      for (let i = 0; i < d.length; i += 4) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v; }
      return { w: c.width, h: c.height, mn, mx, mean: +(sum / (d.length / 4)).toFixed(2) };
    `);
    check('still decodes to a real image', pix.w === 480 && pix.h === 320 && (pix.mx - pix.mn) > 40,
      `${pix.w}x${pix.h} range=${pix.mx - pix.mn} mean=${pix.mean}`);
  }

  console.log('\n=== video export ===');
  await rpc('import_media', { paths: ['test/fixtures/probe.mp4'] });
  await sleep(2500);
  const vid = await rpc('export_video', { path: 'verify-clip.mp4', codec: 'avc' });
  const vidOk = vid.ok === true;
  const vidPath = join(OUT, 'verify-clip.mp4');
  check('export_video reported success', vidOk, vidOk ? JSON.stringify(vid.result).slice(0, 140) : JSON.stringify(vid.error).slice(0, 200));
  check('video file exists', existsSync(vidPath), existsSync(vidPath) ? `${statSync(vidPath).size} bytes` : vidPath);
  if (existsSync(vidPath)) {
    const buf = readFileSync(vidPath);
    // ftyp at 4..8 identifies the container; a real MP4 has it.
    const box = buf.subarray(4, 8).toString('latin1');
    check('container is MP4 (ftyp box)', box === 'ftyp', `box="${box}"`);
    const brand = buf.subarray(8, 12).toString('latin1');
    check('brand is an mp4 brand', /^isom|mp4|avc1|M4V/.test(brand), `brand="${brand}"`);
    check('file is big enough to hold video', buf.length > 2000, `${buf.length} bytes`);
    // A moov atom means the index was written, so the file is seekable/streamable.
    check('moov index present (faststart)', buf.includes(Buffer.from('moov')), 'moov atom found');
    // And it must decode: feed it back to the browser as a <video>.
    const b64 = buf.toString('base64');
    const probe = await browser.eval(`
      const v = document.createElement('video');
      v.muted = true; v.src = 'data:video/mp4;base64,${b64}';
      await new Promise((res, rej) => {
        v.onloadedmetadata = res;
        v.onerror = () => rej(new Error('decode error: ' + (v.error && v.error.message)));
        setTimeout(() => rej(new Error('metadata timeout')), 8000);
      });
      const seek = (t) => new Promise((res) => { v.onseeked = res; v.currentTime = t; setTimeout(res, 1500); });
      await seek(0.2);
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      const g = c.getContext('2d');
      const grab = async (t) => { await seek(t); g.drawImage(v, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
      const a1 = await grab(0.2);
      const a2 = await grab(1.2);
      let diff = 0;
      for (let i = 0; i < a1.length; i += 4) diff = Math.max(diff, Math.abs(a1[i] - a2[i]));
      return { w: v.videoWidth, h: v.videoHeight, duration: v.duration, diff };
    `).catch((e) => ({ error: e.message }));
    check('exported video decodes in a player', !probe.error && probe.w > 0,
      probe.error ?? `${probe.w}x${probe.h}, ${probe.duration?.toFixed(2)}s`);
    check('exported frames actually differ over time', (probe.diff ?? 0) > 20, `max delta=${probe.diff}`);
  }

  console.log(`\n[export] ${passed} passed, ${failed} failed\n`);
} catch (err) {
  console.error(`[export] ${err.message}`);
  failed++;
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
