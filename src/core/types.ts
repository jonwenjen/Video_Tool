/**
 * Core type contract for the Resolve-like NLE.
 * Every parallel workstream imports from here — treat as the shared ABI.
 */

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** 3-channel linear value. */
export type RGB = [number, number, number];

/** Working colour spaces. AP1 is Resolve's default timeline space. */
export type WorkingSpace =
  | 'timeline-linear'   // AP1, scene linear, 32-bit float (default)
  | 'timeline-gamma'    // AP1 with gamma 2.4 encoding (Rec.709-like)
  | 'srgb'
  | 'display-p3';

export type OutputSpace = 'Rec.709' | 'Rec.2020' | 'sRGB' | 'Display P3';

/** A keyframe-able scalar: either a constant or a track of keys. */
export type Animated<T> = T | KeyframeTrack<T>;

export interface Keyframe<T = number> {
  /** Frame (on the timeline, 0-based) */
  frame: number;
  value: T;
  /** 'linear' | 'ease' | 'hold' | 'ease-in' | 'ease-out' */
  interp?: Interp;
}

export type KeyframeTrack<T = number> = Keyframe<T>[];

export type Interp = 'linear' | 'ease' | 'hold' | 'ease-in' | 'ease-out';

// ---------------------------------------------------------------------------
// Node graph (Color page)
// ---------------------------------------------------------------------------

export type NodeKind = 'corrector' | 'serial' | 'parallel' | 'note' | 'group' | 'key';

export type NodeLayout = 'auto' | 'horizontal' | 'vertical' | 'top';

export interface Node {
  id: string;
  label: string;
  kind: NodeKind;
  /** Node index in the graph (1-based, matches Resolve's UI). */
  index: number;
  grade: GradeState;
  enabled: boolean;
  /** For serial nodes: [leftInputId, rightInputId] */
  inputs: (string | null)[];
  /** UI position in graph space, for drag persistence. */
  pos?: { x: number; y: number };
  /** Bypass this node's own grade but keep it in the chain. */
  bypass?: boolean;
  /** Colour-management override for this node only. */
  cmOverride?: boolean;
}

export interface Graph {
  nodes: Node[];
  /** Directed edges as node-id pairs. */
  edges: [string, string][];
  outputNodeId: string | null;
  layout: NodeLayout;
}

// ---------------------------------------------------------------------------
// Grade state — the heart of the Color page
// ---------------------------------------------------------------------------

export interface PrimaryState {
  /** Colour wheels, each RGB in scene-linear-ish wheel space, -1..1 */
  lift: RGB;        // shadows
  gamma: RGB;       // midtones
  gain: RGB;        // highlights
  offset: RGB;      // master pedestal
  /** Log-style tonemap controls that Resolve exposes under primaries */
  contrast: number;   // 0.5..1.5, default 1
  pivot: number;     // 0.1..0.9, default 0.435
  brightness: number;// -0.5..0.5, default 0
  saturation: number;// 0..2, default 1
  hue: number;       // degrees -180..180, default 0
  colourBoost: number; // 0..1, default 0
  /** Midtone detail-ish contrast split (Resolve's Contrast split control) */
  contrastLow: number;  // 0..1, default 0
  contrastHigh: number; // 0..1, default 0
  /** Shadows / midtones / highlights pivots */
  shadowBias: number;   // -0.5..0.5
  highlightBias: number;// -0.5..0.5
  /** Colour temperature & tint in mired-ish units */
  temperature: number;  // -100..100, default 0
  tint: number;         // -100..100, default 0
  /** Vibrance (saturation weighted by inverse current saturation) */
  vibrance: number;     // -1..1, default 0
}

export type CurveChannel = 'r' | 'g' | 'b' | 'rgb';

export interface CurvePoint {
  x: number; // 0..1 input
  y: number; // 0..1 output
}

export interface CurvesState {
  master: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
  /** Resolve: custom curves vs pre-defined */
  mode: 'custom' | 'preset';
}

