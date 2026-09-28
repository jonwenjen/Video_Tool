/**
 * GLSL ES 3.00 sources for the WebGL2 colour pipeline.
 *
 * INVARIANTS that hold across every shader here:
 *
 *  - AP1 LINEAR IS THE WORKING SPACE, AND NOTHING CLAMPED IN THE CHAIN.
 *    No `clamp()` in GRADE_SHADER touches a colour value. The only clamps
 *    are (a) texture ADDRESS clamps, where a LUT is undefined outside its
 *    domain, and (b) MATTE / MASK values, which are masks and not colours.
 *    The single value clamp in the whole pipeline is at the bottom of
 *    OUTPUT_SHADER. Clamping mid-chain is the most common cause of
 *    "the highlights turned to paper" in browser colour tools.
 *
 *  - EVERY STAGE IS AN EXACT IDENTITY AT ITS DEFAULT. Not "identity to
 *    within float rounding" — bit-exact. `pow(x, 1.0)`, `(x - p) + p` and
 *    `luma + (x - luma) * 1.0` are all near-identity but not bit-exact, and
 *    ~40 of them stacked across a 6-node graph shows up as drift in the
 *    deepest blacks. Every such stage is therefore behind a CPU-computed
 *    boolean uniform, and the maths inside each branch is written so that
 *    even if the branch were taken it would return x.
 *
 *  - TOP-LEFT ORIGIN INTERNALLY. Texel (0,0) is the image's top-left, `y`
 *    runs down. That matches `readPixels()`, the UI, `WindowState.cx/cy` and
 *    `gl_FragCoord`, so no coordinate flipping happens in the middle of the
 *    chain. The one and only vertical flip is `uFlipY` in OUTPUT_SHADER, at
 *    the canvas boundary, because the default framebuffer is y-up.
 */

/** Version directive. Must be byte 0 of the compiled source. */
const V = '#version 300 es\n';

// ---------------------------------------------------------------------------
// Vertex
// ---------------------------------------------------------------------------

/**
 * Attribute-less fullscreen triangle. No VAO, no buffers, no attributes:
 * gl_VertexID 0,1,2 -> (-1,-1), (3,-1), (-1,3), which covers the viewport
 * with one primitive and avoids the diagonal seam a two-triangle quad puts
 * straight through a derivative-using fragment shader.
 *
 * Fragment stages read `gl_FragCoord.xy / uResolution` rather than a
 * varying, so any pass can render at a different resolution than its input
 * without rescaling UVs.
 */
export const FULLSCREEN_VERT: string = `${V}void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Shared GLSL fragments
// ---------------------------------------------------------------------------

/**
 * Odd-extension power. `pow()` of a negative base is undefined in GLSL, and
 * a wide-gamut linear working space legitimately contains negative
 * excursions — any saturated colour fed through a 3x3 primary matrix can
 * produce them — so every power in this pipeline has to be odd-symmetric or
 * it folds those excursions back to positive.
 */
const SPOW3: string = `
// The exponent is splatted to a vec3 because GLSL ES 3.00 has no
// pow(vec3, float) overload — only pow(vec3, vec3).
vec3 spow3(vec3 v, float e) { return sign(v) * pow(abs(v), vec3(e)); }
// Per-channel exponent, for the two controls that are genuinely RGB:
// ASC CDL power and the gamma wheel.
vec3 spow3v(vec3 v, vec3 e) { return sign(v) * pow(abs(v), e); }
float spow1(float x, float e) { return sign(x) * pow(abs(x), e); }
`;

const LUMA_FNS: string = `
uniform vec3 uLuma;   // AP1 luma weights, from colormath AP1_LUMA

float lumaAP1(vec3 c) { return dot(c, uLuma); }

// HSV-style chroma ratio rather than HSL's (max + min) / 2. In linear light
// with negatives present, (max + min) / 2 is undefined across half the
// image; the ratio form stays finite and monotonic for any input with
// max > 0.
float chromaOf(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  if (mx <= 0.0) return 0.0;
  return (mx - min(min(c.r, c.g), c.b)) / mx;
}

// Hue in 0..1, or -1 when achromatic. Gate on chroma before trusting it.
float hueOf(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float d = mx - mn;
  if (d <= 0.0) return -1.0;
  float h;
  if (mx == c.r)      h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else                h = (c.r - c.g) / d + 4.0;
  return h / 6.0;
}

float hueDist(float a, float b) {
  if (a < 0.0 || b < 0.0) return 0.5;
  float d = abs(a - b);
  return d > 0.5 ? 1.0 - d : d;
}

