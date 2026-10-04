/**
 * Lane L10 — native `utils/distributions.{h,cc}`, as `Patch::setPoint` consumes it.
 *
 * `getLinear`/`getNormal` are rejection samplers: draw a candidate `x`, evaluate its PDF,
 * draw `z`, and keep `x` only when `z < y` (and `0 <= z <= 1`); otherwise **recurse**. The
 * recursion (native's is recursive too, one call per rejection) means the *number of
 * `randpw()` draws* depends on the PDF values — so a 1-ulp difference in `pow` changes the
 * whole sequence, not just the last bits.
 *
 * PORT-NOTE(L10/distributions-float-order): native is C++ with `<math.h>`'s **double**
 * overloads, so `normalPDF` is not a float chain. `__Z9normalPDFfff` (`0xfb6c`) keeps
 * `sigma^2`, the `fl(2*pi) * sigma^2` product, the `sqrt` and the reciprocal in double and
 * narrows to float exactly once per store:
 *
 *   fb78:  fcvt  d1, s1                    ; (double)sigma
 *   fb7c:  fmul  d1, d1, d1                ; sigma^2      <- `pow(sigma,2)`, folded
 *   fb8c:  fmov  d3, 0x401921FB60000000    ; fl(2*pi_f) widened (6.2831854820251465)
 *   fb90:  fmul  d3, d1, d3                ; (2*pi) * sigma^2
 *   fb94:  fsqrt d3, d3                    ; sqrt, in double
 *   fb98:  fdiv  d3, 1.0, d3               ; reciprocal, in double
 *   fba0:  fcvt  s8, d3                    ; `left`       <- its ONLY binary32 rounding
 *   fba4:  fsub  s0, s0, s2                ; x - mu (float)
 *   fba8:  fnmul s0, s0, s0                ; `rightTop` = -(x-mu)^2, one rounding
 *   fbac:  fadd  d1, d1, d1                ; 2 * sigma^2
 *   fbb0:  fcvt  s1, d1                    ; `rightBottom`<- its ONLY binary32 rounding
 *
 * So `left` carries one `f32`, not four. The expression this file used before
 * (`f32(1.0 / f32(Math.sqrt(f32(f32(2 * pi) * f32(Math.pow(sigma, 2))))))`) rounded the
 * square, the product *and* the root too — measured against the dylib itself, row by row, over
 * `native/raw/normalpdf_sweep.tsv` (1 296 `(x, sigma, mu)` rows captured by
 * `native/raw/dump_normalpdf.cc`, reproducible with `npx tsx tools/measure_normalpdf_f32.ts`),
 * it disagreed with the oracle's `left` on **576 (44.4 %)** of them and with the function's
 * return value on **537 (41.4 %)**. Both `left` and `rightBottom` now carry the binary's operand
 * types (one `f32` each, `sigma * sigma` in double because that is `fmul d1, d1, d1` and not a
 * `pow` call at all): `left` now matches the oracle on all 1 296 of those rows and the return
 * value on all but 10, every one of them the `powf` residual below. `f32(2 * (sigma * sigma))` is
 * *value*-neutral against the previous `f32(2 * f32(Math.pow(sigma, 2)))` (0 disagreements in
 * the same 1 296) — `* 2` is exact in binary32, so the roundings commute; it is written this way
 * to match the binary, not because it fixed anything.
 *
 * `rightTop`'s `f32(Math.pow(f32(x - mu), 2))` is already the oracle's single rounding (the
 * double square of a `float` needs ≤ 48 significand bits, so it is exact). Leave it.
 *
 * Reachability, measured rather than assumed: the probe's `patch.*.rectGauss`/`ellipseGauss`
 * set-point fixtures **do** reach this function (through `getNormal`), and they do not move —
 * `npx vitest run tests/environment.test.ts` is 15/15 both before and after this fix. `getNormal`
 * compares an independent `randpw()` draw against the PDF, so a last-bit change here only
 * changes a sample when that draw lands inside the 1-ulp window; the fixtures' fixed stream does
 * not. Where it would, the sampler recurses, so the consequence is a different number of
 * `randpw()` draws and not just a different last bit.
 *
 * PORT-NOTE(L10/distributions-float-parameters): native's four signatures are `float`
 * (`utils/distributions.h`), so a call **narrows its arguments to binary32 before any
 * arithmetic** — that is literally the first operation of both bodies (`fcvt d1, s1` @0xfb78 in
 * `__Z9normalPDFfff` widens its already-narrowed `sigma`, and the operands `linearPDF`'s
 * `fmadd s1, s1, s0, s2` @0xfbdc fuses are binary32). The port therefore narrows at *entry*
 * (card t_bb4630da). `Patch::setPoint`'s literals are native `float`s and are now `f32(...)` here
 * too, but entry narrowing is what makes the parameter declaration true of *any* caller: without
 * it, a call site passing a JS `0.3` reaches `(double)sigma` as `0.29999999999999998889776975374843…`,
 * which is not a float the oracle could ever hold. Measured against the shipped function over
 * `native/raw/normalpdf_insitu.tsv` (the call site's own `sigma = 0.3f`, `mu = 0.5f`, `x = i/10000`,
 * 10 000 rows, dumped by `native/raw/dump_normalpdf_insitu.cc`): with the double `0.3`, `left` is
 * the wrong float on **10 000 / 10 000** rows (`0x3faa3723` against the oracle's `0x3faa3722`) and
 * the return value is wrong on **9 456 / 10 000 (94.6 %)**; with the entry `f32`, both are **0**.
 * `linearPDF` the same way over `native/raw/linearpdf_insitu.tsv` (40 001 `x` on a 1/40000 grid,
 * `slope = -0.4f`, `yIntercept = 0.4f`, dumped by `native/raw/dump_linearpdf_insitu.cc`): the
 * double literals disagree with the shipped function on **7 991 / 40 001 (20.0 %)** of `x` — the
 * else arm alone, 3 999 / 20 000 — and **0** with the entry `f32`. That is not a cosmetic last
 * bit: `linearPDF`'s value *is* the argument of `getLinear`'s rejection test, so a 1-ulp
 * difference is a different number of `randpw()` draws when the draw lands inside the window.
 * In situ it usually does not: on one deterministic 20 000-draw stream, `getNormal` and `getLinear`
 * each produced **0** differing samples and 0 differing draw counts with the doubles versus the
 * floats (the same insensitivity `t_8db5f338` measured for `normalPDF`'s own 1-ulp residual).
 * `npx tsx tools/measure_distributions_insitu.ts` prints all of it;
 * `tests/distributions-normalpdf.test.ts` pins it.
 *
 * PORT-NOTE(L10/distributions-pow-drift): this file's transcendental is **not** the double
 * `pow` — the oracle's `normalPDF` (and `getNormal`, where it is inlined) compiles to exactly
 * one transcendental call, `_powf` (`bl _powf` @0xfbc4 / @0xfce4; a byte-identical replica of
 * the C source, built with the oracle's own flags, reproduces that code), with two float
 * narrowings (`left`, `rightBottom`) and the other three `pow` calls folded by clang into
 * multiplies — `pow(sigma,2)` to a double `d*d`, `pow(x-mu,2)` to a single-precision
 * `fnmul s0,s0,s0`. Measured: L1's double `pow` and V8's `Math.pow` are bit-identical to each
 * other on all 117,000 arguments of this file's own model ranges and on a 680,034-pair float
 * sweep, and each disagrees with the shipped `powf` on 228/117,000 (0.19 %) and
 * 2,007/680,034 (0.30 %) of them — so swapping `Math.pow` for `pow` would neither reproduce the
 * oracle nor change a single bit here, and it never happened. The site calls L1's own
 * transcription of the *float* overload instead (card t_29e0a2fc, `src/model/rng/libm.ts`,
 * tables in `applePowfTable.ts`): with it, `right` — the last disagreement this function had
 * with the oracle, 11 of the 1 296 `normalpdf_sweep.tsv` rows (0.85 %), all 1 ulp — now matches
 * on **all 1 296**, and the residual that `tests/distributions-normalpdf.test.ts` used to pin
 * as "not ours" is closed there. `npx tsx tools/measure_powf.ts` prints the counts
 * (7 308/7 308 on the libm corpus, 1 296/1 296 here, against 7 271 and 1 285 for the double
 * `pow`). Both recorded scenarios use `Distribution U`, so no *recorded* artifact reaches
 * `getNormal`/`getLinear` (the probe's own gauss set-point fixtures do, and do not move — see the
 * reachability paragraph above); `sqrt` and the rejection comparison are pinned by the probe's
 * `dist.*` fixtures, so any drift in this path is *measurable*; PARITY.md carries the measured
 * result.
 */