/** HSL qualifier — the isolate-a-colour tool. */
export interface QualifierState {
  enabled: boolean;
  hue: number;      // 0..1 centre
  hueWidth: number; // 0..0.5
  hueSoft: number;  // 0..0.5
  satLow: number;   // 0..1
  satHigh: number;  // 0..1
  lumLow: number;   // 0..1
  lumHigh: number;  // 0..1
  balance: number;  // -1..1 hue bias
  /** Resolve's Key/Show isolation */
  view: 'matte' | 'overlay' | 'no-key';
  /** How much of the non-keyed image survives */
  desaturateOutside: number; // 0..1
  denoise: number;  // 0..1
  /** Blur the matte edges */
  matteBlur: number; // 0..1
  invert: boolean;
  /** Restrict qualifier to only the region inside the window */
  windowRestrict: boolean;
}

export type WindowShape = 'ellipse' | 'rectangle' | 'linear' | 'poly' | 'none';

export interface WindowState {
  enabled: boolean;
  shape: WindowShape;
  /** Centre in normalised 0..1 viewer space */
  cx: number;
  cy: number;
  /** Radius / size */
  w: number;
  h: number;
  angle: number;   // degrees
  softness: number;// 0..1
  /** Gaussian-ish feather of the outer edge */
  feather: number; // 0..1
  invert: boolean;
  /** Mask the window but keep the grade outside too (instead of keying out) */
  mix: number; // 0..1 blend of graded vs original inside window
}

export interface KeyState {
  enabled: boolean;
  /** Chroma key: sample the key colour in RGBA 0..1 */
  keyColor: RGB;
  /** Tolerance / softness in hue-sat space */
  tolerance: number; // 0..1
  softness: number;   // 0..1
  spill: number;      // 0..1 spill suppression
  edge: number;       // 0..1 edge softness
  shrinkGrow: number; // -1..1
  /** Replace the keyed background with this colour instead of alpha */
  fillMode: 'over' | 'fill' | 'edge';
  fillColor: RGB;
}

/** Per-node effects, all identity-safe at default. */
export interface EffectsState {
  blur: number;        // 0..1 -> gaussian radius in px
  sharpen: number;     // 0..1
  sharpenRadius: number; // 0.5..3
  glow: number;        // 0..1 bloom
  glowThreshold: number; // 0..1
  vignette: number;    // -1..1
  vignetteSoft: number;// 0..1
  grain: number;       // 0..1
  /** 3D/1D LUT id from the LUT library */
  lut: string | null;
  lutIntensity: number; // 0..1
  /** Resolve-style CDL-ish ASC CDL slope/offset/power/sat */
  cdl: {
    slope: RGB;
    offset: RGB;
    power: RGB;
    sat: number;
  };
  /** Film emulation-ish filmic contrast curve, identity at 0 */
  filmContrast: number; // 0..1
}

export interface GradeState {
  primary: PrimaryState;
  curves: CurvesState;
  qualifier: QualifierState;
  window: WindowState;
  key: KeyState;
  effects: EffectsState;
  /** Node-level input/output gamma trim (0.1..10) */
  inputGamma: number;
  outputGamma: number;
  /** Per-parameter keyframe tracks, keyed by dotted path e.g. 'primary.lift' */
  keyframes: Record<string, KeyframeTrack<number>>;
}

// ---------------------------------------------------------------------------
// Project / timeline
// ---------------------------------------------------------------------------

export interface MediaClip {
  id: string;
  name: string;
  /** Object URL or path */
  src: string;
  durationFrames: number;
  fps: number;
  width: number;
  height: number;
  /** 'video' | 'image' | 'audio' | 'generator' */
  kind: ClipKind;
  codec?: string;
  /** Postage-stamp metadata, like Resolve's clip attrs */
  attrs: Record<string, string>;
  thumbnail?: string;
  /** Normalised 0..1 scene-referred exposure offset, applied at read */
  iso?: number;
}

