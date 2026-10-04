/**
 * Lane L13 (complexity) — the lane's acceptance tests.
 *
 * Three layers:
 *
 *   1. **`log2`** — the transcription in `src/model/complexity/log2.ts`, pinned bit-for-bit
 *      against `native/raw/log2_native.txt` (this machine's own libm, 22,312 values spanning
 *      every exponent, the model's ranges, the subnormal range and the specials). The same test
 *      asserts that the corpus is *discriminating*: V8's `Math.log2` differs from native on
 *      exactly 68 of those values (the number `log2.ts` and PARITY.md quote; the corpus is
 *      committed, so the count is pinned rather than merely bounded).
 *
 *   2. **The algorithm** (unit) — `next_combination`'s exact subset sequence, the matrix
 *      helpers, `n_choose_k_le_s`, and the two GSL kernels against the values recorded from the
 *      shipped library.
 *
 *   3. **Differential parity against the oracle's own code** — the goldens under `golden/` were
 *      produced by `native/run_complexityprobe.sh`, which links the native tree's
 *      `libpolyworld.dylib`:
 *
 *        `golden/brain.txt`  the real `CalcComplexity_brainfunction()` over all 87 recorded
 *                            `run/brain/function/brainFunction_*.txt.gz` fixtures of
 *                            `minitest_voff` × 7 `parts` strings
 *        `golden/pieces-*.txt`  `CalcApproximateFullComplexityWithMatrix`'s pipeline stage by
 *                            stage (noise + `gsamp`, `calcCOV`, `determinant`, `CalcI`,
 *                            `calcC_k_exact`) over two matrices the probe generates itself,
 *                            including `next_combination`'s cross-section trace and the LU
 *                            factors of every cross-section
 *
 *      The Adami half of the lane has no probe here (see `native/complexityprobe.cc`): it is
 *      pinned by `native/adami_reference.py` — an independent implementation of the same
 *      arithmetic, whose output is committed under `golden/adami/` — and, end to end, by the
 *      recorded scenario `minitest_adami` (`tools/scenarios.d/minitest_adami.json`). Both are
 *      asserted in `tests/complexity-adami.test.ts`.
 *
 *      When the native tree (or its built library) is not present, the last suite is skipped
 *      with a message rather than failing: the lane's contract is parity *where the oracle
 *      exists*, and a developer without the native build should still get everything else.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  Matrix,
  calcApproximateFullComplexityWithMatrix,
  calcApproximateFullComplexityWithVector,
  calcCk,
  calcCkExact,
  calcCOV,
  calcI,
  gsamp,
  matrixCrosssection,
  matrixSubsetCol,
  nChooseKLeS,
  nextCombination,
  setGaussianize,
} from '../src/model/complexity/algorithm';
import {
  calcComplexityBrainfunction,
  calcComplexityWithMatrixBrainfunction,
  getListOfBrainfunctionLogfiles,
  readinBrainfunction,
  type BrainFunctionFile,
} from '../src/model/complexity/brain';
import { determinant, luDecomp, statsCovariance, statsMean } from '../src/model/complexity/gsl';
import { log2 } from '../src/model/complexity/log2';
import { Mt19937 } from '../src/model/rng';
import { fma } from '../src/model/rng/libm';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '..');
const LANE = join(REPO, 'src/model/complexity');
const GOLDEN = join(LANE, 'golden');
const RAW = join(LANE, 'native/raw');

//===========================================================================
// helpers
//===========================================================================

const DV = new DataView(new ArrayBuffer(8));
function bits(x: number): string {
  DV.setFloat64(0, x, true);
  return DV.getBigUint64(0, true).toString(16).padStart(16, '0');
}
function fromBits(hex: string): number {
  DV.setBigUint64(0, BigInt('0x' + hex), true);
  return DV.getFloat64(0, true);
}
function bitsOfFile(file: string): string[] {
  return readFileSync(file, 'utf8').trim().split('\n').map((l) => l.trim());
}

/**
 * `AbstractFile` over a recorded fixture: `gets` is `fgets`/`gzgets` (at most `size-1`
 * characters, the newline kept, `null` at end of file) and `seek( offset, SEEK_SET )` is an
 * absolute offset into the **decompressed** stream.
 *
 * PORT-NOTE(l13/fixture-reader-is-node-only): the sim's brain-function files are written by
 * lane L12's `BrainFunctionLog` and read back here; the lane keeps the reader a seam
 * (`BrainFunctionFile`) because the browser has no `node:zlib`. This is the test's node
 * implementation.
 */
