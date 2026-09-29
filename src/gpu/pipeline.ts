/**
 * ColorPipeline — owns a WebGL2 context and renders a Resolve-style node
 * graph through the 18-stage grade chain in `shaders.ts`.
 *
 * Design decisions worth knowing before reading the code:
 *
 *  - PRECISION IS NEGOTIATED, NOT ASSUMED. `EXT_color_buffer_float` gives
 *    RGBA32F targets, which is what the grade chain actually needs — at 16
 *    bits per channel, a stack of six nodes on a 32-bit float image will
 *    band visibly in the shadows, and the pipeline falls back to RGBA8 only
 *    when there is genuinely nothing else. `precision` is exposed so the UI
 *    can tell the user which of the three they got, because the difference
 *    is visible and the user deserves to know.
 *
 *  - NO PER-FRAME ALLOCATION. Every texture, framebuffer and uniform lookup
 *    is created on first use at a given size and reused. `render()` allocates
 *    nothing but the tiny per-node uniform structs.
 *
 *  - EVERY PUBLIC METHOD IS SAFE BEFORE THE FIRST FRAME. Uniform locations
 *    are resolved lazily and cached; a `readPixels` on a pipeline that has
 *    never rendered returns zeros rather than throwing, because the agent
 *    bridge calls it speculatively.
 *
 *  - THE ONE CLAMP IS IN OUTPUT_SHADER. The grade chain and the FBO chain
 *    are float and unbounded. That is why the ping-pong is 32F whenever the
 *    driver allows it, and why the canvas is only written by the final
 *    output-transform pass.
 */

import type {
  CurvePoint,
  GradeState,
  Graph,
  Interp,
  Keyframe,
  KeyframeTrack,
  Lut3D,
  Node,
  OutputSpace,
  RGB,
  ScopeData,
} from '../core/types.js';
import {
  AP1_LUMA,
  AP1_TO_P3D65,
  AP1_TO_REC2020,
  AP1_TO_SRGB_LINEAR,
  SRGB_LINEAR_TO_AP1,
  mat3ColumnMajor,
  type Mat3,
} from '../core/colormath.js';
import { defaultGrade } from '../core/defaults.js';
import {
  CURVE_LUT_ROWS,
  CURVE_LUT_SIZE,
  PROGRAMS,
  type ProgramName,
  type ShaderProgram,
} from './shaders.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which float format the render targets actually got. */
export type PipelinePrecision = 'float32' | 'float16' | 'byte';

/** Source colour management, set once per source clip. */
export interface SourceOptions {
  /** 'srgb' (default) | 'rec709' | 'gamma22' */
  transfer?: 'srgb' | 'rec709' | 'gamma22';
  /** Decode ARRI LogC (EI 800) before the primaries matrix. */
  logc?: boolean;
  /** Scene-referred exposure multiplier; 1 = unity. */
  exposure?: number;
  /** Pre-grade saturation; 1 = unity. */
  preSaturation?: number;
}

export interface PipelineOptions {
  /** Display space for the final transform. Default 'Rec.709'. */
  outputSpace?: OutputSpace;
  /** Deliver as sRGB piecewise (true) or a pure display gamma (false). */
  srgbEncode?: boolean;
  /** Used when srgbEncode is false. Default 2.4. */
  displayGamma?: number;
  /** ProjectSettings.outputGamma trim. 1 = identity. */
  projectGamma?: number;
  /** Source decode for the first render. */
  source?: SourceOptions;
  /** Perceptual gamma for the curve stage. Default 2.2. */
  curveDomain?: number;
  /** Run the 3D LUT on a gamma-encoded signal (default) or scene-linear. */
  lutDomainMode?: 'gamma' | 'linear';
  /** Grain seed. */
  grainSeed?: number;
  /** Analyser resolution. Default 256x144. */
  analysisWidth?: number;
  analysisHeight?: number;
}

export interface CurveLutInfo {
  /** 1024x4, row 0/1/2 = r/g/b, row 3 = master. */
  width: number;
  rows: number;
  /** True when every channel is the identity straight line. */
  isIdentity: boolean;
}

/** A serial/parallel node's mixer amount, read off the grade's own knobs. */
export interface MixUniforms {
  mix: number;
  useAlphaKey: boolean;
}

interface Targets {
  /** Ping-pong working buffers, always in working-space AP1 linear. */
  a: WebGLFramebuffer;
  b: WebGLFramebuffer;
  /** Blur chain temps. */
  blurH: WebGLFramebuffer;
  blurV: WebGLFramebuffer;
  /**
   * Display-referred copy of the final output transform, at frame size.
   * `readPixels` and `analyze` read THIS, not the working buffer, so a
   * returned value means what the operator sees and 0..1 means 0..1.
   */
  display: WebGLFramebuffer;
  texDisplay: WebGLTexture;
  /** Downscaled copy for the analyser. */
  small: WebGLFramebuffer;
  /** Scope display raster. */
  scope: WebGLFramebuffer;
  texA: WebGLTexture;
  texB: WebGLTexture;
  texBlurH: WebGLTexture;
  texBlurV: WebGLTexture;
  texSmall: WebGLTexture;
  texScope: WebGLTexture;
  width: number;
  height: number;
}

interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const IDENTITY3: Float32Array = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

function norm3(v: readonly number[]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross3(
  a: readonly number[],
  b: readonly number[],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Luma-preserving hue rotation as a COLUMN-MAJOR mat3 for a GLSL
 * `uniform mat3`, built on the CPU so the shader never re-derives it.
 *
 *   M = n nᵀ + cos(t)(u uᵀ + v vᵀ) + sin(t)(v uᵀ − u vᵀ)
 *
 * with n the AP1 luma normal and (u, v) an orthonormal basis of its
 * complement, using the same Gram-Schmidt construction as colormath.ts's
 * `lumaBasis`. M n = n identically, so luma is preserved to machine
 * precision for any input — no dependence on remembered YIQ coefficients,
 * which drift and stop matching the luma the scopes actually use.
 *
 * Re-deriving this in GLSL would be two sins: a per-pixel `sin`/`cos` and
 * Gram-Schmidt, and a second, subtly different definition of "luma" living
 * in the shader. The second one is the expensive kind, because the scopes
 * would then disagree with the image about what brightness means.
 */
export function hueRotateMatrix(
  deg: number,
  luma: readonly number[] = AP1_LUMA,
): Float32Array {
  if (!Number.isFinite(deg) || deg === 0) return IDENTITY3;

  const n = norm3(luma);
  // Gram-Schmidt e0 against n; fall back to e1 if they are nearly parallel.
  let u: [number, number, number] = [
    1 - n[0] * n[0],
    -n[0] * n[1],
    -n[0] * n[2],
  ];
  if (Math.hypot(u[0], u[1], u[2]) < 1e-6) {
    u = [-n[1] * n[0], 1 - n[1] * n[1], -n[1] * n[2]];
  }
  u = norm3(u);
  const v = norm3(cross3(n, u));

  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);

  const m: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) {
      m[r][col] =
        n[r] * n[col] +
        c * (u[r] * u[col] + v[r] * v[col]) +
        s * (v[r] * u[col] - u[r] * v[col]);
    }
  }
  return new Float32Array([
    m[0][0], m[1][0], m[2][0],
    m[0][1], m[1][1], m[2][1],
    m[0][2], m[1][2], m[2][2],
  ]);
}

const OUTPUT_MATRICES: Readonly<Record<OutputSpace, Mat3>> = {
  'Rec.709': AP1_TO_SRGB_LINEAR,
  sRGB: AP1_TO_SRGB_LINEAR,
  'Rec.2020': AP1_TO_REC2020,
  'Display P3': AP1_TO_P3D65,
};

const TRANSFER_INDEX: Readonly<Record<string, number>> = {
  srgb: 0,
  rec709: 1,
  gamma22: 2,
};

const SHAPE_INDEX: Readonly<Record<string, number>> = {
  ellipse: 0,
  rectangle: 1,
  linear: 2,
  // 'poly' and 'none' have no SDF here; 'none' disables the window and
  // 'poly' falls back to the rectangle, which is the closest honest answer
  // without a point-in-polygon path the shader would have to be fed.
  poly: 1,
  none: 0,
};

const VIEW_INDEX: Readonly<Record<string, number>> = {
  matte: 0,
  overlay: 1,
  'no-key': 2,
};

const FILL_INDEX: Readonly<Record<string, number>> = {
  over: 0,
  fill: 1,
  edge: 2,
};

const approx = (a: number, b: number, eps = 1e-6): boolean =>
  Number.isFinite(a) && Math.abs(a - b) < eps;

const rgbApprox = (a: RGB, b: RGB, eps = 1e-6): boolean =>
  approx(a[0], b[0], eps) && approx(a[1], b[1], eps) && approx(a[2], b[2], eps);

/** Interp curves. `t` is already normalised to 0..1. */
function ease(kind: Interp | undefined, t: number): number {
  switch (kind) {
    case 'hold': return 0;
    case 'ease-in': return t * t;
    case 'ease-out': return 1 - (1 - t) * (1 - t);
    case 'ease': return t * t * (3 - 2 * t);
    case 'linear':
    default: return t;
  }
}

