/**
 * Test isolation.
 *
 * The browser agent client picks its server from `?agent=<origin>`, falling
 * back to the port the page was served from. Two consequences that have cost
 * real time:
 *
 * 1. A test that starts an agent server on the DEFAULT port shares it with any
 *    browser tab the user happens to have open. Commands then execute in the
 *    user's tab while the test reads state from its own headless page — which
 *    looks exactly like a broken feature. `set_page` "did nothing" was this.
 * 2. `npm run verify` and a running app are not independent, so a green suite
 *    can depend on whether the user has a tab open.
 *
 * Every test that talks to the agent server must therefore use its own port
 * AND point its page at it. `agentUrl()` is the only supported way to do that.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';

export const AGENT_PORT = Number(process.env.HERMES_RESOLVE_TEST_PORT ?? 7811);
export const AGENT_ORIGIN = `http://127.0.0.1:${AGENT_PORT}`;

/** The app URL a test should open, wired to that test's own agent server. */
export function agentUrl(appPort, pathname = '/') {
  return `http://127.0.0.1:${appPort}${pathname}?agent=${encodeURIComponent(AGENT_ORIGIN)}`;
}

/** Environment for a spawned agent server, on this test's own port. */
export function agentEnv() {
  return { ...process.env, HERMES_RESOLVE_PORT: String(AGENT_PORT) };
}

/**
 * Kill leftover agent servers and refuse to run against a shared port.
 *
 * The server routes to its "preferred" client — whichever polled most
 * recently — so a browser left over from an earlier run, carrying an older
 * bundle, will happily answer commands meant for the page under test. The
 * result is assertions that quietly measure the wrong page. This has cost real
 * time more than once, so it is a hard precondition rather than a hope: if
 * more than one client ever registers, the test fails loudly.
 */
export async function requireSoleClient(origin = AGENT_ORIGIN, tries = 40) {
  for (let i = 0; i < tries; i++) {
    let health = null;
    try {
      health = await (await fetch(`${origin}/health`)).json();
    } catch {
      health = null;
    }
    if (health && health.clients === 1) return health;
    if (health && health.clients > 1) {
      const ids = (health.clients_detail ?? []).map((c) => c.id).join(', ');
      throw new Error(
        `${origin} has ${health.clients} browser clients (${ids}). Commands would be routed to ` +
        'whichever polled last, which may be a stale page from an earlier run. Close the extra ' +
        'tabs, or give this run its own port via HERMES_RESOLVE_TEST_PORT.',
      );
    }
    await sleep(250);
  }
  throw new Error(`no browser client registered at ${origin} after ${tries} polls`);
}

/**
 * Stop everything an earlier run may have left running: the agent server, a
 * preview server, and — the one that actually keeps re-registering — a headless
 * Chrome from a test that died before its cleanup ran. A leaked browser keeps
 * polling, so killing only the server is not enough.
 */
export function killLeakedTestProcesses() {
  try {
    const out = execFileSync('ps', ['-o', 'pid,command', '-ax'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (/server\/server\.mjs|vite\/bin\/vite\.js|--headless|--remote-debugging-port/.test(line)
        && !line.includes('killLeaked')) {
        const pid = line.trim().split(/\s+/)[0];
        if (/^\d+$/.test(pid)) {
          try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    }
  } catch { /* ps unavailable: requireSoleClient still catches it */ }
}

/** Stop any agent server left behind by an earlier run. Test ports only. */
export function killStaleAgentServers(port = AGENT_PORT) {
  try {
    const out = execFileSync('ps', ['-o', 'pid,command', '-ax'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (!line.includes('server/server.mjs')) continue;
      const pid = line.trim().split(/\s+/)[0];
      if (!/^\d+$/.test(pid)) continue;
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ }
    }
  } catch { /* ps unavailable: the caller still checks the health endpoint */ }
}
