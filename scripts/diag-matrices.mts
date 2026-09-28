/**
 * Diagnostic: which link in the sRGB <-> AP1 chain is wrong?
 * Run: node --experimental-strip-types scripts/diag-matrices.mts
 */
import {
  mat3Mul, mat3Vec, mat3Inverse, mat3ColumnMajor,
  SRGB_TO_XYZ_D65, XYZ_D65_TO_SRGB,
  AP1_TO_XYZ_D60, XYZ_D60_TO_AP1,
  D65_TO_D60, D60_TO_D65, bradfordAdapt, D65, D60,
} from '../src/core/colormath.ts';

const fmt = (m: Float64Array) => {
  const r: string[] = [];
  for (let i = 0; i < 3; i++) r.push(`[${m[i*3].toFixed(6)}, ${m[i*3+1].toFixed(6)}, ${m[i*3+2].toFixed(6)}]`);
  return r.join('\n         ');
};
const maxDiff = (a: Float64Array, b: Float64Array) =>
  Math.max(...Array.from(a).map((v, i) => Math.abs(v - b[i])));

console.log('=== 1. Is XYZ_D65_TO_SRGB the inverse of SRGB_TO_XYZ_D65? ===');
const inv709 = mat3Inverse(SRGB_TO_XYZ_D65)!;
console.log('inv(SRGB_TO_XYZ_D65):\n         ', fmt(inv709));
console.log('published XYZ_D65_TO_SRGB:\n         ', fmt(XYZ_D65_TO_SRGB));
console.log('maxDiff vs published:', maxDiff(inv709, XYZ_D65_TO_SRGB).toExponential(3));

console.log('\n=== 2. Is XYZ_D60_TO_AP1 the inverse of AP1_TO_XYZ_D60? ===');
const invAp1 = mat3Inverse(AP1_TO_XYZ_D60)!;
console.log('inv(AP1_TO_XYZ_D60):\n         ', fmt(invAp1));
console.log('published XYZ_D60_TO_AP1:\n         ', fmt(XYZ_D60_TO_AP1));
console.log('maxDiff vs published:', maxDiff(invAp1, XYZ_D60_TO_AP1).toExponential(3));

console.log('\n=== 3. Bradford round trip ===');
const fwd = bradfordAdapt(D65, D60);
const back = bradfordAdapt(D60, D65);
const rt = mat3Mul(back, fwd);
console.log('D60->D65 * D65->D60:\n         ', fmt(rt));
console.log('max deviation from identity:', maxDiff(rt, new Float64Array([1,0,0,0,1,0,0,0,1])).toExponential(3));

console.log('\n=== 4. Bradford applied to D65 white ===');
const wD65 = [0.3127 / 0.3290, 1, (1 - 0.3127 - 0.3290) / 0.3290];
console.log('D65 white XYZ:', wD65.map(v => v.toFixed(6)).join(', '));
console.log('-> D60       :', mat3Vec(fwd, wD65).map(v => v.toFixed(6)).join(', '));
const wD60 = [D60.x / D60.y, 1, (1 - D60.x - D60.y) / D60.y];
console.log('true D60 white XYZ:', wD60.map(v => v.toFixed(6)).join(', '));

console.log('\n=== 5. Full chain on pure white ===');
const chain = mat3Mul(mat3Mul(
  new Float64Array([3.2409699419, -1.5373831776, -0.4986107603, -0.9692436363, 1.8759675015, 0.0415550574, 0.0556300797, -0.2039769589, 1.0569715142]),
  D60_TO_D65), AP1_TO_XYZ_D60);
console.log('AP1->sRGB(white) =', mat3Vec(chain, [1,1,1]).map(v => v.toFixed(6)).join(', '));
console.log('=> neutral?', (() => { const v = mat3Vec(chain, [1,1,1]); return Math.abs(v[0]-v[1])<1e-6 && Math.abs(v[1]-v[2])<1e-6; })());

console.log('\n=== 6. Round trip through the published chain ===');
const toAp1 = mat3Mul(mat3Mul(
  new Float64Array([1.6048793531, -0.5310800757, -0.0738369503, -0.1025281259, 1.1081130458, -0.0055799502, -0.0032715150, -0.0728766601, 1.0761483301]),
  D65_TO_D60), SRGB_TO_XYZ_D65);
const rt2 = mat3Mul(chain, toAp1);
console.log('round trip matrix:\n         ', fmt(rt2));
console.log('max deviation from identity:', maxDiff(rt2, new Float64Array([1,0,0,0,1,0,0,0,1])).toExponential(3));
