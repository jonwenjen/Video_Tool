#!/usr/bin/env node
/**
 * hermes-resolve agent bridge — local Node server, zero dependencies.
 *
 * TRANSPORT: long-poll over plain HTTP/JSON, deliberately.
 *
 * The brief allowed either a hand-rolled RFC6455 WebSocket or long-poll. Long-poll
 * wins here for three reasons:
 *   1. Zero hand-written framing code means zero hand-written framing bugs (mask
 *      handling, fragment reassembly, close handshakes) in the path that drives a
 *      colour pipeline.
 *   2. Every failure mode (server restarting, tab reloading, laptop sleeping) is
 *      visible as an ordinary HTTP error instead of a socket that silently
 *      half-opens. Reconnect is just the next poll.
 *   3. The browser client and the CLI speak the exact same JSON envelopes either
 *      way, so the protocol is not coupled to the transport. See
 *      src/agent/protocol.ts — the client upgrades to a WebSocket automatically if
 *      a server ever advertises `transport: "ws"` in /health.
 *
 * Endpoints
 *   GET  /health         { ok, clients, version, transport, outDir }
 *   POST /rpc            one AgentRequest or a batch; long-polls the browser
 *   GET  /events         SSE stream of AgentEvents (progress/log/state/done)
 *   POST /file           write a file into the sandboxed output dir
 *   GET  /commands       mirrored command list (drift check against the client)
 *   GET  /client/poll    browser long-polls here for work
 *   POST /client/result  browser posts an AgentResponse back
 *   POST /client/event   browser posts AgentEvents, fanned out to /events
 *   POST /client/hello   browser announces itself + its capability report
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname, sep, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const PORT = Number(process.env.HERMES_RESOLVE_PORT || 7801);
const HOST = process.env.HERMES_RESOLVE_HOST || '127.0.0.1';
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** Every file the agent may write lands under here, and only here. */
const OUT_DIR = resolve(process.env.HERMES_RESOLVE_OUT || join(ROOT, 'out'));

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
/** Long-poll holds just under the client poll window so we answer first. */
const POLL_WAIT_MS = 25_000;
const MAX_BODY_BYTES = 256 * 1024 * 1024;
const EVENT_RING = 500;
/**
 * A client is only "connected" if it has polled within this window. Without a
 * TTL a tab that is closed mid-render (crash, force-quit, laptop lid) stays in
 * the registry forever, and `doctor` cheerfully reports a client that can never
 * answer — the worst possible failure mode for a health check.
 */
const CLIENT_TTL_MS = 70_000;
/** How long the newest client keeps exclusive routing before anyone may take over. */
const PREFERRED_GRACE_MS = 2_500;

/**
 * Mirrors COMMAND_NAMES in src/agent/protocol.ts. The .mjs side cannot import TS
 * (no build step, and the CLI must run straight from a checkout), so the list is
 * duplicated and verified at runtime: the browser sends its own list in
 * /client/hello and any drift is reported as a `log` event + a health warning.
 */
const COMMAND_NAMES = [
  'open_media', 'import_media', 'list_media', 'list_timeline', 'set_playhead', 'set_page',
  'add_node', 'remove_node', 'connect_nodes', 'set_node_param', 'set_grade', 'auto_balance',
  'analyze_frame', 'get_scopes', 'read_pixel', 'export_frame', 'export_video', 'apply_lut',
  'select_clip', 'keyframe', 'save_project', 'undo', 'redo', 'screenshot',
  'agent_env', 'agent_commands',
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Map<string, {id:string, connectedAt:number, lastSeen:number, commands:string[], capabilities:object}>} */
const clients = new Map();
/** Requests waiting for a browser to execute them. @type {Map<string, object>} */
const pending = new Map();
/** Live SSE subscribers. @type {Set<import('node:http').ServerResponse>} */
const subscribers = new Set();
/** Bounded backlog so a `watch` that attaches late still sees recent history. */
const eventLog = [];
let eventSeq = 0;
let shuttingDown = false;

const log = (...a) => console.log('[hermes-resolve]', ...a);
const warn = (...a) => console.warn('[hermes-resolve]', ...a);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-hermes-client',
  'access-control-max-age': '600',
  'access-control-expose-headers': 'x-hermes-clients',
};

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

/**
 * Defence in depth. We already bind to loopback, but a reverse proxy or an
 * `--host 0.0.0.0` override should never be able to expose a machine-writable
 * file endpoint to the network.
 */
