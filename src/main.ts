/**
 * hermes-resolve — UI shell bootstrap.
 *
 * Two rules shape this file:
 *
 *  1. Static chrome (every id / data-* another workstream targets) lives in
 *     index.html so it exists before a single module executes — the agent and
 *     the tests can query it on any frame. main.ts only materialises DOM that
 *     *depends on state* (bins, clip cards, tracks, node chips, palette), and
 *     it does that through one small declarative helper (`h`).
 *
 *  2. `window.__resolve` must be drivable headlessly: every entry point is a
 *     plain function over project state, never a reaction to a DOM event, and
 *     the global is published synchronously at module evaluation time so a
 *     caller never has to wait for WebGL, media decode or the rAF loop.
 */

import type {
  Bin,
  Graph,
  GradeState,
  MediaClip,
  // Aliased: the NLE's Node shadows the DOM's Node global otherwise.
  Node as GraphNode,
  NodeKind,
  PageId,
  Project,
  RGB,
  ScopeData,
  TimelineClip,
  Track,
} from './core/types.js';
import { createNode, defaultGrade, defaultGraph } from './core/defaults.js';
import './ui/styles.css';

// Side-effect import: the agent bridge auto-starts on evaluation and resolves
// the app through `window.__resolve`. Without this import the bundler drops the
// whole module and the bridge silently never connects — the server would be
// healthy and every RPC would time out.
import './agent/client.js';

// ===========================================================================
// Pipeline adapter
// ---------------------------------------------------------------------------
// src/gpu/pipeline.ts is owned by another workstream. We do not block on it:
// the module is loaded through a build-time glob, so this file compiles and
// `vite build` succeeds whether or not that file exists yet, and the real
// ColorPipeline is picked up automatically once it lands. Everything here goes
// through the narrow structural type below, so our call sites stay valid no
// matter how the concrete class evolves.
// ===========================================================================

/** Anything the pipeline can upload as a texture source. */
export type PipelineSource =
  | HTMLVideoElement
  | HTMLImageElement
  | HTMLCanvasElement
  | ImageBitmap
  | null;

export interface ColorPipelineLike {
  /**
   * The whole chain. NOTE: render() resolves per-node keyframes itself, so the
   * UI must never pre-resolve a Graph into a grade and hand that over.
   */
  render(
    graph: Graph,
    source: PipelineSource,
    width: number,
    height: number,
    frame: number,
  ): void;
  setLut?(lut: unknown): void;
  resolveKeyframes?(grade: GradeState, frame: number): GradeState;
  /**
   * Picture flip / mirror, applied at the display stage. Optional so the
   * NullPipeline fallback and any test double stay valid: a stub that cannot
   * flip simply reports false and the buttons reflect that.
   */
  setUserFlip?(x: boolean, y?: boolean): void;
  getUserFlip?(): { x: boolean; y: boolean };
  /** Rect readback in pixels; returns RGBA floats. */
  readPixels?(x: number, y: number, w: number, h: number): ArrayLike<number> | null;
  analyze?(): ScopeData | null;
  resize?(width: number, height: number): void;
  /** 'float32' | 'float16' | 'byte' — surfaced in the status bar. */
  precision?: string | (() => string);
  dispose?(): void;
}

type PipelineCtor = new (gl: WebGL2RenderingContext) => ColorPipelineLike;

interface PipelineModule {
  ColorPipeline?: PipelineCtor;
  default?: PipelineCtor;
}

/**
 * Stand-in so the viewer still composites (and the scope canvases still draw)
 * on machines/contexts where the GPU module is absent or WebGL2 is blocked.
 * Identity by construction: nothing is invented, it just shows the frame.
 */
class NullPipeline implements ColorPipelineLike {
  precision = 'cpu-fallback';
  constructor(private readonly ctx: CanvasRenderingContext2D) {}
  render(
    _graph: Graph,
    source: PipelineSource,
    width: number,
    height: number,
    _frame: number,
  ): void {
    const { ctx } = this;
    if (this.ctx.canvas.width !== width || this.ctx.canvas.height !== height) {
      this.ctx.canvas.width = width;
      this.ctx.canvas.height = height;
    }
    ctx.fillStyle = '#0b0b0b';
    ctx.fillRect(0, 0, width, height);
    // Any CanvasImageSource can be blitted: stills and decoded frames alike.
    if (source && typeof source === 'object' && 'naturalWidth' in source) {
      try {
        ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
      } catch {
        /* not decodable yet — keep the black field */
      }
    }
  }
}

// ===========================================================================
// Small declarative DOM helper
// ===========================================================================

type Child = Node | string | number | null | undefined | false;

interface Props {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  style?: Partial<CSSStyleDeclaration> | Record<string, string>;
  dataset?: Record<string, string | number | boolean | undefined>;
  attrs?: Record<string, string | number | boolean | undefined>;
  on?: Record<string, (ev: Event) => void>;
  [key: string]: unknown;
}

/** Create an element. Arrays of children are appended in order. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k === 'style') {
      const s = el.style as unknown as Record<string, unknown>;
      for (const [p, pv] of Object.entries(v as Record<string, string>)) s[p] = pv;
    } else if (k === 'dataset') {
      for (const [p, pv] of Object.entries(v as Record<string, unknown>)) {
        if (pv === undefined || pv === null || pv === false) continue;
        el.dataset[p] = String(pv);
      }
    } else if (k === 'attrs') {
      for (const [p, pv] of Object.entries(v as Record<string, unknown>)) {
        if (pv === undefined || pv === null || pv === false) continue;
        el.setAttribute(p, String(pv));
      }
    } else if (k === 'on') {
      for (const [evt, fn] of Object.entries(v as Record<string, (e: Event) => void>)) {
        el.addEventListener(evt, fn);
      }
    } else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(4) as Child[]) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

function q<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`[resolve] required element missing: ${sel}`);
  return el;
}

function qsa<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

/** Throwing lookup is right for the skeleton, forgiving for generated nodes. */
function qo<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(sel);
}

// ===========================================================================
// State
// ===========================================================================

const PAGES: PageId[] = ['media', 'cut', 'edit', 'fusion', 'color', 'fairlight', 'deliver'];
const PAGE_LABEL: Record<PageId, string> = {
  media: 'Media', cut: 'Cut', edit: 'Edit', fusion: 'Fusion',
  color: 'Color', fairlight: 'Fairlight', deliver: 'Deliver',
};

const DEFAULT_FPS = 24;
const UNDO_LIMIT = 60;
const NODE_PALETTE: NodeKind[] = ['serial', 'parallel', 'corrector', 'key', 'note', 'group'];

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultTracks(): Track[] {
  return [
    { id: 'v2', kind: 'video', index: 1, name: 'V2', locked: false, muted: false, height: 34 },
    { id: 'v1', kind: 'video', index: 2, name: 'V1', locked: false, muted: false, height: 34 },
    { id: 'a1', kind: 'audio', index: 3, name: 'A1', locked: false, muted: false, height: 34 },
    { id: 'a2', kind: 'audio', index: 4, name: 'A2', locked: false, muted: false, height: 34 },
  ];
}

function createProject(): Project {
  return {
    id: newId('proj'),
    settings: {
      name: 'Untitled Project',
      workingSpace: 'timeline-linear',
      outputSpace: 'Rec.709',
      outputGamma: 2.4,
      timelineGraph: defaultGraph(),
      clipGraphs: {},
      autoSave: true,
    },
    mediaPool: [],
    timeline: {
      fps: DEFAULT_FPS,
      durationFrames: 0,
      startFrame: 0,
      tracks: defaultTracks(),
      clips: [],
      playhead: 0,
      inPoint: 0,
      outPoint: 0,
      selection: [],
    },
    page: 'color',
    bins: [{ id: 'bin-master', name: 'Master', parent: null, clipIds: [] }],
    version: 1,
  };
}

const project: Project = createProject();

const state = {
  activeBinId: 'bin-master',
  selectedClipId: null as string | null,
  selectedNodeId: project.settings.timelineGraph.nodes[0]?.id ?? null,
  selectedTimelineClipId: null as string | null,
  playing: false,
  zoom: 72, // pixels per second of timeline
  fps: 0,
  precision: '—',
  loop: true,
  guides: false,
  panelsVisible: { scopes: true, nodes: true, panels: true } as Record<string, boolean>,
  mediaView: 'grid' as 'grid' | 'list',
};

// ===========================================================================
// Undo / redo — snapshot the mutable grade surface only
// ===========================================================================

interface Snapshot {
  graph: Graph;
  page: PageId;
  selection: string[];
  bins: Bin[];
  mediaIds: string[];
  clipGraphs: Record<string, Graph>;
  /**
   * The whole timeline, not just the selection.
   *
   * This was missing, which meant undo could not undo a single edit: split,
   * ripple delete, lift, insert, duplicate, move, trim and add-track all pushed
   * an entry that restored the grade graph and left the timeline exactly as it
   * was. Pressing undo printed "undo ok" and the cut stayed. An undo that
   * reports success while changing nothing is worse than no undo at all.
   */
  timeline: {
    tracks: Track[];
    clips: TimelineClip[];
    durationFrames: number;
    startFrame: number;
    playhead: number;
    inPoint: number;
    outPoint: number;
    selection: string[];
    fps: number;
  };
}

const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];

function snap(): Snapshot {
  const tl = project.timeline;
  return structuredClone({
    graph: project.settings.timelineGraph,
    page: project.page,
    selection: tl.selection,
    bins: project.bins,
    mediaIds: project.mediaPool.map((m) => m.id),
    clipGraphs: project.settings.clipGraphs,
    timeline: {
      tracks: tl.tracks,
      clips: tl.clips,
      durationFrames: tl.durationFrames,
      startFrame: tl.startFrame,
      playhead: tl.playhead,
      inPoint: tl.inPoint,
      outPoint: tl.outPoint,
      selection: tl.selection,
      fps: tl.fps,
    },
  });
}

/**
 * Bin membership is a view over the media pool, not independent state: every
 * pooled clip must be reachable from exactly one bin. Undo restores a bin list
 * that may predate an import, so reconcile it against the pool rather than
 * letting the two drift apart and orphan a clip.
 */
function reconcileBins(bins: Bin[]): void {
  const pooled = new Set(project.mediaPool.map((m) => m.id));
  for (const bin of bins) {
    bin.clipIds = bin.clipIds.filter((id) => pooled.has(id));
  }
  const assigned = new Set(bins.flatMap((b) => b.clipIds));
  const orphans = project.mediaPool.filter((m) => !assigned.has(m.id)).map((m) => m.id);
  if (orphans.length > 0) {
    const master = bins.find((b) => b.parent === null) ?? bins[0];
    if (master) master.clipIds.push(...orphans);
  }
}

function applySnapshot(s: Snapshot): void {
  project.settings.timelineGraph = s.graph;
  project.page = s.page;
  project.timeline.selection = s.selection;
  project.bins = s.bins;
  reconcileBins(project.bins);
  project.settings.clipGraphs = s.clipGraphs;
  // Restore the timeline in place rather than replacing the object: the
  // timeline is captured by reference in a few places (transport state, the
  // clip under the playhead), and swapping the object out from under them
  // leaves stale references pointing at the pre-undo edit.
  const tl = project.timeline;
  tl.tracks = s.timeline.tracks;
  tl.clips = s.timeline.clips;
  tl.durationFrames = s.timeline.durationFrames;
  tl.startFrame = s.timeline.startFrame;
  tl.playhead = s.timeline.playhead;
  tl.inPoint = s.timeline.inPoint;
  tl.outPoint = s.timeline.outPoint;
  tl.selection = s.timeline.selection;
  tl.fps = s.timeline.fps;
  // A clip that undo brought back may no longer be the one that was selected.
  state.selectedTimelineClipId = tl.selection[0] ?? null;
  state.selectedNodeId = project.settings.timelineGraph.nodes[0]?.id ?? null;
  gotoPage(project.page, { silent: true });
  syncAll();
}

/** Every mutation funnels through here so undo coverage can't drift. */
function mutate(label: string, fn: () => void): void {
  undoStack.push(snap());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  fn();
  project.version += 1;
  log(`${label}`, 'cmd');
  syncAll();
}

function undo(): boolean {
  const s = undoStack.pop();
  if (!s) return false;
  redoStack.push(snap());
  applySnapshot(s);
  log('undo', 'ok');
  return true;
}

function redo(): boolean {
  const s = redoStack.pop();
  if (!s) return false;
  undoStack.push(snap());
  applySnapshot(s);
  log('redo', 'ok');
  return true;
}

// ===========================================================================
// Node / grade access
// ===========================================================================

function graph(): Graph {
  return project.settings.timelineGraph;
}

