/**
 * Colour science: transfer functions, primaries matrices, chromatic
 * adaptation, and the log/linear helpers the Resolve-style pipeline needs.
 *
 * Everything here is float and UNCLAMPED on the way out. The GPU pipeline is
 * 32-bit float; clamping happens once, at the very end of the output
 * transform. Clamping mid-chain is the single most common cause of
 * "highlight detail turns to paper" in browser colour tools.
 *
 * HOUSE RULE, learned the hard way: only FORWARD (RGB -> XYZ) matrices are
 * written down as constants. Every XYZ -> RGB matrix is computed with
 * mat3Inverse at module load. Recalled "inverse" matrices from reference
 * sources are not reliably inverses of each other — AP1's are a live example
 * — and a non-inverse pair tints every neutral pixel while still producing a
 * plausible-looking image. See scripts/derive-ap1.mts, which regenerates the
 * forward constants from chromaticity primaries and reproduces the published
 * sRGB matrix to 10 decimal places.
 *
 * Every function here is covered by test/colormath.test.ts.
 */

// ---------------------------------------------------------------------------
// Transfer functions
// ---------------------------------------------------------------------------

/** Rec.709 / sRGB EOTF. Input and output are LINEAR scene-referred. */
export function rec709ToGamma(linear: number): number {
  const v = Math.max(linear, 0);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

export function gammaToRec709(encoded: number): number {
  const v = Math.max(encoded, 0);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Pure gamma 2.4, no linear toe. Resolve's "Gamma 2.4" timeline option. */
export function gamma24ToLinear(v: number): number {
  return Math.pow(Math.max(v, 0), 2.4);
}

export function linearToGamma24(v: number): number {
  return Math.pow(Math.max(v, 0), 1 / 2.4);
}

/**
 * ARRI LogC (EI 800), a camera log space Resolve accepts as an input colour
 * space. Chosen over the "DaVinci Intermediate" constants that circulate in
 * blog posts, because those do not round-trip — their encode and decode toe
 * breakpoints disagree, so decode(encode(x)) drifts near black. LogC is
 * exactly invertible and puts 18% grey at 0.3867.
 */
const LOGC = {
  cut: 0.010591,
  a: 5.555556,
  b: 0.052272,
  c: 0.052272,
  d: 0.385537,
  e: 5.367655,
  f: 0.092809,
} as const;

/** Encoded value at which LogC leaves its linear toe. */
export const LOGC_BREAKPOINT: number =
  LOGC.c * Math.log10(LOGC.a * LOGC.cut + LOGC.b) + LOGC.d;

/** Mid-grey (0.18 linear) in LogC. */
export const LOGC_MIDDLE_GREY: number =
  LOGC.c * Math.log10(LOGC.a * 0.18 + LOGC.b) + LOGC.d;

export function logcEncode(lin: number): number {
  const x = Math.max(lin, 0);
  if (x > LOGC.cut) return LOGC.c * Math.log10(LOGC.a * x + LOGC.b) + LOGC.d;
  return x * LOGC.e + LOGC.f;
}

export function logcDecode(enc: number): number {
  if (enc > LOGC_BREAKPOINT) {
    return (Math.pow(10, (enc - LOGC.d) / LOGC.c) - LOGC.b) / LOGC.a;
  }
  return (enc - LOGC.f) / LOGC.e;
}

// ---------------------------------------------------------------------------
// 3x3 matrix helpers
// ---------------------------------------------------------------------------

/** Row-major 3x3. */
export type Mat3 = Float64Array;

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] =
        a[r * 3] * b[c] +
        a[r * 3 + 1] * b[3 + c] +
        a[r * 3 + 2] * b[6 + c];
    }
  }
  return o;
}

export function mat3Vec(m: Mat3, v: readonly number[]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Column-major, for uploading to a GLSL mat3 uniform. */
export function mat3ColumnMajor(m: Mat3): Float32Array {
  return new Float32Array([
    m[0], m[3], m[6],
    m[1], m[4], m[7],
    m[2], m[5], m[8],
  ]);
}

export function mat3Inverse(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m as unknown as number[];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) {
    throw new Error('mat3Inverse: singular matrix (determinant ~0)');
  }
  const id = 1 / det;
  return new Float64Array([
    A * id, (c * h - b * i) * id, (b * f - c * e) * id,
    B * id, (a * i - c * g) * id, (c * d - a * f) * id,
    C * id, (b * g - a * h) * id, (a * e - b * d) * id,
  ]);
}

// ---------------------------------------------------------------------------
// Chromatic adaptation
// ---------------------------------------------------------------------------

/** CIE xy chromaticity. z is derived as 1 - x - y, never passed in. */
export interface WhitePoint { x: number; y: number }

export const D65: WhitePoint = { x: 0.3127, y: 0.3290 };
export const D60: WhitePoint = { x: 0.32168, y: 0.33767 };
export const D55: WhitePoint = { x: 0.33242, y: 0.34743 };

/** XYZ for a white point, normalised to Y = 1. */
export function whiteXYZ(w: WhitePoint): [number, number, number] {
  return [w.x / w.y, 1, (1 - w.x - w.y) / w.y];
}

