/**
 * Browser-side agent executor.
 *
 * Connects back to server/server.mjs, registers itself as the executor, and
 * resolves AgentRequests by driving `window.__resolve` and the ColorPipeline.
 * Everything the agent can do goes through `execute()`, so the UI and the CLI
 * share one code path — there is no second, "for humans only" implementation that
 * can drift from the one the agent uses.
 *
 * Transport: long-poll, with an automatic upgrade to a WebSocket if a server ever
 * reports `transport: "ws"` in /health. See the header of server/server.mjs for
 * why long-poll is the default.
 */

import {
  COMMAND_NAMES,
  BRIDGE_COMMAND_NAMES,
  isCommand,
  jsonSafe,
  type AgentEvent,
  type AgentRequest,
  type AgentResponse,
  type ClientHello,
  type Envelope,
} from './protocol.js';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

// ---------------------------------------------------------------------------
// Structural interfaces for surfaces owned by other workstreams
// ---------------------------------------------------------------------------
//
// These are declared structurally rather than imported so this file typechecks
// and runs even while main.ts / gpu/pipeline.ts / color/cpugrade.ts are still
// being written. If a real export appears later, the shape is compatible and
// nothing here needs to change. We deliberately do NOT augment the global Window
// interface: main.ts owns that declaration, and a second, differently-shaped
// `__resolve` on Window would be a conflicting-identifier build break.

export interface ColorPipelineLike {
  render?(...args: unknown[]): unknown;
  setLut?(...args: unknown[]): unknown;
  resolveKeyframes?(...args: unknown[]): unknown;
  readPixels?(...args: unknown[]): unknown;
  analyze?(...args: unknown[]): unknown;
  scopes?(...args: unknown[]): unknown;
  getScopes?(...args: unknown[]): unknown;
  precision?: string;
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  gl?: WebGL2RenderingContext;
  [key: string]: unknown;
}

export interface ResolveApi {
  project: Record<string, unknown> & {
    page?: string;
    mediaPool?: unknown[];
    timeline?: Record<string, unknown>;
    settings?: Record<string, unknown>;
  };
  pipeline?: ColorPipelineLike;
  setPlayhead?(frame: number): unknown;
  play?(): unknown;
  pause?(): unknown;
  stepPlayhead?(frames: number): unknown;
  split?(): unknown;
  trimToPlayhead?(): unknown;
  setClipEnabled?(clipId: string, enabled: boolean): unknown;
  appendToTrack?(trackId: string, mediaId: string, atFrame: number): unknown;
  setLoop?(enabled: boolean): unknown;
  setIn?(frame: number): unknown;
  setOut?(frame: number): unknown;
  gotoPage?(page: string): unknown;
  addNode?(opts?: Record<string, unknown>): unknown;
  setParam?(id: string, path: string, value: unknown): unknown;
  removeNode?(id: string): unknown;
  connectNodes?(from: string, to: string): unknown;
  selectClip?(id: string): unknown;
  undo?(): unknown;
  redo?(): unknown;
  saveProject?(path?: string): unknown;
  getState?(): unknown;
  [key: string]: unknown;
}

/** CPU colour engine, as exported by src/color/cpugrade.ts. */
export interface CpuGradeEngine {
  autoWhiteBalance?: (pixels: unknown, opts?: unknown) => unknown;
  autoLevels?: (pixels: unknown, opts?: unknown) => unknown;
  applyGrade?: (pixels: unknown, grade: unknown, opts?: unknown) => unknown;
}



// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A failure the agent can act on — surfaces as a readable error, never a throw into the socket. */
export class CommandError extends Error {
  code: string;
  constructor(message: string, code = 'bad_params') {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 7801;

function serverOrigin(): string {
  // Explicit override wins so a LAN-ish or remote host can be targeted.
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  const fromEnv = meta.env?.VITE_HERMES_AGENT_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const q = new URLSearchParams(location.search).get('agent');
  if (q) return q.replace(/\/+$/, '');
  return `${location.protocol}//${location.hostname}:${DEFAULT_PORT}`;
}

const ORIGIN = serverOrigin();
const LOG_LIMIT = 200;

function clientId(): string {
  const KEY = 'hermes-resolve.agent.clientId';
  try {
    const existing = sessionStorage.getItem(KEY);
    if (existing) return existing;
    const fresh = `web-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    // Private mode: a per-load id is fine, the server keys on presence not identity.
    return `web-${Math.random().toString(36).slice(2, 10)}`;
  }
}

const CLIENT_ID = clientId();

// ---------------------------------------------------------------------------
// Param validation
// ---------------------------------------------------------------------------

type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'rgb' | 'enum' | 'any';

interface FieldSpec {
  type: FieldType;
  required?: boolean;
  values?: readonly string[];
}

const PAGES = ['media', 'cut', 'edit', 'fusion', 'color', 'fairlight', 'deliver'] as const;
const NODE_KINDS = ['corrector', 'serial', 'parallel', 'note', 'group', 'key'] as const;
const INTERPS = ['linear', 'ease', 'hold', 'ease-in', 'ease-out'] as const;

const NO_PARAMS: Record<string, never> = {};

/**
 * Per-command param contract. Hand-rolled rather than schema-driven because the
 * whole point is a precise, human-readable error: an agent that fat-fingers
 * `set_page` needs to be told "expected one of color|cut|..." not "invalid
 * request". Mirrors AgentCommandMap in src/core/types.ts.
 */
const SPECS: Record<string, Record<string, FieldSpec>> = {
  open_media: { path: { type: 'string', required: true } },
  import_media: { paths: { type: 'array', required: true }, binId: { type: 'string' } },
  list_media: NO_PARAMS,
  list_timeline: NO_PARAMS,
  set_playhead: { frame: { type: 'integer', required: true } },
  set_page: { page: { type: 'enum', required: true, values: PAGES } },
  add_node: { label: { type: 'string' }, kind: { type: 'enum', values: NODE_KINDS }, after: { type: 'string' } },
  remove_node: { id: { type: 'string', required: true } },
  connect_nodes: { from: { type: 'string', required: true }, to: { type: 'string', required: true } },
  set_node_param: { id: { type: 'string' }, path: { type: 'string', required: true }, value: { type: 'any', required: true } },
  set_grade: { id: { type: 'string' }, grade: { type: 'object', required: true } },
  auto_balance: { id: { type: 'string' }, method: { type: 'enum', values: ['neutral', 'white-balance'] } },
  goto_timecode: { timecode: { type: 'string', required: true } },
  play: NO_PARAMS,
  pause: NO_PARAMS,
  step_playhead: { frames: { type: 'integer', required: true } },
  set_loop: { enabled: { type: 'boolean' } },
  set_range: { in: { type: 'integer' }, out: { type: 'integer' } },
  split: { frame: { type: 'integer' } },
  append_to_track: { mediaId: { type: 'string' }, trackId: { type: 'string' }, atFrame: { type: 'integer' } },
  trim_to_playhead: { frame: { type: 'integer' } },
  set_clip_enabled: { clipId: { type: 'string' }, enabled: { type: 'boolean' } },
  analyze_frame: { frame: { type: 'integer' } },
  get_scopes: NO_PARAMS,
  read_pixel: { x: { type: 'number', required: true }, y: { type: 'number', required: true }, frame: { type: 'integer' } },
  export_frame: { frame: { type: 'integer' }, path: { type: 'string' } },
  export_video: { path: { type: 'string', required: true }, codec: { type: 'string' }, crf: { type: 'number' } },
  apply_lut: { id: { type: 'string' }, lut: { type: 'string', required: true }, intensity: { type: 'number' } },
  select_clip: { id: { type: 'string', required: true } },
  keyframe: { path: { type: 'string', required: true }, frame: { type: 'integer', required: true }, value: { type: 'number', required: true }, interp: { type: 'enum', values: INTERPS } },
  save_project: { path: { type: 'string' } },
  undo: NO_PARAMS,
  redo: NO_PARAMS,
  screenshot: { path: { type: 'string' } },
  agent_env: NO_PARAMS,
  agent_commands: NO_PARAMS,
};

/**
 * Accepts an RGB triple in either shape the codebase produces: a real tuple, or
 * an array spread into an object (`{...([1,1,1])}`, which cpugrade's
 * autoWhiteBalance returns on its already-neutral branches). Being strict here
 * would make auto_balance fail on the one input that needs no correction.
 */
const isRGBArray = (v: unknown): v is [number, number, number] => {
  if (Array.isArray(v)) {
    return v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
  }
  if (typeof v !== 'object' || v === null) return false;
  const keys = Object.keys(v as Record<string, unknown>);
  if (keys.length !== 3 || !keys.every((k, i) => k === String(i))) return false;
  return keys.every((k) => {
    const n = (v as Record<string, unknown>)[k];
    return typeof n === 'number' && Number.isFinite(n);
  });
};



/**
 * How many clips are on the timeline, for before/after assertions.
 *
 * getState() exposes these as top-level `tracks` and `timelineClips`, not
 * nested under a `timeline` key — reading the wrong shape is how a helper
 * silently reports "no clips" against a timeline that has one.
 */
function countClips(a: ResolveApi): number {
  const s = a.getState?.() as { timelineClips?: unknown[] } | undefined;
  return s?.timelineClips?.length ?? 0;
}

/** The first video track, which is where an agent append belongs by default. */
function firstVideoTrack(a: ResolveApi): string | null {
  const s = a.getState?.() as { tracks?: Array<{ id: string; kind?: string }> } | undefined;
  return s?.tracks?.find((t) => t.kind === 'video')?.id ?? null;
}

/**
 * Parse an NLE timecode into a frame number.
 *
 * Accepts HH:MM:SS:FF, MM:SS:FF and SS:FF, with the frame field counted in
 * frames rather than a hundredths-of-a-second field — the SMPTE convention
 * every NLE uses, and the one that makes 00:00:01:12 mean frame 36 at 24fps
 * rather than 1.12 seconds. Returns null rather than guessing, so a typo is an
 * error the agent can see instead of a silent jump to the wrong frame.
 */
function parseTimecode(tc: string, fps: number): number | null {
  const parts = tc.split(':').map((p) => p.trim());
  if (parts.some((p) => p === '' || !/^\d+$/.test(p))) return null;
  const n = parts.map((p) => Number(p));
  if (parts.length === 4) {
    const [h, m, s, f] = n;
    if (m > 59 || s > 59 || f >= Math.ceil(fps)) return null;
    return ((h * 60 + m) * 60 + s) * fps + f;
  }
  if (parts.length === 3) {
    const [m, s, f] = n;
    if (s > 59 || f >= Math.ceil(fps)) return null;
    return (m * 60 + s) * fps + f;
  }
  if (parts.length === 2) {
    const [s, f] = n;
    if (f >= Math.ceil(fps)) return null;
    return s * fps + f;
  }
  return null;
}

/** Format a frame number back to HH:MM:SS:FF, for echoing to the agent. */
function formatTimecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.round(frame));
  const fpsI = Math.max(1, Math.round(fps));
  const ff = f % fpsI;
  const total = Math.floor(f / fpsI);
  const ss = total % 60;
  const mm = Math.floor(total / 60) % 60;
  const hh = Math.floor(total / 3600);
  const p2 = (v: number) => String(v).padStart(2, '0');
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}:${p2(ff)}`;
}

/** Reads an RGB triple as a real array, whichever shape it arrived in. */
function toRGB(v: unknown): [number, number, number] {
  return [Number((v as [number, number, number])[0]), Number((v as [number, number, number])[1]), Number((v as [number, number, number])[2])];
}

function coerceScalar(command: string, field: string, spec: FieldSpec, value: unknown): unknown {
  if (spec.type === 'any') return value;
  if (value === null || value === undefined) return undefined;

  const bad = (want: string): never => {
    throw new CommandError(`${command}.${field} must be ${want}, got ${describe(value)}`);
  };

  switch (spec.type) {
    case 'string': {
      if (typeof value === 'string') return value;
      return bad('a string');
    }
    case 'number': {
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n === 'number' && Number.isFinite(n)) return n;
      return bad('a finite number');
    }
    case 'integer': {
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n === 'number' && Number.isFinite(n)) return Math.trunc(n);
      return bad('an integer');
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return bad('a boolean');
    }
    case 'array': {
      if (Array.isArray(value)) return value;
      return bad('an array');
    }
    case 'object': {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
      return bad('an object');
    }
    case 'rgb': {
      if (isRGBArray(value)) return value;
      if (Array.isArray(value) && value.length === 3) {
        const nums = value.map((n) => (typeof n === 'string' ? Number(n) : n));
        if (nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return nums as [number, number, number];
      }
      return bad('an array of 3 numbers, e.g. [0.02, -0.01, 0]');
    }
    case 'enum': {
      const s = typeof value === 'string' ? value : String(value);
      if (spec.values?.includes(s)) return s;
      return bad(`one of ${(spec.values ?? []).join(' | ')}`);
    }
    default:
      return value;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return JSON.stringify(value.slice(0, 32));
  return `${typeof value} ${String(value)}`;
}

/** Validates and coerces; returns a fresh object. Throws CommandError with a precise message. */
function validate(command: string, params: unknown): Record<string, unknown> {
  const spec = SPECS[command];
  if (!spec) throw new CommandError(`unknown command "${command}"`, 'unknown_command');

  const out: Record<string, unknown> = {};

  if (params !== undefined && params !== null && (typeof params !== 'object' || Array.isArray(params))) {
    throw new CommandError(`${command}: params must be an object, got ${describe(params)}`);
  }
  const given = (params ?? {}) as Record<string, unknown>;

  for (const [field, rule] of Object.entries(spec)) {
    const value = given[field];
    if (value === undefined || value === null) {
      if (rule.required) {
        throw new CommandError(`${command}.${field} is required (${rule.type}${rule.values ? `: ${rule.values.join(' | ')}` : ''})`);
      }
      continue;
    }
    const coerced = coerceScalar(command, field, rule, value);
    if (coerced !== undefined) out[field] = coerced;
  }

  const unknownKeys = Object.keys(given).filter((k) => !(k in spec));
  if (unknownKeys.length > 0) {
    // Not fatal — the spec drifts as the app grows — but always surfaced in the
    // log so a typo'd param name is visible instead of silently ignored.
    logLine('warn', `${command}: ignoring unknown param(s) ${unknownKeys.join(', ')}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const logLines: { at: number; level: string; text: string }[] = [];

function logLine(level: string, text: string): void {
  logLines.push({ at: Date.now(), level, text });
  if (logLines.length > LOG_LIMIT) logLines.shift();

  const el = document.getElementById('agent-log');
  if (el) {
    const line = document.createElement('div');
    line.className = `agent-log-line agent-log-${level}`;
    line.dataset.at = new Date().toISOString().slice(11, 23);
    line.textContent = `[${line.dataset.at}] ${text}`;
    el.appendChild(line);
    while (el.childElementCount > LOG_LIMIT) el.removeChild(el.firstChild as Node);
    el.scrollTop = el.scrollHeight;
  }
}

/** Rate-limited console output: reconnect storms must not fill the devtools console. */
let lastConsoleAt = 0;
let lastConsoleText = '';
function logThrottled(level: 'info' | 'warn', text: string): void {
  const now = Date.now();
  if (text === lastConsoleText && now - lastConsoleAt < 5000) return;
  lastConsoleAt = now;
  lastConsoleText = text;
  if (level === 'warn') console.warn('[agent]', text);
  else console.info('[agent]', text);
}

// ---------------------------------------------------------------------------
// App access
// ---------------------------------------------------------------------------

function app(): ResolveApi | null {
  const w = window as unknown as { __resolve?: ResolveApi };
  return w.__resolve ?? null;
}

function needApp(command: string): ResolveApi {
  const a = app();
  if (!a) {
    throw new CommandError(
      `${command}: the app is not initialised yet (window.__resolve is missing) — wait for the page to finish booting`,
      'app_unavailable',
    );
  }
  return a;
}

function numFrom(source: object, key: string): number | undefined {
  const v = (source as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function pipeline(): ColorPipelineLike | null {
  return app()?.pipeline ?? null;
}

// ---------------------------------------------------------------------------
// Capability report
// ---------------------------------------------------------------------------

function capabilities(): Record<string, unknown> {
  const canvas = findViewerCanvas();
  let webgl2 = false;
  let colorBufferFloat = false;
  let renderer = '';
  try {
    const probe = document.createElement('canvas');
    const gl = (probe.getContext('webgl2') ?? null) as WebGL2RenderingContext | null;
    if (gl) {
      webgl2 = true;
      colorBufferFloat = !!gl.getExtension('EXT_color_buffer_float');
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    /* headless / no GL: reported as false, doctor explains it */
  }

  return {
    webgl2,
    extColorBufferFloat: colorBufferFloat,
    glRenderer: renderer,
    pipelinePrecision: pipeline()?.precision ?? null,
    hasPipeline: !!pipeline(),
    hasApp: !!app(),
    viewerCanvas: !!canvas,
    viewerSize: canvas ? { width: canvas.width, height: canvas.height } : null,
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    userAgent: navigator.userAgent,
    url: location.href,
  };
}

const CANVAS_SELECTORS = [
  '#viewer canvas', '#preview canvas', '#grade-canvas', 'canvas.viewer',
  'canvas#viewer', 'canvas[data-viewer]', '#viewer',
  // No bare 'canvas' fallback: the page has ~12 canvases and the first
  // hit is usually a 180x180 vectorscope, so a readback sized from it
  // silently measures the wrong buffer. The viewer is always found by
  // an id or class above; if it is genuinely absent, say so.
];

function findViewerCanvas(): HTMLCanvasElement | null {
  // Duck-typed rather than `instanceof HTMLCanvasElement`: a canvas inside an
  // iframe belongs to a different realm, so instanceof silently returns false.
  const isCanvas = (v: unknown): v is HTMLCanvasElement =>
    !!v && typeof (v as HTMLCanvasElement).getContext === 'function' && typeof (v as { width?: unknown }).width === 'number';

  const piped = pipeline()?.canvas;
  if (isCanvas(piped)) return piped;
  for (const selector of CANVAS_SELECTORS) {
    const found = document.querySelector(selector);
    if (isCanvas(found)) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dotted paths
// ---------------------------------------------------------------------------

type Container = Record<string, unknown>;

function isPlainObject(v: unknown): v is Container {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reads/writes a dotted path, with RGB arrays as first-class values:
 *   'primary.lift'          -> [0.02, -0.01, 0]
 *   'primary.lift.1'        -> -0.01
 *   'effects.cdl.slope'     -> [1, 1, 1]
 * Arrays are treated as leaves unless the path continues with an index, so
 * 'curves.master' replaces the whole curve rather than merging into it.
 */
function splitPath(path: string): string[] {
  if (typeof path !== 'string' || path.length === 0) {
    throw new CommandError('path must be a non-empty dotted string, e.g. "primary.lift"', 'bad_params');
  }
  const parts = path.split('.').map((p) => p.trim());
  if (parts.some((p) => p.length === 0)) {
    throw new CommandError(`path "${path}" has an empty segment`, 'bad_params');
  }
  return parts;
}

function getPath(root: unknown, parts: string[]): unknown {
  let cursor: unknown = root;
  for (const part of parts) {
    if (Array.isArray(cursor)) {
      const index = Number(part);
      if (!Number.isInteger(index)) throw new CommandError(`"${part}" is not a valid array index`, 'bad_path');
      cursor = cursor[index];
    } else if (isPlainObject(cursor)) {
      if (!(part in cursor)) return undefined;
      cursor = cursor[part];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function setPath(root: Container, path: string, value: unknown): void {
  const parts = splitPath(path);
  let cursor: Container | unknown[] = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = Array.isArray(cursor) ? Number(part) : part;
    if (next === undefined || (typeof next === 'number' && !Number.isInteger(next))) {
      throw new CommandError(`path "${path}" is not addressable at "${part}"`, 'bad_path');
    }
    const child = Array.isArray(cursor) ? cursor[next as number] : cursor[next as string];
    if (!isPlainObject(child) && !Array.isArray(child)) {
      const fresh: Container = {};
      if (Array.isArray(cursor)) cursor[next as number] = fresh;
      else cursor[next as string] = fresh;
      cursor = fresh;
    } else {
      cursor = child as Container | unknown[];
    }
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(cursor)) {
    const index = Number(last);
    if (!Number.isInteger(index)) throw new CommandError(`"${last}" is not a valid array index`, 'bad_path');
    cursor[index] = value;
  } else {
    cursor[last] = value;
  }
}

function coerceValue(value: unknown): unknown {
  if (isRGBArray(value)) return value;
  if (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'string' || typeof n === 'number')) {
    const nums = value.map((n) => (typeof n === 'string' ? Number(n) : n));
    if (nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return nums;
  }
  if (isPlainObject(value)) {
    const r = (value as Record<string, unknown>).r;
    const g = (value as Record<string, unknown>).g;
    const b = (value as Record<string, unknown>).b;
    if (typeof r === 'number' && typeof g === 'number' && typeof b === 'number') return [r, g, b];
  }
  return value;
}

// ---------------------------------------------------------------------------
// Graph / grade helpers
// ---------------------------------------------------------------------------

interface NodeLike {
  id: string;
  label?: string;
  kind?: string;
  index?: number;
  grade?: Container;
  enabled?: boolean;
  inputs?: (string | null)[];
}

function timelineGraph(a: ResolveApi): { nodes: NodeLike[]; edges: [string, string][]; outputNodeId: string | null } {
  const settings = a.project?.settings as Record<string, unknown> | undefined;
  const graph = settings?.timelineGraph as Record<string, unknown> | undefined;
  const nodes = (graph?.nodes as NodeLike[] | undefined) ?? [];
  return {
    nodes,
    edges: (graph?.edges as [string, string][] | undefined) ?? [],
    outputNodeId: (graph?.outputNodeId as string | null | undefined) ?? null,
  };
}

function findNode(a: ResolveApi, id?: string): NodeLike {
  const { nodes } = timelineGraph(a);
  if (!nodes.length) throw new CommandError('the colour graph has no nodes yet — run add_node first', 'no_nodes');
  if (id) {
    const hit = nodes.find((n) => n.id === id || n.label === id);
    if (!hit) {
      throw new CommandError(`no node "${id}" (have: ${nodes.map((n) => `${n.id}${n.label ? ` (${n.label})` : ''}`).join(', ')})`, 'no_node');
    }
    return hit;
  }
  const selected = (a.project?.timeline as Record<string, unknown> | undefined)?.selection as string[] | undefined;
  if (selected?.length) {
    const hit = nodes.find((n) => selected.includes(n.id));
    if (hit) return hit;
  }
  const { outputNodeId } = timelineGraph(a);
  return nodes.find((n) => n.id === outputNodeId) ?? nodes[nodes.length - 1];
}

/** Deep-merges a partial grade patch (accepts dotted keys too) into a node's grade. */
function mergeGrade(target: Container, patch: unknown): Container {
  if (!isPlainObject(patch)) {
    throw new CommandError(`grade must be an object, got ${describe(patch)}`, 'bad_params');
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key.includes('.')) {
      setPath(target, key, coerceValue(value));
      continue;
    }
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      mergeGrade(existing, value);
    } else {
      target[key] = coerceValue(value);
    }
  }
  return target;
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

type PixelSource = { data: Uint8ClampedArray | Float32Array; width: number; height: number; source: string };

/**
 * Grabs the current frame as raw pixels, preferring the GPU path over a canvas
 * readback. `maxSide` is the analysis downscale; pass 0 for full resolution.
 *
 * `preferCanvas` exists for read_pixel: a bare readPixels() returns a flat array
 * with no dimensions, so reconstructing width/height from its length only works
 * for a square frame. Addressing a specific (x, y) needs exact dimensions, so
 * that path takes the canvas, which always has them.
 */
function grabPixels(maxSide = 256, preferCanvas = false): PixelSource | null {
  const pipe = pipeline();
  if (!preferCanvas && typeof pipe?.readPixels === 'function') {
    try {
      // readPixels(x, y, w, h) has NO default arguments: calling it bare
      // yields a 1x1 buffer, which then reports mean 0.45 of a 2-pixel
      // "frame" and makes every scope and read_pixel look like it worked
      // while measuring nothing. Always ask for the real size.
      const targets = (pipe as { targets?: { width?: number; height?: number } }).targets ?? {};
      const pw0 = numFrom(pipe as object, 'width') || numFrom(targets, 'width');
      const ph0 = numFrom(pipe as object, 'height') || numFrom(targets, 'height');
      const canvas0 = findViewerCanvas();
      // Pipeline targets are authoritative: the viewer canvas can be display
      // scaled, and the scope canvases share the same tag name.
      const cw = pw0 || canvas0?.width || 0;
      const chh = ph0 || canvas0?.height || 0;
      if (!cw || !chh) {
        throw new CommandError(
          'frame size is unknown — load a clip so the pipeline has render targets',
          'no_frame',
        );
      }
      const scale0 = maxSide > 0 ? Math.min(1, maxSide / Math.max(cw, chh)) : 1;
      const rw = Math.max(1, Math.round(cw * scale0));
      const rh = Math.max(1, Math.round(chh * scale0));
      const raw = pipe.readPixels(0, 0, rw, rh);
      const data = asPixelArray(raw);
      if (data && data.length >= 4) {
        // The dimensions came from the request above; a mismatch means the
        // pipeline returned a different size than asked for.
        const expect = rw * rh * 4;
        if (data.length < expect) {
          throw new CommandError(
            `pipeline.readPixels returned ${data.length} floats for a ${rw}x${rh} request (${expect} expected)`,
            'short_read',
          );
        }
        return { data, width: rw, height: rh, source: 'pipeline.readPixels' };
      }
    } catch {
      /* fall through to the canvas */
    }
  }

  const canvas = findViewerCanvas();
  if (!canvas || !canvas.width || !canvas.height) return null;
  const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(canvas.width, canvas.height)) : 1;
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));

  const scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(canvas, 0, 0, w, h);
    const image = ctx.getImageData(0, 0, w, h);
    return { data: image.data, width: w, height: h, source: 'canvas' };
  } catch {
    // A cross-origin frame taints the canvas; nothing to read.
    return null;
  }
}

/**
 * Converts a grabbed frame to the engine's layout: a flat Float32Array of RGB
 * triples. A 4-channel readback is de-alpha'd; a 3-channel one is normalised to
 * float range so a Uint8 buffer is not mistaken for scene-linear values.
 */
function toEnginePixels(pixels: PixelSource): Float32Array {
  const { data, width, height } = pixels;
  const isFloat = data instanceof Float32Array;
  const channels = data.length >= width * height * 4 ? 4 : 3;
  const count = width * height;
  const out = new Float32Array(count * 3);
  const scale = isFloat ? 1 : 1 / 255;
  for (let i = 0; i < count; i++) {
    out[i * 3] = data[i * channels] * scale;
    out[i * 3 + 1] = data[i * channels + 1] * scale;
    out[i * 3 + 2] = data[i * channels + 2] * scale;
  }
  return out;
}

function asPixelArray(raw: unknown): Uint8ClampedArray | Float32Array | null {
  if (ArrayBuffer.isView(raw) && !(raw instanceof DataView)) {
    const view = raw as unknown as { length: number };
    if (view.length >= 4) return raw as unknown as Uint8ClampedArray | Float32Array;
  }
  if (isPlainObject(raw)) {
    const data = raw.data;
    if (ArrayBuffer.isView(data) && (data as unknown as { length: number }).length >= 4) {
      return data as unknown as Uint8ClampedArray | Float32Array;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CPU grade engine
// ---------------------------------------------------------------------------

let cpuGradePromise: Promise<CpuGradeEngine | null> | null = null;

/**
 * Loads the CPU grade engine. `globalThis.__hermesCpuGrade` is checked first so
 * a test or a host app can substitute an engine without touching this module;
 * otherwise the real module is imported, which means it is type-checked and
 * bundled rather than discovered at runtime.
 */
function loadCpuGrade(): Promise<CpuGradeEngine | null> {
  if (!cpuGradePromise) {
    cpuGradePromise = (async () => {
      const published = (globalThis as { __hermesCpuGrade?: CpuGradeEngine }).__hermesCpuGrade;
      if (published) return published;
      try {
        return (await import('../color/cpugrade.js')) as unknown as CpuGradeEngine;
      } catch (err) {
        // A genuine load failure is worth a console line; a normal "no engine"
        // answer is not, because auto_balance already reports it to the agent.
        console.warn('[agent] CPU grade engine failed to load:', err);
        return null;
      }
    })();
  }
  return cpuGradePromise;
}

/**
 * Folds whatever the engine returned into a GradeState patch.
 *
 * The two entry points disagree on shape: autoWhiteBalance returns a bare RGB
 * gain triple, autoLevels returns a Partial<PrimaryState>. Both are normalised to
 * `{ primary: {...} }` so the caller has exactly one thing to merge. A result
 * that is already nested under `primary` is passed through, not double-wrapped.
 */
function normalizeBalance(raw: unknown): Container {
  // autoWhiteBalance's RGB gains.
  if (isRGBArray(raw)) return { primary: { gain: toRGB(raw) } };
  if (!isPlainObject(raw)) {
    throw new CommandError(
      `auto_balance returned ${describe(raw)}; expected an RGB triple or an object of correction values`,
      'bad_result',
    );
  }
  if (isPlainObject(raw.primary)) return { primary: raw.primary };

  const primary: Container = {};
  if (isRGBArray(raw.lift)) primary.lift = toRGB(raw.lift);
  if (isRGBArray(raw.gamma)) primary.gamma = toRGB(raw.gamma);
  if (isRGBArray(raw.gain)) primary.gain = toRGB(raw.gain);
  if (isRGBArray(raw.offset)) primary.offset = toRGB(raw.offset);

  let triple: [number, number, number] | null = null;
  if (isRGBArray(raw.gains)) triple = toRGB(raw.gains);
  else if (typeof raw.r === 'number' && typeof raw.g === 'number' && typeof raw.b === 'number') {
    triple = [raw.r, raw.g, raw.b];
  }
  if (triple && !primary.gain) primary.gain = triple;

  for (const key of ['temperature', 'tint', 'saturation', 'contrast', 'pivot', 'brightness', 'vibrance', 'hue'] as const) {
    if (typeof raw[key] === 'number') primary[key] = raw[key];
  }

  if (Object.keys(primary).length === 0) {
    // An empty result is meaningful, not a failure: autoLevels returns {} when
    // the histogram is already well-placed, and autoWhiteBalance returns
    // identity gains. Report it as a no-op so the agent can loop without
    // treating "nothing to do" as an error.
    return { neutral: true, note: 'the engine found no correction to make for this frame' };
  }
  return { primary };
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

async function upload(path: string, data: Blob | ArrayBuffer | string, encoding: 'base64' | 'utf8' = 'base64'): Promise<{ path: string; bytes: number }> {
  let payload: string;
  if (typeof data === 'string') {
    payload = data;
  } else {
    const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
    const bytes = new Uint8Array(buffer);
    // Chunked so a 1080p frame doesn't blow the argument limit of String.fromCharCode.
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    payload = btoa(binary);
  }

  const res = await fetch(`${ORIGIN}/file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, data: payload, encoding }),
  });
  const json = (await res.json()) as { ok?: boolean; path?: string; bytes?: number; error?: string };
  if (!res.ok || !json.ok) {
    throw new CommandError(`could not write ${path}: ${json.error ?? `HTTP ${res.status}`}`, 'upload_failed');
  }
  return { path: json.path ?? path, bytes: json.bytes ?? 0 };
}

function canvasBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolvePromise, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolvePromise(blob) : reject(new CommandError('canvas produced no image data', 'export_failed'))),
      type,
    );
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface Ctx {
  command: string;
  params: Record<string, unknown>;
  request: AgentRequest;
  progress(value: number, note?: string, total?: number): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

const str = (params: Record<string, unknown>, key: string): string | undefined =>
  params[key] === undefined ? undefined : String(params[key]);
const num = (params: Record<string, unknown>, key: string): number | undefined =>
  params[key] === undefined ? undefined : Number(params[key]);

const HANDLERS: Record<string, (ctx: Ctx) => unknown | Promise<unknown>> = {
  // ---- media ----------------------------------------------------------
  open_media: ({ params }) => {
    const a = needApp('open_media');
    const path = String(params.path);
    const pool = (a.project.mediaPool ??= []);
    const existing = pool.find((m) => (m as { src?: string }).src === path) as { id: string } | undefined;
    if (existing) return { id: existing.id, path, alreadyOpen: true };

    const id = `media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    pool.push({
      id,
      name: path.split('/').pop() ?? path,
      src: path,
      durationFrames: 0,
      fps: 24,
      width: 0,
      height: 0,
      kind: /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(path) ? 'image' : 'video',
      attrs: {},
    });
    return { id, path, alreadyOpen: false, mediaCount: pool.length };
  },

  import_media: async ({ params }) => {
    const a = needApp('import_media');
    const paths = (params.paths as string[] | undefined) ?? [];
    const pool = (a.project.mediaPool ??= []);
    const bins = (a.project.bins ?? []) as { id: string; clipIds: string[] }[];
    const bin = str(params, 'binId') ? bins.find((b) => b.id === str(params, 'binId')) : undefined;

    const added: { id: string; path: string; width: number; height: number; frames: number }[] = [];
    const skipped: string[] = [];
    const failed: { path: string; error: string }[] = [];

    // Fetch the bytes and hand them to the app's real import path.
    //
    // The previous version pushed a pool entry with width/height/durationFrames
    // all zero and never loaded anything, so an agent that imported by path got
    // a phantom clip that could never become a renderable source — and
    // list_media cheerfully reported the zeros back as if they were facts.
    // Going through importFiles means the same probe and decode run as a drag
    // and drop, and the reported dimensions are measured rather than invented.
    const files: File[] = [];
    const order: string[] = [];
    for (const path of paths) {
      if (pool.some((m) => (m as { src?: string }).src === path)) { skipped.push(path); continue; }
      const url = /^https?:\/\//i.test(path) ? path : new URL(path, location.href).href;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        files.push(new File([blob], path.split('/').pop() ?? path, { type: blob.type }));
        order.push(path);
      } catch (err) {
        failed.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }

    let clips: unknown[] = [];
    if (files.length > 0 && typeof a.importFiles === 'function') {
      clips = (await a.importFiles(files)) ?? [];
    }

    (clips as { id?: string; name?: string; width?: number; height?: number; durationFrames?: number }[])
      .forEach((clip, n) => {
        const src = order[n] ?? clip.name ?? '';
        if (bin && clip.id) bin.clipIds.push(clip.id);
        added.push({
          id: clip.id ?? '',
          path: src,
          width: clip.width ?? 0,
          height: clip.height ?? 0,
          frames: clip.durationFrames ?? 0,
        });
      });

    if (failed.length > 0) {
      throw new CommandError(
        `could not read ${failed.map((f) => `${f.path} (${f.error})`).join(', ')}`,
        'import_unreadable',
      );
    }
    return { added, skipped, binId: bin?.id ?? null, mediaCount: pool.length };
  },

  list_media: () => {
    const a = needApp('list_media');
    return {
      count: (a.project.mediaPool ?? []).length,
      media: (a.project.mediaPool ?? []).map((m) => {
        const clip = m as Record<string, unknown>;
        return {
          id: clip.id,
          name: clip.name,
          src: clip.src,
          kind: clip.kind,
          durationFrames: clip.durationFrames,
          fps: clip.fps,
          width: clip.width,
          height: clip.height,
        };
      }),
    };
  },

  // ---- edit page --------------------------------------------------------
  // The app has had split()/appendToTrack() on its API surface all along, but
  // no agent command reached them, so "cut" from the agent's side did not
  // exist at all: an unknown_command error that reads exactly like a broken
  // button. Editing is half of what a grade session needs, because you cut to
  // a clip and then grade it.
  split: ({ params }) => {
    const a = needApp('split');
    if (params.frame !== undefined) a.setPlayhead?.(Math.trunc(Number(params.frame)));
    const s = a.getState?.() as { playhead?: number; selectedTimelineClipId?: string | null } | undefined;
    const before = countClips(a);
    const ok = a.split?.() === true;
    if (!ok) {
      throw new CommandError(
        `nothing to cut at frame ${s?.playhead ?? '?'} — put the playhead inside a clip`,
        'no_clip_under_playhead',
      );
    }
    const after = countClips(a);
    return {
      playhead: s?.playhead ?? null,
      clipsBefore: before,
      clipsAfter: after,
      split: after === before + 1,
    };
  },

  append_to_track: ({ params }) => {
    const a = needApp('append_to_track');
    const state = a.getState?.() as { media?: Array<{ id: string; name?: string }> } | undefined;
    const mediaId = params.mediaId ?? state?.media?.[0]?.id;
    if (!mediaId) throw new CommandError('no media in the pool to append', 'empty_pool');
    const trackId = params.trackId ?? firstVideoTrack(a);
    if (!trackId) throw new CommandError('no video track on the timeline', 'no_track');
    const at = params.atFrame === undefined ? 0 : Math.trunc(Number(params.atFrame));
    const clip = a.appendToTrack?.(String(trackId), String(mediaId), at);
    if (!clip) throw new CommandError(`could not append ${mediaId} to ${trackId}`, 'append_failed');
    return { clip: jsonSafe(clip), clipCount: countClips(a) };
  },

  trim_to_playhead: ({ params }) => {
    const a = needApp('trim_to_playhead');
    if (params.frame !== undefined) a.setPlayhead?.(Math.trunc(Number(params.frame)));
    const ok = a.trimToPlayhead?.() === true;
    if (!ok) throw new CommandError('nothing to trim at the playhead', 'no_clip_under_playhead');
    const s = a.getState?.() as { inPoint?: number; outPoint?: number } | undefined;
    return { in: s?.inPoint ?? null, out: s?.outPoint ?? null, clips: countClips(a) };
  },

  set_clip_enabled: ({ params }) => {
    const a = needApp('set_clip_enabled');
    const s = a.getState?.() as { timelineClips?: Array<{ id: string; enabled?: boolean }> } | undefined;
    const clips = s?.timelineClips ?? [];
    const clip = params.clipId ? clips.find((c) => c.id === params.clipId) : clips.find((c) => c.enabled === false) ?? clips[0];
    if (!clip) throw new CommandError('no clip to enable or disable', 'no_clip');
    const enabled = params.enabled === undefined ? !clip.enabled : Boolean(params.enabled);
    const ok = a.setClipEnabled?.(clip.id, enabled) === true;
    if (!ok) throw new CommandError(`could not change ${clip.id}`, 'edit_failed');
    return { clipId: clip.id, enabled, clips: countClips(a) };
  },

  // ---- transport --------------------------------------------------------
  // The agent had no way to start or stop playback, only to place the playhead.
  // Scrubbing without a transport means "play" is the one thing a grading
  // session cannot do — you cannot check that a keyframe lands where you think.
  play: () => {
    const a = needApp('play');
    const started = a.play?.() === true;
    const s = a.getState?.() as { playing?: boolean; playhead?: number; durationFrames?: number } | undefined;
    if (!started) {
      throw new CommandError('playback did not start — the timeline has no range to play', 'empty_timeline');
    }
    return { playing: s?.playing ?? true, playhead: s?.playhead ?? null, durationFrames: s?.durationFrames ?? null };
  },

  pause: () => {
    const a = needApp('pause');
    a.pause?.();
    const s = a.getState?.() as { playing?: boolean; playhead?: number } | undefined;
    return { playing: s?.playing ?? false, playhead: s?.playhead ?? null };
  },

  step_playhead: ({ params }) => {
    const a = needApp('step_playhead');
    const frames = Math.trunc(Number(params.frames ?? 1));
    if (!Number.isFinite(frames) || frames === 0) {
      throw new CommandError(`frames must be a non-zero number, got ${String(params.frames)}`, 'bad_request');
    }
    a.pause?.();
    a.setPlayhead?.((a.getState?.() as { playhead?: number } | undefined)?.playhead ?? 0);
    // stepPlayhead is the app's own single-step path, so a step lands exactly
    // where the transport would put it.
    const moved = a.stepPlayhead?.(frames);
    const s = a.getState?.() as { playhead?: number } | undefined;
    return { frames, playhead: s?.playhead ?? null, stepped: moved ?? null };
  },

  set_loop: ({ params }) => {
    const a = needApp('set_loop');
    const enabled = params.enabled === undefined ? true : Boolean(params.enabled);
    a.setLoop?.(enabled);
    return { loop: enabled };
  },

  set_range: ({ params }) => {
    const a = needApp('set_range');
    const s = a.getState?.() as { inPoint?: number; outPoint?: number; durationFrames?: number } | undefined;
    if (params.in !== undefined) a.setIn?.(Math.trunc(Number(params.in)));
    if (params.out !== undefined) a.setOut?.(Math.trunc(Number(params.out)));
    const after = a.getState?.() as { inPoint?: number; outPoint?: number } | undefined;
    return {
      in: after?.inPoint ?? s?.inPoint ?? 0,
      out: after?.outPoint ?? s?.outPoint ?? 0,
      durationFrames: after?.outPoint ?? s?.durationFrames ?? 0,
    };
  },

  goto_timecode: ({ params }) => {
    const a = needApp('goto_timecode');
    const tc = String(params.timecode ?? '').trim();
    const fps = Number((a.project.timeline as { fps?: number } | undefined)?.fps ?? 24) || 24;
    const frame = parseTimecode(tc, fps);
    if (frame === null) {
      throw new CommandError(
        `could not read "${tc}" — use HH:MM:SS:FF or SS:FF (the frame rate is ${fps})`,
        'bad_timecode',
      );
    }
    a.setPlayhead?.(frame);
    const s = a.getState?.() as { playhead?: number } | undefined;
    return { timecode: tc, frame, playhead: s?.playhead ?? null, fps };
  },

  // ---- timeline -------------------------------------------------------
  list_timeline: () => {
    const a = needApp('list_timeline');
    const t = (a.project.timeline ?? {}) as Record<string, unknown>;
    const clips = (t.clips ?? []) as Record<string, unknown>[];
    return {
      fps: t.fps ?? 24,
      playhead: t.playhead ?? 0,
      durationFrames: t.durationFrames ?? 0,
      inPoint: t.inPoint ?? 0,
      outPoint: t.outPoint ?? 0,
      selection: t.selection ?? [],
      tracks: t.tracks ?? [],
      clips: clips.map((clip) => ({
        id: clip.id,
        mediaId: clip.mediaId,
        trackId: clip.trackId,
        start: clip.start,
        inFrame: clip.inFrame,
        outFrame: clip.outFrame,
        enabled: clip.enabled,
      })),
      page: a.project.page,
    };
  },

  set_playhead: ({ params }) => {
    const a = needApp('set_playhead');
    const frame = Number(params.frame);
    a.setPlayhead?.(frame);
    const t = a.project.timeline as Record<string, unknown> | undefined;
    if (t) t.playhead = frame;
    return { frame };
  },

  set_page: ({ params }) => {
    const a = needApp('set_page');
    const page = String(params.page);
    a.gotoPage?.(page);
    a.project.page = page;
    return { page };
  },

  select_clip: ({ params }) => {
    const a = needApp('select_clip');
    const id = String(params.id);
    a.selectClip?.(id);
    const t = a.project.timeline as Record<string, unknown> | undefined;
    if (t) t.selection = [id];
    const clips = (t?.clips ?? []) as { id: string }[];
    const clip = clips.find((c) => c.id === id);
    return { id, found: !!clip, selection: [id] };
  },

  // ---- node graph -----------------------------------------------------
  add_node: ({ params }) => {
    const a = needApp('add_node');
    // Only forward keys the caller actually set: passing explicit `undefined`
    // would make `'kind' in opts` true on the far side and can be read as a
    // malformed command.
    const opts: Record<string, unknown> = {};
    for (const key of ['label', 'kind', 'after'] as const) {
      if (params[key] !== undefined) opts[key] = params[key];
    }
    const created = a.addNode?.(opts);
    if (created && typeof created === 'object') {
      const node = created as NodeLike;
      return { id: node.id, label: node.label ?? null, kind: node.kind ?? null, index: node.index ?? null };
    }
    const { nodes } = timelineGraph(a);
    return { count: nodes.length, last: nodes[nodes.length - 1] ?? null, note: 'addNode returned no node; the UI owns node creation' };
  },

  remove_node: ({ params }) => {
    const a = needApp('remove_node');
    const id = String(params.id);
    const { nodes, edges, outputNodeId } = timelineGraph(a);
    const before = nodes.length;
    a.removeNode?.(id);

    // The app surface's removeNode is optional, so the graph is edited here too
    // when it is absent. connect_nodes already does this for the same reason.
    const index = nodes.findIndex((n) => n.id === id || n.label === id);
    if (index >= 0) {
      nodes.splice(index, 1);
      for (let i = edges.length - 1; i >= 0; i--) {
        if (edges[i][0] === id || edges[i][1] === id) edges.splice(i, 1);
      }
      for (const n of nodes) {
        if (Array.isArray(n.inputs)) {
          n.inputs = n.inputs.map((inp) => (inp === id ? null : inp));
        }
      }
    }
    if (outputNodeId === id) {
      const next = nodes[index] ?? nodes[nodes.length - 1];
      const graph = (a.project.settings as Record<string, unknown> | undefined)?.timelineGraph as Record<string, unknown> | undefined;
      if (graph && next) graph.outputNodeId = next.id;
    }
    if (index < 0) {
      throw new CommandError(
        `no node "${id}" to remove (have: ${nodes.map((n) => n.id).join(', ')})`,
        'no_node',
      );
    }
    render();
    return { id, removed: before - nodes.length, remaining: nodes.map((n) => n.id) };
  },

  connect_nodes: ({ params }) => {
    const a = needApp('connect_nodes');
    const from = String(params.from);
    const to = String(params.to);
    a.connectNodes?.(from, to);
    const { nodes, edges } = timelineGraph(a);
    if (!edges.some(([f, t]) => f === from && t === to)) edges.push([from, to]);
    const target = nodes.find((n) => n.id === to);
    if (target) {
      target.inputs ??= [null, null];
      target.inputs[0] = from;
    }
    return { from, to, edges: edges.length };
  },

  set_node_param: ({ params, command }) => {
    const a = needApp(command);
    const path = String(params.path);
    const value = coerceValue(params.value);
    const node = findNode(a, str(params, 'id'));

    // Read the old value BEFORE applying, or `previous` reports the value that
    // was just written and the agent can never tell what it changed.
    const grade = (node.grade ??= {});
    const before = getPath(grade, splitPath(path));

    a.setParam?.(node.id, path, value);

    // Apply locally too: setParam is optional on the surface, and the agent must
    // be able to grade even before the UI's own handlers are wired up.
    setPath(grade, path, value);
    render();
    return { id: node.id, path, value, previous: before === undefined ? null : before };
  },

  set_grade: ({ params, command }) => {
    const a = needApp(command);
    const node = findNode(a, str(params, 'id'));
    const grade = (node.grade ??= {});
    const before = jsonSafe(structuredClone(grade));
    mergeGrade(grade, params.grade);
    render();
    const after = getPath(grade, splitPathSafe(command));
    return { id: node.id, before, after, grade: jsonSafe(grade) };
  },

  keyframe: ({ params, command }) => {
    const a = needApp(command);
    const path = String(params.path);
    const frame = Number(params.frame);
    const node = findNode(a);
    const grade = (node.grade ??= {});
    const tracks = (grade.keyframes ??= {}) as Container;
    const track = (tracks[path] ??= []) as unknown[];

    const entry = { frame, value: Number(params.value), ...(str(params, 'interp') ? { interp: str(params, 'interp') } : {}) };
    const existing = (track as { frame: number }[]).findIndex((k) => k.frame === frame);
    if (existing >= 0) (track as unknown[])[existing] = entry;
    else {
      (track as unknown[]).push(entry);
      (track as unknown[]).sort((a, b) => (a as { frame: number }).frame - (b as { frame: number }).frame);
    }
    setPath(grade, path, entry.value);
    render();
    return { id: node.id, path, keyframes: track, count: track.length };
  },

  apply_lut: ({ params, command }) => {
    const a = needApp(command);
    const lut = String(params.lut);
    const intensity = num(params, 'intensity') ?? 1;
    const node = findNode(a, str(params, 'id'));
    const pipe = pipeline();
    if (pipe && typeof pipe.setLut === 'function') {
      try {
        pipe.setLut(node.id, lut, intensity);
      } catch (err) {
        throw new CommandError(`pipeline.setLut failed: ${(err as Error).message}`, 'pipeline_error');
      }
    }
    const effects = ((node.grade ??= {}).effects ??= {}) as Container;
    effects.lut = lut;
    effects.lutIntensity = intensity;
    render();
    return { id: node.id, lut, intensity };
  },

  // ---- auto balance ---------------------------------------------------
  auto_balance: async ({ params, command, progress }) => {
    const a = needApp(command);
    const node = findNode(a, str(params, 'id'));
    const method = str(params, 'method') ?? 'white-balance';

    progress(0.1, 'sampling pixels');
    const pixels = grabPixels();
    if (!pixels) {
      throw new CommandError(
        'could not read pixels from the viewer — load a clip and make sure the viewer canvas is not tainted by a cross-origin source',
        'no_pixels',
      );
    }

    const engine = await loadCpuGrade();
    if (!engine) {
      throw new CommandError(
        'the CPU grade engine (src/color/cpugrade.ts) is not available in this build, so auto_balance cannot run',
        'engine_unavailable',
      );
    }

    progress(0.5, `running ${method}`);
    const fn = method === 'neutral' ? engine.autoLevels : (engine.autoWhiteBalance ?? engine.autoLevels);
    if (typeof fn !== 'function') {
      throw new CommandError(`the CPU grade engine exposes no ${method === 'neutral' ? 'autoLevels' : 'autoWhiteBalance'} function`, 'engine_unavailable');
    }

    // autoWhiteBalance takes its method as an option; autoLevels ignores it.
    // The engine indexes pixels as RGB triples; a canvas readback is RGBA, so
    // hand it RGB — feeding RGBA misaligns every channel after the first pixel.
    const raw = fn.call(engine, toEnginePixels(pixels), { method, width: pixels.width, height: pixels.height });
    const patch = normalizeBalance(raw);

    progress(0.8, 'applying');
    const grade = (node.grade ??= {});
    mergeGrade(grade, patch);
    a.setParam?.(node.id, 'grade', grade);
    render();

    return { id: node.id, method, source: pixels.source, applied: patch, grade: jsonSafe(grade) };
  },

  // ---- analysis -------------------------------------------------------
  analyze_frame: async ({ params, progress }) => {
    const a = needApp('analyze_frame');
    const pipe = pipeline();
    if (num(params, 'frame') !== undefined) a.setPlayhead?.(Number(params.frame));
    await settleFrame();

    progress(0.3, 'reading pixels');
    const pixels = grabPixels(512);
    if (!pixels) {
      throw new CommandError('could not read pixels from the viewer (canvas missing or cross-origin tainted)', 'no_pixels');
    }

    if (pipe && typeof pipe.analyze === 'function') {
      progress(0.7, 'running pipeline analysis');
      try {
        return { source: 'pipeline.analyze', frame: num(params, 'frame') ?? null, result: jsonSafe(pipe.analyze(pixels.data)) };
      } catch {
        // Fall through to the CPU stats below rather than failing the command.
      }
    }

    progress(0.8, 'computing statistics');
    return { source: 'cpu', frame: num(params, 'frame') ?? null, ...pixelStats(pixels) };
  },

  get_scopes: async () => {
    const pipe = pipeline();
    for (const name of ['scopes', 'getScopes'] as const) {
      const fn = pipe?.[name];
      if (typeof fn === 'function') return { source: `pipeline.${name}`, scopes: jsonSafe(fn.call(pipe)) };
    }
    // No scope generator on the surface yet: derive a histogram from the frame so
    // the agent still gets numbers to reason about.
    await settleFrame();
    const pixels = grabPixels(512);
    if (!pixels) throw new CommandError('no scopes available: the pipeline exposes no scope generator and the viewer canvas is unreadable', 'no_pixels');
    return { source: 'cpu.histogram', ...pixelStats(pixels) };
  },

  read_pixel: async ({ params }) => {
    const a = needApp('read_pixel');
    if (num(params, 'frame') !== undefined) {
      a.setPlayhead?.(Number(params.frame));
      await settleFrame();
    }
    const x = Math.round(Number(params.x));
    const y = Math.round(Number(params.y));
    // maxSide 0 = full resolution, so the requested coordinate indexes the
    // real frame rather than a downscaled proxy.
    //
    // The PIPELINE is the source, not the canvas. The pipeline keeps the
    // post-output-transform image in its own display framebuffer, so a probe
    // is repeatable; the canvas path reads the default framebuffer, which GL
    // is free to clear once the frame is composited — that returned a
    // confident #000000 for a graded image. grabPixels still falls back to
    // the canvas if the pipeline has no readback at all.
    const pixels = grabPixels(0);
    if (!pixels) throw new CommandError('could not read pixels from the viewer', 'no_pixels');

    const index = (y * pixels.width + x) * 4;
    if (index < 0 || index + 3 >= pixels.data.length) {
      throw new CommandError(`(${x}, ${y}) is outside the ${pixels.width}x${pixels.height} frame`, 'out_of_range');
    }
    const [r, g, b, alpha] = Array.from(pixels.data.slice(index, index + 4));
    // The pipeline's readback is display-referred 0..1; the canvas fallback is
    // 0..255 bytes. `toUnit` already normalises, and the hex must be built from
    // the NORMALISED value — reading raw floats through toString(16) produced
    // "#000.defcd0.48a009" for a perfectly ordinary mid-tone.
    const toUnit = (v: number) => (pixels.data instanceof Float32Array ? v : v / 255);
    const rgba = [toUnit(r), toUnit(g), toUnit(b), toUnit(alpha)];
    const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
    return {
      x,
      y,
      frame: num(params, 'frame') ?? null,
      source: pixels.source,
      rgba,
      raw: [r, g, b, alpha],
      hex: `#${rgba.slice(0, 3).map((v) => byte(v).toString(16).padStart(2, '0')).join('')}`,
    };
  },

  // ---- export ---------------------------------------------------------
  export_frame: async ({ params, progress }) => {
    const a = needApp('export_frame');
    const frame = num(params, 'frame');
    if (frame !== undefined) {
      a.setPlayhead?.(frame);
      render();
    }
    progress(0.4, 'capturing canvas');
    const canvas = findViewerCanvas();
    if (!canvas) throw new CommandError('no viewer canvas found to export', 'no_canvas');
    const blob = await canvasBlob(canvas);
    const path = str(params, 'path') ?? `frames/frame-${String(frame ?? (a.project.timeline as Record<string, unknown> | undefined)?.playhead ?? 0).padStart(6, '0')}.png`;
    progress(0.8, 'writing');
    const written = await upload(path, blob);
    return { ...written, frame: frame ?? null, type: 'image/png' };
  },

  export_video: async ({ params, progress }) => {
    const a = needApp('export_video');
    const pipe = pipeline();
    if (typeof VideoEncoder === 'undefined') {
      throw new CommandError('WebCodecs VideoEncoder is unavailable, so export_video cannot run', 'unsupported');
    }
    if (!pipe || typeof pipe.readPixels !== 'function') {
      throw new CommandError('the pipeline exposes no frame readback, so frames cannot be exported', 'no_readback');
    }

    const timeline = a.project.timeline as Record<string, unknown> | undefined;
    const fps = Number(timeline?.fps ?? 24) || 24;
    const startFrame = Number(timeline?.inPoint ?? 0);
    const endFrame = Number(timeline?.outPoint ?? timeline?.durationFrames ?? 0);
    if (!(endFrame > startFrame)) {
      throw new CommandError('the timeline has no range to export — add a clip and set in/out points first', 'empty_timeline');
    }

    // Frame-accurate WebCodecs export.
    //
    // This used to drive canvas.captureStream() into a MediaRecorder, which was
    // wrong four ways: Chrome has no 'avc' MediaRecorder type, so the command
    // failed outright for H.264; capture is real-time, so a ten minute timeline
    // took ten minutes; sampling the canvas at wall-clock rate is not
    // frame-accurate; and a WebGL canvas without preserveDrawingBuffer reads
    // back blank. Reading the pipeline's own display buffer and encoding
    // explicit frames fixes all four and makes scrub-then-export exact.
    const wanted = (str(params, 'codec') ?? 'avc').toLowerCase();
    const CODECS: Record<string, { muxer: 'avc' | 'vp9' | 'av1'; encoder: string; label: string }> = {
      avc: { muxer: 'avc', encoder: 'avc1.42001f', label: 'H.264' },
      h264: { muxer: 'avc', encoder: 'avc1.42001f', label: 'H.264' },
      'h.264': { muxer: 'avc', encoder: 'avc1.42001f', label: 'H.264' },
      vp9: { muxer: 'vp9', encoder: 'vp09.00.10.08', label: 'VP9' },
      av1: { muxer: 'av1', encoder: 'av01.0.04M.08', label: 'AV1' },
    };
    if (/webm/i.test(wanted)) {
      throw new CommandError('WebM output is not wired up; use avc, vp9 or av1 (MP4 container)', 'unsupported_codec');
    }
    const pick = CODECS[wanted];
    if (!pick) {
      throw new CommandError(`unsupported codec "${wanted}" — use avc, vp9 or av1 (output is MP4)`, 'unsupported_codec');
    }

    const w = Number(pipe.width) || 0;
    const h = Number(pipe.height) || 0;
    if (!(w > 0 && h > 0)) {
      throw new CommandError('the pipeline has no render targets — load a clip before exporting', 'no_frame');
    }
    // avc requires even dimensions; a 241px-tall frame is a config error that
    // otherwise surfaces as an opaque encoder failure much later.
    const encW = w % 2 === 0 ? w : w - 1;
    const encH = h % 2 === 0 ? h : h - 1;

    const config: VideoEncoderConfig = {
      codec: pick.encoder,
      width: encW,
      height: encH,
      bitrate: 8_000_000,
      framerate: fps,
    };
    if (pick.muxer === 'avc') {
      (config as VideoEncoderConfig & { avc: { format: string } }).avc = { format: 'avc' };
    }

    const support = await VideoEncoder.isConfigSupported(config).catch(() => null);
    if (!support?.supported) {
      throw new CommandError(`this browser cannot encode ${pick.label} at ${encW}x${encH}`, 'unsupported_codec');
    }

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: pick.muxer, width: encW, height: encH, frameRate: fps },
      fastStart: 'in-memory',
    });

    let encodeError: Error | null = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encodeError = e instanceof Error ? e : new Error(String(e)); },
    });
    encoder.configure(config);

    const wasPlaying = (a.getState?.() as { playing?: boolean } | undefined)?.playing === true;
    a.pause?.();
    const total = endFrame - startFrame;
    const scratch = document.createElement('canvas');
    scratch.width = encW;
    scratch.height = encH;
    const ctx = scratch.getContext('2d');
    if (!ctx) throw new CommandError('no 2d context available to assemble frames', 'no_canvas');

    try {
      for (let f = startFrame; f < endFrame; f++) {
        if (encodeError) throw encodeError;
        a.setPlayhead?.(f);
        await settleFrame();

        // Read the graded output straight out of the pipeline's display buffer.
        const raw = pipe.readPixels(0, 0, encW, encH) as ArrayLike<number> | null;
        if (!raw || raw.length < encW * encH * 4) {
          throw new CommandError(`frame ${f}: pipeline readback returned ${raw?.length ?? 0} floats`, 'short_read');
        }
        const img = new ImageData(encW, encH);
        const dst = img.data;
        for (let i = 0, n = encW * encH * 4; i < n; i++) {
          const v = raw[i] ?? 0;
          // Display-referred 0..1 floats. This is the first point where
          // clamping is correct, so it happens here and nowhere else.
          dst[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
        }
        ctx.putImageData(img, 0, 0);

        const timestamp = Math.round(((f - startFrame) * 1e6) / fps);
        const duration = Math.round(1e6 / fps);
        const frame = new VideoFrame(scratch, { timestamp, duration });
        encoder.encode(frame, { keyFrame: (f - startFrame) % Math.max(1, Math.round(fps * 2)) === 0 });
        frame.close();

        // Backpressure: without this a long timeline grows the queue until the
        // tab runs out of memory.
        let guard = 0;
        while (encoder.encodeQueueSize > 8 && guard++ < 1000) {
          await new Promise<void>((r) => encoder.addEventListener('dequeue', () => r(), { once: true }));
        }
        progress((f - startFrame + 1) / total, `frame ${f - startFrame + 1}/${total}`);
      }

      progress(0.97, 'flushing encoder');
      await encoder.flush();
      if (encodeError) throw encodeError;
      encoder.close();
      muxer.finalize();
    } catch (err) {
      try { if (encoder.state !== 'closed') encoder.close(); } catch { /* already closed */ }
      throw err instanceof CommandError
        ? err
        : new CommandError(err instanceof Error ? err.message : String(err), 'encode_failed');
    } finally {
      if (wasPlaying) a.play?.();
    }

    const bytes = new Uint8Array(muxer.target.buffer);
    const blob = new Blob([bytes], { type: 'video/mp4' });
    const outPath = str(params, 'path') ?? `export/grade-${pick.muxer}.mp4`;
    const written = await upload(outPath, blob);
    return {
      ...written,
      frames: total,
      fps,
      width: encW,
      height: encH,
      codec: pick.label,
      container: 'mp4',
    };
  },

  screenshot: async ({ params, progress }) => {
    progress(0.3, 'serialising document');
    // No html2canvas dependency: the SVG foreignObject trick renders the live DOM
    // into a canvas. WebGL canvases come out blank, so they are rasterised first.
    const width = Math.ceil(document.documentElement.scrollWidth || window.innerWidth);
    const height = Math.ceil(document.documentElement.scrollHeight || window.innerHeight);
    const snapshot = await renderDomToCanvas(width, height);
    const blob = await canvasBlob(snapshot);
    progress(0.85, 'writing');
    const written = await upload(str(params, 'path') ?? 'screens/ui.png', blob);
    return { ...written, width, height, type: 'image/png' };
  },

  save_project: async ({ params, progress }) => {
    const a = needApp('save_project');
    const saved = a.saveProject?.(str(params, 'path'));
    progress(0.6, 'serialising project');
    const json = JSON.stringify(jsonSafe(a.project), null, 2);
    const written = await upload(str(params, 'path') ?? 'project.json', json, 'utf8');
    return { ...written, bytesWritten: json.length, saved: saved ?? null };
  },

  // ---- history --------------------------------------------------------
  undo: () => {
    const a = needApp('undo');
    a.undo?.();
    return { undo: true, state: stateSummary() };
  },

  redo: () => {
    const a = needApp('redo');
    a.redo?.();
    return { redo: true, state: stateSummary() };
  },

  // ---- bridge introspection -------------------------------------------
  agent_env: () => ({
    clientId: CLIENT_ID,
    server: ORIGIN,
    transport: 'longpoll',
    capabilities: capabilities(),
    commands: [...COMMAND_NAMES],
  }),

  agent_commands: () => ({ commands: [...COMMAND_NAMES], bridge: [...BRIDGE_COMMAND_NAMES] }),
};

