// Sweep red-recovery shapes against the real pipeline and pick by measurement.
//
// A flat red gain corrects the green-shifted frames and over-corrects the ones
// that were already neutral, so G/R ends up spread across the shot (1.06 on the
// early frames, 0.79 late). A red curve that lifts the low end and leaves the
// top alone should hold G/R nearer 1.0 across every frame.
//
// Every candidate is applied and read back out of pipeline.readPixels. The
// measurement gate must pass first or nothing here is believable — see
// scripts/measure-gate.mjs.
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
  const p = join(VIDEO, '..', decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, ''));
  if (!existsSync(p)) { res.writeHead(404).end('nope'); return; }
  const st = statSync(p);
  const range = (req.headers.range ?? '').startsWith('bytes=') ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;
  const start = range?.[1] ? Number(range[1]) : 0;
  const end = range?.[2] ? Number(range[2]) : st.size - 1;
  res.writeHead(range ? 206 : 200, {
    'content-type': 'video/mp4',
    'content-length': String(range ? end - start + 1 : st.size),
    ...(range ? { 'content-range': `bytes ${start}-${end}/${st.size}` } : {}),
    'access-control-allow-origin': '*', 'accept-ranges': 'bytes',
  });
  createReadStream(p, range ? { start, end } : {}).pipe(res);
});
await new Promise((r) => fileSrv.listen(FILE_PORT, '127.0.0.1', r));

const rpc = async (command, params = {}) => {
  const r = await fetch(`${AGENT}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`, command, params }),
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

try {
  const h = await (await fetch(`${AGENT}/health`)).json();
  if (!h.clients) { console.log('no app tab — open http://127.0.0.1:4178/'); process.exit(1); }
  const url = `http://127.0.0.1:${FILE_PORT}/${basename(VIDEO)}`;
  const imp = await rpc('import_media', { paths: [url] });
  if (!imp.ok) { console.log('import failed:', JSON.stringify(imp.error).slice(0, 160)); process.exit(1); }
  const lm = await rpc('list_media', {});
  const pool = lm.result?.media ?? lm.result?.mediaPool ?? [];
  await rpc('append_to_track', { mediaId: pool[pool.length - 1].id, track: 0, start: 0 });
  await sleep(4000);
  await rpc('pause');
  await sleep(600);

  const apply = async (g) => { await rpc('set_grade', { grade: g }); await sleep(900); };
  const measure = async () => {
    const rows = [];
    for (const f of FRAMES) {
      await rpc('set_playhead', { frame: f });
      await sleep(1250);
      const r = (await rpc('get_scopes', {})).result ?? {};
      const m = r.mean ?? [];
      if (!m.length) continue;
      rows.push({ f, gr: +(m[1] / Math.max(m[0], 1e-6)).toFixed(3), ...pct(r.histogram?.luma),
                  clip: +(r.clipped?.high ?? 0).toFixed(5) });
    }
    const grs = rows.map((x) => x.gr);
    const avg = (k) => +(rows.reduce((a, x) => a + x[k], 0) / (rows.length || 1)).toFixed(3);
    return { rows, spread: +(Math.max(...grs) - Math.min(...grs)).toFixed(3),
             meanGr: +(grs.reduce((a, b) => a + b, 0) / (grs.length || 1)).toFixed(3),
             p10: avg('p10'), p50: avg('p50'), p90: avg('p90'), clip: Math.max(...rows.map((x) => x.clip)) };
  };

  const line = (label, r) => console.log(
    `  ${label.padEnd(34)} G/R per frame [${r.rows.map((x) => String(x.gr).padStart(5)).join(' ')}]` +
    `  mean ${String(r.meanGr).padEnd(6)} spread ${String(r.spread).padEnd(6)} p10 ${r.p10} p50 ${r.p50} p90 ${r.p90} clip ${r.clip}`);

  const IDENT = { primary: { gain: [1, 1, 1], contrast: 1 }, curves: { red: [{ x: 0, y: 0 }, { x: 1, y: 1 }], mode: 'custom' } };

  console.log('\nBASELINE');
  await apply(IDENT);
  line('identity', await measure());

  console.log('\nA — flat red gain (what is on the timeline now)');
  for (const g of [1.3, 1.45, 1.6]) {
    await apply({ primary: { gain: [g, 1, 1], contrast: 1.3 }, curves: IDENT.curves });
    line(`gain ${g} + contrast 1.3`, await measure());
  }

  // Refine: lift 0.08 held the frames together (spread 0.169 vs 0.276 for a
  // flat gain) but left the whole picture warm at mean 0.924. Bracket smaller.
  console.log('\nREFINE — smaller lifts, contrast 1.2 and 1.3');
  const curve2 = (lift, knee) => ({
    red: [{ x: 0, y: lift * 0.5 }, { x: knee, y: knee + lift }, { x: 1, y: 1 }],
    mode: 'custom',
  });
  for (const c of [1.2, 1.3]) {
    for (const [lift, knee] of [[0.02, 0.30], [0.035, 0.30], [0.05, 0.30], [0.065, 0.30]]) {
      await apply({ primary: { gain: [1, 1, 1], contrast: c }, curves: curve2(lift, knee) });
      line(`curve ${lift}@${knee} + contrast ${c}`, await measure());
    }
  }
} catch (e) {
  console.log('failed:', e?.message ?? e);
  process.exit(5);
} finally {
  fileSrv.close();
}