// Band-limited ramp. A hard step() here produces the crawling, sparkling
// keyer edge nobody can actually paint a line against.
float softBand(float v, float lo, float hi, float soft) {
  return smoothstep(lo - soft, lo + soft, v) *
         (1.0 - smoothstep(hi - soft, hi + soft, v));
}
`;

const HASH: string = `
// Integer-lattice hash on (pixel, frame). Deterministic per frame, so a
// still frame produces a still grain field and two consecutive frames do
// not produce the same one.
float hash1(vec2 p, float seed) {
  vec3 q = fract(vec3(p.xyx) * 0.1031 + seed * 0.137);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
vec3 hash3(vec3 p) {
  return vec3(hash1(p.xy, p.z), hash1(p.yz, p.z + 7.31), hash1(p.zx, p.z + 13.71));
}
`;

// ---------------------------------------------------------------------------
// INPUT
// ---------------------------------------------------------------------------

/**
 * Source decode: an sRGB/Rec.709-ENCODED video element or still -> AP1 linear
 * 32-bit float. The primaries matrix is the uniform `uSRGBToAP1`, uploaded
 * with `mat3ColumnMajor(SRGB_LINEAR_TO_AP1)`; it is not written down here
 * because colormath.ts owns those numbers and the CPU and GPU must not be
 * able to disagree about them.
 *
 * `uTransfer` selects the decode of the encoded signal:
 *   0  sRGB piecewise — the usual case for 8-bit video and PNG stills
 *   1  BT.709 (2.4 with the 0.081 linear toe) — broadcast rasters
 *   2  pure 2.2 — the web convention Resolve's "Gamma 2.4" sits next to
 *
 * `uLogcToLinear` switches the source to ARRI LogC (EI 800). LogC is applied
 * BEFORE the RGB->AP1 matrix: a camera log is a transfer function on a
 * known gamut (Rec.709), not on AP1, and running the matrix first would put
 * the log on the wrong primaries.
 */
export const INPUT_SHADER: string = `${V}precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uSource;
uniform vec2  uResolution;
uniform mat3  uSRGBToAP1;
uniform int   uTransfer;      // 0 sRGB, 1 BT.709, 2 gamma 2.2
uniform float uLogcToLinear;  // 0 / 1
uniform float uExposure;      // scene-referred stop offset, 1.0 = unity
uniform float uPreSat;        // pre-grade saturation, 1.0 = unity

out vec4 fragColor;

${SPOW3}
const float LOGC_A = 5.555556;
const float LOGC_B = 0.052272;
const float LOGC_C = 0.052272;
const float LOGC_D = 0.385537;
const float LOGC_E = 5.367655;
const float LOGC_F = 0.092809;
const float LOGC_BREAK = ${(
      0.052272 * Math.log10(5.555556 * 0.010591 + 0.052272) + 0.385537
    ).toFixed(9)};

float logcDecode(float e) {
  return e > LOGC_BREAK
    ? (pow(10.0, (e - LOGC_D) / LOGC_C) - LOGC_B) / LOGC_A
    : (e - LOGC_F) / LOGC_E;
}

float srgbToLinear(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}
float bt709ToLinear(float c) {
  return c < 0.081 ? c / 4.5 : pow((c + 0.099) / 1.099, 1.0 / 0.45);
}
float g22ToLinear(float c) { return pow(max(c, 0.0), 2.2); }

void main() {
  vec3 s = texture(uSource, gl_FragCoord.xy / uResolution).rgb;

  vec3 c;
  if (uLogcToLinear > 0.5) {
    c = vec3(logcDecode(s.r), logcDecode(s.g), logcDecode(s.b));
  } else if (uTransfer == 1) {
    c = vec3(bt709ToLinear(s.r), bt709ToLinear(s.g), bt709ToLinear(s.b));
  } else if (uTransfer == 2) {
    c = vec3(g22ToLinear(s.r), g22ToLinear(s.g), g22ToLinear(s.b));
  } else {
    c = vec3(srgbToLinear(s.r), srgbToLinear(s.g), srgbToLinear(s.b));
  }

  c *= uExposure;
  if (uPreSat != 1.0) {
    float y = dot(c, vec3(0.2722287168, 0.6740817658, 0.0536895174));
    c = y + (c - y) * uPreSat;
  }

  fragColor = vec4(uSRGBToAP1 * c, 1.0);
}
`;

// ---------------------------------------------------------------------------
// GRADE
// ---------------------------------------------------------------------------

/**
 * The grade. Stage order is fixed and each stage's position matters:
 *
 *    1  input gamma trim          10 chroma key
 *    2  ASC CDL                   11 3D LUT
 *    3  primaries                 12 gaussian blur
 *    4  temperature / tint        13 unsharp mask
 *    5  hue rotate                14 bloom / glow
 *    6  saturation + vibrance     15 vignette
 *    7  custom curves             16 film grain
 *    8  power window              17 filmic contrast
 *    9  HSL qualifier matte       18 output gamma trim
 *
 * WINDOW AND QUALIFIER (8, 9) are evaluated against the UNGRADED input
 * pixel, and are in the WORKING (AP1 LINEAR) space, not a gamma-encoded
 * copy. The matte answers "is this pixel inside the window / inside the
 * hue", and that question is asked of the incoming image — the same way
 * Resolve asks it, with the qualifier sitting downstream of the input
 * transform. Their masks are UNIONED, not applied in sequence: applying the
 * window and then the qualifier would grade an overlap twice and change its
 * strength, which makes the two controls interact in a way nobody can
 * reason about.
 *
 * CURVE DOMAIN (7) is the one stage that leaves AP1. The reason is the
 * DOMAIN of the control points, not aesthetics: `CurvesState` is 0..1 in,
 * 0..1 out, and a point dragged to 0.5 in a 0..1 domain lands at
 * scene-linear 0.5 — brighter than diffuse white, in the top 2% of the
 * tonal range — if the curve is applied in linear. In a 1/2.2-encoded domain
 * 0.5 is perceptual mid-grey, which is what the user actually aimed at.
 * Resolve makes the same trade: its custom curves live in a log/gamma
 * domain, not the working space. The consequence, which is intended and
 * matches Resolve, is that values outside the curve's 0..1 domain
 * (super-whites, negative excursions) are HELD at the curve's endpoint,
 * because a 0..1 curve has no meaning outside 0..1. Only the LUT INDEX is
 * clamped for that reason; the LUT OUTPUT never is.
 *
 * CONTRAST is log-pivot, written so that contrast == 1.0 is bit-exact
 * identity:  x' = pivot * (x / pivot)^contrast.  The naive form
 * (x - pivot) * contrast + pivot, applied to a log signal and then
 * re-encoded with a fixed 0.5 gamma, darkens the image at contrast == 1 —
 * it is the single most common bug in a hand-rolled primaries block, and it
 * is why this one is written as a power about the pivot.
 */
export const GRADE_SHADER: string = `${V}precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;

uniform sampler2D uSource;    // working-space AP1 linear input for this node
uniform sampler2D uBlurTex;   // pre-blurred copy; only sampled when an fx is on
uniform sampler3D uLut3D;

uniform vec2  uResolution;
uniform float uFrame;

${LUMA_FNS}
${SPOW3}
${HASH}

// --- stage switches. These are what make a default grade a bit-exact
// --- pass-through rather than a stack of near-identities.
uniform int uInGammaOn;   // 0/1 flag
uniform int uCdlCurveOn;   // 0/1 flag
uniform int uCdlSatOn;   // 0/1 flag
uniform int uPrimaryOn;   // 0/1 flag
uniform int uTempOn;   // 0/1 flag
uniform int uHueOn;   // 0/1 flag
uniform int uSatOn;   // 0/1 flag
uniform int uCurvesOn;   // 0/1 flag
uniform int uWindowOn;   // 0/1 flag
uniform int uQualifierOn;   // 0/1 flag
uniform int uKeyOn;   // 0/1 flag
uniform int uLutOn;   // 0/1 flag
uniform int uBlurFxOn;   // 0/1 flag
uniform int uSharpOn;   // 0/1 flag
uniform int uGlowOn;   // 0/1 flag
uniform int uVignetteOn;   // 0/1 flag
uniform int uGrainOn;   // 0/1 flag
uniform int uFilmOn;   // 0/1 flag
uniform int uOutGammaOn;   // 0/1 flag

// --- 1 / 18  gamma trims
uniform float uInputGamma;
uniform float uOutputGamma;

// --- 2  ASC CDL
uniform vec3  uCdlSlope;
uniform vec3  uCdlOffset;
uniform vec3  uCdlPower;
uniform float uCdlSat;

// --- 3  primaries
uniform vec3  uLift;
uniform vec3  uGammaW;
uniform vec3  uGain;
uniform vec3  uOffset;
uniform float uContrast;
uniform float uPivot;
uniform float uBrightness;
uniform float uSaturation;
uniform float uContrastLow;
uniform float uContrastHigh;
uniform float uShadowBias;
uniform float uHighlightBias;
uniform float uColourBoost;

// --- 4  temperature / tint
uniform vec3  uTempTintGains;

// --- 5  hue rotate. The luma-basis matrix is built on the CPU
// --- (hueRotateMatrix in pipeline.ts) and uploaded; it is never re-derived
// --- here, because a shader-local derivation drifts from colormath.ts and
// --- the scopes then stop agreeing with the image about brightness.
uniform mat3  uHueMat;

// --- 6  vibrance
uniform float uVibrance;

// --- 7  custom curves: 1024x4 RGBA float, rows 0/1/2 = r/g/b, row 3 = master
uniform sampler2D uCurveLut;
uniform float uCurveDomain;

// --- 8  power window
uniform int   uWinShape;      // 0 ellipse, 1 rectangle, 2 linear
uniform vec2  uWinCenter;     // normalised, top-left origin
uniform vec2  uWinHalf;       // half extents, normalised
uniform float uWinAngle;      // degrees
uniform float uWinSoftness;
uniform float uWinFeather;
uniform int uWinInvert;   // 0/1 flag
uniform float uWinMix;

// --- 9  qualifier
uniform float uQCenter;
uniform float uQWidth;
uniform float uQSoft;
uniform float uQSatLow;
uniform float uQSatHigh;
uniform float uQLumLow;
uniform float uQLumHigh;
uniform float uQBalance;
uniform int uQInvert;   // 0/1 flag
uniform float uQDenoise;
uniform float uQMatteBlur;
uniform int   uQView;         // 0 matte, 1 overlay, 2 no-key
uniform float uQDesatOutside;
uniform int uQWindowRestrict;   // 0/1 flag

// --- 10 chroma key
uniform vec3  uKeyColor;
uniform vec3  uKeyFill;
uniform float uKeyTolerance;
uniform float uKeySoftness;
uniform float uKeySpill;
uniform float uKeyEdge;
uniform float uKeyShrinkGrow;
uniform int   uKeyFillMode;   // 0 over, 1 fill, 2 edge

// --- 11 3D LUT
uniform float uLutIntensity;
uniform vec2  uLutDomain;     // input domain, from the .cube header
uniform float uLutDomainMode; // 0 gamma-encoded (every real .cube file), 1 linear

// --- 12 / 13 / 14  spatial
uniform float uBlurAmount;
uniform float uSharpen;
uniform float uSharpenRadius;
uniform float uGlow;
uniform float uGlowThreshold;

// --- 15 / 16 / 17  finishing
uniform float uVignette;
uniform float uVignetteSoft;
uniform float uGrain;
uniform float uGrainSeed;
uniform float uFilmContrast;

out vec4 fragColor;

// ===========================================================================
// 8. power window — signed distance, so soft edges, feather and rotation
//     all come out of one expression.
// ===========================================================================

// Returned in units of 1/imageHeight: x was pre-multiplied by aspect and y
// was left alone, so one unit is one image height everywhere below, and a
// softness in pixels is just softness * resolution.y.
float windowSDF(vec2 uv) {
  float aspect = uResolution.x / uResolution.y;
  vec2 d = uv - uWinCenter;
  d.x *= aspect;
  float a = radians(-uWinAngle);
  vec2 r = vec2(d.x * cos(a) - d.y * sin(a), d.x * sin(a) + d.y * cos(a));
  vec2 hw = vec2(max(uWinHalf.x, 1e-4) * aspect, max(uWinHalf.y, 1e-4));

  if (uWinShape == 0) {
    return (length(r / hw) - 1.0) * min(hw.x, hw.y);
  } else if (uWinShape == 1) {
    float rad = 0.08 * min(hw.x, hw.y);   // slight corner round, like Resolve
    vec2 q = abs(r) - hw + rad;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
  }
  return abs(r.x) - hw.x;   // linear: an infinite band about the major axis
}

float windowMask(vec2 uv) {
  float sd = windowSDF(uv);
  float softPx = max(uWinSoftness, 0.0) * 0.5 * uResolution.y;
  float featherPx = max(uWinFeather, 0.0) * 0.5 * uResolution.y;
  // softness is the analytic edge transition; feather is a second, wider
  // falloff that additionally tapers the interior towards the boundary, so
  // the two controls are not redundant.
  float m = 1.0 - smoothstep(-0.5 * softPx, 0.5 * softPx, sd);
  m *= 1.0 - smoothstep(-0.5 * featherPx, 0.5 * featherPx, sd);
  return (uWinInvert != 0) ? 1.0 - m : m;
}

// ===========================================================================
// 9. HSL qualifier matte
// ===========================================================================

// HSL of a linear AP1 value. Only the MIN term is guarded, and that is a
// matte-domain operation, not a colour clamp: (max + min) / 2 is undefined
// once min goes negative, and a matte must never come out negative. The
// colour itself is never touched.
float qSatOf(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  if (mx <= 0.0) return 0.0;
  return (mx - max(min(min(c.r, c.g), c.b), 0.0)) / mx;
}

float qualifierMatte(vec3 c) {
  float soft = 0.02 + uQDenoise * 0.06;
  float sat = qSatOf(c);
  if (sat < uQSatLow - soft) return 0.0;
  float lum = lumaAP1(c);
  if (lum < uQLumLow - soft || lum > uQLumHigh + soft) return 0.0;
  if (sat > uQSatHigh + soft) return 0.0;

  // balance skews the WIDTH rather than shifting the centre, so the key's
  // colour stays where the user put it while the soft edge moves — which is
  // what Resolve's balance slider does.
  float w = clamp(uQWidth * (1.0 + uQBalance), 1.0 / 2048.0, 0.5);
  float s = max(uQSoft, 1.0 / 2048.0);
  float mHue = 1.0 - smoothstep(w, w + s, hueDist(hueOf(c), uQCenter));

  return softBand(sat, uQSatLow, uQSatHigh, soft)
       * softBand(lum, uQLumLow, uQLumHigh, soft)
       * mHue;
}

// Matte blur as a 12-tap average of the matte FUNCTION over a spiral in the
// source. Mathematically that IS a blur of the matte image — the matte is a
// deterministic function of the source pixel — and it costs no extra
// framebuffer and no extra pass. At matteBlur == 0 the loop is not entered
// at all. A separate matte pass would win at large radii; for a preview
// parameter on a browser tool this is the right trade.
float qualifierMatteBlurred(vec3 c, vec2 uv) {
  float m0 = qualifierMatte(c);
  if (uQMatteBlur <= 0.0) return m0;
  float radiusPx = uQMatteBlur * 0.02 * min(uResolution.x, uResolution.y);
  if (radiusPx < 0.5) return m0;

  vec2 halfTexel = 0.5 / uResolution;
  float sum = m0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float a = (fi + 0.5) * (2.0 * 3.141592653589793 / 12.0);
    float rr = radiusPx * sqrt((fi + 0.5) / 12.0);
    vec2 t = clamp(uv + vec2(cos(a), sin(a)) * rr / uResolution,
                   halfTexel, 1.0 - halfTexel);
    sum += qualifierMatte(texture(uSource, t).rgb);
  }
  return sum / 13.0;
}

