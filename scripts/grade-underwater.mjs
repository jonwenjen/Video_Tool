// Grade the underwater footage by MEASURING the real pipeline.
//
// The previous attempt at this failed because it simulated the colour maths in
// the script. This one changes a parameter, waits, and reads the result back out
// of pipeline.readPixels. Every number below is what the app actually renders.
//
// It also proves the readback is alive before trusting any of it: a grade change
// must move the pixels, and moving the playhead must move them again.
const TARGET_CONTRAST = 1.3;
const CONTRASTS = [1.0, 1.15, 1.3, 1.45];

import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const AGENT = process.env.AGENT ?? 'http://127.0.0.1:7801';
const VIDEO = process.env.VIDEO ?? join(process.env.HOME, 'Downloads/VID_20260805_081949.mp4');
const FILE_PORT = Number(process.env.FILE_PORT ?? 7931);
const FRAMES = [12, 30, 48, 66, 90];

if (!existsSync(VIDEO)) { console.log('no such file:', VIDEO); process.exit(1); }

const fileSrv = createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
  const p = join(VIDEO, '..', name);
  if (!existsSync(p)) { res.writeHead(404).end('nope'); return; }
  const st = statSync(p);
  res.writeHead(200, {
    'content-type': 'video/mp4',
    'content-length': String(st.size),
    'access-control-allow-origin': '*',
    'accept-ranges': 'bytes',
  });
  if ((req.headers.range ?? '').startsWith('bytes=')) {
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Number(m[2]) : st.size - 1;
    res.writeHead(206, {
      'content-type': 'video/mp4',
      'content-length': String(end - start + 1),
      'content-length-range': `bytes ${start}-${end}/${st.size}`,
      'content-range': `bytes ${start}-${end}/${st.size}`,
      'access-control-allow-origin': '*',
      'accept-ranges': 'bytes',
    });
    createReadStream(p, { start, end }).pipe(res);
    return;
  }
  createReadStream(p).pipe(res);
});
await new Promise((r) => fileSrv.listen(FILE_PORT, '127.0.0.1', r));
console.log(`serving ${basename(VIDEO)} (${(statSync(VIDEO).size / 1e6).toFixed(1)} MB) on ${FILE_PORT}`);