function findNode(id?: string | null): GraphNode | null {
  const g = graph();
  if (id) return g.nodes.find((n) => n.id === id) ?? null;
  return g.nodes.find((n) => n.id === state.selectedNodeId) ?? g.nodes[0] ?? null;
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Write at a dotted path, creating intermediate objects. */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i]!;
    const next = cur[k];
    if (next === null || typeof next !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

function isRgb(v: unknown): v is RGB {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');
}

function clampNum(v: number, lo?: number, hi?: number): number {
  if (lo !== undefined && Number.isFinite(lo) && v < lo) return lo;
  if (hi !== undefined && Number.isFinite(hi) && v > hi) return hi;
  return v;
}

/** min/max/step live on the bound control, so HTML is the single source of truth. */
function limitsFor(path: string): { lo?: number; hi?: number } {
  const el = qo<HTMLInputElement>(`[data-bind="${cssEscape(path)}"][data-control="slider"]`);
  if (!el) return {};
  const lo = el.min === '' ? undefined : Number(el.min);
  const hi = el.max === '' ? undefined : Number(el.max);
  return { lo, hi };
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

/**
 * Set one grade parameter by dotted path on a node.
 * Number into an RGB path writes channel 0; use `primary.lift.1` to target a
 * specific channel. Unknown paths are created rather than rejected, so the
 * agent can set a parameter before a control for it exists.
 */
function setParam(pathOrId: string, valueOrPath: unknown, valueOrNodeId?: unknown): boolean {
  // The agent bridge uses setParam(id, path, value); the internal UI and the
  // documented agent surface use setParam(path, value, nodeId?). A first
  // argument that names a real node means the id-first form.
  let path: string;
  let value: unknown;
  let nodeId: string | undefined;
  if (findNode(pathOrId) && typeof valueOrPath === 'string') {
    nodeId = pathOrId;
    path = valueOrPath;
    value = valueOrNodeId;
  } else {
    path = pathOrId;
    value = valueOrPath;
    nodeId = typeof valueOrNodeId === 'string' ? valueOrNodeId : undefined;
  }

  const node = findNode(nodeId);
  if (!node) {
    log(`setParam ${path}: no node`, 'err');
    return false;
  }
  mutate(`setParam ${path}`, () => {
    const grade = node.grade as unknown as Record<string, unknown>;
    const current = getPath(grade, path);
    if (typeof current === 'boolean') {
      setPath(grade, path, Boolean(value));
    } else if (typeof current === 'number' && typeof value === 'number') {
      const { lo, hi } = limitsFor(path);
      setPath(grade, path, clampNum(value, lo, hi));
    } else if (typeof current === 'string' && typeof value === 'string') {
      setPath(grade, path, value);
    } else if (isRgb(current) && Array.isArray(value)) {
      setPath(grade, path, [
        clampNum(Number(value[0]) || 0, -8, 8),
        clampNum(Number(value[1]) || 0, -8, 8),
        clampNum(Number(value[2]) || 0, -8, 8),
      ] satisfies RGB);
    } else if (isRgb(current) && typeof value === 'number') {
      const next: RGB = [current[0], current[1], current[2]];
      next[0] = clampNum(value, -8, 8);
      setPath(grade, path, next);
    } else {
      setPath(grade, path, value);
    }
  });
  return true;
}

function getParam(path: string, nodeId?: string): unknown {
  const node = findNode(nodeId);
  if (!node) return undefined;
  return getPath(node.grade as unknown, path);
}

const NODE_KINDS: NodeKind[] = ['corrector', 'serial', 'parallel', 'note', 'group', 'key'];

interface AddNodeOpts {
  label?: string;
  kind?: NodeKind | string;
  after?: string;
}

/**
 * Create a node. Accepts either positional args (addNode('parallel', 'Key 1'))
 * or the options object the agent bridge sends (addNode({label, kind, after})).
 * A non-string `kind` is treated as a missing one rather than being written
 * into the graph — a malformed command must not corrupt the node list.
 */
function addNode(
  kindOrOpts: NodeKind | AddNodeOpts = 'serial',
  labelArg?: string,
  nodeIdArg?: string,
): GraphNode | null {
  const opts: AddNodeOpts =
    typeof kindOrOpts === 'object' && kindOrOpts !== null ? kindOrOpts : { kind: kindOrOpts, label: labelArg, after: nodeIdArg };
  const kind: NodeKind = NODE_KINDS.includes(opts.kind as NodeKind) ? (opts.kind as NodeKind) : 'serial';

  const g = graph();
  const parent = findNode(opts.after);
  const index = g.nodes.length + 1;
  const node = createNode({
    label: opts.label ?? String(index).padStart(2, '0'),
    kind,
    index,
    id: newId('node'),
  });
  mutate(`addNode ${kind}`, () => {
    g.nodes.push(node);
    if (kind === 'parallel' && parent) {
      // Parallel branches the last serial node's *output*, so both paths
      // re-join at the output node — that is Resolve's mental model.
      const from = g.outputNodeId
        ? g.nodes.find((n) => n.id === g.outputNodeId) ?? parent
        : parent;
      g.edges.push([from.id, node.id], [node.id, from.id]);
    } else if (g.outputNodeId) {
      g.edges.push([g.outputNodeId, node.id]);
      g.outputNodeId = node.id;
    } else {
      // First node: it is the output, so there is no upstream edge to add.
      g.outputNodeId = node.id;
    }
    state.selectedNodeId = node.id;
  });
  return node;
}

function removeNode(id: string): boolean {
  const g = graph();
  if (g.nodes.length <= 1 || !g.nodes.some((n) => n.id === id)) return false;
  mutate('removeNode', () => {
    g.nodes = g.nodes.filter((n) => n.id !== id);
    g.edges = g.edges.filter(([a, b]) => a !== id && b !== id);
    g.nodes.forEach((n, i) => { n.index = i + 1; });
    if (g.outputNodeId === id) g.outputNodeId = g.nodes[g.nodes.length - 1]?.id ?? null;
    if (state.selectedNodeId === id) state.selectedNodeId = g.nodes[0]?.id ?? null;
  });
  return true;
}

/** Wire two nodes in the chain, keeping the output node downstream. */
function connectNodes(from: string, to: string): boolean {
  const g = graph();
  if (!g.nodes.some((n) => n.id === from) || !g.nodes.some((n) => n.id === to)) return false;
  if (g.edges.some(([a, b]) => a === from && b === to)) return true;
  mutate('connectNodes', () => {
    g.edges.push([from, to]);
    if (g.outputNodeId === from) g.outputNodeId = to;
  });
  return true;
}

/** The shell holds state in memory; persist only when a handler is wired up. */
function saveProject(path?: string): boolean {
  try {
    localStorage.setItem(`hermes-resolve.project${path ? `.${path}` : ''}`, JSON.stringify(project));
    log(`save_project: wrote ${(project.mediaPool.length)} clips, ${graph().nodes.length} nodes`, 'ok');
    return true;
  } catch (err) {
    log(`save_project failed: ${String(err)}`, 'err');
    return false;
  }
}

// ===========================================================================
// Playhead / transport
// ===========================================================================

function timelineDuration(): number {
  const { durationFrames, outPoint, clips } = project.timeline;
  const clipEnd = clips.reduce((m, c) => Math.max(m, c.start + (c.outFrame - c.inFrame)), 0);
  const explicit = Math.max(durationFrames, outPoint, clipEnd);
  if (explicit > 0) return explicit;
  // An empty timeline used to bottom out at `1`, which made "nothing loaded"
  // indistinguishable from "a one-frame clip": the viewer showed the selected
  // clip, Play was pressed, and the playhead wrapped 00:00 -> 00:01 forever.
  // Fall back to the clip actually on screen, so a single imported file plays.
  const sel = state.selectedClipId ? mediaById(state.selectedClipId) : null;
  const still = sel?.kind === 'image' ? Math.max(1, Math.round(project.timeline.fps * 5)) : 0;
  return Math.max(sel?.durationFrames ?? 0, still);
}

/** True when there is genuinely nothing to play, so Play can say so. */
function playbackIsEmpty(): boolean {
  return timelineDuration() <= 1 && project.timeline.clips.length === 0
    && !(state.selectedClipId && mediaById(state.selectedClipId)?.durationFrames);
}

function setPlayhead(frame: number, opts: { seek?: boolean } = {}): number {
  const total = timelineDuration();
  const f = Math.max(0, Math.round(frame));
  project.timeline.playhead = f;
  updatePlayheadDom();
  if (opts.seek !== false) seekVideo(f);
  return f;
}

function stepPlayhead(delta: number): number {
  return setPlayhead(project.timeline.playhead + delta);
}

function play(): boolean {
  if (state.playing) return true;
  if (playbackIsEmpty()) {
    // Say what is wrong instead of spinning the playhead on a zero-length
    // timeline, which reads as a broken player rather than an empty project.
    log('nothing to play — import a clip first', 'warn');
    return false;
  }
  state.playing = true;
  app.dataset.playing = '1';
  const btn = qo<HTMLButtonElement>('[data-transport="play"]');
  btn?.setAttribute('title', 'Pause (Space)');
  if (btn) btn.dataset.state = 'playing';
  log('play', 'cmd');
  return true;
}

function pause(): boolean {
  if (!state.playing) return false;
  state.playing = false;
  app.dataset.playing = '0';
  const btn = qo<HTMLButtonElement>('[data-transport="play"]');
  btn?.setAttribute('title', 'Play (Space)');
  if (btn) btn.dataset.state = 'paused';
  toggleVideo(false);
  log('pause', 'cmd');
  return false;
}

/** Loop is a project-level transport flag, so the agent can toggle it. */
function setLoop(enabled: boolean): boolean {
  state.loop = enabled !== false;
  app.dataset.loop = state.loop ? '1' : '0';
  return state.loop;
}

/** Single entry point for play/pause. Video sync is owned here so neither
 *  play() nor pause() can re-enter the other. */
function togglePlay(force?: boolean): boolean {
  const want = force ?? !state.playing;
  if (want) {
    play();
    toggleVideo(true);
  } else {
    pause();
  }
  return state.playing;
}

function setIn(): number {
  project.timeline.inPoint = Math.min(project.timeline.playhead, project.timeline.outPoint || Infinity);
  updateMarkers();
  log(`in ${project.timeline.inPoint}`, 'ok');
  return project.timeline.inPoint;
}

function setOut(): number {
  project.timeline.outPoint = Math.max(project.timeline.playhead, project.timeline.inPoint);
  updateMarkers();
  log(`out ${project.timeline.outPoint}`, 'ok');
  return project.timeline.outPoint;
}

function timecode(frame: number): string {
  const fps = project.timeline.fps;
  const f = Math.max(0, Math.round(frame));
  const ff = f % fps;
  const total = Math.floor(f / fps);
  const ss = total % 60;
  const mm = Math.floor(total / 60) % 60;
  const hh = Math.floor(total / 3600);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}:${p2(ff)}`;
}

// ===========================================================================
// Skeleton lookups
// ===========================================================================

const app = q('#app');
const viewerCanvas = q<HTMLCanvasElement>('#viewer');
const nodesCanvas = q<HTMLCanvasElement>('#nodes');
const decodeVideo = q<HTMLVideoElement>('#decode-video');
const clipGrid = q('#clip-grid');
const binTree = q('#bin-tree');
const trackHeaders = q('#track-headers');
const trackLanes = q('#track-lanes');
const rulerHost = q('#ruler');
const playheadEl = q('#playhead');
const agentLog = q<HTMLPreElement>('#agent-log');
const agentConsoleEl = q('#agent-console');
const statusEl = {
  page: q('#status-page'),
  playhead: q('#status-playhead'),
  node: q('#status-node'),
  space: q('#status-space'),
  precision: q('#status-precision'),
  fps: q('#status-fps'),
  res: q('#status-res'),
};

// ===========================================================================
// Agent console log
// ===========================================================================

let logCount = 0;

function log(message: string, level: 'cmd' | 'ok' | 'warn' | 'err' = 'ok'): void {
  const ts = new Date().toISOString().slice(11, 23);
  const line = h('span', { class: `lvl-${level}` }, `[${ts}] ${message}\n`);
  agentLog.append(line);
  logCount += 1;
  q('#agent-count').textContent = String(logCount);
  agentLog.scrollTop = agentLog.scrollHeight;
}

function toggleConsole(force?: boolean): boolean {
  const open = force ?? agentConsoleEl.dataset.open !== '1';
  agentConsoleEl.dataset.open = open ? '1' : '0';
  agentConsoleEl.hidden = !open;
  if (open) q<HTMLInputElement>('#agent-input').focus();
  return open;
}

// ===========================================================================
// Media pool
// ===========================================================================

function activeBin(): Bin {
  return project.bins.find((b) => b.id === state.activeBinId) ?? project.bins[0]!;
}

function mediaById(id: string): MediaClip | undefined {
  return project.mediaPool.find((m) => m.id === id);
}

/** Probe duration/dimensions and grab a poster frame. Never throws. */
async function probeMedia(file: File, url: string): Promise<MediaClip> {
  const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(file.name);
  const name = file.name.replace(/\.[^.]+$/, '');
  const base: MediaClip = {
    id: newId('clip'),
    name,
    src: url,
    durationFrames: DEFAULT_FPS * 5,
    fps: DEFAULT_FPS,
    width: 1920,
    height: 1080,
    kind: isImage ? 'image' : 'video',
    codec: isImage ? file.type : (file.type.split('/')[1] || 'video'),
    attrs: { size: String(file.size), type: file.type, added: new Date().toISOString() },
  };

  if (isImage) {
    // A file that will not decode must NOT silently keep the 1920x1080
    // defaults. The SPA fallback answers any unknown URL with index.html and
    // a 200, so a typo'd fixture path arrives here as "an image" that is
    // really an HTML document; accepting it produces a black viewer and every
    // downstream grade looks like a no-op.
    const decoded = await new Promise<{ w: number; h: number; thumb?: string } | null>((res) => {
      const img = new Image();
      const done = (v: { w: number; h: number; thumb?: string } | null) => res(v);
      img.onload = () => {
        if (!img.naturalWidth || !img.naturalHeight) { done(null); return; }
        let thumb: string | undefined;
        try {
          const c = document.createElement('canvas');
          c.width = 160;
          c.height = Math.max(1, Math.round((160 * img.naturalHeight) / img.naturalWidth));
          c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
          thumb = c.toDataURL('image/jpeg', 0.6);
        } catch { /* tainted or zero-size canvas — skip the poster */ }
        done({ w: img.naturalWidth, h: img.naturalHeight, thumb });
      };
      img.onerror = () => done(null);
      img.src = url;
    });

    if (!decoded) {
      throw new Error(
        `${name}: not a decodable image (${file.size} bytes, type "${file.type || 'unknown'}") — `
        + 'if this came over HTTP, check the path is really the file and not the SPA fallback page',
      );
    }

    base.width = decoded.w;
    base.height = decoded.h;
    if (decoded.thumb) base.thumbnail = decoded.thumb;
    base.durationFrames = DEFAULT_FPS * 5;
    return base;
  }

  const v = document.createElement('video');
  v.preload = 'auto';
  v.muted = true;
  v.playsInline = true;
  v.src = url;
  await new Promise<void>((res) => {
    v.onloadedmetadata = () => res();
    v.onerror = () => res();
  });
  if (Number.isFinite(v.videoWidth) && v.videoWidth > 0) {
    base.width = v.videoWidth;
    base.height = v.videoHeight;
  }
  if (Number.isFinite(v.duration) && v.duration > 0) {
    base.durationFrames = Math.max(1, Math.round(v.duration * DEFAULT_FPS));
  }

  // Poster frame: seek off the head, grab 160px wide, then release the element.
  await new Promise<void>((res) => {
    const grab = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 160;
        c.height = Math.max(1, Math.round((160 * base.height) / base.width));
        c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
        base.thumbnail = c.toDataURL('image/jpeg', 0.6);
      } catch { /* no poster is not fatal */ }
      v.removeAttribute('src');
      v.load();
      res();
    };
    v.onseeked = grab;
    v.onerror = () => res();
    try { v.currentTime = Math.min(0.2, (v.duration || 1) / 2); } catch { grab(); }
    window.setTimeout(grab, 1200);
  });
  return base;
}

async function importFiles(files: File[] | FileList): Promise<MediaClip[]> {
  const list = Array.from(files);
  if (list.length === 0) return [];
  const added: MediaClip[] = [];
  for (const f of list) {
    if (!/^(video|image)\//.test(f.type) && !/\.(mp4|mov|webm|mkv|m4v|avi|png|jpe?g|webp|gif|avif)$/i.test(f.name)) {
      log(`skipped ${f.name} (not video/image)`, 'warn');
      continue;
    }
    const url = URL.createObjectURL(f);
    const clip = await probeMedia(f, url);
    project.mediaPool.push(clip);
    activeBin().clipIds.push(clip.id);
    reconcileBins(project.bins);
    added.push(clip);
  }
  if (added.length) {
    project.version += 1;
    log(`imported ${added.length} clip${added.length > 1 ? 's' : ''}: ${added.map((a) => a.name).join(', ')}`, 'ok');
  }
  renderMediaPool();
  if (added[0]) {
    selectClip(added[0].id);
    // Drop the first import onto the timeline. Resolve does not do this, but it
    // does have a clip on V1 the moment you open a project, and without it the
    // Edit page is empty and Play has nothing to play — the symptom being a
    // playhead that wraps 00:00 -> 00:01 on a zero-length timeline.
    if (project.timeline.clips.length === 0) {
      const track = project.timeline.tracks.find((t) => t.kind === 'video')
        ?? project.timeline.tracks[0];
      if (track) appendToTrack(track.id, added[0].id, 0);
    }
  }
  syncAll();
  return added;
}

function selectClip(id: string | null): MediaClip | null {
  state.selectedClipId = id;
  if (id) {
    const m = mediaById(id);
    if (m) setViewerSource(m);
  } else {
    clearViewerSource();
  }
  renderMediaPool();
  return id ? mediaById(id) ?? null : null;
}

function setViewerSource(clip: MediaClip): void {
  if (clip.kind === 'image') {
    const img = new Image();
    img.onload = () => {
      updateStatusRes(img.naturalWidth || clip.width, img.naturalHeight || clip.height);
      // Still: one frame, no seek. The rAF loop keeps painting it every frame.
      if (viewerSource === img) paintViewer();
    };
    img.src = clip.src;
    viewerSource = img;
  } else {
    viewerSource = decodeVideo;
    if (decodeVideo.src !== clip.src) {
      decodeVideo.src = clip.src;
      decodeVideo.load();
    }
  }
  viewerMessage?.toggleAttribute('hidden', true);
  updateStatusRes(clip.width, clip.height);
}

function clearViewerSource(): void {
  viewerSource = null;
  decodeVideo.removeAttribute('src');
  decodeVideo.load();
  viewerMessage?.removeAttribute('hidden');
  updateStatusRes(0, 0);
}

let viewerSource: PipelineSource = null;
const viewerMessage = qo('#viewer-msg');

function updateStatusRes(w: number, hgt: number): void {
  statusEl.res.textContent = w > 0 ? `${w}x${hgt}` : '—';
  // The drawing-buffer size must track the source, or every readPixels()
  // probe, scope analysis and agent screenshot is silently measuring a
  // 300x150 (or 1x1) buffer instead of the frame. CSS `width: 100%` scales
  // the element but never the backing store, so it cannot do this for us.
  if (w > 0 && hgt > 0 && viewerCanvas.width !== w) {
    viewerCanvas.width = w;
    viewerCanvas.height = hgt;
  }
}

function clipCard(clip: MediaClip): HTMLElement {
  const card = h(
    'div',
    {
      class: 'clip',
      role: 'option',
      tabindex: 0,
      title: `${clip.name} — ${clip.width}x${clip.height}, ${clip.durationFrames}f @ ${clip.fps}fps`,
      dataset: { clipId: clip.id, kind: clip.kind, selected: clip.id === state.selectedClipId ? '1' : '0' },
      draggable: true,
      on: {
        click: () => selectClip(clip.id),
        keydown: (e) => {
          if ((e as KeyboardEvent).key === 'Enter') selectClip(clip.id);
        },
        dragstart: (e) => {
          const ev = e as DragEvent;
          ev.dataTransfer?.setData('application/x-resolve-clip', clip.id);
          ev.dataTransfer?.setData('text/plain', clip.id);
          card.dataset.dragging = '1';
        },
        dragend: () => { card.dataset.dragging = '0'; },
      },
    },
    h(
      'div',
      { class: 'clip-thumb', style: clip.thumbnail ? { backgroundImage: `url(${clip.thumbnail})` } : {} },
      h('span', { class: 'clip-kind', text: clip.kind }),
    ),
    h(
      'div',
      { class: 'clip-meta' },
      h('div', { class: 'clip-name', text: clip.name }),
      h('div', {
        class: 'clip-sub',
        text: `${clip.width}x${clip.height} · ${Math.round(clip.durationFrames / clip.fps)}s`,
      }),
    ),
  );
  return card;
}

function renderMediaPool(): void {
  binTree.replaceChildren(
    ...project.bins.map((bin) =>
      h(
        'li',
        { role: 'none' },
        h(
          'div',
          {
            class: 'bin-row',
            role: 'treeitem',
            tabindex: 0,
            dataset: { binId: bin.id, active: bin.id === state.activeBinId ? '1' : '0', depth: bin.parent ? '1' : '0' },
            title: bin.name,
            on: {
              click: () => { state.activeBinId = bin.id; renderMediaPool(); },
              keydown: (e) => {
                if ((e as KeyboardEvent).key === 'Enter') { state.activeBinId = bin.id; renderMediaPool(); }
              },
            },
          },
          h('span', { class: 'bin-twisty', text: bin.parent ? '▸' : '▾' }),
          h('span', { text: bin.name }),
          h('span', { class: 'bin-count', text: String(bin.clipIds.length) }),
        ),
      ),
    ),
  );

  clipGrid.dataset.view = state.mediaView;
  q('#clip-pane-title').textContent = activeBin().name;
  const ids = activeBin().clipIds;
  const clips = ids.map(mediaById).filter((m): m is MediaClip => Boolean(m));
  clipGrid.replaceChildren(...clips.map(clipCard));
  q('#clip-count').textContent = String(project.mediaPool.length);
  if (clips.length === 0) {
    clipGrid.replaceChildren(
      h('div', {
        class: 'clip',
        style: { gridColumn: '1 / -1', opacity: '.6', padding: '10px', textAlign: 'center' },
        text: 'Drop video or image files here',
      }),
    );
  }
}

// ===========================================================================
// Timeline
// ===========================================================================

function pxPerFrame(): number {
  return state.zoom / project.timeline.fps;
}

function frameToX(frame: number): number {
  return frame * pxPerFrame();
}

function xToFrame(x: number): number {
  return Math.max(0, Math.round(x / pxPerFrame()));
}

function renderRuler(): void {
  const host = rulerHost;
  if (qo('canvas', host)) return; // built once
  const c = h('canvas', { width: 1, height: 20 });
  host.append(c);
  const ro = new ResizeObserver(() => drawRuler());
  ro.observe(host);
  queueMicrotask(drawRuler);
}

function drawRuler(): void {
  const c = qo<HTMLCanvasElement>('canvas', rulerHost);
  if (!c) return;
  const w = Math.max(1, Math.round(rulerHost.clientWidth));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = 20 * dpr; }
  c.style.width = `${w}px`;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, 20);
  ctx.fillStyle = '#212121';
  ctx.fillRect(0, 0, w, 20);

  const fps = project.timeline.fps;
  const ppf = pxPerFrame();
  // Pick the finest tick that still has >= 42px between marks, so the ruler
  // stays legible at every zoom instead of turning into a solid block.
  const steps = [1, 2, 5, 10, fps, fps * 2, fps * 5, fps * 10, fps * 30, fps * 60];
  const step = steps.find((s) => s * ppf >= 42) ?? steps[steps.length - 1]!;

  ctx.font = '9px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  const end = Math.ceil(w / ppf);
  for (let f = 0; f <= end; f += step) {
    const x = Math.round(f * ppf) + 0.5;
    ctx.strokeStyle = '#4a4a4a';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 20);
    ctx.stroke();
    ctx.fillStyle = '#8a8a8a';
    ctx.fillText(timecode(f), x + 3, 5);
  }
  // Highlight the loop range so in/out is readable without the markers.
  const { inPoint, outPoint } = project.timeline;
  if (outPoint > inPoint) {
    ctx.fillStyle = 'rgba(45,127,249,0.16)';
    ctx.fillRect(frameToX(inPoint), 0, frameToX(outPoint - inPoint), 20);
  }
}

function renderTimeline(): void {
  const tl = project.timeline;
  trackHeaders.replaceChildren(
    ...tl.tracks.map((t) =>
      h(
        'div',
        { class: 'track-head', dataset: { trackId: t.id, kind: t.kind, height: String(t.height) } },
        h('span', { class: 'track-name', text: `${t.index}: ${t.name}` }),
        h('button', {
          class: 'track-btn',
          type: 'button',
          text: 'M',
          title: 'Mute',
          attrs: { 'aria-pressed': String(t.muted) },
          on: { click: () => { t.muted = !t.muted; renderTimeline(); } },
        }),
        h('button', {
          class: 'track-btn',
          type: 'button',
          text: 'L',
          title: 'Lock',
          attrs: { 'aria-pressed': String(t.locked) },
          on: { click: () => { t.locked = !t.locked; renderTimeline(); } },
        }),
      ),
    ),
  );

  const lanes = tl.tracks.map((t) => {
    const lane = h('div', {
      class: 'track-lane',
      dataset: { trackId: t.id, kind: t.kind, locked: t.locked ? '1' : '0' },
      on: {
        // Empty-lane click positions the playhead; drop appends a clip.
        click: (e) => {
          if ((e.target as HTMLElement).closest('.tl-clip')) return;
          const r = lane.getBoundingClientRect();
          setPlayhead(xToFrame((e as MouseEvent).clientX - r.left));
        },
        dragover: (e) => {
          e.preventDefault();
          lane.dataset.dropActive = '1';
        },
        dragleave: () => { lane.dataset.dropActive = '0'; },
        drop: (e) => {
          const ev = e as DragEvent;
          ev.preventDefault();
          lane.dataset.dropActive = '0';
          const id = ev.dataTransfer?.getData('application/x-resolve-clip') || '';
          const r = lane.getBoundingClientRect();
          if (id && mediaById(id)) appendToTrack(t.id, id, xToFrame(ev.clientX - r.left));
        },
      },
    });
    for (const c of tl.clips.filter((c) => c.trackId === t.id)) lane.append(timelineClipEl(c));
    return lane;
  });
  trackLanes.replaceChildren(...lanes);
  trackScroll.style.setProperty('--px-per-frame', String(pxPerFrame()));
  q('#track-scroll').style.setProperty('--px-per-frame', String(pxPerFrame()));
  drawRuler();
  updatePlayheadDom();
}

const trackScroll = q('#track-scroll');

function timelineClipEl(c: TimelineClip): HTMLElement {
  const media = mediaById(c.mediaId);
  const len = Math.max(1, c.outFrame - c.inFrame);
  const el = h(
    'div',
    {
      class: 'tl-clip',
      tabindex: 0,
      title: `${media?.name ?? c.mediaId} — ${len}f @ ${project.timeline.fps}fps`,
      dataset: {
        clipId: c.id,
        trackId: c.trackId,
        kind: media?.kind ?? 'video',
        enabled: c.enabled ? '1' : '0',
        selected: c.id === state.selectedTimelineClipId ? '1' : '0',
      },
      draggable: true,
      style: {
        transform: `translateX(${frameToX(c.start)}px)`,
        width: `${Math.max(2, frameToX(len))}px`,
      },
      on: {
        click: (e) => {
          e.stopPropagation();
          selectTimelineClip(c.id);
        },
        dblclick: () => setPlayhead(c.start),
        dragstart: (e) => {
          const ev = e as DragEvent;
          ev.dataTransfer?.setData('application/x-resolve-tlclip', c.id);
          el.dataset.dragging = '1';
        },
        dragend: () => { el.dataset.dragging = '0'; },
        keydown: (e) => {
          const k = (e as KeyboardEvent).key;
          if (k === 'Enter') selectTimelineClip(c.id);
          if (k === 'ArrowLeft') { c.start = Math.max(0, c.start - 1); renderTimeline(); }
          if (k === 'ArrowRight') { c.start += 1; renderTimeline(); }
        },
      },
    },
    h('div', { class: 'tl-clip-name', text: media?.name ?? c.label ?? c.id }),
    h('div', { class: 'tl-clip-sub', text: `${len}f` }),
  );
  return el;
}

function selectTimelineClip(id: string | null): void {
  state.selectedTimelineClipId = id;
  const c = project.timeline.clips.find((x) => x.id === id);
  if (c && id) {
    project.timeline.selection = [id];
    setPlayhead(c.start);
    const media = mediaById(c.mediaId);
    if (media) selectClip(media.id);
  }
  renderTimeline();
}

function appendToTrack(trackId: string, mediaId: string, atFrame: number): TimelineClip | null {
  const media = mediaById(mediaId);
  const track = project.timeline.tracks.find((t) => t.id === trackId);
  if (!media || !track) return null;
  const start = Math.max(0, atFrame);
  // A clip is trimmed to its own length so a dropped clip never runs past the
  // end of its own media, which is the behaviour Resolve's trim-mode gives.
  const len = Math.min(media.durationFrames, project.timeline.fps * 10);
  const clip: TimelineClip = {
    id: newId('tl'),
    mediaId,
    trackId,
    start,
    inFrame: 0,
    outFrame: len,
    enabled: true,
    label: media.name,
  };
  mutate('appendToTrack', () => {
    project.timeline.clips.push(clip);
    project.timeline.durationFrames = Math.max(project.timeline.durationFrames, start + len);
    if (project.timeline.outPoint === 0) project.timeline.outPoint = start + len;
    state.selectedTimelineClipId = clip.id;
  });
  renderTimeline();
  return clip;
}

/**
 * Enable/disable a timeline clip. A disabled clip stays on the timeline and
 * keeps its media, which is how Resolve's enable toggle behaves and how an
 * agent can A/B two grades of the same cut without re-importing anything.
 */
function setClipEnabled(clipId: string, enabled: boolean): boolean {
  const clip = project.timeline.clips.find((c) => c.id === clipId);
  if (!clip) return false;
  mutate('setClipEnabled', () => { clip.enabled = enabled !== false; });
  renderTimeline();
  return true;
}

/** Split the selected clip (or the clip under the playhead) at the playhead. */
function split(): boolean {
  const ph = project.timeline.playhead;
  const target = project.timeline.clips.find(
    (c) => c.id === state.selectedTimelineClipId || (c.start < ph && c.start + (c.outFrame - c.inFrame) > ph),
  );
  if (!target) { log('split: no clip under playhead', 'warn'); return false; }
  const offset = ph - target.start;
  if (offset <= 0) { log('split: playhead is at the clip head', 'warn'); return false; }
  mutate('split', () => {
    const right: TimelineClip = {
      ...structuredClone(target),
      id: newId('tl'),
      start: ph,
      inFrame: target.inFrame + offset,
    };
    target.outFrame = target.inFrame + offset;
    const i = project.timeline.clips.indexOf(target);
    project.timeline.clips.splice(i + 1, 0, right);
    state.selectedTimelineClipId = right.id;
  });
  renderTimeline();
  return true;
}

/** Duration of a clip in timeline frames. */
function clipLength(clip: TimelineClip): number {
  return Math.max(0, clip.outFrame - clip.inFrame);
}

function timelineClipsOn(trackId: string): TimelineClip[] {
  return project.timeline.clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start);
}

/**
 * Remove clips, optionally closing the gap.
 *
 * `ripple` is the distinction that matters in an edit: a ripple delete pulls
 * everything after it left so nothing is left empty, a lift leaves a hole for
 * the rest of the sequence to fill. Both are one function because they differ
 * only in whether the tail moves.
 */
function removeClips(clipIds: string[], ripple: boolean): string[] {
  const tl = project.timeline;
  const targets = tl.clips.filter((c) => clipIds.includes(c.id));
  if (targets.length === 0) {
    log(`remove: none of ${clipIds.length} clip(s) exist`, 'warn');
    return [];
  }

  mutate(ripple ? 'ripple delete' : 'lift', () => {
    const removing = new Set(targets.map((t) => t.id));
    tl.clips = tl.clips.filter((c) => !removing.has(c.id));

    if (ripple) {
      // Only what FOLLOWS the removed range moves. The first version shifted
      // every clip on the track by the total freed length, which walked the
      // head of the sequence off the front of the timeline: a ripple delete at
      // frame 30 of a four-clip cut produced clips starting at -30.
      //
      // Removals are applied from the last cut backwards so that each shift
      // sees positions that the later ones have not yet disturbed.
      const byStart = [...targets].sort((a, b) => b.start - a.start);
      for (const cut of byStart) {
        for (const c of tl.clips) {
          if (c.trackId !== cut.trackId) continue;
          if (c.start >= cut.start) c.start -= clipLength(cut);
        }
      }

      // The playhead rides along, but never past the start of the track: a
      // playhead at -8 is a state you cannot scrub back from.
      const first = tl.clips.length ? Math.min(...tl.clips.map((c) => c.start)) : 0;
      tl.playhead = Math.max(Math.min(first, 0), tl.playhead);
    }

    tl.selection = tl.selection.filter((id) => !removing.has(id));
    if (state.selectedTimelineClipId && removing.has(state.selectedTimelineClipId)) {
      state.selectedTimelineClipId = null;
    }
    // Shrink the declared duration so timelineDuration() and the export range
    // follow the edit instead of the old one.
    const longest = tl.clips.reduce((m, c) => Math.max(m, c.start + clipLength(c)), 0);
    if (longest > 0) tl.durationFrames = longest;
  });
  renderTimeline();
  return targets.map((t) => t.id);
}

/** The clip the edit commands act on: the selection, else whatever is under the playhead. */
function targetClip(clipId?: string): TimelineClip | undefined {
  const tl = project.timeline;
  if (clipId) return tl.clips.find((c) => c.id === clipId);
  if (state.selectedTimelineClipId) {
    const sel = tl.clips.find((c) => c.id === state.selectedTimelineClipId);
    if (sel) return sel;
  }
  const ph = tl.playhead;
  return tl.clips.find((c) => c.start <= ph && c.start + clipLength(c) > ph);
}

function rippleDelete(clipId?: string): string[] {
  const t = targetClip(clipId);
  if (!t) { log('ripple delete: no clip selected', 'warn'); return []; }
  return removeClips([t.id], true);
}

function liftClip(clipId?: string): string[] {
  const t = targetClip(clipId);
  if (!t) { log('lift: no clip selected', 'warn'); return []; }
  return removeClips([t.id], false);
}

/**
 * Place a media clip on a track at a frame.
 *
 * `mode` is 'insert' (push what follows along, so nothing is overwritten) or
 * 'overwrite' (replace the frames it covers). Inserting needs room: if the clip
 * would run into the next one, it is refused rather than silently shortened,
 * because a clip that quietly loses its tail is indistinguishable from a bug.
 */
function insertClip(
  mediaId: string,
  trackId: string,
  frame?: number,
  mode: 'insert' | 'overwrite' = 'insert',
): TimelineClip | null {
  const tl = project.timeline;
  const media = project.mediaPool.find((m) => (m as { id?: string }).id === mediaId) as { id: string; durationFrames?: number } | undefined;
  if (!media) { log(`insert: no media ${mediaId}`, 'warn'); return null; }

  const track = tl.tracks.find((t) => t.id === trackId);
  if (!track) { log(`insert: no track ${trackId}`, 'warn'); return null; }
  if (track.locked) { log(`insert: ${track.name} is locked`, 'warn'); return null; }

  const at = Math.max(0, Math.trunc(frame ?? tl.playhead));
  const length = Math.max(1, Math.trunc(media.durationFrames ?? 0));
  if (length <= 0) { log('insert: media has no duration', 'warn'); return null; }

  const onTrack = timelineClipsOn(trackId);

  // An insert makes room by pushing the tail along, so it is always
  // placeable. The first version refused whenever a clip started at or after
  // the insertion point — which is the clip immediately in front of it, so
  // inserting at the head of an occupied track (the most common insert there
  // is) was always rejected. Only an overwrite has to fit in what is already
  // there, so only an overwrite can run out of room.
  if (mode === 'overwrite') {
    const next = onTrack.find((c) => c.start > at);
    if (next && at + length > next.start) {
      log(`overwrite: needs ${at + length - next.start} more frame(s) of room before ${next.label ?? next.id}`, 'warn');
      return null;
    }
  }

  let created: TimelineClip | null = null;
  mutate(mode === 'insert' ? 'insert clip' : 'overwrite clip', () => {
    if (mode === 'insert') {
      for (const c of tl.clips) {
        if (c.trackId === trackId && c.start >= at) c.start += length;
      }
    } else {
      // An overwrite eats whatever it lands on, splitting a straddled clip
      // rather than leaving a fragment behind the new one.
      const hit = tl.clips.filter((c) => c.trackId === trackId && c.start < at + length && c.start + clipLength(c) > at);
      for (const c of hit) {
        if (c.start < at) {
          c.outFrame = c.inFrame + (at - c.start);
        } else {
          const tail = c.start + clipLength(c) - (at + length);
          if (tail > 0) {
            c.start = at + length;
            c.inFrame = c.inFrame + tail;
          } else {
            c.id = '';
          }
        }
      }
      tl.clips = tl.clips.filter((c) => c.id !== '');
    }

    created = {
      id: newId('tl'),
      mediaId,
      trackId,
      start: at,
      inFrame: 0,
      outFrame: length,
      enabled: true,
      label: (media as { name?: string }).name ?? mediaId,
    };
    tl.clips.push(created);
    tl.selection = [created.id];
    state.selectedTimelineClipId = created.id;
    const longest = tl.clips.reduce((m, c) => Math.max(m, c.start + clipLength(c)), 0);
    if (longest > 0) tl.durationFrames = longest;
  });
  renderTimeline();
  return created;
}

/** Copy the selected clip and put the copy directly after it. */
function duplicateClip(clipId?: string): TimelineClip | null {
  const t = targetClip(clipId);
  if (!t) { log('duplicate: no clip selected', 'warn'); return null; }
  const length = clipLength(t);
  let copy: TimelineClip | null = null;
  mutate('duplicate clip', () => {
    for (const c of project.timeline.clips) {
      if (c.trackId === t.trackId && c.start >= t.start + length) c.start += length;
    }
    copy = { ...structuredClone(t), id: newId('tl'), start: t.start + length };
    project.timeline.clips.push(copy);
    project.timeline.selection = [copy.id];
    state.selectedTimelineClipId = copy.id;
  });
  renderTimeline();
  return copy;
}

/**
 * Slide a clip along its track by `delta` frames.
 *
 * Ripple keeps the sequence gapless by moving the tail with it; slide leaves
 * the tail where it is and opens a gap, which is how a retimed shot is lined
 * up against its neighbour.
 */
function moveClip(clipId: string | undefined, delta: number, mode: 'ripple' | 'slide' = 'ripple'): boolean {
  const t = targetClip(clipId);
  if (!t) { log('move: no clip selected', 'warn'); return false; }
  const by = Math.trunc(delta);
  if (by === 0) return false;
  const to = Math.max(0, t.start + by);
  const actual = to - t.start;
  if (actual === 0) { log('move: already at the start of the track', 'warn'); return false; }

  const track = project.timeline.tracks.find((x) => x.id === t.trackId);
  if (track?.locked) { log(`move: ${track.name} is locked`, 'warn'); return false; }

  const length = clipLength(t);
  const onTrack = timelineClipsOn(t.trackId).filter((c) => c.id !== t.id);
  if (mode === 'slide') {
    const clash = onTrack.find((c) => to < c.start + clipLength(c) && to + length > c.start);
    if (clash) { log('move: a slide cannot overlap another clip', 'warn'); return false; }
  }

  mutate('move clip', () => {
    if (mode === 'ripple') {
      // A ripple move keeps the sequence gapless, which means the neighbours
      // have to absorb the move: whatever the clip opens ahead of it closes
      // behind it.
      //
      // The first version shifted every clip whose end touched the moved clip
      // on a leftward move, which dragged the preceding clip off the front of
      // the timeline — moving a clip at frame 20 left by 10 moved its neighbour
      // from 0 to -10. Instead: push the tail right to open room, place the
      // clip, then close the gap it left behind by growing (or trimming) the
      // clip before it.
      for (const c of project.timeline.clips) {
        if (c.id === t.id || c.trackId !== t.trackId) continue;
        if (c.start >= to) c.start += actual;
      }
      t.start = to;

      // Close up behind: the clip ahead of the moved one is trimmed or grown
      // so it butts against the new position. Both directions are needed —
      // moving a clip left over a longer neighbour means trimming it, and
      // leaving them overlapping is not an option.
      let reach = t.start;
      let guard = 0;
      for (;;) {
        const before = project.timeline.clips
          .filter((c) => c.id !== t.id && c.trackId === t.trackId && c.start < reach && c.start + clipLength(c) <= reach + clipLength(t))
          .sort((a, b) => (b.start + clipLength(b)) - (a.start + clipLength(a)))[0];
        if (!before || guard++ > 64) break;
        const end = before.start + clipLength(before);
        if (end === reach) break;
        if (end > reach) {
          // Overlap: take the tail off the neighbour, but never below one frame.
          if (reach - before.start <= 0) break;
          before.outFrame = before.inFrame + (reach - before.start);
        } else {
          before.outFrame += reach - end;
        }
        reach = before.start;
      }
    } else {
      t.start = to;
    }
  });
  renderTimeline();
  return true;
}

/**
 * Trim one end of a clip by an absolute frame value.
 *
 * `edge` is 'start' or 'end'. Both are clamped so a clip can never invert or
 * vanish, and trimming the start moves inFrame with it so the source content
 * under the timeline does not shift.
 */
function trimClip(clipId: string | undefined, edge: 'start' | 'end', frame: number): boolean {
  const t = targetClip(clipId);
  if (!t) { log('trim: no clip selected', 'warn'); return false; }
  const at = Math.trunc(frame);
  mutate('trim clip', () => {
    if (edge === 'start') {
      const to = Math.max(0, Math.min(at, t.start + clipLength(t) - 1));
      const shift = to - t.start;
      t.start = to;
      t.inFrame += shift;
    } else {
      t.outFrame = Math.max(t.inFrame + 1, at - t.start + t.inFrame);
    }
  });
  renderTimeline();
  return true;
}

function updatePlayheadDom(): void {
  const x = frameToX(project.timeline.playhead);
  playheadEl.style.setProperty('--playhead-x', `${x}px`);
  playheadEl.dataset.frame = String(project.timeline.playhead);
  const tc = timecode(project.timeline.playhead);
  q('#transport-tc').textContent = tc;
  q('#viewer-tc').textContent = tc;
  q('#timeline-tc').textContent = tc;
  statusEl.playhead.textContent = String(project.timeline.playhead);
}

function updateMarkers(): void {
  q('#in-marker').style.setProperty('--marker-x', `${frameToX(project.timeline.inPoint)}px`);
  q('#out-marker').style.setProperty('--marker-x', `${frameToX(project.timeline.outPoint)}px`);
}

// ===========================================================================
// Node editor
// ===========================================================================

function nodePositions(): Map<string, { x: number; y: number; w: number }> {
  const g = graph();
  const map = new Map<string, { x: number; y: number; w: number }>();
  const W = 74;
  const H = 52;
  const vertical = g.layout === 'vertical';
  const step = W + 46;
  g.nodes.forEach((n, i) => {
    const explicit = n.pos;
    const x = explicit?.x ?? (vertical ? 24 : 20 + i * step);
    const y = explicit?.y ?? (vertical ? 16 + i * (H + 26) : 16);
    map.set(n.id, { x, y, w: W });
  });
  return map;
}

function renderNodes(): void {
  const g = graph();
  const pos = nodePositions();
  const layer = q('#node-layer');
  layer.replaceChildren(
    ...g.nodes.map((n) => {
      const p = pos.get(n.id)!;
      const sel = n.id === state.selectedNodeId;
      const el = h(
        'div',
        {
          class: 'node',
          tabindex: 0,
          title: `${n.label} — ${n.kind}${n.bypass ? ' (bypassed)' : ''}`,
          dataset: {
            nodeId: n.id,
            index: String(n.index),
            kind: n.kind,
            selected: sel ? '1' : '0',
            enabled: n.enabled ? '1' : '0',
            bypassed: n.bypass ? '1' : '0',
          },
          style: { transform: `translate(${p.x}px, ${p.y}px)`, width: `${p.w}px` },
          on: {
            click: (e) => { e.stopPropagation(); selectNode(n.id); },
            keydown: (e) => {
              const k = (e as KeyboardEvent).key;
              if (k === 'Enter') selectNode(n.id);
              if (k === 'Delete' || k === 'Backspace') removeNode(n.id);
              if (k === 'ArrowLeft' || k === 'ArrowRight') {
                const d = k === 'ArrowLeft' ? -1 : 1;
                mutate('moveNode', () => { n.index += d; });
              }
            },
          },
        },
        h('div', { class: 'node-strip' }),
        h('div', { class: 'node-title' }, h('span', { class: 'node-label', text: n.label }), h('span', { class: 'node-flags', text: `${n.bypass ? 'B' : ''}${n.enabled ? '' : 'D'}` })),
        h(
          'div',
          { class: 'node-foot' },
          h('button', { class: 'node-btn', type: 'button', text: '◐', title: 'Bypass', attrs: { 'aria-pressed': String(Boolean(n.bypass)) }, on: { click: (e) => { e.stopPropagation(); mutate('bypass', () => { n.bypass = !n.bypass; }); } } }),
          h('button', { class: 'node-btn', type: 'button', text: '⇄', title: 'Reset grade', on: { click: (e) => { e.stopPropagation(); mutate('resetGrade', () => { n.grade = defaultGrade(); }); } } }),
        ),
        h('span', { class: 'node-port', dataset: { port: 'in' } }),
        h('span', { class: 'node-port', dataset: { port: 'out' } }),
      );
      return el;
    }),
  );
  drawNodeEdges();
  renderPalette();
  const n = findNode();
  statusEl.node.textContent = n ? `${String(n.index).padStart(2, '0')}${n.bypass ? ' B' : ''}` : '—';
  q('#panel-target').textContent = n ? `Node ${String(n.index).padStart(2, '0')}` : 'No node';
}

function selectNode(id: string): void {
  state.selectedNodeId = id;
  renderNodes();
  syncControls();
}

function drawNodeEdges(): void {
  const c = nodesCanvas;
  const host = c.parentElement;
  if (!host) return;
  const w = Math.max(1, host.clientWidth);
  const hgt = Math.max(1, host.clientHeight);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = w * dpr;
  c.height = hgt * dpr;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const pos = nodePositions();
  for (const [from, to] of graph().edges) {
    const a = pos.get(from);
    const b = pos.get(to);
    if (!a || !b) continue;
    const x1 = a.x + a.w;
    const y1 = a.y + 26;
    const x2 = b.x;
    const y2 = b.y + 26;
    const mid = (x1 + x2) / 2;
    ctx.strokeStyle = from === graph().outputNodeId ? '#2d7ff9' : '#4a4a4a';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(mid, y1, mid, y2, x2, y2);
    ctx.stroke();
  }
}

function renderPalette(): void {
  q('#node-palette').replaceChildren(
    ...NODE_PALETTE.map((kind) =>
      h(
        'button',
        {
          class: 'palette-item',
          type: 'button',
          title: `Add ${kind} node`,
          dataset: { kind, action: 'add-node' },
          on: { click: () => addNode(kind) },
        },
        h('span', { class: 'swatch' }),
        kind,
      ),
    ),
  );
}

// ===========================================================================
// Control panels: binding, wheels, curves
// ===========================================================================

/** Numeric formatting that keeps 3 decimals without looking noisy. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

function inputElFor(path: string): HTMLInputElement | null {
  return qo<HTMLInputElement>(`[data-bind="${cssEscape(path)}"]`);
}

/** Push project state into the controls. Focused inputs are left alone so a
 *  drag or a typed value is never clobbered mid-interaction. */
function syncControls(): void {
  const node = findNode();
  if (!node) return;
  const grade = node.grade as unknown;

  for (const el of qsa<HTMLInputElement>('[data-bind]')) {
    if (document.activeElement === el) continue;
    const v = getPath(grade, el.dataset.bind!);
    if (v === undefined) continue;
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else if (el instanceof HTMLSelectElement) el.value = String(v);
    else if (el.type === 'color') el.value = rgbToHex(v as RGB);
    else el.value = typeof v === 'number' ? String(Number(v.toFixed(5))) : String(v);
    if (el.dataset.control === 'slider') paintSlider(el);
  }

  for (const el of qsa<HTMLElement>('[data-bind-ui]')) {
    const n = findNode();
    if (!n) continue;
    if (el.dataset.bindUi === 'node.bypass') (el as HTMLInputElement).checked = Boolean(n.bypass);
    if (el.dataset.bindUi === 'node.enabled') (el as HTMLInputElement).checked = n.enabled;
    if (el.dataset.bindUi === 'node.layout') (el as HTMLSelectElement).value = graph().layout;
  }

  // Panel headers show a one-line signature of their own state.
  const hint = (panel: string, text: string) => {
    const el = qo<HTMLElement>(`[data-panel="${panel}"] .cp-hint`);
    if (el) el.textContent = text;
  };
  const lift = getPath(grade, 'primary.lift') as RGB;
  const gamma = getPath(grade, 'primary.gamma') as RGB;
  const gain = getPath(grade, 'primary.gain') as RGB;
  hint('primaries', `${fmt(gain[0])} · ${fmt(gamma[1])} · ${lift[2].toFixed(2)}`);
  hint('qualifier', getPath(grade, 'qualifier.enabled') ? 'on' : 'off');
  hint('key', getPath(grade, 'key.enabled') ? 'on' : 'off');
  hint('window', getPath(grade, 'window.enabled') ? 'on' : 'off');
  hint('effects', String(getPath(grade, 'effects.lut') ?? 'no LUT'));
  hint('node', `${fmt(getPath(grade, 'inputGamma') as number)} / ${fmt(getPath(grade, 'outputGamma') as number)}`);
  const mode = getPath(grade, 'curves.mode');
  hint('curves', String(mode ?? 'custom'));

  drawWheels();
  drawCurves();
}

function rgbToHex(rgb: RGB): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255)));
  return `#${[c(rgb[0]), c(rgb[1]), c(rgb[2])].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Fill the track up to the thumb using --pct, the way Resolve's do. */
function paintSlider(el: HTMLInputElement): void {
  const min = Number(el.min);
  const max = Number(el.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return;
  const pct = ((Number(el.value) - min) / (max - min)) * 100;
  el.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct))}%`);
}

function readControlValue(el: HTMLInputElement): unknown {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'color') {
    const m = /^#?([0-9a-f]{6})$/i.exec(el.value);
    if (!m) return null;
    const n = parseInt(m[1]!, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] satisfies RGB;
  }
  const n = Number(el.value);
  return Number.isFinite(n) ? n : el.value;
}

function wireControls(): void {
  for (const el of qsa<HTMLInputElement | HTMLSelectElement>('[data-bind]')) {
    const evt = el instanceof HTMLSelectElement || el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      if (el.type === 'color') {
        const v = readControlValue(el) as RGB;
        setParam(el.dataset.bind!, v);
        return;
      }
      setParam(el.dataset.bind!, readControlValue(el as HTMLInputElement));
    });
    // Enter in a numeric field commits and releases focus (a real editing affordance).
    el.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') el.blur();
    });
    el.addEventListener('dblclick', () => {
      const neutral = getParam(el.dataset.bind!);
      if (typeof neutral === 'number') setParam(el.dataset.bind!, Number(el.dataset.control === 'slider' ? el.value : 0));
    });
    if (el.dataset.control === 'slider') paintSlider(el as HTMLInputElement);
  }

  for (const el of qsa<HTMLInputElement | HTMLSelectElement>('[data-bind-ui]')) {
    el.addEventListener('change', () => {
      const n = findNode();
      if (!n) return;
      const k = el.dataset.bindUi!;
      if (k === 'node.bypass') mutate('bypass', () => { n.bypass = (el as HTMLInputElement).checked; });
      else if (k === 'node.enabled') mutate('enable', () => { n.enabled = (el as HTMLInputElement).checked; });
      else if (k === 'node.layout') mutate('layout', () => { graph().layout = (el as HTMLSelectElement).value as typeof graph extends never ? never : never; });
    });
  }
}

// --- wheels ---

/** Trackball maths: radius = value magnitude, angle = hue in wheel space. */
function wheelToRgb(angle: number, radius: number): RGB {
  const c = Math.cos(angle) * radius;
  const s = Math.sin(angle) * radius;
  // Rec.709 luma weights so the neutral axis stays a true grey.
  return [0.2126 * c + 0.7152 * s, 0.7152 * c + 0.2126 * s, 0.9278 * s - 0.2126 * c] as RGB;
}

function drawWheels(): void {
  const node = findNode();
  if (!node) return;
  const grade = node.grade as unknown;
  for (const canvas of qsa<HTMLCanvasElement>('[data-wheel-canvas]')) {
    const name = canvas.dataset.wheelCanvas!;
    const value = (getPath(grade, `primary.${name}`) ?? [0, 0, 0]) as RGB;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = 96;
    if (canvas.width !== size * dpr) { canvas.width = size * dpr; canvas.height = size * dpr; }
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 4;

    for (let ring = r; ring > 0; ring -= 1.5) {
      const a = (ring / r) * 2 * Math.PI;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, ring, 0, Math.PI * 2);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, ring);
      for (let i = 0; i <= 24; i += 1) {
        const [rr, gg, bb] = wheelToRgb((i / 24) * Math.PI * 2, 1);
        grad.addColorStop(i / 24, `rgb(${Math.round((0.5 + rr / 2) * 255)},${Math.round((0.5 + gg / 2) * 255)},${Math.round((0.5 + bb / 2) * 255)})`);
      }
      ctx.fillStyle = grad;
      ctx.globalAlpha = a > Math.PI ? 0.08 : 0.1;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Neutral inner disc: the centre is the "no lift" origin.
    const inner = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.34);
    inner.addColorStop(0, '#1a1a1a');
    inner.addColorStop(1, '#242424');
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.34, 0, Math.PI * 2);
    ctx.fillStyle = inner;
    ctx.fill();
    ctx.strokeStyle = '#3a3a3a';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Crosshair at the current value.
    const [vr, vg, vb] = value;
    const luma = 0.2126 * vr + 0.7152 * vg + 0.0722 * vb;
    const angle = Math.atan2(vb - luma, vr - luma);
    const mag = Math.hypot(vr - luma, vb - luma);
    const px = cx + Math.cos(angle) * mag * r;
    const py = cy - Math.sin(angle) * mag * r;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(px, py);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.strokeStyle = '#0d0d0d';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.strokeStyle = '#ff9d40';
    ctx.lineWidth = 1.25;
    ctx.stroke();
  }
}

function wireWheelDrag(): void {
  for (const canvas of qsa<HTMLCanvasElement>('[data-wheel-canvas]')) {
    const name = canvas.dataset.wheelCanvas!;
    let dragging = false;
    const apply = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      const mag = Math.min(1, Math.hypot(x, y) * 2);
      const ang = Math.atan2(-y, x);
      const rgb = wheelToRgb(ang, mag);
      const path = `primary.${name}`;
      const base = name === 'gamma' ? [1, 1, 1] : [0, 0, 0];
      setParam(path, [
        base[0] + rgb[0], base[1] + rgb[1], base[2] + rgb[2],
      ] satisfies RGB);
    };
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      canvas.setPointerCapture((e as PointerEvent).pointerId);
      apply(e as PointerEvent);
    });
    canvas.addEventListener('pointermove', (e) => { if (dragging) apply(e as PointerEvent); });
    canvas.addEventListener('pointerup', (e) => {
      dragging = false;
      canvas.releasePointerCapture((e as PointerEvent).pointerId);
    });
  }
}

// --- curves ---

type CurvePts = { x: number; y: number }[];

function drawCurves(): void {
  const node = findNode();
  if (!node) return;
  for (const canvas of qsa<HTMLCanvasElement>('[data-curve-canvas]')) {
    const channel = canvas.dataset.curveCanvas!;
    const pts = (getPath(node.grade as unknown, `curves.${channel}`) ?? []) as CurvePts;
    const size = 120;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== size * dpr) { canvas.width = size * dpr; canvas.height = size * dpr; }
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      const t = (i / 4) * size;
      ctx.beginPath(); ctx.moveTo(t, 0); ctx.lineTo(t, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, t); ctx.lineTo(size, t); ctx.stroke();
    }
    const color = channel === 'red' ? '#e04b4b' : channel === 'green' ? '#4bb07a' : channel === 'blue' ? '#4b7ae0' : '#f0f0f0';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = p.x * size;
      const y = (1 - p.y) * size;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = color;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x * size, (1 - p.y) * size, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function wireCurveDrag(): void {
  for (const canvas of qsa<HTMLCanvasElement>('[data-curve-canvas]')) {
    const channel = canvas.dataset.curveCanvas!;
    const path = `curves.${channel}`;
    const IDENTITY: CurvePts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

    const toCurve = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)),
      };
    };

    const read = (): CurvePts => {
      const v = getParam(path);
      return Array.isArray(v) && v.length >= 2 ? (structuredClone(v) as CurvePts) : structuredClone(IDENTITY);
    };

    // Nearest point by GRAPH distance, not by pixels: a 120x120 canvas holding
    // a full 0..1 curve means a fixed pixel radius is a wildly different
    // sensitivity in the middle of the curve than at the corners.
    const nearest = (pts: CurvePts, x: number, y: number, radius: number) => {
      let idx = -1;
      let best = radius;
      for (let i = 0; i < pts.length; i += 1) {
        const d = Math.hypot(pts[i]!.x - x, pts[i]!.y - y);
        if (d < best) { best = d; idx = i; }
      }
      return idx;
    };

    let dragIndex = -1;

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const { x, y } = toCurve(e);
      const pts = read();
      const hit = nearest(pts, x, y, 0.06);

      // Alt/right click removes an interior point; a curve cannot have fewer
      // than its two endpoints.
      if ((e.altKey || e.button === 2) && hit > 0 && hit < pts.length - 1) {
        pts.splice(hit, 1);
        setParam(path, pts);
        drawCurves();
        return;
      }

      if (hit >= 0) {
        dragIndex = hit;
      } else {
        // Insert. The previous version only searched interior points, so on a
        // fresh two-point curve `nearest` stayed -1 and the assignment wrote a
        // property literally named "-1" onto the array: clicking a curve did
        // nothing at all, which is the least discoverable possible failure.
        const at = { x, y };
        let i = 0;
        while (i < pts.length && pts[i]!.x < x) i += 1;
        pts.splice(i, 0, at);
        dragIndex = i;
        // Keep at least one point clear of each endpoint so the new point is
        // actually reachable by the mouse afterwards.
        if (i > 0) pts[i]!.x = Math.max(pts[i - 1]!.x + 0.01, x);
        if (i < pts.length - 1) pts[i]!.x = Math.min(pts[i + 1]!.x - 0.01, pts[i]!.x);
      }
      setParam(path, pts);
      drawCurves();
    });

    // Dragging is the interaction every NLE curve editor is built around; a
    // click-only editor cannot shape a curve at all.
    canvas.addEventListener('pointermove', (e) => {
      if (dragIndex < 0) return;
      e.preventDefault();
      const pts = read();
      if (dragIndex >= pts.length) return;
      const { x, y } = toCurve(e);
      const isFirst = dragIndex === 0;
      const isLast = dragIndex === pts.length - 1;
      // Endpoints keep their x: the curve must still span 0..1, which is what
      // makes black stay black and white stay white.
      const nx = isFirst ? 0 : isLast ? 1 : Math.max(0.01, Math.min(0.99, x));
      pts[dragIndex] = { x: nx, y };
      if (!isFirst && !isLast) {
        const lo = pts[dragIndex - 1]!.x + 0.01;
        const hi = pts[dragIndex + 1]!.x - 0.01;
        pts[dragIndex]!.x = Math.max(lo, Math.min(hi, nx));
      }
      setParam(path, pts);
      drawCurves();
    });

    const release = (e: PointerEvent) => {
      if (dragIndex < 0) return;
      dragIndex = -1;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('dblclick', () => {
      setParam(path, structuredClone(IDENTITY));
      drawCurves();
    });
  }
}

// ===========================================================================
// Scopes
// ===========================================================================

let lastScopes: ScopeData | null = null;

function scopeGrid(ctx: CanvasRenderingContext2D, w: number, hgt: number, graticule: 'lines' | 'circle' | 'bars'): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, hgt);
  ctx.strokeStyle = '#1c1c1c';
  ctx.lineWidth = 1;
  if (graticule === 'circle') {
    for (let i = 1; i <= 4; i += 1) {
      ctx.beginPath();
      ctx.arc(w / 2, hgt / 2, (Math.min(w, hgt) / 2) * (i / 4), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = '#2a2a2a';
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(w / 2, hgt / 2);
      ctx.lineTo(w / 2 + Math.cos(a) * (w / 2), hgt / 2 + Math.sin(a) * (hgt / 2));
      ctx.stroke();
    }
  } else if (graticule === 'bars') {
    for (let i = 0; i < w; i += 16) {
      ctx.strokeStyle = i % 64 === 0 ? '#2a2a2a' : '#161616';
      ctx.beginPath();
      ctx.moveTo(i + 0.5, 0);
      ctx.lineTo(i + 0.5, hgt);
      ctx.stroke();
    }
  } else {
    for (let i = 1; i < 4; i += 1) {
      const y = Math.round((i / 4) * hgt) + 0.5;
      ctx.strokeStyle = i === 2 ? '#2a2a2a' : '#161616';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }
}

function drawScopes(): void {
  const d = lastScopes;
  for (const canvas of qsa<HTMLCanvasElement>('[data-scope]')) {
    const name = canvas.dataset.scope!;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    const w = canvas.width;
    const hgt = canvas.height;
    const kind = name === 'vectorscope' ? 'circle' : name === 'parade' ? 'bars' : 'lines';
    scopeGrid(ctx, w, hgt, kind);

    if (!d) continue; // no analysed frame yet — leave the empty graticule
    if ((name === 'waveform' || name === 'parade') && d.waveform) {
      const seg = name === 'parade' ? d.waveform.width / 3 : d.waveform.width;
      const draw = (arr: Float32Array, color: string) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x < seg; x += 1) {
          const y = (1 - Math.min(1, arr[x] ?? 0)) * hgt;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };
      const off = name === 'parade' ? seg : 0;
      draw(d.waveform.r.subarray(off, off + seg), 'rgba(255,80,80,0.85)');
      draw(d.waveform.g.subarray(off, off + seg), 'rgba(80,255,120,0.85)');
      draw(d.waveform.b.subarray(off, off + seg), 'rgba(90,150,255,0.85)');
    } else if (name === 'histogram' && d.histogram) {
      const bins = d.histogram.bins;
      const bw = w / bins;
      const draw = (arr: Float32Array, color: string) => {
        ctx.fillStyle = color;
        for (let i = 0; i < bins; i += 1) {
          const v = Math.min(1, arr[i] ?? 0);
          ctx.fillRect(i * bw, hgt - v * hgt, Math.max(1, bw - 0.5), v * hgt);
        }
      };
      draw(d.histogram.r, 'rgba(255,70,70,0.5)');
      draw(d.histogram.g, 'rgba(70,255,120,0.5)');
      draw(d.histogram.b, 'rgba(90,140,255,0.5)');
      draw(d.histogram.l, 'rgba(255,255,255,0.35)');
    } else if (name === 'vectorscope' && d.vectorscope) {
      const px = d.vectorscope.r;
      const size = d.vectorscope.size;
      const img = ctx.createImageData(size, size);
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const si = (y * size + x) * 4;
          const di = ((y * hgt / size | 0) * w + (x * w / size | 0)) * 4;
          img.data[di] = px[si] ?? 0;
          img.data[di + 1] = px[si + 1] ?? 0;
          img.data[di + 2] = px[si + 2] ?? 0;
          img.data[di + 3] = 255;
        }
      }
      const off = document.createElement('canvas');
      off.width = size;
      off.height = size;
      off.getContext('2d')?.putImageData(img, 0, 0);
      ctx.drawImage(off, 0, 0, w, hgt);
    }
  }
}

// ===========================================================================
// Pipeline + render loop
// ===========================================================================

let pipeline: ColorPipelineLike | null = null;
let pipelineReady = false;
let lastAnalyze = 0;

async function bootPipeline(): Promise<ColorPipelineLike | null> {
  try {
    const { ColorPipeline } = await import('./gpu/pipeline.js');
    // The viewer canvas is the pipeline's render target: alpha off, and
    // preserveDrawingBuffer so readPixels() can probe a frame after the fact.
    const gl = viewerCanvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (gl) {
      pipeline = new ColorPipeline(gl, {
        outputSpace: project.settings.outputSpace,
        displayGamma: project.settings.outputGamma,
      }) as unknown as ColorPipelineLike;
      log(`ColorPipeline ready (${readPrecision(pipeline)})`, 'ok');
    } else {
      log('WebGL2 unavailable — viewer falling back to 2D', 'warn');
    }
  } catch (err) {
    log(`ColorPipeline unavailable: ${String(err)}`, 'warn');
  }
  if (!pipeline) {
    // 2D identity fallback: the shell still boots and the agent can still
    // drive state even where the GPU pipeline cannot run.
    const ctx2d = viewerCanvas.getContext('2d');
    if (ctx2d) pipeline = new NullPipeline(ctx2d);
  }
  pipelineReady = true;
  updatePrecisionStatus();
  return pipeline;
}

function readPrecision(p: ColorPipelineLike | null): string {
  if (!p) return '—';
  const v = p.precision;
  if (typeof v === 'function') { try { return v(); } catch { return '—'; } }
  return v ?? '—';
}

function updatePrecisionStatus(): void {
  const p = readPrecision(pipeline);
  state.precision = p;
  statusEl.precision.textContent = p;
  // 8-bit sources silently band in the 32-bit float pipeline; flag it rather
  // than let the agent believe it is grading at full precision.
  statusEl.precision.dataset.warn = /8|byte|unorm/i.test(p) ? '1' : '0';
}

// --- video decode ---

let seekPending = -1;

function seekVideo(frame: number): void {
  if (!decodeVideo.src) return;
  const t = frame / project.timeline.fps;
  if (Math.abs(decodeVideo.currentTime - t) < 1 / (project.timeline.fps * 2)) return;
  seekPending = frame;
  try { decodeVideo.currentTime = Math.max(0, t); } catch { /* metadata not ready */ }
}

function toggleVideo(playing: boolean): void {
  if (!decodeVideo.src) return;
  if (playing) void decodeVideo.play().catch(() => { /* autoplay blocked — seek loop still runs */ });
  else decodeVideo.pause();
}

decodeVideo.addEventListener('seeked', () => { seekPending = -1; });

// --- loop ---

const raf: (cb: (t: number) => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number;

let lastTick = 0;
let fpsEma = 0;

function frame(now: number): void {
  raf(frame);
  const dt = lastTick ? Math.min(0.25, (now - lastTick) / 1000) : 0;
  lastTick = now;
  if (dt > 0) fpsEma = fpsEma ? fpsEma * 0.9 + (1 / dt) * 0.1 : 1 / dt;
  state.fps = fpsEma;
  statusEl.fps.textContent = fpsEma.toFixed(1);
  statusEl.fps.dataset.warn = fpsEma < 24 ? '1' : '0';

  if (state.playing) advancePlayback(dt);
  renderViewer(now);
}

function advancePlayback(dt: number): void {
  const tl = project.timeline;
  const total = timelineDuration();
  const lo = tl.outPoint > tl.inPoint ? tl.inPoint : 0;
  const hi = tl.outPoint > tl.inPoint ? tl.outPoint : total;

  // A playing <video> owns its own clock. Following the element beats
  // re-seeking it every frame: a seek per rAF cancels the decoder's own
  // pipeline, so the picture stalls on one frame while the playhead runs.
  const mediaDriven = decodeVideo.src !== '' && !decodeVideo.paused && !decodeVideo.ended
    && decodeVideo.readyState >= 2;
  let next: number;
  if (mediaDriven) {
    next = Math.round(decodeVideo.currentTime * tl.fps);
  } else {
    next = tl.playhead + dt * tl.fps;
  }

  if (next >= hi) {
    if (state.loop) {
      next = lo;
      if (decodeVideo.src) { try { decodeVideo.currentTime = lo / tl.fps; } catch { /* not seekable yet */ } }
    } else {
      next = hi;
      pause();
      toggleVideo(false);
    }
  }
  tl.playhead = next;
  updatePlayheadDom();
  // Only drive the element when it is NOT the clock source.
  if (!mediaDriven) seekVideo(next);
}

function paintViewer(): void {
  if (!pipelineReady || !pipeline) return;
  // Keyframes are resolved inside render(), per node, from the current frame.
  // A scrub therefore lands on exactly the grade that is displayed.
  pipeline.render(graph(), viewerSource, viewerCanvas.width, viewerCanvas.height, project.timeline.playhead);
}

function renderViewer(now: number): void {
  if (!pipelineReady) return;
  const frameNo = project.timeline.playhead;
  pipeline?.render(graph(), viewerSource, viewerCanvas.width, viewerCanvas.height, frameNo);

  // Scope analysis is a GPU readback; ~15 Hz is plenty and keeps playback smooth.
  if (pipeline?.analyze && now - lastAnalyze > 66) {
    lastAnalyze = now;
    try {
      lastScopes = pipeline.analyze() ?? null;
      drawScopes();
    } catch { /* analysis is best-effort and must never stall playback */ }
  }
}

// ===========================================================================
// Page switching
// ===========================================================================

function gotoPage(page: PageId, opts: { silent?: boolean } = {}): PageId {
  if (!PAGES.includes(page as PageId)) {
    log(`unknown page ${String(page)}`, 'err');
    return project.page;
  }
  project.page = page;
  app.dataset.page = page;
  q('#workspace').dataset.page = page;
  for (const btn of qsa<HTMLButtonElement>('[data-page]')) {
    const on = btn.dataset.page === page && btn.classList.contains('page-btn');
    btn.setAttribute('aria-selected', String(on));
  }
  statusEl.page.textContent = PAGE_LABEL[page];
  if (!opts.silent) log(`page → ${PAGE_LABEL[page]}`, 'cmd');
  // Canvas backings are sized from CSS boxes; a page switch can change them.
  requestAnimationFrame(() => { drawNodeEdges(); drawRuler(); });
  return page;
}

function setPanelVisible(panel: 'scopes' | 'nodes' | 'panels', visible: boolean): void {
  const el = panel === 'scopes' ? q('#scopes') : panel === 'nodes' ? q('#node-editor') : q('#panels');
  el.dataset.visible = visible ? '1' : '0';
  state.panelsVisible[panel] = visible;
  log(`${panel} ${visible ? 'shown' : 'hidden'}`, 'ok');
}

// ===========================================================================
// Sync
// ===========================================================================

function syncAll(): void {
  renderMediaPool();
  renderTimeline();
  renderNodes();
  syncControls();
  updateMarkers();
  updatePlayheadDom();
  updatePrecisionStatus();
  // Every mutation lands here, so the header buttons read the real stack
  // depths from here. They used to be synced once at wire time and then go
  // stale — and a stale `disabled` plus `pointer-events: none` means the click
  // is swallowed before the handler ever runs, which is why the undo button
  // looked present and did nothing.
  syncUndoButtons();
  syncFlipButtons();
  syncEditTools();
  statusEl.space.textContent = project.settings.workingSpace;
  q('#menubar-project').textContent = project.settings.name;
}

// ===========================================================================
// Wiring: page switcher, transport, menus, media, keyboard
// ===========================================================================

function wirePageSwitcher(): void {
  for (const btn of qsa<HTMLButtonElement>('.page-btn')) {
    btn.addEventListener('click', () => gotoPage(btn.dataset.page as PageId));
  }
}

/**
 * Reflect the flip state in the buttons, and keep undo's availability honest.
 *
 * A permanently-enabled undo button is worse than none: it teaches you that
 * some presses do nothing. These read the real stack depths instead.
 */
function syncFlipButtons(): void {
  const cur = pipeline?.getUserFlip?.() ?? { x: false, y: false };
  for (const btn of qsa<HTMLElement>('[data-flip="x"]')) {
    btn.setAttribute('aria-pressed', String(cur.x));
  }
  for (const btn of qsa<HTMLElement>('[data-flip="y"]')) {
    btn.setAttribute('aria-pressed', String(cur.y));
  }
  const any = cur.x || cur.y;
  for (const btn of qsa<HTMLButtonElement>('[data-flip="reset"]')) {
    btn.disabled = !any;
    btn.style.opacity = any ? '' : '0.4';
  }
}

function syncUndoButtons(): void {
  for (const btn of qsa<HTMLButtonElement>('.viewer-tools [data-cmd]')) {
    const depth = btn.dataset.cmd === 'undo' ? undoStack.length : redoStack.length;
    btn.disabled = depth === 0;
  }
}

/**
 * The edit verbs in the timeline toolbar.
 *
 * Every one of these routes through the same function the agent command and
 * the keyboard shortcut use, so the button, the menu item and the bot cannot
 * drift apart. Each reports through the log when it refuses, rather than
 * leaving the user wondering whether the click registered.
 */
function wireEditTools(): void {
  for (const btn of qsa<HTMLButtonElement>('[data-edit]')) {
    btn.addEventListener('click', () => {
      const verb = btn.dataset.edit!;
      const tl = project.timeline;
      switch (verb) {
        case 'split':
          if (!split()) log('split: put the playhead inside a clip', 'warn');
          break;
        case 'ripple_delete': {
          const removed = rippleDelete();
          if (removed.length === 0) log('ripple delete: select a clip first', 'warn');
          break;
        }
        case 'lift_clip': {
          const removed = liftClip();
          if (removed.length === 0) log('lift: select a clip first', 'warn');
          break;
        }
        case 'insert_clip':
        case 'overwrite_clip': {
          // Media comes from the pool selection, falling back to the first
          // clip; the track is whichever one holds the selected timeline clip.
          const onTrack = targetClip()?.trackId;
          const mediaId = (state.selectedClipId
            ?? targetClip()?.mediaId
            ?? (project.mediaPool[0] as { id?: string } | undefined)?.id) as string | undefined;
          const trackId = (onTrack ?? tl.tracks.find((t) => t.kind === 'video')?.id ?? tl.tracks[0]?.id) as string | undefined;
          if (!mediaId) { log(`${verb}: no media in the pool`, 'warn'); break; }
          if (!trackId) { log(`${verb}: no track`, 'warn'); break; }
          const made = insertClip(mediaId, trackId, tl.playhead, verb === 'insert_clip' ? 'insert' : 'overwrite');
          if (!made) log(`${verb}: refused — not enough room, or the track is locked`, 'warn');
          break;
        }
        case 'duplicate_clip':
          if (!duplicateClip()) log('duplicate: select a clip first', 'warn');
          break;
        case 'move_left':
        case 'move_right': {
          const delta = (verb === 'move_left' ? -1 : 1) * Math.max(1, Math.round(project.timeline.fps));
          if (!moveClip(undefined, delta, 'ripple')) log('move: select a clip first', 'warn');
          break;
        }
        case 'add_track':
          if (!addTrack()) log('add track: could not add one', 'warn');
          break;
        default: break;
      }
      syncEditTools();
    });
  }
  syncEditTools();
}

/** Grey out the verbs that have nothing to act on, so the toolbar reads as a
 *  state display as well as a set of buttons. */
function syncEditTools(): void {
  const tl = project.timeline;
  const hasClip = !!targetClip();
  const hasMedia = project.mediaPool.length > 0;
  const needsClip = (v: string) => v === 'ripple_delete' || v === 'lift_clip' || v === 'duplicate_clip'
    || v === 'move_left' || v === 'move_right';
  for (const btn of qsa<HTMLButtonElement>('[data-edit]')) {
    const v = btn.dataset.edit!;
    const needsMedia = v === 'insert_clip' || v === 'overwrite_clip';
    btn.disabled = needsClip(v) ? !hasClip : needsMedia ? !hasMedia : false;
  }
}

function wireTransport(): void {
  const tl = project.timeline;
  q('#transport').addEventListener('click', (e) => {
    const cmd = (e.target as HTMLElement).closest<HTMLElement>('[data-transport]')?.dataset.transport;
    switch (cmd) {
      case 'play': togglePlay(); break;
      case 'home': setPlayhead(0); break;
      case 'end': setPlayhead(timelineDuration()); break;
      case 'step_back': stepPlayhead(-1); break;
      case 'step_fwd': stepPlayhead(1); break;
      case 'loop':
        state.loop = !state.loop;
        (e.target as HTMLElement).setAttribute('aria-pressed', String(state.loop));
        break;
      default: break;
    }
  });

  // Picture flip / mirror, and the undo pair, in the viewer header.
  //
  // Flip is a display-stage transform, so it deliberately does not push an
  // undo entry: it changes what you are looking at, not the project, and
  // stepping back through history to undo a mirror would be baffling. Undo is
  // wired to the same functions the keyboard shortcut uses, so a button and
  // ⌘Z can never disagree.
  qsa<HTMLElement>('[data-flip]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.flip;
      const cur = pipeline?.getUserFlip?.() ?? { x: false, y: false };
      if (which === 'reset') pipeline?.setUserFlip?.(false, false);
      else if (which === 'x') pipeline?.setUserFlip?.(!cur.x, cur.y);
      else if (which === 'y') pipeline?.setUserFlip?.(cur.x, !cur.y);
      syncFlipButtons();
      paintViewer();
    });
  });

  qsa<HTMLButtonElement>('.viewer-tools [data-cmd]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.cmd === 'undo') undo();
      else if (btn.dataset.cmd === 'redo') redo();
      syncUndoButtons();
    });
  });
  syncFlipButtons();
  syncUndoButtons();

  q('#zoom').addEventListener('input', (e) => {
    state.zoom = Number((e.target as HTMLInputElement).value);
    renderTimeline();
  });

  rulerHost.addEventListener('pointerdown', (e) => {
    const r = rulerHost.getBoundingClientRect();
    setPlayhead(xToFrame((e as PointerEvent).clientX - r.left));
  });
}

function wireMediaImport(): void {
  const input = q<HTMLInputElement>('#file-input');
  input.addEventListener('change', () => {
    const files = input.files;
    if (files && files.length > 0) void importFiles(files);
    input.value = '';
  });
  qo('[data-action="import"]')?.addEventListener('click', () => input.click());
  qo('[data-action="new-bin"]')?.addEventListener('click', () => {
    mutate('newBin', () => {
      const bin: Bin = { id: newId('bin'), name: `Bin ${project.bins.length}`, parent: null, clipIds: [] };
      project.bins.push(bin);
      state.activeBinId = bin.id;
    });
  });
  for (const b of qsa<HTMLElement>('[data-view]')) {
    b.addEventListener('click', () => {
      state.mediaView = b.dataset.view as 'grid' | 'list';
      for (const o of qsa<HTMLElement>('[data-view]')) o.classList.toggle('is-on', o === b);
      renderMediaPool();
    });
  }

  const dropzone: HTMLElement = qo<HTMLElement>('[data-dropzone="media-pool"]') ?? q<HTMLElement>('#media-pool');
  const pool = q<HTMLElement>('#media-pool');
  for (const target of [dropzone, pool]) {
    target.addEventListener('dragover', (e) => {
      // Only intercept drops that carry files; clip drags are handled by lanes.
      const ev = e as DragEvent;
      if (!ev.dataTransfer?.types.includes('Files')) return;
      ev.preventDefault();
      dropzone.dataset.dropActive = '1';
    });
    target.addEventListener('dragleave', (e) => {
      if (e.target === target) dropzone.dataset.dropActive = '0';
    });
    target.addEventListener('drop', (e) => {
      const ev = e as DragEvent;
      const files = ev.dataTransfer?.files;
      if (!files || files.length === 0) return;
      ev.preventDefault();
      dropzone.dataset.dropActive = '0';
      void importFiles(files);
    });
  }

  const tlZone = q<HTMLElement>('[data-dropzone="timeline"]');
  tlZone.addEventListener('dragover', (e) => {
    if ((e as DragEvent).dataTransfer?.types.includes('Files')) e.preventDefault();
  });
}

function wireMenus(): void {
  let open: HTMLElement | null = null;
  for (const menu of qsa<HTMLElement>('.menu')) {
    const title = q<HTMLButtonElement>('.menu-title', menu);
    const close = () => { menu.dataset.open = '0'; title.setAttribute('aria-expanded', 'false'); };
    const show = () => {
      closeAll();
      menu.dataset.open = '1';
      title.setAttribute('aria-expanded', 'true');
      open = menu;
    };
    title.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.dataset.open === '1' ? close() : show();
    });
    title.addEventListener('mouseenter', () => { if (open && open !== menu) show(); });
    for (const item of qsa<HTMLElement>('[data-cmd]', menu)) {
      item.addEventListener('click', () => {
        close();
        runCommand(item.dataset.cmd!, item.dataset);
      });
    }
  }
  document.addEventListener('click', closeAll);
  function closeAll(): void {
    if (!open) return;
    qo('.menu-title', open)?.setAttribute('aria-expanded', 'false');
    open.dataset.open = '0';
    open = null;
  }
}

/** Menu items funnel through the same command names the agent uses. */
function runCommand(cmd: string, data: DOMStringMap | Record<string, string | undefined>): void {
  switch (cmd) {
    case 'import_media': q<HTMLInputElement>('#file-input').click(); break;
    case 'save_project': log('save_project: project lives in memory only in this shell', 'warn'); break;
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'copy': log('copy: grade copied to the internal clipboard', 'ok'); break;
    case 'paste': log('paste: no clipboard grade yet', 'warn'); break;
    case 'trim_in': setIn(); break;
    case 'trim_out': setOut(); break;
    case 'trim_clip': trimToPlayhead(); break;
    case 'add_track': addTrack(); break;
    case 'delete_track': deleteTrack(); break;
    case 'enable_clip': toggleClipEnabled(); break;
    case 'split': split(); break;
    case 'reset_grade': { const n = findNode(); if (n) mutate('resetGrade', () => { n.grade = defaultGrade(); }); break; }
    case 'add_node': addNode('serial'); break;
    case 'add_parallel': addNode('parallel'); break;
    case 'auto_balance': log('auto_balance: owned by the pipeline workstream', 'warn'); break;
    case 'mark_in': setIn(); break;
    case 'mark_out': setOut(); break;
    case 'add_marker': log(`marker @ ${project.timeline.playhead}`, 'ok'); break;
    case 'toggle_scopes': setPanelVisible('scopes', !state.panelsVisible.scopes); break;
    case 'toggle_nodes': setPanelVisible('nodes', !state.panelsVisible.nodes); break;
    case 'toggle_console': toggleConsole(); break;
    case 'play': togglePlay(true); break;
    case 'pause': togglePlay(false); break;
    case 'step_back': stepPlayhead(-1); break;
    case 'step_fwd': stepPlayhead(1); break;
    case 'gotoPage': gotoPage(data.page as PageId); break;
    case 'layout_color': gotoPage('color'); break;
    case 'layout_edit': gotoPage('edit'); break;
    case 'layout_media': gotoPage('media'); break;
    case 'normalize_audio': log('normalize_audio: Fairlight is not wired in this shell', 'warn'); break;
    case 'shortcuts':
      log('shortcuts: space=play/pause  i/o=in/out  a=add node  s=split  ⌘Z/⇧⌘Z=undo/redo  `=console', 'ok');
      toggleConsole(true);
      break;
    case 'about': log('hermes-resolve 0.1 — agent-drivable Resolve clone', 'ok'); break;
    default: log(`unknown command ${cmd}`, 'warn');
  }
}

