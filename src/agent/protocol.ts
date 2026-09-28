/**
 * Wire protocol for the Hermes -> browser bridge.
 *
 * WHY this file is not shared code: the three peers (Node server, browser bundle,
 * CLI) run on different loaders. The server and CLI are plain .mjs with no build
 * step and the browser is compiled by Vite, so the two .mjs files keep a
 * deliberately tiny mirror of the few constants they need. `COMMAND_NAMES` is the
 * single written definition; `hermes-resolve doctor` surfaces drift if the mirror
 * ever goes stale.
 */

import type { AgentCommandMap } from '../core/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 1;

/** Long enough for a slow export_video pass, short enough that a stuck client fails loudly. */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 600_000;

/** Refuse to fan a giant batch out over the single browser client. */
export const MAX_BATCH = 64;

/** Control frames over the WebSocket are capped so a bad length cannot OOM the bridge. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** How long a browser client's poll is held before the server answers 204. */
export const POLL_WAIT_MS = 25_000;

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

export interface AgentRequest {
  id: string;
  command: string;
  params?: unknown;
  timeoutMs?: number;
}

export interface AgentError {
  message: string;
  stack?: string;
  code?: string;
}

export interface AgentResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: AgentError;
  /** Wall-clock time the browser spent executing. */
  ms: number;
}

export function success(id: string, result: unknown, ms: number): AgentResponse {
  return { id, ok: true, result, ms };
}

export function failure(
  id: string,
  message: string,
  code = 'error',
  ms = 0,
  stack?: string,
): AgentResponse {
  return { id, ok: false, error: { message, code, ...(stack ? { stack } : {}) }, ms };
}

export function timeoutResponse(id: string, ms: number): AgentResponse {
  return failure(id, `no client response within ${ms}ms`, 'timeout', ms);
}

// ---------------------------------------------------------------------------
// Events (progress / log / state / done)
// ---------------------------------------------------------------------------

export type AgentEvent = AgentProgressEvent | AgentLogEvent | AgentStateEvent | AgentDoneEvent;

export interface AgentEventBase {
  /** Epoch ms, stamped by the emitter so watchers can interleave by source. */
  ts: number;
  /** Request this event belongs to, when it is command-scoped. */
  id?: string;
  command?: string;
}

export interface AgentProgressEvent extends AgentEventBase {
  type: 'progress';
  /** 0..1. Clamped by the client so consumers never see nonsense. */
  value: number;
  total?: number;
  note?: string;
}

