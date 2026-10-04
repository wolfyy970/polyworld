/**
 * Lane L6 (brain core) — the draw surface `GroupsBrain::growSynapses` uses.
 *
 * Native `RandomNumberGenerator` is *one class with two behaviours* selected by the role's
 * configured `Type`:
 *
 *   GLOBAL  `drand()` -> `drand48()`, `nrand()` -> `::nrand()`, `seed()` -> `srand48()`
 *   LOCAL   `drand()` -> `gsl_rng_uniform()`, `nrand()` -> `gsl_ran_ugaussian()`,
 *           `seed()` -> `gsl_rng_set()`
 *
 * and `range( lo, hi )` is `interp( drand(), lo, hi )` in both cases (`utils/misc.h`).
 * `GroupsBrain::growSynapses` picks one of the two per *connection*: with
 * `EnableTopologicalDistortionRngSeed` / `EnableInitWeightRngSeed` off (both scenarios) it
 * draws from the nervous system's GLOBAL stream, otherwise from a fresh LOCAL MT19937 seeded
 * per (synapse type, from group, to group) — so the same code path must be able to do both.
 *
 * PORT-NOTE(l6/grow-draw-surface): this adapter is the single place where the two native
 * generator types are reconciled against the frozen surfaces in `types/rng.ts`
 * (`RngSurface` for GLOBAL, `Mt19937Stream` for LOCAL). It exists so `groupsBrain.ts` reads
 * like the C++ (`td_rng->drand()`, `weight_rng->range( … )`) without every call site knowing
 * which generator it holds — and so that no lane merges the glibc and MT19937 streams.
 */

import { interp } from './nativeMath';
import type { Mt19937Stream, RngRole, RngSurface } from '../../types';

/** Native `RandomNumberGenerator`'s draw surface, either type. */
export interface GrowRng {
  /** Native `drand()`. */
  drand(): number;
  /** Native `nrand()`. */
  nrand(): number;
  /** Native `nrand( mean, stdev )` — `mean + nrand() * stdev`. */
  nrandScaled(mean: number, stdev: number): number;
  /** Native `seed( x )`. */
  set(seed: number): void;
  /** Native `range( lo, hi )` — `interp( drand(), lo, hi )`. */
  range(lo: number, hi: number): number;
}

/** The GLOBAL role: the shared glibc streams behind `RngSurface`. */
export function globalGrowRng(surface: RngSurface): GrowRng {
  return {
    drand: () => surface.drand48(),
    nrand: () => surface.nrand(),
    nrandScaled: (mean, stdev) => surface.nrandScaled(mean, stdev),
    set: (seed) => surface.srand48(seed),
    range: (lo, hi) => interp(surface.drand48(), lo, hi),
  };
}

/** The LOCAL role: one private MT19937 stream. */
export function localGrowRng(stream: Mt19937Stream): GrowRng {
  return {
    drand: () => stream.uniform(),
    nrand: () => stream.gaussian(),
    nrandScaled: (mean, stdev) => mean + stream.gaussian() * stdev,
    set: (seed) => stream.set(seed),
    range: (lo, hi) => stream.range(lo, hi),
  };
}

/** Native `RandomNumberGenerator::Role` values, re-exported for the brain's call sites. */
export const GrowRngRole = {
  NERVOUS_SYSTEM: 0,
  TOPOLOGICAL_DISTORTION: 1,
  INIT_WEIGHT: 2,
} as const satisfies Record<string, RngRole>;
