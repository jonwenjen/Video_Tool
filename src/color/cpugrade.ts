/**
 * CPU reference implementation of the grade math.
 *
 * WHY THIS EXISTS: the GPU path does the real-time work, but the agent bridge,
 * the auto-balance features, the still exporter and the test suite all need a
 * deterministic, headless, byte-for-byte-predictable answer to "what does this
 * grade do?". This file is that answer. It must stay in stage order with the
 * shader; when the shader changes, this changes in the same commit.
 *
 * ---------------------------------------------------------------------------
 * THE ONE INVARIANT
 * ---------------------------------------------------------------------------
 * At defaultGrade() the whole chain is the identity function. Not "close to",
 * not "within 1e-6" — the output is the input. A null config that changes
 * pixels is the single most common bug in a browser colour tool: it is
 * invisible in a still, it shows up as a slow drift in a grade built from a
 * dozen nodes, and by then nobody remembers touching the input transform.
 *
 * The two ways it breaks, and how this file defends against each:
 *   1. A stage that is not quite a no-op (pow(x,1), lerp(a,b,1), s + 0*s).
 *      Every stage below is guarded by an explicit "is this active?" test and
 *      skipped wholesale when the answer is no. No guard, no float wobble.
 *   2. A convolution with an amount of 0 that is still a convolution. blur,
 *      glow, sharpen, denoise, matteBlur and the key's shrink/grow are real
 *      separable filters — but they allocate nothing and touch nothing when
 *      their amount is 0.
 *
 * ---------------------------------------------------------------------------
 * COLOUR HOUSE RULES (inherited from core/colormath.ts, not negotiable)
 * ---------------------------------------------------------------------------
 * - Everything is float and UNCLAMPED end to end. Clamping happens once, in
 *   the display encode, and nowhere else.
 * - Luma weights come from the working space, never from memory. This engine
 *   grades in AP1, so AP1_LUMA is the luma everywhere; Rec.709 weights on a
 *   wide gamut is an error, not a rounding detail.
 * - Only forward RGB->XYZ matrices are trusted. The sRGB <-> AP1 pair here is
 *   the computed one from colormath, which carries the Bradford D65->D60 step.
 *   Use the exported matrices, do not hand-write another pair.
 *
 * ES2022 / strict TS. Relative imports carry .js for the type stripper.
 */

import type {
  CurvePoint,
  EffectsState,
  GradeState,
  Interp,
  KeyState,
  KeyframeTrack,
  Lut3D,
  OutputSpace,
  PrimaryState,
  QualifierState,
  RGB,
  WindowState,
  WorkingSpace,
} from '../core/types.js';
import {
  AP1_LUMA,
  AP1_TO_P3D65,
  AP1_TO_REC2020,
  AP1_TO_SRGB_LINEAR,
  P3_LUMA,
  REC709_LUMA,
  SRGB_LINEAR_TO_AP1,
  hueRotate,
  hslToRgb,
  lumaAP1,
  logcDecode,
  logcEncode,
  mat3Vec,
  rgbToHsl,
  tempTintGains,
  type Mat3,
} from '../core/colormath.js';
import { cloneGrade, defaultGrade } from '../core/defaults.js';

// ===========================================================================
// Context
// ===========================================================================

/**
 * Everything applyGrade needs that is not the grade itself.
 *
 * lutIntensity and workingSpace are optional on purpose: a caller that just
 * wants the chain evaluated should not have to name a colour space to get the
 * right answer, and the identity invariant must not depend on it.
 */
export interface GradeContext {
  /** Frame width in pixels. */
  width: number;
  /** Frame height in pixels. */
  height: number;
  /** Timeline frame, used for grain seeding and keyframe resolution. */
  frame: number;
  /** Resolved 3D LUT data. The id lives in effects.lut; the bytes live here. */
  lut?: Lut3D | null;
  /** Overrides effects.lutIntensity when set. */
  lutIntensity?: number;
  /** Selects the luma weights used by the analysis and scope helpers. */
  workingSpace?: WorkingSpace;
  /** Selects the matrix used by the display encode. */
  outputSpace?: OutputSpace;
}

/** Tightened context for the auto-balance estimators, which never need a frame. */
export interface AutoOptions {
  /** 'neutral' (default) | 'white-balance' | 'grey-world' | 'white-point' */
  method?: 'neutral' | 'white-balance' | 'grey-world' | 'white-point';
  /** 0..1, how much of the estimated correction to ask for. */
  strength?: number;
  /** Luma window of samples admitted, in scene-linear units. */
  lumaLow?: number;
  lumaHigh?: number;
  /** Hard clamp on the returned gains so a black frame cannot explode them. */
  gainClamp?: [number, number];
  /** Sample budget; larger frames are strided down to this. */
  maxSamples?: number;
}

export interface LevelsOptions {
  /** Lower input percentile treated as black, 0..0.5. */
  lowPercentile?: number;
  /** Upper input percentile treated as white, 0.5..1. */
  highPercentile?: number;
  /** Where the black point should land, 0..1. */
  targetLow?: number;
  /** Where the white point should land, 0..1. */
  targetHigh?: number;
  /** Extra guard rails; the contract ranges are the defaults. */
  contrastRange?: [number, number];
  pivotRange?: [number, number];
  maxSamples?: number;
}

/** Per-channel mean, luma percentiles, clipping fractions and the cast read. */
export interface FrameAnalysis {
  mean: RGB;
  median: number;
  p05: number;
  p95: number;
  clipped: { r: number; g: number; b: number; total: number };
  neutralRatio: number;
  /** 0..1 hue of the dominant chroma, or -1 when the frame is achromatic. */
  dominantHue: number;
  /** Representative colour of that hue, mid saturation and lightness. */
  dominantColor: RGB;
  luma: { min: number; max: number; mean: number };
  pixelCount: number;
}

export interface HistogramData {
  bins: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  l: Float32Array;
}

export interface WaveformData {
  width: number;
  height: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  y: Float32Array;
}

// ===========================================================================
// Scalar helpers
// ===========================================================================

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite smoothstep on an already-normalised t. */
function smoothstep01(t: number): number {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
}

/** Smoothstep between two edges, with a hard step when the edges coincide. */
function smoothstepEdge(x: number, e0: number, e1: number): number {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  return smoothstep01((x - e0) / (e1 - e0));
}

/**
 * Sign-preserving power. Math.pow throws away the sign of a negative base
 * with a fractional exponent, and a sign flip mid-chain reads as a bug in the
 * grade that nobody can find. p === 1 returns v untouched.
 */
function spow(v: number, p: number): number {
  if (p === 1) return v;
  const a = Math.abs(v);
  return v < 0 ? -Math.pow(a, p) : Math.pow(a, p);
}

/** Luma for a working space. Never hardcode Rec.709 weights on a wide gamut. */
export function lumaWeights(space: WorkingSpace | undefined): readonly [number, number, number] {
  switch (space) {
    case 'srgb':
    case 'timeline-gamma':
      return REC709_LUMA;
    case 'display-p3':
      return P3_LUMA;
    default:
      return AP1_LUMA;
  }
}

function lumaIn(
  r: number, g: number, b: number, w: readonly [number, number, number],
): number {
  return w[0] * r + w[1] * g + w[2] * b;
}

/**
 * Luma mapped into 0..1 for a scene-linear, unclamped pixel.
 *
 * WHY Reinhard and not a clamp: a qualifier's lumHigh of 0.5 has to mean
 * "up to the middle of the tonal range" on a pixel that is allowed to sit at
 * 8.0. Clamping would put every highlight in the same bucket and make the
 * luminance axis of the key useless above 1.0.
 */
function tonal(luma: number): number {
  if (!(luma > 0)) return 0;
  return luma / (1 + luma);
}

/** Circular distance between two 0..1 hues, 0..0.5. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return d > 0.5 ? 1 - d : d;
}

/**
 * Deterministic per-pixel noise in 0..1. Integer mixing only — Math.random
 * would make the Deliver still export irreproducible and the tests flaky.
 */
