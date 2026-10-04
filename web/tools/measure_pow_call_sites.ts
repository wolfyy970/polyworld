/**
 * Measurement behind the L5/L10 pow call-site swap (kanban t_c10975cb).
 *
 * The oracle's libpolyworld calls, per the disassembly (`otool -tvV lib/libpolyworld.dylib`):
 *   genome::__InterpolatedGene::interpolate(unsigned char) / MutableScalarGene::get  -> `_pow`
 *   genome::Genome::mateProbability: `pow(a, miscbias)`                             -> `_pow`
 *   genome::Genome::mutateBytes(float): pow(2.0, Scalar) is clang-folded to `_exp2`
 *   genome::Genome::mateProbability: `pow(fabs(cosa), MISC_INVIS_SLOPE)`            -> `_powf`
 *   utils/distributions normalPDF / getNormal: `pow(e, ratio)`, pow(sigma,2) folded -> `_powf`
 *
 * This script reports, per swapped site, how far V8's `Math.pow` / `Math.cos` are from the
 * transcribed Apple functions the port now calls, on that site's own argument domain.
 */
import { pow } from '../src/model/rng';
import { cos } from '../src/model/rng/libm';

type Case = { name: string; args: Array<[number, number]> };

const cases: Case[] = [];

// 1. gene.ts:183 — `ratio = pow(ratio, interpolationPower)`; ratio = f32(f32(raw)*1/255).
{
  const args: Array<[number, number]> = [];
  const ratioOf = (raw: number) => Math.fround(Math.fround(raw) * Math.fround(1 / 255));
  for (let raw = 0; raw <= 255; raw++)
    for (const p of [2.0, 3.0, 0.5]) args.push([ratioOf(raw), p]);
  cases.push({ name: 'gene.ts:183 pow(ratio, interpolationPower)', args });
}

// 2. genome.ts:264 — `Math.fround(pow(2.0, MutationStdevPower))`; the gene is float-valued and
//    interpolated over [MinMutationStdevPower, MaxMutationStdevPower] = [0, 6] in the recorded
//    worldfiles, so its reachable exponents are the 256 raw-byte interpolations (plus a grid).
{
  const args: Array<[number, number]> = [];
  for (let raw = 0; raw <= 255; raw++) args.push([2.0, Math.fround((6.0 * raw) / 255)]);
  for (let i = 0; i <= 2000; i++) args.push([2.0, (6.0 * i) / 2000]);
  cases.push({ name: 'genome.ts:264 pow(2.0, MutationStdevPower)', args });
}

// 3. genome.ts:385 — `cos(pow(a, miscbias) * Math.PI)`; a = separation() is a float in [0,1].
{
  const args: Array<[number, number]> = [];
  for (let i = 0; i <= 4000; i++) {
    const a = Math.fround(i / 4000);
    for (const miscbias of [0.5, 1.0, 2.0, 3.0]) args.push([a, miscbias]);
  }
  cases.push({ name: 'genome.ts:385 pow(a, miscbias)', args });
}

const bits = (x: number) => {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, x);
  return b.getBigUint64(0).toString(16);
};

let total = 0;
let powDiff = 0;
let cosDiff = 0;
for (const c of cases) {
  let diff = 0;
  const ex: string[] = [];
  for (const [x, y] of c.args) {
    total++;
    const ported = pow(x, y);
    const v8 = Math.pow(x, y);
    if (!Object.is(ported, v8)) {
      diff++;
      powDiff++;
      if (ex.length < 3) ex.push(`pow(${x}, ${y}): ported=${ported} v8=${v8} (${bits(ported)} vs ${bits(v8)})`);
    }
  }
  console.log(`${c.name}: n=${c.args.length}  transcribed pow != Math.pow on ${diff}`);
  for (const e of ex) console.log('    ' + e);
}

// cos at the mateProbability argument: pow(a, miscbias) * PI
{
  let diff = 0;
  const ex: string[] = [];
  let n = 0;
  for (let i = 0; i <= 4000; i++) {
    const a = Math.fround(i / 4000);
    for (const miscbias of [0.5, 1.0, 2.0, 3.0]) {
      const arg = pow(a, miscbias) * Math.PI;
      n++;
      const ported = cos(arg);
      const v8 = Math.cos(arg);
      if (!Object.is(ported, v8)) {
        cosDiff++;
        diff++;
        if (ex.length < 3) ex.push(`cos(${arg}): ported=${ported} v8=${v8}`);
      }
    }
  }
  console.log(`genome.ts:385 cos(pow(a, miscbias) * PI): n=${n}  transcribed cos != Math.cos on ${diff}`);
  for (const e of ex) console.log('    ' + e);
}
console.log(`TOTAL pow comparisons=${total}, transcribed pow != Math.pow on ${powDiff}, transcribed cos != Math.cos on ${cosDiff}`);