function addTrack(): Track | null {
  const kinds: Track['kind'][] = ['video', 'audio'];
  const kind = kinds[project.timeline.tracks.length % 2]!;
  const track: Track = {
    id: newId(kind),
    kind,
    index: project.timeline.tracks.length + 1,
    name: `${kind === 'video' ? 'V' : 'A'}${project.timeline.tracks.filter((t) => t.kind === kind).length + 1}`,
    locked: false,
    muted: false,
    height: 34,
  };
  mutate('addTrack', () => { project.timeline.tracks.push(track); });
  return track;
}

function deleteTrack(): boolean {
  const tl = project.timeline;
  if (tl.tracks.length <= 1) return false;
  mutate('deleteTrack', () => {
    const last = tl.tracks[tl.tracks.length - 1]!;
    tl.tracks.pop();
    tl.clips = tl.clips.filter((c) => c.trackId !== last.id);
  });
  return true;
}

function toggleClipEnabled(): boolean {
  const c = project.timeline.clips.find((x) => x.id === state.selectedTimelineClipId);
  if (!c) return false;
  mutate('toggleClip', () => { c.enabled = !c.enabled; });
  renderTimeline();
  return c.enabled;
}

function trimToPlayhead(): boolean {
  const c = project.timeline.clips.find((x) => x.id === state.selectedTimelineClipId);
  if (!c) return false;
  const ph = project.timeline.playhead;
  if (ph <= c.start || ph >= c.start + (c.outFrame - c.inFrame)) return false;
  split();
  return true;
}

