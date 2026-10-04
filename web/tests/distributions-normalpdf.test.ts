/**
 * Lane L10 — `normalPDF` against the oracle's own values (`utils/distributions.cc:32-43`).
 *
 * This is the one function in the lane that a source reading gets *wrong*, twice over:
 *
 *  1. Three of its four `pow` calls do not survive as calls. `normalPDF` is the folded form of
 *     `pow(sigma,2) * 2`, `pow(sigma,2)` and `pow(x-mu,2)` — clang's `-O2` turns them into
 *     multiplies (`fmul d1, d1, d1`, `fnmul s0, s0, s0`), so there is nothing to transcribe from
 *     the source and no call site to attribute.
 *  2. It is not a float chain. `__Z9normalPDFfff` keeps `sigma^2`, the `fl(2*pi) * sigma^2`
 *     product, the `sqrt` and the reciprocal in **double** and narrows to float once per store,
 *     and it narrows `2 * (double)sigma^2` once too. The port used to put an `f32` at every
 *     arithmetic step (`distributions.ts:32`, `:36`), which rounds three times where the binary
 *     rounds once.
 *
 * So the pin cannot be written from the C source either — it is written against the shipped
 * library: `native/raw/normalpdf_sweep.tsv` (1 296 `(x, sigma, mu)` rows, every field a float32
 * bit pattern) is dumped by `native/raw/dump_normalpdf.cc`, which calls `normalPDF` **out of
 * `libpolyworld.dylib`** and, alongside it, emits the four expressions as the *binary* evaluates
 * them (a `volatile` per step, at the register width the disassembly uses). The replica is
 * checked against the library on every row below, so a misreading of the disassembly cannot
 * survive in this file. Regenerate with the command in that dumper's header; the numbers are
 * re-printable with `npx tsx tools/measure_normalpdf_f32.ts`.
 *
 * Measured (this file re-derives them): the pre-fix `left` disagreed with the oracle on **576 /
 * 1 296 (44.4 %)** rows and the port's return value on **537 (41.4 %)**; after the fix `left`,
 * `rightTop` and `rightBottom` match on **all 1 296**, and the last residual — **11 rows
 * (0.85 %)**, all 1 ulp, where the oracle's `_powf` (`bl _powf` @0xfbc4) disagreed with the
 * port's double `pow` — was closed by **card t_29e0a2fc**, which transcribed the float overload
 * (`powf` in `src/model/rng/libm.ts`; the 7 325-row corpus is
 * `src/model/rng/native/raw/libm_native_powf.txt`). `right` — and therefore `pdf` — now matches
 * on all 1 296 rows, and the double-`pow` shortcut is pinned as an 11-row / 37-row regression
 * rather than left implicit. None of it is reachable in the recorded scenarios (`Distribution U`
 * in both worldfiles), so no golden moves; it is a draw-count risk for a worldfile that sets
 * `EllipseGauss`/`RectGauss` (`getNormal`'s rejection sampler recurses on the PDF value).
 *
 * `t_bb4630da` added the **in-situ** half of the same question. Every row above passes exact
 * float32 `sigma`/`mu`/`x`; the port's own call site does not — `Patch::setPoint`'s four
 * distribution parameters are native `float` literals (`Patch.cc:78-81`: `sigma = .3f`,
 * `mu = .5f`, `slope = -0.4f`, `yIntercept = .4f`) and were transcribed as JS doubles, so
 * `normalPDF`'s `fcvt d1, s1` (0xfb78) widened `0.299999999999999988…` instead of
 * `0.300000011920928955…` and `linearPDF`'s `fmadd s1, s1, s0, s2` (0xfbdc) fused the wrong
 * operands. Two corpora now carry the library's own answers for the operands the call site
 * really passes — `native/raw/normalpdf_insitu.tsv` (`sigma = 0.3f`, `mu = 0.5f`, `x = i/10000`,
 * 10 000 rows) and `native/raw/linearpdf_insitu.tsv` (`slope = -0.4f`, `yIntercept = 0.4f`,
 * `x = i/40000`, 40 001 rows) — dumped by `dump_normalpdf_insitu.cc` / `dump_linearpdf_insitu.cc`.
 * The four functions also narrow their own parameters at entry now (native's signatures are
 * `float`); the sections at the bottom measure both spellings, so a re-widened literal or a
 * dropped entry `f32` both read as a regression.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalPDF, linearPDF, getNormal, getLinear } from '../src/model/environment/distributions';
import {
  PATCH_GAUSS_MU,
  PATCH_GAUSS_SIGMA,
  PATCH_LINEAR_SLOPE,
  PATCH_LINEAR_Y_INTERCEPT,
} from '../src/model/environment/patch';
import { f32Fma } from '../src/model/agent/numeric';
import { f32, f32Bits, f32UlpDistance } from '../src/model/geometry';
import { pow, powf } from '../src/model/rng/libm';

const CORPUS = 'normalpdf_sweep.tsv';
const ROWS = 1296;

type Row = {
  x: number;
  sigma: number;
  mu: number;
  /** `left` as the shipped function computes it (`fcvt s8, d3` at `0xfba0`). */
  left: number;
  /** `-fnmul(x - mu, x - mu)` (`0xfba8`). */
  rightTop: number;
  /** `fcvt s1, d1` of `2 * (double)sigma^2` (`0xfbb0`). */
  rightBottom: number;
  /** The oracle's `powf`, the float overload the port now transcribes (`0xfbc4`). */
  right: number;
  /** The **shipped** `normalPDF`'s return value (`fmul s0, s0, s8`). */
  pdf: number;
};

