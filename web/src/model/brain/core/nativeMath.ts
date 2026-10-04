/**
 * Lane L6 (brain core) — the C arithmetic primitives the brain code is written in.
 *
 * PORT-NOTE(l6/float-discipline): this lane's maths is a mix of `double` and `float`, and
 * which one a value is stored in decides the logged bytes (PORT_SPEC rule 3). Every native
 * store into a `float` becomes `f32(...)` at exactly that statement; every native `double`
 * store stays a plain number. The rule of thumb in this module: a helper that returns what C
 * returns for a float-typed expression is named in C terms (`nint`, `logistic`) and the
 * call sites apply `f32` where native's *store* is float.
 *
 * PORT-NOTE(l6/nint-macro): native `nint(a)` is
 * `((long)((a)+(((a)<0.0)?-0.499999999:0.499999999)))`. Three details matter and are easy to
 * "clean up" wrongly: the test is `< 0.0` (not `<=`); the whole sum is computed in `double` —
 * `a` is promoted, `0.499999999` is a double literal, and the `(long)` cast truncates toward
 * zero; and the macro **mentions `a` twice**, so an argument with a side effect (the RNG call in
 * `GroupsBrain.cc:778`'s distortion, the only such call site in the tree) is *evaluated twice*.
 * `Math.round` is *not* equivalent (it rounds halves away from zero and is exact for the ties
 * this macro deliberately does not hit), and neither is a single-evaluation `nint`: that reading
 * costs one draw per passing connection and desynchronises the agent's whole `NERVOUS_SYSTEM`
 * stream — see `growArithmetic.ts`'s `distortionIndex` and PARITY.md's
 * `l6/groups-nint-double-evaluation` row.
 *
 * PORT-NOTE(l6/logistic-libm): `logistic(x, slope)` is `1/(1+exp(-x*slope))` and it is the
 * only transcendental on the firing-rate path (the spiking path adds `exp` for the bias
 * injection and `sqrt`/`log` inside `nrand()`). It calls **lane L1's transcribed `exp`**
 * (`src/model/rng/libm.ts`), not `Math.exp`: the oracle's libm is not V8's, and this lane's
 * differential harness (`native/brainprobe.cc`) compares raw double bits, so the difference
 * is measurable rather than academic. Measured on this machine (2026-09-28): `Math.exp`
 * reproduces the oracle's `exp` on 7,876 of 8,261 corpus values, the transcription on all of
 * them; the `libm census` block in `tests/brain-core.test.ts` is now exact for both `exp`
 * and `logistic`. See PARITY.md's libm finding.
 */

import { exp } from '../../rng/libm';

/** A native store into a C `float`. */
export function f32(x: number): number {
  return Math.fround(x);
}

// ---------------------------------------------------------------------------
// the native build's `-ffp-contract=on` on the brain's own `double` arithmetic
//
// PORT-NOTE(l6/fma-contraction): the native tree is compiled with `-O2` and clang's default
// `-ffp-contract=on`, so `a*b + c` written as *one* expression is one `fmadd` — the product is
// exact and the sum rounds **once**. The neuron models' accumulation loops, the tau/gain mix,
// both learning rules and the spiking model's Izhikevich update are all contracted in the
// shipped `libpolyworld.dylib`; the pre-fix port rounded twice at each of those sites, and the
// resulting ~1 ulp per step is what amplified into the `Yaw` nerve's residual (PARITY.md, the
// float-contraction rule; the disassembly sites are cited at each call).
//
// `f32Fma` (lane L8, `agent/numeric.ts`) is the same rule in single precision; this is the
// binary64 one. There is no `Math.fma` in JavaScript, so it is emulated exactly:
//
//   twoProduct   Dekker's split multiplication — `p + e === a*b` exactly, both doubles
//   twoSum       Knuth's exact sum — `s + t === p + c` exactly
//   round-to-odd Boldo & Melquiond's FMA emulation: `RN( a*b + c ) = RN( s + RO( t + e ) )`.
//                (Rounding the correction to odd — not to nearest — is what keeps the
//                information the outer rounding needs; the 2^-53-scale double rounding of a
//                plain `s + (t + e)` is *not* always innocuous.)
//
// Verified against exact rational arithmetic (`fractions.Fraction` -> correctly-rounded
// binary64) on 44,498 vectors — the model's own value shapes, wide-random doubles, and 4,000
// constructed so that `a*b + c` is *exactly* the midpoint between two doubles: 0 mismatches.
// ---------------------------------------------------------------------------

