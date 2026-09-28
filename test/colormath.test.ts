import { describe, it, expect } from 'vitest';
import {
  rec709ToGamma, gammaToRec709, gamma24ToLinear, linearToGamma24,
  logcEncode, logcDecode, LOGC_MIDDLE_GREY,
  mat3Mul, mat3Vec, mat3Inverse, bradfordAdapt,
  SRGB_LINEAR_TO_AP1, AP1_TO_SRGB_LINEAR, AP1_TO_REC2020, AP1_TO_P3D65,
  luma709, hueRotate, rgbToHsl, hslToRgb, tempTintGains,
  D65_TO_D60, D60_TO_D65, D65, D60,
  REC709_LUMA, AP1_LUMA, AP0_LUMA,
} from '../src/core/colormath.js';

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const IDENT = (m: Float64Array) => {
  for (let i = 0; i < 9; i++) expect(close(m[i], i % 4 === 0 ? 1 : 0, 1e-9)).toBe(true);
};

describe('transfer functions', () => {
  it('sRGB encode/decode is an exact round trip', () => {
    for (const v of [0, 0.001, 0.0031308, 0.5, 0.18, 1, 0.9]) {
      expect(close(gammaToRec709(rec709ToGamma(v)), v, 1e-9)).toBe(true);
    }
  });

  it('gamma 2.4 round trips', () => {
    for (const v of [0, 0.01, 0.18, 0.5, 1]) {
      expect(close(linearToGamma24(gamma24ToLinear(v)), v, 1e-9)).toBe(true);
    }
  });

  it('LogC round trips across the toe and the whole shoulder', () => {
    for (const v of [0, 0.0001, 0.010591, 0.05, 0.18, 0.5, 1, 4, 16, 55]) {
      expect(close(logcDecode(logcEncode(v)), v, 1e-7)).toBe(true);
    }
  });

  it('LogC puts 18% grey at 0.3867 (documented LogC value)', () => {
    expect(close(LOGC_MIDDLE_GREY, 0.3867, 1e-4)).toBe(true);
  });

  it('LogC is monotonic across the toe breakpoint', () => {
    // A non-monotonic transfer function shows up as banding or inverted shadows.
    const cut = 0.010591;
    expect(logcEncode(cut * 0.999) < logcEncode(cut)).toBe(true);
    expect(logcEncode(cut) < logcEncode(cut * 1.001)).toBe(true);
  });
});

describe('matrices', () => {
  it('multiplication and inversion are mutually consistent', () => {
    const inv = mat3Inverse(SRGB_LINEAR_TO_AP1)!;
    IDENT(mat3Mul(inv, SRGB_LINEAR_TO_AP1));
  });

  it('sRGB linear -> AP1 -> sRGB linear is identity (the null-case check)', () => {
    const samples: [number, number, number][] = [
      [1, 1, 1], [0, 0, 0], [0.5, 0.5, 0.5],
      [1, 0, 0], [0, 1, 0], [0, 0, 1],
      [0.2126, 0.7152, 0.0722],
      [0.9, 0.2, 0.05], [0.03, 0.06, 0.4],
    ];
    for (const s of samples) {
      const ap1 = mat3Vec(SRGB_LINEAR_TO_AP1, s);
      const back = mat3Vec(AP1_TO_SRGB_LINEAR, ap1);
      for (let i = 0; i < 3; i++) expect(close(back[i], s[i], 1e-9)).toBe(true);
    }
  });

  it('pure white stays neutral through every output path (no colour cast)', () => {
    for (const m of [AP1_TO_SRGB_LINEAR, AP1_TO_REC2020, AP1_TO_P3D65]) {
      const v = mat3Vec(m, [1, 1, 1]);
      expect(close(v[0], v[1], 1e-6)).toBe(true);
      expect(close(v[1], v[2], 1e-6)).toBe(true);
    }
  });

  it('Bradford adaptation is a true inverse pair', () => {
    IDENT(mat3Mul(D60_TO_D65, D65_TO_D60));
  });

  it('adapting sRGB white to AP1 gives R=G=B (no cast on neutral input)', () => {
    // Trap #2: a naive chain tints every grey. Assert neutral survives.
    const w = mat3Vec(SRGB_LINEAR_TO_AP1, [1, 1, 1]);
    expect(close(w[0], w[1], 1e-6)).toBe(true);
    expect(close(w[1], w[2], 1e-6)).toBe(true);
  });

  it('Bradford derives z from 1-x-y, so D65 and D60 differ but stay neutral', () => {
    const a = bradfordAdapt(D65, D60);
    const w = mat3Vec(a, [0.9504559, 1.0, 1.0890578]);
    // D60 white expressed in D65 XYZ should land on the D60 white locus.
    expect(close(w[0] / w[1], D60.x / D60.y, 1e-4)).toBe(true);
  });

  it('AP1 red primary is outside Rec.709 gamut but only by a sane amount', () => {
    const r = mat3Vec(AP1_TO_SRGB_LINEAR, [1, 0, 0]);
    expect(r[0]).toBeGreaterThan(1);
    // A correct matrix keeps the other channels small; a broken one explodes.
    expect(Math.abs(r[1])).toBeLessThan(0.2);
    expect(Math.abs(r[2])).toBeLessThan(0.6);
  });
});

describe('luma', () => {
  it('every luma weight set sums to 1', () => {
    for (const w of [REC709_LUMA, AP1_LUMA, AP0_LUMA]) {
      expect(close(w[0] + w[1] + w[2], 1, 1e-6)).toBe(true);
    }
  });

  it('AP1 luma is NOT the Rec.709 weights (wider gamut needs its own)', () => {
    // If these were equal, the AP1 scope would be systematically wrong on blue.
    expect(close(AP1_LUMA[1], REC709_LUMA[1], 1e-3)).toBe(false);
  });
});

describe('hue and saturation', () => {
  it('hue rotation by 0 is exact identity', () => {
    const v = hueRotate(0.3, 0.6, 0.2, 0);
    expect(close(v[0], 0.3, 1e-12)).toBe(true);
    expect(close(v[1], 0.6, 1e-12)).toBe(true);
    expect(close(v[2], 0.2, 1e-12)).toBe(true);
  });

  it('hue rotation preserves Rec.709 luma', () => {
    for (const deg of [15, 45, 90, 180]) {
      const v = hueRotate(0.4, 0.25, 0.1, deg);
      expect(close(luma709(v[0], v[1], v[2]), luma709(0.4, 0.25, 0.1), 1e-9)).toBe(true);
    }
  });

  it('HSL round trips', () => {
    for (const c of [[0.3, 0.6, 0.2], [1, 0, 0], [0.5, 0.5, 0.5]] as const) {
      const [h, s, l] = rgbToHsl(c[0], c[1], c[2]);
      const b = hslToRgb(h, s, l);
      for (let i = 0; i < 3; i++) expect(close(b[i], c[i], 1e-9)).toBe(true);
    }
  });

  it('temperature sign is warm-positive, matching the UI label', () => {
    const warm = tempTintGains(50, 0);
    expect(warm[0]).toBeGreaterThan(1);
    expect(warm[2]).toBeLessThan(1);
    const cool = tempTintGains(-50, 0);
    expect(cool[0]).toBeLessThan(1);
    expect(cool[2]).toBeGreaterThan(1);
  });

  it('neutral temp/tint is exact gain identity', () => {
    const g = tempTintGains(0, 0);
    expect(g[0]).toBe(1); expect(g[1]).toBe(1); expect(g[2]).toBe(1);
  });
});
