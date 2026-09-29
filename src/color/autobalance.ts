/**
 * Auto balance, shared by the UI button and the agent command.
 *
 * This used to live only in the agent layer, which is why the UI's
 * auto_balance button could not reach it: two implementations, one of them
 * unreachable from the keyboard. The button and `auto_balance` now call the
 * same function, so they cannot disagree about what "auto" means.
 */

export type BalanceMethod = 'neutral' | 'white-balance';

export interface BalancePixels {
  data: Float32Array | Uint8ClampedArray;
  width: number;
  height: number;
}

type Container = Record<string, unknown>;

interface CpuGradeEngine {
  autoWhiteBalance?: (pixels: unknown, opts?: unknown) => unknown;
  autoLevels?: (pixels: unknown, opts?: unknown) => unknown;
}

let enginePromise: Promise<CpuGradeEngine | null> | null = null;

/** Load the CPU grade engine once. A real failure resolves to null rather than
 *  rejecting, so callers report "unavailable" instead of an opaque throw. */
export function loadGradeEngine(): Promise<CpuGradeEngine | null> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const published = (globalThis as { __hermesCpuGrade?: CpuGradeEngine }).__hermesCpuGrade;
      if (published) return published;
      try {
        return (await import('./cpugrade.js')) as unknown as CpuGradeEngine;
      } catch {
        return null;
      }
    })();
  }
  return enginePromise;
}

function isRGBArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.length >= 3 && v.every((n) => typeof n === 'number');
}

function toRGB(v: readonly number[]): number[] {
  return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
}

/**
 * The engine indexes pixels as RGB triples; a canvas readback is RGBA, so hand
 * it RGB. Feeding RGBA misaligns every channel after the first pixel, which
 * looks like a subtly wrong balance rather than an error.
 */
export function toEnginePixels(pixels: BalancePixels): Float32Array {
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

/**
 * Reduce whatever the engine returned to a grade patch.
 *
 * autoWhiteBalance has returned both a bare RGB triple and an object of
 * correction values across revisions, and the neutral branch returns an
 * object. Both are accepted; anything else is an error rather than a silently
 * ignored result, which is what a "no visible change" report usually is.
 */
export function normalizeBalance(raw: unknown): Container {
  if (isRGBArray(raw)) return { primary: { gain: toRGB(raw) } };
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`auto balance returned ${JSON.stringify(raw) ?? String(raw)}; expected an RGB triple or an object of correction values`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.primary === 'object' && obj.primary !== null) {
    return { primary: obj.primary as Container };
  }

  const primary: Container = {};
  for (const key of ['lift', 'gamma', 'gain', 'offset'] as const) {
    if (isRGBArray(obj[key])) primary[key] = toRGB(obj[key] as number[]);
  }
  if (Object.keys(primary).length === 0) {
    throw new Error(`auto balance returned ${JSON.stringify(raw)}; no lift/gamma/gain/offset in it`);
  }
  return { primary };
}

export interface BalanceResult {
  method: BalanceMethod;
  patch: Container;
  raw: unknown;
}

/** Run the engine. Throws with a readable message; callers decide how to report. */
export async function runAutoBalance(pixels: BalancePixels, method: BalanceMethod): Promise<BalanceResult> {
  const engine = await loadGradeEngine();
  if (!engine) throw new Error('the CPU grade engine is not available in this build, so auto balance cannot run');

  const fn = method === 'neutral' ? engine.autoLevels : (engine.autoWhiteBalance ?? engine.autoLevels);
  if (typeof fn !== 'function') {
    const wanted = method === 'neutral' ? 'autoLevels' : 'autoWhiteBalance';
    throw new Error(`the CPU grade engine exposes no ${wanted} function`);
  }
  const raw = fn.call(engine, toEnginePixels(pixels), { method, width: pixels.width, height: pixels.height });
  return { method, patch: normalizeBalance(raw), raw };
}