/** Bradford cone response matrix. */
const BRADFORD: Mat3 = new Float64Array([
  0.8951, 0.2664, -0.1614,
  -0.7502, 1.7135, 0.0367,
  0.0389, -0.0685, 1.0296,
]);

/**
 * Bradford chromatic adaptation matrix mapping XYZ(src white) -> XYZ(dst white).
 *
 *   out = M^-1 * diag(dstCone / srcCone) * M
 *
 * The z component of each white point is 1 - x - y. Passing z = 1.0 instead
 * (a common slip) inflates it ~3x, which is why naive AP1 code runs warm.
 */
export function bradfordAdapt(src: WhitePoint, dst: WhitePoint): Mat3 {
  const M = BRADFORD;
  const Mi = mat3Inverse(M);
  const srcCone = mat3Vec(M, whiteXYZ(src));
  const dstCone = mat3Vec(M, whiteXYZ(dst));
  const ratio = new Float64Array([
    dstCone[0] / srcCone[0], 0, 0,
    0, dstCone[1] / srcCone[1], 0,
    0, 0, dstCone[2] / srcCone[2],
  ]);
  return mat3Mul(Mi, mat3Mul(ratio, M));
}

export const D65_TO_D60: Mat3 = bradfordAdapt(D65, D60);
export const D60_TO_D65: Mat3 = bradfordAdapt(D60, D65);

// ---------------------------------------------------------------------------
// FORWARD primaries matrices (RGB -> XYZ). The only constants in this file.
//
// Regenerate with: node --experimental-strip-types scripts/derive-ap1.mts
// ---------------------------------------------------------------------------

/** ACES AP0 (ACES2065-1) -> XYZ (D60). */
export const AP0_TO_XYZ_D60: Mat3 = new Float64Array([
  0.9525523959, 0.0000000000, 0.0000936786,
  0.3439664498, 0.7281660966, -0.0721325464,
  0.0000000000, 0.0000000000, 1.0088251844,
]);

/** AP1 (ACEScc-ish wide gamut, D60) -> XYZ (D60). */
export const AP1_TO_XYZ_D60: Mat3 = new Float64Array([
  0.6624541811, 0.1340042065, 0.1561876870,
  0.2722287168, 0.6740817658, 0.0536895174,
  -0.0055746495, 0.0040607335, 1.0103391003,
]);

/** sRGB / Rec.709 (D65) -> XYZ (D65). */
export const SRGB_TO_XYZ_D65: Mat3 = new Float64Array([
  0.4123907993, 0.3575843394, 0.1804807884,
  0.2126390059, 0.7151686788, 0.0721923154,
  0.0193308187, 0.1191947798, 0.9505321522,
]);

/** Rec.2020 (D65) -> XYZ (D65). */
export const REC2020_TO_XYZ_D65: Mat3 = new Float64Array([
  0.6369580483, 0.1446169036, 0.1688809752,
  0.2627002120, 0.6779980715, 0.0593017165,
  0.0000000000, 0.0280726930, 1.0609850577,
]);

/** Display P3 (D65) -> XYZ (D65). */
export const P3D65_TO_XYZ_D65: Mat3 = new Float64Array([
  0.4865709486, 0.2656676932, 0.1982172852,
  0.2289745641, 0.6917385218, 0.0792869141,
  0.0000000000, 0.0451133819, 1.0439443689,
]);

// ---------------------------------------------------------------------------
// INVERSE matrices — all computed, never written down
// ---------------------------------------------------------------------------

export const XYZ_D60_TO_AP0: Mat3 = mat3Inverse(AP0_TO_XYZ_D60);
export const XYZ_D60_TO_AP1: Mat3 = mat3Inverse(AP1_TO_XYZ_D60);
export const XYZ_D65_TO_SRGB: Mat3 = mat3Inverse(SRGB_TO_XYZ_D65);
export const XYZ_D65_TO_REC2020: Mat3 = mat3Inverse(REC2020_TO_XYZ_D65);
export const XYZ_D65_TO_P3D65: Mat3 = mat3Inverse(P3D65_TO_XYZ_D65);

// ---------------------------------------------------------------------------
// Working-space chains
// ---------------------------------------------------------------------------

/** AP0 -> AP1. */
export const AP0_TO_AP1: Mat3 = mat3Mul(XYZ_D60_TO_AP1, AP0_TO_XYZ_D60);
/** AP1 -> AP0. */
export const AP1_TO_AP0: Mat3 = mat3Mul(XYZ_D60_TO_AP0, AP1_TO_XYZ_D60);

/**
 * sRGB (D65, linear) -> AP1 (D60, linear).
 * The Bradford step is REQUIRED: without it every neutral pixel picks up a
 * ~5% warm cast, because sRGB white is D65 and AP1 white is D60.
 */
export const SRGB_LINEAR_TO_AP1: Mat3 = mat3Mul(
  mat3Mul(XYZ_D60_TO_AP1, D65_TO_D60),
  SRGB_TO_XYZ_D65,
);