import { f32 } from '../geometry';
import { f32Fma } from '../agent/numeric';
import { powf } from '../rng';

/** Native `float normalPDF( float x, float sigma, float mu )` (`distributions.cc:27-43`). */
export function normalPDF(xIn: number, sigmaIn: number, muIn: number): number {
  // Native's parameters are `float`, so the call narrows: `fcvt d1, s1` (0xfb78) widens the
  // *already binary32* `sigma`. See PORT-NOTE(L10/distributions-float-parameters).
  const x = f32(xIn);
  const sigma = f32(sigmaIn);
  const mu = f32(muIn);

  // `float pi = 3.1415927; float e = 2.7182818;` — the *float* literals, truncated on purpose.
  const pi = f32(3.1415927);
  const e = f32(2.7182818);

  // left = 1.0 / sqrt( 2 * pi * pow( sigma, 2 ) )
  //   The disassembly keeps this in double to the `fcvt s8, d3` at 0xfba0: `sigma * sigma` is
  //   the folded `pow(sigma,2)` (`fmul d1, d1, d1`) and `f32(2 * pi)` is the widened
  //   `0x401921FB60000000` constant (`fmov d3, ...`, `fmul d3, d1, d3`).
  const left = f32(1.0 / Math.sqrt(f32(2 * pi) * (sigma * sigma)));
  // rightTop = - pow( (x - mu), 2 )
  const rightTop = f32(-f32(Math.pow(f32(x - mu), 2)));
  // rightBottom = 2 * pow( sigma, 2 ) — `fadd d1, d1, d1` then the one `fcvt s1, d1` (0xfbb0).
  const rightBottom = f32(2 * (sigma * sigma));
  // right = pow( e, (rightTop / rightBottom) )
  //   The ratio is a `float` division in the binary (`fdiv s1, s0, s1` at 0xfbb4) and the
  //   call is `_powf` (`bl _powf` @0xfbc4) — the *float* overload, transcribed in L1 as
  //   `powf` (card t_29e0a2fc). The double `pow` is not a stand-in: it disagrees with the
  //   shipped `powf` on 11 of these 1 296 rows and on 37 of the 7 308 argument pairs of
  //   `src/model/rng/native/raw/libm_native_powf.txt`. `npx tsx tools/measure_powf.ts`
  //   prints both counts.
  const right = powf(e, f32(rightTop / rightBottom));
  return f32(left * right);
}

