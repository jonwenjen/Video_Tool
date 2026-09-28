#!/usr/bin/env node
/**
 * Playback verification.
 *
 * The bug this exists for: a clip in the media pool with an empty timeline
 * produced a duration of 1, so pressing Play wrapped the playhead 00:00 -> 00:01
 * forever while the viewer showed a still. A test that only checks "play
 * returned true" passes straight through that, so this asserts on the MOTION:
 * the playhead must actually advance, the decoder must actually advance, and
 * the rendered pixels must actually change.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchChrome } from './cdp-client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PLAYBACK_PORT ?? 4180);
const ORIGIN = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`); }
};

if (!existsSync(join(ROOT, 'test/fixtures/probe.mp4'))) {
  console.error('[playback] missing test/fixtures/probe.mp4 — run: npm run fixtures:video');
  process.exit(2);
}

for (const pat of ['vite/bin/vite.js', 'Google Chrome.*--headless']) {
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
const cleanup = () => {
  try { srv.kill('SIGKILL'); } catch { /* gone */ }
  try { browser?.closeBrowser(); } catch { /* gone */ }
};
process.on('exit', cleanup);
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(ORIGIN)).ok) break; } catch { /* not up */ }
  await sleep(250);
}

let browser;
try {
  browser = await launchChrome();
  await browser.enableDomains();
  const href = await browser.goto(ORIGIN);
  if (!href.startsWith(ORIGIN)) throw new Error(`app did not load: ${href}`);
  await browser.eval('for (let i=0;i<100 && !document.querySelector(\'[data-ready="1"]\');i++) await new Promise(r=>setTimeout(r,100)); return 1;');

  console.log('\n=== import a real video ===');
  const imported = await browser.eval(`
    const a = window.__resolve;
    const blob = await (await fetch('/test/fixtures/probe.mp4')).blob();
    const clips = await a.importFiles([new File([blob], 'probe.mp4', { type: 'video/mp4' })]);
    await new Promise(r => setTimeout(r, 1500));
    const c = clips[0] ?? {};
    return { name: c.name, kind: c.kind, w: c.width, h: c.height, frames: c.durationFrames, fps: c.fps };
  `);
  check('video probed with real dimensions', imported.w === 320 && imported.h === 240, JSON.stringify(imported));
  check('video has a real frame count', (imported.frames ?? 0) > 24, `frames=${imported.frames}`);

  console.log('\n=== the timeline is no longer zero-length ===');
  const dur = await browser.eval(`
    const a = window.__resolve;
    const s = a.getState();
    return { durationFrames: s.durationFrames, clips: s.timelineClips.length,
             out: s.outPoint, dur: s.durationFrames, playhead: s.playhead };
  `);
  check('clip landed on the timeline', dur.clips >= 1, `clips=${dur.clips}`);
  check('timeline duration is the clip length', dur.durationFrames >= 24, `durationFrames=${dur.durationFrames}`);

  console.log('\n=== playback actually moves ===');
  const play = await browser.eval(`
    const a = window.__resolve, p = a.pipeline;
    const c = document.querySelector('#viewer');
    const w = c?.width || 0, h = c?.height || 0;
    const mean = (arr) => { let s = 0; for (const v of arr) s += v; return s / arr.length; };
    a.setPlayhead(0);
    await new Promise(r => setTimeout(r, 300));
    const start = a.getState().playhead;
    const started = a.play();
    const samples = [];
    const px = [];
    for (let i = 0; i < 14; i++) {
      await new Promise(r => setTimeout(r, 120));
      samples.push(a.getState().playhead);
      // Whole-frame statistics, not a corner: a clip letterboxed into a larger
      // project resolution leaves the corner static background, which reads as
      // "the picture is frozen" when the picture is fine.
      px.push(mean(p.readPixels(0, 0, p.width || w, p.height || h) ?? []));
    }
    a.pause();
    return {
      started, start, samples,
      videoTime: Number(document.querySelector('video')?.currentTime ?? -1),
      canvas: [w, h],
      videoPaused: document.querySelector('video')?.paused ?? null,
      final: a.getState().playhead,
      frameMeans: px.map((v) => +v.toFixed(5)),
      distinctPixels: (() => {
        let distinct = 0;
        for (let i = 1; i < px.length; i++) if (Math.abs(px[i] - px[0]) > 1e-4) distinct++;
        return distinct;
      })(),
    };
  `);
  check('play() started', play.started === true, `videoPaused=${play.videoPaused}`);
  const maxHead = Math.max(...play.samples);
  check('playhead advances past frame 1', maxHead > 3, `0 → ${maxHead} (${play.samples.join(',')})`);
  check('playhead is monotonic (no 00:00↔00:01 loop)',
    play.samples.every((v, i) => i === 0 || v >= play.samples[i - 1]),
    play.samples.join(','));
  check('decoder clock advances', play.videoTime > 0.05, `video.currentTime=${play.videoTime}`);
  check('canvas matches the clip', play.canvas[0] === 320 && play.canvas[1] === 240,
    `${play.canvas[0]}x${play.canvas[1]}`);
  check('rendered pixels change during playback', play.distinctPixels >= 3,
    `${play.distinctPixels}/13 samples differed from frame 0; means=${play.frameMeans.slice(0, 5).join(' ')}`);

  console.log('\n=== pause stops it ===');
  const paused = await browser.eval(`
    const a = window.__resolve;
    a.setPlayhead(5); await new Promise(r => setTimeout(r, 200));
    a.play(); await new Promise(r => setTimeout(r, 400)); a.pause();
    const at = a.getState().playhead;
    await new Promise(r => setTimeout(r, 400));
    return { at, after: a.getState().playhead, playing: a.getState().playing };
  `);
  check('pause halts the playhead', paused.at === paused.after && paused.playing === false,
    `${paused.at} → ${paused.after}, playing=${paused.playing}`);

  console.log('\n=== scrubbing works ===');
  const scrub = await browser.eval(`
    const a = window.__resolve;
    const seen = [];
    for (const f of [0, 12, 36, 60]) { a.setPlayhead(f); await new Promise(r => setTimeout(r, 250)); seen.push(a.getState().playhead); }
    return seen;
  `);
  check('setPlayhead lands where asked', scrub.every((v, i) => v === [0, 12, 36, 60][i]), scrub.join(','));

  console.log(`\n[playback] ${passed} passed, ${failed} failed\n`);
} catch (err) {
  console.error(`[playback] ${err.message}`);
  failed++;
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