function openFixture(path: string): BrainFunctionFile {
  let bytes: Uint8Array;
  if (path.endsWith('.gz')) bytes = new Uint8Array(gunzipSync(readFileSync(path)));
  else bytes = new Uint8Array(readFileSync(path));
  let pos = 0;
  return {
    gets(maxChars: number): string | null {
      if (pos >= bytes.length) return null;
      const max = maxChars - 1;
      const start = pos;
      let n = 0;
      while (pos < bytes.length && n < max) {
        const ch = bytes[pos]!;
        pos++;
        n++;
        if (ch === 0x0a) break;
      }
      return Buffer.from(bytes.subarray(start, pos)).toString('latin1');
    },
    seek(offset: number): void {
      pos = offset;
    },
  };
}

/** `golden/brain.txt`'s `file` column is an absolute path from the recording machine. */
function fixturePath(recorded: string): string {
  const i = recorded.indexOf('oracle/');
  return join(REPO, i >= 0 ? recorded.slice(i) : recorded);
}

/** A deterministic, model-independent matrix generator (never the model's RNG). */
function lcgMatrix(rows: number, cols: number, seed = 0x2545f4914f6cdd1dn): Matrix {
  let s = seed;
  const next = (): number => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return Number((s >> 11n) & ((1n << 53n) - 1n)) / Number(1n << 53n);
  };
  const m = new Matrix(rows, cols);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) m.set(i, j, next() * 2.0 - 0.5);
  return m;
}

//===========================================================================
// 1. log2
//===========================================================================

describe('log2', () => {
  it('is bit-exact against the machine libm on the committed corpus', () => {
    const args = bitsOfFile(join(RAW, 'log2_args.txt'));
    const native = bitsOfFile(join(RAW, 'log2_native.txt'));
    expect(native.length).toBe(args.length);

    let mineOff = 0;
    let v8Off = 0;
    const examples: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const x = fromBits(args[i]!);
      const want = native[i]!;
      const mine = bits(log2(x));
      if (mine !== want) {
        if (examples.length < 8) examples.push(`x=${x} mine=${mine} native=${want}`);
        mineOff++;
      }
      if (bits(Math.log2(x)) !== want) v8Off++;
    }
    expect(examples, 'port mismatches').toEqual([]);
    expect(mineOff, 'port mismatches').toBe(0);
    // The corpus has to be discriminating, or this test proves nothing about the transcription.
    // Pinned, not merely bounded, because the corpus is committed: 68 is the number `log2.ts`
    // and PARITY.md's L13 row quote, so a change here means those docs are now wrong (re-measure
    // with `native/raw/gen_log2_corpus.py` + `native/raw/log2_correct_rounding.py`) rather than
    // that the transcription regressed.
    expect(v8Off, 'Math.log2 mismatches (the corpus is discriminating; see log2.ts)').toBe(68);
  });
});

//===========================================================================
// 2. the algorithm, unit level
//===========================================================================