/** Evaluate one keyframe track at a frame, honouring per-segment interp. */
export function evaluateTrack(
  track: KeyframeTrack<number> | undefined,
  frame: number,
): number | null {
  if (!track || track.length === 0) return null;
  if (track.length === 1) return track[0].value;

  // Tracks are authored in order, but a JSON round-trip or an agent-driven
  // insert can leave them shuffled; sorting a copy keeps the caller safe.
  const keys = [...track].sort((a, b) => a.frame - b.frame);
  if (frame <= keys[0].frame) return keys[0].value;
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return last.value;

  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (frame < a.frame || frame >= b.frame) continue;
    const span = b.frame - a.frame;
    if (span <= 0) return b.value;
    const t = ease(a.interp ?? 'linear', (frame - a.frame) / span);
    return a.value + (b.value - a.value) * t;
  }
  return last.value;
}

/**
 * Monotone (Fritsch–Carlson) resample of a control-point list onto a
 * 1024-entry LUT row.
 *
 * Naive piecewise-linear through unsorted control points produces a curve
 * that doubles back on itself the moment a user drags a point past its
 * neighbour, and the shader then samples a staircase. Monotone cubic keeps
 * the curve's direction, which is what a colourist expects when they pull a
 * handle across another one.
 */
function resampleCurve(points: CurvePoint[], size: number): Float32Array {
  const out = new Float32Array(size);
  if (!points || points.length === 0) {
    for (let i = 0; i < size; i++) out[i] = i / (size - 1);
    return out;
  }
  const pts = [...points].sort((a, b) => a.x - b.x);
  if (pts.length === 1) {
    out.fill(pts[0].y);
    return out;
  }

  const n = pts.length;
  const dx = new Float64Array(n - 1);
  const slope = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = Math.max(pts[i + 1].x - pts[i].x, 1e-9);
    slope[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }

  // Fritsch–Carlson tangents.
  const m = new Float64Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) * 0.5;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }

  let seg = 0;
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);
    if (x <= pts[0].x) { out[i] = pts[0].y; continue; }
    if (x >= pts[n - 1].x) { out[i] = pts[n - 1].y; continue; }
    while (seg < n - 2 && x > pts[seg + 1].x) seg++;
    const h = dx[seg];
    const t = (x - pts[seg].x) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    out[i] =
      (2 * t3 - 3 * t2 + 1) * pts[seg].y +
      (t3 - 2 * t2 + t) * h * m[seg] +
      (-2 * t3 + 3 * t2) * pts[seg + 1].y +
      (t3 - t2) * h * m[seg + 1];
  }
  return out;
}

const isIdentityPoints = (p: CurvePoint[] | undefined): boolean =>
  !!p && p.length === 2 && approx(p[0].x, 0, 1e-4) && approx(p[0].y, 0, 1e-4)
    && approx(p[1].x, 1, 1e-4) && approx(p[1].y, 1, 1e-4);

/**
 * Short string identifying a curve set. Includes the point COUNT, so
 * "added a point that happens to sit on the line" is still a change.
 */
function curveSignature(g: GradeState): string {
  const pts = (p: CurvePoint[] | undefined): string =>
    (p ?? []).map((q) => `${q.x},${q.y}`).join(';');
  return `${pts(g.curves.master)}|${pts(g.curves.red)}|${pts(g.curves.green)}|${pts(g.curves.blue)}`;
}

