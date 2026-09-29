import type {
  GradeState, PrimaryState, CurvesState, QualifierState,
  WindowState, KeyState, EffectsState, RGB, Node, Graph,
  Project, Timeline,
} from './types.js';

/** Identity grade. Every value here is a mathematical no-op. */
export const neutralRGB: RGB = [0, 0, 0];

export function defaultPrimary(): PrimaryState {
  return {
    lift: [0, 0, 0],
    gamma: [1, 1, 1],
    gain: [1, 1, 1],
    offset: [0, 0, 0],
    contrast: 1,
    pivot: 0.435,
    brightness: 0,
    exposure: 0,
    saturation: 1,
    hue: 0,
    colourBoost: 0,
    contrastLow: 0,
    contrastHigh: 0,
    shadowBias: 0,
    highlightBias: 0,
    temperature: 0,
    tint: 0,
    vibrance: 0,
  };
}

export function defaultCurves(): CurvesState {
  // Two endpoints only = straight line = identity.
  return {
    master: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    red: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    green: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    blue: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    mode: 'custom',
  };
}

export function defaultQualifier(): QualifierState {
  return {
    enabled: false,
    hue: 0.35,
    hueWidth: 0.12,
    hueSoft: 0.05,
    satLow: 0.15,
    satHigh: 1,
    lumLow: 0,
    lumHigh: 1,
    balance: 0,
    view: 'no-key',
    desaturateOutside: 0,
    denoise: 0,
    matteBlur: 0,
    invert: false,
    windowRestrict: false,
  };
}

export function defaultWindow(): WindowState {
  return {
    enabled: false,
    shape: 'ellipse',
    cx: 0.5,
    cy: 0.5,
    w: 0.4,
    h: 0.4,
    angle: 0,
    softness: 0.1,
    feather: 0.05,
    invert: false,
    mix: 1,
  };
}

export function defaultKey(): KeyState {
  return {
    enabled: false,
    keyColor: [0, 1, 0],
    tolerance: 0.3,
    softness: 0.1,
    spill: 0.5,
    edge: 0.1,
    shrinkGrow: 0,
    fillMode: 'over',
    fillColor: [0, 0, 0],
  };
}

export function defaultEffects(): EffectsState {
  return {
    blur: 0,
    sharpen: 0,
    sharpenRadius: 1,
    glow: 0,
    glowThreshold: 0.8,
    vignette: 0,
    vignetteSoft: 0.5,
    grain: 0,
    lut: null,
    lutIntensity: 1,
    cdl: { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 },
    filmContrast: 0,
  };
}

export function defaultGrade(): GradeState {
  return {
    primary: defaultPrimary(),
    curves: defaultCurves(),
    qualifier: defaultQualifier(),
    window: defaultWindow(),
    key: defaultKey(),
    effects: defaultEffects(),
    inputGamma: 1,
    outputGamma: 1,
    keyframes: {},
  };
}

let nodeSeq = 0;
export function newNodeId(prefix = 'node'): string {
  nodeSeq += 1;
  return `${prefix}-${nodeSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createNode(partial: Partial<Node> = {}): Node {
  return {
    id: partial.id ?? newNodeId(),
    label: partial.label ?? 'Untitled',
    kind: partial.kind ?? 'corrector',
    index: partial.index ?? 1,
    grade: partial.grade ?? defaultGrade(),
    enabled: partial.enabled ?? true,
    inputs: partial.inputs ?? [null, null],
    pos: partial.pos,
    bypass: partial.bypass ?? false,
    cmOverride: partial.cmOverride ?? false,
  };
}

/** A fresh colour graph: one serial node 01 wired to the output. */
export function defaultGraph(): Graph {
  const n1 = createNode({ label: '01', index: 1, kind: 'serial' });
  return { nodes: [n1], edges: [], outputNodeId: n1.id, layout: 'horizontal' };
}

export function cloneGrade(g: GradeState): GradeState {
  return structuredClone(g);
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

/** Resolve's default: an AP1 timeline at 24 fps, Rec.709 output. */
export function defaultTimeline(): Timeline {
  return {
    fps: 24,
    durationFrames: 24 * 60 * 10,
    startFrame: 0,
    tracks: [
      { id: 'v2', kind: 'video', index: 2, name: 'V2', locked: false, muted: false, height: 64 },
      { id: 'v1', kind: 'video', index: 1, name: 'V1', locked: false, muted: false, height: 64 },
      { id: 'a1', kind: 'audio', index: 1, name: 'A1', locked: false, muted: false, height: 48 },
      { id: 'a2', kind: 'audio', index: 2, name: 'A2', locked: false, muted: false, height: 48 },
    ],
    clips: [],
    playhead: 0,
    inPoint: 0,
    outPoint: 24 * 60 * 10,
    selection: [],
  };
}

export function defaultProject(name = 'Untitled Project'): Project {
  return {
    id: newNodeId('proj'),
    settings: {
      name,
      workingSpace: 'timeline-linear',
      outputSpace: 'Rec.709',
      outputGamma: 1,
      timelineGraph: defaultGraph(),
      clipGraphs: {},
      autoSave: true,
    },
    mediaPool: [],
    timeline: defaultTimeline(),
    page: 'media',
    bins: [
      { id: 'bin-master', name: 'Master', parent: null, clipIds: [] },
    ],
    version: 0,
  };
}
