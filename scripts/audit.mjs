#!/usr/bin/env node
/**
 * Full-surface audit.
 *
 * Exercises every agent command, every page, and every bound control, and
 * checks for an OBSERVABLE effect wherever one is expected — not just
 * `ok: true`. A command that returns success while changing nothing is the
 * failure mode this session has been about, so "did it answer" is never the
 * assertion.
 *
 * Run: node scripts/audit.mjs
 */
import { launchChrome } from './cdp-client.mjs';
import { fetchFixture } from './fixture-guard.mjs';
import { AGENT_PORT, AGENT_ORIGIN, agentUrl, agentEnv } from './test-isolation.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'out');
const PORT = Number(process.env.AUDIT_PORT ?? 4186);
const ORIGIN = `http://127.0.0.1:${PORT}`;

mkdirSync(OUT, { recursive: true });
spawnSync('node', ['node_modules/vite/bin/vite.js', 'build'], { cwd: ROOT, stdio: 'ignore' });
const procs = [
  spawn('node', ['server/server.mjs'], { cwd: ROOT, stdio: 'ignore', env: agentEnv(), detached: true }),
  spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore', detached: true }),
];
const stop = () => { for (const q of procs) { try { process.kill(-q.pid); } catch { /* gone */ } } };
for (let i = 0; i < 120; i++) { try { if ((await fetch(`${ORIGIN}/`)).ok) break; } catch { /* not up */ } await sleep(200); }

