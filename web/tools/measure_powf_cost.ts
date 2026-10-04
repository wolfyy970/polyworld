/**
 * Cost of the transcribed `powf` (the float overload, card t_29e0a2fc).
 *
 *   npx tsx tools/measure_powf_cost.ts
 *
 * `pow`'s row in PARITY.md carries a cost caveat (~1.2 us/call, because its exponent assembly is
 * BigInt arithmetic) that matters if a per-agent-per-step site is switched to it. `powf` — the
 * function the model's two `_powf` sites actually call — was expected to be cheaper, since the
 * shipped code assembles its `2^(n/128)` with a *single* 64-bit `add` and its reduction with a
 * 128-scaled log table; this script measures it on the model's own argument domain
 * (`normalPDF`'s `(e_f, -|ratio|)` shape) against both alternatives.
 */
import { pow, powf } from '../src/model/rng/libm';

function f32(x: number): number {
  return Math.fround(x);
}

const e_f = f32(2.7182818);
const args: [number, number][] = [];
for (let i = 0; i < 4096; i++) {
  args.push([e_f, f32(-(i / 4096) * 0.5)]);
}

function timeIt(name: string, fn: (x: number, y: number) => number): void {
  for (let i = 0; i < args.length; i++) fn(args[i]![0], args[i]![1]); // warm
  const reps = 40;
  const t0 = process.hrtime.bigint();
  let acc = 0;
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < args.length; i++) acc += fn(args[i]![0], args[i]![1]);
  }
  const t1 = process.hrtime.bigint();
  const per = Number(t1 - t0) / (reps * args.length) / 1000;
  console.log(`  ${name.padEnd(22)} ${per.toFixed(3)} us/call`);
  if (!Number.isFinite(acc)) throw new Error('accumulator went non-finite');
}

console.log(`powf cost over ${args.length} model-domain argument pairs (40 reps):`);
timeIt('transcribed powf', powf);
timeIt('transcribed pow', (x, y) => f32(pow(x, y)));
timeIt('Math.pow', (x, y) => f32(Math.pow(x, y)));
