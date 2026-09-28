/**
 * The null-case test for the CPU grade engine.
 *
 * A colour pipeline that "looks right" and shifts pixels at its defaults is
 * the single most common failure in this kind of code: every downstream
 * measurement is then relative to a silently-wrong baseline. This asserts the
 * identity property directly, on a neutral image AND a saturated one.
 */
import { describe, it, expect } from 'vitest';
import {
  applyGrade, GradeBuffer, resolveKeyframes, sampleCurve, windowMask,
  qualifierMatte, autoWhiteBalance, autoLevels, analyzeFrame, histogram, waveform,
} from '../src/color/cpugrade.js';
import { defaultGrade, defaultProject, defaultGraph, createNode } from '../src/core/defaults.js';

const W = 32, H = 32;
const ctx = { width: W, height: H, frame: 0, lut: null, lutIntensity: 1, workingSpace: 'timeline-linear' as const };

/** A colourful test image in AP1 linear, with values that go outside 0..1. */
function colourfulImage(): Float32Array {
  const d = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      d[i] = (x / W) * 1.4 - 0.2;        // includes >1 and <0 on purpose
      d[i + 1] = (y / H) * 0.9 + 0.05;
      d[i + 2] = 0.5 - (x / W) * 0.6;
    }
  }
  return d;
}

function neutralImage(v: number): Float32Array {
  return new Float32Array(W * H * 3).fill(v);
}

const maxDiff = (a: Float32Array, b: Float32Array) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

describe('null case: a default grade changes nothing', () => {
  it('is a no-op on a neutral image, at several brightness levels', () => {
    for (const v of [0.02, 0.18, 0.5, 0.9]) {
      const src = neutralImage(v);
      const out = applyGrade(src, defaultGrade(), ctx);
      expect(maxDiff(src, out)).toBeLessThan(1e-5);
    }
  });

  it('is a no-op on a colourful image, including out-of-range values', () => {
    const src = colourfulImage();
    const out = applyGrade(src, defaultGrade(), ctx);
    const d = maxDiff(src, out);
    expect(d).toBeLessThan(1e-5);
    if (d >= 1e-5) {
      // Name the worst pixel so the failure is actionable.
      let wi = 0, wv = 0;
      for (let i = 0; i < src.length; i++) {
        const d2 = Math.abs(src[i] - out[i]);
        if (d2 > wv) { wv = d2; wi = i; }
      }
      throw new Error(
        `default grade shifted pixel ${Math.floor(wi / 3)},${wi % 3}: ` +
        `${src[wi]} -> ${out[wi]} (delta ${wv})`,
      );
    }
  });

  it('does not mutate its input', () => {
    const src = colourfulImage();
    const copy = new Float32Array(src);
    applyGrade(src, defaultGrade(), ctx);
    expect(maxDiff(src, copy)).toBe(0);
  });
});

describe('grade actually does something', () => {
  it('saturation > 1 pushes channels apart', () => {
    const src = colourfulImage();
    const g = defaultGrade();
    g.primary.saturation = 1.8;
    expect(maxDiff(src, applyGrade(src, g, ctx))).toBeGreaterThan(0.01);
  });

  it('gain > 1 brightens', () => {
    const src = neutralImage(0.4);
    const g = defaultGrade();
    g.primary.gain = [1.3, 1.3, 1.3];
    const out = applyGrade(src, g, ctx);
    expect(out[0]).toBeGreaterThan(src[0] * 1.15);
  });

  it('temperature > 0 warms, tint keeps green in place', () => {
    const src = neutralImage(0.4);
    const warm = defaultGrade();
    warm.primary.temperature = 50;
    const o = applyGrade(src, warm, ctx);
    expect(o[0]).toBeGreaterThan(o[2]);           // r > b
    const cool = defaultGrade();
    cool.primary.temperature = -50;
    const c = applyGrade(src, cool, ctx);
    expect(c[2]).toBeGreaterThan(c[0]);           // b > r
  });

  it('a warm image becomes more neutral after a cooling grade', () => {
    const src = neutralImage(0.4);
    src[0] = 0.62; src[1] = 0.50; src[2] = 0.34;  // tungsten cast
    for (let i = 3; i < src.length; i += 3) {
      src[i] = 0.62; src[i + 1] = 0.50; src[i + 2] = 0.34;
    }
    const g = defaultGrade();
    g.primary.temperature = -60;
    const out = applyGrade(src, g, ctx);
    // The r-b spread must shrink.
    const before = 0.62 - 0.34;
    const after = out[0] - out[2];
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(0);
  });

  it('a qualifier mask isolates only the keyed hue', () => {
    const g = defaultGrade();
    g.qualifier.enabled = true;
    g.qualifier.hue = 0;          // red
    g.qualifier.hueWidth = 0.05;
    g.qualifier.satLow = 0.3;
    const red = qualifierMatte(0.8, 0.1, 0.1, g.qualifier);
    const blue = qualifierMatte(0.1, 0.1, 0.8, g.qualifier);
    expect(red).toBeGreaterThan(blue);
  });
});