// ===========================================================================
// 10. chroma key
// ===========================================================================

// CbCr of a gamma-encoded signal. The keyer deliberately does NOT run on
// scene-linear: chroma separation is roughly perceptually uniform in an
// encoded domain, which is exactly where a clean-plate swatch picked off
// the display image belongs. Keying raw linear light makes greens and
// magentas need wildly different tolerances for the same plate.
vec2 cbcrOf(vec3 c) {
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return vec2(c.b - y, c.r - y);
}

float keyAlpha(vec3 c, vec2 keyCbCr, float keyChroma) {
  float dist = length(cbcrOf(spow3(c, 1.0 / 2.2)) - keyCbCr)
             * mix(2.0, 1.0, keyChroma);
  float tol = max(uKeyTolerance, 1e-4);
  float soft = max(uKeySoftness * tol, 1e-5);
  float a = 1.0 - smoothstep(tol * (1.0 - uKeySoftness), tol + soft, dist);

  // shrink / grow: re-threshold the matte about its own 0.5
  float sg = uKeyShrinkGrow;
  if (abs(sg) > 0.001) {
    float k = 0.5 - abs(sg) * 0.5;
    a = sg < 0.0 ? 1.0 - smoothstep(k, 1.0 - k, a)
                  : smoothstep(k, 1.0 - k, a);
  }
  // edge: soften the matte boundary
  if (uKeyEdge > 0.001) {
    a = smoothstep(0.5 - uKeyEdge * 0.5, 0.5 + uKeyEdge * 0.5, a);
  }
  return clamp(a, 0.0, 1.0);   // MATTE value, not a colour
}

