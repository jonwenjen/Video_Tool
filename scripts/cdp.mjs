#!/usr/bin/env node
/**
 * Zero-dependency CDP harness: launch a throwaway headless Chrome, open a URL,
 * evaluate expressions, collect console + exceptions, tear down.
 *
 * Deliberately does NOT touch the user's own browser profile — the shared
 * profile is often locked, and a test run must not depend on it.
 *
 * Usage:
 *   node scripts/cdp.mjs <url> [--keep] [--eval 'expr'] [--eval 'expr2']
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find(existsSync);

if (!CHROME) {
  console.error('no chrome found; set CHROME_PATH');
  process.exit(2);
}

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const evals = args.reduce((acc, a, i) => (a === '--eval' ? [...acc, args[i + 1]] : acc), []);
const keep = args.includes('--keep');

if (!url) {
  console.error('usage: cdp.mjs <url> [--eval expr]... [--keep]');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'hr-chrome-'));
const PORT = 9222 + Math.floor(Math.random() * 500);

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu-sandbox',
  '--use-gl=angle',
  '--use-angle=default',
  '--enable-unsafe-swiftshader',
  '--window-size=1920,1080',
  '--hide-scrollbars',
  '--mute-audio',
  '--no-sandbox',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let stderr = '';
chrome.stderr.on('data', (d) => { stderr += d.toString(); });

const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
  if (!keep) { try { rmSync(profile, { recursive: true, force: true }); } catch { /* fine */ } }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function waitForTarget() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`chrome did not expose a page target on :${PORT}\n${stderr.slice(-2000)}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.console = [];
    this.exceptions = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p(msg); }
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        this.console.push({
          type: msg.params.type,
          text: msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
        });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.exceptions.push(d.exception?.description ?? d.text);
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        if (e.level === 'error') this.exceptions.push(`[${e.source}] ${e.text}`);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timed out`)); }
      }, 60000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

const target = await waitForTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', () => rej(new Error('ws connect failed')));
});

const cdp = new CDP(ws);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Log.enable');

// Wait for THIS navigation's load event, not the one from the initial
// about:blank. Attaching the listener before Page.navigate matters: the load
// event can fire before send() resolves, and polling location.href instead
// races against it. Navigate the empty page away first so the target is not
// sitting on about:blank when we subscribe.
await cdp.send('Page.navigate', { url: 'about:blank' });
await new Promise((r) => setTimeout(r, 200));

const loaded = new Promise((res) => {
  const t = setTimeout(() => res(false), 30000);
  const onMsg = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.loadEventFired') {
      clearTimeout(t);
      ws.removeEventListener('message', onMsg);
      res(true);
    }
  };
  ws.addEventListener('message', onMsg);
});
await cdp.send('Page.navigate', { url });
const didLoad = await loaded;

// Guard: a data: URL or a navigation that silently failed leaves the page on
// about:blank, where every assertion below passes vacuously.
const finalUrl = await cdp.eval('return location.href;');
if (!didLoad) {
  console.error(`WARN: load event never fired for ${url}`);
}
if (finalUrl === 'about:blank') {
  console.error(`FATAL: navigation to ${url} did not take effect (still at about:blank)`);
  console.error(`console: ${JSON.stringify(cdp.console)}`);
  cleanup();
  process.exit(3);
}

const results = [];
for (const e of evals) {
  try {
    results.push({ ok: true, value: await cdp.eval(e) });
  } catch (err) {
    results.push({ ok: false, error: err.message });
  }
}

console.log(JSON.stringify({
  results,
  console: cdp.console,
  exceptions: cdp.exceptions,
}, null, 2));

cleanup();
process.exit(cdp.exceptions.length ? 1 : 0);