function hash01(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ===========================================================================
// GradeBuffer
// ===========================================================================

/**
 * 2D RGB working surface. blur, glow, sharpen, the qualifier's denoise and the
 * key's shrink/grow all need neighbours, and a Float32Array of triplets does
 * not have them. Everything downstream of GradeBuffer construction is
 * two-dimensional, including the analysis helpers, because a stripe-aware
 * grain or vignette is a bug you cannot see.
 */
export class GradeBuffer {
  readonly width: number;
  readonly height: number;
  /** width * height * 3, row major, R first. */
  readonly data: Float32Array;

  constructor(width: number, height: number, data?: Float32Array) {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
    const n = this.width * this.height * 3;
    if (data && data.length === n) {
      this.data = data;
    } else if (data) {
      this.data = new Float32Array(n);
      this.data.set(data.subarray(0, Math.min(n, data.length)));
    } else {
      this.data = new Float32Array(n);
    }
  }

  get length(): number {
    return this.width * this.height;
  }

  static fromRGB(rgb: Float32Array, width: number, height: number): GradeBuffer {
    const n = Math.floor(rgb.length / 3);
    const buf = new GradeBuffer(width, height);
    buf.data.set(rgb.subarray(0, Math.min(rgb.length, buf.data.length)));
    // A trailing partial triplet is a malformed frame, not a colour. Drop it
    // rather than letting the zero-fill invent a black pixel at the edge.
    if (buf.data.length > n * 3) buf.data.fill(0, n * 3);
    return buf;
  }

  toRGB(): Float32Array {
    return this.data.slice();
  }

  clone(): GradeBuffer {
    return new GradeBuffer(this.width, this.height, this.data.slice());
  }

  /** Edge-clamped read. Out-of-range convolution taps read the border pixel. */
  at(x: number, y: number): RGB {
    const xi = clamp(x | 0, 0, this.width - 1);
    const yi = clamp(y | 0, 0, this.height - 1);
    const i = (yi * this.width + xi) * 3;
    const d = this.data;
    return [d[i], d[i + 1], d[i + 2]];
  }

  set(x: number, y: number, rgb: readonly number[]): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.data[i] = rgb[0];
    this.data[i + 1] = rgb[1];
    this.data[i + 2] = rgb[2];
  }

  lumaAt(x: number, y: number): number {
    const c = this.at(x, y);
    return lumaAP1(c[0], c[1], c[2]);
  }

  /**
   * In-place separable Gaussian. sigma <= 0 is a no-op that does not even
   * allocate the scratch — that is the whole point of the guard.
   */
  blurGaussian(sigma: number, scratch?: Float32Array): void {
    if (!(sigma > 0) || this.width < 1 || this.height < 1) return;
    const k = gaussianKernel(sigma);
    const tmp = scratch && scratch.length === this.data.length
      ? scratch
      : new Float32Array(this.data.length);
    const w = this.width;
    const h = this.height;
    const src = this.data;
    const r = (k.length - 1) >> 1;

    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let ar = 0, ag = 0, ab = 0;
        for (let t = -r; t <= r; t++) {
          const i = (row + clamp(x + t, 0, w - 1)) * 3;
          const kv = k[t + r];
          ar += src[i] * kv;
          ag += src[i + 1] * kv;
          ab += src[i + 2] * kv;
        }
        const o = (row + x) * 3;
        tmp[o] = ar;
        tmp[o + 1] = ag;
        tmp[o + 2] = ab;
      }
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let ar = 0, ag = 0, ab = 0;
        for (let t = -r; t <= r; t++) {
          const i = (clamp(y + t, 0, h - 1) * w + x) * 3;
          const kv = k[t + r];
          ar += tmp[i] * kv;
          ag += tmp[i + 1] * kv;
          ab += tmp[i + 2] * kv;
        }
        const o = (y * w + x) * 3;
        src[o] = ar;
        src[o + 1] = ag;
        src[o + 2] = ab;
      }
    }
  }

  /**
   * Separable box blur with a running sum. O(1) per pixel regardless of
   * radius, which is what makes the very wide glow kernel affordable.
   */
  boxBlur(radius: number, scratch?: Float32Array): void {
    const r = Math.floor(radius);
    if (!(r > 0) || this.width < 1 || this.height < 1) return;
    const tmp = scratch && scratch.length === this.data.length
      ? scratch
      : new Float32Array(this.data.length);
    const w = this.width;
    const h = this.height;
    const src = this.data;
    const norm = 1 / (2 * r + 1);

    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let ar = 0, ag = 0, ab = 0;
        for (let t = -r; t <= r; t++) {
          const i = (row + clamp(x + t, 0, w - 1)) * 3;
          ar += src[i]; ag += src[i + 1]; ab += src[i + 2];
        }
        const o = (row + x) * 3;
        tmp[o] = ar * norm;
        tmp[o + 1] = ag * norm;
        tmp[o + 2] = ab * norm;
      }
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let ar = 0, ag = 0, ab = 0;
        for (let t = -r; t <= r; t++) {
          const i = (clamp(y + t, 0, h - 1) * w + x) * 3;
          ar += tmp[i]; ag += tmp[i + 1]; ab += tmp[i + 2];
        }
        const o = (y * w + x) * 3;
        src[o] = ar * norm;
        src[o + 1] = ag * norm;
        src[o + 2] = ab * norm;
      }
    }
  }
}

/** Normalised 1D Gaussian, radius ceil(3 sigma). */
export function gaussianKernel(sigma: number): Float64Array {
  const s = Math.max(sigma, 1e-6);
  const r = Math.max(1, Math.ceil(s * 3));
  const k = new Float64Array(2 * r + 1);
  const inv = 1 / (2 * s * s);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-i * i * inv);
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** Grayscale morphology on a w*h matte buffer. shrinkGrow uses this. */
function morphMatte(
  m: Float32Array, w: number, h: number, radius: number, dilate: boolean,
): void {
  const tmp = new Float32Array(m.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1;
      for (let t = -radius; t <= radius; t++) {
        const s = m[row + clamp(x + t, 0, w - 1)];
        if (dilate) { if (s > v) v = s; } else if (s < v) v = s;
      }
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1;
      for (let t = -radius; t <= radius; t++) {
        const s = tmp[clamp(y + t, 0, h - 1) * w + x];
        if (dilate) { if (s > v) v = s; } else if (s < v) v = s;
      }
      m[y * w + x] = v;
    }
  }
}

/** Separable Gaussian on a w*h scalar buffer (mattes). */
function blurScalar(
  m: Float32Array, w: number, h: number, sigma: number, tmp: Float32Array,
): void {
  if (!(sigma > 0) || w < 1 || h < 1) return;
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) >> 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let t = -r; t <= r; t++) s += m[row + clamp(x + t, 0, w - 1)] * k[t + r];
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let t = -r; t <= r; t++) s += tmp[clamp(y + t, 0, h - 1) * w + x] * k[t + r];
      m[y * w + x] = s;
    }
  }
}

// ===========================================================================
// Partial-grade repair
// ===========================================================================

type AnyRec = Record<string, unknown>;

function mergeFields<T extends object>(base: T, patch: Partial<T> | undefined): T {
  const out = base as unknown as AnyRec;
  if (!patch) return out as T;
  for (const k of Object.keys(patch)) {
    const v = (patch as AnyRec)[k];
    if (v === undefined) continue;
    if (Array.isArray(v)) out[k] = v.slice();
    else if (v !== null && typeof v === 'object') out[k] = { ...(v as object) };
    else out[k] = v;
  }
  return out as T;
}

function mergeCurves(
  base: GradeState['curves'],
  patch: Partial<GradeState['curves']> | undefined,
): GradeState['curves'] {
  if (!patch) return base;
  const pick = (a: CurvePoint[] | undefined, b: CurvePoint[]): CurvePoint[] =>
    (a ?? b).map((p) => ({ x: p.x, y: p.y }));
  return {
    master: pick(patch.master, base.master),
    red: pick(patch.red, base.red),
    green: pick(patch.green, base.green),
    blue: pick(patch.blue, base.blue),
    mode: patch.mode ?? base.mode,
  };
}

/**
 * Fill a partial grade over the defaults.
 *
 * The agent bridge sends `set_grade { grade: Partial<GradeState> }`, so an
 * incoming object really can be missing primary, or primary.saturation, or
 * the whole curves block. Reading a field straight off a partial is how a
 * "null" config turns into a NaN pixel and a black export.
 */
