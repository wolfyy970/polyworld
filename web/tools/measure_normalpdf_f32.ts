/**
 * Measurement behind the L10 `normalPDF` `f32`-boundary fix (kanban t_8db5f338).
 *
 * `__Z9normalPDFfff` (`0xfb6c`) is **not** a float chain: `left` keeps `sigma^2`, the
 * `fl(2*pi) * sigma^2` product, the `sqrt` and the reciprocal in **double** and narrows once
 * (`fcvt s8, d3` at `0xfba0`); `rightBottom` narrows `2 * (double)sigma^2` once
 * (`fcvt s1, d1` at `0xfbb0`). The port used to put an `f32` at every arithmetic step of both
 * expressions — three extra binary32 roundings in `left` — which this script measures against
 * the oracle's own values, row by row, over
 * `src/model/environment/native/raw/normalpdf_sweep.tsv` (1 296 `(x, sigma, mu)` rows captured
 * by `native/raw/dump_normalpdf.cc`, which calls the shipped `normalPDF` out of
 * `libpolyworld.dylib`).
 *
 * Run: npx tsx tools/measure_normalpdf_f32.ts
 *
 * What it reports, per expression: rows where the *current* port disagrees with the oracle, and
 * where the *pre-fix* expression did. `pdf`'s residual is attributed too: the oracle calls
 * `powf` there (`bl _powf` @0xfbc4) and the port calls the double `pow` (card t_29e0a2fc), so
 * the script separates "the port's `pdf` differs because its `right` differs" from "…for any
 * other reason" — the latter must be 0.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { f32, f32Bits, f32UlpDistance } from '../src/model/geometry';

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(here, '..', 'src', 'model', 'environment', 'native', 'raw', 'normalpdf_sweep.tsv');

const bitsOf = (x: number) => f32Bits(x);
const hex = (b: number) => `0x${(b >>> 0).toString(16).padStart(8, '0')}`;
/** `0x…` -> the float32 it encodes (via its double value, exactly). */
const fromHex = (h: string) => {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, parseInt(h.slice(2), 16), false);
  return dv.getFloat32(0, false);
};

type Row = {
  x: number; sigma: number; mu: number;
  left: number; rightTop: number; rightBottom: number; right: number; pdf: number;
};