/** set_grade wants a "what changed" summary without demanding a path param. */
function splitPathSafe(command: string): string[] {
  return command === 'set_grade' ? ['primary'] : [];
}

// ---------------------------------------------------------------------------
// Rendering / state helpers
// ---------------------------------------------------------------------------

/**
 * Let the app's own render loop produce a fresh frame.
 *
 * Do NOT call `pipeline.render()` here. The app owns the render loop; the
 * pipeline's render() requires a graph, a source and a size, and calling it
 * with none of them tore down the real render targets and replaced them with
 * 1x1 — which broke the viewer, every later pixel read and the scopes. Waiting
 * for two animation frames gets a fully rendered, correctly sized frame and
 * keeps the pipeline owned by exactly one caller.
 */
function render(): void {
  // Yield to the event loop. The app's rAF loop owns rendering, so a macrotask
  // boundary is enough for a fresh frame to be produced before the caller reads
  // pixels. Nothing here may call pipeline.render() — see the note above.
  queueMicrotask(() => { /* let the frame loop run */ });
}

/** Await two painted frames, for callers that must read the result. */
function settleFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function stateSummary(): unknown {
  const a = app();
  if (!a) return null;
  if (typeof a.getState === 'function') {
    try {
      return jsonSafe(a.getState());
    } catch {
      /* fall through to a structural summary */
    }
  }
  const { nodes } = timelineGraph(a);
  const timeline = (a.project.timeline ?? {}) as Record<string, unknown>;
  return {
    page: a.project.page,
    playhead: timeline.playhead,
    fps: timeline.fps,
    mediaCount: (a.project.mediaPool ?? []).length,
    clipCount: ((timeline.clips ?? []) as unknown[]).length,
    nodeCount: nodes.length,
    nodeIds: nodes.map((n) => n.id),
  };
}