export function resolveGrade(partial: Partial<GradeState>): GradeState {
  const d = defaultGrade();
  const g: GradeState = {
    primary: mergeFields(d.primary, partial.primary),
    curves: mergeCurves(d.curves, partial.curves),
    qualifier: mergeFields(d.qualifier, partial.qualifier),
    window: mergeFields(d.window, partial.window),
    key: mergeFields(d.key, partial.key),
    effects: mergeFields(d.effects, partial.effects),
    inputGamma: partial.inputGamma ?? d.inputGamma,
    outputGamma: partial.outputGamma ?? d.outputGamma,
    keyframes: partial.keyframes ?? d.keyframes,
  };
  g.effects.cdl = mergeFields(d.effects.cdl, partial.effects?.cdl);
  g.key.keyColor = (g.key.keyColor ?? d.key.keyColor).slice() as RGB;
  g.key.fillColor = (g.key.fillColor ?? d.key.fillColor).slice() as RGB;
  g.primary.lift = (g.primary.lift ?? d.primary.lift).slice() as RGB;
  g.primary.gamma = (g.primary.gamma ?? d.primary.gamma).slice() as RGB;
  g.primary.gain = (g.primary.gain ?? d.primary.gain).slice() as RGB;
  g.primary.offset = (g.primary.offset ?? d.primary.offset).slice() as RGB;
  g.effects.cdl.slope = (g.effects.cdl.slope ?? d.effects.cdl.slope).slice() as RGB;
  g.effects.cdl.offset = (g.effects.cdl.offset ?? d.effects.cdl.offset).slice() as RGB;
  g.effects.cdl.power = (g.effects.cdl.power ?? d.effects.cdl.power).slice() as RGB;
  return g;
}

// ===========================================================================
// Keyframes
// ===========================================================================

/**
 * The UI addresses saturation and vibrance under `effects.` in some places and
 * `primary.` in others; both spellings have to land on the same field or an
 * animated wheel silently stops animating.
 */
const PATH_ALIAS: Record<string, string> = {
  'effects.saturation': 'primary.saturation',
  'effects.vibrance': 'primary.vibrance',
  'effects.contrast': 'primary.contrast',
  'effects.hue': 'primary.hue',
  'effects.brightness': 'primary.brightness',
  'effects.pivot': 'primary.pivot',
  'primary.sat': 'primary.saturation',
};

function setPath(root: GradeState, path: string, value: number): boolean {
  const raw = path.split('.');
  if (raw.length < 2) return false;
  const head = `${raw[0]}.${raw[1]}`;
  const segs = PATH_ALIAS[head]
    ? [PATH_ALIAS[head], ...raw.slice(2)]
    : raw;

  let node: unknown = root;
  for (let i = 0; i < segs.length - 1; i++) {
    if (node === null || typeof node !== 'object') return false;
    node = (node as AnyRec)[segs[i]];
  }
  if (node === null || typeof node !== 'object') return false;
  (node as AnyRec)[segs[segs.length - 1]] = value;
  return true;
}

function interpShape(t: number, kind: Interp | undefined): number {
  switch (kind) {
    case 'hold': return 0;
    case 'ease': return smoothstep01(t);
    case 'ease-in': return t * t;
    case 'ease-out': return 1 - (1 - t) * (1 - t);
    default: return t;
  }
}

/** Value of one track at a frame, clamped to the first/last key outside it. */
export function sampleTrack(track: KeyframeTrack<number>, frame: number): number {
  if (!track || track.length === 0) return 0;
  if (track.length === 1) return track[0].value;
  // Tracks arrive from the UI in insertion order; sorting a copy keeps
  // out-of-order keys from producing a backwards ramp.
  const keys = track.slice().sort((a, b) => a.frame - b.frame);
  if (frame <= keys[0].frame) return keys[0].value;
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (frame < a.frame || frame > b.frame) continue;
    const span = b.frame - a.frame;
    const t = span <= 0 ? 1 : (frame - a.frame) / span;
    return lerp(a.value, b.value, interpShape(t, a.interp ?? b.interp));
  }
  return last.value;
}

/**
 * Resolve every animated parameter for a frame and hand back a standalone
 * grade. The result never aliases the input, so a caller can hold onto it
 * without racing the keyframe editor.
 */
export function resolveKeyframes(grade: GradeState, frame: number): GradeState {
  const out = cloneGrade(grade);
  const tracks = grade.keyframes;
  if (!tracks) return out;
  for (const path of Object.keys(tracks)) {
    const track = tracks[path];
    if (!track || track.length === 0) continue;
    setPath(out, path, sampleTrack(track, frame));
  }
  return out;
}

// ===========================================================================
// Curves
// ===========================================================================

/**
 * True when a curve is exactly the straight 0->1 line. Checked before
 * evaluation because the identity case is not merely cheap, it is the only
 * way the chain stays bit-exact at defaults.
 */
export function isIdentityCurve(points: CurvePoint[] | undefined): boolean {
  if (!points || points.length < 2) return true;
  if (points[0].x !== 0 || points[0].y !== 0) return false;
  const last = points[points.length - 1];
  if (last.x !== 1 || last.y !== 1) return false;
  for (let i = 0; i < points.length; i++) {
    if (points[i].y !== points[i].x) return false;
  }
  return true;
}

/**
 * Monotone cubic Hermite (Fritsch-Carlson) through the control points.
 *
 * WHY monotone and not a plain Catmull-Rom: a curve control point that dips
 * below the line between its neighbours makes the tone curve overshoot past
 * 1.0, which in a linear pipeline reads as clipping that does not exist in
 * the source. Monotone interpolation cannot do that. Outside the control
 * range the curve extrapolates along the end segment, so highlights above 1.0
 * keep whatever slope the top of the curve had.
 */
export function sampleCurve(points: CurvePoint[], x: number): number {
  if (!points || points.length === 0) return x;
  if (points.length === 1) return points[0].y;
  if (isIdentityCurve(points)) return x;

  const pts = points.slice().sort((a, b) => a.x - b.x);
  const n = pts.length;

  // Secant slopes; a zero-width segment contributes no slope.
  const d = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    d[i] = dx > 0 ? (pts[i + 1].y - pts[i].y) / dx : 0;
  }

  if (x <= pts[0].x) return pts[0].y + (x - pts[0].x) * d[0];
  const last = pts[n - 1];
  if (x >= last.x) return last.y + (x - last.x) * d[n - 2];

  // Node tangents.
  const m = new Array<number>(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] + d[i]) * 0.5;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }

  let i = 0;
  while (i < n - 2 && x > pts[i + 1].x) i++;
  const x0 = pts[i].x;
  const x1 = pts[i + 1].x;
  const span = x1 - x0;
  if (!(span > 0)) return pts[i].y;
  const t = (x - x0) / span;
  if (t <= 0) return pts[i].y;
  if (t >= 1) return pts[i + 1].y;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * pts[i].y + h10 * span * m[i] + h01 * pts[i + 1].y + h11 * span * m[i + 1];
}

// ===========================================================================
// Power window
// ===========================================================================

interface WindowGeometry {
  ca: number;
  sa: number;
  ox: number;
  oy: number;
  sx: number;
  sy: number;
  rect: boolean;
  band: boolean;
  inner: number;
  outer: number;
  invert: boolean;
  mix: number;
}

function prepareWindow(w: WindowState, ctx: GradeContext): WindowGeometry {
  // Pixels per unit of the normalised viewer space, per axis. Dividing the
  // pixel offset by these is what makes w === h a circle on screen instead of
  // an ellipse stretched to the frame.
  const sx = w.w * (ctx.width * 0.5);
  const sy = w.h * (ctx.height * 0.5);
  const a = (-w.angle * Math.PI) / 180;
  return {
    ca: Math.cos(a),
    sa: Math.sin(a),
    ox: w.cx * ctx.width,
    oy: w.cy * ctx.height,
    sx: Math.abs(sx) > 1e-6 ? sx : 1e-6,
    sy: Math.abs(sy) > 1e-6 ? sy : 1e-6,
    rect: w.shape === 'rectangle',
    band: w.shape === 'linear',
    inner: 1 - 0.5 * clamp01(w.softness),
    outer: 1 + 0.5 * clamp01(w.feather),
    invert: w.invert,
    mix: clamp01(w.mix),
  };
}

function windowMaskAt(g: WindowGeometry, x: number, y: number): number {
  const ux = (x + 0.5 - g.ox) / g.sx;
  const uy = (y + 0.5 - g.oy) / g.sy;
  const rx = ux * g.ca - uy * g.sa;
  const ry = ux * g.sa + uy * g.ca;

  // d is 1.0 exactly on the window boundary, in units of the window radius.
  let d: number;
  if (g.band) {
    // A linear window is an infinite band: w is the unused length, because
    // WindowState has no separate length or thickness field to spend it on.
    d = Math.abs(ry);
  } else if (g.rect) {
    d = Math.max(Math.abs(rx), Math.abs(ry));
  } else {
    // 'poly' has no vertex buffer in WindowState, so it degrades to the
    // ellipse rather than inventing vertices the UI never drew.
    d = Math.hypot(rx, ry);
  }

  let m: number;
  if (d <= g.inner) m = 1;
  else if (d >= g.outer) m = 0;
  else m = 1 - smoothstep01((d - g.inner) / (g.outer - g.inner));

  if (g.invert) m = 1 - m;
  return m * g.mix;
}

