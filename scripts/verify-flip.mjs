#!/usr/bin/env node
/**
 * Picture flip / mirror, and the viewer-header undo buttons.
 *
 * Flip is asserted by pixels, not by aria-pressed: a button that reports
 * pressed while the image is unchanged is the exact failure this session has
 * been about. The fixture is deliberately lopsided — a bright bar hard against
 * its left edge — so a horizontal mirror is detectable by sampling two points
 * that swap.
 */
import { launchChrome } from './cdp-client.mjs';
import { fetchFixture } from './fixture-guard.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.FLIP_PORT ?? 4191);
const ORIGIN = `http://127.0.0.1:${PORT}`;

spawnSync('node', ['node_modules/vite/bin/vite.js', 'build'], { cwd: ROOT, stdio: 'ignore' });
const srv = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore', detached: true });
const stop = () => { try { process.kill(-srv.pid); } catch { /* gone */ } };
for (let i = 0; i < 120; i++) { try { if ((await fetch(`${ORIGIN}/`)).ok) break; } catch { /* not up */ } await sleep(200); }

const results = [];
const note = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

const b = await launchChrome(); const p = b;
await p.enableDomains();
await p.goto(ORIGIN);
await sleep(1600);
await p.eval(`for (let i=0;i<150 && !document.querySelector('[data-ready="1"]');i++) await new Promise(r=>setTimeout(r,100)); return 1;`);

// A lopsided fixture in BOTH axes. The first version was only lopsided
// horizontally, so a vertical flip could not be detected at all — top and
// bottom were the same grey, and the test reported a working feature broken.
await p.eval(`
  const c = document.createElement('canvas');
  c.width = 200; c.height = 120;
  const g = c.getContext('2d');
  g.fillStyle = '#101010'; g.fillRect(0, 0, 200, 120);
  g.fillStyle = '#f0f0f0'; g.fillRect(0, 0, 40, 120);   // bright bar, LEFT
  g.fillStyle = '#3060c0'; g.fillRect(40, 0, 20, 120);
  g.fillStyle = '#e0e040'; g.fillRect(0, 0, 200, 22);  // bright bar, TOP
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  await window.__resolve.importFiles([new File([blob], 'lopsided.png', { type: 'image/png' })]);
  await new Promise(r => setTimeout(r, 1200));
  return 1;
`);

const probe = () => p.eval(`
  const q = window.__resolve.pipeline;
  const w = q.width, h = q.height;
  const at = (fx, fy) => {
    const d = q.readPixels(Math.round(fx * (w - 1)), Math.round(fy * (h - 1)), 1, 1);
    return d ? Math.round(d[0] * 255) : -1;
  };
  return { left: at(0.06, 0.5), right: at(0.94, 0.5), top: at(0.5, 0.06), bottom: at(0.5, 0.94) };
`);

const click = async (sel) => {
  await p.eval(`document.querySelector(${JSON.stringify(sel)}).click(); return 1;`);
  await sleep(420);
};
const pressed = (sel) => p.eval(`return document.querySelector(${JSON.stringify(sel)}).getAttribute('aria-pressed');`);
const disabled = (sel) => p.eval(`return document.querySelector(${JSON.stringify(sel)}).disabled === true;`);

console.log('\n=== the buttons exist where they should ===');
const ui = await p.eval(`
  const h = document.querySelector('#viewer-area .panel-head');
  const r = (s) => { const e = h.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
  return {
    flipX: r('[data-flip="x"]'), flipY: r('[data-flip="y"]'), flipReset: r('[data-flip="reset"]'),
    undo: r('[data-cmd="undo"]'), redo: r('[data-cmd="redo"]'),
    inViewerHeader: !!h.querySelector('[data-flip="x"]'),
  };
`);
note('flip button is in the viewer header', ui.inViewerHeader);
note('flip buttons are a usable hit target', (ui.flipX?.w ?? 0) >= 28 && (ui.flipX?.h ?? 0) >= 20, `${ui.flipX?.w}x${ui.flipX?.h}`);
note('undo button is a usable hit target', (ui.undo?.w ?? 0) >= 50 && (ui.undo?.h ?? 0) >= 20, `${ui.undo?.w}x${ui.undo?.h}`);