export type ClipKind = 'video' | 'image' | 'audio' | 'generator';

export interface TimelineClip {
  id: string;
  mediaId: string;
  trackId: string;
  /** Timeline position in frames */
  start: number;
  /** In/out points in the source, frames */
  inFrame: number;
  outFrame: number;
  enabled: boolean;
  /** Per-clip grade override (node graph lives in gradeGraphs when detached) */
  grade?: GradeState;
  label?: string;
  speed?: number;
  /** Opacity 0..1 */
  opacity?: number;
}

export interface Track {
  id: string;
  kind: 'video' | 'audio';
  index: number;
  name: string;
  locked: boolean;
  muted: boolean;
  height: number;
}

export interface Timeline {
  fps: number;
  durationFrames: number;
  startFrame: number;
  tracks: Track[];
  clips: TimelineClip[];
  playhead: number;
  /** Loop playback range */
  inPoint: number;
  outPoint: number;
  selection: string[];
}

export interface ProjectSettings {
  name: string;
  workingSpace: WorkingSpace;
  outputSpace: OutputSpace;
  outputGamma: number;
  /** Timeline-level node graph (grade applied to whole timeline) */
  timelineGraph: Graph;
  /** Per-clip saved graphs: mediaId or clipId -> graph */
  clipGraphs: Record<string, Graph>;
  autoSave: boolean;
}

export interface Project {
  id: string;
  settings: ProjectSettings;
  mediaPool: MediaClip[];
  timeline: Timeline;
  /** Which page the UI is on */
  page: PageId;
  /** Bins in the media pool, folder tree */
  bins: Bin[];
  version: number;
}

export interface Bin {
  id: string;
  name: string;
  parent: string | null;
  clipIds: string[];
}

export type PageId = 'media' | 'cut' | 'edit' | 'fusion' | 'color' | 'fairlight' | 'deliver';

// ---------------------------------------------------------------------------
// LUTs
// ---------------------------------------------------------------------------

export interface Lut3D {
  id: string;
  name: string;
  size: number;         // N^3 entries
  domain: [number, number];
  /** Flat Float32Array of size*size*size*3, RGB order, .cube layout */
  data: Float32Array;
}

export interface Lut1D {
  id: string;
  name: string;
  size: number;
  data: Float32Array;   // size*3
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export interface ScopeData {
  /** Waveform / parade: for each of 4 sub-tables, columns of max-luma traces */
  waveform: { width: number; height: number; r: Float32Array; g: Float32Array; b: Float32Array; y: Float32Array };
  histogram: { bins: number; r: Float32Array; g: Float32Array; b: Float32Array; l: Float32Array };
  vectorscope: { size: number; r: Uint8ClampedArray };
}

// ---------------------------------------------------------------------------
// Agent bridge
// ---------------------------------------------------------------------------

export interface AgentCommandMap {
  open_media: { path: string };
  import_media: { paths: string[]; binId?: string };
  list_media: Record<string, never>;
  list_timeline: Record<string, never>;
  set_playhead: { frame: number };
  set_page: { page: PageId };
  add_node: { label?: string; kind?: NodeKind; after?: string };
  remove_node: { id: string };
  connect_nodes: { from: string; to: string };
  set_node_param: { id?: string; path: string; value: unknown };
  set_grade: { id?: string; grade: Partial<GradeState> };
  auto_balance: { id?: string; method?: 'neutral' | 'white-balance' };
  analyze_frame: { frame?: number };
  get_scopes: Record<string, never>;
  read_pixel: { x: number; y: number; frame?: number };
  export_frame: { frame?: number; path?: string };
  export_video: { path: string; codec?: string; crf?: number };
  apply_lut: { id?: string; lut: string; intensity?: number };
  select_clip: { id: string };
  keyframe: { path: string; frame: number; value: number; interp?: Interp };
  save_project: { path?: string };
  undo: Record<string, never>;
  redo: Record<string, never>;
  screenshot: { path?: string };
}