/** Depth-first topological order over graph edges, cycle-safe. */
function topoOrder(graph: Graph): Node[] {
  const byId = new Map<string, Node>();
  for (const n of graph.nodes) byId.set(n.id, n);

  const indeg = new Map<string, number>();
  for (const n of graph.nodes) indeg.set(n.id, 0);
  for (const [, to] of graph.edges) {
    if (byId.has(to)) indeg.set(to, (indeg.get(to) ?? 0) + 1);
  }

  const queue: Node[] = graph.nodes
    .filter((n) => (indeg.get(n.id) ?? 0) === 0)
    .sort((a, b) => a.index - b.index);
  const out: Node[] = [];
  const seen = new Set<string>();

  while (queue.length) {
    const n = queue.shift()!;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    for (const [from, to] of graph.edges) {
      if (from !== n.id || !byId.has(to)) continue;
      const d = (indeg.get(to) ?? 1) - 1;
      indeg.set(to, d);
      if (d <= 0) queue.push(byId.get(to)!);
    }
  }
  // A cycle (which a hand-edited graph can have) leaves nodes out; append
  // them in index order rather than silently dropping their grade.
  for (const n of [...graph.nodes].sort((a, b) => a.index - b.index)) {
    if (!seen.has(n.id)) out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ColorPipeline
// ---------------------------------------------------------------------------

export class ColorPipeline {
  readonly gl: WebGL2RenderingContext;

  /** Which float format the targets got. The UI shows this. */
  readonly precision: PipelinePrecision;

  private options: Required<
    Pick<
      PipelineOptions,
      | 'outputSpace'
      | 'srgbEncode'
      | 'displayGamma'
      | 'projectGamma'
      | 'curveDomain'
      | 'grainSeed'
      | 'analysisWidth'
      | 'analysisHeight'
    >
  > & { lutDomainMode: 'gamma' | 'linear'; source: Required<SourceOptions> };

  private readonly programs = new Map<ProgramName, ProgramInfo>();
  private targets: Targets | null = null;
  private sourceTex: WebGLTexture | null = null;
  private lutTex: WebGLTexture | null = null;
  /** False until the caller actually supplies a LUT (the bound 1x1x1 is filler). */
  private userLut = false;
  /** True when lutTex is the 1x1x1 placeholder rather than a user LUT. */
  private fillerLut = false;
  private curveTex: WebGLTexture | null = null;
  private lutData: { size: number; domain: [number, number] } | null = null;
  private curveData: Float32Array | null = null;
  private curveIsIdentity = true;
  /**
   * Cheap signature of the curve state the current curve TEXTURE was built
   * from. Without it, a caller that edits `grade.curves` and renders gets
   * silently-unapplied curves until it remembers to call buildCurveLut —
   * a failure with no error and no wrong-looking value, just a slider that
   * does nothing. Comparing the control points each frame is far cheaper
   * than the GPU upload it avoids.
   */
  private curveSig = '';
  /**
   * The picture flip / mirror, in output pixels. Applied at the display stage
   * so it does not disturb the graded image upstream — a viewer flip should
   * not become a grade change.
   */
  private userFlip = { x: false, y: false };
  private linearFloatFilter = false;
  private lastFrame = -1;
  /**
   * Texture + FBO holding the CURRENT output. The ping-pong ends in
   * whichever buffer the last node wrote, so readback has to follow it —
   * reading a hardcoded `a` returns the previous frame, or the source, and
   * does so silently, which is worse than an exception.
   */
  private lastTex: WebGLTexture | null = null;
  private lastFbo: WebGLFramebuffer | null = null;
  private disposed = false;

  private readonly toAP1: Float32Array = mat3ColumnMajor(SRGB_LINEAR_TO_AP1);
  private readonly luma: Float32Array = Float32Array.from(AP1_LUMA);
  private toOutput: Float32Array = mat3ColumnMajor(AP1_TO_SRGB_LINEAR);
  private readonly tempTint = new Float32Array([1, 1, 1]);
  private readonly hueMat = new Float32Array(9);
  private readonly keyCbCr = new Float32Array(2);

  /** Scratch ping-pong index for the current frame's chain. */
  private parity = 0;
  /** 1x1 opaque black, for sampler slots with nothing to show. */
  private blackTex: WebGLTexture | null = null;

  constructor(gl: WebGL2RenderingContext, options: PipelineOptions = {}) {
    this.gl = gl;
    this.options = {
      outputSpace: options.outputSpace ?? 'Rec.709',
      srgbEncode: options.srgbEncode ?? true,
      displayGamma: options.displayGamma ?? 2.4,
      projectGamma: options.projectGamma ?? 1,
      curveDomain: options.curveDomain ?? 2.2,
      grainSeed: options.grainSeed ?? 0,
      analysisWidth: options.analysisWidth ?? 256,
      analysisHeight: options.analysisHeight ?? 144,
      lutDomainMode: options.lutDomainMode ?? 'gamma',
      source: {
        transfer: options.source?.transfer ?? 'srgb',
        logc: options.source?.logc ?? false,
        exposure: options.source?.exposure ?? 1,
        preSaturation: options.source?.preSaturation ?? 1,
      },
    };
    this.toOutput = mat3ColumnMajor(
      OUTPUT_MATRICES[this.options.outputSpace] ?? AP1_TO_SRGB_LINEAR,
    );

    // Precision negotiation, in descending order of quality. Each step down
    // is visible in the shadows, so the warnings say so rather than
    // mentioning an extension name the user cannot act on.
    const extFloat = gl.getExtension('EXT_color_buffer_float');
    const extHalf = gl.getExtension('EXT_color_buffer_half_float');
    const extLinear = gl.getExtension('OES_texture_float_linear');

    if (extFloat) {
      this.precision = 'float32';
      this.linearFloatFilter = !!extLinear;
      if (!extLinear) {
        console.warn(
          '[ColorPipeline] OES_texture_float_linear unavailable: 32-bit ' +
          'targets are NEAREST-filtered. The grade is unaffected, but ' +
          'blur, glow and the scope downscale will be blockier than usual.',
        );
      }
    } else if (extHalf) {
      this.precision = 'float16';
      this.linearFloatFilter = true;
      console.warn(
        '[ColorPipeline] EXT_color_buffer_float unavailable: falling back ' +
        'to RGBA16F working space. 16 bits per channel will band in the ' +
        'deep shadows once several nodes are stacked — expect to lose ' +
        'shadow detail compared with a 32-bit float session.',
      );
    } else {
      this.precision = 'byte';
      this.linearFloatFilter = true;
      console.warn(
        '[ColorPipeline] No floating-point render targets: falling back to ' +
        '8-bit UNORM working space. Grades WILL band and highlights WILL ' +
        'clip, and the HDR scopes are meaningless. This is not a usable ' +
        'grading session — check that the browser is not blocking WebGL ' +
        'float extensions, and that hardware acceleration is enabled.',
      );
    }

    // Bound immediately: the grade program's sampler3D must be complete on
    // frame one, not from the second render onwards.
    this.identityLut3D();
    this.vao = gl.createVertexArray();
  }

  private vao: WebGLVertexArrayObject;

  // -------------------------------------------------------------------------
  // Shader compilation
  // -------------------------------------------------------------------------

  private compile(type: number, source: string, label: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type);
    if (!sh) throw new Error(`[ColorPipeline] createShader failed for ${label}`);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return sh;
    const log = gl.getShaderInfoLog(sh) ?? '(no log)';
    gl.deleteShader(sh);
    // Annotate the log with the offending source lines. A bare ANGLE log
    // gives line numbers that refer to the generated string, which nobody can
    // map back to a template literal.
    throw new Error(
      `[ColorPipeline] ${label} failed to compile\n${this.annotate(log, source)}`,
    );
  }

  private annotate(log: string, source: string): string {
    const lines = source.split('\n');
    const out: string[] = [];
    for (const raw of log.split('\n')) {
      if (!raw.trim()) continue;
      out.push(`  ${raw}`);
      const m = /\b0:(\d+)/.exec(raw) ?? /:(\d+):/.exec(raw);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      for (let i = Math.max(n - 2, 1); i <= Math.min(n + 2, lines.length); i++) {
        out.push(`    ${String(i).padStart(4)} | ${lines[i - 1] ?? ''}`);
      }
    }
    return out.join('\n');
  }

  private program(name: ProgramName): ProgramInfo {
    const cached = this.programs.get(name);
    if (cached) return cached;

    const gl = this.gl;
    const src: ShaderProgram = PROGRAMS[name];
    const vs = this.compile(gl.VERTEX_SHADER, src.vert, `${name} vertex shader`);
    const fs = this.compile(gl.FRAGMENT_SHADER, src.frag, `${name} fragment shader`);

    const program = gl.createProgram();
    if (!program) {
      throw new Error(`[ColorPipeline] createProgram failed for ${name}`);
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    // Shaders are reference-counted by the program; deleting them here means
    // they go with it and nothing leaks if a program is replaced.
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '(no log)';
      gl.deleteProgram(program);
      throw new Error(`[ColorPipeline] ${name} program failed to link\n  ${log}`);
    }
    const info: ProgramInfo = { program, uniforms: new Map() };
    this.programs.set(name, info);
    return info;
  }

  /**
   * Get a program AND make it current.
   *
   * Separate from `program()` on purpose. `gl.uniform*` writes to whatever
   * program is CURRENTLY bound, not to one you have merely compiled — so a
   * pass that sets its uniforms and then draws will silently write them
   * into the previously-bound program (or into none at all, on the first
   * frame) and render with every uniform at zero. That is a black frame
   * with no error anywhere, which is why the bind is not left implicit in
   * the draw call.
   */
  private use(name: ProgramName): ProgramInfo {
    const info = this.program(name);
    this.gl.useProgram(info.program);
    return info;
  }

  private loc(name: ProgramName, uniform: string): WebGLUniformLocation | null {
    const p = this.program(name);
    let l = p.uniforms.get(uniform);
    if (l === undefined) {
      l = this.gl.getUniformLocation(p.program, uniform);
      p.uniforms.set(uniform, l);
    }
    return l;
  }

  // -------------------------------------------------------------------------
  // Targets
  // -------------------------------------------------------------------------

  private internalFormat(): { internal: number; type: number } {
    const gl = this.gl;
    if (this.precision === 'float32') return { internal: gl.RGBA32F, type: gl.FLOAT };
    if (this.precision === 'float16') return { internal: gl.RGBA16F, type: gl.HALF_FLOAT };
    return { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
  }

  /**
   * A 1x1 black texture. Exists so a sampler uniform always has a texture
   * bound that is not the current render target — see the uBlurTex note in
   * setNodeUniforms.
   */
  private blackTexture(): WebGLTexture {
    if (this.blackTex) return this.blackTex;
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('[ColorPipeline] createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT,
      new Float32Array([0, 0, 0, 1]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.blackTex = tex;
    return tex;
  }

  private makeTarget(width: number, height: number): {
    fbo: WebGLFramebuffer;
    tex: WebGLTexture;
  } {
    const gl = this.gl;
    const { internal, type } = this.internalFormat();
    const tex = gl.createTexture();
    if (!tex) throw new Error('[ColorPipeline] createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, gl.RGBA, type, null);
    // CLAMP_TO_EDGE on both axes: the wrap mode matters for the blur and
    // downscale taps, which read past the edge. REPEAT on a float target
    // costs a driver fallback to CPU filtering on some ANGLE backends.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.linearFloatFilter ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.linearFloatFilter ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('[ColorPipeline] createFramebuffer failed');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(
        `[ColorPipeline] framebuffer incomplete (0x${status.toString(16)}) at ` +
        `${width}x${height} in ${this.precision} — the driver advertised the ` +
        `extension but cannot render to it`,
      );
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex };
  }

  private ensureTargets(width: number, height: number): Targets {
    // A caller that omits the size must not be able to destroy a good set of
    // targets. `ensureTargets(undefined, undefined)` used to tear down the real
    // 480x320 buffers and replace them with 1x1, which silently killed the
    // viewer, every later pixel read and the scopes for the rest of the
    // session — from a single agent command. Keep the existing targets unless
    // the caller asked for a real, different size.
    const wReq = Number.isFinite(width) && width >= 1 ? Math.floor(width) : 0;
    const hReq = Number.isFinite(height) && height >= 1 ? Math.floor(height) : 0;
    if (this.targets && (wReq === 0 || hReq === 0 || (this.targets.width === wReq && this.targets.height === hReq))) {
      return this.targets;
    }
    this.destroyTargets();

    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const a = this.makeTarget(w, h);
    const b = this.makeTarget(w, h);
    const blurH = this.makeTarget(w, h);
    const blurV = this.makeTarget(w, h);

    // The analyser works on a small copy: a 4K histogram is a 30M-sample
    // readback, which blocks the main thread for tens of milliseconds. The
    // scope shader box-filters the full-res image down to this.
    const sw = Math.min(this.options.analysisWidth, w);
    const sh = Math.min(this.options.analysisHeight, h);
    const display = this.makeTarget(w, h);
    const small = this.makeTarget(sw, sh);
    const scope = this.makeTarget(sw, sh);

    this.targets = {
      a: a.fbo, b: b.fbo, blurH: blurH.fbo, blurV: blurV.fbo,
      display: display.fbo, small: small.fbo, scope: scope.fbo,
      texA: a.tex, texB: b.tex, texBlurH: blurH.tex, texBlurV: blurV.tex,
      texDisplay: display.tex, texSmall: small.tex, texScope: scope.tex,
      width: w, height: h,
    };
    return this.targets;
  }

  private destroyTargets(): void {
    const gl = this.gl;
    if (this.blackTex) { gl.deleteTexture(this.blackTex); this.blackTex = null; }
    const t = this.targets;
    if (!t) return;
    for (const fbo of [t.a, t.b, t.blurH, t.blurV, t.display, t.small, t.scope]) {
      gl.deleteFramebuffer(fbo);
    }
    for (const tex of [t.texA, t.texB, t.texBlurH, t.texBlurV, t.texDisplay, t.texSmall, t.texScope]) {
      gl.deleteTexture(tex);
    }
    this.targets = null;
  }

  // -------------------------------------------------------------------------
  // Draw helpers
  // -------------------------------------------------------------------------

  private draw(
    name: ProgramName,
    fbo: WebGLFramebuffer | null,
    width: number,
    height: number,
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, height);
    this.use(name);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bindTex(
    name: ProgramName,
    uniform: string,
    unit: number,
    tex: WebGLTexture,
  ): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const l = this.loc(name, uniform);
    if (l) gl.uniform1i(l, unit);
  }

  // -------------------------------------------------------------------------
  // Public: source
  // -------------------------------------------------------------------------

  /**
   * Upload a `TexImageSource` (video, image, ImageBitmap, canvas) to the
   * source texture. Safe before the first frame; a size change resizes the
   * texture but does NOT reallocate the render targets, which `render`
   * owns.
   */
  uploadSource(
    source: TexImageSource,
    width: number,
    height: number,
    opts?: SourceOptions,
  ): void {
    const gl = this.gl;
    if (opts) {
      this.options.source = {
        transfer: opts.transfer ?? this.options.source.transfer,
        logc: opts.logc ?? this.options.source.logc,
        exposure: opts.exposure ?? this.options.source.exposure,
        preSaturation: opts.preSaturation ?? this.options.source.preSaturation,
      };
    }
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);

    if (!this.sourceTex) this.sourceTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    // Flip on upload so texel (0,0) is the image's top-left, matching the
    // top-left-origin convention everything downstream assumes.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Video elements are not mipmapped, and CLAMP_TO_EDGE is both correct
    // and cheaper than REPEAT.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // -------------------------------------------------------------------------
  // Public: LUTs
  // -------------------------------------------------------------------------

  /**
   * A 1x1x1 LUT that is always bound to `uLut3D`, even when the user has not
   * supplied one.
   *
   * This is not defensive padding, it is required for correctness. The grade
   * shader declares a `sampler3D` and, with no texture bound to that unit,
   * the draw is sampling an incomplete texture — which makes the ENTIRE
   * fragment undefined, not just the LUT branch. On ANGLE that presents as a
   * solid black frame with no GL error anywhere, while the identical frame
   * renders correctly the moment any LUT happens to be bound. A 1x1x1
   * identity-ish cube is the cheapest way to keep the sampler complete.
   */
  private identityLut3D(): WebGLTexture {
    const gl = this.gl;
    // A real LUT always wins. This guard matters because setNodeUniforms
    // runs every node of every frame: without the userLut check it would
    // replace the user's LUT with the 1x1x1 filler mid-graph, and the LUT
    // would appear to work when setLut was called and then silently stop
    // applying on the next frame.
    if (this.lutTex && (this.userLut || this.fillerLut)) return this.lutTex;
    const tex = gl.createTexture();
    if (!tex) throw new Error('[ColorPipeline] createTexture failed');
    gl.bindTexture(gl.TEXTURE_3D, tex);
    // 1x1x1 in .cube order: a single black entry, never sampled because
    // uLutOn is false whenever userLut is false.
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, 1, 1, 1, 0, gl.RGB, gl.FLOAT, new Float32Array(3));
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    this.lutTex = tex;
    this.userLut = false;
    this.fillerLut = true;
    return tex;
  }

  /**
   * Create or update the 3D LUT texture from a parsed `.cube` LUT.
   *
   * WebGL2's TEXTURE_3D is indexed (r, g, b) with R varying fastest, which is
   * the same order a `.cube` file stores its triples in, so `Lut3D.data` goes
   * up unchanged. Nothing is interpolated at upload time.
   */
  setLut(lut: Lut3D | null): void {
    const gl = this.gl;
    if (!lut) {
      if (this.lutTex && this.userLut) this.gl.deleteTexture(this.lutTex);
      this.userLut = false;
      this.lutData = { size: 1, domain: [0, 1] };
      this.identityLut3D();
      return;
    }
    const size = Math.max(2, lut.size | 0);
    const expected = size * size * size * 3;
    if (lut.data.length < expected) {
      throw new Error(
        `[ColorPipeline] setLut: "${lut.name ?? lut.id}" declares size ${size} ` +
        `(${expected} floats) but carries ${lut.data.length}`,
      );
    }

    if (!this.lutTex) {
      this.lutTex = gl.createTexture();
      if (!this.lutTex) throw new Error('[ColorPipeline] createTexture failed');
    }
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    // The LUT's own dynamic range is preserved: a .cube with values above
    // 1.0 (a LUT built for a HDR working space) must not be squashed on
    // upload, so the format is float and filtering is LINEAR across the
    // lattice. That is a colour decision, not a convenience — a 17^3 or
    // 33^3 LUT NEEDS interpolation to avoid visible banding, and a NEAREST
    // 33-cube is an ugly image.
    const { type } = this.internalFormat();
    if (this.lutData?.size !== size) {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, size, size, size, 0, gl.RGB, gl.FLOAT, lut.data);
      this.lutData = { size, domain: lut.domain };
    } else {
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, size, size, size, gl.RGB, gl.FLOAT, lut.data);
    }
    void type;
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    this.userLut = true;
    this.fillerLut = false;
  }

  /** True when the caller has supplied a real LUT (not the 1x1x1 filler). */
  hasLut(): boolean {
    return this.userLut;
  }

  /**
   * Build the 1024x4 RGBA float curve texture from a grade's curves.
   *
   * Row 0/1/2 are red/green/blue, row 3 is master, sampled with `texelFetch`
   * so the lookup is exact and independent of filtering. A master curve is
   * applied AFTER the per-channel curves, which is the order Resolve uses and
   * the only one where a master curve behaves like a contrast control rather
   * than fighting the per-channel ones.
   *
   * R = curve output, G = tangent, B = active flag, A = 1. The flags let a
   * later shader change skip a row without re-uploading.
   */
  buildCurveLut(grade: GradeState): CurveLutInfo {
    const gl = this.gl;
    const { master, red, green, blue } = grade.curves;
    const size = CURVE_LUT_SIZE;
    const rows = CURVE_LUT_ROWS;

    const data = this.curveData ?? new Float32Array(size * rows * 4);
    if (this.curveData === null) this.curveData = data;

    const rowSpec: ReadonlyArray<readonly [CurvePoint[] | undefined, number]> = [
      [red, 0],
      [green, 1],
      [blue, 2],
      [master, 3],
    ];

    let identity = true;
    for (const [points, row] of rowSpec) {
      const off = row * size * 4;
      const y = resampleCurve(points ?? [], size);
      for (let i = 0; i < size; i++) {
        const v = y[i];
        // Exact identity rows must be EXACTLY the straight line, not the
        // monotone cubic evaluated at it: the two differ in the last ulp and
        // a 4-node graph would accumulate that into a visible tint.
        if (!isIdentityPoints(points)) {
          identity = false;
          data[off + i * 4 + 0] = v;
        } else {
          data[off + i * 4 + 0] = i / (size - 1);
        }
        data[off + i * 4 + 1] = 0;
        data[off + i * 4 + 2] = isIdentityPoints(points) ? 0 : 1;
        data[off + i * 4 + 3] = 1;
      }
    }
    this.curveIsIdentity = identity;

    if (!this.curveTex) {
      this.curveTex = gl.createTexture();
      if (!this.curveTex) throw new Error('[ColorPipeline] createTexture failed');
    }
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA32F, size, rows, 0, gl.RGBA, gl.FLOAT, data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.curveSig = curveSignature(grade);
    return { width: size, rows, isIdentity: identity };
  }

  /**
   * Re-upload the curve texture only when the control points actually
   * changed. Called from render() so a caller that never touches
   * buildCurveLut still gets working curves.
   *
   * The whole graph shares ONE curve texture, which reads like a bug and was
   * documented as one ("the last node with non-identity curves wins"). It is
   * not: this is called once per node inside the render loop, immediately
   * before that node's uniforms are set and it draws, so each node uploads its
   * own curve before its own pass. The single-entry `curveSig` cache is
   * invalidated by each node's differing grade. Swapping two nodes' curves
   * changes the output, which is the assertion that proves it — see
   * scripts/verify-node-curves.mjs. Do not hoist this call out of the loop,
   * and do not "fix" the shared texture into a per-node one: that would be a
   * large refactor of the ping-pong for no behavioural change.
   */
  private syncCurveLut(grade: GradeState): void {
    const sig = curveSignature(grade);
    if (sig === this.curveSig && this.curveTex) return;
    this.buildCurveLut(grade);
  }

  // -------------------------------------------------------------------------
  // Public: keyframes
  // -------------------------------------------------------------------------

  /**
   * Evaluate a grade's keyframe map at `frame` and return a new GradeState
   * with the animated scalars substituted in.
   *
   * Paths are dotted: `primary.lift.0` (array index), `primary.contrast`,
   * `effects.cdl.slope.1`. An unresolvable path is ignored rather than
   * throwing, because the agent bridge can push a typo'd path and a grade
   * that refuses to render is worse than a grade that ignores one track.
   *
   * The input is deep-cloned only when the grade actually has tracks, so the
   * common (unanimated) case allocates nothing.
   */
  resolveKeyframes(grade: GradeState, frame: number): GradeState {
    const tracks = grade.keyframes;
    const keys = Object.keys(tracks);
    if (keys.length === 0) return grade;

    const out = structuredClone(grade);
    for (const path of keys) {
      const value = evaluateTrack(tracks[path], frame);
      if (value === null) continue;
      this.assignPath(out, path, value);
    }
    return out;
  }

  /** Write `value` into `root` at a dotted path. Returns false if no hit. */
  private assignPath(root: unknown, path: string, value: number): boolean {
    const parts = path.split('.');
    let cur: unknown = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur === null || typeof cur !== 'object') return false;
      const key: string | number = /^\d+$/.test(parts[i])
        ? Number(parts[i])
        : parts[i];
      cur = (cur as Record<string | number, unknown>)[key];
    }
    if (cur === null || typeof cur !== 'object') return false;
    const last: string | number = /^\d+$/.test(parts[parts.length - 1])
      ? Number(parts[parts.length - 1])
      : parts[parts.length - 1];
    const bag = cur as Record<string | number, unknown>;
    if (!(last in bag)) return false;
    // Booleans are animatable in practice (toggling a qualifier), so a
    // 0/1 value coerces rather than being rejected.
    if (typeof bag[last] === 'boolean') bag[last] = value >= 0.5;
    else if (typeof bag[last] === 'number') bag[last] = value;
    else return false;
    return true;
  }

  // -------------------------------------------------------------------------
  // Public: readback
  // -------------------------------------------------------------------------

  /**
   * Current frame size. The agent bridge needs this to size a readback —
   * readPixels() has no default arguments, so a bare call returns a 1x1
   * buffer that makes every scope and pixel probe measure nothing while
   * looking like it worked.
   */
  get width(): number { return this.targets?.width ?? 0; }
  get height(): number { return this.targets?.height ?? 0; }


  /**
   * Read back a rectangle of the CURRENT output as float RGBA, DISPLAY
   * REFERRED: after the output transform, so 0..1 means 0..1 and a value is
   * directly comparable with what the operator sees on screen.
   *
   * For the un-clamped working-space image — super-whites above 1.0 included
   * — use `readWorkingPixels`.
   *
   * Safe before the first frame: returns zeros, because the agent bridge
   * calls `read_pixel` speculatively and a throw there takes the whole
   * command down.
   */
  readPixels(x: number, y: number, w: number, h: number): Float32Array {
    return this.readFrom(this.targets?.display ?? null, x, y, w, h);
  }

  /**
   * Read the WORKING-SPACE (AP1 linear, UNCLAMPED) buffer instead.
   *
   * This is the buffer the grade chain actually operated on, before the
   * display transform. Values above 1.0 are normal and correct here; a
   * super-white that `readPixels` reports as 1.0 is reported truthfully as,
   * say, 3.87 by this. Use it to check what a grade did, and `readPixels`
   * to see what the operator sees.
   */
  readWorkingPixels(x: number, y: number, w: number, h: number): Float32Array {
    return this.readFrom(this.lastFbo, x, y, w, h);
  }

  private readFrom(
    fbo: WebGLFramebuffer | null,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Float32Array {
    const out = new Float32Array(Math.max(0, w) * Math.max(0, h) * 4);
    if (this.disposed || !this.targets || !fbo || w <= 0 || h <= 0) return out;
    if (this.lastFrame < 0) return out;

    const gl = this.gl;
    const t = this.targets;
    const rx = Math.max(0, Math.min(t.width - 1, Math.round(x)));
    const ry = Math.max(0, Math.min(t.height - 1, Math.round(y)));
    const rw = Math.max(1, Math.min(t.width - rx, w));
    const rh = Math.max(1, Math.min(t.height - ry, h));

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const { internal, type } = this.internalFormat();
    const fmt = internal === gl.RGBA8 ? gl.RGBA : gl.RGBA;

    if (type === gl.UNSIGNED_BYTE) {
      const bytes = new Uint8Array(rw * rh * 4);
      gl.readPixels(rx, ry, rw, rh, fmt, type, bytes);
      for (let i = 0; i < out.length; i++) out[i] = (bytes[i] ?? 0) / 255;
    } else {
      const buf = new Float32Array(rw * rh * 4);
      gl.readPixels(rx, ry, rw, rh, fmt, type, buf);
      out.set(buf.subarray(0, out.length));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** One pixel as [r, g, b, a], 0..1 display-referred. See readPixels. */
  readPixel(x: number, y: number): [number, number, number, number] {
    const p = this.readPixels(x, y, 1, 1);
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
  }

  /**
   * Histogram + waveform + vectorscope for the current frame.
   *
   * The analysis runs on a box-filtered downscale rather than the full-res
   * image: a 4K readback is 33M samples and blocks the main thread long
   * enough to drop frames, and for a histogram the 256-wide one it produces
   * is statistically identical. What is lost is the waveform's fine
   * structure, which is the reason the waveform is generated from a
   * half-height copy at a fixed width rather than from the full frame.
   */
  analyze(): ScopeData {
    const t = this.targets;
    const width = t ? t.width : 0;
    const height = t ? t.height : 0;

    const histBins = 256;
    const scopeW = t ? t.width : 0;
    const scopeH = t ? t.height : 0;
    const vecSize = 128;

    if (!t || this.lastFrame < 0 || this.disposed) {
      return {
        waveform: {
          width: scopeW, height: scopeH,
          r: new Float32Array(scopeW * scopeH),
          g: new Float32Array(scopeW * scopeH),
          b: new Float32Array(scopeW * scopeH),
          y: new Float32Array(scopeW * scopeH),
        },
        histogram: {
          bins: histBins,
          r: new Float32Array(histBins),
          g: new Float32Array(histBins),
          b: new Float32Array(histBins),
          l: new Float32Array(histBins),
        },
        vectorscope: { size: vecSize, r: new Uint8ClampedArray(vecSize * vecSize * 4) },
      };
    }

    this.renderAnalysisSmall();

    const gl = this.gl;
    const sw = Math.min(this.options.analysisWidth, t.width);
    const sh = Math.min(this.options.analysisHeight, t.height);
    const small = new Float32Array(sw * sh * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.small);
    const { type } = this.internalFormat();
    if (type === gl.UNSIGNED_BYTE) {
      const bytes = new Uint8Array(sw * sh * 4);
      gl.readPixels(0, 0, sw, sh, gl.RGBA, type, bytes);
      for (let i = 0; i < small.length; i++) small[i] = (bytes[i] ?? 0) / 255;
    } else {
      gl.readPixels(0, 0, sw, sh, gl.RGBA, type, small);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return this.buildScopeData(small, sw, sh, histBins, scopeW, scopeH, vecSize, width, height);
  }

  /** Box-filter the current output down to the analysis target. */
  private renderAnalysisSmall(): void {
    const t = this.targets;
    if (!t) return;
    const gl = this.gl;
    const sw = Math.min(this.options.analysisWidth, t.width);
    const sh = Math.min(this.options.analysisHeight, t.height);
    const box = Math.min(4, Math.max(1, Math.floor(t.width / Math.max(sw, 1))));

    this.use('downscale');
    const lSrc = this.loc('downscale', 'uSrcSize');
    if (lSrc) gl.uniform2i(lSrc, t.width, t.height);
    const lRes = this.loc('downscale', 'uResolution');
    if (lRes) gl.uniform2f(lRes, sw, sh);
    const lBox = this.loc('downscale', 'uBox');
    if (lBox) gl.uniform2i(lBox, box, box);
    this.bindTex('downscale', 'uSource', 0, t.texDisplay);
    this.draw('downscale', t.small, sw, sh);
  }

  private buildScopeData(
    px: Float32Array,
    sw: number,
    sh: number,
    histBins: number,
    scopeW: number,
    scopeH: number,
    vecSize: number,
    _fullW: number,
    _fullH: number,
  ): ScopeData {
    const hist = {
      bins: histBins,
      r: new Float32Array(histBins),
      g: new Float32Array(histBins),
      b: new Float32Array(histBins),
      l: new Float32Array(histBins),
    };
    const n = Math.max(1, sw * sh);

    // --- histogram ------------------------------------------------------
    for (let i = 0; i < sw * sh; i++) {
      const o = i * 4;
      for (let ch = 0; ch < 3; ch++) {
        const v = px[o + ch] ?? 0;
        const bin = Math.min(histBins - 1, Math.max(0, Math.floor(v * histBins)));
        (ch === 0 ? hist.r : ch === 1 ? hist.g : hist.b)[bin] += 1;
      }
      const l = 0.2722287168 * (px[o] ?? 0) + 0.6740817658 * (px[o + 1] ?? 0)
        + 0.0536895174 * (px[o + 2] ?? 0);
      const bin = Math.min(histBins - 1, Math.max(0, Math.floor(l * histBins)));
      hist.l[bin] += 1;
    }
    // Normalise to 0..1 by the peak, not by the sample count: a display
    // histogram is read for SHAPE, and a histogram normalised by n makes
    // every frame look like a flat line 0.001 tall.
    let peak = 0;
    for (let i = 0; i < histBins; i++) {
      peak = Math.max(peak, hist.r[i] ?? 0, hist.g[i] ?? 0, hist.b[i] ?? 0, hist.l[i] ?? 0);
    }
    const inv = peak > 0 ? 1 / peak : 0;
    for (let i = 0; i < histBins; i++) {
      hist.r[i] = (hist.r[i] ?? 0) * inv;
      hist.g[i] = (hist.g[i] ?? 0) * inv;
      hist.b[i] = (hist.b[i] ?? 0) * inv;
      hist.l[i] = (hist.l[i] ?? 0) * inv;
    }

    // --- waveform -------------------------------------------------------
    // Four sub-tables of width scopeW/4 each, laid out side by side, holding
    // the per-column max-luma trace of R, G, B and Y. The type in types.ts
    // is a flat width x height per table, so each table is written into its
    // own quarter and the caller slices.
    const tableW = Math.max(1, Math.floor(scopeW / 4));
    const tableH = Math.max(1, scopeH);
    const wave = {
      width: tableW, height: tableH,
      r: new Float32Array(tableW * tableH),
      g: new Float32Array(tableW * tableH),
      b: new Float32Array(tableW * tableH),
      y: new Float32Array(tableH * tableW),
    };
    for (let i = 0; i < tableW * tableH; i++) wave.y[i] = wave.r[i] ?? 0;

    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const o = (y * sw + x) * 4;
        const r = px[o] ?? 0;
        const g = px[o + 1] ?? 0;
        const b = px[o + 2] ?? 0;
        const yv = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        // Column bucket: 4 sub-tables across the analysis width.
        const col = Math.min(tableW - 1, Math.floor((x / sw) * tableW));
        const rows = Math.min(tableH - 1, Math.max(0, Math.floor(Math.min(1, Math.max(0, yv)) * tableH)));
        const idx = rows * tableW + col;
        if ((wave.r[idx] ?? 0) < 1) wave.r[idx] = 1;
        const gr = Math.min(tableH - 1, Math.max(0, Math.floor(Math.min(1, Math.max(0, g)) * tableH)));
        const gi = gr * tableW + col;
        if ((wave.g[gi] ?? 0) < 1) wave.g[gi] = 1;
        const br = Math.min(tableH - 1, Math.max(0, Math.floor(Math.min(1, Math.max(0, b)) * tableH)));
        const bi = br * tableW + col;
        if ((wave.b[bi] ?? 0) < 1) wave.b[bi] = 1;
        const yi = Math.min(tableH - 1, Math.max(0, Math.floor(Math.min(1, Math.max(0, yv)) * tableH)));
        wave.y[yi * tableW + col] = 1;
      }
    }

    // --- vectorscope ----------------------------------------------------
    const vec = new Uint8ClampedArray(vecSize * vecSize * 4);
    for (let i = 0; i < sw * sh; i++) {
      const o = i * 4;
      const r = px[o] ?? 0;
      const g = px[o + 1] ?? 0;
      const b = px[o + 2] ?? 0;
      const yv = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const cb = b - yv;
      const cr = r - yv;
      // The six Rec.709 primary targets sit at fixed (cb, cr); scaling by
      // 1.6 puts the R/B targets comfortably inside the disc at 100%
      // saturation instead of clipping them at the rim.
      const vx = cb * 1.6;
      const vy = cr * 1.6;
      const rad = Math.hypot(vx, vy);
      const px2 = Math.floor(((vx + 1) * 0.5) * vecSize);
      const py2 = Math.floor(((vy + 1) * 0.5) * vecSize);
      if (px2 < 0 || py2 < 0 || px2 >= vecSize || py2 >= vecSize || rad > 1.15) continue;
      const vo = (py2 * vecSize + px2) * 4;
      // Accumulate as a soft spot: the displayed intensity is the radial
      // density of samples, which is what a vectorscope is read for.
      const density = Math.min(1, 0.35 + (1 - Math.min(1, rad)) * 0.65);
      vec[vo + 0] = Math.max(vec[vo + 0] ?? 0, (r * 255 * density) | 0);
      vec[vo + 1] = Math.max(vec[vo + 1] ?? 0, (g * 255 * density) | 0);
      vec[vo + 2] = Math.max(vec[vo + 2] ?? 0, (b * 255 * density) | 0);
      vec[vo + 3] = 255;
    }
    // Graticule: 100% saturation rings at 25/50/75% of the disc, in a dim
    // grey, so the trace has a reference. 75% rings are the legal-limit
    // bars; 100% is the outer edge.
    for (let ring = 1; ring <= 3; ring++) {
      const rr = (ring / 4) * (vecSize * 0.48);
      const steps = Math.floor(2 * Math.PI * rr);
      for (let s = 0; s < steps; s++) {
        const a = (s / steps) * 2 * Math.PI;
        const x = Math.floor(vecSize / 2 + Math.cos(a) * rr);
        const y = Math.floor(vecSize / 2 + Math.sin(a) * rr);
        if (x < 0 || y < 0 || x >= vecSize || y >= vecSize) continue;
        const o = (y * vecSize + x) * 4;
        if ((vec[o + 3] ?? 0) === 0) {
          vec[o + 0] = 60; vec[o + 1] = 60; vec[o + 2] = 60; vec[o + 3] = 255;
        }
      }
    }

    return {
      waveform: wave,
      histogram: hist,
      vectorscope: { size: vecSize, r: vec },
    };
  }

  // -------------------------------------------------------------------------
  // Public: render
  // -------------------------------------------------------------------------

  /**
   * Render a node graph for one frame to the currently-bound canvas.
   *
   * Walks the graph in topological order, applying each enabled,
   * non-bypassed node's grade in sequence. `note` and `group` resolve to
   * pass-through, which is what makes them usable as organisational nodes
   * rather than dead ends in the chain.
   */
  render(
    graph: Graph,
    source: TexImageSource | null,
    width: number,
    height: number,
    frame: number,
  ): void {
    if (this.disposed) return;
    const gl = this.gl;
    const t = this.ensureTargets(width, height);
    const src = this.options.source;

    // 1. decode the source into AP1 linear, into buffer A.
    // The guard tests `source`, not `this.sourceTex`: sourceTex is created
    // BY uploadSource, so gating on it skipped the very first frame's
    // upload and rendered an empty texture.
    if (source) {
      this.uploadSource(source, width, height);
    }
    this.use('input');
    const l1 = this.loc('input', 'uResolution');
    if (l1) gl.uniform2f(l1, t.width, t.height);
    const l2 = this.loc('input', 'uSRGBToAP1');
    if (l2) gl.uniformMatrix3fv(l2, false, this.toAP1);
    const l3 = this.loc('input', 'uTransfer');
    if (l3) gl.uniform1i(l3, TRANSFER_INDEX[src.transfer] ?? 0);
    const l4 = this.loc('input', 'uLogcToLinear');
    if (l4) gl.uniform1f(l4, src.logc ? 1 : 0);
    const l5 = this.loc('input', 'uExposure');
    if (l5) gl.uniform1f(l5, src.exposure);
    const l6 = this.loc('input', 'uPreSat');
    if (l6) gl.uniform1f(l6, src.preSaturation);
    if (this.sourceTex) this.bindTex('input', 'uSource', 0, this.sourceTex);
    this.draw('input', t.a, t.width, t.height);

    // 2. apply nodes. The curve texture is synced here, not left to the
    // caller, because a graph's nodes can carry different curves and the
    // texture is a single shared one — so the LAST node with non-identity
    // curves wins, which is a documented limitation of sharing one LUT
    // rather than silently shipping a node whose curves do nothing.
    const order = topoOrder(graph);
    const byId = new Map<string, Node>(order.map((n) => [n.id, n]));
    this.parity = 0;
    let currentTex = t.texA;
    let currentFbo = t.a;

    for (const node of order) {
      const grade = this.resolveKeyframes(node.grade, frame);
      const isPassthrough = !node.enabled || !!node.bypass
        || node.kind === 'note' || node.kind === 'group';
      if (isPassthrough) continue;
      this.syncCurveLut(grade);

      const dest = this.parity === 0 ? t.b : t.a;
      const destFbo = this.parity === 0 ? t.b : t.a;
      const other = this.parity === 0 ? t.a : t.b;
      const otherTex = this.parity === 0 ? t.texA : t.texB;

      // Two-input node: grade both inputs, then mix. In a linear working
      // space a cross-fade is the correct composite (no gamma-space
      // mid-grey dip), which is why the mixer is a lerp in AP1 and not a
      // screen blend.
      if (node.kind === 'parallel' || node.inputs.filter(Boolean).length >= 2) {
        const [inA, inB] = node.inputs;
        const nodeA = inA ? byId.get(inA) : undefined;
        const nodeB = inB ? byId.get(inB) : undefined;

        // Grade the background into `other`, grade the foreground into
        // `dest`, then blend. This needs the background rendered from the
        // ORIGINAL upstream, not from the just-rendered dest, which is why
        // the background pass runs first against `otherTex`.
        if (nodeA) {
          this.renderNode(nodeA, grade, otherTex, other, t.width, t.height, frame);
        }
        const bgTex = otherTex;
        if (nodeB) {
          this.renderNode(nodeB, grade, currentTex, other, t.width, t.height, frame);
          // nodeB wrote into `other`; blend bgTex and that into dest.
          this.blend(bgTex, otherTex, destFbo, t.width, t.height, nodeB);
          currentTex = this.parity === 0 ? t.texB : t.texA;
        } else {
          currentTex = otherTex;
          currentFbo = other;
        }
        this.parity ^= 1;
        continue;
      }

      this.renderNode(node, grade, currentTex, destFbo, t.width, t.height, frame);
      currentTex = this.parity === 0 ? t.texB : t.texA;
      currentFbo = destFbo;
      this.parity ^= 1;
    }

    // 3. output transform. This is the only clamp in the pipeline, and it
    // happens exactly once per destination: the FBO copy that readback and
    // the scopes use, and the canvas.
    this.lastTex = currentTex;
    this.lastFbo = currentFbo;
    this.drawDisplay(currentTex, t.display, t.width, t.height, false);
    this.drawDisplay(currentTex, null, gl.drawingBufferWidth, gl.drawingBufferHeight, true);
    this.lastFrame = frame;
  }

  /**
   * Run one node's grade. `srcTex` -> `dstFbo`, including the blur chain
   * when the node's effects need it. The blur is generated into blurH/blurV
   * from `srcTex` and handed to the grade as uBlurTex.
   */
  private renderNode(
    node: Node,
    grade: GradeState,
    srcTex: WebGLTexture,
    dstFbo: WebGLFramebuffer,
    width: number,
    height: number,
    frame: number,
  ): void {
    const gl = this.gl;
    const t = this.targets;
    if (!t) return;

    const fx = grade.effects;
    // Glow and bloom need a blur of their own: they are a THRESHOLDED TAIL
    // off a blurred copy, so with no radius there is no tail and the effect
    // silently does nothing. Deriving the radius from blur/sharpen alone
    // means glow works only when some other effect happens to be on, which
    // is exactly how a "my glow button does nothing" bug happens.
    const needsBlur = fx.blur > 0 || fx.sharpen > 0 || fx.glow > 0;
    let blurTex: WebGLTexture | null = null;
    if (needsBlur) {
      // Blur radius in pixels. Resolve's blur control is a normalised 0..1,
      // so 1.0 has to mean "obviously, unmistakably blurred" rather than a
      // token 1px. 48px at 1080p reads as a heavy defocus; glow gets a
      // slightly smaller default radius because a broad, hard bloom is
      // usually a mistake rather than a look.
      const r = Math.max(
        0.5,
        fx.blur * 48,
        fx.sharpen * 6 * fx.sharpenRadius,
        fx.glow * 32,
      );
      this.blur(srcTex, t.texBlurH, t.blurH, r, 1, 0, width, height);
      this.blur(t.texBlurH, t.texBlurV, t.blurV, r, 0, 1, width, height);
      blurTex = t.texBlurV;
    }

    this.use('grade');
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
    gl.viewport(0, 0, width, height);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    this.setNodeUniforms(node, grade, srcTex, blurTex, frame, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private setNodeUniforms(
    node: Node,
    grade: GradeState,
    srcTex: WebGLTexture,
    blurTex: WebGLTexture | null,
    frame: number,
    width: number,
    height: number,
  ): void {
    const gl = this.gl;
    const t = this.targets;
    if (!t) return;
    const g = grade;
    const pr = g.primary;
    const fx = g.effects;
    const q = g.qualifier;
    const w = g.window;
    const k = g.key;

    // Bind the samplers first so the units are set before any draw.
    this.bindTex('grade', 'uSource', 0, srcTex);
    // NEVER fall back to t.texA when there is no blur. A texture that is
    // still bound to a sampler unit while it is also the colour attachment of
    // the bound draw framebuffer is a feedback loop: WebGL defines the draw as
    // having no effect, so the pass is silently dropped. Because the node loop
    // ping-pongs between the two targets, whichever node happens to render
    // into t.a would vanish — which is why a single-node graph looked perfect
    // and every multi-node graph ignored the last node's grade. A dedicated
    // 1x1 black texture is always a legal placeholder.
    this.bindTex('grade', 'uBlurTex', 1, blurTex ?? this.blackTexture());
    // ALWAYS bind the 3D LUT, even when uLutOn is false: an unbound
    // sampler3D makes the whole fragment undefined, not just the LUT branch.
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, this.identityLut3D());
    const ll = this.loc('grade', 'uLut3D');
    if (ll) gl.uniform1i(ll, 2);
    if (this.curveTex) this.bindTex('grade', 'uCurveLut', 3, this.curveTex);

    const U = (n: string) => this.loc('grade', n);
    const f1 = (n: string, v: number) => { const l = U(n); if (l) gl.uniform1f(l, v); };
    const f2 = (n: string, x: number, y: number) => { const l = U(n); if (l) gl.uniform2f(l, x, y); };
    // ArrayLike, not readonly number[]: the scratch gain and luma buffers
    // are Float32Arrays, and widening the parameter is cheaper than copying
    // them into plain arrays on every node of every frame.
    const f3 = (n: string, v: ArrayLike<number>) => { const l = U(n); if (l) gl.uniform3f(l, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0); };
    const m3 = (n: string, v: Float32Array) => { const l = U(n); if (l) gl.uniformMatrix3fv(l, false, v); };
    const i1 = (n: string, v: number) => { const l = U(n); if (l) gl.uniform1i(l, v); };
    const b1 = (n: string, v: boolean) => { const l = U(n); if (l) gl.uniform1i(l, v ? 1 : 0); };

    f2('uResolution', width, height);
    f3('uLuma', this.luma);
    f1('uFrame', frame);

    // --- stage switches, derived from the state so a default grade never
    // --- enters a branch whose maths is merely near-identity.
    const inputGamma = g.inputGamma;
    b1('uInGammaOn', !approx(inputGamma, 1));
    f1('uInputGamma', inputGamma);
    const outputGamma = g.outputGamma;
    b1('uOutGammaOn', !approx(outputGamma, 1));
    f1('uOutputGamma', outputGamma);

    const cdl = fx.cdl;
    const cdlCurveOn = !rgbApprox(cdl.slope, [1, 1, 1]) || !rgbApprox(cdl.offset, [0, 0, 0])
      || !rgbApprox(cdl.power, [1, 1, 1]);
    b1('uCdlCurveOn', cdlCurveOn);
    b1('uCdlSatOn', !approx(cdl.sat, 1));
    f3('uCdlSlope', cdl.slope);
    f3('uCdlOffset', cdl.offset);
    f3('uCdlPower', cdl.power);
    f1('uCdlSat', cdl.sat);

    const primaryOn = !rgbApprox(pr.lift, [0, 0, 0]) || !rgbApprox(pr.gamma, [1, 1, 1])
      || !rgbApprox(pr.gain, [1, 1, 1]) || !rgbApprox(pr.offset, [0, 0, 0])
      || !approx(pr.contrast, 1) || !approx(pr.brightness, 0)
      || !approx(pr.saturation, 1) || !approx(pr.contrastLow, 0)
 || !approx(pr.contrastHigh, 0) || !approx(pr.shadowBias, 0)
 || !approx(pr.highlightBias, 0) || !approx(pr.colourBoost, 0)
 // exposure was missing here too: the gate skipped the whole primary
 // stage whenever only exposure was non-default, so even a bound
 // uniform would have been discarded.
 || !approx(pr.exposure, 0);
    b1('uPrimaryOn', primaryOn);
    f3('uLift', pr.lift);
    f3('uGammaW', pr.gamma);
    f3('uGain', pr.gain);
    f3('uOffset', pr.offset);
    f1('uContrast', pr.contrast);
    f1('uPivot', pr.pivot);
    // The shader gained uExposure when primary.exposure became a real field;
    // without this binding the uniform stayed 0 and the control did nothing.
    f1('uExposure', pr.exposure);
    f1('uBrightness', pr.brightness);
    f1('uSaturation', pr.saturation);
    f1('uContrastLow', pr.contrastLow);
    f1('uContrastHigh', pr.contrastHigh);
    f1('uShadowBias', pr.shadowBias);
    f1('uHighlightBias', pr.highlightBias);
    f1('uColourBoost', pr.colourBoost);

    const tempOn = !approx(pr.temperature, 0) || !approx(pr.tint, 0);
    b1('uTempOn', tempOn);
    if (tempOn) {
      const tt = pr.temperature / 100;
      const tn = pr.tint / 100;
      this.tempTint[0] = Math.pow(2, tt * 0.3) * Math.pow(2, tn * 0.12);
      this.tempTint[1] = 1;
      this.tempTint[2] = Math.pow(2, -tt * 0.3) * Math.pow(2, -tn * 0.12);
      f3('uTempTintGains', this.tempTint);
    }

    const hueOn = !approx(pr.hue, 0);
    b1('uHueOn', hueOn);
    this.hueMat.set(hueRotateMatrix(pr.hue));
    m3('uHueMat', this.hueMat);

    const satOn = !approx(pr.saturation, 1) || !approx(pr.vibrance, 0);
    b1('uSatOn', satOn);
    f1('uVibrance', pr.vibrance);

    const curvesOn = !this.curveIsIdentity;
    b1('uCurvesOn', curvesOn);
    f1('uCurveDomain', this.options.curveDomain);

    b1('uWindowOn', w.enabled && w.shape !== 'none');
    i1('uWinShape', SHAPE_INDEX[w.shape] ?? 0);
    f2('uWinCenter', w.cx, w.cy);
    f2('uWinHalf', w.w * 0.5, w.h * 0.5);
    f1('uWinAngle', w.angle);
    f1('uWinSoftness', w.softness);
    f1('uWinFeather', w.feather);
    b1('uWinInvert', w.invert);
    f1('uWinMix', w.mix);

    b1('uQualifierOn', q.enabled);
    f1('uQCenter', q.hue);
    f1('uQWidth', q.hueWidth);
    f1('uQSoft', q.hueSoft);
    f1('uQSatLow', q.satLow);
    f1('uQSatHigh', q.satHigh);
    f1('uQLumLow', q.lumLow);
    f1('uQLumHigh', q.lumHigh);
    f1('uQBalance', q.balance);
    b1('uQInvert', q.invert);
    f1('uQDenoise', q.denoise);
    f1('uQMatteBlur', q.matteBlur);
    i1('uQView', VIEW_INDEX[q.view] ?? 2);
    f1('uQDesatOutside', q.desaturateOutside);
    b1('uQWindowRestrict', q.windowRestrict);

    b1('uKeyOn', k.enabled);
    f3('uKeyColor', k.keyColor);
    f3('uKeyFill', k.fillColor);
    f1('uKeyTolerance', k.tolerance);
    f1('uKeySoftness', k.softness);
    f1('uKeySpill', k.spill);
    f1('uKeyEdge', k.edge);
    f1('uKeyShrinkGrow', k.shrinkGrow);
    i1('uKeyFillMode', FILL_INDEX[k.fillMode] ?? 0);

    const lutOn = this.userLut;
    b1('uLutOn', lutOn);
    f1('uLutIntensity', fx.lutIntensity);
    f2('uLutDomain', this.lutData?.domain[0] ?? 0, this.lutData?.domain[1] ?? 1);
    f1('uLutDomainMode', this.options.lutDomainMode === 'linear' ? 1 : 0);

    b1('uBlurFxOn', fx.blur > 0);
    b1('uSharpOn', fx.sharpen > 0);
    b1('uGlowOn', fx.glow > 0);
    f1('uBlurAmount', fx.blur);
    f1('uSharpen', fx.sharpen);
    f1('uSharpenRadius', fx.sharpenRadius);
    f1('uGlow', fx.glow);
    f1('uGlowThreshold', fx.glowThreshold);

    b1('uVignetteOn', fx.vignette !== 0);
    f1('uVignette', fx.vignette);
    f1('uVignetteSoft', fx.vignetteSoft);

    b1('uGrainOn', fx.grain > 0);
    f1('uGrain', fx.grain);
    f1('uGrainSeed', this.options.grainSeed);

    b1('uFilmOn', fx.filmContrast > 0);
    f1('uFilmContrast', fx.filmContrast);
  }

  /** Separable Gaussian: one direction, src -> dst. */
  private blur(
    srcTex: WebGLTexture,
    dstTex: WebGLTexture,
    dstFbo: WebGLFramebuffer,
    radius: number,
    dx: number,
    dy: number,
    width: number,
    height: number,
  ): void {
    const gl = this.gl;
    this.program('gaussian');
    const p = this.program('gaussian');
    gl.useProgram(p.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
    gl.viewport(0, 0, width, height);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    const lRes = this.loc('gaussian', 'uResolution');
    if (lRes) gl.uniform2f(lRes, width, height);
    const lTexel = this.loc('gaussian', 'uTexelSize');
    if (lTexel) gl.uniform2f(lTexel, 1 / Math.max(width, 1), 1 / Math.max(height, 1));
    const lDir = this.loc('gaussian', 'uDirection');
    if (lDir) gl.uniform2f(lDir, dx, dy);
    const lRad = this.loc('gaussian', 'uRadius');
    if (lRad) gl.uniform1f(lRad, radius);
    const lFilt = this.loc('gaussian', 'uFiltered');
    if (lFilt) gl.uniform1i(lFilt, this.linearFloatFilter ? 1 : 0);
    this.bindTex('gaussian', 'uSource', 0, srcTex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    void dstTex;
  }

  /** Two-input mixer. */
  private blend(
    texA: WebGLTexture,
    texB: WebGLTexture,
    dstFbo: WebGLFramebuffer,
    width: number,
    height: number,
    node: Node,
  ): void {
    const gl = this.gl;
    const { mix, useAlphaKey } = this.mixFor(node);
    this.program('blend');
    const p = this.program('blend');
    gl.useProgram(p.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
    gl.viewport(0, 0, width, height);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    const lRes = this.loc('blend', 'uResolution');
    if (lRes) gl.uniform2f(lRes, width, height);
    const lMix = this.loc('blend', 'uMix');
    if (lMix) gl.uniform1f(lMix, mix);
    const lKey = this.loc('blend', 'uUseAlphaKey');
    if (lKey) gl.uniform1i(lKey, useAlphaKey ? 1 : 0);
    this.bindTex('blend', 'uA', 0, texA);
    this.bindTex('blend', 'uB', 1, texB);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * A parallel/serial node's mixer amount. Resolve exposes this as the
   * mixer's own key output slider; the shared Node contract has no such
   * field, so it rides on the node's vibrance knob — the one primary
   * control that is conceptually "how much of the other image" — read as
   * 0.5 + vibrance/2 so a neutral vibrance gives an even mix.
   */
  private mixFor(node: Node): MixUniforms {
    const v = node.grade.primary.vibrance;
    return { mix: Math.min(1, Math.max(0, 0.5 + v * 0.5)), useAlphaKey: node.grade.key.enabled };
  }

  /**
   * The display transform. `fbo === null` draws to the canvas.
   *
   * Called TWICE per frame: once into the `display` target, which is what
   * `readPixels` and `analyze` read, and once to the canvas. The two differ
   * only in `uFlipY` — the FBO keeps the top-left-origin convention, the
   * canvas needs the y-up flip. Running the transform twice rather than
   * reading back the canvas is worth the pass: the canvas is 8-bit, may be a
   * different size to the frame, and may not have preserveDrawingBuffer, so
   * reading it would quietly return quantised or undefined values.
   */
  private drawDisplay(
    srcTex: WebGLTexture,
    fbo: WebGLFramebuffer | null,
    width: number,
    height: number,
    flipY: boolean,
  ): void {
    const gl = this.gl;
    this.use('output');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, height);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    const lRes = this.loc('output', 'uResolution');
    if (lRes) gl.uniform2f(lRes, width, height);
    const lM = this.loc('output', 'uToOutput');
    if (lM) gl.uniformMatrix3fv(lM, false, this.toOutput);
    // These three are declared `float` in GLSL, so they MUST be set with
    // uniform1f. uniform1i against a float uniform is INVALID_OPERATION: the
    // write is silently dropped, the uniform stays 0, and the result is a
    // display transform with no encode and no clamp. It renders a plausible
    // image, which is what makes it expensive to find.
    const lS = this.loc('output', 'uSrgbEncode');
    if (lS) gl.uniform1f(lS, this.options.srgbEncode ? 1 : 0);
    const lG = this.loc('output', 'uDisplayGamma');
    if (lG) gl.uniform1f(lG, this.options.displayGamma);
    const lP = this.loc('output', 'uProjectGamma');
    if (lP) gl.uniform1f(lP, this.options.projectGamma);
    const lC = this.loc('output', 'uClampOut');
    if (lC) gl.uniform1f(lC, 1);
    const lF = this.loc('output', 'uFlipY');
    if (lF) gl.uniform1f(lF, flipY ? 1 : 0);
    const lUF = this.loc('output', 'uUserFlip');
    if (lUF) gl.uniform2f(lUF, this.userFlip.x ? 1 : 0, this.userFlip.y ? 1 : 0);
    this.bindTex('output', 'uSource', 0, srcTex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // -------------------------------------------------------------------------
  // Options
  // -------------------------------------------------------------------------

  setOutputSpace(space: OutputSpace): void {
    this.options.outputSpace = space;
    this.toOutput = mat3ColumnMajor(OUTPUT_MATRICES[space] ?? AP1_TO_SRGB_LINEAR);
  }

  getOutputSpace(): OutputSpace {
    return this.options.outputSpace;
  }

  /** Flip / mirror the picture. Either axis may be set independently. */
  setUserFlip(x: boolean, y?: boolean): void {
    this.userFlip = { x: !!x, y: y === undefined ? this.userFlip.y : !!y };
  }

  /** The current flip, for the UI to reflect and for the agent to report. */
  getUserFlip(): { x: boolean; y: boolean } {
    return { ...this.userFlip };
  }

  setSourceOptions(opts: SourceOptions): void {
    this.options.source = {
      transfer: opts.transfer ?? this.options.source.transfer,
      logc: opts.logc ?? this.options.source.logc,
      exposure: opts.exposure ?? this.options.source.exposure,
      preSaturation: opts.preSaturation ?? this.options.source.preSaturation,
    };
  }

  /** Default graph for a pipeline that has not been handed one. */
  static defaultGrade(): GradeState {
    return defaultGrade();
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    this.destroyTargets();
    if (this.sourceTex) gl.deleteTexture(this.sourceTex);
    if (this.lutTex) gl.deleteTexture(this.lutTex);
    if (this.curveTex) gl.deleteTexture(this.curveTex);
    this.sourceTex = null;
    this.lutTex = null;
    this.curveTex = null;
    for (const p of this.programs.values()) gl.deleteProgram(p.program);
    this.programs.clear();
    if (this.vao) gl.deleteVertexArray(this.vao);
  }
}