describe('algorithm primitives', () => {
  it('walks subsets in native order', () => {
    const seen: number[][] = [];
    const a = new Int32Array([0, 1, 2, 3]);
    do {
      seen.push([...a.slice(0, 2)]);
    } while (nextCombination(a, 0, 2, 4));
    expect(seen).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
    // native's guard clauses
    const b = new Int32Array([0, 1, 2]);
    expect(nextCombination(b, 0, 0, 3)).toBe(false);
    expect(nextCombination(b, 0, 3, 3)).toBe(false);
  });

  it('covers every subset of size k exactly once', () => {
    for (const [n, k] of [
      [1, 1],
      [5, 1],
      [5, 2],
      [5, 4],
      [7, 3],
      [9, 8],
    ] as const) {
      const key = (v: ArrayLike<number>, len: number) => [...Array(len)].map((_, i) => v[i]).join(',');
      const seen = new Set<string>();
      const a = new Int32Array(n);
      for (let i = 0; i < n; i++) a[i] = i;
      let count = 0;
      do {
        seen.add(key(a, k));
        count++;
        if (count > 100000) throw new Error('next_combination did not terminate');
      } while (nextCombination(a, 0, k, n));
      const expected = (() => {
        let c = 1;
        for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
        return Math.round(c);
      })();
      expect(count, `n=${n} k=${k} subset count`).toBe(expected);
      expect(seen.size, `n=${n} k=${k} distinct`).toBe(expected);
    }
  });

  it('selects cross-sections and column subsets', () => {
    const m = new Matrix(3, 3);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m.set(i, j, i * 10 + j);
    const cross = matrixCrosssection(m, [2, 0], 2);
    expect([cross.get(0, 0), cross.get(0, 1), cross.get(1, 0), cross.get(1, 1)]).toEqual([22, 20, 2, 0]);
    const cols = matrixSubsetCol(m, [2, 0], 2);
    expect(cols.size1).toBe(3);
    expect([cols.get(0, 0), cols.get(0, 1), cols.get(2, 0), cols.get(2, 1)]).toEqual([2, 0, 22, 20]);
  });

  it('implements n_choose_k_le_s', () => {
    expect(nChooseKLeS(5, 4, 1000)).toBe(true);
    expect(nChooseKLeS(29, 4, 1000)).toBe(false);
    expect(nChooseKLeS(1, 1, 1000)).toBe(true);
    expect(nChooseKLeS(10, 0, 1000)).toBe(true);
  });

  it("uses GSL's online mean and online covariance, both rounded as the library is", () => {
    // Values recorded from the shipped library by `native/run_gslprobe.sh` (the committed
    // output is `native/raw/gsl_kernels.txt`), bit patterns and all.
    const a = [0.3, -1.7, 2.9, 0.05, -0.44, 1.2, -3.1, 0.8];
    const b = [-0.9, 0.6, 1.55, -2.2, 0.31, 0.07, 2.4, -1.1];
    expect(bits(statsMean(a, 1, 8))).toBe('3f547ae147ae1440');
    // ... and not the plain `sum/n`, which the same library returns for the *variance* helpers
    let sum = 0;
    for (const v of a) sum += v;
    expect(bits(sum / 8)).toBe('3f547ae147ae1480');
    // Recorded from the shipped library: gsl_stats_covariance( a, 1, b, 1, 8 ) is 0xbfe821223b197428.
    // The online recurrence without the fused multiply-add gives 0xbfe821223b197425 and the
    // textbook two-pass gives 0xbfe821223b197427, so this pins the *form*, not just the value.
    expect(bits(statsCovariance(a, b, 8))).toBe('bfe821223b197428');
  });

  it('rejects the shapes native aborts on', () => {
    expect(() => determinant(new Matrix(0, 0))).toThrow(/0x0/);
    expect(() => calcCkExact(new Matrix(3, 3), 1.0, 0)).toThrow(/sub-matrix/);
    expect(() => gsamp(new Matrix(2, 3))).toThrow(/more cols than rows/);
    expect(() => calcApproximateFullComplexityWithVector([1, 2, 3], 5, 1, 1)).toThrow(/shorter/);
  });
});

//===========================================================================
// 3. differential parity, from the committed probe goldens
//===========================================================================