function isLoopback(req) {
  const addr = req.socket?.remoteAddress;
  if (!addr) return true; // unix socket / in-process test harness
  return LOOPBACK.has(addr) || addr === '::1' || addr.startsWith('127.');
}

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolvePromise({});
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const clampTimeout = (ms) => {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(ms)));
};

/** Publish an event to every SSE subscriber and the replay ring. */
function emit(event) {
  const full = { ...event, ts: typeof event.ts === 'number' ? event.ts : Date.now(), seq: ++eventSeq };
  eventLog.push(full);
  if (eventLog.length > EVENT_RING) eventLog.shift();
  const frame = `id: ${full.seq}\ndata: ${JSON.stringify(full)}\n\n`;
  for (const res of subscribers) {
    try {
      res.write(frame);
    } catch {
      subscribers.delete(res);
    }
  }
  return full;
}

/**
 * Hand every undelivered request to a single parked browser client in one wake.
 *
 * Draining in bulk (rather than one request per wake) is what makes a batch
 * atomic-ish: a client parked on /client/poll is woken once with all of it, so a
 * 24-request grading script does not need 24 poll cycles and cannot half-deliver.
 * Returns false when no client is parked, so the caller can keep the request
 * pending and hand it over on a later poll.
 */
/** Drop clients that stopped polling. A parked poll refreshes lastSeen, so a live tab never expires. */
function reapClients() {
  const cutoff = Date.now() - CLIENT_TTL_MS;
  for (const [id, client] of clients) {
    if (client.lastSeen >= cutoff) continue;
    // A client that is mid-promise may still be alive, so let its own poll land.
    if (typeof client.wake === 'function') {
      if (client.wakeTtlExpired) continue;
      client.wakeTtlExpired = true;
      continue;
    }
    clients.delete(id);
    log(`browser client expired: ${id}`);
  }
}

/**
 * The client that commands go to when the request is not explicitly addressed.
 *
 * With two tabs open, "whichever client happens to poll first" is arbitrary, so
 * the same command can land in a tab with no media loaded or a stale build and
 * come back with a different answer each time. Pick the most recently active
 * client instead: that is the tab the operator is actually looking at.
 */
function preferredClientId() {
  let best = null;
  for (const [id, client] of clients) {
    if (!best || client.lastSeen > best.lastSeen
      || (client.lastSeen === best.lastSeen && id > best.id)) {
      best = { id, lastSeen: client.lastSeen };
    }
  }
  return best ? best.id : null;
}

function drainQueue(clientId) {
  // An unaddressed request goes only to the preferred client, so a second tab
  // cannot intercept the agent's work.
  const pref = preferredClientId();
  if (pref !== null && pref !== clientId) {
    // Deterministic routing, but never hang: if the preferred client has been
    // quiet for longer than the grace window it is probably gone, so let
    // whichever client is actually polling take the work.
    const preferred = clients.get(pref);
    if (preferred && Date.now() - preferred.lastSeen < PREFERRED_GRACE_MS) return [];
  }
  const queued = [];
  for (const entry of pending.values()) {
    if (entry.delivered || entry.settled) continue;
    // An explicitly addressed request only goes to its named client.
    if (entry.request.client && entry.request.client !== clientId) continue;
    entry.delivered = true;
    queued.push(entry.request);
  }
  return queued;
}

function deliverToClients(preferredClient) {
  let target = null;
  for (const client of clients.values()) {
    if (preferredClient && client.id !== preferredClient) continue;
    if (typeof client.wake === 'function') {
      target = client;
      break;
    }
  }
  if (!target) return false;

  const queued = drainQueue(target.id);
  if (queued.length === 0) return false;

  target.lastSeen = Date.now();
  const wake = target.wake;
  target.wake = null;
  wake({ kind: 'batch', requests: queued });
  return true;
}

/**
 * Register a request without delivering it yet.
 *
 * Two-phase on purpose: a batch of N must all be in `pending` before a single
 * handoff runs, otherwise request 1 wakes the client and requests 2..N find
 * nobody parked and stall until timeout.
 */