/**
 * 0..1 power-window mask at a pixel, with softness, feather, invert and mix.
 * A disabled window, or shape 'none', selects nothing and returns 0 —
 * applyGrade guards on `enabled` separately so a disabled window never gates
 * the grade.
 */
export function windowMask(
  x: number, y: number, w: WindowState, ctx: GradeContext,
): number {
  if (!w || !w.enabled || w.shape === 'none') return 0;
  return windowMaskAt(prepareWindow(w, ctx), x, y);
}

// ===========================================================================
// HSL qualifier
// ===========================================================================

/** Saturation and luminance get a small fixed edge; only hue has a control. */
const QUALIFIER_AXIS_SOFT = 0.05;

function bandMask(v: number, lo: number, hi: number, soft: number): number {
  const a = smoothstepEdge(v, lo - soft, lo);
  const b = 1 - smoothstepEdge(v, hi, hi + soft);
  return a * b;
}

/**
 * Analytic per-pixel key. 0 = outside the key, 1 = inside.
 *
 * The neighbourhood operations live in the pipeline, not here: denoise
 * filters the image before the key is measured, and matteBlur filters the
 * resulting matte. Both need a 2D surface, and a function of three floats
 * cannot provide one.
 */
export function qualifierMatte(r: number, g: number, b: number, q: QualifierState): number {
  if (!q || !q.enabled) return 0;

  const [h, s] = rgbToHsl(r, g, b);
  if (!Number.isFinite(s) || !Number.isFinite(h)) return 0;

  // balance slides the window along the hue circle rather than narrowing it,
  // which is what a colourist means by "bias the key towards the green side".
  const centre = ((q.hue + q.balance * 0.5) % 1 + 1) % 1;
  const half = q.hueWidth * 0.5;
  const dh = hueDistance(h, centre);
  const soft = Math.max(q.hueSoft, 1e-4);
  const mHue = 1 - smoothstep01((dh - half) / soft);

  const mSat = bandMask(clamp01(s), q.satLow, q.satHigh, QUALIFIER_AXIS_SOFT);
  const mLum = bandMask(tonal(lumaAP1(r, g, b)), q.lumLow, q.lumHigh, QUALIFIER_AXIS_SOFT);

  let m = mHue * mSat * mLum;
  if (!(m > 0)) return 0;
  if (q.invert) m = 1 - m;
  return clamp01(m);
}

// ===========================================================================
// Chroma key
// ===========================================================================

/** Analytic chroma-key matte, 0 = foreground, 1 = key colour. */
export function chromaKeyMatte(
  r: number, g: number, b: number, k: KeyState,
): number {
  if (!k || !k.enabled) return 0;
  const [h, s] = rgbToHsl(r, g, b);
  if (!Number.isFinite(h) || !Number.isFinite(s)) return 0;
  const [kh, ks] = rgbToHsl(k.keyColor[0], k.keyColor[1], k.keyColor[2]);
  if (!Number.isFinite(kh) || !Number.isFinite(ks)) return 0;

  const dhn = hueDistance(h, kh) * 2;
  const dsn = Math.abs(s - ks);
  // A white or black key carries no hue to compare, so the distance has to
  // fall back to saturation or the key grabs half the image.
  const dist = ks < 1e-3 ? dsn : Math.hypot(dhn, dsn);

  const inner = Math.max(k.tolerance, 1e-4);
  const outer = inner + Math.max(k.softness, 1e-4) + k.edge * 0.25;
  return 1 - smoothstepEdge(dist, inner, outer);
}

// ===========================================================================
// Display transform (Deliver page still export)
// ===========================================================================

function outputMatrix(space: OutputSpace | undefined): Mat3 {
  switch (space) {
    case 'Rec.2020': return AP1_TO_REC2020;
    case 'Display P3': return AP1_TO_P3D65;
    default: return AP1_TO_SRGB_LINEAR;
  }
}

/** AP1 linear -> output-primary linear. Unclamped. */
export function toDisplayLinear(
  rgb: Float32Array, ctx: GradeContext,
): Float32Array {
  const m = outputMatrix(ctx.outputSpace);
  const out = new Float32Array(rgb.length);
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const v = mat3Vec(m, [rgb[i], rgb[i + 1], rgb[i + 2]]);
    out[i] = v[0];
    out[i + 1] = v[1];
    out[i + 2] = v[2];
  }
  return out;
}

/** Output-primary linear -> AP1 linear. Unclamped. */
export function fromDisplayLinear(
  rgb: Float32Array, ctx: GradeContext,
): Float32Array {
  const m = outputMatrix(ctx.outputSpace);
  const inv = inverse3(m);
  const out = new Float32Array(rgb.length);
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const v = mat3Vec(inv, [rgb[i], rgb[i + 1], rgb[i + 2]]);
    out[i] = v[0];
    out[i + 1] = v[1];
    out[i + 2] = v[2];
  }
  return out;
}

function inverse3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m as unknown as number[];
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const id = 1 / (det === 0 ? 1e-30 : det);
  return new Float64Array([
    A * id, (c * h - b * i) * id, (b * f - c * e) * id,
    B * id, (a * i - c * g) * id, (c * d - a * f) * id,
    C * id, (b * g - a * h) * id, (a * e - b * d) * id,
  ]);
}

/**
 * AP1 linear -> 8-bit-ready 0..1 display RGB. This is the ONE place the chain
 * clamps, and it is not part of the grade.
 */
export function encodeDisplay(rgb: Float32Array, ctx: GradeContext): Float32Array {
  const lin = toDisplayLinear(rgb, ctx);
  const out = new Float32Array(lin.length);
  for (let i = 0; i < lin.length; i++) {
    const v = lin[i];
    const s = v <= 0 ? 0 : v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    out[i] = s < 0 ? 0 : s > 1 ? 1 : s;
  }
  return out;
}

/** Inverse of encodeDisplay, for a round-trip check or a re-read. */
export function decodeDisplay(enc: Float32Array, ctx: GradeContext): Float32Array {
  const lin = new Float32Array(enc.length);
  for (let i = 0; i < enc.length; i++) {
    const v = clamp01(enc[i]);
    lin[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return fromDisplayLinear(lin, ctx);
}

/** sRGB linear -> AP1 linear. The Bradford D65->D60 step lives in the matrix. */
export function srgbToAP1(rgb: Float32Array): Float32Array {
  const out = new Float32Array(rgb.length);
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const v = mat3Vec(SRGB_LINEAR_TO_AP1, [rgb[i], rgb[i + 1], rgb[i + 2]]);
    out[i] = v[0];
    out[i + 1] = v[1];
    out[i + 2] = v[2];
  }
  return out;
}

/** ARRI LogC EI800 in/out, for clips that arrive camera-logged. */
export function encodeLogc(rgb: Float32Array): Float32Array {
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = logcEncode(rgb[i]);
  return out;
}

export function decodeLogc(rgb: Float32Array): Float32Array {
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = logcDecode(rgb[i]);
  return out;
}

// ===========================================================================
// 3D LUT
// ===========================================================================

/** Trilinear sample of a .cube-order LUT. Input and output are 0..1. */
export function sampleLut3D(lut: Lut3D, r: number, g: number, b: number): RGB {
  const n = lut.size;
  const d = lut.data;
  const [lo, hi] = lut.domain;
  const span = hi - lo || 1;
  const f = (v: number): number =>
    clamp((v - lo) / span, 0, 1) * (n - 1);
  const fr = f(r), fg = f(g), fb = f(b);
  const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
  const r1 = Math.min(r0 + 1, n - 1);
  const g1 = Math.min(g0 + 1, n - 1);
  const b1 = Math.min(b0 + 1, n - 1);
  const tr = fr - r0, tg = fg - g0, tb = fb - b0;
  const out: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c000 = d[(b0 * n * n + g0 * n + r0) * 3 + c];
    const c100 = d[(b0 * n * n + g0 * n + r1) * 3 + c];
    const c010 = d[(b0 * n * n + g1 * n + r0) * 3 + c];
    const c110 = d[(b0 * n * n + g1 * n + r1) * 3 + c];
    const c001 = d[(b1 * n * n + g0 * n + r0) * 3 + c];
    const c101 = d[(b1 * n * n + g0 * n + r1) * 3 + c];
    const c011 = d[(b1 * n * n + g1 * n + r0) * 3 + c];
    const c111 = d[(b1 * n * n + g1 * n + r1) * 3 + c];
    const c00 = lerp(c000, c100, tr);
    const c10 = lerp(c010, c110, tr);
    const c01 = lerp(c001, c101, tr);
    const c11 = lerp(c011, c111, tr);
    out[c] = lerp(lerp(c00, c10, tg), lerp(c01, c11, tg), tb);
  }
  return out;
}

