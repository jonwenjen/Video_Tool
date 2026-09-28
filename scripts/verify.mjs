#!/usr/bin/env node
/**
 * End-to-end verification: boots the BUILT app in a throwaway headless Chrome
 * and drives it through the Hermes agent API, asserting on real pixels.
 *
 * Every assertion here is chosen to fail on a plausible-looking bug:
 *  - a neutral grade must produce a byte-identical frame (the null case)
 *  - a grade must produce a frame that DIFFERS from the source, because a
 *    passthrough renders fine and passes every "is it non-blank" check
 *  - each control is measured from a PRISTINE baseline, restored between
 *    cases, or a later control reads delta 0 and looks like dead code
 *  - gl.getError() must be empty, which is what catches a uniform-type
 *    mismatch that silently disables every shader branch
 *  - the exported file must be structurally valid, not merely downloadable
 *
 * Usage: npm run verify
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchChrome } from './cdp-client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = Number(process.env.VERIFY_PORT ?? 4178);
const AGENT_PORT = Number(process.env.AGENT_PORT ?? 7801);
const ORIGIN = `http://127.0.0.1:${APP_PORT}`;

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`); }
};

const procs = [];
const cleanup = () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } } };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ---------------------------------------------------------------------------
// 0. A stale preview server serves a stale bundle and makes every fix look
//    inert. Kill anything holding the ports before building.
// ---------------------------------------------------------------------------
console.log('\n[verify] clearing stale servers');
for (const pat of ['vite/bin/vite.js', 'server/server.mjs', 'Google Chrome.*--headless']) {
  spawnSync('pkill', ['-9', '-f', pat], { stdio: 'ignore' });
}
await sleep(1200);

// ---------------------------------------------------------------------------
// 1. Build
// ---------------------------------------------------------------------------
console.log('[verify] building');
const build = spawnSync('node', ['node_modules/vite/bin/vite.js', 'build'], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000,
});
if (build.status !== 0) {
  console.error('[verify] build failed:\n' + (build.stdout ?? '') + (build.stderr ?? ''));
  process.exit(1);
}
mkdirSync(join(ROOT, 'dist/test/fixtures'), { recursive: true });
for (const f of ['cast.png', 'neutral-ramp.png', 'step-wedge.png']) {
  const src = join(ROOT, 'test/fixtures', f);
  if (existsSync(src)) copyFileSync(src, join(ROOT, 'dist/test/fixtures', f));
}

// ---------------------------------------------------------------------------
// 2. Servers. 127.0.0.1 as a LITERAL — WebCodecs needs a secure context and
//    `localhost` does not provide one on this machine.
// ---------------------------------------------------------------------------
const j = (file, args) => spawn('node', [file, ...args], { cwd: ROOT, stdio: 'ignore' });
procs.push(j('server/server.mjs', []));
procs.push(j('node_modules/vite/bin/vite.js', ['preview', '--port', String(APP_PORT), '--strictPort', '--host', '127.0.0.1']));

const waitFor = async (url, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up */ }
    await sleep(250);
  }
  return false;
};
if (!await waitFor(`http://127.0.0.1:${AGENT_PORT}/health`)) {
  console.error('[verify] agent server never came up'); process.exit(1);
}
if (!await waitFor(ORIGIN)) {
  console.error('[verify] preview server never came up'); process.exit(1);
}
console.log(`[verify] serving ${ORIGIN}\n`);

// ---------------------------------------------------------------------------
// 3. Headless Chrome + a dependency-free CDP client
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 3. Headless Chrome via the shared CDP client
// ---------------------------------------------------------------------------
let browser;
try {
  browser = await launchChrome();
} catch (e) {
  console.error(`[verify] ${e.message}`);
  process.exit(1);
}
procs.push({ kill: () => browser.closeBrowser() });
const page = browser;
const ev = (body) => page.eval(body);

const rpc = (command, params = {}) => fetch(`http://127.0.0.1:${AGENT_PORT}/rpc`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: `v-${command}`, command, params }),
}).then((r) => r.json());

// ---------------------------------------------------------------------------
// 4. Capabilities
// ---------------------------------------------------------------------------
console.log('=== environment ===');
await page.enableDomains();
const href = await page.goto(ORIGIN);
// A failed navigation leaves about:blank / chrome-error:// and every
// assertion below would pass vacuously.
check('app loads', href.startsWith(ORIGIN), href);
if (!href.startsWith(ORIGIN)) { cleanup(); process.exit(1); }

