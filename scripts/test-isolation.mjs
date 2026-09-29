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