const hex = (bits: number): string => `0x${(bits >>> 0).toString(16).padStart(8, '0')}`;

const toF32 = (h: string): number => {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, parseInt(h.slice(2), 16), false);
  return dv.getFloat32(0, false);
};

const rows: Row[] = readFileSync(
  join(__dirname, '..', 'src', 'model', 'environment', 'native', 'raw', CORPUS),
  'utf8',
)
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((line) => {
    const f = line.trim().split('\t').map(toF32);
    if (f.length !== 8) throw new Error(`bad ${CORPUS} row: ${line}`);
    const [x, sigma, mu, left, rightTop, rightBottom, right, pdf] = f as [
      number, number, number, number, number, number, number, number,
    ];
    return { x, sigma, mu, left, rightTop, rightBottom, right, pdf };
  });

const ef = f32(2.7182818);
const pi = f32(3.1415927);

/** The binary's operand types: one rounding per native store. This is what ships. */
function binaryForm(x: number, sigma: number, mu: number) {
  const left = f32(1.0 / Math.sqrt(f32(2 * pi) * (sigma * sigma)));
  const rightTop = f32(-f32(Math.pow(f32(x - mu), 2)));
  const rightBottom = f32(2 * (sigma * sigma));
  return { left, rightTop, rightBottom };
}

/** The transcription of the *source* (what `distributions.ts` had before this card). */
function sourceForm(x: number, sigma: number, mu: number) {
  const left = f32(1.0 / f32(Math.sqrt(f32(f32(2 * pi) * f32(Math.pow(sigma, 2))))));
  const rightTop = f32(-f32(Math.pow(f32(x - mu), 2)));
  const rightBottom = f32(2 * f32(Math.pow(sigma, 2)));
  return { left, rightTop, rightBottom };
}

/** `right = pow( e, rightTop / rightBottom )` — the port's transcription of the float overload. */
const portRight = (rightTop: number, rightBottom: number) => powf(ef, f32(rightTop / rightBottom));

/** The double `pow` narrowed to float32 — what this file used before `powf` landed. */
const doublePowRight = (rightTop: number, rightBottom: number) =>
  f32(pow(ef, f32(rightTop / rightBottom)));