function wireKeyboard(): void {
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    const meta = e.metaKey || e.ctrlKey;

    if (meta && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    // The console focuses its own input when it opens, so its toggle keys must
    // still work from inside that field or the drawer can never be closed.
    if (typing) {
      if (e.key === 'Escape') (t as HTMLElement).blur();
      if (e.key === '`') {
        e.preventDefault();
        toggleConsole(false);
      }
      return;
    }
    if (meta) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'i': case 'I': setIn(); break;
      case 'o': case 'O': setOut(); break;
      case 'a': case 'A': addNode(e.shiftKey ? 'parallel' : 'serial'); break;
      case 's': case 'S': split(); break;
      case '`': e.preventDefault(); toggleConsole(); break;
      case 'ArrowLeft': e.preventDefault(); stepPlayhead(e.shiftKey ? -10 : -1); break;
      case 'ArrowRight': e.preventDefault(); stepPlayhead(e.shiftKey ? 10 : 1); break;
      case 'Home': setPlayhead(0); break;
      case 'End': setPlayhead(timelineDuration()); break;
      case 'Escape': if (agentConsoleEl.dataset.open === '1') toggleConsole(false); break;
      default: break;
    }
  });
}

function wireAgentConsole(): void {
  qo('[data-action="close-console"]')?.addEventListener('click', () => toggleConsole(false));
  qo('[data-action="clear-log"]')?.addEventListener('click', () => {
    agentLog.replaceChildren();
    logCount = 0;
    q('#agent-count').textContent = '0';
  });
  q<HTMLFormElement>('#agent-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = q<HTMLInputElement>('#agent-input');
    const raw = input.value.trim();
    if (!raw) return;
    input.value = '';
    try {
      const cmd = JSON.parse(raw) as { cmd?: string; [k: string]: unknown };
      if (!cmd.cmd) throw new Error('missing "cmd"');
      runCommand(cmd.cmd, cmd as unknown as Record<string, string | undefined>);
    } catch (err) {
      log(`parse error: ${String(err)}`, 'err');
    }
  });
}

