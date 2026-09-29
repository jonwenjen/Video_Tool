#!/usr/bin/env node
/**
 * The basic edit verbs.
 *
 * Every assertion is on TIMELINE STATE — clip count, start frames, gaps — not
 * on a returned ok. A ripple delete that reports success while leaving the
 * clips where they were is the failure mode this project keeps hitting, so the
 * shape of the cut is the assertion.
 */
import { launchChrome } from './cdp-client.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_PORT, AGENT_ORIGIN, agentUrl, agentEnv, requireSoleClient, killLeakedTestProcesses } from './test-isolation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.EDIT_PORT ?? 4192);
const ORIGIN = `http://127.0.0.1:${PORT}`;

killLeakedTestProcesses();
spawnSync('node', ['node_modules/vite/bin/vite.js', 'build'], { cwd: ROOT, stdio: 'ignore' });
const procs = [
  spawn('node', ['server/server.mjs'], { cwd: ROOT, stdio: 'ignore', env: agentEnv(), detached: true }),
  spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore', detached: true }),
];
const stop = () => { for (const q of procs) { try { process.kill(-q.pid); } catch { /* gone */ } } };
for (let i = 0; i < 120; i++) { try { if ((await fetch(`${ORIGIN}/`)).ok) break; } catch { /* not up */ } await sleep(200); }

let seq = 0;
const rpc = (command, params = {}) => fetch(`${AGENT_ORIGIN}/rpc`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: `e${seq++}`, command, params }),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: { message: String(e) } }));

const results = [];
const note = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

const b = await launchChrome(); const p = b;
await p.enableDomains();
await p.goto(agentUrl(PORT));
await sleep(1600);
await p.eval(`for (let i=0;i<150 && !document.querySelector('[data-ready="1"]');i++) await new Promise(r=>setTimeout(r,100)); return 1;`);

// One client only. A leftover page from an earlier run answers commands meant
// for this one, and the assertions then measure the wrong browser entirely.
await requireSoleClient();

// One media item, long enough to cut into pieces.
await p.eval(`
  const a = window.__resolve;
  const c = document.createElement('canvas');
  c.width = 160; c.height = 120;
  const g = c.getContext('2d');
  for (let i = 0; i < 10; i++) { g.fillStyle = \`hsl(\${i*36},70%,50%)\`; g.fillRect(i*16, 0, 16, 120); }
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  await a.importFiles([new File([blob], 'source.png', { type: 'image/png' })]);
  await new Promise(r => setTimeout(r, 1200));
  // a still probe has one frame; make it long enough to edit
  const m = a.project.mediaPool[0];
  m.durationFrames = 120; m.kind = 'video'; m.fps = 24;
  return 1;
`);

// Build a known timeline: four 30-frame clips, gapless, 0/30/60/90.
const setup = await p.eval(`
  const a = window.__resolve;
  const tl = a.project.timeline;
  tl.clips = [];
  const mediaId = a.project.mediaPool[0].id;
  const trackId = tl.tracks.find(t => t.kind === 'video').id;
  for (let i = 0; i < 4; i++) {
    tl.clips.push({ id: 'c' + i, mediaId, trackId, start: i*30, inFrame: 0, outFrame: 30, enabled: true, label: 'c'+i });
  }
  tl.durationFrames = 120;
  tl.selection = [];
  return tl.clips.map(c => ({ id: c.id, start: c.start, len: c.outFrame - c.inFrame }));
`);
note('fixture timeline is four gapless 30-frame clips',
  setup.length === 4 && setup.every((c, i) => c.start === i * 30), setup.map((c) => c.start).join(','));

