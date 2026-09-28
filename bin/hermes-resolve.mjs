#!/usr/bin/env node
/**
 * hermes-resolve — CLI for the agent bridge.
 *
 * Talks to server/server.mjs over HTTP/JSON. Deliberately zero-dependency and
 * import-free of the TS sources so it runs straight from a checkout.
 *
 *   hermes-resolve health
 *   hermes-resolve call <command> [--json '<params>'] [key=value ...]
 *   hermes-resolve batch <file.json>
 *   hermes-resolve watch
 *   hermes-resolve doctor
 *
 * Machine-readable output: pass --json (no value) or set HERMES_RESOLVE_JSON=1.
 * With a value, --json carries the command's params instead.
 */

import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  magenta: (s) => (useColor ? `\x1b[35m${s}\x1b[0m` : s),
  bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
};

const out = (s = '') => process.stdout.write(`${s}\n`);
const errOut = (s = '') => process.stderr.write(`${s}\n`);

function fail(message, code = 1) {
  errOut(c.red(`hermes-resolve: ${message}`));
  process.exit(code);
}

/** One message for the single most common failure: the bridge is not running. */
function notRunning(detail) {
  errOut(c.red(`hermes-resolve: cannot reach the agent bridge at ${BASE}`));
  if (detail) errOut(`  ${c.dim(detail)}`);
  errOut('');
  errOut('  start it with:  ' + c.cyan('npm run agent'));
  errOut('  (or directly:   ' + c.cyan('node server/server.mjs') + ')');
  errOut('  then open the app in a browser and reload so a client connects.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = process.env.HERMES_RESOLVE_PORT || '7801';
const BASE = (process.env.HERMES_RESOLVE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function getJSON(path, { timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: controller.signal });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { error: `non-JSON response: ${text.slice(0, 200)}` };
    }
    return { status: res.status, body };
  } catch (err) {
    if (err?.name === 'AbortError') notRunning(`${path} timed out after ${timeoutMs}ms`);
    notRunning(err?.cause?.code ? `${err.cause.code} connecting to ${BASE}` : String(err?.message ?? err));
    return null; // unreachable
  } finally {
    clearTimeout(timer);
  }
}