const FMA_SPLITTER = 134217729; // 2**27 + 1
const FMA_SCALE = 2 ** 600;
const FMA_VIEW = new DataView(new ArrayBuffer(8));

/** Veltkamp split: `hi + lo === a` exactly, `hi` carrying 26 significand bits. */
function splitDouble(a: number): [number, number] {
  const c = FMA_SPLITTER * a;
  if (!Number.isFinite(c) || Math.abs(a) < 2 ** -600) {
    // |a| too large (the splitter itself would overflow) or too small (it would round into
    // the subnormal range): split a scaled copy, where both halves stay in range
    const up = !Number.isFinite(c);
    const s = up ? a / FMA_SCALE : a * FMA_SCALE;
    const cs = FMA_SPLITTER * s;
    const hi = cs - (cs - s);
    const lo = s - hi;
    return [up ? hi * FMA_SCALE : hi / FMA_SCALE, up ? lo * FMA_SCALE : lo / FMA_SCALE];
  }
  const hi = c - (c - a);
  return [hi, a - hi];
}

/** Dekker: `p + e === a*b` exactly (`p` is the rounded product, `e` the exact remainder). */
function twoProduct(a: number, b: number): [number, number] {
  const p = a * b;
  const [ah, al] = splitDouble(a);
  const [bh, bl] = splitDouble(b);
  const e = ah * bh - p + ah * bl + al * bh + al * bl;
  return [p, e];
}

/** Knuth: `s + t === a + b` exactly (`s` is the rounded sum, `t` the exact remainder). */
function twoSum(a: number, b: number): [number, number] {
  const s = a + b;
  const bb = s - a;
  return [s, a - (s - bb) + (b - bb)];
}

/** Round to odd: set the low significand bit, which is what keeps the outer rounding exact. */
function roundToOdd(x: number): number {
  FMA_VIEW.setFloat64(0, x);
  const hi = FMA_VIEW.getUint32(0);
  const lo = FMA_VIEW.getUint32(4);
  if ((lo & 1) === 1) return x;
  FMA_VIEW.setUint32(0, hi);
  FMA_VIEW.setUint32(4, (lo + 1) >>> 0);
  return FMA_VIEW.getFloat64(0);
}

/** Native `fma( a, b, c )` — one rounding, i.e. clang's contraction of `a*b + c`. */
export function fma64(a: number, b: number, c: number): number {
  const [p, err] = twoProduct(a, b);
  const [s, t] = twoSum(p, c);
  const [u, uerr] = twoSum(t, err);
  return s + (uerr === 0 ? u : roundToOdd(u));
}

/**
 * Native `short( x )` / `(short)x` — a C++ functional cast to `short`.
 *
 * PORT-NOTE(l6/to-short): a `short` conversion of an out-of-range value is
 * implementation-defined in C++; on this platform (and every one the model targets) it is the
 * two's-complement wrap of the low 16 bits. `groupsBrain.ts` narrows through this for the
 * same reason native does (`short distortion = short( nint( … ) )`, `max<short>( … )`).
 */
export function toShort(x: number): number {
  const n = Math.trunc(x);
  return ((n + 0x8000) & 0xffff) - 0x8000;
}