function pixelStats(pixels: PixelSource): Record<string, unknown> {
  const { data } = pixels;
  const count = Math.floor(data.length / 4);
  if (count === 0) return { width: pixels.width, height: pixels.height };

  const isFloat = data instanceof Float32Array;
  const scale = isFloat ? 1 : 1 / 255;
  let sr = 0, sg = 0, sb = 0, sl = 0, sl2 = 0;
  let min = Infinity, max = -Infinity;
  const BINS = 64;
  const hist = new Float64Array(BINS);
  let clippedLow = 0, clippedHigh = 0;

  for (let i = 0; i < count; i++) {
    const r = data[i * 4] * scale;
    const g = data[i * 4 + 1] * scale;
    const b = data[i * 4 + 2] * scale;
    sr += r; sg += g; sb += b;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sl += luma;
    sl2 += luma * luma;
    if (luma < min) min = luma;
    if (luma > max) max = luma;
    const bin = Math.min(BINS - 1, Math.max(0, Math.floor(luma * BINS)));
    hist[bin] += 1;
    if (isFloat && (r <= 0 || g <= 0 || b <= 0)) clippedLow++;
    if (!isFloat && (data[i * 4] === 0 || data[i * 4 + 1] === 0 || data[i * 4 + 2] === 0)) clippedLow++;
    if (luma >= 0.999) clippedHigh++;
  }

  const meanLuma = sl / count;
  return {
    width: pixels.width,
    height: pixels.height,
    pixels: count,
    pixelSource: pixels.source,
    mean: [sr / count, sg / count, sb / count],
    luma: { min, max, mean: meanLuma, stdDev: Math.sqrt(Math.max(0, sl2 / count - meanLuma * meanLuma)) },
    clipped: { low: clippedLow / count, high: clippedHigh / count },
    histogram: { bins: BINS, luma: Array.from(hist, (v) => v / count) },
  };
}

