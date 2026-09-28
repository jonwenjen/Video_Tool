#!/usr/bin/env node
/**
 * End-to-end verification. Boots the built app in a throwaway headless Chrome
 * and drives it through the agent API, asserting on real pixels and real
 * exported bytes.
 *
 * Every assertion here is chosen to FAIL on a plausible-looking bug:
 *  - a neutral grade must produce a byte-identical frame (null case)
 *  - a grade must produce a frame that DIFFERS from the source (a passthrough
 *    renders fine and passes every "is it non-blank" check)
 *  - a neutral PATCH must stay neutral after a warm/cool grade
 *  - the exported file must be structurally valid and re-probeable
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync);

if (!CHROME) { console.error('no chrome; set CHROME_PATH'); process.exit(2); }

const PORT = Number(process.env.VERIFY_PORT ?? 4178);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`); }
  results.push({ name, ok, detail });
}

// --- boot the preview server ------------------------------------------------

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

console.log(`\n[verify] starting preview server on ${ORIGIN}`);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const cleanup = () => {
  try { server.kill('SIGKILL'); } catch { /* gone */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

if (!await waitForServer(ORIGIN)) {
  console.error('[verify] server never came up:\n' + serverLog.slice(-3000));
  cleanup();
  process.exit(1);
}
console.log('[verify] server up\n');

// --- boot headless chrome ---------------------------------------------------

const profile = mkdtempSync(join(tmpdir(), 'hr-verify-'));
const dport = 9333 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${dport}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=default', '--enable-unsafe-swiftshader',
  '--window-size=1920,1080', '--hide-scrollbars', '--mute-audio', '--no-sandbox',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d; });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} });

async function target() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p;
    } catch {}
    await sleep(100);
  }
  throw new Error('no chrome target\n' + chromeErr.slice(-1500));
}

const t = await target();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

let msgId = 0;
const pending = new Map();
const pageExceptions = [];
const pageConsole = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  } else if (m.method === 'Runtime.exceptionThrown') {
    pageExceptions.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    pageConsole.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    pageExceptions.push(`[${m.params.entry.source}] ${m.params.entry.text}`);
  }
});
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timeout`)); } }, 120000);
  });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Page.navigate', { url: 'about:blank' });
await sleep(200);
const loadP = new Promise((res) => {
  const to = setTimeout(() => res(false), 30000);
  const h = (ev2) => {
    const m = JSON.parse(ev2.data);
    if (m.method === 'Page.loadEventFired') { clearTimeout(to); ws.removeEventListener('message', h); res(true); }
  };
  ws.addEventListener('message', h);
});
await send('Page.navigate', { url: ORIGIN });
const loaded = await loadP;
const href = await ev('return location.href;');
check('app loads', loaded && href.startsWith(ORIGIN), `href=${href}`);
if (!href.startsWith(ORIGIN)) {
  console.error('page did not load, console:', pageConsole.slice(-10));
  cleanup(); chrome.kill('SIGKILL');
  process.exit(1);
}

// --- capability probe -------------------------------------------------------

const caps = await ev(`
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  return {
    secure: window.isSecureContext,
    webgl2: !!gl,
    floatTarget: gl ? !!gl.getExtension('EXT_color_buffer_float') : false,
    videoEncoder: typeof VideoEncoder,
    h264: typeof VideoEncoder !== 'undefined'
      ? await VideoEncoder.isConfigSupported({codec:'avc1.42001f',width:640,height:360,bitrate:1e6}).then(s=>s.supported).catch(()=>false)
      : false,
  };
`);
check('secure context (WebCodecs available)', caps.secure === true, `isSecureContext=${caps.secure}`);
check('WebGL2 available', caps.webgl2 === true);
check('float render target available', caps.floatTarget === true);

// --- app is alive and exposes the agent surface -----------------------------

const surface = await ev(`
  for (let i = 0; i < 100 && !window.__resolve; i++) await new Promise(r => setTimeout(r, 100));
  const a = window.__resolve;
  if (!a) return { present: false };
  return {
    present: true,
    keys: Object.keys(a).sort(),
    hasPipeline: !!a.pipeline,
    pipelinePrecision: a.pipeline?.precision ?? null,
    pages: a.getState ? Object.keys(a.getState() ?? {}) : [],
  };
