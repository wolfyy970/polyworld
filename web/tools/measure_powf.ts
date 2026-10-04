/**
 * Proof-of-fidelity probe for the transcribed `powf` (the float overload).
 *
 *   npx tsx tools/measure_powf.ts
 *
 * Walks the committed native corpus (`src/model/rng/native/raw/libm_native_powf.txt`, 7,325
 * float32 argument pairs captured from the shipped `powf` by `raw/libm_census.c`) and prints,
 * per expression:
 *
 *   * how many rows the L1 transcription matches bit-for-bit,
 *   * how many V8's `Math.pow` narrowed to float32 matches (the "do we need this at all"
 *     number — **a property of the V8 this runs under**: 196 rows are off under V8 12.4 and 42
 *     under V8 13.6/14.6, while the port is off on 0 under both; see the `PORT-NOTE` in
 *     `tests/rng.test.ts` and `libm.ts`), and
 *   * how many the *double* `pow` transcription narrowed to float32 matches — the candidate
 *     this card replaced, measured rather than argued (37 rows, engine-independent).
 *
 * It also walks L10's `normalpdf_sweep.tsv` (1,296 `(x, sigma, mu)` rows) and counts the
 * `right = powf(e, rightTop/rightBottom)` values the port reproduces, so the 11 rows
 * `tests/distributions-normalpdf.test.ts` pins as a residual can be re-measured directly.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pow, powf } from '../src/model/rng/libm';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = join(here, '..', 'src', 'model', 'rng', 'native', 'raw');

function f32Bits(x: number): number {
  const b = Buffer.alloc(4);
  b.writeFloatLE(x, 0);
  return b.readUInt32LE(0);
}

function f32From(u: number): number {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(u >>> 0, 0);
  return b.readFloatLE(0);
}

function f32(x: number): number {
  return Math.fround(x);
}

function dFromBits(h: string): number {
  return Buffer.from(h, 'hex').readDoubleBE(0);
}

function dBits(x: number): string {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x, 0);
  return b.toString('hex');
}

function f32Hex(x: number): string {
  return f32Bits(x).toString(16).padStart(8, '0');
}

function main(): void {
  const extra = process.argv[2];
  const rows = readFileSync(extra ?? join(RAW, 'libm_native_powf.txt'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.trim().split(/\s+/));

  let port = 0;
  let v8 = 0;
  let dpow = 0;
  const examples: string[] = [];
  for (const row of rows) {
    const x = f32(dFromBits(row[1]!));
    const y = f32(dFromBits(row[2]!));
    const want = f32Hex(f32(dFromBits(row[3]!)));
    if (f32Hex(powf(x, y)) === want) port += 1;
    if (f32Hex(f32(Math.pow(x, y))) === want) v8 += 1;
    if (f32Hex(f32(pow(x, y))) === want) dpow += 1;
    if (examples.length < 3 && f32Hex(powf(x, y)) !== want) {
      examples.push(`powf(${f32Hex(x)}, ${f32Hex(y)}) -> ${f32Hex(powf(x, y))}, native ${want}`);
    }
  }
  console.log(`powf corpus rows: ${rows.length}${extra ? ` (${extra})` : ''}`);
  console.log(`  ported powf      : ${port}/${rows.length}`);
  console.log(`  f32(Math.pow)    : ${v8}/${rows.length}`);
  console.log(`  f32(ported pow)  : ${dpow}/${rows.length}`);
  for (const e of examples) console.log(`  MISMATCH ${e}`);

  if (extra) return;

  const sweep = readFileSync(
    join(here, '..', 'src', 'model', 'environment', 'native', 'raw', 'normalpdf_sweep.tsv'),
    'utf8',
  )
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.trim().split(/\s+/));

  const e_f = f32(2.7182818);
  let rightOk = 0;
  let rightBad = 0;
  let portBad = 0;
  const bad: string[] = [];
  for (const r of sweep) {
    const rightTop = f32From(parseInt(r[4]!, 16));
    const rightBottom = f32From(parseInt(r[5]!, 16));
    const oracleRight = r[6]!.replace(/^0x/, '');
    const ratio = f32(rightTop / rightBottom);
    const gotPort = f32Hex(powf(e_f, ratio));
    const gotOld = f32Hex(f32(pow(e_f, ratio)));
    if (gotPort === oracleRight) rightOk += 1;
    else {
      rightBad += 1;
      if (bad.length < 3) bad.push(`ratio ${f32Hex(ratio)} -> ${gotPort}, oracle ${oracleRight}`);
    }
    if (gotOld !== oracleRight) portBad += 1;
  }
  console.log(`normalPDF sweep: right matches ${rightOk}/${sweep.length}, mismatches ${rightBad}`);
  console.log(`  f32(ported pow) would mismatch on ${portBad}/${sweep.length} of the same rows`);
  for (const b of bad) console.log(`  residual ${b}`);
}

main();