/**
 * C `int` arithmetic: wrap to 32 bits.
 *
 * PORT-NOTE(l6/int32-wrap): `GroupsBrain::init` computes its `maxsynapses` estimate in `int`
 * (every factor is a `short`) and only stores the *result* in a `long`, so a big configuration
 * overflows before it is kept. The port wraps, because the estimate is the denominator of the
 * energy formula and the bound in the architecture check.
 */
export function int32(x: number): number {
  return x | 0;
}

/** Native `#define nint(a)` (`utils/misc.h`). */
export function nint(a: number): number {
  const truncated = Math.trunc(a + (a < 0.0 ? -0.499999999 : 0.499999999));
  // C's `(long)` cast has no negative zero; Math.trunc does for -1 < x < 0
  return truncated === 0 ? 0 : truncated;
}

/**
 * Native `nint` with the macro's `+ ±0.499999999` **contracted into the last multiply of its
 * argument**.
 *
 * PORT-NOTE(l6/nint-contracted-sum): the shipped `libpolyworld.dylib` is compiled with clang's
 * `-ffp-contract=on`, so `nint( a * b * c )` — one expression — carries a single `fmadd`: the
 * macro's `+` fuses with the *last* multiply of its argument, and the sign test reads a
 * different, **unfused** evaluation of it. `GroupsBrain::growSynapses`'s distortion is the one
 * call site in the tree whose argument has a side effect (the `range()` draw), so both halves
 * are visible in one instruction sequence:
 *
 *   66d7c  fmul  d9, d0, d10      ; d9 = RN( range1 * td_fromto_abs )  (d10 = (double)td_abs)
 *   66d90  fmul  d0, d0, d10      ; the SECOND evaluation's draw …
 *   66d94  fmul  d0, d0, d11      ; … times the count (d11 = (double)neuronCount_from, 66ce4)
 *   66d98  fcmp  d0, #0.0         ; the macro's `(a) < 0.0` on that unfused product
 *   66dbc  fcsel d0, d1, d0, mi   ; ±0.499999999 by its sign
 *   66dc0  fmadd d0, d9, d11, d0  ; RN( RN(range1*td_abs) * count + ±0.499999999 )  — ONE rounding
 *   66dc4  fcvtzs x8, d0          ; the `(long)` cast
 *
 * So the argument of `nint` is not a value the caller may materialise and hand over: `nint`
 * would round the product (`fmul` + `fadd`) where the binary rounds `RN(p * count)` once inside
 * the fused add. The two forms differ only when that product lands within ~1 ulp of the
 * truncation boundary `n - ±0.499999999`, which is what `brainprobe growexpr`'s constructed
 * *boundary* family measures (522 rows over 141 `(td_abs, count)` shapes, t_7d391d0f; the same
 * rows are exact for this helper and wrong for the round-then-add form).
 *
 * `product` is that last multiply's rounded first factor (`RN(range1 * td_fromto_abs)`),
 * `factor` its second operand (`(double)neuronCount_from`), and `negative` the macro's own
 * `(a) < 0.0` test — passed in rather than recomputed, because the compiler reads it off the
 * *unfused* second evaluation while the sum is fused with the first.
 */
export function nintFused(product: number, factor: number, negative: boolean): number {
  const truncated = Math.trunc(fma64(product, factor, negative ? -0.499999999 : 0.499999999));
  // C's `(long)` cast has no negative zero; Math.trunc does for -1 < x < 0
  return truncated === 0 ? 0 : truncated;
}

/** Native `double logistic( double x, double slope )` (`utils/misc.cc`). */
export function logistic(x: number, slope: number): number {
  return 1.0 / (1.0 + exp(-1 * x * slope));
}

/** Native `double gaussian( double x, double mean, double variance )` (`utils/misc.cc`). */
export function gaussian(x: number, mean: number, variance: number): number {
  return exp(-((x - mean) * (x - mean)) / variance);
}

/** Native `interp(x,ylo,yhi)` — the macro `range()`/`rrand()` are built on. */
export function interp(x: number, ylo: number, yhi: number): number {
  return ylo + x * (yhi - ylo);
}
