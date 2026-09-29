// Prove a measurement is a measurement before believing it.
//
// This session produced four confidently wrong conclusions — green and blue gain
// "had no effect", contrast "had no effect", red gain "inverted", and a whole
// "the render latches" bug — all of them the same mistake: a readback that did
// not move was read as a control that did nothing. The real cause was a <video>
// still running, so every read was of some other frame.
//
// The gate below is deliberately paranoid. It is not one check at the start:
// every comparison is bracketed, so drift that starts mid-sweep still fails.
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const AGENT = process.env.AGENT ?? 'http://127.0.0.1:7801';
const VIDEO = process.env.VIDEO ?? join(process.env.HOME, 'Downloads/VID_20260805_081949.mp4');
const FILE_PORT = Number(process.env.FILE_PORT ?? 7931);
const FRAME = 30;

if (!existsSync(VIDEO)) { console.log('no such file:', VIDEO); process.exit(1); }
const fileSrv = createServer((req, res) => {
  const p = join(VIDEO, '..', decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, ''));
  if (!existsSync(p)) { res.writeHead(404).end('nope'); return; }
  const st = statSync(p);
  const range = (req.headers.range ?? '').startsWith('bytes=') ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;
  const start = range?.[1] ? Number(range[1]) : 0;
  const end = range?.[2] ? Number(range[2]) : st.size - 1;
  const partial = !!range;
  res.writeHead(partial ? 206 : 200, {
    'content-type': 'video/mp4',
    'content-length': String(partial ? end - start + 1 : st.size),
    ...(partial ? { 'content-range': `bytes ${start}-${end}/${st.size}` } : {}),
    'access-control-allow-origin': '*', 'accept-ranges': 'bytes',
  });
  createReadStream(p, partial ? { start, end } : {}).pipe(res);
});
await new Promise((r) => fileSrv.listen(FILE_PORT, '127.0.0.1', r));

const rpc = async (command, params = {}) => {
  const r = await fetch(`${AGENT}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `v${Date.now()}${Math.random().toString(36).slice(2, 6)}`, command, params }),
  });
  return r.json();
};

const pct = (bins) => {
  if (!Array.isArray(bins) || !bins.length) return { p10: 0, p50: 0, p90: 0 };
  const tot = bins.reduce((a, b) => a + b, 0) || 1;
  const at = (q) => {
    let a = 0;
    for (let i = 0; i < bins.length; i += 1) {
      a += bins[i];
      if (a >= tot * q) return +(((i + 1) / bins.length).toFixed(3));
    }
    return 1;
  };
  return { p10: at(0.1), p50: at(0.5), p90: at(0.9) };
};

let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures += 1;
  return cond;
};

try {
  const health = await (await fetch(`${AGENT}/health`)).json();
  if (!health.clients) { console.log('no app tab — open http://127.0.0.1:4178/'); process.exit(1); }

  const url = `http://127.0.0.1:${FILE_PORT}/${basename(VIDEO)}`;
  const imp = await rpc('import_media', { paths: [url] });
  if (!ok(imp.ok, 'import the footage', JSON.stringify(imp.ok ? imp.result?.added : imp.error).slice(0, 140))) process.exit(1);
  const lm = await rpc('list_media', {});
  const pool = lm.result?.media ?? lm.result?.mediaPool ?? [];
  const clip = pool[pool.length - 1];
  await rpc('append_to_track', { mediaId: clip.id, track: 0, start: 0 });
  await sleep(4000);

  const seek = async (f) => { await rpc('set_playhead', { frame: f }); await sleep(1300); };
  const mean = async () => ((await rpc('get_scopes', {})).result?.mean ?? []).map((v) => +v.toFixed(4));

  // --- 1. pause must actually stop the element ------------------------------
  console.log('\n1. pause() stops the decoder, not just the app clock');
  await rpc('play');
  await sleep(900);
  await rpc('pause');
  await sleep(500);
  const a1 = await mean(); await sleep(1200); const a2 = await mean();
  ok(JSON.stringify(a1) === JSON.stringify(a2), 'readback holds still after pause',
     `${JSON.stringify(a1)} -> ${JSON.stringify(a2)}`);

  // --- 2. the frame named is the frame read ---------------------------------
  console.log('\n2. a read at frame N is that frame, and seeking changes it');
  await seek(12); const f12 = await mean();
  await seek(66); const f66 = await mean();
  await seek(FRAME); const f30 = await mean();
  ok(JSON.stringify(f12) !== JSON.stringify(f66), 'different frames read differently');
  ok(JSON.stringify(f12) !== JSON.stringify(f30) && JSON.stringify(f66) !== JSON.stringify(f30),
     'the working frame is distinct from both');
  await seek(FRAME); const f30b = await mean();
  ok(JSON.stringify(f30) === JSON.stringify(f30b), 're-seeking the same frame reproduces it',
     `${JSON.stringify(f30)} vs ${JSON.stringify(f30b)}`);

  // --- 3. a parameter round-trips, bracketed --------------------------------
  console.log('\n3. a grade change moves pixels and comes back');
  const bracket = async (label, apply, revert) => {
    const before = await mean();
    await apply(); await sleep(800);
    const during = await mean();
    await revert(); await sleep(800);
    const after = await mean();
    const moved = JSON.stringify(before) !== JSON.stringify(during);
    const back = JSON.stringify(before) === JSON.stringify(after);
    ok(moved && back, label, `${JSON.stringify(before)} -> ${JSON.stringify(during)} -> ${JSON.stringify(after)}`);
    return { before, during, after };
  };
  await bracket('exposure 0 -> 1 -> 0',
    () => rpc('set_node_param', { path: 'primary.exposure', value: 1 }),
    () => rpc('set_node_param', { path: 'primary.exposure', value: 0 }));

  // --- 4. re-run the same comparison, twice --------------------------------
  // Reproducibility is the check this session never did. A sweep whose numbers
  // move between identical runs is measuring drift, not the parameter.
  console.log('\n4. the same measurement twice must agree');
  const r1 = await bracket('run 1', () => rpc('set_grade', { grade: { primary: { gain: [1.45, 1, 1] } } }),
                                () => rpc('set_grade', { grade: { primary: { gain: [1, 1, 1] } } }));
  const r2 = await bracket('run 2', () => rpc('set_grade', { grade: { primary: { gain: [1.45, 1, 1] } } }),
                                () => rpc('set_grade', { grade: { primary: { gain: [1, 1, 1] } } }));
  ok(JSON.stringify(r1.during) === JSON.stringify(r2.during),
     'red gain 1.45 reads the same in both runs', `${JSON.stringify(r1.during)} vs ${JSON.stringify(r2.during)}`);

  await rpc('set_grade', { grade: { primary: { lift: [0,0,0], gamma: [1,1,1], gain: [1,1,1], offset: [0,0,0], contrast: 1, exposure: 0, saturation: 1 } } });
  console.log(`\n${failures === 0 ? 'ALL GATES PASS — this environment can be trusted to measure' : `${failures} GATE(S) FAILED — do not grade against this`}`);
  process.exit(failures === 0 ? 0 : 4);
} catch (e) {
  console.log('failed:', e?.message ?? e);
  process.exit(5);
} finally {
  fileSrv.close();
}