console.log('\n=== horizontal flip mirrors the picture ===');
const before = await probe();
note('fixture is lopsided to begin with', Math.abs(before.left - before.right) > 60 && Math.abs(before.top - before.bottom) > 60, `L${before.left} R${before.right} T${before.top} B${before.bottom}`);
await click('[data-flip="x"]');
const afterX = await probe();
note('horizontal flip moves the pixels', afterX.left !== before.left || afterX.right !== before.right,
  `left ${before.left}->${afterX.left}, right ${before.right}->${afterX.right}`);
note('horizontal flip mirrors left and right', Math.abs(afterX.left - before.right) < 12 && Math.abs(afterX.right - before.left) < 12,
  `expected ~${before.right}/${before.left}`);
note('the button reports pressed', (await pressed('[data-flip="x"]')) === 'true');

console.log('\n=== vertical flip ===');
await click('[data-flip="y"]');
const afterY = await probe();
note('vertical flip swaps top and bottom', Math.abs(afterY.top - afterX.bottom) < 12 && Math.abs(afterY.bottom - afterX.top) < 12,
  `top ${afterX.top}->${afterY.top}, bottom ${afterX.bottom}->${afterY.bottom}`);
note('vertical flip leaves left and right alone', afterY.left === afterX.left && afterY.right === afterX.right);

console.log('\n=== both axes, then reset ===');
await click('[data-flip="x"]');
await click('[data-flip="y"]');
const both = await probe();
await click('[data-flip="reset"]');
const reset = await probe();
note('reset restores the original picture', reset.left === before.left && reset.top === before.top && reset.bottom === before.bottom,
  `left=${reset.left} top=${reset.top}`);
note('reset clears both pressed states', (await pressed('[data-flip="x"]')) === 'false' && (await pressed('[data-flip="y"]')) === 'false');
note('two flips cancel out', both.left === before.left && both.top === before.top, 'four toggles return to the original');

console.log('\n=== undo buttons ===');
// Not "starts disabled": importing the fixture is itself a mutation, so the
// stack is legitimately non-empty by now. Assert the relationship instead —
// the button's enabled state must equal whether there is history to undo.
const agree = await p.eval(`
  const d = window.__resolve.getState().undoDepth;
  const btn = document.querySelector('.viewer-tools [data-cmd="undo"]');
  return { depth: d, disabled: btn.disabled, agrees: btn.disabled === (d === 0) };
`);
note('undo button state matches the real stack depth', agree.agrees, `depth=${agree.depth} disabled=${agree.disabled}`);
const satBefore = await p.eval(`
  const a = window.__resolve;
  a.setParam(null, 'primary.saturation', 1.9);
  await new Promise(r => setTimeout(r, 300));
  return a.project.settings.timelineGraph.nodes[0].grade.primary.saturation;
`);
await click('.viewer-tools [data-cmd="undo"]');
const satAfter = await p.eval(`return window.__resolve.project.settings.timelineGraph.nodes[0].grade.primary.saturation;`);
note('undo button reverts a grade change', satBefore === 1.9 && satAfter !== 1.9, `saturation ${satBefore} -> ${satAfter}`);
note('undo button becomes enabled once there is history', !(await disabled('.viewer-tools [data-cmd="undo"]')));
await click('.viewer-tools [data-cmd="redo"]');
const satRedone = await p.eval(`return window.__resolve.project.settings.timelineGraph.nodes[0].grade.primary.saturation;`);
note('redo button puts it back', satRedone === 1.9, `saturation -> ${satRedone}`);

console.log('\n=== flip does not touch the grade ===');
await p.eval(`const a=window.__resolve; a.setParam(null,'primary.saturation',1.9); await new Promise(r=>setTimeout(r,300)); return 1;`);
const gBefore = await p.eval(`return window.__resolve.project.settings.timelineGraph.nodes[0].grade.primary.saturation;`);
const undoDepthBefore = await p.eval(`return window.__resolve.getState().undoDepth;`);
await click('[data-flip="x"]');
const undoDepthAfter = await p.eval(`return window.__resolve.getState().undoDepth;`);
note('flipping does not push an undo entry', undoDepthBefore === undoDepthAfter, `depth ${undoDepthBefore} -> ${undoDepthAfter}`);
await click('[data-flip="x"]');

b.closeBrowser();
stop();

const fails = results.filter((r) => !r.ok);
console.log(`\n[flip] ${results.length} checks, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  - ${f.name}  ${f.detail}`); }
process.exit(fails.length ? 1 : 0);