// ===========================================================================
// Stages
// ===========================================================================

function stageInputGamma(buf: GradeBuffer, gamma: number): void {
  if (gamma === 1 || !(gamma > 0)) return;
  const inv = 1 / gamma;
  const d = buf.data;
  for (let i = 0; i < d.length; i++) d[i] = spow(d[i], inv);
}

function stageOutputGamma(buf: GradeBuffer, gamma: number): void {
  if (gamma === 1 || !(gamma > 0)) return;
  const inv = 1 / gamma;
  const d = buf.data;
  for (let i = 0; i < d.length; i++) d[i] = spow(d[i], inv);
}

function stageCDL(buf: GradeBuffer, e: EffectsState): void {
  const c = e.cdl;
  const active =
    c.sat !== 1 ||
    c.slope[0] !== 1 || c.slope[1] !== 1 || c.slope[2] !== 1 ||
    c.offset[0] !== 0 || c.offset[1] !== 0 || c.offset[2] !== 0 ||
    c.power[0] !== 1 || c.power[1] !== 1 || c.power[2] !== 1;
  if (!active) return;
  const d = buf.data;
  for (let i = 0; i < d.length; i += 3) {
    const r = spow(d[i] * c.slope[0] + c.offset[0], c.power[0]);
    const g = spow(d[i + 1] * c.slope[1] + c.offset[1], c.power[1]);
    const b = spow(d[i + 2] * c.slope[2] + c.offset[2], c.power[2]);
    if (c.sat === 1) {
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    } else {
      const y = lumaAP1(r, g, b);
      d[i] = y + (r - y) * c.sat;
      d[i + 1] = y + (g - y) * c.sat;
      d[i + 2] = y + (b - y) * c.sat;
    }
  }
}

/**
 * Primaries. Order is fixed: colour wheels, then the log-style tone controls,
 * then the chroma-only trim. Each block reports itself inactive at defaults
 * so the whole stage can be skipped without touching a single float.
 */
function stagePrimaries(buf: GradeBuffer, p: PrimaryState): void {
  const wheels =
    p.lift[0] !== 0 || p.lift[1] !== 0 || p.lift[2] !== 0 ||
    p.gamma[0] !== 1 || p.gamma[1] !== 1 || p.gamma[2] !== 1 ||
    p.gain[0] !== 1 || p.gain[1] !== 1 || p.gain[2] !== 1 ||
    p.offset[0] !== 0 || p.offset[1] !== 0 || p.offset[2] !== 0;
  const tone =
    p.contrast !== 1 || p.brightness !== 0 ||
    p.contrastLow !== 0 || p.contrastHigh !== 0 ||
    p.shadowBias !== 0 || p.highlightBias !== 0;
  const chroma = p.colourBoost !== 0;
  const white = p.temperature !== 0 || p.tint !== 0;
  const hue = p.hue !== 0;
  const sat = p.saturation !== 1 || p.vibrance !== 0;
  if (!wheels && !tone && !chroma && !white && !hue && !sat) return;

  const pivot = clamp(p.pivot, 0.01, 0.99);
  const d = buf.data;
  for (let i = 0; i < d.length; i += 3) {
    let r = d[i], g = d[i + 1], b = d[i + 2];

    if (wheels) {
      // Gain, then gamma, then lift, then pedestal — the order a colour wheel
      // is built from, so the three do not fight each other.
      r = r * p.gain[0] + p.offset[0];
      g = g * p.gain[1] + p.offset[1];
      b = b * p.gain[2] + p.offset[2];
      if (p.gamma[0] !== 1) r = spow(r, 1 / Math.max(p.gamma[0], 1e-4));
      if (p.gamma[1] !== 1) g = spow(g, 1 / Math.max(p.gamma[1], 1e-4));
      if (p.gamma[2] !== 1) b = spow(b, 1 / Math.max(p.gamma[2], 1e-4));
      r += p.lift[0]; g += p.lift[1]; b += p.lift[2];
    }

    if (tone) {
      const y = lumaAP1(r, g, b);
      // Split contrast and the bias sliders are all luma-weighted so they
      // touch one end of the range and leave the other alone.
      const t = tonal(y);
      const wLow = 1 - smoothstep01(t / Math.max(pivot, 1e-4));
      const wHigh = smoothstep01((t - pivot) / Math.max(1 - pivot, 1e-4));
      const k =
        p.contrast +
        p.contrastLow * 2 * wLow +
        p.contrastHigh * 2 * wHigh;
      if (k !== 1) { r = pivot + (r - pivot) * k; g = pivot + (g - pivot) * k; b = pivot + (b - pivot) * k; }
      if (p.shadowBias !== 0) {
        const o = p.shadowBias * 0.25 * wLow;
        r += o; g += o; b += o;
      }
      if (p.highlightBias !== 0) {
        const o = p.highlightBias * 0.25 * wHigh;
        r += o; g += o; b += o;
      }
      if (p.brightness !== 0) { r += p.brightness; g += p.brightness; b += p.brightness; }
    }

    if (white) {
      const gains = tempTintGains(p.temperature, p.tint);
      r *= gains[0]; g *= gains[1]; b *= gains[2];
    }

    if (hue) {
      const h = hueRotate(r, g, b, p.hue);
      r = h[0]; g = h[1]; b = h[2];
    }

    if (sat) {
      const y = lumaAP1(r, g, b);
      let s = p.saturation;
      if (p.vibrance !== 0) {
        // Vibrance leans on how saturated the pixel already is, so it protects
        // skin and sky while still letting a flat frame come alive.
        const cur = Math.max(r, g, b) - Math.min(r, g, b);
        const amount = 1 - clamp01(cur / Math.max(Math.abs(y), 1e-3));
        s *= 1 + p.vibrance * amount;
      }
      if (chroma) {
        s *= 1 + p.colourBoost * 1.5 * (1 - Math.abs(2 * tonal(y) - 1));
      }
      if (s !== 1) { r = y + (r - y) * s; g = y + (g - y) * s; b = y + (b - y) * s; }
    }

    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
}

function stageCurves(buf: GradeBuffer, c: GradeState['curves']): void {
  const mr = isIdentityCurve(c.master);
  const rr = isIdentityCurve(c.red);
  const gg = isIdentityCurve(c.green);
  const bb = isIdentityCurve(c.blue);
  if (mr && rr && gg && bb) return;
  const d = buf.data;
  for (let i = 0; i < d.length; i += 3) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    if (!rr) r = sampleCurve(c.red, r);
    if (!gg) g = sampleCurve(c.green, g);
    if (!bb) b = sampleCurve(c.blue, b);
    if (!mr) {
      r = sampleCurve(c.master, r);
      g = sampleCurve(c.master, g);
      b = sampleCurve(c.master, b);
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
}

function stageWindow(buf: GradeBuffer, w: WindowState, ctx: GradeContext): void {
  if (!w.enabled || w.shape === 'none') return;
  const geo = prepareWindow(w, ctx);
  const src = buf.data.slice();
  const dst = buf.data;
  let i = 0;
  for (let y = 0; y < buf.height; y++) {
    for (let x = 0; x < buf.width; x++, i += 3) {
      const k = windowMaskAt(geo, x, y);
      if (k <= 0 || k >= 1) continue;
      // mix = 0 keeps the untouched pixel, mix = 1 keeps the graded one, and
      // everything between is a straight blend of the two.
      dst[i] = lerp(src[i], dst[i], k);
      dst[i + 1] = lerp(src[i + 1], dst[i + 1], k);
      dst[i + 2] = lerp(src[i + 2], dst[i + 2], k);
    }
  }
}

function stageQualifier(
  buf: GradeBuffer, q: QualifierState, win: WindowState, ctx: GradeContext,
): void {
  if (!q.enabled) return;
  const w = buf.width;
  const h = buf.height;

  // Denoise filters the image before the key is measured, which is the whole
  // point of it: grain sitting on a key edge is what makes a matte crawl.
  if (q.denoise > 0) buf.blurGaussian(q.denoise * 2.5);

  const matte = new Float32Array(w * h);
  const d = buf.data;
  for (let y = 0, p = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++, i += 3) {
      let m = qualifierMatte(d[i], d[i + 1], d[i + 2], q);
      if (q.windowRestrict) m *= windowMask(x, y, win, ctx);
      matte[p] = m;
    }
  }
  if (q.matteBlur > 0) blurScalar(matte, w, h, q.matteBlur * 6, new Float32Array(w * h));

  for (let y = 0, p = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++, i += 3) {
      const m = matte[p];
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (q.view === 'matte') {
        d[i] = m; d[i + 1] = m; d[i + 2] = m;
        continue;
      }
      if (q.view === 'overlay') {
        const y709 = lumaAP1(r, g, b);
        d[i] = lerp(y709, r, m);
        d[i + 1] = lerp(y709, g, m);
        d[i + 2] = lerp(y709, b, m);
        continue;
      }
      if (q.desaturateOutside > 0 && m < 1) {
        const y709 = lumaAP1(r, g, b);
        const k = (1 - m) * q.desaturateOutside;
        d[i] = lerp(r, y709, k);
        d[i + 1] = lerp(g, y709, k);
        d[i + 2] = lerp(b, y709, k);
      }
    }
  }
}

