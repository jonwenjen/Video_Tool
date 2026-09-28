#!/usr/bin/env node
/**
 * Produce test/fixtures/probe.mp4 — a real encoded H.264 clip.
 *
 * Run with the DEV server (not preview), because the generator page imports
 * mp4-muxer as a bare specifier and only Vite's dev server resolves that from
 * node_modules. There is no ffmpeg on this machine, and a still image cannot
 * exercise the <video> playback path, so this is the only way to get a fixture
 * that actually decodes.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchChrome } from './cdp-client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VIDEO_PORT ?? 5199);
const URL_ = `http://127.0.0.1:${PORT}/scripts/make-video.html`;

const dev = spawn('node', ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore',
});
const stop = () => { try { dev.kill('SIGKILL'); } catch { /* gone */ } };
process.on('exit', stop);

for (let i = 0; i < 120; i++) {
  try { if ((await fetch(URL_)).ok) break; } catch { /* not up */ }
  await sleep(250);
}

let browser;
try {
  browser = await launchChrome();
  await browser.enableDomains();
  await browser.goto(URL_);

  let video = null;
  for (let i = 0; i < 200 && !video; i++) {
    video = await browser.eval('return window.__video ?? null;');
    if (!video) await sleep(250);
  }
  if (!video) throw new Error(`generator never finished: ${await browser.eval("return document.getElementById('out').textContent;")}`);

  const buf = Buffer.from(video.base64, 'base64');
  const dir = join(ROOT, 'test/fixtures');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'probe.mp4');
  writeFileSync(out, buf);
  // Also under public/ so `vite build` copies it into dist. The playback test
  // imports it over HTTP from the served origin, and vite's SPA fallback
  // answers a missing path with index.html and a 200 — the test then "plays"
  // an HTML document.
  const pub = join(ROOT, 'public', 'test', 'fixtures');
  mkdirSync(pub, { recursive: true });
  writeFileSync(join(pub, 'probe.mp4'), buf);
  console.log(`[make-video] wrote ${out} — ${video.bytes} bytes, ${video.width}x${video.height}, ${video.frames} frames @ ${video.fps}fps`);
} finally {
  if (browser) browser.closeBrowser();
  stop();
}
if (!existsSync(join(ROOT, 'test/fixtures/probe.mp4'))) process.exit(1);