describe('pieces (CalcApproximateFullComplexityWithMatrix)', () => {
  for (const [rows, cols, np] of [
    [12, 5, 1],
    [30, 9, 1],
  ] as const) {
    it(`reproduces the native pipeline for ${rows}x${cols}`, () => {
      const text = readFileSync(join(GOLDEN, `pieces-${rows}x${cols}-np${np}.txt`), 'utf8');
      const scalars = new Map<string, string>();
      const nativeInput: string[] = [];
      const nativeNoisy: string[] = [];
      const nativeCov = new Map<string, string>();
      for (const line of text.split('\n')) {
        const t = line.trim().split(' ');
        if (t[0] === 'input') nativeInput.push(t[3]!);
        else if (t[0] === 'noisygsamp') nativeNoisy.push(t[3]!);
        else if (t[0] === 'cov') nativeCov.set(`${t[1]},${t[2]}`, t[3]!);
        else if (t.length === 3) scalars.set(t[0]!, t[1]!);
      }

      const data = lcgMatrix(rows, cols);
      let k = 0;
      for (let i = 0; i < rows; i++)
        for (let j = 0; j < cols; j++) {
          expect(bits(data.get(i, j)), `input ${i},${j}`).toBe(nativeInput[k]);
          k++;
        }

      // The pipeline, stage by stage, exactly as the probe replicates it.
      setGaussianize(true);
      const m = data.clone();
      const rng = new Mt19937(42);
      for (let i = 0; i < rows; i++)
        for (let j = 0; j < cols; j++) m.set(i, j, data.get(i, j) + 0.00001 * rng.gaussian());
      gsamp(m);

      k = 0;
      for (let i = 0; i < rows; i++)
        for (let j = 0; j < cols; j++) {
          expect(bits(m.get(i, j)), `noisy+gsamp ${i},${j}`).toBe(nativeNoisy[k]);
          k++;
        }

      const COV = calcCOV(m);
      for (let i = 0; i < cols; i++)
        for (let j = 0; j < cols; j++)
          expect(bits(COV.get(i, j)), `cov ${i},${j}`).toBe(nativeCov.get(`${i},${j}`));

      const det = determinant(COV);
      const I_n = calcI(COV, det);
      expect(bits(det), 'det').toBe(scalars.get('det'));
      expect(bits(I_n), 'I_n').toBe(scalars.get('I_n'));
      expect(bits(calcCkExact(COV, I_n, cols - 1)), 'ck_exact_nm1').toBe(scalars.get('ck_exact_nm1'));
      expect(bits(calcCkExact(COV, I_n, Math.floor(cols / 2))), 'ck_exact_half').toBe(
        scalars.get('ck_exact_half'),
      );
      expect(bits(calcCk(COV, I_n, cols - 1)), 'calcC_k_nm1').toBe(scalars.get('calcC_k_nm1'));
      expect(bits(calcApproximateFullComplexityWithMatrix(data, np)), 'complexity').toBe(
        scalars.get('complexity_library'),
      );
    });
  }

  it('reproduces the per-cross-section determinants, integrations and LU factors', () => {
    for (const [rows, cols] of [
      [12, 5],
      [30, 9],
    ] as const) {
      const text = readFileSync(join(GOLDEN, `pieces-${rows}x${cols}-np1.txt`), 'utf8');
      const data = lcgMatrix(rows, cols);
      setGaussianize(true);
      const m = data.clone();
      const rng = new Mt19937(42);
      for (let i = 0; i < rows; i++)
        for (let j = 0; j < cols; j++) m.set(i, j, data.get(i, j) + 0.00001 * rng.gaussian());
      gsamp(m);
      const COV = calcCOV(m);

      const kOf = (label: string) => (label === 'nm1' ? cols - 1 : Math.floor(cols / 2));

      // `ck <label> <n> k <k> idx <indexes> det <bits> I <bits>` -> the sum order and the values
      const traces = new Map<string, { idx: number[]; det: string; I: string }[]>();
      for (const line of text.split('\n')) {
        const t = line.trim().split(' ');
        if (t[0] !== 'ck' || t[2] === undefined || t[2] === 'sumI_k') continue;
        const idx: number[] = [];
        let p = 6;
        while (t[p] !== 'det') idx.push(Number(t[p++]!));
        traces.set(`${t[1]}`, [...(traces.get(t[1]!) ?? []), { idx, det: t[p + 1]!, I: t[p + 3]! }]);
      }

      for (const [label, want] of traces) {
        const k = kOf(label);
        const index = new Int32Array(cols);
        for (let i = 0; i < cols; i++) index[i] = i;
        const seen: string[] = [];
        do {
          const xCOV = matrixCrosssection(COV, index, k);
          const det = determinant(xCOV);
          seen.push(`${[...index.slice(0, k)].join(' ')}|${bits(det)}|${bits(calcI(xCOV, det))}`);
        } while (nextCombination(index, 0, k, cols));
        expect(seen.map((s) => s.split('|')[0]), `${label} cross-sections`).toEqual(
          want.map((w) => w.idx.join(' ')),
        );
        expect(seen.map((s) => s.split('|')[1]), `${label} determinants`).toEqual(want.map((w) => w.det));
        expect(seen.map((s) => s.split('|')[2]), `${label} integrations`).toEqual(want.map((w) => w.I));
      }

      // The LU factors themselves: every cross-section of every trace, element for element.
      const luWant = new Map<string, { sign: number; a: [number, number, string][] }>();
      for (const line of text.split('\n')) {
        const t = line.trim().split(' ');
        if (t[0] !== 'lu') continue;
        const key = `${t[1]} ${t[2]}`;
        const entry = luWant.get(key) ?? { sign: 0, a: [] };
        if (t[3] === 'sign') entry.sign = Number(t[4]);
        else if (t[3] === 'a') entry.a.push([Number(t[4]), Number(t[5]), t[6]!]);
        luWant.set(key, entry);
      }
      for (const [name, want] of luWant) {
        const [label, nc] = name.split(' ');
        const index = new Int32Array(cols);
        for (let i = 0; i < cols; i++) index[i] = i;
        for (let s = 0; s < Number(nc); s++) nextCombination(index, 0, kOf(label!), cols);
        const A = matrixCrosssection(COV, index, kOf(label!)).clone();
        const perm = new Int32Array(A.size1);
        for (let i = 0; i < A.size1; i++) perm[i] = i;
        expect(luDecomp(A, perm), `${name} signum`).toBe(want.sign);
        const bad = want.a.filter(([i, j, hex]) => bits(A.get(i, j)) !== hex);
        expect(bad.map(([i, j, hex]) => `lu[${i}][${j}] mine=${bits(A.get(i, j))} native=${hex}`)).toEqual(
          [],
        );
      }
    }
  });
});