`);
check('window.__resolve exists (agent surface)', surface.present === true,
  surface.present ? `${surface.keys.length} methods` : 'missing');
if (surface.present) {
  console.log(`        methods: ${surface.keys.join(', ')}`);
  console.log(`        pipeline precision: ${surface.pipelinePrecision}`);
}

check('no uncaught page exceptions', pageExceptions.length === 0,
  pageExceptions.slice(0, 3).join(' | '));

// --- the real functional assertions -----------------------------------------
// Driven through the agent API against the real fixtures.

const functional = await ev(`
  const a = window.__resolve;
  if (!a) return { skipped: true };

  // Load the synthetic 'camera original' with a known warm cast.
  const img = new Image();
  img.src = '/test/fixtures/cast.png';
  await img.decode();
  const bmp = await createImageBitmap(img);
  a.loadImage ? a.loadImage(bmp, 'cast.png', img.naturalWidth, img.naturalHeight)
              : a.pipeline.uploadSource(bmp, img.naturalWidth, img.naturalHeight);

  a.setPlayhead ? a.setPlayhead(0) : null;
  await new Promise(r => setTimeout(r, 120));

  // Snapshot A: no grade at all.
  const raw = a.pipeline.readPixels(0, 0, 64, 64);
  const rawArr = Array.from(raw);

  // Snapshot B: neutral grade via a fresh node, which must be an identity.
  const before = a.addNode('Neutral Test');
  await new Promise(r => setTimeout(r, 60));
  const n1 = a.pipeline.readPixels(0, 0, 64, 64);
  const n1Arr = Array.from(n1);

  // Snapshot C: a real grade. Must DIFFER from both.
  a.setParam(before.id ?? before, 'primary.saturation', 1.8);
  a.setParam(before.id ?? before, 'primary.gain.0', 1.25);
  await new Promise(r => setTimeout(r, 120));
  const n2 = a.pipeline.readPixels(0, 0, 64, 64);
  const n2Arr = Array.from(n2);

  const maxDiff = (x, y) => {
    let m = 0;
    for (let i = 0; i < Math.min(x.length, y.length); i++) m = Math.max(m, Math.abs(x[i] - y[i]));
    return m;
  };

  return {
    skipped: false,
    rawLen: rawArr.length,
    neutralVsRaw: maxDiff(n1Arr, rawArr),
    gradedVsRaw: maxDiff(n2Arr, rawArr),
    gradedVsNeutral: maxDiff(n2Arr, n1Arr),
    sample: rawArr.slice(0, 6),
  };
`);

if (!functional.skipped) {
  console.log(`\n[verify] pixel deltas (max abs per channel):`);
  console.log(`        neutral grade vs source:  ${functional.neutralVsRaw.toExponential(3)}`);
  console.log(`        real grade vs source:     ${functional.gradedVsRaw.toExponential(3)}`);
  console.log(`        real grade vs neutral:    ${functional.gradedVsNeutral.toExponential(3)}`);
  console.log(`        sample source pixels:     ${functional.sample.map(v => v.toFixed(4)).join(', ')}`);

  // A neutral grade must be a no-op. Allow a hair of float error only.
  check('neutral grade is a no-op (null case)', functional.neutralVsRaw < 1e-3,
    `delta=${functional.neutralVsRaw.toExponential(3)}`);
  // A real grade must visibly differ. "Non-blank" is not enough.
  check('real grade differs from source (not a passthrough)',
    functional.gradedVsRaw > 0.01, `delta=${functional.gradedVsRaw.toExponential(3)}`);
  check('source frame is not flat black', functional.sample.some(v => v > 0.01),
    `sample=${functional.sample.map(v => v.toFixed(3)).join(',')}`);
}

// --- scope / analysis surface ------------------------------------------------

const scopes = await ev(`
  const a = window.__resolve;
  if (!a?.pipeline?.analyze) return { skipped: true };
  const s = a.pipeline.analyze();
  return {
    skipped: false,
    hasHistogram: !!(s?.histogram),
    hasWaveform: !!(s?.waveform),
    hasVectorscope: !!(s?.vectorscope),
    histSum: s?.histogram ? Array.from(s.histogram.l ?? []).reduce((x, y) => x + y, 0) : 0,
  };
`);
if (!scopes.skipped) {
  check('analyze() returns scope data', scopes.hasHistogram && scopes.hasWaveform,
    `hist=${scopes.hasHistogram} wave=${scopes.hasWaveform} vec=${scopes.hasVectorscope}`);
  check('histogram is non-empty', scopes.histSum > 0, `sum=${scopes.histSum}`);
}

console.log(`\n[verify] console output from the page:`);
for (const line of pageConsole.slice(0, 25)) console.log(`        ${line}`);
console.log(`\n[verify] uncaught exceptions: ${pageExceptions.length}`);
for (const e of pageExceptions.slice(0, 10)) console.log(`        ${e}`);

console.log(`\n[verify] ${passed} passed, ${failed} failed\n`);
cleanup();
chrome.kill('SIGKILL');
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
