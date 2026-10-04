/**
 * Lane L8 — the numeric helpers the agent core uses (native `utils/misc.h`, `graphics/gmisc.h`).
 *
 * These are macros in C++ (`nint`, `interp`, `rrand`, `clamp`, `randpw`), so they are
 * *expressions*, not functions: the argument is evaluated as many times as the macro text
 * mentions it. Every ported use is written with that in mind, and each one is a pure
 * arithmetic identity, so a function is behaviourally identical here (no argument in the
 * agent core has a side effect).
 *
 * PORT-NOTE(L8/float-narrowing): native model math is `float`-typed and every store into a
 * `float` rounds (PORT_SPEC ground rule 3). `f32` is that store; it must be applied exactly
 * where the C++ assigns to a float, and *not* applied to intermediates the C++ keeps in
 * `double` — getting either side wrong moves the last bits.
 */

/** `float` store (native assignment to a `float`). */
export function f32(value: number): number {
  return Math.fround(value);
}

// ---------------------------------------------------------------------------
// fused multiply-add — the native build's `-ffp-contract=on`
// ---------------------------------------------------------------------------

const BITS = new DataView(new ArrayBuffer(4));

/** Next binary32 value after `x` toward +inf (`dir = 1`) or -inf (`dir = -1`). */
function nextF32(x: number, dir: number): number {
  BITS.setFloat32(0, Math.abs(x));
  let u = BITS.getUint32(0);
  if (x >= 0 ? dir > 0 : dir < 0) u += 1;
  else u -= 1;
  BITS.setUint32(0, u);
  const mag = BITS.getFloat32(0);
  return x < 0 ? -mag : mag;
}

const F32_OVERFLOW_MID = 2 ** 128 - 2 ** 103; // midpoint of the largest float and 2**128
const F32_MAX = 3.4028234663852886e38;

/**
 * Correctly-rounded binary32 `a*b + c` — C's `fmaf`, i.e. the *single* rounding the native
 * build performs when clang contracts `a*b + c` into one `fmadd`.
 *
 * PORT-NOTE(L8/contraction): the native tree is compiled with `-O2` and clang's default
 * `-ffp-contract=on`, so `a*b + c` is *not* two roundings (a `float` multiply then a `float`
 * add) but one: the product is kept exact and the sum rounds once. A source-level
 * transcription that rounds per operation therefore differs in the last bits whenever the
 * contracted form and the source form round differently — measured on the shipped dylib:
 * 65 of 3016 `agent::GetCollisionFixedCoordinates` cases (PARITY.md -> the float-contraction
 * rule). Every site the native build contracts needs this helper, and `agent.ts` names the
 * sites.
 *
 * Exactness argument (and why `Math.fround( a*b + c )` is *not* enough): `a` and `b` are
 * binary32, so `a*b` is exact in a double (24+24 <= 53 bits) and `Math.fround( a*b + c )`
 * rounds the exact sum twice — once to binary64, once to binary32. When the exact sum sits
 * within ~2**-29 of a binary32 rounding boundary the two roundings disagree (measured: with
 * `c` generated to land on such a boundary, ~1 case in 10^4 for the ranges this lane feeds);
 * `Math.fround` alone is therefore only *usually* right. Here the binary64 rounding error of
 * `p + c` is recovered exactly (Knuth two-sum), so the exact sum is known as the pair
 * `(s, e)` and the one binary32 boundary the exact sum can straddle is resolved exactly by a
 * second exact comparison against the midpoint `(r + nextafter(r))/2` (Sterbenz: `s - mid`
 * is exact). Verified against hardware `FMADD` (`__builtin_fmaf`, clang -O2) bit-for-bit on
 * 300 000 triples and against an exact rational (BigInt) reference on 1.6 million more,
 * including 800 000 built to sit on a rounding boundary.
 *
 * Contract: `a` and `b` are binary32-valued; `c` is any finite double.
 */
export function f32Fma(a: number, b: number, c: number): number {
  const p = a * b; // exact: both factors are binary32
  const s = p + c; // binary64 rounding of the exact sum
  const bp = s - p;
  const e = p - (s - bp) + (c - bp); // Knuth two-sum: s + e === p + c exactly
  const r = Math.fround(s);
  if (!Number.isFinite(r)) {
    // overflow region: decide against the midpoint between the largest float and 2**128
    const sgn = s < 0 ? -1 : 1;
    if (Math.abs(s) >= 2 ** 129) return sgn * Infinity;
    const d0 = Math.abs(s) - F32_OVERFLOW_MID; // exact here
    const t0 = d0 + sgn * e;
    if (t0 > 0) return sgn * Infinity;
    if (t0 < 0) return sgn * F32_MAX;
    return sgn * Infinity; // exact tie rounds to the even significand (2**128)
  }
  if (e === 0 || r === s) return r; // no second rounding: r is already the exact result
  const up = s > r;
  const nb = nextF32(r, up ? 1 : -1);
  const mid = (r + nb) / 2; // exact: the midpoint of two adjacent binary32 values
  const d = s - mid; // exact (Sterbenz: same magnitude, same sign)
  const t = d + e; // exact value s+e-mid === t + et
  const bt = t - d;
  const et = d - (t - bt) + (e - bt);
  if (t !== 0) return t > 0 === up ? nb : r;
  if (et !== 0) return et > 0 === up ? nb : r;
  BITS.setFloat32(0, r);
  return (BITS.getUint32(0) & 1) === 0 ? r : nb; // exact tie -> even significand
}

/** Native `nint(a)` — `(long)(a + (a < 0.0 ? -0.499999999 : 0.499999999))`. */
export function nint(a: number): number {
  return Math.trunc(a + (a < 0.0 ? -0.499999999 : 0.499999999));
}

/** Native `interp(x, ylo, yhi)`. */
export function interp(x: number, ylo: number, yhi: number): number {
  return ylo + x * (yhi - ylo);
}

/** Native `utils/misc.cc` `trand(min, max)` == `min + sqrt(randpw() * range * range)`. */
export function trand(random: number, min: number, max: number): number {
  const range = max - min;
  return min + Math.sqrt(random * range * range);
}

/**
 * Native `sign(x)` for `float`/`int`/`long` — **never returns 0** (native's definition is
 * `x < 0 ? -1 : 1`), which `Energy::operator*( Energy, EnergyMultiplier )` depends on.
 */
export function sign(x: number): number {
  return x < 0 ? -1 : 1;
}

/** Native `clamp(VAL, MIN, MAX)` macro. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Native `DEGTORAD` (`utils/misc.h`) — a `double` literal, so `yaw() * DEGTORAD` is double. */
export const DEGTORAD = 0.017453292;

/** Native `RADTODEG`. */
export const RADTODEG = 57.29577951;

/** `<limits.h>` `INT_MAX`, the `geneCache.lifespan` value when `DieAtMaxAge` is off. */
export const INT_MAX = 2147483647;