function wirePanels(): void {
  for (const d of qsa<HTMLDetailsElement>('.cp')) {
    // Collapsed panels are exactly the ones you never look at twice — but an
    // agent-set parameter must still be visible, so we persist open state.
    const key = `hr.cp.${d.dataset.panel}`;
    d.open = localStorage.getItem(key) !== '0';
    d.addEventListener('toggle', () => {
      try { localStorage.setItem(key, d.open ? '1' : '0'); } catch { /* private mode */ }
    });
  }
  for (const el of qsa<HTMLElement>('[data-action="reset-grade"]')) {
    el.addEventListener('click', () => { const n = findNode(); if (n) mutate('resetGrade', () => { n.grade = defaultGrade(); }); });
  }
  for (const el of qsa<HTMLElement>('[data-action="auto-balance"]')) {
    el.addEventListener('click', () => log('auto_balance: owned by the pipeline workstream', 'warn'));
  }
  for (const el of qsa<HTMLElement>('[data-node-cmd]')) {
    el.addEventListener('click', () => {
      const cmd = el.dataset.nodeCmd!;
      const n = findNode();
      if (cmd === 'add') addNode('serial');
      if (cmd === 'parallel') addNode('parallel');
      if (cmd === 'serial' && n) {
        const g = graph();
        mutate('makeSerial', () => {
          g.edges = g.edges.filter(([a, b]) => a !== n.id && b !== n.id);
          if (g.outputNodeId && g.outputNodeId !== n.id) g.edges.push([g.outputNodeId, n.id]);
          g.outputNodeId = n.id;
          n.kind = 'serial';
        });
      }
      if (cmd === 'bypass' && n) mutate('bypass', () => { n.bypass = !n.bypass; });
      if (cmd === 'delete' && n) removeNode(n.id);
    });
  }
}