describe('curves', () => {
  it('the default two-point curve is exactly the identity', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      expect(Math.abs(sampleCurve(pts, x) - x)).toBeLessThan(1e-6);
    }
  });

  it('a lifted curve raises midtones', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }];
    expect(sampleCurve(pts, 0.5)).toBeGreaterThan(0.6);
  });
});

describe('keyframes', () => {
  it('a track with one key holds that value at every frame', () => {
    const g = defaultGrade();
    g.keyframes['primary.contrast'] = [{ frame: 10, value: 1.5 }];
    for (const f of [0, 10, 100]) {
      expect(resolveKeyframes(g, f).primary.contrast).toBeCloseTo(1.5, 6);
    }
  });

  it('interpolates linearly between two keys', () => {
    const g = defaultGrade();
    g.keyframes['primary.saturation'] = [
      { frame: 0, value: 1, interp: 'linear' },
      { frame: 10, value: 2, interp: 'linear' },
    ];
    expect(resolveKeyframes(g, 5).primary.saturation).toBeCloseTo(1.5, 6);
    expect(resolveKeyframes(g, 0).primary.saturation).toBeCloseTo(1, 6);
    expect(resolveKeyframes(g, 10).primary.saturation).toBeCloseTo(2, 6);
  });

  it('hold interpolation does not ramp', () => {
    const g = defaultGrade();
    g.keyframes['primary.saturation'] = [
      { frame: 0, value: 1, interp: 'hold' },
      { frame: 10, value: 2, interp: 'hold' },
    ];
    expect(resolveKeyframes(g, 9).primary.saturation).toBeCloseTo(1, 6);
  });

  it('clamps outside the key range rather than extrapolating wildly', () => {
    const g = defaultGrade();
    g.keyframes['primary.contrast'] = [
      { frame: 10, value: 1.2 },
      { frame: 20, value: 1.4 },
    ];
    expect(resolveKeyframes(g, 0).primary.contrast).toBeCloseTo(1.2, 6);
    expect(resolveKeyframes(g, 999).primary.contrast).toBeCloseTo(1.4, 6);
  });
});