describe('brain-function complexity (CalcComplexity_brainfunction)', () => {
  it('reproduces every recorded fixture for every parts string', () => {
    const golden = join(GOLDEN, 'brain.txt');
    if (!existsSync(golden)) {
      // The golden is committed; this only guards a partial check-out.
      throw new Error(`missing ${golden} (regenerate with native/gen_complexity_golden.py)`);
    }
    const lines = readFileSync(golden, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('file '));
    expect(lines.length).toBeGreaterThan(100);

    const mismatches: string[] = [];
    let checked = 0;
    for (const line of lines) {
      const t = line.split(' ');
      const file = fixturePath(t[1]!);
      const part = t[3]!;
      const wantAgent = Number(t[5]);
      const wantNeurons = Number(t[7]);
      const wantLifespan = Number(t[9]);
      const want = t[11]!;
      const r = calcComplexityBrainfunction({ file: openFixture(file), part });
      checked++;
      if (
        bits(r.complexity) !== want ||
        r.agentNumber !== wantAgent ||
        r.numNeurons !== wantNeurons ||
        r.lifespan !== wantLifespan
      ) {
        if (mismatches.length < 12) {
          mismatches.push(
            `${file.split('/').pop()} ${part}: mine=${bits(r.complexity)} native=${want} ` +
              `(agent ${r.agentNumber}/${wantAgent}, neurons ${r.numNeurons}/${wantNeurons}, lifespan ${r.lifespan}/${wantLifespan})`,
          );
        }
      }
    }
    expect(mismatches, `${checked} (fixture, parts) pairs`).toEqual([]);
  }, 600000);

  it('reads the file the way native does', () => {
    const file = join(REPO, 'oracle/minitest_voff/run/brain/function/brainFunction_1.txt.gz');
    const read = readinBrainfunction(openFixture(file), false, 0, 500);
    expect(read.agentNumber).toBe(1);
    expect(read.numNeurons).toBe(37);
    expect(read.numINeurons).toBe(29);
    expect(read.numONeurons).toBe(8);
    expect(read.lifespan).toBe(218);
    expect(read.activity!.size1).toBe(218);
    expect(read.activity!.size2).toBe(37);
    // frame 0 is not all zero, and the matrix is written by (row, neuron index) from the file
    expect(bits(read.activity!.get(0, 0))).toBe(bits(0.821122));
  });

  it('lists brain-function files by native\'s substring rule', () => {
    const dir = join(REPO, 'oracle/minitest_voff/run/brain/function/');
    const names = readdirSync(dir);
    const listed = getListOfBrainfunctionLogfiles(dir, { readdir: () => names });
    // native's rule is the substring `_brainFunction_`, minus MATLAB exports -- so the
    // `incomplete_brainFunction_<n>` files qualify and the plain `brainFunction_<n>.txt.gz`
    // names (no leading underscore) do not. That asymmetry is native's; the port keeps it.
    const expected = names
      .filter((n) => n.includes('_brainFunction_') && !n.includes('.txt.mat'))
      .map((n) => dir + n);
    expect(listed.sort()).toEqual(expected.sort());
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.some((p) => p.includes('incomplete_brainFunction_'))).toBe(true);
    expect(listed.some((p) => /\/brainFunction_1\.txt\.gz$/.test(p))).toBe(false);
    void dir;
  });

  it('returns -2 for an input-less brain and 0 for an unusable file', () => {
    const m = new Matrix(4, 4);
    expect(calcComplexityWithMatrixBrainfunction(m, 'A', 0, 0)).toBe(-2);
    // A file whose row count is zero reads as `activity === null` -> complexity 0.0
    const emptyContents = new Matrix(0, 0);
    void emptyContents;
    const read = readinBrainfunction(
      { gets: () => null, seek: () => undefined },
      false,
      0,
      500,
    );
    expect(read.activity).toBeNull();
    expect(
      calcComplexityBrainfunction({ file: { gets: () => null, seek: () => undefined }, part: 'A' }).complexity,
    ).toBe(0.0);
    // A brain with fewer rows than neurons is scored 0.0 by `CalcComplexity_brainfunction`
    const short = new Matrix(1, 2);
    void short;
  });
});

