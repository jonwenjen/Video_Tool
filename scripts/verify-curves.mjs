import { launchChrome } from './cdp-client.mjs';
import { fetchFixture } from './fixture-guard.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drive the curve editor with REAL pointer events, the way a person does.
 * Setting the grade through the API proves the shader honours curves; it says
 * nothing about whether clicking the canvas does anything, which is the thing
 * that was broken.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CURVES_PORT ?? 4182);
const ORIGIN = `http://127.0.0.1:${PORT}`;

// Own the build and the server so this can never run against a stale bundle.
spawnSync('node', ['node_modules/vite/bin/vite.js', 'build'], { cwd: ROOT, stdio: 'ignore' });
const server = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore', detached: true });
const stop = () => { try { process.kill(-server.pid); } catch { /* already gone */ } };
for (let i = 0; i < 100; i++) { try { const r = await fetch(`${ORIGIN}/`); if (r.ok) break; } catch { /* not up yet */ } await sleep(200); }

const b = await launchChrome(); const p = b;
await p.enableDomains();
await p.goto(`${ORIGIN}/`);
await sleep(1500);
await p.eval(`for (let i=0;i<100 && !document.querySelector('[data-ready="1"]');i++) await new Promise(r=>setTimeout(r,100)); return 1;`);
await fetchFixture(b, '/test/fixtures/cast.png', { magicHex: '89504e47' });
await p.eval(`
  const a = window.__resolve;
  const blob = await (await fetch('/test/fixtures/cast.png')).blob();
  await a.importFiles([new File([blob], 'cast.png', { type: 'image/png' })]);
  await new Promise(r => setTimeout(r, 1000));
  return 1;
`);

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log(`  PASS  ${n}${d ? '  ' + d : ''}`); } else { fail++; console.log(`  FAIL  ${n}${d ? '  ' + d : ''}`); } };

// Install a helper that dispatches genuine pointer events at graph coords.
await p.eval(`
  window.__curveTest = async (channel, action, gx, gy, opts = {}) => {
    const a = window.__resolve, pipe = a.pipeline;
    const canvas = document.querySelector('[data-curve-canvas="' + channel + '"]');
    const r = canvas.getBoundingClientRect();
    const cx = r.left + gx * r.width;
    const cy = r.top + (1 - gy) * r.height;
    const mean = () => { const W = pipe.width, H = pipe.height; const d = pipe.readPixels(0, 0, W, H); let s = 0; for (const v of d) s += v; return s / d.length; };
    const ev = (type, x, y, extra = {}) => canvas.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, ...extra,
    }));
    const pts = () => JSON.stringify(a.project.settings.timelineGraph.nodes[0].grade.curves[channel]);

    if (action === 'reset') { a.setParam(null, 'curves.' + channel, [{x:0,y:0},{x:1,y:1}]); await new Promise(r=>setTimeout(r,300)); return { pts: pts(), mean: mean() }; }

    const before = mean();
    const beforePts = pts();
    if (action === 'click') { ev('pointerdown', cx, cy, opts); ev('pointerup', cx, cy, opts); }
    if (action === 'drag')  { ev('pointerdown', cx, cy, opts); ev('pointermove', cx + (opts.dx ?? 0), cy + (opts.dy ?? 0), opts); ev('pointerup', cx + (opts.dx ?? 0), cy + (opts.dy ?? 0), opts); }
    await new Promise(r => setTimeout(r, 450));
    return { before, after: mean(), beforePts, pts: pts(), delta: Math.abs(mean() - before) };
  };
  return 1;
`);

console.log('\n=== click on a fresh curve inserts a point ===');
let r = await p.eval('return window.__curveTest("master", "reset");');
const beforePts = r.pts;
r = await p.eval('return window.__curveTest("master", "click", 0.5, 0.2);');
const inserted = JSON.parse(r.pts).length > JSON.parse(beforePts).length;
check('click adds a control point', inserted, `${JSON.parse(beforePts).length} -> ${JSON.parse(r.pts).length} points`);
check('click changes the image', r.delta > 0.0002, `delta=${r.delta?.toFixed(5)}`);

console.log('\n=== dragging a point reshapes the curve ===');
r = await p.eval('return window.__curveTest("master", "drag", 0.5, 0.2, { dy: 60 });');
check('drag moves the point down', r.delta > 0.0002, `delta=${r.delta?.toFixed(5)}`);
const dragged = JSON.parse(r.pts);
check('the point is still there after the drag', dragged.length === JSON.parse(r.beforePts).length, `${dragged.length} points`);

console.log('\n=== per-channel curves ===');
for (const ch of ['red', 'green', 'blue']) {
  await p.eval(`return window.__curveTest("${ch}", "reset");`);
  const c = await p.eval(`return window.__curveTest("${ch}", "click", 0.5, 0.25);`);
  check(`${ch} curve responds`, c.delta > 0.0001, `delta=${c.delta?.toFixed(6)}`);
}

console.log('\n=== alt-click removes a point, double-click resets ===');
r = await p.eval(`
  const a = window.__resolve;
  a.setParam(null, 'curves.master', [{x:0,y:0},{x:0.5,y:0.2},{x:1,y:1}]);
  await new Promise(r => setTimeout(r, 300));
  const canvas = document.querySelector('[data-curve-canvas="master"]');
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + 0.5 * rect.width, cy = rect.top + 0.8 * rect.height;
  canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, altKey: true }));
  canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, altKey: true }));
  await new Promise(r => setTimeout(r, 300));
  const afterAlt = JSON.stringify(a.project.settings.timelineGraph.nodes[0].grade.curves.master);
  canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 300));
  const afterDbl = JSON.stringify(a.project.settings.timelineGraph.nodes[0].grade.curves.master);
  return { afterAlt, afterDbl };
`);
check('alt-click deletes the point', JSON.parse(r.afterAlt).length === 2, r.afterAlt);
check('double-click restores identity', r.afterDbl === JSON.stringify([{ x: 0, y: 0 }, { x: 1, y: 1 }]), r.afterDbl);

console.log(`\n[curves] ${pass} passed, ${fail} failed`);
b.closeBrowser();
stop();
process.exit(fail ? 1 : 0);
