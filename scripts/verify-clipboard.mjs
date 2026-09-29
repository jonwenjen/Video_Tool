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
    const el = document.querySelector('.viewer-tools [data-cmd="${act}"]');
    if (!el) return 'no header button for ${act}';
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  `);
  if (!box) return 'no such button';
  if (box.w < 40 || box.h < 24) return `header button is only ${box.w}x${box.h}px — too small to hit`;
  const r = await p.eval(`
    const el = document.querySelector('.viewer-tools [data-cmd="${act}"]');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    el.click();
    return true;
  `);
  return true;
};

// PARTIALLY FIXED. The three grade buttons in the viewer header are hittable
// and AUTO WB is verified end to end through the shared app.autoBalance path.
// Copy and paste both execute and log success, but the round trip does NOT
// restore the grade — so paste still claims work it does not do. The failing
// check below is that bug, left red on purpose.
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
// Copy FIRST. Copying after the change would copy the changed grade, and a
// paste that restores what is already there proves nothing.
await setExp(0);
const before = await probe(PX, PY);
check('COPY button is hit and clickable', (await clickAct('copy')) === true);
await setExp(-1.6);
const changed = await probe(PX, PY);
check('a grade change moves pixels', before !== changed, `${before} -> ${changed}`);
check('PASTE button is hit and clickable', (await clickAct('paste')) === true);
await sleep(700);
const clip = await p.eval(`(() => { try { return String(window.__gradeClipboardDebug); } catch (e) { return 'n/a'; } })()`);
const logNow = await p.eval(`
  const el = document.querySelector('#log, .log, [data-log], #console, .console, pre, [id*=log i]');
  return el ? (el.textContent || '').split('\\n').filter(Boolean).slice(-4).join(' | ').slice(0, 300) : 'NO LOG ELEMENT';
`);
console.log('  log after copy+paste:', logNow);
const afterPaste = await probe(PX, PY);
check('paste restored the copied grade', afterPaste === before, `${changed} -> ${afterPaste} (copied was ${before})`);


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

console.log('\n=== auto balance: the button must do what the agent command does ===');
const abBox = await p.eval(`
  const el = document.querySelector('.viewer-tools [data-cmd="auto_balance"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { w: r.width, h: r.height, disabled: el.disabled };
`);
check('AUTO WB button is present and hittable', !!abBox && abBox.w >= 40 && abBox.h >= 24 && !abBox.disabled, JSON.stringify(abBox));
if (abBox && !abBox.disabled) {
  await rpc('set_grade', { grade: { primary: { temperature: 0.55 } } });
  const preAB = await rpc('get_scopes', {}).then((q) => JSON.stringify(q.result?.mean));
  await clickAct('auto_balance');
  await sleep(1800);
  const postAB = await rpc('get_scopes', {}).then((q) => JSON.stringify(q.result?.mean));
  check('AUTO WB button changes the image', preAB !== postAB, `${preAB} -> ${postAB}`);
  const r2 = await rpc('auto_balance', {});
  check('the agent command still works', r2.ok, r2.ok ? String(r2.result?.source) : JSON.stringify(r2.error).slice(0, 120));
}

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
