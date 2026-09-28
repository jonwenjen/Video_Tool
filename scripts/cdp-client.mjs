/**
 * Minimal Chrome DevTools Protocol client, shared by the verification scripts.
 *
 * Hand-rolled rather than pulled from npm: the only transport needed is a
 * WebSocket that Chrome already speaks, and the point of this verification
 * path is that it has no dependencies to drift.
 *
 * The transport uses the browser's OWN WebSocket object so the browser does the
 * frame parsing. A hand-rolled `socket.read()` loop is where a CDP client
 * quietly hangs: read() is a low-level chunk read that returns null on a
 * partial frame, so the message never arrives and the await never settles.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME = process.env.CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find(existsSync);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome({ port = 0, windowSize = '1920,1080' } = {}) {
  if (!CHROME) throw new Error('no Chrome found; set CHROME_PATH');
  const profile = mkdtempSync(join(tmpdir(), 'hr-chrome-'));
  const debugPort = port || 9200 + Math.floor(Math.random() * 600);
  const proc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--use-gl=angle',
    '--use-angle=default',
    // SwiftShader is what makes WebGL2 + EXT_color_buffer_float available
    // with no real GPU, which is how the float pipeline gets verified here.
    '--enable-unsafe-swiftshader',
    `--window-size=${windowSize}`,
    '--hide-scrollbars',
    '--mute-audio',
    '--no-sandbox',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  proc.stderr?.on('data', (d) => { stderr += d.toString(); });

  const close = () => {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* fine */ }
  };

  let target = null;
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      target = list.find((t) => t.type === 'page') ?? null;
      if (target) break;
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  if (!target) {
    close();
    throw new Error(`chrome exposed no page target on :${debugPort}\n${stderr.slice(-1500)}`);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('websocket connect failed')), { once: true });
  });

  return new CdpSession(ws, close, debugPort);
}

class CdpSession {
  constructor(ws, close, port) {
    this.ws = ws;
    this.closeBrowser = close;
    this.port = port;
    this.id = 0;
    this.pending = new Map();
    this.console = [];
    this.exceptions = [];
    this.eventWaiters = [];

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p(msg); }
        return;
      }
      this.#onEvent(msg);
    });
  }

  #onEvent(msg) {
    if (msg.method === 'Runtime.consoleAPICalled') {
      this.console.push({
        type: msg.params.type,
        text: msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
      });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.exceptions.push(d.exception?.description ?? d.text);
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      this.exceptions.push(`[${msg.params.entry.source}] ${msg.params.entry.text}`);
    }
    for (const w of [...this.eventWaiters]) {
      if (w.method === msg.method) {
        this.eventWaiters.splice(this.eventWaiters.indexOf(w), 1);
        w.res(msg.params);
      }
    }
  }

  send(method, params = {}, timeoutMs = 120000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timed out`)); }
      }, timeoutMs);
    });
  }

  once(method, timeoutMs = 30000) {
    return new Promise((res) => {
      const w = { method, res };
      this.eventWaiters.push(w);
      setTimeout(() => {
        const i = this.eventWaiters.indexOf(w);
        if (i >= 0) { this.eventWaiters.splice(i, 1); res(null); }
      }, timeoutMs);
    });
  }

  /** Evaluate an async function body; returns its value. Throws on page error. */
  async eval(body) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result?.value;
  }

  async enableDomains() {
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Log.enable');
  }

  /**
   * Navigate and wait for THIS load event.
   *
   * Subscribing before navigating matters: the load event can fire before
   * send() resolves. The caller must still assert the URL took effect — a
   * failed navigation leaves the page on about:blank / chrome-error://, where
   * every downstream assertion passes vacuously.
   */
  async goto(url) {
    await this.send('Page.navigate', { url: 'about:blank' });
    await sleep(200);
    const loaded = this.once('Page.loadEventFired', 30000);
    await this.send('Page.navigate', { url });
    await loaded;
    return this.eval('return location.href;');
  }
}
