/**
 * Lane L13 — `log2`, transcribed from the oracle's libm.
 *
 * `complexity/complexity_algorithm.cc` defines `c_log` as `log2` (`complexity_algorithm.cc:20`)
 * and every Integration value the complexity machinery produces is a sum of `log2`s, so the
 * port needs a bit-exact `log2`.
 *
 * PORT-NOTE(L13/log2-is-transcribed-not-correctly-rounded): this machine's `log2` is **not
 * correctly rounded**, so "implement correct rounding" is not an option. Measured on the
 * committed corpus (`native/raw/log2_args.txt` + `native/raw/log2_native.txt`, 22,312 values
 * of 16 hex digits each, built by `native/raw/gen_log2_corpus.py`: every exponent, random
 * mantissas, the model's own ranges — variances ~1e-3..2, determinants down to 1e-200 — and
 * the whole subnormal range):
 *
 *   this transcription             bit-identical to the machine's `log2` on all 22,312
 *   `Math.log2` (V8)               differs from it on 68 (0.30 %)
 *   `appleLog(x) / ln2`            differs on 6,409
 *   `appleLog(x) * (1/ln2)`        differs on 5,613
 *   correctly-rounded `log2`       differs on 4 (1 ulp each) — so the oracle's `log2` is
 *                                  accurate but *not* correctly rounded, and no portable
 *                                  formula reproduces it (`native/raw/log2_correct_rounding.py`)
 *
 * Hence this is a transcription of the shipped function, instruction by instruction, plus its
 * data table (`./appleLog2Table.ts`, extracted from the running libSystem -- see
 * `native/raw/dump_log2_data.c` and `native/gen_log2_table.py`).
 *
 * The algorithm, disassembled from `/usr/lib/system/libsystem_m.dylib` (`pacibsp` entry,
 * `lldb -o "disassemble -n log2"`):
 *
 *   k    = (bits(x) + 0xc018100000000000) >> 52          -- arithmetic 64-bit shift: floor(log2 x) + 1
 *   idx  = ((bits(x) & 2^52-1) + 2^44) >> 45             -- 0..128, one interval per 1/128
 *   z    = the double with 1.0's exponent and x's mantissa   -- z in [1, 2)
 *   r    = z * invc - 1                                    -- one fused rounding
 *   d4   = r^2 (c0 + c1 r)(c2 + c3 r + r^2)(c4 + c5 r + r^2)
 *   x >= 0.5 (k != 0):  log2 x = (k + hi(logc)) + (lo(logc) + d4 + r/ln2)
 *   x <  0.5 (k == 0):  a two-sum split of (logc + hi(r)*LOG2E_HI) keeps the low bits of
 *                       a cancellation, exactly the k == 0 branch `log` has
 *
 * The same two traps lane W1d documented for `log`/`exp` apply: `fnmsub Dd,Dn,Dm,Da` is
 * `Dn*Dm - Da` (so `r = invc*z - 1`), and the argument is re-biased by an *integer* add of the
 * bit patterns, not an FP one.
 *
 * Verified: bit-identical to the machine's `log2` on the whole committed corpus above
 * (`native/raw/log2_args.txt` + `native/raw/log2_native.txt`, 22,312 values), which
 * `tests/complexity.test.ts` reads and re-checks on every run.
 *
 * PORT-NOTE(L13/log2-belongs-in-rng): a bit-exact libm primitive is `src/model/rng`'s subject
 * (`libm.ts`'s `log` and `exp` are the same kind of transcription). It lives in this lane
 * because lane L1's `libm.ts` was under active edit (lane W1d's uncommitted `sin`/`cos`/`pow`
 * work) when L13 landed; moving it there is a pure file move plus an import change.
 */

import { fma } from '../rng/libm';
import {
  LOG2_BIAS_BITS,
  LOG2_INF_BITS,
  LOG2_LOG2E,
  LOG2_LOG2E_HI,
  LOG2_LOG2E_LO,
  LOG2_MASK_BITS,
  LOG2_ONE_BITS,
  LOG2_POLY,
  LOG2_TAB_INVC,
  LOG2_TAB_LOGC,
} from './appleLog2Table';

