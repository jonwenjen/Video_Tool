import { launchChrome } from './cdp-client.mjs';
import { fetchFixture } from './fixture-guard.mjs';
import { AGENT_PORT, AGENT_ORIGIN, agentUrl, agentEnv } from './test-isolation.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Per-node curves on a multi-node graph.
 *
 * The whole graph shares one curve-LUT texture, which reads like a bug. It is
 * not: render() re-uploads the texture once per node, immediately before that
 * node draws, so each node's curve is in place for its own pass.
 *
 * The assertion that actually settles it is ORDER. If one shared texture meant
 * "the last node with a curve wins", then swapping two nodes' curves would
 * leave the output unchanged. It does not — so each node's own curve is
 * applied, in order. A single-node test cannot distinguish the two cases, which
 * is why this file exists: it would catch someone hoisting syncCurveLut out of
 * the node loop, and it would catch a real regression of that shape.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.NODECURVE_PORT ?? 4184);
const ORIGIN = `http://127.0.0.1:${PORT}`;

spawnSync('node', ['node_modules/vite/bin/vite.js', 'build'], { cwd: ROOT, stdio: 'ignore' });
const server = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore', detached: true });
const stop = () => { try { process.kill(-server.pid); } catch { /* gone */ } };
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${ORIGIN}/`)).ok) break; } catch { /* not up */ } await sleep(200); }

const b = await launchChrome(); const p = b;
await p.enableDomains();
await p.goto(agentUrl(PORT));
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

const measure = async (label) => p.eval(`
  const a = window.__resolve, pipe = a.pipeline;
  const g = a.project.settings.timelineGraph;
  const d = pipe.readPixels(0, 0, pipe.width, pipe.height);
  let s = 0; for (const v of d) s += v;
  return {
    mean: +(s / d.length).toFixed(6),
    nodes: g.nodes.length,
    curves: g.nodes.map(n => JSON.stringify(n.grade.curves.master)),
  };
`);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};

console.log('\n=== one node, baseline ===');
const single = await p.eval(`
  const a = window.__resolve;
  const g = a.project.settings.timelineGraph;
  while (g.nodes.length > 1) a.removeNode(g.nodes[g.nodes.length - 1].id);
  g.nodes[0].grade.curves.master = [{x:0,y:0},{x:1,y:1}];
  await new Promise(r => setTimeout(r, 500));
  const d = a.pipeline.readPixels(0, 0, a.pipeline.width, a.pipeline.height);
  let s = 0; for (const v of d) s += v;
  return { mean: +(s / d.length).toFixed(6), n: g.nodes.length };
`);
console.log(`  nodes=${single.n} mean=${single.mean}`);

const setBoth = (a1, a2) => p.eval(`
  const a = window.__resolve;
  const g = a.project.settings.timelineGraph;
  while (g.nodes.length > 1) a.removeNode(g.nodes[g.nodes.length - 1].id);
  g.nodes[0].grade.curves.master = ${JSON.stringify(a1)};
  a.addNode({ kind: 'serial' });
  const second = g.nodes[g.nodes.length - 1];
  second.grade.curves.master = ${JSON.stringify(a2)};
  await new Promise(r => setTimeout(r, 700));
  const d = a.pipeline.readPixels(0, 0, a.pipeline.width, a.pipeline.height);
  let s = 0; for (const v of d) s += v;
  return { mean: +(s / d.length).toFixed(6), n: g.nodes.length, last: JSON.stringify(second.grade.curves.master) };
`);

const ID = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
const LIFT = [{ x: 0, y: 0.5 }, { x: 1, y: 1 }];
const DIP = [{ x: 0, y: 0 }, { x: 0.5, y: 0.2 }, { x: 1, y: 1 }];

console.log('\n=== two nodes, node1 lift + node2 identity ===');
const r1 = await setBoth(LIFT, ID);
check('node 1 curve applies (graph changed)', Math.abs(r1.mean - single.mean) > 1e-4, `mean=${r1.mean} vs 1-node ${single.mean}`);

console.log('\n=== two nodes, node1 identity + node2 lift ===');
const r2 = await setBoth(ID, LIFT);
check('node 2 curve applies when node 1 is identity', Math.abs(r2.mean - single.mean) > 1e-4, `mean=${r2.mean}`);

console.log('\n=== two nodes, BOTH have different curves ===');
const r3 = await setBoth(LIFT, DIP);
const r4 = await setBoth(DIP, LIFT);
check('swapping the two curves changes the result',
  Math.abs(r3.mean - r4.mean) > 1e-4,
  `lift+dip=${r3.mean}  dip+lift=${r4.mean}`);

console.log('\n=== three nodes, each with a different curve ===');
const r5 = await p.eval(`
  const a = window.__resolve;
  const g = a.project.settings.timelineGraph;
  while (g.nodes.length > 1) a.removeNode(g.nodes[g.nodes.length - 1].id);
  const C = [[{x:0,y:0.2},{x:1,y:1}], [{x:0,y:0.4},{x:1,y:1}], [{x:0,y:0.6},{x:1,y:1}]];
  g.nodes[0].grade.curves.master = C[0];
  a.addNode({ kind: 'serial' });
  a.addNode({ kind: 'serial' });
  g.nodes.forEach((n, i) => { n.grade.curves.master = C[i]; });
  await new Promise(r => setTimeout(r, 800));
  const d = a.pipeline.readPixels(0, 0, a.pipeline.width, a.pipeline.height);
  let s = 0; for (const v of d) s += v;
  return { mean: +(s / d.length).toFixed(6), n: g.nodes.length, curves: g.nodes.map(n => JSON.stringify(n.grade.curves.master)) };
`);
console.log(`  nodes=${r5.n} mean=${r5.mean}`);
for (const c of r5.curves) console.log(`    ${c}`);
check('three-node graph renders with three distinct curves', r5.n === 3 && r5.curves.length === 3);

console.log(`\n[node-curves] ${pass} passed, ${fail} failed`);
b.closeBrowser();
stop();
process.exit(fail ? 1 : 0);