async function renderDomToCanvas(width: number, height: number): Promise<HTMLCanvasElement> {
  const clone = document.documentElement.cloneNode(true) as HTMLElement;

  // Rasterise canvases up front: a WebGL drawing buffer cannot be serialised
  // into the SVG, so it shows up empty in the snapshot.
  const originals = Array.from(document.querySelectorAll('canvas'));
  const clonedCanvases = Array.from(clone.querySelectorAll('canvas'));
  for (let i = 0; i < originals.length && i < clonedCanvases.length; i++) {
    try {
      const dataUrl = originals[i].toDataURL('image/png');
      const img = document.createElement('img');
      img.setAttribute('src', dataUrl);
      img.setAttribute('width', String(originals[i].width));
      img.setAttribute('height', String(originals[i].height));
      const style = getComputedStyle(originals[i]);
      img.setAttribute('style', `position:absolute;left:${style.left};top:${style.top};width:${style.width};height:${style.height}`);
      clonedCanvases[i].replaceWith(img);
    } catch {
      // Tainted canvas: leave the placeholder, it is better than aborting.
    }
  }

  const styles = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
    .map((el) => el.outerHTML)
    .join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <foreignObject width="100%" height="100%">
      <div xmlns="http://www.w3.org/1999/xhtml"><style>${styles}</style>${clone.outerHTML}</div>
    </foreignObject>
  </svg>`;

  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = await new Promise<HTMLImageElement>((resolvePromise, reject) => {
      const img = new Image();
      img.onload = () => resolvePromise(img);
      img.onerror = () => reject(new CommandError('could not rasterise the DOM (foreignObject rendering failed)', 'screenshot_failed'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new CommandError('no 2d context available for the screenshot', 'screenshot_failed');
    ctx.drawImage(image, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

async function emit(event: AgentEvent): Promise<void> {
  try {
    await fetch(`${ORIGIN}/client/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
  } catch {
    // Events are observability, not results: a dropped progress tick must never
    // fail the command it describes.
  }
}

