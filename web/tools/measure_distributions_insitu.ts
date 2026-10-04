/**
 * Measurement behind the L10 **in-situ literal-width** fix (kanban t_bb4630da).
 *
 * `Patch::setPoint`'s four distribution parameters are native `float` literals
 * (`environment/Patch.cc:78-81`): `sigma = .3f`, `mu = .5f`, `slope = -0.4f`,
 * `yIntercept = .4f`. `normalPDF`'s first instruction is `fcvt d1, s1` (`0xfb78`) — it widens
 * its **float** parameter — and `linearPDF`'s else arm is the fused `fmadd s1, s1, s0, s2`
 * (`0xfbdc`) over **binary32** operands, so a port that transcribes those literals as JS doubles
 * hands both functions values the oracle cannot have. This script measures that against the
 * library's own answers for the operands the call site really passes, over the two in-situ
 * corpora (`native/raw/dump_normalpdf_insitu.cc`, `native/raw/dump_linearpdf_insitu.cc`), and
 * then measures what the difference is worth *in situ* (the rejection samplers' draw counts).
 *
 * Run: npx tsx tools/measure_distributions_insitu.ts
 *
 * Columns are always "vs the shipped function": `pre-fix` is the literal arithmetic as the port
 * spelled it before this card (`sigma`/`mu`/`slope`/`yIntercept` as JS doubles), `current` is the
 * imported function called the same way (with the doubles a sloppy call site would still pass).
 * The fix expects 0 in every `current` column and the pre-fix counts to stay where this script
 * put them, so a re-widened literal reads as a regression rather than as a cleanup.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { f32Fma } from '../src/model/agent/numeric';
import { getLinear, getNormal, linearPDF, normalPDF } from '../src/model/environment/distributions';
import { f32, f32Bits } from '../src/model/geometry';
import { powf } from '../src/model/rng';

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, '..', 'src', 'model', 'environment', 'native', 'raw');

const hex = (b: number) => `0x${(b >>> 0).toString(16).padStart(8, '0')}`;
const bits = (v: number) => f32Bits(v) >>> 0;
const fromHex = (h: string) => {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, parseInt(h.slice(2), 16), false);
  return dv.getFloat32(0, false);
};

const readRows = (file: string, width: number): number[][] =>
  readFileSync(join(corpusDir, file), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const f = line.split('\t').map(fromHex);
      if (f.length !== width) throw new Error(`bad ${file} row: ${line}`);
      return f;
    });

const pct = (k: number, n: number) => `${k} / ${n} (${((100 * k) / n).toFixed(1)} %)`;

// ---------------------------------------------------------------------------
// The call site's literals, as doubles (what the port passed) and as floats (what it passes now).
// ---------------------------------------------------------------------------

const SIGMA_D = 0.3;
const MU_D = 0.5;
const SLOPE_D = -0.4;
const YI_D = 0.4;
const SIGMA = f32(0.3);
const MU = f32(0.5);
const SLOPE = f32(-0.4);
const YI = f32(0.4);

const PI = f32(3.1415927);
const E = f32(2.7182818);

/** The port's arithmetic as it was *before* this card: the same expressions, doubles in. */
function preFixNormalPDF(x: number, sigma: number, mu: number) {
  const left = f32(1.0 / Math.sqrt(f32(2 * PI) * (sigma * sigma)));
  const rightTop = f32(-f32(Math.pow(f32(x - mu), 2)));
  const rightBottom = f32(2 * (sigma * sigma));
  const right = powf(E, f32(rightTop / rightBottom));
  return { left, rightTop, rightBottom, right, pdf: f32(left * right) };
}

/** The pre-fix else arm: `f32Fma` fed the *double* literals, i.e. `f32(-0.4 * x + 0.4)`. */
const preFixLinearPDF = (x: number) => (x <= 0.5 ? f32(-SLOPE_D * x) : f32Fma(SLOPE_D, x, YI_D));

/** The pre-fix `getNormal`/`getLinear`: native's structure, the pre-fix PDF. */
function preFixGetNormal(sigma: number, mu: number, randpw: () => number): number {
  for (;;) {
    const x = f32(randpw());
    const y = preFixNormalPDF(x, sigma, mu).pdf;
    const z = f32(randpw());
    if (z < y && z >= 0 && z <= 1) return x;
  }
}
function preFixGetLinear(slope: number, yIntercept: number, randpw: () => number): number {
  for (;;) {
    const x = f32(randpw());
    const y = preFixLinearPDF(x);
    const z = f32(randpw());
    if (z < y && z >= 0 && z <= 1) return x;
  }
}