const DV = new DataView(new ArrayBuffer(8));
const MASK64 = 0xffffffffffffffffn;
const TWO52 = 0x0010000000000000n;
/** `x0 - 2^52` compared against this decides the negative/subnormal/inf/nan dispatch. */
const DISPATCH_LIMIT = 0x7fe0000000000000n;
/** The bits `log2` adds to re-bias a subnormal it has just scaled up. */
const SUBNORMAL_REBIAS = 0xc020000000000000n;

function bitsOf(x: number): bigint {
  DV.setFloat64(0, x, true);
  return (BigInt(DV.getUint32(4, true)) << 32n) | BigInt(DV.getUint32(0, true));
}

function fromBits(b: bigint): number {
  DV.setUint32(0, Number(b & 0xffffffffn), true);
  DV.setUint32(4, Number((b >> 32n) & 0xffffffffn), true);
  return DV.getFloat64(0, true);
}

/** The one shared body: `x0` is the argument's bit pattern (already re-biased if subnormal). */
function main(x0: bigint): number {
  const k = Number(BigInt.asIntN(64, x0 + LOG2_BIAS_BITS) >> 52n);
  const mant = x0 & 0x000fffffffffffffn;
  const idx = Number((mant + 0x0000100000000000n) >> 45n);
  const z = fromBits(LOG2_ONE_BITS | mant);

  const invc = LOG2_TAB_INVC[idx]!;
  const logc = LOG2_TAB_LOGC[idx]!;

  const r = fma(z, invc, -1.0); // fnmsub: invc*z - 1
  const p16 = fma(r, LOG2_POLY[1]!, LOG2_POLY[0]!);
  const p19 = r + LOG2_POLY[3]!;
  const p21 = r + LOG2_POLY[5]!;
  let d4 = r * r;
  const p18 = fma(r, p19, LOG2_POLY[2]!);
  const p20 = fma(r, p21, LOG2_POLY[4]!);
  d4 = d4 * p16;
  d4 = d4 * p18;
  d4 = d4 * p20;

  if (k === 0) {
    const prod = invc * z;
    const err = fma(invc, z, -prod); // the product's exact rounding error
    const d6 = prod - 1.0;
    let d0 = r * LOG2_LOG2E_LO;
    const rHi = fromBits(bitsOf(r) & LOG2_MASK_BITS);
    let d2 = d6 - rHi;
    const d1 = rHi * LOG2_LOG2E_HI;
    d2 = err + d2;
    const s = logc + d1;
    const err2 = s - logc;
    d0 = fma(d2, LOG2_LOG2E_HI, d0);
    d0 = d0 + (d1 - err2);
    d0 = d0 + d4;
    d0 = d0 + s;
    return d0;
  }

  const logcHi = fromBits(bitsOf(logc) & LOG2_MASK_BITS);
  const logcLo = logc - logcHi;
  let d3 = logcLo + d4;
  d3 = fma(r, LOG2_LOG2E, d3);
  return (k + logcHi) + d3;
}

/**
 * `log2(x)`, bit-identical to the oracle's libm.
 *
 * Edge cases follow the C library: `log2(±0)` is -Infinity, `log2(negative)` and `log2(NaN)`
 * are NaN, `log2(+Infinity)` is +Infinity.
 */
export function log2(x: number): number {
  let x0 = bitsOf(x);
  const x2 = (x0 - TWO52) & MASK64;

  if (x2 >= DISPATCH_LIMIT) {
    if (Number.isNaN(x)) return x; // fcmp unordered
    if (x === 0) return -Infinity; // -1.0 / 0.0
    if (x < 0) return NaN; // inf - inf
    // x > 0: +Infinity returns itself; a subnormal is scaled into [1,2) and re-biased.
    if ((x2 >> 63n) === 0n) return x;
    x0 = (bitsOf(fromBits((x0 | LOG2_ONE_BITS) & MASK64) - 1.0) + SUBNORMAL_REBIAS) & MASK64;
  }

  return main(x0);
}

/** The `INF` constant, exported so a reviewer can see it is the negative path's `x - x`. */
export const LOG2_INFINITY_BITS = LOG2_INF_BITS;