// ===========================================================================
// 7. curve LUT fetch
// ===========================================================================

float curveAt(int row, float v) {
  float u = clamp(v, 0.0, 1.0);              // ADDRESS clamp: the curve is
  float x = u * 1023.0;                      // only defined on its domain
  int i0 = int(floor(x));
  int i1 = min(i0 + 1, 1023);
  float f = x - float(i0);
  float a = texelFetch(uCurveLut, ivec2(i0, row), 0).r;
  float b = texelFetch(uCurveLut, ivec2(i1, row), 0).r;
  return mix(a, b, f);
}

// ===========================================================================
// main
// ===========================================================================

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec3 src = texture(uSource, uv).rgb;
  float alpha = 1.0;
  vec3 c = src;

  // --- masks, evaluated against the UNGRADED pixel, in working space ----
  float wMask = 1.0;
  if (uWindowOn != 0) wMask = windowMask(uv);

  float qMask = 1.0;
  if (uQualifierOn != 0) {
    qMask = qualifierMatteBlurred(src, uv);
    if (uQDenoise > 0.0) {
      // Denoise is soft-edge contraction, not a spatial filter: there is no
      // neighbourhood here without another pass, so what it actually buys
      // the user is a harder, less sparkly matte boundary.
      float k = mix(0.5, 0.02, uQDenoise);
      qMask = smoothstep(0.5 - k, 0.5 + k, qMask);
    }
    if (uQInvert != 0) qMask = 1.0 - qMask;
    if (uQWindowRestrict != 0) qMask *= wMask;
  }

  // --- 1. input gamma trim ---------------------------------------------
  if (uInputGamma != 1.0) c = spow3(c, uInputGamma);

  // --- 2. ASC CDL -------------------------------------------------------
  // CDL power is only defined on non-negative values, so the max() below is
  // a requirement of the ASC spec, not a chain clamp. It sits behind
  // uCdlCurveOn so an unused CDL cannot clip the negatives a default grade
  // is legitimately carrying around.
  if (uCdlCurveOn != 0) {
    c = spow3v(max(c * uCdlSlope + uCdlOffset, vec3(0.0)), uCdlPower);
  }
  if (uCdlSatOn != 0) {
    float y = lumaAP1(c);
    c = y + (c - y) * uCdlSat;
  }

  // --- 3. primaries -----------------------------------------------------
  if (uPrimaryOn != 0) {
    // lift / gamma / gain in scene linear: a pedestal, a shaping exponent
    // and a gain on light, which is what "scene-linear-ish wheel space" in
    // types.ts means. gain 1.0 is a bit-exact multiply-by-one.
    if (uLift != vec3(0.0))   c += uLift;
    if (uGammaW != vec3(1.0)) c = spow3v(c, 1.0 / uGammaW);
    if (uGain != vec3(1.0))   c *= uGain;
    if (uOffset != vec3(0.0)) c += uOffset;

    // Contrast, brightness, the tonal range and colour boost run on a
    // 1/2.2-encoded signal, because their reference points are perceptual:
    // a pivot of 0.435 in scene linear is 0.435x diffuse white, below
    // middle grey by most of a stop, and not the number anyone aims at.
    vec3 p = spow3(c, 1.0 / 2.2);

    if (uContrast != 1.0) {
      // Log-pivot contrast: bit-exact identity at contrast == 1 because
      // pivot * (x / pivot)^1 == pivot * (x / pivot) == x. Never the naive
      // (x - pivot) * k + pivot, which darkens at k == 1 once the signal is
      // re-encoded.
      float k = uPivot;
      p = k * spow3(p / k, uContrast);

      // Low / high split: a smaller contrast about a raised (low) or
      // lowered (high) pivot, cross-faded on green so the two ends meet.
      if (uContrastLow > 0.0 || uContrastHigh > 0.0) {
        float cl = 1.0 + (uContrast - 1.0) * (1.0 - uContrastHigh);
        float ch = 1.0 + (uContrast - 1.0) * (1.0 - uContrastLow);
        vec3 lo = uPivot * spow3(p / uPivot, cl);
        vec3 hi = uPivot * spow3(p / uPivot, ch);
        p = mix(lo, hi, clamp(p.g, 0.0, 1.0));
      }
    }
    if (uBrightness != 0.0) p += uBrightness;

    if (uShadowBias != 0.0 || uHighlightBias != 0.0) {
      // Gaussian range weights on perceptual luminance: a soft partition of
      // unity, so shadows + midtones + highlights == 1 and dragging the
      // range handles can never change the overall level of the node.
      float l = clamp(p.g, 0.0, 1.0);
      float wS = exp(-pow(max(l, 0.0) * 2.0, 2.0));
      float wH = exp(-pow(max(1.0 - l, 0.0) * 2.0, 2.0));
      p += vec3(uShadowBias * wS + uHighlightBias * wH);
    }
    if (uColourBoost > 0.0) {
      // Boost saturation of the mid-luminance band only, so a skin tone
      // comes up without the sky following it.
      float l = clamp(p.g, 0.0, 1.0);
      float w = exp(-pow((l - 0.5) * 2.4, 2.0));
      float y = lumaAP1(p);
      p = y + (p - y) * (1.0 + w * uColourBoost * 0.75);
    }
    c = spow3(p, 2.2);

    if (uSaturation != 1.0) {
      float y = lumaAP1(c);
      c = y + (c - y) * uSaturation;
    }
  }

  // --- 4. temperature / tint -------------------------------------------
  if (uTempOn != 0) c *= uTempTintGains;   // gains are (1,1,1) at 0/0

  // --- 5. hue rotate, luma preserving (matrix from the CPU) ------------
  if (uHueOn != 0) c = uHueMat * c;

  // --- 6. saturation + vibrance ----------------------------------------
  if (uSatOn != 0) {
    float y = lumaAP1(c);
    c = y + (c - y) * uSaturation;
    if (uVibrance != 0.0) {
      // weighted by how unsaturated the pixel ALREADY is, so vibrance lifts
      // the muted colours and leaves the hero colour alone
      float w = 1.0 - chromaOf(c);
      c = y + (c - y) * (1.0 + uVibrance * w);
    }
  }

  // --- 7. custom curves, on a 1/2.2 encoded signal ---------------------
  // See the header: the curve DOMAIN is perceptual, which is the only
  // reason this stage leaves AP1. Outside 0..1 the curve holds its endpoint
  // (index clamp), and the LUT output is never clamped.
  if (uCurvesOn != 0) {
    vec3 p = spow3(c, 1.0 / uCurveDomain);
    vec3 q = vec3(curveAt(0, p.r), curveAt(1, p.g), curveAt(2, p.b));
    q = vec3(curveAt(3, q.r), curveAt(3, q.g), curveAt(3, q.b));
    c = spow3(q, uCurveDomain);
  }

  // --- 11. 3D LUT -------------------------------------------------------
  if ((uLutOn != 0) && uLutIntensity > 0.0) {
    // uLutDomainMode 0 is the default and what every real .cube file
    // assumes: the LUT runs on a gamma-encoded signal. A .cube authored for
    // a display-referred Rec.709 image, applied to scene-linear AP1, gives a
    // plausible-looking but badly wrong result — the shadows move twice.
    vec3 p = uLutDomainMode < 0.5 ? spow3(c, 1.0 / 2.2) : c;
    vec3 uvw = clamp(p, 0.0, 1.0);          // ADDRESS clamp only
    uvw = uLutDomain.x + uvw * (uLutDomain.y - uLutDomain.x);
    vec3 s = texture(uLut3D, uvw).rgb;     // sampler3D, from a .cube upload
    c = mix(c, uLutDomainMode < 0.5 ? spow3(s, 2.2) : s, uLutIntensity);
  }

  // --- 12 / 13 / 14  spatial --------------------------------------------
  if ((uBlurFxOn != 0) || (uSharpOn != 0) || (uGlowOn != 0)) {
    vec3 b = texture(uBlurTex, uv).rgb;
    if (uBlurFxOn != 0)   c = mix(c, b, uBlurAmount);
    if (uSharpOn != 0)    c += uSharpen * uSharpenRadius * (c - b);
    // bloom is a thresholded tail off the same blur: one blur chain serves
    // all three, which is why the pipeline needs only two extra targets.
    if (uGlowOn != 0)    c += max(b - uGlowThreshold, vec3(0.0)) * uGlow;
  }

  // --- 15. vignette -----------------------------------------------------
  if (uVignette != 0.0) {
    float aspect = uResolution.x / uResolution.y;
    vec2 d = (uv - 0.5) * vec2(aspect, 1.0);
    float r = length(d) * 1.4142135;
    float f = mix(1.0, smoothstep(0.0, 1.0, r), uVignetteSoft);
    c *= 1.0 - uVignette * f;
  }

  // --- 16. film grain ---------------------------------------------------
  if (uGrain > 0.0) {
    // Hash on pixel + frame, so a still frame has a still grain field.
    // Amplitude rises out of the toe: noise in the crushed blacks is the
    // most visible noise there is.
    vec3 h = hash3(vec3(uv * uResolution, uFrame + uGrainSeed));
    float amp = uGrain * 0.12 * smoothstep(0.0, 0.25, max(lumaAP1(c), 0.0));
    c += (h - 0.5) * amp;
  }

  // --- 17. filmic contrast ---------------------------------------------
  if (uFilmContrast > 0.0) {
    vec3 p = spow3(c, 1.0 / 2.2);
    // A filmic curve is by definition defined on 0..1 with pinned endpoints;
    // its extrapolation into super-white is worse than a flat extension. The
    // smoothstep inside does the bounding, so no explicit clamp is needed.
    vec3 s = mix(p, smoothstep(0.0, 1.0, p), uFilmContrast);
    c = spow3(s, 2.2);
  }

  // --- 18. output gamma trim -------------------------------------------
  if (uOutputGamma != 1.0) c = spow3(c, uOutputGamma);

  // --- 10. chroma key ---------------------------------------------------
  if (uKeyOn != 0) {
    vec3 enc = spow3(c, 1.0 / 2.2);
    vec2 kCbCr = cbcrOf(spow3(uKeyColor, 1.0 / 2.2));
    float a = keyAlpha(c, kCbCr, chromaOf(spow3(uKeyColor, 1.0 / 2.2)));

    // spill suppression: pull the chroma component along the key hue out of
    // the pixel. This is what leaves the green fringe.
    if (uKeySpill > 0.0) {
      float kl = length(kCbCr);
      if (kl > 1e-5) {
        vec2 dir = kCbCr / kl;
        vec2 d = cbcrOf(enc) - dir * max(dot(cbcrOf(enc), dir), 0.0) * uKeySpill;
        float y = dot(enc, vec3(0.2126, 0.7152, 0.0722));
        c = spow3(vec3(y + d.y, y - 0.5 * (d.x + d.y), y + d.x), 2.2);
      }
    }
    vec3 keyed = uKeyFillMode == 1 ? uKeyFill
               : (uKeyFillMode == 2 ? mix(c, uKeyFill, 0.5) : c);
    c = mix(c, keyed, a);
    alpha = 1.0 - a;
  }

  // --- mask application -------------------------------------------------
  // Union, not sequence — see the header.
  float mask = 1.0 - (1.0 - wMask * uWinMix) * (1.0 - qMask);
  c = mix(src, c, mask);

  // --- qualifier view modes --------------------------------------------
  if (uQualifierOn != 0) {
    if (uQView == 0) {
      c = vec3(qMask);
    } else if (uQView == 1) {
      c = mix(c, vec3(1.0), qMask * 0.5);   // screen-ish wash over the image
    }
    if (uQView != 0 && uQDesatOutside > 0.0) {
      float y = lumaAP1(c);
      c = mix(c, vec3(y), (1.0 - qMask) * uQDesatOutside);
    }
  }

  fragColor = vec4(c, alpha);
}
`;

// ---------------------------------------------------------------------------
// OUTPUT
// ---------------------------------------------------------------------------

/**
 * Display transform, and THE ONLY VALUE CLAMP IN THE PIPELINE.
 *
 * Input is AP1 linear (D60 white). `uToOutput` is the AP1 -> display
 * primaries matrix, uploaded column-major from colormath.ts
 * (AP1_TO_SRGB_LINEAR / AP1_TO_REC2020 / AP1_TO_P3D65), followed by an
 * encode: `uSrgbEncode` 1 = sRGB piecewise (what a browser canvas expects
 * for Rec.709 / sRGB), 0 = a pure `uDisplayGamma` power, which is the
 * Rec.2020 / Display P3 case where the delivery gamma is a pipeline setting
 * rather than a property of the colour space.
 *
 * `uProjectGamma` is ProjectSettings.outputGamma as a TRIM — a power on top
 * of the encode, defaulting to 1.0 = identity. Same convention as
 * GradeState.outputGamma, so the two compose without either of them
 * special-casing the other.
 *
 * `uFlipY` is the pipeline's single vertical flip, set only when drawing to
 * the y-up default framebuffer.
 */
export const OUTPUT_SHADER: string = `${V}precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uSource;
uniform vec2  uResolution;
uniform mat3  uToOutput;
uniform float uSrgbEncode;   // 0 / 1
uniform float uDisplayGamma;
uniform float uProjectGamma;
uniform float uClampOut;     // 0 / 1  <- the only clamp in the pipeline
uniform float uFlipY;