describe('normalPDF — the oracle’s own values (native/raw/normalpdf_sweep.tsv)', () => {
  it('carries the expected number of captured rows', () => {
    expect(rows.length).toBe(ROWS);
  });

  it('is a decomposition of the shipped function: pdf === left * right', () => {
    // The dumper's replica of the disassembly is only trustworthy if it reproduces the library
    // it sits next to; this asserts that on every row, so a wrong reading of any intermediate
    // cannot hide behind a matching final value.
    const bad = rows.filter((r) => f32Bits(f32(r.left * r.right)) !== f32Bits(r.pdf));
    expect(bad.map((r) => `${hex(f32Bits(r.x))} ${hex(f32Bits(r.sigma))}`)).toEqual([]);
  });

  it('narrows `left` and `rightBottom` once, not once per arithmetic step', () => {
    const binaryLeft = rows.filter((r) => f32Bits(binaryForm(r.x, r.sigma, r.mu).left) !== f32Bits(r.left));
    expect(binaryLeft).toEqual([]);

    const binaryRightBottom = rows.filter(
      (r) => f32Bits(binaryForm(r.x, r.sigma, r.mu).rightBottom) !== f32Bits(r.rightBottom),
    );
    expect(binaryRightBottom).toEqual([]);

    // The expression the port used before is a *different float*, not a different spelling:
    // 576 of 1 296 rows (44.4 %). Pinned so a re-widened `f32(...)` chain reads as a regression
    // rather than as a cleanup.
    const sourceLeft = rows.filter((r) => f32Bits(sourceForm(r.x, r.sigma, r.mu).left) !== f32Bits(r.left));
    expect(sourceLeft.length).toBe(576);

    // `rightBottom`'s extra `f32` is *value*-neutral (`* 2` is exact in binary32, so the
    // roundings commute) — the operand types changed for the binary's sake, not to move a bit.
    const sourceRightBottom = rows.filter(
      (r) => f32Bits(sourceForm(r.x, r.sigma, r.mu).rightBottom) !== f32Bits(r.rightBottom),
    );
    expect(sourceRightBottom).toEqual([]);
  });

  it('reproduces the oracle everywhere, the `powf` residual included', () => {
    const unattributed: string[] = [];
    let powfRows = 0;
    let matched = 0;
    for (const r of rows) {
      const port = normalPDF(r.x, r.sigma, r.mu);
      const right = portRight(r.rightTop, r.rightBottom);
      if (f32Bits(right) !== f32Bits(r.right)) {
        // This used to be the residual the L10 card did not own: the oracle's `_powf` against
        // the port's double `pow` (11 rows, card t_29e0a2fc). That card transcribed the float
        // overload, so the count below is now 0 -- kept as a named counter so a regression in
        // `powf` reports as "the float overload, again" rather than as an unattributed row.
        expect(f32UlpDistance(right, r.right)).toBe(1);
        powfRows++;
        continue;
      }
      // `right` matches, so the corpus's own decomposition (`pdf === left * right`, asserted
      // above) makes any difference here a difference in `left`/`rightTop`/`rightBottom`.
      if (f32Bits(port) !== f32Bits(r.pdf)) {
        unattributed.push(
          `x=${hex(f32Bits(r.x))} sigma=${hex(f32Bits(r.sigma))} mu=${hex(f32Bits(r.mu))}: ` +
            `port=${hex(f32Bits(port))} oracle=${hex(f32Bits(r.pdf))}`,
        );
        continue;
      }
      matched++;
    }
    expect(unattributed).toEqual([]);
    expect(powfRows).toBe(0);
    expect(matched).toBe(ROWS);
  });

  it('is reproducible from the C++ source only through the float overload', () => {
    // `powf` is *not* `f32(pow(...))`: `npx tsx tools/measure_powf.ts` measures the double
    // transcription narrowed to float32 against the shipped `powf` on the 7 308-row libm
    // corpus (37 mismatches) and on this sweep (11). Both numbers are pinned here so the
    // "just use `pow`" shortcut cannot come back silently.
    const viaDoublePow = rows.filter(
      (r) => f32Bits(doublePowRight(r.rightTop, r.rightBottom)) !== f32Bits(r.right),
    );
    expect(viaDoublePow.length).toBe(11);
    for (const r of viaDoublePow) {
      expect(f32UlpDistance(doublePowRight(r.rightTop, r.rightBottom), r.right)).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// The call site's own operands (card t_bb4630da)
// ---------------------------------------------------------------------------
//
// `Patch::setPoint` declares its four distribution parameters `float` (`Patch.cc:78-81`), so the
// oracle's `normalPDF`/`linearPDF` receive `0.3f`/`0.5f`/`-0.4f`/`0.4f` — *not* the JS doubles a
// source-shaped transcription gives. These corpora are the shipped library's own answers for
// exactly those operands (see the file header).

const NP_IN_SITU = 'normalpdf_insitu.tsv';
const LP_IN_SITU = 'linearpdf_insitu.tsv';
const NP_IN_SITU_ROWS = 10_000;
const LP_IN_SITU_ROWS = 40_001;

const readBits = (name: string, width: number): number[][] =>
  readFileSync(join(__dirname, '..', 'src', 'model', 'environment', 'native', 'raw', name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => {
      const f = line.trim().split('\t').map(toF32);
      if (f.length !== width) throw new Error(`bad ${name} row: ${line}`);
      return f;
    });

/** `x sigma mu left rightTop rightBottom right pdf` — `sigma = 0.3f`, `mu = 0.5f`. */
const npInSitu = readBits(NP_IN_SITU, 8);
/** `x lo hi pdf` — `slope = -0.4f`, `yIntercept = 0.4f`. */
const lpInSitu = readBits(LP_IN_SITU, 4);

/** The call site's literals at native's width. */
const SIGMA_F = f32(0.3);
const MU_F = f32(0.5);
const SLOPE_F = f32(-0.4);
const YI_F = f32(0.4);
/** …and as the port spelled them before this card. */
const SIGMA_D = 0.3;
const MU_D = 0.5;

/** The port's arithmetic before this card: the same expressions, the literals as doubles. */
function inSituPreFixNormalPDF(x: number, sigma: number, mu: number) {
  const left = f32(1.0 / Math.sqrt(f32(2 * pi) * (sigma * sigma)));
  const rightTop = f32(-f32(Math.pow(f32(x - mu), 2)));
  const rightBottom = f32(2 * (sigma * sigma));
  const right = powf(ef, f32(rightTop / rightBottom));
  return { left, rightTop, rightBottom, right, pdf: f32(left * right) };
}

/** The pre-fix `linearPDF` (`f32Fma` fed the doubles), and the pre-fix samplers built on both. */
const inSituPreFixLinearPDF = (x: number) => (x <= 0.5 ? f32(-(-0.4) * x) : f32Fma(-0.4, x, 0.4));
function inSituPreFixGetNormal(sigma: number, mu: number, randpw: () => number): number {
  for (;;) {
    const x = f32(randpw());
    const y = inSituPreFixNormalPDF(x, sigma, mu).pdf;
    const z = f32(randpw());
    if (z < y && z >= 0.0 && z <= 1.0) return x;
  }
}
function inSituPreFixGetLinear(slope: number, yIntercept: number, randpw: () => number): number {
  for (;;) {
    const x = f32(randpw());
    const y = x <= 0.5 ? f32(-slope * x) : f32Fma(slope, x, yIntercept);
    const z = f32(randpw());
    if (z < y && z >= 0.0 && z <= 1.0) return x;
  }
}

/** A deterministic `drand48`-shaped stream (the 48-bit LCG), so sampler runs are reproducible. */
const lcgStream = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 0x100000000;
  };
};

describe('the call site’s own operands (t_bb4630da)', () => {
  it('carries both in-situ corpora, and each is the shipped function’s own decomposition', () => {
    expect(npInSitu.length).toBe(NP_IN_SITU_ROWS);
    expect(lpInSitu.length).toBe(LP_IN_SITU_ROWS);

    // normalPDF: the replica next to the library must reproduce the library's own return value
    // on every row (the same self-check the 1 296-row sweep runs).
    const npBad = npInSitu.filter((r) => {
      const [x, sigma, mu, left, , , right, pdf] = r as number[];
      return (
        f32Bits(f32(left! * right!)) !== f32Bits(pdf!) ||
        f32Bits(sigma!) !== f32Bits(SIGMA_F) ||
        f32Bits(mu!) !== f32Bits(MU_F) ||
        x! < 0 ||
        x! >= 1 // `randpw()`'s own domain: the sampler passes its draw straight in
      );
    });
    expect(npBad).toEqual([]);

    // linearPDF: `fcmp s0, 0.5f` + `fcsel s0, s1, s3, hi` — the arm boundary included.
    const lpBad = lpInSitu.filter((r) => {
      const [x, lo, hi, pdf] = r as number[];
      return f32Bits(x! <= 0.5 ? lo! : hi!) !== f32Bits(pdf!);
    });
    expect(lpBad).toEqual([]);
    expect(lpInSitu[20_000]![0]).toBe(0.5); // i/40000 = 0.5 takes the `fnmul` arm
  });

  it('`0.3` is not `0.3f`: `normalPDF` narrows the call site’s literals', () => {
    // What the pre-fix port computed: the same expressions, `sigma`/`mu` as JS doubles.
    const preLeft = npInSitu.filter(
      (r) => f32Bits(inSituPreFixNormalPDF(r[0]!, SIGMA_D, MU_D).left) !== f32Bits(r[3]!),
    );
    const prePdf = npInSitu.filter(
      (r) => f32Bits(inSituPreFixNormalPDF(r[0]!, SIGMA_D, MU_D).pdf) !== f32Bits(r[7]!),
    );
    // `left`/`rightBottom` are functions of `sigma` alone, so this one value is the whole grid…
    expect(preLeft.length).toBe(NP_IN_SITU_ROWS);
    expect(f32Bits(inSituPreFixNormalPDF(0, SIGMA_D, MU_D).left)).toBe(0x3faa3723);
    // …and the return value moved on all but 544 of the 10 000 x values.
    expect(prePdf.length).toBe(9_456);
    expect(f32Bits(npInSitu[0]![3]!)).toBe(0x3faa3722); // the oracle's `left`

    // The fix, measured through the public entry: the *same* double literals a careless call
    // site would still pass, and the call site's own floats, both give the oracle's answer —
    // native's parameters are `float`, so the entry narrowing is what makes that true.
    const viaDoubles = npInSitu.filter(
      (r) => f32Bits(normalPDF(r[0]!, SIGMA_D, MU_D)) !== f32Bits(r[7]!),
    );
    const viaFloats = npInSitu.filter(
      (r) => f32Bits(normalPDF(r[0]!, SIGMA_F, MU_F)) !== f32Bits(r[7]!),
    );
    expect(viaDoubles).toEqual([]);
    expect(viaFloats).toEqual([]);
  });

  it('`linearPDF` narrows them too: the doubles move 20.0 % of x', () => {
    const preAll = lpInSitu.filter(
      (r) => f32Bits(inSituPreFixLinearPDF(r[0]!)) !== f32Bits(r[3]!),
    );
    const preElse = lpInSitu.filter(
      (r) => r[0]! > 0.5 && f32Bits(inSituPreFixLinearPDF(r[0]!)) !== f32Bits(r[3]!),
    );
    expect(preElse.length).toBe(3_999); // of the 20 000 rows in (0.5, 1]
    expect(preAll.length).toBe(7_991); // 20.0 % of all 40 001
    // e.g. x = 0x39378034: the shipped `fmadd` gives 0x3892ccf7, the double-operand form 0x3892ccf6
    const example = lpInSitu.find((r) => f32Bits(r[0]!) === 0x39378034)!;
    expect(f32Bits(example[3]!)).toBe(0x3892ccf7);
    expect(f32Bits(inSituPreFixLinearPDF(example[0]!))).toBe(0x3892ccf6);

    const viaDoubles = lpInSitu.filter(
      (r) => f32Bits(linearPDF(r[0]!, -0.4, 0.4)) !== f32Bits(r[3]!),
    );
    const viaFloats = lpInSitu.filter(
      (r) => f32Bits(linearPDF(r[0]!, SLOPE_F, YI_F)) !== f32Bits(r[3]!),
    );
    expect(viaDoubles).toEqual([]);
    expect(viaFloats).toEqual([]);
  });

  it('the samplers still draw the same samples — why this was not urgent', () => {
    // The consequence of a 1-ulp PDF is a flipped rejection test, i.e. a different *draw count*,
    // not a cosmetic last bit — but only when the draw lands inside the ulp window. Measured:
    // none does, on this stream, for either sampler (the same insensitivity `t_8db5f338` found
    // for `normalPDF`'s own 1-ulp residual). Pinned so the claim stays measured rather than
    // asserted, and so a change to the sampler structure shows up here.
    const N = 20_000;
    const pairs: [string, (r: () => number) => number, (r: () => number) => number][] = [
      [
        'getNormal',
        (r) => inSituPreFixGetNormal(SIGMA_D, MU_D, r),
        (r) => getNormal(SIGMA_F, MU_F, r),
      ],
      [
        'getLinear',
        (r) => inSituPreFixGetLinear(-0.4, 0.4, r),
        (r) => getLinear(SLOPE_F, YI_F, r),
      ],
    ];
    for (const [name, pre, now] of pairs) {
      const a = lcgStream(20260928);
      const b = lcgStream(20260928);
      let differingSamples = 0;
      let differingDrawCounts = 0;
      let preDraws = 0;
      for (let i = 0; i < N; i++) {
        let da = 0;
        let db = 0;
        const ra = () => (da++, a());
        const rb = () => (db++, b());
        const va = pre(ra);
        const vb = now(rb);
        if (f32Bits(va) !== f32Bits(vb)) differingSamples++;
        if (da !== db) differingDrawCounts++;
        preDraws += da;
      }
      expect(differingSamples, `${name}: samples`).toBe(0);
      expect(differingDrawCounts, `${name}: draw counts`).toBe(0);
      // Non-vacuity: the rejection loop is really running (getNormal ~2.5, getLinear ~20 draws
      // per accepted sample), so "no difference" is a fact about the operands, not a constant.
      expect(preDraws, `${name}: draws`).toBeGreaterThan(2 * N);
    }
  });

  it('the whole (x, sigma, mu) grid still matches when the caller passes the JS doubles', () => {
    // Criterion-wise: the sweep's own grid, but with every `sigma`/`mu` fed as the *double* a
    // source-shaped transcription would hold. `shortestSource` recovers that literal from the
    // stored float (the shortest decimal that narrows back to it) — and it recovers the dumper's
    // own lists exactly (`0.05 … 10`, `-0.5 … 1`), which is the check that the reconstruction is
    // the source and not a re-spelling of the float.
    const shortestSource = (v: number): string => {
      for (let p = 1; p <= 9; p++) {
        const text = String(Number(v.toPrecision(p)));
        if (f32Bits(f32(Number(text))) === f32Bits(v)) return text;
      }
      throw new Error(`no shortest decimal for ${v}`);
    };
    expect([...new Set(rows.map((r) => shortestSource(r.sigma)))].sort()).toEqual([
      '0.05', '0.1', '0.3', '0.5', '0.7', '1', '10', '2', '3.3',
    ]);
    expect([...new Set(rows.map((r) => shortestSource(r.mu)))].sort()).toEqual([
      '-0.5', '0', '0.25', '0.5', '0.75', '1',
    ]);

    const asDoubles = (r: Row) => [Number(shortestSource(r.sigma)), Number(shortestSource(r.mu))] as const;

    // Pre-fix, five of the nine `sigma`s (0.05, 0.1, 0.3, 0.7, 3.3) have a double that is not
    // their float, and each accounts for all 144 of its rows: 720 of 1 296 in `left`/`rightBottom`,
    // 386 of 1 296 in the return value.
    const preLeft = rows.filter((r) => {
      const [sigma, mu] = asDoubles(r);
      const b = inSituPreFixNormalPDF(r.x, sigma, mu);
      return f32Bits(b.left) !== f32Bits(r.left) || f32Bits(b.rightBottom) !== f32Bits(r.rightBottom);
    });
    const prePdf = rows.filter((r) => {
      const [sigma, mu] = asDoubles(r);
      return f32Bits(inSituPreFixNormalPDF(r.x, sigma, mu).pdf) !== f32Bits(r.pdf);
    });
    expect(preLeft.length).toBe(720);
    expect(prePdf.length).toBe(386);

    // …and through the public entry both spellings reproduce the oracle on all 1 296 rows.
    const viaDoubles = rows.filter((r) => {
      const [sigma, mu] = asDoubles(r);
      return f32Bits(normalPDF(r.x, sigma, mu)) !== f32Bits(r.pdf);
    });
    const viaFloats = rows.filter((r) => f32Bits(normalPDF(r.x, r.sigma, r.mu)) !== f32Bits(r.pdf));
    expect(viaDoubles).toEqual([]);
    expect(viaFloats).toEqual([]);
  });

  it('pins the call site’s literals at binary32 — the four `setPoint` parameters', () => {
    // `patch.ts` exports the four values `setPoint` passes (`Patch.cc:78-81`'s `float` literals).
    // This is the *source* half of the fix and the only place it can be checked: with the entry
    // narrowing measured above, a re-widened literal at the call site produces the same samples
    // (0 differing samples in 20 000 draws of either sampler), so nothing downstream can see it.
    expect(f32Bits(PATCH_GAUSS_SIGMA)).toBe(0x3e99999a); // 0.300000011920928955078125
    expect(f32Bits(PATCH_GAUSS_MU)).toBe(0x3f000000); // 0.5
    expect(f32Bits(PATCH_LINEAR_SLOPE)).toBe(0xbecccccd); // -0.4000000059604644775390625
    expect(f32Bits(PATCH_LINEAR_Y_INTERCEPT)).toBe(0x3ecccccd); // 0.4000000059604644775390625

    // Non-vacuity: three of the four are *different values* from the doubles a source-shaped
    // transcription would hold (0.5 is the one literal that is exact in both widths).
    expect(PATCH_GAUSS_SIGMA).not.toBe(0.3);
    expect(PATCH_LINEAR_SLOPE).not.toBe(-0.4);
    expect(PATCH_LINEAR_Y_INTERCEPT).not.toBe(0.4);
    expect(PATCH_GAUSS_MU).toBe(0.5);
    // …and the direction of the difference is native's `float` narrowing: the double `0.3` lies
    // *below* `0.3f` (`0.299999999999999988…` against `0.300000011920928955…`).
    expect(PATCH_GAUSS_SIGMA).toBeGreaterThan(0.3);
    expect(PATCH_LINEAR_Y_INTERCEPT).toBeGreaterThan(0.4);
  });
});
