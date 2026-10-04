/**
 * Lane W1d — MT19937 with GSL's mapping (`gsl_rng_mt19937`), bit-exact.
 *
 * PORT-NOTE(W1d/gsl-mt19937-mapping): GSL's `mt.c` is the reference MT19937
 * (1812433253 seeding recursion, standard tempering, `s == 0` remapped to 4357) and its
 * `get_double` is `mt_get() / 4294967296.0`, i.e. the 32-bit output over 2^32, *not*
 * 2^32-1. Measured against GSL 2.8 (see src/model/rng/nativeVectors.ts): seed 42 ->
 * 0.37454011430963874, 0.79654298420064151, ...
 *
 * `gsl_rng_uniform_pos` is GSL's rejection loop (`do { x = uniform() } while (x == 0)`),
 * and `gsl_ran_ugaussian` is `gsl_ran_gaussian(r, 1.0)`, GSL's **polar** (Marsaglia) normal:
 * `y * sqrt(-2*log(r2)/r2)` with `r2 = x*x + y*y` from two draws in (-1,1)^2, rejecting
 * `r2 > 1 || r2 == 0` — note it returns the *y* component, one value per call (no spare).
 *
 * PORT-NOTE(W1d/gaussian-polar-uses-uniform-pos): both components are drawn with
 * `gsl_rng_uniform_pos`, **not** `gsl_rng_uniform` — so a raw draw of exactly 0 is rejected
 * and redrawn instead of becoming `-1`. GSL's own `gauss.c` says so, and the *shipped*
 * library was interrogated to be sure (`native/raw/gsl_polar_probe.c`, linked against the
 * same `/opt/homebrew/opt/gsl/lib/libgsl.28.dylib` the oracle links): driving it with the
 * fixed stream `[0, 0.75, ...]` consumes **3** draws for the first gaussian (`uniform` would
 * consume 4), and `[0.9, 0.1, 0.0, 0.6, 0.7, ...]` — a rejected pair, then a zero in the
 * *second* component — consumes 5 draws and returns 1.604712017744792 (`uniform` would
 * consume 4 and return a different value). The two readings are indistinguishable on ordinary
 * vectors (an MT19937 output is exactly 0 with probability 2^-32), which is why this was
 * pinned with an injected zero rather than by sampling; but they consume a different number of
 * draws, so a `uniform` port desynchronises the LOCAL stream from the first real zero on.
 * `tests/rng.test.ts` asserts the captured `GSL_FIXED_A` / `GSL_FIXED_B` / `GSL_INJECT_*`
 * sections, draw counts included.
 *
 * JS needs care with 32-bit wrapping: `Math.imul` for the seeding product, `>>> 0` for
 * every XOR/sum, and `>>>` (not `>>`) for the logical shifts so the top bit does not sign
 * extend.
 *
 * Only `RandomNumberGenerator::LOCAL` uses MT19937 (`utils/RandomNumberGenerator.cc`), and
 * that type is selected when the worldfile sets `StaticTimestepGeometry`.
 */

import { fma, log } from './libm';

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;
/** GSL's `mt_set`: a zero seed becomes the default seed 4357. */
const DEFAULT_SEED = 4357;
const TWO32 = 4294967296;

/** MT19937 with GSL's uniform mapping — one independent stream. */
export class Mt19937 {
  private readonly mt = new Uint32Array(N);
  private mti = N;

  constructor(seed?: number) {
    if (seed !== undefined) this.set(seed);
    else this.set(DEFAULT_SEED);
  }

  /** GSL `gsl_rng_set`. */
  set(seed: number): void {
    let s = seed >>> 0;
    if (s === 0) s = DEFAULT_SEED;
    const mt = this.mt;
    mt[0] = s;
    for (let i = 1; i < N; i++) {
      mt[i] = (Math.imul(1812433253, mt[i - 1]! ^ (mt[i - 1]! >>> 30)) + i) >>> 0;
    }
    this.mti = N;
  }

  /** The raw 32-bit MT19937 output (`mt_get`). */
  next(): number {
    const mt = this.mt;
    if (this.mti >= N) {
      for (let kk = 0; kk < N - M; kk++) {
        const y = ((mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK)) >>> 0;
        mt[kk] = (mt[kk + M]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      for (let kk = N - M; kk < N - 1; kk++) {
        const y = ((mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK)) >>> 0;
        mt[kk] = (mt[kk + (M - N)]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      const y = ((mt[N - 1]! & UPPER_MASK) | (mt[0]! & LOWER_MASK)) >>> 0;
      mt[N - 1] = (mt[M - 1]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      this.mti = 0;
    }
    let y = mt[this.mti++]!;
    y = (y ^ (y >>> 11)) >>> 0;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y = (y ^ (y >>> 18)) >>> 0;
    return y;
  }

  /** GSL `gsl_rng_uniform` -> [0, 1). */
  uniform(): number {
    return this.next() / TWO32;
  }

  /** GSL `gsl_rng_uniform_pos` -> (0, 1): reject exact zeros. */
  uniformPos(): number {
    let x = this.uniform();
    while (x === 0) x = this.uniform();
    return x;
  }

  /**
   * GSL `gsl_ran_ugaussian` -> standard normal (GSL's polar method).
   *
   * PORT-NOTE(W1d/gaussian-polar-uses-uniform-pos): both components come from `uniformPos()`
   * (GSL `gauss.c`), so an exact 0 is redrawn rather than folded in as `-1` — see the
   * PORT-NOTE at the top of this file for the shipped-library evidence.
   */
  gaussian(): number {
    let x: number;
    let y: number;
    let r2: number;
    do {
      x = -1 + 2 * this.uniformPos();
      y = -1 + 2 * this.uniformPos();
      // PORT-NOTE(W1d/gaussian-is-fma-contracted): GSL's source says `r2 = x*x + y*y`, but
      // the library the oracle links was built with FMA contraction, so the shipped code
      // evaluates `fma(x, x, y*y)` — 1 ulp different, and measurable: the 5th gaussian from
      // seed 42 needs r2 = 0.78780299177152346, which only the contracted form produces.
      r2 = fma(x, x, y * y);
    } while (r2 > 1.0 || r2 === 0);
    return y * Math.sqrt((-2.0 * log(r2)) / r2);
  }

  /** Native `RandomNumberGenerator::range( lo, hi )` == `interp( uniform(), lo, hi )`. */
  range(lo: number, hi: number): number {
    return lo + this.uniform() * (hi - lo);
  }
}
