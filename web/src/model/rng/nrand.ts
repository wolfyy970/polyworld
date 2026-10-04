/**
 * Lane W1d — native `nrand()` (`utils/misc.cc`): the Marsaglia polar normal over
 * `drand48()`, kept stateful exactly as the C does.
 *
 * PORT-NOTE(W1d/nrand-spare-draws): the C keeps `static bool spare` and `static double
 * u, v, c`. The first call draws `u`, `v` until `s = u*u + v*v` satisfies
 * `s != 0 && s < 1`, then returns `c*u`; the **next** call returns `c*v` *without drawing*
 * and clears the spare. So the draw count per call alternates between 2 (per accepted pair,
 * more if rejected) and 0 — a port that re-derives the normal differently changes every
 * downstream draw. Verified against the oracle (`tests/rng.test.ts`: NRAND_DRAWCOUNT shows
 * `drand48()` continuing at draw 3 after one `nrand()`, and at draw 4 after two).
 *
 * The spare state is *shared* between callers, like the C statics: it lives on the instance
 * that owns the `drand48` stream (see `surface.ts`), never in a local variable.
 *
 * `nrand( mean, stdev )` is `mean + nrand() * stdev` (`nrandScaled` here).
 *
 * PORT-NOTE(W1d/nrand-is-fma-contracted): the oracle's build contracted the C source's
 * `s = u*u + v*v` into `fma(u, u, v*v)` — the leftmost product is contracted into the
 * addition. That is a 1-ulp difference in `s` and therefore in `c` and in the returned
 * normal, and it was measured, not guessed: with the plain sum the port reproduces the
 * oracle on most draws but misses on 1 in ~10 (e.g. the pair whose `s` is
 * 0.62914357991151715), with `fma(u, u, v*v)` it matches every captured value. The flag
 * `-ffp-contract=off` on the *oracle's* build would have removed the difference; it was not
 * used, so the port reproduces the contraction instead of "cleaning it up".
 */

import { fma, log } from './libm';

/** Native `nrand()` — one instance per global RNG stream. */
export class NRand {
  private spare = false;
  private u = 0;
  private v = 0;
  private c = 0;

  /** `draw` is the `drand48()` function of the stream this normal lives on. */
  constructor(private readonly draw: () => number) {}

  nrand(): number {
    if (this.spare) {
      this.spare = false;
      return this.c * this.v;
    }
    let u: number;
    let v: number;
    let s: number;
    do {
      u = 2.0 * this.draw() - 1.0;
      v = 2.0 * this.draw() - 1.0;
      // fma, not `u*u + v*v`: the oracle's build contracted this sum (PORT-NOTE above)
      s = fma(u, u, v * v);
    } while (s === 0.0 || s >= 1.0);
    this.c = Math.sqrt((-2.0 * log(s)) / s);
    this.u = u;
    this.v = v;
    this.spare = true;
    return this.c * this.u;
  }

  /** Native `nrand( mean, stdev )`. */
  nrandScaled(mean: number, stdev: number): number {
    return mean + this.nrand() * stdev;
  }
}
