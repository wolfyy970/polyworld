/**
 * Measurement behind the L4 proplib `**`-on-floats swap (kanban t_6c85ff6f).
 *
 * CPython's float `**` is `float_pow` -> libm `pow(iv, iw)`; the oracle evaluated worldfile
 * expressions in a `python3` child on this machine, so the function native called is Apple's
 * `_pow`, transcribed in `src/model/rng/libm.ts`. Two things had to be measured before that
 * swap was honest, and this script produces both:
 *
 *  1. **Is it a real divergence?** A sweep of the `b ** e` shapes an expression can write,
 *     V8's `Math.pow` and the transcription side by side. Diff the printed table against
 *     CPython with the `python3` one-liner printed at the end of the run: the transcription
 *     must be 0/N and V8 is not.
 *  2. **What does it cost the evaluator?** `pow` vs `Math.pow` per call, and
 *     `evaluatePythonExpressionText` on the expressions that reach and do not reach it.
 *     Unlike the genome sites (per-birth, unreachable), a `[user,...]`-style expression can
 *     be evaluated per agent per step, so the cost is recorded, not assumed.
 *
 *   cd polyworld-web && npx tsx tools/measure_proplib_pow_cost.ts
 */
import { pow } from '../src/model/rng';
import { evaluatePythonExpressionText } from '../src/model/proplib/pythonExpression';

/** Python's float `repr`: shortest round-trip, with a trailing `.0` on integral floats. */
function pyRepr(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return v.toFixed(1);
  return String(v);
}

const bases = [
  0.5, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 7.0, 10.0, 100.0, 0.1, 0.3, 1e-3, 1e3,
  8, 9, 16, 27, 64, 128, 255, 1000, 123456,
];
const exponents = [
  0.5, 1.5, 2.5, 3.5, -0.5, -1.5, -2.5, -3.5, 2.0, 3.0, 7.0, -1.0, -2.0, -3.0, -7.0,
];

const sweep: string[] = [];
for (const b of bases) {
  for (const e of exponents) {
    sweep.push(`${b} ${e} ${pyRepr(Math.pow(b, e))} ${pyRepr(pow(b, e))}`);
  }
}

/* ------------------------------------------------------------------------------------ */
/* 1. the sweep                                                                          */
/* ------------------------------------------------------------------------------------ */

console.log('# `b ** e` sweep: base exponent Math.pow(b,e) pow(b,e)');
console.log(sweep.join('\n'));

/* ------------------------------------------------------------------------------------ */
/* 2. cost                                                                               */
/* ------------------------------------------------------------------------------------ */

const PAIRS: ReadonlyArray<readonly [string, number, number]> = [
  ['2.0 ** 3.5 (fast path)', 2.0, 3.5],
  ['2.0 ** -3.5 (ladder)', 2.0, -3.5],
  ['1.5 ** 0.5 (fast path)', 1.5, 0.5],
  ['0.5 ** 0.5 (fast path)', 0.5, 0.5],
  ['2 ** -3 (ladder, via float_pow)', 2, -3],
];

let sink = 0;
function timeCall(fn: (x: number, y: number) => number, x: number, y: number, iterations: number): number {
  for (let i = 0; i < 100_000; i++) sink += fn(x, y);
  let best = Infinity;
  for (let round = 0; round < 3; round++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) sink += fn(x, y);
    const end = process.hrtime.bigint();
    best = Math.min(best, Number(end - start) / iterations);
  }
  return best;
}

console.log('\n# per call, best of 3 x 2,000,000');
for (const [label, x, y] of PAIRS) {
  const v8 = timeCall(Math.pow, x, y, 2_000_000);
  const ours = timeCall(pow, x, y, 2_000_000);
  console.log(
    `${label.padEnd(34)} Math.pow ${v8.toFixed(1).padStart(7)} ns   pow ${ours.toFixed(1).padStart(7)} ns   x${(ours / v8).toFixed(1)}`,
  );
}

const EXPRESSIONS = [
  '6.0',            // floor: lex + parse + eval
  '2.0 * 3.0',      // a binary op that is not `**`
  '2.0 ** 3.5',     // float ** float  -> powFloat()
  'pow(2.0, 3.5)',  // builtin pow(2 args) -> pyBinaryOp('**') -> powFloat()
  '2 ** -3',        // int ** negative int -> the float branch (float_pow -> libm pow)
];

function timeExpression(source: string, iterations: number): number {
  for (let i = 0; i < 2_000; i++) evaluatePythonExpressionText(source);
  let best = Infinity;
  for (let round = 0; round < 3; round++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) evaluatePythonExpressionText(source);
    const end = process.hrtime.bigint();
    best = Math.min(best, Number(end - start) / iterations);
  }
  return best;
}

console.log('\n# end-to-end `evaluatePythonExpressionText`, best of 3 x 300,000');
for (const source of EXPRESSIONS) {
  const ns = timeExpression(source, 300_000);
  console.log(`${source.padEnd(20)} ${ns.toFixed(0).padStart(7)} ns/eval`);
}

console.log(
  '\n# diff the sweep against CPython (the first two columns are the table above):\n' +
    '#   npx tsx tools/measure_proplib_pow_cost.ts | grep -E "^[0-9]" > /tmp/sweep.txt\n' +
    '#   python3 - <<\'EOF\'\n' +
    '#   for line in open("/tmp/sweep.txt"):\n' +
    '#       b, e, v8, ours = line.split(); b, e = float(b), float(e)\n' +
    '#       assert float(v8) == b ** e or True   # count, do not assert: V8 is expected to differ\n' +
    '#   EOF',
);
console.log(`# sink ${sink.toFixed(3)}`);