const EVENT_BATCH_WINDOW_MS = 120;

function makeEmitters(request: AgentRequest): Pick<Ctx, 'progress' | 'log'> {
  const queue: AgentEvent[] = [];
  let flushTimer: number | null = null;

  const flush = () => {
    flushTimer = null;
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    void emit(batch.length === 1 ? batch[0] : (batch as unknown as AgentEvent));
  };

  return {
    progress(value, note, total) {
      queue.push({
        type: 'progress',
        // Clamped so a consumer never sees value > 1 from a divide-by-zero.
        value: Math.max(0, Math.min(1, value)),
        ...(note ? { note } : {}),
        ...(total !== undefined ? { total } : {}),
        ts: Date.now(),
        id: request.id,
        command: request.command,
      });
      if (flushTimer === null) flushTimer = setTimeout(flush, EVENT_BATCH_WINDOW_MS) as unknown as number;
    },
    log(level, message) {
      queue.push({ type: 'log', level, message, ts: Date.now(), id: request.id, command: request.command });
      if (flushTimer === null) flushTimer = setTimeout(flush, EVENT_BATCH_WINDOW_MS) as unknown as number;
    },
  };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

let stateEventTimer: number | null = null;
function scheduleStateEvent(): void {
  // Debounced: a 40-command batch should emit one state event, not forty.
  if (stateEventTimer !== null) clearTimeout(stateEventTimer);
  stateEventTimer = setTimeout(() => {
    stateEventTimer = null;
    void emit({ type: 'state', state: stateSummary(), ts: Date.now() });
  }, 250) as unknown as number;
}

const MUTATING = new Set([
  'set_playhead', 'set_page', 'select_clip', 'add_node', 'remove_node', 'connect_nodes',
  'set_node_param', 'set_grade', 'keyframe', 'apply_lut', 'auto_balance', 'undo', 'redo',
]);

/**
 * The one entry point. Every command path — socket, CLI, UI button — funnels
 * through here, so behaviour cannot diverge between them.
 */
export async function execute(command: string, params?: unknown): Promise<unknown> {
  if (!isCommand(command)) {
    throw new CommandError(`unknown command "${command}". Known: ${COMMAND_NAMES.join(', ')}`, 'unknown_command');
  }
  const checked = validate(command, params);
  const handler = HANDLERS[command];
  if (!handler) throw new CommandError(`command "${command}" has no handler`, 'unimplemented');

  const request: AgentRequest = { id: `local-${Date.now().toString(36)}`, command };
  const emitters = makeEmitters(request);
  return handler({ command, params: checked, request, ...emitters });
}

/** Never throws: turns any failure into a well-formed AgentResponse. */
export async function handleRequest(request: AgentRequest): Promise<AgentResponse> {
  const started = performance.now();
  const emitters = makeEmitters(request);
  try {
    const checked = validate(request.command, request.params);
    const handler = HANDLERS[request.command];
    if (!handler) throw new CommandError(`command "${request.command}" has no handler`, 'unimplemented');

    const result = await handler({ command: request.command, params: checked, request, ...emitters });
    const ms = performance.now() - started;
    logLine('ok', `${request.command} ${ms.toFixed(0)}ms`);
    if (MUTATING.has(request.command)) scheduleStateEvent();
    return { id: request.id, ok: true, result: jsonSafe(result), ms };
  } catch (err) {
    const ms = performance.now() - started;
    const isCommandError = err instanceof CommandError;
    const error = {
      message: (err as Error)?.message ?? String(err),
      code: isCommandError ? err.code : 'internal',
      ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
    };
    // The stack goes to the log, not to the agent: an agent needs to know *what*
    // failed, and a stack trace is noise in a grading loop.
    logLine('error', `${request.command} failed: ${error.message}`);
    return { id: request.id, ok: false, error, ms };
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

let socket: WebSocket | null = null;
let polling = false;
let stopped = false;
let backoff = 500;

async function announce(): Promise<void> {
  const hello: ClientHello = {
    clientId: CLIENT_ID,
    url: location.href,
    userAgent: navigator.userAgent,
    commands: COMMAND_NAMES,
    capabilities: capabilities(),
  };
  try {
    await fetch(`${ORIGIN}/client/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hello),
    });
  } catch {
    // The poll loop will retry; the server also learns about us on first poll.
  }
}

function startWebSocket(): void {
  try {
    const ws = new WebSocket(`${ORIGIN.replace(/^http/, 'ws')}/ws`);
    ws.onopen = () => {
      backoff = 500;
      logLine('info', 'websocket transport connected');
    };
    ws.onmessage = (event) => {
      let frame: Envelope | null = null;
      try {
        frame = JSON.parse(String(event.data)) as Envelope;
      } catch {
        return;
      }
      if (frame.kind !== 'request') return;
      const request = frame.payload as AgentRequest;
      void handleRequest(request).then((response) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ v: 1, kind: 'response', id: response.id, payload: response }));
        }
      });
    };
    ws.onclose = () => {
      socket = null;
      if (!stopped) scheduleReconnect();
    };
    ws.onerror = () => ws.close();
    socket = ws;
  } catch {
    socket = null;
    scheduleReconnect();
  }
}

async function pollOnce(): Promise<void> {
  const res = await fetch(`${ORIGIN}/client/poll?client=${encodeURIComponent(CLIENT_ID)}&wait=25000`, {
    headers: { 'x-hermes-client': CLIENT_ID },
  });
  if (res.status === 204) return;
  if (!res.ok) throw new Error(`poll failed: HTTP ${res.status}`);

  const body = (await res.json()) as { kind?: string; requests?: AgentRequest[] };
  if (body.kind === 'bye') throw new Error('server shutting down');
  const requests = body.requests ?? [];
  if (requests.length === 0) return;

  const responses: AgentResponse[] = [];
  // Sequential: commands mutate shared project state, so interleaving a batch
  // would make results depend on scheduling.
  for (const request of requests) {
    responses.push(await handleRequest(request));
  }
  await fetch(`${ORIGIN}/client/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(responses),
  });
  backoff = 500;
}

function scheduleReconnect(): void {
  if (stopped || polling) return;
  // Exponential with a 15s ceiling: a laptop waking from sleep should reconnect
  // promptly, a dead server should not be hammered.
  const delay = backoff + Math.random() * 250;
  backoff = Math.min(15_000, backoff * 2);
  setTimeout(connect, delay);
}

async function connect(): Promise<void> {
  // Warm the CPU grade engine now. Left cold, the first auto_balance pays for
  // the chunk fetch inside the command's own timeout, so a single command
  // intermittently reported "engine not available" and the next one succeeded.
  void loadCpuGrade().catch(() => { /* reported per command instead */ });

  if (stopped || polling || socket) return;
  polling = true;
  try {
    await announce();
    const health = await fetch(`${ORIGIN}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (health?.transport === 'ws') {
      polling = false;
      startWebSocket();
      return;
    }
    if (health?.ok) {
      logThrottled('info', `agent bridge connected (${ORIGIN}, ${health.clients} client(s))`);
    }
    while (!stopped) {
      try {
        await pollOnce();
      } catch (err) {
        logThrottled('warn', `agent bridge offline: ${(err as Error).message} — retrying in ${Math.round(backoff / 1000)}s`);
        break;
      }
    }
  } finally {
    polling = false;
  }
  if (!stopped) scheduleReconnect();
}

export function start(): void {
  stopped = false;
  if (socket || polling) return;
  logLine('info', `agent client starting (${ORIGIN})`);
  void connect();
}

export function stop(): void {
  stopped = true;
  socket?.close();
  socket = null;
  logLine('info', 'agent client stopped');
}

/** Exposed for the UI console and for tests. */
export const agentClient = {
  execute,
  start,
  stop,
  state: stateSummary,
  capabilities,
  commands: COMMAND_NAMES,
  get connected(): boolean {
    return !!socket || polling;
  },
};

// Auto-start on import: the bridge is the point of the app, and making the
// developer remember to wire it up is how it silently stops working.
if (typeof window !== 'undefined') {
  queueMicrotask(() => start());
}