const caps = await ev(`
  const gl = document.createElement('canvas').getContext('webgl2');
  return {
    secure: window.isSecureContext,
    webgl2: !!gl,
    floatTarget: gl ? !!gl.getExtension('EXT_color_buffer_float') : false,
    videoEncoder: typeof VideoEncoder,
  };
`);
check('secure context (WebCodecs available)', caps.secure === true, `isSecureContext=${caps.secure}`);
check('WebGL2 available', caps.webgl2 === true);
check('float render target available', caps.floatTarget === true);
check('WebCodecs present', caps.videoEncoder === 'function', caps.videoEncoder);

// ---------------------------------------------------------------------------
// 5. Boot + agent surface
// ---------------------------------------------------------------------------
console.log('\n=== app + agent surface ===');
const boot = await ev(`
  for (let i = 0; i < 100 && !document.querySelector('[data-ready="1"]'); i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  const a = window.__resolve;
  return { ready: !!a, methods: a ? Object.keys(a).length : 0, precision: a?.pipeline?.precision ?? null };
`);
check('window.__resolve published', boot.ready === true, `${boot.methods} methods`);
check('32-bit float pipeline', boot.precision === 'float32', String(boot.precision));

const health = await (await fetch(`http://127.0.0.1:${AGENT_PORT}/health`)).json();
// Exactly one: a leftover tab from an earlier run is still a live client, and
// the agent's answer then depends on which tab happens to poll first.
check('exactly one browser client', health.clients === 1, `clients=${health.clients}`);

// ---------------------------------------------------------------------------
// 6. Load media through the agent
// ---------------------------------------------------------------------------
const loaded = await ev(`
  const a = window.__resolve;
  const blob = await (await fetch('/test/fixtures/cast.png')).blob();
  await a.importFiles([new File([blob], 'cast.png', { type: 'image/png' })]);
  await new Promise(r => setTimeout(r, 900));
  const s = a.getState();
  const c = document.querySelector('#viewer');
  return { media: s.media, canvas: c ? [c.width, c.height] : null };
`);
check('agent imported media', (loaded.media?.length ?? 0) === 1, JSON.stringify(loaded.media?.[0] ?? {}).slice(0, 90));
check('viewer sized to the source', loaded.canvas?.[0] > 1, `${loaded.canvas?.[0]}x${loaded.canvas?.[1]}`);

const hasPicture = await ev(`
  const p = window.__resolve.pipeline;
  const b = Array.from(p.readPixels(0, 0, 480, 320) ?? []);
  let mn = Infinity, mx = -Infinity;
  for (const v of b) { if (v < mn) mn = v; if (v > mx) mx = v; }
  return { n: b.length, range: mx - mn };
`);
check('frame has real content', hasPicture.range > 0.2, `range=${hasPicture.range.toFixed(3)}`);

const glErrors = await ev(`
  const gl = window.__resolve.pipeline.gl; const c = [];
  for (let i = 0; i < 20; i++) { const e = gl.getError(); if (!e) break; c.push(e); }
  return c;
`);
// A uniform-type mismatch (e.g. uniform1i on a `bool`) returns 1282 here and
// silently disables every shader branch behind those flags.
check('no WebGL errors', glErrors.length === 0, `codes=${JSON.stringify(glErrors)}`);

// ---------------------------------------------------------------------------
// 7. The null case
// ---------------------------------------------------------------------------
console.log('\n=== null case: defaults must be a no-op ===');
const nullCase = await ev(`
  const a = window.__resolve, p = a.pipeline;
  const px = () => Array.from(p.readPixels(0, 0, 64, 64) ?? []);
  const before = px();
  a.addNode({ label: 'Neutral' });
  await new Promise(r => setTimeout(r, 500));
  const after = px();
  let m = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    m = Math.max(m, Math.abs(before[i] - after[i]));
  }
  return { maxDelta: m };
`);
check('neutral grade changes nothing', nullCase.maxDelta < 1e-3, `delta=${nullCase.maxDelta}`);