let seq = 0;
async function rpc(command, params = {}) {
  return fetch(`${AGENT_ORIGIN}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `a${seq++}`, command, params }),
  }).then((r) => r.json()).catch((e) => ({ ok: false, error: { message: String(e) } }));
}

const results = [];
const note = (name, status, detail = '') => {
  results.push({ name, status, detail });
  console.log(`  ${status.toUpperCase().padEnd(4)} ${name}${detail ? '  ' + detail : ''}`);
};
const summarise = (v) => {
  const s = JSON.stringify(v);
  return s.length > 84 ? s.slice(0, 81) + '…' : s;
};
const errText = (r) => String(r?.error?.message ?? r?.error ?? 'no error').slice(0, 88);
const sizeOf = (f) => { try { return readFileSync(f).length; } catch { return 0; } };
// The server re-roots absolute paths under OUT_DIR by design, so a command's
// `path` in the result is the truth. Checking the requested path instead makes
// a working export look like a broken one.
const sizeAt = (r) => (r?.result?.path ? sizeOf(r.result.path) : 0);

const b = await launchChrome(); const p = b;
await p.enableDomains();
await p.goto(agentUrl(PORT));
await sleep(1500);
await p.eval(`for (let i=0;i<150 && !document.querySelector('[data-ready="1"]');i++) await new Promise(r=>setTimeout(r,100)); return 1;`);
await fetchFixture(b, '/test/fixtures/cast.png', { magicHex: '89504e47' });

console.log('\n=== boot ===');
const boot = await p.eval(`
  const a = window.__resolve;
  const blob = await (await fetch('/test/fixtures/cast.png')).blob();
  await a.importFiles([new File([blob], 'cast.png', { type: 'image/png' })]);
  await new Promise(r => setTimeout(r, 1200));
  const s = a.getState();
  return { ready: !!a.pipeline, precision: s.precision, media: s.media.length, tracks: s.tracks.length, clips: s.timelineClips.length };
`);
note('pipeline booted', boot.ready ? 'ok' : 'fail', `precision=${boot.precision}`);
note('media imported', boot.media === 1 ? 'ok' : 'fail', `media=${boot.media}`);
note('timeline has a track', boot.tracks >= 1 ? 'ok' : 'fail', `tracks=${boot.tracks}`);
note('clip landed on the timeline', boot.clips >= 1 ? 'ok' : 'fail', `clips=${boot.clips}`);

const mean = () => p.eval(`
  const pipe = window.__resolve.pipeline;
  const d = pipe.readPixels(0, 0, pipe.width, pipe.height);
  let s = 0; for (const v of d) s += v; return +(s / d.length).toFixed(6);
`);

// Restore a captured pristine grade. Guessing at the app's own reset path
// failed twice: setParam(null,'effects.reset',…) writes a path that does not
// exist, and setGrade is an agent command rather than a method on the app
// object. A captured snapshot cannot drift from the real defaults.
const PRISTINE = await p.eval(`return JSON.stringify(window.__resolve.project.settings.timelineGraph.nodes[0].grade);`);
const reset = () => rpc('set_grade', { grade: JSON.parse(PRISTINE) }).then(() => sleep(220));;

console.log('\n=== read-only commands ===');
for (const cmd of ['agent_commands', 'agent_env', 'list_media', 'list_timeline', 'get_scopes', 'analyze_frame', 'undo', 'redo']) {
  const r = await rpc(cmd, {});
  note(`rpc ${cmd}`, r.ok ? 'ok' : 'fail', r.ok ? summarise(r.result) : errText(r).slice(0, 88));
}

console.log('\n=== pages ===');
const pageIds = await p.eval(`return [...new Set([...document.querySelectorAll('[data-page]')].map(e => e.dataset.page))];`);
for (const page of pageIds) {
  const r = await rpc('set_page', { page });
  await sleep(220);
  const st = await p.eval(`return window.__resolve.getState().page;`);
  note(`set_page ${page}`, r.ok && st === page ? 'ok' : 'fail', r.ok && st === page ? '' : `state.page=${st}`);
}
await rpc('set_page', { page: 'color' });

console.log('\n=== media ===');
{
  const r = await rpc('open_media', { path: 'test/fixtures/probe.mp4' });
  note('rpc open_media', r.ok ? 'ok' : 'fail', r.ok ? summarise(r.result) : errText(r).slice(0, 88));
  const r2 = await rpc('import_media', { paths: ['test/fixtures/neutral-ramp.png'] });
  const n = await p.eval(`return window.__resolve.getState().media.length;`);
  note('rpc import_media', r2.ok && n >= 2 ? 'ok' : 'fail', r2.ok && n >= 2 ? `media=${n}` : errText(r2).slice(0, 88));
  const r3 = await rpc('open_media', { path: '../../../../etc/passwd' });
  note('open_media refuses a path escape', !r3.ok ? 'ok' : 'fail', r3.ok ? 'read outside the sandbox' : errText(r3).slice(0, 70));
}

console.log('\n=== nodes, keyframes, balance ===');
let auditNode = null;
{
  const r = await rpc('add_node', { kind: 'serial', label: 'audit' });
  auditNode = r.result?.id ?? r.result?.nodeId ?? null;
  note('rpc add_node', r.ok && auditNode ? 'ok' : 'fail', r.ok ? `id=${auditNode}` : errText(r).slice(0, 88));

  const r2 = await rpc('set_node_param', { id: auditNode, path: 'primary.saturation', value: 2 });
  const before = await mean();
  await rpc('set_node_param', { id: auditNode, path: 'primary.saturation', value: 1 });
  const after = await mean();
  note('set_node_param changes pixels', r2.ok && Math.abs(before - after) > 1e-4 ? 'ok' : 'fail', `${before} -> ${after}`);
  note('set_node_param reports previous', r2.ok && JSON.stringify(r2.result?.previous) === '2' ? 'ok' : 'fail', `previous=${JSON.stringify(r2.result?.previous)}`);

  const nodes = await p.eval(`return window.__resolve.getState().nodes.map(n => n.id);`);
  const conn = await rpc('connect_nodes', { from: nodes[0], to: nodes[1] });
  note('rpc connect_nodes', conn.ok ? 'ok' : 'fail', conn.ok ? summarise(conn.result) : conn.error.message.slice(0, 88));

  const rk = await rpc('keyframe', { path: 'primary.exposure', frame: 5, value: 1.5 });
  const at5 = await p.eval(`
    const a = window.__resolve, g = a.project.settings.timelineGraph;
    const n = g.nodes.find(x => x.id === ${JSON.stringify(auditNode)}) ?? g.nodes[g.nodes.length - 1];
    return a.pipeline.resolveKeyframes(n.grade, 5).primary.exposure;
  `);
  note('rpc keyframe', rk.ok ? 'ok' : 'fail', rk.ok ? summarise(rk.result) : rk.error.message.slice(0, 88));
  note('keyframe resolves at its own frame', Math.abs(at5 - 1.5) < 1e-6 ? 'ok' : 'fail', `exposure@5=${at5}, expected 1.5`);

  const ab = await rpc('auto_balance', { method: 'white-balance' });
  note('auto_balance white-balance', ab.ok ? 'ok' : 'fail', ab.ok ? summarise(ab.result) : ab.error.message.slice(0, 88));
  const ab2 = await rpc('auto_balance', { method: 'neutral' });
  note('auto_balance neutral', ab2.ok ? 'ok' : 'fail', ab2.ok ? summarise(ab2.result) : ab2.error.message.slice(0, 88));

  const lut = await rpc('apply_lut', { lut: 'nonexistent.cube' });
  note('apply_lut fails loudly on a missing file', !lut.ok ? 'ok' : 'fail', lut.ok ? 'returned ok for a missing file' : lut.error.message.slice(0, 68));

  const rm = await rpc('remove_node', { id: auditNode });
  const left = await p.eval(`return window.__resolve.getState().nodes.length;`);
  note('rpc remove_node', rm.ok ? 'ok' : 'fail', rm.ok ? `nodes=${left}` : rm.error.message.slice(0, 88));
}

console.log('\n=== every grade control moves pixels ===');
// Derived from the app's own default grade at runtime, not hand-listed: an
// earlier hand-written list invented names that do not exist (colorBoost for
// colourBoost, qualifier.sat for satLow), and the resulting "the control does
// nothing" failures were the audit's fault, not the app's.
const GRADE = await p.eval(`
  const a = window.__resolve;
  const g = a.project.settings.timelineGraph.nodes[0].grade;
  const out = [];
  // Pairs that are meaningless alone: a range needs its other end moved, and a
  // mask or a key does nothing until enabled. Enabling first means a genuine
  // no-op is distinguishable from a control that merely needs context.
  const CONTEXT = {
    'window.enabled': true, 'qualifier.enabled': true, 'key.enabled': true,
    'effects.cdl.sat': 1.3,
  };
  const perturbed = (v, key) => {
    if (typeof v === 'number') {
      if (key === 'pivot') return 0.62;
      if (key === 'contrast') return 1.3;
      if (key === 'saturation' || key === 'sat') return 1.5;
      if (key === 'shape') return null;
      if (Math.abs(v) < 1e-6) return 0.4;
      return v + 0.35;
    }
    if (Array.isArray(v)) {
      if (v.length === 3 && v.every(n => typeof n === 'number')) {
        // a direction that changes the image: tilt the channels apart
        return v.map((n, i) => n + (i === 0 ? 0.3 : i === 2 ? -0.2 : 0.05));
      }
      if (v.length === 2 && typeof v[0] === 'number' && typeof v[0]?.x === 'number') {
        return [{ x: 0, y: 0 }, { x: 0.5, y: 0.32 }, { x: 1, y: 1 }];
      }
    }
    if (v === 'ellipse') return 'circle';
    if (typeof v === 'string' && v === 'srgb') return 'rec709';
    return null;
  };
  for (const group of ['primary', 'effects', 'window', 'qualifier', 'key']) {
    const g2 = g[group];
    if (!g2 || typeof g2 !== 'object') continue;
    for (const [key, value] of Object.entries(g2)) {
      const p2 = perturbed(value, key);
      if (p2 !== null) out.push([group + '.' + key, p2]);
    }
    for (const [k, v] of Object.entries(g2)) {
      if (typeof v === 'object' && v && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) {
          const p3 = perturbed(v2, k2);
          if (p3 !== null) out.push([group + '.' + k + '.' + k2, p3]);
        }
      }
    }
  }
  for (const c of Object.entries(CONTEXT)) out.unshift([c[0], c[1]]);
  return out;
`);
for (const [path, value] of GRADE) {
  await reset();
  const before = await mean();
  const r = await rpc('set_node_param', { path, value });
  await sleep(240);
  const after = await mean();
  const delta = Math.abs(after - before);
  note(`grade ${path}`, r.ok && delta > 1e-5 ? 'ok' : 'fail', r.ok ? `Δ=${delta.toFixed(5)}` : errText(r).slice(0, 78));
}
await reset();

console.log('\n=== transport and editing ===');
for (const [cmd, params] of [
  ['goto_timecode', { timecode: '00:00:00:12' }], ['set_playhead', { frame: 30 }],
  ['step_playhead', { frames: 5 }], ['set_loop', { enabled: true }], ['set_range', { in: 0, out: 60 }],
  ['play', {}], ['pause', {}], ['trim_to_playhead', { frame: 20 }],
  ['append_to_track', {}], ['set_clip_enabled', { enabled: false }],
  ['set_clip_enabled', { enabled: true }], ['split', { frame: 30 }],
]) {
  const r = await rpc(cmd, params);
  note(`rpc ${cmd}`, r.ok ? 'ok' : 'fail', r.ok ? summarise(r.result) : errText(r).slice(0, 88));
}

console.log('\n=== error paths must be errors ===');
for (const [cmd, params, label] of [
  ['select_clip', { id: 'does-not-exist' }, 'select_clip with an unknown id'],
  ['set_node_param', { path: 'no.such.path', value: 1 }, 'set_node_param with an unknown path'],
  ['set_page', { page: 'not-a-page' }, 'set_page with an unknown page'],
  ['add_node', { kind: 'nonsense' }, 'add_node with an unknown kind'],
  ['goto_timecode', { timecode: '99:99:99:99' }, 'goto_timecode with a malformed timecode'],
]) {
  const r = await rpc(cmd, params);
  note(label, !r.ok ? 'ok' : 'fail', r.ok ? 'silently accepted bad input' : errText(r).slice(0, 68));
}

console.log('\n=== pixels and files ===');
{
  const r = await rpc('read_pixel', { x: 100, y: 80 });
  note('rpc read_pixel', r.ok && /^#[0-9a-f]{6}$/i.test(r.result?.hex ?? '') ? 'ok' : 'fail', `hex=${r.result?.hex}`);
  const mono = await p.eval(`
    const q = window.__resolve.pipeline;
    const d = q.readPixels(0,0,q.width,q.height);
    return new Set(Array.from(d).map(v => Math.round(v*255))).size;
  `);
  note('the frame is not a flat colour', mono > 8 ? 'ok' : 'fail', `distinct levels=${mono}`);

  const r2 = await rpc('export_frame', { path: join(OUT, 'audit-frame.png') });
  note('rpc export_frame', r2.ok && sizeAt(r2) > 1000 ? 'ok' : 'fail',
    `${sizeAt(r2)} bytes, said ${r2.ok ? summarise(r2.result) : errText(r2).slice(0, 48)}`);

  const r3 = await rpc('export_video', { path: join(OUT, 'audit-clip.mp4') });
  let vbytes = sizeAt(r3), isMp4 = false;
  try { isMp4 = readFileSync(r3.result.path).subarray(4, 8).toString('latin1') === 'ftyp'; } catch { /* absent */ }
  note('rpc export_video', r3.ok && isMp4 ? 'ok' : 'fail',
    `${vbytes} bytes ftyp=${isMp4}, said ${r3.ok ? summarise(r3.result) : errText(r3).slice(0, 48)}`);

  const r4 = await rpc('screenshot', { path: join(OUT, 'audit-shot.png') });
  note('rpc screenshot', r4.ok && sizeAt(r4) > 1000 ? 'ok' : 'fail',
    `${sizeAt(r4)} bytes at ${r4.result?.source ?? '?'}, said ${r4.ok ? summarise(r4.result) : errText(r4).slice(0, 48)}`);

  const r5 = await rpc('save_project', { path: join(OUT, 'audit-project.json') });
  note('rpc save_project', r5.ok ? 'ok' : 'fail', r5.ok ? summarise(r5.result) : errText(r5).slice(0, 78));
}

console.log('\n=== UI ===');
const ui = await p.eval(`
  return {
    controls: document.querySelectorAll('[data-bind]').length,
    scopes: document.querySelectorAll('[data-scope]').length,
    wheels: document.querySelectorAll('[data-wheel-canvas]').length,
    curves: document.querySelectorAll('[data-curve-canvas]').length,
    tracks: document.querySelectorAll('[data-track-id]').length,
    clips: document.querySelectorAll('[data-clip-id]').length,
  };
`);
note('bound controls exist', ui.controls > 50 ? 'ok' : 'fail', `${ui.controls} [data-bind]`);
note('scope widgets exist', ui.scopes >= 3 ? 'ok' : 'warn', `${ui.scopes}`);
note('colour wheels exist', ui.wheels >= 3 ? 'ok' : 'warn', `${ui.wheels}`);
note('curve editors exist', ui.curves >= 3 ? 'ok' : 'warn', `${ui.curves}`);
note('timeline tracks rendered', ui.tracks >= 1 ? 'ok' : 'fail', `${ui.tracks}`);
note('timeline clips rendered', ui.clips >= 1 ? 'ok' : 'fail', `${ui.clips}`);

const dead = await p.eval(`
  const bad = [];
  for (const el of document.querySelectorAll('[data-bind]')) {
    let v;
    try { v = window.__resolve.getParam(el.dataset.bind); } catch (e) { v = 'THREW'; }
    if (v === undefined || v === null) bad.push(el.dataset.bind);
  }
  return bad;
`);
note('every [data-bind] control reads a real param', dead.length === 0 ? 'ok' : 'fail',
  dead.length ? `${dead.length} dead: ${dead.slice(0, 8).join(', ')}` : `${ui.controls} paths resolve`);

// A control that is present and wired but does nothing is the "cannot use"
// case. Drive real slider inputs through the DOM and watch the pixels.
const domCtl = await p.eval(`
  const a = window.__resolve;
  const mean = () => { const q = a.pipeline; const d = q.readPixels(0,0,q.width,q.height); let s=0; for (const v of d) s+=v; return s/d.length; };
  const out = [];
  const sliders = [...document.querySelectorAll('input[type=range][data-bind]')].slice(0, 24);
  for (const el of sliders) {
    const before = mean();
    const orig = el.value;
    const min = Number(el.min || 0), max = Number(el.max || 1);
    el.value = String(orig === String(max) ? min : max);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const after = mean();
    el.value = orig;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => requestAnimationFrame(r));
    out.push({ bind: el.dataset.bind, moved: Math.abs(after - before) > 1e-5 });
  }
  return out;
`);
const deadCtl = domCtl.filter((c) => !c.moved);
note('range inputs move pixels', deadCtl.length === 0 ? 'ok' : 'fail',
  deadCtl.length ? `${deadCtl.length}/${domCtl.length} dead: ${deadCtl.slice(0, 10).map((c) => c.bind).join(', ')}` : `${domCtl.length}/${domCtl.length} live`);

console.log('\n=== console errors ===');
const errs = p.exceptions.filter((e) => !String(e).includes('404'));
if (errs.length === 0) console.log('  none');
for (const e of errs.slice(0, 6)) console.log('  ' + String(e).split('\n')[0].slice(0, 130));

b.closeBrowser();
stop();

const fails = results.filter((r) => r.status === 'fail');
const warns = results.filter((r) => r.status === 'warn');
console.log(`\n[audit] ${results.length} checks — ${results.length - fails.length - warns.length} passed, ${fails.length} failed, ${warns.length} warnings`);
if (fails.length) {
  console.log('\nFAILURES:');
  for (const f of fails) console.log(`  - ${f.name}${f.detail ? '   ' + f.detail : ''}`);
}
process.exit(fails.length ? 1 : 0);