out vec4 fragColor;

${SPOW3}

float linearToSrgb(float c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  if (uFlipY > 0.5) uv.y = 1.0 - uv.y;

  vec3 c = uToOutput * texture(uSource, uv).rgb;

  vec3 e;
  if (uSrgbEncode > 0.5) {
    e = vec3(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b));
  } else {
    e = spow3(c, 1.0 / max(uDisplayGamma, 1e-3));
  }
  if (uProjectGamma != 1.0) e = spow3(e, uProjectGamma);

  if (uClampOut > 0.5) e = clamp(e, 0.0, 1.0);   // <- the one clamp

  fragColor = vec4(e, 1.0);
}
`;

// ---------------------------------------------------------------------------
// BLIT / BLEND
// ---------------------------------------------------------------------------

/** 1:1 copy. `uSwapRB` is for tests that feed a raw channel permutation. */
export const BLIT_SHADER: string = `${V}precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uSource;
uniform vec2  uResolution;
uniform float uSwapRB;

out vec4 fragColor;

void main() {
  vec4 s = texture(uSource, gl_FragCoord.xy / uResolution);
  fragColor = uSwapRB > 0.5 ? vec4(s.b, s.g, s.r, s.a) : s;
}
`;

/**
 * Parallel / serial two-input mixer. Both sides arrive already graded in
 * working space. The B input's ALPHA is used as a key, so a chroma-keyed
 * upstream node composites OVER a background rather than cross-fading into
 * it. That is the only reason alpha survives the chain for anything other
 * than a key matte, and it is why a key node in the middle of a graph is
 * worth having.
 */
export const BLEND_SHADER: string = `${V}precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uA;
uniform sampler2D uB;
uniform vec2  uResolution;
uniform float uMix;
uniform float uUseAlphaKey;