function stageChromaKey(buf: GradeBuffer, k: KeyState): void {
  if (!k.enabled) return;
  const w = buf.width;
  const h = buf.height;
  const d = buf.data;
  const matte = new Float32Array(w * h);

  for (let y = 0, p = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++, i += 3) {
      matte[p] = chromaKeyMatte(d[i], d[i + 1], d[i + 2], k);
    }
  }
  if (k.shrinkGrow !== 0) {
    const radius = clamp(Math.round(Math.abs(k.shrinkGrow) * 8), 1, 32);
    morphMatte(matte, w, h, radius, k.shrinkGrow > 0);
  }

  for (let p = 0, i = 0; p < matte.length; p++, i += 3) {
    const m = matte[p];
    let r = d[i], g = d[i + 1], b = d[i + 2];

    if (k.spill > 0 && m > 0) {
      // Neutral clip: pull any channel sitting above the luma back down to it,
      // which is exactly the key colour bleeding into the edge.
      const y = lumaAP1(r, g, b);
      const s = k.spill * m;
      r = lerp(r, Math.min(r, y), s);
      g = lerp(g, Math.min(g, y), s);
      b = lerp(b, Math.min(b, y), s);
    }

    if (k.fillMode === 'over') {
      // No alpha channel in this surface, so 'over' cannot remove pixels: it
      // suppresses the spill and leaves the matte for the caller to use. Use
      // chromaKeyMatteBuffer to get it.
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    } else if (k.fillMode === 'fill') {
      d[i] = lerp(r, k.fillColor[0], 1 - m);
      d[i + 1] = lerp(g, k.fillColor[1], 1 - m);
      d[i + 2] = lerp(b, k.fillColor[2], 1 - m);
    } else {
      // 'edge': composite over the fill colour, then burn a thin line along
      // the matte gradient. A true edge colour needs the premultiplied alpha
      // this surface does not carry, so the burn-in is the honest stand-in.
      d[i] = lerp(k.fillColor[0], r, m);
      d[i + 1] = lerp(k.fillColor[1], g, m);
      d[i + 2] = lerp(k.fillColor[2], b, m);
      if (k.edge > 0) {
        const left = matte[p % w === 0 ? p : p - 1];
        const above = matte[p < w ? p : p - w];
        const grad = Math.min(1, (Math.abs(m - left) + Math.abs(m - above)) * 2);
        const burn = grad * k.edge * 0.5;
        d[i] *= 1 - burn; d[i + 1] *= 1 - burn; d[i + 2] *= 1 - burn;
      }
    }
  }
}

function stageEffects(buf: GradeBuffer, e: EffectsState, ctx: GradeContext): void {
  const w = buf.width;
  const h = buf.height;
  const d = buf.data;

  // --- LUT ---
  const lut = ctx.lut ?? null;
  const intensity = ctx.lutIntensity ?? e.lutIntensity;
  if (lut && intensity > 0) {
    for (let i = 0; i < d.length; i += 3) {
      const c = sampleLut3D(lut, d[i], d[i + 1], d[i + 2]);
      d[i] = lerp(d[i], c[0], intensity);
      d[i + 1] = lerp(d[i + 1], c[1], intensity);
      d[i + 2] = lerp(d[i + 2], c[2], intensity);
    }
  }

  // --- Blur ---
  if (e.blur > 0) buf.blurGaussian(Math.min(e.blur * 20, 48));

  // --- Sharpen (unsharp mask) ---
  if (e.sharpen > 0) {
    const soft = buf.clone();
    soft.blurGaussian(clamp(e.sharpenRadius, 0.25, 8));
    for (let i = 0; i < d.length; i++) {
      d[i] = clamp(d[i] + e.sharpen * (d[i] - soft.data[i]), -64, 64);
    }
  }

  // --- Glow / bloom ---
  if (e.glow > 0) {
    const bright = buf.clone();
    const bd = bright.data;
    for (let i = 0; i < d.length; i += 3) {
      const y = lumaAP1(d[i], d[i + 1], d[i + 2]);
      const over = y > e.glowThreshold ? (y - e.glowThreshold) / Math.max(y, 1e-6) : 0;
      bd[i] = d[i] * over;
      bd[i + 1] = d[i + 1] * over;
      bd[i + 2] = d[i + 2] * over;
    }
    bright.blurGaussian(Math.max(4, Math.min(w, h) / 24));
    for (let i = 0; i < d.length; i++) d[i] += bd[i] * e.glow;
  }

  // --- Vignette ---
  if (e.vignette !== 0) {
    const aspect = w / Math.max(h, 1);
    const norm = Math.hypot(aspect, 1);
    let p = 0;
    for (let y = 0; y < h; y++) {
      const ny = ((y + 0.5) / h) * 2 - 1;
      for (let x = 0; x < w; x++, p += 3) {
        const nx = ((x + 0.5) / w) * 2 - 1;
        const r = Math.hypot(nx * aspect, ny) / norm;
        const k = 1 + e.vignette * smoothstep01((r - (1 - clamp01(e.vignetteSoft))) / Math.max(clamp01(e.vignetteSoft), 1e-4));
        d[p] *= k; d[p + 1] *= k; d[p + 2] *= k;
      }
    }
  }

  // --- Film contrast ---
  if (e.filmContrast !== 0) {
    // A Reinhard soft-clip in the log domain around the same 0.435 pivot the
    // primary contrast uses, so the two controls agree about where the middle
    // of the range is. Identity at amount 0 by construction, and skipped.
    const a = e.filmContrast * 2;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      const pivot = 0.435;
      const s = v < 0 ? -1 : 1;
      const t = Math.log2(Math.max(Math.abs(v), 1e-6) / pivot);
      const at = Math.abs(t);
      const soft = a === 0 ? t : (t * (1 + a)) / (1 + a * at);
      d[i] = s * pivot * Math.pow(2, soft);
    }
  }

  // --- Grain ---
  if (e.grain > 0) {
    const frame = ctx.frame | 0;
    let p = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++, p += 3) {
        // Film grain peaks in the midtones and all but vanishes in the toe
        // and the shoulder, so it is weighted by the same tonal curve the
        // qualifier uses.
        const weight = 4 * tonal(lumaAP1(d[p], d[p + 1], d[p + 2])) *
          (1 - tonal(lumaAP1(d[p], d[p + 1], d[p + 2])));
        const n = hash01(x, y, frame) - 0.5;
        const o = n * e.grain * 0.1 * weight;
        d[p] += o; d[p + 1] += o; d[p + 2] += o;
      }
    }
  }
}

// ===========================================================================
// applyGrade
// ===========================================================================

function resolveSize(count: number, ctx: GradeContext): [number, number] {
  const w = Math.floor(ctx.width);
  const h = Math.floor(ctx.height);
  if (w > 0 && h > 0 && w * h === count) return [w, h];
  // A frame whose declared size does not match its data still has to grade;
  // treat it as a single row rather than refusing or silently dropping pixels.
  return [count > 0 ? count : 1, 1];
}

/**
 * Run the full chain over an AP1 linear RGB frame.
 *
 * STAGE ORDER — keep this identical to the shader:
 *   inputGamma -> CDL -> primaries -> temp/tint -> hue -> saturation/vibrance
 *   -> curves -> power window -> HSL qualifier -> chroma key -> effects
 *   -> outputGamma
 *
 * The input is never mutated and the result is always a new array.
 */