describe('native differential (rebuild)', () => {
  const native = process.env.POLYWORLD_NATIVE ?? join(REPO, '..', 'polyworld');
  const canRebuild = existsSync(join(native, 'lib/libpolyworld.dylib'));
  let out: string | null = null;

  beforeAll(() => {
    if (!canRebuild) return;
    out = mkdtempSync(join(tmpdir(), 'complexityprobe-'));
    execFileSync('sh', [join(LANE, 'native/run_complexityprobe.sh'), out], {
      cwd: REPO,
      stdio: 'pipe',
      env: { ...process.env, POLYWORLD_NATIVE: native },
    });
  }, 600000);

  it('regenerates the committed goldens byte for byte', () => {
    if (!canRebuild || out === null) {
      console.log(`skipped: no native build at ${native} (set POLYWORLD_NATIVE)`);
      return;
    }
    const produced = readdirSync(out).filter((f) => f.endsWith('.txt') && f !== 'pieces.txt');
    expect(produced.sort()).toEqual(readdirSync(GOLDEN).filter((f) => f.endsWith('.txt')).sort());
    for (const f of produced) {
      const fresh = normalise(readFileSync(join(out, f), 'utf8'));
      const committed = normalise(readFileSync(join(GOLDEN, f), 'utf8'));
      expect(fresh, f).toBe(committed);
    }
  }, 600000);

  /** Absolute paths differ between machines; the probe's own output is otherwise identical. */
  function normalise(text: string): string {
    return text
      .split('\n')
      .map((l) => l.replace(/^file \S+ /, 'file FIXTURE '))
      .join('\n');
  }
});