out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 a = texture(uA, uv);
  vec4 b = texture(uB, uv);
  float t = uUseAlphaKey > 0.5 ? uMix * b.a : uMix;
  fragColor = vec4(a.rgb * (1.0 - t) + b.rgb * t, a.a * (1.0 - t) + t);
}
`;

// ---------------------------------------------------------------------------
// GAUSSIAN
// ---------------------------------------------------------------------------

/**
 * Separable Gaussian. `uDirection` is (1,0) or (0,1); the pipeline runs it
 * horizontally into one temp and vertically into the other, which is why the
 * whole chain needs two extra full-size targets instead of a downsample
 * pyramid.
 *
 * `uFiltered` selects hardware bilinear against a manual bilinear built from
 * texelFetch. 32F textures are only texture-filterable with
 * OES_texture_float_linear, and that extension is missing often enough that
 * a NEAREST blur at a 6-pixel step bands visibly. The manual path costs four
 * texelFetches and is correct everywhere.
 */
export const GAUSSIAN_SHADER: string = `${V}precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uSource;
uniform vec2  uResolution;
uniform vec2  uTexelSize;    // 1 / source size
uniform vec2  uDirection;    // (1,0) or (0,1)
uniform float uRadius;       // pixels
uniform int uFiltered;   // 0/1 flag