export function applyGrade(
  rgb: Float32Array, grade: GradeState, ctx: GradeContext,
): Float32Array {
  const count = Math.floor(rgb.length / 3);
  if (count <= 0) return new Float32Array(0);

  const g = resolveKeyframes(grade, ctx.frame);
  const [w, h] = resolveSize(count, ctx);
  const buf = GradeBuffer.fromRGB(rgb, w, h);
  const window: WindowState = g.window;
  const frameCtx: GradeContext = {
    width: w,
    height: h,
    frame: ctx.frame | 0,
    lut: ctx.lut ?? null,
    lutIntensity: ctx.lutIntensity,
    workingSpace: ctx.workingSpace,
    outputSpace: ctx.outputSpace,
  };

  stageInputGamma(buf, g.inputGamma);
  stageCDL(buf, g.effects);
  stagePrimaries(buf, g.primary);
  stageCurves(buf, g.curves);
  stageWindow(buf, window, frameCtx);
  stageQualifier(buf, g.qualifier, window, frameCtx);
  stageChromaKey(buf, g.key);
  stageEffects(buf, g.effects, frameCtx);
  stageOutputGamma(buf, g.outputGamma);

  return buf.toRGB();
}

// ===========================================================================
// Auto balance
// ===========================================================================

interface FrameStats {
  count: number;
  mean: RGB;
  p05: RGB;
  p50: RGB;
  p95: RGB;
}

function lumaStats(
  rgb: Float32Array, maxSamples: number, w: readonly [number, number, number],
): FrameStats {
  const n = Math.floor(rgb.length / 3);
  const stride = Math.max(1, Math.ceil(n / Math.max(maxSamples, 1024)));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  let sr = 0, sg = 0, sb = 0, used = 0;
  for (let i = 0; i < n; i += stride) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    rs.push(r); gs.push(g); bs.push(b);
    sr += r; sg += g; sb += b;
    used++;
  }
  const pct = (arr: number[], p: number): number => {
    if (arr.length === 0) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const i = clamp(Math.round(p * (s.length - 1)), 0, s.length - 1);
    return s[i];
  };
  return {
    count: used,
    mean: [sr / used, sg / used, sb / used],
    p05: [pct(rs, 0.05), pct(gs, 0.05), pct(bs, 0.05)],
    p50: [pct(rs, 0.5), pct(gs, 0.5), pct(bs, 0.5)],
    p95: [pct(rs, 0.95), pct(gs, 0.95), pct(bs, 0.95)],
  };
}

function neutralish(m: RGB): boolean {
  const hi = Math.max(m[0], m[1], m[2]);
  const lo = Math.min(m[0], m[1], m[2]);
  return hi - lo <= 1e-9 * Math.max(Math.abs(hi), 1);
}

/**
 * von Kries style white balance.
 *
 * WHY NOT JUST DIVIDE BY THE MEAN: the classic grey-world failure is a frame
 * with a dominant colour — a red wall, a green screen, a sunset — where the
 * mean is not the illuminant and the correction overshoots into a cast of
 * its own. So the reference is taken from a midtone-weighted average with
 * the shadows and the speculars thrown out, which is closer to what a colourist
 * picks as "the thing that is supposed to be grey".
 *
 * Returns the per-channel gains that neutralise the cast, luma-preserving so
 * applying them does not also change exposure. An already-neutral frame
 * returns exactly [1, 1, 1] — not approximately, exactly, because
 * auto-balance is run in a loop by the agent and a 1e-16 drift per pass is a
 * drift that never settles.
 */
export function autoWhiteBalance(rgb: Float32Array, opts: AutoOptions = {}): RGB {
  const method = opts.method ?? 'neutral';
  const maxSamples = opts.maxSamples ?? 1 << 18;
  const clampRange = opts.gainClamp ?? [0.25, 4];
  const lo = opts.lumaLow ?? 0.01;
  const hi = opts.lumaHigh ?? 4;

  const n = Math.floor(rgb.length / 3);
  if (n <= 0) return [1, 1, 1];
  const stride = Math.max(1, Math.ceil(n / Math.max(maxSamples, 1024)));

  let sr = 0, sg = 0, sb = 0, sw = 0;
  const bins = 256;
  const hueHist = new Float64Array(bins);
  let hueTotal = 0;

  for (let i = 0; i < n; i += stride) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const y = lumaAP1(r, g, b);
    if (!(y > lo) || y > hi) continue;

    let w: number;
    switch (method) {
      case 'grey-world':
        w = 1;
        break;
      case 'white-point':
        // Lean on the top of the range, but as a percentile average rather
        // than the single brightest pixel, which is usually a light source.
        w = y * y;
        break;
      case 'white-balance':
        // Shades-of-grey: weight by 1/luma in log space, the estimator that
        // survives a frame that is mostly dark.
        w = 1 / Math.log(1 + y);
        break;
      default:
        // Bell centred on 18% grey, in the tonal domain so it behaves the
        // same at 0.05 and at 2.0.
        w = 1 - Math.abs(2 * tonal(y) - 1);
        break;
    }
    if (!(w > 0)) continue;
    sr += r * w; sg += g * w; sb += b * w; sw += w;

    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx > mn && mx > 1e-6) {
      const chroma = (mx - mn) / mx;
      const [h, s] = rgbToHsl(r, g, b);
      if (Number.isFinite(h) && Number.isFinite(s) && s > 0) {
        const bin = clamp(Math.floor(h * bins), 0, bins - 1);
        const v = chroma * w;
        hueHist[bin] += v;
        hueTotal += v;
      }
    }
  }

  if (!(sw > 0) || !(sr > 0) || !(sg > 0) || !(sb > 0)) {
    return { ...([1, 1, 1] as RGB) };
  }

  const mean: RGB = [sr / sw, sg / sw, sb / sw];
  if (neutralish(mean)) return [1, 1, 1];

  // A true von Kries correction in a wide gamut is a diagonal of the LMS
  // cone responses, not of RGB. A diagonal RGB gain is a good approximation of
  // it and is what the temp/tint control implements, so auto-balance and a
  // manual temperature trim land in the same place.
  const raw: RGB = [1 / mean[0], 1 / mean[1], 1 / mean[2]];
  const yl = lumaAP1(raw[0], raw[1], raw[2]);
  let gains: RGB = [raw[0] / yl, raw[1] / yl, raw[2] / yl];

  const strength = clamp(opts.strength ?? 1, 0, 1);
  gains = [
    lerp(1, clamp(gains[0], clampRange[0], clampRange[1]), strength),
    lerp(1, clamp(gains[1], clampRange[0], clampRange[1]), strength),
    lerp(1, clamp(gains[2], clampRange[0], clampRange[1]), strength),
  ];
  return gains;
}

/**
 * Auto levels as a pivot/contrast pair, which is what the primaries model can
 * actually express. A full black/white point remap needs a curve; this gets
 * the histogram into a usable place and leaves the rest to the operator.
 */
export function autoLevels(rgb: Float32Array, opts: LevelsOptions = {}): Partial<PrimaryState> {
  const loP = clamp(opts.lowPercentile ?? 0.005, 0, 0.49);
  const hiP = clamp(opts.highPercentile ?? 0.995, 0.51, 1);
  const tLo = clamp(opts.targetLow ?? 0.005, 0, 1);
  const tHi = clamp(opts.targetHigh ?? 0.98, 0, 1);
  const cRange = opts.contrastRange ?? [0.5, 1.5];
  const pRange = opts.pivotRange ?? [0.1, 0.9];

  const stats = lumaStats(rgb, opts.maxSamples ?? 1 << 18, AP1_LUMA);
  if (stats.count === 0) return {};

  const pLow = (stats.p05[0] + stats.p05[1] + stats.p05[2]) / 3;
  const pHigh = (stats.p95[0] + stats.p95[1] + stats.p95[2]) / 3;
  if (!(pHigh > 1e-5)) return {};

  const span = pHigh - pLow;
  const contrast = clamp(span > 1e-4 ? (tHi - tLo) / span : 1, cRange[0], cRange[1]);

  // With out = pivot + (in - pivot) * contrast, the pivot is the one input
  // that does not move. Solve for the one that carries the midpoint onto the
  // target midpoint, so the tone curve is centred rather than just steeper.
  const pMid = (pLow + pHigh) * 0.5;
  const tMid = (tLo + tHi) * 0.5;
  const solved = contrast === 1 ? 0.435 : (tMid - contrast * pMid) / (1 - contrast);
  const pivot = clamp(solved, pRange[0], pRange[1]);

  if (contrast === 1 && Math.abs(pivot - 0.435) < 1e-6) return {};
  return { contrast, pivot };
}