/** Native `float linearPDF( float x, float slope, float yIntercept )` (`distributions.cc:46-52`). */
export function linearPDF(xIn: number, slopeIn: number, yInterceptIn: number): number {
  // Native's parameters are `float`, so both the `fnmul` arm and the fused `fmadd` arm are fed
  // binary32 operands whatever the call site wrote. See
  // PORT-NOTE(L10/distributions-float-parameters).
  const x = f32(xIn);
  const slope = f32(slopeIn);
  const yIntercept = f32(yInterceptIn);
  // if( x <= 0.5 ) return( -slope * x ); else return( slope * x + yIntercept );
  //
  // PORT-NOTE(L10/fma-contraction): the shipped `linearPDF` is six instructions
  // (`__Z9linearPDFfff` at 0xfbd8):
  //
  //   fbd8:  fnmul  s3, s1, s0        ; s3 = -(slope*x), one rounding   (x <= 0.5 arm)
  //   fbdc:  fmadd  s1, s1, s0, s2    ; s1 = slope*x + yIntercept, ONE rounding
  //   fbe4:  fcmp   s0, 0.5f
  //   fbe8:  fcsel  s0, s1, s3, hi    ; x > 0.5 takes the fmadd
  //
  // so the else arm is a fused multiply-add, not "round the product, then round the
  // sum". The previous `f32(f32(slope * x) + yIntercept)` rounded the product to
  // binary32 first, i.e. it transcribed the *source* rather than the binary, and it is
  // the *unfused* value: measured over the model's own operands (`slope = -0.4f`,
  // `yIntercept = 0.4f`, `x` on a 1/400 000 grid in (0.5, 1]) the two disagree in the
  // last bit on **115 001 of 200 000** `x` values (57 %), e.g. `x = 0x3f20002a`
  // (`0.6250025033950806`): fused `0x3e199957` vs unfused `0x3e199956`. That last bit is
  // the argument of `getLinear`'s rejection test, so it is a draw-count risk, not a
  // cosmetic one. The `x <= 0.5` arm needs no change (`fnmul` is one rounding of
  // `-(slope*x)`, which `f32(-slope * x)` is). Pinned in
  // `tests/fma-contraction-sweep.test.ts`.
  return x <= 0.5 ? f32(-slope * x) : f32Fma(slope, x, yIntercept);
}

/** Native `float getLinear( float slope, float yIntercept )` (`distributions.cc:57-69`). */
export function getLinear(slopeIn: number, yInterceptIn: number, randpw: () => number): number {
  const slope = f32(slopeIn);
  const yIntercept = f32(yInterceptIn);
  // The recursion is native's; the loop keeps the stack depth out of the picture. The draw
  // order and the number of draws are identical either way.
  for (;;) {
    const x = f32(randpw());
    const y = linearPDF(x, slope, yIntercept);
    const z = f32(randpw());
    if (z < y && z >= 0.0 && z <= 1.0) return x;
  }
}

/** Native `float getNormal( float sigma, float mu )` (`distributions.cc:71-83`). */
export function getNormal(sigmaIn: number, muIn: number, randpw: () => number): number {
  const sigma = f32(sigmaIn);
  const mu = f32(muIn);
  for (;;) {
    const x = f32(randpw());
    const y = normalPDF(x, sigma, mu);
    const z = f32(randpw());
    if (z < y && z >= 0.0 && z <= 1.0) return x;
  }
}