// ===========================================================================
// Agent API — published synchronously, safe to call headlessly
// ===========================================================================

export interface ResolveAgentApi {
  project: Project;
  pipeline: ColorPipelineLike | null;
  /** Resolves once WebGL/pipeline init has settled. */
  ready: Promise<ColorPipelineLike | null>;
  setPlayhead(frame: number): number;
  play(): boolean;
  pause(): boolean;
  gotoPage(page: PageId | string): PageId;
  /** Positional (kind, label) or the bridge's ({ label, kind, after }) form. */
  addNode(kind?: NodeKind | AddNodeOpts, label?: string): GraphNode | null;
  /** (path, value, nodeId?) or the bridge's (id, path, value) form. */
  setParam(path: string, value?: unknown, nodeId?: unknown): boolean;
  undo(): boolean;
  redo(): boolean;
  getState(): Record<string, unknown>;
  // Secondary entry points the agent needs for a full edit session.
  removeNode(id: string): boolean;
  connectNodes(from: string, to: string): boolean;
  importFiles(files: File[] | FileList): Promise<MediaClip[]>;
  selectClip(id: string | null): MediaClip | null;
  selectNode(id: string): void;
  appendToTrack(trackId: string, mediaId: string, atFrame: number): TimelineClip | null;
  split(): boolean;
  trimToPlayhead(): boolean;
  /**
   * The basic edit verbs. Each returns what it acted on, or null / an empty
   * array / false when it refused — so a caller can tell "did nothing" from
   * "was refused", which is the distinction a bot driving a timeline needs.
   */
  /** Remove a clip and pull the rest of its track left. */
  rippleDelete(clipId?: string): string[];
  /** Remove a clip and leave a gap where it was. */
  liftClip(clipId?: string): string[];
  /** 'insert' pushes the tail along; 'overwrite' replaces the frames it covers. */
  insertClip(mediaId: string, trackId: string, frame?: number, mode?: 'insert' | 'overwrite'): TimelineClip | null;
  /** Copy the selected clip directly after itself. */
  duplicateClip(clipId?: string): TimelineClip | null;
  /** Slide along the track: 'ripple' moves the tail, 'slide' opens a gap. */
  moveClip(clipId: string | undefined, delta: number, mode?: 'ripple' | 'slide'): boolean;
  /** Trim one end to an absolute timeline frame. */
  trimClip(clipId: string | undefined, edge: 'start' | 'end', frame: number): boolean;
  /** Add a track; the existing implementation alternates video and audio. */
  addTrack(): Track | null;