// ===========================================================================
// Analysis and scopes
// ===========================================================================

/**
 * Everything the agent needs to describe a frame without a GPU. The clipped
 * counts are FRACTIONS of the frame, not pixel counts, so they compare across
 * resolutions and against the histogram.
 */
export function analyzeFrame(
  rgb: Float32Array, ctx: GradeContext, opts: { maxSamples?: number } = {},
): FrameAnalysis {
  const n = Math.floor(rgb.length / 3);
  const w = lumaWeights(ctx.workingSpace);
  const empty: FrameAnalysis = {
    mean: [0, 0, 0], median: 0, p05: 0, p95: 0,
    clipped: { r: 0, g: 0, b: 0, total: 0 },
    neutralRatio: 0, dominantHue: -1, dominantColor: [0, 0, 0],
    luma: { min: 0, max: 0, mean: 0 }, pixelCount: 0,
  };
  if (n <= 0) return empty;

  const maxSamples = opts.maxSamples ?? 1 << 20;
  const stride = Math.max(1, Math.ceil(n / Math.max(maxSamples, 1024)));
  const lumas: number[] = [];
  let sr = 0, sg = 0, sb = 0;
  let cr = 0, cg = 0, cb = 0, cAny = 0;
  let neutral = 0, used = 0;
  let lmin = Infinity, lmax = -Infinity, ssum = 0;
  const bins = 64;
  const hueHist = new Float64Array(bins);
  let hueTotal = 0, hueSatSum = 0, hueLumSum = 0, hueWeight = 0;

  for (let i = 0; i < n; i += stride) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    sr += r; sg += g; sb += b;
    used++;

    // 1.0 in scene linear is diffuse white on a timeline whose reference is
    // 1.0; that is the line the scopes draw too, so the two agree.
    if (r >= 1) cr++;
    if (g >= 1) cg++;
    if (b >= 1) cb++;
    if (r >= 1 || g >= 1 || b >= 1) cAny++;

    const y = lumaIn(r, g, b, w);
    lumas.push(y);
    ssum += y;
    if (y < lmin) lmin = y;
    if (y > lmax) lmax = y;

    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const chroma = mx > 1e-6 ? (mx - mn) / mx : 0;
    if (chroma < 0.04 && y > 0.02) neutral++;

    const [h, s] = rgbToHsl(r, g, b);
    if (chroma > 0.02 && Number.isFinite(h) && Number.isFinite(s) && s > 0) {
      const bin = clamp(Math.floor(h * bins), 0, bins - 1);
      hueHist[bin] += chroma;
      hueTotal += chroma;
      hueSatSum += s * chroma;
      hueLumSum += tonal(y) * chroma;
      hueWeight += chroma;
    }
  }
  if (used === 0) return empty;

  lumas.sort((a, b) => a - b);
  const q = (p: number): number =>
    lumas[clamp(Math.round(p * (lumas.length - 1)), 0, lumas.length - 1)];

  let dominantHue = -1;
  let dominantColor: RGB = [0, 0, 0];
  // -1 rather than 0 for "no dominant hue": red is a real answer and 0 is a
  // real hue, so the caller must be able to tell them apart.
  if (hueTotal > 0 && hueTotal / used > 0.005) {
    let best = 0;
    for (let i = 1; i < bins; i++) if (hueHist[i] > hueHist[best]) best = i;
    if (hueHist[best] > 0) {
      dominantHue = (best + 0.5) / bins;
      const s = clamp01(hueSatSum / hueWeight);
      const l = clamp01(hueLumSum / hueWeight);
      dominantColor = hslToRgb(dominantHue, s, l);
    }
  }

  return {
    mean: [sr / used, sg / used, sb / used],
    median: q(0.5),
    p05: q(0.05),
    p95: q(0.95),
    clipped: { r: cr / used, g: cg / used, b: cb / used, total: cAny / used },
    neutralRatio: neutral / used,
    dominantHue,
    dominantColor,
    luma: { min: lmin, max: lmax, mean: ssum / used },
    pixelCount: used,
  };
}

/**
 * Histogram over 0..1 scene linear, normalised so each array sums to 1. Values
 * outside the domain land in the end bins rather than being discarded — a
 * clipped highlight is information, and dropping it hides exactly the thing
 * the operator opened the histogram to look at.
 */
export function histogram(rgb: Float32Array, bins = 256, workingSpace?: WorkingSpace): HistogramData {
  const nb = clamp(Math.floor(bins), 2, 4096);
  const r = new Float32Array(nb);
  const g = new Float32Array(nb);
  const b = new Float32Array(nb);
  const l = new Float32Array(nb);
  const w = lumaWeights(workingSpace);
  const n = Math.floor(rgb.length / 3);
  if (n === 0) return { bins: nb, r, g, b, l };

  const idx = (v: number): number =>
    v <= 0 ? 0 : v >= 1 ? nb - 1 : Math.min(nb - 1, Math.floor(v * nb));
  for (let i = 0; i < n; i++) {
    r[idx(rgb[i * 3])] += 1;
    g[idx(rgb[i * 3 + 1])] += 1;
    b[idx(rgb[i * 3 + 2])] += 1;
    l[idx(lumaIn(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], w))] += 1;
  }
  for (let i = 0; i < nb; i++) {
    r[i] /= n;
    g[i] /= n;
    b[i] /= n;
    l[i] /= n;
  }
  return { bins: nb, r, g, b, l };
}

/**
 * Waveform: for every column and every intensity level, the strongest sample
 * seen there, per channel. The four traces span the full width; a renderer
 * that wants the classic quad layout slices each array into four.
 *
 * srcWidth is the width of the source frame. When it is omitted the input is
 * assumed to be exactly `width` pixels wide and the columns are taken
 * strided, which keeps the shape useful for a square still.
 */
export function waveform(
  rgb: Float32Array, width: number, height: number, srcWidth?: number,
): WaveformData {
  const w = clamp(Math.floor(width), 1, 8192);
  const h = clamp(Math.floor(height), 1, 8192);
  const sw = Math.max(1, Math.floor(srcWidth ?? w));
  const r = new Float32Array(w * h);
  const g = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  const y = new Float32Array(w * h);
  const n = Math.floor(rgb.length / 3);
  if (n === 0) return { width: w, height: h, r, g, b, y };

  const rowOf = (v: number): number => {
    const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
    return Math.min(h - 1, Math.floor(c * h));
  };
  const stride = Math.max(1, Math.ceil(sw / w));

  for (let i = 0; i < n; i++) {
    const col = Math.min(w - 1, ((i % sw) / stride) | 0);
    const p = col * h;
    const rv = rgb[i * 3], gv = rgb[i * 3 + 1], bv = rgb[i * 3 + 2];
    const yv = lumaAP1(rv, gv, bv);
    const ri = p + rowOf(rv);
    const gi = p + rowOf(gv);
    const bi = p + rowOf(bv);
    const yi = p + rowOf(yv);
    if (rv > r[ri]) r[ri] = rv;
    if (gv > g[gi]) g[gi] = gv;
    if (bv > b[bi]) b[bi] = bv;
    if (yv > y[yi]) y[yi] = yv;
  }
  return { width: w, height: h, r, g, b, y };
}

/** w*h key matte for the compositor; applyGrade cannot return alpha. */
export function chromaKeyMatteBuffer(
  rgb: Float32Array, k: KeyState,
): Float32Array {
  const n = Math.floor(rgb.length / 3);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = chromaKeyMatte(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], k);
  }
  return out;
}

/** w*h HSL key matte, with denoise and matte blur applied. */
export function qualifierMatteBuffer(
  rgb: Float32Array, ctx: GradeContext, q: QualifierState, win?: WindowState,
): Float32Array {
  const count = Math.floor(rgb.length / 3);
  const [w, h] = resolveSize(count, ctx);
  const buf = GradeBuffer.fromRGB(rgb, w, h);
  const frameCtx: GradeContext = { ...ctx, width: w, height: h };
  if (q.denoise > 0) buf.blurGaussian(q.denoise * 2.5);
  const matte = new Float32Array(count);
  const d = buf.data;
  for (let y = 0, p = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++, i += 3) {
      let m = qualifierMatte(d[i], d[i + 1], d[i + 2], q);
      if (q.windowRestrict && win) m *= windowMask(x, y, win, frameCtx);
      matte[p] = m;
    }
  }
  if (q.matteBlur > 0) blurScalar(matte, w, h, q.matteBlur * 6, new Float32Array(w * h));
  return matte;
}
