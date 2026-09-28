/**
 * Derive RGB->XYZ matrices from chromaticity primaries instead of trusting
 * recalled constants. Run: node --experimental-strip-types scripts/derive-ap1.mts
 */

type M3 = number[]; // row-major 9

const inv3 = (m: M3): M3 => {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const id = 1 / det;
  return [
    A * id, (c * h - b * i) * id, (b * f - c * e) * id,
    B * id, (a * i - c * g) * id, (c * d - a * f) * id,
    C * id, (b * g - a * h) * id, (a * e - b * d) * id,
  ];
};
const mul = (a: M3, b: M3): M3 => {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
    for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
};
const ap = (m: M3, v: number[]) => [
  m[0]*v[0]+m[1]*v[1]+m[2]*v[2],
  m[3]*v[0]+m[4]*v[1]+m[5]*v[2],
  m[6]*v[0]+m[7]*v[1]+m[8]*v[2],
];
const fmt = (m: M3) => {
  const r: string[] = [];
  for (let i = 0; i < 3; i++)
    r.push(`  [${m[i*3].toFixed(10)}, ${m[i*3+1].toFixed(10)}, ${m[i*3+2].toFixed(10)}],`);
  return r.join('\n');
};

/** Standard RGB->XYZ from xy primaries + xy white (SMPTE RP 177). */
function rgbToXyz(primaries: {r:[number,number], g:[number,number], b:[number,number]}, w: {x:number,y:number}): M3 {
  const P = (p: [number, number]) => {
    const [x, y] = p;
    return [x / y, 1, (1 - x - y) / y];
  };
  // Primaries go in COLUMNS: col0=red, col1=green, col2=blue.
  const [xr, yr, zr] = P(primaries.r);
  const [xg, yg, zg] = P(primaries.g);
  const [xb, yb, zb] = P(primaries.b);
  const M: M3 = [
    xr, xg, xb,
    yr, yg, yb,
    zr, zg, zb,
  ];
  const W = [w.x / w.y, 1, (1 - w.x - w.y) / w.y];
  // W = M * S  where S = diag(Sr, Sg, Sb)  =>  S = M^-1 * W
  // M's columns are the unscaled primaries, so scaling a COLUMN means
  // multiplying by S[c] — result = M * diag(S), not diag(S) * M.
  const S = ap(inv3(M), W);
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r * 3 + c] = M[r * 3 + c] * S[c];
  }
  return out;
}

const D60 = { x: 0.32168, y: 0.33767 };
const D65 = { x: 0.3127, y: 0.3290 };

// ACES AP0 and AP1 primaries.
const AP0 = { r: [0.7347, 0.2653], g: [0.0, 1.0], b: [0.0001, -0.077] };
const AP1 = { r: [0.713, 0.293],   g: [0.165, 0.830], b: [0.128, 0.044] };

for (const [name, p, w] of [['AP0', AP0, D60], ['AP1', AP1, D60]] as const) {
  const m = rgbToXyz(p as any, w);
  const whiteOut = ap(m, [1, 1, 1]);
  const trueWhite = [w.x / w.y, 1, (1 - w.x - w.y) / w.y];
  console.log(`\n=== ${name} -> XYZ (D60) ===`);
  console.log(fmt(m));
  console.log(`  white check: got [${whiteOut.map(v=>v.toFixed(6))}] want [${trueWhite.map(v=>v.toFixed(6))}]`);
  const yRow = m.slice(3, 6);
  console.log(`  luma weights (Y row): [${yRow.map(v=>v.toFixed(7))}] sum=${yRow.reduce((a,b)=>a+b,0).toFixed(9)}`);
}

// Cross-check against the published Rec.709 matrix, which I can verify is right.
const srgb = rgbToXyz({ r: [0.64, 0.33], g: [0.30, 0.60], b: [0.15, 0.06] }, D65);
console.log('\n=== sRGB -> XYZ (D65), derived ===');
console.log(fmt(srgb));
console.log('  published: [0.4123907993, 0.3575843394, 0.1804807884, 0.2126390059, 0.7151686788, 0.0721923154, 0.0193308187, 0.1191947798, 0.9505321522]');