const rows: Row[] = readFileSync(corpusPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((line) => {
    const f = line.split('\t').map(fromHex);
    if (f.length !== 8) throw new Error(`bad row: ${line}`);
    const [x, sigma, mu, left, rightTop, rightBottom, right, pdf] = f as [
      number, number, number, number, number, number, number, number,
    ];
    return { x, sigma, mu, left, rightTop, rightBottom, right, pdf };
  });

// ---------------------------------------------------------------------------
// the two forms of the port's expression
// ---------------------------------------------------------------------------

/** `distributions.ts` before this card: an `f32` at every arithmetic step. */
function prefixNormalPDF(x: number, sigma: number, mu: number) {
  const pi = f32(3.1415927);
  const e = f32(2.7182818);
  const left = f32(1.0 / f32(Math.sqrt(f32(f32(2 * pi) * f32(Math.pow(sigma, 2))))));
  const rightTop = f32(-f32(Math.pow(f32(x - mu), 2)));
  const rightBottom = f32(2 * f32(Math.pow(sigma, 2)));
  const right = f32(Math.pow(e, f32(rightTop / rightBottom)));
  return { left, rightTop, rightBottom, right: right, pdf: f32(left * right) };
}

/** `distributions.ts` now: the binary's operand types, one `f32` per native store. */
function currentNormalPDF(x: number, sigma: number, mu: number) {
  const pi = f32(3.1415927);
  const e = f32(2.7182818);
  const left = f32(1.0 / Math.sqrt(f32(2 * pi) * (sigma * sigma)));
  const rightTop = f32(-f32(Math.pow(f32(x - mu), 2)));
  const rightBottom = f32(2 * (sigma * sigma));
  const right = f32(Math.pow(e, f32(rightTop / rightBottom)));
  return { left, rightTop, rightBottom, right: right, pdf: f32(left * right) };
}

// ---------------------------------------------------------------------------
// the comparison
// ---------------------------------------------------------------------------

type Counters = { left: number; rightTop: number; rightBottom: number; right: number; pdf: number };
const zero = (): Counters => ({ left: 0, rightTop: 0, rightBottom: 0, right: 0, pdf: 0 });

const pre = zero();
const now = zero();
let corpusSelfCheck = 0;
let pdfResidualRows = 0;
let pdfResidualWithMatchingRight = 0;
let pdfResidualMaxUlp = 0;
let rightResidualMaxUlp = 0;
const rightResidualExamples: string[] = [];
const pdfResidualExamples: string[] = [];

for (const r of rows) {
  const a = prefixNormalPDF(r.x, r.sigma, r.mu);
  const b = currentNormalPDF(r.x, r.sigma, r.mu);

  // the corpus decomposes its own `pdf` (the shipped function) into `left * right`?
  if (bitsOf(f32(r.left * r.right)) !== bitsOf(r.pdf)) corpusSelfCheck++;

  for (const [name, cur] of [['left', b.left], ['rightTop', b.rightTop],
    ['rightBottom', b.rightBottom], ['right', b.right], ['pdf', b.pdf]] as const) {
    if (bitsOf(cur) !== bitsOf(r[name])) now[name]++;
  }
  for (const [name, old] of [['left', a.left], ['rightTop', a.rightTop],
    ['rightBottom', a.rightBottom], ['right', a.right], ['pdf', a.pdf]] as const) {
    if (bitsOf(old) !== bitsOf(r[name])) pre[name]++;
  }

  if (bitsOf(b.right) !== bitsOf(r.right)) {
    rightResidualMaxUlp = Math.max(rightResidualMaxUlp, f32UlpDistance(b.right, r.right));
    if (rightResidualExamples.length < 3)
      rightResidualExamples.push(
        `x=${hex(bitsOf(r.x))} sigma=${hex(bitsOf(r.sigma))} mu=${hex(bitsOf(r.mu))}: ` +
          `right oracle=${hex(bitsOf(r.right))} port=${hex(bitsOf(b.right))} (${f32UlpDistance(b.right, r.right)} ulp)`);
  }
  if (bitsOf(b.pdf) !== bitsOf(r.pdf)) {
    pdfResidualRows++;
    pdfResidualMaxUlp = Math.max(pdfResidualMaxUlp, f32UlpDistance(b.pdf, r.pdf));
    if (bitsOf(b.right) === bitsOf(r.right)) pdfResidualWithMatchingRight++;
    if (pdfResidualExamples.length < 3)
      pdfResidualExamples.push(
        `x=${hex(bitsOf(r.x))} sigma=${hex(bitsOf(r.sigma))} mu=${hex(bitsOf(r.mu))}: ` +
          `pdf oracle=${hex(bitsOf(r.pdf))} port=${hex(bitsOf(b.pdf))} (${f32UlpDistance(b.pdf, r.pdf)} ulp)`);
  }
}

const n = rows.length;
const pct = (k: number) => `${k} / ${n} (${((100 * k) / n).toFixed(1)} %)`;

console.log(`corpus: ${n} rows  ${corpusPath}`);
console.log(`corpus self-check (pdf == f32(left * right) on the oracle's own values): ${corpusSelfCheck} mismatches`);
console.log('');
console.log('                     pre-fix vs oracle      current vs oracle');
for (const k of ['left', 'rightTop', 'rightBottom', 'right', 'pdf'] as const) {
  console.log(`${k.padEnd(14)} ${pct(pre[k]).padEnd(22)} ${pct(now[k])}`);
}
console.log('');
console.log(`pdf residual (current): ${pdfResidualRows} rows, max ${pdfResidualMaxUlp} ulp`);
console.log(`  of those, rows whose \`right\` matches the oracle: ${pdfResidualWithMatchingRight}` +
  '  <- must be 0: the residual is entirely the untranscribed `powf`');
console.log(`right residual (current, card t_29e0a2fc): ${now.right} rows, max ${rightResidualMaxUlp} ulp`);
console.log('');
console.log('examples (right):');
for (const e of rightResidualExamples) console.log('  ' + e);
console.log('examples (pdf):');
for (const e of pdfResidualExamples) console.log('  ' + e);
console.log('');
console.log(`pre-fix pdf vs current pdf (what the fix moved): ${rows.filter((r) => {
  const a = prefixNormalPDF(r.x, r.sigma, r.mu);
  const b = currentNormalPDF(r.x, r.sigma, r.mu);
  return bitsOf(a.pdf) !== bitsOf(b.pdf);
}).length} / ${n} rows`);