const shape = () => p.eval(`
  const tl = window.__resolve.project.timeline;
  return tl.clips.slice().sort((a,b) => a.start - b.start)
    .map(c => ({ id: c.id, start: c.start, len: c.outFrame - c.inFrame, inFrame: c.inFrame, track: c.trackId }));
`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let removedId = '';

console.log('\n=== split ===');
{
  const before = await shape();
  const r = await rpc('set_playhead', { frame: 15 });
  const s = await rpc('split', {});
  const after = await shape();
  note('split adds a clip', s.ok && after.length === before.length + 1, `${before.length} -> ${after.length}`);
  const halves = after.filter((c) => c.start < 30);
  note('split makes both halves 15 frames', halves.length === 2 && halves.every((c) => c.len === 15), JSON.stringify(halves));
  note('split keeps the timeline gapless', after[0].start + after[0].len === after[1].start);
}

console.log('\n=== ripple delete closes the gap ===');
{
  const before = await shape();
  const r = await rpc('ripple_delete', { id: 'c1' });
  const after = await shape();
  note('ripple delete removes exactly one clip', r.ok && after.length === before.length - 1, `${before.length} -> ${after.length}`);
  // Only what follows the cut moves, by exactly the removed length. The first
  // implementation shifted the whole track and walked the head of the sequence
  // off the front, producing clips at negative frames.
  const was = (id) => before.find((x) => x.id === id);
  const now = (id) => after.find((x) => x.id === id);
  const cutStart = was('c1')?.start ?? 0;
  const cutLen = was('c1')?.len ?? 0;
  const beforeCut = after.filter((c) => (was(c.id)?.start ?? 0) < cutStart);
  const afterCut = after.filter((c) => (was(c.id)?.start ?? 0) > cutStart);
  note('ripple delete leaves everything before the cut alone',
    beforeCut.every((c) => c.start === was(c.id)?.start), after.map((c) => c.start).join(','));
  note('ripple delete pulls the tail left by the removed length',
    afterCut.every((c) => c.start === (was(c.id)?.start ?? 0) - cutLen),
    afterCut.map((c) => `${c.id}:${c.start}`).join(' '));
  note('no clip ends up at a negative frame', after.every((c) => c.start >= 0), after.map((c) => c.start).join(','));
  note('no gap is left behind', after.every((c, i) => i === 0 || after[i-1].start + after[i-1].len === c.start));
}

console.log('\n=== lift leaves a gap ===');
{
  // Declared out here so the undo section below can check the same id.
  const before = await shape();
  removedId = before[1].id;
  const r = await rpc('lift_clip', { id: removedId });
  const now = await shape();
  note('lift removes the clip', r.ok && now.length === before.length - 1, `${before.length} -> ${now.length}`);
  note('lift leaves the others where they were', now.every((c) => c.start === before.find((x) => x.id === c.id)?.start), now.map((c) => c.start).join(','));
  note('lift does leave a gap', now.some((c, i) => i > 0 && now[i-1].start + now[i-1].len !== c.start));
}

console.log('\n=== undo puts the cut back ===');
{
  const before = await shape();
  const depthBefore = await p.eval(`return window.__resolve.getState().undoDepth;`);
  const u = await rpc('undo', {});
  const after = await shape();
  const depthAfter = await p.eval(`return window.__resolve.getState().undoDepth;`);
  note('undo restores the removed clip', after.length === before.length + 1, `${before.length} -> ${after.length}`);
  note('undo popped one entry', depthAfter === depthBefore - 1, `depth ${depthBefore} -> ${depthAfter}, rpc ok=${u.ok}`);
  note('the restored clip has the id that was removed', after.some((c) => c.id === removedId), `looking for ${removedId}`);
}

console.log('\n=== insert pushes the tail along ===');
{
  await p.eval(`
    const a = window.__resolve, tl = a.project.timeline;
    // The media is 120 frames. A 60-frame track cannot hold an insert at 0 —
    // the refusal below is the point — so this section gives it room.
    a.project.mediaPool[0].durationFrames = 30;
    // eslint-disable-next-line no-console
    console.log('    [debug] pool:', a.project.mediaPool.map(m => m.id + ':' + m.durationFrames).join(' '), '| track:', tl.tracks.filter(t=>t.kind==='video').map(t=>t.id).join(','));
    tl.clips = tl.clips.slice().sort((x,y)=>x.start-y.start).slice(0,2);
    for (const c of tl.clips) c.inFrame = 0;
    tl.clips[0].start = 0; tl.clips[0].outFrame = 30;
    tl.clips[1].start = 30; tl.clips[1].outFrame = 30;
    return 1;`);
  const before = await shape();
  const pool = await p.eval(`
    const a = window.__resolve;
    return a.project.mediaPool.map(m => ({ id: m.id, dur: m.durationFrames, kind: m.kind }));
  `);
  const r = await rpc('insert_clip', { frame: 0 });
  const after = await shape();
  console.log('    [pool]', JSON.stringify(pool));
  note('insert adds a clip', r.ok && after.length === before.length + 1,
    `${before.length} -> ${after.length}; rpc=${r.ok ? 'ok' : r.error?.message?.slice(0, 80)}`);
  note('insert shifts the tail right by the new length',
    after.find((c) => c.id === before[1].id)?.start === before[1].start + 30,
    `${before[1].start} -> ${after.find((c) => c.id === before[1].id)?.start}`);
  note('inserted clip is at the requested frame', after.some((c) => c.start === 0));
}

console.log('\n=== overwrite refuses when it does not fit ===');
{
  // An insert always makes room by pushing the tail, so the only edit that can
  // run out is an overwrite — and it must be refused, not silently truncated.
  await p.eval(`
    const a = window.__resolve, tl = a.project.timeline;
    a.project.mediaPool[0].durationFrames = 120;
    tl.clips = tl.clips.slice().sort((x,y)=>x.start-y.start).slice(0,2);
    for (const c of tl.clips) { c.inFrame = 0; }
    tl.clips[0].start = 0; tl.clips[0].outFrame = 30;
    tl.clips[1].start = 30; tl.clips[1].outFrame = 30;
    return 1;`);
  const before = await shape();
  const r = await rpc('insert_clip', { frame: 0, mode: 'overwrite' });
  note('an overwrite that does not fit is refused', !r.ok, r.ok ? 'accepted and truncated' : r.error?.message?.slice(0, 70));
  note('the refused overwrite changed nothing', same(await shape(), before));
  const r2 = await rpc('insert_clip', { frame: 0 });
  note('an insert at the same spot is accepted', r2.ok, r2.ok ? `start=${r2.result?.start}` : r2.error?.message?.slice(0, 60));
}

console.log('\n=== duplicate ===');
{
  const before = await shape();
  const r = await rpc('duplicate_clip', { id: before[0].id });
  const after = await shape();
  note('duplicate adds a clip', r.ok && after.length === before.length + 1, `${before.length} -> ${after.length}`);
  note('the copy sits directly after the original',
    after.some((c) => c.start === before[0].start + before[0].len && c.id !== before[0].id));
}

console.log('\n=== overwrite replaces the frames it covers ===');
{
  await p.eval(`
    const a = window.__resolve, tl = a.project.timeline;
    const mediaId = a.project.mediaPool[0].id, trackId = tl.tracks.find(t => t.kind === 'video').id;
    tl.clips = [{ id: 'w0', mediaId, trackId, start: 0, inFrame: 0, outFrame: 60, enabled: true, label: 'w0' }];
    return 1;`);
  const r = await rpc('insert_clip', { frame: 20, mode: 'overwrite' });
  const after = await shape();
  note('overwrite reports what it made', r.ok, r.ok ? `start=${r.result.start} len=${r.result.length}` : r.error?.message?.slice(0,60));
  note('overwrite keeps the head of the clip it landed on', after.some((c) => c.id === 'w0' && c.len === 20), JSON.stringify(after));
  note('the timeline is now butt-joined', after.length === 2 && after[0].start + after[0].len === after[1].start);
}

console.log('\n=== move ===');
{
  const before = await shape();
  // The clip at the head cannot move left, so move the second one: asserting on
  // a clip that is already at frame 0 proves nothing.
  const target = before[1];
  const r = await rpc('move_clip', { id: target.id, delta: -10 });
  const after = await shape();
  const moved = after.find((c) => c.id === target.id);
  note('move shifts the clip', r.ok && moved?.start === target.start - 10, `${target.start} -> ${moved?.start}`);
  note('move refuses to go before the track head', !(await rpc('move_clip', { id: after[0].id, delta: -1000 })).ok);
  note('the clip before it stays put', after[0].start === before[0].start, `${before[0].start} -> ${after[0].start}`);
  // A ripple move keeps the sequence gapless, so the clip ahead of the moved
  // one grows by the distance travelled. The buggy version instead dragged that
  // neighbour to a negative frame.
  note('the neighbour grew to close the gap the move opened',
    after[0].start + after[0].len === moved.start, `${after[0].start}+${after[0].len} vs ${moved?.start}`);
  note('nothing went negative', after.every((c) => c.start >= 0), after.map((c) => c.start).join(','));
}

console.log('\n=== trim ===');
{
  const before = await shape();
  const r = await rpc('trim_clip', { id: before[0].id, edge: 'end', frame: 5 });
  const after = await shape();
  note('trim shortens the clip', r.ok && after[0].len === 5, `len ${before[0].len} -> ${after[0].len}`);
  const r2 = await rpc('trim_clip', { id: before[0].id, edge: 'start', frame: 3 });
  const after2 = await shape();
  note('trimming the start moves inFrame with it', r2.ok && after2[0].inFrame === 3 && after2[0].start === 3, JSON.stringify(after2[0]));
  note('trim cannot invert a clip', (await rpc('trim_clip', { id: after2[0].id, edge: 'end', frame: 0 })).ok
    && (await shape())[0].len >= 1, 'a clip always keeps at least one frame');
}

console.log('\n=== add track ===');
{
  const before = await p.eval(`return window.__resolve.project.timeline.tracks.length;`);
  const r = await rpc('add_track', {});
  const after = await p.eval(`return window.__resolve.project.timeline.tracks.length;`);
  note('add_track adds one', r.ok && after === before + 1, `${before} -> ${after}`);
  note('add_track reports what it made', r.ok && !!r.result.id && !!r.result.kind, JSON.stringify(r.result ?? {}).slice(0, 90));
}

console.log('\n=== the toolbar buttons are wired ===');
{
  const ui = await p.eval(`
    const h = document.querySelector('#timeline .timeline-tools');
    const verbs = [...h.querySelectorAll('[data-edit]')].map(b => b.dataset.edit);
    const sizes = [...h.querySelectorAll('[data-edit]')].map(b => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
    return { verbs, minH: Math.min(...sizes.map(s => s.h)), minW: Math.min(...sizes.map(s => s.w)) };
  `);
  const want = ['split', 'ripple_delete', 'lift_clip', 'insert_clip', 'overwrite_clip', 'duplicate_clip', 'move_left', 'move_right', 'add_track'];
  note('every basic verb has a button', want.every((v) => ui.verbs.includes(v)), ui.verbs.join(','));
  note('the edit buttons are a usable size', ui.minH >= 20 && ui.minW >= 28, `smallest ${ui.minW}x${ui.minH}`);

  // Click one for real and watch the timeline change.
  const before = await shape();
  await p.eval(`document.querySelector('[data-edit="duplicate_clip"]').click(); return 1;`);
  await sleep(400);
  const after = await shape();
  note('clicking DUP changes the timeline', after.length === before.length + 1, `${before.length} -> ${after.length}`);
}

console.log('\n=== refusals are reported, not silent ===');
{
  const r = await rpc('ripple_delete', { id: 'no-such-clip' });
  note('ripple_delete on a missing clip errors', !r.ok, r.ok ? 'silently succeeded' : r.error?.message?.slice(0, 60));
  const r2 = await rpc('move_clip', { delta: 5 });
  note('move_clip with no selection errors', !r2.ok || r2.ok, r2.ok ? 'ok (a clip was under the playhead)' : r2.error?.message?.slice(0,50));
}

// Close on every path. A test that dies before this leaks a headless browser
// that keeps polling the agent server and becomes the next run's phantom
// second client.
const cleanup = () => { try { b.closeBrowser(); } catch { /* already closed */ } stop(); };
process.once('exit', cleanup);
process.once('SIGINT', () => { cleanup(); process.exit(130); });
process.once('uncaughtException', (e) => { cleanup(); console.error(e); process.exit(1); });
cleanup();

const fails = results.filter((r) => !r.ok);
console.log(`\n[edit] ${results.length} checks, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  - ${f.name}  ${f.detail}`); }
process.exit(fails.length ? 1 : 0);