/** AP1 (D60, linear) -> sRGB (D65, linear). */
export const AP1_TO_SRGB_LINEAR: Mat3 = mat3Mul(
  mat3Mul(XYZ_D65_TO_SRGB, D60_TO_D65),
  AP1_TO_XYZ_D60,
);

export const AP1_TO_REC2020: Mat3 = mat3Mul(
  mat3Mul(XYZ_D65_TO_REC2020, D60_TO_D65),
  AP1_TO_XYZ_D60,
);

export const AP1_TO_P3D65: Mat3 = mat3Mul(
  mat3Mul(XYZ_D65_TO_P3D65, D60_TO_D65),
  AP1_TO_XYZ_D60,
);

export const SRGB_LINEAR_TO_AP0: Mat3 = mat3Mul(
  mat3Mul(XYZ_D60_TO_AP0, D65_TO_D60),
  SRGB_TO_XYZ_D65,
);

// ---------------------------------------------------------------------------
// Luma
// ---------------------------------------------------------------------------

/**
 * Luma weights per working space, read straight off the Y row of that
 * space's forward matrix. Derived, not recalled, so they always sum to 1.
 * AP1 and AP0 carry NEGATIVE blue/green terms — that is correct, and using
 * Rec.709 weights on a wide gamut is a real error, not a rounding detail.
 */
function yRow(m: Mat3): readonly [number, number, number] {
  return [m[3], m[4], m[5]];
}

export const REC709_LUMA = yRow(SRGB_TO_XYZ_D65);
export const AP1_LUMA = yRow(AP1_TO_XYZ_D60);
export const AP0_LUMA = yRow(AP0_TO_XYZ_D60);
export const REC2020_LUMA = yRow(REC2020_TO_XYZ_D65);
export const P3_LUMA = yRow(P3D65_TO_XYZ_D65);

export function luma709(r: number, g: number, b: number): number {
  return REC709_LUMA[0] * r + REC709_LUMA[1] * g + REC709_LUMA[2] * b;
}

export function lumaAP1(r: number, g: number, b: number): number {
  return AP1_LUMA[0] * r + AP1_LUMA[1] * g + AP1_LUMA[2] * b;
}

// ---------------------------------------------------------------------------
// Hue
// ---------------------------------------------------------------------------

/**
 * Luma-preserving hue rotation.
 *
 * Built as a rotation in the plane orthogonal to the luma normal:
 *
 *   M = n n^T + cos(t) (u u^T + v v^T) + sin(t) (v u^T - u v^T)
 *
 * with n the luma direction and (u, v) an orthonormal basis of its
 * complement. M n = n identically, so luma is preserved to machine
 * precision for ANY input — no reliance on remembered YIQ coefficients,
 * which drift and stop matching the luma weights the scopes actually use.
 */
const norm3 = (v: readonly number[]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross3 = (a: readonly number[], b: readonly number[]): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Luma basis for a working space, built once at module load. */
function lumaBasis(weights: readonly [number, number, number]) {
  const n = norm3(weights);
  // Gram-Schmidt e0 against n; fall back to e1 if they are nearly parallel.
  let u = [1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2]];
  if (Math.hypot(u[0], u[1], u[2]) < 1e-6) {
    u = [-n[1] * n[0], 1 - n[1] * n[1], -n[1] * n[2]];
  }
  const un = norm3(u);
  const v = norm3(cross3(n, un));
  return { n, u: un, v };
}

const REC709_HUE_BASIS = lumaBasis(REC709_LUMA);

/** Rec.709-luma-preserving hue rotation, in degrees. */
export function hueRotate(
  r: number, g: number, b: number, deg: number,
): [number, number, number] {
  if (deg === 0) return [r, g, b];
  return hueRotateIn(REC709_HUE_BASIS, r, g, b, deg);
}

export function hueRotateIn(
  basis: { n: [number, number, number]; u: [number, number, number]; v: [number, number, number] },
  r: number, g: number, b: number, deg: number,
): [number, number, number] {
  const { n, u, v } = basis;
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const y = r * n[0] + g * n[1] + b * n[2];
  const cu = r * u[0] + g * u[1] + b * u[2];
  const cv = r * v[0] + g * v[1] + b * v[2];
  const ru = c * cu + s * cv;
  const rv = -s * cu + c * cv;
  return [
    y * n[0] + ru * u[0] + rv * v[0],
    y * n[1] + ru * u[1] + rv * v[1],
    y * n[2] + ru * u[2] + rv * v[2],
  ];
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue2rgb(h + 1 / 3), hue2rgb(h), hue2rgb(h - 1 / 3)];
}

/**
 * Temperature/tint as a predictable gain pair.
 * Warm-positive, cool-negative — the same sign convention as Resolve's
 * Colour Temperature wheel, where pushing right warms the image.
 */
export function tempTintGains(temperature: number, tint: number): [number, number, number] {
  const t = temperature / 100;
  const n = tint / 100;
  return [
    Math.pow(2, t * 0.3) * Math.pow(2, n * 0.12),
    1,
    Math.pow(2, -t * 0.3) * Math.pow(2, -n * 0.12),
  ];
}