out vec4 fragColor;

vec4 tap(sampler2D t, vec2 uv) {
  if (uFiltered != 0) return texture(t, uv);
  vec2 p = uv / uTexelSize - 0.5;
  vec2 f = fract(p);
  ivec2 i = ivec2(floor(p));
  vec4 a = texelFetch(t, i, 0);
  vec4 b = texelFetch(t, i + ivec2(1, 0), 0);
  vec4 c = texelFetch(t, i + ivec2(1, 1), 0);
  vec4 d = texelFetch(t, i + ivec2(0, 1), 0);
  return mix(mix(a, b, f.x), mix(d, c, f.x), f.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float sigma = max(uRadius, 0.01) / 2.5;
  float sp = uRadius / 8.0;

  vec4 sum = tap(uSource, uv);
  float wsum = 1.0;
  for (int i = 1; i <= 16; i++) {
    float fi = float(i);
    float w = exp(-0.5 * (fi * sp / sigma) * (fi * sp / sigma));
    if (w < 1e-4) break;
    vec2 o = uDirection * uTexelSize * fi * sp;
    vec2 lo = uTexelSize * 0.5;
    sum += tap(uSource, clamp(uv + o, lo, 1.0 - lo)) * w;
    sum += tap(uSource, clamp(uv - o, lo, 1.0 - lo)) * w;
    wsum += 2.0 * w;
  }
  fragColor = sum / wsum;
}
`;

// ---------------------------------------------------------------------------
// DOWNSCALE
// ---------------------------------------------------------------------------

/**
 * Box downscale by explicit texelFetch taps, for scope analysis.
 *
 * A single bilinear sample is the usual downscale trick, but that only works
 * with LINEAR filtering, and the analysis buffer deliberately runs at NEAREST
 * when OES_texture_float_linear is missing — otherwise the histogram would
 * be integrating whichever four texels the sampler happened to pick, and the
 * vectorscope would smear.
 */
export const DOWNSCALE_SHADER: string = `${V}precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uSource;
uniform vec2  uResolution;   // DESTINATION size
uniform ivec2 uSrcSize;      // source size in texels
uniform ivec2 uBox;          // taps per axis, 1..4

out vec4 fragColor;

void main() {
  ivec2 dst = ivec2(gl_FragCoord.xy);
  // ivec2 / ivec2 is integer division, which would floor the step to 1 for
  // any downscale factor below 1 and silently turn the box filter into a
  // point sample. Do it in float and convert once.
  vec2 stf = max(vec2(uSrcSize) / max(uResolution, vec2(1.0)), vec2(1.0));
  ivec2 st = ivec2(stf);
  vec4 sum = vec4(0.0);
  float n = 0.0;
  for (int y = 0; y < 4; y++) {
    if (y >= uBox.y) break;
    for (int x = 0; x < 4; x++) {
      if (x >= uBox.x) break;
      ivec2 p = clamp(dst * st + ivec2(x, y), ivec2(0), uSrcSize - ivec2(1));
      sum += texelFetch(uSource, p, 0);
      n += 1.0;
    }
  }
  fragColor = sum / max(n, 1.0);
}
`;

// ---------------------------------------------------------------------------
// SCOPE
// ---------------------------------------------------------------------------

/**
 * Rasterises a float analysis buffer into a display texture.
 *
 * `uMode` 0 = single-channel intensity ramp, channel from `uChannel`
 *          1 = RGB passthrough (waveform / parade shows the real trace colour)
 *          2 = heat ramp on luma
 *
 * Scopes are the one place a saturating clamp is not merely acceptable but
 * required: an unbounded float buffer mapped to a display has to saturate
 * somewhere, and it is a measurement, not an image.
 */
export const SCOPE_SHADER: string = `${V}precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uData;
uniform vec2  uResolution;
uniform int   uMode;
uniform int   uChannel;
uniform float uScale;
uniform float uGamma;
uniform vec3  uTint;
uniform float uBackground;

out vec4 fragColor;

vec3 heat(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(vec3(0.0, 0.0, 0.12), vec3(0.25, 0.10, 0.70), smoothstep(0.0, 0.35, t));
  c = mix(c, vec3(0.10, 0.80, 0.40), smoothstep(0.30, 0.60, t));
  c = mix(c, vec3(0.95, 0.85, 0.20), smoothstep(0.55, 0.82, t));
  c = mix(c, vec3(1.00, 0.25, 0.10), smoothstep(0.78, 1.00, t));
  return c;
}

void main() {
  vec4 d = texture(uData, gl_FragCoord.xy / uResolution);
  vec3 c;
  if (uMode == 1) {
    c = clamp(d.rgb * uScale, 0.0, 1.0);
  } else if (uMode == 2) {
    float v = dot(d.rgb, vec3(0.2126, 0.7152, 0.0722)) * uScale;
    c = heat(pow(max(v, 0.0), 1.0 / max(uGamma, 0.05))) * uTint;
  } else {
    float v = uChannel == 0 ? d.r : (uChannel == 1 ? d.g : (uChannel == 2 ? d.b : d.a));
    v = pow(max(v * uScale, 0.0), 1.0 / max(uGamma, 0.05));
    c = clamp(vec3(v), 0.0, 1.0) * uTint;
  }
  fragColor = vec4(mix(vec3(uBackground), c, 1.0), 1.0);
}
`;

// ---------------------------------------------------------------------------
// OVERLAY
// ---------------------------------------------------------------------------

/**
 * Qualifier-matte / power-window / tracker-box overlay for the viewer.
 *
 * Drawn as an analytic fullscreen pass driven by uniform arrays rather than
 * from a vertex buffer: the overlay lives in normalised viewer space, has to
 * track a live drag, and the caller should not have to own a second VAO and
 * a buffer layout that this file and the viewer have to agree on forever.
 * Shapes resolve as signed distance fields, so soft edges, rounded corners
 * and rotation cost nothing extra.
 *
 * `uRect[i]`  cx, cy, halfW, halfH   (normalised, top-left origin)
 * `uStyle[i]` rotationDeg, cornerRadius, borderWidth, unused
 * `uColor[i]` rgb, alpha
 * `uKind[i]`  0 filled, 1 outline, 2 tracker box + crosshair, 3 soft matte
 */
export const OVERLAY_SHADER: string = `${V}precision highp float;
precision highp int;

#define MAX_ELEMENTS 16

uniform vec2  uResolution;
uniform int   uElementCount;
uniform vec4  uRect[MAX_ELEMENTS];
uniform vec4  uStyle[MAX_ELEMENTS];
uniform vec4  uColor[MAX_ELEMENTS];
uniform int   uKind[MAX_ELEMENTS];
uniform float uAlpha;
uniform float uSoftness;

out vec4 fragColor;

float boxSDF(vec2 p, vec2 c, vec2 h, float rot, float rad) {
  float a = radians(rot);
  vec2 d = p - c;
  d = vec2(d.x * cos(a) + d.y * sin(a), -d.x * sin(a) + d.y * cos(a));
  vec2 q = abs(d) - h + rad;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 p = gl_FragCoord.xy / uResolution;

  vec3 acc = vec3(0.0);
  float accA = 0.0;

  for (int i = 0; i < MAX_ELEMENTS; i++) {
    if (i >= uElementCount) break;
    vec4 col = uColor[i];
    if (col.a <= 0.0) continue;

    vec4 rect = uRect[i];
    vec4 style = uStyle[i];
    vec2 c = rect.xy;
    vec2 h = vec2(max(rect.z, 1e-4) * aspect, max(rect.w, 1e-4));
    float soft = max(uSoftness, 0.001) * min(h.x, h.y);
    float border = max(style.z, 0.0) * min(h.x, h.y);
    float sd = boxSDF(p, c, h, style.x, style.y * min(h.x, h.y));
    float inside = 1.0 - smoothstep(-soft, soft, sd);

    float m;
    if (uKind[i] == 1) {
      // outline: a band riding the inside of the edge
      m = 1.0 - smoothstep(0.0, max(border, soft), abs(sd + border * 0.5) - border * 0.5);
    } else if (uKind[i] == 2) {
      // tracker: bounds plus a centre crosshair, so the operator can see
      // the tracked box and the single tracked point at the same time
      float box = 1.0 - smoothstep(-soft, soft, sd - border * 0.5);
      float cross = 1.0 - smoothstep(0.0, border * 0.25 + soft,
                                      abs(p.x - c.x) / h.x * min(h.x, h.y));
      cross = max(cross, 1.0 - smoothstep(0.0, border * 0.25 + soft,
                                          abs(p.y - c.y) / h.y * min(h.x, h.y)));
      m = max(box, cross);
    } else {
      m = inside;
    }

    acc += col.rgb * m * col.a;
    accA = max(accA, m * col.a);
  }

  fragColor = vec4(acc, clamp(accA, 0.0, 1.0) * uAlpha);
}
`;

// ---------------------------------------------------------------------------
// Program table — the pipeline compiles these lazily, by name
// ---------------------------------------------------------------------------

export type ProgramName =
  | 'input'
  | 'grade'
  | 'output'
  | 'blit'
  | 'blend'
  | 'gaussian'
  | 'downscale'
  | 'scope'
  | 'overlay';

export interface ShaderProgram {
  readonly name: ProgramName;
  readonly vert: string;
  readonly frag: string;
}

export const PROGRAMS: Readonly<Record<ProgramName, ShaderProgram>> = {
  input: { name: 'input', vert: FULLSCREEN_VERT, frag: INPUT_SHADER },
  grade: { name: 'grade', vert: FULLSCREEN_VERT, frag: GRADE_SHADER },
  output: { name: 'output', vert: FULLSCREEN_VERT, frag: OUTPUT_SHADER },
  blit: { name: 'blit', vert: FULLSCREEN_VERT, frag: BLIT_SHADER },
  blend: { name: 'blend', vert: FULLSCREEN_VERT, frag: BLEND_SHADER },
  gaussian: { name: 'gaussian', vert: FULLSCREEN_VERT, frag: GAUSSIAN_SHADER },
  downscale: { name: 'downscale', vert: FULLSCREEN_VERT, frag: DOWNSCALE_SHADER },
  scope: { name: 'scope', vert: FULLSCREEN_VERT, frag: SCOPE_SHADER },
  overlay: { name: 'overlay', vert: FULLSCREEN_VERT, frag: OVERLAY_SHADER },
};

/** Number of rows in the curve LUT texture: 0/1/2 = r/g/b, 3 = master. */
export const CURVE_LUT_ROWS = 4;
/** Curve LUT width, in texels. */
export const CURVE_LUT_SIZE = 1024;