/** A deterministic `drand48`-shaped stream: the 48-bit LCG, in [0,1). */
function lcgStream(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return ((s >>> 0) % 0x100000000) / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// normalPDF, in situ: sigma = 0.3f, mu = 0.5f (the call site's own literals)
// ---------------------------------------------------------------------------

const NP_IN_SITU = readRows('normalpdf_insitu.tsv', 8);

let npSelfCheck = 0;
for (const [, , , left, , , right, pdf] of NP_IN_SITU) {
  if (bits(f32(left! * right!)) !== bits(pdf!)) npSelfCheck++;
}

const npPre = { left: 0, rightTop: 0, rightBottom: 0, right: 0, pdf: 0 };
const npNow = { left: 0, rightTop: 0, rightBottom: 0, right: 0, pdf: 0 };
for (const [x, , , left, rightTop, rightBottom, right, pdf] of NP_IN_SITU) {
  const b = preFixNormalPDF(x!, SIGMA_D, MU_D);
  if (bits(b.left) !== bits(left!)) npPre.left++;
  if (bits(b.rightTop) !== bits(rightTop!)) npPre.rightTop++;
  if (bits(b.rightBottom) !== bits(rightBottom!)) npPre.rightBottom++;
  if (bits(b.right) !== bits(right!)) npPre.right++;
  if (bits(b.pdf) !== bits(pdf!)) npPre.pdf++;

  // The in-situ call, through the public entry, with the literals a sloppy call site passes:
  // `normalPDF(x, 0.3, 0.5)` — the entry narrowing is what makes this the oracle's answer.
  const port = normalPDF(x!, SIGMA_D, MU_D);
  if (bits(port) !== bits(pdf!)) npNow.pdf++;
  const bF = preFixNormalPDF(x!, SIGMA, MU);
  if (bits(bF.left) !== bits(left!)) npNow.left++;
  if (bits(bF.rightBottom) !== bits(rightBottom!)) npNow.rightBottom++;
}

// ---------------------------------------------------------------------------
// linearPDF, in situ: slope = -0.4f, yIntercept = 0.4f
// ---------------------------------------------------------------------------

const LP_IN_SITU = readRows('linearpdf_insitu.tsv', 4);

let lpSelfCheck = 0;
for (const [x, lo, hi, pdf] of LP_IN_SITU) {
  if (bits(x! <= 0.5 ? lo! : hi!) !== bits(pdf!)) lpSelfCheck++;
}

const elseRows = LP_IN_SITU.filter((r) => r[0]! > 0.5).length;
let lpPreAll = 0;
let lpPreElse = 0;
let lpNow = 0;
for (const [x, , , pdf] of LP_IN_SITU) {
  const pre = preFixLinearPDF(x!);
  if (bits(pre) !== bits(pdf!)) lpPreAll++;
  if (x! > 0.5 && bits(pre) !== bits(pdf!)) lpPreElse++;
  if (bits(linearPDF(x!, SLOPE_D, YI_D)) !== bits(pdf!)) lpNow++;
}

// ---------------------------------------------------------------------------
// In situ: what the difference is worth to the samplers themselves.
// ---------------------------------------------------------------------------

const N = 20000;
function samplerDelta(
  pre: (rng: () => number) => number,
  now: (rng: () => number) => number,
): { samples: number; firstDraws: number; secondDraws: number } {
  let samples = 0;
  let firstDraws = 0;
  let secondDraws = 0;
  const a = lcgStream(20260928);
  const b = lcgStream(20260928);
  for (let i = 0; i < N; i++) {
    let da = 0;
    let db = 0;
    const ra = () => {
      da++;
      return a();
    };
    const rb = () => {
      db++;
      return b();
    };
    const va = pre(ra);
    const vb = now(rb);
    if (bits(va) !== bits(vb)) samples++;
    if (da !== db) firstDraws++;
    secondDraws += da;
    void secondDraws;
  }
  return { samples, firstDraws, secondDraws };
}

const gauss = samplerDelta(
  (rng) => preFixGetNormal(SIGMA_D, MU_D, rng),
  (rng) => getNormal(SIGMA, MU, rng),
);
const linear = samplerDelta(
  (rng) => preFixGetLinear(SLOPE_D, YI_D, rng),
  (rng) => getLinear(SLOPE, YI, rng),
);

// ---------------------------------------------------------------------------

console.log('=== normalPDF, in situ (sigma = 0.3f, mu = 0.5f, x = i/10000, 10 000 rows) ===');
console.log(`corpus self-check (pdf == f32(left * right) on the oracle's own values): ${npSelfCheck} mismatches`);
console.log('');
console.log('                     pre-fix (doubles) vs oracle   current in-situ call vs oracle');
for (const k of ['left', 'rightTop', 'rightBottom', 'right', 'pdf'] as const) {
  console.log(`${k.padEnd(14)} ${pct(npPre[k], NP_IN_SITU.length).padEnd(30)} ${pct(npNow[k], NP_IN_SITU.length)}`);
}
console.log('(`left`/`rightBottom` depend on `sigma` alone — their count is the row count, or 0)');

console.log('');
console.log('=== linearPDF, in situ (slope = -0.4f, yIntercept = 0.4f, x = i/40000, 40 001 rows) ===');
console.log(`corpus self-check (pdf == (x <= 0.5 ? lo : hi) on the oracle's own values): ${lpSelfCheck} mismatches`);
console.log(`pre-fix (double literals) vs oracle, whole function: ${pct(lpPreAll, LP_IN_SITU.length)}`);
console.log(`pre-fix (double literals) vs oracle, else arm only: ${pct(lpPreElse, elseRows)}`);
console.log(`current in-situ call vs oracle:                     ${pct(lpNow, LP_IN_SITU.length)}`);

console.log('');
console.log(`=== in situ: the samplers, ${N} draws on one deterministic stream ===`);
console.log(`getNormal: ${gauss.samples} differing samples, ${gauss.firstDraws} differing draw counts`);
console.log(`getLinear: ${linear.samples} differing samples, ${linear.firstDraws} differing draw counts`);

console.log('');
console.log(`examples: left oracle=${hex(bits(NP_IN_SITU[0]![3]!))} pre-fix=${hex(bits(preFixNormalPDF(NP_IN_SITU[0]![0]!, SIGMA_D, MU_D).left))} ` +
  `(x=${hex(bits(NP_IN_SITU[0]![0]!))}, x-independent)`);
const lpEx = LP_IN_SITU.find((r) => bits(preFixLinearPDF(r[0]!)) !== bits(r[3]!));
if (lpEx) {
  console.log(`          linearPDF(x=${hex(bits(lpEx[0]!))}) oracle=${hex(bits(lpEx[3]!))} pre-fix=${hex(bits(preFixLinearPDF(lpEx[0]!)))}`);
}