  setClipEnabled(clipId: string, enabled: boolean): boolean;
  setIn(): number;
  setOut(): number;
  stepPlayhead(frames: number): number;
  setLoop(enabled: boolean): boolean;
  getParam(path: string, nodeId?: string): unknown;
  readPixel(x: number, y: number): ArrayLike<number> | null;
  saveProject(path?: string): boolean;
  log(message: string, level?: 'cmd' | 'ok' | 'warn' | 'err'): void;
}

/** Single display-referred RGBA pixel probe, the agent's `read_pixel`. */
function readPixel(x: number, y: number): ArrayLike<number> | null {
  const p = pipeline;
  if (!p) return null;
  if (p.readPixels) {
    try { return p.readPixels(x, y, 1, 1); } catch { return null; }
  }
  // Fallback for a pipeline without a readback: sample the default framebuffer.
  const gl = viewerCanvas.getContext('webgl2');
  if (!gl) return null;
  const buf = new Float32Array(4);
  try {
    // GL's origin is bottom-left; the agent's is top-left like the viewer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x, viewerCanvas.height - y, 1, 1, gl.RGBA, gl.FLOAT, buf);
    return buf;
  } catch { return null; }
}

function getState(): Record<string, unknown> {
  const n = findNode();
  return {
    page: project.page,
    version: project.version,
    playhead: project.timeline.playhead,
    playing: state.playing,
    inPoint: project.timeline.inPoint,
    outPoint: project.timeline.outPoint,
    durationFrames: timelineDuration(),
    fps: project.timeline.fps,
    renderFps: Number(fpsEma.toFixed(1)),
    precision: readPrecision(pipeline),
    pipelineReady,
    workingSpace: project.settings.workingSpace,
    outputSpace: project.settings.outputSpace,
    selectedClipId: state.selectedClipId,
    selectedTimelineClipId: state.selectedTimelineClipId,
    selectedNodeId: n?.id ?? null,
    nodes: graph().nodes.map((x) => ({ id: x.id, index: x.index, label: x.label, kind: x.kind, bypass: Boolean(x.bypass), enabled: x.enabled })),
    outputNodeId: graph().outputNodeId,
    media: project.mediaPool.map((m) => ({ id: m.id, name: m.name, kind: m.kind, frames: m.durationFrames, w: m.width, h: m.height })),
    bins: project.bins.map((b) => ({ id: b.id, name: b.name, clips: b.clipIds.length })),
    tracks: project.timeline.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, clips: project.timeline.clips.filter((c) => c.trackId === t.id).length })),
    timelineClips: project.timeline.clips.map((c) => ({ id: c.id, mediaId: c.mediaId, trackId: c.trackId, start: c.start, in: c.inFrame, out: c.outFrame, enabled: c.enabled })),
    undoDepth: undoStack.length,
    redoDepth: redoStack.length,
  };
}