async function postJSON(path, body, { timeoutMs = 600_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    if (err?.name === 'AbortError') notRunning(`${path} timed out after ${Math.round(timeoutMs / 1000)}s`);
    notRunning(String(err?.message ?? err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const newId = () => `cli-${randomUUID().slice(0, 8)}`;

async function call(request) {
  const { status, body } = await postJSON('/rpc', request);
  if (status !== 200) {
    throw new Error(body?.error ?? `HTTP ${status}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderValue(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return c.dim('null');
  if (Array.isArray(value)) {
    if (value.length === 0) return c.dim('[]');
    // Arrays of plain scalars stay inline: a colour triple should read as
    // `[0.02, -0.01, 0]`, not as three lines.
    if (value.every((v) => v === null || typeof v !== 'object')) {
      return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    }
    return `[\n${value.map((v) => `${pad}  ${renderValue(v, indent + 1)}`).join(',\n')}\n${pad}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return c.dim('{}');
    return `{\n${entries
      .map(([k, v]) => `${pad}  ${c.cyan(k)}: ${renderValue(v, indent + 1)}`)
      .join(',\n')}\n${pad}}`;
  }
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function reportResult(request, response, { json }) {
  if (json) {
    out(JSON.stringify(response, null, 2));
    return response.ok;
  }
  const label = request.command;
  if (response.ok) {
    out(`${c.green('✓')} ${c.bold(label)} ${c.dim(`${Math.round(response.ms)}ms`)}`);
    if (response.result !== undefined && response.result !== null) {
      out(`  ${renderValue(response.result, 1)}`);
    }
  } else {
    out(`${c.red('✗')} ${c.bold(label)} ${c.dim(`${Math.round(response.ms)}ms`)}`);
    const e = response.error ?? {};
    out(`  ${c.red(e.message ?? 'unknown error')}`);
    if (e.code) out(`  ${c.dim(`code: ${e.code}`)}`);
  }
  return response.ok;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * `key=value` pairs are a first-class input form because an agent shelling out
 * will reach for them long before it writes a JSON blob. Values are JSON-parsed
 * when they look like JSON, so `frame=12` is a number and `paths=["a","b"]` is an
 * array, but `label=01` stays the string "01".
 */
function parseKeyValues(pairs) {
  const params = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new Error(`expected key=value, got "${pair}"`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    let value = raw;
    if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (raw === 'null') value = null;
    else if (raw !== '' && !Number.isNaN(Number(raw))) value = Number(raw);
    else if (/^[[{]/.test(raw)) {
      try {
        value = JSON.parse(raw);
      } catch {
        // Not valid JSON after all — keep the string, the server will explain.
      }
    }
    params[key] = value;
  }
  return params;
}

function parseFlags(argv) {
  const flags = { json: false, timeout: null, client: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      const next = argv[i + 1];
      // `--json '<params>'` is the params form; a bare `--json` is the
      // machine-readable-output form. Anything that parses as JSON wins.
      if (next && !next.startsWith('--')) {
        try {
          JSON.parse(next);
          flags.jsonParams = next;
          i++;
          continue;
        } catch {
          /* not JSON: fall through to output-mode flag */
        }
      }
      flags.json = true;
    } else if (arg === '--timeout') {
      flags.timeout = Number(argv[++i]);
    } else if (arg === '--client') {
      flags.client = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const USAGE = `${c.bold('hermes-resolve')} — drive the app from the terminal

${c.bold('USAGE')}
  hermes-resolve health
  hermes-resolve call <command> [--json '<params>'] [key=value ...]
  hermes-resolve batch <file.json>
  hermes-resolve watch
  hermes-resolve doctor

${c.bold('OPTIONS')}
  --json              machine-readable JSON output (or: --json '<params>')
  --timeout <ms>      per-request timeout (default 30000)
  --client <id>       address a specific browser client
  -h, --help          this message

${c.bold('ENV')}
  HERMES_RESOLVE_URL      bridge URL (default http://127.0.0.1:${PORT})
  HERMES_RESOLVE_JSON=1  force JSON output
  NO_COLOR=1             disable colour

${c.bold('EXAMPLES')}
  hermes-resolve doctor
  hermes-resolve call set_page page=color
  hermes-resolve call set_node_param path=primary.lift value='[0.02,-0.01,0]'
  hermes-resolve call set_grade --json '{"primary":{"contrast":1.1}}'
  hermes-resolve batch grade-pass.json --json
`;

async function cmdHealth(flags) {
  const { status, body } = await getJSON('/health');
  if (status !== 200 || !body?.ok) {
    if (flags.json) out(JSON.stringify({ ok: false, error: body?.error ?? `HTTP ${status}` }, null, 2));
    else fail(`health check failed: ${body?.error ?? `HTTP ${status}`}`);
    return 1;
  }

  if (flags.json) {
    out(JSON.stringify(body, null, 2));
    return 0;
  }

  out(`${c.green('●')} agent bridge ${c.bold(`v${body.version}`)} on ${BASE}`);
  out(`  ${c.dim('transport')}  ${body.transport}`);
  out(`  ${c.dim('clients')}   ${body.clients} browser client(s) connected`);
  out(`  ${c.dim('out dir')}   ${body.outDir}`);
  if (body.commandDrift?.length) {
    out(`  ${c.yellow('drift')}     command list differs from the server's copy:`);
    for (const d of body.commandDrift) {
      out(`    ${c.dim(d.client)} missing [${d.missing.join(', ')}] extra [${d.extra.join(', ')}]`);
    }
  }
  return 0;
}

async function cmdCall(flags, rest) {
  const command = rest.shift();
  if (!command) fail('call needs a command name — try `hermes-resolve call --help`');

  const params = { ...parseKeyValues(rest) };
  if (flags.jsonParams) {
    let extra;
    try {
      extra = JSON.parse(flags.jsonParams);
    } catch {
      fail(`--json value is not valid JSON: ${flags.jsonParams}`);
    }
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
      Object.assign(params, extra);
    }
  }

  const request = { id: newId(), command, params, ...(flags.timeout ? { timeoutMs: flags.timeout } : {}), ...(flags.client ? { client: flags.client } : {}) };
  const response = await call(request);
  return reportResult({ command }, response, { json: flags.json }) ? 0 : 1;
}

async function cmdBatch(flags, rest) {
  const file = rest.shift();
  if (!file) fail('batch needs a path to a JSON file containing an array of requests');

  let requests;
  try {
    requests = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`could not read ${file}: ${err.message}`);
  }
  if (!Array.isArray(requests)) {
    fail(`${file} must contain a JSON array of requests, e.g. [{"id":"1","command":"set_page","params":{"page":"color"}}]`);
  }

  // Fill in ids so a hand-written array of {command, params} works.
  const normalised = requests.map((r, i) => ({
    id: r?.id ?? newId(),
    command: r?.command,
    params: r?.params,
    ...(flags.timeout ? { timeoutMs: flags.timeout } : {}),
  }));
  const bad = normalised.find((r) => typeof r.command !== 'string');
  if (bad) fail(`every entry needs a "command" string (offending index ${normalised.indexOf(bad)})`);

  const { status, body } = await postJSON('/rpc', normalised);
  if (status !== 200) fail(`batch failed: ${body?.error ?? `HTTP ${status}`}`);

  if (flags.json) {
    out(JSON.stringify(body, null, 2));
    return body.every((r) => r.ok) ? 0 : 1;
  }

  out(c.bold(`${body.length} request(s) to ${BASE}`));
  let failures = 0;
  body.forEach((response, i) => {
    const request = normalised[i];
    out('');
    if (!reportResult(request, response, { json: false })) failures++;
  });
  out('');
  if (failures === 0) out(c.green(`all ${body.length} succeeded`));
  else out(c.red(`${failures} of ${body.length} failed`));
  return failures === 0 ? 0 : 1;
}

async function cmdWatch(flags) {
  const url = new URL(`${BASE}/events`);
  out(c.dim(`watching ${url} — ctrl-c to stop`));
  out(c.dim(`replay: past events are replayed from the server's ${500}-event buffer`));

  const req = httpRequest(
    { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET' },
    (res) => {
      if (res.statusCode !== 200) {
        notRunning(`event stream returned HTTP ${res.statusCode}`);
        return;
      }
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        // SSE frames are separated by a blank line.
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            out(c.dim(payload));
            continue;
          }
          if (flags.json) {
            out(payload);
            continue;
          }
          // The stream opens with a `hello` greeting that is not an AgentEvent.
          if (!parsed.type) {
            out(c.dim(`connected — bridge v${parsed.version ?? '?'}, ${parsed.clients ?? 0} client(s)`));
            continue;
          }
          const time = new Date(parsed.ts ?? Date.now()).toISOString().slice(11, 23);
          const tag = { progress: c.cyan('progress'), log: c.dim('log'), state: c.magenta('state'), done: c.bold('done') }[parsed.type] ?? parsed.type;
          const detail =
            parsed.type === 'progress' ? `${(parsed.value * 100).toFixed(0)}% ${parsed.note ?? ''}`
              : parsed.type === 'log' ? `${parsed.level} ${parsed.message}`
                : parsed.type === 'done' ? `${parsed.command} ${parsed.ok ? c.green('ok') : c.red('failed')} ${Math.round(parsed.ms)}ms ${parsed.error?.message ?? ''}`
                  : c.dim(JSON.stringify(parsed.state));
          out(`${c.dim(time)} ${tag} ${detail}`);
        }
      });
      res.on('end', () => {
        errOut(c.yellow('event stream closed (server shutting down?)'));
        process.exit(0);
      });
    },
  );
  req.on('error', (err) => notRunning(String(err.message ?? err)));
  req.end();
  await new Promise(() => {}); // stream until interrupted
  return 0;
}

async function cmdDoctor(flags) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  // 1. server
  let health = null;
  try {
    const { status, body } = await getJSON('/health', { timeoutMs: 4000 });
    health = body;
    add('bridge reachable', status === 200 && !!body?.ok, status === 200 ? `${BASE} v${body.version}` : `HTTP ${status}`);
  } catch {
    add('bridge reachable', false, BASE);
  }

  let env = null;
  if (health?.ok) {
    // 2. browser client
    add('browser client connected', (health.clients ?? 0) > 0, `${health.clients ?? 0} client(s)`);

    // 3-5. capabilities, reported by the client itself
    try {
      const response = await call({ id: newId(), command: 'agent_env', timeoutMs: 8000 });
      if (response.ok) {
        env = response.result;
        const caps = env?.capabilities ?? {};
        add('webgl2', !!caps.webgl2, caps.glRenderer || 'no webgl2 context');
        add('ext_color_buffer_float', !!caps.extColorBufferFloat, caps.extColorBufferFloat ? 'available' : 'missing — 32-bit float render targets unavailable');
        const precision = caps.pipelinePrecision ?? 'unknown';
        add('pipeline precision', precision !== 'unknown' && precision !== null, String(precision));
        add('pipeline attached', !!caps.hasPipeline, caps.hasPipeline ? 'ok' : 'window.__resolve.pipeline missing');
        add('viewer canvas', !!caps.viewerCanvas, caps.viewerSize ? `${caps.viewerSize.width}x${caps.viewerSize.height}` : 'not found — grading commands will fail');
      } else {
        add('agent_env probe', false, response.error?.message ?? 'failed');
      }
    } catch (err) {
      add('agent_env probe', false, String(err.message ?? err));
    }

    if (health.commandDrift?.length) {
      add('command list in sync', false, `drift: ${health.commandDrift.map((d) => d.client).join(', ')}`);
    } else {
      add('command list in sync', true, `${(await getJSON('/commands')).body?.commands?.length ?? 0} commands`);
    }
  }

  const failed = checks.filter((ch) => !ch.ok);
  const verdict = !health?.ok
    ? c.red('FAIL — agent bridge is not running (start it with `npm run agent`)')
    : failed.length === 0
      ? c.green('OK — the agent can drive this session')
      : c.yellow(`DEGRADED — ${failed.length} check(s) failed; the agent will not be able to grade until they pass`);

  if (flags.json) {
    out(JSON.stringify({ ok: failed.length === 0, verdict: failed.length === 0 ? 'ok' : 'degraded', checks, environment: env }, null, 2));
    return failed.length === 0 ? 0 : 1;
  }

  for (const ch of checks) {
    const mark = ch.ok ? c.green('✓') : c.red('✗');
    out(`${mark} ${ch.name.padEnd(24)} ${c.dim(ch.detail ?? '')}`);
  }
  out('');
  out(verdict);
  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (process.env.HERMES_RESOLVE_JSON === '1') argv.unshift('--json');
  const { flags, rest } = parseFlags(argv);
  const command = rest.shift();

  if (flags.help || !command) {
    out(USAGE);
    return command ? 0 : 1;
  }

  switch (command) {
    case 'health': return cmdHealth(flags);
    case 'call': return cmdCall(flags, rest);
    case 'batch': return cmdBatch(flags, rest);
    case 'watch': return cmdWatch(flags);
    case 'doctor': return cmdDoctor(flags);
    case 'serve': return cmdServe(rest);
    default:
      errOut(c.red(`hermes-resolve: unknown command "${command}"`));
      errOut(`  known: health, call, batch, watch, doctor, serve`);
      errOut('');
      errOut(USAGE);
      return 1;
  }
}

/** Convenience passthrough so `hermes-resolve serve` works without npm scripts. */
async function cmdServe(rest) {
  const portIndex = rest.indexOf('--port');
  if (portIndex >= 0) process.env.HERMES_RESOLVE_PORT = rest[portIndex + 1];
  await import('../server/server.mjs');
  return new Promise(() => {});
}

main().then(
  (code) => process.exit(typeof code === 'number' ? code : 0),
  (err) => {
    errOut(c.red(`hermes-resolve: ${err?.message ?? err}`));
    if (process.env.HERMES_RESOLVE_DEBUG) errOut(err?.stack ?? '');
    process.exit(1);
  },
);