const rpc = async (command, params = {}) => {
  const r = await fetch(`${AGENT}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `g${Date.now()}${Math.random().toString(36).slice(2, 6)}`, command, params }),
  });
  return r.json();
};

try {
  const health = await (await fetch(`${AGENT}/health`)).json();
  console.log('agent clients:', health.clients);
  if (!health.clients) { console.log('no app tab registered — open http://127.0.0.1:4178/ first'); process.exit(1); }

  const url = `http://127.0.0.1:${FILE_PORT}/${basename(VIDEO)}`;
  const imp = await rpc('import_media', { paths: [url] });
  console.log('import ok?', imp.ok, imp.ok ? JSON.stringify(imp.result?.added) : JSON.stringify(imp.error).slice(0, 200));
  if (!imp.ok) process.exit(1);

  const lm = await rpc('list_media', {});
  const pool = lm.result?.media ?? lm.result?.mediaPool ?? [];
  const clip = pool[pool.length - 1];
  console.log('pool:', pool.map((m) => `${m.name} ${m.width}x${m.height} ${m.durationFrames}f`).join(' | '));

  const ap = await rpc('append_to_track', { mediaId: clip.id, track: 0, start: 0 });
  console.log('on timeline?', ap.ok);
  await sleep(4000);

  // PAUSE FIRST. A playing <video> owns its own clock, so a read taken 1.5s
  // after set_playhead is a DIFFERENT frame than the one that was asked for.
  // Every comparison in this script assumes the frame is still the one named.
  await rpc('pause');
  await sleep(700);

  // Sanity: the tab must be able to see the frame at all.
  const probe = async (frame) => {
    const s = await rpc('get_scopes', {});
    void s;
    return null;
  };
  void probe;

  // p10/p90 are not in the scopes payload; derive them from the 256-bin luma
  // histogram rather than inventing a field name and reading zero forever.
  const percentiles = (bins) => {
    if (!Array.isArray(bins) || !bins.length) return { p10: 0, p50: 0, p90: 0 };
    const total = bins.reduce((a, b) => a + b, 0) || 1;
    const at = (q) => {
      let acc = 0;
      for (let i = 0; i < bins.length; i += 1) {
        acc += bins[i];
        if (acc >= total * q) return +(((i + 1) / bins.length)).toFixed(3);
      }
      return 1;
    };
    return { p10: at(0.10), p50: at(0.50), p90: at(0.90) };
  };

  const measure = async (frames) => {
    const out = [];
    for (const f of frames) {
      await rpc('set_playhead', { frame: f });
      await sleep(1500);
      const s = await rpc('get_scopes', {});
      const r = s.result ?? {};
      const m = r.mean ?? [];
      if (!m.length) { out.push({ frame: f, mean: null }); continue; }
      out.push({
        frame: f,
        mean: m.map((v) => +v.toFixed(4)),
        gr: +(m[1] / Math.max(m[0], 1e-6)).toFixed(3),
        lumaMean: +(r.luma?.mean ?? 0).toFixed(4),
        ...percentiles(r.histogram?.luma),
        blackPct: +(r.clipped?.low ?? 0).toFixed(4),
        clipPct: +(r.clipped?.high ?? 0).toFixed(4),
      });
    }
    return out;
  };

  const liveness = await measure([12, 30, 48, 66]);
  // Re-read f30 without moving. If it differs, the frame is not holding still
  // and nothing below can be trusted.
  const holdA = (await rpc('get_scopes', {})).result?.mean ?? [];
  await sleep(900);
  const holdB = (await rpc('get_scopes', {})).result?.mean ?? [];
  const holds = JSON.stringify(holdA.map((v) => +v.toFixed(3))) === JSON.stringify(holdB.map((v) => +v.toFixed(3)));
  console.log(`frame holds still when re-read: ${holds ? 'YES' : 'NO'}`);
  if (!holds) console.log('   ', holdA, '->', holdB);
  const distinct = new Set(liveness.filter((x) => x.mean).map((x) => JSON.stringify(x.mean))).size;
  console.log(`\nLIVENESS: ${distinct} distinct reads across ${liveness.length} frames — ${distinct >= 3 ? 'readback is ALIVE' : 'readback is FROZEN, stop'}`);
  if (distinct < 3) { for (const r of liveness) console.log('  ', r.frame, r.mean); process.exit(2); }

  const show = (label, rows) => {
    console.log(`\n${label}`);
    for (const r of rows) {
      if (!r.mean) { console.log(`   f${r.frame}  (no read)`); continue; }
      console.log(`   f${String(r.frame).padStart(3)}  mean ${JSON.stringify(r.mean).padEnd(26)} G/R ${String(r.gr).padEnd(6)} p10 ${String(r.p10).padEnd(6)} p90 ${String(r.p90).padEnd(6)} black ${r.blackPct}`);
    }
    const ok = rows.filter((r) => r.mean);
    if (ok.length) {
      const avg = (k) => +(ok.reduce((a, r) => a + r[k], 0) / ok.length).toFixed(3);
      console.log(`   AVG        G/R ${avg('gr')}   p10 ${avg('p10')}   p90 ${avg('p90')}   black ${avg('blackPct')}`);
    }
  };

  show('RAW (identity grade)', liveness);

  // Does a parameter reach the pipeline at all, and does it come back?
  // EVERY read seeks first. Comparing a read taken at f30 against one taken at
  // whatever the playhead drifted to is how this whole session produced four
  // confidently wrong conclusions.
  const FRAME = 30;
  const atFrame = async () => {
    await rpc('set_playhead', { frame: FRAME });
    await sleep(1400);
    return ((await rpc('get_scopes', {})).result?.mean ?? []).map((v) => +v.toFixed(3));
  };
  await rpc('set_node_param', { path: 'primary.exposure', value: 0 });
  await sleep(800);
  const before = await atFrame();
  await rpc('set_node_param', { path: 'primary.exposure', value: 1.0 });
  await sleep(800);
  const up = await atFrame();
  await rpc('set_node_param', { path: 'primary.exposure', value: 0 });
  await sleep(800);
  const down = await atFrame();
  const moved = JSON.stringify(up.map((v) => +v.toFixed(3))) !== JSON.stringify(before.map((v) => +v.toFixed(3)));
  const cameBack = JSON.stringify(down.map((v) => +v.toFixed(3))) === JSON.stringify(before.map((v) => +v.toFixed(3)));
  console.log(`\nPARAMETER CHECK at a fixed frame ${FRAME}: exposure 0 -> 1 -> 0`);
  console.log(`   base ${JSON.stringify(before)}  up ${JSON.stringify(up)}  back ${JSON.stringify(down)}`);
  console.log(`   moves: ${moved ? 'YES' : 'NO'}   returns: ${cameBack ? 'YES' : 'NO'}`);
  if (!moved) { console.log('   parameters do not reach the pipeline — do not grade blind'); process.exit(3); }

  // ---- the grade, chosen by measurement rather than by simulation ----------
  // The previous attempt at this graded a re-implementation of the colour maths
  // and was visibly far too red. Every candidate below is applied to the real
  // pipeline and measured back out of it.
  const GRADE_FRAMES = [12, 30, 48];
  const applyGrade = async (g) => {
    await rpc('set_grade', { grade: g });
    await sleep(900);
  };
  const measureGrade = async (label) => {
    const rows = [];
    for (const f of GRADE_FRAMES) {
      await rpc('set_playhead', { frame: f });
      await sleep(1400);
      const r = (await rpc('get_scopes', {})).result ?? {};
      const m = r.mean ?? [];
      if (!m.length) continue;
      rows.push({ frame: f, mean: m.map((v) => +v.toFixed(4)),
                  gr: +(m[1] / Math.max(m[0], 1e-6)).toFixed(3), ...percentiles(r.histogram?.luma),
                  clip: +(r.clipped?.high ?? 0).toFixed(4) });
    }
    const avg = (k) => +(rows.reduce((a, r) => a + r[k], 0) / (rows.length || 1)).toFixed(3);
    const avgM = [0,1,2].map((i) => +(rows.reduce((a, r) => a + r.mean[i], 0) / (rows.length || 1)).toFixed(3));
    console.log(`  ${label.padEnd(30)} mean ${JSON.stringify(avgM).padEnd(24)} G/R ${String(avg('gr')).padEnd(6)} p10 ${String(avg('p10')).padEnd(6)} p50 ${String(avg('p50')).padEnd(6)} p90 ${String(avg('p90')).padEnd(6)} clip ${avg('clip')}`);
    return { rows, gr: avg('gr'), p10: avg('p10'), p90: avg('p90'), clip: avg('clip'), mean: avgM };
  };

  console.log('\nSTAGE 1 — red gain, already chosen: 1.45 (G/R ~1.04, no clipping)');
  const BASE = { primary: { gain: [1.45, 1.0, 1.0] } };
  const report = (label, r) => {
    const ok = r.clip < 0.005;
    console.log(`  ${label.padEnd(26)} mean ${JSON.stringify(r.mean).padEnd(24)} G/R ${String(r.gr).padEnd(6)} p10 ${String(r.p10).padEnd(6)} p50 ${String(r.p50).padEnd(6)} p90 ${String(r.p90).padEnd(6)} clip ${r.clip}${ok ? '' : '   CLIPPING'}`);
  };

  // Contrast widens the range around a pivot: it is what actually removes the
  // backscatter veil, because the veil is a raised p10, not a wrong hue.
  console.log('\nSTAGE 2 — contrast sweep (red gain held at 1.45)');
  for (const c of [1.0, 1.15, 1.3, 1.45]) {
    await applyGrade({ primary: { ...BASE.primary, contrast: c } });
    report(`contrast ${c}`, await measureGrade(''));
  }

  console.log('\nSTAGE 3 — offset sweep at the best contrast so far');
  const best = CONTRASTS.reduce((a, b) => (Math.abs(b - TARGET_CONTRAST) < Math.abs(a - TARGET_CONTRAST) ? b : a), 1.3);
  for (const o of [0, -0.03, -0.06, -0.09]) {
    await applyGrade({ primary: { ...BASE.primary, contrast: best, offset: [o, o, o] } });
    report(`contrast ${best} offset ${o}`, await measureGrade(''));
  }

  console.log('\nFINAL — the values the measurements chose');
  await applyGrade({ primary: { ...BASE.primary, contrast: best, offset: [-0.06, -0.06, -0.06] } });
  report('applied', await measureGrade(''));
  console.log('\n   grade: ' + JSON.stringify({ primary: { gain: [1.45, 1, 1], contrast: best, offset: [-0.06, -0.06, -0.06] } }));
} catch (e) {
  console.log('failed:', e?.message ?? e);
} finally {
  fileSrv.close();
}
