/**
 * Lane W1a — the frozen RNG surface.
 *
 * Determinism is the backbone of the port (PORT_SPEC ground rule 2): the model calls the
 * C library's PRNGs directly, so the *sequences*, the *number of draws per step* and the
 * *stream separation* are contract. Three generators are in play, and which one is used
 * matters:
 *
 *   libc rand()/srand()           — Park–Miller, *not* TYPE_3. The oracle is macOS/Apple Libc
 *                                   (FreeBSD `rand.c`), where `rand()` and `random()` are two
 *                                   *different* streams: `rand()` is `x <- 16807*x mod 2^31-1`
 *                                   with seed 0 remapped to 123459876, while
 *                                   `random()`/`srandom()` is the TYPE_3 additive feedback
 *                                   (degree 31, separation 3, 310 warm-up draws). On glibc
 *                                   `rand()` is merely an alias of `random()`, which is where
 *                                   the old TYPE_3 note came from. The port follows the oracle:
 *                                   both streams are in `src/model/rng/rand.ts` (`LibcRand` =
 *                                   `rand`, `BsdRandom` = `random`, the latter there so
 *                                   `bin/rancheck`'s `random` column is reproducible) — see its
 *                                   PORT-NOTE `W1d/rand-is-not-random`. Only the `rand`/`srand`
 *                                   entry points below are frozen, and they are the Park–Miller
 *                                   stream. `rrand( lo, hi )` == `interp( randpw(), lo, hi )`
 *                                   and `randpw()` is drand48, not rand — see below.
 *   glibc drand48()/srand48()     — 48-bit LCG, [0,1). `randpw()` is a macro for drand48,
 *                                   so that is what `rrand`/`nrand`/`RandomNumberGenerator::
 *                                   drand()` consume on the GLOBAL stream.
 *   GSL gsl_rng_mt19937           — only for `RandomNumberGenerator::LOCAL` (used when the
 *                                   worldfile sets `StaticTimestepGeometry`, i.e. per-agent
 *                                   RNG state). `drand()` -> `gsl_rng_uniform`,
 *                                   `nrand()` -> `gsl_ran_ugaussian`.
 *
 * `nrand()` is the **Marsaglia polar** method over `drand48()` (`utils/misc.cc`) and it
 * keeps a *static* spare value: consecutive calls return (`c*u`, then `c*v`) from one pair
 * of samples, so the draw count per call alternates. Never re-derive it, never replace it
 * with a different normal generator.
 *
 * The implementations live in lane W1d (`src/model/rng/`), verified against
 * `../polyworld/bin/rancheck`. This file freezes the entry points and their semantics so
 * that lanes can be written against them before W1d lands.
 *
 * PORT-NOTE(types/rng-surface-naming): native exposes these as free functions in
 * `utils/{misc,RandomNumberGenerator}` and macros (`randpw`, `interp`, `rrand`). The port
 * keeps one drifted-free name per generator (below) and must not merge the libc streams
 * (`rand`, `drand48`) with MT19937 — `gslUniformPos` only ever corresponds to native
 * `gsl_rng_uniform_pos`.
 */

/** glibc `RAND_MAX`. */
export const RAND_MAX = 2147483647;
/** MT19937's output range (GSL reports min 0, max 2^32-1). */
export const MT19937_MAX = 4294967295;

/** The C-library generators the model uses directly. */
export interface RngSurface {
  /** libc `srand` — Apple/FreeBSD `rand.c`, Park–Miller (not glibc's TYPE_3 alias of `random`). */
  srand(seed: number): void;
  /** libc `rand()` -> [0, RAND_MAX] (RAND_MAX = 2^31-1). `LibcRand`, `src/model/rng/rand.ts`. */
  rand(): number;

  /** glibc `srand48`. */
  srand48(seed: number): void;
  /** glibc `drand48()` -> [0, 1). Native `randpw()`. */
  drand48(): number;
  /** glibc `lrand48()` -> [0, 2^31). */
  lrand48(): number;

  /**
   * Native `nrand()` (`utils/misc.cc`): Marsaglia polar normal over `drand48()`, with the
   * persistent `spare` value folded in. Stateful and *shared*: the draw order across
   * callers is part of the contract.
   */
  nrand(): number;
  /** Native `nrand( mean, stdev )` == `mean + nrand() * stdev`. */
  nrandScaled(mean: number, stdev: number): number;
}

/** One MT19937 stream (native `RandomNumberGenerator` instance on the LOCAL type). */
export interface Mt19937Stream {
  /** GSL `gsl_rng_set`. */
  set(seed: number): void;
  /** GSL `gsl_rng_uniform` -> [0, 1). */
  uniform(): number;
  /** GSL `gsl_rng_uniform_pos` -> (0, 1). */
  uniformPos(): number;
  /** GSL `gsl_ran_ugaussian`. */
  gaussian(): number;
  /** Native `RandomNumberGenerator::range( lo, hi )` == `interp( uniform(), lo, hi )`. */
  range(lo: number, hi: number): number;
}

/**
 * Native `RandomNumberGenerator::Role` — the three independently seeded streams the brain
 * genome uses. `set( role, type )` in the native `init()` chooses one; a port that seeds
 * all roles from one generator changes every recorded brain.
 */
export const RngRole = {
  NERVOUS_SYSTEM: 0,
  TOPOLOGICAL_DISTORTION: 1,
  INIT_WEIGHT: 2,
} as const;

export type RngRole = (typeof RngRole)[keyof typeof RngRole];

/** Native `RandomNumberGenerator::Type`: a shared global generator or per-instance state. */
export const RngType = {
  GLOBAL: 0,
  LOCAL: 1,
} as const;

export type RngType = (typeof RngType)[keyof typeof RngType];