export interface AgentLogEvent extends AgentEventBase {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export interface AgentStateEvent extends AgentEventBase {
  type: 'state';
  state: unknown;
}

export interface AgentDoneEvent extends AgentEventBase {
  type: 'done';
  ok: boolean;
  ms: number;
  error?: AgentError;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type CommandName = keyof AgentCommandMap;

/**
 * Bridge-only commands. These are deliberately kept out of core/types.ts: the
 * domain model has no business knowing about capability probes, and the core
 * command map stays the contract for the grading surface.
 */
export interface AgentBridgeCommands {
  /** Capability probe used by `hermes-resolve doctor`. */
  agent_env: Record<string, never>;
  /** Echoes the command list this client will accept. */
  agent_commands: Record<string, never>;
}

export type BridgeCommandName = keyof AgentBridgeCommands;
export type AnyCommandName = CommandName | BridgeCommandName;

/** Param type for a given command, e.g. ParamsOf<'set_page'> === { page: PageId }. */
export type ParamsOf<C extends CommandName> = AgentCommandMap[C];

// The mapped type makes this object literal an exhaustive checklist: a command
// added to AgentCommandMap breaks the build here until it is mirrored below.
const COMMAND_TABLE: { readonly [K in CommandName]: true } = {
  open_media: true,
  import_media: true,
  list_media: true,
  list_timeline: true,
  set_playhead: true,
  goto_timecode: true,
  split: true,
  append_to_track: true,
  trim_to_playhead: true,
  set_clip_enabled: true,
  play: true,
  pause: true,
  step_playhead: true,
  set_loop: true,
  set_range: true,
  set_page: true,
  add_node: true,
  remove_node: true,
  connect_nodes: true,
  set_node_param: true,
  set_grade: true,
  auto_balance: true,
  analyze_frame: true,
  get_scopes: true,
  read_pixel: true,
  export_frame: true,
  export_video: true,
  apply_lut: true,
  select_clip: true,
  keyframe: true,
  save_project: true,
  undo: true,
  redo: true,
  screenshot: true,
};

const BRIDGE_COMMAND_TABLE: { readonly [K in BridgeCommandName]: true } = {
  agent_env: true,
  agent_commands: true,
};

export const CORE_COMMAND_NAMES: readonly string[] = Object.freeze(
  Object.keys(COMMAND_TABLE) as CommandName[],
);

export const BRIDGE_COMMAND_NAMES: readonly string[] = Object.freeze(
  Object.keys(BRIDGE_COMMAND_TABLE) as BridgeCommandName[],
);

/** Every command the browser executor accepts. */
export const COMMAND_NAMES: readonly string[] = Object.freeze([
  ...CORE_COMMAND_NAMES,
  ...BRIDGE_COMMAND_NAMES,
]);

const COMMAND_SET: ReadonlySet<string> = new Set(COMMAND_NAMES);

export function isCommand(name: string): name is AnyCommandName {
  return COMMAND_SET.has(name);
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Minimal JSON-RPC-ish framing. A single tagged union rather than a positional
 * [id, method, params] array: WS and long-poll carry the exact same shapes, and
 * tagged frames survive being logged as JSON without a decoder.
 */
export type EnvelopeKind = 'hello' | 'request' | 'response' | 'event' | 'ping' | 'pong';

export interface Envelope<T = unknown> {
  v: number;
  kind: EnvelopeKind;
  id?: string;
  /** Which browser client this frame is addressed to (or came from). */
  client?: string;
  payload?: T;
}

export function envelope<T>(
  kind: EnvelopeKind,
  payload: T,
  extra?: { id?: string; client?: string },
): Envelope<T> {
  return { v: PROTOCOL_VERSION, kind, payload, ...(extra?.id ? { id: extra.id } : {}), ...(extra?.client ? { client: extra.client } : {}) };
}

export interface ClientHello {
  clientId: string;
  url: string;
  userAgent: string;
  /** Echoed back by the server so drift against COMMAND_NAMES is visible. */
  commands: readonly string[];
  capabilities: Record<string, unknown>;
}

export function hello(
  clientId: string,
  commands: readonly string[],
  capabilities: Record<string, unknown> = {},
): Envelope<ClientHello> {
  return envelope('hello', {
    clientId,
    url: typeof location === 'undefined' ? '' : location.href,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    commands,
    capabilities,
  });
}

export function rpcRequest(request: AgentRequest, client?: string): Envelope<AgentRequest> {
  return envelope('request', request, { id: request.id, ...(client ? { client } : {}) });
}

export function rpcResponse(response: AgentResponse): Envelope<AgentResponse> {
  return envelope('response', response, { id: response.id });
}

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    typeof kind === 'string' &&
    ['hello', 'request', 'response', 'event', 'ping', 'pong'].includes(kind)
  );
}

/** Returns null rather than throwing: a corrupt frame must not kill a socket. */
export function decodeEnvelope(raw: string): Envelope | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isAgentRequest(value: unknown): value is AgentRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && v.id.length > 0 && typeof v.command === 'string' && v.command.length > 0;
}

export function isAgentResponse(value: unknown): value is AgentResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.ok === 'boolean';
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === 'progress' || t === 'log' || t === 'state' || t === 'done';
}

export function clampTimeout(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(ms)));
}

// ---------------------------------------------------------------------------
// JSON safety
// ---------------------------------------------------------------------------

/**
 * Results cross a JSON boundary, so typed arrays (pixel reads, scopes) would
 * otherwise serialise as `{"0":1,"1":0}` and typed arrays holding NaN become null.
 * Normalising here keeps every handler free of bespoke serialisation code.
 */
export function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value as number) ? value : null;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'bigint') return Number(value);
  if (t === 'function' || t === 'symbol') return undefined;

  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);

  if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
    const view = obj as unknown as ArrayLike<number>;
    const out = new Array(view.length);
    for (let i = 0; i < view.length; i++) out[i] = Number.isFinite(view[i]) ? view[i] : null;
    return out;
  }
  if (obj instanceof ArrayBuffer) return jsonSafe(Array.from(new Uint8Array(obj)), seen);
  if (obj instanceof Error) {
    return { message: obj.message, stack: obj.stack, name: obj.name };
  }
  if (obj instanceof Date) return obj.toISOString();
  if (obj instanceof Map) return jsonSafe(Array.from(obj.entries()), seen);
  if (obj instanceof Set) return jsonSafe(Array.from(obj.values()), seen);
  if (Array.isArray(obj)) return obj.map((v) => jsonSafe(v, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const safe = jsonSafe(v, seen);
    if (safe !== undefined) out[k] = safe;
  }
  return out;
}