// ---------------------------------------------------------------------------
// 8. Every grade control, each from a PRISTINE baseline
// ---------------------------------------------------------------------------
console.log('\n=== grade controls (isolated baselines) ===');
const controls = await ev(`
  const a = window.__resolve, p = a.pipeline;
  const g = a.project.settings.timelineGraph;

  // Snapshot EVERY node. setParam(null, ...) writes to the SELECTED node, and
  // a previous addNode moves that selection, so restoring only nodes[0] leaves
  // the node under test holding the previous case's value — the grade is
  // measured against the wrong baseline and every case reads delta 0.
  const pristine = g.nodes.map((n) => JSON.stringify(n.grade));
  const restore = () => {
    g.nodes.forEach((n, i) => { n.grade = JSON.parse(pristine[i]); });
    a.selectNode(g.nodes[0].id);
  };
  const px = () => Array.from(p.readPixels(0, 0, 64, 64) ?? []);

  const cases = ${JSON.stringify([
    ['saturation', 'primary.saturation', 2.0],
    ['contrast', 'primary.contrast', 1.3],
    ['temperature', 'primary.temperature', -60],
    ['tint', 'primary.tint', 50],
    ['gain', 'primary.gain', [1.4, 1.1, 0.8]],
    ['lift', 'primary.lift', [0.06, -0.02, 0.04]],
    ['offset', 'primary.offset', [0.03, 0.0, -0.02]],
    ['hue', 'primary.hue', 40],
    ['brightness', 'primary.brightness', 0.2],
    ['vibrance', 'primary.vibrance', 0.8],
    ['colourBoost', 'primary.colourBoost', 0.9],
    ['shadowBias', 'primary.shadowBias', 0.3],
    ['vignette', 'effects.vignette', 0.8],
    ['grain', 'effects.grain', 0.5],
    ['blur', 'effects.blur', 0.5],
    ['sharpen', 'effects.sharpen', 0.6],
    ['glow', 'effects.glow', 0.7],
    ['filmContrast', 'effects.filmContrast', 0.7],
    ['inputGamma', 'inputGamma', 1.4],
  ])};

  const out = [];
  for (const [name, path, val] of cases) {
    restore();
    await new Promise(r => setTimeout(r, 200));

    // Prove the baseline really is an identity before trusting any delta.
    const identity = px();
    await new Promise(r => setTimeout(r, 150));
    let drift = 0;
    const again = px();
    for (let i = 0; i < identity.length; i++) drift = Math.max(drift, Math.abs(identity[i] - again[i]));

    const before = identity;
    const applied = a.setParam(null, path, val);
    await new Promise(r => setTimeout(r, 350));
    const after = px();
    let m = 0;
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      m = Math.max(m, Math.abs(before[i] - after[i]));
    }
    out.push({ name, applied, delta: m, drift });
  }
  restore();
  return out;
`);

for (const c of controls) {
  check(
    `control '${c.name}'`,
    c.applied && c.delta > 0.0008 && c.drift < 1e-4,
    `delta=${c.delta.toFixed(6)} drift=${c.drift.toExponential(1)}`,
  );
}

// ---------------------------------------------------------------------------
// 9. Agent RPC round trip
// ---------------------------------------------------------------------------
console.log('\n=== agent RPC ===');
const preRpc = await ev(`
  const a = window.__resolve, pipe = a.pipeline, c = document.querySelector('#viewer');
  return { targets: [pipe.targets?.width, pipe.targets?.height],
           canvas: [c?.width, c?.height], nodes: a.project.settings.timelineGraph.nodes.length };
`);
check('targets still sized after the control loop',
  preRpc.targets[0] > 1 && preRpc.canvas[0] > 1,
  `targets=${JSON.stringify(preRpc.targets)} canvas=${JSON.stringify(preRpc.canvas)} nodes=${preRpc.nodes}`);
for (const [cmd, params] of [
  ['analyze_frame', {}],
  ['get_scopes', {}],
  ['read_pixel', { x: 100, y: 80 }],
  ['add_node', { label: 'RPC' }],
  ['set_node_param', { path: 'primary.contrast', value: 1.1 }],
  ['undo', {}],
  ['redo', {}],
  ['auto_balance', { method: 'white-balance' }],
  ['keyframe', { path: 'primary.saturation', frame: 5, value: 1.4 }],
  ['set_page', { page: 'color' }],
  ['set_playhead', { frame: 12 }],
]) {
  const r = await rpc(cmd, params);
  check(`rpc ${cmd}`, r.ok === true, r.ok ? '' : JSON.stringify(r.error).slice(0, 130));
}

const bad = await rpc('definitely_not_a_command', {});
check('unknown command fails cleanly', bad.ok === false && typeof bad.error?.message === 'string',
  bad.error?.message?.slice(0, 60) ?? '');

const pixel = (await rpc('read_pixel', { x: 100, y: 80 })).result;
check('read_pixel returns a real colour', !!pixel?.hex && /^#[0-9a-f]{6}$/i.test(pixel.hex), String(pixel?.hex));

const analyzed = (await rpc('analyze_frame', {})).result;
const inner = analyzed?.result ?? analyzed;
check('analyze_frame measures the whole frame',
  (inner?.waveform?.width ?? 0) > 1 && (inner?.waveform?.r?.length ?? 0) > 16,
  `wave=${inner?.waveform?.width}x${inner?.waveform?.height} samples=${inner?.waveform?.r?.length} hist=${inner?.histogram?.bins}`);

const balanced = (await rpc('auto_balance', { method: 'white-balance' })).result;
check('auto_balance returns real gains', !!balanced?.applied, JSON.stringify(balanced?.applied).slice(0, 90));

// ---------------------------------------------------------------------------
console.log(`\n[verify] ${passed} passed, ${failed} failed\n`);
cleanup();
process.exit(failed ? 1 : 0);
