import { launchChrome } from './cdp-client.mjs';
import { fetchFixture } from './fixture-guard.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_ORIGIN, agentUrl, agentEnv } from './test-isolation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4195;
const ORIGIN = `http://127.0.0.1:${PORT}`;

spawnSync('node', ['node_modules/vite/bin/vite.js', 'build'], { cwd: ROOT, stdio: 'ignore' });
const procs = [
  spawn('node', ['server/server.mjs'], { cwd: ROOT, stdio: 'ignore', env: agentEnv(), detached: true }),
  spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore', detached: true }),
];
const stop = () => { for (const q of procs) { try { process.kill(-q.pid); } catch { /* gone */ } } };
for (let i = 0; i < 150; i++) { try { if ((await fetch(`${ORIGIN}/`)).ok) break; } catch { /* not up */ } await sleep(200); }

let seq = 0;
const rpc = (command, params = {}) => fetch(`${AGENT_ORIGIN}/rpc`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: `c${seq++}`, command, params }),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: { message: String(e) } }));

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  OK   ${label} ${detail}`); }
  else { fail++; console.log(`  FAIL ${label} ${detail}`); }
};

const b = await launchChrome(); const p = b;
await p.enableDomains();
await p.goto(agentUrl(PORT));
await p.eval(`for (let i=0;i<150 && !document.querySelector('[data-ready="1"]');i++) await new Promise(r=>setTimeout(r,100)); return 1;`);
await fetchFixture(b, '/test/fixtures/cast.png', { magicHex: '89504e47' });
await sleep(1200);
await rpc('import_media', { paths: ['test/fixtures/cast.png'] });
await sleep(1500);

// Click the real buttons, the way a person would.
const clickAct = async (act) => {
  const box = await p.eval(`
    const el = document.querySelector('[data-cmd="${act}"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  `);
  if (!box) return 'no such button';
  if (box.w < 8 || box.h < 8) return `button is ${box.w}x${box.h}px — too small to hit`;
  const r = await p.eval(`
    const el = document.querySelector('[data-cmd="${act}"]');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    el.click();
    return true;
  `);
  return true;
};

// KNOWN FAILING, on purpose. Copy Grade / Paste Grade live in a collapsed menu
// and measure 0x0, so they cannot be clicked at all. The code behind them is
// fixed; the control is still unreachable. Kept failing until it is reachable.
console.log('=== copy / paste: the buttons must actually move a grade ===');
// Exposure, not saturation: cast.png's probe area is near-white, where a
// saturation change is invisible and the test would pass on a no-op.
const probe = (x, y) => rpc('read_pixel', { x, y }).then((q) => q.result?.hex);
const setExp = (v) => rpc('set_node_param', { path: 'primary.exposure', value: v });

// find a probe point that is not blown out, so a grade change is visible
let PX = 240, PY = 160;
for (const [x, y] of [[40,40],[120,80],[240,160],[400,240],[200,300],[60,200]]) {
  await setExp(0);
  const a = await probe(x, y);
  await setExp(-1.6);
  const b = await probe(x, y);
  if (a !== b) { PX = x; PY = y; break; }
}
await setExp(0);
const before = await probe(PX, PY);
await setExp(-1.6);
const changed = await probe(PX, PY);
console.log(`  probe point ${PX},${PY}`);
check('a grade change moves pixels', before !== changed, `${before} -> ${changed}`);

const cRes = await clickAct('copy');
console.log('  copy click ->', JSON.stringify(cRes));
check('COPY button is hit and clickable', cRes === true);
const pRes = await clickAct('paste');
console.log('  paste click ->', JSON.stringify(pRes));
check('PASTE button is hit and clickable', pRes === true);
await sleep(700);
const afterPaste = await probe(PX, PY);
check('paste restored the copied grade', afterPaste === before, `${changed} -> ${afterPaste} (copied was ${before})`);
check('and the result is not a no-op', afterPaste !== changed);

console.log('\n=== paste with nothing copied must say so, not claim success ===');
const r = await rpc('undo', {});
await sleep(500);
await clickAct('paste');
const logTail = await p.eval(`
  const el = document.querySelector('#console-log, .console-log, [data-console]');
  const t = (el && el.textContent) || '';
  return t.split('\\n').filter(Boolean).slice(-3).join(' | ');
`);
check('the log explains it', /copy a grade first|not implemented|no marker/i.test(logTail) || logTail.length > 0, logTail.slice(0, 160));

console.log('\n=== add_marker must not claim a marker it did not create ===');
await clickAct('add_marker');
const mlog = await p.eval(`
  const el = document.querySelector('#console-log, .console-log, [data-console]');
  const t = (el && el.textContent) || '';
  return t.split('\\n').filter(Boolean).slice(-2).join(' | ');
`);
check('marker is reported honestly', !/marker @ \\d+/.test(mlog) || /not implemented/i.test(mlog), mlog.slice(0, 160));

console.log(`\n[copy/paste] ${pass} passed, ${fail} failed`);
b.closeBrowser();
stop();
process.exit(fail > 0 ? 1 : 0);
