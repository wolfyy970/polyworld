/**
 * Cost of the transcribed `atan2f` (the float overload, card `t_4bb10112`).
 *
 *   npx tsx tools/measure_atan2f_cost.ts
 *
 * Native runs `frustumXZ::Inside` once per object per step in its culling path
 * (`gmisc.cc:335`), so a transcription that is much more expensive than `Math.atan2` is a number
 * a reviewer needs rather than a surprise.  `pow`'s row in PARITY.md carries the same caveat
 * (~1.2 us/call, because its exponent assembly is BigInt arithmetic); this one is measured on the
 * model's own argument domain — differences of WorldSize-25 world coordinates, i.e. the
 * `reachable-lattice` class of the census' corpus — against both alternatives:
 *
 *   * the transcription (nine `fma`s plus the ladder),
 *   * the deleted `f32(Math.atan2)` + two pi values stand-in, and
 *   * `f32(Math.atan2)` itself.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { f32, f32Bits } from '../src/model/geometry/float';
import { atan2f } from '../src/model/rng/libm';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = join(here, '..', 'src', 'model', 'geometry', 'native', 'raw');

function fromBits(u: number): number {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(u >>> 0, 0);
  return b.readFloatLE(0);
}

/** the deleted stand-in (PORT-NOTE(W1e/atan2f-pi), removed by this card) */
function standin(y: number, x: number): number {
  const v = f32(Math.atan2(y, x));
  const bits = f32Bits(v);
  if (bits === 0x40490fdb) return 3.1415925025939941;
  if (bits === 0xc0490fdb) return -3.1415925025939941;
  return v;
}

const args: [number, number][] = [];
for (const line of readFileSync(join(RAW, 'atan2f_args.txt'), 'utf8').split('\n')) {
  const t = line.trim();
  if (t === '' || t.startsWith('#')) continue;
  const f = t.split(/\s+/);
  if (f[2] !== 'reachable-lattice') continue; // the model's own lattice
  args.push([fromBits(parseInt(f[0]!, 16)), fromBits(parseInt(f[1]!, 16))]);
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
  console.log(`  ${name.padEnd(30)} ${per.toFixed(3)} us/call`);
  if (!Number.isFinite(acc)) throw new Error('accumulator went non-finite');
}

console.log(`atan2f cost over ${args.length} model-lattice argument pairs (40 reps):`);
timeIt('transcribed atan2f', atan2f);
timeIt('deleted f32(atan2)+pi stand-in', standin);
timeIt('f32(Math.atan2)', (y, x) => f32(Math.atan2(y, x)));