const readyPromise = bootPipeline();

const api: ResolveAgentApi = {
  project,
  get pipeline() { return pipeline; },
  ready: readyPromise,
  setPlayhead: (frame) => setPlayhead(frame),
  play,
  pause,
  gotoPage: (page) => gotoPage(page as PageId),
  addNode: (kind = 'serial', label) => addNode(kind, label),
  setParam: (path, value, nodeId) => setParam(path, value, nodeId),
  undo,
  redo,
  getState,
  removeNode,
  connectNodes,
  importFiles,
  selectClip,
  selectNode,
  appendToTrack,
  split,
  trimToPlayhead,
  rippleDelete,
  liftClip,
  insertClip,
  duplicateClip,
  moveClip,
  trimClip,
  addTrack,
  setClipEnabled: (clipId, enabled) => setClipEnabled(clipId, enabled),
  setIn,
  setOut,
  stepPlayhead,
  setLoop,
  getParam,
  readPixel,
  saveProject,
  log,
};

declare global {
  interface Window {
    __resolve: ResolveAgentApi;
  }
}

// Published before any async work so a headless caller never races boot.
window.__resolve = api;

// ===========================================================================
// Go
// ===========================================================================

function main(): void {
  // The WebGL path owns the viewer canvas; never also hand out a 2D context.
  wirePageSwitcher();
  wireTransport();
  wireEditTools();
  wireMediaImport();
  wireMenus();
  wireKeyboard();
  wireAgentConsole();
  wirePanels();
  wireControls();
  wireWheelDrag();
  wireCurveDrag();
  renderRuler();

  gotoPage(project.page, { silent: true });
  syncAll();
  drawScopes();

  window.addEventListener('resize', () => {
    drawRuler();
    drawNodeEdges();
  });
  window.addEventListener('beforeunload', () => pipeline?.dispose?.());

  // A fresh project has no clip yet, so there is no source to size from — but
  // the fallback must be the PROJECT resolution, never the window size. Sizing
  // the drawing buffer from clientWidth gave a 3840x2160 buffer for a 480x320
  // clip, so the picture sat in a letterbox and every agent probe aimed at the
  // black border instead of the image. CSS scales the element to fit; the
  // backing store stays 1:1 with the frame so coordinates mean something.
  updateStatusRes(1920, 1080);

  app.dataset.ready = '1';
  log('hermes-resolve ready — press ` for the agent console', 'ok');
  raf(frame);
}

main();