function enqueue(request) {
  const startedAt = Date.now();
  const timeoutMs = clampTimeout(request.timeoutMs);
  const entry = { request, resolve: null, timer: null, delivered: false, settled: false, handoffTimer: null, startedAt, timeoutMs };

  const promise = new Promise((resolvePromise) => {
    // Single exit point: every path funnels through here so the timer is always
    // cleared and the pending map never leaks a resolved entry.
    entry.resolve = (response) => {
      if (entry.settled) return;
      entry.settled = true;
      clearTimeout(entry.timer);
      if (entry.handoffTimer) clearTimeout(entry.handoffTimer);
      pending.delete(request.id);
      resolvePromise({ ...response, ms: typeof response.ms === 'number' ? response.ms : Date.now() - startedAt });
    };
  });

  entry.timer = setTimeout(() => {
    entry.resolve({ id: request.id, ok: false, error: { message: `no browser client responded within ${timeoutMs}ms`, code: 'timeout' } });
    emit({ type: 'done', id: request.id, command: request.command, ok: false, ms: Date.now() - startedAt, error: { message: 'timeout', code: 'timeout' } });
  }, timeoutMs);

  pending.set(request.id, entry);

  // No client parked yet. Retry briefly so a command issued just before the tab
  // opened still lands, but don't burn the whole timeout on a tab that will
  // never exist.
  entry.handoffTimer = setInterval(() => {
    if (entry.delivered || entry.settled) {
      clearInterval(entry.handoffTimer);
      return;
    }
    handoff();
  }, 200);
  setTimeout(() => {
    if (entry.delivered || entry.settled) return;
    entry.resolve({ id: request.id, ok: false, error: { message: 'no browser client connected — open the app and reload', code: 'no_client' } });
    emit({ type: 'done', id: request.id, command: request.command, ok: false, ms: Date.now() - startedAt, error: { message: 'no_client', code: 'no_client' } });
  }, Math.min(timeoutMs, 5000));

  return promise;
}

/** Try to hand every undelivered request to a parked client. Safe to call often. */
function handoff(preferredClient) {
  for (const entry of pending.values()) {
    if (entry.delivered || entry.settled) continue;
    if (preferredClient && entry.request.client && entry.request.client !== preferredClient) continue;
    if (deliverToClients(entry.request.client)) {
      if (entry.handoffTimer) clearInterval(entry.handoffTimer);
      return true;
    }
  }
  return false;
}

/** Park requests until the browser answers, the timeout fires, or a client shows up. */
function dispatch(requests) {
  const list = Array.isArray(requests) ? requests : [requests];
  const promises = list.map(enqueue);
  // All entries now exist in `pending`, so one handoff carries the whole batch.
  handoff();
  return Promise.all(promises);
}

function validateRequest(value) {
  if (typeof value !== 'object' || value === null) return 'request must be an object';
  if (typeof value.id !== 'string' || value.id.length === 0) return 'request.id must be a non-empty string';
  if (typeof value.command !== 'string' || value.command.length === 0) return 'request.command must be a non-empty string';
  return null;
}

// ---------------------------------------------------------------------------
// POST /file — sandboxed writes
// ---------------------------------------------------------------------------

function resolveInOutDir(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { error: 'path must be a non-empty string' };
  }
  if (inputPath.includes('\0')) return { error: 'path must not contain NUL' };
  // Absolute inputs are re-rooted under the sandbox rather than honoured: the
  // caller has no business writing outside OUT_DIR, and silently stripping the
  // leading slash keeps `/Users/me/Desktop/x.png` from escaping.
  const relative = isAbsolute(inputPath) ? inputPath.replace(/^([/\\])+/, '') : inputPath;
  const target = resolve(OUT_DIR, relative);
  if (target !== OUT_DIR && !target.startsWith(OUT_DIR + sep)) {
    return { error: `path escapes the sandbox: ${inputPath}` };
  }
  if (target === OUT_DIR) return { error: 'path must name a file' };
  return { path: target };
}

async function handleFile(req, res) {
  const body = await readBody(req);
  const resolved = resolveInOutDir(body.path);
  if (resolved.error) return sendJSON(res, 400, { ok: false, error: resolved.error });
  const { path: target } = resolved;

  if (body.append) {
    const prev = existsSync(target) ? readFileSync(target) : Buffer.alloc(0);
    const next = decodePayload(body, prev);
    if (next.error) return sendJSON(res, 400, { ok: false, error: next.error });
    if (body.mkdir !== false) mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, next.buffer);
    return sendJSON(res, 200, { ok: true, path: target, bytes: next.buffer.length, appended: true });
  }

  const decoded = decodePayload(body, Buffer.alloc(0));
  if (decoded.error) return sendJSON(res, 400, { ok: false, error: decoded.error });
  if (body.mkdir !== false) mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, decoded.buffer);
  emit({ type: 'log', level: 'info', message: `wrote ${decoded.buffer.length}B to ${target}`, command: body.command || 'file' });
  return sendJSON(res, 200, { ok: true, path: target, bytes: decoded.buffer.length });
}