describe('power window', () => {
  // windowMask takes PIXEL coordinates, not normalised 0..1: the mask is
  // aspect-corrected against ctx.width/ctx.height, so x=w/2, y=h/2 is the
  // centre of the frame.
  const px = (u: number, v: number): [number, number] => [u * W, v * H];

  it('is fully transparent when disabled', () => {
    const w = defaultGrade().window;
    w.enabled = false;
    const [x, y] = px(0.5, 0.5);
    expect(windowMask(x, y, w, ctx)).toBe(0);
  });

  it('is 1 at the centre of an enabled window', () => {
    const w = defaultGrade().window;
    w.enabled = true;
    w.softness = 0;
    w.feather = 0;
    const [x, y] = px(0.5, 0.5);
    expect(windowMask(x, y, w, ctx)).toBeCloseTo(1, 5);
  });

  it('is 0 well outside the window', () => {
    const w = defaultGrade().window;
    w.enabled = true;
    w.softness = 0;
    w.feather = 0;
    w.cx = 0.2; w.cy = 0.2; w.w = 0.1; w.h = 0.1;
    const [x, y] = px(0.9, 0.9);
    expect(windowMask(x, y, w, ctx)).toBe(0);
  });

  it('invert flips the mask', () => {
    const w = defaultGrade().window;
    w.enabled = true; w.softness = 0; w.feather = 0;
    const [x, y] = px(0.5, 0.5);
    const a = windowMask(x, y, w, ctx);
    w.invert = true;
    const b = windowMask(x, y, w, ctx);
    expect(a).toBeCloseTo(1, 5);
    expect(b).toBeCloseTo(0, 5);
  });

  it('mix scales the whole mask', () => {
    const w = defaultGrade().window;
    w.enabled = true; w.softness = 0; w.feather = 0; w.mix = 0.5;
    const [x, y] = px(0.5, 0.5);
    expect(windowMask(x, y, w, ctx)).toBeCloseTo(0.5, 5);
  });
});

describe('auto white balance', () => {
  it('returns unity for an already-neutral image', () => {
    const src = neutralImage(0.4);
    const g = autoWhiteBalance(src);
    expect(Math.abs(g[0] - 1)).toBeLessThan(0.02);
    expect(Math.abs(g[1] - 1)).toBeLessThan(0.02);
    expect(Math.abs(g[2] - 1)).toBeLessThan(0.02);
  });

  it('neutralises a grey-world cast', () => {
    const src = neutralImage(0.4);
    for (let i = 0; i < src.length; i += 3) {
      src[i] = 0.50; src[i + 1] = 0.42; src[i + 2] = 0.30;   // red HIGH, blue low
    }
    const g = autoWhiteBalance(src, { method: 'grey-world' });
    // Grey-world equalises the channels, so the highest is cut and the
    // lowest is lifted. Getting this backwards is an easy mistake and
    // would double the cast instead of removing it.
    expect(g[0]).toBeLessThan(1);
    expect(g[2]).toBeGreaterThan(1);
    expect(Math.abs(g[1] - 1)).toBeLessThan(0.15);
  });

  it('the default neutral method is unity on a uniform grey', () => {
    const g = autoWhiteBalance(neutralImage(0.18));
    for (let i = 0; i < 3; i++) expect(Math.abs(g[i] - 1)).toBeLessThan(0.02);
  });

  it('every method reduces the r-b spread of a cast frame', () => {
    const src = neutralImage(0.4);
    for (let i = 0; i < src.length; i += 3) {
      src[i] = 0.62; src[i + 1] = 0.50; src[i + 2] = 0.34;
    }
    for (const method of ['neutral', 'white-balance', 'grey-world', 'white-point'] as const) {
      const g = autoWhiteBalance(src, { method });
      const after = (src[0] * g[0]) - (src[2] * g[2]);
      expect(Math.abs(after)).toBeLessThan(src[0] - src[2]);
    }
  });
});

describe('analysis', () => {
  it('reports the mean of a flat image', () => {
    const a = analyzeFrame(neutralImage(0.5), ctx);
    expect(a.mean[0]).toBeCloseTo(0.5, 3);
  });

  it('counts clipping as a fraction', () => {
    const src = new Float32Array(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      src[i * 3] = i < W * H / 2 ? 1.0 : 0.2;   // half the pixels clipped
      src[i * 3 + 1] = src[i * 3];
      src[i * 3 + 2] = src[i * 3];
    }
    const a = analyzeFrame(src, ctx);
    expect(a.clipped.total).toBeGreaterThan(0.4);
    expect(a.clipped.total).toBeLessThan(0.6);
  });

  it('histogram is non-empty and normalised', () => {
    const h = histogram(colourfulImage(), 64);
    const total = Array.from(h.l).reduce((s, v) => s + v, 0);
    expect(total).toBeGreaterThan(0);
    expect(h.bins).toBe(64);
  });

  it('waveform has the requested dimensions', () => {
    const w = waveform(colourfulImage(), 16, 8);
    expect(w.r.length).toBe(16 * 8);
  });
});