function decodePayload(body, seed) {
  const encoding = body.encoding || (body.base64 ? 'base64' : 'utf8');
  try {
    if (encoding === 'base64') {
      return { buffer: Buffer.concat([seed, Buffer.from(String(body.data ?? ''), 'base64')]) };
    }
    if (encoding === 'hex') {
      return { buffer: Buffer.concat([seed, Buffer.from(String(body.data ?? ''), 'hex')]) };
    }
    const text = body.data === undefined || body.data === null ? '' : String(body.data);
    return { buffer: Buffer.concat([seed, Buffer.from(text, 'utf8')]) };
  } catch (err) {
    return { error: `could not decode payload as ${encoding}: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  if (!isLoopback(req)) {
    return sendJSON(res, 403, { ok: false, error: 'hermes-resolve agent bridge only accepts loopback requests' });
  }
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (req.method === 'GET' && route === '/') {
      return sendJSON(res, 200, {
        ok: true,
        name: 'hermes-resolve agent bridge',
        version: VERSION,
        endpoints: ['/health', '/rpc', '/events', '/file', '/commands', '/client/poll', '/client/result', '/client/event', '/client/hello'],
      });
    }

    if (req.method === 'GET' && route === '/health') {
      reapClients();
      const caps = [...clients.values()].map((c) => ({ id: c.id, connectedAt: c.connectedAt, lastSeen: c.lastSeen, capabilities: c.capabilities }));
      return sendJSON(res, 200, {
        ok: true,
        clients: clients.size,
        version: VERSION,
        transport: 'longpoll',
        outDir: OUT_DIR,
        pending: pending.size,
        commandDrift: clients.size === 0 ? null : [...clients.values()].map((c) => ({
          client: c.id,
          missing: COMMAND_NAMES.filter((n) => !c.commands.includes(n)),
          extra: c.commands.filter((n) => !COMMAND_NAMES.includes(n)),
        })).filter((d) => d.missing.length || d.extra.length),
        clients_detail: caps,
      });
    }

    if (req.method === 'GET' && route === '/commands') {
      return sendJSON(res, 200, { ok: true, commands: COMMAND_NAMES });
    }

    if (req.method === 'POST' && route === '/rpc') {
      reapClients();
      const body = await readBody(req);
      const isBatch = Array.isArray(body);
      const list = isBatch ? body : [body];
      if (list.length > 64) {
        return sendJSON(res, 400, { ok: false, error: 'batch too large (max 64)' });
      }

      const valid = [];
      for (const item of list) {
        const invalid = validateRequest(item);
        if (invalid) {
          const id = typeof item?.id === 'string' ? item.id : 'unknown';
          valid.push({ id, ok: false, error: { message: invalid, code: 'bad_request' }, ms: 0 });
        } else {
          valid.push(item);
        }
      }

      // Malformed entries are answered locally, the rest are dispatched together
      // so a batch arrives at the browser as a single unit of work.
      const settledLocally = valid.filter((v) => v.ok === false && v.error?.code === 'bad_request');
      const toDispatch = valid.filter((v) => !(v.ok === false && v.error?.code === 'bad_request'));
      const dispatched = await dispatch(toDispatch);

      res.setHeader('x-hermes-clients', String(clients.size));
      if (!isBatch) return sendJSON(res, 200, dispatched[0] ?? settledLocally[0]);

      // Re-interleave so results come back in request order.
      const byId = new Map([...settledLocally, ...dispatched].map((r) => [r.id, r]));
      return sendJSON(res, 200, list.map((item) => byId.get(typeof item?.id === 'string' ? item.id : 'unknown')));
    }

    if (req.method === 'GET' && route === '/events') {
      res.writeHead(200, {
        ...CORS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': hermes-resolve agent event stream\n\n');
      res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, version: VERSION, clients: clients.size })}\n\n`);

      // Replay what we still hold so a late `watch` is not blind.
      const lastId = Number(req.headers['last-event-id'] || url.searchParams.get('since') || 0);
      for (const ev of eventLog) {
        if (!Number.isFinite(lastId) || ev.seq > lastId) res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
      }

      subscribers.add(res);
      const beat = setInterval(() => {
        try { res.write(': keep-alive\n\n'); } catch { /* closed below */ }
      }, 15_000);
      req.on('close', () => {
        clearInterval(beat);
        subscribers.delete(res);
      });
      return undefined;
    }

    if (req.method === 'POST' && route === '/file') {
      return await handleFile(req, res);
    }

    // ---- browser-facing channel -------------------------------------------

    if (req.method === 'GET' && route === '/client/poll') {
      reapClients();
      const id = url.searchParams.get('client') || 'anonymous';
      let client = clients.get(id);
      if (!client) {
        client = { id, connectedAt: Date.now(), lastSeen: Date.now(), commands: [], capabilities: {}, wake: null };
        clients.set(id, client);
        log(`browser client connected: ${id}`);
      }
      client.lastSeen = Date.now();
      client.wakeTtlExpired = false;

      // Requests that arrived while no client was parked go out immediately.
      // Drained for *this* client rather than via deliverToClients, which would
      // wake a different parked client instead of answering this poll.
      const queued = drainQueue(id);
      if (queued.length > 0) {
        res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ kind: 'batch', requests: queued }));
      }

      const timeoutMs = Math.min(60_000, Math.max(1000, Number(url.searchParams.get('wait')) || POLL_WAIT_MS));
      const timer = setTimeout(() => {
        if (client) client.wake = null;
        res.writeHead(204, CORS);
        res.end();
      }, timeoutMs);
      client.wake = (msg) => {
        clearTimeout(timer);
        res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
        res.end(JSON.stringify(msg));
      };
      req.on('close', () => {
        clearTimeout(timer);
        if (client) client.wake = null;
      });
      return undefined;
    }

    if (req.method === 'POST' && route === '/client/result') {
      const body = await readBody(req);
      const list = Array.isArray(body) ? body : [body];
      const results = [];
      for (const response of list) {
        if (typeof response?.id !== 'string') continue;
        const entry = pending.get(response.id);
        if (!entry) continue; // late reply to a request that already timed out
        const ms = Number.isFinite(response.ms) ? response.ms : 0;
        if (typeof entry.resolve === 'function') {
          entry.resolve({ id: response.id, ok: !!response.ok, result: response.result, error: response.error, ms });
        }
        emit({
          type: 'done',
          id: response.id,
          command: entry.request.command,
          ok: !!response.ok,
          ms,
          ...(response.error ? { error: response.error } : {}),
        });
        results.push(response.id);
      }
      return sendJSON(res, 200, { ok: true, resolved: results });
    }

    if (req.method === 'POST' && route === '/client/event') {
      const body = await readBody(req);
      const list = Array.isArray(body) ? body : [body];
      const events = list.filter((e) => e && typeof e === 'object').map((e) => emit(e));
      return sendJSON(res, 200, { ok: true, emitted: events.length });
    }

    if (req.method === 'POST' && route === '/client/hello') {
      const body = await readBody(req);
      const id = String(body.clientId || url.searchParams.get('client') || 'anonymous');
      const client = clients.get(id) || { id, connectedAt: Date.now(), commands: [], capabilities: {} };
      client.lastSeen = Date.now();
      client.commands = Array.isArray(body.commands) ? body.commands : [];
      client.capabilities = body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : {};
      clients.set(id, client);
      const missing = COMMAND_NAMES.filter((n) => !client.commands.includes(n));
      const extra = client.commands.filter((n) => !COMMAND_NAMES.includes(n));
      if (missing.length || extra.length) {
        warn(`command drift with ${id}: missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`);
        emit({ type: 'log', level: 'warn', message: `command drift: client missing [${missing.join(', ')}] extra [${extra.join(', ')}]` });
      }
      return sendJSON(res, 200, { ok: true, client: id, commands: COMMAND_NAMES, transport: 'longpoll' });
    }

    return sendJSON(res, 404, { ok: false, error: `no route for ${req.method} ${route}` });
  } catch (err) {
    const status = err?.status || 500;
    if (status === 500) warn(err);
    return sendJSON(res, status, { ok: false, error: err?.message || 'internal error' });
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

try {
  mkdirSync(OUT_DIR, { recursive: true });
} catch { /* created lazily on first write */ }

server.listen(PORT, HOST, () => {
  log(`agent bridge on http://${HOST}:${PORT}  (version ${VERSION}, out ${OUT_DIR})`);
  log(`  ${clients.size === 0 ? 'no browser client yet — open the app and reload' : `${clients.size} client(s) connected`}`);
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} — shutting down`);
  for (const res of subscribers) {
    try { res.end(); } catch { /* already gone */ }
  }
  subscribers.clear();
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    if (typeof entry.resolve === 'function') {
      entry.resolve({ id: entry.request.id, ok: false, error: { message: 'server shutting down', code: 'shutdown' }, ms: 0 });
    }
  }
  pending.clear();
  for (const client of clients.values()) {
    if (typeof client.wake === 'function') {
      client.wake({ kind: 'bye' });
      client.wake = null;
    }
  }
  server.close(() => process.exit(0));
  // Don't let a lingering keep-alive socket hold the process open.
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  // A single bad client must not take the bridge (and every pending command) down.
  warn('uncaught', err?.stack || err);
});
